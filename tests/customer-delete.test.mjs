import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("customer deletion protects formal business links with an authoritative backend check", async () => {
  const route = await source("app/api/customers/route.ts");

  assert.match(route, /action === "check_delete"/);
  assert.match(route, /action === "delete_customer"/);
  assert.match(route, /customerDeleteDependencies\(customerId\)/);
  assert.match(route, /FROM orders WHERE customer_id = \?/);
  assert.match(route, /FROM after_sales_cases WHERE customer_id = \?/);
  assert.match(route, /FROM tasks WHERE customer_id = \?/);
  assert.match(route, /FROM timeline_events WHERE customer_id = \?/);
  assert.match(route, /关联订单/);
  assert.match(route, /关联售后/);
  assert.match(route, /关联工作/);
  assert.match(route, /业务时间线/);
  assert.match(route, /status: 409/);
});

test("eligible customer deletion clears only customer-owned records in one guarded D1 batch", async () => {
  const route = await source("app/api/customers/route.ts");
  const deleteBranch = route.slice(
    route.indexOf('if (action === "delete_customer")'),
    route.indexOf('if (action === "update_profile")'),
  );

  assert.match(deleteBranch, /await db\.batch\(statements\)/);
  for (const table of [
    "contacts",
    "customer_follow_ups",
    "customer_memory",
    "customer_custom_fields",
    "customer_status_history",
  ]) {
    assert.match(deleteBranch, new RegExp(`DELETE FROM ${table} WHERE customer_id = \\? \\$\\{customerDeleteGuard\\}`));
  }
  assert.match(deleteBranch, /DELETE FROM legacy_records/);
  assert.match(deleteBranch, /DELETE FROM customers[\s\S]*WHERE id = \? AND deleted_at IS NULL \$\{customerDeleteGuard\}/);
  assert.match(deleteBranch, /customerDeleteResult/);
  assert.match(deleteBranch, /latestDependencies/);
  assert.doesNotMatch(deleteBranch, /UPDATE customers SET deleted_at/);
});

test("Existing and Potential editors share the protected delete UI and clear local Attention", async () => {
  const app = await source("app/WorkspaceApp.tsx");
  const customerDetail = app.slice(
    app.indexOf("function CustomerDetail"),
    app.indexOf("function LeadsView"),
  );

  assert.match(customerDetail, /\["existing", "potential_customer"\]\.includes\(String\(customer\.lifecycle\)\)/);
  assert.match(customerDetail, /删除客户/);
  assert.match(customerDetail, /requestCustomerSave\("check_delete", \{\}\)/);
  assert.match(customerDetail, /requestCustomerSave\("delete_customer", \{\}\)/);
  assert.match(customerDetail, /确认删除「\{customer\.company\}」？/);
  assert.match(customerDetail, /确认删除/);
  assert.match(customerDetail, /onDeleted\(String\(customer\.id\)\)/);
  assert.match(app, /function removeCustomer\(customerId: string\)/);
  assert.match(app, /customerFollowUpCache\.delete\(customerId\)/);
  assert.match(app, /current\.attention\.filter/);
  assert.match(app, /String\(item\.source_type \|\| item\.kind\) === "customer"/);
  assert.match(app, /onDeleted=\{removeCustomer\}/);
  assert.doesNotMatch(customerDetail, /window\.confirm/);
  assert.doesNotMatch(customerDetail, /loadWorkspace/);
});
