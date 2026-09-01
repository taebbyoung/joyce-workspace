import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  attentionIdentity,
  buildWorkTaskAttention,
  groupHomeAttention,
  isWorkTaskAttentionEligible,
  sortWorkAttention,
  syncWorkTaskAttention,
  workAttentionMessage,
} from "../lib/work-attention.ts";

const today = "2026-08-15";
const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

function task(id, reminderDate, extra = {}) {
  return {
    id,
    title: `任务 ${id}`,
    status: "pending",
    reminder_date: reminderDate,
    ...extra,
  };
}

test("only overdue Work tasks create attention keyed by their real source id", () => {
  const tasks = [task("A", "2026-08-05"), task("B", "2026-08-12")];
  const attention = tasks.map(buildWorkTaskAttention);
  assert.deepEqual(attention.map(attentionIdentity), ["task:A", "task:B"]);
  assert.equal(new Set(attention.map(attentionIdentity)).size, 2);
  assert.ok(tasks.every((item) => isWorkTaskAttentionEligible(item, today)));
  assert.equal(isWorkTaskAttentionEligible(task("today", today), today), false);
  assert.equal(isWorkTaskAttentionEligible(task("future", "2026-08-20"), today), false);
  assert.equal(
    isWorkTaskAttentionEligible(task("done", "2026-08-05", { status: "completed" }), today),
    false,
  );
});

test("home exposes the true Attention total while rendering only the first five", () => {
  for (const count of [0, 3, 5, 6, 12]) {
    const attention = Array.from({ length: count }, (_, index) =>
      buildWorkTaskAttention(task(String(index + 1), `2026-08-${String(index + 1).padStart(2, "0")}`)),
    );
    const grouped = groupHomeAttention(attention);
    assert.equal(grouped.total, count);
    assert.equal(grouped.visibleItems.length, Math.min(5, count));
    assert.equal(grouped.allItems.length, count);
  }
});

test("Work attention sorts oldest overdue first", () => {
  const sorted = sortWorkAttention([
    buildWorkTaskAttention(task("three-days", "2026-08-12")),
    buildWorkTaskAttention(task("ten-days", "2026-08-05")),
  ]);
  assert.deepEqual(sorted.map((item) => item.source_id), ["ten-days", "three-days"]);
  assert.equal(workAttentionMessage(sorted[0], today), "已逾期 10 天");
  assert.equal(workAttentionMessage(sorted[1], today), "已逾期 3 天");
});

test("the full Attention dataset keeps mixed customer and business items", () => {
  const work = Array.from({ length: 4 }, (_, index) =>
    buildWorkTaskAttention(task(String(index), `2026-08-${String(index + 1).padStart(2, "0")}`)),
  );
  const others = [
    { kind: "order", id: "risk-1", source_type: "order", source_id: "order-1" },
    { kind: "customer", id: "customer-1", source_type: "customer", source_id: "customer-1" },
    { kind: "customer", id: "customer-2", source_type: "customer", source_id: "customer-2" },
  ];
  const grouped = groupHomeAttention([...work, ...others]);
  assert.equal(grouped.total, 7);
  assert.equal(grouped.visibleItems.length, 5);
  assert.deepEqual(grouped.allItems.slice(-3), others);
});

test("Home Attention shows the shared total and opens its complete shared dataset", async () => {
  const app = await source("app/WorkspaceApp.tsx");
  const homeView = app.slice(
    app.indexOf("function HomeView"),
    app.indexOf("function WorkView"),
  );

  assert.match(homeView, /const visibleAttention = homeAttention\.visibleItems/);
  assert.match(homeView, /homeAttention\.total > visibleAttention\.length/);
  assert.match(homeView, /查看全部/);
  assert.match(homeView, /title=\{`全部需要关注 · \$\{homeAttention\.total\} 条`\}/);
  assert.match(homeView, /homeAttention\.allItems\.map/);
  assert.match(homeView, /onOpenAttention\(item\)/);
});

test("moving a reminder to today, the future, or completing a task removes its local attention", () => {
  const active = task("A", "2026-08-10");
  const attention = [buildWorkTaskAttention(active)];
  assert.equal(syncWorkTaskAttention(attention, active, today).length, 1);
  assert.equal(
    syncWorkTaskAttention(attention, { ...active, reminder_date: today }, today).length,
    0,
  );
  assert.equal(
    syncWorkTaskAttention(attention, { ...active, reminder_date: "2026-08-20" }, today).length,
    0,
  );
  assert.equal(
    syncWorkTaskAttention(attention, { ...active, status: "completed" }, today).length,
    0,
  );
});
