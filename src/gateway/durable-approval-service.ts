// Gateway-facing service over the durable approval store (state/durable-approvals-store).
//
// Owns the gateway concerns the raw store leaves open: a single injected DB-options
// seam (so callers do not thread state-dir options), the action-hash that binds a
// decision to the immutable snapshot, and the durable approval TTL policy. The
// deferred (non-blocking) plugin-approval path, the Telegram callback, and the
// resume-on-approve path all go through this one seam; the in-memory
// ExecApprovalManager is untouched and still owns synchronous approvals.

import { createHash } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";
import {
  appendDurableApprovalMessageRef,
  createDurableApproval,
  type DurableApprovalDecision,
  type DurableApprovalRecord,
  expireDueDurableApprovals,
  getDurableApproval,
  listDurableApprovalsByStatus,
  markDurableApprovalApplied,
  markDurableApprovalFailed,
  type RecordDecisionResult,
  recordDurableApprovalDecision,
} from "../state/durable-approvals-store.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";

// Operator policy: durable approvals live for hours, independent of the in-memory
// plugin-approval timeout. Default 24h; clamp to the supported 6h–24h window so a
// caller-supplied ttl cannot widen the exposure beyond what the owner approved.
export const DURABLE_APPROVAL_TTL_DEFAULT_MS = 24 * 60 * 60 * 1000;
const DURABLE_APPROVAL_TTL_MIN_MS = 6 * 60 * 60 * 1000;
const DURABLE_APPROVAL_TTL_MAX_MS = 24 * 60 * 60 * 1000;

function clampTtlMs(ttlMs: number | undefined): number {
  if (ttlMs === undefined || !Number.isFinite(ttlMs)) {
    return DURABLE_APPROVAL_TTL_DEFAULT_MS;
  }
  return Math.min(DURABLE_APPROVAL_TTL_MAX_MS, Math.max(DURABLE_APPROVAL_TTL_MIN_MS, ttlMs));
}

/**
 * Hash that binds an approved decision to the exact action snapshot it was shown
 * for. `kind` is included so two different action kinds can never collide on the
 * same payload. Deterministic via stable key ordering so the resume path can
 * recompute and compare it (approve-one-execute-another protection).
 */
export function computeActionHash(kind: string, action: unknown): string {
  const raw = stableStringify({ kind, action });
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

export type CreateDeferredApprovalInput = {
  id: string;
  kind: string;
  action: unknown;
  ttlMs?: number;
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
  // Defaults to Date.now(); injectable for deterministic tests.
  nowMs?: number;
};

export class DurableApprovalService {
  constructor(private readonly options: OpenClawStateDatabaseOptions = {}) {}

  /** Persist a deferred approval and return the stored record (with action hash). */
  createDeferred(input: CreateDeferredApprovalInput): DurableApprovalRecord {
    const nowMs = input.nowMs ?? Date.now();
    return createDurableApproval(
      {
        id: input.id,
        kind: input.kind,
        action: input.action,
        actionHash: computeActionHash(input.kind, input.action),
        createdAtMs: nowMs,
        expiresAtMs: nowMs + clampTtlMs(input.ttlMs),
        title: input.title,
        description: input.description,
        risk: input.risk,
        requesterActor: input.requesterActor,
        ownerSubject: input.ownerSubject,
        source: input.source,
        idempotencyKey: input.idempotencyKey,
        resumeRunId: input.resumeRunId,
        resumeToolName: input.resumeToolName,
        resumeToolCallId: input.resumeToolCallId,
        resumePayload: input.resumePayload,
      },
      this.options,
    );
  }

  get(id: string): DurableApprovalRecord | undefined {
    return getDurableApproval(id, this.options);
  }

  recordDecision(
    id: string,
    decision: DurableApprovalDecision,
    resolvedBy: string,
    nowMs?: number,
  ): RecordDecisionResult {
    return recordDurableApprovalDecision(
      id,
      decision,
      resolvedBy,
      this.options,
      nowMs ?? Date.now(),
    );
  }

  markApplied(id: string, resultRef?: string, nowMs?: number): DurableApprovalRecord | undefined {
    return markDurableApprovalApplied(id, resultRef, this.options, nowMs ?? Date.now());
  }

  markFailed(id: string, reason: string): DurableApprovalRecord | undefined {
    return markDurableApprovalFailed(id, reason, this.options);
  }

  appendMessageRef(id: string, ref: unknown): DurableApprovalRecord | undefined {
    return appendDurableApprovalMessageRef(id, ref, this.options);
  }

  /** Pending approvals, oldest first — used to redeliver cards after a restart. */
  listPending(): DurableApprovalRecord[] {
    return listDurableApprovalsByStatus("pending", this.options);
  }

  /** Approved-but-not-yet-applied approvals, oldest first — the apply work queue. */
  listApproved(): DurableApprovalRecord[] {
    return listDurableApprovalsByStatus("approved", this.options);
  }

  expireDue(nowMs?: number): string[] {
    return expireDueDurableApprovals(this.options, nowMs ?? Date.now());
  }
}
