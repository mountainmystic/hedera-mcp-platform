/**
 * compliance-kya-onboarding-agent.mjs
 * HederaToolbox + Fixatum — Compliance + KYA Onboarding Agent
 *
 * Screens any Hedera account before doing business with them.
 * Runs identity resolution, on-chain risk screening, and optional KYC verification,
 * then pulls a live Fixatum KYA trust score (0-100) — free, no extra call needed.
 * Writes a tamper-proof compliance + reputation record to your HCS topic
 * and optionally verifies it was not tampered with.
 *
 * Use cases: token issuers, DEXes, DAOs, treasury managers, RWA projects,
 * any party that needs auditable counterparty screening before transacting.
 *
 * IMPORTANT: identity_check_sanctions is on-chain behavioural analysis of
 * Hedera transaction patterns only. It is NOT a legal sanctions check against
 * OFAC, UN, EU, or any government watchlist. Do not treat results as legal compliance.
 *
 * Setup (one-time):
 *   1. Send any HBAR to the platform wallet: 0.0.10309126
 *      Your Hedera account ID becomes your API key within ~10 seconds.
 *   2. Replace YOUR_HEDERA_ACCOUNT_ID below, or set env var.
 *   3. Set YOUR_HCS_TOPIC_ID to your own HCS topic (required for writing records).
 *      If you have a Fixatum DID, your agent_topic_id works perfectly here.
 *   4. node compliance-kya-onboarding-agent.mjs
 *      Or: SUBJECT=0.0.123456 node compliance-kya-onboarding-agent.mjs
 *
 * Cost per run:
 *   identity_resolve:         0.2 HBAR
 *   identity_check_sanctions: 1.0 HBAR
 *   fixatum_score:            free
 *   hcs_write_record:         0.1 HBAR
 *   hcs_verify_record:        1.0 HBAR  (optional, set SKIP_VERIFY=true to skip)
 *   identity_verify_kyc:      0.5 HBAR  (optional, set KYC_TOKEN_ID to enable)
 *   ──────────────────────────────────
 *   Base total:               ~1.3 HBAR
 *   With verify:              ~2.3 HBAR
 *   With verify + KYC:        ~2.8 HBAR
 *
 * Load 5 HBAR to get started comfortably.
 */

// ─── Config ──────────────────────────────────────────────────────────────────
const API_KEY      = process.env.HEDERA_ACCOUNT_ID || "YOUR_HEDERA_ACCOUNT_ID";
const SUBJECT_ID   = process.env.SUBJECT           || "0.0.7925398";
const TOPIC_ID     = process.env.HCS_TOPIC_ID      || "YOUR_HCS_TOPIC_ID";
const KYC_TOKEN_ID = process.env.KYC_TOKEN_ID      || null;
const VERIFY       = process.env.SKIP_VERIFY       !== "true";
const ENDPOINT     = "https://api.hederatoolbox.com/mcp";
const HASHSCAN_TX  = "https://hashscan.io/mainnet/transaction";
// ─────────────────────────────────────────────────────────────────────────────

if (API_KEY === "YOUR_HEDERA_ACCOUNT_ID") {
  console.error("\n Error: Replace API_KEY with your Hedera account ID.");
  console.error("  Send any HBAR to 0.0.10309126 first.\n");
  process.exit(1);
}

if (TOPIC_ID === "YOUR_HCS_TOPIC_ID") {
  console.error("\n Error: Set HCS_TOPIC_ID to your own HCS topic.");
  console.error("  If you have a Fixatum DID, use your agent_topic_id.");
  console.error("  Get one at: https://fixatum.com/register\n");
  process.exit(1);
}

// ─── MCP caller ──────────────────────────────────────────────────────────────
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
function sep(len = 62) { console.log("-".repeat(len)); }

// ─── Preflight ───────────────────────────────────────────────────────────────
async function preflight() {
  await callTool("get_terms", {});
  await callTool("confirm_terms", { consent: true });
  const info = await callTool("account_info", {});
  log(`Account: ${API_KEY} | Balance: ${info.balance_hbar} HBAR`);

  const needed = 1.3 + (VERIFY ? 1.0 : 0) + (KYC_TOKEN_ID ? 0.5 : 0);
  if (parseFloat(info.balance_hbar) < needed) {
    console.error(`\n Error: Insufficient balance (have ${info.balance_hbar} HBAR, need ~${needed.toFixed(1)} HBAR)`);
    console.error(`  Top up: send HBAR to ${info.platform_wallet}\n`);
    process.exit(1);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const totalCost = (1.3 + (VERIFY ? 1.0 : 0) + (KYC_TOKEN_ID ? 0.5 : 0)).toFixed(1);

  console.log("\n" + "=".repeat(62));
  console.log("  HederaToolbox + Fixatum — Compliance + KYA Onboarding Agent");
  console.log(`  Subject:      ${SUBJECT_ID}`);
  console.log(`  HCS topic:    ${TOPIC_ID}`);
  if (KYC_TOKEN_ID) console.log(`  KYC token:    ${KYC_TOKEN_ID}`);
  console.log(`  Verify:       ${VERIFY ? "yes" : "skipped"}`);
  console.log(`  Est. cost:    ~${totalCost} HBAR`);
  console.log("=".repeat(62) + "\n");

  await preflight();
  log("Workflow starting...\n");

  // Step 1 — Identity
  log("Step 1 — Identity resolution (0.2 HBAR)...");
  const identity = await callTool("identity_resolve", { account_id: SUBJECT_ID });

  // Step 2 — On-chain risk screening
  log("Step 2 — On-chain risk screening (1.0 HBAR)...");
  const sanctions = await callTool("identity_check_sanctions", { account_id: SUBJECT_ID });

  // Step 3 — Fixatum KYA score (free)
  log("Step 3 — Fixatum KYA reputation score (free)...");
  let kya = { score: null, grade: "NOT_REGISTERED" };
  try {
    kya = await callTool("fixatum_score", { account_id: SUBJECT_ID });
  } catch (_) {
    // Account not registered with Fixatum — score is null, not an error
  }

  // Step 4 — Optional KYC
  let kyc = null;
  if (KYC_TOKEN_ID) {
    log("Step 4 — KYC verification (0.5 HBAR)...");
    kyc = await callTool("identity_verify_kyc", {
      account_id: SUBJECT_ID,
      token_id: KYC_TOKEN_ID,
    });
  }

  // Determine result
  const result =
    sanctions.screening_result === "FLAGGED"              ? "REJECTED"
    : sanctions.screening_result === "REVIEW"             ? "PENDING_REVIEW"
    : kyc && !kyc.kyc_details?.[0]?.kyc_granted           ? "PENDING_KYC"
    : "APPROVED";

  // Step 5 — Write HCS record
  const writeStep = KYC_TOKEN_ID ? 5 : 4;
  log(`Step ${writeStep} — Writing compliance record to HCS topic ${TOPIC_ID} (0.1 HBAR)...`);
  const record = await callTool("hcs_write_record", {
    topic_id: TOPIC_ID,
    record_type: "compliance_kya_onboarding",
    entity_id: SUBJECT_ID,
    data: {
      subject_account:  SUBJECT_ID,
      screened_by:      API_KEY,
      result:           result,
      identity_summary: identity.identity_summary,
      account_age_days: identity.account_age_days,
      sanctions_result: sanctions.screening_result,
      risk_level:       sanctions.risk_level,
      risk_score:       sanctions.risk_score,
      risk_signals:     sanctions.risk_signals,
      kya_score:        kya.score,
      kya_grade:        kya.grade,
      kyc_checked:      !!KYC_TOKEN_ID,
      kyc_status:       kyc?.kyc_details?.[0]?.kyc_status ?? null,
      agent:            "compliance-kya-onboarding-agent",
    },
  });

  // Step 6 — Optional verify
  let verified = null;
  if (VERIFY) {
    const verifyStep = writeStep + 1;
    log(`Step ${verifyStep} — Verifying record on-chain (1.0 HBAR)...`);
    await new Promise(r => setTimeout(r, 3000)); // wait for consensus
    verified = await callTool("hcs_verify_record", { record_id: record.record_id });
  }

  // ── Final report ──────────────────────────────────────────────────────────
  const icon = result === "APPROVED" ? "[APPROVED]" : result === "REJECTED" ? "[REJECTED]" : "[REVIEW]";
  const remaining = verified?.payment?.remaining_hbar ?? record.payment?.remaining_hbar;
  const kyaDisplay = kya.score !== null ? `${kya.score}/100 (${kya.grade})` : `Not registered`;

  console.log("\n" + "=".repeat(62));
  console.log(`  ${icon}`);
  console.log("=".repeat(62));
  sep();
  console.log("  SCREENING SUMMARY");
  sep();
  console.log(`  Subject:       ${SUBJECT_ID}`);
  console.log(`  Identity:      ${identity.identity_summary}`);
  console.log(`  Account age:   ${identity.account_age_days} days`);
  console.log(`  Risk screen:   ${sanctions.screening_result} (${sanctions.risk_level}, score ${sanctions.risk_score}/100)`);
  console.log(`  Fixatum KYA:   ${kyaDisplay}`);
  if (KYC_TOKEN_ID) console.log(`  KYC:           ${kyc?.kyc_details?.[0]?.kyc_status ?? "N/A"}`);
  sep();
  console.log("  ON-CHAIN RECORD");
  sep();
  console.log(`  Record ID:     ${record.record_id}`);
  console.log(`  HCS topic:     ${TOPIC_ID}`);
  console.log(`  HashScan:      ${HASHSCAN_TX}/${record.transaction_id}`);
  if (verified) console.log(`  Verified:      ${verified.verified ? "Intact" : "TAMPER DETECTED"}`);
  if (remaining) console.log(`  Balance after: ${remaining} HBAR`);
  sep();

  if (result === "APPROVED") {
    console.log("\n  Account cleared for onboarding.\n");
  } else if (result === "REJECTED") {
    console.log("\n  Flagged. Do not proceed.\n");
  } else if (result === "PENDING_REVIEW") {
    console.log("\n  Manual review required before onboarding.\n");
  } else {
    console.log("\n  KYC required before allowing token interactions.\n");
  }
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
