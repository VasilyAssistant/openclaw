import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { CODEX_CONTROL_METHODS } from "./capabilities.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions, CodexPluginConfig } from "./config.js";
import type { JsonValue } from "./protocol.js";
import { readRecentCodexRateLimits, rememberCodexRateLimits } from "./rate-limit-cache.js";
import {
  resolveCodexRateLimitReserveViolation,
  type CodexRateLimitReserveViolation,
} from "./rate-limits.js";

const CODEX_RATE_LIMIT_RESERVE_ERROR = Symbol.for("openclaw.codexRateLimitReserveError");
const DEFAULT_CODEX_RATE_LIMIT_GUARD_CACHE_MAX_AGE_MS = 60_000;
const DEFAULT_CODEX_RATE_LIMIT_GUARD_REQUEST_TIMEOUT_MS = 3_000;

export type CodexRateLimitGuardRunClass = "main" | "background";

export type CodexRateLimitGuardDecision = {
  runClass: CodexRateLimitGuardRunClass;
  reservePercent: number;
  violation: CodexRateLimitReserveViolation;
  message: string;
};

export type CodexRateLimitReserveError = Error & {
  [CODEX_RATE_LIMIT_RESERVE_ERROR]?: CodexRateLimitGuardDecision;
  status?: number;
  code?: string;
};

export async function evaluateCodexRateLimitGuard(params: {
  client: CodexAppServerClient;
  attempt: EmbeddedRunAttemptParams;
  pluginConfig: CodexPluginConfig;
  appServer: Pick<CodexAppServerRuntimeOptions, "requestTimeoutMs">;
  signal?: AbortSignal;
}): Promise<CodexRateLimitGuardDecision | undefined> {
  const runClass = resolveCodexRateLimitGuardRunClass(params.attempt);
  const reservePercent = resolveCodexRateLimitGuardReservePercent({
    pluginConfig: params.pluginConfig,
    runClass,
  });
  if (reservePercent === undefined) {
    return undefined;
  }
  const rateLimits = await readCodexRateLimitsForGuard(params);
  const violation = resolveCodexRateLimitReserveViolation({
    value: rateLimits,
    reservePercent,
    modelId: params.attempt.modelId,
  });
  if (!violation) {
    return undefined;
  }
  return {
    runClass,
    reservePercent,
    violation,
    message: formatCodexRateLimitGuardMessage({
      runClass,
      reservePercent,
      violation,
    }),
  };
}

export function createCodexRateLimitReserveError(
  decision: CodexRateLimitGuardDecision,
): CodexRateLimitReserveError {
  const error = new Error(decision.message) as CodexRateLimitReserveError;
  error.name = "CodexRateLimitReserveError";
  error.status = 429;
  error.code = "RATE_LIMIT";
  error[CODEX_RATE_LIMIT_RESERVE_ERROR] = decision;
  return error;
}

export function readCodexRateLimitReserveError(
  error: unknown,
): CodexRateLimitGuardDecision | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  return (error as CodexRateLimitReserveError)[CODEX_RATE_LIMIT_RESERVE_ERROR];
}

function resolveCodexRateLimitGuardRunClass(
  attempt: Pick<EmbeddedRunAttemptParams, "trigger" | "sessionKey">,
): CodexRateLimitGuardRunClass {
  const sessionKey = attempt.sessionKey?.trim().toLowerCase() ?? "";
  if (sessionKey.includes(":background:")) {
    return "background";
  }
  switch (attempt.trigger) {
    case "cron":
    case "heartbeat":
    case "memory":
    case "overflow":
      return "background";
    case "manual":
    case "user":
    default:
      return "main";
  }
}

function resolveCodexRateLimitGuardReservePercent(params: {
  pluginConfig: CodexPluginConfig;
  runClass: CodexRateLimitGuardRunClass;
}): number | undefined {
  const config = params.pluginConfig.rateLimitGuard;
  if (!config || config.enabled === false) {
    return undefined;
  }
  const raw =
    params.runClass === "background" ? config.backgroundReservePercent : config.mainReservePercent;
  return normalizeReservePercent(raw);
}

async function readCodexRateLimitsForGuard(params: {
  client: CodexAppServerClient;
  pluginConfig: CodexPluginConfig;
  appServer: Pick<CodexAppServerRuntimeOptions, "requestTimeoutMs">;
  signal?: AbortSignal;
}): Promise<JsonValue | undefined> {
  if (params.signal?.aborted) {
    return undefined;
  }
  const cacheMaxAgeMs = resolveCacheMaxAgeMs(params.pluginConfig.rateLimitGuard?.cacheMaxAgeMs);
  const cached = readRecentCodexRateLimits({ maxAgeMs: cacheMaxAgeMs });
  if (cached !== undefined) {
    return cached;
  }
  try {
    const rateLimits = await params.client.request(CODEX_CONTROL_METHODS.rateLimits, undefined, {
      timeoutMs: resolveRequestTimeoutMs({
        configured: params.pluginConfig.rateLimitGuard?.requestTimeoutMs,
        appServer: params.appServer.requestTimeoutMs,
      }),
      signal: params.signal,
    });
    rememberCodexRateLimits(rateLimits);
    return rateLimits;
  } catch {
    return undefined;
  }
}

function resolveCacheMaxAgeMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_CODEX_RATE_LIMIT_GUARD_CACHE_MAX_AGE_MS;
  }
  return Math.floor(value);
}

function resolveRequestTimeoutMs(params: {
  configured?: number;
  appServer: number | undefined;
}): number {
  const configured = normalizePositiveInteger(params.configured);
  if (configured !== undefined) {
    return configured;
  }
  const appServer = normalizePositiveInteger(params.appServer);
  return Math.min(
    appServer ?? DEFAULT_CODEX_RATE_LIMIT_GUARD_REQUEST_TIMEOUT_MS,
    DEFAULT_CODEX_RATE_LIMIT_GUARD_REQUEST_TIMEOUT_MS,
  );
}

function normalizeReservePercent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, value));
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function formatCodexRateLimitGuardMessage(params: {
  runClass: CodexRateLimitGuardRunClass;
  reservePercent: number;
  violation: CodexRateLimitReserveViolation;
}): string {
  const subject = params.runClass === "background" ? "background task" : "main session";
  const windowLabel =
    params.violation.window === "limit" ? "usage limit" : `${params.violation.window} window`;
  return (
    `Codex rate limit reserve reached for ${subject}: ` +
    `${params.violation.limitLabel} ${windowLabel} has ` +
    `${formatPercent(params.violation.remainingPercent)} remaining, at or below the ` +
    `${formatPercent(params.reservePercent)} reserve. ` +
    "Treating this as a usage limit so configured model fallback can run before usage reaches 0%."
  );
}

function formatPercent(value: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  return Number.isInteger(clamped) ? `${clamped}%` : `${clamped.toFixed(1)}%`;
}
