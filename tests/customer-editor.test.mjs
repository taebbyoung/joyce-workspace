import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  customerEditorStateSignature,
  hasCustomerEditorChanges,
  normalizeCustomerEditorValue,
} from "../lib/customer-editor-state.ts";

const root = path.resolve(import.meta.dirname, "..");

test("customer editor dirty comparison normalizes equivalent field values", () => {
  const app = fs.readFileSync(path.join(root, "app/WorkspaceApp.tsx"), "utf8");
  const editorStateImport = app.match(
    /import\s*\{([^}]+)\}\s*from\s*"@\/lib\/customer-editor-state";/,
  )?.[1] || "";

  assert.match(editorStateImport, /normalizeCustomerEditorValue/);
  assert.equal(normalizeCustomerEditorValue("  Joyce  "), "Joyce");
  assert.equal(normalizeCustomerEditorValue("3000.00", "number"), 3000);
  assert.equal(normalizeCustomerEditorValue("2026-08-17T08:00:00Z", "date"), "2026-08-17");
  assert.equal(
    customerEditorStateSignature({ notes: null, tags: ["B", "A"] }),
    customerEditorStateSignature({ tags: ["A", "B"], notes: "" }),
  );
  assert.equal(
    hasCustomerEditorChanges(
      { company: " Joyce ", active: true },
      { company: "Joyce", active: true },
    ),
    false,
  );
  assert.equal(
    hasCustomerEditorChanges({ company: "Joyce" }, { company: "Joyce Mobility" }),
    true,
  );
});

test("customer editor exposes one sticky save and protected close workflow", () => {
  const app = fs.readFileSync(path.join(root, "app/WorkspaceApp.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(root, "app/globals.css"), "utf8");
  const customerDetail = app.slice(
    app.indexOf("function CustomerDetail"),
    app.indexOf("function LeadsView"),
  );

  assert.match(app, /hideClose/);
  assert.match(app, /hideHeader = false/);
  assert.match(
    app,
    /onClose=\{\(\) => customerCloseRequestRef\.current\?\.\(\) \?\? closeSelectedCustomer\(\)\}[\s\S]*hideHeader/,
  );
  assert.match(customerDetail, /customer-editor-toolbar/);
  assert.equal(
    customerDetail.match(/<strong>\{customer\.company\}<\/strong>/g)?.length,
    1,
    "the customer editor must retain exactly one company-name header",
  );
  assert.match(customerDetail, /disabled=\{!isDirty \|\| isSaving\}/);
  assert.match(customerDetail, /onClick=\{\(\) => void saveAll\(\)\}/);
  assert.match(customerDetail, /closeAfterSave = false/);
  assert.match(customerDetail, /<CustomerUnsavedChangesDialog/);
  assert.match(app, /role="alertdialog"/);
  assert.match(app, /event\.target === event\.currentTarget/);
  assert.match(customerDetail, /<h3>保存失败<\/h3>/);
  assert.match(customerDetail, /重新尝试保存/);
  assert.match(customerDetail, /onFeedback\("已保存"\)/);
  assert.match(customerDetail, /baselineRef\.current/);
  assert.match(customerDetail, /customerFormSignature/);
  assert.match(customerDetail, /onSaved\(latestSnapshot\)/);
  assert.ok(
    customerDetail.indexOf("onSaved(latestSnapshot)") < customerDetail.indexOf("onFeedback(\"已保存\")"),
    "customer data must update locally before saved feedback is shown",
  );
  assert.match(customerDetail, /catch \(error\) \{[\s\S]*setSaveError[\s\S]*setIsDirty\(true\)[\s\S]*return false;/);
  assert.match(customerDetail, /onSavingClose: \(\) => setMessage\("正在保存，请稍候。"\)/);
  assert.match(customerDetail, /closeRequestRef\.current = closeGuard\.requestClose;/);
  assert.doesNotMatch(customerDetail, /loadWorkspace/);
  assert.match(styles, /\.customer-editor-toolbar[\s\S]*position: sticky/);
  assert.doesNotMatch(customerDetail, /saveAll\(\[\], true\)/);
});

test("customer editor dialogs render at viewport level and preserve editor scroll", () => {
  const app = fs.readFileSync(path.join(root, "app/WorkspaceApp.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(root, "app/globals.css"), "utf8");
  const closeGuard = app.slice(
    app.indexOf("function useCustomerCloseGuard"),
    app.indexOf("function CustomerDetail"),
  );
  const dialog = app.slice(
    app.indexOf("function CustomerEditorDialog"),
    app.indexOf("function CustomerDetail"),
  );
  const customerDetail = app.slice(
    app.indexOf("function CustomerDetail"),
    app.indexOf("function LeadsView"),
  );

  assert.match(dialog, /createPortal\([\s\S]*document\.body/);
  assert.match(dialog, /closest<HTMLElement>\("\.modal-card"\)/);
  assert.match(dialog, /scrollContainer\.style\.overflow = "hidden"/);
  assert.match(dialog, /scrollContainer\.style\.overflow = previousContainerOverflow/);
  assert.match(dialog, /document\.body\.style\.overflow = "hidden"/);
  assert.match(dialog, /focus\(\{ preventScroll: true \}\)/);
  assert.match(closeGuard, /function useCustomerCloseGuard/);
  assert.match(dialog, /function CustomerUnsavedChangesDialog/);
  assert.match(dialog, /当前有未保存的修改，确定关闭吗？/);
  assert.match(dialog, /继续编辑/);
  assert.match(dialog, /放弃修改/);
  assert.equal(customerDetail.match(/<CustomerEditorDialog/g)?.length, 2);
  assert.match(customerDetail, /<CustomerUnsavedChangesDialog/);
  assert.match(
    styles,
    /\.customer-editor-dialog-backdrop\s*\{[\s\S]*position: fixed;[\s\S]*inset: 0;[\s\S]*z-index: 1000;[\s\S]*place-items: center;/,
  );
});

test("customer editor keeps company fields in the main form and saves contacts inline", () => {
  const app = fs.readFileSync(path.join(root, "app/WorkspaceApp.tsx"), "utf8");
  const customerDetail = app.slice(
    app.indexOf("function CustomerDetail"),
    app.indexOf("function LeadsView"),
  );

  for (const formKey of ["rating", "profile"]) {
    assert.match(customerDetail, new RegExp(`data-customer-form=[\\"{\\\`]${formKey}`));
  }
  assert.match(customerDetail, /data-customer-form=\{`contact:\$\{contact\.id\}`\}/);
  assert.match(customerDetail, /operationForForm/);
  assert.match(customerDetail, /action: "update_rating"/);
  assert.match(customerDetail, /payload: \{ grade, purchaseIntent, purchaseAbility, ratingReason, nextFollow \}/);
  assert.match(customerDetail, /const ratingFormChanged = useCallback/);
  assert.match(customerDetail, /setIsDirty\(changed \|\| ratingFormChanged\(\)\)/);
  assert.match(customerDetail, /ratingFormChanged\(\)[\s\S]*!formsToSave\.some/);
  assert.match(customerDetail, /action: "update_profile"/);
  assert.match(customerDetail, /action: "save_contact"/);
  assert.match(customerDetail, /\+ 新增联系人/);
  assert.match(customerDetail, /onSubmit=\{saveNewContact\}/);
  assert.match(app, /key=\{String\(selectedCustomer\.id\)\}/);
  assert.match(app, /function ContactFieldSet[\s\S]*联系人备注/);
  assert.match(app, /function ContactFieldSet[\s\S]*微信/);
  assert.match(customerDetail, /公司背景与合作备注/);
  assert.doesNotMatch(customerDetail, /V1 原备注|V1 合作备注|name="legacyNotes"/);
  assert.doesNotMatch(customerDetail, /CUSTOMER MEMORY|自定义字段|custom:new/);
});

test("new customer reuses formal customer fields and stages formal contacts", () => {
  const app = fs.readFileSync(path.join(root, "app/WorkspaceApp.tsx"), "utf8");
  const workspaceRoute = fs.readFileSync(
    path.join(root, "app/api/workspace/route.ts"),
    "utf8",
  );
  const modal = app.slice(
    app.indexOf("function NewCustomerForm"),
    app.indexOf("function RecordModal"),
  );
  const customerCreate = workspaceRoute.slice(
    workspaceRoute.indexOf('} else if (kind === "customer")'),
    workspaceRoute.indexOf('} else if (kind === "order")'),
  );

  for (const field of [
    "company",
    "customerCode",
    "lifecycle",
    "country",
    "city",
    "website",
    "customerType",
    "source",
    "address",
    "companyBackgroundNotes",
    "nextAction",
  ]) {
    assert.match(modal, new RegExp(`name=\\"${field}\\"`));
  }
  assert.match(modal, /<NewCustomerContacts[\s\S]*onDraftStateChange/);
  assert.match(app, /function NewCustomerContacts[\s\S]*\+ 新增联系人/);
  assert.doesNotMatch(modal, /name="profile"/);
  assert.doesNotMatch(modal, /name="contact"|name="email" type="email" \/>|name="phone" \/>/);
  assert.ok(
    (app.match(/<ContactFieldSet/g) || []).length >= 3,
    "create and edit must share the same Contact fields component",
  );

  assert.match(customerCreate, /parseNewCustomerContacts\(payload\.contacts\)/);
  assert.match(customerCreate, /company_background_notes/);
  assert.match(customerCreate, /INSERT INTO contacts/);
  assert.match(customerCreate, /customer_id/);
  assert.doesNotMatch(customerCreate, /asNullableText\(payload\.contact|asNullableText\(payload\.email|asNullableText\(payload\.phone|asNullableText\(payload\.profile/);
});

test("Customers list keeps lifecycle-specific grade guides beside the review filter", () => {
  const app = fs.readFileSync(path.join(root, "app/WorkspaceApp.tsx"), "utf8");
  const css = fs.readFileSync(path.join(root, "app/globals.css"), "utf8");
  const customersView = app.slice(
    app.indexOf("function CustomersView"),
    app.indexOf("function LeadsView"),
  );

  assert.match(customersView, /A 高价值长期合作 · 7天｜B 有培养价值 · 15天｜C 低活跃\/有风险 · 30天｜D 清理型客户 · 45天/);
  assert.match(customersView, /1 有能力\+有意向 · 7天｜2 有意向但能力受限 · 15天｜3 有能力但意向不足 · 30天｜4 能力\/意向都弱 · 45天/);
  assert.match(customersView, /className="customer-grade-filter-row"/);
  assert.match(customersView, /className="customer-grade-guide"/);
  assert.match(css, /\.customer-grade-filter-row[\s\S]*flex-wrap: wrap/);
  assert.match(css, /\.customer-grade-guide[\s\S]*font-size: var\(--font-meta\)/);
});

test("contacts store WeChat per person through the shared editor", () => {
  const app = fs.readFileSync(path.join(root, "app/WorkspaceApp.tsx"), "utf8");
  const schema = fs.readFileSync(path.join(root, "db/schema.ts"), "utf8");
  const workspaceRoute = fs.readFileSync(
    path.join(root, "app/api/workspace/route.ts"),
    "utf8",
  );
  const customerRoute = fs.readFileSync(
    path.join(root, "app/api/customers/route.ts"),
    "utf8",
  );
  const migration = fs.readFileSync(
    path.join(root, "drizzle/0018_contact_wechat.sql"),
    "utf8",
  );
  const fieldSet = app.slice(
    app.indexOf("function ContactFieldSet"),
    app.indexOf("function NewCustomerContacts"),
  );

  assert.match(schema, /wechat: text\("wechat"\)/);
  assert.match(migration, /ALTER TABLE `contacts` ADD `wechat` text;/);
  assert.match(fieldSet, /textProps\("whatsapp"\)[\s\S]*textProps\("wechat"\)[\s\S]*textProps\("linkedin"\)/);
  assert.match(app, /contact\.wechat \? ` · 微信：\$\{contact\.wechat\}` : ""/);
  assert.match(workspaceRoute, /wechat: asNullableText\(row\.wechat, 100\)/);
  assert.match(workspaceRoute, /contact\.whatsapp,[\s\S]*contact\.wechat,[\s\S]*contact\.linkedin/);
  assert.match(customerRoute, /wechat = excluded\.wechat/);
  assert.match(customerRoute, /nullable\(payload\.whatsapp, 100\),[\s\S]*nullable\(payload\.wechat, 100\),[\s\S]*nullable\(payload\.linkedin, 500\)/);
});

test("new customer contact insert supplies a value for every explicit contact column", () => {
  const workspaceRoute = fs.readFileSync(
    path.join(root, "app/api/workspace/route.ts"),
    "utf8",
  );
  const customerCreate = workspaceRoute.slice(
    workspaceRoute.indexOf('} else if (kind === "customer")'),
    workspaceRoute.indexOf('} else if (kind === "order")'),
  );
  const match = customerCreate.match(
    /INSERT INTO contacts\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)`/,
  );

  assert.ok(match, "new customer flow must insert staged contacts");
  const columns = match[1].replace(/\s+/g, " ").split(",").map((item) => item.trim());
  const values = match[2].replace(/\s+/g, " ").split(",").map((item) => item.trim());
  assert.equal(columns.length, 16);
  assert.equal(values.length, 16);
  assert.equal(values[11], "?", "is_primary must receive its own bound value");
  assert.match(customerCreate, /contact\.isPrimary \? 1 : 0,[\s\S]*now,[\s\S]*now/);
});

test("new customer reuses the customer close guard and protects staged contact drafts", () => {
  const app = fs.readFileSync(path.join(root, "app/WorkspaceApp.tsx"), "utf8");
  const newCustomerForm = app.slice(
    app.indexOf("function NewCustomerForm"),
    app.indexOf("function RecordModal"),
  );
  const newCustomerContacts = app.slice(
    app.indexOf("function NewCustomerContacts"),
    app.indexOf("function NewCustomerForm"),
  );

  assert.match(newCustomerForm, /newCustomerInitialDraftSignature/);
  assert.match(newCustomerForm, /customerFormSignature\(form\)/);
  assert.match(newCustomerForm, /useCustomerCloseGuard/);
  assert.match(newCustomerForm, /isSaving: \(\) => busy/);
  assert.match(newCustomerForm, /onClose=\{closeGuard\.requestClose\}/);
  assert.match(newCustomerForm, /onInput=\{refreshDirty\}/);
  assert.match(newCustomerForm, /onChange=\{refreshDirty\}/);
  assert.match(newCustomerForm, /viewportFixed/);
  assert.match(newCustomerForm, /<CustomerUnsavedChangesDialog/);
  assert.match(newCustomerForm, /if \(saved\) setIsDirty\(false\)/);
  assert.match(newCustomerForm, /disabled=\{busy\}/);
  assert.match(newCustomerContacts, /name="contacts"/);
  assert.match(newCustomerContacts, /name="contactDraft"/);
  assert.match(newCustomerContacts, /onDraftStateChange\(\)/);
  assert.doesNotMatch(app, /NewCustomerUnsavedConfirm|NewCustomerDirtyGuard/);
});

test("company-level notes migrate legacy sources once without overwriting the official field", () => {
  const migration = fs.readFileSync(
    path.join(root, "drizzle/0016_customer_company_notes_unification.sql"),
    "utf8",
  );
  const runtime = fs.readFileSync(path.join(root, "db/runtime.ts"), "utf8");
  const customerRoute = fs.readFileSync(path.join(root, "app/api/customers/route.ts"), "utf8");
  const v1ImportRoute = fs.readFileSync(path.join(root, "app/api/import-v1/route.ts"), "utf8");
  const db = new DatabaseSync(":memory:");

  db.exec(`CREATE TABLE customers (
    id TEXT PRIMARY KEY,
    company_background_notes TEXT,
    legacy_notes TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE customer_memory (
    customer_id TEXT PRIMARY KEY,
    relationship_notes TEXT
  );`);
  db.prepare("INSERT INTO customers (id, company_background_notes, legacy_notes) VALUES (?, ?, ?)")
    .run("original-only", null, "原备注内容");
  db.prepare("INSERT INTO customers (id, company_background_notes, legacy_notes) VALUES (?, ?, ?)")
    .run("cooperation-only", null, "");
  db.prepare("INSERT INTO customers (id, company_background_notes, legacy_notes) VALUES (?, ?, ?)")
    .run("all-sources", "现有正式内容", "原备注内容");
  db.prepare("INSERT INTO customers (id, company_background_notes, legacy_notes) VALUES (?, ?, ?)")
    .run("empty", null, "");
  db.prepare("INSERT INTO customer_memory (customer_id, relationship_notes) VALUES (?, ?)")
    .run("cooperation-only", "合作备注内容");
  db.prepare("INSERT INTO customer_memory (customer_id, relationship_notes) VALUES (?, ?)")
    .run("all-sources", "合作备注内容");

  const statements = migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) db.exec(statement);

  const afterFirstRun = db.prepare(
    "SELECT id, company_background_notes AS notes, legacy_notes FROM customers ORDER BY id",
  ).all();
  const noteById = Object.fromEntries(afterFirstRun.map((row) => [row.id, row.notes]));
  assert.equal(noteById["original-only"], "【V1 原备注】\n原备注内容");
  assert.equal(noteById["cooperation-only"], "【V1 合作备注】\n合作备注内容");
  assert.equal(
    noteById["all-sources"],
    "现有正式内容\n\n【V1 原备注】\n原备注内容\n\n【V1 合作备注】\n合作备注内容",
  );
  assert.equal(noteById.empty, null);
  assert.equal(afterFirstRun.find((row) => row.id === "all-sources").legacy_notes, "原备注内容");

  for (const statement of statements) db.exec(statement);
  const afterSecondRun = db.prepare(
    "SELECT id, company_background_notes AS notes FROM customers ORDER BY id",
  ).all();
  assert.deepEqual(
    afterSecondRun.map(({ id, notes }) => ({ id, notes })),
    afterFirstRun.map(({ id, notes }) => ({ id, notes })),
  );

  assert.match(migration, /backup_v67_customers_company_notes_20260826/);
  assert.match(migration, /backup_v67_customer_memory_company_notes_20260826/);
  assert.match(migration, /【V1 原备注】/);
  assert.match(migration, /【V1 合作备注】/);
  assert.match(migration, /INSTR\(COALESCE\(`company_background_notes`, ''\), '【V1 原备注】'\)/);
  assert.match(runtime, /customerCompanyNotesUnificationStatements/);
  assert.match(runtime, /customerCompanyNotesBackupStatements/);
  assert.doesNotMatch(customerRoute, /company_background_notes = \?, legacy_notes = \?/);
  assert.doesNotMatch(v1ImportRoute, /legacy_notes/);
});

test("customer editor separates stable customer data from the local follow-up work area", () => {
  const app = fs.readFileSync(path.join(root, "app/WorkspaceApp.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(root, "app/globals.css"), "utf8");
  const customerDetail = app.slice(
    app.indexOf("function CustomerDetail"),
    app.indexOf("function LeadsView"),
  );

  assert.match(app, /onClose=\{\(\) => customerCloseRequestRef\.current\?\.\(\) \?\? closeSelectedCustomer\(\)\}[\s\S]*viewportFixed[\s\S]*hideClose/);
  assert.match(customerDetail, /customer-editor-columns/);
  assert.match(customerDetail, /customer-editor-profile-column/);
  assert.match(customerDetail, /customer-editor-followup-column/);
  assert.match(customerDetail, /customer-followup-top/);
  assert.ok(
    customerDetail.indexOf("customer-editor-profile-column") < customerDetail.indexOf("customer-editor-followup-column"),
    "stable customer data must precede the follow-up work area",
  );
  assert.match(styles, /\.customer-editor-columns[\s\S]*grid-template-columns: minmax\(0, 3fr\) minmax\(340px, 2fr\)/);
  assert.match(styles, /\.customer-editor-followup-column \.customer-followup-editor[\s\S]*position: sticky/);
  assert.match(styles, /\.customer-followup-history[\s\S]*overflow-y: auto/);
  assert.match(styles, /@media \(max-width: 920px\)[\s\S]*\.customer-editor-columns[\s\S]*grid-template-columns: 1fr/);
  assert.doesNotMatch(customerDetail, /loadWorkspace/);
});

test("customer follow-ups are explicitly recorded, lightweight, and local", () => {
  const app = fs.readFileSync(path.join(root, "app/WorkspaceApp.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(root, "app/globals.css"), "utf8");
  const route = fs.readFileSync(path.join(root, "app/api/customers/route.ts"), "utf8");
  const migration = fs.readFileSync(
    path.join(root, "drizzle/0015_customer_contact_followups.sql"),
    "utf8",
  );
  const customerDetail = app.slice(
    app.indexOf("function CustomerDetail"),
    app.indexOf("function LeadsView"),
  );

  assert.match(customerDetail, /\+ 记录跟进/);
  assert.match(customerDetail, /onSubmit=\{saveFollowUp\}/);
  assert.match(customerDetail, /customer-followup-history/);
  assert.match(customerDetail, /loadMoreFollowUps/);
  assert.match(customerDetail, /followUpDate/);
  assert.match(customerDetail, /nextFollowUpDate/);
  assert.doesNotMatch(customerDetail, /补录有效联系日期|记录本次联系|recordContact/);
  assert.match(customerDetail, /FollowUpHistoryItem/);
  assert.match(customerDetail, /saveFollowUpEdit/);
  assert.match(customerDetail, /deleteFollowUp/);
  assert.match(app, /function FollowUpHistoryItem[\s\S]*ResizeObserver/);
  assert.match(app, /expanded \? "收起" : "展开全文"/);
  assert.match(app, /确认删除这条跟进记录？/);
  assert.match(styles, /\.follow-up-item p[\s\S]*-webkit-line-clamp: 3/);
  assert.match(styles, /\.follow-up-item p\.expanded[\s\S]*overflow: visible/);
  assert.doesNotMatch(customerDetail, /DateTimeInput|默认仅加载最近 3 条|查看全部（/);
  assert.doesNotMatch(customerDetail, /loadWorkspace/);
  assert.match(route, /action === "record_follow_up"/);
  assert.match(route, /action === "update_follow_up"/);
  assert.match(route, /action === "delete_follow_up"/);
  assert.match(route, /ORDER BY follow_up_at DESC, created_at DESC LIMIT \? OFFSET \?/);
  assert.match(route, /FOLLOW_UP_INITIAL_LIMIT = 6/);
  assert.match(route, /payload\.followUpDate/);
  assert.doesNotMatch(route, /localDateTime\(payload\.followUpAt\)/);
  assert.match(route, /function recomputeLastFollow/);
  assert.match(route, /SELECT MAX\(follow_up_at\) AS follow_up_at/);
  assert.match(route, /DELETE FROM customer_follow_ups WHERE id = \? AND customer_id = \?/);
  assert.doesNotMatch(route, /action === "record_contact"/);
  assert.doesNotMatch(route, /action === "update_memory"|action === "save_custom_field"/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `customer_follow_ups`/);
  assert.match(migration, /company_background_notes/);
  assert.match(migration, /backup_v58_customers_contact_notes_20260819/);
  assert.match(migration, /backup_v58_customer_memory_contact_notes_20260819/);
});

test("a new potential-customer follow-up updates the current date without rewriting history decisions", () => {
  const app = fs.readFileSync(path.join(root, "app/WorkspaceApp.tsx"), "utf8");
  const route = fs.readFileSync(path.join(root, "app/api/customers/route.ts"), "utf8");
  const customerDetail = app.slice(
    app.indexOf("function CustomerDetail"),
    app.indexOf("function LeadsView"),
  );
  const recordFollowUp = route.slice(
    route.indexOf('if (action === "record_follow_up")'),
    route.indexOf('if (action === "update_follow_up")'),
  );
  const historicalFollowUpChanges = route.slice(
    route.indexOf('if (action === "update_follow_up")'),
    route.indexOf('if (action === "save_contact")'),
  );

  assert.match(
    customerDetail,
    /下次跟进日期[\s\S]*value=\{nextFollow\}[\s\S]*setNextFollow/,
  );
  assert.match(
    customerDetail,
    /下次跟进[\s\S]*nextFollow \? formatDate\(nextFollow\) : "未设置"/,
  );
  assert.match(
    customerDetail,
    /record_follow_up[\s\S]*setNextFollow\(String\(result\.snapshot\.customer\?\.next_follow \|\| ""\)\.slice\(0, 10\)\)/,
  );
  assert.match(recordFollowUp, /await db\.batch\(statements\)/);
  assert.match(recordFollowUp, /next_follow = CASE WHEN \? IS NOT NULL THEN \? ELSE next_follow END/);
  assert.doesNotMatch(recordFollowUp, /recomputeNextFollow/);
  assert.doesNotMatch(historicalFollowUpChanges, /next_follow\s*=|recomputeNextFollow/);
});

test("AI suggestions remain UI-only until Joyce adopts and saves", () => {
  const app = fs.readFileSync(path.join(root, "app/WorkspaceApp.tsx"), "utf8");
  const customerDetail = app.slice(
    app.indexOf("function CustomerDetail"),
    app.indexOf("function LeadsView"),
  );
  const analyze = customerDetail.slice(
    customerDetail.indexOf("async function generateRatingAdvice"),
    customerDetail.indexOf("function adoptRatingAdvice"),
  );
  const adopt = customerDetail.slice(
    customerDetail.indexOf("function adoptRatingAdvice"),
    customerDetail.indexOf("async function loadMoreFollowUps"),
  );

  assert.match(analyze, /setRatingAdvice/);
  assert.doesNotMatch(analyze, /requestCustomerSave|saveAll/);
  assert.match(adopt, /setGrade/);
  assert.match(adopt, /setRatingReason/);
  assert.doesNotMatch(adopt, /requestCustomerSave|saveAll/);
});
