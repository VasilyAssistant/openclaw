import { isRecord, normalizeString } from "./validation.js";

export type TaskFlowToolsConfig = {
  requireCreateApproval: boolean;
  requireCancelApproval: boolean;
  requireScheduleApproval: boolean;
  defaultTimezone: string;
  allowedRecipientChannels?: string[];
};

function parseChannelList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const channels = value
    .map((entry) => normalizeString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return channels.length > 0 ? Array.from(new Set(channels)) : undefined;
}

export function parseConfig(rawConfig: unknown): TaskFlowToolsConfig {
  const raw = isRecord(rawConfig) ? rawConfig : {};
  const defaultTimezone = normalizeString(raw.defaultTimezone) ?? "UTC";
  return {
    requireCreateApproval: raw.requireCreateApproval !== false,
    requireCancelApproval: raw.requireCancelApproval !== false,
    requireScheduleApproval: raw.requireScheduleApproval !== false,
    defaultTimezone,
    allowedRecipientChannels: parseChannelList(raw.allowedRecipientChannels),
  };
}
