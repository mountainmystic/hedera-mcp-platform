// visionforge.js — Daily financial heartbeat for the Toolbox + Fixatum fleet
// Runs once daily at 13:00 UTC (05:00 Vancouver time)
// Internal only. Posts to /agent-report on Fixatum.
// Midas reads it via /agent-status and decides whether to surface it.
// No Telegram. No proposals. Numbers only.

import https from "https";

const ADMIN_SECRET         = process.env.ADMIN_SECRET;
const FIXATUM_API_URL      = process.env.FIXATUM_API_URL      || "https://did.fixatum.com";
const FIXATUM_ADMIN_SECRET = process.env.FIXATUM_ADMIN_SECRET;
const FIXATUM_WALLET       = process.env.FIXATUM_WALLET       || "0.0.10394452";
const TOOLBOX_WALLET       = "0.0.10309126";
const FIXATUM_API_KEY      = "0.0.10394452"; // Fixatum's account on the Toolbox platform

let briefCounter = 0;

// --- Alert thresholds (HBAR) -------------------------------------------------
const TOOLBOX_TREASURY_WARN  = 50;   // mirror node balance
const FIXATUM_TREASURY_WARN  = 20;   // mirror node balance
const XAGENT_BALANCE_WARN    = 5;    // Toolbox platform balance
const FIXATUM_TOOLBOX_WARN   = 20;   // Fixatum working capital on Toolbox (~9 registrations)
const COST_PER_REGISTRATION  = 2.1;  // hcs_create_topic(2.0) + hcs_write_record(0.1). identity_check_sanctions now cached 24h — not charged per registration.

// --- Mirror node balance query ------------------------------------------------

async function getAccountBalance(accountId) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "mainnet-public.mirrornode.hedera.com",
      path: `/api/v1/accounts/${accountId}`,
      method: "GET",
      headers: { "Accept": "application/json" },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve((parsed?.balance?.balance ?? 0) / 100_000_000);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

// --- Toolbox /admin/accounts -------------------------------------------------
// Single call covers both XAgent balance and Fixatum working capital.

async function getToolboxAccounts() {
  if (!ADMIN_SECRET) return null;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.hederatoolbox.com",
      path: "/admin/accounts",
      method: "GET",
      headers: { "x-admin-secret": ADMIN_SECRET, "Accept": "application/json" },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(Array.isArray(parsed) ? parsed : (parsed?.accounts ?? []));
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

// --- Toolbox analytics — 24h calls and revenue -------------------------------

async function getToolboxStats() {
  if (!ADMIN_SECRET) return null;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.hederatoolbox.com",
      path: "/admin/analytics",
      method: "GET",
      headers: { "x-admin-secret": ADMIN_SECRET, "Accept": "application/json" },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

// --- Fixatum issuances — registration counts ---------------------------------

async function getFixatumIssuances() {
  if (!FIXATUM_ADMIN_SECRET) return null;
  const hostname = new URL(FIXATUM_API_URL).hostname;
  return new Promise((resolve) => {
    const req = https.request({
      hostname,
      path: "/admin/issuances",
      method: "GET",
      headers: { "x-admin-secret": FIXATUM_ADMIN_SECRET, "Accept": "application/json" },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

// --- Haiku observation — one dry, factual sentence ---------------------------

async function synthesiseObservation(metricsBlock) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return null;

  const body = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 120,
    system: `You are a financial monitoring agent. You receive daily metrics for two Hedera products: HederaToolbox and Fixatum. Write exactly ONE sentence — dry, factual, observational. Flag anything anomalous or worth noting. Acknowledge steady state if nothing is notable. No proposals, no suggestions, no fluff. Plain text only, no markdown.`,
    messages: [{ role: "user", content: `Today's metrics:\n\n${metricsBlock}\n\nOne sentence observation:` }],
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
        try { resolve(JSON.parse(data).content?.[0]?.text?.trim() || null); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

// --- POST agent report to Fixatum --------------------------------------------

async function postAgentReport(statusLine, metadata = {}) {
  if (!FIXATUM_ADMIN_SECRET) return;
  const hostname = new URL(FIXATUM_API_URL).hostname;
  const body = JSON.stringify({ agent_id: "visionforge", status_line: statusLine, metadata });
  return new Promise((resolve) => {
    const req = https.request({
      hostname,
      path: "/agent-report",
      method: "POST",
      headers: {
        "x-admin-secret": FIXATUM_ADMIN_SECRET,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, res => { res.on("data", () => {}); res.on("end", resolve); });
    req.on("error", () => resolve());
    req.write(body);
    req.end();
  });
}

// --- Main cycle --------------------------------------------------------------

export async function runVisionForgeCycle() {
  briefCounter++;
  const briefNum = briefCounter;
  const date = new Date().toISOString().slice(0, 10);
  console.error(`[VisionForge] Running cycle #${briefNum} -- ${date}`);

  // Gather all data in parallel
  const [
    toolboxBalance,
    fixatumBalance,
    toolboxAccounts,
    toolboxStats,
    fixatumIssuances,
  ] = await Promise.all([
    getAccountBalance(TOOLBOX_WALLET),
    getAccountBalance(FIXATUM_WALLET),
    getToolboxAccounts(),
    getToolboxStats(),
    getFixatumIssuances(),
  ]);

  // Extract platform balances from the accounts list
  const XAGENT_KEY = process.env.XAGENT_API_KEY;
  const xagentEntry = XAGENT_KEY && toolboxAccounts
    ? toolboxAccounts.find(a => a.api_key === XAGENT_KEY)
    : null;
  const xagentHbar = xagentEntry ? xagentEntry.balance_tinybars / 100_000_000 : null;

  const fixatumToolboxEntry = toolboxAccounts
    ? toolboxAccounts.find(a => a.api_key === FIXATUM_API_KEY)
    : null;
  const fixatumToolboxHbar = fixatumToolboxEntry
    ? fixatumToolboxEntry.balance_tinybars / 100_000_000
    : null;
  const runway = fixatumToolboxHbar !== null
    ? Math.floor(fixatumToolboxHbar / COST_PER_REGISTRATION)
    : null;

  // 24h activity
  const calls24h   = toolboxStats?.monthly?.this_month?.calls ?? null;
  const revenue24h = toolboxStats?.monthly?.this_month?.hbar  ?? null;

  const since24h = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19);
  let reg24h = 0, regTotal = 0;
  if (Array.isArray(fixatumIssuances)) {
    regTotal = fixatumIssuances.length;
    reg24h   = fixatumIssuances.filter(i => i.registered_at >= since24h).length;
  }

  // Alerts — collected for metadata, logged to console
  const fmt = (v, d = 2) => v !== null ? v.toFixed(d) + " H" : "unknown";
  const alerts = [];
  if (fixatumToolboxHbar !== null && fixatumToolboxHbar < FIXATUM_TOOLBOX_WARN) {
    alerts.push(`CRITICAL: Fixatum working capital ${fmt(fixatumToolboxHbar)} (~${runway} reg left)`);
  }
  if (toolboxBalance !== null && toolboxBalance < TOOLBOX_TREASURY_WARN) {
    alerts.push(`LOW: Toolbox treasury ${fmt(toolboxBalance)}`);
  }
  if (fixatumBalance !== null && fixatumBalance < FIXATUM_TREASURY_WARN) {
    alerts.push(`LOW: Fixatum treasury ${fmt(fixatumBalance)}`);
  }
  if (xagentHbar !== null && xagentHbar < XAGENT_BALANCE_WARN) {
    alerts.push(`LOW: XAgent balance ${fmt(xagentHbar)}`);
  }

  if (alerts.length > 0) {
    console.error(`[VisionForge] ALERTS: ${alerts.join(" | ")}`);
  }

  // Haiku observation
  const metricsBlock = [
    `Toolbox treasury: ${fmt(toolboxBalance)}`,
    `Fixatum treasury: ${fmt(fixatumBalance)}`,
    `XAgent balance: ${fmt(xagentHbar)}`,
    `Fixatum->Toolbox capital: ${fmt(fixatumToolboxHbar)} (~${runway ?? "?"} registrations runway)`,
    `24h registrations: ${reg24h} | Total DIDs: ${regTotal}`,
    `24h tool calls: ${calls24h ?? "?"} | 24h revenue: ${revenue24h ?? "?"} H`,
    alerts.length > 0 ? `Alerts: ${alerts.join("; ")}` : `No alerts.`,
  ].join("\n");

  const observation = await synthesiseObservation(metricsBlock);

  // Post to Fixatum agent-report — Midas reads this
  const statusLine = [
    `#${briefNum} ${date}`,
    `Toolbox: ${fmt(toolboxBalance)}`,
    `Fixatum->TB: ${fmt(fixatumToolboxHbar)} (~${runway ?? "?"} reg)`,
    `24h reg:${reg24h} calls:${calls24h ?? "?"} rev:${revenue24h ?? "?"}H`,
    alerts.length > 0 ? `[${alerts.length} ALERT(S)]` : `[OK]`,
  ].join(" | ");

  await postAgentReport(statusLine, {
    brief_number:           briefNum,
    date,
    toolbox_treasury_hbar:  toolboxBalance,
    fixatum_treasury_hbar:  fixatumBalance,
    fixatum_toolbox_hbar:   fixatumToolboxHbar,
    xagent_hbar:            xagentHbar,
    runway_registrations:   runway,
    reg_24h:                reg24h,
    reg_total:              regTotal,
    calls_24h:              calls24h,
    revenue_24h_hbar:       revenue24h,
    alerts,
    observation:            observation || null,
  });

  console.error(`[VisionForge] Cycle #${briefNum} complete. Alerts: ${alerts.length}. Posted to agent-report.`);
}

// --- Scheduler: 13:00 UTC daily (05:00 Vancouver) ----------------------------

export function scheduleVisionForge() {
  const now  = new Date();
  const next = new Date();
  next.setUTCHours(13, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const ms = next - now;

  console.error(`[VisionForge] Next cycle in ${Math.round(ms / 3600000 * 10) / 10}h (13:00 UTC / 05:00 Vancouver)`);

  setTimeout(() => {
    runVisionForgeCycle();
    setInterval(runVisionForgeCycle, 24 * 60 * 60 * 1000);
  }, ms);
}
