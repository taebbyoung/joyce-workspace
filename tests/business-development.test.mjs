import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  LEAD_TOUCH_CADENCE_DAYS,
  isActiveLeadStatus,
  isDevelopingLeadStatus,
  leadPayload,
  leadStatusLabels,
  nextLeadTouchDate,
  normalizeLeadName,
  sortLeads,
  websiteDomain,
} from "../lib/business-development.ts";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("Lead normalization and lifecycle defaults remain deterministic", () => {
  assert.equal(normalizeLeadName("  ABC Mobility GmbH  "), "abc mobility");
  assert.equal(websiteDomain("https://www.example.com/products"), "example.com");
  const payload = leadPayload({ companyName: "ABC Mobility GmbH", country: "Germany", website: "www.example.com" });
  assert.equal(payload.normalizedName, "abc mobility");
  assert.equal(payload.websiteDomain, "example.com");
  assert.equal(payload.status, "research_pending");
  assert.equal(payload.priority, "Medium");
  assert.equal(payload.motoEvBusiness, "Unknown");
});

test("Lead cadence uses the actual previous touch date and stops automation after Touch 8", () => {
  assert.deepEqual(LEAD_TOUCH_CADENCE_DAYS, [0, 4, 7, 14, 25, 35, 45, 50]);
  assert.equal(nextLeadTouchDate("2026-09-01", 1), "2026-09-05");
  assert.equal(nextLeadTouchDate("2026-09-05", 2), "2026-09-12");
  assert.equal(nextLeadTouchDate("2026-09-12", 7), "2026-11-01");
  assert.equal(nextLeadTouchDate("2026-11-01", 8), "");
});

test("Lead status compatibility and active queue behavior preserve old developing values", () => {
  assert.equal(leadStatusLabels.waiting_reply, "开发中");
  assert.equal(leadStatusLabels.following_up, "开发中");
  assert.equal(isDevelopingLeadStatus("waiting_reply"), true);
  assert.equal(isDevelopingLeadStatus("following_up"), true);
  assert.equal(isActiveLeadStatus("replied_pending_conversion"), true);
  assert.equal(isActiveLeadStatus("paused"), false);
  assert.equal(isActiveLeadStatus("abandoned"), false);
  assert.equal(isActiveLeadStatus("converted"), false);
});

test("Lead Pool sorting prioritizes overdue, today, replied, first outreach, and future work", () => {
  const rows = sortLeads([
    { id: "research", status: "research_pending", priority: "Low", created_at: "2026-09-01" },
    { id: "reply", status: "replied_pending_conversion", priority: "Low", created_at: "2026-09-02" },
    { id: "overdue", status: "following_up", priority: "Medium", next_follow_up_date: "2026-09-03", created_at: "2026-09-01" },
    { id: "today", status: "waiting_reply", priority: "Low", next_follow_up_date: "2026-09-04", created_at: "2026-09-01" },
    { id: "first", status: "first_outreach_due", priority: "High", created_at: "2026-09-01" },
    { id: "future", status: "following_up", priority: "High", next_follow_up_date: "2026-09-10", created_at: "2026-09-01" },
  ], "2026-09-04");
  assert.deepEqual(rows.map((row) => row.id), ["overdue", "today", "reply", "first", "future", "research"]);
});

test("Lead Pool V2 schema is additive and keeps Leads independent from Customers", async () => {
  const [phaseOne, phaseTwo, schema, runtime] = await Promise.all([
    source("drizzle/0020_new_business_development_leads.sql"),
    source("drizzle/0022_lead_pool_v2.sql"),
    source("db/schema.ts"),
    source("db/runtime.ts"),
  ]);
  assert.match(phaseOne, /CREATE TABLE IF NOT EXISTS `business_development_leads`/);
  assert.match(phaseOne, /CREATE TABLE IF NOT EXISTS `lead_contacts`/);
  assert.match(phaseTwo, /ALTER TABLE `customers` ADD COLUMN `source_lead_id` TEXT/);
  assert.match(phaseTwo, /CREATE TABLE IF NOT EXISTS `lead_development_history`/);
  assert.match(phaseTwo, /lead_development_history_lead_time_idx/);
  assert.match(schema, /export const leadDevelopmentHistory/);
  assert.match(schema, /sourceLeadId: text\("source_lead_id"\)/);
  assert.match(runtime, /CREATE TABLE IF NOT EXISTS lead_development_history/);
  assert.match(runtime, /source_lead_id TEXT/);
});

test("Lead API implements development history, manual scheduling, and safe Potential conversion", async () => {
  const route = await source("app/api/leads/route.ts");
  assert.match(route, /if \(!payload\.companyName\) return errorResponse\("请填写公司名称。"\)/);
  assert.match(route, /if \(!payload\.country\) return errorResponse\("请填写国家。"\)/);
  assert.match(route, /action === "save_development"/);
  assert.match(route, /nextLeadTouchDate\(developmentAt, touchNumber \|\| 0\)/);
  assert.match(route, /action === "set_next_date"/);
  assert.match(route, /action === "convert_to_potential"/);
  assert.match(route, /code: "possible_duplicate"/);
  assert.match(route, /'potential_customer'/);
  assert.match(route, /source_lead_id/);
  assert.match(route, /INSERT INTO contacts/);
  assert.match(route, /INSERT INTO customer_follow_ups/);
  assert.match(route, /SET status = 'converted'/);
  assert.match(route, /WHERE lead_id = \?/);
  assert.match(route, /该 Lead 已有相同 Email 的联系人/);
});

test("New Business Development UI exposes V2 quick views and compact Lead workflow", async () => {
  const app = await source("app/WorkspaceApp.tsx");
  const view = app.slice(app.indexOf("const leadQuickViews"), app.indexOf("const paymentStatusOptions"));
  assert.match(app, /label: "新客开发"/);
  assert.match(app, /view === "leads" && <BusinessDevelopmentView/);
  assert.match(view, /\["all", "全部活跃"\]/);
  assert.match(view, /\["today", "今天要开发"\]/);
  assert.match(view, /\["overdue", "已逾期"\]/);
  assert.match(view, /\["developing", "开发中"\]/);
  assert.match(view, /\["replied", "已回复待转换"\]/);
  assert.match(view, /\["research", "待研究"\]/);
  assert.match(view, /线索池（Lead Pool）/);
  assert.match(view, /最近开发/);
  assert.match(view, /下次开发/);
  assert.match(view, /开发历史/);
  assert.match(view, /我方开发（计入 Touch）/);
  assert.match(view, /客户真实回复/);
  assert.match(view, /转为潜在客户/);
  assert.match(view, /Touch \{Number\(lead\.touch_count \|\| 0\)\}/);
  assert.match(view, /lead\.country, lead\.website/);
  assert.match(view, /CustomerUnsavedChangesDialog/);
  assert.doesNotMatch(view, /AI Research|AI Candidates/);
});
