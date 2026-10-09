import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createWorkspaceBootstrapRequest,
  WORKSPACE_BOOTSTRAP_TIMEOUT_MS,
  WorkspaceBootstrapTimeoutError,
} from "../lib/workspace-bootstrap.ts";
import { beginAsyncDataLoad, createAsyncDataState, rejectAsyncData } from "../app/async-data-state.ts";

function response(body, ok = true) {
  return {
    ok,
    json: async () => body,
  };
}

test("workspace bootstrap resolves successful responses and surfaces API failures", async () => {
  const successful = createWorkspaceBootstrapRequest(
    "/api/workspace",
    async () => response({ customers: [] }),
    50,
  );
  assert.deepEqual(await successful.promise, { customers: [] });

  const failed = createWorkspaceBootstrapRequest(
    "/api/workspace",
    async () => response({ error: "服务异常" }, false),
    50,
  );
  await assert.rejects(failed.promise, /服务异常/);
});

test("workspace bootstrap aborts a timed out request and reports a distinct timeout", async () => {
  let requestSignal;
  const timedOut = createWorkspaceBootstrapRequest(
    "/api/workspace",
    (_url, init) =>
      new Promise((_resolve, reject) => {
        requestSignal = init.signal;
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
    5,
  );

  await assert.rejects(timedOut.promise, WorkspaceBootstrapTimeoutError);
  assert.equal(requestSignal.aborted, true);
});

test("startup timeout is 20 seconds and settles even when fetch ignores abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  assert.equal(WORKSPACE_BOOTSTRAP_TIMEOUT_MS, 20_000);
  const request = createWorkspaceBootstrapRequest(
    "/api/home",
    () => new Promise(() => {}),
  );
  let outcome = "pending";
  request.promise.then(
    () => { outcome = "resolved"; },
    () => { outcome = "rejected"; },
  );
  t.mock.timers.tick(19_900);
  await Promise.resolve();
  assert.equal(outcome, "pending");
  assert.equal(request.signal.aborted, false);
  t.mock.timers.tick(100);
  await assert.rejects(request.promise, WorkspaceBootstrapTimeoutError);
  assert.equal(request.signal.aborted, true);
  assert.equal(outcome, "rejected");

  const loading = beginAsyncDataLoad(createAsyncDataState());
  const failed = rejectAsyncData(loading, "网络连接较慢，或服务暂时未响应。请重试。");
  assert.equal(failed.isInitialLoading, false);
  assert.match(failed.error, /请重试/);
  const retry = createWorkspaceBootstrapRequest("/api/home", async () => response({ ok: true }));
  assert.deepEqual(await retry.promise, { ok: true });
  t.mock.timers.reset();
});

test("manual abort settles without waiting for a fetch implementation that ignores abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const request = createWorkspaceBootstrapRequest(
    "/api/home",
    () => new Promise(() => {}),
  );
  request.abort();
  await assert.rejects(request.promise, { name: "AbortError" });
  t.mock.timers.tick(20_000);
  assert.equal(request.signal.aborted, true);
  t.mock.timers.reset();
});

test("manual cancellation remains distinct from a timeout", async () => {
  const cancelled = createWorkspaceBootstrapRequest(
    "/api/workspace",
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("cancelled")));
      }),
    50,
  );
  cancelled.abort();
  await assert.rejects(cancelled.promise, { name: "AbortError" });
});

test("WorkspaceApp replaces active bootstrap requests and guards against stale results", async () => {
  const root = new URL("../", import.meta.url);
  const app = await readFile(new URL("app/WorkspaceApp.tsx", root), "utf8");

  assert.match(app, /workspaceBootstrapRequestRef\.current\?\.request\.abort\(\)/);
  assert.match(app, /const requestId = \+\+workspaceBootstrapRequestIdRef\.current/);
  assert.match(app, /requestId !== workspaceBootstrapRequestIdRef\.current/);
  assert.match(app, /workspaceBootstrapRequestRef\.current\?\.request\.abort\(\)/);
  assert.match(app, /工作台加载超时/);
  assert.match(app, /网络连接较慢，或服务暂时未响应。请重试。/);
  assert.match(app, /isValidHomeBootstrapResponse\(result\)/);
  assert.match(app, /暂时无法打开工作区/);
});
