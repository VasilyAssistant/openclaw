import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  appendProviderUsageHistory,
  buildProviderUsageDeltas,
  buildProviderUsageEfficiencyChunks,
  buildProviderUsageEfficiencySummary,
  loadProviderUsageHistory,
  resolveProviderUsageHistoryPath,
  type ProviderUsageHistoryRecord,
} from "./provider-usage.history.js";
import type { UsageSummary } from "./provider-usage.types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const codexRecord = (params: {
  at: number;
  usedPercent: number;
  resetAt?: number;
  label?: string;
}): ProviderUsageHistoryRecord => ({
  recordedAt: params.at,
  provider: "openai",
  displayName: "Codex",
  windows: [
    {
      label: params.label ?? "5h",
      usedPercent: params.usedPercent,
      resetAt: params.resetAt,
    },
  ],
});

const codexSummary = (params: {
  at: number;
  usedPercent: number;
  resetAt?: number;
}): UsageSummary => ({
  updatedAt: params.at,
  providers: [
    {
      provider: "openai",
      displayName: "Codex",
      plan: "plus",
      windows: [{ label: "5h", usedPercent: params.usedPercent, resetAt: params.resetAt }],
    },
  ],
});

describe("provider usage history", () => {
  it("appends and loads sanitized provider usage snapshots", async () => {
    await withTempDir("openclaw-provider-usage-history-", async (stateDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await appendProviderUsageHistory({
          updatedAt: 1000,
          providers: [
            {
              provider: "openai",
              displayName: "Codex",
              plan: "plus",
              windows: [{ label: "5h", usedPercent: 12.5, resetAt: 5000 }],
            },
            {
              provider: "anthropic",
              displayName: "Claude",
              windows: [],
              error: "Unsupported provider",
            },
          ],
        });

        const filePath = resolveProviderUsageHistoryPath();
        expect(filePath).toBe(path.join(stateDir, "usage", "provider-usage-snapshots.jsonl"));
        if (process.platform !== "win32") {
          const usageDirStat = await fs.stat(path.dirname(filePath));
          const fileStat = await fs.stat(filePath);
          expect(usageDirStat.mode & 0o777).toBe(0o700);
          expect(fileStat.mode & 0o777).toBe(0o600);
        }
        const raw = await fs.readFile(filePath, "utf8");
        expect(raw).toContain("openai");
        expect(raw).toContain("usedPercent");
        expect(raw).not.toContain("Bearer");
        expect(raw).not.toContain("token");
        expect(raw).not.toContain("prompt");

        await fs.appendFile(filePath, "{not-json}\n", "utf8");
        await fs.appendFile(
          filePath,
          `${JSON.stringify({
            recordedAt: 1100,
            provider: "openai",
            displayName: "Codex",
            windows: [
              { label: "bad-percent", usedPercent: "12" },
              { label: "", usedPercent: 13 },
            ],
            prompt: "must not round-trip",
          })}\n`,
          "utf8",
        );
        const loaded = await loadProviderUsageHistory({ sinceMs: 0 });
        expect(loaded).toEqual([
          {
            recordedAt: 1000,
            provider: "openai",
            displayName: "Codex",
            plan: "plus",
            windows: [{ label: "5h", usedPercent: 12.5, resetAt: 5000 }],
          },
        ]);
      });
    });
  });

  it("retains recent snapshots and compacts old or malformed history after append", async () => {
    await withTempDir("openclaw-provider-usage-retention-", async (stateDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const now = 40 * DAY_MS;
        const filePath = resolveProviderUsageHistoryPath();
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(
          filePath,
          [
            JSON.stringify({
              recordedAt: now - 30 * DAY_MS - 1,
              provider: "openai",
              displayName: "Codex",
              windows: [{ label: "5h", usedPercent: 1 }],
              secret: "old-secret",
            }),
            JSON.stringify({
              recordedAt: now - 30 * DAY_MS,
              provider: "openai",
              displayName: " Codex ",
              plan: " plus ",
              windows: [{ label: " 5h ", usedPercent: 2, token: "raw-window-token" }],
              prompt: "raw prompt must be removed",
            }),
            "{not-json",
          ].join("\n") + "\n",
          "utf8",
        );

        await appendProviderUsageHistory(codexSummary({ at: now, usedPercent: 3 }));

        const raw = await fs.readFile(filePath, "utf8");
        expect(raw).not.toContain("old-secret");
        expect(raw).not.toContain("raw prompt");
        expect(raw).not.toContain("raw-window-token");
        expect(raw).not.toContain("{not-json");
        expect(raw.trim().split("\n")).toHaveLength(2);
        expect(await loadProviderUsageHistory({ sinceMs: 0 })).toEqual([
          {
            recordedAt: now - 30 * DAY_MS,
            provider: "openai",
            displayName: "Codex",
            plan: "plus",
            windows: [{ label: "5h", usedPercent: 2 }],
          },
          {
            recordedAt: now,
            provider: "openai",
            displayName: "Codex",
            plan: "plus",
            windows: [{ label: "5h", usedPercent: 3 }],
          },
        ]);
      });
    });
  });

  it("serializes same-process concurrent appends without losing records", async () => {
    await withTempDir("openclaw-provider-usage-concurrent-", async (stateDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const baseAt = 100 * DAY_MS;
        await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            appendProviderUsageHistory(
              codexSummary({ at: baseAt + index, usedPercent: index + 1 }),
            ),
          ),
        );

        const loaded = await loadProviderUsageHistory({ sinceMs: 0 });
        expect(loaded).toHaveLength(8);
        expect(loaded.map((record) => record.recordedAt)).toEqual(
          Array.from({ length: 8 }, (_, index) => baseAt + index),
        );
        expect(loaded.map((record) => record.windows[0]?.usedPercent)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8,
        ]);
      });
    });
  });

  it("builds deltas from the latest baseline at or before the target", () => {
    const deltas = buildProviderUsageDeltas({
      current: codexSummary({ at: 5000, usedPercent: 20, resetAt: 10_000 }),
      history: [
        codexRecord({ at: 1000, usedPercent: 10, resetAt: 10_000 }),
        codexRecord({ at: 2500, usedPercent: 12, resetAt: 10_000 }),
        codexRecord({ at: 4500, usedPercent: 19, resetAt: 10_000 }),
      ],
      targetAt: 3000,
    });

    expect(deltas).toEqual([
      {
        provider: "openai",
        label: "5h",
        currentUsedPercent: 20,
        baselineUsedPercent: 12,
        deltaUsedPercent: 8,
        baselineAt: 2500,
        insufficientHistory: false,
        resetCrossed: false,
      },
    ]);
  });

  it("marks insufficient history when no baseline exists", () => {
    const [delta] = buildProviderUsageDeltas({
      current: codexSummary({ at: 5000, usedPercent: 20 }),
      history: [],
      targetAt: 3000,
    });

    expect(delta).toMatchObject({
      baselineUsedPercent: undefined,
      deltaUsedPercent: undefined,
      insufficientHistory: true,
      resetCrossed: false,
    });
  });

  it("marks reset-crossed deltas when resetAt changes", () => {
    const [delta] = buildProviderUsageDeltas({
      current: codexSummary({ at: 5000, usedPercent: 20, resetAt: 20_000 }),
      history: [codexRecord({ at: 1000, usedPercent: 10, resetAt: 10_000 })],
      targetAt: 1000,
    });

    expect(delta?.deltaUsedPercent).toBe(10);
    expect(delta?.resetCrossed).toBe(true);
  });

  it("marks reset-crossed deltas when usedPercent decreased", () => {
    const [delta] = buildProviderUsageDeltas({
      current: codexSummary({ at: 5000, usedPercent: 3, resetAt: 20_000 }),
      history: [codexRecord({ at: 1000, usedPercent: 95, resetAt: 10_000 })],
      targetAt: 1000,
    });

    expect(delta?.deltaUsedPercent).toBe(-92);
    expect(delta?.resetCrossed).toBe(true);
  });

  it("computes tokens per percent only for reset-safe coarse chunks", () => {
    const chunks = buildProviderUsageEfficiencyChunks({
      current: codexSummary({ at: 60 * 60_000, usedPercent: 16, resetAt: 5 * 60 * 60_000 }),
      history: [
        codexRecord({ at: 0, usedPercent: 10, resetAt: 5 * 60 * 60_000 }),
        codexRecord({ at: 30 * 60_000, usedPercent: 13, resetAt: 5 * 60 * 60_000 }),
      ],
      tokenChunks: [
        { startAt: 0, endAt: 30 * 60_000, tokens: 3000 },
        { startAt: 30 * 60_000, endAt: 60 * 60_000, tokens: 6000 },
      ],
      chunkMinutes: 30,
    });

    expect(chunks.map((chunk) => chunk.tokensPerPercent)).toEqual([1000, 2000]);
    expect(chunks.every((chunk) => chunk.skippedReason === undefined)).toBe(true);
    expect(buildProviderUsageEfficiencySummary(chunks)).toEqual({
      validChunks: 2,
      skippedChunks: 0,
      resetCrossedChunks: 0,
    });
  });

  it("skips coarse chunks that cross a reset boundary", () => {
    const [chunk] = buildProviderUsageEfficiencyChunks({
      current: codexSummary({ at: 60 * 60_000, usedPercent: 2, resetAt: 10 * 60 * 60_000 }),
      history: [codexRecord({ at: 0, usedPercent: 90, resetAt: 5 * 60 * 60_000 })],
      tokenChunks: [{ startAt: 0, endAt: 60 * 60_000, tokens: 10_000 }],
      chunkMinutes: 60,
    });

    expect(chunk?.tokensPerPercent).toBeUndefined();
    expect(chunk?.skippedReason).toBe("reset_crossed");
    expect(buildProviderUsageEfficiencySummary([chunk])).toEqual({
      validChunks: 0,
      skippedChunks: 1,
      resetCrossedChunks: 1,
    });
  });

  it("skips coarse chunks when quota delta is not positive", () => {
    const [chunk] = buildProviderUsageEfficiencyChunks({
      current: codexSummary({ at: 60 * 60_000, usedPercent: 10, resetAt: 5 * 60 * 60_000 }),
      history: [codexRecord({ at: 0, usedPercent: 10, resetAt: 5 * 60 * 60_000 })],
      tokenChunks: [{ startAt: 0, endAt: 60 * 60_000, tokens: 10_000 }],
      chunkMinutes: 60,
    });

    expect(chunk?.deltaUsedPercent).toBe(0);
    expect(chunk?.tokensPerPercent).toBeUndefined();
    expect(chunk?.skippedReason).toBe("non_positive_delta");
  });
});
