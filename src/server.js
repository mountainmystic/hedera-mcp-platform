// server.js - MCP server factory with consent gate and HITL enforcement
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HCS_TOOL_DEFINITIONS, executeHCSTool } from "./modules/hcs/tools.js";
import { COMPLIANCE_TOOL_DEFINITIONS, executeComplianceTool } from "./modules/compliance/tools.js";
import { GOVERNANCE_TOOL_DEFINITIONS, executeGovernanceTool } from "./modules/governance/tools.js";
import { TOKEN_TOOL_DEFINITIONS, executeTokenTool } from "./modules/token/tools.js";
import { IDENTITY_TOOL_DEFINITIONS, executeIdentityTool } from "./modules/identity/tools.js";
import { CONTRACT_TOOL_DEFINITIONS, executeContractTool } from "./modules/contract/tools.js";
import { FIXATUM_TOOL_DEFINITIONS, FIXATUM_FLEET_TOOL_DEFINITIONS, executeFixatumTool } from "./modules/fixatum/tools.js";
import { ACCOUNT_TOOL_DEFINITIONS, executeAccountTool } from "./modules/account/tools.js";
import { LEGAL_TOOL_DEFINITIONS, executeLegalTool } from "./modules/legal/tools.js";
import { checkConsent } from "./consent.js";
import { logProvenance, getAgentDid, hasToolAccess } from "./db.js";

// Gated tools — only visible and callable by authorised accounts.
// These never appear in the public list_tools response.
export const GATED_TOOL_NAMES = new Set(["hcs_create_topic"]);
export const GATED_TOOLS = COMPLIANCE_TOOL_DEFINITIONS.filter(t => GATED_TOOL_NAMES.has(t.name));

// Public tool list — visible to all agents
export const ALL_TOOLS = [
  // Legal / onboarding (always first — agents see these before any paid tool)
  ...LEGAL_TOOL_DEFINITIONS,
  ...ACCOUNT_TOOL_DEFINITIONS,
  // Paid tools
  ...HCS_TOOL_DEFINITIONS,
  // Compliance tools minus gated ones
  ...COMPLIANCE_TOOL_DEFINITIONS.filter(t => !GATED_TOOL_NAMES.has(t.name)),
  ...GOVERNANCE_TOOL_DEFINITIONS,
  ...TOKEN_TOOL_DEFINITIONS,
  ...IDENTITY_TOOL_DEFINITIONS,
  ...CONTRACT_TOOL_DEFINITIONS,
  ...FIXATUM_TOOL_DEFINITIONS,
  ...FIXATUM_FLEET_TOOL_DEFINITIONS,
];

// Tools that bypass consent entirely
const FREE_TOOLS = new Set(["account_info", "get_terms", "confirm_terms", "fixatum_score", "fixatum_status", "fixatum_fleet_status", "fixatum_fleet_inbox"]);

// ── API key validation ────────────────────────────────────────────────────────
// Reject keys that are empty, too long, or clearly malformed.
// Hedera account IDs follow 0.0.XXXXXX format — enforce this for paid tools.
const API_KEY_MAX_LENGTH = 64;
const API_KEY_FORMAT = /^\d+\.\d+\.\d+$/; // e.g. 0.0.123456

function validateApiKey(apiKey, toolName) {
  if (FREE_TOOLS.has(toolName)) return; // free tools don't require a key
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error(
      `Missing api_key. Pass your Hedera account ID (e.g. 0.0.123456) as api_key. ` +
      `Call account_info to get the platform wallet address and funding instructions.`
    );
  }
  if (apiKey.length > API_KEY_MAX_LENGTH) {
    throw new Error(`Invalid api_key: exceeds maximum length of ${API_KEY_MAX_LENGTH} characters.`);
  }
  if (!API_KEY_FORMAT.test(apiKey)) {
    throw new Error(
      `Invalid api_key format. Expected Hedera account ID format: 0.0.XXXXXX (e.g. 0.0.123456). ` +
      `Call account_info if you need help getting started.`
    );
  }
}

async function routeTool(name, args, req) {
  // ── API key validation ──────────────────────────────────────────────────────
  validateApiKey(args?.api_key, name);

  // Legal tools (no consent check — they ARE the consent flow)
  if (["get_terms", "confirm_terms"].includes(name)) return executeLegalTool(name, args, req);
  if (name === "account_info") return executeAccountTool(name, args);

  // ── Gated tool access check ────────────────────────────────────────────────────
  if (GATED_TOOL_NAMES.has(name)) {
    if (!hasToolAccess(args?.api_key, name)) {
      throw new Error(
        `Tool "${name}" requires explicit access grant. ` +
        `Contact the platform operator to request access.`
      );
    }
  }

  // ── Consent gate ────────────────────────────────────────────────────
  checkConsent(name, args);

  // ── Execute tool ──────────────────────────────────────────────────────
  let result;
  if (["hcs_monitor", "hcs_query", "hcs_understand"].includes(name)) {
    result = await executeHCSTool(name, args);
  } else if (["hcs_write_record", "hcs_verify_record", "hcs_audit_trail", "hcs_create_topic"].includes(name)) {
    result = await executeComplianceTool(name, args);
  } else if (["governance_monitor", "governance_analyze", "governance_vote"].includes(name)) {
    result = await executeGovernanceTool(name, args);
  } else if (["token_price", "token_analyze", "token_monitor"].includes(name)) {
    result = await executeTokenTool(name, args);
  } else if (["identity_resolve", "identity_verify_kyc", "identity_check_sanctions"].includes(name)) {
    result = await executeIdentityTool(name, args);
  } else if (["contract_read", "contract_call", "contract_analyze"].includes(name)) {
    result = await executeContractTool(name, args);
  } else if (["fixatum_fleet_status", "fixatum_fleet_inbox"].includes(name)) {
    result = await executeFixatumTool(name, args);
  } else if (["fixatum_register", "fixatum_score", "fixatum_status"].includes(name)) {
    result = await executeFixatumTool(name, args);
  } else {
    throw new Error(`Unknown tool: ${name}`);
  }

  // ── Provenance ────────────────────────────────────────────────────
  // fixatum_score and fixatum_status are free read-only queries — no provenance needed.
  // fixatum_register is infrastructure, not a data query — no provenance.
  if (["fixatum_register", "fixatum_score", "fixatum_status", "fixatum_fleet_status", "fixatum_fleet_inbox"].includes(name)) return result;

  // Fire-and-forget — never blocks or fails the tool response.
  // inputs_summary: key args minus api_key (no credentials in provenance)
  // outputs_summary: first 300 chars of result — signal digest, not full payload
  // risk_flags: extracted from identity/compliance results where applicable
  setImmediate(() => {
    try {
      const { api_key, ...inputRest } = args || {};
      const inputsSummary  = JSON.stringify(inputRest).slice(0, 300);
      const outputsSummary = JSON.stringify(result).slice(0, 300);
      const resultStr      = JSON.stringify(result).toLowerCase();
      // Risk flags: only fire on genuinely adverse signals, not on the mere
      // presence of a risk_score field (which appears in almost every result).
      // sanctioned/frozen = hard adverse. anomaly/unusual = only when the tool
      // explicitly surfaces them as a finding, not as a field name.
      const riskFlags = [
        resultStr.includes('"sanctioned":true')                ? "sanctioned"       : null,
        resultStr.includes('"frozen":true')                    ? "frozen"           : null,
        resultStr.includes('"is_sanctioned":true')             ? "sanctioned"       : null,
        (resultStr.includes('"anomalies_detected":true') ||
         resultStr.includes('"anomaly_detected":true'))        ? "anomaly_detected" : null,
        resultStr.includes('"unusual_activity":true')          ? "unusual_activity" : null,
        resultStr.includes('"review"') && name === "identity_check_sanctions" ? "screening_review" : null,
      ].filter(Boolean).join(",") || null;
      const resolvedDid = args?.agent_did || getAgentDid(args?.api_key) || null;
      logProvenance(args?.api_key, name, inputsSummary, outputsSummary, riskFlags, resolvedDid);
    } catch { /* never propagate */ }
  });

  return result;
}

export function createServer(req) {
  const server = new Server(
    { name: "hedera-mcp-platform", version: "3.3.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    // Build a personalised tool list.
    // Start with the public tools, then append any gated tools this account has access to.
    const apiKey = request?.params?.arguments?.api_key || req?.apiKey || null;
    let tools = [...ALL_TOOLS];
    if (apiKey) {
      const gatedAllowed = GATED_TOOLS.filter(t => hasToolAccess(apiKey, t.name));
      tools = [...tools, ...gatedAllowed];
    }
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    console.error(`[Tool] ${name} | key: ${args?.api_key || "none"}`);

    try {
      const result = await routeTool(name, args, req);
      console.error(`[Done] ${name}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      console.error(`[Error] ${name}: ${error.message}`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: error.message,
            tool: name,
            timestamp: new Date().toISOString(),
          }),
        }],
        isError: true,
      };
    }
  });

  return server;
}
