/**
 * agent-reputation-monitor.mjs
 * HederaToolbox + Fixatum — Agent Reputation Monitor
 *
 * Watches a list of Fixatum-registered AI agents on a schedule.
 * Detects grade changes and significant score drops, writes a tamper-proof
 * record to your HCS topic when a change is observed.
 *
 * Use cases: platforms accepting agents as counterparties, DAOs monitoring
 * delegate agents, operators tracking a fleet of deployed agents.
 *
 * Setup:
 *   1. Send any HBAR to the platform wallet: 0.0.10309126
 *      Your Hedera account ID becomes your API key within ~10 seconds.
 *   2. Create watched-agents.json in the same directory (see format below).
 *   3. Set your HCS topic ID — records write to your own topic.
 *      If you have a Fixatum DID, your agent_topic_id works perfectly here.
 *      Get one at: https://fixatum.com/register
 *   4. node agent-reputation-monitor.mjs
 *
 * watched-agents.json format:
 *   [
 *     { "did": "did:hedera:mainnet:z..._0.0.123456", "label": "MyAgent" },
 *     { "did": "did:hedera:mainnet:z..._0.0.789012", "label": "PartnerAgent" }
 *   ]
 *   "label" is optional but makes output readable.
 *   You can also pass a single DID via env var: WATCH_DID=did:hedera:mainnet:z...
 *
 * Alerting logic:
 *   - First run: establishes baselines only. No alerts, no HCS writes.
 *   - Subsequent runs: alerts on grade change OR score drop >= DROP_THRESHOLD.
 *   - Every alert writes one tamper-proof record to your HCS topic (0.1 HBAR).
 *   - Score drift within the same grade is logged but does not trigger an alert.
 *
 * Cost:
 *   fixatum_score is free — polling costs nothing.
 *   0.1 HBAR per HCS write, only when an alert fires.
 *   5 HBAR covers ~50 alerts. Load 5 HBAR to get started.
 *
 * IMPORTANT: Fixatum scores are on-chain behavioural data only.
 * A score change is an observation, not a guarantee of trustworthiness.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────
const API_KEY          = process.env.HEDERA_ACCOUNT_ID  || "YOUR_HEDERA_ACCOUNT_ID";
const TOPIC_ID         = process.env.HCS_TOPIC_ID       || "YOUR_HCS_TOPIC_ID";
const CHECK_INTERVAL_H = parseFloat(process.env.CHECK_INTERVAL_H || "6");
const DROP_THRESHOLD   = parseInt(process.env.DROP_THRESHOLD     || "10");
const WATCH_LIST_FILE  = resolve(__dirname, process.env.WATCH_FILE || "watched-agents.json");
const STATE_FILE       = resolve(__dirname, "agents-state.json");
const ENDPOINT         = "https://api.hederatoolbox.com/mcp";
const HASHSCAN_TX      = "https://hashscan.io/mainnet/transaction";
// ─────────────────────────────────────────────────────────────────────────────

// ─── Grade order for change detection ────────────────────────────────────────
const GRADE_ORDER = { F: 0, D: 1, C: 2, B: 3, A: 4 };

function gradeDirection(prev, curr) {
  const p = GRADE_ORDER[prev] ?? -1;
  const c = GRADE_ORDER[curr] ?? -1;
  if (c > p) return "up";
  if (c < p) return "down";
  return "same";
}

// ─── Startup validation ───────────────────────────────────────────────────────
if (API_KEY === "YOUR_HEDERA_ACCOUNT_ID") {
  console.error("\n  Error: Set HEDERA_ACCOUNT_ID to your Hedera account ID.");
  console.error("  Send any HBAR to 0.0.10309126 first.\n");
  process.exit(1);
}

if (TOPIC_ID === "YOUR_HCS_TOPIC_ID") {
  console.error("\n  Error: Set HCS_TOPIC_ID to your own HCS topic.");
  console.error("  If you have a Fixatum DID, use your agent_topic_id.");
  console.error("  Get one at: https://fixatum.com/register\n");
  process.exit(1);
}

// ─── Load watch list ──────────────────────────────────────────────────────────
function loadWatchList() {
  // Single DID via env var takes priority
  if (process.env.WATCH_DID) {
    return [{ did: process.env.WATCH_DID, label: process.env.WATCH_LABEL || null }];
  }

  if (!existsSync(WATCH_LIST_FILE)) {
    console.error(`\n  Error: ${WATCH_LIST_FILE} not found.`);
    console.error("  Create it with a list of DIDs to watch. See header comment for format.\n");
    process.exit(1);
  }

  try {
    const raw = JSON.parse(readFileSync(WATCH_LIST_FILE, "utf8"));
    if (!Array.isArray(raw) || raw.length === 0) throw new Error("empty or invalid array");
    return raw;
  } catch (err) {
    console.error(`\n  Error reading ${WATCH_LIST_FILE}: ${err.message}\n`);
    process.exit(1);
  }
}

// ─── State management ─────────────────────────────────────────────────────────
function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── MCP caller ───────────────────────────────────────────────────────────────
async function callTool(toolName, args) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: { ...args, api_key: API_KEY } },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${toolName}`);
  const json = await res.json();
  if (json.error) throw new Error(`${toolName}: ${json.error.message}`);
  const text = json.result?.content?.find(c => c.type === "text")?.text;
  if (!text) throw new Error(`No text response from ${toolName}`);
  return JSON.parse(text);
}

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sep(len = 62) { console.log("=".repeat(len)); }

// ─── Preflight ────────────────────────────────────────────────────────────────
async function preflight() {
  await callTool("get_terms", {});
  await callTool("confirm_terms", { consent: true });
  const info = await callTool("account_info", {});
  log(`Account: ${API_KEY} | Balance: ${info.balance_hbar} HBAR`);
  if (parseFloat(info.balance_hbar) < 0.5) {
    console.error(`\n  Error: Low balance (${info.balance_hbar} HBAR).`);
    console.error(`  Top up: send HBAR to ${info.platform_wallet}\n`);
    process.exit(1);
  }
}

// ─── Single agent check ───────────────────────────────────────────────────────
async function checkAgent(entry, state, isBaseline) {
  const { did, label } = entry;
  const display = label ? `${label} (${did.slice(-20)}...)` : did;

  let scoreData;
  try {
    scoreData = await callTool("fixatum_score", { did });
  } catch (err) {
    log(`  ${display} — score fetch failed: ${err.message}`);
    return;
  }

  const score = scoreData.score ?? null;
  const grade = scoreData.grade ?? null;
  const now   = new Date().toISOString();

  if (isBaseline) {
    state[did] = { label: label || null, score, grade, last_checked: now, last_alert_at: null };
    log(`  ${display} — ${score}/100 Grade ${grade} (baseline set)`);
    return;
  }

  const prev = state[did];
  if (!prev) {
    // New entry added to watch list after first run
    state[did] = { label: label || null, score, grade, last_checked: now, last_alert_at: null };
    log(`  ${display} — ${score}/100 Grade ${grade} (new entry, baseline set)`);
    return;
  }

  const prevScore = prev.score;
  const prevGrade = prev.grade;
  const scoreDelta = score - prevScore;
  const direction  = gradeDirection(prevGrade, grade);
  const gradeChanged = direction !== "same";
  const bigDrop = scoreDelta <= -DROP_THRESHOLD;

  // Update state regardless
  state[did] = { ...prev, label: label || prev.label, score, grade, last_checked: now };

  if (!gradeChanged && !bigDrop) {
    const delta = scoreDelta >= 0 ? `+${scoreDelta}` : `${scoreDelta}`;
    log(`  ${display} — ${score}/100 Grade ${grade} (${delta} pts, no change)`);
    return;
  }

  // Alert path
  const changeType = gradeChanged
    ? `Grade ${prevGrade} -> ${grade} (${scoreDelta >= 0 ? "+" : ""}${scoreDelta} pts)`
    : `Score drop ${prevScore} -> ${score} (${scoreDelta} pts)`;

  const alertIcon = direction === "down" || bigDrop ? "DECLINE" : "IMPROVEMENT";

  console.log();
  sep();
  console.log(`  ${alertIcon} DETECTED`);
  sep();
  console.log(`  Agent:     ${label || "unlabelled"}`);
  console.log(`  DID:       ${did}`);
  console.log(`  Change:    ${changeType}`);
  console.log(`  Previous:  ${prevScore}/100 Grade ${prevGrade}`);
  console.log(`  Now:       ${score}/100 Grade ${grade}`);

  // Write HCS record
  console.log(`  Writing HCS record (0.1 HBAR)...`);
  try {
    const record = await callTool("hcs_write_record", {
      topic_id: TOPIC_ID,
      record_type: "agent_reputation_change",
      entity_id: did,
      data: {
        did,
        label: label || null,
        monitored_by: API_KEY,
        previous_score: prevScore,
        previous_grade: prevGrade,
        current_score: score,
        current_grade: grade,
        score_delta: scoreDelta,
        grade_changed: gradeChanged,
        direction: direction === "same" ? "decline" : direction,
        alert_type: alertIcon,
        agent: "agent-reputation-monitor",
      },
    });

    state[did].last_alert_at = now;

    console.log(`  Record ID: ${record.record_id}`);
    console.log(`  HashScan:  ${HASHSCAN_TX}/${record.transaction_id}`);
  } catch (err) {
    console.error(`  HCS write failed: ${err.message}`);
  }

  sep();
  console.log();
}

// ─── Main cycle ───────────────────────────────────────────────────────────────
async function runCycle(watchList, cycleNum) {
  const isBaseline = cycleNum === 1;
  const state = loadState();

  if (isBaseline) {
    log(`Establishing baselines for ${watchList.length} agent(s)...`);
  } else {
    log(`Checking ${watchList.length} agent(s)... (cycle #${cycleNum})`);
  }

  for (const entry of watchList) {
    await checkAgent(entry, state, isBaseline);
    // Brief pause between calls — avoids hammering the endpoint
    await new Promise(r => setTimeout(r, 500));
  }

  saveState(state);

  if (isBaseline) {
    log(`Baselines saved to ${STATE_FILE}`);
  }

  log(`Done. Next check in ${CHECK_INTERVAL_H}h.\n`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────
async function main() {
  const watchList = loadWatchList();
  const intervalMs = CHECK_INTERVAL_H * 60 * 60 * 1000;

  console.log("\n" + "=".repeat(62));
  console.log("  HederaToolbox + Fixatum — Agent Reputation Monitor");
  console.log(`  Watching:  ${watchList.length} agent(s)`);
  console.log(`  HCS topic: ${TOPIC_ID}`);
  console.log(`  Interval:  every ${CHECK_INTERVAL_H}h`);
  console.log(`  Alert on:  grade change OR score drop >= ${DROP_THRESHOLD} pts`);
  console.log(`  Cost:      free to poll · 0.1 HBAR per alert`);
  console.log("=".repeat(62) + "\n");

  await preflight();
  log("Starting monitor...\n");

  let cycleNum = 1;

  // Check if state exists — if so, skip straight to cycle 2+ behaviour
  if (existsSync(STATE_FILE)) {
    const existing = loadState();
    const hasBaselines = watchList.every(e => existing[e.did]);
    if (hasBaselines) {
      log("Existing state found — skipping baseline, starting from cycle 2.\n");
      cycleNum = 2;
    }
  }

  while (true) {
    try {
      await runCycle(watchList, cycleNum++);
    } catch (err) {
      log(`Cycle error: ${err.message} — retrying next interval`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
