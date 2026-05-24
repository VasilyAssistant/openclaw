// Lobster tests cover lobster tool plugin behavior.
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../runtime-api.js";
import { createLobsterManagedWorkflowTool } from "./lobster-managed-workflow-tool.js";
import { createLobsterTool } from "./lobster-tool.js";
import { createFakeTaskFlow } from "./taskflow-test-helpers.js";

function fakeApi(overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi {
  return createTestPluginApi({
    id: "lobster",
    name: "lobster",
    source: "test",
    runtime: { version: "test" } as any,
    resolvePath: (p) => p,
    ...overrides,
  });
}

function fakeCtx(overrides: Partial<OpenClawPluginToolContext> = {}): OpenClawPluginToolContext {
  return {
    config: {},
    workspaceDir: "/tmp",
    agentDir: "/tmp",
    agentId: "main",
    sessionKey: "main",
    messageChannel: undefined,
    agentAccountId: undefined,
    sandboxed: false,
    ...overrides,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

class MemoryStore<T> {
  readonly entries = new Map<string, T>();

  async register(key: string, value: T): Promise<void> {
    this.entries.set(key, value);
  }

  async registerIfAbsent(key: string, value: T): Promise<boolean> {
    if (this.entries.has(key)) {
      return false;
    }
    this.entries.set(key, value);
    return true;
  }

  async lookup(key: string): Promise<T | undefined> {
    return this.entries.get(key);
  }
}

describe("lobster plugin tool", () => {
  it("returns the Lobster envelope in details", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [{ hello: "world" }],
        requiresApproval: null,
      }),
    };

    const tool = createLobsterTool(fakeApi(), { runner });
    const res = await tool.execute("call1", {
      action: "run",
      pipeline: "noop",
      timeoutMs: 1000,
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      cwd: process.cwd(),
      timeoutMs: 1000,
      maxStdoutBytes: 512_000,
    });
    const details = requireRecord(res.details, "lobster tool details");
    expect(details.ok).toBe(true);
    expect(details.status).toBe("ok");
    expect(details.output).toEqual([{ hello: "world" }]);
    expect(details.requiresApproval).toBeNull();
  });

  it("supports approval envelopes without changing the tool contract", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "needs_approval",
        output: [],
        requiresApproval: {
          type: "approval_request",
          prompt: "Send these alerts?",
          items: [{ id: "alert-1" }],
          resumeToken: "resume-token-1",
        },
      }),
    };

    const tool = createLobsterTool(fakeApi(), { runner });
    const res = await tool.execute("call-injected-runner", {
      action: "run",
      pipeline: "noop",
      argsJson: '{"since_hours":1}',
      timeoutMs: 1500,
      maxStdoutBytes: 4096,
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      argsJson: '{"since_hours":1}',
      cwd: process.cwd(),
      timeoutMs: 1500,
      maxStdoutBytes: 4096,
    });
    const details = requireRecord(res.details, "approval lobster tool details");
    expect(details.ok).toBe(true);
    expect(details.status).toBe("needs_approval");
    const approval = requireRecord(details.requiresApproval, "approval request");
    expect(approval.type).toBe("approval_request");
    expect(approval.prompt).toBe("Send these alerts?");
    expect(approval.resumeToken).toBe("resume-token-1");
  });

  it("normalizes numeric string run limits before invoking the runner", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
    };

    const tool = createLobsterTool(fakeApi(), { runner });
    await tool.execute("call-string-limits", {
      action: "run",
      pipeline: "noop",
      timeoutMs: "1500",
      maxStdoutBytes: "4096",
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      cwd: process.cwd(),
      timeoutMs: 1500,
      maxStdoutBytes: 4096,
    });
  });

  it("rejects malformed numeric run limits before invoking the runner", async () => {
    const runner = { run: vi.fn() };
    const tool = createLobsterTool(fakeApi(), { runner });

    await expect(
      tool.execute("call-bad-timeout", {
        action: "run",
        pipeline: "noop",
        timeoutMs: "1500.5",
      }),
    ).rejects.toThrow("timeoutMs must be a positive integer");
    await expect(
      tool.execute("call-bad-stdout", {
        action: "run",
        pipeline: "noop",
        maxStdoutBytes: 0,
      }),
    ).rejects.toThrow("maxStdoutBytes must be a positive integer");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("throws when the runner returns an error envelope", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: {
        run: vi.fn().mockResolvedValue({
          ok: false,
          error: {
            type: "runtime_error",
            message: "boom",
          },
        }),
      },
    });

    await expect(
      tool.execute("call-runner-error", {
        action: "run",
        pipeline: "noop",
      }),
    ).rejects.toThrow("boom");
  });

  it("can run through managed TaskFlow mode", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "needs_approval",
        output: [],
        requiresApproval: {
          type: "approval_request",
          prompt: "Approve this?",
          items: [{ id: "item-1" }],
          resumeToken: "resume-1",
          approvalId: "approval-1",
        },
      }),
    };
    const taskFlow = createFakeTaskFlow();

    const tool = createLobsterTool(fakeApi(), { runner, taskFlow });
    const res = await tool.execute("call-managed-run", {
      action: "run",
      pipeline: "noop",
      flowControllerId: "tests/lobster",
      flowGoal: "Run Lobster workflow",
      flowStateJson: '{"lane":"email"}',
      flowCurrentStep: "run_lobster",
      flowWaitingStep: "await_review",
    });

    expect(taskFlow.createManaged).toHaveBeenCalledWith({
      controllerId: "tests/lobster",
      goal: "Run Lobster workflow",
      currentStep: "run_lobster",
      stateJson: { lane: "email" },
    });
    expect(taskFlow.setWaiting).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 1,
      currentStep: "await_review",
      waitJson: {
        kind: "lobster_approval",
        prompt: "Approve this?",
        items: [{ id: "item-1" }],
        resumeToken: "resume-1",
        approvalId: "approval-1",
      },
    });
    const details = requireRecord(res.details, "managed run lobster tool details");
    expect(details.ok).toBe(true);
    expect(details.status).toBe("needs_approval");
    const flow = requireRecord(details.flow, "managed run flow details");
    expect(flow.flowId).toBe("flow-1");
    const mutation = requireRecord(details.mutation, "managed run mutation details");
    expect(mutation.applied).toBe(true);
  });

  it("rejects managed TaskFlow params when no bound taskFlow runtime is available", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });

    await expect(
      tool.execute("call-missing-taskflow", {
        action: "run",
        pipeline: "noop",
        flowControllerId: "tests/lobster",
        flowGoal: "Run Lobster workflow",
      }),
    ).rejects.toThrow(/Managed TaskFlow run mode requires a bound taskFlow runtime/);
  });

  it("rejects invalid flowStateJson in managed TaskFlow mode", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
      taskFlow: createFakeTaskFlow(),
    });

    await expect(
      tool.execute("call-invalid-flow-json", {
        action: "run",
        pipeline: "noop",
        flowControllerId: "tests/lobster",
        flowGoal: "Run Lobster workflow",
        flowStateJson: "{bad",
      }),
    ).rejects.toThrow(/flowStateJson must be valid JSON/);
  });

  it("can resume managed TaskFlow mode with only approvalId", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
    };
    const taskFlow = createFakeTaskFlow();
    const tool = createLobsterTool(fakeApi(), { runner, taskFlow });

    const res = await tool.execute("call-managed-resume-approval-id", {
      action: "resume",
      approvalId: "approval-1",
      approve: true,
      flowId: "flow-1",
      flowExpectedRevision: 1,
      flowCurrentStep: "resume_lobster",
    });

    expect(taskFlow.resume).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 1,
      status: "running",
      currentStep: "resume_lobster",
    });
    expect(runner.run).toHaveBeenCalledWith({
      action: "resume",
      approvalId: "approval-1",
      approve: true,
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxStdoutBytes: 512_000,
    });
    const details = requireRecord(res.details, "managed resume lobster tool details");
    expect(details.ok).toBe(true);
    expect(details.status).toBe("ok");
    const mutation = requireRecord(details.mutation, "managed resume mutation details");
    expect(mutation.applied).toBe(true);
  });

  it("normalizes numeric string flowExpectedRevision before managed resume", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
    };
    const taskFlow = createFakeTaskFlow();
    const tool = createLobsterTool(fakeApi(), { runner, taskFlow });

    await tool.execute("call-managed-resume-string-revision", {
      action: "resume",
      approvalId: "approval-1",
      approve: true,
      flowId: "flow-1",
      flowExpectedRevision: "1",
      flowCurrentStep: "resume_lobster",
    });

    expect(taskFlow.resume).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 1,
      status: "running",
      currentStep: "resume_lobster",
    });
  });

  it("rejects managed TaskFlow resume mode without a token or approvalId", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
      taskFlow: createFakeTaskFlow(),
    });

    await expect(
      tool.execute("call-missing-resume-token", {
        action: "resume",
        flowId: "flow-1",
        flowExpectedRevision: 1,
        approve: true,
      }),
    ).rejects.toThrow(/token or approvalId required when using managed TaskFlow resume mode/);
  });

  it("rejects managed TaskFlow resume mode without approve", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
      taskFlow: createFakeTaskFlow(),
    });

    await expect(
      tool.execute("call-missing-resume-approve", {
        action: "resume",
        token: "resume-token",
        flowId: "flow-1",
        flowExpectedRevision: 1,
      }),
    ).rejects.toThrow(/approve required when using managed TaskFlow resume mode/);
  });

  it("requires action", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(tool.execute("call-action-missing", {})).rejects.toThrow(/action required/);
  });

  it("rejects unknown action", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(
      tool.execute("call-action-unknown", {
        action: "explode",
      }),
    ).rejects.toThrow(/Unknown action/);
  });

  it("rejects absolute cwd", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(
      tool.execute("call-absolute-cwd", {
        action: "run",
        pipeline: "noop",
        cwd: "/tmp",
      }),
    ).rejects.toThrow(/cwd must be a relative path/);
  });

  it("rejects cwd that escapes the gateway working directory", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(
      tool.execute("call-escape-cwd", {
        action: "run",
        pipeline: "noop",
        cwd: "../../etc",
      }),
    ).rejects.toThrow(/must stay within/);
  });

  it("can be gated off in sandboxed contexts", () => {
    const api = fakeApi();
    const factoryTool = (ctx: OpenClawPluginToolContext) => {
      if (ctx.sandboxed) {
        return null;
      }
      return createLobsterTool(api, {
        runner: { run: vi.fn() },
      });
    };

    expect(factoryTool(fakeCtx({ sandboxed: true }))).toBeNull();
    expect(factoryTool(fakeCtx({ sandboxed: false }))?.name).toBe("lobster");
  });
});

describe("lobster managed workflow tool", () => {
  function managedApi(config: Record<string, unknown>) {
    return fakeApi({
      pluginConfig: {
        managedWorkflows: {
          "task/create": {
            pipeline: "tasks.preview | approve --prompt 'Create task?' | tasks.create",
            goal: "Create a task after approval",
            allowSandboxed: true,
            approvalMode: "taskflow",
            ...config,
          },
        },
      },
    });
  }

  it("is exposed even when no named workflows are configured", async () => {
    const tool = createLobsterManagedWorkflowTool(
      fakeApi({ pluginConfig: { managedWorkflows: {} } }),
      fakeCtx({ sandboxed: true }),
      {
        runner: { run: vi.fn() },
        taskFlow: createFakeTaskFlow(),
        idempotencyStore: new MemoryStore<any>(),
      },
    );

    expect(tool?.name).toBe("lobster_managed_workflow");
    await expect(
      tool?.execute("call-unconfigured-workflow", {
        action: "run",
        workflowId: "task/create",
        idempotencyKey: "telegram:1",
      }),
    ).rejects.toThrow(/not configured/);
  });

  it("runs a configured managed workflow from sandbox when explicitly allowed", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [{ id: "task-1" }],
        requiresApproval: null,
      }),
    };
    const taskFlow = createFakeTaskFlow();
    const store = new MemoryStore<any>();
    const tool = createLobsterManagedWorkflowTool(
      managedApi({ approvalMode: "taskflow" }),
      fakeCtx({ sandboxed: true }),
      { runner, taskFlow, idempotencyStore: store },
    );

    const res = await tool?.execute("call-managed-workflow", {
      action: "run",
      workflowId: "task/create",
      idempotencyKey: "telegram:1",
      argsJson: '{"title":"Call client"}',
    });

    expect(tool?.name).toBe("lobster_managed_workflow");
    expect(taskFlow.createManaged).toHaveBeenCalledWith({
      controllerId: "lobster/task/create",
      goal: "Create a task after approval",
      currentStep: "run_lobster",
    });
    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "tasks.preview | approve --prompt 'Create task?' | tasks.create",
      argsJson: '{"title":"Call client"}',
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxStdoutBytes: 512_000,
    });
    const details = requireRecord(res?.details, "managed workflow details");
    expect(details.status).toBe("ok");
  });

  it("rejects sandboxed callers unless the named workflow opts in", async () => {
    const tool = createLobsterManagedWorkflowTool(
      managedApi({ allowSandboxed: false }),
      fakeCtx({ sandboxed: true }),
      {
        runner: { run: vi.fn() },
        taskFlow: createFakeTaskFlow(),
        idempotencyStore: new MemoryStore<any>(),
      },
    );

    await expect(
      tool?.execute("call-managed-workflow", {
        action: "run",
        workflowId: "task/create",
        idempotencyKey: "telegram:1",
      }),
    ).rejects.toThrow(/not allowed from sandboxed sessions/);
  });

  it("can bridge Lobster approval through plugin approval and resume the flow", async () => {
    const runner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: "needs_approval",
          output: [],
          requiresApproval: {
            type: "approval_request",
            prompt: "Create task?",
            items: [{ title: "Call client" }],
            approvalId: "lobster-approval-1",
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: "ok",
          output: [{ id: "task-1" }],
          requiresApproval: null,
        }),
    };
    const taskFlow = createFakeTaskFlow({
      runTask: vi.fn().mockImplementation((input: Record<string, unknown>) => ({
        created: true,
        flow: {
          flowId: "flow-1",
          revision: 4,
          syncMode: "managed" as const,
          controllerId: "tests/lobster",
          ownerKey: "agent:main:main",
          status: "running" as const,
          goal: "Run Lobster workflow",
        },
        task: {
          taskId: "task-1",
          runtime: input.runtime,
          sourceId: input.sourceId,
          requesterSessionKey: "agent:main:main",
          ownerKey: "agent:main:main",
          scopeKind: "session" as const,
          parentFlowId: input.flowId,
          runId: input.runId,
          label: input.label,
          task: input.task,
          status: input.status ?? "queued",
          deliveryStatus: input.deliveryStatus ?? "pending",
          notifyPolicy: input.notifyPolicy ?? "done_only",
          createdAt: 1,
        },
      })),
    });
    const callGatewayTool = vi.fn(async (method: string) => {
      if (method === "plugin.approval.request") {
        return { id: "plugin-approval-1" };
      }
      if (method === "plugin.approval.waitDecision") {
        return { id: "plugin-approval-1", decision: "allow-once" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const tool = createLobsterManagedWorkflowTool(
      managedApi({
        approvalMode: "plugin-inline",
        onApproved: {
          type: "runTask",
          runtime: "subagent",
          taskTemplate: "Create task: {{title}}",
          labelTemplate: "{{title}}",
          sourceIdTemplate: "source:{{idempotencyKey}}",
          runIdTemplate: "run:{{idempotencyKey}}",
          notifyPolicy: "state_changes",
        },
      }),
      fakeCtx({ sandboxed: true }),
      {
        runner,
        taskFlow,
        callGatewayTool,
        idempotencyStore: new MemoryStore<any>(),
      },
    );

    const res = await tool?.execute("call-managed-workflow-approval", {
      action: "run",
      workflowId: "task/create",
      idempotencyKey: "telegram:1",
      argsJson: '{"title":"Call client"}',
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      { timeoutMs: 130_000 },
      expect.objectContaining({
        pluginId: "lobster",
        toolName: "lobster_managed_workflow",
        allowedDecisions: ["allow-once", "deny"],
        description: expect.stringContaining("Create task: Call client"),
        sessionKey: "main",
      }),
      { expectFinal: false },
    );
    expect(taskFlow.resume).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 2,
      status: "running",
      currentStep: "resume_lobster",
    });
    expect(runner.run).toHaveBeenLastCalledWith({
      action: "resume",
      approvalId: "lobster-approval-1",
      approve: true,
      argsJson: '{"title":"Call client"}',
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxStdoutBytes: 512_000,
    });
    expect(taskFlow.runTask).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 3,
      runtime: "subagent",
      task: "Create task: Call client",
      status: "queued",
      label: "Call client",
      sourceId: "source:telegram:1",
      runId: "run:telegram:1",
      notifyPolicy: "state_changes",
    });
    expect(taskFlow.finish).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 4,
    });
    const details = requireRecord(res?.details, "managed workflow approval details");
    expect(details.status).toBe("ok");
    const flow = requireRecord(details.flow, "managed workflow completed flow");
    expect(flow.revision).toBe(5);
    const approval = requireRecord(details.approval, "managed workflow approval bridge");
    expect(approval.status).toBe("approved");
    const sideEffect = requireRecord(details.sideEffect, "approved workflow side effect");
    expect(sideEffect.type).toBe("runTask");
    const task = requireRecord(sideEffect.task, "approved child task");
    expect(task.taskId).toBe("task-1");
    expect(task.parentFlowId).toBe("flow-1");
  });

  it("runs the approved task side effect when a managed workflow is manually resumed", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [{ id: "task-1" }],
        requiresApproval: null,
      }),
    };
    const taskFlow = createFakeTaskFlow({
      runTask: vi.fn().mockImplementation((input: Record<string, unknown>) => ({
        created: true,
        flow: {
          flowId: "flow-1",
          revision: 4,
          syncMode: "managed" as const,
          controllerId: "tests/lobster",
          ownerKey: "agent:main:main",
          status: "running" as const,
          goal: "Run Lobster workflow",
        },
        task: {
          taskId: "task-1",
          runtime: input.runtime,
          sourceId: input.sourceId,
          requesterSessionKey: "agent:main:main",
          ownerKey: "agent:main:main",
          scopeKind: "session" as const,
          parentFlowId: input.flowId,
          runId: input.runId,
          label: input.label,
          task: input.task,
          status: input.status ?? "queued",
          deliveryStatus: input.deliveryStatus ?? "pending",
          notifyPolicy: input.notifyPolicy ?? "done_only",
          createdAt: 1,
        },
      })),
    });
    const tool = createLobsterManagedWorkflowTool(
      managedApi({
        approvalMode: "plugin-inline",
        onApproved: {
          type: "runTask",
          runtime: "subagent",
          taskTemplate: "Create task: {{title}}\n{{description}}",
          labelTemplate: "{{title}}",
          sourceIdTemplate: "source:{{idempotencyKey}}",
          runIdTemplate: "run:{{idempotencyKey}}",
          notifyPolicy: "state_changes",
        },
      }),
      fakeCtx({ sandboxed: true }),
      {
        runner,
        taskFlow,
        idempotencyStore: new MemoryStore<any>(),
      },
    );

    const res = await tool?.execute("call-managed-workflow-manual-resume", {
      action: "resume",
      workflowId: "task/create",
      flowId: "flow-1",
      flowExpectedRevision: 2,
      approvalId: "lobster-approval-1",
      approve: true,
      idempotencyKey: "telegram:manual",
      argsJson: '{"title":"Call client","description":"Bring agenda"}',
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "resume",
      approvalId: "lobster-approval-1",
      approve: true,
      argsJson: '{"title":"Call client","description":"Bring agenda"}',
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxStdoutBytes: 512_000,
    });
    expect(taskFlow.runTask).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 3,
      runtime: "subagent",
      task: "Create task: Call client\nBring agenda",
      status: "queued",
      label: "Call client",
      sourceId: "source:telegram:manual",
      runId: "run:telegram:manual",
      notifyPolicy: "state_changes",
    });
    expect(taskFlow.finish).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 4,
    });
    const details = requireRecord(res?.details, "manual managed workflow resume details");
    expect(details.status).toBe("ok");
    const sideEffect = requireRecord(details.sideEffect, "manual resume side effect");
    expect(sideEffect.type).toBe("runTask");
    const task = requireRecord(sideEffect.task, "manual resume child task");
    expect(task.taskId).toBe("task-1");
    expect(task.parentFlowId).toBe("flow-1");
  });

  it("does not run an approved task side effect when Lobster resume is cancelled", async () => {
    const runner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: "needs_approval",
          output: [],
          requiresApproval: {
            type: "approval_request",
            prompt: "Create task?",
            items: [{ title: "Call client" }],
            approvalId: "lobster-approval-1",
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: "cancelled",
          output: [],
          requiresApproval: null,
        }),
    };
    const taskFlow = createFakeTaskFlow({ runTask: vi.fn() });
    const callGatewayTool = vi.fn(async (method: string) => {
      if (method === "plugin.approval.request") {
        return { id: "plugin-approval-1" };
      }
      if (method === "plugin.approval.waitDecision") {
        return { id: "plugin-approval-1", decision: "allow-once" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const tool = createLobsterManagedWorkflowTool(
      managedApi({
        approvalMode: "plugin-inline",
        onApproved: {
          type: "runTask",
          runtime: "subagent",
          taskTemplate: "Create task: {{title}}",
        },
      }),
      fakeCtx({ sandboxed: true }),
      {
        runner,
        taskFlow,
        callGatewayTool,
        idempotencyStore: new MemoryStore<any>(),
      },
    );

    const res = await tool?.execute("call-managed-workflow-cancelled", {
      action: "run",
      workflowId: "task/create",
      idempotencyKey: "telegram:cancelled",
      argsJson: '{"title":"Call client"}',
    });

    expect(taskFlow.runTask).not.toHaveBeenCalled();
    const details = requireRecord(res?.details, "managed workflow cancelled details");
    expect(details.status).toBe("cancelled");
    expect(details.sideEffect).toBeUndefined();
  });

  it("returns an idempotent replay without creating another flow", async () => {
    const store = new MemoryStore<any>();
    await store.register("task/create:telegram:1", {
      workflowId: "task/create",
      idempotencyKey: "telegram:1",
      status: "waiting",
      flowId: "flow-1",
      revision: 2,
      updatedAtMs: 1,
    });
    const taskFlow = createFakeTaskFlow();
    const tool = createLobsterManagedWorkflowTool(
      managedApi({ approvalMode: "taskflow" }),
      fakeCtx({ sandboxed: true }),
      {
        runner: { run: vi.fn() },
        taskFlow,
        idempotencyStore: store,
      },
    );

    const res = await tool?.execute("call-managed-workflow-replay", {
      action: "run",
      workflowId: "task/create",
      idempotencyKey: "telegram:1",
    });

    expect(taskFlow.createManaged).not.toHaveBeenCalled();
    const details = requireRecord(res?.details, "managed workflow replay details");
    expect(details.status).toBe("idempotent_replay");
  });
});
