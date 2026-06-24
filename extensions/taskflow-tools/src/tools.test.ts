/* oxlint-disable typescript/unbound-method -- vitest mocks of BoundTaskFlowRuntime methods (createManaged/requestCancel/get) intentionally expose vi.fn refs via the typed runtime object; not unbound class methods. */
import { describe, expect, it, vi } from "vitest";
import { createTaskFlowTools, TASKFLOW_TOOL_NAMES } from "../index.js";
import type {
  BoundTaskFlowDetailsRuntime,
  BoundTaskFlowRuntime,
  GatewayCaller,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  TaskFlowRecord,
  TaskFlowMutationResult,
  ToolEnvelope,
} from "./types.js";

type RawToolResult = Awaited<ReturnType<ReturnType<typeof createTaskFlowTools>[number]["execute"]>>;
type ToolDetails = ToolEnvelope;

function toolDetails(result: RawToolResult): ToolDetails {
  return (result as { details: ToolEnvelope }).details;
}

function expectOk(result: RawToolResult): Extract<ToolDetails, { ok: true }> {
  const details = toolDetails(result);
  if (!details.ok) {
    throw new Error(`Expected successful tool result, got ${details.error.code}`);
  }
  expect(details.ok).toBe(true);
  return details;
}

function expectError(result: RawToolResult, code: string): Extract<ToolDetails, { ok: false }> {
  const details = toolDetails(result);
  if (details.ok) {
    throw new Error(`Expected failed tool result, got success from ${details.toolName}`);
  }
  expect(details.ok).toBe(false);
  expect(details.error.code).toBe(code);
  return details;
}

function createKeyedStore() {
  const values = new Map<string, unknown>();
  return {
    lookup: vi.fn(async (key: string) => values.get(key)),
    registerIfAbsent: vi.fn(async (key: string, value: unknown) => {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    }),
  };
}

function createTaskFlowRuntime(): BoundTaskFlowRuntime {
  const flows = new Map<string, TaskFlowRecord>();
  let counter = 0;
  return {
    sessionKey: "session-owner-1",
    createManaged: vi.fn((params) => {
      const now = 1_000 + counter;
      counter += 1;
      const flow: TaskFlowRecord = {
        flowId: `flow-${counter}`,
        syncMode: "managed",
        controllerId: params.controllerId,
        revision: 1,
        status: params.status ?? "running",
        notifyPolicy: params.notifyPolicy ?? "done_only",
        goal: params.goal,
        ...(params.currentStep ? { currentStep: params.currentStep } : {}),
        ...(params.stateJson ? { stateJson: params.stateJson } : {}),
        createdAt: now,
        updatedAt: now,
      };
      flows.set(flow.flowId, flow);
      return flow;
    }),
    get: vi.fn((flowId) => flows.get(flowId)),
    list: vi.fn(() => Array.from(flows.values())),
    getTaskSummary: vi.fn(() => undefined),
    requestCancel: vi.fn((params): TaskFlowMutationResult => {
      const flow = flows.get(params.flowId);
      if (!flow) {
        return { applied: false, code: "not_found" as const };
      }
      if (flow.revision !== params.expectedRevision) {
        return { applied: false, code: "revision_conflict" as const, current: flow };
      }
      const cancelled: TaskFlowRecord = {
        ...flow,
        revision: flow.revision + 1,
        cancelRequestedAt: params.cancelRequestedAt ?? 2_000,
        updatedAt: 2_000,
      };
      flows.set(cancelled.flowId, cancelled);
      return { applied: true as const, flow: cancelled };
    }),
  };
}

function createTaskFlowDetailsRuntime(): BoundTaskFlowDetailsRuntime {
  return {
    get: vi.fn(() => undefined),
  };
}

function createHarness(
  options: {
    pluginConfig?: Record<string, unknown>;
    taskFlow?: BoundTaskFlowRuntime;
    taskFlowDetails?: BoundTaskFlowDetailsRuntime;
    gatewayCaller?: GatewayCaller;
    approvalViaGateway?: boolean;
    nowMs?: () => number;
  } = {},
) {
  const taskFlow = options.taskFlow ?? createTaskFlowRuntime();
  const taskFlowDetails = options.taskFlowDetails ?? createTaskFlowDetailsRuntime();
  const keyedStore = createKeyedStore();
  // All gated taskflow paths are deferred (durable): they carry a `durable` field and
  // resolve to a `pending_approval` acknowledgement, never a synchronous decision.
  const requestApproval = vi.fn(async () => ({
    status: "pending_approval" as const,
    id: "approval-1",
    actionHash: "sha256:test",
    expiresAtMs: 1_000,
  }));
  const api = {
    pluginConfig: options.pluginConfig ?? {},
    runtime: {
      tasks: {
        managedFlows: {
          fromToolContext: vi.fn(() => taskFlow),
        },
        flows: {
          fromToolContext: vi.fn(() => taskFlowDetails),
        },
      },
      state: {
        openKeyedStore: vi.fn(() => keyedStore),
      },
      logging: {
        getChildLogger: vi.fn(() => ({ info: vi.fn() })),
      },
    },
  } as unknown as OpenClawPluginApi;
  const ctx = {
    agentId: "agent-1",
    agentAccountId: "account-1",
    messageChannel: "telegram",
    sessionKey: "session-owner-1",
    deliveryContext: {
      channel: "telegram",
      to: "chat-1",
      accountId: "account-1",
      threadId: "topic-1",
    },
  } as unknown as OpenClawPluginToolContext;
  const tools = Object.fromEntries(
    createTaskFlowTools(
      api,
      ctx,
      options.approvalViaGateway
        ? {
            nowMs: options.nowMs,
            callGatewayTool: options.gatewayCaller,
          }
        : {
            nowMs: options.nowMs,
            requestApproval,
            callGatewayTool: options.gatewayCaller,
          },
    ).map((tool) => [tool.name, tool]),
  );
  return {
    api,
    ctx,
    taskFlow,
    taskFlowDetails,
    keyedStore,
    requestApproval,
    tools,
  };
}

describe("taskflow-tools trusted plugin", () => {
  it("exposes only the narrow TaskFlow and schedule wrappers", () => {
    expect([...TASKFLOW_TOOL_NAMES].toSorted()).toEqual([
      "taskflow_create_managed",
      "taskflow_get_own",
      "taskflow_list_own",
      "taskflow_list_schedules",
      "taskflow_request_cancel",
      "taskflow_request_schedule",
      "taskflow_request_schedule_cancel",
    ]);
  });

  it("creates a managed flow inline without approval (never gated), visible to list/get", async () => {
    // Managed-flow creation is owner-delegated one-shot work, never gated — even with
    // requireCreateApproval on (the default) it is created inline, not deferred.
    const harness = createHarness();

    const created = expectOk(
      await harness.tools.taskflow_create_managed.execute("create-1", {
        goal: "Prepare the quarterly report",
        currentStep: "Collect inputs",
        stateJson: { owner: "finance", phase: "draft" },
        idempotencyKey: "report-q1",
      }),
    );

    expect(harness.requestApproval).not.toHaveBeenCalled();
    expect(harness.taskFlow.createManaged).toHaveBeenCalledWith(
      expect.objectContaining({
        controllerId: "taskflow-tools/agent",
        goal: "Prepare the quarterly report",
      }),
    );

    const flowId = created.flowId;
    expect(flowId).toBe("flow-1");
    expect(
      (created.result as { flow: { stateJson: Record<string, unknown> } }).flow.stateJson.phase,
    ).toBe("draft");

    const listed = expectOk(await harness.tools.taskflow_list_own.execute("list-1", {}));
    expect((listed.result as { total: number }).total).toBe(1);

    const got = expectOk(await harness.tools.taskflow_get_own.execute("get-1", { flowId }));
    expect(got.flowId).toBe(flowId);
  });

  it("includes sanitized linked task details on get results when runtime details are available", async () => {
    const harness = createHarness({ pluginConfig: { requireCreateApproval: false } });
    const created = expectOk(
      await harness.tools.taskflow_create_managed.execute("create-detail", {
        goal: "Track linked child",
        idempotencyKey: "detail-flow",
      }),
    );
    vi.mocked(harness.taskFlowDetails.get).mockReturnValue({
      tasks: [
        {
          id: "task-1",
          runtime: "subagent",
          sourceId: "linked-spawn:stable",
          sessionKey: "session-owner-1",
          ownerKey: "session-owner-1",
          scope: "session",
          childSessionKey: "agent:main:subagent:child",
          flowId: created.flowId ?? "",
          agentId: "main",
          runId: "linked-run-1",
          taskName: "flowlink_smoke_child",
          label: "FlowLink smoke child",
          title: "Run linked child",
          status: "succeeded",
          deliveryStatus: "delivered",
          notifyPolicy: "state_changes",
          createdAt: 1_000,
          endedAt: 2_000,
          terminalSummary: "FLOWLINK_CHILD_OK",
        },
      ],
    });

    const got = expectOk(
      await harness.tools.taskflow_get_own.execute("get-detail", { flowId: created.flowId }),
    );
    const flow = (got.result as { flow: { tasks?: Array<Record<string, unknown>> } }).flow;

    expect(flow.tasks).toEqual([
      expect.objectContaining({
        id: "task-1",
        runtime: "subagent",
        flowId: created.flowId,
        childSessionKey: "agent:main:subagent:child",
        runId: "linked-run-1",
        taskName: "flowlink_smoke_child",
        label: "FlowLink smoke child",
        status: "succeeded",
      }),
    ]);
  });

  it("defers a managed flow cancellation behind a durable approval (revisionless)", async () => {
    const harness = createHarness();
    const created = expectOk(
      await harness.tools.taskflow_create_managed.execute("create-cancel-target", {
        goal: "Cancelable flow",
        idempotencyKey: "cancel-target",
      }),
    );
    harness.requestApproval.mockClear();

    const result = expectOk(
      await harness.tools.taskflow_request_cancel.execute("cancel-1", {
        flowId: created.flowId,
        expectedRevision: created.revision,
        idempotencyKey: "cancel-target-request",
      }),
    );

    expect(harness.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "taskflow_request_cancel",
        title: "Cancel managed TaskFlow",
        durable: expect.objectContaining({
          kind: "taskflow.managed.cancel",
          // Revisionless: only the flow id is captured; the gateway cancels current state.
          action: { flowId: created.flowId },
        }),
      }),
    );
    // Deferred: no inline requestCancel — the gateway cancels on approval.
    expect(harness.taskFlow.requestCancel).not.toHaveBeenCalled();
    expect((result.result as { status: string }).status).toBe("pending_approval");
  });

  it("defers a scheduled task behind a durable approval instead of adding cron inline", async () => {
    const gatewayCaller = vi.fn<GatewayCaller>();
    const harness = createHarness({
      gatewayCaller,
      nowMs: () => Date.parse("2026-05-23T11:00:00.000Z"),
    });

    const result = expectOk(
      await harness.tools.taskflow_request_schedule.execute("schedule-1", {
        taskType: "reminder",
        title: "Standup reminder",
        message: "Ask me whether the standup notes are sent.",
        recurrence: { kind: "once", at: "2026-05-23T12:00:00Z" },
        idempotencyKey: "standup-reminder",
      }),
    );

    expect(harness.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "taskflow_request_schedule",
        description: expect.stringContaining("Schedule: once at 2026-05-23T12:00:00.000Z"),
        durable: expect.objectContaining({
          kind: "taskflow.schedule.create",
          idempotencyKey: "schedule-1",
          action: expect.objectContaining({
            name: "Standup reminder",
            schedule: { kind: "at", at: "2026-05-23T12:00:00.000Z" },
          }),
        }),
      }),
    );
    // Deferred: cron is not touched inline; the gateway adds the job on approval.
    expect(gatewayCaller).not.toHaveBeenCalled();
    expect((result.result as { status: string }).status).toBe("pending_approval");
  });

  it("lists schedules through sanitized cron.list requests", async () => {
    const gatewayCaller = vi.fn<GatewayCaller>(async (method, _options, params) => {
      expect(method).toBe("cron.list");
      expect(params).toEqual({
        limit: 10,
        offset: 5,
        query: "worker",
        enabled: "all",
        sortBy: "updatedAtMs",
        sortDir: "desc",
      });
      return {
        jobs: [
          {
            id: "cron-1",
            name: "Worker tick",
            schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
            payload: { kind: "agentTurn", message: "hidden" },
            delivery: { channel: "telegram", to: "chat-1" },
            state: "scheduled",
          },
        ],
        total: 1,
        limit: 10,
        offset: 5,
      };
    });
    const harness = createHarness({ gatewayCaller });

    const listed = expectOk(
      await harness.tools.taskflow_list_schedules.execute("schedule-list-1", {
        limit: 10,
        offset: 5,
        query: "worker",
        enabled: "all",
        sortBy: "updatedAtMs",
        sortDir: "desc",
      }),
    );

    expect(harness.requestApproval).not.toHaveBeenCalled();
    expect(gatewayCaller).toHaveBeenCalledOnce();
    const jobs = (listed.result as { jobs: Array<Record<string, unknown>> }).jobs;
    expect(jobs[0]).toMatchObject({ id: "cron-1", name: "Worker tick" });
    expect(jobs[0]).not.toHaveProperty("payload");
  });

  it("defers a schedule cancellation behind a durable approval", async () => {
    const gatewayCaller = vi.fn<GatewayCaller>();
    const harness = createHarness({ gatewayCaller });

    const result = expectOk(
      await harness.tools.taskflow_request_schedule_cancel.execute("schedule-cancel-1", {
        scheduleId: "cron-1",
        idempotencyKey: "cancel-cron-1",
      }),
    );

    expect(harness.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "taskflow_request_schedule_cancel",
        title: "Cancel scheduled agent task",
        durable: expect.objectContaining({
          kind: "taskflow.schedule.cancel",
          action: { scheduleId: "cron-1" },
        }),
      }),
    );
    // Deferred: cron is not touched inline; the gateway removes the job on approval.
    expect(gatewayCaller).not.toHaveBeenCalled();
    expect((result.result as { status: string }).status).toBe("pending_approval");
  });

  it("rejects unsafe schedule recurrence before approval or cron", async () => {
    const gatewayCaller = vi.fn<GatewayCaller>();
    const harness = createHarness({
      gatewayCaller,
      nowMs: () => Date.parse("2026-05-23T11:00:00.000Z"),
    });

    expectError(
      await harness.tools.taskflow_request_schedule.execute("schedule-bad", {
        taskType: "agent_task",
        message: "Run too often",
        recurrence: { kind: "cron", expr: "* * * * *", timezone: "UTC" },
        idempotencyKey: "too-often",
      }),
      "cron_too_frequent",
    );

    expect(harness.requestApproval).not.toHaveBeenCalled();
    expect(gatewayCaller).not.toHaveBeenCalled();
  });
});
