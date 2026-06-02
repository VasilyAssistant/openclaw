import { describe, expect, test } from "vitest";
import {
  MAX_TIMER_TIMEOUT_MS,
  asFiniteNumber,
  parseFiniteNumber,
  resolveTimerTimeoutMs,
} from "./number-coercion.js";

describe("number-coercion", () => {
  test("asFiniteNumber accepts only finite numbers", () => {
    expect(asFiniteNumber(4)).toBe(4);
    expect(asFiniteNumber("4")).toBeUndefined();
    expect(asFiniteNumber(Number.NaN)).toBeUndefined();
    expect(asFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  test("parseFiniteNumber accepts finite numbers and numeric strings", () => {
    expect(parseFiniteNumber(4)).toBe(4);
    expect(parseFiniteNumber("4.5ms")).toBe(4.5);
    expect(parseFiniteNumber("")).toBeUndefined();
    expect(parseFiniteNumber("nope")).toBeUndefined();
  });

  test("resolveTimerTimeoutMs clamps to timer-safe positive integers", () => {
    expect(resolveTimerTimeoutMs(undefined, 500)).toBe(500);
    expect(resolveTimerTimeoutMs(20.8, 500)).toBe(20);
    expect(resolveTimerTimeoutMs(Number.MAX_SAFE_INTEGER, 500)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveTimerTimeoutMs(0, 500)).toBe(500);
    expect(resolveTimerTimeoutMs(Number.NaN, 500)).toBe(500);
    expect(resolveTimerTimeoutMs(undefined, Number.NaN)).toBe(1);
  });
});
