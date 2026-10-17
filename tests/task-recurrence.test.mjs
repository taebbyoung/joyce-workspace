import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildNextRecurringTask,
  nextRecurringDate,
  taskRecurrenceRules,
} from "../lib/task-recurrence.ts";

const root = new URL("../", import.meta.url);

test("fixed-calendar recurrence skips overdue dates without moving its anchor", () => {
  assert.equal(nextRecurringDate("2026-07-31", "daily"), "2026-08-01");
  assert.equal(nextRecurringDate("2026-07-31", "weekly"), "2026-08-07");
  assert.equal(nextRecurringDate("2026-01-31", "monthly"), "2026-02-28");
  assert.equal(nextRecurringDate("2024-01-30", "monthly"), "2024-02-29");
  assert.equal(nextRecurringDate("2025-01-29", "monthly"), "2025-02-28");
  assert.equal(nextRecurringDate("2024-02-29", "yearly"), "2025-02-28");
  assert.equal(
    nextRecurringDate("2026-10-10", "daily", "2026-10-13"),
    "2026-10-14",
  );
  assert.equal(
    nextRecurringDate("2026-10-12", "weekly", "2026-10-15"),
    "2026-10-19",
  );
  assert.equal(
    nextRecurringDate("2026-10-10", "monthly", "2026-10-15"),
    "2026-11-10",
  );
  assert.equal(
    nextRecurringDate("2026-10-15", "daily", "2026-10-13"),
    "2026-10-16",
  );
  assert.equal(
    nextRecurringDate("2026-01-31", "monthly", "2026-03-01"),
    "2026-03-31",
  );
  assert.equal(nextRecurringDate("2026-07-31", "custom"), null);
  assert.equal(nextRecurringDate("2026-02-31", "daily"), null);
  assert.ok(taskRecurrenceRules.has("custom"));
});

test("next recurring occurrence is a separate pending task with stable identity", () => {
  const current = {
    id: "daily-email-check",
    title: "邮箱check",
    status: "pending",
    priority: "中",
    reminder_date: "2026-10-10",
    recurrence_rule: "daily",
    project_id: "project-1",
    next_action: "检查收件箱",
    notes: "保留说明",
    work_sort_order: 200,
    legacy_metadata: "{}",
  };
  const occurrence = buildNextRecurringTask(
    current,
    "2026-10-13",
    "2026-10-13T09:30:00.000Z",
  );
  assert.equal(occurrence?.nextDate, "2026-10-14");
  assert.equal(occurrence?.nextTask.id, "recurring:daily-email-check:2026-10-14");
  assert.equal(occurrence?.nextTask.status, "pending");
  assert.equal(occurrence?.nextTask.reminder_date, "2026-10-14");
  assert.equal(occurrence?.nextTask.project_id, "project-1");
  assert.equal(occurrence?.nextTask.next_action, "检查收件箱");
  assert.equal(occurrence?.nextTask.notes, "保留说明");
  assert.equal(current.reminder_date, "2026-10-10");
  assert.equal(current.status, "pending");

  const repeated = buildNextRecurringTask(
    current,
    "2026-10-13",
    "2026-10-13T09:30:01.000Z",
  );
  assert.equal(repeated?.nextTask.id, occurrence?.nextTask.id);
  assert.equal(buildNextRecurringTask({ ...current, recurrence_rule: "none" }, "2026-10-13", "now"), null);
});

test("generated monthly tasks retain the original calendar anchor", () => {
  const january = {
    id: "month-end",
    title: "月末检查",
    status: "pending",
    priority: "中",
    reminder_date: "2026-01-31",
    recurrence_rule: "monthly",
    legacy_metadata: "{}",
  };
  const february = buildNextRecurringTask(
    january,
    "2026-01-31",
    "2026-01-31T02:00:00.000Z",
  );
  assert.equal(february?.nextDate, "2026-02-28");
  const march = buildNextRecurringTask(
    february?.nextTask ?? {},
    "2026-02-28",
    "2026-02-28T02:00:00.000Z",
  );
  assert.equal(march?.nextDate, "2026-03-31");
});

test("completion and deletion share the server recurrence path", async () => {

  const route = await readFile(new URL("app/api/tasks/route.ts", root), "utf8");
  const statusFlow = route.slice(route.indexOf('if (action === "status")'));
  const deleteStart = route.indexOf('if (action === "delete")');
  const updateStart = route.indexOf('if (action === "update")', deleteStart);
  const deleteFlow = route.slice(deleteStart, updateStart);
  assert.match(route, /INSERT OR IGNORE INTO tasks/);
  assert.match(statusFlow, /buildNextRecurringTask/);
  assert.match(statusFlow, /status = 'completed'/);
  assert.match(statusFlow, /COALESCE\(completed_at, \?\)/);
  assert.match(statusFlow, /nextTask/);
  assert.match(deleteFlow, /buildNextRecurringTask/);
  assert.match(deleteFlow, /nextTask/);
  assert.match(route, /const businessDate = isValidDateOnly\(payload\.businessDate\)/);
  assert.match(route, /buildNextRecurringTask\([\s\S]*businessDate/);
  assert.match(statusFlow, /nextReminderDate/);
  assert.doesNotMatch(statusFlow, /SELECT \* FROM tasks WHERE id = \? LIMIT 1/);
  assert.doesNotMatch(statusFlow, /requestAi|requestJson|Gemini/);
});

test("task forms expose repeat rules while keeping one reminder date", async () => {
  const app = await readFile(new URL("app/WorkspaceApp.tsx", root), "utf8");
  const workspaceRoute = await readFile(
    new URL("app/api/workspace/route.ts", root),
    "utf8",
  );
  assert.match(app, /name="recurrenceRule"/);
  assert.match(app, /每天/);
  assert.match(app, /每周/);
  assert.match(app, /每月/);
  assert.match(app, /每年/);
  assert.match(app, /自定义（后续扩展）/);
  assert.match(workspaceRoute, /asText\(payload\.recurrenceRule, 20\)/);
  assert.doesNotMatch(workspaceRoute, /rankAfterCreation|rankWorkPriority/);
});
