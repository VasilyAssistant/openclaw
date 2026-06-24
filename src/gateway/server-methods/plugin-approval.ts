// Gateway RPC handlers for plugin approval requests and decisions.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validatePluginApprovalRequestParams,
  validatePluginApprovalResolveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import {
  resolvePluginApprovalRequestAllowedDecisions,
  resolvePluginApprovalTimeoutMs,
} from "../../infra/plugin-approvals.js";
import type { DurableApprovalApplier } from "../durable-approval-apply.js";
import type { DurableApprovalService } from "../durable-approval-service.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import {
  bindApprovalRequesterMetadata,
  buildRequestedApprovalEvent,
  handleApprovalResolve,
  handleApprovalWaitDecision,
  handlePendingApprovalRequest,
  listVisiblePendingApprovalRequests,
  registerPendingApprovalRecord,
  resolveApprovalDecisionParams,
} from "./approval-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

type PluginDurableApprovalParams = {
  kind: string;
  action: unknown;
  idempotencyKey?: string | null;
};

/** Create plugin approval handlers backed by the shared approval manager. */
export function createPluginApprovalHandlers(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
  opts?: {
    forwarder?: ExecApprovalForwarder;
    durableService?: DurableApprovalService;
    applier?: DurableApprovalApplier;
  },
): GatewayRequestHandlers {
  return {
    "plugin.approval.list": async ({ respond, client }) => {
      respond(true, listVisiblePendingApprovalRequests({ manager, client }), undefined);
    },
    "plugin.approval.request": async ({ params, client, respond, context }) => {
      if (!validatePluginApprovalRequestParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid plugin.approval.request params: ${formatValidationErrors(
              validatePluginApprovalRequestParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as {
        pluginId?: string | null;
        title: string;
        description: string;
        severity?: string | null;
        toolName?: string | null;
        toolCallId?: string | null;
        allowedDecisions?: string[] | null;
        agentId?: string | null;
        sessionKey?: string | null;
        turnSourceChannel?: string | null;
        turnSourceTo?: string | null;
        turnSourceAccountId?: string | null;
        turnSourceThreadId?: string | number | null;
        timeoutMs?: number;
        twoPhase?: boolean;
      };
      const twoPhase = p.twoPhase === true;
      const timeoutMs = resolvePluginApprovalTimeoutMs(p.timeoutMs);

      const normalizeTrimmedString = (value?: string | null): string | null =>
        normalizeOptionalString(value) || null;

      const request: PluginApprovalRequestPayload = {
        pluginId: p.pluginId ?? null,
        title: p.title,
        description: p.description,
        severity: (p.severity as PluginApprovalRequestPayload["severity"]) ?? null,
        toolName: p.toolName ?? null,
        toolCallId: p.toolCallId ?? null,
        ...(Array.isArray(p.allowedDecisions)
          ? {
              allowedDecisions: resolvePluginApprovalRequestAllowedDecisions({
                allowedDecisions: p.allowedDecisions,
              }),
            }
          : {}),
        agentId: p.agentId ?? null,
        sessionKey: p.sessionKey ?? null,
        turnSourceChannel: normalizeTrimmedString(p.turnSourceChannel),
        turnSourceTo: normalizeTrimmedString(p.turnSourceTo),
        turnSourceAccountId: normalizeTrimmedString(p.turnSourceAccountId),
        turnSourceThreadId: p.turnSourceThreadId ?? null,
      };

      // Deferred (durable, non-blocking) mode: persist the action snapshot and
      // return `pending` immediately instead of holding the call open. The owner
      // can decide hours later and the request survives a gateway restart. Fail
      // closed if durable mode is requested but not configured, so a deferred
      // request never silently blocks instead.
      const durable = (params as { durable?: PluginDurableApprovalParams }).durable;
      if (durable) {
        if (!opts?.durableService) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "durable plugin approvals are not enabled"),
          );
          return;
        }
        const durableRecord = opts.durableService.createDeferred({
          id: `plugin:${randomUUID()}`,
          kind: durable.kind,
          action: durable.action,
          idempotencyKey: normalizeTrimmedString(durable.idempotencyKey) ?? undefined,
          title: request.title,
          description: request.description,
          risk: normalizeTrimmedString(p.severity) ?? undefined,
          // Provenance is derived from the trusted request, never plugin-supplied.
          requesterActor: request.sessionKey ?? request.agentId ?? undefined,
        });

        // Deliver the approval card now, but do not hold the call: the record is
        // persisted and we return `pending` below. The card's buttons carry the
        // `plugin:` id and resolve against the durable store, so they keep working
        // for hours and across a gateway restart even though this connection is
        // gone. Best-effort: a delivery failure must not fail the persisted
        // request — the owner can still resolve it out-of-band.
        const requestEvent = {
          id: durableRecord.id,
          request,
          createdAtMs: durableRecord.createdAtMs,
          expiresAtMs: durableRecord.expiresAtMs,
        };
        void opts.forwarder?.handlePluginApprovalRequested?.(requestEvent).catch((err: unknown) => {
          context.logGateway?.error?.(
            `plugin approvals: forward durable request failed: ${String(err)}`,
          );
        });

        respond(
          true,
          {
            status: "pending_approval",
            id: durableRecord.id,
            actionHash: durableRecord.actionHash,
            expiresAtMs: durableRecord.expiresAtMs,
          },
          undefined,
        );
        return;
      }

      // Always server-generate the ID — never accept plugin-provided IDs.
      // Kind-prefix so /approve routing can distinguish plugin vs exec IDs deterministically.
      const record = manager.create(request, timeoutMs, `plugin:${randomUUID()}`);
      bindApprovalRequesterMetadata({ record, client });

      const decisionPromise = registerPendingApprovalRecord({
        manager,
        record,
        timeoutMs,
        respond,
      });
      if (!decisionPromise) {
        return;
      }

      const requestEvent = buildRequestedApprovalEvent(record);

      await handlePendingApprovalRequest({
        manager,
        record,
        decisionPromise,
        respond,
        context,
        clientConnId: client?.connId,
        requestEventName: "plugin.approval.requested",
        requestEvent,
        twoPhase,
        approvalKind: "plugin",
        deliverRequest: () => {
          if (!opts?.forwarder?.handlePluginApprovalRequested) {
            return false;
          }
          return opts.forwarder
            .handlePluginApprovalRequested(requestEvent)
            .catch((err: unknown) => {
              context.logGateway?.error?.(
                `plugin approvals: forward request failed: ${String(err)}`,
              );
              return false;
            });
        },
      });
    },

    "plugin.approval.waitDecision": async ({ params, respond, client }) => {
      await handleApprovalWaitDecision({
        manager,
        inputId: (params as { id?: string }).id,
        client,
        respond,
      });
    },

    "plugin.approval.resolve": async ({ params, respond, client, context }) => {
      const resolveParams = resolveApprovalDecisionParams({
        rawParams: params,
        validate: validatePluginApprovalResolveParams,
        methodName: "plugin.approval.resolve",
        respond,
      });
      if (!resolveParams) {
        return;
      }
      const { inputId, decision } = resolveParams;

      // Durable (deferred) approvals are resolved against the store, not the
      // in-memory manager: the id outlives the connection and the process, so a
      // decision can land hours later or after a restart. Exact-id match — card
      // buttons carry the full `plugin:` id. Replay-safe: an already-resolved or
      // expired row returns its current state instead of erroring. Resume/apply
      // on approval is wired in the resume slice.
      const durableRecord = opts?.durableService?.get(inputId);
      if (durableRecord) {
        const resolvedBy =
          client?.connect?.client?.displayName ?? client?.connect?.client?.id ?? "owner";
        const result = opts!.durableService!.recordDecision(
          inputId,
          decision === "deny" ? "deny" : "approve",
          resolvedBy,
        );
        if (!result.ok) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "unknown or expired approval id"),
          );
          return;
        }

        // Clear the delivered card's buttons on the real decision transition only.
        // `recorded` is the one state change; `already`/`expired` are replays whose
        // card was finalized the first time, so re-forwarding would be a redundant
        // edit. Best-effort and non-blocking — the durable decision is already
        // committed. After a gateway restart the in-memory pending entry is gone, so
        // the channel finalize is a no-op then; the persisted card stays tappable
        // and resolves idempotently.
        if (result.outcome === "recorded") {
          const resolvedEvent = { id: inputId, decision, resolvedBy, ts: Date.now() };
          void opts?.forwarder
            ?.handlePluginApprovalResolved?.(resolvedEvent)
            .catch((err: unknown) => {
              context.logGateway?.error?.(
                `plugin approvals: forward durable resolve failed: ${String(err)}`,
              );
            });

          // On approval, drive the side effect now (low latency). Non-blocking: the
          // decision is already committed, apply runs to its own terminal state, and
          // a periodic/startup sweep retries anything missed (e.g. a crash before
          // apply). Denials transition to `denied`, not `approved`, so they never apply.
          if (result.record.status === "approved") {
            void opts?.applier?.applyById(inputId).catch((err: unknown) => {
              context.logGateway?.error?.(
                `plugin approvals: durable apply trigger failed: ${String(err)}`,
              );
            });
          }
        }

        respond(
          true,
          { ok: true, status: result.record.status, outcome: result.outcome },
          undefined,
        );
        return;
      }

      await handleApprovalResolve({
        manager,
        inputId,
        decision,
        respond,
        context,
        client,
        exposeAmbiguousPrefixError: false,
        validateDecision: (snapshot) =>
          resolvePluginApprovalRequestAllowedDecisions(snapshot.request).includes(decision)
            ? null
            : {
                message: `${decision} is unavailable for this plugin approval`,
                details: {
                  allowedDecisions: resolvePluginApprovalRequestAllowedDecisions(snapshot.request),
                },
              },
        resolvedEventName: "plugin.approval.resolved",
        buildResolvedEvent: ({
          approvalId,
          decision: decisionLocal,
          resolvedBy,
          snapshot,
          nowMs,
        }) => ({
          id: approvalId,
          decision: decisionLocal,
          resolvedBy,
          ts: nowMs,
          request: snapshot.request,
        }),
        forwardResolved: (resolvedEvent) =>
          opts?.forwarder?.handlePluginApprovalResolved?.(resolvedEvent),
        forwardResolvedErrorLabel: "plugin approvals: forward resolve failed",
      });
    },
  };
}
