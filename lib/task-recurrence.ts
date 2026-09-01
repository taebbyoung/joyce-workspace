export const taskRecurrenceRules = new Set([
  "none",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "custom",
]);

export function nextRecurringDate(value: string, recurrence: string) {
  if (!value || recurrence === "none") return null;
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  if (recurrence === "daily") date.setUTCDate(date.getUTCDate() + 1);
  if (recurrence === "weekly") date.setUTCDate(date.getUTCDate() + 7);
  if (recurrence === "monthly") {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + 1);
    const finalDay = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
    ).getUTCDate();
    date.setUTCDate(Math.min(day, finalDay));
  }
  if (recurrence === "yearly") {
    const month = date.getUTCMonth();
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCFullYear(date.getUTCFullYear() + 1);
    date.setUTCMonth(month);
    const finalDay = new Date(
      Date.UTC(date.getUTCFullYear(), month + 1, 0),
    ).getUTCDate();
    date.setUTCDate(Math.min(day, finalDay));
  }
  if (!["daily", "weekly", "monthly", "yearly"].includes(recurrence)) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}
