import {
  buildExecApprovalPendingReplyPayload,
  buildPluginApprovalPendingReplyPayload,
  resolveExecApprovalRequestAllowedDecisions,
  resolveExecApprovalCommandDisplay,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeMessageChannel } from "openclaw/plugin-sdk/routing";
import { isTelegramExecApprovalClientEnabled } from "./exec-approvals.js";

export function shouldSuppressTelegramExecApprovalForwardingFallback(params: {
  cfg: OpenClawConfig;
  target: { channel: string; accountId?: string | null };
  request: ExecApprovalRequest;
}): boolean {
  const channel = normalizeMessageChannel(params.target.channel) ?? params.target.channel;
  if (channel !== "telegram") {
    return false;
  }
  const requestChannel = normalizeMessageChannel(params.request.request.turnSourceChannel ?? "");
  if (requestChannel !== "telegram") {
    return false;
  }
  const accountId =
    params.target.accountId?.trim() || params.request.request.turnSourceAccountId?.trim();
  return isTelegramExecApprovalClientEnabled({ cfg: params.cfg, accountId });
}

export function buildTelegramExecApprovalPendingPayload(params: {
  request: ExecApprovalRequest;
  nowMs: number;
}) {
  return buildExecApprovalPendingReplyPayload({
    approvalId: params.request.id,
    approvalSlug: params.request.id.slice(0, 8),
    approvalCommandId: params.request.id,
    warningText: params.request.request.warningText ?? undefined,
    command: resolveExecApprovalCommandDisplay(params.request.request).commandText,
    cwd: params.request.request.cwd ?? undefined,
    host: params.request.request.host === "node" ? "node" : "gateway",
    nodeId: params.request.request.nodeId ?? undefined,
    allowedDecisions: resolveExecApprovalRequestAllowedDecisions(params.request.request),
    expiresAtMs: params.request.expiresAtMs,
    nowMs: params.nowMs,
  });
}

function formatTelegramApprovalExpiresIn(expiresAtMs: number, nowMs: number): string {
  return `${Math.max(0, Math.round((expiresAtMs - nowMs) / 1000))}s`;
}

function buildTelegramPluginApprovalText(request: PluginApprovalRequest, nowMs: number): string {
  const severity = request.request.severity ?? "warning";
  const icon = severity === "critical" ? "🚨" : severity === "info" ? "ℹ️" : "🛡️";
  const lines = [
    `${icon} Plugin approval required`,
    `Title: ${request.request.title}`,
    `Description: ${request.request.description}`,
  ];
  if (request.request.toolName) {
    lines.push(`Tool: ${request.request.toolName}`);
  }
  if (request.request.pluginId) {
    lines.push(`Plugin: ${request.request.pluginId}`);
  }
  if (request.request.agentId) {
    lines.push(`Agent: ${request.request.agentId}`);
  }
  lines.push(`ID: ${request.id}`);
  lines.push(`Expires in: ${formatTelegramApprovalExpiresIn(request.expiresAtMs, nowMs)}`);
  lines.push("Use the approval buttons below.");
  return lines.join("\n");
}

export function buildTelegramPluginApprovalPendingPayload(params: {
  request: PluginApprovalRequest;
  nowMs: number;
}) {
  return buildPluginApprovalPendingReplyPayload({
    request: params.request,
    nowMs: params.nowMs,
    text: buildTelegramPluginApprovalText(params.request, params.nowMs),
  });
}
