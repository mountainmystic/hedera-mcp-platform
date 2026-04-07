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
    description: "Write a tamper-evident record to any open HCS topic on Hedera. Use this to write entries to your agent's own topic for continuity, memory, or history. topic_id is required — pass your agent topic ID. Returns record ID and tx proof. 0.1 HBAR.",
    annotations: { title: "Write Compliance Record", readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        topic_id: { type: "string", description: "HCS topic ID to write the record to. Must be an open topic you own or have access to." },
        record_type: { type: "string", description: "Type of compliance record (e.g. transaction, approval, audit_event)" },
        entity_id: { type: "string", description: "ID of the entity this record relates to" },
        data: { type: "object", description: "The compliance data to record (any JSON object)" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["topic_id", "record_type", "entity_id", "data", "api_key"],
    },
  },
  {
    name: "hcs_verify_record",
    description: "Verify a compliance record on Hedera HCS has not been tampered. 1.0 HBAR.",
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
    const payment = chargeForTool("hcs_write_record", args.api_key);
    const client = getClient();
    if (!args.topic_id) {
      return {
        error: true,
        reason: "topic_id is required. Pass the HCS topic ID you want to write to.",
        timestamp: new Date().toISOString(),
      };
    }

    const topicId = args.topic_id;

    const record = {
      record_id: crypto.randomUUID(),
      record_type: args.record_type,
      entity_id: args.entity_id,
      data: args.data,
      written_at: new Date().toISOString(),
      written_by: process.env.HEDERA_ACCOUNT_ID,
    };

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
          const computedHash = crypto
            .createHash("sha256")
            .update(JSON.stringify(recordWithoutHash))
            .digest("hex");

          foundRecord = {
            record_id: record.record_id,
            record_type: record.record_type,
            entity_id: record.entity_id,
            written_at: record.written_at,
            consensus_timestamp: msg.consensus_timestamp,
            hash_valid: computedHash === hash,
            tampered: computedHash !== hash,
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
        verified: false,
        record_id: args.record_id,
        topic_id: topicId,
        error: "Record not found on blockchain",
        payment,
      };
    }

    return {
      verified: true,
      tampered: foundRecord.tampered,
      hash_valid: foundRecord.hash_valid,
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