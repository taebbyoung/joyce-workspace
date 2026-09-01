import { getAiProviderHealth, requestAi, requestJson } from "@/lib/ai-client";
export type WorkPriorityItem = {
  id: string;
  title: string;
  currentOrder: number;
  dueDate?: string | null;
  priority?: string | null;
  customerGrade?: string | null;
  customerLifecycle?: string | null;
  customerName?: string | null;
  paymentStatus?: string | null;
  orderValue?: number | null;
  shipmentStatus?: string | null;
  eta?: string | null;
  orderRisk?: string | null;
  afterSalesPriority?: string | null;
  afterSalesStatus?: string | null;
  nextStep?: string | null;
  notes?: string | null;
};

export type WorkPriorityRanking = {
  id: string;
  reason: string;
};

function currentShanghaiDate() {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

function workPriorityScore(item: WorkPriorityItem, today: string) {
  let score = 0;
  const text = [
    item.title,
    item.nextStep,
    item.notes,
    item.orderRisk,
    item.paymentStatus,
    item.shipmentStatus,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (item.dueDate) {
    if (item.dueDate < today) score += 120;
    else if (item.dueDate === today) score += 100;
    else {
      const days = Math.ceil(
        (new Date(`${item.dueDate}T12:00:00`).getTime() -
          new Date(`${today}T12:00:00`).getTime()) /
          86_400_000,
      );
      if (days <= 1) score += 80;
      else if (days <= 7) score += 45;
      else if (days <= 30) score += 20;
    }
  }

  const priority = String(item.priority ?? "").toLowerCase();
  if (["紧急", "urgent", "critical"].includes(priority)) score += 90;
  else if (["高", "high"].includes(priority)) score += 55;
  else if (["中", "medium"].includes(priority)) score += 25;

  if (/\b(urgent|asap|today|deadline|blocked|delay|overdue)\b|紧急|今天|截止|延误|逾期|阻塞|异常/.test(text)) {
    score += 65;
  }
  if (/quotation|quote|报价|客户回复|customer reply|confirm|确认/.test(text)) {
    score += 30;
  }
  if (/payment|balance|deposit|unpaid|付款|尾款|定金|未付款/.test(text)) {
    score += 55;
  }
  if (/shipment|vessel|eta|etd|container|shipping|船期|货柜|发货|到港/.test(text)) {
    score += 45;
  }
  if (/after.?sales|complaint|failure|technical|售后|客诉|故障|技术/.test(text)) {
    score += 50;
  }
  if (/certification|eec|sample|认证|样车/.test(text)) score += 35;

  const grade = String(item.customerGrade ?? "").toUpperCase();
  if (grade === "A") score += 40;
  else if (grade === "B") score += 20;
  if (item.customerLifecycle === "existing") score += 15;

  const value = Number(item.orderValue);
  if (Number.isFinite(value) && value > 0) {
    score += Math.min(45, Math.round(Math.log10(value + 1) * 8));
  }
  if (/unpaid|balance_pending|abnormal|未付款|尾款待收|异常/.test(String(item.paymentStatus ?? "").toLowerCase())) {
    score += 60;
  }
  if (/abnormal|delayed|异常|延误/.test(String(item.shipmentStatus ?? "").toLowerCase())) {
    score += 55;
  }
  if (item.eta && item.eta <= today && !/completed|arrived|已完成|已到达/.test(String(item.shipmentStatus ?? "").toLowerCase())) {
    score += 45;
  }
  if (/urgent|critical|紧急|严重/.test(String(item.afterSalesPriority ?? "").toLowerCase())) {
    score += 60;
  }

  return score;
}

function deterministicWorkPriority(
  items: WorkPriorityItem[],
  today: string,
): WorkPriorityRanking[] {
  return [...items]
    .sort((a, b) => {
      const scoreDifference =
        workPriorityScore(b, today) - workPriorityScore(a, today);
      if (scoreDifference) return scoreDifference;
      return a.currentOrder - b.currentOrder;
    })
    .map((item) => ({
      id: item.id,
      reason: "根据已记录的期限、风险、客户级别和业务影响排序。",
    }));
}

function normalizeWorkPriorityRanking(
  value: unknown,
  items: WorkPriorityItem[],
) {
  if (!Array.isArray(value)) return null;
  const validIds = new Set(items.map((item) => item.id));
  const seen = new Set<string>();
  const result: WorkPriorityRanking[] = [];
  for (const valueItem of value) {
    const row = (valueItem ?? {}) as Record<string, unknown>;
    const id = String(row.id ?? "");
    if (!validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      reason: String(row.reason ?? "").trim().slice(0, 500),
    });
  }
  return result.length === items.length ? result : null;
}

export async function rankWorkPriority(
  items: WorkPriorityItem[],
  kind: "tasks" | "projects",
) {
  const today = currentShanghaiDate();
  const fallback = deterministicWorkPriority(items, today);
  const health = getAiProviderHealth();
  if (!health.configured || items.length < 2) {
    return {
      ranking: fallback,
      provider: health.configured ? ("single_item" as const) : ("deterministic_fallback" as const),
    };
  }

  const criteria =
    kind === "projects"
      ? "strategic customer importance, active order dependencies, external or EEC/certification deadlines, sample-development urgency, customer commitments, business opportunity, and current blockers"
      : "urgency, importance, due and overdue dates, customer importance and level, payment risk, order value and business impact, shipment/ETA risk, after-sales severity, explicit customer or internal deadlines, blocking dependencies, communication context, business consequences, and time sensitivity";
  const prompt = `You rank Joyce's active ${kind} for an export-sales Work Overview.
Evaluate the COMPLETE supplied list whenever a new item is created.
Urgency is not the same as importance. Consider ${criteria}.
Use only supplied evidence. Do not invent facts.
Return every supplied id exactly once in recommended order.
Return a JSON array only. Each item: {"id":"exact id","reason":"brief evidence-based Chinese reason"}.
Today: ${today}
Items:
${JSON.stringify(items)}`;
  try {
    const { data, meta } = await requestJson(
      {
        task: "work_priority",
        system: "You rank work priorities using only supplied evidence. Return JSON only.",
        prompt,
        maxTokens: 2200,
      },
      (value): value is unknown[] => Array.isArray(value) && Boolean(normalizeWorkPriorityRanking(value, items)),
    );
    const parsed = normalizeWorkPriorityRanking(data, items);
    if (!parsed) throw new Error("Gemini returned an incomplete work ranking");
    return { ranking: parsed, provider: meta.provider, model: meta.model };
  } catch (error) {
    return {
      ranking: fallback,
      provider: "deterministic_fallback" as const,
      warning:
        error instanceof Error ? error.message : "AI temporarily unavailable",
    };
  }
}

export type GroundedReportGroup = {
  target: string;
  topic: string;
  evidence: string[];
  status: "已完成" | "进行中" | "待跟进" | "暂缓";
  remark: string;
};

export type GroundedReportItem = {
  target: string;
  content: string;
  status: "已完成" | "进行中" | "待跟进" | "暂缓";
  remark: string;
};

function deterministicReportItems(
  groups: GroundedReportGroup[],
  longerRange: boolean,
) {
  return groups.map((group) => {
    const evidence = [...new Set(group.evidence.filter(Boolean))];
    const detail =
      evidence.length > 1
        ? [evidence[0], evidence.at(-1)].filter(Boolean).join("；")
        : evidence[0] ?? "";
    return {
      target: group.target,
      content:
        evidence.length > 1
          ? `围绕${group.topic}${longerRange ? "形成阶段性推进" : "持续推进"}，本期整合${evidence.length}项相关活动，主要进展包括：${detail}。`
          : detail || `推进${group.topic}相关工作。`,
      status: group.status,
      remark: group.remark,
    };
  });
}

export async function generateGroundedWorkReport(
  groups: GroundedReportGroup[],
  longerRange: boolean,
) {
  const fallback = deterministicReportItems(groups, longerRange);
  const health = getAiProviderHealth();
  if (!health.configured || !groups.length) {
    return { items: fallback, provider: "deterministic_fallback" as const };
  }

  const prompt = `你为 Joyce 生成中文工作报告草稿。只能使用下面每组明确提供的证据，不得补充未发生的客户回复、完成结果、订单、付款、发货或技术结论。
每个输入分组必须恰好输出一行；不得新增、拆分、删除或合并分组；target 和 status 必须原样保留。
content 写“行动 + 有意义的进展/结果”，不要逐条罗列微小动作。
remark 优先写下一步、等待项、风险、重要日期或依赖；没有证据就留空，不写“继续跟进”等空话。
${longerRange ? "本次日期范围较长，请提高概括层级，突出阶段进展、重要变化、未解决事项和下一步。" : "本次为周报范围，请概括本周有意义的进展。"}
允许的状态仅为：已完成、进行中、待跟进、暂缓。
只返回 JSON 数组，每项字段：target, content, status, remark。

证据分组：
${JSON.stringify(groups)}`;

  try {
    const { data: raw, meta } = await requestJson(
      {
        task: "sales_brief",
        system: "You generate a grounded sales report. Return JSON only.",
        prompt,
        maxTokens: 2600,
      },
      (value): value is unknown[] => Array.isArray(value),
    );
    if (!Array.isArray(raw) || raw.length !== groups.length) {
      throw new Error("Gemini changed the grounded report row count");
    }
    const allowed = new Set(["已完成", "进行中", "待跟进", "暂缓"]);
    const items = raw.map((value, index) => {
      const row = (value ?? {}) as Record<string, unknown>;
      const original = groups[index];
      const status = String(row.status ?? "");
      return {
        target: original.target,
        content:
          String(row.content ?? "").trim().slice(0, 1200) ||
          fallback[index].content,
        status: allowed.has(status) ? original.status : original.status,
        remark: String(row.remark ?? "").trim().slice(0, 800),
      };
    });
    return { items, provider: meta.provider, model: meta.model };
  } catch (error) {
    return {
      items: fallback,
      provider: "deterministic_fallback" as const,
      warning:
        error instanceof Error ? error.message : "AI temporarily unavailable",
    };
  }
}
