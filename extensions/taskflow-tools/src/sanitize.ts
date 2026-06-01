import type { TaskFlowRecord, TaskRegistrySummary, TaskRunView } from "./types.js";
import { redactSecrets } from "./validation.js";

export function sanitizeSummary(
  summary: TaskRegistrySummary | undefined,
): TaskRegistrySummary | undefined {
  if (!summary) {
    return undefined;
  }
  return {
    total: summary.total,
    active: summary.active,
    terminal: summary.terminal,
    failures: summary.failures,
    ...(summary.byStatus ? { byStatus: summary.byStatus } : {}),
    ...(summary.byRuntime ? { byRuntime: summary.byRuntime } : {}),
  };
}

export function sanitizeFlow(
  flow: TaskFlowRecord,
  summary?: TaskRegistrySummary,
  tasks?: TaskRunView[],
): TaskFlowRecord & {
  taskSummary?: TaskRegistrySummary;
  tasks?: TaskRunView[];
} {
  return {
    flowId: flow.flowId,
    syncMode: flow.syncMode,
    ...(flow.controllerId ? { controllerId: flow.controllerId } : {}),
    revision: flow.revision,
    status: flow.status,
    notifyPolicy: flow.notifyPolicy,
    goal: flow.goal,
    ...(flow.currentStep ? { currentStep: flow.currentStep } : {}),
    ...(flow.blockedSummary ? { blockedSummary: flow.blockedSummary } : {}),
    ...(flow.stateJson !== undefined ? { stateJson: redactSecrets(flow.stateJson) } : {}),
    ...(flow.waitJson !== undefined ? { waitJson: redactSecrets(flow.waitJson) } : {}),
    ...(flow.cancelRequestedAt !== undefined ? { cancelRequestedAt: flow.cancelRequestedAt } : {}),
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    ...(flow.endedAt !== undefined ? { endedAt: flow.endedAt } : {}),
    ...(summary ? { taskSummary: sanitizeSummary(summary) } : {}),
    ...(tasks && tasks.length > 0 ? { tasks: sanitizeTaskViews(tasks) } : {}),
  };
}

export function sanitizeTaskViews(tasks: TaskRunView[]): TaskRunView[] {
  return tasks.map((task) => ({
    id: task.id,
    runtime: task.runtime,
    ...(task.sourceId ? { sourceId: task.sourceId } : {}),
    ...(task.sessionKey ? { sessionKey: task.sessionKey } : {}),
    ...(task.ownerKey ? { ownerKey: task.ownerKey } : {}),
    ...(task.scope ? { scope: task.scope } : {}),
    ...(task.childSessionKey ? { childSessionKey: task.childSessionKey } : {}),
    ...(task.flowId ? { flowId: task.flowId } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.agentId ? { agentId: task.agentId } : {}),
    ...(task.runId ? { runId: task.runId } : {}),
    ...(task.taskName ? { taskName: task.taskName } : {}),
    ...(task.label ? { label: task.label } : {}),
    title: task.title,
    status: task.status,
    ...(task.deliveryStatus ? { deliveryStatus: task.deliveryStatus } : {}),
    ...(task.notifyPolicy ? { notifyPolicy: task.notifyPolicy } : {}),
    ...(task.createdAt !== undefined ? { createdAt: task.createdAt } : {}),
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    ...(task.lastEventAt !== undefined ? { lastEventAt: task.lastEventAt } : {}),
    ...(task.cleanupAfter !== undefined ? { cleanupAfter: task.cleanupAfter } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.progressSummary ? { progressSummary: task.progressSummary } : {}),
    ...(task.terminalSummary ? { terminalSummary: task.terminalSummary } : {}),
    ...(task.terminalOutcome ? { terminalOutcome: task.terminalOutcome } : {}),
  }));
}

export function sanitizeCronJob(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const job = value as Record<string, unknown>;
  const delivery =
    job.delivery && typeof job.delivery === "object" && !Array.isArray(job.delivery)
      ? (job.delivery as Record<string, unknown>)
      : undefined;
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    deleteAfterRun: job.deleteAfterRun,
    enabled: job.enabled,
    createdAtMs: job.createdAtMs,
    updatedAtMs: job.updatedAtMs,
    state: job.state,
    ...(delivery
      ? {
          delivery: {
            mode: delivery.mode,
            channel: delivery.channel,
            to: delivery.to,
            accountId: delivery.accountId,
            threadId: delivery.threadId,
          },
        }
      : {}),
  };
}

export function sanitizeCronListPage(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const page = value as Record<string, unknown>;
  const jobs = Array.isArray(page.jobs) ? page.jobs.map((job) => sanitizeCronJob(job)) : [];
  return {
    jobs,
    total: page.total,
    limit: page.limit,
    offset: page.offset,
    nextOffset: page.nextOffset,
    ...(page.deliveryPreviews ? { deliveryPreviews: page.deliveryPreviews } : {}),
  };
}
