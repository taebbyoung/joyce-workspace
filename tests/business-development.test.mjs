import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  leadPayload,
  normalizeLeadName,
  sortLeads,
  websiteDomain,
} from "../lib/business-development.ts";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("Lead normalization is deterministic without becoming a duplicate blocker", () => {
  assert.equal(normalizeLeadName("  ABC Mobility GmbH  "), "abc mobility");
  assert.equal(websiteDomain("https://www.example.com/products"), "example.com");
  const payload = leadPayload({ companyName: "ABC Mobility GmbH", country: "Germany", website: "www.example.com" });
  assert.equal(payload.normalizedName, "abc mobility");
  assert.equal(payload.websiteDomain, "example.com");
  assert.equal(payload.status, "research_pending");
  assert.equal(payload.priority, "Medium");
  assert.equal(payload.motoEvBusiness, "Unknown");
});

test("Lead Pool sorting follows replied, due, first outreach, then stable priority/date order", () => {
  const rows = sortLeads([
    { id: "four", status: "research_pending", priority: "Low", created_at: "2026-09-01" },
    { id: "one", status: "replied_pending_conversion", priority: "Low", created_at: "2026-09-02" },
    { id: "two", status: "following_up", priority: "Medium", next_follow_up_date: "2026-09-03", created_at: "2026-09-01" },
    { id: "three", status: "first_outreach_due", priority: "High", created_at: "2026-09-01" },
  ], "2026-09-04");
  assert.deepEqual(rows.map((row) => row.id), ["one", "two", "three", "four"]);
});

test("Phase 1 schema is independent of Customers and has only Lead foundation tables", async () => {
  const [migration, schema, runtime] = await Promise.all([
    source("drizzle/0020_new_business_development_leads.sql"),
    source("db/schema.ts"),
    source("db/runtime.ts"),
  ]);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `business_development_leads`/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `lead_contacts`/);
  assert.match(migration, /lead_contacts_lead_idx/);
  assert.doesNotMatch(migration, /ALTER TABLE `customers`/);
  assert.doesNotMatch(migration, /prospect_candidates|lead_development_history|lead_research/);
  assert.match(schema, /export const businessDevelopmentLeads/);
  assert.match(schema, /export const leadContacts/);
  assert.match(runtime, /CREATE TABLE IF NOT EXISTS business_development_leads/);
  assert.match(runtime, /CREATE TABLE IF NOT EXISTS lead_contacts/);
});

test("Lead API validates Phase 1 fields and keeps Customer contacts isolated", async () => {
  const route = await source("app/api/leads/route.ts");
  assert.match(route, /if \(!payload\.companyName\) return errorResponse\("请填写公司名称。"\)/);
  assert.match(route, /if \(!payload\.country\) return errorResponse\("请填写国家。"\)/);
  assert.match(route, /EDITABLE_LEAD_STATUSES/);
  assert.match(route, /INSERT INTO lead_contacts/);
  assert.match(route, /WHERE lead_id = \?/);
  assert.match(route, /联系人不属于该 Lead/);
  assert.match(route, /下次跟进日期无效/);
  assert.doesNotMatch(route, /INSERT INTO contacts/);
  assert.doesNotMatch(route, /prospect_candidates|lead_development_history|convert_lead_to_potential/);
});

test("New Business Development UI remains Lead-only in Phase 1", async () => {
  const app = await source("app/WorkspaceApp.tsx");
  const view = app.slice(app.indexOf("const leadQuickViews"), app.indexOf("const paymentStatusOptions"));
  assert.match(app, /label: "New Business Development"/);
  assert.match(app, /view === "leads" && <BusinessDevelopmentView/);
  assert.match(view, /\+ 手动新增 Lead/);
  assert.match(view, /全部 Lead/);
  assert.match(view, /今天要处理/);
  assert.match(view, /No decision maker/);
  assert.match(view, /CustomerUnsavedChangesDialog/);
  assert.match(view, /save-keeps-open|所有修改已保存/);
  assert.doesNotMatch(view, /AI Research|AI Candidates|Touch 1|转 Potential|Development History/);
});
