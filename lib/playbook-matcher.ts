export type PlaybookCandidate = {
  id: string;
  knowledgeItemId?: string;
  sourceTitle?: string;
  principle: string;
  scenarios: string[];
};

export type PlaybookMatch = PlaybookCandidate & { score: number };

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return list(parsed);
  } catch {
    // Legacy rows may use commas or line breaks.
  }
  return value.split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean);
}

export function normalizePlaybookRows(
  rows: Array<Record<string, unknown>>,
): PlaybookCandidate[] {
  return rows.flatMap((row) => {
    const stored = String(row.summary ?? "").trim();
    const principles = stored ? [stored] : list(row.principles);
    return principles.map((principle, index) => ({
      id: principles.length > 1 ? `${String(row.id)}:${index}` : String(row.id),
      knowledgeItemId: row.knowledge_item_id
        ? String(row.knowledge_item_id)
        : undefined,
      sourceTitle: row.source_title ? String(row.source_title) : undefined,
      principle,
      scenarios: list(row.applicable_scenarios),
    }));
  });
}

function tokens(value: string) {
  const normalized = value.toLowerCase().replace(/\s+/g, "");
  const ascii = value.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  const chinese = normalized.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  const grams = chinese.flatMap((entry) =>
    Array.from({ length: Math.max(0, entry.length - 1) }, (_, index) =>
      entry.slice(index, index + 2),
    ),
  );
  return new Set([...ascii, ...chinese, ...grams]);
}

const sceneAliases: Record<string, string[]> = {
  potential_customer: ["潜在客户", "新客户开发", "客户开发", "线索"],
  existing_customer: ["老客户", "客户跟进", "客户维护", "复购"],
  customer_followup: ["客户跟进", "沟通", "高层拜访", "需求判断"],
  daily_brief: ["今日重点", "客户跟进", "新客户开发", "项目推进"],
  order: ["订单推进", "付款", "谈判", "报价", "项目推进"],
  project: ["重点项目", "项目推进", "高层沟通", "决策人"],
  complaint: ["客诉", "售后沟通", "客户关系", "预期管理"],
};

export function matchPlaybook(
  candidates: PlaybookCandidate[],
  input: { scene: string; context: string },
  limit = 3,
): PlaybookMatch[] {
  const requested = new Set([
    input.scene.toLowerCase(),
    ...(sceneAliases[input.scene] ?? []).map((item) => item.toLowerCase()),
  ]);
  const contextTokens = tokens(`${input.scene} ${input.context}`);

  return candidates
    .map((candidate) => {
      let score = 0;
      for (const scenario of candidate.scenarios) {
        const lower = scenario.toLowerCase();
        if ([...requested].some((value) => lower.includes(value) || value.includes(lower))) {
          score += 12;
        }
        for (const token of tokens(scenario)) {
          if (contextTokens.has(token)) score += 3;
        }
      }
      for (const token of tokens(candidate.principle)) {
        if (contextTokens.has(token)) score += 1;
      }
      return { ...candidate, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, Math.min(3, limit)));
}

export const PLAYBOOK_PROMPT_GUARDRAIL = `Sales Playbook 是 Joyce 长期认可的销售判断原则，只能作为当前建议的参考框架。
必须优先依据当前客户、订单、项目和沟通中的真实事实。
不得为了套用 Playbook 改变事实、忽略上下文、虚构客户情况或机械复述原则。
只使用与当前场景直接相关的原则。最终建议必须具体、现实、可执行。`;

