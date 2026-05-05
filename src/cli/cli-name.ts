// CLI-name helpers keep generated examples aligned with the binary the user invoked.
import path from "node:path";

const DEFAULT_CLI_NAME = "openclaw";

const KNOWN_CLI_NAMES = new Set([DEFAULT_CLI_NAME]);
const CLI_PREFIX_RE = /^(?:((?:pnpm|npm|bunx|npx)\s+))?(openclaw)\b/;
const CLI_DISPLAY_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function resolveCliDisplayName(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string | null {
  const raw = env.OPENCLAW_CLI_DISPLAY_NAME?.trim();
  if (!raw || !CLI_DISPLAY_NAME_RE.test(raw)) {
    return null;
  }
  return raw;
}

/** Resolve the displayed CLI binary name from argv, falling back to `openclaw`. */
export function resolveCliName(
  argv: string[] = process.argv,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  const displayName = resolveCliDisplayName(env);
  if (displayName) {
    return displayName;
  }
  const argv1 = argv[1];
  if (!argv1) {
    return DEFAULT_CLI_NAME;
  }
  const base = path.basename(argv1).trim();
  if (KNOWN_CLI_NAMES.has(base)) {
    return base;
  }
  return DEFAULT_CLI_NAME;
}

/** Replace a leading `openclaw` command prefix with the active CLI name. */
export function replaceCliName(command: string, cliName = resolveCliName()): string {
  if (!command.trim()) {
    return command;
  }
  if (!CLI_PREFIX_RE.test(command)) {
    return command;
  }
  return command.replace(CLI_PREFIX_RE, (_match, runner: string | undefined) => {
    return `${runner ?? ""}${cliName}`;
  });
}
