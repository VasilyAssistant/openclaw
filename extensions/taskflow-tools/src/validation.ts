import crypto from "node:crypto";
import type { JsonObject, JsonValue } from "./types.js";

const textEncoder = new TextEncoder();
export const STATE_JSON_MAX_BYTES = 16 * 1024;
export const JSON_MAX_DEPTH = 8;

const forbiddenArgNames = new Set([
  "ownerid",
  "ownerkey",
  "sessionkey",
  "requesterorigin",
  "childsessionkey",
  "host",
  "runtime",
  "provider",
  "model",
  "budget",
  "delivery",
  "target",
  "outboundpolicy",
  "gatewayurl",
  "gatewaytoken",
]);

const secretKeyPattern = /secret|token|password|apikey|api_key|credential|cookie|authorization/iu;

export class ToolInputProblem extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolInputProblem";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function normalizeArgName(name: string): string {
  return name.replace(/[_-]/gu, "").toLowerCase();
}

export function assertNoForbiddenArgs(params: Record<string, unknown>): void {
  const forbidden = Object.keys(params).find((key) => forbiddenArgNames.has(normalizeArgName(key)));
  if (forbidden) {
    throw new ToolInputProblem(
      "forbidden_arg",
      `Argument "${forbidden}" is not accepted by TaskFlow tools.`,
      { arg: forbidden },
    );
  }
}

export function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function requiredString(params: Record<string, unknown>, key: string): string {
  const value = normalizeString(params[key]);
  if (!value) {
    throw new ToolInputProblem("missing_arg", `${key} required`, { arg: key });
  }
  return value;
}

export function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  return normalizeString(params[key]);
}

export function requiredRevision(params: Record<string, unknown>): number {
  const raw = params.expectedRevision;
  const value: number | undefined =
    typeof raw === "number" && Number.isFinite(raw)
      ? raw
      : typeof raw === "string" && raw.trim()
        ? Number(raw)
        : undefined;
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    throw new ToolInputProblem(
      "invalid_revision",
      "expectedRevision must be a non-negative integer",
    );
  }
  return value;
}

export function optionalLimit(params: Record<string, unknown>): number {
  const raw = params.limit;
  const value =
    typeof raw === "number" && Number.isFinite(raw)
      ? raw
      : typeof raw === "string" && raw.trim()
        ? Number(raw)
        : undefined;
  if (value === undefined || !Number.isFinite(value)) {
    return 50;
  }
  return Math.max(1, Math.min(100, Math.trunc(value)));
}

export function isSecretLikeKey(key: string): boolean {
  return secretKeyPattern.test(key) || secretKeyPattern.test(normalizeArgName(key));
}

export function assertJsonObject(value: unknown, label: "stateJson", maxBytes: number): JsonObject {
  if (!isRecord(value)) {
    throw new ToolInputProblem("invalid_json", `${label} must be a JSON object.`);
  }
  assertJsonValue(value, label, 0, new WeakSet<object>());
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new ToolInputProblem("invalid_json", `${label} must be JSON serializable.`);
  }
  const bytes = textEncoder.encode(json).byteLength;
  if (bytes > maxBytes) {
    throw new ToolInputProblem("json_too_large", `${label} exceeds ${maxBytes} bytes.`, {
      maxBytes,
      actualBytes: bytes,
    });
  }
  return value as JsonObject;
}

function assertJsonValue(value: unknown, path: string, depth: number, seen: WeakSet<object>): void {
  if (depth > JSON_MAX_DEPTH) {
    throw new ToolInputProblem(
      "json_too_deep",
      `${path} exceeds maximum depth ${JSON_MAX_DEPTH}.`,
      {
        maxDepth: JSON_MAX_DEPTH,
      },
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ToolInputProblem("invalid_json", `${path} must contain only finite numbers.`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new ToolInputProblem("invalid_json", `${path} must be JSON serializable.`);
  }
  if (seen.has(value)) {
    throw new ToolInputProblem("invalid_json", `${path} must not contain circular references.`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new ToolInputProblem("invalid_json", `${path} must not contain sparse arrays.`);
        }
        assertJsonValue(value[index], `${path}[${index}]`, depth + 1, seen);
      }
      return;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new ToolInputProblem("invalid_json", `${path} must contain only plain JSON objects.`);
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretLikeKey(key)) {
        throw new ToolInputProblem("secret_like_key", `${path} contains a secret-like key.`, {
          key,
        });
      }
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
        throw new ToolInputProblem("invalid_json", `${path}.${key} must be JSON serializable.`);
      }
      assertJsonValue(entry, `${path}.${key}`, depth + 1, seen);
    }
  } finally {
    seen.delete(value);
  }
}

export function redactSecrets(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  return redactUnknown(value) as JsonValue;
}

function redactUnknown(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      isSecretLikeKey(key) ? "[REDACTED]" : redactUnknown(entry),
    ]),
  );
}

export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function stableHash(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function ownerHash(ownerKey: string): string {
  return hashText(ownerKey).slice(0, 16);
}
