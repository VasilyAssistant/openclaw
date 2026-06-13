import { normalizeOptionalString } from "../shared/string-coerce.js";

// Match the agentId charset (`[a-z0-9][a-z0-9_-]{0,63}`) so kebab-case handles
// like `gls-camper-parcel-watch` are accepted. taskName is only ever compared by
// equality as a subagent run handle and stored verbatim on linked TaskFlow tasks;
// it is never split on `-` or used in session-key composition, so allowing
// hyphens stays consistent with TaskFlow task names and avoids spawn_blocked when
// a flow's task name is kebab-case.
const SUBAGENT_TASK_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const RESERVED_SUBAGENT_TASK_NAMES = new Set(["all", "last"]);

type NormalizeSubagentTaskNameResult =
  | { taskName?: string; error?: undefined }
  | { taskName?: undefined; error: string };

export function normalizeSubagentTaskName(value: unknown): NormalizeSubagentTaskNameResult {
  const taskName = normalizeOptionalString(value);
  if (!taskName) {
    return {};
  }
  if (!SUBAGENT_TASK_NAME_RE.test(taskName)) {
    return {
      error: `Invalid taskName "${taskName}". Use 1-64 chars matching [a-z][a-z0-9_-]*.`,
    };
  }
  if (RESERVED_SUBAGENT_TASK_NAMES.has(taskName)) {
    return {
      error: `Invalid taskName "${taskName}". Reserved subagent targets cannot be used as taskName values.`,
    };
  }
  return { taskName };
}
