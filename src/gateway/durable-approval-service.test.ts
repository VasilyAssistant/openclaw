import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  computeActionHash,
  DURABLE_APPROVAL_TTL_DEFAULT_MS,
  DurableApprovalService,
} from "./durable-approval-service.js";

const tempDirs: string[] = [];

function stateOptions(): OpenClawStateDatabaseOptions {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-approval-service-"));
  tempDirs.push(dir);
  return { env: { OPENCLAW_STATE_DIR: dir } };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

describe("computeActionHash", () => {
  it("is deterministic and independent of object key order", () => {
    const a = computeActionHash("taskflow.schedule.create", { name: "n", cron: "0 9 * * *" });
    const b = computeActionHash("taskflow.schedule.create", { cron: "0 9 * * *", name: "n" });
    expect(a).toBe(b);
    expect(a.startsWith("sha256:")).toBe(true);
  });

  it("changes with the action kind", () => {
    const schedule = computeActionHash("taskflow.schedule.create", { name: "n" });
    const managed = computeActionHash("taskflow.managed.create", { name: "n" });
    expect(schedule).not.toBe(managed);
  });

  it("changes with the action snapshot", () => {
    const one = computeActionHash("k", { cron: "0 9 * * *" });
    const two = computeActionHash("k", { cron: "0 10 * * *" });
    expect(one).not.toBe(two);
  });
});

describe("DurableApprovalService", () => {
  it("persists a deferred approval with the computed hash and default TTL", () => {
    const service = new DurableApprovalService(stateOptions());
    const action = { name: "nightly", cron: "0 9 * * 1-5" };
    const record = service.createDeferred({
      id: "plugin:abc",
      kind: "taskflow.schedule.create",
      action,
      nowMs: 1_000,
    });
    expect(record.status).toBe("pending");
    expect(record.actionHash).toBe(computeActionHash("taskflow.schedule.create", action));
    // Default durable TTL is hours, not the in-memory plugin-approval timeout.
    expect(record.expiresAtMs).toBe(1_000 + DURABLE_APPROVAL_TTL_DEFAULT_MS);
  });

  it("clamps the TTL into the 6h-24h window", () => {
    const service = new DurableApprovalService(stateOptions());
    const tooShort = service.createDeferred({
      id: "plugin:short",
      kind: "k",
      action: {},
      ttlMs: 1_000,
      nowMs: 0,
    });
    expect(tooShort.expiresAtMs).toBe(SIX_HOURS_MS);
    const tooLong = service.createDeferred({
      id: "plugin:long",
      kind: "k",
      action: {},
      ttlMs: 100 * 60 * 60 * 1000,
      nowMs: 0,
    });
    expect(tooLong.expiresAtMs).toBe(DURABLE_APPROVAL_TTL_DEFAULT_MS);
  });

  it("survives a restart: a fresh service over the same state dir reads back pending work", () => {
    const options = stateOptions();
    const before = new DurableApprovalService(options);
    const created = before.createDeferred({
      id: "plugin:restart",
      kind: "taskflow.managed.create",
      action: { goal: "do it" },
      nowMs: 1_000,
    });

    // Simulate a gateway restart: a brand-new service instance (the in-memory
    // ExecApprovalManager would have lost this; the durable store does not).
    const after = new DurableApprovalService(options);
    const reloaded = after.get(created.id);
    expect(reloaded?.status).toBe("pending");
    expect(reloaded?.actionHash).toBe(created.actionHash);
    expect(after.listPending().map((r) => r.id)).toContain("plugin:restart");

    const decision = after.recordDecision("plugin:restart", "approve", "owner", 2_000);
    expect(decision.ok && decision.outcome).toBe("recorded");
    expect(after.get("plugin:restart")?.status).toBe("approved");
  });

  it("is idempotent on createDeferred by idempotency key", () => {
    const service = new DurableApprovalService(stateOptions());
    const first = service.createDeferred({
      id: "plugin:1",
      kind: "k",
      action: { a: 1 },
      idempotencyKey: "idem",
      nowMs: 0,
    });
    const second = service.createDeferred({
      id: "plugin:2",
      kind: "k",
      action: { a: 1 },
      idempotencyKey: "idem",
      nowMs: 0,
    });
    expect(second.id).toBe(first.id);
  });

  it("records apply/fail and expires due approvals", () => {
    const service = new DurableApprovalService(stateOptions());
    service.createDeferred({ id: "plugin:apply", kind: "k", action: {}, nowMs: 0 });
    service.recordDecision("plugin:apply", "approve", "owner", 1);
    const applied = service.markApplied("plugin:apply", "taskflow:flow:F1", 2);
    expect(applied?.status).toBe("applied");
    expect(applied?.appliedResultRef).toBe("taskflow:flow:F1");

    service.createDeferred({
      id: "plugin:overdue",
      kind: "k",
      action: {},
      ttlMs: SIX_HOURS_MS,
      nowMs: 0,
    });
    const expired = service.expireDue(SIX_HOURS_MS + 1);
    expect(expired).toContain("plugin:overdue");
    expect(service.get("plugin:overdue")?.status).toBe("expired");
  });
});
