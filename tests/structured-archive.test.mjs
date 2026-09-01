import test from "node:test";
import assert from "node:assert/strict";
import {
  parseKnowledgeArchive,
  parseTechnicalCaseArchive,
} from "../lib/structured-archive.ts";

test("knowledge standard draft maps locally without changing long text", () => {
  const original = "第一段原文。\n\n第二段原文，保留换行。";
  const result = parseKnowledgeArchive(`【标题】
真正影响成交的是决策人的经营目标

【分类标签】
销售知识，客户开发

【精华提炼】
不要把客户提出的表面要求误当成最终决策标准。
真正需要理解的是决策人的经营目标。

【核心原则】
- 先识别真正决策人
- 从经营目标理解需求

【可执行技巧】
1. 拜访前画出决策链
2. 向采购确认老板最关心的问题

【适用场景】
高层拜访、项目销售

【完整原文】
${original}

【来源】
Joyce 销售复盘
https://example.com/source`);

  assert.ok(result);
  assert.equal(result.title, "真正影响成交的是决策人的经营目标");
  assert.deepEqual(result.categories, ["销售知识", "客户开发"]);
  assert.equal(
    result.essenceSummary,
    "不要把客户提出的表面要求误当成最终决策标准。\n真正需要理解的是决策人的经营目标。",
  );
  assert.deepEqual(result.corePrinciples, [
    "先识别真正决策人",
    "从经营目标理解需求",
  ]);
  assert.deepEqual(result.actionableTactics, [
    "拜访前画出决策链",
    "向采购确认老板最关心的问题",
  ]);
  assert.deepEqual(result.applicableScenarios, ["高层拜访", "项目销售"]);
  assert.equal(result.originalText, original);
  assert.equal(result.sourceName, "Joyce 销售复盘");
  assert.equal(result.sourceUrl, "https://example.com/source");
});

test("knowledge parser leaves missing fields empty and rejects non-standard text", () => {
  const result = parseKnowledgeArchive("【标题】\n测试\n【完整原文】\n原文");
  assert.ok(result);
  assert.equal(result.essenceSummary, "");
  assert.deepEqual(result.categories, []);
  assert.equal(parseKnowledgeArchive("普通段落，没有标准标题"), null);
  assert.equal(parseKnowledgeArchive("【标题】\n只有一个标题"), null);
});

test("technical case standard draft maps all supplied fields and keeps missing empty", () => {
  const report = "客户报告第一段。\n\n测试结果：1长4短。";
  const result = parseTechnicalCaseArchive(`【案例标题】
ADV无法解除P挡
【客户代码】
GR04
【车型/版本】
ADV ABS
【订单号】

【VIN】
VIN123
【故障日期】
2026-07-29
【标签】
P挡无法解除，1长4短，控制器，控制器
【故障现象】
仪表报警1长4短。
【排查过程】
先检查线束。
再测量角度信号。
【确认原因】
控制器角度信号异常。
【解决及复用方法】
更换控制器并重新标定。
【完整技术报告】
${report}`);

  assert.ok(result);
  assert.equal(result.customerCode, "GR04");
  assert.equal(result.orderNo, "");
  assert.equal(result.faultDate, "2026-07-29");
  assert.deepEqual(result.tags, ["P挡无法解除", "1长4短", "控制器"]);
  assert.equal(result.fullTechnicalReport, report);
});

test("technical case parser rejects non-standard text and invalid dates", () => {
  const result = parseTechnicalCaseArchive(
    "【案例标题】测试\n【故障日期】\n昨天",
  );
  assert.ok(result);
  assert.equal(result.faultDate, "");
  assert.equal(parseTechnicalCaseArchive("普通技术报告"), null);
  assert.equal(parseTechnicalCaseArchive("【案例标题】\n只有标题"), null);
});

