import assert from "node:assert/strict";
import test from "node:test";

import {
  sortUpcomingTasks,
  taskReminderDate,
} from "../lib/upcoming-task-sort.ts";

test("upcoming tasks sort by reminder date ascending", () => {
  const tasks = [
    { id: "sep-20", reminder_date: "2026-09-20", work_sort_order: 100 },
    { id: "aug-22", reminder_date: "2026-08-22", work_sort_order: 400 },
    { id: "sep-03", reminder_date: "2026-09-03", work_sort_order: 200 },
    { id: "aug-18", reminder_date: "2026-08-18", work_sort_order: 300 },
    { id: "aug-16", reminder_date: "2026-08-16", work_sort_order: 500 },
  ];

  assert.deepEqual(
    sortUpcomingTasks(tasks).map((task) => task.id),
    ["aug-16", "aug-18", "aug-22", "sep-03", "sep-20"],
  );
});

test("manual order applies only inside the same reminder date", () => {
  const tasks = [
    { id: "later", reminder_date: "2026-08-21", work_sort_order: 100 },
    { id: "same-a", reminder_date: "2026-08-20", work_sort_order: 200 },
    { id: "same-b", reminder_date: "2026-08-20", work_sort_order: 300 },
  ];

  assert.deepEqual(
    sortUpcomingTasks(tasks, ["later", "same-b", "same-a"]).map(
      (task) => task.id,
    ),
    ["same-b", "same-a", "later"],
  );
});

test("tasks without a valid reminder date stay at the end", () => {
  const tasks = [
    { id: "missing", reminder_date: null, work_sort_order: 100 },
    { id: "dated", reminder_date: "2026-08-20", work_sort_order: 400 },
    { id: "invalid", reminder_date: "2026-02-30", work_sort_order: 200 },
    { id: "legacy", next_action_date: "2026-08-21", work_sort_order: 300 },
  ];

  assert.deepEqual(
    sortUpcomingTasks(tasks).map((task) => task.id),
    ["dated", "legacy", "missing", "invalid"],
  );
});

test("date-only comparison does not shift dates across time zones", () => {
  assert.equal(taskReminderDate({ reminder_date: "2026-08-20" }), "2026-08-20");
  assert.equal(
    taskReminderDate({ reminder_date: "2026-08-20T00:00:00.000Z" }),
    "2026-08-20",
  );
});

test("sorting is stable across optimistic and server response input order", () => {
  const manualIds = ["same-b", "same-a"];
  const optimistic = [
    { id: "late", reminder_date: "2026-09-01", work_sort_order: 100 },
    { id: "same-a", reminder_date: "2026-08-20", work_sort_order: 200 },
    { id: "same-b", reminder_date: "2026-08-20", work_sort_order: 300 },
  ];
  const server = [optimistic[2], optimistic[0], optimistic[1]];

  assert.deepEqual(
    sortUpcomingTasks(optimistic, manualIds).map((task) => task.id),
    sortUpcomingTasks(server, manualIds).map((task) => task.id),
  );
  assert.deepEqual(
    optimistic.map((task) => task.id),
    ["late", "same-a", "same-b"],
  );
});

test("new, edited, and completed task collections keep chronological order", () => {
  const existing = [
    { id: "aug-20", reminder_date: "2026-08-20" },
    { id: "aug-25", reminder_date: "2026-08-25" },
    { id: "sep-01", reminder_date: "2026-09-01" },
  ];
  const withNewTask = [
    ...existing,
    { id: "aug-22", reminder_date: "2026-08-22" },
  ];
  assert.deepEqual(
    sortUpcomingTasks(withNewTask).map((task) => task.id),
    ["aug-20", "aug-22", "aug-25", "sep-01"],
  );

  const edited = withNewTask.map((task) =>
    task.id === "sep-01" ? { ...task, reminder_date: "2026-08-19" } : task,
  );
  assert.deepEqual(
    sortUpcomingTasks(edited).map((task) => task.id),
    ["sep-01", "aug-20", "aug-22", "aug-25"],
  );

  const afterCompletion = edited.filter((task) => task.id !== "aug-20");
  assert.deepEqual(
    sortUpcomingTasks(afterCompletion).map((task) => task.id),
    ["sep-01", "aug-22", "aug-25"],
  );
});
