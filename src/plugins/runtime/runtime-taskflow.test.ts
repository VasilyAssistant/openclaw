// Runtime task-flow tests cover plugin task-flow registration and execution behavior.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTaskFlowById } from "../../tasks/task-flow-registry.js";
import { getTaskById } from "../../tasks/task-registry.js";
import {
  installRuntimeTaskDeliveryMock,
  resetRuntimeTaskTestState,
} from "./runtime-task-test-harness.js";
import { createRuntimeTaskFlow } from "./runtime-taskflow.js";

function requireCreatedFlow<T>(flow: T | null): T {
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

afterEach(() => {
  resetRuntimeTaskTestState({ persist: false });
});

describe("runtime TaskFlow", () => {
  beforeEach(() => {
    installRuntimeTaskDeliveryMock();
  });

  it("binds managed TaskFlow operations to a session key", () => {
    const runtime = createRuntimeTaskFlow();
    const taskFlow = runtime.bindSession({
      sessionKey: "agent:main:main",
      requesterOrigin: {
        channel: "telegram",
        to: "telegram:123",
      },
    });

    const created = requireCreatedFlow(
      taskFlow.createManaged({
        controllerId: "tests/runtime-taskflow",
        goal: "Triage inbox",
        currentStep: "classify",
        stateJson: { lane: "inbox" },
      }),
    );

    expect(created.syncMode).toBe("managed");
    expect(created.ownerKey).toBe("agent:main:main");
    expect(created.controllerId).toBe("tests/runtime-taskflow");
    expect(created.requesterOrigin?.channel).toBe("telegram");
    expect(created.requesterOrigin?.to).toBe("telegram:123");
    expect(created.goal).toBe("Triage inbox");
    expect(taskFlow.get(created.flowId)?.flowId).toBe(created.flowId);
    expect(taskFlow.findLatest()?.flowId).toBe(created.flowId);
    expect(taskFlow.resolve("agent:main:main")?.flowId).toBe(created.flowId);
  });

  it("binds TaskFlows from trusted tool context", () => {
    const runtime = createRuntimeTaskFlow();
    const taskFlow = runtime.fromToolContext({
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "discord",
        to: "channel:123",
        threadId: "thread:456",
      },
    });

    const created = requireCreatedFlow(
      taskFlow.createManaged({
        controllerId: "tests/runtime-taskflow",
        goal: "Review queue",
      }),
    );

    expect(created.requesterOrigin?.channel).toBe("discord");
    expect(created.requesterOrigin?.to).toBe("channel:123");
    expect(created.requesterOrigin?.threadId).toBe("thread:456");
  });

  it("updates managed TaskFlow state with expected revision checks", () => {
    const runtime = createRuntimeTaskFlow();
    const taskFlow = runtime.bindSession({
      sessionKey: "agent:main:main",
    });

    const created = taskFlow.createManaged({
      controllerId: "tests/runtime-taskflow",
      goal: "Track multi-step work",
      currentStep: "start",
      stateJson: { step: 1 },
    });
    const updated = taskFlow.updateState({
      flowId: created.flowId,
      expectedRevision: created.revision,
      currentStep: "next",
      stateJson: { step: 2 },
    });

    expect(updated).toMatchObject({
      applied: true,
      flow: {
        flowId: created.flowId,
        currentStep: "next",
        stateJson: { step: 2 },
        revision: created.revision + 1,
      },
    });
    const conflicted = taskFlow.updateState({
      flowId: created.flowId,
      expectedRevision: created.revision,
      stateJson: { step: 3 },
    });

    expect(conflicted).toMatchObject({
      applied: false,
      code: "revision_conflict",
      current: {
        flowId: created.flowId,
        stateJson: { step: 2 },
      },
    });
  });

  it("rejects tool contexts without a bound session key", () => {
    const runtime = createRuntimeTaskFlow();
    expect(() =>
      runtime.fromToolContext({
        sessionKey: undefined,
        deliveryContext: undefined,
      }),
    ).toThrow("TaskFlow runtime requires tool context with a sessionKey.");
  });

  it("keeps TaskFlow reads owner-scoped and runs child tasks under the bound TaskFlow", () => {
    const runtime = createRuntimeTaskFlow();
    const ownerTaskFlow = runtime.bindSession({
      sessionKey: "agent:main:main",
    });
    const otherTaskFlow = runtime.bindSession({
      sessionKey: "agent:main:other",
    });

    const created = requireCreatedFlow(
      ownerTaskFlow.createManaged({
        controllerId: "tests/runtime-taskflow",
        goal: "Inspect PR batch",
      }),
    );

    expect(otherTaskFlow.get(created.flowId)).toBeUndefined();
    expect(otherTaskFlow.list()).toStrictEqual([]);

    const child = ownerTaskFlow.runTask({
      flowId: created.flowId,
      runtime: "acp",
      childSessionKey: "agent:main:subagent:child",
      runId: "runtime-taskflow-child",
      task: "Inspect PR 1",
      status: "running",
      startedAt: 10,
      lastEventAt: 10,
    });

    expect(child.created).toBe(true);
    if (!child.created) {
      throw new Error("expected child task creation to succeed");
    }
    expect(child.flow.flowId).toBe(created.flowId);
    expect(child.task.parentFlowId).toBe(created.flowId);
    expect(child.task.ownerKey).toBe("agent:main:main");
    expect(child.task.runId).toBe("runtime-taskflow-child");

    const storedTask = getTaskById(child.task.taskId);
    expect(storedTask?.parentFlowId).toBe(created.flowId);
    expect(storedTask?.ownerKey).toBe("agent:main:main");
    expect(getTaskFlowById(created.flowId)?.flowId).toBe(created.flowId);
    const summary = ownerTaskFlow.getTaskSummary(created.flowId);
    if (!summary) {
      throw new Error("expected task summary for created flow");
    }
    expect(summary.total).toBe(1);
    expect(summary.active).toBe(1);
  });

  it("runs child tasks only when the expected revision still matches", () => {
    const runtime = createRuntimeTaskFlow();
    const taskFlow = runtime.bindSession({
      sessionKey: "agent:main:main",
    });
    const created = taskFlow.createManaged({
      controllerId: "tests/runtime-taskflow",
      goal: "Protected child spawn",
    });

    const conflicted = taskFlow.runTask({
      flowId: created.flowId,
      expectedRevision: created.revision + 1,
      runtime: "acp",
      childSessionKey: "agent:main:subagent:stale",
      runId: "runtime-taskflow-stale-child",
      task: "Should not start",
    });

    expect(conflicted).toMatchObject({
      created: false,
      found: true,
      reason: "Flow revision conflict.",
      flow: {
        flowId: created.flowId,
        revision: created.revision,
      },
    });
    expect(taskFlow.getTaskSummary(created.flowId)).toMatchObject({
      total: 0,
    });

    const child = taskFlow.runTask({
      flowId: created.flowId,
      expectedRevision: created.revision,
      runtime: "acp",
      childSessionKey: "agent:main:subagent:fresh",
      runId: "runtime-taskflow-fresh-child",
      task: "Start now",
    });

    expect(child).toMatchObject({
      created: true,
      task: {
        runId: "runtime-taskflow-fresh-child",
        parentFlowId: created.flowId,
      },
    });
  });
});
