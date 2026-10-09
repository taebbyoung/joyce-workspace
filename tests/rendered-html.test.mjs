import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("Work creation never calls AI and preserves manual ordering", async () => {
  const [workspaceRoute, priorityService, migration] =
    await Promise.all([
      source("app/api/workspace/route.ts"),
      source("lib/work-priority.ts"),
      source("drizzle/0005_work_priority_sorting.sql"),
    ]);

  assert.doesNotMatch(workspaceRoute, /rankAfterCreation|rankWorkPriority/);
  assert.doesNotMatch(priorityService, /rankWorkPriority|requestJson|requestAi/);
  assert.match(workspaceRoute, /MAX\(work_sort_order\)/);
  assert.match(priorityService, /work_sort_order/);
  assert.match(migration, /backup_v21_tasks_priority_20260724/);
  assert.match(migration, /backup_v21_projects_priority_20260724/);
});

test("Work tasks use one reminder date and keep legacy columns only for compatibility", async () => {
  const [app, workspaceRoute, tasksRoute] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/api/workspace/route.ts"),
    source("app/api/tasks/route.ts"),
  ]);
  const workStart = app.indexOf("function WorkView(");
  const reportsStart = app.indexOf("function ReportsView(", workStart);
  const workSource = app.slice(workStart, reportsStart);
  const recordStart = app.indexOf("function RecordModal(");
  const taskFormStart = app.indexOf('{kind === "task" ?', recordStart);
  const taskFormEnd = app.indexOf('{kind === "project" ?', taskFormStart);
  const taskFormSource = app.slice(taskFormStart, taskFormEnd);

  assert.match(taskFormSource, /name="title"/);
  assert.match(taskFormSource, /name="reminderDate"/);
  assert.match(taskFormSource, /name="nextAction"/);
  assert.match(taskFormSource, /name="notes"/);
  assert.match(taskFormSource, /name="recurrenceRule"/);
  assert.doesNotMatch(
    taskFormSource,
    /name="customerCode"|name="nextActionDate"|name="priority"/,
  );
  assert.doesNotMatch(
    workSource,
    /name="nextActionDate"|name="priority"/,
  );
  assert.match(workSource, /task\.reminder_date \?\? task\.next_action_date/);
  assert.match(workspaceRoute, /asNullableText\(payload\.reminderDate, 10\)/);
  assert.doesNotMatch(workspaceRoute, /task\.priority ===/);
  assert.match(tasksRoute, /payload\.reminderDate \?\? payload\.snoozedUntil/);
  const statusSource = tasksRoute.slice(
    tasksRoute.indexOf('if (action === "status")'),
  );
  assert.doesNotMatch(statusSource, /next_action_date = CASE/);
  assert.doesNotMatch(statusSource, /\bnextActionDate\b/);
  assert.match(
    statusSource,
    /recurringContinues/,
  );
});

test("task mutations use local updates without reloading the workspace", async () => {
  const [app, tasksRoute] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/api/tasks/route.ts"),
  ]);
  const start = app.indexOf("async function updateTask(");
  const end = app.indexOf("async function submitRecord", start);
  const mutationSource = app.slice(start, end);
  const submitStart = app.indexOf("async function submitRecord", end);
  const submitEnd = app.indexOf("const headerTitle", submitStart);
  const submitSource = app.slice(submitStart, submitEnd);

  assert.ok(start >= 0 && end > start);
  assert.match(mutationSource, /optimisticTask/);
  assert.match(mutationSource, /previousTask/);
  assert.match(mutationSource, /previousTodayTask/);
  assert.match(mutationSource, /restorePreviousTask\(\)/);
  assert.match(mutationSource, /work_sort_order/);
  assert.doesNotMatch(mutationSource, /await loadWorkspace\(\)/);
  const optimisticTaskBranch = submitSource.slice(
    submitSource.indexOf("if (optimisticTask) {", submitSource.indexOf("const result")),
    submitSource.indexOf('if (recordModal === "project"', submitSource.indexOf("const result")),
  );
  assert.match(optimisticTaskBranch, /closeRecord\(true\)[\s\S]*return true;/);
  assert.doesNotMatch(optimisticTaskBranch, /loadWorkspace\(/);
  assert.doesNotMatch(tasksRoute, /requestAi|rankWorkPriority|rankAfterCreation/);
  assert.match(tasksRoute, /Object\.prototype\.hasOwnProperty/);
});

test("Work Overview supports stable manual drag ordering without an AI button", async () => {
  const [app, priorityRoute] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/api/work-priority/route.ts"),
  ]);

  assert.match(app, /draggable/);
  assert.match(app, /onPointerMove/);
  assert.match(app, /\/api\/work-priority/);
  assert.match(priorityRoute, /saveManualWorkOrder/);
  assert.match(await source("lib/work-priority.ts"), /'待处理', '进行中', '延期'/);
  assert.doesNotMatch(
    app,
    /AI\s*(重新排序|Re-sort)|Optimize Order|Recalculate Priority/i,
  );
});

test("Work task More menu is single-open and closes outside or on scroll", async () => {
  const app = await source("app/WorkspaceApp.tsx");
  const workStart = app.indexOf("function WorkView(");
  const reportsStart = app.indexOf("function ReportsView(", workStart);
  const workSource = app.slice(workStart, reportsStart);

  assert.match(workSource, /openTaskMenuId/);
  assert.match(workSource, /data-task-more-menu/);
  assert.match(workSource, /closest\("\[data-task-more-menu\]"\)/);
  assert.match(
    workSource,
    /document\.addEventListener\("pointerdown", closeOnOutsidePointer\)/,
  );
  assert.match(
    workSource,
    /window\.addEventListener\("scroll", closeOnScroll, true\)/,
  );
  assert.match(
    workSource,
    /current === String\(task\.id\) \? "" : String\(task\.id\)/,
  );
  assert.match(workSource, /aria-expanded=\{openTaskMenuId === String\(task\.id\)\}/);
  assert.match(workSource, /setEditingTask\(task\)/);
  assert.match(workSource, /void act\(task, "archive"\)/);
  assert.match(workSource, /void act\(task, "delete"\)/);
});

test("Projects no longer present progress controls or progress bars in Work", async () => {
  const app = await source("app/WorkspaceApp.tsx");
  const workStart = app.indexOf("function WorkView(");
  const nextModule = app.indexOf("function ReportsView(", workStart);
  const workSource = app.slice(workStart, nextModule);
  const recordModalStart = app.indexOf("function RecordModal(");
  const recordModalSource = app.slice(recordModalStart);

  assert.ok(workStart >= 0 && nextModule > workStart);
  assert.doesNotMatch(workSource, /project\.progress|selectedProject\.progress/);
  assert.doesNotMatch(recordModalSource, /name="progress"/);
});

test("Work Overview reuses the Completed white card system", async () => {
  const [app, styles] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/globals.css"),
  ]);

  assert.equal(
    (app.match(/className="plain-panel overview-section/g) ?? []).length,
    3,
  );
  assert.match(app, /暂无即将进行的安排。/);
  assert.match(styles, /\.plain-panel\s*\{[\s\S]*background:\s*var\(--paper\)/);
  assert.doesNotMatch(
    styles,
    /\.projects-overview\s*\{[\s\S]{0,180}border-left:/,
  );
});

test("Edit Order uses a viewport-fixed modal with an isolated scroll body", async () => {
  const [app, styles] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(app, /createPortal\(modal, document\.body\)/);
  assert.match(app, /viewportFixed/);
  assert.match(app, /bodyRef=\{orderModalBodyRef\}/);
  assert.match(app, /dismissOnBackdrop=\{false\}/);
  assert.match(app, /orderModalBodyRef\.current\.scrollTop = 0/);
  assert.match(app, /bodyStyle\.position = "fixed"/);
  assert.match(app, /window\.scrollTo\(scrollX, scrollY\)/);
  assert.match(app, /focus\(\{ preventScroll: true \}\)/);
  assert.match(styles, /\.modal-backdrop-viewport\s*\{[\s\S]*height:\s*100dvh/);
  assert.match(styles, /\.modal-card-viewport\s*\{[\s\S]*display:\s*flex/);
  assert.match(styles, /\.modal-body-viewport\s*\{[\s\S]*min-height:\s*0/);
  assert.match(styles, /\.modal-body-viewport\s*\{[\s\S]*overflow-y:\s*auto/);
  assert.match(
    styles,
    /\.modal-card-viewport \.modal-head\s*\{[\s\S]*position:\s*sticky/,
  );
});

test("final order model is additive and keeps a pre-migration backup", async () => {
  const [schema, runtime, migration] = await Promise.all([
    source("db/schema.ts"),
    source("db/runtime.ts"),
    source("drizzle/0003_order_module_final.sql"),
  ]);

  for (const value of ["orderDocuments", "orderRisks", "orderStatusHistory"]) {
    assert.match(schema, new RegExp(`export const ${value}`));
  }
  assert.match(runtime, /backup_v21_orders_final_20260724/);
  assert.match(runtime, /port_of_loading/);
  assert.match(runtime, /production_notes/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `order_documents`/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `order_risks`/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM `orders`/);
});

test("order editor separates product items, lightweight shipment and risks", async () => {
  const app = await source("app/WorkspaceApp.tsx");
  assert.match(app, /PRODUCT ITEMS/);
  const itemsStart = app.indexOf('className="order-item-list"');
  const itemsEnd = app.indexOf('</section>', itemsStart);
  const itemsSource = app.slice(itemsStart, itemsEnd);
  assert.match(itemsSource, /<table className="order-item-table">/);
  assert.match(itemsSource, /<thead>[\s\S]*<th scope="col">整车车型<\/th>[\s\S]*<th scope="col">操作<\/th>[\s\S]*<\/thead>/);
  assert.match(itemsSource, /<tbody>[\s\S]*editorItems\.map/);
  assert.doesNotMatch(itemsSource, /<label>整车车型|className="order-item-row"/);
  assert.match(app, /产品明细不会反算或覆盖订单总金额/);
  assert.match(app, /客户名称（自动匹配）/);
  assert.match(app, /AI RISK ALERT/);
  const ordersView = app.slice(app.indexOf("function OrdersView("), app.indexOf("function AfterSalesView("));
  assert.doesNotMatch(ordersView, /上传提单并识别|订单文档|上传文档/);
  const paymentOptions = app.slice(
    app.indexOf("const paymentStatusOptions"),
    app.indexOf("const productionStatusOptions"),
  );
  assert.match(paymentOptions, /\["unpaid", "未付款"\]/);
  assert.doesNotMatch(paymentOptions, /\["partial_payment"/);
});

test("Knowledge cards open a complete editable detail workflow", async () => {
  const [app, route, playbookRoute, styles] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/api/knowledge/route.ts"),
    source("app/api/knowledge/playbook/route.ts"),
    source("app/globals.css"),
  ]);

  assert.match(app, /className="knowledge-card"/);
  assert.match(app, /onClick=\{\(\) => onSelect\(item\)\}/);
  assert.match(app, /function KnowledgeDetailModal/);
  assert.match(app, /完整原文/);
  assert.doesNotMatch(app, /AI 整理后的标题/);
  assert.doesNotMatch(app, /AI 整理后的摘要/);
  for (const label of [
    "标题",
    "分类",
    "标签",
    "精华提炼",
    "核心原则",
    "可执行技巧",
    "适用场景",
    "完整原文",
    "来源名称",
    "来源链接",
  ]) {
    assert.match(app, new RegExp(label));
  }
  assert.match(app, /加入 Sales Playbook/);
  assert.match(app, /保存修改/);
  assert.match(app, /再次点击确认删除/);
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function PATCH/);
  assert.match(route, /export async function DELETE/);
  assert.doesNotMatch(route, /inSalesPlaybook/);
  assert.match(playbookRoute, /created_from/);
  assert.match(playbookRoute, /approved_by/);
  assert.match(playbookRoute, /approved_at/);
  assert.match(playbookRoute, /selectedPrinciples|principles/);
  assert.match(styles, /\.knowledge-card:hover/);
  assert.match(styles, /\.knowledge-detail/);
});

test("knowledge categories and tags use compact editable chips", async () => {
  const [app, styles, route] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/globals.css"),
    source("app/api/knowledge/route.ts"),
  ]);
  const detail = app.slice(
    app.indexOf("function EditableChips"),
    app.indexOf("function ContentView"),
  );
  assert.match(detail, /function EditableChips/);
  assert.match(detail, /knowledge-editable-chip/);
  assert.match(detail, /\+ 添加\{addLabel\}/);
  assert.match(detail, /aria-label=\{`删除\$\{label\}/);
  assert.match(detail, /<EditableChips label="分类"/);
  assert.match(detail, /<EditableChips label="标签"/);
  assert.doesNotMatch(detail, /来源备注/);
  assert.doesNotMatch(detail, /sourceNotes/);
  assert.match(styles, /\.knowledge-chip-row/);
  assert.match(styles, /flex-wrap:\s*wrap/);
  assert.match(styles, /min-height:\s*30px/);
  assert.match(styles, /text-overflow:\s*clip/);
  assert.match(styles, /white-space:\s*nowrap/);
  assert.doesNotMatch(detail, /Math\.min\(24/);
  assert.match(route, /"sourceNotes" in payload/);
  assert.match(route, /text\(before\.source_notes/);
});

test("knowledge essence is one coherent paragraph and list add rows are temporary", async () => {
  const [app, route, essence] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/api/knowledge/route.ts"),
    source("lib/knowledge-essence.ts"),
  ]);
  const detail = app.slice(
    app.indexOf("function EditableList"),
    app.indexOf("function ContentView"),
  );
  assert.match(detail, /knowledge-essence-editor/);
  assert.match(detail, /aria-label="精华提炼"/);
  assert.match(detail, /String\(item\?\.essence_summary \|\| ""\)/);
  assert.match(detail, /essenceSummary:\s*essenceSummary\.trim\(\)/);
  assert.doesNotMatch(detail, /parseList\(item\?\.essence_points\)\.join/);
  assert.doesNotMatch(detail, /<EditableList label="精华提炼"/);
  assert.match(detail, /\{adding \? \(/);
  assert.match(detail, /\+ 添加\{addLabel\}/);
  assert.match(detail, /addLabel="原则"/);
  assert.match(detail, /addLabel="技巧"/);
  assert.match(detail, /<EditableChips[\s\S]*label="适用场景"[\s\S]*addLabel="场景"/);
  assert.match(essence, /essence_summary 必须是单个字符串/);
  assert.match(essence, /本文介绍了/);
  assert.match(route, /essence_summary = \?/);
  assert.doesNotMatch(route, /essenceValues|essencePoints\.join/);
});

test("knowledge detail follows the final structured field order", async () => {
  const app = await source("app/WorkspaceApp.tsx");
  const start = app.indexOf("function KnowledgeDetailModal");
  const end = app.indexOf("function ContentView", start);
  const detail = app.slice(start, end);
  const labels = [
    "标题",
    'label="分类"',
    'label="标签"',
    'label="精华提炼"',
    'label="核心原则"',
    'label="可执行技巧"',
    'label="适用场景"',
    'className="knowledge-original"',
    "来源名称",
  ];
  let last = -1;
  for (const label of labels) {
    const position = detail.indexOf(label);
    assert.ok(position > last, `${label} must follow the previous field`);
    last = position;
  }
});

test("knowledge migration is additive, backed up and preserves approved legacy records", async () => {
  const [migration, runtime, schema] = await Promise.all([
    source("drizzle/0007_knowledge_structured_playbook.sql"),
    source("db/runtime.ts"),
    source("db/schema.ts"),
  ]);
  assert.match(migration, /backup_v22_knowledge_structured_20260725/);
  assert.match(migration, /backup_v22_playbook_structured_20260725/);
  assert.match(migration, /essence_points/);
  assert.match(migration, /core_principles/);
  assert.match(migration, /actionable_tactics/);
  assert.match(migration, /applicable_scenarios/);
  assert.match(migration, /source_name/);
  assert.match(migration, /original_source_type/);
  assert.match(migration, /771238a0-5b03-4e9e-916a-4702f9bd4fdf/);
  assert.match(migration, /eda82392-1a24-4027-87b5-883d9210a666/);
  assert.doesNotMatch(migration, /SET[\s\S]*`title`\s*=/);
  assert.match(runtime, /knowledgeStructuredBackupStatements/);
  assert.match(schema, /userEditedFields/);
  assert.match(schema, /contentModifiedAt/);
});

test("essence_summary migration is additive and keeps legacy essence points", async () => {
  const [migration, runtime, schema] = await Promise.all([
    source("drizzle/0008_knowledge_essence_summary.sql"),
    source("db/runtime.ts"),
    source("db/schema.ts"),
  ]);
  assert.match(migration, /backup_v22_knowledge_essence_summary_20260725/);
  assert.match(migration, /ADD COLUMN `essence_summary` text/);
  assert.doesNotMatch(migration, /DROP COLUMN|UPDATE `knowledge_items`/);
  assert.match(runtime, /knowledgeEssenceSummaryBackupStatements/);
  assert.match(runtime, /\["essence_summary", "TEXT"\]/);
  assert.match(schema, /essenceSummary:\s*text\("essence_summary"\)/);
  assert.match(schema, /essencePoints:\s*text\("essence_points"\)/);
});

test("Knowledge Library uses local parsing first and AI only for field allocation", async () => {
  const [provider, route, parser, app] = await Promise.all([
    source("lib/ai-provider.ts"),
    source("app/api/knowledge/route.ts"),
    source("lib/structured-archive.ts"),
    source("app/WorkspaceApp.tsx"),
  ]);
  assert.match(parser, /parseKnowledgeArchive/);
  assert.match(app, /parseKnowledgeArchive\(organizedText\)/);
  assert.match(app, /已识别标准整理稿并填入字段，尚未保存/);
  assert.match(route, /你的唯一任务是把用户已经整理好的内容原样分配到字段/);
  assert.match(route, /不得总结、改写、删减、补充、推断或优化/);
  assert.match(route, /saved: false/);
  assert.doesNotMatch(provider, /generateKnowledgeEssence\(input/);
});

test("Work completed history uses the server completion timestamp", async () => {
  const [app, tasksRoute] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/api/tasks/route.ts"),
  ]);
  const workStart = app.indexOf("function WorkView(");
  const reportsStart = app.indexOf("function ReportsView(", workStart);
  const workSource = app.slice(workStart, reportsStart);
  const statusStart = tasksRoute.indexOf('if (action === "status")');
  const statusSource = tasksRoute.slice(statusStart);

  assert.match(tasksRoute, /const now = new Date\(\)\.toISOString\(\)/);
  assert.match(statusSource, /status === "completed" \? now : null/);
  assert.match(workSource, /sortTasksByCompletedAt\(completedTasks\)/);
  assert.doesNotMatch(workSource, /sortTasksByCompletedAt\(todayTasks|sortTasksByCompletedAt\(upcomingTasks/);
});

test("completed Work separates tasks and projects by their own completion timestamps", async () => {
  const [app, projectsRoute, migration, schema, runtime] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/api/projects/route.ts"),
    source("drizzle/0011_projects_completed_at.sql"),
    source("db/schema.ts"),
    source("db/runtime.ts"),
  ]);
  const workStart = app.indexOf("function WorkView(");
  const reportsStart = app.indexOf("function ReportsView(", workStart);
  const workSource = app.slice(workStart, reportsStart);

  assert.match(workSource, /<h2>已完成任务<\/h2>|\? "已完成任务"/);
  assert.match(workSource, /<h2>已完成项目<\/h2>/);
  assert.match(workSource, /const completedProjects = sortTasksByCompletedAt/);
  assert.match(workSource, /project\.completed_at/);
  assert.match(projectsRoute, /action === "complete"/);
  assert.match(projectsRoute, /status = 'completed', completed_at = \?, updated_at = \?/);
  assert.match(schema, /completedAt: text\("completed_at"\)/);
  assert.match(runtime, /projectCompletionColumns/);
  assert.match(migration, /backup_v45_projects_completed_at_20260812/);
  assert.match(migration, /ALTER TABLE projects ADD COLUMN completed_at TEXT/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM projects/);
});

test("project deletion preserves linked tasks and updates Work locally", async () => {
  const [app, projectsRoute] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/api/projects/route.ts"),
  ]);
  const updateStart = app.indexOf("async function updateProject(");
  const nextFunction = app.indexOf("function applyOrderUpdate", updateStart);
  const updateSource = app.slice(updateStart, nextFunction);
  const unlinkIndex = projectsRoute.indexOf("UPDATE tasks SET project_id = NULL");
  const deleteIndex = projectsRoute.indexOf("DELETE FROM projects WHERE id = ?");

  assert.match(app, /window\.confirm\("确定删除这个项目吗？"\)/);
  assert.ok(unlinkIndex >= 0 && deleteIndex > unlinkIndex);
  assert.doesNotMatch(projectsRoute, /DELETE FROM tasks|UPDATE tasks SET status/);
  assert.match(updateSource, /projects: current\.projects\.filter/);
  assert.match(updateSource, /project_id: null/);
  assert.doesNotMatch(updateSource, /loadWorkspace/);
});

test("Completed uses a paged task list and side-by-side projects with final results", async () => {
  const [app, tasksRoute, projectsRoute, css, migration, schema, runtime] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/api/tasks/route.ts"),
    source("app/api/projects/route.ts"),
    source("app/globals.css"),
    source("drizzle/0012_projects_final_result.sql"),
    source("db/schema.ts"),
    source("db/runtime.ts"),
  ]);

  assert.match(app, /\/api\/tasks\?view=completed&limit=30&offset=/);
  assert.match(app, /completedTasksHasMore/);
  assert.match(app, /"加载更多"/);
  assert.match(tasksRoute, /export async function GET/);
  assert.match(tasksRoute, /LIMIT \? OFFSET \?/);
  assert.match(tasksRoute, /completed_at DESC/);
  assert.match(css, /\.completed-work-sections[\s\S]*grid-template-columns:\s*minmax\(0, 3fr\) minmax\(280px, 2fr\)/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.completed-work-sections[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(app, /project\.final_result \|\| "暂无最终结论"/);
  assert.match(app, /name="finalResult"/);
  assert.match(projectsRoute, /action === "reopen"/);
  assert.match(projectsRoute, /status = '进行中', completed_at = NULL/);
  assert.match(migration, /backup_v46_projects_final_result_20260812/);
  assert.match(migration, /ALTER TABLE projects ADD COLUMN final_result TEXT/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM projects/);
  assert.match(schema, /finalResult: text\("final_result"\)/);
  assert.match(runtime, /projectFinalResultColumns/);
});

test("Need Your Attention routes only by source type and source id", async () => {
  const [app, homeRoute, homeBootstrap] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/api/home/route.ts"),
    source("lib/home-bootstrap.ts"),
  ]);
  const routerStart = app.indexOf("function openAttentionTarget(");
  const routerEnd = app.indexOf("return (", routerStart);
  const router = app.slice(routerStart, routerEnd);
  const attentionQuery = homeBootstrap.slice(
    homeBootstrap.indexOf("export const homeNonCustomerAttentionSql"),
  );
  const homeStart = app.indexOf("function HomeView(");
  const workStart = app.indexOf("function WorkView(", homeStart);
  const homeSource = app.slice(homeStart, workStart);

  assert.match(homeRoute, /homeNonCustomerAttentionSql/);
  assert.match(attentionQuery, /'task' AS source_type|SELECT 'task', id, NULL, 'task', id/);
  assert.match(attentionQuery, /'order' AS source_type, r\.order_id AS source_id/);
  assert.match(homeBootstrap, /buildCustomerFollowUpAttention/);
  assert.match(
    attentionQuery,
    /COALESCE\(NULLIF\(reminder_date, ''\), NULLIF\(next_action_date, ''\), NULLIF\(due_date, ''\)\) < \?/,
  );
  assert.match(attentionQuery, /status IN \('pending', 'in_progress'/);
  assert.match(attentionQuery, /attention_date/);
  assert.match(homeBootstrap, /customerAttention/);
  assert.doesNotMatch(attentionQuery, /due_date < \?|LIMIT 10/);
  assert.match(homeSource, /groupHomeAttention\(data\.attention\)/);
  assert.match(homeSource, /className="attention-total">\{homeAttention\.total\} 条/);
  assert.doesNotMatch(homeSource, /data\.attention\.slice\(0, 5\)/);
  assert.match(router, /item\.source_type \|\| item\.kind/);
  assert.match(router, /type === "order" \? item\.order_id : item\.id/);
  assert.match(router, /task: "work"/);
  assert.match(router, /project: "work"/);
  assert.match(router, /order: "orders"/);
  assert.match(router, /customer: "customers"/);
  assert.match(router, /after_sales_case: "after-sales"/);
  assert.match(router, /原关联/);
  assert.doesNotMatch(router, /includes\(|充电|故障|技术|BMS|控制器/);
  assert.doesNotMatch(router, /onAcknowledgeRisk|acknowledge/);
  assert.match(app, /attentionTarget\.type === "task"[\s\S]*setEditingTask\(task\)/);
  assert.match(app, /\["task", "project"\]\.includes\(attentionTarget\.type\)[\s\S]*else \{[\s\S]*setSelectedProject\(project\)/);
  assert.match(app, /attentionTarget\?\.type !== "order"[\s\S]*openOrder\(order\)/);
  assert.match(app, /attentionTarget\?\.type !== "after_sales_case"[\s\S]*const target = attentionTarget;[\s\S]*openEdit\(\{ id: target\.id \}\)/);
});

test("Need Your Attention targets are consumed once after the destination opens", async () => {
  const app = await source("app/WorkspaceApp.tsx");
  const rootStart = app.indexOf("export function WorkspaceApp");
  const workStart = app.indexOf("function WorkView(");
  const ordersStart = app.indexOf("function OrdersView(");
  const afterSalesStart = app.indexOf("function AfterSalesView(");
  const knowledgeStart = app.indexOf("function KnowledgeView(", afterSalesStart);
  const rootSource = app.slice(rootStart, workStart);
  const workSource = app.slice(workStart, ordersStart);
  const ordersSource = app.slice(ordersStart, afterSalesStart);
  const afterSalesSource = app.slice(afterSalesStart, knowledgeStart);

  assert.match(
    rootSource,
    /const consumeAttentionTarget = useCallback\(\(consumedTarget: AttentionTarget\) => \{[\s\S]*current\?\.type === consumedTarget\.type && current\.id === consumedTarget\.id \? null : current/,
  );
  assert.equal(
    (rootSource.match(/onAttentionTargetConsumed=\{consumeAttentionTarget\}/g) || []).length,
    3,
  );

  assert.match(
    workSource,
    /if \(task\) \{\s*setEditingTask\(task\);\s*onAttentionTargetConsumed\(attentionTarget\);\s*\}/,
  );
  assert.match(
    workSource,
    /if \(project\) \{\s*setSelectedProject\(project\);\s*onAttentionTargetConsumed\(attentionTarget\);\s*\}/,
  );
  assert.match(
    workSource,
    /\[attentionTarget, data\.tasks, data\.projects, onAttentionTargetConsumed\]/,
  );
  assert.doesNotMatch(
    workSource.slice(workSource.indexOf("async function saveEdit"), workSource.indexOf("async function saveSnooze")),
    /onAttentionTargetConsumed|setAttentionTarget/,
  );

  assert.match(
    ordersSource,
    /if \(order\) \{\s*openOrder\(order\);\s*onAttentionTargetConsumed\(attentionTarget\);\s*\}/,
  );
  assert.match(
    ordersSource,
    /\[attentionTarget, data\.orders, onAttentionTargetConsumed\]/,
  );

  assert.match(afterSalesSource, /setEditorOpen\(true\);\s*return true;/);
  assert.match(afterSalesSource, /catch \(error\) \{[\s\S]*return false;/);
  assert.match(
    afterSalesSource,
    /const target = attentionTarget;[\s\S]*openEdit\(\{ id: target\.id \}\)\.then\(\(opened\) => \{\s*if \(opened\) onAttentionTargetConsumed\(target\);/,
  );
  assert.match(afterSalesSource, /\[attentionTarget, onAttentionTargetConsumed\]/);
});

test("Gemini is the default server-side provider with centralized model routing", async () => {
  const [runtime, client, essence, health] = await Promise.all([
    source("db/runtime.ts"),
    source("lib/ai-client.ts"),
    source("lib/knowledge-essence.ts"),
    source("app/api/ai/provider/route.ts"),
  ]);
  assert.match(runtime, /DEEPSEEK_API_KEY/);
  assert.match(runtime, /AI_PROVIDER === "deepseek" \? "deepseek" : "gemini"/);
  assert.match(runtime, /DEEPSEEK_DEFAULT_MODEL.*deepseek-v4-flash/);
  assert.match(runtime, /DEEPSEEK_REASONING_MODEL.*deepseek-v4-pro/);
  assert.match(client, /AI_TASK_MODELS/);
  assert.match(client, /knowledge_distillation: "deepseek-v4-pro"/);
  assert.match(client, /knowledge_quality_rewrite: "deepseek-v4-pro"/);
  assert.match(client, /response_format: \{ type: "json_object" \}/);
  assert.match(client, /authorization: `Bearer \$\{env\.deepseek\.apiKey\}`/);
  assert.doesNotMatch(client, /NEXT_PUBLIC_DEEPSEEK_API_KEY/);
  assert.match(client, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
  assert.match(essence, /task: "knowledge_distillation"/);
  assert.match(essence, /task: "knowledge_quality_rewrite"/);
  assert.match(client, /return deepseekReasoning \? env\.gemini\.reasoningModel : env\.gemini\.defaultModel/);
  assert.match(health, /getAiProviderHealth/);
  assert.match(health, /action !== "test_provider"/);
});

test("Gemini default preserves DeepSeek code and protected knowledge backfill behavior", async () => {
  const [runtime, client, route, app] = await Promise.all([
    source("db/runtime.ts"),
    source("lib/ai-client.ts"),
    source("app/api/knowledge/essence-backfill/route.ts"),
    source("app/WorkspaceApp.tsx"),
  ]);
  assert.match(runtime, /AI_FALLBACK_PROVIDER/);
  assert.match(client, /fallbackProvider === "gemini"/);
  assert.match(route, /const knowledgeId = text\(payload\.knowledge_id\)/);
  assert.match(route, /SET essence_summary = \?/);
  assert.doesNotMatch(route, /SET[\s\S]{0,220}essence_points\s*=/);
  assert.match(app, /当前 Provider：Gemini/);
  assert.match(app, /DeepSeek 保留为可选备用能力/);
});

test("legacy knowledge backfill requires one explicit knowledge_id and updates only essence_summary", async () => {
  const route = await source("app/api/knowledge/essence-backfill/route.ts");
  assert.match(route, /const knowledgeId = text\(payload\.knowledge_id\)/);
  assert.match(route, /必须提供明确的 knowledge_id；不会执行批量回填/);
  assert.match(route, /未找到该知识，未调用 AI/);
  assert.match(route, /return response\([\s\S]{0,160}404/);
  assert.match(route, /771238a0-5b03-4e9e-916a-4702f9bd4fdf/);
  assert.match(route, /eda82392-1a24-4027-87b5-883d9210a666/);
  assert.doesNotMatch(route, /for\s*\(const id of legacyKnowledgeIds\)/);
  assert.doesNotMatch(route, /regenerate_current_two/);
  assert.match(route, /editedFields\.includes\("essence_summary"\)/);
  assert.match(route, /overwrite_manual_essence_summary/);
  assert.match(route, /已有 Joyce 手动版本，默认不会覆盖/);
  assert.match(route, /hasExistingSummary && \(!hasManualSummary \|\| !forceManualOverwrite\)/);
  assert.match(route, /if \(!generated\.ok\)/);
  assert.match(route, /status: "generation_failed"/);
  assert.match(
    route,
    /UPDATE knowledge_items\s+SET essence_summary = \?\s+WHERE id = \?/,
  );
  assert.match(route, /trim\(COALESCE\(essence_summary, ''\)\) = ''/);
  assert.doesNotMatch(
    route,
    /UPDATE knowledge_items[\s\S]{0,500}SET[\s\S]{0,300}(title|categories|tags|essence_points|core_principles|actionable_tactics|applicable_scenarios|original_text|human_review_status)\s*=/,
  );
  assert.match(route, /otherFieldsPreserved/);
});

test("knowledge save does not rerun AI or automatically sync Playbook", async () => {
  const route = await source("app/api/knowledge/route.ts");
  const patch = route.slice(
    route.indexOf("export async function PATCH"),
    route.indexOf("export async function DELETE"),
  );
  assert.match(patch, /user_edited_fields/);
  assert.match(patch, /content_modified_at/);
  assert.match(patch, /original_text/);
  assert.doesNotMatch(patch, /Gemini|sales_playbook_items/);
  assert.doesNotMatch(patch, /human_review_status = 'approved'/);
});

test("structured archives share chips, copy fields, local updates and database search", async () => {
  const [app, route, styles] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/api/knowledge/route.ts"),
    source("app/globals.css"),
  ]);
  for (const field of [
    "精华提炼",
    "核心原则",
    "可执行技巧",
    "适用场景",
    "完整原文",
  ]) {
    assert.match(app, new RegExp(field));
  }
  assert.match(app, /navigator\.clipboard[\s\S]*writeText\(value\)/);
  assert.match(app, /<EditableChips[\s\S]*label="分类标签"/);
  assert.match(styles, /\.knowledge-editable-chip/);
  assert.match(styles, /\.archive-chip-row/);
  assert.match(styles, /flex-wrap:\s*wrap/);
  assert.match(route, /title LIKE \?/);
  for (const field of [
    "categories",
    "tags",
    "essence_summary",
    "core_principles",
    "actionable_tactics",
    "applicable_scenarios",
    "original_text",
    "source_name",
  ]) {
    assert.match(route, new RegExp(`${field} LIKE \\?`));
  }
  const knowledgeDetail = app.slice(
    app.indexOf("function KnowledgeDetailModal"),
    app.indexOf("function ContentView"),
  );
  assert.doesNotMatch(knowledgeDetail, /loadWorkspace|onReload/);
  assert.doesNotMatch(app, /复制全部|复制整条/);
});

test("after-sales module is a searchable completed technical case library", async () => {
  const [app, route, normalizer, migration, runtime, workspace, styles] =
    await Promise.all([
      source("app/WorkspaceApp.tsx"),
      source("app/api/after-sales-cases/route.ts"),
      source("lib/after-sales-case.ts"),
      source("drizzle/0009_after_sales_case_library.sql"),
      source("db/runtime.ts"),
      source("app/api/workspace/route.ts"),
      source("app/globals.css"),
    ]);

  assert.match(app, /售后技术案例库/);
  assert.match(app, /After-sales Technical Case Library|AFTER-SALES TECHNICAL CASE LIBRARY/);
  assert.match(app, /新建案例/);
  assert.match(app, /粘贴技术报告/);
  assert.match(app, /AI识别并填入/);
  assert.match(app, /AI仅完成字段识别，尚未保存/);
  assert.match(app, /parseTechnicalCaseArchive\(importText\)/);
  assert.match(app, /确定删除该技术案例吗？删除后无法恢复。/);
  for (const field of [
    "故障现象",
    "排查过程",
    "确认原因",
    "解决及复用方法",
  ]) {
    assert.match(app, new RegExp(`"${field}"`));
  }
  assert.match(app, /<strong>完整技术报告<\/strong>/);
  assert.match(app, /copyCaseField\(String\(draft\[field/);
  assert.match(app, /technical-case-model-suggestions/);
  assert.match(app, /case-list[\s\S]*highlighted\(matchingSnippet\(item\)\)/);
  const afterSalesView = app.slice(
    app.indexOf("function AfterSalesView"),
    app.indexOf("function KnowledgeView"),
  );
  const ordersView = app.slice(
    app.indexOf("function OrdersView"),
    app.indexOf("function AfterSalesView"),
  );
  assert.doesNotMatch(afterSalesView, /data\.afterSales|accessory-sales-panel/);
  assert.match(ordersView, /accessory-sales-panel[\s\S]*saveAccessorySales/);
  assert.match(afterSalesView, /after-sales-cases\?id=/);
  assert.match(afterSalesView, /parseTags\(item\.tags\)\.slice\(0, 3\)/);
  assert.match(afterSalesView, /pagination\.pageSize/);
  assert.doesNotMatch(
    afterSalesView,
    /loadWorkspace|onReload|onCapture/,
  );

  assert.match(route, /payload\.action === "extract"/);
  assert.match(route, /task: "default"/);
  assert.match(route, /唯一任务是把用户已经整理好的技术报告内容原样分配到对应字段/);
  assert.match(route, /不得重新诊断、总结、改写、删减、补充、推断或优化/);
  assert.match(route, /怀疑、推测、可能、待验证的原因不得写入 confirmed_cause/);
  assert.match(route, /saved: false/);
  assert.match(route, /case_title LIKE \?/);
  assert.match(route, /SELECT \$\{detailFields\} FROM after_sales_cases WHERE id = \?/);
  assert.match(route, /fault_symptoms_summary/);
  assert.match(route, /confirmed_cause_summary/);
  assert.match(route, /match_snippet/);
  assert.match(route, /Math\.min\(50, Math\.max\(30, requestedPageSize\)\)/);
  assert.match(route, /LIMIT \? OFFSET \?/);
  const listHandler = route.slice(
    route.indexOf("export async function GET"),
    route.indexOf("export async function POST"),
  );
  assert.doesNotMatch(listHandler, /requestJson|task:\s*"default"/);
  for (const field of [
    "customer_code",
    "vehicle_model",
    "order_no",
    "vin",
    "tags",
    "issue_description",
    "troubleshooting_process",
    "confirmed_cause",
    "reuse_solution",
    "full_technical_report",
  ]) {
    assert.match(route, new RegExp(`${field} LIKE \\?`));
  }
  const extractBranch = route.slice(
    route.indexOf('payload.action === "extract"'),
    route.indexOf("const input = normalizePayload", route.indexOf('payload.action === "extract"')),
  );
  assert.doesNotMatch(extractBranch, /INSERT INTO after_sales_cases|UPDATE after_sales_cases/);
  assert.match(normalizer, /row\.cause_confirmed === true/);
  assert.match(normalizer, /genericTags/);
  assert.match(normalizer, /fullTechnicalReport: fullReport\.trim\(\)/);

  assert.match(migration, /backup_v22_after_sales_case_library_20260729/);
  assert.match(migration, /ADD COLUMN `case_title` text/);
  assert.match(migration, /ADD COLUMN `full_technical_report` text/);
  assert.match(migration, /历史诊断或判断（未自动视为确认原因）/);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|DELETE FROM/);
  assert.match(runtime, /afterSalesCaseLibraryBackupStatements/);
  assert.match(runtime, /afterSalesCaseLibraryColumns/);
  assert.doesNotMatch(
    workspace.slice(workspace.indexOf("const attention"), workspace.indexOf("const normalizedTasks")),
    /FROM after_sales_cases/,
  );
  assert.doesNotMatch(workspace, /SELECT \* FROM after_sales_cases|\bafterSales\b/);
  assert.match(styles, /\.technical-case-card/);
  assert.match(styles, /\.case-library-filters/);
  assert.match(styles, /\.archive-chip/);
  assert.match(app, /<EditableChips[\s\S]*label="标签"/);
});

test("after-sales list has explicit load states, workspace-lifetime cache, and a light read path", async () => {
  const [app, route, styles] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/api/after-sales-cases/route.ts"),
    source("app/globals.css"),
  ]);
  const afterSalesView = app.slice(
    app.indexOf("function AfterSalesView"),
    app.indexOf("function KnowledgeView"),
  );
  const listHandler = route.slice(
    route.indexOf("export async function GET"),
    route.indexOf("export async function POST"),
  );

  assert.match(app, /useState<AfterSalesListCache>\(emptyAfterSalesListCache\)/);
  assert.match(app, /listCache=\{afterSalesListCache\}/);
  assert.match(afterSalesView, /const \[initialLoading, setInitialLoading\]/);
  assert.match(afterSalesView, /const \[refreshing, setRefreshing\]/);
  assert.match(afterSalesView, /const \[loadError, setLoadError\]/);
  assert.match(afterSalesView, /正在加载售后技术案例…/);
  assert.match(afterSalesView, /案例加载失败，请重试/);
  assert.match(afterSalesView, /重新加载/);
  assert.match(afterSalesView, /listLoaded \? <section className="case-list">/);
  assert.match(afterSalesView, /title=\{filterActive \? "没有匹配案例" : "暂无技术案例"\}/);
  assert.match(afterSalesView, /更新失败，当前显示上一次加载的数据。/);
  assert.match(afterSalesView, /filterActive \? 220 : 0/);
  assert.match(afterSalesView, /const \[searchResult, setSearchResult\]/);
  assert.match(afterSalesView, /onListCacheChange\(\(current\) =>/);
  assert.doesNotMatch(afterSalesView, /setCases\(\[\]\)|loadWorkspace/);

  assert.doesNotMatch(listHandler, /ensureWorkspace\(/);
  assert.match(listHandler, /await db\.batch\(\[/);
  assert.match(listHandler, /server-timing/);
  assert.match(listHandler, /SELECT \$\{listFields\}/);
  assert.doesNotMatch(
    route.slice(route.indexOf("const listFields"), route.indexOf("const searchableFields")),
    /troubleshooting_process|reuse_solution|full_technical_report/,
  );
  assert.match(styles, /\.case-library-load-state/);
  assert.match(styles, /\.case-library-refreshing/);
});

test("technical case extraction keeps missing facts empty and filters generic tags", async () => {
  const normalizer = await source("lib/after-sales-case.ts");
  const route = await source("app/api/after-sales-cases/route.ts");

  assert.match(normalizer, /faultDate: \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
  assert.match(normalizer, /confirmedCause:[\s\S]*row\.cause_confirmed === true/);
  assert.match(normalizer, /"车辆故障"/);
  assert.match(normalizer, /\.slice\(0, 8\)/);
  assert.match(route, /order_no": ""/);
  assert.match(route, /vin": ""/);
  assert.match(route, /fault_date": "YYYY-MM-DD或空字符串"/);
});

test("order shipping reminders are method-aware and accessory sales stay statistical", async () => {
  const migration = await source("drizzle/0010_order_shipping_accessory_sales.sql");
  const riskLogic = await source("lib/order-risk.ts");
  const orderRoute = await source("app/api/orders/route.ts");
  const homeBootstrap = await source("lib/home-bootstrap.ts");
  const workspace = await source("app/WorkspaceApp.tsx");

  assert.match(migration, /backup_v40_orders_shipping_20260731/);
  assert.match(migration, /shipping_method TEXT/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS accessory_sales_totals/);
  assert.match(riskLogic, /shippingMethod === "sea_freight"/);
  assert.match(riskLogic, /shippingMethod === "express"/);
  assert.match(riskLogic, /shippingMethod === "domestic"/);
  assert.match(riskLogic, /运输订单缺少BL号/);
  assert.match(riskLogic, /运输中快递订单缺少追踪号/);
  assert.match(riskLogic, /运输中订单缺少物流单号/);
  assert.match(orderRoute, /action === "acknowledge_risk"/);
  assert.match(orderRoute, /status = 'acknowledged'/);
  assert.match(orderRoute, /action === "save_accessory_sales"/);
  assert.match(homeBootstrap, /currentYearVehicleSales/);
  assert.match(homeBootstrap, /currentYearAccessorySales/);
  assert.match(workspace, /Sea Freight 海运/);
  assert.match(workspace, /Air Freight 空运/);
  assert.match(workspace, /Tracking No\./);
  assert.match(workspace, /年度合计/);
  assert.match(workspace, /onOrderSaved\(result\)/);
});

test("Projects separate read-only details from editable local updates", async () => {
  const app = await source("app/WorkspaceApp.tsx");
  const route = await source("app/api/projects/route.ts");
  const workView = app.slice(
    app.indexOf("function WorkView"),
    app.indexOf("const reportScopeOptions"),
  );
  const customerView = app.slice(
    app.indexOf("function CustomerDetail"),
    app.indexOf("function LeadsView"),
  );
  const afterSalesView = app.slice(
    app.indexOf("function AfterSalesView"),
    app.indexOf("function KnowledgeView"),
  );

  assert.match(workView, /const \[selectedProject, setSelectedProject\]/);
  assert.match(workView, /const \[editingProject, setEditingProject\]/);
  assert.match(workView, /setEditingProject\(project\)/);
  assert.match(workView, /<ProjectEditModal/);
  assert.match(workView, /onSave=\{saveProjectEdit\}/);
  assert.doesNotMatch(customerView, /editingProject|saveProjectEdit|ProjectEditModal/);
  assert.doesNotMatch(afterSalesView, /editingProject|saveProjectEdit|ProjectEditModal/);
  assert.match(app, /function ProjectEditModal/);
  assert.match(app, /name="title"/);
  assert.match(app, /name="status"/);
  assert.match(app, /name="nextStep"/);
  assert.match(app, /name="notes"/);
  assert.match(app, /保存修改/);
  const updater = app.slice(
    app.indexOf("async function updateProject"),
    app.indexOf("function applyOrderUpdate"),
  );
  assert.match(updater, /projects: current\.projects\.map/);
  assert.doesNotMatch(updater, /loadWorkspace/);
  assert.match(route, /UPDATE projects/);
  assert.match(route, /project_updated/);
  assert.match(route, /SELECT \* FROM projects WHERE id = \? LIMIT 1/);
  assert.doesNotMatch(route, /Gemini|generateAi|AI_PROVIDER/);
});

test("Product Brain application features are removed without deleting historical storage", async () => {
  const [
    app,
    styles,
    workspace,
    aiProvider,
    aiClient,
    documents,
    schema,
    runtime,
    migration,
    legacyImporter,
  ] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/globals.css"),
    source("app/api/workspace/route.ts"),
    source("lib/ai-provider.ts"),
    source("lib/ai-client.ts"),
    source("app/api/documents/route.ts"),
    source("db/schema.ts"),
    source("db/runtime.ts"),
    source("drizzle/0000_cloudy_norman_osborn.sql"),
    source("app/api/import-v1/route.ts"),
  ]);

  assert.doesNotMatch(
    app,
    /function ProductsView|PRODUCT BRAIN|Ask Products|ask-products|上传产品资料|产品知识资料/,
  );
  assert.doesNotMatch(app, /id: "products"|view === "products"|\| "products"/);
  assert.doesNotMatch(
    styles,
    /\.ask-products|\.grounded-answer|\.source-citations|\.source-list/,
  );
  assert.doesNotMatch(workspace, /FROM products/);
  assert.match(
    workspace,
    /FROM source_documents[\s\S]*WHERE document_type = 'sales_playbook_source'/,
  );
  assert.doesNotMatch(aiProvider, /generateGroundedProductAnswer|product_answer/);
  assert.doesNotMatch(aiClient, /product_answer/);
  assert.doesNotMatch(
    legacyImporter,
    /moduleId === "products"|INSERT OR IGNORE INTO products/,
  );
  await assert.rejects(source("app/api/ask-products/route.ts"), /ENOENT/);

  assert.match(documents, /source_documents/);
  assert.match(documents, /document_chunks/);
  assert.match(schema, /export const products = sqliteTable\("products"/);
  assert.match(schema, /export const sourceDocuments = sqliteTable\("source_documents"/);
  assert.match(runtime, /CREATE TABLE IF NOT EXISTS products/);
  assert.match(migration, /CREATE TABLE `products`/);
  assert.match(app, /Source Library/);
  assert.match(app, /售后技术案例库/);
});
