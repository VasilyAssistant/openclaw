import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { withFileLock } from "./file-lock.js";
import { createAsyncLock, writeTextAtomic } from "./json-files.js";
import { usageProviders } from "./provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageSummary,
} from "./provider-usage.types.js";

export type ProviderUsageHistoryRecord = {
  recordedAt: number;
  provider: UsageProviderId;
  displayName: string;
  plan?: string;
  windows: Array<{ label: string; usedPercent: number; resetAt?: number }>;
};

export type ProviderUsageWindowDelta = {
  provider: UsageProviderId;
  label: string;
  currentUsedPercent: number;
  baselineUsedPercent?: number;
  deltaUsedPercent?: number;
  baselineAt?: number;
  insufficientHistory: boolean;
  resetCrossed: boolean;
};

export type ProviderUsageEfficiencyChunk = {
  provider: UsageProviderId;
  label: string;
  startAt: number;
  endAt: number;
  tokens: number;
  baselineAt?: number;
  observedAt?: number;
  baselineUsedPercent?: number;
  currentUsedPercent?: number;
  deltaUsedPercent?: number;
  tokensPerPercent?: number;
  skippedReason?:
    | "insufficient_history"
    | "baseline_too_far"
    | "label_mismatch"
    | "reset_crossed"
    | "non_positive_delta";
};

export type ProviderUsageEfficiencySummary = {
  validChunks: number;
  skippedChunks: number;
  resetCrossedChunks: number;
};

type ProviderUsageWindowSnapshot = {
  record: ProviderUsageHistoryRecord;
  window: ProviderUsageHistoryRecord["windows"][number];
};

const PROVIDER_USAGE_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PROVIDER_USAGE_HISTORY_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 1.4,
    minTimeout: 20,
    maxTimeout: 500,
    randomize: true,
  },
  stale: 30_000,
};
const withProviderUsageHistoryWriteQueue = createAsyncLock();

export type TokenUsageChunkInput = {
  startAt: number;
  endAt: number;
  tokens: number;
};

export function resolveProviderUsageHistoryPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "usage", "provider-usage-snapshots.jsonl");
}

function sanitizeProviderUsageRecord(params: {
  recordedAt: number;
  provider: ProviderUsageSnapshot;
}): ProviderUsageHistoryRecord | null {
  if (!Number.isFinite(params.recordedAt)) {
    return null;
  }
  const provider = usageProviders.includes(params.provider.provider)
    ? params.provider.provider
    : undefined;
  if (!provider) {
    return null;
  }
  const windows = params.provider.windows
    .filter(
      (window) =>
        typeof window.label === "string" &&
        window.label.trim() &&
        Number.isFinite(window.usedPercent),
    )
    .map((window) =>
      Object.assign(
        {
          label: window.label.trim(),
          usedPercent: window.usedPercent,
        },
        Number.isFinite(window.resetAt) ? { resetAt: window.resetAt } : {},
      ),
    );
  if (!windows.length) {
    return null;
  }
  const displayName = params.provider.displayName.trim() || provider;
  const plan = typeof params.provider.plan === "string" ? params.provider.plan.trim() : "";
  return {
    recordedAt: params.recordedAt,
    provider,
    displayName,
    ...(plan ? { plan } : {}),
    windows,
  };
}

export async function appendProviderUsageHistory(summary: UsageSummary): Promise<void> {
  const records = summary.providers
    .map((provider) => sanitizeProviderUsageRecord({ recordedAt: summary.updatedAt, provider }))
    .filter((record): record is ProviderUsageHistoryRecord => record !== null);
  if (!records.length) {
    return;
  }

  const filePath = resolveProviderUsageHistoryPath();
  const dirPath = path.dirname(filePath);
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fs.chmod(dirPath, 0o700).catch(() => undefined);
  await withProviderUsageHistoryWriteQueue(() =>
    withFileLock(filePath, PROVIDER_USAGE_HISTORY_LOCK_OPTIONS, async () => {
      await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
      await fs.chmod(dirPath, 0o700).catch(() => undefined);
      await fs.appendFile(filePath, serializeProviderUsageHistoryRecords(records), {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.chmod(filePath, 0o600).catch(() => undefined);
      await compactProviderUsageHistoryFile({
        filePath,
        cutoffMs: summary.updatedAt - PROVIDER_USAGE_HISTORY_RETENTION_MS,
      }).catch(() => undefined);
    }),
  );
}

function normalizeProviderUsageHistoryRecord(value: unknown): ProviderUsageHistoryRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const provider =
    typeof record.provider === "string" &&
    usageProviders.includes(record.provider as UsageProviderId)
      ? (record.provider as UsageProviderId)
      : undefined;
  const displayName = typeof record.displayName === "string" ? record.displayName.trim() : "";
  if (!Number.isFinite(record.recordedAt) || !provider || !displayName) {
    return null;
  }
  const windows = Array.isArray(record.windows)
    ? record.windows
        .map((window) => {
          if (!window || typeof window !== "object") {
            return null;
          }
          const entry = window as Record<string, unknown>;
          const label = typeof entry.label === "string" ? entry.label.trim() : "";
          if (!label || !Number.isFinite(entry.usedPercent)) {
            return null;
          }
          return {
            label,
            usedPercent: entry.usedPercent as number,
            ...(Number.isFinite(entry.resetAt) ? { resetAt: entry.resetAt as number } : {}),
          };
        })
        .filter(
          (window): window is ProviderUsageHistoryRecord["windows"][number] => window !== null,
        )
    : [];
  if (!windows.length) {
    return null;
  }
  const plan = typeof record.plan === "string" ? record.plan.trim() : "";
  return {
    recordedAt: record.recordedAt as number,
    provider,
    displayName,
    ...(plan ? { plan } : {}),
    windows,
  };
}

function serializeProviderUsageHistoryRecords(records: ProviderUsageHistoryRecord[]): string {
  if (!records.length) {
    return "";
  }
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function parseProviderUsageHistoryLines(params: {
  raw: string;
  sinceMs: number;
}): ProviderUsageHistoryRecord[] {
  const records: ProviderUsageHistoryRecord[] = [];
  for (const line of params.raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      const record = normalizeProviderUsageHistoryRecord(parsed);
      if (record && record.recordedAt >= params.sinceMs) {
        records.push(record);
      }
    } catch {
      // Ignore malformed/incomplete tail lines.
    }
  }
  return records.toSorted((a, b) => a.recordedAt - b.recordedAt);
}

async function compactProviderUsageHistoryFile(params: {
  filePath: string;
  cutoffMs: number;
}): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(params.filePath, "utf8");
  } catch {
    return;
  }
  const compacted = serializeProviderUsageHistoryRecords(
    parseProviderUsageHistoryLines({ raw, sinceMs: params.cutoffMs }),
  );
  if (compacted === raw) {
    return;
  }
  await writeTextAtomic(params.filePath, compacted, {
    mode: 0o600,
    dirMode: 0o700,
  });
}

export async function loadProviderUsageHistory(params: {
  sinceMs: number;
  filePath?: string;
}): Promise<ProviderUsageHistoryRecord[]> {
  const filePath = params.filePath ?? resolveProviderUsageHistoryPath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  return parseProviderUsageHistoryLines({ raw, sinceMs: params.sinceMs });
}

function currentRecordsFromSummary(summary: UsageSummary): ProviderUsageHistoryRecord[] {
  return summary.providers
    .map((provider) => sanitizeProviderUsageRecord({ recordedAt: summary.updatedAt, provider }))
    .filter((record): record is ProviderUsageHistoryRecord => record !== null);
}

function findLatestWindowAtOrBefore(params: {
  records: ProviderUsageHistoryRecord[];
  provider: UsageProviderId;
  label: string;
  at: number;
}): ProviderUsageWindowSnapshot | undefined {
  for (const record of params.records.toSorted((a, b) => b.recordedAt - a.recordedAt)) {
    if (record.recordedAt > params.at || record.provider !== params.provider) {
      continue;
    }
    const window = record.windows.find((candidate) => candidate.label === params.label);
    if (window) {
      return { record, window };
    }
  }
  return undefined;
}

export function buildProviderUsageDeltas(params: {
  current: UsageSummary;
  history: ProviderUsageHistoryRecord[];
  targetAt: number;
}): ProviderUsageWindowDelta[] {
  const deltas: ProviderUsageWindowDelta[] = [];
  for (const provider of params.current.providers) {
    for (const window of provider.windows) {
      const baseline = findLatestWindowAtOrBefore({
        records: params.history,
        provider: provider.provider,
        label: window.label,
        at: params.targetAt,
      });
      const deltaUsedPercent =
        baseline?.window.usedPercent === undefined
          ? undefined
          : window.usedPercent - baseline.window.usedPercent;
      const resetCrossed =
        baseline?.window !== undefined &&
        (baseline.window.resetAt !== window.resetAt ||
          (deltaUsedPercent !== undefined && deltaUsedPercent < 0));
      deltas.push({
        provider: provider.provider,
        label: window.label,
        currentUsedPercent: window.usedPercent,
        baselineUsedPercent: baseline?.window.usedPercent,
        deltaUsedPercent,
        baselineAt: baseline?.record.recordedAt,
        insufficientHistory: baseline?.window.usedPercent === undefined,
        resetCrossed,
      });
    }
  }
  return deltas;
}

export function buildProviderUsageEfficiencyChunks(params: {
  current: UsageSummary;
  history: ProviderUsageHistoryRecord[];
  tokenChunks: TokenUsageChunkInput[];
  chunkMinutes: number;
  maxBoundarySkewMs?: number;
}): ProviderUsageEfficiencyChunk[] {
  const currentRecords = currentRecordsFromSummary(params.current);
  const records = [...params.history, ...currentRecords].toSorted(
    (a, b) => a.recordedAt - b.recordedAt,
  );
  const maxBoundarySkewMs = params.maxBoundarySkewMs ?? params.chunkMinutes * 60_000;
  const out: ProviderUsageEfficiencyChunk[] = [];

  for (const provider of params.current.providers) {
    for (const window of provider.windows) {
      for (const chunk of params.tokenChunks) {
        const baseline = findLatestWindowAtOrBefore({
          records,
          provider: provider.provider,
          label: window.label,
          at: chunk.startAt,
        });
        const observed = findLatestWindowAtOrBefore({
          records,
          provider: provider.provider,
          label: window.label,
          at: chunk.endAt,
        });
        const base: ProviderUsageEfficiencyChunk = {
          provider: provider.provider,
          label: window.label,
          startAt: chunk.startAt,
          endAt: chunk.endAt,
          tokens: chunk.tokens,
          baselineAt: baseline?.record.recordedAt,
          observedAt: observed?.record.recordedAt,
          baselineUsedPercent: baseline?.window.usedPercent,
          currentUsedPercent: observed?.window.usedPercent,
        };
        if (!baseline || !observed) {
          out.push({ ...base, skippedReason: "insufficient_history" });
          continue;
        }
        if (
          chunk.startAt - baseline.record.recordedAt > maxBoundarySkewMs ||
          chunk.endAt - observed.record.recordedAt > maxBoundarySkewMs
        ) {
          out.push({ ...base, skippedReason: "baseline_too_far" });
          continue;
        }
        if (baseline.window.label !== observed.window.label) {
          out.push({ ...base, skippedReason: "label_mismatch" });
          continue;
        }
        if (
          baseline.window.resetAt !== observed.window.resetAt ||
          observed.window.usedPercent < baseline.window.usedPercent
        ) {
          out.push({ ...base, skippedReason: "reset_crossed" });
          continue;
        }
        const deltaUsedPercent = observed.window.usedPercent - baseline.window.usedPercent;
        if (deltaUsedPercent <= 0) {
          out.push({ ...base, deltaUsedPercent, skippedReason: "non_positive_delta" });
          continue;
        }
        out.push({
          ...base,
          deltaUsedPercent,
          tokensPerPercent: chunk.tokens / deltaUsedPercent,
        });
      }
    }
  }
  return out;
}

export function buildProviderUsageEfficiencySummary(
  chunks: ProviderUsageEfficiencyChunk[],
): ProviderUsageEfficiencySummary {
  return {
    validChunks: chunks.filter((chunk) => chunk.tokensPerPercent !== undefined).length,
    skippedChunks: chunks.filter((chunk) => chunk.skippedReason !== undefined).length,
    resetCrossedChunks: chunks.filter((chunk) => chunk.skippedReason === "reset_crossed").length,
  };
}
