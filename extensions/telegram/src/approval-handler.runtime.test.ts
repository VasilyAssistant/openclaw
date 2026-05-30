import { describe, expect, it, vi } from "vitest";
import { telegramApprovalNativeRuntime } from "./approval-handler.runtime.js";
import { buildTelegramPluginApprovalPendingPayload } from "./exec-approval-forwarding.js";

type TelegramPayload = {
  text: string;
  buttons?: Array<Array<{ text: string; callback_data?: string }>>;
};

describe("telegramApprovalNativeRuntime", () => {
  it("renders only the allowed pending buttons", async () => {
    const payload = (await telegramApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: {
        token: "tg-token",
      },
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec",
      nowMs: 0,
      view: {
        approvalKind: "exec",
        approvalId: "req-1",
        commandText: "echo hi",
        actions: [
          {
            kind: "decision",
            decision: "allow-once",
            label: "Allow Once",
            command: "/approve req-1 allow-once",
            style: "success",
          },
          {
            kind: "decision",
            decision: "deny",
            label: "Deny",
            command: "/approve req-1 deny",
            style: "danger",
          },
        ],
      } as never,
    })) as TelegramPayload;

    expect(payload.text).toContain("echo hi");
    expect(payload.text).not.toContain("allow-always");
    expect(payload.buttons?.[0]?.map((button) => button.text)).toEqual(["Allow Once", "Deny"]);
  });

  it("renders plugin approvals with buttons instead of manual approve commands", async () => {
    const payload = (await telegramApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: {
        token: "tg-token",
      },
      request: {
        id: "plugin:req-1",
        request: {
          title: "Cancel managed TaskFlow",
          description: "Request cancellation for TaskFlow flow-1.",
          pluginId: "taskflow-tools",
          toolName: "taskflow_request_cancel",
          allowedDecisions: ["allow-once", "deny"],
        },
        createdAtMs: 0,
        expiresAtMs: 120_000,
      },
      approvalKind: "plugin",
      nowMs: 0,
      view: {
        approvalKind: "plugin",
        approvalId: "plugin:req-1",
        phase: "pending",
        title: "Cancel managed TaskFlow",
        description: "Request cancellation for TaskFlow flow-1.",
        metadata: [],
        severity: "warning",
        actions: [
          {
            kind: "decision",
            decision: "allow-once",
            label: "Allow Once",
            command: "/approve plugin:req-1 allow-once",
            style: "success",
          },
          {
            kind: "decision",
            decision: "deny",
            label: "Deny",
            command: "/approve plugin:req-1 deny",
            style: "danger",
          },
        ],
        expiresAtMs: 120_000,
      } as never,
    })) as TelegramPayload;

    expect(payload.text).toContain("Cancel managed TaskFlow");
    expect(payload.text).toContain("taskflow_request_cancel");
    expect(payload.text).not.toContain("/approve");
    expect(payload.buttons?.[0]?.map((button) => button.text)).toEqual(["Allow Once", "Deny"]);
  });

  it("keeps plugin command actions as text instead of Telegram callbacks", async () => {
    const payload = (await telegramApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: {
        token: "tg-token",
      },
      request: {
        id: "plugin-req-1",
        request: {
          title: "World ID proof",
          description: "Approve the verified proof.",
          actions: [
            {
              kind: "command",
              label: "Open AgentKit",
              style: "primary",
              command: "/agentkit approve plugin-req-1",
            },
            {
              kind: "decision",
              decision: "deny",
              label: "Deny",
              style: "danger",
              command: "/agentkit deny plugin-req-1",
            },
          ],
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "plugin",
      nowMs: 0,
      view: {
        approvalKind: "plugin",
        approvalId: "plugin-req-1",
        title: "World ID proof",
        severity: "warning",
        actions: [
          {
            kind: "command",
            label: "Open AgentKit",
            command: "/agentkit approve plugin-req-1",
            style: "primary",
          },
          {
            kind: "decision",
            decision: "deny",
            label: "Deny",
            command: "/agentkit deny plugin-req-1",
            style: "danger",
          },
        ],
      } as never,
    })) as TelegramPayload;

    expect(payload.text).toContain("/agentkit approve plugin-req-1");
    expect(payload.text).not.toContain("/agentkit deny plugin-req-1");
    expect(payload.buttons).toEqual([
      [{ text: "Deny", callback_data: "/approve plugin-req-1 deny", style: "danger" }],
    ]);
  });

  it("builds forwarded plugin approval payloads with button presentation", () => {
    const payload = buildTelegramPluginApprovalPendingPayload({
      request: {
        id: "plugin:req-1",
        request: {
          title: "Cancel managed TaskFlow",
          description: "Request cancellation for TaskFlow flow-1.",
          pluginId: "taskflow-tools",
          toolName: "taskflow_request_cancel",
          allowedDecisions: ["allow-once", "deny"],
        },
        createdAtMs: 0,
        expiresAtMs: 120_000,
      },
      nowMs: 0,
    });
    const block = payload.presentation?.blocks[0];

    expect(payload.text).toContain("Use the approval buttons below.");
    expect(payload.text).not.toContain("/approve");
    expect(block?.type).toBe("buttons");
    expect(block?.type === "buttons" ? block.buttons.map((button) => button.label) : []).toEqual([
      "Allow Once",
      "Deny",
    ]);
  });

  it("passes topic thread ids to typing and message delivery", async () => {
    const sendTyping = vi.fn().mockResolvedValue({ ok: true });
    const sendMessage = vi.fn().mockResolvedValue({
      chatId: "-1003841603622",
      messageId: "m1",
    });

    const entry = await telegramApprovalNativeRuntime.transport.deliverPending({
      cfg: {} as never,
      accountId: "default",
      context: {
        token: "tg-token",
        deps: {
          sendTyping,
          sendMessage,
        },
      },
      plannedTarget: {
        surface: "origin",
        reason: "preferred",
        target: {
          to: "-1003841603622",
          threadId: 928,
        },
      },
      preparedTarget: {
        chatId: "-1003841603622",
        messageThreadId: 928,
      },
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec",
      view: {
        approvalKind: "exec",
        approvalId: "req-1",
        commandText: "echo hi",
        actions: [],
      } as never,
      pendingPayload: {
        text: "pending",
        buttons: [],
      },
    });

    expect(sendTyping).toHaveBeenCalledWith("-1003841603622", {
      cfg: {},
      token: "tg-token",
      accountId: "default",
      messageThreadId: 928,
    });
    expect(sendMessage).toHaveBeenCalledWith("-1003841603622", "pending", {
      cfg: {},
      token: "tg-token",
      accountId: "default",
      buttons: [],
      messageThreadId: 928,
    });
    expect(entry).toEqual({
      chatId: "-1003841603622",
      messageId: "m1",
    });
  });
});
