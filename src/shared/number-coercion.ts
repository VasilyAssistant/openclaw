export const MAX_TIMER_TIMEOUT_MS = 2_147_483_647;

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseFiniteNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : undefined;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function asPositiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function resolveTimerTimeoutMs(value: number | undefined, fallbackMs: number): number {
  const configured = asFiniteNumber(value);
  return clampTimerTimeoutMs(configured !== undefined && configured > 0 ? configured : fallbackMs);
}

function clampTimerTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return Math.min(Math.floor(value), MAX_TIMER_TIMEOUT_MS);
}
