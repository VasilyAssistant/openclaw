import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableApprovalApplier, type DurableApprovalExecutor } from "./durable-approval-apply.js";
import { DurableApprovalService } from "./durable-approval-service.js";

const tempDirs: string[] = [];

function service(): DurableApprovalService {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-approval-apply-"));
  tempDirs.push(dir);
  return new DurableApprovalService({ env: { OPENCLAW_STATE_DIR: dir } });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Create an approved record ready to apply. */
function approve(svc: DurableApprovalService, id: string, kind = "taskflow.schedule.create"): void {
  svc.createDeferred({ id, kind, action: { name: id }, nowMs: 1_000 });
  const result = svc.recordDecision(id, "approve", "owner", 2_000);
  expect(result.ok && result.outcome).toBe("recorded");
}

describe("DurableApprovalApplier", () => {
  it("applies an approved record via its kind executor and records the result ref", async () => {
    const svc = service();
    approve(svc, "plugin:a");
    const executor = vi.fn<DurableApprovalExecutor>(() =>
      Promise.resolve({ resultRef: "taskflow:flow:F1" }),
    );
    const applier = new DurableApprovalApplier(
      svc,
      new Map([["taskflow.schedule.create", executor]]),
    );

    const outcome = await applier.applyApproved();

    expect(outcome.applied).toEqual(["plugin:a"]);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0][0].id).toBe("plugin:a");
    const stored = svc.get("plugin:a");
    expect(stored?.status).toBe("applied");
    expect(stored?.appliedResultRef).toBe("taskflow:flow:F1");
  });

  it("skips and leaves approved when no executor is registered for the kind", async () => {
    const svc = service();
    approve(svc, "plugin:unknown", "some.unknown.kind");
    const applier = new DurableApprovalApplier(svc, new Map());

    const outcome = await applier.applyApproved();

    expect(outcome.skipped).toEqual(["plugin:unknown"]);
    // Left approved so a later sweep applies it once the executor registers.
    expect(svc.get("plugin:unknown")?.status).toBe("approved");
  });

  it("marks failed when the executor throws", async () => {
    const svc = service();
    approve(svc, "plugin:boom");
    const executor: DurableApprovalExecutor = () => Promise.reject(new Error("scheduler down"));
    const applier = new DurableApprovalApplier(
      svc,
      new Map([["taskflow.schedule.create", executor]]),
    );

    const outcome = await applier.applyApproved();

    expect(outcome.failed).toEqual(["plugin:boom"]);
    expect(svc.get("plugin:boom")?.status).toBe("failed");
    expect(svc.get("plugin:boom")?.failureReason).toContain("scheduler down");
  });

  it("applyById applies only an approved record and is a no-op otherwise", async () => {
    const svc = service();
    // Pending (not yet decided) must not be applied.
    svc.createDeferred({ id: "plugin:pending", kind: "k", action: {}, nowMs: 1_000 });
    const executor = vi.fn<DurableApprovalExecutor>(() => Promise.resolve({}));
    const applier = new DurableApprovalApplier(svc, new Map([["k", executor]]));

    const outcome = await applier.applyById("plugin:pending");

    expect(outcome.applied).toEqual([]);
    expect(executor).not.toHaveBeenCalled();
    expect(svc.get("plugin:pending")?.status).toBe("pending");
  });

  it("is idempotent across sweeps: an applied record is not re-executed", async () => {
    const svc = service();
    approve(svc, "plugin:once");
    const executor = vi.fn<DurableApprovalExecutor>(() => Promise.resolve({ resultRef: "r" }));
    const applier = new DurableApprovalApplier(
      svc,
      new Map([["taskflow.schedule.create", executor]]),
    );

    await applier.applyApproved();
    await applier.applyApproved();

    // Second sweep sees no `approved` rows — the executor runs exactly once.
    expect(executor).toHaveBeenCalledTimes(1);
    expect(svc.get("plugin:once")?.status).toBe("applied");
  });
});
