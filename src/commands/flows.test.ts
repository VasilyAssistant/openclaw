// Flows command tests cover task creation, task execution, and runtime command output.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { createRunningTaskRun as createRunningTaskRunOrNull } from "../tasks/task-executor.js";
import {
  createManagedTaskFlow as createManagedTaskFlowOrNull,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-registry.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import {
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-registry.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { captureEnv } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  flowsCancelCommand,
  flowsCreateManagedCommand,
  flowsFinalizeRunCommand,
  flowsFinishCommand,
  flowsListCommand,
  flowsRequestCancelCommand,
  flowsRunTaskCommand,
  flowsShowCommand,
  flowsUpdateStateCommand,
} from "./flows.js";

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
  loadConfig: vi.fn(() => ({})),
  resetConfigRuntimeState: () => undefined,
}));

function jsonRoundTrip<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return JSON.parse(serialized) as T;
}

function createManagedTaskFlow(
  params: Parameters<typeof createManagedTaskFlowOrNull>[0],
): TaskFlowRecord {
  const flow = createManagedTaskFlowOrNull(params);
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

function createRunningTaskRun(
  params: Parameters<typeof createRunningTaskRunOrNull>[0],
): TaskRecord {
  const task = createRunningTaskRunOrNull(params);
  if (!task) {
    throw new Error("expected running task creation to succeed");
  }
  return task;
}

type TestRuntime = RuntimeEnv & {
  writeStdout: ReturnType<typeof vi.fn>;
  writeJson: ReturnType<typeof vi.fn>;
};

function createRuntime(): TestRuntime {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  };
}

async function withTaskFlowCommandStateDir(run: (root: string) => Promise<void>): Promise<void> {
  await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "openclaw-flows-command-",
    },
    async (state) => {
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      try {
        await run(state.stateDir);
      } finally {
        resetTaskRegistryDeliveryRuntimeForTests();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      }
    },
  );
}

describe("flows commands", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  });

  afterEach(() => {
    envSnapshot.restore();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("lists TaskFlows as JSON with linked tasks and summaries", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/flows-command",
        goal: "Inspect a PR cluster",
        status: "blocked",
        blockedSummary: "Waiting on child task",
        createdAt: 100,
        updatedAt: 100,
      });

      const childTask = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:child",
        runId: "run-child-1",
        label: "Inspect PR 123",
        task: "Inspect PR 123",
        startedAt: 100,
        lastEventAt: 100,
      });

      const runtime = createRuntime();
      await flowsListCommand({ json: true, status: "blocked" }, runtime);

      expect(runtime.log).not.toHaveBeenCalled();
      const payload = jsonRoundTrip(vi.mocked(runtime.writeJson).mock.calls[0]?.[0]);

      expect(payload).toStrictEqual({
        count: 1,
        status: "blocked",
        flows: [
          {
            ...jsonRoundTrip(flow),
            tasks: [jsonRoundTrip(childTask)],
            taskSummary: {
              total: 1,
              active: 1,
              terminal: 0,
              failures: 0,
              byStatus: {
                queued: 0,
                running: 1,
                succeeded: 0,
                failed: 0,
                timed_out: 0,
                cancelled: 0,
                lost: 0,
              },
              byRuntime: {
                subagent: 0,
                acp: 1,
                cli: 0,
                cron: 0,
              },
            },
          },
        ],
      });
    });
  });

  it("shows one TaskFlow as JSON through the runtime JSON writer", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/flows-command",
        goal: "Inspect a single flow",
        status: "running",
        createdAt: 100,
        updatedAt: 100,
      });

      const runtime = createRuntime();
      await flowsShowCommand({ lookup: flow.flowId, json: true }, runtime);

      expect(runtime.log).not.toHaveBeenCalled();
      expect(vi.mocked(runtime.writeJson).mock.calls[0]?.[0]).toMatchObject({
        ...jsonRoundTrip(flow),
        tasks: [],
        taskSummary: {
          total: 0,
          active: 0,
          terminal: 0,
          failures: 0,
        },
      });
    });
  });

  it("shows one TaskFlow with linked task details in text mode", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/flows-command",
        goal: "Investigate a flaky queue",
        status: "blocked",
        currentStep: "spawn_child",
        blockedSummary: "Waiting on child task output",
        createdAt: 100,
        updatedAt: 100,
      });

      const task = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:child",
        runId: "run-child-2",
        label: "Collect logs",
        task: "Collect logs",
        startedAt: 100,
        lastEventAt: 100,
      });

      const runtime = createRuntime();
      await flowsShowCommand({ lookup: flow.flowId, json: false }, runtime);

      expect(vi.mocked(runtime.log).mock.calls.map(([line]) => String(line))).toEqual([
        "TaskFlow:",
        `flowId: ${flow.flowId}`,
        "status: blocked",
        "goal: Investigate a flaky queue",
        "currentStep: spawn_child",
        "owner: agent:main:main",
        "notify: done_only",
        "state: Waiting on child task output",
        "createdAt: 1970-01-01T00:00:00.100Z",
        "updatedAt: 1970-01-01T00:00:00.100Z",
        "endedAt: n/a",
        "tasks: 1 total · 1 active · 0 issues",
        "Linked tasks:",
        `- ${task.taskId} running run-child-2 Collect logs`,
      ]);
    });
  });

  it("shows TaskFlows with Date-invalid timestamps without crashing", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/flows-command",
        goal: "Inspect malformed flow timestamp",
        status: "running",
        createdAt: 100,
        updatedAt: 8_700_000_000_000_000,
      });

      const runtime = createRuntime();
      await flowsShowCommand({ lookup: flow.flowId, json: false }, runtime);

      const lines = vi.mocked(runtime.log).mock.calls.map(([line]) => String(line));
      expect(lines).toContain(`flowId: ${flow.flowId}`);
      expect(lines).toContain("createdAt: 1970-01-01T00:00:00.100Z");
      expect(lines).toContain("updatedAt: n/a");
    });
  });

  it("sanitizes TaskFlow text output before printing to the terminal", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const unsafeOwnerKey = "agent:main:\u001b[31mowner";
      const flow = createManagedTaskFlow({
        ownerKey: unsafeOwnerKey,
        controllerId: "tests/flows-command",
        goal: "Investigate\nqueue\tstate",
        status: "blocked",
        currentStep: "spawn\u001b[2K_child",
        blockedSummary: "Waiting\u001b[31m on child\nforged: yes",
        createdAt: 100,
        updatedAt: 100,
      });

      const task = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: unsafeOwnerKey,
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:child",
        runId: "run-child-3",
        label: "Collect\nlogs\u001b[2K",
        task: "Collect logs",
        startedAt: 100,
        lastEventAt: 100,
      });

      const runtime = createRuntime();
      await flowsShowCommand({ lookup: flow.flowId, json: false }, runtime);

      const lines = vi.mocked(runtime.log).mock.calls.map(([line]) => String(line));
      expect(lines).toEqual([
        "TaskFlow:",
        `flowId: ${flow.flowId}`,
        "status: blocked",
        "goal: Investigate\\nqueue\\tstate",
        "currentStep: spawn_child",
        "owner: agent:main:owner",
        "notify: done_only",
        "state: Waiting on child\\nforged: yes",
        "createdAt: 1970-01-01T00:00:00.100Z",
        "updatedAt: 1970-01-01T00:00:00.100Z",
        "endedAt: n/a",
        "tasks: 1 total · 1 active · 0 issues",
        "Linked tasks:",
        `- ${task.taskId} running run-child-3 Collect\\nlogs`,
      ]);
      expect(lines.join("\n")).not.toContain("\u001b[");
    });
  });

  it("cancels a managed TaskFlow with no active children", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/flows-command",
        goal: "Stop detached work",
        status: "running",
        createdAt: 100,
        updatedAt: 100,
      });

      const runtime = createRuntime();
      await flowsCancelCommand({ lookup: flow.flowId }, runtime);

      expect(vi.mocked(runtime.error)).not.toHaveBeenCalled();
      expect(vi.mocked(runtime.exit)).not.toHaveBeenCalled();
      expect(vi.mocked(runtime.log).mock.calls.map(([line]) => String(line))).toEqual([
        `Cancelled ${flow.flowId} (managed) with status cancelled.`,
      ]);
    });
  });
});

describe("owner-scoped TaskFlow lifecycle commands", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  });

  afterEach(() => {
    envSnapshot.restore();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  function lastJson(runtime: TestRuntime): unknown {
    const calls = vi.mocked(runtime.writeJson).mock.calls;
    return jsonRoundTrip(calls[calls.length - 1]?.[0]);
  }

  const ownerKey = "agent:ops:background-program";

  it("creates, idempotently links, mutates, and finalizes a flow", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const createRuntime0 = createRuntime();
      await flowsCreateManagedCommand(
        {
          json: true,
          ownerKey,
          controllerId: "vasily/background-program",
          goal: "Bounded worker",
          currentStep: "queue_bounded_worker",
          stateJson: JSON.stringify({ itemId: "item-1" }),
        },
        createRuntime0,
      );
      const created = lastJson(createRuntime0) as { flow: TaskFlowRecord };
      expect(created.flow.syncMode).toBe("managed");
      expect(created.flow.ownerKey).toBe(ownerKey);
      const flowId = created.flow.flowId;

      const runArgs = {
        json: true,
        ownerKey,
        flowId,
        idempotencyKey: "vasily-background-program:item-1:task-1",
        idempotencyPayloadHash: "task:task-1",
        task: "Do bounded work",
        childSessionKey: "agent:ops:background:task-1",
        agentId: "ops",
        runId: "vasily-background:item-1:task-1",
        taskName: "item-1",
        projectKey: "background-program",
        controllerId: "vasily/background-program",
        label: "Bounded worker",
      } as const;

      const runRuntime1 = createRuntime();
      await flowsRunTaskCommand({ ...runArgs }, runRuntime1);
      const linked = lastJson(runRuntime1) as {
        created: boolean;
        reserved: boolean;
        task: TaskRecord;
      };
      expect(linked.created).toBe(true);
      expect(linked.task.parentFlowId).toBe(flowId);

      // Second identical link is idempotent: same task, not re-created.
      const runRuntime2 = createRuntime();
      await flowsRunTaskCommand({ ...runArgs }, runRuntime2);
      const relinked = lastJson(runRuntime2) as {
        created: boolean;
        reserved: boolean;
        task: TaskRecord;
      };
      expect(relinked.created).toBe(false);
      expect(relinked.reserved).toBe(true);
      expect(relinked.task.taskId).toBe(linked.task.taskId);

      const updateRuntime = createRuntime();
      await flowsUpdateStateCommand(
        {
          json: true,
          ownerKey,
          flowId,
          currentStep: "worker_queued",
          stateJson: JSON.stringify({ itemId: "item-1", taskFlowTaskId: linked.task.taskId }),
        },
        updateRuntime,
      );
      const updated = lastJson(updateRuntime) as { flow: TaskFlowRecord };
      expect(updated.flow.currentStep).toBe("worker_queued");

      const finalizeRuntime = createRuntime();
      await flowsFinalizeRunCommand(
        { json: true, runId: runArgs.runId, outcome: "succeeded", summary: "Worker done." },
        finalizeRuntime,
      );
      expect(vi.mocked(finalizeRuntime.error)).not.toHaveBeenCalled();

      const finishRuntime = createRuntime();
      await flowsFinishCommand(
        { json: true, ownerKey, flowId, stateJson: JSON.stringify({ status: "completed" }) },
        finishRuntime,
      );
      const finished = lastJson(finishRuntime) as { flow: TaskFlowRecord; tasks: TaskRecord[] };
      expect(finished.flow.status).toBe("succeeded");
      expect(finished.tasks[0]?.status).toBe("succeeded");
    });
  });

  it("rejects lifecycle mutations from a different owner", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const createRuntime0 = createRuntime();
      await flowsCreateManagedCommand(
        { json: true, ownerKey, controllerId: "vasily/background-program", goal: "Scoped" },
        createRuntime0,
      );
      const flowId = (lastJson(createRuntime0) as { flow: TaskFlowRecord }).flow.flowId;

      const otherRuntime = createRuntime();
      await flowsUpdateStateCommand(
        { json: true, ownerKey: "agent:intruder:background-program", flowId, currentStep: "x" },
        otherRuntime,
      );
      expect(vi.mocked(otherRuntime.exit)).toHaveBeenCalledWith(1);
      expect(vi.mocked(otherRuntime.writeJson)).not.toHaveBeenCalled();
    });
  });

  it("requests cancellation intent on an owner-scoped flow", async () => {
    await withTaskFlowCommandStateDir(async () => {
      const createRuntime0 = createRuntime();
      await flowsCreateManagedCommand(
        { json: true, ownerKey, controllerId: "vasily/background-program", goal: "Cancel me" },
        createRuntime0,
      );
      const flowId = (lastJson(createRuntime0) as { flow: TaskFlowRecord }).flow.flowId;

      const cancelRuntime = createRuntime();
      await flowsRequestCancelCommand({ json: true, ownerKey, flowId }, cancelRuntime);
      const cancelled = lastJson(cancelRuntime) as { flow: TaskFlowRecord };
      expect(cancelled.flow.cancelRequestedAt).toBeTruthy();
    });
  });
});
