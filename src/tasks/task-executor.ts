import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  DetachedRunningTaskCreateParams,
  DetachedTaskCreateParams,
  DetachedTaskFinalizeParams,
} from "./detached-task-runtime-contract.js";
import { getRegisteredDetachedTaskLifecycleRuntime } from "./detached-task-runtime-state.js";
import {
  cancelTaskById,
  createTaskRecord,
  findLatestTaskForFlowId,
  getTaskById,
  isParentFlowLinkError,
  linkTaskToFlowById,
  listTasksForFlowId,
  markTaskTerminalById,
  markTaskLostById,
  markTaskRunningByRunId,
  finalizeTaskRunByRunId as finalizeTaskRunByRunIdInRegistry,
  recordTaskProgressByRunId,
  setTaskRunDeliveryStatusByRunId,
  updateTaskRunLinkById,
} from "./runtime-internal.js";
import { getTaskFlowByIdForOwner } from "./task-flow-owner-access.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  createTaskFlowForTask,
  deleteTaskFlowRecordById,
  getTaskFlowById,
  requestFlowCancel,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-runtime-internal.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
import type {
  TaskDeliveryState,
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRegistrySummary,
  TaskRuntime,
  TaskStatus,
  TaskTerminalOutcome,
} from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/executor");

function isOneTaskFlowEligible(task: TaskRecord): boolean {
  if (task.parentFlowId?.trim() || task.scopeKind !== "session") {
    return false;
  }
  if (task.deliveryStatus === "not_applicable") {
    return false;
  }
  return task.runtime === "acp" || task.runtime === "subagent";
}

function ensureSingleTaskFlow(params: {
  task: TaskRecord;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
}): TaskRecord {
  if (!isOneTaskFlowEligible(params.task)) {
    return params.task;
  }
  try {
    const flow = createTaskFlowForTask({
      task: params.task,
      requesterOrigin: params.requesterOrigin,
    });
    const linked = linkTaskToFlowById({
      taskId: params.task.taskId,
      flowId: flow.flowId,
    });
    if (!linked) {
      deleteTaskFlowRecordById(flow.flowId);
      return params.task;
    }
    if (linked.parentFlowId !== flow.flowId) {
      deleteTaskFlowRecordById(flow.flowId);
      return linked;
    }
    return linked;
  } catch (error) {
    log.warn("Failed to create one-task flow for detached run", {
      taskId: params.task.taskId,
      runId: params.task.runId,
      error,
    });
    return params.task;
  }
}

type TaskRunCreateParams = DetachedTaskCreateParams;
type RunningTaskRunCreateParams = DetachedRunningTaskCreateParams;

export function createQueuedTaskRun(params: TaskRunCreateParams): TaskRecord {
  const task = createTaskRecord({
    ...params,
    status: "queued",
  });
  return ensureSingleTaskFlow({
    task,
    requesterOrigin: params.requesterOrigin,
  });
}

export function getFlowTaskSummary(flowId: string): TaskRegistrySummary {
  return summarizeTaskRecords(listTasksForFlowId(flowId));
}

export function createRunningTaskRun(params: RunningTaskRunCreateParams): TaskRecord {
  const task = createTaskRecord({
    ...params,
    status: "running",
  });
  return ensureSingleTaskFlow({
    task,
    requesterOrigin: params.requesterOrigin,
  });
}

type RunTaskInFlowParams = {
  flowId: string;
  expectedRevision?: number;
  runtime: TaskRuntime;
  sourceId?: string;
  childSessionKey?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  taskName?: string;
  idempotencyKey?: string;
  idempotencyPayloadHash?: string;
  projectKey?: string;
  controllerId?: string;
  attempt?: number;
  label?: string;
  task: string;
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
  preferMetadata?: boolean;
  status?: "queued" | "running";
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
};

export function startTaskRunByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
}) {
  return markTaskRunningByRunId(params);
}

export function recordTaskRunProgressByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
}) {
  return recordTaskProgressByRunId(params);
}

export function completeTaskRunByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  endedAt: number;
  lastEventAt?: number;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  terminalOutcome?: TaskTerminalOutcome | null;
}) {
  return finalizeTaskRunByRunId({
    ...params,
    status: "succeeded",
  });
}

export function finalizeTaskRunByRunId(params: DetachedTaskFinalizeParams) {
  return finalizeTaskRunByRunIdInRegistry(params);
}

export function failTaskRunByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  status?: Extract<TaskStatus, "failed" | "timed_out" | "cancelled">;
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  progressSummary?: string | null;
  terminalSummary?: string | null;
}) {
  return finalizeTaskRunByRunId({
    ...params,
    status: params.status ?? "failed",
  });
}

export function markTaskRunLostById(params: {
  taskId: string;
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  cleanupAfter?: number;
}) {
  return markTaskLostById(params);
}

export function setDetachedTaskDeliveryStatusByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  deliveryStatus: TaskDeliveryStatus;
  error?: string;
}) {
  return setTaskRunDeliveryStatusByRunId(params);
}

type RetryBlockedFlowResult = {
  found: boolean;
  retried: boolean;
  reason?: string;
  previousTask?: TaskRecord;
  task?: TaskRecord;
};

type RetryBlockedFlowParams = {
  flowId: string;
  sourceId?: string;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  childSessionKey?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task?: string;
  preferMetadata?: boolean;
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
  status: "queued" | "running";
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
};

function resolveRetryableBlockedFlowTask(flowId: string): {
  flowFound: boolean;
  retryable: boolean;
  latestTask?: TaskRecord;
  reason?: string;
} {
  const flow = getTaskFlowById(flowId);
  if (!flow) {
    return {
      flowFound: false,
      retryable: false,
      reason: "Flow not found.",
    };
  }
  const latestTask = findLatestTaskForFlowId(flowId);
  if (!latestTask) {
    return {
      flowFound: true,
      retryable: false,
      reason: "Flow has no retryable task.",
    };
  }
  if (flow.status !== "blocked") {
    return {
      flowFound: true,
      retryable: false,
      latestTask,
      reason: "Flow is not blocked.",
    };
  }
  if (latestTask.status !== "succeeded" || latestTask.terminalOutcome !== "blocked") {
    return {
      flowFound: true,
      retryable: false,
      latestTask,
      reason: "Latest TaskFlow task is not blocked.",
    };
  }
  return {
    flowFound: true,
    retryable: true,
    latestTask,
  };
}

function retryBlockedFlowTask(params: RetryBlockedFlowParams): RetryBlockedFlowResult {
  const resolved = resolveRetryableBlockedFlowTask(params.flowId);
  if (!resolved.retryable || !resolved.latestTask) {
    return {
      found: resolved.flowFound,
      retried: false,
      reason: resolved.reason,
    };
  }
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return {
      found: false,
      retried: false,
      reason: "Flow not found.",
      previousTask: resolved.latestTask,
    };
  }
  const task = createTaskRecord({
    runtime: resolved.latestTask.runtime,
    sourceId: params.sourceId ?? resolved.latestTask.sourceId,
    ownerKey: flow.ownerKey,
    scopeKind: "session",
    requesterOrigin: params.requesterOrigin ?? flow.requesterOrigin,
    parentFlowId: flow.flowId,
    childSessionKey: params.childSessionKey,
    parentTaskId: resolved.latestTask.taskId,
    agentId: params.agentId ?? resolved.latestTask.agentId,
    runId: params.runId,
    label: params.label ?? resolved.latestTask.label,
    task: params.task ?? resolved.latestTask.task,
    preferMetadata: params.preferMetadata,
    notifyPolicy: params.notifyPolicy ?? resolved.latestTask.notifyPolicy,
    deliveryStatus: params.deliveryStatus ?? "pending",
    status: params.status,
    startedAt: params.startedAt,
    lastEventAt: params.lastEventAt,
    progressSummary: params.progressSummary,
  });
  return {
    found: true,
    retried: true,
    previousTask: resolved.latestTask,
    task,
  };
}

export function retryBlockedFlowAsQueuedTaskRun(
  params: Omit<RetryBlockedFlowParams, "status" | "startedAt" | "lastEventAt" | "progressSummary">,
): RetryBlockedFlowResult {
  return retryBlockedFlowTask({
    ...params,
    status: "queued",
  });
}

export function retryBlockedFlowAsRunningTaskRun(
  params: Omit<RetryBlockedFlowParams, "status">,
): RetryBlockedFlowResult {
  return retryBlockedFlowTask({
    ...params,
    status: "running",
  });
}

type CancelFlowResult = {
  found: boolean;
  cancelled: boolean;
  reason?: string;
  flow?: TaskFlowRecord;
  tasks?: TaskRecord[];
};

type RunTaskInFlowResult = {
  found: boolean;
  created: boolean;
  reason?: string;
  flow?: TaskFlowRecord;
  task?: TaskRecord;
};

export type LinkedTaskReservationResult = {
  found: boolean;
  reserved: boolean;
  created: boolean;
  conflict?: boolean;
  reason?: string;
  flow?: TaskFlowRecord;
  task?: TaskRecord;
};

export type LinkedTaskFinalizeResult = {
  found: boolean;
  finalized: boolean;
  reason?: string;
  task?: TaskRecord;
};

function isActiveTaskStatus(status: TaskStatus): boolean {
  return status === "queued" || status === "running";
}

function isTerminalFlowStatus(status: TaskFlowRecord["status"]): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost"
  );
}

function markFlowCancelRequested(flow: TaskFlowRecord): TaskFlowRecord | FlowUpdateFailure {
  if (flow.cancelRequestedAt != null) {
    return flow;
  }
  const result = requestFlowCancel({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
  });
  if (result.applied) {
    return result.flow;
  }
  return {
    reason:
      result.reason === "revision_conflict"
        ? "Flow changed while cancellation was in progress."
        : "Flow not found.",
    flow: result.current ?? getTaskFlowById(flow.flowId),
  };
}

type FlowUpdateFailure = {
  reason: string;
  flow?: TaskFlowRecord;
};

function cancelManagedFlowAfterChildrenSettle(
  flow: TaskFlowRecord,
  endedAt: number,
): TaskFlowRecord | FlowUpdateFailure {
  const result = updateFlowRecordByIdExpectedRevision({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
    patch: {
      status: "cancelled",
      blockedTaskId: null,
      blockedSummary: null,
      waitJson: null,
      endedAt,
      updatedAt: endedAt,
    },
  });
  if (result.applied) {
    return result.flow;
  }
  return {
    reason:
      result.reason === "revision_conflict"
        ? "Flow changed while cancellation was in progress."
        : "Flow not found.",
    flow: result.current ?? getTaskFlowById(flow.flowId),
  };
}

function mapRunTaskInFlowCreateError(params: {
  error: unknown;
  flowId: string;
}): RunTaskInFlowResult {
  const flow = getTaskFlowById(params.flowId);
  if (isParentFlowLinkError(params.error)) {
    if (params.error.code === "cancel_requested") {
      return {
        found: true,
        created: false,
        reason: "Flow cancellation has already been requested.",
        ...(flow ? { flow } : {}),
      };
    }
    if (params.error.code === "terminal") {
      const terminalStatus = flow?.status ?? params.error.details?.status ?? "terminal";
      return {
        found: true,
        created: false,
        reason: `Flow is already ${terminalStatus}.`,
        ...(flow ? { flow } : {}),
      };
    }
    if (params.error.code === "parent_flow_not_found") {
      return {
        found: false,
        created: false,
        reason: "Flow not found.",
      };
    }
  }
  throw params.error;
}

function normalizeLinkedTaskKey(value: string | undefined): string {
  return value?.trim() ?? "";
}

function findLinkedTaskInFlowByIdempotency(params: {
  flowId: string;
  ownerKey: string;
  idempotencyKey: string;
}): TaskRecord | undefined {
  const idempotencyKey = normalizeLinkedTaskKey(params.idempotencyKey);
  if (!idempotencyKey) {
    return undefined;
  }
  return listTasksForFlowId(params.flowId).find(
    (task) =>
      task.ownerKey.trim() === params.ownerKey.trim() &&
      normalizeLinkedTaskKey(task.idempotencyKey) === idempotencyKey,
  );
}

export function createLinkedTaskSpawnIdempotencyKey(params: {
  ownerKey: string;
  flowId: string;
  idempotencyKey: string;
}): string {
  const hash = crypto
    .createHash("sha256")
    .update(params.ownerKey.trim())
    .update("\0")
    .update(params.flowId.trim())
    .update("\0")
    .update(params.idempotencyKey.trim())
    .digest("hex");
  return `linked-spawn:${hash}`;
}

export function findLinkedTaskByIdempotencyForOwner(params: {
  flowId: string;
  callerOwnerKey: string;
  idempotencyKey: string;
  idempotencyPayloadHash?: string;
  projectKey?: string;
  controllerId?: string;
}): LinkedTaskReservationResult {
  const flow = getTaskFlowByIdForOwner({
    flowId: params.flowId,
    callerOwnerKey: params.callerOwnerKey,
  });
  if (!flow) {
    const hiddenFlow = getTaskFlowById(params.flowId);
    return {
      found: false,
      reserved: false,
      created: false,
      reason: hiddenFlow ? "Flow not found for this caller owner scope." : "Flow not found.",
    };
  }
  const idempotencyKey = normalizeLinkedTaskKey(params.idempotencyKey);
  if (!idempotencyKey) {
    return {
      found: true,
      reserved: false,
      created: false,
      flow,
      reason: "Linked task idempotencyKey is required.",
    };
  }
  const existing = findLinkedTaskInFlowByIdempotency({
    flowId: flow.flowId,
    ownerKey: flow.ownerKey,
    idempotencyKey,
  });
  if (!existing) {
    return {
      found: true,
      reserved: false,
      created: false,
      flow,
    };
  }
  const projectKey = normalizeLinkedTaskKey(params.projectKey);
  const existingProjectKey = normalizeLinkedTaskKey(existing.projectKey);
  if (projectKey && existingProjectKey && projectKey !== existingProjectKey) {
    return {
      found: true,
      reserved: false,
      created: false,
      conflict: true,
      flow,
      task: existing,
      reason: `Linked task projectKey mismatch: this flowLink.idempotencyKey is already bound to projectKey "${existingProjectKey}". Use the original projectKey or choose a new flowLink.idempotencyKey for different work.`,
    };
  }
  const controllerId = normalizeLinkedTaskKey(params.controllerId);
  const existingControllerId = normalizeLinkedTaskKey(existing.controllerId);
  if (controllerId && existingControllerId && controllerId !== existingControllerId) {
    return {
      found: true,
      reserved: false,
      created: false,
      conflict: true,
      flow,
      task: existing,
      reason: `Linked task controllerId mismatch: this flowLink.idempotencyKey is already bound to controllerId "${existingControllerId}". Use the original controllerId or choose a new flowLink.idempotencyKey for different work.`,
    };
  }
  const payloadHash = normalizeLinkedTaskKey(params.idempotencyPayloadHash);
  const existingPayloadHash = normalizeLinkedTaskKey(existing.idempotencyPayloadHash);
  if (payloadHash && existingPayloadHash && payloadHash !== existingPayloadHash) {
    return {
      found: true,
      reserved: false,
      created: false,
      conflict: true,
      flow,
      task: existing,
      reason:
        "Linked task idempotency payload conflict: this flowLink.idempotencyKey is already bound to a different sessions_spawn payload. Reuse the exact same task and spawn parameters to retry the existing child, including taskName, projectKey, controllerId, cwd/model/runtime, and task text; or choose a new flowLink.idempotencyKey for different work.",
    };
  }
  return {
    found: true,
    reserved: true,
    created: false,
    flow,
    task: existing,
  };
}

export function reserveLinkedTaskInFlowForOwner(
  params: RunTaskInFlowParams & {
    callerOwnerKey: string;
    idempotencyKey: string;
    idempotencyPayloadHash: string;
    taskName?: string;
    projectKey?: string;
    controllerId?: string;
    attempt?: number;
  },
): LinkedTaskReservationResult {
  const existing = findLinkedTaskByIdempotencyForOwner({
    flowId: params.flowId,
    callerOwnerKey: params.callerOwnerKey,
    idempotencyKey: params.idempotencyKey,
    idempotencyPayloadHash: params.idempotencyPayloadHash,
    projectKey: params.projectKey,
    controllerId: params.controllerId,
  });
  if (!existing.found || existing.reserved || existing.conflict) {
    return existing;
  }
  if (!existing.flow) {
    return {
      found: false,
      reserved: false,
      created: false,
      reason: existing.reason ?? "Flow not found.",
    };
  }
  const created = runTaskInFlowForOwner({
    ...params,
    flowId: existing.flow.flowId,
    callerOwnerKey: params.callerOwnerKey,
    taskName: params.taskName,
    idempotencyKey: params.idempotencyKey,
    idempotencyPayloadHash: params.idempotencyPayloadHash,
    projectKey: params.projectKey,
    controllerId: params.controllerId,
    attempt: params.attempt,
    status: params.status ?? "queued",
  });
  return {
    found: created.found,
    reserved: created.created,
    created: created.created,
    reason: created.reason,
    flow: created.flow,
    task: created.task,
  };
}

export function finalizeLinkedTaskSpawn(params: {
  taskId: string;
  sourceId?: string;
  childSessionKey?: string;
  runId: string;
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
  deliveryStatus?: TaskDeliveryStatus;
}): LinkedTaskFinalizeResult {
  const task = getTaskById(params.taskId);
  if (!task) {
    return {
      found: false,
      finalized: false,
      reason: "Task not found.",
    };
  }
  if (task.status !== "queued" && task.status !== "running") {
    return {
      found: true,
      finalized: false,
      reason: "Task is already terminal.",
      task,
    };
  }
  const updated = updateTaskRunLinkById({
    taskId: task.taskId,
    sourceId: params.sourceId,
    childSessionKey: params.childSessionKey,
    runId: params.runId,
    status: "running",
    startedAt: params.startedAt ?? task.startedAt ?? Date.now(),
    lastEventAt: params.lastEventAt ?? Date.now(),
    progressSummary: params.progressSummary,
    deliveryStatus: params.deliveryStatus,
  });
  return {
    found: true,
    finalized: Boolean(updated),
    task: updated ?? task,
    ...(updated ? {} : { reason: "Task not found." }),
  };
}

export function failLinkedTaskSpawn(params: {
  taskId: string;
  endedAt?: number;
  error?: string;
  terminalSummary?: string | null;
}): LinkedTaskFinalizeResult {
  const task = getTaskById(params.taskId);
  if (!task) {
    return {
      found: false,
      finalized: false,
      reason: "Task not found.",
    };
  }
  if (task.status !== "queued" && task.status !== "running") {
    return {
      found: true,
      finalized: false,
      reason: "Task is already terminal.",
      task,
    };
  }
  const endedAt = params.endedAt ?? Date.now();
  const updated = markTaskTerminalById({
    taskId: task.taskId,
    status: "failed",
    endedAt,
    lastEventAt: endedAt,
    error: params.error,
    terminalSummary: params.terminalSummary,
  });
  return {
    found: true,
    finalized: Boolean(updated),
    task: updated ?? task,
    ...(updated ? {} : { reason: "Task not found." }),
  };
}

export function runTaskInFlow(params: RunTaskInFlowParams): RunTaskInFlowResult {
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return {
      found: false,
      created: false,
      reason: "Flow not found.",
    };
  }
  if (flow.syncMode !== "managed") {
    return {
      found: true,
      created: false,
      reason: "Flow does not accept managed child tasks.",
      flow,
    };
  }
  if (flow.cancelRequestedAt != null) {
    return {
      found: true,
      created: false,
      reason: "Flow cancellation has already been requested.",
      flow,
    };
  }
  if (isTerminalFlowStatus(flow.status)) {
    return {
      found: true,
      created: false,
      reason: `Flow is already ${flow.status}.`,
      flow,
    };
  }
  if (typeof params.expectedRevision === "number" && flow.revision !== params.expectedRevision) {
    return {
      found: true,
      created: false,
      reason: "Flow revision conflict.",
      flow,
    };
  }

  const common = {
    runtime: params.runtime,
    sourceId: params.sourceId,
    ownerKey: flow.ownerKey,
    scopeKind: "session" as const,
    requesterOrigin: flow.requesterOrigin,
    parentFlowId: flow.flowId,
    childSessionKey: params.childSessionKey,
    parentTaskId: params.parentTaskId,
    agentId: params.agentId,
    runId: params.runId,
    taskName: params.taskName,
    idempotencyKey: params.idempotencyKey,
    idempotencyPayloadHash: params.idempotencyPayloadHash,
    projectKey: params.projectKey,
    controllerId: params.controllerId,
    attempt: params.attempt,
    label: params.label,
    task: params.task,
    preferMetadata: params.preferMetadata,
    notifyPolicy: params.notifyPolicy,
    deliveryStatus: params.deliveryStatus ?? "pending",
  };
  let task: TaskRecord;
  try {
    task =
      params.status === "running"
        ? createRunningTaskRun({
            ...common,
            startedAt: params.startedAt,
            lastEventAt: params.lastEventAt,
            progressSummary: params.progressSummary,
          })
        : createQueuedTaskRun(common);
  } catch (error) {
    return mapRunTaskInFlowCreateError({
      error,
      flowId: flow.flowId,
    });
  }

  return {
    found: true,
    created: true,
    flow: getTaskFlowById(flow.flowId) ?? flow,
    task,
  };
}

export function runTaskInFlowForOwner(
  params: RunTaskInFlowParams & { callerOwnerKey: string },
): RunTaskInFlowResult {
  const flow = getTaskFlowByIdForOwner({
    flowId: params.flowId,
    callerOwnerKey: params.callerOwnerKey,
  });
  if (!flow) {
    return {
      found: false,
      created: false,
      reason: "Flow not found.",
    };
  }
  return runTaskInFlow({
    flowId: flow.flowId,
    expectedRevision: params.expectedRevision,
    runtime: params.runtime,
    sourceId: params.sourceId,
    childSessionKey: params.childSessionKey,
    parentTaskId: params.parentTaskId,
    agentId: params.agentId,
    runId: params.runId,
    taskName: params.taskName,
    idempotencyKey: params.idempotencyKey,
    idempotencyPayloadHash: params.idempotencyPayloadHash,
    projectKey: params.projectKey,
    controllerId: params.controllerId,
    attempt: params.attempt,
    label: params.label,
    task: params.task,
    preferMetadata: params.preferMetadata,
    notifyPolicy: params.notifyPolicy,
    deliveryStatus: params.deliveryStatus,
    status: params.status,
    startedAt: params.startedAt,
    lastEventAt: params.lastEventAt,
    progressSummary: params.progressSummary,
  });
}

export async function cancelFlowById(params: {
  cfg: OpenClawConfig;
  flowId: string;
}): Promise<CancelFlowResult> {
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return {
      found: false,
      cancelled: false,
      reason: "Flow not found.",
    };
  }
  if (isTerminalFlowStatus(flow.status)) {
    return {
      found: true,
      cancelled: false,
      reason: `Flow is already ${flow.status}.`,
      flow,
      tasks: listTasksForFlowId(flow.flowId),
    };
  }
  const cancelRequestedFlow = markFlowCancelRequested(flow);
  if ("reason" in cancelRequestedFlow) {
    return {
      found: true,
      cancelled: false,
      reason: cancelRequestedFlow.reason,
      flow: cancelRequestedFlow.flow,
      tasks: listTasksForFlowId(flow.flowId),
    };
  }
  const linkedTasks = listTasksForFlowId(flow.flowId);
  const activeTasks = linkedTasks.filter((task) => isActiveTaskStatus(task.status));
  for (const task of activeTasks) {
    await cancelDetachedTaskRunById({
      cfg: params.cfg,
      taskId: task.taskId,
    });
  }
  const refreshedTasks = listTasksForFlowId(flow.flowId);
  const remainingActive = refreshedTasks.filter((task) => isActiveTaskStatus(task.status));
  if (remainingActive.length > 0) {
    return {
      found: true,
      cancelled: false,
      reason: "One or more child tasks are still active.",
      flow: getTaskFlowById(flow.flowId) ?? cancelRequestedFlow,
      tasks: refreshedTasks,
    };
  }
  const now = Date.now();
  const refreshedFlow = getTaskFlowById(flow.flowId) ?? cancelRequestedFlow;
  if (isTerminalFlowStatus(refreshedFlow.status)) {
    return {
      found: true,
      cancelled: refreshedFlow.status === "cancelled",
      reason:
        refreshedFlow.status === "cancelled"
          ? undefined
          : `Flow is already ${refreshedFlow.status}.`,
      flow: refreshedFlow,
      tasks: refreshedTasks,
    };
  }
  const updatedFlow = cancelManagedFlowAfterChildrenSettle(refreshedFlow, now);
  if ("reason" in updatedFlow) {
    return {
      found: true,
      cancelled: false,
      reason: updatedFlow.reason,
      flow: updatedFlow.flow,
      tasks: refreshedTasks,
    };
  }
  return {
    found: true,
    cancelled: true,
    flow: updatedFlow,
    tasks: refreshedTasks,
  };
}

export async function cancelFlowByIdForOwner(params: {
  cfg: OpenClawConfig;
  flowId: string;
  callerOwnerKey: string;
}): Promise<CancelFlowResult> {
  const flow = getTaskFlowByIdForOwner({
    flowId: params.flowId,
    callerOwnerKey: params.callerOwnerKey,
  });
  if (!flow) {
    return {
      found: false,
      cancelled: false,
      reason: "Flow not found.",
    };
  }
  return cancelFlowById({
    cfg: params.cfg,
    flowId: flow.flowId,
  });
}

export async function cancelDetachedTaskRunById(params: { cfg: OpenClawConfig; taskId: string }) {
  const task = getTaskById(params.taskId);
  if (!task) {
    return cancelTaskById(params);
  }
  const registeredRuntime = getRegisteredDetachedTaskLifecycleRuntime();
  if (registeredRuntime) {
    const cancelled = await registeredRuntime.cancelDetachedTaskRunById(params);
    if (cancelled.found) {
      return cancelled;
    }
  }
  return cancelTaskById(params);
}
