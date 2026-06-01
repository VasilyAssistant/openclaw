// Coverage for sessions_spawn workspace inheritance from sandbox context.
import { describe, expect, it } from "vitest";
import { resolveAttemptSpawnWorkspaceDir } from "./attempt.thread-helpers.js";

describe("runEmbeddedAttempt sessions_spawn workspace inheritance", () => {
  it("passes the real workspace to sessions_spawn when workspaceAccess is ro", () => {
    // Read-only sandbox copies should not become the child session workspace;
    // spawned sessions need the canonical real workspace.
    const realWorkspace = "/tmp/openclaw-real-workspace";
    const sandboxWorkspace = "/tmp/openclaw-sandbox-workspace";
    const sandbox = {
      enabled: true,
      workspaceAccess: "ro",
    };

    expect(
      resolveAttemptSpawnWorkspaceDir({
        sandbox,
        effectiveWorkspace: sandboxWorkspace,
        resolvedWorkspace: realWorkspace,
      }),
    ).toBe(realWorkspace);
  });

  it("does not override spawned workspace when sandbox workspace is rw at the real path", () => {
    const realWorkspace = "/tmp/openclaw-real-workspace";
    const sandbox = {
      enabled: true,
      workspaceAccess: "rw",
    };

    expect(
      resolveAttemptSpawnWorkspaceDir({
        sandbox,
        effectiveWorkspace: realWorkspace,
        resolvedWorkspace: realWorkspace,
      }),
    ).toBeUndefined();
  });

  it("passes the real workspace when rw sandbox exposes it at a different path", () => {
    const realWorkspace = "/tmp/openclaw-real-workspace";
    const sandboxWorkspace = "/workspace";
    const sandbox = {
      enabled: true,
      workspaceAccess: "rw",
    };

    expect(
      resolveAttemptSpawnWorkspaceDir({
        sandbox,
        effectiveWorkspace: sandboxWorkspace,
        resolvedWorkspace: realWorkspace,
      }),
    ).toBe(realWorkspace);
  });
});
