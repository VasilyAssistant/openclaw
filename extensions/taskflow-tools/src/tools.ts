import { parseConfig } from "./config.js";
import { withIdempotency } from "./idempotency.js";
import { sanitizeCronJob, sanitizeCronListPage, sanitizeFlow } from "./sanitize.js";
import { buildCronJob, describeScheduleApproval, normalizeScheduleInput } from "./schedule.js";
import type {
  AgentToolResult,
  AnyAgentTool,
  ApprovalRequestResult,
  BoundTaskFlowDetailsRuntime,
  BoundTaskFlowRuntime,
  GatewayCaller,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  TaskFlowRecord,
  ToolEnvelope,
  ToolFailure,
  ToolName,
  ToolSuccess,
} from "./types.js";
import {
  assertJsonObject,
  assertNoForbiddenArgs,
  isRecord,
  normalizeString,
  optionalLimit,
  optionalString,
  requiredRevision,
  requiredString,
  STATE_JSON_MAX_BYTES,
  ToolInputProblem,
} from "./validation.js";

export const TASKFLOW_TOOL_NAMES = [
  "taskflow_create_managed",
  "taskflow_list_own",
  "taskflow_get_own",
  "taskflow_request_cancel",
  "taskflow_request_schedule",
  "taskflow_list_schedules",
  "taskflow_request_schedule_cancel",
] as const satisfies readonly ToolName[];

const CONTROLLER_ID = "taskflow-tools/agent";
// RPC timeout for the durable approval-request call. The request returns `pending`
// immediately (no synchronous decision wait), so this only bounds the request RPC;
// kept below common agent tool-call ceilings.
const APPROVAL_GATEWAY_TIMEOUT_MS = 85_000;
const SCHEDULE_GATEWAY_TIMEOUT_MS = 60_000;
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "lost"]);

export type TaskFlowToolDeps = {
  nowMs?: () => number;
  requestApproval?: (params: Record<string, unknown>) => Promise<ApprovalRequestResult | undefined>;
  callGatewayTool?: GatewayCaller;
};

const ToolSchemas: Record<ToolName, unknown> = {
  taskflow_create_managed: {
    type: "object",
    additionalProperties: false,
    properties: {
      goal: { type: "string" },
      currentStep: { type: "string" },
      stateJson: { type: "object" },
      notifyPolicy: { type: "string", enum: ["done_only", "state_changes", "silent"] },
      idempotencyKey: { type: "string" },
    },
    required: ["goal"],
  },
  taskflow_list_own: {
    type: "object",
    additionalProperties: false,
    properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
  },
  taskflow_get_own: {
    type: "object",
    additionalProperties: false,
    properties: { flowId: { type: "string" } },
    required: ["flowId"],
  },
  taskflow_request_cancel: {
    type: "object",
    additionalProperties: false,
    properties: {
      flowId: { type: "string" },
      expectedRevision: { type: "integer", minimum: 0 },
      idempotencyKey: { type: "string" },
    },
    required: ["flowId", "expectedRevision"],
  },
  taskflow_request_schedule: {
    type: "object",
    additionalProperties: false,
    properties: {
      taskType: { type: "string", enum: ["reminder", "agent_task"] },
      title: { type: "string" },
      message: { type: "string" },
      recurrence: {
        type: "object",
        additionalProperties: true,
        properties: {
          kind: { type: "string", enum: ["once", "at", "daily", "weekly", "cron"] },
          at: { type: "string" },
          atIso: { type: "string" },
          delaySeconds: { type: "number" },
          time: { type: "string" },
          days: { type: "array" },
          expr: { type: "string" },
          timezone: { type: "string" },
        },
        required: ["kind"],
      },
      recipient: {
        type: "object",
        additionalProperties: false,
        properties: {
          channel: { type: "string" },
          to: { type: "string" },
          accountId: { type: "string" },
          threadId: { anyOf: [{ type: "string" }, { type: "number" }] },
        },
      },
      deleteAfterRun: { type: "boolean" },
      idempotencyKey: { type: "string" },
    },
    required: ["taskType", "message", "recurrence"],
  },
  taskflow_list_schedules: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 100 },
      offset: { type: "integer", minimum: 0 },
      query: { type: "string" },
      enabled: { type: "string", enum: ["all", "enabled", "disabled"] },
      sortBy: { type: "string", enum: ["nextRunAtMs", "updatedAtMs", "name"] },
      sortDir: { type: "string", enum: ["asc", "desc"] },
    },
  },
  taskflow_request_schedule_cancel: {
    type: "object",
    additionalProperties: false,
    properties: {
      scheduleId: { type: "string" },
      idempotencyKey: { type: "string" },
    },
    required: ["scheduleId"],
  },
};

let gatewayCallerPromise: Promise<GatewayCaller | undefined> | undefined;

function loadGatewayCaller(): Promise<GatewayCaller | undefined> {
  gatewayCallerPromise ??= (async () => {
    try {
      const module = await import("openclaw/plugin-sdk/agent-harness-runtime");
      return typeof module.callGatewayTool === "function" ? module.callGatewayTool : undefined;
    } catch {
      return undefined;
    }
  })();
  return gatewayCallerPromise;
}

export function jsonResult(payload: ToolEnvelope): AgentToolResult<ToolEnvelope> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function success(params: {
  toolName: ToolName;
  result: unknown;
  flowId?: string;
  revision?: number;
  idempotent?: boolean;
}): ToolSuccess {
  return {
    ok: true,
    toolName: params.toolName,
    ...(params.flowId ? { flowId: params.flowId } : {}),
    ...(params.revision !== undefined ? { revision: params.revision } : {}),
    ...(params.idempotent ? { idempotent: true } : {}),
    result: params.result,
  };
}

function failure(code: string, message: string, details?: Record<string, unknown>): ToolFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}

function errorFromUnknown(error: unknown): ToolFailure {
  if (error instanceof ToolInputProblem) {
    return failure(error.code, error.message, error.details);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/sessionKey/u.test(message)) {
    return failure(
      "missing_session",
      "TaskFlow tools require trusted tool context with a sessionKey.",
    );
  }
  if (/openKeyedStore|trusted durable plugin state/u.test(message)) {
    return failure("state_unavailable", "TaskFlow tools require trusted durable plugin state.");
  }
  return failure("internal_error", message);
}

function bindTaskFlow(
  api: OpenClawPluginApi,
  ctx: OpenClawPluginToolContext,
): BoundTaskFlowRuntime {
  const taskFlow =
    api.runtime?.tasks?.managedFlows?.fromToolContext(ctx) ??
    api.runtime?.tasks?.flow?.fromToolContext(ctx);
  if (!taskFlow) {
    throw new ToolInputProblem("runtime_unavailable", "TaskFlow runtime API is unavailable.");
  }
  return taskFlow as unknown as BoundTaskFlowRuntime;
}

function bindTaskFlowDetails(
  api: OpenClawPluginApi,
  ctx: OpenClawPluginToolContext,
): BoundTaskFlowDetailsRuntime | undefined {
  return api.runtime?.tasks?.flows?.fromToolContext(ctx);
}

function getTaskDetails(taskFlowDetails: BoundTaskFlowDetailsRuntime | undefined, flowId: string) {
  return taskFlowDetails?.get(flowId)?.tasks;
}

function requireManagedFlow(taskFlow: BoundTaskFlowRuntime, flowId: string): TaskFlowRecord {
  const flow = taskFlow.get(flowId);
  if (!flow || flow.syncMode !== "managed") {
    throw new ToolInputProblem("not_found", "TaskFlow not found.");
  }
  return flow;
}

function isTerminalFlow(flow: Pick<TaskFlowRecord, "status">): boolean {
  return TERMINAL_STATUSES.has(flow.status);
}

function assertExpectedRevision(flow: TaskFlowRecord, expectedRevision: number): void {
  if (flow.revision !== expectedRevision) {
    throw new ToolInputProblem("revision_conflict", "TaskFlow revision conflict.", {
      currentRevision: flow.revision,
      status: flow.status,
    });
  }
}

function mapMutationFailure(result: {
  code: "not_found" | "not_managed" | "revision_conflict";
  current?: TaskFlowRecord;
}): ToolFailure {
  if (result.code === "revision_conflict") {
    return failure("revision_conflict", "TaskFlow revision conflict.", {
      currentRevision: result.current?.revision,
      status: result.current?.status,
    });
  }
  return failure("not_found", "TaskFlow not found.");
}

function normalizeNotifyPolicyArg(
  value: unknown,
): "done_only" | "state_changes" | "silent" | undefined {
  return value === "done_only" || value === "state_changes" || value === "silent"
    ? value
    : undefined;
}

function normalizeCreateInput(params: Record<string, unknown>) {
  return {
    goal: requiredString(params, "goal"),
    currentStep: optionalString(params, "currentStep"),
    stateJson:
      params.stateJson !== undefined
        ? assertJsonObject(params.stateJson, "stateJson", STATE_JSON_MAX_BYTES)
        : undefined,
    notifyPolicy: normalizeNotifyPolicyArg(params.notifyPolicy),
    idempotencyKey: optionalString(params, "idempotencyKey"),
  };
}

function normalizeFlowIdInput(params: Record<string, unknown>) {
  return { flowId: requiredString(params, "flowId") };
}

function normalizeFlowRevisionInput(params: Record<string, unknown>) {
  return {
    flowId: requiredString(params, "flowId"),
    expectedRevision: requiredRevision(params),
    idempotencyKey: optionalString(params, "idempotencyKey"),
  };
}

function optionalOffset(params: Record<string, unknown>): number | undefined {
  const raw = params.offset;
  const value =
    typeof raw === "number" && Number.isFinite(raw)
      ? raw
      : typeof raw === "string" && raw.trim()
        ? Number(raw)
        : undefined;
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.trunc(value));
}

function optionalEnum<T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalString(params, key);
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function normalizeScheduleListInput(params: Record<string, unknown>) {
  return {
    limit: optionalLimit(params),
    offset: optionalOffset(params),
    query: optionalString(params, "query"),
    enabled: optionalEnum(params, "enabled", ["all", "enabled", "disabled"] as const),
    sortBy: optionalEnum(params, "sortBy", ["nextRunAtMs", "updatedAtMs", "name"] as const),
    sortDir: optionalEnum(params, "sortDir", ["asc", "desc"] as const),
  };
}

function normalizeScheduleCancelInput(params: Record<string, unknown>) {
  return {
    scheduleId: requiredString(params, "scheduleId"),
    idempotencyKey: optionalString(params, "idempotencyKey"),
  };
}

function compactApprovalText(value: string, maxChars: number): string {
  const compacted = value.replace(/\s+/gu, " ").trim();
  if (compacted.length <= maxChars) {
    return compacted;
  }
  return `${compacted.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

async function callApprovalRequest(
  deps: TaskFlowToolDeps,
  params: Record<string, unknown>,
): Promise<ApprovalRequestResult | undefined> {
  if (deps.requestApproval) {
    return deps.requestApproval(params);
  }
  const callGatewayTool = deps.callGatewayTool ?? (await loadGatewayCaller());
  if (!callGatewayTool) {
    return undefined;
  }
  return (await callGatewayTool(
    "plugin.approval.request",
    { timeoutMs: APPROVAL_GATEWAY_TIMEOUT_MS },
    params,
    { expectFinal: false },
  )) as ApprovalRequestResult | undefined;
}

/**
 * Request a deferred (durable) approval and return a `pending_approval` envelope. Unlike
 * `requestApproval`, this does not block for a synchronous decision: the gateway persists
 * the immutable action snapshot and applies it later when the owner approves, surviving
 * the ~75s tool ceiling and a gateway restart. `kind` must match the gateway's durable
 * executor key (taskflow.managed.create / taskflow.schedule.create); provenance (ownerKey)
 * is derived gateway-side from the session, never carried in the action.
 */
async function requestDeferredApproval(params: {
  deps: TaskFlowToolDeps;
  taskFlow: BoundTaskFlowRuntime;
  ctx: OpenClawPluginToolContext;
  toolName: ToolName;
  toolCallId: string;
  title: string;
  description: string;
  severity: "info" | "warning";
  kind: string;
  action: Record<string, unknown>;
}): Promise<ToolEnvelope> {
  const request = await callApprovalRequest(params.deps, {
    pluginId: "taskflow-tools",
    title: params.title.slice(0, 80),
    description: params.description.slice(0, 512),
    severity: params.severity,
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    allowedDecisions: ["allow-once", "deny"],
    agentId: params.ctx.agentId,
    sessionKey: params.taskFlow.sessionKey,
    turnSourceChannel: params.ctx.deliveryContext?.channel ?? params.ctx.messageChannel,
    turnSourceTo: params.ctx.deliveryContext?.to,
    turnSourceAccountId: params.ctx.deliveryContext?.accountId ?? params.ctx.agentAccountId,
    turnSourceThreadId: params.ctx.deliveryContext?.threadId,
    // Idempotency-keyed by tool call so a retried tool call reuses the same durable
    // approval instead of stacking duplicates.
    durable: {
      kind: params.kind,
      action: params.action,
      idempotencyKey: params.toolCallId,
    },
  });
  if (request?.status === "pending_approval" && request.id) {
    return success({
      toolName: params.toolName,
      result: {
        status: "pending_approval",
        approvalId: request.id,
        actionHash: request.actionHash,
        expiresAtMs: request.expiresAtMs,
        message:
          "Approval requested. The action runs automatically once the owner approves it; " +
          "no further tool call is needed.",
      },
    });
  }
  return failure("approval_unavailable", "Durable approval request was not accepted.");
}

async function callCronAdd(deps: TaskFlowToolDeps, job: Record<string, unknown>): Promise<unknown> {
  const callGatewayTool = deps.callGatewayTool ?? (await loadGatewayCaller());
  if (!callGatewayTool) {
    throw new ToolInputProblem("gateway_unavailable", "Gateway cron API is not available.");
  }
  return await callGatewayTool("cron.add", { timeoutMs: SCHEDULE_GATEWAY_TIMEOUT_MS }, { job });
}

async function callCronList(
  deps: TaskFlowToolDeps,
  input: Record<string, unknown>,
): Promise<unknown> {
  const callGatewayTool = deps.callGatewayTool ?? (await loadGatewayCaller());
  if (!callGatewayTool) {
    throw new ToolInputProblem("gateway_unavailable", "Gateway cron API is not available.");
  }
  const filtered = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
  return await callGatewayTool("cron.list", { timeoutMs: SCHEDULE_GATEWAY_TIMEOUT_MS }, filtered);
}

async function callCronRemove(deps: TaskFlowToolDeps, scheduleId: string): Promise<unknown> {
  const callGatewayTool = deps.callGatewayTool ?? (await loadGatewayCaller());
  if (!callGatewayTool) {
    throw new ToolInputProblem("gateway_unavailable", "Gateway cron API is not available.");
  }
  return await callGatewayTool(
    "cron.remove",
    { timeoutMs: SCHEDULE_GATEWAY_TIMEOUT_MS },
    { id: scheduleId },
  );
}

async function executeTool(params: {
  api: OpenClawPluginApi;
  ctx: OpenClawPluginToolContext;
  deps: TaskFlowToolDeps;
  toolName: ToolName;
  toolCallId: string;
  input: Record<string, unknown>;
}): Promise<ToolEnvelope> {
  assertNoForbiddenArgs(params.input);
  const taskFlow = bindTaskFlow(params.api, params.ctx);
  const taskFlowDetails = bindTaskFlowDetails(params.api, params.ctx);
  const cfg = parseConfig(params.api.pluginConfig);
  switch (params.toolName) {
    case "taskflow_create_managed": {
      const normalized = normalizeCreateInput(params.input);
      return withIdempotency({
        api: params.api,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        taskFlow,
        input: params.input,
        normalized,
        run: async () => {
          // Managed-flow creation is owner-delegated one-shot work, not a recurring
          // commitment, so it is never gated (operator policy: approval is only for
          // scheduled/recurring commitments + external side effects). Created inline.
          const flow = taskFlow.createManaged({
            controllerId: CONTROLLER_ID,
            goal: normalized.goal,
            currentStep: normalized.currentStep,
            stateJson: normalized.stateJson,
            notifyPolicy: normalized.notifyPolicy,
          });
          return success({
            toolName: params.toolName,
            flowId: flow.flowId,
            revision: flow.revision,
            result: {
              flow: sanitizeFlow(
                flow,
                taskFlow.getTaskSummary(flow.flowId),
                getTaskDetails(taskFlowDetails, flow.flowId),
              ),
            },
          });
        },
      });
    }
    case "taskflow_list_own": {
      const limit = optionalLimit(params.input);
      const flows = taskFlow
        .list()
        .filter((flow) => flow.syncMode === "managed")
        .slice(0, limit)
        .map((flow) => sanitizeFlow(flow, taskFlow.getTaskSummary(flow.flowId)));
      return success({ toolName: params.toolName, result: { flows, total: flows.length, limit } });
    }
    case "taskflow_get_own": {
      const normalized = normalizeFlowIdInput(params.input);
      const flow = requireManagedFlow(taskFlow, normalized.flowId);
      return success({
        toolName: params.toolName,
        flowId: flow.flowId,
        revision: flow.revision,
        result: {
          flow: sanitizeFlow(
            flow,
            taskFlow.getTaskSummary(flow.flowId),
            getTaskDetails(taskFlowDetails, flow.flowId),
          ),
        },
      });
    }
    case "taskflow_request_cancel": {
      const normalized = normalizeFlowRevisionInput(params.input);
      return withIdempotency({
        api: params.api,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        taskFlow,
        input: params.input,
        normalized,
        run: async () => {
          const flow = requireManagedFlow(taskFlow, normalized.flowId);
          if (flow.cancelRequestedAt != null || isTerminalFlow(flow)) {
            return success({
              toolName: params.toolName,
              flowId: flow.flowId,
              revision: flow.revision,
              idempotent: true,
              result: {
                flow: sanitizeFlow(
                  flow,
                  taskFlow.getTaskSummary(flow.flowId),
                  getTaskDetails(taskFlowDetails, flow.flowId),
                ),
              },
            });
          }
          assertExpectedRevision(flow, normalized.expectedRevision);
          if (cfg.requireCancelApproval) {
            // Deferred durable approval: return `pending` now; the gateway applier
            // cancels the flow when the owner approves. Revisionless — the action snapshot
            // carries only the flow id, and the applier cancels whatever state the flow is
            // in at approval time (the captured expectedRevision would be stale by then).
            return requestDeferredApproval({
              deps: params.deps,
              taskFlow,
              ctx: params.ctx,
              toolName: params.toolName,
              toolCallId: params.toolCallId,
              title: "Cancel managed TaskFlow",
              description: `Request cancellation for TaskFlow ${flow.flowId}: ${compactApprovalText(flow.goal, 220)}`,
              severity: "warning",
              kind: "taskflow.managed.cancel",
              action: { flowId: normalized.flowId },
            });
          }
          const cancelled = taskFlow.requestCancel({
            flowId: normalized.flowId,
            expectedRevision: normalized.expectedRevision,
          });
          if (!cancelled.applied) {
            return mapMutationFailure(cancelled);
          }
          return success({
            toolName: params.toolName,
            flowId: cancelled.flow.flowId,
            revision: cancelled.flow.revision,
            result: {
              flow: sanitizeFlow(
                cancelled.flow,
                taskFlow.getTaskSummary(cancelled.flow.flowId),
                getTaskDetails(taskFlowDetails, cancelled.flow.flowId),
              ),
            },
          });
        },
      });
    }
    case "taskflow_request_schedule": {
      const normalized = normalizeScheduleInput(params.input, cfg, params.ctx, params.deps);
      return withIdempotency({
        api: params.api,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        taskFlow,
        input: params.input,
        normalized,
        run: async () => {
          const job = buildCronJob(normalized);
          if (cfg.requireScheduleApproval) {
            // Deferred durable approval: return `pending` now; the gateway applier adds
            // the cron job (idempotently, deterministic id) when the owner approves, not
            // inline here. The pre-built job snapshot is the action. `kind` matches the
            // gateway durable executor key.
            return requestDeferredApproval({
              deps: params.deps,
              taskFlow,
              ctx: params.ctx,
              toolName: params.toolName,
              toolCallId: params.toolCallId,
              title: "Create scheduled agent task",
              description: describeScheduleApproval(normalized),
              severity: "warning",
              kind: "taskflow.schedule.create",
              action: job,
            });
          }
          const cronResult = await callCronAdd(params.deps, job);
          return success({
            toolName: params.toolName,
            result: {
              taskType: normalized.taskType,
              schedule: normalized.recurrence,
              recipient: normalized.recipient,
              cronJob: sanitizeCronJob(cronResult),
            },
          });
        },
      });
    }
    case "taskflow_list_schedules": {
      const normalized = normalizeScheduleListInput(params.input);
      const cronResult = await callCronList(params.deps, normalized);
      return success({
        toolName: params.toolName,
        result: sanitizeCronListPage(cronResult),
      });
    }
    case "taskflow_request_schedule_cancel": {
      const normalized = normalizeScheduleCancelInput(params.input);
      return withIdempotency({
        api: params.api,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        taskFlow,
        input: params.input,
        normalized,
        run: async () => {
          if (cfg.requireScheduleApproval) {
            // Deferred durable approval: return `pending` now; the gateway applier removes
            // the cron job (idempotently) when the owner approves.
            return requestDeferredApproval({
              deps: params.deps,
              taskFlow,
              ctx: params.ctx,
              toolName: params.toolName,
              toolCallId: params.toolCallId,
              title: "Cancel scheduled agent task",
              description: `Request cancellation for schedule ${normalized.scheduleId}`,
              severity: "warning",
              kind: "taskflow.schedule.cancel",
              action: { scheduleId: normalized.scheduleId },
            });
          }
          const cronResult = await callCronRemove(params.deps, normalized.scheduleId);
          return success({
            toolName: params.toolName,
            result: {
              scheduleId: normalized.scheduleId,
              cronResult,
            },
          });
        },
      });
    }
  }
  return failure("unknown_tool", "Unsupported TaskFlow tool.");
}

function isMutatingTool(toolName: ToolName): boolean {
  return (
    toolName !== "taskflow_list_own" &&
    toolName !== "taskflow_get_own" &&
    toolName !== "taskflow_list_schedules"
  );
}

function logMutation(params: {
  api: OpenClawPluginApi;
  ctx: OpenClawPluginToolContext;
  taskFlow?: BoundTaskFlowRuntime;
  toolName: ToolName;
  toolCallId: string;
  input: Record<string, unknown>;
  result: ToolEnvelope;
}) {
  if (!isMutatingTool(params.toolName)) {
    return;
  }
  try {
    params.api.runtime?.logging
      .getChildLogger?.({ plugin: "taskflow-tools" })
      .info?.("taskflow tool mutation", {
        actor: `${params.ctx.agentId ?? "agent"}:${params.taskFlow?.sessionKey ?? "no-owner"}`,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        flowId: params.result.ok ? params.result.flowId : normalizeString(params.input.flowId),
        result: params.result.ok ? "ok" : "error",
        errorCode: params.result.ok ? undefined : params.result.error.code,
      });
  } catch {
    // Observability is best-effort and must not affect tool results.
  }
}

export function createTaskFlowTools(
  api: OpenClawPluginApi,
  ctx: OpenClawPluginToolContext,
  deps: TaskFlowToolDeps = {},
): AnyAgentTool[] {
  return TASKFLOW_TOOL_NAMES.map((toolName) => ({
    name: toolName,
    label: toolName,
    description: `Trusted owner-scoped TaskFlow tool: ${toolName}`,
    parameters: ToolSchemas[toolName],
    async execute(toolCallId: string, args: unknown): Promise<AgentToolResult> {
      const input = isRecord(args) ? args : {};
      let taskFlow: BoundTaskFlowRuntime | undefined;
      let result: ToolEnvelope;
      try {
        taskFlow = bindTaskFlow(api, ctx);
        result = await executeTool({ api, ctx, deps, toolName, toolCallId, input });
      } catch (error) {
        result = errorFromUnknown(error);
      }
      logMutation({ api, ctx, taskFlow, toolName, toolCallId, input, result });
      return jsonResult(result);
    },
  })) as AnyAgentTool[];
}
