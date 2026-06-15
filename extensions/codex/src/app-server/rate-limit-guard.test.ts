// Covers the Codex rate-limit reserve guard turn-gating decision: background runs are
// gated when remaining headroom drops to the reserve, main sessions keep running, and
// the rate-limit read is skipped entirely when the guard is not configured.
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_CONTROL_METHODS } from "./capabilities.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexPluginConfig } from "./config.js";
import { resetCodexRateLimitCacheForTests } from "./rate-limit-cache.js";
import { evaluateCodexRateLimitGuard } from "./rate-limit-guard.js";

const APP_SERVER = { requestTimeoutMs: 5_000 };

function codexRateLimitPayload(usedPercent: number) {
  return {
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: "Codex",
        primary: {
          usedPercent,
          windowDurationMins: 300,
          resetsAt: Math.ceil(Date.now() / 1000) + 3600,
        },
        secondary: null,
      },
    },
  };
}

function guardAttempt(overrides: {
  trigger: EmbeddedRunAttemptParams["trigger"];
  sessionKey: string;
}): EmbeddedRunAttemptParams {
  return { modelId: "gpt-5.5", ...overrides } as unknown as EmbeddedRunAttemptParams;
}

function guardConfig(rateLimitGuard?: CodexPluginConfig["rateLimitGuard"]): CodexPluginConfig {
  return { rateLimitGuard } as unknown as CodexPluginConfig;
}

describe("evaluateCodexRateLimitGuard", () => {
  beforeEach(() => {
    resetCodexRateLimitCacheForTests();
  });
  afterEach(() => {
    resetCodexRateLimitCacheForTests();
    vi.restoreAllMocks();
  });

  it("gates a background turn when remaining headroom is at or below the background reserve", async () => {
    const request = vi.fn(async (method: string) =>
      method === CODEX_CONTROL_METHODS.rateLimits ? codexRateLimitPayload(80) : {},
    );
    const client = { request } as unknown as CodexAppServerClient;

    const decision = await evaluateCodexRateLimitGuard({
      client,
      attempt: guardAttempt({ trigger: "cron", sessionKey: "agent:worker:background:flow-1" }),
      pluginConfig: guardConfig({ mainReservePercent: 10, backgroundReservePercent: 30 }),
      appServer: APP_SERVER,
    });

    expect(request).toHaveBeenCalledWith(
      CODEX_CONTROL_METHODS.rateLimits,
      undefined,
      expect.anything(),
    );
    expect(decision?.runClass).toBe("background");
    expect(decision?.reservePercent).toBe(30);
    expect(decision?.violation.remainingPercent).toBe(20);
    expect(decision?.message).toContain("reserve reached for background task");
    expect(decision?.message).toContain("20% remaining");
    expect(decision?.message).toContain("30% reserve");
  });

  it("allows a main-session turn when remaining headroom is above the main reserve", async () => {
    const request = vi.fn(async (method: string) =>
      method === CODEX_CONTROL_METHODS.rateLimits ? codexRateLimitPayload(80) : {},
    );
    const client = { request } as unknown as CodexAppServerClient;

    const decision = await evaluateCodexRateLimitGuard({
      client,
      attempt: guardAttempt({ trigger: "user", sessionKey: "agent:main:main" }),
      pluginConfig: guardConfig({ mainReservePercent: 10, backgroundReservePercent: 30 }),
      appServer: APP_SERVER,
    });

    expect(request).toHaveBeenCalledWith(
      CODEX_CONTROL_METHODS.rateLimits,
      undefined,
      expect.anything(),
    );
    expect(decision).toBeUndefined();
  });

  it("skips the rate-limit read when the guard is not configured", async () => {
    const request = vi.fn(async (method: string) =>
      method === CODEX_CONTROL_METHODS.rateLimits ? codexRateLimitPayload(99) : {},
    );
    const client = { request } as unknown as CodexAppServerClient;

    const decision = await evaluateCodexRateLimitGuard({
      client,
      attempt: guardAttempt({ trigger: "cron", sessionKey: "agent:worker:background:flow-1" }),
      pluginConfig: guardConfig(undefined),
      appServer: APP_SERVER,
    });

    expect(decision).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});
