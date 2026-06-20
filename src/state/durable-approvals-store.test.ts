import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendDurableApprovalMessageRef,
  createDurableApproval,
  type CreateDurableApprovalInput,
  expireDueDurableApprovals,
  findDurableApprovalByIdempotencyKey,
  getDurableApproval,
  listDurableApprovalsByStatus,
  markDurableApprovalApplied,
  recordDurableApprovalDecision,
} from "./durable-approvals-store.js";

const tempDirs: string[] = [];

function stateOptions(): { env: { OPENCLAW_STATE_DIR: string } } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-approvals-"));
  tempDirs.push(dir);
  return { env: { OPENCLAW_STATE_DIR: dir } };
}

function input(overrides: Partial<CreateDurableApprovalInput> = {}): CreateDurableApprovalInput {
  return {
    id: "apr-1",
    kind: "taskflow.schedule.create",
    action: { name: "nightly", cron: "0 9 * * 1-5" },
    actionHash: "sha256:abc",
    expiresAtMs: 5_000,
    createdAtMs: 1_000,
    idempotencyKey: "idem-1",
    requesterActor: "agent:main:main",
    source: "owner-main-chat",
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("durable approvals store", () => {
  it("creates and reads back a pending approval with parsed action", () => {
    const options = stateOptions();
    const created = createDurableApproval(input(), options);
    expect(created.status).toBe("pending");
    expect(created.action).toEqual({ name: "nightly", cron: "0 9 * * 1-5" });

    const loaded = getDurableApproval("apr-1", options);
    expect(loaded?.actionHash).toBe("sha256:abc");
    expect(loaded?.source).toBe("owner-main-chat");
    expect(loaded?.expiresAtMs).toBe(5_000);
  });

  it("is idempotent on create by idempotency key", () => {
    const options = stateOptions();
    const first = createDurableApproval(input(), options);
    const second = createDurableApproval(input({ id: "apr-2" }), options);
    expect(second.id).toBe(first.id); // reused, not a duplicate
    expect(findDurableApprovalByIdempotencyKey("idem-1", options)?.id).toBe("apr-1");
  });

  it("records an approve decision (pending -> approved)", () => {
    const options = stateOptions();
    createDurableApproval(input(), options);
    const result = recordDurableApprovalDecision(
      "apr-1",
      "approve",
      "owner:dmitry",
      options,
      2_000,
    );
    expect(result).toMatchObject({ ok: true, outcome: "recorded" });
    const loaded = getDurableApproval("apr-1", options);
    expect(loaded?.status).toBe("approved");
    expect(loaded?.decision).toBe("approve");
    expect(loaded?.resolvedBy).toBe("owner:dmitry");
  });

  it("is replay-safe: a second decision is a no-op", () => {
    const options = stateOptions();
    createDurableApproval(input(), options);
    recordDurableApprovalDecision("apr-1", "approve", "owner:dmitry", options, 2_000);
    const replay = recordDurableApprovalDecision("apr-1", "deny", "attacker", options, 2_100);
    expect(replay).toMatchObject({ ok: true, outcome: "already" });
    expect(getDurableApproval("apr-1", options)?.decision).toBe("approve");
  });

  it("expires an overdue decision instead of applying it", () => {
    const options = stateOptions();
    createDurableApproval(input(), options);
    const result = recordDurableApprovalDecision("apr-1", "approve", "owner", options, 6_000);
    expect(result).toMatchObject({ ok: true, outcome: "expired" });
    expect(getDurableApproval("apr-1", options)?.status).toBe("expired");
  });

  it("returns not_found for an unknown id", () => {
    const options = stateOptions();
    expect(recordDurableApprovalDecision("nope", "approve", "o", options, 1)).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("marks an approved approval applied", () => {
    const options = stateOptions();
    createDurableApproval(input(), options);
    recordDurableApprovalDecision("apr-1", "approve", "owner", options, 2_000);
    const applied = markDurableApprovalApplied("apr-1", "cron:job-9", options, 3_000);
    expect(applied?.status).toBe("applied");
    expect(applied?.appliedResultRef).toBe("cron:job-9");
  });

  it("lists by status and sweeps overdue approvals", () => {
    const options = stateOptions();
    createDurableApproval(input({ id: "a", idempotencyKey: "ia", expiresAtMs: 100 }), options);
    createDurableApproval(input({ id: "b", idempotencyKey: "ib", expiresAtMs: 9_999 }), options);
    expect(listDurableApprovalsByStatus("pending", options).map((r) => r.id)).toEqual(["a", "b"]);

    const expired = expireDueDurableApprovals(options, 1_000);
    expect(expired).toEqual(["a"]);
    expect(getDurableApproval("a", options)?.status).toBe("expired");
    expect(getDurableApproval("b", options)?.status).toBe("pending");
  });

  it("appends message refs for restart redelivery", () => {
    const options = stateOptions();
    createDurableApproval(input(), options);
    appendDurableApprovalMessageRef("apr-1", { channel: "telegram", messageId: "m1" }, options);
    appendDurableApprovalMessageRef("apr-1", { channel: "telegram", messageId: "m2" }, options);
    expect(getDurableApproval("apr-1", options)?.messageRefs).toEqual([
      { channel: "telegram", messageId: "m1" },
      { channel: "telegram", messageId: "m2" },
    ]);
  });
});
