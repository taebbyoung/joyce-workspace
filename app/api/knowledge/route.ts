import { ensureWorkspace, getD1 } from "@/db/runtime";
import { requestJson } from "@/lib/ai-client";

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

function stringList(value: unknown, maxItems = 30, maxLength = 500) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((entry) => text(entry, maxLength))
      .filter(Boolean),
  )].slice(0, maxItems);
}

function normalizeKnowledgeDraft(payload: Record<string, unknown>) {
  const source = text(payload.sourceName ?? payload.source, 300);
  return {
    title: text(payload.title, 300),
    categories: stringList(payload.categories, 20, 100),
    tags: stringList(payload.tags, 40, 60),
    essenceSummary: text(payload.essenceSummary ?? payload.essence_summary, 5000),
    corePrinciples: stringList(
      payload.corePrinciples ?? payload.core_principles,
      30,
    ),
    actionableTactics: stringList(
      payload.actionableTactics ?? payload.actionable_tactics,
      40,
    ),
    applicableScenarios: stringList(
      payload.applicableScenarios ?? payload.applicable_scenarios,
      30,
      200,
    ),
    originalText: text(payload.originalText ?? payload.original_text, 50000),
    sourceName: source,
    sourceUrl: text(payload.sourceUrl ?? payload.source_url, 1000),
  };
}

function validKnowledgeExtraction(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.title === "string" &&
    Array.isArray(row.categories) &&
    Array.isArray(row.tags) &&
    typeof row.essence_summary === "string" &&
    Array.isArray(row.core_principles) &&
    Array.isArray(row.actionable_tactics) &&
    Array.isArray(row.applicable_scenarios) &&
    typeof row.original_text === "string" &&
    typeof row.source_name === "string" &&
    typeof row.source_url === "string"
  );
}

async function findKnowledge(id: string) {
  return getD1()
    .prepare("SELECT * FROM knowledge_items WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
}

export async function GET(request: Request) {
  try {
    await ensureWorkspace();
    const url = new URL(request.url);
    const id = text(url.searchParams.get("id"), 100);
    const query = text(url.searchParams.get("q"), 200);
    if (!id && query) {
      const like = `%${query}%`;
      const items = await getD1()
        .prepare(
          `SELECT * FROM knowledge_items
           WHERE title LIKE ? OR category LIKE ? OR categories LIKE ? OR tags LIKE ?
              OR essence_summary LIKE ? OR core_principles LIKE ?
              OR actionable_tactics LIKE ? OR applicable_scenarios LIKE ?
              OR original_text LIKE ? OR source LIKE ? OR source_name LIKE ?
              OR source_url LIKE ?
           ORDER BY updated_at DESC LIMIT 100`,
        )
        .bind(...Array(12).fill(like))
        .all<Record<string, unknown>>();
      return Response.json(
        { ok: true, items: items.results },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (!id) return jsonError("缺少知识编号。");
    const item = await findKnowledge(id);
    if (!item) return jsonError("没有找到这条知识。", 404);
    const playbook = await getD1()
      .prepare(
        `SELECT * FROM sales_playbook_items
         WHERE knowledge_item_id = ?
         ORDER BY updated_at DESC`,
      )
      .bind(id)
      .all<Record<string, unknown>>();
    return Response.json(
      {
        ok: true,
        item,
        playbook: playbook.results,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "知识详情加载失败。",
      500,
    );
  }
}

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const payload = (await request.json()) as Record<string, unknown>;
    if (payload.action === "extract") {
      const organizedText = text(payload.organizedText, 100000);
      if (!organizedText) return jsonError("请先粘贴整理稿。");
      const prompt = `你是知识库字段识别员。你的唯一任务是把用户已经整理好的内容原样分配到字段，不得总结、改写、删减、补充、推断或优化。
如果某个字段没有明确内容，返回空字符串或空数组。保留原有事实、结论、措辞和重要换行。只返回 JSON。
JSON 结构：
{
  "title": "",
  "categories": [],
  "tags": [],
  "essence_summary": "",
  "core_principles": [],
  "actionable_tactics": [],
  "applicable_scenarios": [],
  "original_text": "",
  "source_name": "",
  "source_url": ""
}

待识别整理稿：
${organizedText}`;
      const { data, meta } = await requestJson(
        {
          task: "default",
          system:
            "你是结构化归档录入员，只做字段识别和原样分配。必须返回 JSON，禁止重新总结或改写。",
          prompt,
          maxTokens: 6000,
        },
        validKnowledgeExtraction,
      );
      const draft = normalizeKnowledgeDraft(data);
      return Response.json(
        { ok: true, draft, provider: meta.provider, model: meta.model, saved: false },
        { headers: { "cache-control": "no-store" } },
      );
    }

    const input = normalizeKnowledgeDraft(payload);
    if (!input.title) return jsonError("标题不能为空。");
    if (!input.originalText) return jsonError("完整原文不能为空。");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const db = getD1();
    await db
      .prepare(
        `INSERT INTO knowledge_items
          (id, title, category, categories, tags, source, source_name, source_url,
           summary, essence_summary, core_principles, actionable_tactics,
           applicable_situations, applicable_scenarios, original_text,
           original_source_type, ai_processing_status, human_review_status,
           reviewed_at, review_status, joyce_approved, user_edited_fields,
           content_modified_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual',
                 'completed', 'approved', ?, 'approved', 1, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.title,
        input.categories[0] ?? null,
        JSON.stringify(input.categories),
        JSON.stringify(input.tags),
        input.sourceName || null,
        input.sourceName || null,
        input.sourceUrl || null,
        input.essenceSummary || null,
        input.essenceSummary || null,
        JSON.stringify(input.corePrinciples),
        JSON.stringify(input.actionableTactics),
        input.applicableScenarios.join("，") || null,
        JSON.stringify(input.applicableScenarios),
        input.originalText,
        now,
        JSON.stringify([
          "title",
          "categories",
          "tags",
          "essence_summary",
          "core_principles",
          "actionable_tactics",
          "applicable_scenarios",
          "original_text",
          "source_name",
          "source_url",
        ]),
        now,
        now,
        now,
      )
      .run();
    const item = await findKnowledge(id);
    await db
      .prepare(
        `INSERT INTO audit_logs
          (id, action, entity_type, entity_id, after_data, source)
         VALUES (?, 'knowledge_created', 'knowledge', ?, ?, 'user')`,
      )
      .bind(crypto.randomUUID(), id, JSON.stringify(item))
      .run();
    return Response.json(
      { ok: true, item },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "知识录入失败。",
      500,
    );
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureWorkspace();
    const payload = (await request.json()) as Record<string, unknown>;
    const id = text(payload.id, 100);
    if (!id) return jsonError("缺少知识编号。");
    const before = await findKnowledge(id);
    if (!before) return jsonError("没有找到这条知识。", 404);

    const title = text(payload.title, 300);
    if (!title) return jsonError("标题不能为空。");
    const categories = stringList(payload.categories, 20, 100);
    const tags = stringList(payload.tags, 40, 60);
    const essenceSummary = text(payload.essenceSummary, 5000);
    const corePrinciples = stringList(payload.corePrinciples, 30);
    const actionableTactics = stringList(payload.actionableTactics, 40);
    const applicableScenarios = stringList(payload.applicableScenarios, 30, 200);
    const summary =
      text(payload.summary) ||
      text(before.summary);
    const sourceName = text(payload.sourceName, 300);
    const sourceUrl = text(payload.sourceUrl, 1000);
    const sourceNotes =
      "sourceNotes" in payload
        ? text(payload.sourceNotes, 4000)
        : text(before.source_notes, 4000);
    const originalText = text(payload.originalText, 50000);
    if (!originalText) return jsonError("完整原文不能为空。");
    const now = new Date().toISOString();
    const db = getD1();
    const editedFields = [
      "title",
      "categories",
      "tags",
      "essence_summary",
      "core_principles",
      "actionable_tactics",
      "applicable_scenarios",
      "original_text",
      "source_name",
      "source_url",
    ];
    if ("sourceNotes" in payload) editedFields.push("source_notes");

    await db
      .prepare(
        `UPDATE knowledge_items
         SET title = ?, summary = ?, category = ?, categories = ?, tags = ?,
             essence_summary = ?, core_principles = ?,
             actionable_tactics = ?, applicable_scenarios = ?,
             applicable_situations = ?, original_text = ?,
             source_name = ?, source_url = ?, source_notes = ?,
             source = ?, user_edited_fields = ?, content_modified_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        title,
        summary,
        categories[0] ?? null,
        JSON.stringify(categories),
        JSON.stringify(tags),
        essenceSummary || null,
        JSON.stringify(corePrinciples),
        JSON.stringify(actionableTactics),
        JSON.stringify(applicableScenarios),
        applicableScenarios.join("；") || null,
        originalText,
        sourceName || null,
        sourceUrl || null,
        sourceNotes || null,
        sourceName || null,
        JSON.stringify(editedFields),
        now,
        now,
        id,
      )
      .run();

    const after = await findKnowledge(id);
    await db
      .prepare(
        `INSERT INTO audit_logs
          (id, action, entity_type, entity_id, before_data, after_data, source)
         VALUES (?, 'knowledge_updated', 'knowledge', ?, ?, ?, 'user')`,
      )
      .bind(
        crypto.randomUUID(),
        id,
        JSON.stringify(before),
        JSON.stringify(after),
      )
      .run();

    return Response.json(
      { ok: true, item: after },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "知识保存失败。",
      500,
    );
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureWorkspace();
    const payload = (await request.json()) as Record<string, unknown>;
    const id = text(payload.id, 100);
    if (!id) return jsonError("缺少知识编号。");
    const before = await findKnowledge(id);
    if (!before) return jsonError("没有找到这条知识。", 404);
    const db = getD1();
    await db.batch([
      db
        .prepare("DELETE FROM sales_playbook_items WHERE knowledge_item_id = ?")
        .bind(id),
      db.prepare("DELETE FROM knowledge_items WHERE id = ?").bind(id),
      db
        .prepare(
          `INSERT INTO audit_logs
            (id, action, entity_type, entity_id, before_data, source)
           VALUES (?, 'knowledge_deleted', 'knowledge', ?, ?, 'user')`,
        )
        .bind(crypto.randomUUID(), id, JSON.stringify(before)),
    ]);
    return Response.json(
      { ok: true, deletedId: id },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "知识删除失败。",
      500,
    );
  }
}
