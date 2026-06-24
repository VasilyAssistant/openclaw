// Applies the side effect of an approved durable approval (slice 5).
//
// The durable `status` column IS the work queue: an `approved` row is a unit of
// pending apply-work. This is the reconciler/relay over that state, not a second
// outbox table. It runs right after a decision is recorded (low latency) and on a
// periodic sweep (catches restart and retry). Kind-keyed executors own the actual
// side effect; core only drives state. `markApplied` is a CAS on `approved`, so at
// most one pass finalizes a record even if two appliers overlap — combined with
// idempotent executors this gives at-least-once apply without double effect.

import type { DurableApprovalRecord } from "../state/durable-approvals-store.js";
import type { DurableApprovalService } from "./durable-approval-service.js";

/**
 * Performs the side effect for an approved durable approval of one `kind`.
 *
 * MUST be idempotent. The applier guarantees at-least-once invocation — a crash
 * between the side effect and `markApplied`, or a concurrent sweep, can re-run it —
 * so the executor must dedupe by `record.actionHash` or a deterministic downstream
 * id (e.g. a stable scheduled-task id). Returns an opaque result ref stored on the
 * approval for audit (e.g. the created flow id).
 */
export type DurableApprovalExecutor = (
  record: DurableApprovalRecord,
) => Promise<{ resultRef?: string }>;

export type DurableApprovalApplyOutcome = {
  applied: string[];
  failed: string[];
  /** Kind has no registered executor yet — left `approved` for a later sweep. */
  skipped: string[];
};

type ApplyLog = {
  error?: (message: string) => void;
  debug?: (message: string) => void;
};

export class DurableApprovalApplier {
  constructor(
    private readonly service: DurableApprovalService,
    private readonly executors: ReadonlyMap<string, DurableApprovalExecutor>,
    private readonly log?: ApplyLog,
  ) {}

  /** Apply every approved-but-unapplied record. The periodic reconciler entry point. */
  async applyApproved(): Promise<DurableApprovalApplyOutcome> {
    const outcome: DurableApprovalApplyOutcome = { applied: [], failed: [], skipped: [] };
    for (const record of this.service.listApproved()) {
      await this.applyRecord(record, outcome);
    }
    return outcome;
  }

  /** Apply a single record by id — the post-approve fast path. No-op unless `approved`. */
  async applyById(id: string): Promise<DurableApprovalApplyOutcome> {
    const outcome: DurableApprovalApplyOutcome = { applied: [], failed: [], skipped: [] };
    const record = this.service.get(id);
    if (record?.status === "approved") {
      await this.applyRecord(record, outcome);
    }
    return outcome;
  }

  private async applyRecord(
    record: DurableApprovalRecord,
    outcome: DurableApprovalApplyOutcome,
  ): Promise<void> {
    const executor = this.executors.get(record.kind);
    if (!executor) {
      // Unknown kind — most likely the owning plugin's executor is not registered
      // yet (startup ordering). Leave the row `approved` so a later sweep applies it
      // once registered, instead of failing it terminally on a transient gap.
      this.log?.debug?.(`durable approvals: no executor for kind ${record.kind} (${record.id})`);
      outcome.skipped.push(record.id);
      return;
    }
    try {
      const { resultRef } = await executor(record);
      this.service.markApplied(record.id, resultRef);
      outcome.applied.push(record.id);
    } catch (err) {
      // Apply errors are terminal for now (`failed`); retry classification is a
      // follow-up. The decision itself is already durably recorded — only the side
      // effect failed, and the owner can re-request.
      this.service.markFailed(record.id, String(err));
      this.log?.error?.(`durable approvals: apply failed ${record.id}: ${String(err)}`);
      outcome.failed.push(record.id);
    }
  }
}
