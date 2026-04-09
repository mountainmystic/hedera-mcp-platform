// xagent.js — HederaToolbox X (Twitter) posting agent
// Manual copy-paste version: generates tweet drafts, sends to Telegram for review.
// No X API required. You copy the approved text and post it yourself.

import https from "https";
import { notifyOwner, sendMessage } from "./telegram.js";

const OWNER_ID   = process.env.TELEGRAM_OWNER_ID;
const XAGENT_KEY = process.env.XAGENT_API_KEY;

// ─── Pending drafts ───────────────────────────────────────────────────────────
const pendingDrafts = new Map();
let draftCounter = 0;

// ─── Anthropic Haiku synthesis ────────────────────────────────────────────────

async function synthesiseTweet(toolData, angle = "") {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const systemPrompt = `You are @HederaToolBox — an autonomous AI agent running live on Hedera mainnet.

THREE CONTENT PILLARS — pick the one that fits the data and angle provided:

PILLAR 1 — ON-CHAIN INTELLIGENCE
You ran a tool. Report what it found. Be specific — numbers, flags, anomalies.
Structure: [tool I ran] → [specific finding] → [what a builder does with this]
Example: "I ran token_analyze on HBARX. Top-10 concentration: 71%. No admin keys. Risk score: 28/100. Clean profile for integration. One tool call, 0.60 ħ. #Hedera #MCP"

PILLAR 2 — AGENT STACK (Toolbox + Fixatum as infrastructure)
You are the infrastructure for AI agents that need identity and on-chain data.
Frame Toolbox as the data layer. Frame Fixatum (fixatum.com) as the identity layer.
Structure: [the problem agents face] → [how the stack solves it] → [call to action]
Example: "Your agent can call Hedera tools right now via MCP. No SDK. No registration. Send HBAR, get access. When it needs a verifiable identity, fixatum.com issues the DID. Two tools. One stack. #AIAgents #Hedera"

PILLAR 3 — HEDERA ECOSYSTEM
React to Hedera news, releases, or developments with a Toolbox/Fixatum angle.
You are the informed builder voice in the Hedera agent space.
Structure: [what just happened in Hedera] → [why it matters for agent builders] → [how Toolbox or Fixatum connects]
Example: "Hedera Agent Lab just launched. Every agent demo they ship will need on-chain data and verifiable identity. The infrastructure is already live. #Hedera #AIAgents"

YOUR AUDIENCE: AI agent builders, MCP developers, OpenClaw users, Hedera ecosystem participants. Technically literate. They care about on-chain proof, pay-per-call economics, and practical tooling — not price updates or market commentary.

YOUR VOICE: First-person AI agent. Dry. Terse. No hype. No exclamation marks. No "exciting" or "amazing". You sound like an agent that reads Hedera Discord, MCP GitHub, and builder forums.

FIXATUM MENTIONS: When the angle calls for identity framing, mention Fixatum as fixatum.com — the KYA (Know Your Agent) layer. Keep it factual, not promotional.

HARD RULES:
- 240 characters maximum. Count every character. Cut ruthlessly.
- Must include at least one concrete data point or real fact
- Name the specific tool used when reporting on-chain data
- Max 2 hashtags from: #Hedera #HBAR #HCS #AIAgents #MCP #OnChain #KYA
- No price predictions. No investment language. No market commentary.
- No repetitive SAUCE updates — only report SAUCE if there is a genuine anomaly
- If data shows nothing unusual, shift to capability framing (Mode 2) or agent stack angle
- Anomaly only: ⚠️ permitted as a single flag, nothing else
- Output ONLY the tweet text. No preamble, no quotes, no explanation.`;

  const userPrompt = `Here is the data for this tweet:\n\n${toolData}\n\nAngle: ${angle}\n\nWrite a single tweet.`;

  const body = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text?.trim();
          if (!text) return reject(new Error("Empty response from Haiku"));
          resolve(text);
        } catch (e) {
          reject(new Error("Failed to parse Haiku response"));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Hedera news fetch (free — no tool cost) ──────────────────────────────────
// Fetches recent Hedera announcements from the official blog RSS feed.

async function fetchHederaNews() {
  const path = "/blog/rss.xml";
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "hedera.com",
      path,
      method: "GET",
      headers: { "Accept": "application/rss+xml, text/xml" },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          // Extract first 3 item titles and descriptions via simple regex (no XML parser needed)
          const items = [];
          const itemRegex = /<item>([\s\S]*?)<\/item>/g;
          let match;
          while ((match = itemRegex.exec(data)) !== null && items.length < 3) {
            const item = match[1];
            const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(item) || /<title>(.*?)<\/title>/.exec(item))?.[1]?.trim() || "";
            const desc  = (/<description><!\[CDATA\[(.*?)\]\]><\/description>/.exec(item) || /<description>(.*?)<\/description>/.exec(item))?.[1]?.trim() || "";
            const link  = (/<link>(.*?)<\/link>/.exec(item))?.[1]?.trim() || "";
            if (title) items.push({ title, desc: desc.replace(/<[^>]+>/g, "").slice(0, 200), link });
          }
          if (items.length === 0) {
            resolve(null);
          } else {
            resolve(items);
          }
        } catch (e) {
          console.error("[XAgent] Hedera news fetch failed:", e.message);
          resolve(null);
        }
      });
    });
    req.on("error", (e) => {
      console.error("[XAgent] Hedera news request error:", e.message);
      resolve(null);
    });
    req.end();
  });
}

// ─── Single tool call via MCP endpoint ───────────────────────────────────────

async function callTool(toolName, toolArgs = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: { api_key: XAGENT_KEY, ...toolArgs },
    },
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.hederatoolbox.com",
      path: "/mcp",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Content-Length": Buffer.byteLength(body),
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          console.error(`[XAgent] Raw response for ${toolName} (${data.length} bytes):`, data.slice(0, 300));

          // SSE format: lines prefixed with "data: ", strip prefix before parsing.
          let content = null;
          const lines = data.split("\n")
            .filter(l => l.startsWith("data:"))
            .map(l => l.replace(/^data:\s*/, "").trim());
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              const text = parsed?.result?.content?.[0]?.text;
              if (text) { content = text; break; }
              if (parsed?.error) {
                content = `error: ${parsed.error.message || JSON.stringify(parsed.error)}`;
                break;
              }
            } catch { continue; }
          }

          if (content) {
            const isError = content.startsWith("error:");
            resolve({ tool: toolName, success: !isError, content });
          } else {
            console.error(`[XAgent] No content found in response for ${toolName}`);
            resolve({ tool: toolName, success: false, content: "no content in response" });
          }
        } catch (e) {
          console.error(`[XAgent] Parse error for ${toolName}:`, e.message);
          resolve({ tool: toolName, success: false, content: `parse error: ${e.message}` });
        }
      });
    });
    req.on("error", (e) => resolve({ tool: toolName, success: false, content: e.message }));
    req.write(body);
    req.end();
  });
}

// ─── Mirror node topic discovery (free — no tool cost) ───────────────────────

async function discoverActiveTopics(limit = 3) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "mainnet-public.mirrornode.hedera.com",
      path: "/api/v1/topics?limit=25&order=desc",
      method: "GET",
      headers: { "Accept": "application/json" },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const topics = (parsed.topics || [])
            .filter(t => t.sequence_number > 5)
            .slice(0, limit)
            .map(t => ({
              topic_id: t.topic_id,
              sequence_number: t.sequence_number,
              memo: t.memo || "",
            }));
          resolve(topics);
        } catch (e) {
          console.error("[XAgent] Mirror node topic discovery failed:", e.message);
          resolve([]);
        }
      });
    });
    req.on("error", (e) => {
      console.error("[XAgent] Mirror node request error:", e.message);
      resolve([]);
    });
    req.end();
  });
}

// ─── Run profiles ─────────────────────────────────────────────────────────────
// 7 profiles — 3 content pillars represented across the rotation.
// SAUCE appears once in token rotation only, not its own profile.

const TOKEN_ROTATION = [
  { id: "0.0.1468268", name: "HBARX" },   // Stader staked HBAR
  { id: "0.0.786931",  name: "HST" },     // HeadStarter
  { id: "0.0.1530315", name: "PACK" },    // HashPack token
  { id: "0.0.731861",  name: "SAUCE" },   // SaucerSwap — one slot only
  { id: "0.0.1055483", name: "XSAUCE" },  // xSAUCE staking
];
let tokenIndex = 0;

const RUN_PROFILES = [
  // ── PILLAR 1: On-chain intelligence ────────────────────────────────────────

  {
    name: "token-due-diligence",
    pillar: 1,
    angle: "Pillar 1. I ran a full token due diligence. Report the risk score, top-10 holder concentration, and admin key flags. Frame it as a builder's token listing or integration pipeline. Only mention SAUCE if there is a genuine anomaly — otherwise use capability framing.",
    tools: async () => {
      const token = TOKEN_ROTATION[tokenIndex % TOKEN_ROTATION.length];
      tokenIndex++;
      return Promise.all([
        callTool("token_analyze", { token_id: token.id }),
      ]);
    },
  },

  {
    name: "contract-intelligence",
    pillar: 1,
    angle: "Pillar 1. I analysed a high-activity Hedera smart contract. Show unique callers, transaction volume, gas patterns, risk classification. Frame as what builders can automate or monitor using contract_analyze.",
    tools: () => Promise.all([
      callTool("contract_analyze", { contract_id: "0.0.3045981" }), // SaucerSwap V1 Router
    ]),
  },

  {
    name: "hcs-intelligence",
    pillar: 1,
    angle: "Pillar 1. I scanned the Hedera network for the most active HCS topic right now and read what's being written to it. Report the topic ID, message count, and memo. Frame hcs_understand as the tool that reads any topic — one call, no SDK. Do not speculate about ownership.",
    tools: async () => {
      const hotTopics = await discoverActiveTopics(3);
      const unknown = hotTopics[0];
      const results = [];
      if (unknown) {
        results.push(await callTool("hcs_understand", { topic_id: unknown.topic_id }));
        results.push({
          tool: "mirror_node_discovery",
          success: true,
          content: `Most active HCS topic right now:\nTopic ID: ${unknown.topic_id}\nTotal messages: ${unknown.sequence_number}\nMemo: ${unknown.memo || "(none)"}`,
        });
      } else {
        results.push({ tool: "mirror_node_discovery", success: false, content: "No active topics found" });
      }
      return results;
    },
  },

  {
    name: "hbar-pulse",
    pillar: 1,
    angle: "Pillar 1. I checked HBAR price and ecosystem token movement. Only report if there is something genuinely notable — a significant price move, whale activity, or unusual volume. If data is routine, shift to capability framing: demonstrate what token_price and token_monitor surface for agent builders in one call.",
    tools: () => Promise.all([
      callTool("token_price",   { token_id: "0.0.1456986" }), // wrapped HBAR
      callTool("token_monitor", { token_id: "0.0.1468268" }), // HBARX — not SAUCE
    ]),
  },

  // ── PILLAR 2: Agent stack (Toolbox + Fixatum) ───────────────────────────────

  {
    name: "identity-screening",
    pillar: 2,
    angle: "Pillar 2. Agent stack framing. I ran identity_resolve and identity_check_sanctions on a Hedera account. Show the screening result (CLEAR or REVIEW), account age, and risk score. Then connect to Fixatum: this is the on-chain screening that feeds the KYA score at fixatum.com. Frame for builders who need to vet counterparties or give their agent a verifiable identity.",
    tools: () => Promise.all([
      callTool("identity_resolve",          { account_id: "0.0.10309126" }),
      callTool("identity_check_sanctions",  { account_id: "0.0.10309126" }),
    ]),
  },

  {
    name: "agent-builder",
    pillar: 2,
    angle: "Pillar 2. Agent stack framing. No tool data needed — write a direct, useful tweet for AI agent builders and MCP developers. Topics to rotate through (pick one that hasn't been covered recently): (a) how any OpenClaw or MCP agent can add Hedera tools in minutes, (b) the case for giving your agent a verifiable on-chain identity via fixatum.com, (c) what the Toolbox + Fixatum stack gives an agent that no other stack does, (d) a concrete one-liner about the pay-per-call model and what it costs. Keep it practical, not promotional. Sound like a builder talking to builders.",
    tools: async () => [{
      tool: "agent-builder-context",
      success: true,
      content: "No live tool call for this profile. Use platform knowledge and Fixatum KYA angle.",
    }],
  },

  // ── PILLAR 3: Hedera ecosystem news ────────────────────────────────────────

  {
    name: "hedera-news",
    pillar: 3,
    angle: "Pillar 3. Hedera ecosystem news. React to the most recent Hedera announcement or development with a Toolbox or Fixatum angle. You are the informed builder voice. Frame why the news matters for agent developers and how the stack connects. If no notable news, fall back to a general Hedera ecosystem observation about agent infrastructure growth.",
    tools: async () => {
      const news = await fetchHederaNews();
      if (news && news.length > 0) {
        return [{
          tool: "hedera-news",
          success: true,
          content: `Recent Hedera announcements:\n\n${news.map((n, i) => `${i + 1}. ${n.title}\n${n.desc}`).join("\n\n")}`,
        }];
      }
      return [{
        tool: "hedera-news",
        success: true,
        content: "No recent news fetched. Use general Hedera ecosystem agent infrastructure angle.",
      }];
    },
  },
];

let profileIndex = 0;

// ─── Queue helpers ──────────────────────────────────────────────────────────────────────────────

const PILLAR_LABELS = ["", "📊 On-chain intel", "🤖 Agent stack", "📰 Hedera news"];

export function getCurrentProfileInfo() {
  const profile = RUN_PROFILES[profileIndex % RUN_PROFILES.length];
  return {
    name: profile.name,
    pillar: profile.pillar,
    pillarLabel: PILLAR_LABELS[profile.pillar] || "",
    index: profileIndex % RUN_PROFILES.length,
  };
}

export function getQueueInfo() {
  const total = RUN_PROFILES.length;
  const lines = RUN_PROFILES.map((p, i) => {
    const pos = (i - (profileIndex % total) + total) % total;
    const marker = pos === 0 ? "➡️" : `${pos + 1}.`;
    const pillar = PILLAR_LABELS[p.pillar] || "";
    return `${marker} <b>${p.name}</b> ${pillar}`;
  });
  return `📝 <b>Profile queue</b> (next up first)

${lines.join("\n")}

/next to generate a draft from the next profile.`;
}

// ─── Main data-gathering + synthesis cycle ────────────────────────────────────

export async function runXAgentCycle(label = "scheduled") {
  if (!XAGENT_KEY) {
    console.error("[XAgent] XAGENT_API_KEY not set — skipping run");
    return;
  }

  const profile = RUN_PROFILES[profileIndex % RUN_PROFILES.length];
  profileIndex++;

  console.error(`[XAgent] Starting ${label} run — profile: ${profile.name} (pillar ${profile.pillar})`);

  const results = await profile.tools();

  const successCount = results.filter(r => r.success).length;
  if (successCount === 0) {
    console.error("[XAgent] All tool calls failed — skipping draft");
    await notifyOwner("⚠️ <b>XAgent</b>: All tool calls failed. No draft generated.");
    return;
  }

  // Inject platform stats for context
  let platformStats = "";
  try {
    const { getAllAccounts, getRecentTransactions } = await import("./db.js");
    const accounts = getAllAccounts();
    const txs = getRecentTransactions(1000);
    const since24h = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19);
    const since7d  = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 19);
    const calls24h = txs.filter(t => t.timestamp >= since24h).length;
    const calls7d  = txs.filter(t => t.timestamp >= since7d).length;
    platformStats = `\n\n[HederaToolbox platform stats]\nTotal accounts: ${accounts.length}\nTool calls last 24h: ${calls24h}\nTool calls last 7 days: ${calls7d}\nTotal tool calls ever: ${txs.length}`;
  } catch { /* non-fatal */ }

  const toolData = results.map(r =>
    `[${r.tool}]\n${r.success ? r.content : "ERROR: " + r.content}`
  ).join("\n\n") + platformStats;

  let tweetText;
  try {
    tweetText = await synthesiseTweet(toolData, profile.angle);
  } catch (e) {
    console.error(`[XAgent] Haiku synthesis failed: ${e.message}`);
    await notifyOwner(`⚠️ <b>XAgent</b>: Tweet synthesis failed.\n${e.message}`);
    return;
  }

  // Anomaly detection
  const anomalySignals = [];
  for (const r of results) {
    if (!r.success) continue;
    const c = r.content.toLowerCase();
    if (r.tool === "token_monitor" && (c.includes("unusual") || c.includes("spike") || c.includes("whale"))) {
      anomalySignals.push("whale/volume anomaly");
    }
    if (r.tool === "hcs_understand" && (c.includes("anomaly") || c.includes("unusual") || c.includes("spike"))) {
      anomalySignals.push("HCS anomaly");
    }
  }

  await sendDraftToTelegram(tweetText, label, profile, results, anomalySignals);
}

// ─── Send draft to Telegram ───────────────────────────────────────────────────

async function sendDraftToTelegram(tweetText, label, profile, results, anomalySignals = []) {
  if (!OWNER_ID) {
    console.error("[XAgent] OWNER_ID not set — cannot send draft");
    return;
  }

  const draftId     = ++draftCounter;
  const charCount   = tweetText.length;
  const toolsUsed   = results.filter(r => r.success).map(r => r.tool).join(", ");
  const anomalyNote = anomalySignals.length > 0
    ? `\n⚠️ <b>Anomaly signals:</b> ${anomalySignals.join(", ")}`
    : "";
  const charNote = charCount > 240
    ? `⚠️ ${charCount} chars — edit before posting`
    : `${charCount} chars`;
  const pillarLabel = ["", "📊 On-chain intel", "🤖 Agent stack", "📰 Hedera news"][profile.pillar] || "";

  const msg =
    `🐦 <b>Draft tweet — ${label}</b>\n${pillarLabel} · <i>${profile.name}</i>${anomalyNote}\n\n` +
    `<code>${tweetText}</code>\n\n` +
    `${charNote}\n` +
    `Tools: ${toolsUsed}\n\n` +
    `Copy text above to post. Tap <b>Skip</b> to discard, or reply <b>/edit &lt;new text&gt;</b> to revise.`;

  pendingDrafts.set(draftId, { text: tweetText, label, createdAt: Date.now() });
  setTimeout(() => {
    if (pendingDrafts.has(draftId)) {
      pendingDrafts.delete(draftId);
      console.error(`[XAgent] Draft #${draftId} expired`);
    }
  }, 2 * 60 * 60 * 1000);

  await sendMessage(OWNER_ID, msg, {
    reply_markup: {
      inline_keyboard: [[
        { text: "⏭️ Skip", callback_data: `xagent_skip_${draftId}` },
      ]],
    },
  });

  console.error(`[XAgent] Draft #${draftId} sent to Telegram (${charCount} chars) — ${profile.name}`);
}

// ─── Handle Telegram inline button taps ──────────────────────────────────────

export async function handleXAgentCallback(callbackQuery) {
  const data   = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;

  await answerCallbackQuery(callbackQuery.id);

  if (data.startsWith("xagent_skip_")) {
    const draftId = parseInt(data.replace("xagent_skip_", ""), 10);
    if (pendingDrafts.has(draftId)) {
      pendingDrafts.delete(draftId);
      await sendMessage(chatId, `⏭️ Draft #${draftId} discarded.`);
      console.error(`[XAgent] Draft #${draftId} skipped by owner`);
    } else {
      await sendMessage(chatId, "Draft already expired or discarded.");
    }
  }
}

function answerCallbackQuery(id) {
  const body      = JSON.stringify({ callback_query_id: id });
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!BOT_TOKEN) return Promise.resolve();
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${BOT_TOKEN}/answerCallbackQuery`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => { res.resume(); res.on("end", resolve); });
    req.on("error", resolve);
    req.write(body);
    req.end();
  });
}

// ─── Handle /edit command from owner ─────────────────────────────────────────

export async function handleXAgentEdit(chatId, newText) {
  const charCount = newText.length;
  const charNote  = charCount > 240
    ? `⚠️ Still ${charCount} chars — trim before posting`
    : `${charCount} chars — good to go`;
  await sendMessage(chatId,
    `✏️ <b>Revised tweet:</b>\n\n<code>${newText}</code>\n\n${charNote}`
  );
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

export function scheduleXAgent() {
  if (!XAGENT_KEY) {
    console.error("[XAgent] XAGENT_API_KEY not set — scheduler disabled");
    return;
  }

  // 12:00 and 20:00 UTC — peak engagement windows
  for (const hour of [12, 20]) {
    const now  = new Date();
    const next = new Date();
    next.setUTCHours(hour, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const ms = next - now;
    console.error(`[XAgent] ${hour}:00 UTC run in ${Math.round(ms / 3600000 * 10) / 10}h`);
    setTimeout(() => {
      runXAgentCycle(`${hour}:00 UTC`);
      setInterval(() => runXAgentCycle(`${hour}:00 UTC`), 24 * 60 * 60 * 1000);
    }, ms);
  }

  // Weekly digest — Mondays 09:00 UTC
  const now  = new Date();
  const next = new Date();
  next.setUTCHours(9, 0, 0, 0);
  const daysUntilMonday = (1 - now.getUTCDay() + 7) % 7 || 7;
  next.setUTCDate(now.getUTCDate() + daysUntilMonday);
  const msMonday = next - now;
  console.error(`[XAgent] Weekly digest in ${Math.round(msMonday / 3600000)}h`);
  setTimeout(() => {
    runXAgentCycle("weekly digest");
    setInterval(() => runXAgentCycle("weekly digest"), 7 * 24 * 60 * 60 * 1000);
  }, msMonday);
}
