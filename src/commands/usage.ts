/** CLI command for summarizing per-session and per-flow transcript usage. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/config.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveStoredSessionKeyForAgentStore } from "../gateway/session-store-key.js";
import { loadCombinedSessionStoreForGateway } from "../gateway/session-utils.js";
import { info } from "../globals.js";
import {
  loadSessionCostSummary,
  loadSessionCostSummaryFromCache,
  resolveExistingUsageSessionFile,
  type CostUsageTotals,
  type SessionCostSummary,
  type SessionMessageCounts,
  type SessionModelUsage,
  type UsageCacheStatus,
} from "../infra/session-cost-usage.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { writeRuntimeJson } from "../runtime.js";
import { listTasksForFlowId } from "../tasks/runtime-internal.js";
import { getTaskFlowByIdForOwner } from "../tasks/task-flow-owner-access.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";

type SessionUsageRollup = Pick<
  SessionCostSummary,
  | "input"
  | "output"
  | "cacheRead"
  | "cacheWrite"
  | "totalTokens"
  | "totalCost"
  | "inputCost"
  | "outputCost"
  | "cacheReadCost"
  | "cacheWriteCost"
  | "missingCostEntries"
  | "messageCounts"
  | "modelUsage"
>;

export type SessionUsageSummaryResult = {
  ok: true;
  scope: "session";
  status: "available" | "missing";
  reason?: string;
  sessionKey: string;
  resolvedKey: string;
  agentId: string;
  sessionId?: string;
  includedSessionIds: string[];
  usage?: SessionUsageRollup;
  cacheStatus?: UsageCacheStatus;
};

export type FlowUsageSummaryResult = {
  ok: true;
  scope: "flow";
  status: "available" | "missing";
  reason?: string;
  flowId: string;
  ownerKey: string;
  agentId: string;
  taskCount: number;
  linkedSessionCount: number;
  missingLinkedSessionCount: number;
  includedSessionIds: string[];
  usage?: SessionUsageRollup;
  cacheStatus?: UsageCacheStatus;
};

type UsageSessionRef = {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  resolvedKey?: string;
  entry?: SessionEntry;
  storePath?: string;
};

type StoredSessionResolution = {
  agentId: string;
  resolvedKey: string;
  entry?: SessionEntry;
  storePath?: string;
  sessionId?: string;
};

function emptyTotals(): CostUsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
}

function addTotals(target: CostUsageTotals, source: CostUsageTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.totalTokens += source.totalTokens;
  target.totalCost += source.totalCost;
  target.inputCost += source.inputCost;
  target.outputCost += source.outputCost;
  target.cacheReadCost += source.cacheReadCost;
  target.cacheWriteCost += source.cacheWriteCost;
  target.missingCostEntries += source.missingCostEntries;
}

function addMessageCounts(target: SessionMessageCounts, source?: SessionMessageCounts): void {
  if (!source) {
    return;
  }
  target.total += source.total;
  target.user += source.user;
  target.assistant += source.assistant;
  target.toolCalls += source.toolCalls;
  target.toolResults += source.toolResults;
  target.errors += source.errors;
}

function mergeModelUsage(
  target: Map<string, SessionModelUsage>,
  source?: SessionModelUsage[],
): void {
  for (const entry of source ?? []) {
    const key = `${entry.provider ?? ""}\0${entry.model ?? ""}`;
    const existing =
      target.get(key) ??
      ({
        provider: entry.provider,
        model: entry.model,
        count: 0,
        totals: emptyTotals(),
      } satisfies SessionModelUsage);
    existing.count += entry.count;
    addTotals(existing.totals, entry.totals);
    target.set(key, existing);
  }
}

// Rank picks the worst freshness so a partial/stale child does not look fresh.
function mergeCacheStatus(
  left: UsageCacheStatus | undefined,
  right: UsageCacheStatus,
): UsageCacheStatus {
  if (!left) {
    return { ...right };
  }
  const rank = { fresh: 0, partial: 1, stale: 2, refreshing: 3 } as const;
  const status = rank[right.status] > rank[left.status] ? right.status : left.status;
  return {
    status,
    cachedFiles: left.cachedFiles + right.cachedFiles,
    pendingFiles: left.pendingFiles + right.pendingFiles,
    staleFiles: left.staleFiles + right.staleFiles,
    refreshedAt: Math.max(left.refreshedAt ?? 0, right.refreshedAt ?? 0) || undefined,
  };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

function addUsageSessionRef(target: Map<string, UsageSessionRef>, ref: UsageSessionRef): void {
  // Dedupe by agent+session so a transcript shared across linked tasks is counted once.
  const key = `${ref.agentId}\0${ref.sessionId}`;
  const existing = target.get(key);
  if (!existing || (!existing.entry && ref.entry)) {
    target.set(key, ref);
    return;
  }
  if (!existing.sessionKey && ref.sessionKey) {
    target.set(key, { ...existing, sessionKey: ref.sessionKey });
  }
}

function resolveStoredEntry(params: {
  sessionKey: string;
  agentId: string;
}): StoredSessionResolution {
  const config = getRuntimeConfig();
  const { storePath, store } = loadCombinedSessionStoreForGateway(config, {
    agentId: params.agentId,
  });
  const resolvedKey = resolveStoredSessionKeyForAgentStore({
    cfg: config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const parsed = parseAgentSessionKey(resolvedKey);
  const keyRest = parsed?.rest ?? params.sessionKey;
  const entry = store[resolvedKey] ?? store[params.sessionKey];
  return {
    agentId: parsed?.agentId ?? params.agentId,
    resolvedKey,
    entry,
    storePath,
    sessionId: entry?.sessionId ?? keyRest,
  };
}

function collectUsageSessionRefsForSession(params: {
  sessionKey: string;
  agentId: string;
  includeHistorical: boolean;
}): { resolved: StoredSessionResolution; refs: UsageSessionRef[] } {
  const resolved = resolveStoredEntry({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  if (!resolved.entry || !resolved.sessionId) {
    return { resolved, refs: [] };
  }
  const sessionIds = uniqueStrings([
    resolved.sessionId,
    ...(params.includeHistorical ? (resolved.entry.usageFamilySessionIds ?? []) : []),
  ]);
  return {
    resolved,
    refs: sessionIds.map((sessionId) => ({
      agentId: resolved.agentId,
      sessionId,
      sessionKey: params.sessionKey,
      resolvedKey: resolved.resolvedKey,
      entry: sessionId === resolved.sessionId ? resolved.entry : undefined,
      storePath: resolved.storePath,
    })),
  };
}

async function loadOneSessionSummary(params: {
  agentId: string;
  sessionId: string;
  entry?: SessionEntry;
  storePath?: string;
}): Promise<{ summary: SessionCostSummary | null; cacheStatus: UsageCacheStatus }> {
  const config = getRuntimeConfig();
  const pathOptions = resolveSessionFilePathOptions({
    storePath: params.storePath !== "(multiple)" ? params.storePath : undefined,
    agentId: params.agentId,
  });
  const sessionFile = resolveExistingUsageSessionFile({
    sessionId: params.sessionId,
    sessionEntry: params.entry,
    sessionFile: resolveSessionFilePath(params.sessionId, params.entry, pathOptions),
    agentId: params.agentId,
  });
  if (!sessionFile) {
    return {
      summary: null,
      cacheStatus: { status: "stale", cachedFiles: 0, pendingFiles: 1, staleFiles: 1 },
    };
  }
  const cached = await loadSessionCostSummaryFromCache({
    requestRefresh: false,
    sessionId: params.sessionId,
    sessionEntry: params.entry,
    sessionFile,
    config,
    agentId: params.agentId,
    refreshMode: "background",
  });
  if (cached.summary) {
    return cached;
  }
  return {
    summary: await loadSessionCostSummary({
      sessionId: params.sessionId,
      sessionEntry: params.entry,
      sessionFile,
      config,
      agentId: params.agentId,
    }),
    cacheStatus: cached.cacheStatus,
  };
}

async function summarizeUsageRefs(refs: UsageSessionRef[]): Promise<{
  summaryCount: number;
  usage?: SessionUsageRollup;
  cacheStatus?: UsageCacheStatus;
}> {
  const loadResult = await runTasksWithConcurrency({
    tasks: refs.map(
      (ref) => () =>
        loadOneSessionSummary({
          agentId: ref.agentId,
          sessionId: ref.sessionId,
          entry: ref.entry,
          storePath: ref.storePath,
        }),
    ),
    limit: 4,
    errorMode: "stop",
  });
  if (loadResult.hasError) {
    throw loadResult.firstError;
  }

  const totals = emptyTotals();
  const messageCounts: SessionMessageCounts = {
    total: 0,
    user: 0,
    assistant: 0,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
  };
  const modelUsage = new Map<string, SessionModelUsage>();
  let cacheStatus: UsageCacheStatus | undefined;
  let summaryCount = 0;
  for (const loaded of loadResult.results) {
    cacheStatus = mergeCacheStatus(cacheStatus, loaded.cacheStatus);
    if (!loaded.summary) {
      continue;
    }
    summaryCount += 1;
    addTotals(totals, loaded.summary);
    addMessageCounts(messageCounts, loaded.summary.messageCounts);
    mergeModelUsage(modelUsage, loaded.summary.modelUsage);
  }

  return {
    summaryCount,
    usage:
      summaryCount > 0
        ? {
            ...totals,
            messageCounts,
            modelUsage: Array.from(modelUsage.values()).toSorted(
              (a, b) => b.totals.totalTokens - a.totals.totalTokens,
            ),
          }
        : undefined,
    cacheStatus,
  };
}

export async function summarizeSessionUsage(params: {
  sessionKey: string;
  agentId?: string;
  includeHistorical: boolean;
}): Promise<SessionUsageSummaryResult> {
  const parsed = parseAgentSessionKey(params.sessionKey);
  const requestedAgentId = normalizeOptionalString(params.agentId);
  const agentId = normalizeAgentId(requestedAgentId ?? parsed?.agentId);
  const { resolved, refs } = collectUsageSessionRefsForSession({
    sessionKey: params.sessionKey,
    agentId,
    includeHistorical: params.includeHistorical,
  });

  if (!resolved.entry || !resolved.sessionId || refs.length === 0) {
    return {
      ok: true,
      scope: "session",
      status: "missing",
      reason: "Linked OpenClaw session entry was not found.",
      sessionKey: params.sessionKey,
      resolvedKey: resolved.resolvedKey,
      agentId: resolved.agentId,
      includedSessionIds: [],
    };
  }

  const rolled = await summarizeUsageRefs(refs);
  if (rolled.summaryCount === 0) {
    return {
      ok: true,
      scope: "session",
      status: "missing",
      reason: "No transcript usage summary was available for the linked session.",
      sessionKey: params.sessionKey,
      resolvedKey: resolved.resolvedKey,
      agentId: resolved.agentId,
      sessionId: resolved.sessionId,
      includedSessionIds: refs.map((ref) => ref.sessionId),
      cacheStatus: rolled.cacheStatus,
    };
  }

  return {
    ok: true,
    scope: "session",
    status: "available",
    sessionKey: params.sessionKey,
    resolvedKey: resolved.resolvedKey,
    agentId: resolved.agentId,
    sessionId: resolved.sessionId,
    includedSessionIds: refs.map((ref) => ref.sessionId),
    usage: rolled.usage,
    cacheStatus: rolled.cacheStatus,
  };
}

export async function summarizeFlowUsage(params: {
  flowId: string;
  ownerKey: string;
  agentId?: string;
  includeHistorical: boolean;
}): Promise<FlowUsageSummaryResult> {
  const requestedAgentId = normalizeAgentId(normalizeOptionalString(params.agentId));
  const flow = getTaskFlowByIdForOwner({
    flowId: params.flowId,
    callerOwnerKey: params.ownerKey,
  });
  if (!flow) {
    return {
      ok: true,
      scope: "flow",
      status: "missing",
      reason: "Linked TaskFlow was not found for the requested owner.",
      flowId: params.flowId,
      ownerKey: params.ownerKey,
      agentId: requestedAgentId,
      taskCount: 0,
      linkedSessionCount: 0,
      missingLinkedSessionCount: 0,
      includedSessionIds: [],
    };
  }

  const tasks = listTasksForFlowId(flow.flowId).filter((task) => task.ownerKey === flow.ownerKey);
  const refsBySessionId = new Map<string, UsageSessionRef>();
  let linkedSessionCount = 0;
  let missingLinkedSessionCount = 0;
  for (const task of tasks) {
    const childSessionKey = normalizeOptionalString(task.childSessionKey);
    if (!childSessionKey) {
      continue;
    }
    linkedSessionCount += 1;
    const parsed = parseAgentSessionKey(childSessionKey);
    const agentId = normalizeAgentId(task.agentId ?? parsed?.agentId ?? requestedAgentId);
    const collected = collectUsageSessionRefsForSession({
      sessionKey: childSessionKey,
      agentId,
      includeHistorical: params.includeHistorical,
    });
    if (collected.refs.length === 0) {
      missingLinkedSessionCount += 1;
      continue;
    }
    for (const ref of collected.refs) {
      addUsageSessionRef(refsBySessionId, ref);
    }
  }

  const refs = Array.from(refsBySessionId.values());
  if (refs.length === 0) {
    return {
      ok: true,
      scope: "flow",
      status: "missing",
      reason: "No linked OpenClaw child session entries were found for this flow.",
      flowId: flow.flowId,
      ownerKey: flow.ownerKey,
      agentId: requestedAgentId,
      taskCount: tasks.length,
      linkedSessionCount,
      missingLinkedSessionCount,
      includedSessionIds: [],
    };
  }

  const rolled = await summarizeUsageRefs(refs);
  if (rolled.summaryCount === 0) {
    return {
      ok: true,
      scope: "flow",
      status: "missing",
      reason: "No transcript usage summary was available for linked flow sessions.",
      flowId: flow.flowId,
      ownerKey: flow.ownerKey,
      agentId: requestedAgentId,
      taskCount: tasks.length,
      linkedSessionCount,
      missingLinkedSessionCount,
      includedSessionIds: refs.map((ref) => ref.sessionId),
      cacheStatus: rolled.cacheStatus,
    };
  }

  return {
    ok: true,
    scope: "flow",
    status: "available",
    flowId: flow.flowId,
    ownerKey: flow.ownerKey,
    agentId: requestedAgentId,
    taskCount: tasks.length,
    linkedSessionCount,
    missingLinkedSessionCount,
    includedSessionIds: refs.map((ref) => ref.sessionId),
    usage: rolled.usage,
    cacheStatus: rolled.cacheStatus,
  };
}

export type UsageSummaryCommandOptions = {
  json?: boolean;
  session?: string;
  flow?: string;
  ownerKey?: string;
  agentId?: string;
  includeHistorical?: boolean;
};

function logUsageText(
  runtime: RuntimeEnv,
  result: SessionUsageSummaryResult | FlowUsageSummaryResult,
): void {
  const scopeLabel =
    result.scope === "flow" ? `flow ${result.flowId}` : `session ${result.sessionKey}`;
  if (result.status !== "available" || !result.usage) {
    runtime.log(
      info(
        `Usage for ${scopeLabel}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`,
      ),
    );
    return;
  }
  const usage = result.usage;
  runtime.log(info(`Usage for ${scopeLabel}:`));
  runtime.log(
    `tokens: ${usage.totalTokens} total (input ${usage.input}, output ${usage.output}, cacheRead ${usage.cacheRead}, cacheWrite ${usage.cacheWrite})`,
  );
  runtime.log(`cost: ${usage.totalCost} (missing cost entries: ${usage.missingCostEntries})`);
  runtime.log(`transcripts included: ${result.includedSessionIds.length}`);
}

/**
 * Summarizes transcript usage for one linked session (`--session`) or for every
 * child session of one owner-scoped TaskFlow (`--flow` + `--owner-key`). Runs the
 * same per-session cost loaders as `usage.agentSummary`, in-process via the
 * runtime, so out-of-band callers do not need a live gateway.
 */
export async function usageSummaryCommand(
  opts: UsageSummaryCommandOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const session = normalizeOptionalString(opts.session);
  const flow = normalizeOptionalString(opts.flow);
  const includeHistorical = opts.includeHistorical !== false;

  if (flow) {
    const ownerKey = normalizeOptionalString(opts.ownerKey);
    if (!ownerKey) {
      runtime.error("--owner-key is required with --flow.");
      runtime.exit(1);
      return;
    }
    const result = await summarizeFlowUsage({
      flowId: flow,
      ownerKey,
      agentId: opts.agentId,
      includeHistorical,
    });
    if (opts.json) {
      writeRuntimeJson(runtime, result);
      return;
    }
    logUsageText(runtime, result);
    return;
  }

  if (!session) {
    runtime.error("Provide --session <key> or --flow <id> to summarize usage.");
    runtime.exit(1);
    return;
  }

  const result = await summarizeSessionUsage({
    sessionKey: session,
    agentId: opts.agentId,
    includeHistorical,
  });
  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  logUsageText(runtime, result);
}
