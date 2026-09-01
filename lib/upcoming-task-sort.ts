type UpcomingTask = {
  id?: unknown;
  reminder_date?: unknown;
  next_action_date?: unknown;
  due_date?: unknown;
  work_sort_order?: unknown;
  created_at?: unknown;
};

export function taskReminderDate(task: UpcomingTask) {
  const value = String(
    task.reminder_date ?? task.next_action_date ?? task.due_date ?? "",
  ).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return "";

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return "";
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function sortUpcomingTasks<T extends UpcomingTask>(
  tasks: T[],
  manualIds: string[] = [],
) {
  const manualPositions = new Map(
    manualIds.map((id, index) => [String(id), index]),
  );

  return [...tasks].sort((left, right) => {
    const leftDate = taskReminderDate(left);
    const rightDate = taskReminderDate(right);

    if (leftDate && rightDate && leftDate !== rightDate) {
      return leftDate.localeCompare(rightDate);
    }
    if (leftDate && !rightDate) return -1;
    if (!leftDate && rightDate) return 1;

    const leftId = String(left.id ?? "");
    const rightId = String(right.id ?? "");
    const leftManual = manualPositions.get(leftId);
    const rightManual = manualPositions.get(rightId);
    if (leftManual !== undefined || rightManual !== undefined) {
      if (leftManual === undefined) return 1;
      if (rightManual === undefined) return -1;
      if (leftManual !== rightManual) return leftManual - rightManual;
    }

    const leftOrder = Number(left.work_sort_order);
    const rightOrder = Number(right.work_sort_order);
    const normalizedLeftOrder =
      Number.isFinite(leftOrder) && leftOrder > 0
        ? leftOrder
        : Number.MAX_SAFE_INTEGER;
    const normalizedRightOrder =
      Number.isFinite(rightOrder) && rightOrder > 0
        ? rightOrder
        : Number.MAX_SAFE_INTEGER;
    if (normalizedLeftOrder !== normalizedRightOrder) {
      return normalizedLeftOrder - normalizedRightOrder;
    }

    const createdComparison = String(left.created_at ?? "").localeCompare(
      String(right.created_at ?? ""),
    );
    if (createdComparison) return createdComparison;
    return leftId.localeCompare(rightId);
  });
}
