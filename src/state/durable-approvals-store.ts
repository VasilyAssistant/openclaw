// Durable, restart-surviving plugin-approval records (SQLite, shared state DB).
//
// Backs deferred (non-blocking) plugin approvals: a request is persisted here and
// returns immediately; the owner decision is recorded later; on approval the
// originating tool call is re-invoked with the immutable snapshot. `action_hash`
// binds the decision to that snapshot so an approved action cannot be swapped
// before it is applied. Survives gateway restart and is independent of the
// requesting connection, unlike the in-memory ExecApprovalManager.

import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

export type DurableApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "applied"
  | "expired"
  | "failed";

export type DurableApprovalDecision = "approve" | "deny";

const ACTIVE_STATUSES: readonly DurableApprovalStatus[] = ["pending", "approved", "applied"];
const TERMINAL_STATUSES: readonly DurableApprovalStatus[] = [
  "applied",
  "denied",
  "expired",
  "failed",
];

export type DurableApprovalRecord = {
  id: string;
  status: DurableApprovalStatus;
  kind: string;
  actionHash: string;
  action: unknown;
  title?: string;
  description?: string;
  risk?: string;
  requesterActor?: string;
  ownerSubject?: string;
  source?: string;
  idempotencyKey?: string;
  createdAtMs: number;
  expiresAtMs: number;
  decision?: DurableApprovalDecision;
  resolvedBy?: string;
  resolvedAtMs?: number;
  appliedAtMs?: number;
  appliedResultRef?: string;
  failureReason?: string;
  messageRefs?: unknown;
  resumeRunId?: string;
  resumeToolName?: string;
  resumeToolCallId?: string;
  resumePayload?: unknown;
};

export type CreateDurableApprovalInput = {
  id: string;
  kind: string;
  action: unknown;
  actionHash: string;
  expiresAtMs: number;
  createdAtMs?: number;
  title?: string;
  description?: string;
  risk?: string;
  requesterActor?: string;
  ownerSubject?: string;
  source?: string;
  idempotencyKey?: string;
  resumeRunId?: string;
  resumeToolName?: string;
  resumeToolCallId?: string;
  resumePayload?: unknown;
};

type DurableApprovalsRow = OpenClawStateKyselyDatabase["durable_approvals"];

function stateKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
}

function parseJson(value: string | null): unknown {
  if (value == null) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stringifyJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function optional(value: string | null): string | undefined {
  return value == null ? undefined : value;
}

function rowToRecord(row: DurableApprovalsRow): DurableApprovalRecord {
  return {
    id: row.id,
    status: row.status as DurableApprovalStatus,
    kind: row.kind,
    actionHash: row.action_hash,
    action: parseJson(row.action_json),
    title: optional(row.title),
    description: optional(row.description),
    risk: optional(row.risk),
    requesterActor: optional(row.requester_actor),
    ownerSubject: optional(row.owner_subject),
    source: optional(row.source),
    idempotencyKey: optional(row.idempotency_key),
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    decision: (optional(row.decision) as DurableApprovalDecision | undefined) ?? undefined,
    resolvedBy: optional(row.resolved_by),
    resolvedAtMs: row.resolved_at_ms ?? undefined,
    appliedAtMs: row.applied_at_ms ?? undefined,
    appliedResultRef: optional(row.applied_result_ref),
    failureReason: optional(row.failure_reason),
    messageRefs: parseJson(row.message_refs_json),
    resumeRunId: optional(row.resume_run_id),
    resumeToolName: optional(row.resume_tool_name),
    resumeToolCallId: optional(row.resume_tool_call_id),
    resumePayload: parseJson(row.resume_payload_json),
  };
}

function readById(db: DatabaseSync, id: string): DurableApprovalRecord | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    stateKysely(db).selectFrom("durable_approvals").selectAll().where("id", "=", id),
  );
  return row ? rowToRecord(row) : undefined;
}

/** Look up a durable approval across all states. */
export function getDurableApproval(
  id: string,
  options: OpenClawStateDatabaseOptions = {},
): DurableApprovalRecord | undefined {
  return readById(openOpenClawStateDatabase(options).db, id);
}

/** Find a still-active approval by idempotency key (pending/approved/applied). */
export function findDurableApprovalByIdempotencyKey(
  idempotencyKey: string,
  options: OpenClawStateDatabaseOptions = {},
): DurableApprovalRecord | undefined {
  const db = openOpenClawStateDatabase(options).db;
  const row = executeSqliteQueryTakeFirstSync(
    db,
    stateKysely(db)
      .selectFrom("durable_approvals")
      .selectAll()
      .where("idempotency_key", "=", idempotencyKey)
      .where("status", "in", [...ACTIVE_STATUSES])
      .orderBy("created_at_ms", "desc"),
  );
  return row ? rowToRecord(row) : undefined;
}

/**
 * Create a durable approval, or idempotently return an existing active one with
 * the same idempotency key so a retried request never produces a duplicate.
 */
export function createDurableApproval(
  input: CreateDurableApprovalInput,
  options: OpenClawStateDatabaseOptions = {},
): DurableApprovalRecord {
  return runOpenClawStateWriteTransaction((database) => {
    const db = database.db;
    if (input.idempotencyKey) {
      const existing = findActiveByIdempotencyKeyTx(db, input.idempotencyKey);
      if (existing) {
        return existing;
      }
    }
    const createdAtMs = input.createdAtMs ?? Date.now();
    executeSqliteQuerySync(
      db,
      stateKysely(db)
        .insertInto("durable_approvals")
        .values({
          id: input.id,
          status: "pending",
          kind: input.kind,
          action_hash: input.actionHash,
          action_json: JSON.stringify(input.action ?? null),
          title: input.title ?? null,
          description: input.description ?? null,
          risk: input.risk ?? null,
          requester_actor: input.requesterActor ?? null,
          owner_subject: input.ownerSubject ?? null,
          source: input.source ?? null,
          idempotency_key: input.idempotencyKey ?? null,
          created_at_ms: createdAtMs,
          expires_at_ms: input.expiresAtMs,
          decision: null,
          resolved_by: null,
          resolved_at_ms: null,
          applied_at_ms: null,
          applied_result_ref: null,
          failure_reason: null,
          message_refs_json: null,
          resume_run_id: input.resumeRunId ?? null,
          resume_tool_name: input.resumeToolName ?? null,
          resume_tool_call_id: input.resumeToolCallId ?? null,
          resume_payload_json: stringifyJson(input.resumePayload),
        }),
    );
    const created = readById(db, input.id);
    if (!created) {
      throw new Error(`durable approval ${input.id} vanished after insert`);
    }
    return created;
  }, options);
}

function findActiveByIdempotencyKeyTx(
  db: DatabaseSync,
  idempotencyKey: string,
): DurableApprovalRecord | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    stateKysely(db)
      .selectFrom("durable_approvals")
      .selectAll()
      .where("idempotency_key", "=", idempotencyKey)
      .where("status", "in", [...ACTIVE_STATUSES])
      .orderBy("created_at_ms", "desc"),
  );
  return row ? rowToRecord(row) : undefined;
}

export type RecordDecisionResult =
  | { ok: true; record: DurableApprovalRecord; outcome: "recorded" | "already" | "expired" }
  | { ok: false; error: "not_found" };

/**
 * Record the owner's approve/deny decision on a pending approval. Safe for
 * replayed/stale callbacks: an already-resolved request returns its current
 * state; an overdue request transitions to ``expired`` instead of being applied.
 */
export function recordDurableApprovalDecision(
  id: string,
  decision: DurableApprovalDecision,
  resolvedBy: string,
  options: OpenClawStateDatabaseOptions = {},
  nowMs: number = Date.now(),
): RecordDecisionResult {
  return runOpenClawStateWriteTransaction((database) => {
    const db = database.db;
    const current = readById(db, id);
    if (!current) {
      return { ok: false, error: "not_found" } as const;
    }
    if (current.status !== "pending") {
      // Terminal or already-approved: replay-safe no-op.
      return { ok: true, record: current, outcome: "already" } as const;
    }
    if (nowMs >= current.expiresAtMs) {
      const expired = transitionTx(db, id, { status: "expired" });
      return { ok: true, record: expired, outcome: "expired" } as const;
    }
    const next = transitionTx(db, id, {
      status: decision === "approve" ? "approved" : "denied",
      decision,
      resolved_by: resolvedBy,
      resolved_at_ms: nowMs,
      failure_reason: decision === "deny" ? "denied by owner" : null,
    });
    return { ok: true, record: next, outcome: "recorded" } as const;
  }, options);
}

/** Mark an approved request applied once its side effect has been performed. */
export function markDurableApprovalApplied(
  id: string,
  resultRef: string | undefined,
  options: OpenClawStateDatabaseOptions = {},
  nowMs: number = Date.now(),
): DurableApprovalRecord | undefined {
  return runOpenClawStateWriteTransaction((database) => {
    const current = readById(database.db, id);
    if (!current || current.status !== "approved") {
      return current;
    }
    return transitionTx(database.db, id, {
      status: "applied",
      applied_at_ms: nowMs,
      applied_result_ref: resultRef ?? null,
    });
  }, options);
}

/** Mark a request failed (apply error). */
export function markDurableApprovalFailed(
  id: string,
  reason: string,
  options: OpenClawStateDatabaseOptions = {},
): DurableApprovalRecord | undefined {
  return runOpenClawStateWriteTransaction((database) => {
    const current = readById(database.db, id);
    if (!current) {
      return undefined;
    }
    return transitionTx(database.db, id, { status: "failed", failure_reason: reason });
  }, options);
}

/** Append a delivered-channel message ref (for restart redelivery / card edits). */
export function appendDurableApprovalMessageRef(
  id: string,
  ref: unknown,
  options: OpenClawStateDatabaseOptions = {},
): DurableApprovalRecord | undefined {
  return runOpenClawStateWriteTransaction((database) => {
    const current = readById(database.db, id);
    if (!current) {
      return undefined;
    }
    const refs = Array.isArray(current.messageRefs) ? current.messageRefs : [];
    return transitionTx(database.db, id, {
      message_refs_json: JSON.stringify([...refs, ref]),
    });
  }, options);
}

/** List approvals in a given status (e.g. ``pending`` for restart redelivery). */
export function listDurableApprovalsByStatus(
  status: DurableApprovalStatus,
  options: OpenClawStateDatabaseOptions = {},
): DurableApprovalRecord[] {
  const db = openOpenClawStateDatabase(options).db;
  const result = executeSqliteQuerySync(
    db,
    stateKysely(db)
      .selectFrom("durable_approvals")
      .selectAll()
      .where("status", "=", status)
      .orderBy("created_at_ms", "asc"),
  );
  return result.rows.map(rowToRecord);
}

/** Sweep pending/approved approvals past their deadline into ``expired``. */
export function expireDueDurableApprovals(
  options: OpenClawStateDatabaseOptions = {},
  nowMs: number = Date.now(),
): string[] {
  return runOpenClawStateWriteTransaction((database) => {
    const db = database.db;
    const due = executeSqliteQuerySync(
      db,
      stateKysely(db)
        .selectFrom("durable_approvals")
        .select(["id"])
        .where("status", "in", ["pending", "approved"])
        .where("expires_at_ms", "<=", nowMs),
    );
    const ids = due.rows.map((row) => row.id);
    for (const id of ids) {
      transitionTx(db, id, { status: "expired" });
    }
    return ids;
  }, options);
}

function transitionTx(
  db: DatabaseSync,
  id: string,
  patch: Partial<DurableApprovalsRow>,
): DurableApprovalRecord {
  executeSqliteQuerySync(
    db,
    stateKysely(db).updateTable("durable_approvals").set(patch).where("id", "=", id),
  );
  const updated = readById(db, id);
  if (!updated) {
    throw new Error(`durable approval ${id} vanished during transition`);
  }
  return updated;
}

export { TERMINAL_STATUSES as DURABLE_APPROVAL_TERMINAL_STATUSES };
