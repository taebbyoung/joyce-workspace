import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  beginAsyncDataLoad,
  createAsyncDataState,
  rejectAsyncData,
  resolveAsyncData,
} from "../app/async-data-state.ts";

test("initial request distinguishes loading, success, empty, and failure", () => {
  const empty = createAsyncDataState();
  const loading = beginAsyncDataLoad(empty);
  assert.deepEqual(loading, {
    data: null,
    hasLoaded: false,
    isInitialLoading: true,
    isRefreshing: false,
    error: null,
  });

  const loadedEmpty = resolveAsyncData([]);
  assert.equal(loadedEmpty.hasLoaded, true);
  assert.deepEqual(loadedEmpty.data, []);
  assert.equal(loadedEmpty.isInitialLoading, false);

  const failed = rejectAsyncData(loading, "加载失败，请重试");
  assert.equal(failed.hasLoaded, false);
  assert.equal(failed.data, null);
  assert.equal(failed.error, "加载失败，请重试");
});

test("cached data stays visible throughout refresh failures", () => {
  const cached = resolveAsyncData([{ id: "task-1" }]);
  const refreshing = beginAsyncDataLoad(cached);
  assert.equal(refreshing.isInitialLoading, false);
  assert.equal(refreshing.isRefreshing, true);
  assert.deepEqual(refreshing.data, [{ id: "task-1" }]);

  const failed = rejectAsyncData(refreshing, "刷新失败");
  assert.equal(failed.hasLoaded, true);
  assert.equal(failed.isRefreshing, false);
  assert.deepEqual(failed.data, [{ id: "task-1" }]);
  assert.equal(failed.error, "刷新失败");
});

test("Workspace keeps completed Work history in a session cache with explicit states", async () => {
  const root = new URL("../", import.meta.url);
  const [app, runtime] = await Promise.all([
    readFile(new URL("app/WorkspaceApp.tsx", root), "utf8"),
    readFile(new URL("db/runtime.ts", root), "utf8"),
  ]);
  const workStart = app.indexOf("function WorkView(");
  const reportsStart = app.indexOf("function ReportsView(", workStart);
  const workSource = app.slice(workStart, reportsStart);

  assert.match(app, /useState<\s*AsyncDataState<CompletedTasksCache>/);
  assert.match(workSource, /正在加载已完成内容/);
  assert.match(workSource, /暂无已完成内容/);
  assert.match(workSource, /更新失败，当前显示上次已完成内容/);
  assert.match(workSource, /beginAsyncDataLoad\(current\)/);
  assert.match(workSource, /rejectAsyncData\(current, message\)/);
  assert.doesNotMatch(workSource, /setCompletedTasks\(\[\]\)/);
  assert.match(runtime, /let workspaceEnsurePromise: Promise<void> \| null = null/);
  assert.match(runtime, /ensureWorkspaceSchema\(\)/);
  assert.doesNotMatch(runtime, /legacy-v1\.json|legacyV1|legacy_v1_seed_version/);
  assert.match(runtime, /schemaStatements\.map/);
});

test("manual V1 import remains payload-based after embedded seed retirement", async () => {
  const root = new URL("../", import.meta.url);
  const route = await readFile(new URL("app/api/import-v1/route.ts", root), "utf8");

  assert.match(route, /await ensureWorkspace\(\)/);
  assert.match(route, /const state = payload\.state \?\? \{\}/);
  assert.doesNotMatch(route, /legacy-v1\.json|legacyV1/);
});
