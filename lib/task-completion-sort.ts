type TaskWithCompletion = {
  completed_at?: unknown;
};

export function sortTasksByCompletedAt<T extends TaskWithCompletion>(tasks: T[]) {
  return [...tasks].sort((left, right) => {
    const leftCompletedAt = String(left.completed_at ?? "").trim();
    const rightCompletedAt = String(right.completed_at ?? "").trim();

    if (leftCompletedAt && rightCompletedAt) {
      return rightCompletedAt.localeCompare(leftCompletedAt);
    }
    if (leftCompletedAt) return -1;
    if (rightCompletedAt) return 1;
    return 0;
  });
}
