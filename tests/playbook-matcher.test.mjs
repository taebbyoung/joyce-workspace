import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  matchPlaybook,
  normalizePlaybookRows,
  PLAYBOOK_PROMPT_GUARDRAIL,
} from "../lib/playbook-matcher.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("normalizes one principle per current row and expands legacy rows", () => {
  const rows = normalizePlaybookRows([
    { id: "new", summary: "进入关键决策层", principles: '["ignored"]', applicable_scenarios: '["高层拜访"]' },
    { id: "legacy", summary: "", principles: '["先确认事实","再推进沟通"]', applicable_scenarios: "客诉,客户跟进" },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].principle, "进入关键决策层");
  assert.deepEqual(rows[0].scenarios, ["高层拜访"]);
});

test("local matcher returns only relevant rules and never more than three", () => {
  const candidates = Array.from({ length: 6 }, (_, index) => ({
    id: String(index),
    principle: `重点客户沟通原则${index}`,
    scenarios: ["客户跟进", "高层拜访"],
  }));
  const matches = matchPlaybook(candidates, {
    scene: "existing_customer",
    context: "重点客户需要安排高层拜访并确认决策人",
  });
  assert.equal(matches.length, 3);
  assert.ok(matches.every((match) => match.score > 0));
  assert.deepEqual(matchPlaybook(candidates, { scene: "complaint", context: "电机报码" }), []);
});

test("playbook creation copies one exact source principle without AI", () => {
  const route = fs.readFileSync(path.join(root, "app/api/knowledge/playbook/route.ts"), "utf8");
  assert.match(route, /core_principles/);
  assert.match(route, /item === requestedPrinciple/);
  assert.match(route, /String\(source\.applicable_scenarios/);
  assert.match(route, /export async function PATCH/);
  assert.doesNotMatch(route, /requestAi|requestJson|Gemini|GEMINI_API_KEY/);
});

test("sales advice and explicit customer rating each use one routed AI request", () => {
  const route = fs.readFileSync(path.join(root, "app/api/sales-advice/route.ts"), "utf8");
  assert.match(route, /matchPlaybook\(normalizePlaybookRows/);
  assert.equal((route.match(/requestJson\(/g) ?? []).length, 3);
  assert.match(route, /mode === "customer_rating"/);
  assert.match(route, /kind === "potential_customer"/);
  assert.match(route, /只有潜在客户和老客户支持等级分析/);
  assert.match(route, /usedPlaybook/);
  assert.match(PLAYBOOK_PROMPT_GUARDRAIL, /不得为了套用 Playbook/);
  assert.match(route, /Playbook 只能指导沟通表达/);
});
