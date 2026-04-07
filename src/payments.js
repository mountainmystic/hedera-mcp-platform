// payments.js - HBAR micropayment system backed by SQLite persistence
// Replaces the old in-memory Map. Balances now survive restarts.

import { deductBalance, getBalance as dbGetBalance } from "./db.js";

export const COSTS = {
  // Module 1 - HCS Topic Intelligence
  hcs_monitor:              { tinybars: 10000000,  hbar: "0.1000" },
  hcs_query:                { tinybars: 10000000,  hbar: "0.1000" },
  hcs_understand:           { tinybars: 100000000, hbar: "1.0000" },
  // Module 2 - Compliance & Audit Trail
  hcs_write_record:         { tinybars: 10000000,  hbar: "0.1000" },
  hcs_verify_record:        { tinybars: 100000000, hbar: "1.0000" },
  hcs_audit_trail:          { tinybars: 200000000, hbar: "2.0000" },
  hcs_create_topic:         { tinybars: 200000000, hbar: "2.0000" },
  // Module 3 - Governance Intelligence
  governance_monitor:       { tinybars: 20000000,  hbar: "0.2000" },
  governance_analyze:       { tinybars: 100000000, hbar: "1.0000" },
  // Module 4 - Token Intelligence
  token_price:              { tinybars: 10000000,  hbar: "0.1000" },
  token_analyze:            { tinybars: 60000000,  hbar: "0.6000" },
  token_monitor:            { tinybars: 20000000,  hbar: "0.2000" },
  // Module 5 - Verified Identity Resolution
  identity_resolve:         { tinybars: 20000000,  hbar: "0.2000" },
  identity_verify_kyc:      { tinybars: 50000000,  hbar: "0.5000" },
  identity_check_sanctions: { tinybars: 100000000, hbar: "1.0000" },
  // Module 6 - Smart Contract Abstraction
  contract_read:            { tinybars: 20000000,   hbar: "0.2000" },
  contract_call:            { tinybars: 100000000,  hbar: "1.0000" },
  contract_analyze:         { tinybars: 150000000,  hbar: "1.5000" },
  // Module 7 - Fixatum Identity
  fixatum_register:         { tinybars: 10000000000, hbar: "100.0000" },
};

// Called by every tool before executing. Deducts cost from the account's
// persistent balance. Throws a clear error if the key is unknown or funds
// are insufficient — that error message reaches the calling AI agent.
export function chargeForTool(toolName, apiKey) {
  const cost = COSTS[toolName];
  if (!cost) return null; // free or unmetered tool

  const newBalanceTinybars = deductBalance(apiKey, cost.tinybars, toolName);
  const remainingHbar = (newBalanceTinybars / 100000000).toFixed(4);

  return {
    charged_hbar: cost.hbar,
    remaining_hbar: remainingHbar,
  };
}

export function getCosts() {
  return COSTS;
}

export function getBalance(apiKey) {
  const tinybars = dbGetBalance(apiKey);
  return (tinybars / 100000000).toFixed(4);
}
