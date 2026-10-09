import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createWorkspaceBootstrapRequest,
  WorkspaceBootstrapTimeoutError,
} from "../lib/workspace-bootstrap.ts";

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
  await assert.rejects(cancelled.promise, /cancelled/);
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
});
