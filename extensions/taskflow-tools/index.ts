import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createTaskFlowTools, TASKFLOW_TOOL_NAMES } from "./src/tools.js";
import type { ToolName } from "./src/types.js";

function toolRisk(toolName: ToolName): "low" | "medium" | "high" {
  if (toolName === "taskflow_list_own" || toolName === "taskflow_get_own") {
    return "low";
  }
  if (toolName === "taskflow_request_schedule") {
    return "high";
  }
  return "medium";
}

export default definePluginEntry({
  id: "taskflow-tools",
  name: "TaskFlow Tools",
  description: "Trusted minimal TaskFlow tools for managed flows and approval-gated schedules.",
  register(api: OpenClawPluginApi) {
    for (const toolName of TASKFLOW_TOOL_NAMES) {
      api.registerToolMetadata?.({
        toolName,
        displayName: toolName,
        description: `Trusted TaskFlow wrapper for ${toolName}.`,
        risk: toolRisk(toolName),
        tags: ["taskflow", "owner-scoped", "approval-gated"],
      });
    }
    api.registerTool?.((ctx: OpenClawPluginToolContext) => createTaskFlowTools(api, ctx), {
      names: [...TASKFLOW_TOOL_NAMES],
      optional: true,
    });
  },
});

export { createTaskFlowTools, TASKFLOW_TOOL_NAMES };
