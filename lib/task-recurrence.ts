export const taskRecurrenceRules = new Set([
  "none",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "custom",
]);

export const fixedCalendarRecurrenceRules = new Set([
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);

type TaskRow = Record<string, unknown>;

type RecurrenceMetadata = Record<string, unknown> & {
  recurrenceAnchorDate?: string;
  recurrenceRule?: string;
  recurringOccurrenceDate?: string;
  recurringSeriesId?: string;
};

function dateOnly(value: unknown) {
  const text = String(value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const parsed = new Date(`${text}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === text
    ? text
    : "";
}

function parseDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function occurrenceAt(anchor: Date, recurrence: string, step: number) {
  const date = new Date(anchor);
  if (recurrence === "daily") {
    date.setUTCDate(date.getUTCDate() + step);
    return date;
  }
  if (recurrence === "weekly") {
    date.setUTCDate(date.getUTCDate() + step * 7);
    return date;
  }
  if (recurrence === "monthly") {
    const day = anchor.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + step);
    const finalDay = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
    ).getUTCDate();
    date.setUTCDate(Math.min(day, finalDay));
    return date;
  }
  if (recurrence === "yearly") {
    const month = anchor.getUTCMonth();
    const day = anchor.getUTCDate();
    date.setUTCDate(1);
    date.setUTCFullYear(date.getUTCFullYear() + step);
    date.setUTCMonth(month);
    const finalDay = new Date(
      Date.UTC(date.getUTCFullYear(), month + 1, 0),
    ).getUTCDate();
    date.setUTCDate(Math.min(day, finalDay));
    return date;
  }
  return null;
}

function initialStep(anchor: Date, threshold: Date, recurrence: string) {
  if (recurrence === "daily" || recurrence === "weekly") {
    const interval = recurrence === "daily" ? 1 : 7;
    const elapsedDays = Math.floor(
      (threshold.getTime() - anchor.getTime()) / 86_400_000,
    );
    return Math.max(1, Math.floor(elapsedDays / interval) + 1);
  }
  if (recurrence === "monthly") {
    const elapsedMonths =
      (threshold.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
      threshold.getUTCMonth() -
      anchor.getUTCMonth();
    return Math.max(1, elapsedMonths);
  }
  if (recurrence === "yearly") {
    return Math.max(
      1,
      threshold.getUTCFullYear() - anchor.getUTCFullYear(),
    );
  }
  return 1;
}

export function nextRecurringDate(
  value: string,
  recurrence: string,
  effectiveToday = value,
) {
  const anchorText = dateOnly(value);
  const todayText = dateOnly(effectiveToday);
  if (
    !anchorText ||
    !todayText ||
    !fixedCalendarRecurrenceRules.has(recurrence)
  ) {
    return null;
  }
  const anchor = parseDate(anchorText);
  const threshold = parseDate(todayText);
  if (!anchor || !threshold) return null;

  let step = initialStep(anchor, threshold, recurrence);
  let next = occurrenceAt(anchor, recurrence, step);
  while (next && formatDate(next) <= todayText) {
    step += 1;
    next = occurrenceAt(anchor, recurrence, step);
  }
  return next ? formatDate(next) : null;
}

function parseMetadata(value: unknown): RecurrenceMetadata {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as RecurrenceMetadata)
      : {};
  } catch {
    return {};
  }
}

function plannedDate(task: TaskRow, fallback: string) {
  return (
    dateOnly(task.reminder_date) ||
    dateOnly(task.next_action_date) ||
    dateOnly(task.due_date) ||
    fallback
  );
}

function nextDateFields(task: TaskRow, nextDate: string) {
  if (dateOnly(task.reminder_date)) {
    return { reminder_date: nextDate };
  }
  if (dateOnly(task.next_action_date)) {
    return { next_action_date: nextDate };
  }
  if (dateOnly(task.due_date)) {
    return { due_date: nextDate };
  }
  return { reminder_date: nextDate };
}

export function buildNextRecurringTask(
  task: TaskRow,
  effectiveToday: string,
  now: string,
) {
  const recurrence = String(task.recurrence_rule ?? "none");
  const today = dateOnly(effectiveToday);
  const taskId = String(task.id ?? "");
  if (!taskId || !today || !fixedCalendarRecurrenceRules.has(recurrence)) {
    return null;
  }

  const occurrenceDate = plannedDate(task, today);
  const metadata = parseMetadata(task.legacy_metadata);
  const storedOccurrence = dateOnly(metadata.recurringOccurrenceDate);
  const storedAnchor = dateOnly(metadata.recurrenceAnchorDate);
  const keepsStoredAnchor =
    storedOccurrence === occurrenceDate &&
    metadata.recurrenceRule === recurrence &&
    Boolean(storedAnchor);
  const anchorDate = keepsStoredAnchor ? storedAnchor : occurrenceDate;
  const threshold = occurrenceDate > today ? occurrenceDate : today;
  const nextDate = nextRecurringDate(anchorDate, recurrence, threshold);
  if (!nextDate) return null;

  const seriesId = String(metadata.recurringSeriesId || taskId);
  const nextMetadata: RecurrenceMetadata = {
    ...metadata,
    recurrenceAnchorDate: anchorDate,
    recurrenceRule: recurrence,
    recurringOccurrenceDate: nextDate,
    recurringSeriesId: seriesId,
  };
  const nextTask: TaskRow = {
    ...task,
    ...nextDateFields(task, nextDate),
    id: `recurring:${seriesId}:${nextDate}`,
    status: "pending",
    snoozed_until: null,
    completed_at: null,
    cancelled_at: null,
    archived_at: null,
    deleted_at: null,
    purge_after: null,
    legacy_metadata: JSON.stringify(nextMetadata),
    created_at: now,
    updated_at: now,
  };
  return { nextDate, nextTask };
}
