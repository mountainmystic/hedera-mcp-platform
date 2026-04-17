# HederaToolbox — Capabilities Manifest

> This document is the authoritative, versioned record of what HederaToolbox can and cannot do.
> It is written for AI agents, developers, and enterprise evaluators.
> Version: 3.5.3 | Updated: 2026-04-01

---

## What HederaToolbox Is

A **read and intelligence platform** for the Hedera network, delivered as an MCP server.

It allows AI agents to query, analyze, and write compliance records to Hedera. It does not execute financial transactions, deploy contracts, or interact with wallets.

---

## Confirmed Capabilities (v3.5.3)

### Payments and Onboarding
- Accept HBAR deposits to a platform wallet and auto-provision API keys
- Return current account balance on demand
- Serve machine-readable Terms of Service
- Record and verify agent consent before paid tool access

### HCS Topic Intelligence
- Retrieve topic metadata (message count, creation time, memo, recent activity)
- Answer natural language questions from topic message history using Claude Haiku
- Perform deep pattern analysis: anomaly detection, trend analysis, entity extraction, risk assessment

### Compliance and Audit Trail
- Write tamper-evident records to any HCS topic
- Verify a previously written record has not been altered
- Retrieve full chronological audit trail for a named entity

### Governance Intelligence
- List active governance proposals with deadlines and current vote tallies
- Analyze voter sentiment, participation rate, token concentration, and predicted outcomes

### Token and DeFi Intelligence
- Return live spot price, 1h/24h/7d price change, and liquidity for any SaucerSwap-listed token
- Return token metadata: name, symbol, decimals, total supply, treasury, type
- Monitor recent transfer activity and detect whale movements
- Discover yield opportunities: liquidity pools, staking, lending rates
- Analyze holder distribution, transfer velocity, concentration risk, and admin key exposure

### Identity Resolution
- Resolve a Hedera account ID to a full on-chain profile
- Return account age, token holdings, transaction history, and HCS identity records
- Check KYC grant status for any token
- Screen an account against on-chain risk signals and known flagged counterparties

### Smart Contract Intelligence
- Return contract metadata: EVM address, bytecode size, age, admin key, gas stats
- Execute read-only function calls against known ERC-20/ERC-721/HTS function selectors
- Perform deep contract analysis: activity patterns, caller distribution, risk classification
- Input accepts both Hedera native IDs (`0.0.123456`) and EVM addresses (`0x...`)

### Fixatum DID Identity
- Register an agent with Fixatum to receive a permanent W3C DID Core 1.0 compliant DID anchored to Hedera HCS (`did:hedera:mainnet:z..._0.0.XXXXXX`)
- Query live KYA (Know Your Agent) trust score (0–100) and component breakdown for any registered agent
- Check registration status and provenance binding for any Hedera account
- `fixatum_score` and `fixatum_status` are free, no consent required
- `fixatum_register` costs 100 HBAR (one-time registration fee, paid directly to Fixatum)

---

## Confirmed Limitations (v3.5.3)

| Area | Limitation |
|---|---|
| `token_price` | Only returns prices for tokens listed on SaucerSwap. Unlisted tokens return metadata only. |
| Mirror node holders | Balance endpoint returns empty for some high-holder tokens due to mirror node pagination. Metadata unaffected. |
| No wallet integration | Cannot interact with Hashpack, MetaMask, Blade, or any external wallet. |
| No token transfers | Cannot send or receive HBAR or HTS tokens on behalf of users. |
| No contract deployment | Cannot deploy, upgrade, or delete smart contracts. |
| No swap execution | Cannot execute trades or swaps on SaucerSwap or any DEX. |

---

## Features That Do Not Exist

The following features have been described by AI systems evaluating this repo. They are **not implemented** and do not exist in any version of HederaToolbox:

| Claimed Feature | Reality |
|---|---|
| DOVU OS integration | No DOVU integration exists. Compliance tools are generic HCS record-keeping. |
| "Actors" tools | No such tools exist. Identity tools cover Hedera accounts only. |
| Supply chain workflow validation | Not implemented. |
| `hederaintel_*` tool prefixes | All tools are unprefixed (e.g. `contract_read`, `hcs_monitor`). |
| `mcpConfig.json` | This file does not exist in the repo. |
| Wallet tool functionality | HederaToolbox has never had transfer or wallet capabilities. |
| NFT serial-level tools | NFT module was removed. Token tools cover HTS fungible tokens only. |
| EVM alias mapping (bidirectional) | Partially supported in `contract_read` input only. |

---

## Safety Architecture

- **Consent gate**: every agent must call `confirm_terms` before paid tools are accessible
- **Loop guard**: same tool called >20 times in 60s by the same key is automatically blocked
- **No client bypass**: all enforcement runs in the private remote server, not in the npm package
- **Audit log**: consent events are recorded to SQLite with timestamps

---

## Version History

| Version | Key Changes |
|---|---|
| 1.0.0 | Initial release — core HCS, token, governance tools |
| 2.0.0 | Thin client proxy architecture — npm package separated from Railway backend |
| 2.1.0 | Legal layer — `get_terms`, `confirm_terms`, HITL enforcement, proprietary license |
| 2.2.0 | SaucerSwap API key auth, live token prices, 1h/24h/7d change |
| 2.3.0 | EVM address support in identity and contract tools |
| 2.4.0 | `contract_call` arbitrary ABI encoding |
| 2.5.0 | npm namespace migration to `@hederatoolbox/platform` |
| 2.6.0 | `contract_call` return_types param, ethers ABI decode for tuples and arrays |
| 2.7.0 | Loop guard: same tool >20 calls/60s is blocked; `hcs_write_record` executes directly |
| 2.8.0 | Removed bridge and NFT modules — 20 tools, 6 modules |
| 2.9.0 | SQLite persistence, deposit watcher, `account_info` free onboarding entrypoint |
| 3.0.0 | Rebranded to HederaToolbox, custom domain `api.hederatoolbox.com` |
| 3.1.0 | Atomic balance deduction, HCS message sanitisation, robust JSON parsing, ghost deposit fix |
| 3.2.0 | Permanent endpoint `api.hederatoolbox.com`; HITL hard-stop removed from governance tools |
| 3.3.1 | Full security audit, SQLite rate limiting, API key validation, legal pages |
| 3.4.x | Repriced tools, X agent, agent examples |
| 3.5.3 | Fixatum DID module — 23 tools, 7 modules |
