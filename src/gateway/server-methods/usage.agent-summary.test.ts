import { beforeEach, describe, expect, it, vi } from "vitest";

const providerUsageMocks = vi.hoisted(() => ({
  loadProviderUsageSummary: vi.fn(),
}));
const providerHistoryMocks = vi.hoisted(() => ({
  appendProviderUsageHistory: vi.fn(),
  loadProviderUsageHistory: vi.fn(),
}));
const sessionUsageMocks = vi.hoisted(() => ({
  loadSessionCostSummaryFromCache: vi.fn(),
}));
const sessionUtilsMocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
}));

vi.mock("../../infra/provider-usage.js", () => ({
  loadProviderUsageSummary: providerUsageMocks.loadProviderUsageSummary,
}));

vi.mock("../../infra/provider-usage.history.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/provider-usage.history.js")>(
    "../../infra/provider-usage.history.js",
  );
  return {
    ...actual,
    appendProviderUsageHistory: providerHistoryMocks.appendProviderUsageHistory,
    loadProviderUsageHistory: providerHistoryMocks.loadProviderUsageHistory,
  };
});

vi.mock("../../infra/session-cost-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  );
  return {
    ...actual,
    loadSessionCostSummaryFromCache: sessionUsageMocks.loadSessionCostSummaryFromCache,
  };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: sessionUtilsMocks.loadSessionEntry,
  };
});

import { usageHandlers } from "./usage.js";

describe("usage.agentSummary", () => {
  beforeEach(() => {
    providerUsageMocks.loadProviderUsageSummary.mockReset();
    providerHistoryMocks.appendProviderUsageHistory.mockReset();
    providerHistoryMocks.loadProviderUsageHistory.mockReset();
    sessionUsageMocks.loadSessionCostSummaryFromCache.mockReset();
    sessionUtilsMocks.loadSessionEntry.mockReset();
    providerHistoryMocks.appendProviderUsageHistory.mockResolvedValue(undefined);
  });

  it("combines readonly session tokens with provider quota deltas and safe chunks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:00.000Z"));
    try {
      providerUsageMocks.loadProviderUsageSummary.mockResolvedValue({
        updatedAt: Date.now(),
        providers: [
          {
            provider: "openai-codex",
            displayName: "Codex",
            windows: [{ label: "5h", usedPercent: 15, resetAt: Date.now() + 10_000 }],
          },
        ],
      });
      providerHistoryMocks.loadProviderUsageHistory.mockResolvedValue([
        {
          recordedAt: Date.now() - 20 * 60_000,
          provider: "openai-codex",
          displayName: "Codex",
          windows: [{ label: "5h", usedPercent: 10, resetAt: Date.now() + 10_000 }],
        },
      ]);
      sessionUtilsMocks.loadSessionEntry.mockReturnValue({
        storePath: "/tmp/openclaw-sessions.json",
        entry: { sessionId: "s1" },
      });
      sessionUsageMocks.loadSessionCostSummaryFromCache.mockResolvedValue({
        summary: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 150,
          totalCost: 0,
          inputCost: 0,
          outputCost: 0,
          cacheReadCost: 0,
          cacheWriteCost: 0,
          missingCostEntries: 0,
          messageCounts: {
            total: 2,
            user: 1,
            assistant: 1,
            toolCalls: 0,
            toolResults: 0,
            errors: 0,
          },
          modelUsage: [],
          toolUsage: { totalCalls: 1, uniqueTools: 1, tools: [{ name: "secret_tool", count: 1 }] },
          sessionFile: "/tmp/private-transcript.jsonl",
          utcQuarterHourTokenUsage: [
            {
              date: "2026-05-04",
              quarterIndex: 47,
              input: 100,
              output: 50,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 150,
              totalCost: 0,
            },
          ],
        },
        cacheStatus: { status: "fresh", cachedFiles: 1, pendingFiles: 0, staleFiles: 0 },
      });

      const respond = vi.fn();
      await usageHandlers["usage.agentSummary"]({
        respond,
        params: {
          key: "agent:main:telegram:default:direct:1",
          windowMinutes: 20,
          includeChunks: true,
        },
        context: { getRuntimeConfig: () => ({ session: {} }) },
      } as unknown as Parameters<(typeof usageHandlers)["usage.agentSummary"]>[0]);

      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      const payload = respond.mock.calls[0]?.[1] as {
        session: {
          messages?: { user: number };
          totals?: { totalTokens: number; input: number };
          sessionFile?: string;
        };
        providerUsage: {
          deltas: Array<{ deltaUsedPercent: number }>;
          efficiencyChunks?: Array<{ tokensPerPercent?: number }>;
          efficiencySummary?: { validChunks: number };
        };
      };
      expect(payload.session.totals?.totalTokens).toBe(150);
      expect(payload.session.totals?.input).toBe(100);
      expect(payload.session.messages?.user).toBe(1);
      expect(payload.providerUsage.deltas[0]?.deltaUsedPercent).toBe(5);
      expect(payload.providerUsage.efficiencyChunks?.[0]?.tokensPerPercent).toBe(30);
      expect(payload.providerUsage.efficiencySummary?.validChunks).toBe(1);
      expect(payload.session.sessionFile).toBeUndefined();
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain("private-transcript");
      expect(serialized).not.toContain("utcQuarterHourTokenUsage");
      expect(serialized).not.toContain("secret_tool");
      expect(providerHistoryMocks.appendProviderUsageHistory).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns session stats with a sanitized provider error when provider usage fetch fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:00.000Z"));
    try {
      providerUsageMocks.loadProviderUsageSummary.mockRejectedValue(new Error("Bearer secret"));
      providerHistoryMocks.loadProviderUsageHistory.mockResolvedValue([]);
      sessionUtilsMocks.loadSessionEntry.mockReturnValue({
        storePath: "/tmp/openclaw-sessions.json",
        entry: { sessionId: "s1" },
      });
      sessionUsageMocks.loadSessionCostSummaryFromCache.mockResolvedValue({
        summary: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          totalCost: 0,
          inputCost: 0,
          outputCost: 0,
          cacheReadCost: 0,
          cacheWriteCost: 0,
          missingCostEntries: 0,
          messageCounts: {
            total: 1,
            user: 1,
            assistant: 0,
            toolCalls: 0,
            toolResults: 0,
            errors: 0,
          },
          modelUsage: [],
        },
        cacheStatus: { status: "fresh", cachedFiles: 1, pendingFiles: 0, staleFiles: 0 },
      });

      const respond = vi.fn();
      await usageHandlers["usage.agentSummary"]({
        respond,
        params: { key: "agent:main:main", windowMinutes: 20 },
        context: { getRuntimeConfig: () => ({ session: {} }) },
      } as unknown as Parameters<(typeof usageHandlers)["usage.agentSummary"]>[0]);

      const payload = respond.mock.calls[0]?.[1] as {
        session: { totals?: { totalTokens: number } };
        providerUsage: {
          current: { providers: unknown[] };
          deltas: unknown[];
          error?: { message: string };
        };
      };
      expect(payload.session.totals?.totalTokens).toBe(15);
      expect(payload.providerUsage.current.providers).toEqual([]);
      expect(payload.providerUsage.deltas).toEqual([]);
      expect(payload.providerUsage.error?.message).toBe("Provider usage unavailable");
      expect(JSON.stringify(payload)).not.toContain("Bearer secret");
    } finally {
      vi.useRealTimers();
    }
  });
});
