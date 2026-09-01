type RecordLike = Record<string, any>;

const activeTaskStatuses = new Set([
  "pending",
  "in_progress",
  "Pending",
  "In Progress",
  "待处理",
  "进行中",
  "snoozed",
  "Snoozed",
  "延期",
]);

export function workTaskReminderDate(task: RecordLike) {
  return String(
    task.reminder_date ?? task.next_action_date ?? task.due_date ?? "",
  ).slice(0, 10);
}

export function isWorkTaskAttentionEligible(task: RecordLike, today: string) {
  const reminderDate = workTaskReminderDate(task);
  return Boolean(
    task.id &&
      !task.deleted_at &&
      !task.archived_at &&
      !task.completed_at &&
      activeTaskStatuses.has(String(task.status)) &&
      reminderDate &&
      reminderDate < today,
  );
}

export function buildWorkTaskAttention(task: RecordLike) {
  const reminderDate = workTaskReminderDate(task);
  const evidenceSource = task.reminder_date
    ? "tasks.reminder_date"
    : task.next_action_date
      ? "tasks.next_action_date"
      : "tasks.due_date";
  return {
    kind: "task",
    id: task.id,
    order_id: null,
    source_type: "task",
    source_id: task.id,
    title: task.title,
    message: `任务提醒日期已到：${reminderDate}`,
    risk_level: "High",
    evidence_source: evidenceSource,
    attention_date: reminderDate,
  };
}

export function syncWorkTaskAttention(
  attention: RecordLike[],
  task: RecordLike | undefined,
  today: string,
) {
  if (!task) return attention;
  const taskId = String(task.id);
  const withoutTask = attention.filter(
    (item) =>
      !(
        String(item.source_type || item.kind) === "task" &&
        String(item.source_id || item.id) === taskId
      ),
  );
  return isWorkTaskAttentionEligible(task, today)
    ? [...withoutTask, buildWorkTaskAttention(task)]
    : withoutTask;
}

export function attentionIdentity(item: RecordLike) {
  return `${String(item.source_type || item.kind || "unknown")}:${String(
    item.source_id || item.id || "missing",
  )}`;
}

export function sortWorkAttention(items: RecordLike[]) {
  return [...items].sort((left, right) => {
    const leftDate = String(left.attention_date || "9999-12-31").slice(0, 10);
    const rightDate = String(right.attention_date || "9999-12-31").slice(0, 10);
    return leftDate.localeCompare(rightDate) ||
      attentionIdentity(left).localeCompare(attentionIdentity(right));
  });
}

export function groupHomeAttention(
  attention: RecordLike[],
  homeLimit = 5,
) {
  const workAttention = sortWorkAttention(
    attention.filter((item) => String(item.source_type || item.kind) === "task"),
  );
  const otherAttention = attention.filter(
    (item) => String(item.source_type || item.kind) !== "task",
  );
  // Preserve the existing homepage order: overdue Work first, followed by
  // the remaining business attentions from the shared workspace payload.
  const allItems = [...workAttention, ...otherAttention];
  return {
    total: allItems.length,
    allItems,
    visibleItems: allItems.slice(0, homeLimit),
    workTotal: workAttention.length,
  };
}

function dayNumber(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return Number.NaN;
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

export function workAttentionMessage(item: RecordLike, today: string) {
  const reminderDate = String(item.attention_date || "").slice(0, 10);
  if (!reminderDate) return String(item.message || "任务提醒日期已到");
  const overdueDays = dayNumber(today) - dayNumber(reminderDate);
  if (!Number.isFinite(overdueDays)) return String(item.message || "任务提醒日期已到");
  if (overdueDays <= 0) return "今天到期";
  return `已逾期 ${overdueDays} 天`;
}
