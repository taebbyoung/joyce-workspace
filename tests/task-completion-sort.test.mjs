import assert from "node:assert/strict";
import test from "node:test";

import { sortTasksByCompletedAt } from "../lib/task-completion-sort.ts";

test("completed tasks sort newest first and keep missing completion times last", () => {
  const tasks = [
    { id: "missing-a", completed_at: null },
    { id: "yesterday", completed_at: "2026-08-06T16:45:00.000Z" },
    { id: "latest", completed_at: "2026-08-07T15:30:00.000Z" },
    { id: "missing-b", completed_at: "" },
    { id: "morning", completed_at: "2026-08-07T10:20:00.000Z" },
  ];

  assert.deepEqual(
    sortTasksByCompletedAt(tasks).map((task) => task.id),
    ["latest", "morning", "yesterday", "missing-a", "missing-b"],
  );
  assert.deepEqual(
    tasks.map((task) => task.id),
    ["missing-a", "yesterday", "latest", "missing-b", "morning"],
  );
});
