// Usage command tests cover per-session and owner-scoped per-flow usage rollups
// loaded from transcript history.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveDefaultSessionStorePath,
  resolveSessionTranscriptsDirForAgent,
} from "../config/sessions/paths.js";
import { createRunningTaskRun } from "../tasks/task-executor.js";
import {
  createManagedTaskFlow,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-registry.js";
import {
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-registry.js";
import { captureEnv } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { summarizeFlowUsage, summarizeSessionUsage } from "./usage.js";

const AGENT_ID = "ops";
const OWNER_KEY = "agent:ops:background-program";

function assistantEntry(params: {
  timestamp: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens: number;
    cost: number;
  };
}): string {
  return JSON.stringify({
    type: "message",
    timestamp: params.timestamp,
    message: {
      role: "assistant",
      provider: "openai",
      model: params.model,
      content: "turn",
      usage: {
        input: params.usage.input,
        output: params.usage.output,
        cacheRead: params.usage.cacheRead ?? 0,
        cacheWrite: params.usage.cacheWrite ?? 0,
        totalTokens: params.usage.totalTokens,
        cost: { total: params.usage.cost },
      },
    },
  });
}

function writeTranscript(sessionsDir: string, sessionId: string, lines: string[]): void {
  writeFileSync(path.join(sessionsDir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

// Mirrors the previous tsx usage smoke fixture: one linked session with a usage
// family, plus a flow with three linked child sessions (two present, one
// missing) that share one historical transcript.
function writeFixture(): { flowId: string } {
  resetTaskRegistryForTests();
  resetTaskFlowRegistryForTests();
  const sessionsDir = resolveSessionTranscriptsDirForAgent(AGENT_ID);
  mkdirSync(sessionsDir, { recursive: true });

  const flow = createManagedTaskFlow({
    ownerKey: OWNER_KEY,
    controllerId: "vasily/background-usage-test",
    goal: "Aggregate background usage",
    currentStep: "aggregate_usage",
    notifyPolicy: "state_changes",
  });
  if (!flow) {
    throw new Error("expected managed flow creation to succeed");
  }
  const flowSessions = [
    "agent:ops:background:usage-flow-task-a",
    "agent:ops:background:usage-flow-task-b",
    "agent:ops:background:usage-flow-task-missing",
  ];
  for (const [index, childSessionKey] of flowSessions.entries()) {
    const task = createRunningTaskRun({
      runtime: "subagent",
      ownerKey: OWNER_KEY,
      scopeKind: "session",
      parentFlowId: flow.flowId,
      childSessionKey,
      agentId: AGENT_ID,
      runId: `usage-test-run-${index}`,
      label: `Usage test ${index}`,
      task: "Aggregate usage.",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
    });
    if (!task) {
      throw new Error("expected linked task creation to succeed");
    }
  }

  writeFileSync(
    resolveDefaultSessionStorePath(AGENT_ID),
    `${JSON.stringify(
      {
        "agent:ops:background:usage-smoke-task": {
          sessionId: "usage-smoke-current",
          sessionFile: "usage-smoke-current.jsonl",
          updatedAt: Date.now(),
          usageFamilySessionIds: ["usage-smoke-history"],
        },
        "agent:ops:background:usage-flow-task-a": {
          sessionId: "usage-flow-current-a",
          sessionFile: "usage-flow-current-a.jsonl",
          updatedAt: Date.now(),
          usageFamilySessionIds: ["usage-flow-history-shared"],
        },
        "agent:ops:background:usage-flow-task-b": {
          sessionId: "usage-flow-current-b",
          sessionFile: "usage-flow-current-b.jsonl",
          updatedAt: Date.now(),
          usageFamilySessionIds: ["usage-flow-history-shared"],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  writeTranscript(sessionsDir, "usage-smoke-current", [
    JSON.stringify({
      type: "message",
      timestamp: "2026-05-31T00:00:00.000Z",
      message: { role: "user", content: "usage smoke" },
    }),
    assistantEntry({
      timestamp: "2026-05-31T00:00:02.000Z",
      model: "gpt-smoke",
      usage: { input: 1000, output: 200, cacheRead: 300, totalTokens: 1500, cost: 0.0123 },
    }),
  ]);
  writeTranscript(sessionsDir, "usage-smoke-history", [
    assistantEntry({
      timestamp: "2026-05-31T00:01:00.000Z",
      model: "gpt-smoke",
      usage: { input: 5, output: 7, totalTokens: 12, cost: 0.0007 },
    }),
  ]);
  writeTranscript(sessionsDir, "usage-flow-current-a", [
    assistantEntry({
      timestamp: "2026-05-31T00:02:00.000Z",
      model: "gpt-flow",
      usage: { input: 100, output: 10, totalTokens: 110, cost: 0.001 },
    }),
  ]);
  writeTranscript(sessionsDir, "usage-flow-current-b", [
    assistantEntry({
      timestamp: "2026-05-31T00:03:00.000Z",
      model: "gpt-flow",
      usage: { input: 200, output: 20, totalTokens: 220, cost: 0.002 },
    }),
  ]);
  writeTranscript(sessionsDir, "usage-flow-history-shared", [
    assistantEntry({
      timestamp: "2026-05-31T00:04:00.000Z",
      model: "gpt-flow",
      usage: { input: 5, output: 7, totalTokens: 12, cost: 0.0007 },
    }),
  ]);

  return { flowId: flow.flowId };
}

async function withUsageState(run: (flowId: string) => Promise<void>): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", scenario: "minimal", prefix: "openclaw-usage-command-" },
    async () => {
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      try {
        const { flowId } = writeFixture();
        await run(flowId);
      } finally {
        resetTaskRegistryDeliveryRuntimeForTests();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      }
    },
  );
}

describe("usage summary command helpers", () => {
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

  it("rolls up linked session usage including the usage family", async () => {
    await withUsageState(async () => {
      const summary = await summarizeSessionUsage({
        sessionKey: "agent:ops:background:usage-smoke-task",
        agentId: AGENT_ID,
        includeHistorical: true,
      });
      expect(summary.status).toBe("available");
      expect(summary.usage?.totalTokens).toBe(1512);
      expect(summary.usage?.input).toBe(1005);
      expect(summary.usage?.output).toBe(207);
      expect(summary.usage?.cacheRead).toBe(300);
      expect(summary.usage?.messageCounts?.total).toBe(3);
      expect(summary.usage?.modelUsage?.[0]?.count).toBe(2);
      expect(summary.includedSessionIds.length).toBe(2);
    });
  });

  it("returns an explicit nonfatal fallback for a missing session", async () => {
    await withUsageState(async () => {
      const summary = await summarizeSessionUsage({
        sessionKey: "agent:ops:background:usage-smoke-missing",
        agentId: AGENT_ID,
        includeHistorical: true,
      });
      expect(summary.status).toBe("missing");
      expect(summary.usage).toBeUndefined();
    });
  });

  it("aggregates flow-level usage across linked child sessions without double counting", async () => {
    await withUsageState(async (flowId) => {
      const summary = await summarizeFlowUsage({
        flowId,
        ownerKey: OWNER_KEY,
        agentId: AGENT_ID,
        includeHistorical: true,
      });
      expect(summary.status).toBe("available");
      expect(summary.taskCount).toBe(3);
      expect(summary.linkedSessionCount).toBe(3);
      expect(summary.missingLinkedSessionCount).toBe(1);
      expect(summary.usage?.totalTokens).toBe(342);
      expect(summary.usage?.input).toBe(305);
      expect(summary.usage?.output).toBe(37);
      expect(summary.usage?.modelUsage?.[0]?.count).toBe(3);
      expect(summary.includedSessionIds.length).toBe(3);
    });
  });

  it("does not return a flow owned by a different owner key", async () => {
    await withUsageState(async (flowId) => {
      const summary = await summarizeFlowUsage({
        flowId,
        ownerKey: "agent:intruder:background-program",
        agentId: AGENT_ID,
        includeHistorical: true,
      });
      expect(summary.status).toBe("missing");
      expect(summary.taskCount).toBe(0);
    });
  });
});
