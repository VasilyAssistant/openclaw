import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurableApprovalRecord } from "../state/durable-approvals-store.js";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createTaskflowScheduleCancelExecutor,
  createTaskflowScheduleCreateExecutor,
  taskflowManagedCancelExecutor,
} from "./durable-approval-taskflow-executor.js";

function record(
  id: string,
  action: unknown,
  kind = "taskflow.schedule.create",
): DurableApprovalRecord {
  return {
    id,
    status: "approved",
    kind,
    actionHash: "sha256:test",
    action,
    requesterActor: "agent:main:main",
    createdAtMs: 1,
    expiresAtMs: 2,
  } as DurableApprovalRecord;
}

async function withRegistry<T>(run: () => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "durable-approval-taskflow-exec-" },
    async () => {
      resetTaskFlowRegistryForTests();
      try {
        return await run();
      } finally {
        resetTaskFlowRegistryForTests();
      }
    },
  );
}

describe("createTaskflowScheduleCreateExecutor", () => {
  const validSchedule = {
    name: "nightly-report",
    schedule: { kind: "cron", expr: "0 9 * * 1-5" },
    payload: { kind: "agent", prompt: "report" },
  };

  function stubCronAdd() {
    return vi.fn((input: { id?: string }) => Promise.resolve({ id: input.id ?? "gen" }));
  }

  type CronAddParam = Parameters<typeof createTaskflowScheduleCreateExecutor>[0];

  it("adds a cron job with a per-approval deterministic id and returns its ref", async () => {
    const cronAdd = stubCronAdd();
    const exec = createTaskflowScheduleCreateExecutor(cronAdd as unknown as CronAddParam);

    const result = await exec(record("plugin:s", validSchedule));

    expect(cronAdd).toHaveBeenCalledTimes(1);
    const passed = cronAdd.mock.calls[0][0];
    expect(passed.id).toMatch(/^durable-/);
    expect((passed as { name?: string }).name).toBe("nightly-report");
    expect(result.resultRef).toBe(`cron:${passed.id}`);
  });

  it("passes the same deterministic id for a re-applied approval (id-dedupe input)", async () => {
    const cronAdd = stubCronAdd();
    const exec = createTaskflowScheduleCreateExecutor(cronAdd as unknown as CronAddParam);

    await exec(record("plugin:same", validSchedule));
    await exec(record("plugin:same", validSchedule));

    expect(cronAdd.mock.calls[0][0].id).toBe(cronAdd.mock.calls[1][0].id);
  });

  it("throws on a missing schedule so the applier marks it failed", async () => {
    const exec = createTaskflowScheduleCreateExecutor(stubCronAdd() as unknown as CronAddParam);
    await expect(exec(record("plugin:bad", { name: "x" }))).rejects.toThrow(/schedule/);
  });
});

describe("taskflowManagedCancelExecutor", () => {
  afterEach(() => {
    resetTaskFlowRegistryForTests();
  });

  it("requests cancellation against the current flow revision", async () => {
    await withRegistry(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-controller",
        goal: "Cancelable flow",
      });
      expect(flow).not.toBeNull();
      const flowId = flow?.flowId ?? "";

      const result = await taskflowManagedCancelExecutor(
        record("plugin:c", { flowId }, "taskflow.managed.cancel"),
      );

      expect(result.resultRef).toBe(`taskflow:flow:${flowId}`);
      expect(getTaskFlowById(flowId)?.cancelRequestedAt).toBeTypeOf("number");
    });
  });

  it("is an idempotent no-op for an unknown flow id (already gone)", async () => {
    await withRegistry(async () => {
      const result = await taskflowManagedCancelExecutor(
        record("plugin:gone", { flowId: "missing-flow" }, "taskflow.managed.cancel"),
      );
      expect(result.resultRef).toBe("taskflow:flow:missing-flow");
    });
  });

  it("throws on a missing flowId so the applier marks it failed", async () => {
    await expect(
      taskflowManagedCancelExecutor(record("plugin:bad", {}, "taskflow.managed.cancel")),
    ).rejects.toThrow(/flowId/);
  });
});

describe("createTaskflowScheduleCancelExecutor", () => {
  type CronRemoveParam = Parameters<typeof createTaskflowScheduleCancelExecutor>[0];

  it("removes the cron job by id and returns its ref", async () => {
    const cronRemove = vi.fn(() => Promise.resolve({ ok: true as const, removed: true }));
    const exec = createTaskflowScheduleCancelExecutor(cronRemove as unknown as CronRemoveParam);

    const result = await exec(
      record("plugin:sc", { scheduleId: "cron-1" }, "taskflow.schedule.cancel"),
    );

    expect(cronRemove).toHaveBeenCalledWith("cron-1");
    expect(result.resultRef).toBe("cron:cron-1");
  });

  it("throws on a missing scheduleId so the applier marks it failed", async () => {
    const cronRemove = vi.fn(() => Promise.resolve({ ok: true as const, removed: false }));
    const exec = createTaskflowScheduleCancelExecutor(cronRemove as unknown as CronRemoveParam);
    await expect(exec(record("plugin:bad", {}, "taskflow.schedule.cancel"))).rejects.toThrow(
      /scheduleId/,
    );
  });
});
