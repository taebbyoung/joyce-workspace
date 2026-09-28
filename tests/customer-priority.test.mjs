import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EXISTING_CONTACT_CYCLES,
  POTENTIAL_CONTACT_CYCLES,
  POTENTIAL_FOLLOWUP_SUGGESTIONS,
  existingContactState,
  getCustomerFollowUpState,
  normalizeCustomerGrade,
  potentialFollowupState,
  ratingReviewDue,
  sortCustomersForLifecycle,
} from "../lib/customer-priority.ts";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("customer lifecycle and resource grade use separate allowed values", () => {
  assert.equal(normalizeCustomerGrade("potential_lead", "1"), "");
  assert.equal(normalizeCustomerGrade("potential_customer", "1"), "1");
  assert.equal(normalizeCustomerGrade("potential_customer", "A"), "");
  assert.equal(normalizeCustomerGrade("existing", "A"), "A");
  assert.equal(normalizeCustomerGrade("existing", "1"), "");
});

test("Potential follow-up reminders use the shared 7/15/30/45 default cycles", () => {
  const today = "2026-08-17";
  assert.deepEqual(POTENTIAL_CONTACT_CYCLES, { "1": 7, "2": 15, "3": 30, "4": 45 });
  assert.deepEqual(POTENTIAL_FOLLOWUP_SUGGESTIONS, {
    "1": "建议7天内安排下一次跟进",
    "2": "建议15天内安排下一次跟进",
    "3": "建议30天内安排下一次跟进",
    "4": "建议45天内安排下一次跟进",
  });
  assert.equal(
    potentialFollowupState({ grade: "1", next_follow: null }, today).label,
    "未设置跟进",
  );
  assert.equal(
    potentialFollowupState({ grade: "4", next_follow: null }, today).label,
    "未设置跟进",
  );
  assert.deepEqual(
    potentialFollowupState({ grade: "2", next_follow: "2026-08-14" }, today),
    { kind: "overdue", label: "逾期3天未跟进", overdueDays: 3 },
  );
  assert.equal(
    potentialFollowupState({ grade: "3", next_follow: today }, today).kind,
    "due",
  );
  assert.equal(
    potentialFollowupState({ grade: "3", next_follow: "2026-08-20" }, today).kind,
    "normal",
  );
  assert.deepEqual(
    potentialFollowupState({ grade: "2", last_follow: "2026-08-02" }, today),
    { kind: "due", label: "今天建议跟进", overdueDays: 0 },
  );
  assert.deepEqual(
    potentialFollowupState({ grade: "4", last_follow: "2026-07-02" }, today),
    { kind: "overdue", label: "逾期1天未跟进", overdueDays: 1 },
  );
});

test("Existing contact cycles use A7 B15 C30 D45 and exact boundaries", () => {
  assert.deepEqual(EXISTING_CONTACT_CYCLES, { A: 7, B: 15, C: 30, D: 45 });
  const today = "2026-08-17";
  assert.deepEqual(existingContactState({ grade: "A", last_follow: "2026-08-08" }, today), {
    kind: "overdue",
    label: "逾期2天未跟进",
    overdueDays: 2,
  });
  assert.equal(
    existingContactState({ grade: "B", last_follow: "2026-08-02" }, today).kind,
    "due",
  );
  assert.equal(
    existingContactState({ grade: "C", last_follow: "2026-07-18" }, today).kind,
    "due",
  );
  assert.equal(
    existingContactState({ grade: "D", last_follow: "2026-07-03" }, today).kind,
    "due",
  );
  assert.equal(existingContactState({ grade: "A", last_follow: null }, today).kind, "missing");
});

test("manual customer next follow-up takes priority over every lifecycle default", () => {
  const today = "2026-08-17";
  assert.equal(
    getCustomerFollowUpState({ lifecycle: "existing", grade: "A", last_contact_at: "2026-01-01", next_follow: today }, today).kind,
    "due",
  );
  assert.equal(
    getCustomerFollowUpState({ lifecycle: "potential_customer", grade: "1", last_contact_at: "2026-01-01", next_follow: "2026-08-18" }, today).kind,
    "normal",
  );
  assert.equal(
    getCustomerFollowUpState({ lifecycle: "potential_customer", grade: "1", last_contact_at: null, next_follow: null }, today).kind,
    "missing",
  );
});

test("customer priority sorting keeps 2 and 3 in one tier", () => {
  const potential = sortCustomersForLifecycle(
    [
      { id: "4", company: "D", grade: "4" },
      { id: "3", company: "C", grade: "3", next_follow: "2026-08-19" },
      { id: "1", company: "A", grade: "1", next_follow: "2026-08-20" },
      { id: "2", company: "B", grade: "2", next_follow: "2026-08-15" },
      { id: "u", company: "U", grade: null },
    ],
    "potential_customer",
    "2026-08-17",
  );
  assert.deepEqual(potential.map((row) => row.id), ["1", "2", "3", "4", "u"]);

  const existing = sortCustomersForLifecycle(
    [
      { id: "b", company: "B", grade: "B", total_sales_cny: 900000 },
      { id: "a-current", company: "A Current", grade: "A", total_sales_cny: 100000 },
      { id: "a-overdue", company: "A Overdue", grade: "A", total_sales_cny: 500000 },
    ],
    "existing",
    "2026-08-17",
  );
  assert.deepEqual(existing.map((row) => row.id), ["a-overdue", "a-current", "b"]);
});

test("Existing Customers sort by grade, cumulative vehicle CNY, latest order, then a stable key", () => {
  const existing = sortCustomersForLifecycle(
    [
      { id: "unrated-large", company: "Unrated", grade: null, total_sales_cny: 9_000_000, latest_order_date: "2026-08-18" },
      { id: "b-overdue", customer_code: "B02", company: "B overdue", grade: "B", total_sales_cny: 100, latest_order_date: "2026-08-19", last_follow: "2026-01-01" },
      { id: "a-lower", customer_code: "A03", company: "A lower", grade: "A", total_sales_cny: 500_000, latest_order_date: "2026-08-18" },
      { id: "a-recent", customer_code: "A02", company: "A recent", grade: "A", total_sales_cny: 800_000, latest_order_date: "2026-08-15" },
      { id: "a-stable-b", customer_code: "A11", company: "A stable B", grade: "A", total_sales_cny: 500_000, latest_order_date: "2026-08-10" },
      { id: "a-stable-a", customer_code: "A10", company: "A stable A", grade: "A", total_sales_cny: "500000.00", latest_order_date: "2026-08-10" },
      { id: "c-no-orders", customer_code: "C01", company: "C", grade: "C", total_sales_cny: null, latest_order_date: null },
      { id: "d", company: "D", grade: "D", total_sales_cny: 1 },
    ],
    "existing",
    "2026-08-19",
  );
  assert.deepEqual(existing.map((row) => row.id), [
    "a-recent",
    "a-lower",
    "a-stable-a",
    "a-stable-b",
    "b-overdue",
    "c-no-orders",
    "d",
    "unrated-large",
  ]);
});

test("rating review warning starts only after 30 completed days", () => {
  assert.equal(ratingReviewDue({ last_reviewed_at: "2026-07-18" }, "2026-08-17"), false);
  assert.equal(ratingReviewDue({ last_reviewed_at: "2026-07-17" }, "2026-08-17"), true);
  assert.equal(ratingReviewDue({ last_reviewed_at: null }, "2026-08-17"), false);
});

test("Customers updates locally and AI rating remains explicit and unsaved", async () => {
  const [app, customersRoute, adviceRoute, workspaceRoute, migration, runtime, schema] =
    await Promise.all([
      source("app/WorkspaceApp.tsx"),
      source("app/api/customers/route.ts"),
      source("app/api/sales-advice/route.ts"),
      source("app/api/workspace/route.ts"),
      source("drizzle/0014_customer_priority_sop.sql"),
      source("db/runtime.ts"),
      source("db/schema.ts"),
    ]);
  const customerDetail = app.slice(
    app.indexOf("function CustomerDetail"),
    app.indexOf("function LeadsView"),
  );
  const leadsView = app.slice(app.indexOf("function LeadsView"), app.indexOf("const paymentStatusOptions"));

  assert.match(app, /onSaved=\{applyCustomerSnapshot\}/);
  assert.doesNotMatch(customerDetail, /loadWorkspace/);
  assert.match(customerDetail, /onClick=\{generateRatingAdvice\}/);
  assert.match(customerDetail, /mode: "customer_rating"/);
  assert.match(customerDetail, /采用建议并填入/);
  assert.match(customerDetail, /尚未保存，Joyce确认后才会写入/);
  assert.doesNotMatch(leadsView, /customer-grade-chip|分析客户等级|lead\.grade/);

  assert.match(customersRoute, /action === "update_rating"/);
  assert.match(customersRoute, /const gradeChanged =/);
  assert.match(customersRoute, /const ratingReasonChanged =/);
  assert.match(customersRoute, /const reviewChanged = gradeChanged \|\| ratingReasonChanged/);
  assert.match(customersRoute, /reviewChanged \? now : customer\.last_reviewed_at/);
  assert.doesNotMatch(customersRoute, /action === "record_contact"/);
  assert.match(customersRoute, /function recomputeLastFollow/);
  assert.match(customersRoute, /SELECT MAX\(follow_up_at\) AS follow_up_at/);
  assert.match(customersRoute, /lifecycleChanged[\s\S]*grade = CASE WHEN \? = 1 THEN NULL/);
  assert.doesNotMatch(customersRoute, /INSERT INTO tasks|\/api\/tasks/);

  assert.match(adviceRoute, /mode === "customer_rating"/);
  assert.match(adviceRoute, /original_amount, cny_amount/);
  assert.match(adviceRoute, /只有潜在客户和老客户支持等级分析/);
  assert.match(adviceRoute, /不得自动保存或修改客户/);
  assert.doesNotMatch(workspaceRoute, /customers\.next_follow/);
  assert.match(workspaceRoute, /LEFT JOIN orders o ON o\.customer_id = c\.id AND o\.deleted_at IS NULL/);
  assert.match(workspaceRoute, /SUM\(COALESCE\(o\.cny_amount, 0\)\)/);
  assert.match(workspaceRoute, /MAX\(COALESCE\(NULLIF\(o\.order_date, ''\), o\.created_at\)\) AS latest_order_date/);

  for (const field of [
    "purchase_intent",
    "purchase_ability",
    "rating_reason",
    "last_reviewed_at",
  ]) {
    assert.match(migration, new RegExp(field));
    assert.match(runtime, new RegExp(field));
    assert.match(schema, new RegExp(field));
  }
  assert.match(migration, /backup_customers_priority_20260817/);
});

test("Existing Customers show a concise next action without changing Potential demand", async () => {
  const app = await source("app/WorkspaceApp.tsx");
  const styles = await source("app/globals.css");
  const customersView = app.slice(
    app.indexOf("function CustomersView"),
    app.indexOf("function customerFormSignature"),
  );

  const existingBranch = customersView.slice(
    customersView.indexOf('tab === "existing" ? ('),
    customersView.indexOf(") : (", customersView.indexOf('tab === "existing" ? (')),
  );
  assert.match(existingBranch, /<span>下一步<\/span>/);
  assert.match(customersView, /className="customer-next-action"[\s\S]*customer\.next_action \|\| "—"/);
  assert.match(customersView, /customer\.next_action \|\| "尚未记录需求"/);
  assert.match(styles, /\.customer-priority-table\.existing[\s\S]*grid-template-columns/);
  assert.match(styles, /\.customer-next-action[\s\S]*-webkit-line-clamp: 2/);
});
