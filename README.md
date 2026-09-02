# HederaToolbox

> The intelligence layer for AI agents on Hedera.

**23 tools. 7 modules. Pay per call in HBAR. No registration.**

[![npm](https://img.shields.io/npm/v/@hederatoolbox/platform?label=npm)](https://www.npmjs.com/package/@hederatoolbox/platform)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-listed-blue)](https://registry.modelcontextprotocol.io)
[![Glama](https://img.shields.io/badge/Glama-listed-green)](https://glama.ai/mcp/servers/mountainmystic/hederatoolbox)
[![ClawHub](https://img.shields.io/badge/ClawHub-hederatoolbox-orange)](https://clawhub.ai/mountainmystic/hederatoolbox)
[![Network](https://img.shields.io/badge/Hedera-Mainnet-8A2BE2)](https://hedera.com)
[![License](https://img.shields.io/badge/License-Proprietary-red.svg)](LICENSE.md)

HederaToolbox is a production [Model Context Protocol](https://modelcontextprotocol.io) server. It gives AI agents structured, metered access to the full Hedera ecosystem — HCS topics, tokens, identity, smart contracts, governance, compliance, and Fixatum DID registration.

Built for agents that need to *reason* about Hedera, not just interact with it.

---

## Demo

**Claude Desktop** — one business objective, no steps specified, agent decides everything:

[![Claude Desktop Demo](https://img.youtube.com/vi/RuZE-Qw7IgU/0.jpg)](https://youtu.be/RuZE-Qw7IgU)

**Terminal agent** — autonomous compliance workflow running headless:

[![Terminal Agent Demo](https://img.youtube.com/vi/XhOCLrILg1o/0.jpg)](https://youtu.be/XhOCLrILg1o)

---

## Autonomous Agent Examples

Five production-ready agents in [`examples/`](examples/). Clone the repo, fund once, run. Zero dependencies beyond Node.js 18+.

**One-time setup for all agents:**

```bash
git clone https://github.com/mountainmystic/hederatoolbox.git
cd hederatoolbox

# Send any HBAR to the platform wallet from your Hedera account.
# Your account ID becomes your API key automatically within 10 seconds.
# Platform wallet: 0.0.10309126
```

> **Windows users:** set env vars before running:
> `set HEDERA_ACCOUNT_ID=0.0.YOUR_ID && set TOKEN_ID=0.0.731861 && node examples/whale-alert-agent.mjs`
> Or edit the config constants directly at the top of each file.

---

### 👁️ Agent Reputation Monitor
**[`examples/agent-reputation-monitor.mjs`](examples/agent-reputation-monitor.mjs)**

Watches a list of [Fixatum](https://fixatum.com)-registered AI agents on a schedule. Detects grade changes and significant score drops — then writes a tamper-proof record to your HCS topic when a change is observed.

Built for platforms that accept agents as counterparties, DAOs monitoring delegate agents, and operators tracking a deployed agent fleet. Polling is free (`fixatum_score` costs nothing) — you only pay 0.1 HBAR when an alert actually fires.

Create a `watched-agents.json` file next to the script:

```json
[
  { "did": "did:hedera:mainnet:z..._0.0.123456", "label": "MyAgent" },
  { "did": "did:hedera:mainnet:z..._0.0.789012", "label": "PartnerAgent" }
]
```

Then run:

```bash
HEDERA_ACCOUNT_ID=0.0.YOUR_ID HCS_TOPIC_ID=0.0.YOUR_TOPIC node examples/agent-reputation-monitor.mjs

# Single agent via env var:
HEDERA_ACCOUNT_ID=0.0.YOUR_ID HCS_TOPIC_ID=0.0.YOUR_TOPIC WATCH_DID=did:hedera:mainnet:z... node examples/agent-reputation-monitor.mjs
```

> First run establishes baselines only — no alerts fire on startup.
> State is saved to `agents-state.json` and survives restarts.

| Config | Default | Description |
|--------|---------|-------------|
| `HCS_TOPIC_ID` | required | Your HCS topic for alert records |
| `CHECK_INTERVAL_H` | `6` | Hours between checks |
| `DROP_THRESHOLD` | `10` | Point drop that triggers alert regardless of grade |
| `WATCH_FILE` | `watched-agents.json` | Path to your watch list |

**Cost:** Free to poll · `0.1 ℏ` per alert written to HCS

> Agents without a Fixatum DID cannot be monitored. Get one at [fixatum.com/register](https://fixatum.com/register).

---

### 🔎 Compliance + KYA Onboarding
**[`examples/compliance-kya-onboarding-agent.mjs`](examples/compliance-kya-onboarding-agent.mjs)**

Screens any Hedera account before doing business with them. Runs identity resolution, on-chain risk screening, and optional KYC verification — then pulls a live [Fixatum](https://fixatum.com) KYA trust score (0–100) for free as part of the same run. The full result is written as a single tamper-proof record to your own HCS topic.

Returns `APPROVED`, `REJECTED`, `PENDING_REVIEW`, or `PENDING_KYC`.

Designed for token issuers, DEXes, DAOs, and treasury managers who want auditable counterparty screening with a reputation layer, not just a binary pass/fail.

```bash
HEDERA_ACCOUNT_ID=0.0.YOUR_ID HCS_TOPIC_ID=0.0.YOUR_TOPIC SUBJECT=0.0.999999 node examples/compliance-kya-onboarding-agent.mjs

# With KYC check and tamper verification:
HEDERA_ACCOUNT_ID=0.0.YOUR_ID HCS_TOPIC_ID=0.0.YOUR_TOPIC SUBJECT=0.0.999999 KYC_TOKEN_ID=0.0.731861 node examples/compliance-kya-onboarding-agent.mjs
```

> `HCS_TOPIC_ID` is required — records write to your own topic, not a shared one. If you have a Fixatum DID, your `agent_topic_id` works here. Get one at [fixatum.com/register](https://fixatum.com/register).

| Config | Default | Description |
|--------|---------|-------------|
| `SUBJECT` | `0.0.7925398` | Account to screen |
| `HCS_TOPIC_ID` | required | Your HCS topic for compliance records |
| `KYC_TOKEN_ID` | none | Optional: your token ID for KYC check |
| `SKIP_VERIFY` | `false` | Set `true` to skip tamper verification |

**Cost:** `~1.3 ℏ` base · `~2.3 ℏ` with verify · `~2.8 ℏ` with verify + KYC

> **Note:** `identity_check_sanctions` is on-chain behavioural analysis of Hedera transaction patterns only. It is not a legal sanctions check against any government watchlist.

---

### 🐋 Whale Alert Monitor
**[`examples/whale-alert-agent.mjs`](examples/whale-alert-agent.mjs)**

Monitors any Hedera token for unusual whale concentration on a schedule. When top-10 holders exceed your threshold, writes a tamper-proof `whale_alert` record to HCS and prints the Hashscan proof URL.

```bash
HEDERA_ACCOUNT_ID=0.0.YOUR_ID TOKEN_ID=0.0.731861 node examples/whale-alert-agent.mjs
```

| Config | Default | Description |
|--------|---------|-------------|
| `TOKEN_ID` | `0.0.731861` | Token to monitor |
| `THRESHOLD_PCT` | `80` | Alert if top-10 holders exceed this % |
| `CHECK_INTERVAL_MS` | `3600000` | Check every hour |

**Cost:** `0.2 ℏ` per check · `5 ℏ` only when anomaly fires

---

### 🔍 Token Due Diligence
**[`examples/token-due-diligence-agent.mjs`](examples/token-due-diligence-agent.mjs)**

Full investment and listing due diligence on any Hedera token in one run. Pulls price data, deep holder analysis, admin key risks, and treasury account identity — outputs a structured risk report with an overall verdict.

```bash
HEDERA_ACCOUNT_ID=0.0.YOUR_ID TOKEN_ID=0.0.731861 node examples/token-due-diligence-agent.mjs
```

**Cost:** `~1.0 ℏ` per report (token_price + token_analyze + identity_resolve on treasury)

---

### 🗳️ DAO Governance Monitor
**[`examples/dao-monitor-agent.mjs`](examples/dao-monitor-agent.mjs)**

Watches active governance proposals for a Hedera token on a schedule. Alerts when a proposal is closing within 24 hours. Pass `--analyze` with a `PROPOSAL_ID` for deep vote tally and outcome prediction.

```bash
# Monitor proposals
HEDERA_ACCOUNT_ID=0.0.YOUR_ID TOKEN_ID=0.0.731861 node examples/dao-monitor-agent.mjs

# Deep-analyze a specific proposal (requires HCS topic)
HEDERA_ACCOUNT_ID=0.0.YOUR_ID TOKEN_ID=0.0.731861 TOPIC_ID=0.0.999 PROPOSAL_ID=42 node examples/dao-monitor-agent.mjs --analyze
```

**Cost:** `0.2 ℏ` per check · `1.0 ℏ` for deep analysis · `10 ℏ` covers ~12 days at 4 checks/day

---

## Connect

**MCP endpoint:**
```
https://api.hederatoolbox.com/mcp
```

**Claude.ai** (web or mobile)
Settings → Connectors → Add → paste the endpoint URL above.

**Claude Desktop app**

Step 1 — install the package globally (required, do this once):
```bash
npm install -g @hederatoolbox/platform
```

Step 2 — add to `claude_desktop_config.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "hederatoolbox": {
      "command": "npx",
      "args": ["-y", "@hederatoolbox/platform"]
    }
  }
}
```

Restart Claude Desktop after saving the config.

> **Windows users:** if you see `npm error could not determine executable to run`, your npm global directory may not exist yet. Run these first:
> ```
> mkdir %APPDATA%\npm
> npm config set prefix %APPDATA%\npm
> npm install -g @hederatoolbox/platform
> ```

**OpenClaw / ClawHub**

Install the HederaToolbox skill directly from ClawHub:

```bash
clawhub install mountainmystic/hederatoolbox
```

Then add your Hedera account ID to your OpenClaw environment:

```
HEDERA_ACCOUNT_ID=0.0.YOUR_ACCOUNT_ID
```

Skill listing: [clawhub.ai/mountainmystic/hederatoolbox](https://clawhub.ai/mountainmystic/hederatoolbox)

**Cursor / other MCP-compatible clients**
Use the endpoint URL directly in your MCP server config.

---

## How It Works

HederaToolbox uses **agent-native HBAR payments**. No accounts, no OAuth, no email.

```
1. get_terms        -> read the Terms of Service         (free)
2. confirm_terms    -> record consent                    (free)
3. account_info     -> get platform wallet + pricing     (free)
4. send HBAR        -> your account ID becomes your key  (auto-provisioned)
5. call any tool    -> pass your Hedera account ID as api_key
```

**Platform wallet:** `0.0.10309126` (mainnet)

Credits are persistent. Unused balance carries over indefinitely.

---

## Safety Architecture

All safety controls run **server-side** and cannot be bypassed by modifying the npm package.

- **Consent gate** — `confirm_terms` required before any paid tool executes
- **Atomic balance deduction** — balance check and deduct are a single SQL operation, race-condition proof
- **Loop guard** — same tool called >20 times in 60s by the same key is blocked automatically
- **No private keys** — we never see your private key and never ask for it. You authenticate with your Hedera account ID — a public identifier, like a username. Your key stays in your wallet.

Terms of Service: `get_terms` tool or [/public/terms.json](https://api.hederatoolbox.com/public/terms.json)

---

## Tools

### Free — Onboarding and Legal

| Tool | Description |
|------|-------------|
| `get_terms` | Machine-readable Terms of Service. Call before anything else. |
| `confirm_terms` | Record consent. Required before any paid tool. |
| `account_info` | Platform wallet address, full pricing table, your balance. |

---

### Module 1 — HCS Topic Intelligence

| Tool | Cost | Description |
|------|------|-------------|
| `hcs_monitor` | 0.10 HBAR | Topic status, message count, recent activity |
| `hcs_query` | 0.10 HBAR | Natural language Q&A over topic messages, AI-ranked |
| `hcs_understand` | 1.00 HBAR | Anomaly detection, trend analysis, entity extraction |

---

### Module 2 — Compliance and Audit Trail

| Tool | Cost | Description |
|------|------|-------------|
| `hcs_write_record` | 0.10 HBAR | Write tamper-evident record to HCS — optionally signed with your DID key |
| `hcs_verify_record` | 1.00 HBAR | Check a record's hash, and re-check its agent signature if it has one |
| `hcs_audit_trail` | 2.00 HBAR | Full chronological audit history for an entity |

---

### Module 3 — Governance Intelligence

| Tool | Cost | Description |
|------|------|-------------|
| `governance_monitor` | 0.20 HBAR | Active proposals, deadlines, current vote tallies |
| `governance_analyze` | 1.00 HBAR | Voter sentiment, participation rate, outcome prediction |

---

### Module 4 — Token Intelligence

| Tool | Cost | Description |
|------|------|-------------|
| `token_price` | 0.10 HBAR | Spot price, 1h/24h/7d change, liquidity — via SaucerSwap |
| `token_monitor` | 0.20 HBAR | Recent transfers, whale movements, unusual patterns |
| `token_analyze` | 0.60 HBAR | Holder distribution, velocity, concentration, risk score |

---

### Module 5 — Identity Resolution

| Tool | Cost | Description |
|------|------|-------------|
| `identity_resolve` | 0.20 HBAR | Account profile: age, holdings, transaction history |
| `identity_verify_kyc` | 0.50 HBAR | KYC grant status and verification history for a token |
| `identity_check_sanctions` | 1.00 HBAR | On-chain risk screening, counterparty patterns |

---

### Module 6 — Smart Contract Intelligence

| Tool | Cost | Description |
|------|------|-------------|
| `contract_read` | 0.20 HBAR | Metadata, bytecode size, recent callers, gas stats |
| `contract_call` | 1.00 HBAR | Read-only function call — no gas, no transaction |
| `contract_analyze` | 1.50 HBAR | Activity patterns, caller distribution, risk classification |

Accepts both Hedera native IDs (`0.0.123456`) and EVM addresses (`0x...`).

---

### Module 7 — Fixatum DID Identity

Register agents on [Fixatum](https://fixatum.com) — a W3C DID issuance and KYA (Know Your Agent) trust scoring platform built on Hedera.

| Tool | Cost | Description |
|------|------|-------------|
| `fixatum_register` | 100 HBAR | Register for a permanent W3C DID anchored to Hedera HCS and a live KYA trust score |
| `fixatum_score` | Free | Query live KYA score (0–100, grade A–F) and component breakdown for any registered agent |
| `fixatum_status` | Free | Check registration status, current score, and whether provenance is actively building |

Call `fixatum_register` without `ed25519_public_key` to get key generation instructions first — no charge until registration proceeds.

---

## Changelog

**v4.0.0** — Agent-signed HCS records. Pass `agent_did` and `agent_signature` to `hcs_write_record` to write a record signed with your Fixatum DID key — records are now marked `agent_signed` or `platform_witnessed`, and `hcs_verify_record` re-checks the signature independently. A signature that does not match is rejected and the call is not charged.

> **Breaking:** `hcs_verify_record` no longer returns the top-level `verified` field. Read `tamper_check` instead — it returns `"intact"` or `"mismatch"`. The `hash_valid` and `tampered` fields are unchanged, so callers reading those need no change.

**v3.5.3** — Fixatum DID module added (fixatum_register, fixatum_score, fixatum_status) — 23 tools, 7 modules

**v3.4.5** — Agent examples improved, xagent persona rewrite

**v3.4.2** — X agent (Telegram-gated autonomous tweet drafting), agent examples added to repo

**v3.4.0** — Repriced all tools across all 6 modules

**v3.3.1** — Full security audit: SQLite-backed rate limiting, API key validation, 1MB body cap, separate BACKUP_SECRET, 90-day PII purge, HITL removed, legal pages deployed

---

## Known Limitations

- Mirror node balance endpoint occasionally returns empty for high-holder tokens. Metadata unaffected.

---

## Links

| | |
|---|---|
| npm | https://www.npmjs.com/package/@hederatoolbox/platform |
| MCP Registry | https://registry.modelcontextprotocol.io/?q=hederatoolbox |
| Glama | https://glama.ai/mcp/servers/mountainmystic/hederatoolbox |
| ClawHub | https://clawhub.ai/mountainmystic/hederatoolbox |
| Live endpoint | https://api.hederatoolbox.com/mcp |
| Terms | https://api.hederatoolbox.com/terms |

> **Note:** The old package `@hederaintel/platform` is deprecated. Update your config to use `@hederatoolbox/platform`.

---

## License

**npm package** — provided for integration use only.

**Remote server and all backend logic** — Proprietary. See [LICENSE.md](LICENSE.md).

Enterprise licensing and SLA inquiries: open an issue titled `[Enterprise]`.

---

## Website

[hederatoolbox.com](https://hederatoolbox.com)

---

## On-Chain Identity

HederaToolbox has a permanent platform identity record written to Hedera mainnet.

| Field | Value |
|---|---|
| HCS Topic | `0.0.10353855` |
| Record ID | `c420c3b9-408e-4f87-a9e1-1dcbb54facfa` |
| Transaction | `0.0.10309126@1773623419.733217779` |
| Written | 16 March 2026 |
| Verify | [hashscan.io/mainnet/topic/0.0.10353855](https://hashscan.io/mainnet/topic/0.0.10353855) |
