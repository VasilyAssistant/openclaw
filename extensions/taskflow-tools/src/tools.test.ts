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
    approvalDecision?: "allow-once" | "deny";
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
  const requestApproval = vi.fn(async () => ({ id: "approval-1" }));
  const waitApprovalDecision = vi.fn(async () => ({
    id: "approval-1",
    decision: options.approvalDecision ?? "allow-once",
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
            waitApprovalDecision,
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
    waitApprovalDecision,
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

  it("requires approval before creating a managed flow and makes it visible to list/get", async () => {
    const harness = createHarness();

    const created = expectOk(
      await harness.tools.taskflow_create_managed.execute("create-1", {
        goal: "Prepare the quarterly report",
        currentStep: "Collect inputs",
        stateJson: { owner: "finance", phase: "draft" },
        idempotencyKey: "report-q1",
      }),
    );

    expect(harness.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "taskflow-tools",
        toolName: "taskflow_create_managed",
        allowedDecisions: ["allow-once", "deny"],
        twoPhase: true,
      }),
    );
    expect(harness.waitApprovalDecision).toHaveBeenCalledWith("approval-1");
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

  it("keeps gateway approval waits below the outer agent tool timeout", async () => {
    const gatewayCaller = vi.fn<GatewayCaller>(async (method) => {
      if (method === "plugin.approval.request") {
        return { id: "approval-1" };
      }
      if (method === "plugin.approval.waitDecision") {
        return { id: "approval-1", decision: "allow-once" };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    });
    const harness = createHarness({ approvalViaGateway: true, gatewayCaller });

    expectOk(
      await harness.tools.taskflow_create_managed.execute("create-gateway-approval", {
        goal: "Create with gateway approval",
        idempotencyKey: "gateway-approval-create",
      }),
    );

    expect(gatewayCaller).toHaveBeenNthCalledWith(
      1,
      "plugin.approval.request",
      { timeoutMs: 85_000 },
      expect.objectContaining({
        timeoutMs: 75_000,
        twoPhase: true,
      }),
      { expectFinal: false },
    );
    expect(gatewayCaller).toHaveBeenNthCalledWith(
      2,
      "plugin.approval.waitDecision",
      { timeoutMs: 85_000 },
      { id: "approval-1" },
    );
    expect((gatewayCaller.mock.calls[0][2] as { timeoutMs?: number }).timeoutMs).toBeLessThan(
      90_000,
    );
    expect(gatewayCaller.mock.calls[1][1].timeoutMs).toBeLessThan(90_000);
  });

  it("includes sanitized linked task details on get results when runtime details are available", async () => {
    const harness = createHarness();
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

  it("does not create a flow when approval is denied", async () => {
    const harness = createHarness({ approvalDecision: "deny" });

    expectError(
      await harness.tools.taskflow_create_managed.execute("create-denied", {
        goal: "Do not create this",
        idempotencyKey: "denied-create",
      }),
      "approval_not_granted",
    );

    expect(harness.taskFlow.createManaged).not.toHaveBeenCalled();
  });

  it("requires approval before requesting managed flow cancellation", async () => {
    const harness = createHarness();
    const created = expectOk(
      await harness.tools.taskflow_create_managed.execute("create-cancel-target", {
        goal: "Cancelable flow",
        idempotencyKey: "cancel-target",
      }),
    );
    harness.requestApproval.mockClear();
    harness.waitApprovalDecision.mockClear();

    const cancelled = expectOk(
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
        allowedDecisions: ["allow-once", "deny"],
      }),
    );
    expect(harness.waitApprovalDecision).toHaveBeenCalledWith("approval-1");
    expect(harness.taskFlow.requestCancel).toHaveBeenCalledWith({
      flowId: created.flowId,
      expectedRevision: created.revision,
    });
    expect(cancelled.revision).toBe(2);
  });

  it("creates approved schedules through validated cron.add requests", async () => {
    const gatewayCaller = vi.fn<GatewayCaller>(async (method, _options, params) => {
      expect(method).toBe("cron.add");
      expect(params).toEqual({
        job: expect.objectContaining({
          name: "Standup reminder",
          schedule: { kind: "at", at: "2026-05-23T12:00:00.000Z" },
          sessionTarget: "isolated",
          wakeMode: "now",
          deleteAfterRun: true,
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "chat-1",
            accountId: "account-1",
            threadId: "topic-1",
          },
        }),
      });
      return {
        id: "cron-1",
        name: "Standup reminder",
        schedule: { kind: "at", at: "2026-05-23T12:00:00.000Z" },
        payload: { kind: "agentTurn", message: "hidden" },
        delivery: { channel: "telegram", to: "chat-1" },
        state: "scheduled",
      };
    });
    const harness = createHarness({
      gatewayCaller,
      nowMs: () => Date.parse("2026-05-23T11:00:00.000Z"),
    });

    const scheduled = expectOk(
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
      }),
    );
    expect(gatewayCaller).toHaveBeenCalledOnce();
    expect((scheduled.result as { cronJob: Record<string, unknown> }).cronJob).toMatchObject({
      id: "cron-1",
    });
    expect((scheduled.result as { cronJob: Record<string, unknown> }).cronJob).not.toHaveProperty(
      "payload",
    );
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

  it("requires approval before cancelling a schedule through cron.remove", async () => {
    const gatewayCaller = vi.fn<GatewayCaller>(async (method, _options, params) => {
      expect(method).toBe("cron.remove");
      expect(params).toEqual({ id: "cron-1" });
      return { removed: true, id: "cron-1" };
    });
    const harness = createHarness({ gatewayCaller });

    const cancelled = expectOk(
      await harness.tools.taskflow_request_schedule_cancel.execute("schedule-cancel-1", {
        scheduleId: "cron-1",
        idempotencyKey: "cancel-cron-1",
      }),
    );

    expect(harness.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "taskflow_request_schedule_cancel",
        title: "Cancel scheduled agent task",
        description: expect.stringContaining("cron-1"),
      }),
    );
    expect(gatewayCaller).toHaveBeenCalledOnce();
    expect(cancelled.result).toEqual({
      scheduleId: "cron-1",
      cronResult: { removed: true, id: "cron-1" },
    });
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
