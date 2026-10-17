export type WorkspaceTimezoneMode = "auto" | "manual";

export type WorkspaceTimezonePreference = {
  mode: WorkspaceTimezoneMode;
  timezone: string | null;
};

export const DEFAULT_WORKSPACE_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_TIMEZONE_PREFERENCE: WorkspaceTimezonePreference = {
  mode: "auto",
  timezone: null,
};

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateOnly(value: unknown): value is string {
  const text = String(value ?? "").trim();
  if (!DATE_ONLY_PATTERN.test(text)) return false;
  const parsed = new Date(`${text}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

export function isValidIanaTimezone(value: unknown): value is string {
  const timezone = String(value ?? "").trim();
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function getDeviceTimezone() {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidIanaTimezone(timezone) ? timezone : DEFAULT_WORKSPACE_TIMEZONE;
  } catch {
    return DEFAULT_WORKSPACE_TIMEZONE;
  }
}

export function normalizeTimezonePreference(
  value: unknown,
): WorkspaceTimezonePreference {
  if (!value || typeof value !== "object") return DEFAULT_TIMEZONE_PREFERENCE;
  const row = value as Record<string, unknown>;
  if (row.mode !== "manual") return DEFAULT_TIMEZONE_PREFERENCE;
  const timezone = String(row.timezone ?? "").trim();
  return { mode: "manual", timezone: timezone || null };
}

export function resolveWorkspaceTimezone(
  preference: WorkspaceTimezonePreference,
  deviceTimezone = getDeviceTimezone(),
) {
  return preference.mode === "manual" && isValidIanaTimezone(preference.timezone)
    ? preference.timezone
    : isValidIanaTimezone(deviceTimezone)
      ? deviceTimezone
      : DEFAULT_WORKSPACE_TIMEZONE;
}

export function getBusinessDate(now = new Date(), timezone = getDeviceTimezone()) {
  const safeTimezone = isValidIanaTimezone(timezone)
    ? timezone
    : DEFAULT_WORKSPACE_TIMEZONE;
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: safeTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function addBusinessDateDays(value: string, days: number) {
  if (!isValidDateOnly(value)) return value;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return date.toISOString().slice(0, 10);
}

export function businessDayDifference(later: string, earlier: string) {
  if (!isValidDateOnly(later) || !isValidDateOnly(earlier)) return 0;
  return Math.round(
    (Date.parse(`${later}T12:00:00Z`) - Date.parse(`${earlier}T12:00:00Z`)) /
      86_400_000,
  );
}

export function getNextMidnightDelay(
  now = new Date(),
  timezone = getDeviceTimezone(),
  bufferMs = 1_500,
) {
  const currentDate = getBusinessDate(now, timezone);
  const start = now.getTime();
  let low = start;
  let high = start + 36 * 60 * 60 * 1000;
  while (getBusinessDate(new Date(high), timezone) === currentDate) {
    high += 12 * 60 * 60 * 1000;
  }
  while (high - low > 1_000) {
    const middle = Math.floor((low + high) / 2);
    if (getBusinessDate(new Date(middle), timezone) === currentDate) low = middle;
    else high = middle;
  }
  return Math.max(1_000, high + bufferMs - start);
}

export function workspaceTimeUrl(
  path: string,
  businessDate: string,
  timezone: string,
) {
  const separator = path.includes("?") ? "&" : "?";
  const query = new URLSearchParams({ businessDate, timezone });
  return `${path}${separator}${query.toString()}`;
}

export function getRequestWorkspaceTime(request: Request) {
  const url = new URL(request.url);
  const requestedTimezone = url.searchParams.get("timezone");
  const timezone = isValidIanaTimezone(requestedTimezone)
    ? requestedTimezone
    : DEFAULT_WORKSPACE_TIMEZONE;
  const requestedDate = url.searchParams.get("businessDate");
  const businessDate = isValidDateOnly(requestedDate)
    ? requestedDate
    : getBusinessDate(new Date(), timezone);
  return { businessDate, timezone };
}

export function formatTimestampInTimezone(
  value: unknown,
  timezone: string,
  options: Intl.DateTimeFormatOptions,
) {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return String(value ?? "");
  return new Intl.DateTimeFormat("zh-CN", {
    ...options,
    timeZone: isValidIanaTimezone(timezone) ? timezone : DEFAULT_WORKSPACE_TIMEZONE,
  }).format(date);
}
