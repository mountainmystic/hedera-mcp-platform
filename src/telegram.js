// telegram.js — HederaToolbox Telegram bot
// Claude-powered assistant for platform questions.
// Sends owner notifications for deposits and escalations.
// Registers webhook with Telegram on startup.

import https from "https";
import http from "http";
import { handleXAgentEdit } from "./xagent.js";

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID   = process.env.TELEGRAM_OWNER_ID;
const RAILWAY_URL =
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null) ||
  (process.env.RAILWAY_STATIC_URL) ||
  (process.env.PUBLIC_URL) ||
  "https://api.hederatoolbox.com";

// Narrator internal URL — Railway internal networking or public domain
// Set NARRATOR_URL in Railway env vars to the Narrator service's internal URL
const NARRATOR_URL = process.env.NARRATOR_URL || null;

// --- Telegram API helper ------------------------------------------------------

function telegramRequest(method, payload) {
  return new Promise((resolve, reject) => {
    if (!BOT_TOKEN) return resolve(null);
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${BOT_TOKEN}/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function sendMessage(chatId, text, options = {}) {
  return telegramRequest("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...options });
}

export async function notifyOwner(text) {
  if (!OWNER_ID) return;
  return sendMessage(OWNER_ID, text);
}

// --- Forward update to Narrator ----------------------------------------------
// Sends the raw Telegram update to Narrator's webhook endpoint so it can
// handle /narrator, /approve, /skip, /revise commands directly.

function forwardToNarrator(update) {
  if (!NARRATOR_URL) return;
  try {
    const urlObj  = new URL(NARRATOR_URL + "/telegram/webhook");
    const mod     = urlObj.protocol === "https:" ? https : http;
    const payload = JSON.stringify(update);
    const req     = mod.request({
      hostname: urlObj.hostname,
      port:     urlObj.port || undefined,
      path:     urlObj.pathname,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, res => { res.on("data", () => {}); });
    req.on("error", e => console.error("[Telegram] Narrator forward error:", e.message));
    req.write(payload);
    req.end();
  } catch (e) {
    console.error("[Telegram] Narrator forward failed:", e.message);
  }
}

// --- Owner notifications ------------------------------------------------------

export async function notifyDeposit({ accountId, depositHbar, balanceHbar, txId, usdValue }) {
  if (!BOT_TOKEN || !OWNER_ID) return;
  return notifyOwner(
    `💰 <b>New deposit</b>\n\n` +
    `Account: <code>${accountId}</code>\n` +
    `Amount:  <b>${depositHbar} ℏ</b>${usdValue ? ` (~${usdValue})` : ""}\n` +
    `Balance: ${balanceHbar} ℏ\n` +
    `TX: <code>${txId}</code>`
  );
}

export async function notifyWatcherError(message) {
  if (!BOT_TOKEN || !OWNER_ID) return;
  return notifyOwner(`⚠️ <b>Watcher error</b>\n\n${message}`);
}

// --- System prompt ------------------------------------------------------------

const SYSTEM_PROMPT = `You are the HederaToolbox support assistant on Telegram. Your job is to help people understand what these products do and how to get started — in plain, clear language. Many people you speak with are not blockchain developers. Meet them where they are.

WHAT THESE PRODUCTS DO (plain English first)

HederaToolbox gives AI agents — and the developers who build them — live access to blockchain data, without needing to understand how blockchains work under the hood. Think of it as a data service: your AI plugs in, asks questions about the Hedera network (token prices, wallet activity, governance votes, smart contract behaviour), and gets structured answers. You pay a small fee per query in HBAR — the native currency of the Hedera network — and that's it. No subscriptions, no accounts to create, no technical setup beyond a single connection URL.

Hedera is a public blockchain network — similar in concept to Ethereum, but faster and cheaper. HBAR is the currency used to pay for things on it.

Fixatum gives AI agents a permanent, verifiable identity on Hedera — and a trust score that reflects how they've behaved. Think of it like a credit score or professional reputation, but for AI agents rather than people. When an agent registers with Fixatum, it gets a unique identifier (a DID — Decentralised Identifier) that's permanently anchored to the blockchain. Anyone can then look up that agent's score to see how long it's been active, what it's done, and whether it shows any risk signals.

Together: Toolbox is the data layer — it records what agents actually do. Fixatum is the identity layer — it turns that activity into a credibility score. Each makes the other more valuable.

PLATFORM IDENTITY — THE FULL STACK
HederaToolbox and Fixatum together form the full agent infrastructure stack on Hedera.

HederaToolbox (hederatoolbox.com) is the data layer — a production MCP server giving AI agents structured, metered access to 20 live Hedera tools via HBAR micropayments. No registration. No SDK. No dashboard. Send HBAR, your account ID becomes your API key within 10 seconds.

Fixatum (fixatum.com) is the identity layer — a DID issuance and KYA (Know Your Agent) credibility scoring platform built on Hedera. It issues permanent W3C-compatible DIDs anchored to HCS, and computes live credibility scores (0–100) based on on-chain behaviour including Toolbox usage history.

The relationship: Toolbox usage creates verifiable on-chain provenance. Fixatum reads that provenance to compute agent credibility scores. Each product increases the value of the other.

HOW HEDERATOOLBOX WORKS
- Send HBAR to platform wallet 0.0.10309126 from any Hedera account
- Within 10 seconds the sending account ID becomes the API key automatically
- Pass that account ID as api_key in any paid tool call
- Balance is deducted per call. Top up any time by sending more HBAR.
- No minimum deposit. No forms. No registration.

HOW FIXATUM WORKS
- Agent generates an Ed25519 key pair at did.fixatum.com/register
- Sends 100 HBAR to Fixatum wallet 0.0.10394452 with the public key in the memo
- Fixatum anchors the DID to Hedera HCS permanently. No private keys ever touch Fixatum.
- DID format: did:hedera:mainnet:z{PUBLIC_KEY}_{HEDERA_ACCOUNT_ID}
- Credibility score (0–100) is computed live on every query — never stored.
- Score query API: free (rate-limited) or 0.01 HBAR/query via api_key param

FIXATUM SCORE COMPONENTS
- Account age (0–25): days since creation, capped at 365d
- Provenance (0–40): verified Toolbox call history, minus risk flag penalty
- Screening (0–20): on-chain behavioural screening — CLEAR=20, REVIEW=10
- Bonus (0–5): age >180d AND calls >20
Grades: A (80+), B (60+), C (40+), D (20+), F (<20)
Note: REVIEW on new accounts is normal — insufficient data, not a flag.

IMPORTANT LANGUAGE: Never use "certified", "verified", or "compliant" when describing Fixatum. Use "on-chain risk screening" or "on-chain behavioural analysis". Fixatum's identity_check_sanctions tool is NOT a legal sanctions check against OFAC, UN, EU, or any government watchlist.

CONNECTION OPTIONS (HederaToolbox)

Claude.ai (web or mobile):
Settings → Connectors → Add custom connector → paste:
https://api.hederatoolbox.com/mcp

Claude Desktop (claude_desktop_config.json under mcpServers):
{
  "hederatoolbox": {
    "command": "npx",
    "args": ["-y", "@hederatoolbox/platform"]
  }
}
Then restart Claude Desktop.

Manus / Cursor / any MCP-compatible client:
Use the endpoint URL directly: https://api.hederatoolbox.com/mcp
No API key required — your Hedera account ID is your credential.

TOOLS AND COSTS (HederaToolbox)
Free: account_info, get_terms, confirm_terms
HCS: hcs_monitor (0.10 ℏ), hcs_query (0.10 ℏ), hcs_understand (1.00 ℏ)
Compliance: hcs_write_record (5.00 ℏ), hcs_verify_record (1.00 ℏ), hcs_audit_trail (2.00 ℏ)
Identity: identity_resolve (0.20 ℏ), identity_verify_kyc (0.50 ℏ), identity_check_sanctions (1.00 ℏ)
Token: token_price (0.10 ℏ), token_monitor (0.20 ℏ), token_analyze (0.60 ℏ)
Governance: governance_monitor (0.20 ℏ), governance_analyze (1.00 ℏ)
Contract: contract_read (0.20 ℏ), contract_call (1.00 ℏ), contract_analyze (1.50 ℏ)

KEY ENDPOINTS
HederaToolbox MCP: https://api.hederatoolbox.com/mcp
HederaToolbox npm: @hederatoolbox/platform (npx -y @hederatoolbox/platform)
Fixatum score API: https://did.fixatum.com/score/:did
Fixatum DID lookup: https://did.fixatum.com/did/:hedera_account_id
Fixatum register: https://did.fixatum.com/register

BEHAVIOUR RULES
- Answer concisely. This is Telegram — short responses work better than long ones.
- Be factual about pricing and authentication. Do not guess.
- If someone asks which tools to use for a use case, recommend specifically.
- If someone asks about agent identity, trust scoring, or DIDs, explain Fixatum.
- If someone reports a bug or technical problem you can't resolve, use ESCALATE.
- If someone mentions enterprise use, volume pricing, or partnership, use ESCALATE.
- Never reveal internal implementation details or environment variables.
- Do not discuss competitors.
- If someone seems unfamiliar with blockchain or crypto, skip the jargon and explain in plain English.
- Lead with the benefit or use case, not the technical mechanism.
- If someone seems confused about what the product actually does, back up and explain the value from scratch.

ESCALATION
If you need to escalate, end your reply with exactly this line (nothing after it):
ESCALATE: <one sentence summary of what needs attention>

OUT OF SCOPE
Anything unrelated to HederaToolbox, Fixatum, Hedera blockchain tools, or MCP. Politely redirect.`;

// --- Claude-powered response --------------------------------------------------

async function getAIResponse(userMessage, chatHistory = []) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return "I'm having trouble connecting to my brain right now. Please try again in a moment.";

  const body = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [...chatHistory, { role: "user", content: userMessage }],
  });

  return new Promise((resolve) => {
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
        try { resolve(JSON.parse(data).content?.[0]?.text || "Sorry, I couldn't generate a response."); }
        catch { resolve("Sorry, something went wrong. Please try again."); }
      });
    });
    req.on("error", () => resolve("I'm having connectivity issues. Please try again shortly."));
    req.write(body);
    req.end();
  });
}

// --- Conversation memory (resets on redeploy) ---------------------------------

const conversationHistory = new Map();

function getHistory(chatId) { return conversationHistory.get(chatId) || []; }

function addToHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });
  if (history.length > 10) history.splice(0, history.length - 10);
  conversationHistory.set(chatId, history);
}

// --- Narrator command keywords -----------------------------------------------

const NARRATOR_COMMANDS = ["/narrator", "/approve", "/skip", "/revise"];

function isNarratorCommand(text) {
  return NARRATOR_COMMANDS.some(cmd => text === cmd || text.startsWith(cmd + " "));
}

// --- Handle incoming Telegram update ------------------------------------------

export async function handleTelegramUpdate(update) {
  if (update.callback_query) {
    const { handleXAgentCallback } = await import("./xagent.js");
    return handleXAgentCallback(update.callback_query);
  }

  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;

  const chatId   = msg.chat.id;
  const userId   = msg.from?.id;
  const username = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || "Someone";
  const text     = msg.text.trim();
  const isOwner  = String(userId) === String(OWNER_ID);

  // --- Narrator commands — forward to Narrator service ----------------------
  if (isOwner && isNarratorCommand(text)) {
    if (!NARRATOR_URL) {
      return sendMessage(chatId, "Narrator not configured — set NARRATOR_URL in Railway env vars.");
    }
    forwardToNarrator(update);
    // Acknowledge immediately — Narrator will send its own response
    if (text === "/narrator") await sendMessage(chatId, "Running Narrator cycle...");
    return;
  }

  // /edit <text>
  if (text.startsWith("/edit ") && isOwner) {
    const newText = text.slice(6).trim();
    if (!newText) return sendMessage(chatId, "Usage: /edit <revised tweet text>");
    const { handleXAgentEdit } = await import("./xagent.js");
    return handleXAgentEdit(chatId, newText);
  }

  // /xagent
  if (text === "/xagent") {
    if (!isOwner) return sendMessage(chatId, "⛔ Owner only.");
    await sendMessage(chatId, "▶️ Running XAgent cycle now...");
    const { runXAgentCycle } = await import("./xagent.js");
    runXAgentCycle("manual").catch(e => sendMessage(chatId, `❌ XAgent error: ${e.message}`));
    return;
  }

  // /next
  if (text === "/next") {
    if (!isOwner) return sendMessage(chatId, "⛔ Owner only.");
    const { runXAgentCycle, getCurrentProfileInfo } = await import("./xagent.js");
    const info = getCurrentProfileInfo();
    await sendMessage(chatId, `▶️ Running profile <b>${info.name}</b> (${info.pillarLabel})...`);
    runXAgentCycle("manual /next").catch(e => sendMessage(chatId, `❌ XAgent error: ${e.message}`));
    return;
  }

  // /queue
  if (text === "/queue") {
    if (!isOwner) return sendMessage(chatId, "⛔ Owner only.");
    const { getQueueInfo } = await import("./xagent.js");
    return sendMessage(chatId, getQueueInfo());
  }

  // /start
  if (text === "/start") {
    return sendMessage(chatId,
      `👋 <b>Welcome to HederaToolbox</b>\n\n` +
      `I can help you get connected, explain the tools and pricing, and answer questions about the platform.\n\n` +
      `What would you like to know?`
    );
  }

  // /help
  if (text === "/help") {
    return sendMessage(chatId,
      `<b>HederaToolbox Bot</b>\n\n` +
      `Ask me anything about:\n` +
      `• Connecting via Claude.ai, Claude Desktop, or Cursor\n` +
      `• How authentication and deposits work\n` +
      `• Which tools to use for your use case\n` +
      `• Pricing and tool costs\n\n` +
      `Or just ask in plain English.`
    );
  }

  // /status
  if (text === "/status") {
    if (!isOwner) return sendMessage(chatId, "⛔ Owner only.");
    try {
      const { getAllAccounts, getRecentTransactions } = await import("./db.js");
      const accounts  = getAllAccounts();
      const txs       = getRecentTransactions(500);
      const totalHbar = accounts.reduce((s, a) => s + a.balance_tinybars, 0) / 100_000_000;
      const lastDeposit = accounts
        .filter(a => a.last_used)
        .sort((a, b) => (b.last_used > a.last_used ? 1 : -1))[0]?.last_used || "none";
      return sendMessage(chatId,
        `📊 <b>Platform status</b>\n\n` +
        `Accounts: <b>${accounts.length}</b>\n` +
        `Total HBAR held: <b>${totalHbar.toFixed(4)} ℏ</b>\n` +
        `Tool calls (all time): <b>${txs.length}</b>\n` +
        `Last tool call: <code>${txs[0]?.timestamp || "none"}</code>\n` +
        `Last account activity: <code>${lastDeposit}</code>`
      );
    } catch (e) { return sendMessage(chatId, `❌ Status error: ${e.message}`); }
  }

  // /accounts
  if (text === "/accounts") {
    if (!isOwner) return sendMessage(chatId, "⛔ Owner only.");
    try {
      const { getAllAccounts } = await import("./db.js");
      const accounts = getAllAccounts()
        .sort((a, b) => b.balance_tinybars - a.balance_tinybars)
        .slice(0, 10);
      if (accounts.length === 0) return sendMessage(chatId, "No accounts yet.");
      const lines = accounts.map((a, i) =>
        `${i + 1}. <code>${a.api_key}</code> — <b>${(a.balance_tinybars / 100_000_000).toFixed(4)} ℏ</b>`
      ).join("\n");
      return sendMessage(chatId, `🏆 <b>Top accounts by balance</b>\n\n${lines}`);
    } catch (e) { return sendMessage(chatId, `❌ Error: ${e.message}`); }
  }

  // /balance <account_id>
  if (text.startsWith("/balance")) {
    if (!isOwner) return sendMessage(chatId, "⛔ Owner only.");
    const accountId = text.split(" ")[1]?.trim();
    if (!accountId) return sendMessage(chatId, "Usage: /balance 0.0.123456");
    try {
      const { getAccount } = await import("./db.js");
      const account = getAccount(accountId);
      if (!account) return sendMessage(chatId, `❌ Account <code>${accountId}</code> not found.`);
      return sendMessage(chatId,
        `💳 <b>Account lookup</b>\n\n` +
        `ID: <code>${account.api_key}</code>\n` +
        `Balance: <b>${(account.balance_tinybars / 100_000_000).toFixed(4)} ℏ</b>\n` +
        `Created: ${account.created_at}\n` +
        `Last used: ${account.last_used || "never"}`
      );
    } catch (e) { return sendMessage(chatId, `❌ Error: ${e.message}`); }
  }

  // /digest
  if (text === "/digest") {
    if (!isOwner) return sendMessage(chatId, "⛔ Owner only.");
    try {
      const { getRecentTransactions, getAllAccounts } = await import("./db.js");
      const allTxs = getRecentTransactions(1000);
      const since  = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19);
      const recent = allTxs.filter(t => t.timestamp >= since);
      const earned = recent.reduce((s, t) => s + t.amount_tinybars, 0) / 100_000_000;
      const toolCounts = {};
      for (const t of recent) toolCounts[t.tool_name] = (toolCounts[t.tool_name] || 0) + 1;
      const topTools = Object.entries(toolCounts)
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([name, count]) => `  ${name}: ${count}`).join("\n") || "  none";
      const activeAccounts = new Set(recent.map(t => t.api_key)).size;
      return sendMessage(chatId,
        `📅 <b>Last 24h digest</b>\n\n` +
        `Tool calls: <b>${recent.length}</b>\n` +
        `HBAR earned: <b>${earned.toFixed(4)} ℏ</b>\n` +
        `Active accounts: <b>${activeAccounts}</b>\n\n` +
        `<b>Top tools:</b>\n${topTools}`
      );
    } catch (e) { return sendMessage(chatId, `❌ Digest error: ${e.message}`); }
  }

  // /edit (owner, inline)
  if (isOwner && text.startsWith("/edit ")) {
    const newText = text.replace(/^\/edit\s+/, "").trim();
    if (newText) { await handleXAgentEdit(chatId, newText); return; }
  }

  // AI response
  addToHistory(chatId, "user", text);
  await telegramRequest("sendChatAction", { chat_id: chatId, action: "typing" });

  let aiReply;
  try {
    const history = getHistory(chatId);
    aiReply = await getAIResponse(text, history.slice(0, -1));
  } catch (err) {
    console.error("[Telegram] getAIResponse threw:", err.message);
    const h = getHistory(chatId);
    if (h.length && h[h.length - 1].role === "user") h.pop();
    return sendMessage(chatId, "Sorry, I hit an error generating a response. Please try again.");
  }

  const isErrorReply = !aiReply ||
    aiReply.startsWith("I'm having") ||
    aiReply.startsWith("Sorry, something went wrong") ||
    aiReply.startsWith("Sorry, I couldn't");

  if (isErrorReply) {
    const h = getHistory(chatId);
    if (h.length && h[h.length - 1].role === "user") h.pop();
    return sendMessage(chatId, aiReply || "Sorry, I hit an error. Please try again.");
  }

  const escalateMatch = aiReply.match(/ESCALATE:\s*(.+)$/m);
  const replyText = aiReply.replace(/\nESCALATE:.+$/m, "").trim();
  addToHistory(chatId, "assistant", replyText);
  await sendMessage(chatId, replyText);

  if (escalateMatch && OWNER_ID) {
    await notifyOwner(
      `🚨 <b>Escalation needed</b>\n\n` +
      `From: ${username} (chat ID: <code>${chatId}</code>)\n` +
      `Message: "<i>${text}</i>"\n\n` +
      `Reason: ${escalateMatch[1].trim()}\n\n` +
      `Reply to them at: https://t.me/${msg.from?.username || chatId}`
    );
  }
}

// --- Webhook registration -----------------------------------------------------

export async function registerWebhook() {
  if (!BOT_TOKEN) {
    console.error("[Telegram] TELEGRAM_BOT_TOKEN not set — bot disabled");
    return;
  }

  const webhookUrl = `${RAILWAY_URL}/telegram/webhook`;
  console.error(`[Telegram] Registering webhook at: ${webhookUrl}`);

  try {
    const result = await telegramRequest("setWebhook", { url: webhookUrl });
    if (result?.ok) {
      console.error(`[Telegram] Webhook registered successfully`);
      if (OWNER_ID) await notifyOwner(`✅ <b>HederaToolbox bot started</b>\nWebhook: ${webhookUrl}`);
    } else {
      console.error(`[Telegram] Webhook registration failed:`, JSON.stringify(result));
    }
  } catch (err) {
    console.error(`[Telegram] Webhook registration error:`, err.message);
  }
}
