import type { TaskFlowToolsConfig } from "./config.js";
import type { OpenClawPluginToolContext } from "./types.js";
import { isRecord, normalizeString, requiredString, ToolInputProblem } from "./validation.js";

const MESSAGE_MAX_CHARS = 4000;
const TITLE_MAX_CHARS = 120;
const MIN_DELAY_SECONDS = 30;
const MAX_DELAY_SECONDS = 366 * 24 * 60 * 60;
const MAX_FUTURE_MS = 10 * 366 * 24 * 60 * 60_000;
const CHANNEL_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const TARGET_PATTERN = /^[A-Za-z0-9_:@.+/#-]{1,256}$/u;
const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

export type ScheduleTaskType = "reminder" | "agent_task";

export type NormalizedRecipient = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
};

export type NormalizedScheduleInput = {
  taskType: ScheduleTaskType;
  title: string;
  message: string;
  recurrence: NormalizedRecurrence;
  recipient: NormalizedRecipient;
  deleteAfterRun: boolean;
  idempotencyKey?: string;
};

export type NormalizedRecurrence =
  | { kind: "at"; at: string; atMs: number; summary: string }
  | { kind: "cron"; expr: string; tz: string; summary: string };

type Clock = {
  nowMs?: () => number;
};

function nowMs(clock: Clock): number {
  return clock.nowMs?.() ?? Date.now();
}

function assertLength(value: string, field: string, maxChars: number): string {
  if (value.length > maxChars) {
    throw new ToolInputProblem(`${field}_too_large`, `${field} exceeds ${maxChars} characters.`, {
      maxChars,
    });
  }
  return value;
}

function assertTimezone(timezone: string): string {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    return timezone;
  } catch {
    throw new ToolInputProblem("invalid_timezone", `Invalid timezone: ${timezone}`, {
      timezone,
    });
  }
}

function parseTimeOfDay(value: unknown): { hour: number; minute: number; label: string } {
  const raw = normalizeString(value);
  const match = raw?.match(/^([01]\d|2[0-3]):([0-5]\d)$/u);
  if (!match || !match[1] || !match[2]) {
    throw new ToolInputProblem("invalid_time", "time must use HH:MM 24-hour format.");
  }
  return { hour: Number(match[1]), minute: Number(match[2]), label: raw ?? "" };
}

function normalizeCronField(field: string, label: string): string {
  if (!/^[0-9*,/-]+$/u.test(field)) {
    throw new ToolInputProblem("invalid_cron", `cron ${label} contains unsupported characters.`);
  }
  if (field.includes("//") || field.includes(",,") || field.includes("--")) {
    throw new ToolInputProblem("invalid_cron", `cron ${label} is malformed.`);
  }
  return field;
}

function assertCronNotTooFrequent(minuteField: string, hourField: string): void {
  if (minuteField === "*" && hourField === "*") {
    throw new ToolInputProblem("cron_too_frequent", "cron schedules must not run every minute.");
  }
  const step = minuteField.match(/^\*\/(\d+)$/u);
  if (step && Number(step[1]) < 15) {
    throw new ToolInputProblem(
      "cron_too_frequent",
      "cron minute steps must be at least 15 minutes.",
    );
  }
}

function normalizeCronExpr(value: unknown): string {
  const expr = normalizeString(value);
  if (!expr) {
    throw new ToolInputProblem("missing_arg", "recurrence.expr required", {
      arg: "recurrence.expr",
    });
  }
  const fields = expr.split(/\s+/u);
  if (fields.length !== 5) {
    throw new ToolInputProblem("invalid_cron", "cron expr must have exactly five fields.");
  }
  const normalized = fields.map((field, index) =>
    normalizeCronField(
      field,
      ["minute", "hour", "day-of-month", "month", "day-of-week"][index] ?? "field",
    ),
  );
  assertCronNotTooFrequent(normalized[0], normalized[1]);
  return normalized.join(" ");
}

function normalizeWeekdays(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolInputProblem(
      "invalid_weekdays",
      "weekly recurrence requires non-empty days array.",
    );
  }
  const days = value.map((entry) => {
    if (typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry <= 6) {
      return entry;
    }
    const label = normalizeString(entry)?.toLowerCase();
    if (label && label in WEEKDAYS) {
      return WEEKDAYS[label];
    }
    throw new ToolInputProblem(
      "invalid_weekdays",
      "weekly recurrence days must be 0-6 or weekday names.",
    );
  });
  return Array.from(new Set(days))
    .toSorted((left, right) => left - right)
    .join(",");
}

function normalizeAtRecurrence(
  recurrence: Record<string, unknown>,
  clock: Clock,
): NormalizedRecurrence {
  const baseNow = nowMs(clock);
  let atMs: number;
  const at = normalizeString(recurrence.at) ?? normalizeString(recurrence.atIso);
  const delaySeconds = recurrence.delaySeconds;
  if (at && delaySeconds !== undefined) {
    throw new ToolInputProblem(
      "invalid_schedule",
      "Use either recurrence.at or recurrence.delaySeconds, not both.",
    );
  }
  if (at) {
    atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) {
      throw new ToolInputProblem(
        "invalid_schedule",
        "recurrence.at must be an ISO-8601 timestamp.",
      );
    }
  } else if (typeof delaySeconds === "number" && Number.isFinite(delaySeconds)) {
    const seconds = Math.trunc(delaySeconds);
    if (seconds < MIN_DELAY_SECONDS || seconds > MAX_DELAY_SECONDS) {
      throw new ToolInputProblem(
        "invalid_delay",
        `recurrence.delaySeconds must be between ${MIN_DELAY_SECONDS} and ${MAX_DELAY_SECONDS}.`,
      );
    }
    atMs = baseNow + seconds * 1000;
  } else {
    throw new ToolInputProblem("missing_arg", "once recurrence requires at or delaySeconds.");
  }
  if (atMs < baseNow + MIN_DELAY_SECONDS * 1000) {
    throw new ToolInputProblem(
      "schedule_too_soon",
      "schedule must be at least 30 seconds in the future.",
    );
  }
  if (atMs > baseNow + MAX_FUTURE_MS) {
    throw new ToolInputProblem(
      "schedule_too_far",
      "schedule must be less than 10 years in the future.",
    );
  }
  const iso = new Date(atMs).toISOString();
  return { kind: "at", at: iso, atMs, summary: `once at ${iso}` };
}

function normalizeRecurrence(
  value: unknown,
  cfg: TaskFlowToolsConfig,
  clock: Clock,
): NormalizedRecurrence {
  if (!isRecord(value)) {
    throw new ToolInputProblem("invalid_schedule", "recurrence must be an object.");
  }
  const kind = normalizeString(value.kind);
  switch (kind) {
    case "once":
    case "at":
      return normalizeAtRecurrence(value, clock);
    case "daily": {
      const time = parseTimeOfDay(value.time);
      const tz = assertTimezone(normalizeString(value.timezone) ?? cfg.defaultTimezone);
      const expr = `${time.minute} ${time.hour} * * *`;
      return { kind: "cron", expr, tz, summary: `daily at ${time.label} ${tz}` };
    }
    case "weekly": {
      const time = parseTimeOfDay(value.time);
      const tz = assertTimezone(normalizeString(value.timezone) ?? cfg.defaultTimezone);
      const days = normalizeWeekdays(value.days);
      const expr = `${time.minute} ${time.hour} * * ${days}`;
      return { kind: "cron", expr, tz, summary: `weekly ${days} at ${time.label} ${tz}` };
    }
    case "cron": {
      const expr = normalizeCronExpr(value.expr);
      const tz = assertTimezone(normalizeString(value.timezone) ?? cfg.defaultTimezone);
      return { kind: "cron", expr, tz, summary: `cron ${expr} ${tz}` };
    }
    default:
      throw new ToolInputProblem(
        "invalid_schedule_kind",
        'recurrence.kind must be one of "once", "daily", "weekly", or "cron".',
      );
  }
}

function normalizeTaskType(value: unknown): ScheduleTaskType {
  if (value === "reminder" || value === "agent_task") {
    return value;
  }
  throw new ToolInputProblem("invalid_task_type", 'taskType must be "reminder" or "agent_task".');
}

function normalizeThreadId(value: unknown): string | number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  const text = normalizeString(value);
  if (!text || text.length > 128 || !TARGET_PATTERN.test(text)) {
    throw new ToolInputProblem("invalid_recipient", "recipient.threadId is invalid.");
  }
  return text;
}

function normalizeRecipient(
  value: unknown,
  cfg: TaskFlowToolsConfig,
  ctx: OpenClawPluginToolContext,
): NormalizedRecipient {
  const recipient = isRecord(value) ? value : {};
  const fallback = ctx.deliveryContext;
  const channel =
    normalizeString(recipient.channel) ??
    normalizeString(fallback?.channel) ??
    normalizeString(ctx.messageChannel);
  const to = normalizeString(recipient.to) ?? normalizeString(fallback?.to);
  const accountId = normalizeString(recipient.accountId) ?? normalizeString(fallback?.accountId);
  const threadId =
    normalizeThreadId(recipient.threadId) ??
    (typeof fallback?.threadId === "string" || typeof fallback?.threadId === "number"
      ? fallback.threadId
      : undefined);
  if (!channel || !CHANNEL_PATTERN.test(channel)) {
    throw new ToolInputProblem(
      "invalid_recipient",
      "recipient.channel is required and must be a safe channel id.",
    );
  }
  if (cfg.allowedRecipientChannels && !cfg.allowedRecipientChannels.includes(channel)) {
    throw new ToolInputProblem("recipient_channel_denied", "recipient.channel is not allowed.", {
      channel,
    });
  }
  const currentChannel = normalizeString(fallback?.channel) ?? normalizeString(ctx.messageChannel);
  if (!cfg.allowedRecipientChannels && currentChannel && channel !== currentChannel) {
    throw new ToolInputProblem(
      "recipient_channel_denied",
      "recipient.channel must match the current conversation.",
    );
  }
  if (!to || !TARGET_PATTERN.test(to)) {
    throw new ToolInputProblem(
      "invalid_recipient",
      "recipient.to is required and must be a safe target.",
    );
  }
  return {
    channel,
    to,
    ...(accountId ? { accountId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
  };
}

export function normalizeScheduleInput(
  params: Record<string, unknown>,
  cfg: TaskFlowToolsConfig,
  ctx: OpenClawPluginToolContext,
  clock: Clock,
): NormalizedScheduleInput {
  const taskType = normalizeTaskType(params.taskType);
  const message = assertLength(requiredString(params, "message"), "message", MESSAGE_MAX_CHARS);
  const title = assertLength(
    normalizeString(params.title) ?? (taskType === "reminder" ? "Reminder" : "Scheduled task"),
    "title",
    TITLE_MAX_CHARS,
  );
  const recurrence = normalizeRecurrence(params.recurrence, cfg, clock);
  const recipient = normalizeRecipient(params.recipient, cfg, ctx);
  const deleteAfterRun =
    typeof params.deleteAfterRun === "boolean" ? params.deleteAfterRun : recurrence.kind === "at";
  return {
    taskType,
    title,
    message,
    recurrence,
    recipient,
    deleteAfterRun,
    ...(normalizeString(params.idempotencyKey)
      ? { idempotencyKey: normalizeString(params.idempotencyKey) }
      : {}),
  };
}

export function buildCronJob(input: NormalizedScheduleInput): Record<string, unknown> {
  const schedule =
    input.recurrence.kind === "at"
      ? { kind: "at", at: input.recurrence.at }
      : { kind: "cron", expr: input.recurrence.expr, tz: input.recurrence.tz };
  return {
    name: input.title,
    schedule,
    sessionTarget: "isolated",
    wakeMode: "now",
    deleteAfterRun: input.deleteAfterRun,
    payload: {
      kind: "agentTurn",
      message: buildScheduledPrompt(input),
    },
    delivery: {
      mode: "announce",
      channel: input.recipient.channel,
      to: input.recipient.to,
      ...(input.recipient.accountId ? { accountId: input.recipient.accountId } : {}),
      ...(input.recipient.threadId !== undefined ? { threadId: input.recipient.threadId } : {}),
    },
  };
}

export function buildScheduledPrompt(input: NormalizedScheduleInput): string {
  if (input.taskType === "reminder") {
    return [
      "Send the user this scheduled reminder now.",
      "Keep it direct, brief, and in your normal assistant voice.",
      `Reminder: ${input.message}`,
    ].join("\n");
  }
  return [
    "Run this scheduled task now and report the useful outcome to the configured recipient.",
    "Do not create another schedule unless the task explicitly asks for it.",
    `Task: ${input.message}`,
  ].join("\n");
}

export function describeScheduleApproval(input: NormalizedScheduleInput): string {
  const preview = input.message.replace(/\s+/gu, " ").trim().slice(0, 160);
  return [
    `Type: ${input.taskType}`,
    `Schedule: ${input.recurrence.summary}`,
    `Recipient: ${input.recipient.channel}:${input.recipient.to}`,
    `Message: ${preview}`,
  ].join("\n");
}
