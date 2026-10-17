import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  addBusinessDateDays,
  formatTimestampInTimezone,
  getBusinessDate,
  getNextMidnightDelay,
  getRequestWorkspaceTime,
  resolveWorkspaceTimezone,
  workspaceTimeUrl,
} from "../lib/workspace-time.ts";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("one instant resolves to the correct business date in each IANA timezone", () => {
  const instant = new Date("2026-10-17T20:00:00.000Z");
  assert.equal(getBusinessDate(instant, "Asia/Shanghai"), "2026-10-18");
  assert.equal(getBusinessDate(instant, "America/Los_Angeles"), "2026-10-17");
  assert.equal(addBusinessDateDays("2026-10-17", 1), "2026-10-18");
});

test("manual timezone overrides the device timezone and auto follows it", () => {
  assert.equal(
    resolveWorkspaceTimezone({ mode: "auto", timezone: null }, "Europe/Rome"),
    "Europe/Rome",
  );
  assert.equal(
    resolveWorkspaceTimezone({ mode: "manual", timezone: "Asia/Tokyo" }, "Europe/Rome"),
    "Asia/Tokyo",
  );
});

test("next-midnight timer follows DST day length rather than assuming 24 hours", () => {
  const springDelay = getNextMidnightDelay(
    new Date("2026-03-28T23:30:00.000Z"),
    "Europe/Rome",
    0,
  );
  const fallDelay = getNextMidnightDelay(
    new Date("2026-10-24T22:30:00.000Z"),
    "Europe/Rome",
    0,
  );
  assert.ok(Math.abs(springDelay - 22.5 * 60 * 60 * 1000) < 1_500);
  assert.ok(Math.abs(fallDelay - 24.5 * 60 * 60 * 1000) < 1_500);
});

test("business date and timezone are propagated together to server APIs", () => {
  const url = workspaceTimeUrl("/api/home", "2026-10-18", "Asia/Shanghai");
  assert.equal(url, "/api/home?businessDate=2026-10-18&timezone=Asia%2FShanghai");
  const request = new Request(`https://workspace.test${url}`);
  assert.deepEqual(getRequestWorkspaceTime(request), {
    businessDate: "2026-10-18",
    timezone: "Asia/Shanghai",
  });
});

test("timestamps display in workspace timezone while date-only values stay unchanged", () => {
  const value = "2026-10-17T20:00:00.000Z";
  assert.notEqual(
    formatTimestampInTimezone(value, "Asia/Shanghai", {
      hour: "2-digit", minute: "2-digit", hour12: false,
    }),
    formatTimestampInTimezone(value, "Europe/Rome", {
      hour: "2-digit", minute: "2-digit", hour12: false,
    }),
  );
  assert.equal(addBusinessDateDays("2026-10-17", 0), "2026-10-17");
});

test("global clock rechecks after sleep or tab return without polling or reload", async () => {
  const provider = await source("app/workspace-time.tsx");
  assert.match(provider, /getNextMidnightDelay/);
  assert.match(provider, /window\.setTimeout/);
  assert.match(provider, /visibilitychange/);
  assert.match(provider, /window\.addEventListener\("focus"/);
  assert.match(provider, /setCheckRevision/);
  assert.doesNotMatch(provider, /setInterval|location\.reload|window\.location/);
});

test("timezone preference persists in D1 and date-sensitive APIs use request business time", async () => {
  const [settings, home, workspace, leads, app] = await Promise.all([
    source("app/api/settings/timezone/route.ts"),
    source("app/api/home/route.ts"),
    source("app/api/workspace/route.ts"),
    source("app/api/leads/route.ts"),
    source("app/WorkspaceApp.tsx"),
  ]);
  assert.match(settings, /workspace_timezone_preference/);
  assert.match(settings, /INSERT INTO settings/);
  assert.match(home, /getRequestWorkspaceTime\(request\)/);
  assert.match(workspace, /getRequestWorkspaceTime\(request\)/);
  assert.match(leads, /getRequestWorkspaceTime\(request\)/);
  assert.match(app, /workspaceTimeUrl\("\/api\/home"/);
  assert.match(app, /workspaceTimeUrl\("\/api\/workspace"/);
  assert.match(app, /failedBackgroundRefreshDateRef/);
  assert.match(app, /今日数据刷新失败，将在下次回到页面时重试/);
  assert.doesNotMatch(app, /location\.reload|window\.location\.reload/);
});
