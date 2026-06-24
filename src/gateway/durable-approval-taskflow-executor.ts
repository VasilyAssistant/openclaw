// Durable-approval executor for an approved taskflow schedule-create.
//
// Variant A (owner-confirmed): the side effect lives in core because the cron `add`
// API is core-owned; the taskflow plugin only assembled the immutable `action` snapshot
// at request time. The applier guarantees at-least-once invocation, so the executor
// derives a per-approval deterministic id and relies on the cron id-dedupe to stay
// idempotent across a retry/crash-replay.

import { createHash } from "node:crypto";
import type { CronServiceContract } from "../cron/service-contract.js";
import type { CronJobCreate } from "../cron/types.js";
import {
  getTaskFlowById,
  isTerminalTaskFlowStatus,
  requestFlowCancel,
} from "../tasks/task-flow-registry.js";
import type { DurableApprovalExecutor } from "./durable-approval-apply.js";

/** Kind of a durable approval whose side effect is creating a scheduled (cron) task. */
export const TASKFLOW_SCHEDULE_CREATE_KIND = "taskflow.schedule.create";
/** Kind of a durable approval whose side effect is cancelling a managed TaskFlow. */
export const TASKFLOW_MANAGED_CANCEL_KIND = "taskflow.managed.cancel";
/** Kind of a durable approval whose side effect is cancelling a scheduled (cron) task. */
export const TASKFLOW_SCHEDULE_CANCEL_KIND = "taskflow.schedule.cancel";

function requireString(value: unknown, kind: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`taskflow ${kind} approval: missing or invalid ${field}`);
  }
  return value;
}

// Per-approval deterministic apply id: a retried/replayed apply of the SAME approved
// approval dedupes to one downstream object. Derived from the approval id (not the action),
// so two distinct approvals of an identical action still create distinct objects.
function deriveDurableApplyId(approvalId: string): string {
  return `durable-${createHash("sha256").update(approvalId).digest("hex").slice(0, 32)}`;
}

/**
 * Builds the schedule-create executor. The cron service is a lazily-created gateway
 * singleton rather than a module export, so the executor closes over the gateway's
 * `cron.add` (injected at wiring time). The plugin persisted a CronJobCreate-shaped job
 * snapshot in the action; we set a deterministic id (so a retry dedupes via the cron
 * id-dedupe) and add it.
 */
export function createTaskflowScheduleCreateExecutor(
  cronAdd: CronServiceContract["add"],
): DurableApprovalExecutor {
  return async (record) => {
    const action = (record.action ?? {}) as Record<string, unknown>;
    requireString(action.name, "schedule-create", "name");
    if (action.schedule === null || typeof action.schedule !== "object") {
      throw new Error("taskflow schedule-create approval: missing or invalid schedule");
    }
    const job = await cronAdd({
      ...(action as unknown as CronJobCreate),
      id: deriveDurableApplyId(record.id),
    });
    return { resultRef: `cron:${job.id}` };
  };
}

/**
 * Cancels a managed TaskFlow on approval. Revisionless: the captured request-time
 * revision would be stale by approval time, so this reads the flow's current revision
 * and requests cancellation against it — cancelling whatever state the flow is in now.
 * Idempotent: an already-gone, terminal, or already-cancelling flow is a no-op; a
 * revision conflict (the flow advanced between read and cancel) re-reads once and retries.
 */
export const taskflowManagedCancelExecutor: DurableApprovalExecutor = async (record) => {
  const action = (record.action ?? {}) as Record<string, unknown>;
  const flowId = requireString(action.flowId, "managed-cancel", "flowId");
  const resultRef = `taskflow:flow:${flowId}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const flow = getTaskFlowById(flowId);
    if (!flow || flow.cancelRequestedAt != null || isTerminalTaskFlowStatus(flow.status)) {
      return { resultRef };
    }
    const result = requestFlowCancel({ flowId, expectedRevision: flow.revision });
    if (result.applied || result.reason === "not_found") {
      return { resultRef };
    }
    if (result.reason !== "revision_conflict") {
      throw new Error(`taskflow managed-cancel failed for ${flowId}: ${result.reason}`);
    }
    // revision_conflict — the loop re-reads the fresh revision and retries once.
  }
  throw new Error(`taskflow managed-cancel could not settle revision for ${flowId}`);
};

/**
 * Builds the schedule-cancel executor. Like schedule-create it closes over the gateway
 * cron service. Idempotent: cron `remove` returns `removed: false` when the job is already
 * gone, so a retried/replayed apply is harmless.
 */
export function createTaskflowScheduleCancelExecutor(
  cronRemove: CronServiceContract["remove"],
): DurableApprovalExecutor {
  return async (record) => {
    const action = (record.action ?? {}) as Record<string, unknown>;
    const scheduleId = requireString(action.scheduleId, "schedule-cancel", "scheduleId");
    await cronRemove(scheduleId);
    return { resultRef: `cron:${scheduleId}` };
  };
}
