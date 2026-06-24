import type {
  AnyAgentTool,
  OpenClawPluginApi as SdkOpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type TaskFlowStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

export type TaskNotifyPolicy = "done_only" | "state_changes" | "silent";

export type TaskRegistrySummary = {
  total: number;
  active: number;
  terminal: number;
  failures: number;
  byStatus?: Record<string, number>;
  byRuntime?: Record<string, number>;
};

type TaskRunStringField =
  | "sourceId"
  | "sessionKey"
  | "ownerKey"
  | "scope"
  | "childSessionKey"
  | "flowId"
  | "parentTaskId"
  | "agentId"
  | "runId"
  | "taskName"
  | "label"
  | "deliveryStatus"
  | "notifyPolicy"
  | "error"
  | "progressSummary"
  | "terminalSummary"
  | "terminalOutcome";

type TaskRunNumberField = "createdAt" | "startedAt" | "endedAt" | "lastEventAt" | "cleanupAfter";

export type TaskRunView = {
  id: string;
  runtime: string;
  title: string;
  status: string;
} & Partial<Record<TaskRunStringField, string>> &
  Partial<Record<TaskRunNumberField, number>>;

export type TaskFlowRecord = {
  flowId: string;
  syncMode: "managed" | "task_mirrored";
  controllerId?: string;
  revision: number;
  status: TaskFlowStatus;
  notifyPolicy: TaskNotifyPolicy;
  goal: string;
  currentStep?: string;
  blockedSummary?: string;
  stateJson?: JsonValue;
  waitJson?: JsonValue;
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};

export type TaskFlowMutationResult =
  | { applied: true; flow: TaskFlowRecord }
  | {
      applied: false;
      code: "not_found" | "not_managed" | "revision_conflict";
      current?: TaskFlowRecord;
    };

export type BoundTaskFlowRuntime = {
  readonly sessionKey: string;
  createManaged(params: {
    controllerId: string;
    goal: string;
    status?: TaskFlowStatus;
    notifyPolicy?: TaskNotifyPolicy;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    waitJson?: JsonValue | null;
  }): TaskFlowRecord;
  get(flowId: string): TaskFlowRecord | undefined;
  list(): TaskFlowRecord[];
  getTaskSummary(flowId: string): TaskRegistrySummary | undefined;
  requestCancel(params: {
    flowId: string;
    expectedRevision: number;
    cancelRequestedAt?: number;
  }): TaskFlowMutationResult;
};

export type BoundTaskFlowDetailsRuntime = {
  get(flowId: string): { tasks?: TaskRunView[] } | undefined;
};

export type PluginStateKeyedStore<T> = {
  registerIfAbsent(key: string, value: T, opts?: { ttlMs?: number }): Promise<boolean>;
  lookup(key: string): Promise<T | undefined>;
};

export type OpenClawPluginApi = Pick<
  SdkOpenClawPluginApi,
  "pluginConfig" | "runtime" | "registerTool" | "registerToolMetadata"
>;

export type { AnyAgentTool, OpenClawPluginToolContext };

export type AgentToolResult<T = unknown> = {
  content: Array<{ type: "text"; text: string }>;
  details: T;
};

export type ToolName =
  | "taskflow_create_managed"
  | "taskflow_list_own"
  | "taskflow_get_own"
  | "taskflow_request_cancel"
  | "taskflow_request_schedule"
  | "taskflow_list_schedules"
  | "taskflow_request_schedule_cancel";

export type ToolSuccess = {
  ok: true;
  toolName: ToolName;
  flowId?: string;
  revision?: number;
  idempotent?: boolean;
  result: unknown;
};

export type ToolFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type ToolEnvelope = ToolSuccess | ToolFailure;

export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export type ApprovalRequestResult = {
  // `pending_approval` is the deferred (durable) acknowledgement: the request is
  // persisted and will be applied when the owner decides later, instead of the
  // call holding open for a synchronous decision.
  status?: "accepted" | "pending_approval";
  id?: string;
  decision?: ApprovalDecision | null;
  actionHash?: string;
  createdAtMs?: number;
  expiresAtMs?: number;
};

export type GatewayCaller = (
  method: string,
  options: { timeoutMs?: number },
  params: Record<string, unknown>,
  callOptions?: Record<string, unknown>,
) => Promise<unknown>;
