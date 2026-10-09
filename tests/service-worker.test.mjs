import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const origin = "https://workspace.example";

function serviceWorkerHarness() {
  const handlers = new Map();
  const stores = new Map();
  const calls = { claimed: false, skipped: false };
  let networkFails = false;
  const key = (request) => typeof request === "string"
    ? request
    : new URL(request.url).pathname;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async addAll(paths) {
          for (const path of paths) entries.set(path, { kind: "cached", path });
        },
        async put(request, response) { entries.set(key(request), response); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(request) {
      for (const entries of stores.values()) {
        if (entries.has(key(request))) return entries.get(key(request));
      }
      return undefined;
    },
  };
  const self = {
    location: { origin },
    addEventListener(name, handler) { handlers.set(name, handler); },
    skipWaiting() { calls.skipped = true; },
    clients: { async claim() { calls.claimed = true; } },
  };
  runInNewContext(source, {
    self, caches, URL,
    fetch: async () => {
      if (networkFails) throw new Error("offline");
      return { ok: true, kind: "network", clone() { return { kind: "cached-network" }; } };
    },
  });
  async function lifecycle(name) {
    let pending;
    handlers.get(name)({ waitUntil(value) { pending = value; } });
    await pending;
  }
  async function request(path, destination, mode = "no-cors") {
    let pending;
    handlers.get("fetch")({
      request: { method: "GET", url: origin + path, destination, mode },
      respondWith(value) { pending = value; },
    });
    return pending;
  }
  return {
    caches, calls, lifecycle, request, stores,
    setOffline(value) { networkFails = value; },
  };
}

test("fresh service worker caches its shell but never returns HTML for failed JS or CSS", async () => {
  const sw = serviceWorkerHarness();
  await sw.lifecycle("install");
  await sw.lifecycle("activate");
  assert.equal(sw.calls.skipped, true);
  assert.equal(sw.calls.claimed, true);
  assert.deepEqual(await sw.caches.keys(), ["joyce-workspace-shell-v3"]);
  assert.equal((await sw.request("/", "document", "navigate")).kind, "network");

  sw.setOffline(true);
  await assert.rejects(sw.request("/assets/app.js", "script"), /offline/);
  await assert.rejects(sw.request("/assets/app.css", "style"), /offline/);
  assert.equal((await sw.request("/", "document", "navigate")).kind, "cached-network");
  assert.equal(await sw.request("/api/home", "", "cors"), undefined);
});

test("upgrade removes only old Workspace caches and keeps unrelated caches", async () => {
  const sw = serviceWorkerHarness();
  const old = await sw.caches.open("joyce-workspace-shell-v2");
  await old.addAll(["/", "/assets/old.js"]);
  await sw.caches.open("unrelated-plugin-cache");
  await sw.lifecycle("install");
  await sw.lifecycle("activate");
  assert.deepEqual(
    (await sw.caches.keys()).sort(),
    ["joyce-workspace-shell-v3", "unrelated-plugin-cache"].sort(),
  );
  assert.equal(await sw.caches.match("/assets/old.js"), undefined);
  sw.setOffline(true);
  await assert.rejects(sw.request("/assets/old.js", "script"), /offline/);
});
