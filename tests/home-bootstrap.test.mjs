import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildHomeBootstrapData } from "../lib/home-bootstrap.ts";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("Home bootstrap returns only Home summaries while preserving Today and Attention rules", () => {
  const data = buildHomeBootstrapData({
    today: "2026-10-09",
    metrics: { active_order_value: 200, currency_review_count: 1 },
    currentYearAccessorySales: 20,
    customerCounts: { existing_count: 3, a_potential_count: 1, lead_count: 2 },
    salesAttributionOrders: [
      {
        customer_code: "EX01",
        cny_amount: 100,
        currency_status: "confirmed",
        shipment_status: "delivered",
        expected_shipping_date: "2026-10-01",
        balance_received_date: "2026-10-02",
      },
    ],
    tasks: [
      { id: "today", title: "今天任务", status: "pending", reminder_date: "2026-10-09" },
      { id: "future", title: "未来任务", status: "pending", reminder_date: "2026-10-10" },
    ],
    todayTaskTotal: 1,
    attentionCustomers: [
      {
        id: "customer-1",
        lifecycle: "existing",
        grade: "A",
        company: "客户",
        customer_code: "EX01",
        next_follow: "2026-10-09",
      },
    ],
    nonCustomerAttention: [
      {
        id: "overdue-task",
        kind: "task",
        source_type: "task",
        source_id: "overdue-task",
        attention_date: "2026-10-08",
        risk_level: "High",
      },
    ],
  });

  assert.deepEqual(Object.keys(data).sort(), [
    "attention",
    "contribution",
    "generatedAt",
    "metrics",
    "salesTrend",
    "todayTaskTotal",
    "todayTasks",
  ]);
  assert.equal(data.todayTasks.length, 1);
  assert.equal(data.todayTasks[0].id, "today");
  assert.equal(data.todayTaskTotal, 1);
  assert.deepEqual(data.attention.map((item) => item.source_type), ["task", "customer"]);
  assert.equal(data.metrics.currentYearSales, 120);
  assert.deepEqual(data.salesTrend, [{ month: "2026-10", amount: 100 }]);
  assert.deepEqual(data.contribution, [{ customer_code: "EX01", amount: 100 }]);
});

test("Home API is narrow and WorkspaceApp defers the full workspace request", async () => {
  const [app, homeRoute, workspaceRoute] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/api/home/route.ts"),
    source("app/api/workspace/route.ts"),
  ]);

  assert.match(homeRoute, /await ensureWorkspace\(\)/);
  assert.match(homeRoute, /buildHomeBootstrapData/);
  assert.match(homeRoute, /LIMIT 6/);
  assert.match(homeRoute, /todayTaskTotal/);
  assert.doesNotMatch(homeRoute, /SELECT \* FROM contacts|SELECT \* FROM order_items|SELECT \* FROM order_payments|SELECT \* FROM knowledge_items|SELECT \* FROM sales_playbook_items/);
  assert.match(app, /createWorkspaceBootstrapRequest<HomeBootstrapData>\("\/api\/home"\)/);
  assert.match(app, /void loadHome\(\)/);
  assert.match(app, /viewRequiresWorkspaceData\(view\)/);
  assert.match(app, /workspaceLoadPromiseRef/);
  assert.match(app, /workspaceLoadedRef/);
  assert.match(app, /updateHomeTaskCollections/);
  assert.match(app, /attentionTarget\?\.type !== "customer"/);
  assert.match(workspaceRoute, /buildHomeBootstrapData/);
});
