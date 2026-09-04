// modules/account/tools.js - Account info and onboarding tool
// This is the agent onboarding entrypoint. Free to call, no API key required.
// An agent that finds this MCP server for the first time calls this tool,
// gets the platform wallet address, live pricing in HBAR and USD, sends HBAR, and is ready to go.

import { COSTS } from "../../payments.js";
import { getBalance, getAccount } from "../../db.js";
import { getHbarPriceUsd, formatUsdCost } from "../../hbar-price.js";

export const ACCOUNT_TOOL_DEFINITIONS = [
  {
    name: "account_info",
    description: "Platform wallet, live pricing for all 23 tools in HBAR/USD, and your balance. FREE. Call first to onboard: send HBAR to platform wallet, your Hedera account ID becomes your API key.",
    annotations: { title: "Account Info & Pricing", readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        api_key: {
          type: "string",
          description: "Optional. Your Hedera account ID (e.g. 0.0.456789) or API key. If provided, your current balance is returned.",
        },
      },
      required: [],
    },
  },
];

export async function executeAccountTool(name, args) {
  if (name === "account_info") {
    return getAccountInfo(args);
  }
  throw new Error(`Unknown account tool: ${name}`);
}

async function getAccountInfo(args) {
  const { api_key } = args || {};

  // Fetch live HBAR/USD price (cached, 5 min TTL)
  const hbarPriceUsd = await getHbarPriceUsd();

  // Build pricing table with live USD equivalents
  const pricing = Object.entries(COSTS).map(([tool, cost]) => {
    const hbarAmount = parseFloat(cost.hbar);
    const entry = {
      tool,
      cost_hbar: cost.hbar,
      cost_usd: formatUsdCost(hbarAmount, hbarPriceUsd),
    };
    return entry;
  });

  // Check balance if an api_key was provided
  let balanceInfo = null;
  if (api_key) {
    const account = getAccount(api_key);
    if (account) {
      const balanceHbar = (account.balance_tinybars / 100_000_000);
      balanceInfo = {
        api_key,
        balance_hbar: balanceHbar.toFixed(4),
        balance_usd: hbarPriceUsd
          ? `~$${(balanceHbar * hbarPriceUsd).toFixed(2)}`
          : null,
        hedera_account_id: account.hedera_account_id,
        created_at: account.created_at,
        last_used: account.last_used,
      };
    } else {
      balanceInfo = {
        api_key,
        balance_hbar: "0.0000",
        message: "Account not found. Send HBAR to the platform wallet to create your account automatically.",
      };
    }
  }

  return {
    service: "HederaToolbox — Hedera MCP Platform",
    description: "23 tools across 7 modules. Pay per call in HBAR. No registration required.",

    hbar_price_usd: hbarPriceUsd ? `$${hbarPriceUsd.toFixed(4)}` : "unavailable",
    hbar_price_source: "SaucerSwap DEX (live, 5-min cache)",

    how_to_fund: {
      step_1: "Send any amount of HBAR to the platform wallet below.",
      step_2: "Your Hedera account ID becomes your API key automatically.",
      step_3: "Pass your Hedera account ID as the api_key parameter in any tool call.",
      step_4: "Call account_info with your api_key at any time to check your balance.",
      minimum_deposit: "Minimum deposit: 0.1 HBAR. Deposits below 0.1 HBAR are silently ignored — no account is created and no balance is credited. Recommended starting deposit: 5–10 HBAR for comfortable exploration of all tools.",
      note: "Balances are persistent. Unused credit carries over indefinitely. You can top up at any time by sending more HBAR to the platform wallet.",
    },

    platform_wallet: {
      account_id: process.env.HEDERA_ACCOUNT_ID,
      network: process.env.HEDERA_NETWORK || "mainnet",
      memo: "HederaToolbox deposit — your sending account ID becomes your API key",
    },

    pricing,

    ...(balanceInfo && { your_account: balanceInfo }),

    links: {
      website: "https://hederatoolbox.com",
      mcp_endpoint: "https://api.hederatoolbox.com/mcp",
      npm: "https://www.npmjs.com/package/@hederatoolbox/platform",
      llms_txt: "https://hederatoolbox.com/llms.txt",
    },
  };
}
