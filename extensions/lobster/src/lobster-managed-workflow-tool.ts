import { Type } from "typebox";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "../runtime-api.js";
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

type BoundTaskFlow = ReturnType<
  NonNullable<OpenClawPluginApi["runtime"]>["tasks"]["managedFlows"]["bindSession"]
>;

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

type LobsterManagedWorkflowToolOptions = {
  runner?: LobsterRunner;
  taskFlow?: BoundTaskFlow;
  callGatewayTool?: GatewayCaller;
  idempotencyStore?: KeyedStore<WorkflowClaim>;
};

type WorkflowClaim = {
  workflowId: string;
  idempotencyKey: string;
  status: "creating" | "waiting" | "completed" | "failed";
  flowId?: string;
  revision?: number;
  updatedAtMs: number;
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

function loadGatewayCaller(): Promise<GatewayCaller | undefined> {
  gatewayCallerPromise ??= (async () => {
    try {
      const dynamicImport = new Function("specifier", "return import(specifier)") as (
        specifier: string,
      ) => Promise<{ callGatewayTool?: GatewayCaller }>;
      const module = await dynamicImport("openclaw/plugin-sdk/agent-harness-runtime");
      return typeof module.callGatewayTool === "function" ? module.callGatewayTool : undefined;
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
  return {
    pipeline,
    goal,
    controllerId,
    allowSandboxed: readBoolean(raw.allowSandboxed) === true,
    approvalMode,
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
    ...(extra ?? {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
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
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

async function requestInlineApproval(params: {
  callGatewayTool?: GatewayCaller;
  ctx: OpenClawPluginToolContext;
  toolCallId: string;
  prompt: string;
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
      description: compactText(params.prompt, 256),
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

async function maybeResumeAfterInlineApproval(params: {
  result: ManagedLobsterFlowResult;
  taskFlow: BoundTaskFlow;
  runner: LobsterRunner;
  runnerBaseParams: Omit<LobsterRunnerParams, "action">;
  workflow: ManagedWorkflowConfig;
  ctx: OpenClawPluginToolContext;
  toolCallId: string;
  callGatewayTool?: GatewayCaller;
}): Promise<{ result: ManagedLobsterFlowResult; approval?: ApprovalResult }> {
  const result = params.result;
  if (!result.ok || result.envelope.status !== "needs_approval" || !result.envelope.requiresApproval) {
    return { result };
  }
  if (params.workflow.approvalMode !== "plugin-inline") {
    return { result };
  }

  const approval = await requestInlineApproval({
    callGatewayTool: params.callGatewayTool,
    ctx: params.ctx,
    toolCallId: params.toolCallId,
    prompt: result.envelope.requiresApproval.prompt,
    approvalTimeoutMs: params.workflow.approvalTimeoutMs,
  });

  if (approval.status !== "approved" && approval.status !== "denied") {
    return { result, approval };
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
      ...(readString(params.input.argsJson)
        ? { argsJson: readString(params.input.argsJson) }
        : {}),
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
      ...(stateJson !== undefined ? { stateJson } : {}),
    });
    const bridged = await maybeResumeAfterInlineApproval({
      result: initial,
      taskFlow: params.taskFlow,
      runner: params.runner,
      runnerBaseParams,
      workflow,
      ctx: params.ctx,
      toolCallId: params.toolCallId,
      callGatewayTool: params.options?.callGatewayTool,
    });
    const { flowId, revision } = flowRevisionFromResult(bridged.result);
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
      cwd: resolveLobsterCwd(workflow.cwd),
      timeoutMs: workflow.timeoutMs,
      maxStdoutBytes: workflow.maxStdoutBytes,
    },
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
          workflowId,
          input,
        });
      }
      throw new Error(`Unknown action: ${String(input.action)}`);
    },
  };
}
