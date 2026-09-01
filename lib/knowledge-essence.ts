import { AiProviderError, requestJson } from "@/lib/ai-client";

export type KnowledgeEssenceAnalysis = {
  misconceptions: string[];
  centralJudgment: string;
  reasons: string[];
  methods: string[];
  differences: string[];
  longTermValue: string;
  caseBoundaries: string[];
};

type EssenceContext = {
  analysis?: KnowledgeEssenceAnalysis;
  title?: string;
  categories?: string[];
  tags?: string[];
  corePrinciples?: string[];
  actionableTactics?: string[];
  applicableScenarios?: string[];
};

const approvedExamples = `Joyce 已确认的正确示例（只学习融合逻辑与价值的写法，不得照抄句式或事实）：

示例一：
判断客户的真实痛点，不能只停留在采购提出的价格、货期和质保，或技术人员提出的参数与质量要求，因为这些往往只是老板和关键决策人经营意图的具体体现。销售如果只围绕表面需求推荐产品，很难真正影响客户决策；想提高重大项目的成交能力，就必须主动接触客户高层，理解他们对利润、风险、市场和长期发展的考虑。高层沟通能力并不是靠临时话术获得，而要通过大量真实拜访反复训练。尽早完成100次老板或高层决策人的拜访，不仅能提高识别痛点和推动成交的能力，也会逐步培养经营者思维，成为销售长期发展中真正难以替代的核心竞争力。

示例二：
销售真正重要的不是多会说，而是让客户在天然戒备的状态下，逐渐感受到你的真诚、可靠和被重视。与其急着证明自己、强行推销，不如从细节、服务和行动中建立信任，让客户看到你踏实、勤奋、热情，却不过度表现，也不带太强的功利心。更关键的是，销售方式不能一套话术用到底：重视品质、长期合作和专业服务的客户，往往更能理解并珍惜深入、细致的服务；而更看重价格和效率的客户，过度解释、过度照顾反而可能让人觉得不够可靠，他们更需要简洁、明确、有判断力的建议。销售的核心不是一味讨好客户，而是识别不同客户真正信任什么，再调整自己的沟通方式和服务深度，在真诚、专业与利润之间找到合适的平衡。`;

function cleanList(value: unknown, maximum = 12, maxLength = 600) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((entry) => String(entry ?? "").trim().slice(0, maxLength))
      .filter(Boolean),
  )].slice(0, maximum);
}

export function normalizeKnowledgeAnalysis(
  value: unknown,
): KnowledgeEssenceAnalysis | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const analysis = {
    misconceptions: cleanList(row.misconceptions, 8),
    centralJudgment: String(
      row.central_judgment ?? row.centralJudgment ?? "",
    ).trim().slice(0, 1200),
    reasons: cleanList(row.reasons, 10),
    methods: cleanList(row.methods, 10),
    differences: cleanList(row.differences, 10),
    longTermValue: String(
      row.long_term_value ?? row.longTermValue ?? "",
    ).trim().slice(0, 1200),
    caseBoundaries: cleanList(
      row.case_boundaries ?? row.caseBoundaries,
      10,
    ),
  };
  return analysis.centralJudgment ? analysis : null;
}

export async function analyzeKnowledgeSource(
  originalText: string,
) {
  const prompt = `你正在为 Joyce 的销售知识库做第一阶段深度分析。
这是销售知识资产的方法论提炼，不是文章摘要。
核心问题是：“这篇内容真正改变销售什么认知、判断标准或工作方法？”
请区分可迁移的销售方法论与案例、人物、偶然数字、修辞表达及一次性细节。
找出资深销售经理在更换客户、产品、市场或年份后，仍会保留和复用的经验。
完整阅读原文，只提取原文真实支持的内容，不写最终摘要，不添加外部理论。

请分析：
- 原文反对或纠正的常见误区
- 最核心的判断
- 判断背后的原因
- 原文提出的方法或行动
- 不同对象、场景或条件之间的差异
- 最值得长期记住的价值和启示
- 哪些只是案例，不能扩大成普遍事实

只返回 JSON：
{
  "misconceptions": ["..."],
  "central_judgment": "...",
  "reasons": ["..."],
  "methods": ["..."],
  "differences": ["..."],
  "long_term_value": "...",
  "case_boundaries": ["..."]
}

完整原文：
${originalText}`;
  const { data } = await requestJson(
    {
      task: "knowledge_distillation",
      system: "你是 Joyce Workspace 的销售知识深度分析助手。必须只返回 JSON，不得输出额外文字。",
      prompt,
      maxTokens: 3200,
    },
    (value): value is Record<string, unknown> => Boolean(normalizeKnowledgeAnalysis(value)),
  );
  return normalizeKnowledgeAnalysis(data);
}

function localQualityIssues(summary: unknown) {
  if (typeof summary !== "string") return ["精华提炼不是字符串"];
  const value = summary.trim();
  const issues: string[] = [];
  const compactLength = value.replace(/\s/g, "").length;
  if (compactLength < 300) issues.push("精华提炼少于300字，方法论展开不足");
  if (compactLength > 500) issues.push("精华提炼超过500字，不够凝练");
  if (/[\r\n]/.test(value)) issues.push("没有保持为一个连续段落");
  if (/^\s*(?:[-*•]|\d+[.、)）])\s*/m.test(value)) {
    issues.push("包含项目符号或编号");
  }
  if (
    /本文介绍了|文章主要讲了|作者认为|文章强调了|本文主要|本篇文章/.test(
      value,
    )
  ) {
    issues.push("包含普通摘要套话");
  }
  if ((value.match(/；/g) ?? []).length >= 3) {
    issues.push("疑似用分号拼接多个独立观点");
  }
  if (
    !/因为|原因|因此|所以|这意味着|背后|本质|之所以|如果|只有|才能/.test(
      value,
    )
  ) {
    issues.push("缺少原因或判断逻辑");
  }
  if (!/不能|而是|需要|应该|应当|要|通过|与其|更重要|关键/.test(value)) {
    issues.push("缺少方法或行动逻辑");
  }
  return issues;
}

function modelQualityIssues(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["缺少质量检查结果"];
  }
  const row = value as Record<string, unknown>;
  const check =
    row.quality_check && typeof row.quality_check === "object"
      ? (row.quality_check as Record<string, unknown>)
      : {};
  const issues = cleanList(check.issues, 12, 300);
  const required = [
    ["grounded", "存在原文不支持的内容"],
    ["logic_integrated", "核心判断、原因、方法和价值没有充分融合"],
    ["natural_chinese", "语言仍像机器摘要"],
    ["not_duplicated", "与原则或技巧重复，未形成完整理解"],
    ["transferable_methodology", "没有提炼成可迁移的销售方法论"],
    ["independent_reading", "脱离原文后不能独立阅读"],
  ] as const;
  for (const [field, message] of required) {
    if (check[field] !== true) issues.push(message);
  }
  if (check.passed !== true) issues.push("模型质量检查未通过");
  return [...new Set(issues)];
}

function essencePrompt(
  originalText: string,
  analysis: KnowledgeEssenceAnalysis,
  context: EssenceContext,
) {
  return `你正在为 Joyce 的 Knowledge Library 做第二阶段精华提炼。
Knowledge Library 是销售知识资产系统，不是文章摘要工具。
不要解释原文讲了什么，而要提炼原文背后的销售方法论。
必须回答：“这篇内容真正改变销售什么认知？”
请像资深销售经理把经验沉淀成可复用的工作认知一样写作。
删除案例化和一次性细节，只保留可迁移的判断标准、因果逻辑、工作方法、适用边界和长期价值。
即使读者从未看过原文，这段内容也必须能够独立阅读。
请基于完整原文和第一阶段分析，真正融合原文的逻辑与长期价值，而不是做普通摘要。

写作要求：
- essence_summary 必须是单个字符串，只写一段连续中文，不分条、不编号
- 必须为 300—500 个汉字
- 使用自然、通俗、容易理解的语言
- 将常见误区或表面现象、核心判断、原因、方法、对象差异和长期价值自然串联
- 读者即使不重新阅读原文，也能抓住真正精华
- 内容适合反复阅读、思考和推敲
- 必须基于完整原文，不得加入原文没有的理论、事实、行动建议
- 不要只改写原文第一段，不要简单堆砌关键词
- 不得用分号连接多个独立要点假装成一段
- 禁止使用“本文介绍了”“文章主要讲了”“作者认为”“文章强调了”等摘要套话
- 语气不要像报告摘要或机器总结
- 不要只是重复核心原则和可执行技巧
- 删除案例化细节、人物、偶然数字和只对单一情境有效的表达，除非缺少它们会改变方法论含义
- 必须明确呈现可迁移的销售认知：判断什么、为什么这样判断、未来应如何行动、边界在哪里
- 写成资深销售经理愿意长期收藏和反复阅读的经验总结，而不是文章简介

建议内部逻辑：
常见误区或表面现象 → 真正的核心判断 → 为什么会这样 → 实际应该怎么做 → 长期价值

${approvedExamples}

第一阶段分析：
${JSON.stringify(analysis)}

已有核心原则（仅用于避免机械重复）：
${JSON.stringify(context.corePrinciples ?? [])}

已有可执行技巧（仅用于避免机械重复）：
${JSON.stringify(context.actionableTactics ?? [])}

已确认的其他结构化字段（原样复制到输出，不得重写）：
${JSON.stringify({
  title: context.title ?? "",
  categories: context.categories ?? [],
  tags: context.tags ?? [],
  core_principles: context.corePrinciples ?? [],
  actionable_tactics: context.actionableTactics ?? [],
  applicable_scenarios: context.applicableScenarios ?? [],
})}

完整原文：
${originalText}

只返回 JSON：
{
  "title": "原样复制已确认标题",
  "categories": ["原样复制已确认分类"],
  "tags": ["原样复制已确认标签"],
  "essence_summary": "一段完整中文",
  "core_principles": ["原样复制已有核心原则"],
  "actionable_tactics": ["原样复制已有可执行技巧"],
  "applicable_scenarios": ["原样复制已有适用场景"],
  "quality_check": {
    "passed": true,
    "grounded": true,
    "logic_integrated": true,
    "natural_chinese": true,
    "not_duplicated": true,
    "transferable_methodology": true,
    "independent_reading": true,
    "issues": []
  }
}`;
}

function extractSummary(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const row = value as Record<string, unknown>;
  return typeof row.essence_summary === "string"
    ? row.essence_summary.trim().slice(0, 5000)
    : "";
}

export async function generateKnowledgeEssence(
  originalText: string,
  context: EssenceContext = {},
): Promise<
  | {
      ok: true;
      essenceSummary: string;
      rewritten: boolean;
      provider: string;
      model: string;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    }
  | { ok: false; error: string }
> {
  const source = originalText.trim().slice(0, 50000);
  if (!source) return { ok: false, error: "完整原文为空，无法生成精华提炼。" };
  try {
    const analysis =
      context.analysis ??
      (await analyzeKnowledgeSource(source));
    if (!analysis) {
      return {
        ok: false,
        error: "Gemini 未能完成原文深度分析，原文已保留。",
      };
    }

    const { data: first, meta: firstMeta } = await requestJson(
      {
        task: "knowledge_distillation",
        system: "你是 Joyce Workspace 的销售知识提炼助手。必须返回 JSON 对象，不能返回项目符号或额外说明。",
        prompt: essencePrompt(source, analysis, context),
        maxTokens: 3200,
      },
      (value): value is Record<string, unknown> => Boolean(extractSummary(value)),
    );
    const firstSummary = extractSummary(first);
    const firstIssues = [
      ...localQualityIssues(firstSummary),
      ...modelQualityIssues(first),
    ];
    if (!firstIssues.length) {
      return {
        ok: true,
        essenceSummary: firstSummary,
        rewritten: false,
        provider: firstMeta.provider,
        model: firstMeta.model,
        usage: firstMeta.usage,
      };
    }

    const rewritePrompt = `当前结果仍像普通摘要或观点拼接，缺少可迁移的销售方法论。请重新阅读完整原文，不要说明文章讲了什么，而要回答“这篇内容真正改变销售什么认知？”。删除案例化细节，把判断标准、原因、未来行动、适用边界和长期价值自然融合成一段300—500字的通俗中文，使其脱离原文也能独立阅读。不得分条，不得使用摘要套话，不得添加原文没有的结论。

这是唯一一次自动重写。必须修正这些问题：
${JSON.stringify(firstIssues)}

第一次结果：
${firstSummary}

第一阶段分析：
${JSON.stringify(analysis)}

完整原文：
${source}

${approvedExamples}

只返回 JSON：
{
  "title": ${JSON.stringify(context.title ?? "")},
  "categories": ${JSON.stringify(context.categories ?? [])},
  "tags": ${JSON.stringify(context.tags ?? [])},
  "essence_summary": "重写后的一段完整中文",
  "core_principles": ${JSON.stringify(context.corePrinciples ?? [])},
  "actionable_tactics": ${JSON.stringify(context.actionableTactics ?? [])},
  "applicable_scenarios": ${JSON.stringify(context.applicableScenarios ?? [])},
  "quality_check": {
    "passed": true,
    "grounded": true,
    "logic_integrated": true,
    "natural_chinese": true,
    "not_duplicated": true,
    "transferable_methodology": true,
    "independent_reading": true,
    "issues": []
  }
}`;
    const { data: second, meta: secondMeta } = await requestJson(
      {
        task: "knowledge_quality_rewrite",
        system: "你是 Joyce Workspace 的销售知识提炼助手。必须返回 JSON 对象，不能返回项目符号或额外说明。",
        prompt: rewritePrompt,
        maxTokens: 3200,
      },
      (value): value is Record<string, unknown> => Boolean(extractSummary(value)),
    );
    const secondSummary = extractSummary(second);
    const secondIssues = [
      ...localQualityIssues(secondSummary),
      ...modelQualityIssues(second),
    ];
    if (secondIssues.length) {
      return {
        ok: false,
        error: `精华提炼在自动重写后仍未通过质量检查：${[
          ...new Set(secondIssues),
        ].join("、")}。原文已保留。`,
      };
    }
    return {
      ok: true,
      essenceSummary: secondSummary,
      rewritten: true,
      provider: secondMeta.provider,
      model: secondMeta.model,
      usage: secondMeta.usage,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof AiProviderError && error.category === "configuration"
          ? "DeepSeek 未配置，原文已保留，精华提炼没有生成。"
          : `精华提炼生成失败，原文已保留。${
              error instanceof Error ? `（${error.message}）` : ""
            }`,
    };
  }
}
