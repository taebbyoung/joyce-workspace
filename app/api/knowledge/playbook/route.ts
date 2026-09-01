import { ensureWorkspace, getD1 } from "@/db/runtime";

export const runtime = "edge";

function jsonError(message: string, status = 400) {
  return Response.json(
    { ok: false, error: message },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function text(value: unknown, max = 20000) {
  return String(value ?? "").trim().slice(0, max);
}

function list(value: unknown, max = 30): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => text(entry, 1000)).filter(Boolean))].slice(0, max);
  }
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? list(parsed, max) : [];
  } catch {
    return value.split(/[\n,，;；]+/).map((entry) => entry.trim()).filter(Boolean).slice(0, max);
  }
}

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const payload = (await request.json()) as Record<string, unknown>;
    const knowledgeItemId = text(payload.knowledgeItemId, 100);
    const requestedPrinciple = text(payload.principle, 1000);
    if (!knowledgeItemId) return jsonError("缺少来源知识编号。");
    if (!requestedPrinciple) return jsonError("请选择一条核心原则。");

    const db = getD1();
    const source = await db
      .prepare(
        `SELECT id, title, core_principles, applicable_scenarios,
                human_review_status, joyce_approved
         FROM knowledge_items WHERE id = ?`,
      )
      .bind(knowledgeItemId)
      .first<Record<string, unknown>>();
    if (!source) return jsonError("没有找到来源知识。", 404);
    if (
      source.human_review_status !== "approved" &&
      Number(source.joyce_approved) !== 1
    ) {
      return jsonError("只有 Joyce 已批准的知识才能加入 Sales Playbook。");
    }
    const sourcePrinciples = list(source.core_principles);
    const principle = sourcePrinciples.find((item) => item === requestedPrinciple);
    if (!principle) {
      return jsonError("核心原则必须与来源知识中的原文完全一致。");
    }
    const duplicate = await db.prepare(
      `SELECT id FROM sales_playbook_items
       WHERE knowledge_item_id = ? AND summary = ?`,
    ).bind(knowledgeItemId, principle).first();
    if (duplicate) return jsonError("这条原则已经在 Sales Playbook 中。", 409);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.batch([
      db
        .prepare(
          `INSERT INTO sales_playbook_items
            (id, knowledge_item_id, title, principles, created_from,
             approved_by, approved_at, category, summary, applicable_scenarios,
             review_status, joyce_approved, evidence, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'knowledge_core_principles',
                   'Joyce', ?, ?, ?, ?, 'current', 1, ?, ?, ?)`,
        )
        .bind(
          id,
          knowledgeItemId,
          principle,
          JSON.stringify([principle]),
          now,
          "[]",
          principle,
          String(source.applicable_scenarios || "[]"),
          `Knowledge Library: ${knowledgeItemId}`,
          now,
          now,
        ),
      db
        .prepare(
          `INSERT INTO audit_logs
            (id, action, entity_type, entity_id, after_data, source)
           VALUES (?, 'playbook_created', 'sales_playbook', ?, ?, 'user')`,
        )
        .bind(
          crypto.randomUUID(),
          id,
          JSON.stringify({
            knowledgeItemId,
            principle,
            applicableScenarios: list(source.applicable_scenarios),
            approvedBy: "Joyce",
            approvedAt: now,
          }),
        ),
    ]);
    const item = await db.prepare("SELECT * FROM sales_playbook_items WHERE id = ?")
      .bind(id).first<Record<string, unknown>>();
    return Response.json(
      { ok: true, item },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Sales Playbook 保存失败。",
      500,
    );
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureWorkspace();
    const payload = (await request.json()) as Record<string, unknown>;
    const id = text(payload.id, 100);
    const principle = text(payload.principle, 1000);
    const applicableScenarios = list(payload.applicableScenarios);
    if (!id) return jsonError("缺少 Playbook 编号。");
    if (!principle) return jsonError("原则不能为空。");
    const db = getD1();
    const before = await db.prepare("SELECT * FROM sales_playbook_items WHERE id = ?")
      .bind(id).first<Record<string, unknown>>();
    if (!before) return jsonError("没有找到这条 Playbook。", 404);
    const now = new Date().toISOString();
    await db.batch([
      db.prepare(
        `UPDATE sales_playbook_items
         SET title = ?, summary = ?, principles = ?, applicable_scenarios = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(
        principle,
        principle,
        JSON.stringify([principle]),
        JSON.stringify(applicableScenarios),
        now,
        id,
      ),
      db.prepare(
        `INSERT INTO audit_logs
          (id, action, entity_type, entity_id, before_data, after_data, source)
         VALUES (?, 'playbook_updated', 'sales_playbook', ?, ?, ?, 'user')`,
      ).bind(
        crypto.randomUUID(),
        id,
        JSON.stringify(before),
        JSON.stringify({ principle, applicableScenarios }),
      ),
    ]);
    const item = await db.prepare("SELECT * FROM sales_playbook_items WHERE id = ?")
      .bind(id).first<Record<string, unknown>>();
    return Response.json({ ok: true, item }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Sales Playbook 保存失败。",
      500,
    );
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureWorkspace();
    const payload = (await request.json()) as Record<string, unknown>;
    const id = text(payload.id, 100);
    if (!id) return jsonError("缺少 Playbook 编号。");
    const db = getD1();
    const before = await db
      .prepare("SELECT * FROM sales_playbook_items WHERE id = ?")
      .bind(id)
      .first<Record<string, unknown>>();
    if (!before) return jsonError("没有找到这条 Playbook。", 404);
    await db.batch([
      db.prepare("DELETE FROM sales_playbook_items WHERE id = ?").bind(id),
      db
        .prepare(
          `INSERT INTO audit_logs
            (id, action, entity_type, entity_id, before_data, source)
           VALUES (?, 'playbook_removed', 'sales_playbook', ?, ?, 'user')`,
        )
        .bind(crypto.randomUUID(), id, JSON.stringify(before)),
    ]);
    return Response.json(
      { ok: true, deletedId: id },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Sales Playbook 移除失败。",
      500,
    );
  }
}
