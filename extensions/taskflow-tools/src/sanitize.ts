import type { JsonValue, TaskFlowRecord, TaskRegistrySummary } from "./types.js";
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
): TaskFlowRecord & {
  taskSummary?: TaskRegistrySummary;
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
    ...(flow.stateJson !== undefined
      ? { stateJson: redactSecrets(flow.stateJson as JsonValue) }
      : {}),
    ...(flow.waitJson !== undefined ? { waitJson: redactSecrets(flow.waitJson as JsonValue) } : {}),
    ...(flow.cancelRequestedAt !== undefined ? { cancelRequestedAt: flow.cancelRequestedAt } : {}),
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    ...(flow.endedAt !== undefined ? { endedAt: flow.endedAt } : {}),
    ...(summary ? { taskSummary: sanitizeSummary(summary) } : {}),
  };
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
