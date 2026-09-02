// compliance/tools.js - Compliance & Audit Trail tool definitions and handlers
import {
  Client,
  AccountId,
  PrivateKey,
  TopicMessageSubmitTransaction,
  TopicCreateTransaction,
} from "@hashgraph/sdk";
import axios from "axios";
import crypto from "crypto";
import { chargeForTool } from "../../payments.js";
import { attestationEnvelope, verifyAgentSignature } from "../../did.js";

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

function getMirrorNodeBase() {
  return process.env.HEDERA_NETWORK === "mainnet"
    ? "https://mainnet-public.mirrornode.hedera.com"
    : "https://testnet.mirrornode.hedera.com";
}

const PLATFORM_TOPIC = process.env.HCS_COMPLIANCE_TOPIC_ID || "0.0.10305125";

export const COMPLIANCE_TOOL_DEFINITIONS = [
  {
    name: "hcs_write_record",
    description: "Write a tamper-evident record to any open HCS topic on Hedera. Use this to write entries to your agent's own topic for continuity, memory, or history. topic_id is required — pass your agent topic ID. Optionally sign the record with your Fixatum DID key by passing agent_did and agent_signature together, which marks the record agent_signed instead of platform_witnessed. Returns record ID and tx proof. 0.1 HBAR.",
    annotations: { title: "Write Compliance Record", readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        topic_id: { type: "string", description: "HCS topic ID to write the record to. Must be an open topic you own or have access to." },
        record_type: { type: "string", description: "Type of compliance record (e.g. transaction, approval, audit_event)" },
        entity_id: { type: "string", description: "ID of the entity this record relates to" },
        data: { type: "object", description: "The compliance data to record (any JSON object)" },
        agent_did: { type: "string", description: "Optional. Your Fixatum DID (did:hedera:mainnet:z{BASE58_PUBKEY}_{ACCOUNT_ID}). Must be passed together with agent_signature." },
        agent_signature: { type: "string", description: "Optional. Base64 Ed25519 signature over the canonical JSON of {topic_id, record_type, entity_id, data} with object keys sorted at every depth. Must be passed together with agent_did. A signature that does not match is rejected and the call is not charged." },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["topic_id", "record_type", "entity_id", "data", "api_key"],
    },
  },
  {
    name: "hcs_verify_record",
    description: "Check that a compliance record on Hedera HCS still matches its stored hash. For records written as agent_signed, the embedded Ed25519 signature is independently re-checked against the public key carried in the record's DID. Returns tamper_check, attestation_type, agent_did and signature_valid. 1.0 HBAR.",
    annotations: { title: "Verify Compliance Record", readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        topic_id: { type: "string", description: "HCS topic ID where the record was written. Defaults to the HederaIntel platform topic." },
        record_id: { type: "string", description: "Record ID returned when the record was written" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["record_id", "api_key"],
    },
  },
  {
    name: "hcs_audit_trail",
    description: "Full chronological audit trail for an entity from Hedera HCS. 2.0 HBAR.",
    annotations: { title: "Retrieve Audit Trail", readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        topic_id: { type: "string", description: "HCS topic ID to query. Defaults to the HederaIntel platform topic." },
        entity_id: { type: "string", description: "Entity ID to retrieve audit trail for" },
        limit: { type: "number", description: "Max records to retrieve (default 50)" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["entity_id", "api_key"],
    },
  },
  {
    name: "hcs_create_topic",
    description: "Create a new HCS topic on Hedera. Requires a Fixatum DID. Access is tiered: platform accounts and explicitly granted issuers bypass the score check; self-service agents need a DID with score ≥ 40. All callers subject to a 3-per-day rate limit. Returns the new topic ID. 2.0 HBAR.",
    annotations: { title: "Create HCS Topic", readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        agent_did: { type: "string", description: "Your Fixatum DID (did:hedera:mainnet:z...). Must have credibility score ≥ 40." },
        memo:      { type: "string", description: "Topic memo — briefly describe the purpose of this topic and the creating agent." },
        api_key:   { type: "string", description: "Your HederaToolbox API key (your Hedera account ID)" },
      },
      required: ["agent_did", "memo", "api_key"],
    },
  },
];

export async function executeComplianceTool(name, args) {
  if (name === "hcs_write_record") {
    // Every check below runs before chargeForTool — a rejected write is never billed.
    if (!args.topic_id) {
      return {
        error: true,
        reason: "topic_id is required. Pass the HCS topic ID you want to write to.",
        timestamp: new Date().toISOString(),
      };
    }

    const topicId = args.topic_id;

    // Agent signing is opt-in and all-or-nothing: both fields, or neither.
    const hasDid = !!args.agent_did;
    const hasSignature = !!args.agent_signature;
    if (hasDid !== hasSignature) {
      return {
        error: true,
        reason: "agent_did and agent_signature must be supplied together. Pass both to write an agent_signed record, or neither for a platform_witnessed record.",
        timestamp: new Date().toISOString(),
      };
    }

    let attestationType = "platform_witnessed";
    if (hasDid) {
      const envelope = attestationEnvelope({
        topic_id: topicId,
        record_type: args.record_type,
        entity_id: args.entity_id,
        data: args.data,
      });

      let signatureMatches = false;
      try {
        signatureMatches = verifyAgentSignature(args.agent_did, envelope, args.agent_signature);
      } catch (e) {
        return {
          error: true,
          reason: `Signature check could not run: ${e.message}`,
          signature_valid: false,
          not_charged: true,
          timestamp: new Date().toISOString(),
        };
      }

      if (!signatureMatches) {
        return {
          error: true,
          reason: "agent_signature does not match agent_did over the signed envelope. Sign the canonical JSON of {topic_id, record_type, entity_id, data} with object keys sorted at every depth.",
          signature_valid: false,
          not_charged: true,
          timestamp: new Date().toISOString(),
        };
      }

      attestationType = "agent_signed";
    }

    const payment = chargeForTool("hcs_write_record", args.api_key);
    const client = getClient();

    const record = {
      record_id: crypto.randomUUID(),
      record_type: args.record_type,
      entity_id: args.entity_id,
      data: args.data,
      written_at: new Date().toISOString(),
      written_by: process.env.HEDERA_ACCOUNT_ID,
      attestation_type: attestationType,
    };

    if (hasDid) {
      record.agent_did = args.agent_did;
      record.agent_signature = args.agent_signature;
      record.submitted_by = process.env.HEDERA_ACCOUNT_ID;
      record.ts = record.written_at;
    }

    const hash = crypto
      .createHash("sha256")
      .update(JSON.stringify(record))
      .digest("hex");

    record.hash = hash;

    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(JSON.stringify(record))
      .execute(client);

    const receipt = await tx.getReceipt(client);

    return {
      success: true,
      record_id: record.record_id,
      topic_id: topicId,
      entity_id: args.entity_id,
      record_type: args.record_type,
      attestation_type: attestationType,
      agent_did: hasDid ? args.agent_did : null,
      signature_valid: hasDid ? true : null,
      hash,
      transaction_id: tx.transactionId.toString(),
      written_at: record.written_at,
      verification_note: "This record is permanently stored on the Hedera blockchain and cannot be altered.",
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  if (name === "hcs_verify_record") {
    const payment = chargeForTool("hcs_verify_record", args.api_key);
    const base = getMirrorNodeBase();
    const topicId = args.topic_id || PLATFORM_TOPIC;

    const response = await axios.get(
      `${base}/api/v1/topics/${topicId}/messages?limit=100&order=asc`
    );

    const messages = response.data.messages || [];
    let foundRecord = null;

    for (const msg of messages) {
      try {
        const content = Buffer.from(msg.message, "base64").toString("utf-8");
        const record = JSON.parse(content);
        if (record.record_id === args.record_id) {
          const { hash, ...recordWithoutHash } = record;
          // Hashing stays on plain JSON.stringify — every record already on
          // chain was hashed this way, so the canonical form must not be used here.
          const computedHash = crypto
            .createHash("sha256")
            .update(JSON.stringify(recordWithoutHash))
            .digest("hex");

          // Records written before attestation_type existed are platform_witnessed.
          const attestationType = record.attestation_type || "platform_witnessed";

          // Re-derive the public key from the DID stored in the record and check
          // the signature again here, independently of the write path.
          let signatureValid = null;
          if (attestationType === "agent_signed") {
            const envelope = attestationEnvelope({
              topic_id: topicId,
              record_type: record.record_type,
              entity_id: record.entity_id,
              data: record.data,
            });
            try {
              signatureValid = verifyAgentSignature(record.agent_did, envelope, record.agent_signature);
            } catch (e) {
              signatureValid = false;
            }
          }

          foundRecord = {
            record_id: record.record_id,
            record_type: record.record_type,
            entity_id: record.entity_id,
            written_at: record.written_at,
            consensus_timestamp: msg.consensus_timestamp,
            tamper_check: computedHash === hash ? "intact" : "mismatch",
            hash_valid: computedHash === hash,
            tampered: computedHash !== hash,
            attestation_type: attestationType,
            agent_did: record.agent_did || null,
            signature_valid: signatureValid,
            sequence_number: msg.sequence_number,
          };
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!foundRecord) {
      return {
        found: false,
        record_id: args.record_id,
        topic_id: topicId,
        error: "Record not found on this topic",
        payment,
      };
    }

    return {
      found: true,
      topic_id: topicId,
      ...foundRecord,
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  if (name === "hcs_audit_trail") {
    const payment = chargeForTool("hcs_audit_trail", args.api_key);
    const base = getMirrorNodeBase();
    const topicId = args.topic_id || PLATFORM_TOPIC;
    const limit = args.limit || 50;

    const response = await axios.get(
      `${base}/api/v1/topics/${topicId}/messages?limit=100&order=asc`
    );

    const messages = response.data.messages || [];
    const trail = [];

    for (const msg of messages) {
      try {
        const content = Buffer.from(msg.message, "base64").toString("utf-8");
        const record = JSON.parse(content);
        if (record.entity_id === args.entity_id) {
          trail.push({
            record_id: record.record_id,
            record_type: record.record_type,
            written_at: record.written_at,
            consensus_timestamp: msg.consensus_timestamp,
            sequence_number: msg.sequence_number,
            data: record.data,
          });
        }
      } catch (e) {
        continue;
      }
    }

    return {
      entity_id: args.entity_id,
      topic_id: topicId,
      total_records: trail.length,
      audit_trail: trail.slice(0, limit),
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  if (name === "hcs_create_topic") {
    // ── Guardrail 1: DID format check — required for all tiers ────────────────
    const did = args.agent_did || "";
    if (!did.startsWith("did:hedera:mainnet:")) {
      return {
        denied: true,
        reason: "agent_did must be a valid Fixatum DID (did:hedera:mainnet:...)",
        timestamp: new Date().toISOString(),
      };
    }

    // ── Guardrail 2: Access tier check ────────────────────────────────────────
    // Three tiers, each with different trust requirements:
    //
    //   Tier A — Platform account (HEDERA_ACCOUNT_ID)
    //     Fixatum itself. Root of trust. No score check.
    //
    //   Tier B — Explicitly granted accounts (tool_access table)
    //     Accounts granted access by the operator after vetting — e.g. registered
    //     issuers. Vetting happened at registration time. No score check.
    //
    //   Tier C — Self-service agents (everyone else)
    //     No prior vetting. Must hold a Fixatum DID with score >= 40.
    //
    // All tiers still subject to the daily rate limit (Guardrail 3).

    const FIXATUM_API = process.env.FIXATUM_API_URL || "https://did.fixatum.com";
    const PLATFORM_ACCOUNT = process.env.HEDERA_ACCOUNT_ID;
    const { db, hasToolAccess } = await import("../../db.js");

    const isTierA = args.api_key === PLATFORM_ACCOUNT;
    const isTierB = !isTierA && hasToolAccess(args.api_key, "hcs_create_topic");
    const isTierC = !isTierA && !isTierB;

    let score = null;
    let accessTier;

    if (isTierA) {
      // Platform account — bypass score check entirely
      accessTier = "platform";
    } else if (isTierB) {
      // Granted issuer — bypass score check, trust came from registration vetting
      accessTier = "granted";
    } else {
      // Self-service agent — must have DID with score >= 40
      accessTier = "self-service";
      const MIN_SCORE = 40;
      try {
        const encodedDid = encodeURIComponent(did);
        const scoreRes = await axios.get(`${FIXATUM_API}/score/${encodedDid}`, {
          timeout: 5000,
          headers: { Accept: "application/json" },
        });
        score = scoreRes.data?.score ?? null;
      } catch (e) {
        return {
          denied: true,
          reason: "Could not verify DID score with Fixatum. Ensure your DID is registered at fixatum.com and try again.",
          timestamp: new Date().toISOString(),
        };
      }

      if (score === null || score < MIN_SCORE) {
        return {
          denied: true,
          reason: `Credibility score too low. Required: ${MIN_SCORE}, Current: ${score ?? "unscored"}. Build provenance via HederaToolbox and retry once your score reaches ${MIN_SCORE}.`,
          access_tier: accessTier,
          score,
          timestamp: new Date().toISOString(),
        };
      }
    }

    // ── Guardrail 3: Rate limit — max 3 topic creations per DID per 24h ────────
    // Applies to all tiers. Even the platform account can't bulk-create topics.
    const recentCount = db.prepare(`
      SELECT COUNT(*) as count FROM provenance
      WHERE agent_did = ? AND tool_name = 'hcs_create_topic'
      AND timestamp >= datetime('now', '-24 hours')
    `).get(did);

    const DAILY_LIMIT = 3;
    if (recentCount && recentCount.count >= DAILY_LIMIT) {
      return {
        denied: true,
        reason: `Daily topic creation limit reached (${DAILY_LIMIT} per DID per 24 hours). Try again tomorrow.`,
        access_tier: accessTier,
        topics_created_today: recentCount.count,
        timestamp: new Date().toISOString(),
      };
    }

    // ── All guardrails passed — charge and create ──────────────────────────────
    const payment = chargeForTool("hcs_create_topic", args.api_key);
    const client = getClient();

    const tx = await new TopicCreateTransaction()
      .setTopicMemo(args.memo)
      .execute(client);

    const receipt = await tx.getReceipt(client);
    const topicId = receipt.topicId.toString();

    return {
      success: true,
      topic_id: topicId,
      memo: args.memo,
      created_by_did: did,
      transaction_id: tx.transactionId.toString(),
      access_tier: accessTier,
      score_at_creation: score,
      topics_created_today: (recentCount?.count ?? 0) + 1,
      daily_limit: DAILY_LIMIT,
      note: "Topic created on Hedera mainnet. The creating DID is recorded in provenance.",
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  throw new Error(`Unknown compliance tool: ${name}`);
}