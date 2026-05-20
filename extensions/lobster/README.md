# Lobster (plugin)

Adds the `lobster` agent tool as an **optional** plugin tool.

## What this is

- Lobster is a standalone workflow shell (typed JSON-first pipelines + approvals/resume).
- This plugin integrates Lobster with OpenClaw _without core changes_.

## Enable

Because this tool can trigger side effects (via workflows), it is registered with `optional: true`.

Enable it in an agent allowlist:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": [
            "lobster" // plugin id (enables all tools from this plugin)
          ]
        }
      }
    ]
  }
}
```

## Managed Workflow Bridge

`lobster_managed_workflow` is a narrower optional tool for sandboxed agents. It
does not accept arbitrary pipelines from the model. The host config owns named
workflows under `plugins.entries.lobster.config.managedWorkflows`, and the agent
passes only `workflowId`, `argsJson`, and an `idempotencyKey`.

Example config:

```jsonc
{
  "plugins": {
    "entries": {
      "lobster": {
        "enabled": true,
        "config": {
          "managedWorkflows": {
            "task/create-after-approval": {
              "pipeline": "tasks.preview | approve --prompt 'Create task?' | tasks.create",
              "goal": "Create a task after approval",
              "allowSandboxed": true,
              "approvalMode": "plugin-inline",
              "approvalTimeoutMs": 600000
            }
          }
        }
      }
    }
  },
  "tools": {
    "allow": ["lobster_managed_workflow"]
  }
}
```

With `approvalMode: "plugin-inline"`, the tool stores the TaskFlow wait state,
requests a normal plugin approval, waits for the decision, then resumes the
Lobster approval with the Lobster `approvalId` or resume token. Side effects
must stay after the Lobster `approve` step.

## Embedded Runner Limitation

The bundled Lobster plugin uses the embedded in-process runner. In that mode,
`openclaw.invoke` steps do not automatically inherit a Gateway URL/auth context
for nested OpenClaw tool calls. Managed workflows should use steps that are
valid in the embedded runtime, or a host-owned side-effect adapter that does not
depend on nested `openclaw.invoke`, until the embedded tool bridge is supported.

## Security

- Runs Lobster in process via the published `@clawdbot/lobster/core` runtime.
- Does not manage OAuth/tokens.
- Uses timeouts, stdout caps, and strict JSON envelope parsing.
