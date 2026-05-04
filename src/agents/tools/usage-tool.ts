import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { READ_SCOPE } from "../../gateway/method-scopes.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool } from "./gateway.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
  resolveSessionReference,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";

const UsageToolSchema = Type.Object({
  windowMinutes: Type.Optional(Type.Number()),
  chunkMinutes: Type.Optional(Type.Number()),
  includeChunks: Type.Optional(Type.Boolean()),
  sessionKey: Type.Optional(Type.String()),
});

export function createUsageTool(opts?: {
  agentSessionKey?: string;
  config?: OpenClawConfig;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Usage",
    name: "usage",
    displaySummary: "Read token usage and provider quota percentages for the current session.",
    description:
      "Readonly usage report. Defaults to current session and last 20 minutes. Returns token totals, message/request counts, current provider quota percentages, and observed percentage deltas when history exists.",
    parameters: UsageToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = opts?.config ?? getRuntimeConfig();
      const { mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSandboxedSessionToolContext({
          cfg,
          agentSessionKey: opts?.agentSessionKey,
          sandboxed: opts?.sandboxed,
        });
      const sessionKeyParam = readStringParam(params, "sessionKey") ?? "current";
      const resolvedSession = await resolveSessionReference({
        sessionKey: sessionKeyParam,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({ status: resolvedSession.status, error: resolvedSession.error });
      }
      const visibleSession = await resolveVisibleSessionReference({
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        restrictToSpawned,
        visibilitySessionKey: sessionKeyParam,
      });
      if (!visibleSession.ok) {
        return jsonResult({
          status: visibleSession.status,
          error: visibleSession.error,
        });
      }
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "usage",
        requesterSessionKey: effectiveRequesterKey,
        visibility: resolveEffectiveSessionToolsVisibility({
          cfg,
          sandboxed: opts?.sandboxed === true,
        }),
        a2aPolicy: createAgentToAgentPolicy(cfg),
      });
      const access = visibilityGuard.check(visibleSession.key);
      if (!access.allowed) {
        return jsonResult({
          status: access.status,
          error: access.error,
        });
      }
      const result = await callGatewayTool(
        "usage.agentSummary",
        {},
        {
          key: visibleSession.key,
          windowMinutes: params.windowMinutes,
          chunkMinutes: params.chunkMinutes,
          includeChunks: params.includeChunks,
        },
        { scopes: [READ_SCOPE] },
      );
      return jsonResult(result);
    },
  };
}
