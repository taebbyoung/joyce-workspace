import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildCustomerFollowUpAttention,
  customerFollowUpDueDate,
  syncCustomerFollowUpAttention,
} from "../lib/customer-attention.ts";

const today = "2026-08-31";
const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("customer attention uses the internal customer id and includes due-today follow-ups", () => {
  const attention = buildCustomerFollowUpAttention({
    id: "customer-42",
    customer_code: "GR04",
    company: "Wheelnwater",
    lifecycle: "existing",
    grade: "A",
    next_follow: today,
  }, today);

  assert.deepEqual(attention && {
    source_type: attention.source_type,
    source_id: attention.source_id,
    title: attention.title,
    message: attention.message,
  }, {
    source_type: "customer",
    source_id: "customer-42",
    title: "GR04 · Wheelnwater",
    message: "A类 · 今天需要跟进",
  });
});

test("Potential customer attention never depends on a customer code", () => {
  const attention = buildCustomerFollowUpAttention({
    id: "potential-1",
    customer_code: null,
    company: "Potential Company",
    lifecycle: "potential_customer",
    grade: "2",
    next_follow: "2026-08-29",
  }, today);

  assert.equal(attention?.title, "Potential Company");
  assert.equal(attention?.source_id, "potential-1");
  assert.match(String(attention?.message), /已逾期2天/);
});

test("explicit next follow-up wins; otherwise the lifecycle cycle starts from last contact", () => {
  assert.equal(customerFollowUpDueDate({
    lifecycle: "potential_customer",
    grade: "1",
    last_contact_at: "2026-08-20",
    next_follow: "2026-08-25",
  }), "2026-08-25");
  assert.equal(customerFollowUpDueDate({
    lifecycle: "potential_customer",
    grade: "2",
    last_contact_at: "2026-08-16",
  }), today);
  assert.equal(customerFollowUpDueDate({
    lifecycle: "existing",
    grade: "C",
    last_follow: "2026-08-01",
  }), today);
});

test("future and missing-contact customers do not enter attention, while an explicit date works before grading", () => {
  assert.equal(buildCustomerFollowUpAttention({
    id: "future", lifecycle: "existing", grade: "A", next_follow: "2026-09-01",
  }, today), null);
  assert.equal(buildCustomerFollowUpAttention({
    id: "ungraded", lifecycle: "existing", next_follow: today,
  }, today)?.message, "今天需要跟进");
  assert.equal(buildCustomerFollowUpAttention({
    id: "missing", lifecycle: "potential_customer", grade: "1",
  }, today), null);
});

test("customer attention local sync replaces the same source instead of duplicating it", () => {
  const original = [{ source_type: "customer", source_id: "customer-1", title: "old" }];
  const synced = syncCustomerFollowUpAttention(original, {
    id: "customer-1",
    lifecycle: "existing",
    grade: "B",
    company: "Updated",
    next_follow: today,
  }, today);
  assert.equal(synced.length, 1);
  assert.equal(synced[0].title, "Updated");
  assert.equal(synced[0].source_id, "customer-1");
});

test("Customer codes are required only for Existing customers and duplicate errors are explicit", async () => {
  const [workspaceRoute, customersRoute, app] = await Promise.all([
    source("app/api/workspace/route.ts"),
    source("app/api/customers/route.ts"),
    source("app/WorkspaceApp.tsx"),
  ]);

  for (const route of [workspaceRoute, customersRoute]) {
    assert.match(route, /lifecycle === "existing" && !(?:customerCode|nextCustomerCode)/);
    assert.match(route, /客户代码 \$\{(?:customerCode|nextCustomerCode)\} 已存在。/);
  }
  assert.match(app, /profileLifecycle === "existing"[\s\S]*name="customerCode"/);
  assert.match(app, /lifecycle === "existing"[\s\S]*name="customerCode"/);
  assert.match(app, /tab === "existing" \? <small>\{customer\.customer_code/);
});
