import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { callGateway } from "../../gateway/call.js";
import { READ_SCOPE } from "../../gateway/method-scopes.js";
import { describeUsageTool, USAGE_TOOL_DISPLAY_SUMMARY } from "../tool-description-presets.js";
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

type GatewayCaller = typeof callGateway;

export function createUsageTool(opts?: {
  agentSessionKey?: string;
  config?: OpenClawConfig;
  sandboxed?: boolean;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    label: "Usage",
    name: "usage",
    displaySummary: USAGE_TOOL_DISPLAY_SUMMARY,
    description: describeUsageTool(),
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
      const usageParams = {
        key: visibleSession.key,
        windowMinutes: params.windowMinutes,
        chunkMinutes: params.chunkMinutes,
        includeChunks: params.includeChunks,
      };
      const result = opts?.callGateway
        ? await opts.callGateway({
            method: "usage.agentSummary",
            params: usageParams,
            scopes: [READ_SCOPE],
          })
        : await callGatewayTool("usage.agentSummary", {}, usageParams, { scopes: [READ_SCOPE] });
      return jsonResult(result);
    },
  };
}
