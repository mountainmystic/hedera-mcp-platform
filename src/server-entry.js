// server-entry.js — Railway / HTTP server entry point (remote brain)
// This is what Railway runs. Contains all Hedera SDK logic.
// NOT shipped in the npm package (blocked by .npmignore).
import "dotenv/config";
import { createServer, ALL_TOOLS } from "./server.js";
import { getCosts } from "./payments.js";
import { provisionKey, getAllAccounts, getRecentTransactions, checkRateLimit, purgeOldConsentPII, getProvenanceByKey, getProvenanceByDid, setAgentDid, getAgentDid } from "./db.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TERMS = JSON.parse(readFileSync(path.join(__dirname, "../legal/terms.json"), "utf-8"));
const { version: VERSION } = JSON.parse(readFileSync(path.join(__dirname, "../package.json"), "utf-8"));
import { startWatcher } from "./watcher.js";
import { handleTelegramUpdate, registerWebhook } from "./telegram.js";
import { scheduleVisionForge } from "./visionforge.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "http";
import https from "https";

// Module-level mirror node balance helper
async function mirrorNodeBalance(accountId) {
  return new Promise((resolve) => {
    const req2 = https.request({
      hostname: "mainnet-public.mirrornode.hedera.com",
      path: `/api/v1/accounts/${accountId}`,
      method: "GET",
      headers: { "Accept": "application/json" },
    }, resp => {
      let d = "";
      resp.on("data", c => d += c);
      resp.on("end", () => {
        try { resolve((JSON.parse(d)?.balance?.balance ?? 0) / 100_000_000); }
        catch { resolve(null); }
      });
    });
    req2.on("error", () => resolve(null));
    req2.end();
  });
}

const required = ["HEDERA_ACCOUNT_ID", "HEDERA_PRIVATE_KEY", "ANTHROPIC_API_KEY"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error("Missing env vars: " + missing.join(", "));
  process.exit(1);
}

const MAX_BODY_BYTES = 1_048_576; // 1MB — reject anything larger before full read

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return reject(Object.assign(new Error("Request body too large"), { code: 413 }));
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function isAdmin(req) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  // Header-only auth — ?secret= URL param removed (leaks to server logs)
  return req.headers["x-admin-secret"] === secret;
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

const port = process.env.PORT || 3000;
const startTime = Date.now();

// ── Rate limiter for free endpoints ──────────────────────────────────────────
// SQLite-backed — survives restarts. Logic in db.js checkRateLimit().

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);

  req.on("error", (e) => {
    if (!res.headersSent) json(res, 413, { error: "Request body too large. Maximum size is 1MB." });
  });

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return json(res, 200, {
      status: "ok",
      service: "HederaToolbox — Hedera MCP Platform",
      version: VERSION,
      network: process.env.HEDERA_NETWORK,
      account: process.env.HEDERA_ACCOUNT_ID,
      watcher_running: !!process.env.HEDERA_ACCOUNT_ID,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      modules: ["hcs", "compliance", "governance", "token", "identity", "contract"],
      tools: ALL_TOOLS.map((t) => t.name),
      costs: getCosts(),
      mcp_endpoint: "/mcp",
      terms_endpoint: "/terms",
      timestamp: new Date().toISOString(),
    });
  }

  if (req.method === "GET" && url.pathname === "/terms") {
    return json(res, 200, TERMS);
  }

  if (["get_terms", "confirm_terms", "account_info"].some(t => url.pathname.includes(t))) {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
    if (checkRateLimit(ip)) {
      return json(res, 429, { error: "Rate limit exceeded. Max 30 requests per 60 seconds.", retry_after_seconds: 60 });
    }
  }

  if (req.method === "GET" && url.pathname.startsWith("/public/")) {
    const filename = url.pathname.replace("/public/", "");
    const staticPath = path.join(__dirname, "../public", filename);
    try {
      const content = readFileSync(staticPath, "utf-8");
      const ct = filename.endsWith(".json") ? "application/json" : "text/plain";
      res.writeHead(200, { "Content-Type": ct });
      res.end(content);
    } catch {
      return json(res, 404, { error: "File not found" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/telegram/webhook") {
    try {
      const body = JSON.parse(await readBody(req));
      handleTelegramUpdate(body).catch(e => console.error("[Telegram] Update error:", e.message));
    } catch (e) {
      console.error("[Telegram] Webhook parse error:", e.message);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }

  if (url.pathname === "/mcp") {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/provision") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    try {
      const body = JSON.parse(await readBody(req));
      const { api_key, hbar, hedera_account_id } = body;
      if (!api_key || !hbar) return json(res, 400, { error: "api_key and hbar are required" });
      const tinybars = Math.round(Number(hbar) * 100_000_000);
      const account = provisionKey(api_key, tinybars, hedera_account_id || null);
      return json(res, 200, {
        success: true,
        api_key: account.api_key,
        balance_hbar: (account.balance_tinybars / 100_000_000).toFixed(4),
        hedera_account_id: account.hedera_account_id,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/admin/accounts") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    const accounts = getAllAccounts().map((a) => ({
      ...a,
      balance_hbar: (a.balance_tinybars / 100_000_000).toFixed(4),
    }));
    return json(res, 200, { accounts });
  }

  if (req.method === "GET" && url.pathname === "/admin/transactions") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    return json(res, 200, { transactions: getRecentTransactions(100) });
  }

  if (req.method === "GET" && url.pathname === "/admin/stats") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    const { db } = await import("./db.js");
    const toolRanking = db.prepare(`
      SELECT tool_name, COUNT(*) as call_count, SUM(amount_tinybars) as total_tinybars
      FROM transactions GROUP BY tool_name ORDER BY call_count DESC
    `).all();
    const dailyVolume = db.prepare(`
      SELECT DATE(timestamp) as date, COUNT(*) as calls, SUM(amount_tinybars) as tinybars
      FROM transactions GROUP BY DATE(timestamp) ORDER BY date DESC LIMIT 30
    `).all();
    const totalCalls = db.prepare(`SELECT COUNT(*) as n FROM transactions`).get();
    const totalAccounts = db.prepare(`SELECT COUNT(*) as n FROM accounts`).get();
    const totalDeposits = db.prepare(`SELECT SUM(amount_tinybars) as n FROM deposits`).get();
    const watcherStatus = {
      platform_account: process.env.HEDERA_ACCOUNT_ID,
      network: process.env.HEDERA_NETWORK,
      poll_interval_seconds: 10,
      status: "running",
    };
    return json(res, 200, {
      watcher: watcherStatus,
      summary: {
        total_calls: totalCalls.n,
        total_accounts: totalAccounts.n,
        total_deposited_hbar: ((totalDeposits.n || 0) / 100_000_000).toFixed(4),
      },
      tool_ranking: toolRanking.map(r => ({
        tool: r.tool_name,
        calls: r.call_count,
        revenue_hbar: (r.total_tinybars / 100_000_000).toFixed(4),
      })),
      daily_volume: dailyVolume.map(d => ({
        date: d.date,
        calls: d.calls,
        revenue_hbar: (d.tinybars / 100_000_000).toFixed(4),
      })),
    });
  }

  // Analytics endpoint — period-aware revenue, tool trends, top spenders, monthly comparison
  if (req.method === "GET" && url.pathname === "/admin/analytics") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    const { db } = await import("./db.js");

    // Period-aware revenue query: daily (30d), weekly (24w), monthly (12m)
    const period = url.searchParams.get('period') || 'daily';
    let revenueRows;
    if (period === 'weekly') {
      revenueRows = db.prepare(`
        SELECT strftime('%Y-W%W', timestamp) as date, COUNT(*) as calls, SUM(amount_tinybars) as tinybars
        FROM transactions WHERE timestamp >= datetime('now', '-84 days')
        GROUP BY strftime('%Y-W%W', timestamp) ORDER BY date ASC
      `).all();
    } else if (period === 'monthly') {
      revenueRows = db.prepare(`
        SELECT strftime('%Y-%m', timestamp) as date, COUNT(*) as calls, SUM(amount_tinybars) as tinybars
        FROM transactions WHERE timestamp >= datetime('now', '-365 days')
        GROUP BY strftime('%Y-%m', timestamp) ORDER BY date ASC
      `).all();
    } else {
      revenueRows = db.prepare(`
        SELECT DATE(timestamp) as date, COUNT(*) as calls, SUM(amount_tinybars) as tinybars
        FROM transactions WHERE timestamp >= datetime('now', '-30 days')
        GROUP BY DATE(timestamp) ORDER BY date ASC
      `).all();
    }

    const thisMonth = db.prepare(`
      SELECT COUNT(*) as calls, COALESCE(SUM(amount_tinybars),0) as tinybars
      FROM transactions WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')
    `).get();
    const lastMonth = db.prepare(`
      SELECT COUNT(*) as calls, COALESCE(SUM(amount_tinybars),0) as tinybars
      FROM transactions WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', datetime('now', '-1 month'))
    `).get();

    const topSpenders = db.prepare(`
      SELECT api_key, COUNT(*) as calls, SUM(amount_tinybars) as tinybars
      FROM transactions GROUP BY api_key ORDER BY tinybars DESC LIMIT 10
    `).all();

    const toolTrends = db.prepare(`
      SELECT tool_name,
        SUM(CASE WHEN timestamp >= datetime('now','-7 days') THEN 1 ELSE 0 END) as calls_7d,
        SUM(CASE WHEN timestamp >= datetime('now','-14 days') AND timestamp < datetime('now','-7 days') THEN 1 ELSE 0 END) as calls_prev_7d
      FROM transactions WHERE timestamp >= datetime('now','-14 days')
      GROUP BY tool_name ORDER BY calls_7d DESC
    `).all();

    const avgCalls = db.prepare(`
      SELECT ROUND(CAST(COUNT(*) AS FLOAT) / MAX(1, (SELECT COUNT(*) FROM accounts)), 1) as avg
      FROM transactions
    `).get();

    const rateLimitHits = db.prepare(`SELECT COUNT(*) as n FROM rate_limits WHERE count >= 30`).get();

    const newAccounts30d = db.prepare(`
      SELECT DATE(created_at) as date, COUNT(*) as n
      FROM accounts WHERE created_at >= datetime('now', '-30 days')
      GROUP BY DATE(created_at) ORDER BY date ASC
    `).all();

    const xagentKey = process.env.XAGENT_API_KEY;
    let xagent = null;
    if (xagentKey) {
      const xacc = db.prepare(`SELECT * FROM accounts WHERE api_key = ?`).get(xagentKey);
      const xspend = db.prepare(`
        SELECT COALESCE(SUM(amount_tinybars),0) as tinybars, COUNT(*) as calls
        FROM transactions WHERE api_key = ? AND timestamp >= datetime('now','-24 hours')
      `).get(xagentKey);
      if (xacc) xagent = {
        balance_hbar: (xacc.balance_tinybars / 100_000_000).toFixed(4),
        last_used: xacc.last_used,
        calls_24h: xspend.calls,
        spent_24h_hbar: (xspend.tinybars / 100_000_000).toFixed(4),
      };
    }

    return json(res, 200, {
      period,
      daily_revenue: revenueRows.map(d => ({ date: d.date, calls: d.calls, hbar: (d.tinybars / 100_000_000).toFixed(4) })),
      monthly: {
        this_month: { calls: thisMonth.calls, hbar: (thisMonth.tinybars / 100_000_000).toFixed(4) },
        last_month: { calls: lastMonth.calls, hbar: (lastMonth.tinybars / 100_000_000).toFixed(4) },
      },
      top_spenders: topSpenders.map(s => ({ api_key: s.api_key, calls: s.calls, hbar: (s.tinybars / 100_000_000).toFixed(4) })),
      tool_trends: toolTrends,
      avg_calls_per_account: avgCalls.avg || 0,
      rate_limit_hits_24h: rateLimitHits.n,
      new_accounts_30d: newAccounts30d,
      xagent,
    });
  }

  // ── Tool access management ─────────────────────────────────────────────────
  // POST /admin/grant-tool-access  { api_key, tool_name }
  // POST /admin/revoke-tool-access { api_key, tool_name }
  // GET  /admin/tool-access        — list all grants

  if (req.method === "POST" && url.pathname === "/admin/grant-tool-access") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    try {
      const { api_key, tool_name } = JSON.parse(await readBody(req));
      if (!api_key || !tool_name) return json(res, 400, { error: "api_key and tool_name required" });
      const { grantToolAccess } = await import("./db.js");
      grantToolAccess(api_key, tool_name, "admin");
      console.error(`[Access] Granted ${tool_name} to ${api_key}`);
      return json(res, 200, { success: true, api_key, tool_name, message: `Access to ${tool_name} granted.` });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (req.method === "POST" && url.pathname === "/admin/revoke-tool-access") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    try {
      const { api_key, tool_name } = JSON.parse(await readBody(req));
      if (!api_key || !tool_name) return json(res, 400, { error: "api_key and tool_name required" });
      const { revokeToolAccess } = await import("./db.js");
      const removed = revokeToolAccess(api_key, tool_name);
      console.error(`[Access] Revoked ${tool_name} from ${api_key}`);
      return json(res, 200, { success: true, api_key, tool_name, removed, message: removed ? `Access to ${tool_name} revoked.` : "Grant not found." });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (req.method === "GET" && url.pathname === "/admin/tool-access") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    const { getAllToolGrants } = await import("./db.js");
    return json(res, 200, { grants: getAllToolGrants() });
  }

  // GDPR delete
  if (req.method === "DELETE" && url.pathname === "/admin/delete-account") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    try {
      const body = JSON.parse(await readBody(req));
      const { api_key } = body;
      if (!api_key) return json(res, 400, { error: "api_key required" });
      const { db } = await import("./db.js");
      const account = db.prepare(`SELECT hedera_account_id FROM accounts WHERE api_key = ?`).get(api_key);
      if (!account) return json(res, 404, { error: "Account not found" });
      db.exec("BEGIN");
      try {
        const txDel  = db.prepare(`DELETE FROM transactions WHERE api_key = ?`).run(api_key);
        const ceDel  = db.prepare(`DELETE FROM consent_events WHERE api_key = ?`).run(api_key);
        const depDel = account.hedera_account_id
          ? db.prepare(`DELETE FROM deposits WHERE hedera_account_id = ?`).run(account.hedera_account_id)
          : { changes: 0 };
        const accDel = db.prepare(`DELETE FROM accounts WHERE api_key = ?`).run(api_key);
        db.exec("COMMIT");
        console.error(`[Admin] Deleted account ${api_key}`);
        return json(res, 200, { success: true, deleted: { transactions: txDel.changes, consent_events: ceDel.changes, deposits: depDel.changes, accounts: accDel.changes } });
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // Agent self-identification — binds a Fixatum DID to an api_key permanently.
  // Called by agents autonomously: POST /identify { api_key, agent_did }
  // Requires a valid account. No admin secret required — the agent owns the key.
  // DID format validated: must start with did:hedera:mainnet:
  if (req.method === "POST" && url.pathname === "/identify") {
    try {
      const body     = JSON.parse(await readBody(req));
      const { api_key, agent_did } = body;
      if (!api_key || !agent_did) {
        return json(res, 400, { error: "api_key and agent_did are required" });
      }
      if (!agent_did.startsWith("did:hedera:mainnet:")) {
        return json(res, 400, { error: "agent_did must be a valid Fixatum DID (did:hedera:mainnet:...)" });
      }
      const bound = setAgentDid(api_key, agent_did);
      if (!bound) return json(res, 404, { error: "Account not found. Send HBAR to create an account first." });
      console.error(`[Identity] DID bound: ${api_key} → ${agent_did}`);
      return json(res, 200, {
        success:   true,
        api_key,
        agent_did,
        message:   "DID bound. All future tool calls from this key will include this DID in provenance records.",
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // One-shot: clear all provenance risk_flags for a given api_key.
  // Used when flag logic changes and old records are stale.
  if (req.method === "POST" && url.pathname === "/admin/provenance/clear-flags") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    try {
      const body = JSON.parse(await readBody(req));
      const { api_key } = body;
      if (!api_key) return json(res, 400, { error: "api_key required" });
      const { db } = await import("./db.js");
      const result = db.prepare(`UPDATE provenance SET risk_flags = NULL WHERE api_key = ?`).run(api_key);
      return json(res, 200, { success: true, cleared: result.changes });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (req.method === "GET" && url.pathname === "/admin/provenance") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    const { getProvenanceByKey, getProvenanceByDid } = await import("./db.js");
    const apiKey   = url.searchParams.get("api_key");
    const agentDid = url.searchParams.get("agent_did");
    const limit    = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);
    if (!apiKey && !agentDid) return json(res, 400, { error: "api_key or agent_did required" });
    const raw = apiKey ? getProvenanceByKey(apiKey, limit) : getProvenanceByDid(agentDid, limit);
    const records = raw.map(r => ({
      ...r,
      risk_flags: r.risk_flags ? r.risk_flags.split(",").filter(Boolean) : [],
    }));
    return json(res, 200, { count: records.length, records });
  }

  // Fleet balance endpoint — mirror node queries for Fixatum + TheRecordKeeper wallets
  if (req.method === "GET" && url.pathname === "/admin/fleet-balances") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    const FIXATUM_WALLET_ID = "0.0.10394452";
    const TRK_WALLET_ID     = "0.0.10419731";
    const { db } = await import("./db.js");
    const fixatumToolboxAcct = db.prepare("SELECT balance_tinybars FROM accounts WHERE hedera_account_id = ? OR api_key = ?").get(FIXATUM_WALLET_ID, FIXATUM_WALLET_ID);
    const fixatumWorkingCapital = fixatumToolboxAcct ? (fixatumToolboxAcct.balance_tinybars / 100_000_000).toFixed(4) : null;
    const [fixatumMirror, trkMirror] = await Promise.all([
      mirrorNodeBalance(FIXATUM_WALLET_ID),
      mirrorNodeBalance(TRK_WALLET_ID),
    ]);
    return json(res, 200, {
      fixatum_wallet_hbar:     fixatumMirror !== null ? parseFloat(fixatumMirror.toFixed(4)) : null,
      fixatum_working_capital: fixatumWorkingCapital,
      trk_wallet_hbar:         trkMirror !== null ? parseFloat(trkMirror.toFixed(4)) : null,
      fixatum_wallet:          FIXATUM_WALLET_ID,
      trk_wallet:              TRK_WALLET_ID,
    });
  }

  if (req.method === "GET" && url.pathname === "/admin/dashboard") {
    const secret = process.env.ADMIN_SECRET;
    const authHeader = req.headers["authorization"] || "";
    const encoded = authHeader.replace(/^Basic\s+/, "");
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const provided = decoded.split(":").slice(1).join(":"); // password portion only
    if (!secret || provided !== secret) {
      res.writeHead(401, {
        "Content-Type": "text/html; charset=utf-8",
        "WWW-Authenticate": 'Basic realm="HederaToolbox Admin"',
      });
      return res.end("Unauthorized");
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(getDashboardHTML(secret));
    return;
  }

  if (req.method === "GET" && url.pathname === "/admin/backup") {
    const backupSecret = process.env.BACKUP_SECRET;
    if (!backupSecret || req.headers["x-backup-secret"] !== backupSecret) {
      return json(res, 401, { error: "Unauthorized. Requires x-backup-secret header." });
    }
    try {
      const dbPath = process.env.DB_PATH || "/data/hederatoolbox.db";
      const dbFile = readFileSync(dbPath);
      const filename = `hederatoolbox-backup-${new Date().toISOString().slice(0,10)}.db`;
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": dbFile.length,
      });
      res.end(dbFile);
    } catch (e) {
      return json(res, 500, { error: `Backup failed: ${e.message}` });
    }
    return;
  }

  // ── Public reputation endpoint — read by Fixatum and any external platform.
  // GET /reputation/:did or GET /reputation?did=...
  // Returns a credibility summary for a Fixatum DID: call count, date range,
  // risk flag rate. No auth required — this is the public signal layer.
  if (req.method === "GET" && (url.pathname === "/reputation" || url.pathname.startsWith("/reputation/"))) {
    const { getProvenanceByDid } = await import("./db.js");
    const did = url.pathname.startsWith("/reputation/")
      ? decodeURIComponent(url.pathname.slice("/reputation/".length))
      : url.searchParams.get("did");
    if (!did) return json(res, 400, { error: "DID required. Use /reputation/:did or ?did=..." });
    if (!did.startsWith("did:hedera:mainnet:")) {
      return json(res, 400, { error: "Invalid DID format. Expected did:hedera:mainnet:..." });
    }
    const records = getProvenanceByDid(did, 1000);
    if (records.length === 0) {
      return json(res, 200, {
        did,
        verified_calls: 0,
        first_call: null,
        last_call: null,
        active_days: 0,
        risk_flag_rate: 0,
        risk_flags_seen: [],
        summary: "No verified tool calls on record for this DID.",
      });
    }
    const flagged = records.filter(r => r.risk_flags && r.risk_flags.length > 0);
    const allFlags = [...new Set(
      records.flatMap(r => r.risk_flags ? r.risk_flags.split(",").filter(Boolean) : [])
    )];
    const timestamps = records.map(r => r.timestamp).sort();
    const days = new Set(timestamps.map(t => t.slice(0, 10))).size;
    // Velocity windows
    const now = Date.now();
    const calls_last_24h = records.filter(r => r.timestamp && (now - new Date(r.timestamp).getTime()) < 86_400_000).length;
    const calls_last_7d  = records.filter(r => r.timestamp && (now - new Date(r.timestamp).getTime()) < 604_800_000).length;
    // Tool diversity breakdown
    const tool_breakdown = {};
    for (const r of records) {
      if (r.tool_name) tool_breakdown[r.tool_name] = (tool_breakdown[r.tool_name] || 0) + 1;
    }
    return json(res, 200, {
      did,
      verified_calls: records.length,
      first_call: timestamps[0],
      last_call: timestamps[timestamps.length - 1],
      active_days: days,
      calls_last_24h,
      calls_last_7d,
      tool_breakdown,
      risk_flag_rate: parseFloat((flagged.length / records.length).toFixed(4)),
      risk_flags_seen: allFlags,
      source: "api.hederatoolbox.com",
      summary: `${records.length} verified tool calls over ${days} active days. Risk flag rate: ${(flagged.length / records.length * 100).toFixed(1)}%.`,
    });
  }

  return json(res, 404, { error: "Not found", mcp_endpoint: "/mcp" });
});

function getDashboardHTML(adminSecret) {
  const platformAccount = process.env.HEDERA_ACCOUNT_ID || "";
  const hasXAgent = !!process.env.XAGENT_API_KEY;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>HederaToolbox Admin</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; min-height: 100vh; }
  header { background: #111; border-bottom: 1px solid #222; padding: 12px 16px; display: flex; align-items: center; gap: 10px; position: sticky; top: 0; z-index: 50; }
  header h1 { font-size: 16px; font-weight: 600; color: #fff; }
  .badge { background: #1a3a2a; color: #4ade80; font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid #2a5a3a; }
  #last-updated { font-size: 11px; color: #444; margin-left: auto; }
  .btn { background: #1a1a1a; border: 1px solid #333; color: #888; padding: 5px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .btn:hover { color: #fff; border-color: #555; }
  .btn.danger { border-color: #4a1a1a; color: #f87171; }
  .btn.danger:hover { background: #2a0a0a; border-color: #ef4444; }
  .btn.green { border-color: #1a4a2a; color: #4ade80; }
  .btn.green:hover { background: #0a2a1a; }
  #menu-btn { display: none; background: none; border: 1px solid #333; color: #888; padding: 5px 9px; border-radius: 6px; font-size: 16px; cursor: pointer; line-height: 1; }
  #layout { display: grid; grid-template-columns: 280px 1fr; min-height: calc(100vh - 49px); }
  #sidebar { border-right: 1px solid #1a1a1a; padding: 14px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
  #main { padding: 14px; overflow-y: auto; }
  .card { background: #111; border: 1px solid #1e1e1e; border-radius: 8px; padding: 12px; }
  .card-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #555; margin-bottom: 6px; }
  .card-value { font-size: 26px; font-weight: 700; color: #fff; line-height: 1; }
  .card-sub { font-size: 11px; color: #444; margin-top: 5px; }
  .card-sub.up { color: #4ade80; } .card-sub.down { color: #f87171; }
  .sec-head { font-size: 11px; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
  .tbl { width: 100%; border-collapse: collapse; background: #111; border: 1px solid #1e1e1e; border-radius: 10px; overflow: hidden; }
  .tbl th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #444; padding: 9px 12px; border-bottom: 1px solid #1a1a1a; }
  .tbl td { padding: 8px 12px; font-size: 12px; border-bottom: 1px solid #161616; }
  .tbl tr:last-child td { border-bottom: none; }
  .tbl-scroll { max-height: 220px; overflow-y: auto; border: 1px solid #1e1e1e; border-radius: 10px; }
  .tbl-scroll table { border: none; border-radius: 0; }
  .bar-wrap { background: #1a1a1a; border-radius: 3px; height: 4px; width: 80px; }
  .bar { background: #4ade80; height: 4px; border-radius: 3px; }
  .chart-wrap { background: #111; border: 1px solid #1e1e1e; border-radius: 10px; padding: 16px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 5px #4ade80; display: inline-block; }
  .dot.amber { background: #fbbf24; box-shadow: 0 0 5px #fbbf24; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  .dot { animation: pulse 2s infinite; }
  .mono { font-family: monospace; font-size: 11px; }
  .trend { font-size: 10px; padding: 1px 5px; border-radius: 4px; }
  .trend.up { background: #0a2a1a; color: #4ade80; }
  .trend.dn { background: #2a0a0a; color: #f87171; }
  .trend.flat { background: #1a1a1a; color: #666; }
  .qr-inline { display: flex; align-items: center; gap: 12px; }
  .qr-inline img { border-radius: 6px; background: #fff; padding: 4px; flex-shrink: 0; }
  input.ctrl { width: 100%; background: #0a0a0a; border: 1px solid #2a2a2a; color: #e0e0e0; padding: 7px 9px; border-radius: 6px; font-size: 12px; margin-bottom: 8px; }
  input.ctrl:focus { outline: none; border-color: #4ade80; }
  .modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 100; align-items: center; justify-content: center; }
  .modal-bg.open { display: flex; }
  .modal { background: #161616; border: 1px solid #2a2a2a; border-radius: 12px; padding: 24px; width: 360px; max-width: 90vw; }
  .modal h3 { font-size: 14px; font-weight: 600; margin-bottom: 14px; }
  .modal input { width: 100%; background: #0a0a0a; border: 1px solid #2a2a2a; color: #e0e0e0; padding: 8px 10px; border-radius: 6px; font-size: 13px; margin-bottom: 10px; }
  .modal input:focus { outline: none; border-color: #4ade80; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
  /* Period toggle */
  .period-btn { background: #1a1a1a; border: 1px solid #2a2a2a; color: #555; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; cursor: pointer; text-transform: uppercase; letter-spacing: 0.05em; }
  .period-btn:hover { color: #888; border-color: #444; }
  .period-btn.active { background: #0a2a1a; border-color: #2a5a3a; color: #4ade80; }
  /* Health strip responsive */
  @media (max-width: 700px) { #health-strip { grid-template-columns: 1fr 1fr !important; } }
  @media (max-width: 400px) { #health-strip { grid-template-columns: 1fr !important; } }
  /* Drag-and-drop panels */
  .panel-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .panel { border: 1px solid #1e1e1e; border-radius: 10px; background: #111; padding: 14px; cursor: grab; transition: opacity 0.2s, border-color 0.2s; min-width: 0; }
  .panel:active { cursor: grabbing; }
  .panel.dragging { opacity: 0.4; border-color: #4ade80; }
  .panel.drag-over { border-color: #4ade80; border-style: dashed; }
  .panel-handle { font-size: 11px; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; user-select: none; }
  .panel-handle::before { content: "⠿"; color: #333; font-size: 14px; }
  .panel-full { grid-column: 1 / -1; }
  #sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 40; }
  .fleet-agent { background: #0d0d0d; border: 1px solid #1e1e1e; border-radius: 6px; padding: 8px 10px; }
  .fleet-agent .fa-name { font-size: 10px; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
  .fleet-agent .fa-status { display: flex; align-items: center; gap: 5px; }
  .fleet-agent .fa-label { font-size: 11px; color: #888; }
  .fa-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .fa-dot.green { background: #4ade80; box-shadow: 0 0 4px #4ade80; }
  .fa-dot.amber { background: #fbbf24; box-shadow: 0 0 4px #fbbf24; }
  .fa-dot.grey  { background: #333; }
  @media (max-width: 900px) {
    #menu-btn { display: block; }
    #layout { grid-template-columns: 1fr; }
    #sidebar { position: fixed; top: 49px; left: 0; bottom: 0; width: 280px; z-index: 45; background: #0f0f0f; transform: translateX(-100%); transition: transform 0.25s ease; border-right: 1px solid #2a2a2a; }
    #sidebar.open { transform: translateX(0); }
    #sidebar-overlay.open { display: block; }
    .panel-grid { grid-template-columns: 1fr; }
    .panel-full { grid-column: auto; }
  }
  @media (max-width: 600px) {
    header { padding: 10px 12px; }
    header h1 { font-size: 14px; }
    #last-updated { display: none; }
    #main { padding: 10px; }
  }
</style>
</head>
<body>

<header>
  <button id="menu-btn" onclick="toggleSidebar()" title="Menu">☰</button>
  <h1>HederaToolbox</h1>
  <span class="badge" id="network-badge">mainnet</span>
  <span class="dot" id="watcher-dot" style="margin-left:4px"></span>
  <span id="last-updated"></span>
  <button class="btn" onclick="loadAll()" style="margin-left:8px">Refresh</button>
</header>

<div id="sidebar-overlay" onclick="toggleSidebar()"></div>

<div id="layout">

<div id="sidebar">
  <div class="card"><div class="card-label">Total Calls</div><div class="card-value" id="kpi-calls">—</div></div>
  <div class="card"><div class="card-label">Accounts</div><div class="card-value" id="kpi-accounts">—</div><div class="card-sub" id="kpi-avg-calls"></div></div>
  <div class="card"><div class="card-label">Total Deposited</div><div class="card-value" id="kpi-deposited">—</div><div class="card-sub">ℏ received</div></div>
  <div class="card"><div class="card-label">This Month</div><div class="card-value" id="kpi-month-hbar">—</div><div class="card-sub" id="kpi-month-delta"></div></div>
  <div class="card"><div class="card-label">Rate Limit Hits</div><div class="card-value" id="kpi-ratelimit">—</div><div class="card-sub">last 24h</div></div>

  <div style="border-top:1px solid #1a1a1a;padding-top:10px">
    <div class="sec-head">Critical Balances</div>
    <div class="card" style="margin-bottom:8px">
      <div class="card-label">Fixatum Wallet · 0.0.10394452</div>
      <div class="card-value" id="fixatum-wallet-bal" style="font-size:22px">—</div>
      <div class="card-sub" id="fixatum-wallet-sub">mirror node</div>
    </div>
    <div class="card" style="margin-bottom:8px">
      <div class="card-label">Fixatum Working Capital</div>
      <div class="card-value" id="fixatum-wc-bal" style="font-size:22px">—</div>
      <div class="card-sub" id="fixatum-wc-sub">Toolbox platform · ~3.1 ℏ/reg</div>
    </div>
    <div class="card" style="margin-bottom:8px">
      <div class="card-label">TheRecordKeeper · 0.0.10419731</div>
      <div class="card-value" id="trk-wallet-bal" style="font-size:22px">—</div>
      <div class="card-sub" id="trk-wallet-sub">mirror node</div>
    </div>
  </div>

  ${hasXAgent ? `<div style="border-top:1px solid #1a1a1a;padding-top:10px">
    <div class="sec-head">X Agent</div>
    <div class="card" style="margin-bottom:8px"><div class="card-label">Balance</div><div class="card-value" id="xa-balance">—</div><div class="card-sub">xagent-internal</div></div>
    <div class="card" style="margin-bottom:8px"><div class="card-label">Calls (24h)</div><div class="card-value" id="xa-calls">—</div><div class="card-sub" id="xa-spent"></div></div>
    <div class="card"><div class="card-label">Last Active</div><div class="card-value" style="font-size:15px" id="xa-last">—</div></div>
  </div>` : ''}

  <div style="border-top:1px solid #1a1a1a;padding-top:10px">
    <div class="sec-head">Provision / Top Up</div>
    <div style="font-size:11px;color:#444;margin-bottom:8px">Add balance to any account key.</div>
    <input id="ctrl-key" class="ctrl" placeholder="API key (e.g. xagent-internal)">
    <input id="ctrl-hbar" class="ctrl" placeholder="HBAR amount" type="number">
    <button class="btn green" style="width:100%" onclick="doProvision()">Provision / Top Up</button>
    <div id="ctrl-result" style="font-size:11px;color:#4ade80;margin-top:8px;min-height:16px"></div>
  </div>

  <div style="border-top:1px solid #1a1a1a;padding-top:10px">
    <div class="sec-head">Platform Wallet</div>
    <div class="qr-inline">
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=56x56&data=${platformAccount}" width="56" height="56" alt="QR">
      <div>
        <div class="mono" style="color:#4ade80;font-size:11px">${platformAccount}</div>
        <div style="font-size:10px;color:#444;margin-top:3px">Send HBAR to top up</div>
      </div>
    </div>
  </div>

  <div style="border-top:1px solid #1a1a1a;padding-top:10px">
    <div class="sec-head">GDPR Delete Account</div>
    <input id="del-key" class="ctrl" placeholder="API key to delete">
    <button class="btn danger" style="width:100%" onclick="openDeleteModal()">Delete Account…</button>
    <div style="font-size:10px;color:#333;margin-top:6px">Removes all data across all tables.</div>
  </div>
</div>

<div id="main">

  <!-- Health strip -->
  <div id="health-strip" style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
    <div class="card" style="padding:10px">
      <div class="card-label">Watcher</div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
        <span class="dot" id="h-watcher-dot"></span>
        <span id="h-watcher-status" style="font-size:13px;font-weight:600;color:#fff">—</span>
      </div>
    </div>
    <div class="card" style="padding:10px">
      <div class="card-label">Last Tool Call</div>
      <div id="h-last-call" style="font-size:13px;font-weight:600;color:#fff;margin-top:4px">—</div>
    </div>
    <div class="card" style="padding:10px">
      <div class="card-label">Avg Revenue/Day</div>
      <div id="h-avg-day" style="font-size:13px;font-weight:600;color:#4ade80;margin-top:4px">—</div>
    </div>
    <div class="card" style="padding:10px">
      <div class="card-label">Active Accounts</div>
      <div id="h-active-accounts" style="font-size:13px;font-weight:600;color:#fff;margin-top:4px">—</div>
      <div style="font-size:10px;color:#444;margin-top:2px">with balance</div>
    </div>
  </div>

  <!-- Agent fleet strip -->
  <div style="background:#111;border:1px solid #1e1e1e;border-radius:8px;padding:12px;margin-bottom:14px">
    <div class="sec-head" style="margin-bottom:10px">Agent Fleet</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px" id="fleet-strip">
      <div class="fleet-agent" id="fa-visionforge">—</div>
      <div class="fleet-agent" id="fa-trk">—</div>
      <div class="fleet-agent" id="fa-scout">—</div>
      <div class="fleet-agent" id="fa-narrator">—</div>
      <div class="fleet-agent" id="fa-midas">—</div>
    </div>
  </div>

  <div class="panel-grid" id="panel-grid">

    <!-- Revenue chart with period toggle -->
    <div class="panel panel-full" data-panel="revenue" draggable="true">
      <div class="panel-handle" style="justify-content:space-between">
        <span>Revenue</span>
        <div style="display:flex;gap:4px">
          <button class="period-btn active" data-period="daily" onclick="setPeriod('daily')">Daily</button>
          <button class="period-btn" data-period="weekly" onclick="setPeriod('weekly')">Weekly</button>
          <button class="period-btn" data-period="monthly" onclick="setPeriod('monthly')">Monthly</button>
        </div>
      </div>
      <div class="chart-wrap">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <span style="font-size:11px;color:#444" id="chart-period-label">ℏ per day · last 30 days</span>
          <span style="font-size:11px;color:#4ade80" id="chart-total"></span>
        </div>
        <svg id="revenue-chart" width="100%" height="80" style="display:block;overflow:visible"></svg>
        <div id="chart-hover-label" style="font-size:11px;color:#4ade80;margin-top:6px;min-height:14px;text-align:center"></div>
      </div>
    </div>

    <!-- New accounts chart -->
    <div class="panel panel-full" data-panel="newaccounts" draggable="true">
      <div class="panel-handle">New Accounts — last 30 days</div>
      <div class="chart-wrap">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <span style="font-size:11px;color:#444">signups per day</span>
          <span style="font-size:11px;color:#4ade80" id="acct-chart-total"></span>
        </div>
        <svg id="acct-chart" width="100%" height="60" style="display:block;overflow:visible"></svg>
        <div id="acct-hover-label" style="font-size:11px;color:#4ade80;margin-top:6px;min-height:14px;text-align:center"></div>
      </div>
    </div>

    <!-- Tool trends -->
    <div class="panel" data-panel="trends" draggable="true">
      <div class="panel-handle">Tool Trends — 7d vs prev 7d</div>
      <div class="tbl-scroll">
        <table class="tbl">
          <thead><tr><th>Tool</th><th>This 7d</th><th>Prev 7d</th><th></th></tr></thead>
          <tbody id="tool-trends"><tr><td colspan="4" style="color:#333">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>

    <!-- Tool ranking -->
    <div class="panel" data-panel="ranking" draggable="true">
      <div class="panel-handle">Tool Ranking — all time</div>
      <div class="tbl-scroll">
        <table class="tbl">
          <thead><tr><th>#</th><th>Tool</th><th>Calls</th><th>Revenue</th><th></th></tr></thead>
          <tbody id="tool-ranking"><tr><td colspan="5" style="color:#333">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>

    <!-- Top spenders -->
    <div class="panel" data-panel="spenders" draggable="true">
      <div class="panel-handle">Top Spenders</div>
      <div class="tbl-scroll">
        <table class="tbl">
          <thead><tr><th>Account</th><th>Calls</th><th>HBAR</th></tr></thead>
          <tbody id="top-spenders"><tr><td colspan="3" style="color:#333">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>

    <!-- Accounts -->
    <div class="panel" data-panel="accounts" draggable="true">
      <div class="panel-handle">Accounts</div>
      <div class="tbl-scroll">
        <table class="tbl">
          <thead><tr><th>Account</th><th>Balance</th><th>Last Used</th><th></th></tr></thead>
          <tbody id="accounts-table"><tr><td colspan="4" style="color:#333">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>

    <!-- Recent transactions -->
    <div class="panel" data-panel="txs" draggable="true">
      <div class="panel-handle">Recent Transactions</div>
      <div class="tbl-scroll">
        <table class="tbl">
          <thead><tr><th>Time</th><th>Account</th><th>Tool</th><th>HBAR</th></tr></thead>
          <tbody id="recent-txs"><tr><td colspan="4" style="color:#333">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>

  </div>
</div>
</div>

<div class="modal-bg" id="delete-modal">
  <div class="modal">
    <h3>⚠️ Confirm Account Deletion</h3>
    <p style="font-size:12px;color:#888;margin-bottom:14px">This will permanently remove all data for <span id="del-modal-key" style="color:#f87171;font-family:monospace"></span>. Type the account ID to confirm.</p>
    <input id="del-confirm-input" placeholder="Type account ID to confirm">
    <div class="modal-actions">
      <button class="btn" onclick="closeDeleteModal()">Cancel</button>
      <button class="btn danger" onclick="doDelete()">Delete Permanently</button>
    </div>
    <div id="del-result" style="font-size:11px;color:#f87171;margin-top:10px;min-height:16px"></div>
  </div>
</div>

<script>
const SECRET = '${adminSecret}';

async function fetchJSON(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'x-admin-secret': SECRET, 'Content-Type': 'application/json', ...(opts.headers||{}) } });
  if (r.status === 401) { alert('Session expired. Please reload.'); throw new Error('Unauthorized'); }
  return r.json();
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}

// ── Drag-and-drop ──
const PANEL_ORDER_KEY = 'htb_panel_order';
let dragSrc = null;

function savePanelOrder() {
  const order = [...document.getElementById('panel-grid').children].map(p => p.dataset.panel);
  localStorage.setItem(PANEL_ORDER_KEY, JSON.stringify(order));
}

function restorePanelOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_ORDER_KEY) || 'null');
    if (!saved) return;
    const grid = document.getElementById('panel-grid');
    const panels = Object.fromEntries([...grid.children].map(p => [p.dataset.panel, p]));
    saved.forEach(key => { if (panels[key]) grid.appendChild(panels[key]); });
  } catch(e) {}
}

function initDragDrop() {
  document.getElementById('panel-grid').querySelectorAll('.panel').forEach(panel => {
    panel.addEventListener('dragstart', e => { dragSrc = panel; panel.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    panel.addEventListener('dragend', () => { panel.classList.remove('dragging'); document.querySelectorAll('.panel').forEach(p => p.classList.remove('drag-over')); savePanelOrder(); });
    panel.addEventListener('dragover', e => { e.preventDefault(); if (dragSrc && dragSrc !== panel) { document.querySelectorAll('.panel').forEach(p => p.classList.remove('drag-over')); panel.classList.add('drag-over'); } });
    panel.addEventListener('drop', e => { e.preventDefault(); if (dragSrc && dragSrc !== panel) { const all = [...document.getElementById('panel-grid').children]; if (all.indexOf(dragSrc) < all.indexOf(panel)) document.getElementById('panel-grid').insertBefore(dragSrc, panel.nextSibling); else document.getElementById('panel-grid').insertBefore(dragSrc, panel); panel.classList.remove('drag-over'); } });
  });
}

function timeAgo(ts) {
  if (!ts) return '—';
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  if (d < 60) return Math.round(d) + 's ago';
  if (d < 3600) return Math.round(d/60) + 'm ago';
  if (d < 86400) return Math.round(d/3600) + 'h ago';
  return Math.round(d/86400) + 'd ago';
}

function pct(a, b) {
  if (!b) return a > 0 ? '+∞' : '—';
  const p = ((a - b) / b * 100).toFixed(0);
  return (p > 0 ? '+' : '') + p + '%';
}

// ── Period toggle ──
let activePeriod = localStorage.getItem('htb_chart_period') || 'daily';
const PERIOD_LABELS = { daily: 'ℏ per day · last 30 days', weekly: 'ℏ per week · last 12 weeks', monthly: 'ℏ per month · last 12 months' };

function setPeriod(p) {
  activePeriod = p;
  localStorage.setItem('htb_chart_period', p);
  document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === p));
  document.getElementById('chart-period-label').textContent = PERIOD_LABELS[p];
  fetchJSON('/admin/analytics?period=' + p).then(a => { renderRevenueChart(a.daily_revenue); updateAnalyticsPanels(a); }).catch(console.error);
}

function renderRevenueChart(rev) {
  const totalRev = rev.reduce((s, d) => s + parseFloat(d.hbar), 0);
  document.getElementById('chart-total').textContent = totalRev.toFixed(4) + ' ℏ total';
  const svgEl = document.getElementById('revenue-chart');
  if (rev.length === 0) { svgEl.innerHTML = '<text x="50%" y="50%" fill="#333" font-size="12" text-anchor="middle" dominant-baseline="middle">No data yet</text>'; return; }
  const W = svgEl.parentElement.clientWidth - 32 || 300, H = 80, pad = { top: 6, bottom: 16, left: 2, right: 2 };
  svgEl.setAttribute('viewBox', \`0 0 \${W} \${H}\`);
  const vals = rev.map(d => parseFloat(d.hbar)), maxV = Math.max(...vals, 0.0001);
  const xStep = (W - pad.left - pad.right) / Math.max(vals.length - 1, 1);
  const yScale = v => pad.top + (1 - v / maxV) * (H - pad.top - pad.bottom);
  const pts = vals.map((v, i) => [pad.left + i * xStep, yScale(v)]);
  const areaPath = \`M\${pts[0][0]},\${H - pad.bottom} \` + pts.map(([x,y]) => \`L\${x.toFixed(1)},\${y.toFixed(1)}\`).join(' ') + \` L\${pts[pts.length-1][0]},\${H - pad.bottom} Z\`;
  const linePath = pts.map(([x,y],i) => \`\${i===0?'M':'L'}\${x.toFixed(1)},\${y.toFixed(1)}\`).join(' ');
  const li = [0, Math.floor(rev.length/2), rev.length-1];
  const labels = li.map(i => \`<text x="\${pts[i][0].toFixed(1)}" y="\${H}" fill="#333" font-size="8" text-anchor="middle">\${rev[i].date.slice(0,7).replace('-','/')}</text>\`).join('');
  const dots = pts.map(([x,y],i) => { const d = rev[i], amt = parseFloat(d.hbar); const tip = \`\${d.date}: \${amt>0?(amt<0.01?amt.toFixed(4):amt.toFixed(2)):'0'} ℏ · \${d.calls} calls\`; return \`<circle cx="\${x.toFixed(1)}" cy="\${y.toFixed(1)}" r="3" fill="#4ade80" opacity="0" onmouseenter="this.style.opacity=1;document.getElementById('chart-hover-label').textContent='\${tip}'" onmouseleave="this.style.opacity=0;document.getElementById('chart-hover-label').textContent=''" style="cursor:default;transition:opacity 0.15s"/>\`; }).join('');
  svgEl.innerHTML = \`<defs><linearGradient id="rg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#4ade80" stop-opacity="0.18"/><stop offset="100%" stop-color="#4ade80" stop-opacity="0"/></linearGradient></defs><path d="\${areaPath}" fill="url(#rg)"/><path d="\${linePath}" fill="none" stroke="#4ade80" stroke-width="1.5" stroke-linejoin="round"/>\` + labels + dots;
}

function renderNewAccountsChart(data) {
  const total = data.reduce((s, d) => s + d.n, 0);
  document.getElementById('acct-chart-total').textContent = total + ' total';
  const svgEl = document.getElementById('acct-chart');
  if (data.length === 0) { svgEl.innerHTML = '<text x="50%" y="50%" fill="#333" font-size="12" text-anchor="middle" dominant-baseline="middle">No signups yet</text>'; return; }
  const W = svgEl.parentElement.clientWidth - 32 || 300, H = 60, pad = { top: 4, bottom: 14, left: 2, right: 2 };
  svgEl.setAttribute('viewBox', \`0 0 \${W} \${H}\`);
  const vals = data.map(d => d.n), maxV = Math.max(...vals, 1);
  const xStep = (W - pad.left - pad.right) / vals.length, barW = Math.max(2, xStep - 2);
  const bars = vals.map((v, i) => { const bh = Math.max(2, (v/maxV)*(H-pad.top-pad.bottom)), x = pad.left+i*xStep, y = H-pad.bottom-bh; const tip = \`\${data[i].date}: \${v} new account\${v!==1?'s':''}\`; return \`<rect x="\${x.toFixed(1)}" y="\${y.toFixed(1)}" width="\${barW.toFixed(1)}" height="\${bh.toFixed(1)}" fill="#1e3a2a" rx="1" onmouseenter="this.setAttribute('fill','#4ade80');document.getElementById('acct-hover-label').textContent='\${tip}'" onmouseleave="this.setAttribute('fill','#1e3a2a');document.getElementById('acct-hover-label').textContent=''" style="cursor:default;transition:fill 0.15s"/>\`; }).join('');
  const li2 = [0, Math.floor(data.length/2), data.length-1];
  const labels = li2.map(i => \`<text x="\${(pad.left+i*xStep+barW/2).toFixed(1)}" y="\${H}" fill="#333" font-size="8" text-anchor="middle">\${data[i].date.slice(5).replace('-','/')}</text>\`).join('');
  svgEl.innerHTML = bars + labels;
}

function updateAnalyticsPanels(analytics) {
  document.getElementById('kpi-avg-calls').textContent = analytics.avg_calls_per_account + ' avg calls/acct';
  document.getElementById('kpi-month-hbar').textContent = analytics.monthly.this_month.hbar + ' ℏ';
  document.getElementById('kpi-ratelimit').textContent = analytics.rate_limit_hits_24h;
  const mDelta = pct(parseFloat(analytics.monthly.this_month.hbar), parseFloat(analytics.monthly.last_month.hbar));
  const mEl = document.getElementById('kpi-month-delta');
  mEl.textContent = mDelta + ' vs last month';
  mEl.className = 'card-sub ' + (mDelta.startsWith('+') ? 'up' : mDelta.startsWith('-') ? 'down' : '');
  document.getElementById('tool-trends').innerHTML = analytics.tool_trends.length === 0
    ? '<tr><td colspan="4" style="color:#333">No data yet</td></tr>'
    : analytics.tool_trends.map(t => { const d = t.calls_7d - t.calls_prev_7d; const cls = d>0?'up':d<0?'dn':'flat'; return \`<tr><td>\${t.tool_name}</td><td>\${t.calls_7d}</td><td style="color:#444">\${t.calls_prev_7d}</td><td><span class="trend \${cls}">\${d>0?'+':''}\${d}</span></td></tr>\`; }).join('');
  document.getElementById('top-spenders').innerHTML = analytics.top_spenders.length === 0
    ? '<tr><td colspan="3" style="color:#333">No data yet</td></tr>'
    : analytics.top_spenders.map(s => \`<tr><td class="mono" style="color:#888">\${s.api_key}</td><td>\${s.calls}</td><td style="color:#4ade80">\${s.hbar} ℏ</td></tr>\`).join('');
  if (analytics.xagent) {
    const xa = analytics.xagent;
    document.getElementById('xa-balance').textContent = xa.balance_hbar + ' ℏ';
    document.getElementById('xa-calls').textContent = xa.calls_24h;
    document.getElementById('xa-spent').textContent = xa.spent_24h_hbar + ' ℏ spent';
    document.getElementById('xa-last').textContent = timeAgo(xa.last_used);
  }
  if (analytics.daily_revenue && analytics.daily_revenue.length > 0) {
    const tot = analytics.daily_revenue.reduce((s,d) => s + parseFloat(d.hbar), 0);
    document.getElementById('h-avg-day').textContent = (tot / analytics.daily_revenue.length).toFixed(4) + ' ℏ';
  }
}

async function loadFleetBalances() {
  try {
    const fb = await fetchJSON('/admin/fleet-balances');

    // Fixatum wallet (mirror node)
    const fwEl = document.getElementById('fixatum-wallet-bal');
    const fwSub = document.getElementById('fixatum-wallet-sub');
    if (fb.fixatum_wallet_hbar !== null) {
      fwEl.textContent = fb.fixatum_wallet_hbar + ' \u210f';
      fwEl.style.color = fb.fixatum_wallet_hbar < 20 ? '#f87171' : fb.fixatum_wallet_hbar < 50 ? '#fbbf24' : '#fff';
      fwSub.textContent = fb.fixatum_wallet_hbar < 20 ? '\u26a0\ufe0f LOW \u2014 pipeline at risk' : 'mirror node';
      fwSub.style.color = fb.fixatum_wallet_hbar < 20 ? '#f87171' : '#444';
    } else { fwEl.textContent = '\u2014'; }

    // Fixatum working capital (Toolbox platform balance)
    const wcEl = document.getElementById('fixatum-wc-bal');
    const wcSub = document.getElementById('fixatum-wc-sub');
    if (fb.fixatum_working_capital !== null) {
      const wc = parseFloat(fb.fixatum_working_capital);
      wcEl.textContent = fb.fixatum_working_capital + ' \u210f';
      wcEl.style.color = wc < 20 ? '#f87171' : wc < 40 ? '#fbbf24' : '#fff';
      const regsLeft = Math.floor(wc / 3.1);
      wcSub.textContent = wc < 20 ? '\u26a0\ufe0f LOW \u2014 ~' + regsLeft + ' regs left' : 'Toolbox platform \u00b7 ~' + regsLeft + ' regs left';
      wcSub.style.color = wc < 20 ? '#f87171' : '#444';
    } else { wcEl.textContent = '\u2014'; }

    // TRK wallet (mirror node)
    const trkEl = document.getElementById('trk-wallet-bal');
    const trkSub = document.getElementById('trk-wallet-sub');
    if (fb.trk_wallet_hbar !== null) {
      trkEl.textContent = fb.trk_wallet_hbar + ' \u210f';
      trkEl.style.color = fb.trk_wallet_hbar < 10 ? '#f87171' : fb.trk_wallet_hbar < 30 ? '#fbbf24' : '#fff';
      trkSub.textContent = fb.trk_wallet_hbar < 10 ? '\u26a0\ufe0f LOW' : 'mirror node';
      trkSub.style.color = fb.trk_wallet_hbar < 10 ? '#f87171' : '#444';
    } else { trkEl.textContent = '\u2014'; }
  } catch(e) { console.error('Fleet balance error:', e); }
}

function renderFleetAgent(id, name, lastSeen, note) {
  const el = document.getElementById(id);
  if (!el) return;
  const age = lastSeen ? (Date.now() - new Date(lastSeen).getTime()) / 1000 : null;
  const dotCls = age === null ? 'grey' : age < 7200 ? 'green' : age < 86400 ? 'amber' : 'grey';
  const label = age === null ? 'No data' : timeAgo(lastSeen) + (note ? ' \u00b7 ' + note : '');
  el.innerHTML = '<div class="fa-name">' + name + '</div><div class="fa-status"><span class="fa-dot ' + dotCls + '"></span><span class="fa-label">' + label + '</span></div>';
}

async function loadFleetStatus() {
  try {
    const r = await fetchJSON('/admin/analytics');
    // Use last transaction as proxy for VisionForge / general activity signal
    const txs = await fetchJSON('/admin/transactions');
    const lastTx = txs.transactions[0]?.timestamp || null;
    // Agents are populated from agent-report data if Fixatum exposes it;
    // for now we show known agents with static identity and last-tx signal
    renderFleetAgent('fa-visionforge', 'VisionForge',  null,  '13:00 UTC daily');
    renderFleetAgent('fa-trk',         'RecordKeeper', null,  '30m heartbeat');
    renderFleetAgent('fa-scout',       'ScoutAgent',   null,  'hourly');
    renderFleetAgent('fa-narrator',    'Narrator',     null,  '4d cycle');
    renderFleetAgent('fa-midas',       'Midas',        null,  'operator');
  } catch(e) { console.error('Fleet status error:', e); }
}

async function loadAll() {
  try {
    const [stats, accounts, txs, analytics] = await Promise.all([
      fetchJSON('/admin/stats'),
      fetchJSON('/admin/accounts'),
      fetchJSON('/admin/transactions'),
      fetchJSON('/admin/analytics?period=' + activePeriod),
    ]);

    document.getElementById('kpi-calls').textContent = stats.summary.total_calls.toLocaleString();
    document.getElementById('kpi-accounts').textContent = stats.summary.total_accounts.toLocaleString();
    document.getElementById('kpi-deposited').textContent = stats.summary.total_deposited_hbar + ' ℏ';
    document.getElementById('watcher-dot').className = 'dot';
    document.getElementById('network-badge').textContent = stats.watcher.network;

    // Health strip
    document.getElementById('h-watcher-status').textContent = stats.watcher.status === 'running' ? 'Running' : 'Down';
    document.getElementById('h-watcher-dot').className = 'dot' + (stats.watcher.status === 'running' ? '' : ' amber');
    document.getElementById('h-last-call').textContent = txs.transactions[0] ? timeAgo(txs.transactions[0].timestamp) : '—';
    document.getElementById('h-active-accounts').textContent = accounts.accounts.filter(a => parseFloat(a.balance_hbar) > 0).length;

    renderRevenueChart(analytics.daily_revenue);
    renderNewAccountsChart(analytics.new_accounts_30d);
    updateAnalyticsPanels(analytics);

    // Tool ranking
    const maxCalls = stats.tool_ranking[0]?.calls || 1;
    document.getElementById('tool-ranking').innerHTML = stats.tool_ranking.length === 0
      ? '<tr><td colspan="5" style="color:#333">No calls yet</td></tr>'
      : stats.tool_ranking.map((t, i) => \`<tr><td style="color:#444">#\${i+1}</td><td>\${t.tool}</td><td>\${t.calls}</td><td style="color:#4ade80">\${t.revenue_hbar} ℏ</td><td><div class="bar-wrap"><div class="bar" style="width:\${Math.round((t.calls/maxCalls)*100)}%"></div></div></td></tr>\`).join('');

    // Accounts
    document.getElementById('accounts-table').innerHTML = accounts.accounts.length === 0
      ? '<tr><td colspan="4" style="color:#333">No accounts yet</td></tr>'
      : accounts.accounts.map(a => \`<tr><td class="mono">\${a.api_key}</td><td style="color:\${parseFloat(a.balance_hbar)>0?'#4ade80':'#f87171'}">\${a.balance_hbar} ℏ</td><td style="color:#444">\${timeAgo(a.last_used)}</td><td><button class="btn danger" style="padding:2px 7px;font-size:10px" onclick="setDeleteKey('\${a.api_key}')">Del</button></td></tr>\`).join('');

    // Recent transactions
    document.getElementById('recent-txs').innerHTML = txs.transactions.length === 0
      ? '<tr><td colspan="4" style="color:#333">No transactions yet</td></tr>'
      : txs.transactions.slice(0, 15).map(t => \`<tr><td style="color:#444">\${timeAgo(t.timestamp)}</td><td class="mono" style="color:#666">\${t.api_key}</td><td>\${t.tool_name}</td><td style="color:#4ade80">\${(t.amount_tinybars/100000000).toFixed(4)}</td></tr>\`).join('');

    document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
    loadFleetBalances();
    loadFleetStatus();
  } catch(e) { console.error('Dashboard error:', e); }
}

async function doProvision() {
  const key = document.getElementById('ctrl-key').value.trim();
  const hbar = parseFloat(document.getElementById('ctrl-hbar').value);
  const el = document.getElementById('ctrl-result');
  if (!key || !hbar) { el.style.color='#f87171'; el.textContent = 'Enter key and amount.'; return; }
  el.style.color='#888'; el.textContent = 'Provisioning...';
  try {
    const r = await fetchJSON('/admin/provision', { method: 'POST', body: JSON.stringify({ api_key: key, hbar }) });
    el.style.color='#4ade80';
    el.textContent = r.success ? \`Done — \${r.balance_hbar} ℏ balance\` : (r.error || 'Error');
    if (r.success) loadAll();
  } catch(e) { el.style.color='#f87171'; el.textContent = e.message; }
}

function setDeleteKey(key) { document.getElementById('del-key').value = key; openDeleteModal(); }
function openDeleteModal() {
  const key = document.getElementById('del-key').value.trim();
  if (!key) return;
  document.getElementById('del-modal-key').textContent = key;
  document.getElementById('del-confirm-input').value = '';
  document.getElementById('del-result').textContent = '';
  document.getElementById('delete-modal').classList.add('open');
}
function closeDeleteModal() { document.getElementById('delete-modal').classList.remove('open'); }
async function doDelete() {
  const key = document.getElementById('del-key').value.trim();
  const confirm = document.getElementById('del-confirm-input').value.trim();
  const el = document.getElementById('del-result');
  if (confirm !== key) { el.textContent = 'Account ID does not match.'; return; }
  el.style.color='#888'; el.textContent = 'Deleting...';
  try {
    const r = await fetchJSON('/admin/delete-account', { method: 'DELETE', body: JSON.stringify({ api_key: key }) });
    if (r.success) { closeDeleteModal(); document.getElementById('del-key').value = ''; loadAll(); }
    else { el.style.color='#f87171'; el.textContent = r.error || 'Failed'; }
  } catch(e) { el.style.color='#f87171'; el.textContent = e.message; }
}

// Init
document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === activePeriod));
document.getElementById('chart-period-label').textContent = PERIOD_LABELS[activePeriod];
restorePanelOrder();
initDragDrop();
loadAll();
setInterval(loadAll, 30000);
</script>
</body>
</html>`;
}

httpServer.listen(port, () => {
  console.error("HederaToolbox remote brain running on port " + port);
  console.error("Health: http://localhost:" + port + "/");
  console.error("MCP:    http://localhost:" + port + "/mcp");
  if (process.env.ADMIN_SECRET) {
    console.error("Admin:  http://localhost:" + port + "/admin/* (secret set)");
  }
});

startWatcher();
registerWebhook();

purgeOldConsentPII();

import { notifyOwner } from "./telegram.js";
import { scheduleXAgent } from "./xagent.js";

function scheduleDailyDigest() {
  const now = new Date();
  const next8am = new Date();
  next8am.setUTCHours(8, 0, 0, 0);
  if (next8am <= now) next8am.setUTCDate(next8am.getUTCDate() + 1);
  const msUntil = next8am - now;
  console.error(`[Digest] First digest in ${Math.round(msUntil / 3600000)}h (08:00 UTC daily)`);

  async function sendDigest() {
    try {
      const allTxs = getRecentTransactions(1000);
      const since  = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19);
      const recent = allTxs.filter(t => t.timestamp >= since);
      const earned = recent.reduce((s, t) => s + t.amount_tinybars, 0) / 100_000_000;
      const activeAccounts = new Set(recent.map(t => t.api_key)).size;
      const toolCounts = {};
      for (const t of recent) toolCounts[t.tool_name] = (toolCounts[t.tool_name] || 0) + 1;
      const topTools = Object.entries(toolCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => `  ${name}: ${count}`)
        .join("\n") || "  none";
      const allAccounts = getAllAccounts();
      const totalHeld = allAccounts.reduce((s, a) => s + a.balance_tinybars, 0) / 100_000_000;

      await notifyOwner(
        `🌅 <b>Morning digest</b>\n\n` +
        `<b>Last 24h</b>\n` +
        `Tool calls: <b>${recent.length}</b>\n` +
        `HBAR earned: <b>${earned.toFixed(4)} ℏ</b>\n` +
        `Active accounts: <b>${activeAccounts}</b>\n\n` +
        `<b>Top tools:</b>\n${topTools}\n\n` +
        `<b>Platform total</b>\n` +
        `Accounts: <b>${allAccounts.length}</b>\n` +
        `HBAR held: <b>${totalHeld.toFixed(4)} ℏ</b>`
      );
      purgeOldConsentPII();
      console.error("[Digest] Daily digest sent");
    } catch (e) {
      console.error(`[Digest] Failed: ${e.message}`);
    }
  }

  setTimeout(() => {
    sendDigest();
    setInterval(sendDigest, 24 * 60 * 60 * 1000);
  }, msUntil);
}

if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_OWNER_ID) {
  scheduleDailyDigest();
  scheduleXAgent();
  scheduleVisionForge();
} else {
  console.error("[Digest] Telegram not configured — daily digest disabled");
}
console.error("Hedera network: " + process.env.HEDERA_NETWORK);
console.error("Tools: " + ALL_TOOLS.map((t) => t.name).join(", "));

if (process.env.GITHUB_BACKUP_TOKEN && process.env.GITHUB_BACKUP_REPO) {
  import("https").then(({ default: https }) => {
    async function runBackup() {
      const dbPath = process.env.DB_PATH || "/data/hederatoolbox.db";
      const today = new Date().toISOString().slice(0, 10);
      const filename = `backups/hederatoolbox-${today}.db`;
      const repo = process.env.GITHUB_BACKUP_REPO;
      const token = process.env.GITHUB_BACKUP_TOKEN;
      console.error(`[Backup] Starting nightly backup to ${repo}/${filename}`);
      try {
        const dbFile = readFileSync(dbPath);
        console.error(`[Backup] Read ${(dbFile.length / 1024).toFixed(1)} KB`);
        const sha = await new Promise(resolve => {
          const req = https.request({
            hostname: "api.github.com",
            path: `/repos/${repo}/contents/${filename}`,
            headers: { "Authorization": `Bearer ${token}`, "User-Agent": "hederaintel-backup", "Accept": "application/vnd.github+json" },
          }, res => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => res.statusCode === 200 ? resolve(JSON.parse(data).sha) : resolve(null));
          });
          req.on("error", () => resolve(null));
          req.end();
        });
        const body = JSON.stringify({
          message: `chore: nightly backup ${today}`,
          content: dbFile.toString("base64"),
          ...(sha ? { sha } : {}),
        });
        await new Promise((resolve, reject) => {
          const req = https.request({
            hostname: "api.github.com",
            path: `/repos/${repo}/contents/${filename}`,
            method: "PUT",
            headers: { "Authorization": `Bearer ${token}`, "User-Agent": "hederaintel-backup", "Accept": "application/vnd.github+json", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
          }, res => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => {
              if (res.statusCode === 200 || res.statusCode === 201) { console.error(`[Backup] ✅ Committed to GitHub`); resolve(); }
              else { console.error(`[Backup] ❌ GitHub returned ${res.statusCode}: ${data}`); reject(new Error(`GitHub ${res.statusCode}`)); }
            });
          });
          req.on("error", reject);
          req.write(body);
          req.end();
        });
      } catch (e) {
        console.error(`[Backup] ❌ Failed: ${e.message}`);
      }
    }

    function scheduleBackup() {
      const now = new Date(), next2am = new Date();
      next2am.setUTCHours(2, 0, 0, 0);
      if (next2am <= now) next2am.setUTCDate(next2am.getUTCDate() + 1);
      const msUntil2am = next2am - now;
      console.error(`[Backup] Next backup scheduled in ${Math.round(msUntil2am / 3600000)}h`);
      setTimeout(() => { runBackup(); setInterval(runBackup, 24 * 60 * 60 * 1000); }, msUntil2am);
    }

    scheduleBackup();
  });
} else {
  console.error("[Backup] GITHUB_BACKUP_TOKEN or GITHUB_BACKUP_REPO not set — nightly backup disabled");
}
