// fixatum/tools.js — Fixatum DID registration, score query, and status tools
import { Client, AccountId, PrivateKey, TransferTransaction, Hbar } from "@hashgraph/sdk";
import { chargeForTool } from "../../payments.js";

const FIXATUM_BASE = "https://did.fixatum.com";
const FIXATUM_WALLET = "0.0.10394452";
const FETCH_TIMEOUT_MS = 5000;
const MIDAS_ACCOUNT = "0.0.10435510"; // only account authorised for fleet tools
const FIXATUM_ADMIN_SECRET = process.env.FIXATUM_ADMIN_SECRET;

// ── Hedera SDK client (ECDSA, same pattern as compliance/tools.js) ────────────
let hederaClient;

function getClient() {
  if (!hederaClient) {
    const network = process.env.HEDERA_NETWORK || "testnet";
    hederaClient = network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
    hederaClient.setOperator(
      AccountId.fromString(process.env.HEDERA_ACCOUNT_ID),
      PrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY)
    );
  }
  return hederaClient;
}

// ── Fixatum API fetch with timeout ────────────────────────────────────────────
async function fixatumGet(path, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${FIXATUM_BASE}${path}`, { signal: controller.signal, headers: extraHeaders });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, status: res.status, data: null };
    const data = await res.json();
    return { ok: true, status: res.status, data };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, data: null, error: e.message };
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

// ── Fleet tools (Midas-only, free, server-side auth) ────────────────────────
export const FIXATUM_FLEET_TOOL_DEFINITIONS = [
  {
    name: "fixatum_fleet_status",
    description:
      "Read all agent statuses and inbox count from the Fixatum agent communication layer. Returns latest report from each agent (VisionForge, Scout, Narrator) plus unresolved inbox item count. Free. Only callable by Midas (0.0.10435510).",
    annotations: {
      title: "Fleet Agent Status",
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        api_key: {
          type: "string",
          description: "Your HederaToolbox API key. Must be Midas account (0.0.10435510).",
        },
      },
      required: ["api_key"],
    },
  },
  {
    name: "fixatum_fleet_inbox",
    description:
      "Read unresolved flagged items from the Fixatum agent inbox. Returns items posted by Scout, Narrator, or other agents requiring Midas attention. Free. Only callable by Midas (0.0.10435510).",
    annotations: {
      title: "Fleet Agent Inbox",
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        api_key: {
          type: "string",
          description: "Your HederaToolbox API key. Must be Midas account (0.0.10435510).",
        },
      },
      required: ["api_key"],
    },
  },
];

export const FIXATUM_TOOL_DEFINITIONS = [
  {
    name: "fixatum_register",
    description:
      "Register this agent with Fixatum to get a permanent W3C-compliant DID (did:hedera:mainnet:z...) anchored to Hedera HCS and a live KYA trust score. Costs 100 HBAR. Requires a dedicated Ed25519 key pair — NOT your Hedera account key. Call with hedera_account_id only to get full prerequisites and key generation instructions. Free prerequisite check, no charge until registration proceeds.",
    annotations: {
      title: "Register Agent DID on Fixatum",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        hedera_account_id: {
          type: "string",
          description: "Your Hedera account ID (e.g. 0.0.123456) — this becomes part of your DID.",
        },
        ed25519_public_key: {
          type: "string",
          description:
            "Your Ed25519 public key encoded as base58btc multibase (starts with z, 40–50 chars). NOT your Hedera ECDSA key. Omit to get prerequisites and key generation instructions.",
        },
        api_key: {
          type: "string",
          description: "Your HederaToolbox API key (Hedera account ID).",
        },
      },
      required: ["hedera_account_id", "api_key"],
    },
  },
  {
    name: "fixatum_score",
    description:
      "Query a live Fixatum KYA trust score for any registered agent. Returns 0-100 score, grade (A-F), and component breakdown (provenance, account age, screening, anomaly signal). Free. Pass a Hedera account ID or full did:hedera DID.",
    annotations: {
      title: "Query Fixatum KYA Trust Score",
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        did_or_account_id: {
          type: "string",
          description:
            "Full Fixatum DID (did:hedera:mainnet:z...) or Hedera account ID (0.0.XXXXXX).",
        },
        api_key: {
          type: "string",
          description: "Your HederaToolbox API key (Hedera account ID).",
        },
      },
      required: ["did_or_account_id", "api_key"],
    },
  },
  {
    name: "fixatum_status",
    description:
      "Check Fixatum registration status for a Hedera account. Returns DID if registered, live score, and whether provenance is actively building. Free. Use before fixatum_register to check if already registered.",
    annotations: {
      title: "Check Fixatum Registration Status",
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        hedera_account_id: {
          type: "string",
          description: "Hedera account ID to check (e.g. 0.0.123456).",
        },
        api_key: {
          type: "string",
          description: "Your HederaToolbox API key (Hedera account ID).",
        },
      },
      required: ["hedera_account_id", "api_key"],
    },
  },
];

// ── Tool execution ────────────────────────────────────────────────────────────

export async function executeFixatumTool(name, args) {

  // ── fixatum_register ────────────────────────────────────────────────────────
  if (name === "fixatum_register") {
    const { hedera_account_id, ed25519_public_key, api_key } = args;

    // Mode A — prerequisites (no public key provided)
    if (!ed25519_public_key) {
      return {
        mode: "prerequisites",
        title: "Fixatum DID Registration — Prerequisites",
        what_fixatum_issues:
          "A W3C DID Core 1.0 compliant DID anchored to Hedera HCS. Format: did:hedera:mainnet:z{BASE58_PUBKEY}_{HEDERA_ACCOUNT_ID}",
        why_ed25519:
          "The W3C did:hedera method requires an Ed25519 public key encoded as base58btc multibase (the z prefix). Your Hedera account uses an ECDSA key for transactions — these are intentionally separate. Your DID key is a dedicated identity key, not your wallet key.",
        key_generation: {
          description:
            "Call GET https://did.fixatum.com/keygen to get a fresh Ed25519 keypair. Store the private_key_hex securely. Use the public_key_multibase value as your ed25519_public_key in the next call.",
          endpoint: "GET https://did.fixatum.com/keygen",
          note:
            "Fixatum generates but never stores your private key. It is returned once only. No Node.js or terminal required.",
        },
        private_key_warning:
          "⚠️ Store your Ed25519 private key securely — offline or in a secrets manager. Fixatum never sees your private key. Loss of the private key does not affect your DID or score, but you will not be able to sign DID assertions in the future.",
        cost: "100 HBAR. One-time, permanent.",
        next_step:
          "Call fixatum_register again with both hedera_account_id and ed25519_public_key to register.",
        hedera_account_id,
        charged: false,
        timestamp: new Date().toISOString(),
      };
    }

    // Mode B — registration

    // Validate public key format
    if (!ed25519_public_key.startsWith("z")) {
      return {
        error: "Invalid public key format. The Ed25519 public key must be encoded as base58btc multibase and start with z (e.g. z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK). You appear to have provided a different key type.",
        hint: "Your Hedera account key is ECDSA (used for signing transactions). Fixatum DIDs require a separate Ed25519 key. Run the key generation command above to create a compatible key pair.",
        charged: false,
        timestamp: new Date().toISOString(),
      };
    }

    // ECDSA key starts with zQ3s — clear error
    if (ed25519_public_key.startsWith("zQ3s")) {
      return {
        error: "Key type mismatch. Keys starting with zQ3s are secp256k1 (ECDSA) keys — the same type used by your Hedera wallet.",
        w3c_note:
          "The W3C did:hedera method requires Ed25519 keys (base58btc multibase, typically starting with z6Mk). ECDSA keys are not compatible with this DID method.",
        hint: "Generate a dedicated Ed25519 key pair using the one-liner in the prerequisites response, then call fixatum_register again with that key.",
        charged: false,
        timestamp: new Date().toISOString(),
      };
    }

    const keyLen = ed25519_public_key.length;
    if (keyLen < 40 || keyLen > 55) {
      return {
        error: `Public key length looks wrong (${keyLen} chars). A valid Ed25519 base58btc multibase key is typically 44–50 characters including the z prefix.`,
        charged: false,
        timestamp: new Date().toISOString(),
      };
    }

    // Check if already registered
    const existing = await fixatumGet(`/did/${hedera_account_id}`);
    if (existing.ok && existing.data?.agent_did) {
      return {
        already_registered: true,
        did: existing.data.agent_did,
        registered_at: existing.data.registered_at || null,
        score_url: `https://did.fixatum.com/score/${existing.data.agent_did}`,
        message: "This account is already registered with Fixatum. No charge applied.",
        next_steps: [
          `Query your live score: call fixatum_score with did_or_account_id="${existing.data.agent_did}"`,
          "Build provenance: use HederaToolbox tools with this api_key to accumulate verified call history.",
        ],
        charged: false,
        timestamp: new Date().toISOString(),
      };
    }

    // Charge 100 HBAR
    const payment = chargeForTool("fixatum_register", api_key);

    // Send 100 HBAR to Fixatum wallet with public key as memo
    let txId;
    try {
      const client = getClient();
      const tx = await new TransferTransaction()
        .addHbarTransfer(process.env.HEDERA_ACCOUNT_ID, Hbar.fromTinybars(-10_000_000_000)) // -100 HBAR
        .addHbarTransfer(FIXATUM_WALLET, Hbar.fromTinybars(10_000_000_000))                 // +100 HBAR
        .setTransactionMemo(ed25519_public_key)
        .execute(client);

      const receipt = await tx.getReceipt(client);
      txId = tx.transactionId.toString();
      console.error(`[Fixatum] Transfer sent: ${txId}, status: ${receipt.status}`);
    } catch (e) {
      // Transfer failed — charge was already deducted. Log and return error with details.
      console.error(`[Fixatum] Transfer error: ${e.message}`);
      return {
        error: `HBAR transfer to Fixatum failed: ${e.message}`,
        note: "Your Toolbox balance was deducted. Contact support with this error if the transfer did not complete.",
        payment,
        charged: true,
        timestamp: new Date().toISOString(),
      };
    }

    // Poll Fixatum for DID confirmation (10 × 5s = 50s max)
    let did = null;
    let registeredAt = null;
    for (let attempt = 1; attempt <= 10; attempt++) {
      await new Promise(r => setTimeout(r, 5000));
      console.error(`[Fixatum] Polling attempt ${attempt}/10 for ${hedera_account_id}`);
      const poll = await fixatumGet(`/did/${hedera_account_id}`);
      if (poll.ok && poll.data?.agent_did) {
        did = poll.data.agent_did;
        registeredAt = poll.data.registered_at || null;
        break;
      }
    }

    if (did) {
      // Fetch full DID record to get agent_topic_id
      const didFull = await fixatumGet(`/did/${hedera_account_id}`);
      const agentTopicId = didFull.ok ? (didFull.data?.agent_topic_id || null) : null;
      const agentTopicHashscan = agentTopicId
        ? `https://hashscan.io/mainnet/topic/${agentTopicId}`
        : null;

      return {
        success: true,
        did,
        registered_at: registeredAt,
        hedera_account_id,
        agent_topic_id: agentTopicId,
        agent_topic_hashscan: agentTopicHashscan,
        score_url: `https://did.fixatum.com/score/${did}`,
        did_record_url: `https://did.fixatum.com/did/${hedera_account_id}`,
        payment,
        charged: true,
        next_steps: [
          `Query your initial score: call fixatum_score with did_or_account_id="${did}"`,
          agentTopicId
            ? `Write to your witness log: use hcs_write_record with topic_id="${agentTopicId}" to record your history, decisions, or continuity entries on-chain. Cost: 0.1 HBAR per entry.`
            : "Your dedicated HCS topic is being created — check did_record_url in a few seconds for your agent_topic_id.",
          "Build provenance: continue using HederaToolbox tools. Each call increments your verified call count, increasing the provenance component of your score (0–40 pts).",
        ],
        timestamp: new Date().toISOString(),
      };
    }

    // Timeout — DID not yet confirmed
    return {
      status: "pending",
      message:
        "HBAR transfer submitted but Fixatum has not yet confirmed the DID. This can take up to 2 minutes on mainnet.",
      hedera_account_id,
      transaction_id: txId,
      payment,
      charged: true,
      manual_check:
        `Poll manually: GET https://did.fixatum.com/did/${hedera_account_id} — when your DID appears, call fixatum_score to see your initial score.`,
      timestamp: new Date().toISOString(),
    };
  }

  // ── fixatum_score ───────────────────────────────────────────────────────────
  if (name === "fixatum_score") {
    const { did_or_account_id } = args;

    const res = await fixatumGet(`/score/${encodeURIComponent(did_or_account_id)}`);

    if (!res.ok) {
      if (res.status === 404) {
        return {
          registered: false,
          queried: did_or_account_id,
          message: "No Fixatum DID found for this identifier. Register first to get a score.",
          next_step: "Call fixatum_register with your hedera_account_id to begin registration.",
          timestamp: new Date().toISOString(),
        };
      }
      return {
        error: `Fixatum API unavailable (status ${res.status}). Try again shortly.`,
        queried: did_or_account_id,
        timestamp: new Date().toISOString(),
      };
    }

    return {
      queried: did_or_account_id,
      ...res.data,
      timestamp: new Date().toISOString(),
    };
  }

  // ── fixatum_status ──────────────────────────────────────────────────────────
  if (name === "fixatum_status") {
    const { hedera_account_id } = args;

    const [didRes, scoreRes] = await Promise.all([
      fixatumGet(`/did/${hedera_account_id}`),
      fixatumGet(`/score/${hedera_account_id}`),
    ]);

    const registered = didRes.ok && !!didRes.data?.agent_did;
    const did = registered ? didRes.data.agent_did : null;
    const registeredAt = registered ? (didRes.data.registered_at || null) : null;
    const score = scoreRes.ok ? scoreRes.data : null;

    const provenanceBound = score
      ? (score.source === "public" || (score.meta?.provenance?.verified_calls > 0))
      : false;

    if (!registered) {
      return {
        registered: false,
        did: null,
        registered_at: null,
        score: null,
        provenance_bound: false,
        hedera_account_id,
        next_step:
          "Call fixatum_register with hedera_account_id to begin DID registration. Costs 100 HBAR. Call without ed25519_public_key first to get key generation instructions.",
        timestamp: new Date().toISOString(),
      };
    }

    return {
      registered: true,
      did,
      registered_at: registeredAt,
      score,
      provenance_bound: provenanceBound,
      hedera_account_id,
      score_url: `https://did.fixatum.com/score/${did}`,
      timestamp: new Date().toISOString(),
    };
  }

  // ── fixatum_fleet_status ────────────────────────────────────────────────────
  if (name === "fixatum_fleet_status") {
    const { api_key } = args;
    if (api_key !== MIDAS_ACCOUNT) {
      return {
        error: "Access denied. fixatum_fleet_status is restricted to the Midas operator account.",
        timestamp: new Date().toISOString(),
      };
    }
    if (!FIXATUM_ADMIN_SECRET) {
      return {
        error: "FIXATUM_ADMIN_SECRET not configured on this Toolbox instance.",
        timestamp: new Date().toISOString(),
      };
    }
    const headers = { "x-admin-secret": FIXATUM_ADMIN_SECRET, "Accept": "application/json" };
    const [statusRes, inboxRes] = await Promise.all([
      fixatumGet("/agent-status", headers),
      fixatumGet("/agent-inbox",  headers),
    ]);
    if (!statusRes.ok) {
      return {
        error: `Fixatum /agent-status returned ${statusRes.status}`,
        timestamp: new Date().toISOString(),
      };
    }
    const unresolvedCount = Array.isArray(inboxRes.data?.items)
      ? inboxRes.data.items.filter(i => !i.resolved).length
      : (inboxRes.ok ? 0 : null);
    return {
      ...statusRes.data,
      inbox_unresolved_count: unresolvedCount,
      timestamp: new Date().toISOString(),
    };
  }

  // ── fixatum_fleet_inbox ──────────────────────────────────────────────────────
  if (name === "fixatum_fleet_inbox") {
    const { api_key } = args;
    if (api_key !== MIDAS_ACCOUNT) {
      return {
        error: "Access denied. fixatum_fleet_inbox is restricted to the Midas operator account.",
        timestamp: new Date().toISOString(),
      };
    }
    if (!FIXATUM_ADMIN_SECRET) {
      return {
        error: "FIXATUM_ADMIN_SECRET not configured on this Toolbox instance.",
        timestamp: new Date().toISOString(),
      };
    }
    const headers = { "x-admin-secret": FIXATUM_ADMIN_SECRET, "Accept": "application/json" };
    const inboxRes = await fixatumGet("/agent-inbox", headers);
    if (!inboxRes.ok) {
      return {
        error: `Fixatum /agent-inbox returned ${inboxRes.status}`,
        timestamp: new Date().toISOString(),
      };
    }
    const items = Array.isArray(inboxRes.data?.items)
      ? inboxRes.data.items.filter(i => !i.resolved)
      : [];
    return {
      unresolved_count: items.length,
      items,
      timestamp: new Date().toISOString(),
    };
  }

  throw new Error(`Unknown fixatum tool: ${name}`);
}
