import { ensureWorkspace, getD1 } from "@/db/runtime";
import { requestJson } from "@/lib/ai-client";
import {
  matchPlaybook,
  normalizePlaybookRows,
  PLAYBOOK_PROMPT_GUARDRAIL,
} from "@/lib/playbook-matcher";

export const runtime = "edge";

type AdviceKind =
  | "potential_customer"
  | "existing_customer"
  | "customer_followup"
  | "daily_brief"
  | "order"
  | "project"
  | "complaint";

type AdviceMode = "sales_advice" | "customer_rating";

const kinds = new Set<AdviceKind>([
  "potential_customer",
  "existing_customer",
  "customer_followup",
  "daily_brief",
  "order",
  "project",
  "complaint",
]);

function fail(message: string, status = 400) {
  return Response.json({ ok: false, error: message }, { status });
}

function text(value: unknown, max = 100) {
  return String(value ?? "").trim().slice(0, max);
}

async function businessContext(kind: AdviceKind, id: string) {
  const db = getD1();
  if (kind === "daily_brief") {
    const [tasks, orders, customers] = await Promise.all([
      db.prepare("SELECT title, next_action, reminder_date, status FROM tasks WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY reminder_date LIMIT 40").all(),
      db.prepare("SELECT order_no, customer_code, payment_status, production_status, shipment_status, eta, risk FROM orders WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 30").all(),
      db.prepare("SELECT customer_code, company, lifecycle, next_action, next_follow FROM customers WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 30").all(),
    ]);
    return { tasks: tasks.results, orders: orders.results, customers: customers.results };
  }
  if (!id) throw new Error("缺少业务记录编号。");
  if (["potential_customer", "existing_customer", "customer_followup"].includes(kind)) {
    const customer = await db.prepare("SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL").bind(id).first();
    if (!customer) return null;
    const [contacts, memory, orders, tasks, timeline] = await Promise.all([
      db.prepare("SELECT name, position, role, notes FROM contacts WHERE customer_id = ? AND deleted_at IS NULL").bind(id).all(),
      db.prepare("SELECT * FROM customer_memory WHERE customer_id = ?").bind(id).first(),
      db.prepare(
        `SELECT order_no, order_date, original_currency, original_amount, cny_amount,
                payment_status, deposit_amount, balance_amount, balance_received_date,
                production_status, shipment_status, risk
         FROM orders
         WHERE customer_id = ? AND deleted_at IS NULL
         ORDER BY COALESCE(order_date, created_at) DESC`,
      ).bind(id).all(),
      db.prepare("SELECT title, next_action, reminder_date, status FROM tasks WHERE customer_id = ? AND deleted_at IS NULL AND archived_at IS NULL").bind(id).all(),
      db.prepare("SELECT event_type, title, content, occurred_at FROM timeline_events WHERE customer_id = ? ORDER BY occurred_at DESC LIMIT 30").bind(id).all(),
    ]);
    return { customer, contacts: contacts.results, memory, orders: orders.results, tasks: tasks.results, timeline: timeline.results };
  }
  const table =
    kind === "order" ? "orders" : kind === "project" ? "projects" : "after_sales_cases";
  const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
  return row ? { [kind]: row } : null;
}

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const payload = (await request.json()) as Record<string, unknown>;
    const kind = text(payload.kind, 40) as AdviceKind;
    const mode = (text(payload.mode, 40) || "sales_advice") as AdviceMode;
    const id = text(payload.id, 100);
    if (!kinds.has(kind)) return fail("销售建议场景无效。");
    if (!["sales_advice", "customer_rating"].includes(mode)) {
      return fail("分析模式无效。");
    }
    const context = await businessContext(kind, id);
    if (!context) return fail("没有找到对应的业务记录。", 404);

    if (mode === "customer_rating") {
      if (!['potential_customer', 'existing_customer'].includes(kind)) {
        return fail("只有潜在客户和老客户支持等级分析。", 409);
      }
      const contextText = JSON.stringify(context);
      if (kind === "potential_customer") {
        const { data, meta } = await requestJson(
          {
            task: "complex_customer_analysis",
            system:
              "你只提供客户等级建议，不得自动保存或修改客户。必须基于真实资料，信息不足时明确写入判断依据。只输出 JSON。",
            prompt: `请根据以下客户资料，按购买意愿 × 购买能力辅助判断潜客等级。
1级：有购买力且有明确购买意愿；2级：有购买意愿但能力有限；3级：有能力但意愿不足；4级：能力和意愿都弱。网站质量只能作为辅助信号，不能单独判断实力。不得虚构资料。

客户真实资料 JSON：
${contextText}

只输出 JSON：
{"suggested_grade":"1|2|3|4","purchase_intent":"high|medium|low|unconfirmed","purchase_ability":"strong|limited|weak|unconfirmed","rating_reason":"1至3句话的事实依据","next_action":"建议下一步"}`,
            maxTokens: 1600,
          },
          (value): value is Record<string, string> => {
            const row = value as Record<string, unknown>;
            return (
              ["1", "2", "3", "4"].includes(String(row.suggested_grade)) &&
              ["high", "medium", "low", "unconfirmed"].includes(
                String(row.purchase_intent),
              ) &&
              ["strong", "limited", "weak", "unconfirmed"].includes(
                String(row.purchase_ability),
              ) &&
              typeof row.rating_reason === "string" &&
              typeof row.next_action === "string"
            );
          },
        );
        return Response.json({
          ok: true,
          ratingAdvice: data,
          provider: meta.provider,
          model: meta.model,
        });
      }

      const { data, meta } = await requestJson(
        {
          task: "complex_customer_analysis",
          system:
            "你只提供客户等级建议，不得自动保存或修改客户。必须基于真实资料，信息不足时明确写入判断依据。只输出 JSON。",
          prompt: `请根据以下客户资料，按合作价值 × 合作质量辅助判断老客户等级。
A类：优质长期合作伙伴；B类：可培养客户；C类：低活跃或风险客户；D类：清退类。重点参考订单频率和金额、付款表现、沟通质量、合作活跃度与长期价值，不得虚构资料。

客户真实资料 JSON：
${contextText}

只输出 JSON：
{"suggested_grade":"A|B|C|D","rating_reason":"1至3句话的事实依据","maintenance_strategy":"建议维护策略"}`,
          maxTokens: 1600,
        },
        (value): value is Record<string, string> => {
          const row = value as Record<string, unknown>;
          return (
            ["A", "B", "C", "D"].includes(String(row.suggested_grade)) &&
            typeof row.rating_reason === "string" &&
            typeof row.maintenance_strategy === "string"
          );
        },
      );
      return Response.json({
        ok: true,
        ratingAdvice: data,
        provider: meta.provider,
        model: meta.model,
      });
    }

    const db = getD1();
    const rows = await db.prepare(
      `SELECT p.*, k.title AS source_title
       FROM sales_playbook_items p
       LEFT JOIN knowledge_items k ON k.id = p.knowledge_item_id
       WHERE p.joyce_approved = 1 AND p.review_status = 'current'`,
    ).all<Record<string, unknown>>();
    const contextText = JSON.stringify(context);
    const matches = matchPlaybook(normalizePlaybookRows(rows.results), {
      scene: kind,
      context: contextText,
    });
    const playbookText = matches.length
      ? matches.map((item, index) => `${index + 1}. ${item.principle}`).join("\n")
      : "无明显相关原则；不要强行引用。";
    const complaintGuard =
      kind === "complaint"
        ? "技术判断必须只依据车辆证据、技术案例、技术资料和当前排查结果；Playbook 只能指导沟通表达、客户预期与配合推进，绝不能替代技术诊断。"
        : "";
    const { data, meta } = await requestJson(
      {
        task: kind === "complaint" ? "complaint_analysis" : "complex_customer_analysis",
        system: `${PLAYBOOK_PROMPT_GUARDRAIL}\n${complaintGuard}\n只输出 JSON。`,
        prompt: `请基于以下真实业务上下文生成具体销售建议，不得虚构。
业务场景：${kind}
真实上下文 JSON：
${contextText}

本地匹配出的 Sales Playbook（最多三条）：
${playbookText}

输出 JSON：
{"judgement":"当前判断","next_action":"最值得做的下一步","communication_focus":"沟通重点","risks":"风险或遗漏","suggested_message":"可直接参考的话术"}`,
        maxTokens: 1800,
      },
      (value): value is Record<string, string> => {
        const row = value as Record<string, unknown>;
        for (const key of ["judgement", "next_action", "communication_focus", "risks", "suggested_message"]) {
          if (typeof row?.[key] !== "string") return false;
        }
        return true;
      },
    );
    return Response.json({
      ok: true,
      advice: data,
      usedPlaybook: matches.map(({ score: _score, ...item }) => item),
      provider: meta.provider,
      model: meta.model,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "销售建议生成失败。", 500);
  }
}
