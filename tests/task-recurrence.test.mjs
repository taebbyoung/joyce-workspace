import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  nextRecurringDate,
  taskRecurrenceRules,
} from "../lib/task-recurrence.ts";

const root = new URL("../", import.meta.url);

test("recurring dates advance one period without pre-generating tasks", async () => {
  assert.equal(nextRecurringDate("2026-07-31", "daily"), "2026-08-01");
  assert.equal(nextRecurringDate("2026-07-31", "weekly"), "2026-08-07");
  assert.equal(nextRecurringDate("2026-01-31", "monthly"), "2026-02-28");
  assert.equal(nextRecurringDate("2024-02-29", "yearly"), "2025-02-28");
  assert.equal(nextRecurringDate("2026-07-31", "custom"), null);
  assert.ok(taskRecurrenceRules.has("custom"));

  const route = await readFile(new URL("app/api/tasks/route.ts", root), "utf8");
  const statusFlow = route.slice(route.indexOf('if (action === "status")'));
  assert.doesNotMatch(statusFlow, /INSERT INTO tasks/);
  assert.match(statusFlow, /status = 'pending'/);
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
