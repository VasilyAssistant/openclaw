import { Type } from "typebox";
import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from "../runtime-api.js";
import {
  createEmbeddedLobsterRunner,
  resolveLobsterCwd,
  type LobsterRunner,
  type LobsterRunnerParams,
} from "./lobster-runner.js";
import {
  resumeManagedLobsterFlow,
  runManagedLobsterFlow,
  type ManagedLobsterFlowResult,
} from "./lobster-taskflow.js";

const TOOL_NAME = "lobster_managed_workflow";
const PLUGIN_ID = "lobster";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_STDOUT_BYTES = 512_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const MAX_APPROVAL_TIMEOUT_MS = 600_000;
const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LINKED_SPAWN_TIMEOUT_MS = 300_000;
const WORKFLOW_STATE_KEY = "lobsterManagedWorkflow";

type BoundTaskFlow = ReturnType<
  NonNullable<OpenClawPluginApi["runtime"]>["tasks"]["managedFlows"]["bindSession"]
>;
type FlowRecord = ReturnType<BoundTaskFlow["createManaged"]>;

type JsonLike =
  | null
  | boolean
  | number
  | string
  | JsonLike[]
  | {
      [key: string]: JsonLike;
    };

type GatewayCaller = (
  method: string,
  options: { timeoutMs?: number },
  params: Record<string, unknown>,
  callOptions?: Record<string, unknown>,
) => Promise<unknown>;

type KeyedStore<T> = {
  register(key: string, value: T, opts?: { ttlMs?: number }): Promise<void>;
  registerIfAbsent(key: string, value: T, opts?: { ttlMs?: number }): Promise<boolean>;
  lookup(key: string): Promise<T | undefined>;
};

type ManagedWorkflowConfig = {
  pipeline: string;
  goal: string;
  controllerId: string;
  allowSandboxed: boolean;
  approvalMode: "taskflow" | "plugin-inline";
  approvedTask?: ApprovedTaskConfig;
  cwd?: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  approvalTimeoutMs: number;
  currentStep?: string;
  waitingStep?: string;
  resumeStep?: string;
  requireIdempotency: boolean;
  idempotencyTtlMs: number;
};

type TaskRuntime = "subagent" | "acp" | "cli" | "cron";
type TaskNotifyPolicy = "done_only" | "state_changes" | "silent";
type TaskDeliveryStatus =
  | "pending"
  | "delivered"
  | "session_queued"
  | "failed"
  | "parent_missing"
  | "not_applicable";

type ApprovedTaskConfig = {
  runtime: TaskRuntime;
  taskTemplate: string;
  labelTemplate?: string;
  sourceIdTemplate?: string;
  childSessionKeyTemplate?: string;
  agentIdTemplate?: string;
  runIdTemplate?: string;
  progressSummaryTemplate?: string;
  status: "queued" | "running";
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
  preferMetadata?: boolean;
};

type RenderedApprovedTask = {
  task: string;
  label?: string;
  sourceId?: string;
  childSessionKey?: string;
  agentId?: string;
  runId?: string;
  progressSummary?: string;
};

type LobsterManagedWorkflowToolOptions = {
  runner?: LobsterRunner;
  taskFlow?: BoundTaskFlow;
  callGatewayTool?: GatewayCaller;
  idempotencyStore?: KeyedStore<WorkflowClaim>;
};

type ApprovedTaskSideEffectResult = {
  sideEffect: JsonLike;
  flow: FlowRecord;
};

type LinkedSpawnAcceptedDetails = {
  status: "accepted";
  childSessionKey?: string;
  runId?: string;
  mode?: string;
  taskName?: string;
  note?: string;
};

type WorkflowClaim = {
  workflowId: string;
  idempotencyKey: string;
  status: "creating" | "waiting" | "completed" | "failed";
  flowId?: string;
  revision?: number;
  sideEffect?: JsonLike;
  updatedAtMs: number;
};

type StoredWorkflowState = {
  workflowId?: string;
  idempotencyKey?: string;
  argsJson?: string;
  args?: JsonLike;
  createdAtMs?: number;
};

type ApprovalResult =
  | { status: "approved"; approvalRequestId: string; decision: string }
  | { status: "denied"; approvalRequestId: string; decision: string }
  | { status: "unavailable"; reason: string; approvalRequestId?: string }
  | { status: "timeout"; approvalRequestId: string };

let gatewayCallerPromise: Promise<GatewayCaller | undefined> | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readPositiveInt(value: unknown, fallback: number, max?: number): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    return fallback;
  }
  return max ? Math.min(value, max) : value;
}

function readTaskRuntime(value: unknown, fallback: TaskRuntime): TaskRuntime {
  return value === "subagent" || value === "acp" || value === "cli" || value === "cron"
    ? value
    : fallback;
}

function readTaskNotifyPolicy(value: unknown): TaskNotifyPolicy | undefined {
  return value === "done_only" || value === "state_changes" || value === "silent"
    ? value
    : undefined;
}

function readTaskDeliveryStatus(value: unknown): TaskDeliveryStatus | undefined {
  return value === "pending" ||
    value === "delivered" ||
    value === "session_queued" ||
    value === "failed" ||
    value === "parent_missing" ||
    value === "not_applicable"
    ? value
    : undefined;
}

function readTaskStatus(value: unknown): "queued" | "running" {
  return value === "running" ? "running" : "queued";
}

function parseJsonLike(raw: unknown, fieldName: string): JsonLike | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new Error(`${fieldName} must be a JSON string`);
  }
  try {
    return JSON.parse(raw) as JsonLike;
  } catch {
    throw new Error(`${fieldName} must be valid JSON`);
  }
}

function compactText(value: string, maxChars: number): string {
  const compacted = value.replace(/\s+/gu, " ").trim();
  if (compacted.length <= maxChars) {
    return compacted;
  }
  return `${compacted.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function parseApprovedTaskConfig(raw: unknown): ApprovedTaskConfig | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }
  const type = readString(record.type) ?? "runTask";
  if (type !== "runTask") {
    throw new Error(`Unsupported Lobster managed workflow onApproved type: ${type}`);
  }
  const taskTemplate = readString(record.taskTemplate);
  if (!taskTemplate) {
    throw new Error("Lobster managed workflow onApproved.runTask requires taskTemplate");
  }
  const runtime = readTaskRuntime(record.runtime, "subagent");
  return {
    runtime,
    taskTemplate,
    ...(readString(record.labelTemplate)
      ? { labelTemplate: readString(record.labelTemplate) }
      : {}),
    ...(readString(record.sourceIdTemplate)
      ? { sourceIdTemplate: readString(record.sourceIdTemplate) }
      : {}),
    ...(readString(record.childSessionKeyTemplate)
      ? { childSessionKeyTemplate: readString(record.childSessionKeyTemplate) }
      : {}),
    ...(readString(record.agentIdTemplate)
      ? { agentIdTemplate: readString(record.agentIdTemplate) }
      : {}),
    ...(readString(record.runIdTemplate)
      ? { runIdTemplate: readString(record.runIdTemplate) }
      : {}),
    ...(readString(record.progressSummaryTemplate)
      ? { progressSummaryTemplate: readString(record.progressSummaryTemplate) }
      : {}),
    status: readTaskStatus(record.status),
    ...(readTaskNotifyPolicy(record.notifyPolicy)
      ? { notifyPolicy: readTaskNotifyPolicy(record.notifyPolicy) }
      : {}),
    ...(readTaskDeliveryStatus(record.deliveryStatus)
      ? { deliveryStatus: readTaskDeliveryStatus(record.deliveryStatus) }
      : {}),
    ...(typeof record.preferMetadata === "boolean"
      ? { preferMetadata: record.preferMetadata }
      : {}),
  };
}

function stringifyTemplateValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function lookupTemplateValue(root: Record<string, unknown>, expression: string): unknown {
  const parts = expression.split(".").filter(Boolean);
  let current: unknown = root;
  for (const part of parts) {
    const record = asRecord(current);
    if (!record || !(part in record)) {
      current = undefined;
      break;
    }
    current = record[part];
  }
  if (current !== undefined || expression.includes(".")) {
    return current;
  }
  const args = asRecord(root.args);
  return args?.[expression];
}

function renderTemplate(
  template: string | undefined,
  context: Record<string, unknown>,
): string | undefined {
  if (!template) {
    return undefined;
  }
  const rendered = template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/gu, (_match, expr) =>
    stringifyTemplateValue(lookupTemplateValue(context, expr)),
  );
  const trimmed = rendered.trim();
  return trimmed ? trimmed : undefined;
}

function loadGatewayCaller(): Promise<GatewayCaller | undefined> {
  gatewayCallerPromise ??= (async () => {
    try {
      const module = await import("openclaw/plugin-sdk/agent-harness-runtime");
      return typeof module.callGatewayTool === "function"
        ? (module.callGatewayTool as GatewayCaller)
        : undefined;
    } catch {
      return undefined;
    }
  })();
  return gatewayCallerPromise;
}

function resolveWorkflowConfig(
  api: OpenClawPluginApi,
  workflowId: string,
): ManagedWorkflowConfig | undefined {
  const pluginConfig = asRecord(api.pluginConfig);
  const workflows = asRecord(pluginConfig?.managedWorkflows);
  const raw = asRecord(workflows?.[workflowId]);
  if (!raw) {
    return undefined;
  }
  const pipeline = readString(raw.pipeline);
  const goal = readString(raw.goal);
  if (!pipeline || !goal) {
    throw new Error(`Lobster managed workflow "${workflowId}" requires pipeline and goal`);
  }
  const controllerId = readString(raw.controllerId) ?? `lobster/${workflowId}`;
  const approvalModeRaw = readString(raw.approvalMode);
  const approvalMode = approvalModeRaw === "plugin-inline" ? "plugin-inline" : "taskflow";
  const approvedTask = parseApprovedTaskConfig(raw.onApproved);
  if (approvedTask && approvalMode !== "plugin-inline") {
    throw new Error(
      `Lobster managed workflow "${workflowId}" onApproved requires approvalMode=plugin-inline`,
    );
  }
  return {
    pipeline,
    goal,
    controllerId,
    allowSandboxed: readBoolean(raw.allowSandboxed) === true,
    approvalMode,
    ...(approvedTask ? { approvedTask } : {}),
    ...(readString(raw.cwd) ? { cwd: readString(raw.cwd) } : {}),
    timeoutMs: readPositiveInt(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxStdoutBytes: readPositiveInt(raw.maxStdoutBytes, DEFAULT_MAX_STDOUT_BYTES),
    approvalTimeoutMs: readPositiveInt(
      raw.approvalTimeoutMs,
      DEFAULT_APPROVAL_TIMEOUT_MS,
      MAX_APPROVAL_TIMEOUT_MS,
    ),
    ...(readString(raw.currentStep) ? { currentStep: readString(raw.currentStep) } : {}),
    ...(readString(raw.waitingStep) ? { waitingStep: readString(raw.waitingStep) } : {}),
    ...(readString(raw.resumeStep) ? { resumeStep: readString(raw.resumeStep) } : {}),
    requireIdempotency: raw.requireIdempotency !== false,
    idempotencyTtlMs: readPositiveInt(raw.idempotencyTtlMs, DEFAULT_IDEMPOTENCY_TTL_MS),
  };
}

function requireWorkflowConfig(
  api: OpenClawPluginApi,
  ctx: OpenClawPluginToolContext,
  workflowId: string,
): ManagedWorkflowConfig {
  const workflow = resolveWorkflowConfig(api, workflowId);
  if (!workflow) {
    throw new Error(`Lobster managed workflow is not configured: ${workflowId}`);
  }
  if (ctx.sandboxed && !workflow.allowSandboxed) {
    throw new Error(
      `Lobster managed workflow "${workflowId}" is not allowed from sandboxed sessions`,
    );
  }
  return workflow;
}

async function resolveIdempotencyStore(
  api: OpenClawPluginApi,
  options?: LobsterManagedWorkflowToolOptions,
): Promise<KeyedStore<WorkflowClaim>> {
  if (options?.idempotencyStore) {
    return options.idempotencyStore;
  }
  const store = api.runtime?.state?.openKeyedStore?.<WorkflowClaim>({
    namespace: "lobster-managed-workflows",
    maxEntries: 1_000,
    defaultTtlMs: DEFAULT_IDEMPOTENCY_TTL_MS,
  });
  if (!store) {
    throw new Error("Lobster managed workflows require durable plugin state.");
  }
  return store;
}

function claimKey(workflowId: string, idempotencyKey: string): string {
  return `${workflowId}:${idempotencyKey}`;
}

function buildWorkflowStateJson(params: {
  baseStateJson?: JsonLike;
  workflowId: string;
  idempotencyKey?: string;
  argsJson?: string;
}): JsonLike {
  const workflowState: Record<string, JsonLike> = {
    workflowId: params.workflowId,
    createdAtMs: Date.now(),
  };
  if (params.idempotencyKey) {
    workflowState.idempotencyKey = params.idempotencyKey;
  }
  if (params.argsJson) {
    workflowState.argsJson = params.argsJson;
  }
  const baseRecord = asRecord(params.baseStateJson);
  if (baseRecord) {
    return {
      ...baseRecord,
      [WORKFLOW_STATE_KEY]: workflowState,
    };
  }
  if (params.baseStateJson !== undefined) {
    return {
      value: params.baseStateJson,
      [WORKFLOW_STATE_KEY]: workflowState,
    };
  }
  return {
    [WORKFLOW_STATE_KEY]: workflowState,
  };
}

function readStoredWorkflowState(params: {
  taskFlow: BoundTaskFlow;
  flowId: string;
  workflowId: string;
}): StoredWorkflowState | undefined {
  const flow = params.taskFlow.get(params.flowId);
  const stateRecord = asRecord(flow?.stateJson);
  const stored = asRecord(stateRecord?.[WORKFLOW_STATE_KEY]);
  if (!stored) {
    return undefined;
  }
  const workflowId = readString(stored.workflowId);
  if (workflowId !== params.workflowId) {
    return undefined;
  }
  return {
    workflowId,
    ...(readString(stored.idempotencyKey)
      ? { idempotencyKey: readString(stored.idempotencyKey) }
      : {}),
    ...(readString(stored.argsJson) ? { argsJson: readString(stored.argsJson) } : {}),
    ...(stored.args !== undefined ? { args: stored.args as JsonLike } : {}),
    ...(typeof stored.createdAtMs === "number" ? { createdAtMs: stored.createdAtMs } : {}),
  };
}

function flowRevisionFromResult(result: ManagedLobsterFlowResult): {
  flowId?: string;
  revision?: number;
} {
  if (result.ok) {
    const mutation = asRecord(result.mutation);
    const flow = asRecord(mutation?.flow) ?? asRecord(result.flow);
    const flowId = readString(flow?.flowId);
    const revision = typeof flow?.revision === "number" ? flow.revision : undefined;
    return {
      ...(flowId ? { flowId } : {}),
      ...(revision !== undefined ? { revision } : {}),
    };
  }
  const mutation = asRecord(result.mutation);
  const flow = asRecord(mutation?.flow);
  const flowId = readString(flow?.flowId);
  const revision = typeof flow?.revision === "number" ? flow.revision : undefined;
  return {
    ...(flowId ? { flowId } : {}),
    ...(revision !== undefined ? { revision } : {}),
  };
}

function formatManagedFlowResult(
  result: ManagedLobsterFlowResult,
  extra?: Record<string, unknown>,
) {
  if (!result.ok) {
    throw result.error;
  }
  const envelope =
    result.envelope && typeof result.envelope === "object" && !Array.isArray(result.envelope)
      ? result.envelope
      : { envelope: result.envelope };
  const details = {
    ...envelope,
    flow: result.flow,
    mutation: result.mutation,
    ...(result.sideEffect !== undefined ? { sideEffect: result.sideEffect } : {}),
    ...extra,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function formatIdempotentReplay(claim: WorkflowClaim) {
  const details = {
    ok: true,
    status: "idempotent_replay",
    claim,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
  };
}

async function requestInlineApproval(params: {
  callGatewayTool?: GatewayCaller;
  ctx: OpenClawPluginToolContext;
  toolCallId: string;
  prompt: string;
  description?: string;
  approvalTimeoutMs: number;
}): Promise<ApprovalResult> {
  const callGatewayTool = params.callGatewayTool ?? (await loadGatewayCaller());
  if (!callGatewayTool) {
    return { status: "unavailable", reason: "plugin approval gateway API is unavailable" };
  }
  const timeoutMs = Math.min(params.approvalTimeoutMs, MAX_APPROVAL_TIMEOUT_MS);
  const requestRaw = await callGatewayTool(
    "plugin.approval.request",
    { timeoutMs: timeoutMs + 10_000 },
    {
      pluginId: PLUGIN_ID,
      title: "Lobster workflow approval",
      description: compactText(params.description ?? params.prompt, 512),
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
      toolName: TOOL_NAME,
      toolCallId: params.toolCallId,
      agentId: params.ctx.agentId,
      sessionKey: params.ctx.sessionKey,
      turnSourceChannel: params.ctx.deliveryContext?.channel ?? params.ctx.messageChannel,
      turnSourceTo: params.ctx.deliveryContext?.to,
      turnSourceAccountId: params.ctx.deliveryContext?.accountId ?? params.ctx.agentAccountId,
      turnSourceThreadId: params.ctx.deliveryContext?.threadId,
      timeoutMs,
      twoPhase: true,
    },
    { expectFinal: false },
  );
  const request = asRecord(requestRaw);
  const approvalRequestId = readString(request?.id);
  if (!approvalRequestId || request?.decision === null) {
    return { status: "unavailable", reason: "plugin approval request was not accepted" };
  }
  let decision = readString(request?.decision);
  if (decision === undefined) {
    try {
      const waitedRaw = await callGatewayTool(
        "plugin.approval.waitDecision",
        { timeoutMs: timeoutMs + 10_000 },
        { id: approvalRequestId },
      );
      const waited = asRecord(waitedRaw);
      decision = readString(waited?.decision);
    } catch {
      return { status: "timeout", approvalRequestId };
    }
  }
  if (decision === "allow-once") {
    return { status: "approved", approvalRequestId, decision };
  }
  if (decision === "deny") {
    return { status: "denied", approvalRequestId, decision };
  }
  return { status: "timeout", approvalRequestId };
}

function buildApprovedTaskContext(params: {
  workflowId: string;
  idempotencyKey?: string;
  argsJson?: string;
  args?: JsonLike;
  flowId: string;
  expectedRevision: number;
  ctx: OpenClawPluginToolContext;
  approval?: Extract<ApprovalResult, { status: "approved" }>;
}): Record<string, unknown> {
  return {
    workflowId: params.workflowId,
    idempotencyKey: params.idempotencyKey ?? "",
    args: params.args ?? {},
    argsJson: params.argsJson ?? "",
    flowId: params.flowId,
    flowExpectedRevision: params.expectedRevision,
    sessionKey: params.ctx.sessionKey ?? "",
    agentId: params.ctx.agentId,
    approvalRequestId: params.approval?.approvalRequestId ?? "",
    approvalDecision: params.approval?.decision ?? "",
  };
}

function renderApprovedTask(
  taskConfig: ApprovedTaskConfig,
  context: Record<string, unknown>,
): RenderedApprovedTask {
  const task = renderTemplate(taskConfig.taskTemplate, context);
  if (!task) {
    throw new Error("Lobster managed workflow onApproved rendered an empty task");
  }
  const label = renderTemplate(taskConfig.labelTemplate, context);
  const sourceId = renderTemplate(taskConfig.sourceIdTemplate, context);
  const childSessionKey = renderTemplate(taskConfig.childSessionKeyTemplate, context);
  const agentId = renderTemplate(taskConfig.agentIdTemplate, context);
  const runId = renderTemplate(taskConfig.runIdTemplate, context);
  const progressSummary = renderTemplate(taskConfig.progressSummaryTemplate, context);
  return {
    task,
    ...(label ? { label } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(childSessionKey ? { childSessionKey } : {}),
    ...(agentId ? { agentId } : {}),
    ...(runId ? { runId } : {}),
    ...(progressSummary ? { progressSummary } : {}),
  };
}

function buildApprovedTaskApprovalDescription(params: {
  prompt: string;
  taskConfig: ApprovedTaskConfig;
  context: Record<string, unknown>;
}): string {
  const rendered = renderApprovedTask(params.taskConfig, params.context);
  return [
    params.prompt,
    rendered.label ? `Approved task label: ${rendered.label}` : undefined,
    `Approved task body: ${rendered.task}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function readToolInvokeDetails(raw: unknown): Record<string, unknown> {
  const envelope = asRecord(raw);
  if (!envelope || envelope.ok !== true) {
    const error = asRecord(envelope?.error);
    throw new Error(
      `Lobster managed workflow onApproved sessions_spawn invoke failed: ${
        readString(error?.message) ?? "tools.invoke did not return ok"
      }`,
    );
  }
  const output = asRecord(envelope.output);
  const details = asRecord(output?.details) ?? output;
  if (!details) {
    throw new Error("Lobster managed workflow onApproved sessions_spawn returned no details.");
  }
  return details;
}

function readLinkedSpawnAcceptedDetails(
  details: Record<string, unknown>,
): LinkedSpawnAcceptedDetails {
  const status = readString(details.status);
  if (status !== "accepted") {
    const error = readString(details.error) ?? readString(asRecord(details.error)?.message);
    throw new Error(
      `Lobster managed workflow onApproved sessions_spawn was not accepted: ${
        error ?? status ?? "unknown status"
      }`,
    );
  }
  return {
    status,
    ...(readString(details.childSessionKey)
      ? { childSessionKey: readString(details.childSessionKey) }
      : {}),
    ...(readString(details.runId) ? { runId: readString(details.runId) } : {}),
    ...(readString(details.mode) ? { mode: readString(details.mode) } : {}),
    ...(readString(details.taskName) ? { taskName: readString(details.taskName) } : {}),
    ...(readString(details.note) ? { note: readString(details.note) } : {}),
  };
}

async function runLinkedSubagentSideEffect(params: {
  taskFlow: BoundTaskFlow;
  rendered: RenderedApprovedTask;
  flowId: string;
  expectedRevision: number;
  ctx: OpenClawPluginToolContext;
  workflowId: string;
  idempotencyKey?: string;
  callGatewayTool?: GatewayCaller;
}): Promise<ApprovedTaskSideEffectResult> {
  const linkedIdempotencyKey =
    params.idempotencyKey ?? params.rendered.runId ?? params.rendered.sourceId;
  if (!linkedIdempotencyKey) {
    throw new Error("Lobster managed workflow onApproved linked subagent requires idempotencyKey.");
  }
  const callGatewayTool = params.callGatewayTool ?? (await loadGatewayCaller());
  if (!callGatewayTool) {
    throw new Error("Lobster managed workflow onApproved linked subagent requires gateway access.");
  }
  const spawnArgs = {
    task: params.rendered.task,
    runtime: "subagent",
    ...(params.rendered.label ? { label: params.rendered.label } : {}),
    ...(params.rendered.agentId ? { agentId: params.rendered.agentId } : {}),
    flowLink: {
      flowId: params.flowId,
      expectedRevision: params.expectedRevision,
      idempotencyKey: linkedIdempotencyKey,
      controllerId: params.workflowId,
    },
  };
  const raw = await callGatewayTool(
    "tools.invoke",
    { timeoutMs: DEFAULT_LINKED_SPAWN_TIMEOUT_MS },
    {
      name: "sessions_spawn",
      sessionKey: params.ctx.sessionKey ?? "main",
      idempotencyKey: `lobster:${params.workflowId}:${linkedIdempotencyKey}:sessions_spawn`,
      args: spawnArgs,
    },
  );
  const accepted = readLinkedSpawnAcceptedDetails(readToolInvokeDetails(raw));
  const flow = params.taskFlow.get(params.flowId);
  if (!flow || flow.syncMode !== "managed") {
    throw new Error("Lobster managed workflow onApproved linked subagent lost its TaskFlow.");
  }
  return {
    flow: flow as FlowRecord,
    sideEffect: {
      type: "runTask",
      mode: "linked_subagent_spawn",
      created: true,
      flowId: flow.flowId,
      flowRevision: flow.revision,
      task: {
        runtime: "subagent",
        status: "running",
        task: params.rendered.task,
        ...(params.rendered.label ? { label: params.rendered.label } : {}),
        ...(accepted.childSessionKey ? { childSessionKey: accepted.childSessionKey } : {}),
        ...(accepted.runId ? { runId: accepted.runId } : {}),
        ...(accepted.taskName ? { taskName: accepted.taskName } : {}),
        parentFlowId: flow.flowId,
      },
      spawn: accepted,
    },
  };
}

async function runApprovedTaskSideEffect(params: {
  taskFlow: BoundTaskFlow;
  taskConfig: ApprovedTaskConfig;
  flowId: string;
  expectedRevision: number;
  ctx: OpenClawPluginToolContext;
  workflowId: string;
  idempotencyKey?: string;
  argsJson?: string;
  args?: JsonLike;
  approval: Extract<ApprovalResult, { status: "approved" }>;
  callGatewayTool?: GatewayCaller;
}): Promise<ApprovedTaskSideEffectResult> {
  const rendered = renderApprovedTask(
    params.taskConfig,
    buildApprovedTaskContext({
      workflowId: params.workflowId,
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
      ...(params.argsJson ? { argsJson: params.argsJson } : {}),
      ...(params.args !== undefined ? { args: params.args } : {}),
      flowId: params.flowId,
      expectedRevision: params.expectedRevision,
      ctx: params.ctx,
      approval: params.approval,
    }),
  );
  if (params.taskConfig.runtime === "subagent") {
    return await runLinkedSubagentSideEffect({
      taskFlow: params.taskFlow,
      rendered,
      flowId: params.flowId,
      expectedRevision: params.expectedRevision,
      ctx: params.ctx,
      workflowId: params.workflowId,
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
      ...(params.callGatewayTool ? { callGatewayTool: params.callGatewayTool } : {}),
    });
  }
  const now = Date.now();
  const created = params.taskFlow.runTask({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    runtime: params.taskConfig.runtime,
    task: rendered.task,
    status: params.taskConfig.status,
    ...(rendered.label ? { label: rendered.label } : {}),
    ...(rendered.sourceId ? { sourceId: rendered.sourceId } : {}),
    ...(rendered.childSessionKey ? { childSessionKey: rendered.childSessionKey } : {}),
    ...(rendered.agentId ? { agentId: rendered.agentId } : {}),
    ...(rendered.runId ? { runId: rendered.runId } : {}),
    ...(params.taskConfig.notifyPolicy ? { notifyPolicy: params.taskConfig.notifyPolicy } : {}),
    ...(params.taskConfig.deliveryStatus
      ? { deliveryStatus: params.taskConfig.deliveryStatus }
      : {}),
    ...(typeof params.taskConfig.preferMetadata === "boolean"
      ? { preferMetadata: params.taskConfig.preferMetadata }
      : {}),
    ...(rendered.progressSummary ? { progressSummary: rendered.progressSummary } : {}),
    ...(params.taskConfig.status === "running" ? { startedAt: now, lastEventAt: now } : {}),
  });
  if (!created.created) {
    throw new Error(`Lobster managed workflow onApproved failed to create task: ${created.reason}`);
  }
  return {
    flow: created.flow,
    sideEffect: {
      type: "runTask",
      created: true,
      flowId: created.flow.flowId,
      flowRevision: created.flow.revision,
      task: {
        taskId: created.task.taskId,
        runtime: created.task.runtime,
        status: created.task.status,
        task: created.task.task,
        ...(created.task.label ? { label: created.task.label } : {}),
        ...(created.task.sourceId ? { sourceId: created.task.sourceId } : {}),
        ...(created.task.runId ? { runId: created.task.runId } : {}),
        ...(created.task.parentFlowId ? { parentFlowId: created.task.parentFlowId } : {}),
      },
    },
  };
}

async function maybeResumeAfterInlineApproval(params: {
  result: ManagedLobsterFlowResult;
  taskFlow: BoundTaskFlow;
  runner: LobsterRunner;
  runnerBaseParams: Omit<LobsterRunnerParams, "action">;
  workflow: ManagedWorkflowConfig;
  workflowId: string;
  idempotencyKey?: string;
  argsJson?: string;
  args?: JsonLike;
  ctx: OpenClawPluginToolContext;
  toolCallId: string;
  callGatewayTool?: GatewayCaller;
}): Promise<{ result: ManagedLobsterFlowResult; approval?: ApprovalResult }> {
  const result = params.result;
  if (
    !result.ok ||
    result.envelope.status !== "needs_approval" ||
    !result.envelope.requiresApproval
  ) {
    return { result };
  }
  if (params.workflow.approvalMode !== "plugin-inline") {
    return { result };
  }

  const { flowId, revision } = flowRevisionFromResult(result);
  if (!flowId || revision === undefined) {
    return {
      result,
      approval: { status: "unavailable", reason: "waiting TaskFlow revision is unavailable" },
    };
  }
  const approvalId = result.envelope.requiresApproval.approvalId;
  const token = result.envelope.requiresApproval.resumeToken;
  if (!approvalId && !token) {
    return {
      result,
      approval: { status: "unavailable", reason: "Lobster approval did not include resume token" },
    };
  }

  const approvalDescription = params.workflow.approvedTask
    ? buildApprovedTaskApprovalDescription({
        prompt: result.envelope.requiresApproval.prompt,
        taskConfig: params.workflow.approvedTask,
        context: buildApprovedTaskContext({
          workflowId: params.workflowId,
          ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
          ...(params.argsJson ? { argsJson: params.argsJson } : {}),
          ...(params.args !== undefined ? { args: params.args } : {}),
          flowId,
          expectedRevision: revision,
          ctx: params.ctx,
        }),
      })
    : undefined;

  const approval = await requestInlineApproval({
    callGatewayTool: params.callGatewayTool,
    ctx: params.ctx,
    toolCallId: params.toolCallId,
    prompt: result.envelope.requiresApproval.prompt,
    ...(approvalDescription ? { description: approvalDescription } : {}),
    approvalTimeoutMs: params.workflow.approvalTimeoutMs,
  });

  if (approval.status !== "approved" && approval.status !== "denied") {
    return { result, approval };
  }

  const resumed = await resumeManagedLobsterFlow({
    taskFlow: params.taskFlow,
    runner: params.runner,
    flowId,
    expectedRevision: revision,
    ...(params.workflow.resumeStep ? { currentStep: params.workflow.resumeStep } : {}),
    runnerParams: {
      action: "resume",
      ...(approvalId ? { approvalId } : { token: token as string }),
      approve: approval.status === "approved",
      ...params.runnerBaseParams,
    },
    ...(approval.status === "approved" && params.workflow.approvedTask
      ? {
          beforeFinalize: ({ flow, envelope, expectedRevision }) => {
            if (!envelope.ok || envelope.status !== "ok") {
              return undefined;
            }
            return runApprovedTaskSideEffect({
              taskFlow: params.taskFlow,
              taskConfig: params.workflow.approvedTask as ApprovedTaskConfig,
              flowId: flow.flowId,
              expectedRevision,
              ctx: params.ctx,
              workflowId: params.workflowId,
              ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
              ...(params.argsJson ? { argsJson: params.argsJson } : {}),
              ...(params.args !== undefined ? { args: params.args } : {}),
              approval,
              ...(params.callGatewayTool ? { callGatewayTool: params.callGatewayTool } : {}),
            });
          },
        }
      : {}),
  });
  return { result: resumed, approval };
}

async function executeRun(params: {
  api: OpenClawPluginApi;
  ctx: OpenClawPluginToolContext;
  taskFlow: BoundTaskFlow;
  runner: LobsterRunner;
  options?: LobsterManagedWorkflowToolOptions;
  toolCallId: string;
  workflowId: string;
  input: Record<string, unknown>;
}) {
  const workflow = requireWorkflowConfig(params.api, params.ctx, params.workflowId);
  const idempotencyKey = readString(params.input.idempotencyKey);
  if (workflow.requireIdempotency && !idempotencyKey) {
    throw new Error(`idempotencyKey required for Lobster managed workflow "${params.workflowId}"`);
  }
  const stateJson = parseJsonLike(params.input.flowStateJson, "flowStateJson");
  const argsJson = readString(params.input.argsJson);
  const args = parseJsonLike(argsJson, "argsJson");
  const workflowStateJson = buildWorkflowStateJson({
    baseStateJson: stateJson,
    workflowId: params.workflowId,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(argsJson ? { argsJson } : {}),
  });
  const store = idempotencyKey
    ? await resolveIdempotencyStore(params.api, params.options)
    : undefined;
  const key = idempotencyKey ? claimKey(params.workflowId, idempotencyKey) : undefined;
  if (store && key) {
    const created = await store.registerIfAbsent(
      key,
      {
        workflowId: params.workflowId,
        idempotencyKey: idempotencyKey as string,
        status: "creating",
        updatedAtMs: Date.now(),
      },
      { ttlMs: workflow.idempotencyTtlMs },
    );
    if (!created) {
      const existing = await store.lookup(key);
      if (existing) {
        return formatIdempotentReplay(existing);
      }
      throw new Error("Lobster managed workflow idempotency claim already exists");
    }
  }

  try {
    const runnerBaseParams = {
      ...(argsJson ? { argsJson } : {}),
      cwd: resolveLobsterCwd(workflow.cwd),
      timeoutMs: workflow.timeoutMs,
      maxStdoutBytes: workflow.maxStdoutBytes,
    };
    const initial = await runManagedLobsterFlow({
      taskFlow: params.taskFlow,
      runner: params.runner,
      runnerParams: {
        action: "run",
        pipeline: workflow.pipeline,
        ...runnerBaseParams,
      },
      controllerId: workflow.controllerId,
      goal: workflow.goal,
      ...(workflow.currentStep ? { currentStep: workflow.currentStep } : {}),
      ...(workflow.waitingStep ? { waitingStep: workflow.waitingStep } : {}),
      stateJson: workflowStateJson,
    });
    const bridged = await maybeResumeAfterInlineApproval({
      result: initial,
      taskFlow: params.taskFlow,
      runner: params.runner,
      runnerBaseParams,
      workflow,
      workflowId: params.workflowId,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(argsJson ? { argsJson } : {}),
      ...(args !== undefined ? { args } : {}),
      ctx: params.ctx,
      toolCallId: params.toolCallId,
      callGatewayTool: params.options?.callGatewayTool,
    });
    const { flowId, revision } = flowRevisionFromResult(bridged.result);
    const sideEffect = bridged.result.ok ? bridged.result.sideEffect : undefined;
    if (store && key && idempotencyKey) {
      await store.register(
        key,
        {
          workflowId: params.workflowId,
          idempotencyKey,
          status: bridged.result.ok
            ? bridged.result.envelope.status === "needs_approval"
              ? "waiting"
              : "completed"
            : "failed",
          ...(flowId ? { flowId } : {}),
          ...(revision !== undefined ? { revision } : {}),
          ...(sideEffect !== undefined ? { sideEffect } : {}),
          updatedAtMs: Date.now(),
        },
        { ttlMs: workflow.idempotencyTtlMs },
      );
    }
    return formatManagedFlowResult(bridged.result, {
      ...(bridged.approval ? { approval: bridged.approval } : {}),
      workflowId: params.workflowId,
    });
  } catch (error) {
    if (store && key && idempotencyKey) {
      await store.register(
        key,
        {
          workflowId: params.workflowId,
          idempotencyKey,
          status: "failed",
          updatedAtMs: Date.now(),
        },
        { ttlMs: workflow.idempotencyTtlMs },
      );
    }
    throw error;
  }
}

async function executeResume(params: {
  api: OpenClawPluginApi;
  ctx: OpenClawPluginToolContext;
  taskFlow: BoundTaskFlow;
  runner: LobsterRunner;
  options?: LobsterManagedWorkflowToolOptions;
  toolCallId: string;
  workflowId: string;
  input: Record<string, unknown>;
}) {
  const workflow = requireWorkflowConfig(params.api, params.ctx, params.workflowId);
  const flowId = readString(params.input.flowId);
  const expectedRevision = params.input.flowExpectedRevision;
  const token = readString(params.input.token);
  const approvalId = readString(params.input.approvalId);
  const approve = params.input.approve;
  if (!flowId) {
    throw new Error("flowId required for Lobster managed workflow resume");
  }
  if (typeof expectedRevision !== "number") {
    throw new Error("flowExpectedRevision required for Lobster managed workflow resume");
  }
  if (!token && !approvalId) {
    throw new Error("token or approvalId required for Lobster managed workflow resume");
  }
  if (typeof approve !== "boolean") {
    throw new Error("approve required for Lobster managed workflow resume");
  }
  const stored = readStoredWorkflowState({
    taskFlow: params.taskFlow,
    flowId,
    workflowId: params.workflowId,
  });
  const idempotencyKey = readString(params.input.idempotencyKey) ?? stored?.idempotencyKey;
  const argsJson = readString(params.input.argsJson) ?? stored?.argsJson;
  const parsedArgs = parseJsonLike(argsJson, "argsJson");
  const args = parsedArgs !== undefined ? parsedArgs : stored?.args;
  const result = await resumeManagedLobsterFlow({
    taskFlow: params.taskFlow,
    runner: params.runner,
    flowId,
    expectedRevision,
    ...(workflow.resumeStep ? { currentStep: workflow.resumeStep } : {}),
    runnerParams: {
      action: "resume",
      ...(approvalId ? { approvalId } : { token: token as string }),
      approve,
      ...(argsJson ? { argsJson } : {}),
      cwd: resolveLobsterCwd(workflow.cwd),
      timeoutMs: workflow.timeoutMs,
      maxStdoutBytes: workflow.maxStdoutBytes,
    },
    ...(approve && workflow.approvedTask
      ? {
          beforeFinalize: ({ flow, envelope, expectedRevision }) => {
            if (!envelope.ok || envelope.status !== "ok") {
              return undefined;
            }
            return runApprovedTaskSideEffect({
              taskFlow: params.taskFlow,
              taskConfig: workflow.approvedTask as ApprovedTaskConfig,
              flowId: flow.flowId,
              expectedRevision,
              ctx: params.ctx,
              workflowId: params.workflowId,
              ...(idempotencyKey ? { idempotencyKey } : {}),
              ...(argsJson ? { argsJson } : {}),
              ...(args !== undefined ? { args } : {}),
              approval: {
                status: "approved",
                approvalRequestId: approvalId ?? token ?? "manual",
                decision: "allow-once",
              },
              ...(params.options?.callGatewayTool
                ? { callGatewayTool: params.options.callGatewayTool }
                : {}),
            });
          },
        }
      : {}),
  });
  return formatManagedFlowResult(result, { workflowId: params.workflowId });
}

export function createLobsterManagedWorkflowTool(
  api: OpenClawPluginApi,
  ctx: OpenClawPluginToolContext,
  options?: LobsterManagedWorkflowToolOptions,
): AnyAgentTool | null {
  const taskFlow =
    options?.taskFlow ??
    (api.runtime?.tasks.managedFlows && ctx.sessionKey
      ? api.runtime.tasks.managedFlows.fromToolContext(ctx)
      : undefined);
  if (!taskFlow) {
    return null;
  }
  const runner = options?.runner ?? createEmbeddedLobsterRunner();
  return {
    name: TOOL_NAME,
    label: "Lobster Managed Workflow",
    description:
      "Run a host-configured Lobster workflow as a managed TaskFlow with optional inline approval.",
    parameters: Type.Object({
      action: Type.Unsafe<"run" | "resume">({ type: "string", enum: ["run", "resume"] }),
      workflowId: Type.String(),
      idempotencyKey: Type.Optional(Type.String()),
      argsJson: Type.Optional(Type.String()),
      flowStateJson: Type.Optional(Type.String()),
      flowId: Type.Optional(Type.String()),
      flowExpectedRevision: Type.Optional(Type.Number()),
      token: Type.Optional(Type.String()),
      approvalId: Type.Optional(Type.String()),
      approve: Type.Optional(Type.Boolean()),
    }),
    async execute(toolCallId: string, input: Record<string, unknown>) {
      const action = readString(input.action);
      const workflowId = readString(input.workflowId);
      if (!workflowId) {
        throw new Error("workflowId required");
      }
      if (action === "run") {
        return executeRun({
          api,
          ctx,
          taskFlow,
          runner,
          options,
          toolCallId,
          workflowId,
          input,
        });
      }
      if (action === "resume") {
        return executeResume({
          api,
          ctx,
          taskFlow,
          runner,
          options,
          toolCallId,
          workflowId,
          input,
        });
      }
      throw new Error(`Unknown action: ${String(input.action)}`);
    },
  };
}
