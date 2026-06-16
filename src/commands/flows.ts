/** CLI commands for listing, inspecting, and cancelling TaskFlow records. */
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { formatCliCommand } from "../cli/command-format.js";
import { getRuntimeConfig } from "../config/config.js";
import { info } from "../globals.js";
import { createRuntimeTaskFlow } from "../plugins/runtime/runtime-taskflow.js";
import type {
  BoundTaskFlowRuntime,
  ManagedTaskFlowMutationResult,
} from "../plugins/runtime/runtime-taskflow.types.js";
import type { RuntimeEnv } from "../runtime.js";
import { writeRuntimeJson } from "../runtime.js";
import { listTasksForFlowId } from "../tasks/runtime-internal.js";
import {
  cancelFlowById,
  completeTaskRunByRunId,
  failTaskRunByRunId,
  getFlowTaskSummary,
  reserveLinkedTaskInFlowForOwner,
} from "../tasks/task-executor.js";
import type {
  JsonValue,
  TaskFlowRecord,
  TaskFlowStatus,
} from "../tasks/task-flow-registry.types.js";
import {
  getTaskFlowById,
  listTaskFlowRecords,
  resolveTaskFlowForLookupToken,
} from "../tasks/task-flow-runtime-internal.js";
import type {
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskRuntime,
} from "../tasks/task-registry.types.js";

const ID_PAD = 10;
const STATUS_PAD = 10;
const MODE_PAD = 14;
const REV_PAD = 6;
const CTRL_PAD = 20;

function formatFlowLookupMiss(lookup: string): string {
  return `TaskFlow not found: ${lookup}. Run ${formatCliCommand("openclaw tasks flow list")} to see recent flow ids.`;
}

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 1) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 1)}…`;
}

function safeFlowDisplayText(value: string | undefined, maxChars?: number): string {
  const sanitized = sanitizeTerminalText(value ?? "").trim();
  if (!sanitized) {
    return "n/a";
  }
  return typeof maxChars === "number" ? truncate(sanitized, maxChars) : sanitized;
}

function shortToken(value: string | undefined, maxChars = ID_PAD): string {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return "n/a";
  }
  return truncate(trimmed, maxChars);
}

function formatFlowTimestamp(value: number | undefined | null): string {
  return timestampMsToIsoString(value) ?? "n/a";
}

function formatFlowStatusCell(status: TaskFlowStatus, rich: boolean) {
  const padded = status.padEnd(STATUS_PAD);
  if (!rich) {
    return padded;
  }
  if (status === "succeeded") {
    return theme.success(padded);
  }
  if (status === "failed" || status === "lost") {
    return theme.error(padded);
  }
  if (status === "running") {
    return theme.accentBright(padded);
  }
  if (status === "blocked") {
    return theme.warn(padded);
  }
  return theme.muted(padded);
}

function formatFlowRows(flows: TaskFlowRecord[], rich: boolean) {
  const header = [
    "TaskFlow".padEnd(ID_PAD),
    "Mode".padEnd(MODE_PAD),
    "Status".padEnd(STATUS_PAD),
    "Rev".padEnd(REV_PAD),
    "Controller".padEnd(CTRL_PAD),
    "Tasks".padEnd(14),
    "Goal",
  ].join(" ");
  const lines = [rich ? theme.heading(header) : header];
  for (const flow of flows) {
    const taskSummary = getFlowTaskSummary(flow.flowId);
    const counts = `${taskSummary.active} active/${taskSummary.total} total`;
    lines.push(
      [
        shortToken(flow.flowId).padEnd(ID_PAD),
        flow.syncMode.padEnd(MODE_PAD),
        formatFlowStatusCell(flow.status, rich),
        String(flow.revision).padEnd(REV_PAD),
        safeFlowDisplayText(flow.controllerId, CTRL_PAD).padEnd(CTRL_PAD),
        counts.padEnd(14),
        safeFlowDisplayText(flow.goal, 80),
      ].join(" "),
    );
  }
  return lines;
}

function formatFlowListSummary(flows: TaskFlowRecord[]) {
  const active = flows.filter(
    (flow) => flow.status === "queued" || flow.status === "running",
  ).length;
  const blocked = flows.filter((flow) => flow.status === "blocked").length;
  const cancelRequested = flows.filter((flow) => flow.cancelRequestedAt != null).length;
  return `${active} active · ${blocked} blocked · ${cancelRequested} cancel-requested · ${flows.length} total`;
}

function summarizeWait(flow: TaskFlowRecord): string {
  if (flow.waitJson == null) {
    return "n/a";
  }
  if (
    typeof flow.waitJson === "string" ||
    typeof flow.waitJson === "number" ||
    typeof flow.waitJson === "boolean"
  ) {
    return String(flow.waitJson);
  }
  if (Array.isArray(flow.waitJson)) {
    return `array(${flow.waitJson.length})`;
  }
  return Object.keys(flow.waitJson).toSorted().join(", ") || "object";
}

function summarizeFlowState(flow: TaskFlowRecord): string | null {
  if (flow.status === "blocked") {
    if (flow.blockedSummary) {
      return flow.blockedSummary;
    }
    if (flow.blockedTaskId) {
      return `blocked by ${flow.blockedTaskId}`;
    }
    return "blocked";
  }
  if (flow.status === "waiting" && flow.waitJson != null) {
    return summarizeWait(flow);
  }
  return null;
}

/** Lists TaskFlows with optional status filtering and JSON output. */
export async function flowsListCommand(
  opts: { json?: boolean; status?: string },
  runtime: RuntimeEnv,
) {
  const statusFilter = opts.status?.trim();
  const flows = listTaskFlowRecords().filter((flow) => {
    if (statusFilter && flow.status !== statusFilter) {
      return false;
    }
    return true;
  });

  if (opts.json) {
    writeRuntimeJson(runtime, {
      count: flows.length,
      status: statusFilter ?? null,
      flows: flows.map((flow) => ({
        ...flow,
        tasks: listTasksForFlowId(flow.flowId),
        taskSummary: getFlowTaskSummary(flow.flowId),
      })),
    });
    return;
  }

  runtime.log(info(`TaskFlows: ${flows.length}`));
  runtime.log(info(`TaskFlow pressure: ${formatFlowListSummary(flows)}`));
  if (statusFilter) {
    runtime.log(info(`Status filter: ${statusFilter}`));
  }
  if (flows.length === 0) {
    runtime.log(
      `No TaskFlows found. Run ${formatCliCommand("openclaw tasks list")} to inspect standalone background tasks.`,
    );
    return;
  }
  const rich = isRich();
  for (const line of formatFlowRows(flows, rich)) {
    runtime.log(line);
  }
}

/** Shows one TaskFlow and its linked task summary. */
export async function flowsShowCommand(
  opts: { json?: boolean; lookup: string },
  runtime: RuntimeEnv,
) {
  const flow = resolveTaskFlowForLookupToken(opts.lookup);
  if (!flow) {
    runtime.error(formatFlowLookupMiss(opts.lookup));
    runtime.exit(1);
    return;
  }
  const tasks = listTasksForFlowId(flow.flowId);
  const taskSummary = getFlowTaskSummary(flow.flowId);
  const stateSummary = summarizeFlowState(flow);

  if (opts.json) {
    writeRuntimeJson(runtime, {
      ...flow,
      tasks,
      taskSummary,
    });
    return;
  }

  const lines = [
    "TaskFlow:",
    `flowId: ${flow.flowId}`,
    `status: ${flow.status}`,
    `goal: ${safeFlowDisplayText(flow.goal)}`,
    `currentStep: ${safeFlowDisplayText(flow.currentStep)}`,
    `owner: ${safeFlowDisplayText(flow.ownerKey)}`,
    `notify: ${flow.notifyPolicy}`,
    ...(stateSummary ? [`state: ${safeFlowDisplayText(stateSummary)}`] : []),
    ...(flow.cancelRequestedAt
      ? [`cancelRequestedAt: ${formatFlowTimestamp(flow.cancelRequestedAt)}`]
      : []),
    `createdAt: ${formatFlowTimestamp(flow.createdAt)}`,
    `updatedAt: ${formatFlowTimestamp(flow.updatedAt)}`,
    `endedAt: ${formatFlowTimestamp(flow.endedAt)}`,
    `tasks: ${taskSummary.total} total · ${taskSummary.active} active · ${taskSummary.failures} issues`,
  ];
  for (const line of lines) {
    runtime.log(line);
  }
  if (tasks.length === 0) {
    runtime.log("Linked tasks: none");
    return;
  }
  runtime.log("Linked tasks:");
  for (const task of tasks) {
    const safeLabel = safeFlowDisplayText(task.label ?? task.task);
    runtime.log(`- ${task.taskId} ${task.status} ${task.runId ?? "n/a"} ${safeLabel}`);
  }
}

/** Requests cancellation for one TaskFlow selected by id or lookup token. */
export async function flowsCancelCommand(opts: { lookup: string }, runtime: RuntimeEnv) {
  const flow = resolveTaskFlowForLookupToken(opts.lookup);
  if (!flow) {
    runtime.error(formatFlowLookupMiss(opts.lookup));
    runtime.exit(1);
    return;
  }
  const result = await cancelFlowById({
    cfg: getRuntimeConfig(),
    flowId: flow.flowId,
  });
  if (!result.found) {
    runtime.error(result.reason ?? formatFlowLookupMiss(opts.lookup));
    runtime.exit(1);
    return;
  }
  if (!result.cancelled) {
    runtime.error(result.reason ?? `Could not cancel TaskFlow: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  const updated = getTaskFlowById(flow.flowId) ?? result.flow ?? flow;
  runtime.log(`Cancelled ${updated.flowId} (${updated.syncMode}) with status ${updated.status}.`);
}

// ---------------------------------------------------------------------------
// Owner-scoped TaskFlow lifecycle primitives.
//
// These are thin, generic verbs over the owner-scoped runtime task-flow API
// (`createRuntimeTaskFlow().bindSession(...)` plus the owner-scoped linked-task
// executor). They give out-of-band controllers (e.g. a host-side background
// program) a revision-safe CLI contract for the full flow lifecycle — create,
// link a child run, mutate flow state, and finalize a run — without depending on
// OpenClaw's internal module layout. Each caller passes an explicit owner key so
// the surface stays product-agnostic.
// ---------------------------------------------------------------------------

type FlowMutateCommonOptions = {
  json?: boolean;
  ownerKey: string;
  flowId: string;
  expectedRevision?: number;
  currentStep?: string;
  stateJson?: string;
};

function parseStateJson(
  raw: string | undefined,
  runtime: RuntimeEnv,
): JsonValue | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    runtime.error("--state-json must be valid JSON.");
    runtime.exit(1);
    return undefined;
  }
}

function bindOwner(ownerKey: string): BoundTaskFlowRuntime {
  return createRuntimeTaskFlow().bindSession({ sessionKey: ownerKey });
}

// Resolve the optimistic-concurrency revision: callers may thread an explicit
// expectedRevision, but when omitted we read the current owner-scoped record so
// a single out-of-band mutation does not need to round-trip the revision first.
function resolveExpectedRevision(
  bound: BoundTaskFlowRuntime,
  opts: { flowId: string; expectedRevision?: number },
  runtime: RuntimeEnv,
): number | undefined {
  if (typeof opts.expectedRevision === "number") {
    return opts.expectedRevision;
  }
  const flow = bound.get(opts.flowId);
  if (!flow) {
    runtime.error(formatFlowLookupMiss(opts.flowId));
    runtime.exit(1);
    return undefined;
  }
  return flow.revision;
}

function emitFlowMutation(
  result: ManagedTaskFlowMutationResult,
  opts: { json?: boolean; flowId: string },
  runtime: RuntimeEnv,
): void {
  if (!result.applied) {
    runtime.error(`TaskFlow mutation failed (${result.code}) for ${opts.flowId}.`);
    runtime.exit(1);
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, {
      flow: result.flow,
      tasks: listTasksForFlowId(result.flow.flowId),
    });
    return;
  }
  runtime.log(
    `TaskFlow ${result.flow.flowId} -> ${result.flow.status} (rev ${result.flow.revision}).`,
  );
}

/** Creates a managed TaskFlow owned by the caller owner key. */
export async function flowsCreateManagedCommand(
  opts: {
    json?: boolean;
    ownerKey: string;
    controllerId: string;
    goal: string;
    currentStep?: string;
    status?: "queued" | "running" | "waiting" | "blocked";
    notifyPolicy?: TaskNotifyPolicy;
    stateJson?: string;
  },
  runtime: RuntimeEnv,
) {
  const stateJson = parseStateJson(opts.stateJson, runtime);
  if (opts.stateJson !== undefined && stateJson === undefined) {
    return;
  }
  const bound = bindOwner(opts.ownerKey);
  const flow = bound.tryCreateManaged({
    controllerId: opts.controllerId,
    goal: opts.goal,
    currentStep: opts.currentStep,
    status: opts.status,
    notifyPolicy: opts.notifyPolicy,
    stateJson,
  });
  if (!flow) {
    runtime.error("TaskFlow creation failed (persistence error).");
    runtime.exit(1);
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, { flow, tasks: listTasksForFlowId(flow.flowId) });
    return;
  }
  runtime.log(`Created TaskFlow ${flow.flowId} (${flow.status}).`);
}

/** Reserves (idempotently) a linked child task run inside an owner-scoped flow. */
export async function flowsRunTaskCommand(
  opts: {
    json?: boolean;
    ownerKey: string;
    flowId: string;
    expectedRevision?: number;
    idempotencyKey: string;
    idempotencyPayloadHash: string;
    task: string;
    runtime?: TaskRuntime;
    sourceId?: string;
    childSessionKey?: string;
    agentId?: string;
    runId?: string;
    taskName?: string;
    projectKey?: string;
    controllerId?: string;
    attempt?: number;
    label?: string;
    notifyPolicy?: TaskNotifyPolicy;
    deliveryStatus?: TaskDeliveryStatus;
    status?: "queued" | "running";
    progressSummary?: string;
  },
  runtime: RuntimeEnv,
) {
  const result = reserveLinkedTaskInFlowForOwner({
    flowId: opts.flowId,
    callerOwnerKey: opts.ownerKey,
    expectedRevision: opts.expectedRevision,
    runtime: opts.runtime ?? "subagent",
    sourceId: opts.sourceId,
    childSessionKey: opts.childSessionKey,
    agentId: opts.agentId,
    runId: opts.runId,
    taskName: opts.taskName,
    idempotencyKey: opts.idempotencyKey,
    idempotencyPayloadHash: opts.idempotencyPayloadHash,
    projectKey: opts.projectKey,
    controllerId: opts.controllerId,
    attempt: opts.attempt,
    label: opts.label,
    task: opts.task,
    notifyPolicy: opts.notifyPolicy,
    deliveryStatus: opts.deliveryStatus,
    status: opts.status ?? "queued",
    progressSummary: opts.progressSummary,
  });
  if (result.conflict || !result.found || !result.task) {
    runtime.error(result.reason ?? `Could not link a task into TaskFlow ${opts.flowId}.`);
    runtime.exit(1);
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, {
      created: result.created,
      reserved: result.reserved,
      flow: result.flow,
      task: result.task,
      tasks: listTasksForFlowId(opts.flowId),
    });
    return;
  }
  runtime.log(
    `Linked task ${result.task.taskId} into TaskFlow ${opts.flowId} (${result.created ? "created" : "existing"}).`,
  );
}

/** Updates the durable state/currentStep of an owner-scoped managed flow. */
export async function flowsUpdateStateCommand(opts: FlowMutateCommonOptions, runtime: RuntimeEnv) {
  const stateJson = parseStateJson(opts.stateJson, runtime);
  if (opts.stateJson !== undefined && stateJson === undefined) {
    return;
  }
  const bound = bindOwner(opts.ownerKey);
  const expectedRevision = resolveExpectedRevision(bound, opts, runtime);
  if (expectedRevision === undefined) {
    return;
  }
  emitFlowMutation(
    bound.updateState({
      flowId: opts.flowId,
      expectedRevision,
      currentStep: opts.currentStep,
      stateJson,
    }),
    opts,
    runtime,
  );
}

/** Marks an owner-scoped managed flow as succeeded. */
export async function flowsFinishCommand(opts: FlowMutateCommonOptions, runtime: RuntimeEnv) {
  const stateJson = parseStateJson(opts.stateJson, runtime);
  if (opts.stateJson !== undefined && stateJson === undefined) {
    return;
  }
  const bound = bindOwner(opts.ownerKey);
  const expectedRevision = resolveExpectedRevision(bound, opts, runtime);
  if (expectedRevision === undefined) {
    return;
  }
  emitFlowMutation(
    bound.finish({ flowId: opts.flowId, expectedRevision, stateJson }),
    opts,
    runtime,
  );
}

/** Marks an owner-scoped managed flow as failed (or cancelled, via currentStep). */
export async function flowsFailCommand(
  opts: FlowMutateCommonOptions & { blockedTaskId?: string; blockedSummary?: string },
  runtime: RuntimeEnv,
) {
  const stateJson = parseStateJson(opts.stateJson, runtime);
  if (opts.stateJson !== undefined && stateJson === undefined) {
    return;
  }
  const bound = bindOwner(opts.ownerKey);
  const expectedRevision = resolveExpectedRevision(bound, opts, runtime);
  if (expectedRevision === undefined) {
    return;
  }
  emitFlowMutation(
    bound.fail({
      flowId: opts.flowId,
      expectedRevision,
      blockedTaskId: opts.blockedTaskId,
      blockedSummary: opts.blockedSummary,
      stateJson,
    }),
    opts,
    runtime,
  );
}

/** Resumes an owner-scoped managed flow back to queued/running. */
export async function flowsResumeCommand(
  opts: FlowMutateCommonOptions & { status?: "queued" | "running" },
  runtime: RuntimeEnv,
) {
  const stateJson = parseStateJson(opts.stateJson, runtime);
  if (opts.stateJson !== undefined && stateJson === undefined) {
    return;
  }
  const bound = bindOwner(opts.ownerKey);
  const expectedRevision = resolveExpectedRevision(bound, opts, runtime);
  if (expectedRevision === undefined) {
    return;
  }
  emitFlowMutation(
    bound.resume({
      flowId: opts.flowId,
      expectedRevision,
      status: opts.status,
      currentStep: opts.currentStep,
      stateJson,
    }),
    opts,
    runtime,
  );
}

/** Sets an owner-scoped managed flow to waiting/blocked. */
export async function flowsSetWaitingCommand(
  opts: FlowMutateCommonOptions & {
    blockedTaskId?: string;
    blockedSummary?: string;
    waitJson?: string;
  },
  runtime: RuntimeEnv,
) {
  const stateJson = parseStateJson(opts.stateJson, runtime);
  if (opts.stateJson !== undefined && stateJson === undefined) {
    return;
  }
  const waitJson = parseStateJson(opts.waitJson, runtime);
  if (opts.waitJson !== undefined && waitJson === undefined) {
    return;
  }
  const bound = bindOwner(opts.ownerKey);
  const expectedRevision = resolveExpectedRevision(bound, opts, runtime);
  if (expectedRevision === undefined) {
    return;
  }
  emitFlowMutation(
    bound.setWaiting({
      flowId: opts.flowId,
      expectedRevision,
      currentStep: opts.currentStep,
      blockedTaskId: opts.blockedTaskId,
      blockedSummary: opts.blockedSummary,
      stateJson,
      waitJson,
    }),
    opts,
    runtime,
  );
}

/** Requests cancellation of an owner-scoped managed flow (intent only). */
export async function flowsRequestCancelCommand(
  opts: { json?: boolean; ownerKey: string; flowId: string; expectedRevision?: number },
  runtime: RuntimeEnv,
) {
  const bound = bindOwner(opts.ownerKey);
  const expectedRevision = resolveExpectedRevision(bound, opts, runtime);
  if (expectedRevision === undefined) {
    return;
  }
  emitFlowMutation(bound.requestCancel({ flowId: opts.flowId, expectedRevision }), opts, runtime);
}

/** Finalizes a linked child run by run id as a terminal succeeded/failed/cancelled task. */
export async function flowsFinalizeRunCommand(
  opts: {
    json?: boolean;
    runId: string;
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
    summary?: string;
    error?: string;
  },
  runtime: RuntimeEnv,
) {
  const now = Date.now();
  const summary = opts.summary;
  const result =
    opts.outcome === "succeeded"
      ? completeTaskRunByRunId({
          runId: opts.runId,
          endedAt: now,
          lastEventAt: now,
          progressSummary: summary,
          terminalSummary: summary,
          terminalOutcome: "succeeded",
        })
      : failTaskRunByRunId({
          runId: opts.runId,
          status: opts.outcome,
          endedAt: now,
          lastEventAt: now,
          error: opts.error ?? summary,
          terminalSummary: summary,
        });
  if (opts.json) {
    writeRuntimeJson(runtime, { runId: opts.runId, outcome: opts.outcome, result });
    return;
  }
  runtime.log(`Finalized run ${opts.runId} as ${opts.outcome}.`);
}
