import type {
  BoundTaskFlowRuntime,
  OpenClawPluginApi,
  ToolEnvelope,
  ToolName,
  ToolSuccess,
} from "./types.js";
import { hashText, normalizeString, ownerHash, stableHash } from "./validation.js";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

type IdempotencyRecord = {
  version: 1;
  argsHash: string;
  response: ToolSuccess;
};

function inputKey(params: {
  toolName: ToolName;
  toolCallId: string;
  ownerKey: string;
  input: Record<string, unknown>;
}): string {
  const explicit = normalizeString(params.input.idempotencyKey);
  const base = explicit
    ? `key:${explicit}`
    : `call:${params.toolCallId || stableHash(params.input)}`;
  const flowId = normalizeString(params.input.flowId);
  const scope =
    params.toolName === "taskflow_create_managed"
      ? "create"
      : params.toolName === "taskflow_request_schedule"
        ? "schedule"
        : (flowId ?? "noflow");
  return [ownerHash(params.ownerKey), params.toolName, scope, hashText(base).slice(0, 32)].join(
    ":",
  );
}

export async function withIdempotency(params: {
  api: OpenClawPluginApi;
  toolName: ToolName;
  toolCallId: string;
  taskFlow: BoundTaskFlowRuntime;
  input: Record<string, unknown>;
  normalized: unknown;
  run: () => Promise<ToolEnvelope> | ToolEnvelope;
}): Promise<ToolEnvelope> {
  const store = params.api.runtime?.state.openKeyedStore<IdempotencyRecord>({
    namespace: "taskflow-tools-idempotency",
    maxEntries: 1000,
    defaultTtlMs: IDEMPOTENCY_TTL_MS,
  });
  if (!store) {
    return {
      ok: false,
      error: {
        code: "state_unavailable",
        message: "TaskFlow tools require trusted durable plugin state.",
      },
    };
  }
  const key = inputKey({
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    ownerKey: params.taskFlow.sessionKey,
    input: params.input,
  });
  const argsHash = stableHash(params.normalized);
  const existing = await store.lookup(key);
  if (existing) {
    if (existing.argsHash !== argsHash) {
      return {
        ok: false,
        error: {
          code: "idempotency_conflict",
          message: "Idempotency key was already used with different arguments.",
        },
      };
    }
    return { ...existing.response, idempotent: true };
  }
  const response = await params.run();
  if (!response.ok) {
    return response;
  }
  const inserted = await store.registerIfAbsent(
    key,
    {
      version: 1,
      argsHash,
      response,
    },
    { ttlMs: IDEMPOTENCY_TTL_MS },
  );
  if (!inserted) {
    const raced = await store.lookup(key);
    if (raced?.argsHash === argsHash) {
      return { ...raced.response, idempotent: true };
    }
    return {
      ok: false,
      error: {
        code: "idempotency_conflict",
        message: "Idempotency key was already used with different arguments.",
      },
    };
  }
  return response;
}
