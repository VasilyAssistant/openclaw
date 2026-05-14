import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
}));

vi.mock("./gateway.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway.js")>("./gateway.js");
  return {
    ...actual,
    callGatewayTool: gatewayMocks.callGatewayTool,
  };
});

import { READ_SCOPE } from "../../gateway/method-scopes.js";
import { __testing as sessionsResolutionTesting } from "./sessions-resolution.js";
import { createUsageTool } from "./usage-tool.js";

describe("usage tool", () => {
  beforeEach(() => {
    gatewayMocks.callGatewayTool.mockReset();
    gatewayMocks.callGatewayTool.mockResolvedValue({ ok: true });
    sessionsResolutionTesting.setDepsForTest({
      callGateway: vi.fn(
        async (request: {
          method?: string;
          params?: { key?: string; sessionId?: string; spawnedBy?: string };
        }) => {
          if (request.method === "sessions.resolve" && request.params?.spawnedBy) {
            return {};
          }
          if (request.method === "sessions.resolve" && request.params?.key === "current") {
            return {};
          }
          if (request.method === "sessions.resolve" && request.params?.key) {
            return { key: request.params.key };
          }
          if (request.method === "sessions.list") {
            return { sessions: [] };
          }
          return {};
        },
      ) as never,
    });
  });

  afterEach(() => {
    sessionsResolutionTesting.setDepsForTest();
  });

  it("calls readonly usage.agentSummary for the current session", async () => {
    const tool = createUsageTool({ agentSessionKey: "agent:main:telegram:default:direct:1" });

    const result = await tool.execute("call-1", { windowMinutes: 20, includeChunks: true });

    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "usage.agentSummary",
      {},
      {
        key: "agent:main:telegram:default:direct:1",
        windowMinutes: 20,
        chunkMinutes: undefined,
        includeChunks: true,
      },
      { scopes: [READ_SCOPE] },
    );
    expect(result.details).toEqual({ ok: true });
  });

  it("uses the injected gateway caller for embedded mode", async () => {
    const callGateway = vi.fn(async () => ({ embedded: true }));
    const tool = createUsageTool({
      agentSessionKey: "agent:main:main",
      callGateway: callGateway as never,
    });

    const result = await tool.execute("call-1", { includeChunks: true });

    expect(callGateway).toHaveBeenCalledWith({
      method: "usage.agentSummary",
      params: {
        key: "agent:main:main",
        windowMinutes: undefined,
        chunkMinutes: undefined,
        includeChunks: true,
      },
      scopes: [READ_SCOPE],
    });
    expect(gatewayMocks.callGatewayTool).not.toHaveBeenCalled();
    expect(result.details).toEqual({ embedded: true });
  });

  it("allows an explicit visible session key and chunk size", async () => {
    const tool = createUsageTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { sessions: { visibility: "all" } } } as unknown as OpenClawConfig,
    });

    await tool.execute("call-1", {
      sessionKey: "agent:main:other",
      windowMinutes: 120,
      chunkMinutes: 30,
      includeChunks: true,
    });

    expect(gatewayMocks.callGatewayTool.mock.calls[0]?.[2]).toEqual({
      key: "agent:main:other",
      windowMinutes: 120,
      chunkMinutes: 30,
      includeChunks: true,
    });
  });

  it("treats explicit current as the requester session", async () => {
    const tool = createUsageTool({ agentSessionKey: "agent:main:main" });

    await tool.execute("call-1", {
      sessionKey: "current",
      windowMinutes: 20,
    });

    expect(gatewayMocks.callGatewayTool.mock.calls[0]?.[2]).toMatchObject({
      key: "agent:main:main",
      windowMinutes: 20,
    });
  });

  it("does not expose gateway override params in the agent schema", () => {
    const tool = createUsageTool({ agentSessionKey: "agent:main:main" });
    const schema = tool.parameters as { properties?: Record<string, unknown> };

    expect(schema.properties).not.toHaveProperty("gatewayUrl");
    expect(schema.properties).not.toHaveProperty("gatewayToken");
  });

  it("denies invisible same-agent session keys under self visibility", async () => {
    const tool = createUsageTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { sessions: { visibility: "self" } } } as unknown as OpenClawConfig,
    });

    const result = await tool.execute("call-1", {
      sessionKey: "agent:main:other",
      windowMinutes: 20,
    });

    expect(result.details).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("visibility is restricted to the current session"),
    });
    expect(gatewayMocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("respects sandbox spawned-session restrictions", async () => {
    const tool = createUsageTool({
      agentSessionKey: "agent:main:main",
      sandboxed: true,
      config: {
        tools: { sessions: { visibility: "all" } },
        agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
      } as unknown as OpenClawConfig,
    });

    const result = await tool.execute("call-1", {
      sessionKey: "agent:main:other",
      windowMinutes: 20,
    });

    expect(result.details).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("not visible from this sandboxed agent session"),
    });
    expect(gatewayMocks.callGatewayTool).not.toHaveBeenCalled();
  });
});
