import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("task completion waits for the server while other single-task writes stay local", async () => {
  const app = await source("app/WorkspaceApp.tsx");
  const updateStart = app.indexOf("async function updateTask(");
  const updateEnd = app.indexOf("async function reorderWork", updateStart);
  const updateSource = app.slice(updateStart, updateEnd);

  assert.match(app, /const TASK_WRITE_TIMEOUT_MS = 9_000/);
  assert.match(app, /const TASK_WRITE_SLOW_MS = 2_500/);
  assert.match(app, /new AbortController\(\)/);
  assert.match(app, /signal: controller\.signal/);
  assert.match(app, /taskPatchForLocalState/);
  assert.match(app, /patch\.status = "snoozed"/);
  assert.match(app, /function taskCompletionFailureMessage/);
  assert.match(updateSource, /postWorkMutation\("\/api\/tasks", \{[\s\S]*action,[\s\S]*id,[\s\S]*\.\.\.fields,[\s\S]*businessDate: currentBusinessDate/);
  assert.match(updateSource, /const isCompletion = action === "status" && fields\.status === "completed"/);
  assert.match(updateSource, /if \(optimisticTask && !isCompletion\)/);
  assert.match(updateSource, /taskCompletionFailureMessage\(previousTask, error\)/);
  assert.doesNotMatch(updateSource, /loadWorkspace/);
  assert.match(updateSource, /task: result\.task,[\s\S]*nextTask: result\.nextTask/);
});

test("Home Today reuses confirmed Work completion and keeps task-specific failure feedback", async () => {
  const app = await source("app/WorkspaceApp.tsx");
  const homeStart = app.indexOf("function HomeView(");
  const workStart = app.indexOf("function WorkView(", homeStart);
  const home = app.slice(homeStart, workStart);
  const homeMountStart = app.indexOf("{view === \"home\" && (");
  const homeMountEnd = app.indexOf("{view === \"work\" && (", homeMountStart);
  const homeMount = app.slice(homeMountStart, homeMountEnd);

  assert.match(app, /async function completeHomeTodayTask\(id: string\)/);
  assert.match(app, /updateTask\(id, "status", \{ status: "completed" \}\)/);
  assert.match(homeMount, /onTaskComplete=\{completeHomeTodayTask\}/);
  assert.match(homeMount, /onOpenTask=\{openTaskFromHome\}/);
  assert.match(home, /aria-label=\{`完成任务：\$\{task\.title\}`\}/);
  assert.match(home, /onChange=\{\(\) => void completeTodayTask\(task\)\}/);
  assert.match(home, /onClick=\{\(\) => onOpenTask\(task\)\}/);
  assert.match(home, /todayCompletionErrors/);
  assert.match(home, /正在完成…/);
  assert.match(home, /todayCompletionErrors\[String\(task\.id\)\]/);
  assert.match(home, /setCompletingTodayTasks/);
  assert.doesNotMatch(home, /loadWorkspace/);
});

test("Work edit and snooze keep a retryable form while exposing saving and slow states", async () => {
  const app = await source("app/WorkspaceApp.tsx");
  const workStart = app.indexOf("function WorkView(");
  const workEnd = app.indexOf("function ProjectEditModal(", workStart);
  const work = app.slice(workStart, workEnd);

  assert.match(work, /setSnoozeReminderDate\(taskDate\(task\)\)/);
  assert.match(work, /value=\{snoozeReminderDate\}/);
  assert.match(work, /disabled=\{busyTaskId === String\(snoozingTask\?\.id\)\}/);
  assert.match(work, /仍在更新提醒时间…/);
  assert.match(work, /仍在保存…/);
  assert.match(work, /taskWriteError/);
  assert.match(work, /if \(busyTaskId === id\) return false/);
  assert.match(work, /onClose=\{closeTaskEditor\}/);
  assert.match(work, /onClose=\{closeSnooze\}/);
});

test("task API batches each update with its audit record and returns a server-timed task", async () => {
  const route = await source("app/api/tasks/route.ts");
  const updateStart = route.indexOf('if (action === "update")');
  const archiveStart = route.indexOf('if (action === "archive")', updateStart);
  const update = route.slice(updateStart, archiveStart);
  const statusStart = route.indexOf('if (action === "status")');
  const status = route.slice(statusStart);

  assert.match(route, /function taskResponse\(/);
  assert.match(route, /"server-timing"/);
  assert.match(update, /await db\.batch\(\[/);
  assert.match(update, /task_updated/);
  assert.doesNotMatch(update, /SELECT \* FROM tasks WHERE id = \? LIMIT 1/);
  assert.match(status, /status === "snoozed" \? reminderDate : existing\.reminder_date/);
  assert.match(status, /taskResponse\(/);
  assert.doesNotMatch(status, /SELECT \* FROM tasks WHERE id = \? LIMIT 1/);
  assert.doesNotMatch(route, /requestAi|requestJson|Gemini/);
});

test("Work completion updates an existing completed-task cache without a blocking read", async () => {
  const app = await source("app/WorkspaceApp.tsx");
  const workStart = app.indexOf("function WorkView(");
  const actStart = app.indexOf("async function act(", workStart);
  const actEnd = app.indexOf("async function saveEdit", actStart);
  const act = app.slice(actStart, actEnd);

  assert.match(act, /onCompletedTasksStateChange/);
  assert.match(act, /tasks: \[\s*result\.task,/);
  assert.match(act, /setTaskCompletionErrors/);
  assert.match(app, /“\$\{title\}”未完成：保存超时，请重试/);
  assert.doesNotMatch(act, /await loadCompletedTasks/);
});

test("Work shows completion pending and retryable task-specific errors in the active row", async () => {
  const app = await source("app/WorkspaceApp.tsx");
  const workStart = app.indexOf("function WorkView(");
  const workEnd = app.indexOf("function ProjectEditModal(", workStart);
  const work = app.slice(workStart, workEnd);
  const css = await source("app/globals.css");

  assert.match(work, /const completing = busyTaskId === String\(task\.id\)/);
  assert.match(work, /正在完成…/);
  assert.match(work, /task-completion-pending/);
  assert.match(work, /task-completion-error/);
  assert.match(css, /\.task-completion-pending,[\s\S]*font-size: var\(--font-meta\)/);
});

test("project writes share timeout-aware requests and avoid post-update reads", async () => {
  const [app, route] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/api/projects/route.ts"),
  ]);
  const updateStart = app.indexOf("async function updateProject(");
  const nextStart = app.indexOf("function applyOrderUpdate", updateStart);
  const update = app.slice(updateStart, nextStart);

  assert.match(update, /postWorkMutation\("\/api\/projects"/);
  assert.match(app, /async function actProject/);
  assert.match(app, /slowProjectId/);
  assert.match(route, /function projectResponse\(/);
  assert.match(route, /"server-timing"/);
  assert.doesNotMatch(route, /const project = await db\.prepare\("SELECT \* FROM projects WHERE id = \? LIMIT 1"/);
});

test("Work creation keeps its form retryable and updates task or project state locally", async () => {
  const [app, workspaceRoute] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/api/workspace/route.ts"),
  ]);
  const submitStart = app.indexOf("async function submitRecord(");
  const submitEnd = app.indexOf("const headerTitle", submitStart);
  const submit = app.slice(submitStart, submitEnd);

  assert.match(submit, /setRecordBusy\(true\)/);
  assert.match(submit, /setRecordError\(message\)/);
  assert.match(submit, /recordModal === "project" && result\.record/);
  assert.match(submit, /projects: \[result\.record, \.\.\.current\.projects\]/);
  assert.match(submit, /updateTaskCollections\(current, optimisticId, result\.record, currentBusinessDate\)/);
  assert.match(app, /busy=\{recordBusy\}/);
  assert.match(app, /disabled=\{busy\}/);
  assert.match(workspaceRoute, /function workspacePostResponse\(/);
  assert.match(workspaceRoute, /"server-timing"/);
});

test("Work Overview next-step links use a one-time task editor focus intent", async () => {
  const app = await source("app/WorkspaceApp.tsx");
  const workStart = app.indexOf("function WorkView(");
  const workEnd = app.indexOf("function ProjectEditModal(", workStart);
  const work = app.slice(workStart, workEnd);

  assert.match(work, /taskEditorFocusField/);
  assert.match(work, /taskNextStepRef/);
  assert.match(work, /openTaskEditor\(task, \{ focusField: "nextStep" \}\)/);
  assert.match(work, /field\.scrollIntoView\(\{ block: "center", inline: "nearest" \}\)/);
  assert.match(work, /field\.setSelectionRange\(cursor, cursor\)/);
  assert.match(work, /setTaskEditorFocusField\(null\)/);
  assert.match(work, /ref=\{taskNextStepRef\}/);
  assert.doesNotMatch(work, /setTimeout\([^\n]*nextStep/);
});

test("WorkView always receives its completed-task cache props", async () => {
  const app = await source("app/WorkspaceApp.tsx");
  const workViewStart = app.indexOf('{data && view === "work" && (');
  const workViewEnd = app.indexOf("{view === \"customers\"", workViewStart);
  const workView = app.slice(workViewStart, workViewEnd);
  const ordersViewStart = app.indexOf("{view === \"orders\" && (");
  const ordersViewEnd = app.indexOf("{view === \"after-sales\"", ordersViewStart);
  const ordersView = app.slice(ordersViewStart, ordersViewEnd);

  assert.match(workView, /completedTasksState=\{completedTasksState\}/);
  assert.match(workView, /onCompletedTasksStateChange=\{setCompletedTasksState\}/);
  assert.doesNotMatch(ordersView, /completedTasksState=/);
});

test("Projects overview only references the project being rendered", async () => {
  const app = await source("app/WorkspaceApp.tsx");
  const projectsStart = app.indexOf("activeProjects.map((project) =>");
  const projectsEnd = app.indexOf("</aside>", projectsStart);
  const projectsOverview = app.slice(projectsStart, projectsEnd);

  assert.ok(projectsStart >= 0, "Projects overview map should exist");
  assert.doesNotMatch(projectsOverview, /\btask\.id\b/);
  assert.match(projectsOverview, /busyProjectId === String\(project\.id\)/);
});
