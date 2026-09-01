import { ensureWorkspace, getD1 } from "@/db/runtime";
import { generateKnowledgeEssence } from "@/lib/knowledge-essence";

export const runtime = "edge";

const legacyKnowledgeIds = new Set([
  "771238a0-5b03-4e9e-916a-4702f9bd4fdf",
  "eda82392-1a24-4027-87b5-883d9210a666",
]);

const manualOverwriteForce = "overwrite_manual_essence_summary";

function response(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function text(value: unknown, max = 100) {
  return String(value ?? "").trim().slice(0, max);
}

function parseList(value: unknown) {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const payload = (await request.json()) as Record<string, unknown>;
    const knowledgeId = text(payload.knowledge_id);
    if (!knowledgeId) {
      return response(
        { ok: false, error: "必须提供明确的 knowledge_id；不会执行批量回填。" },
        400,
      );
    }

    const db = getD1();
    const before = await db
      .prepare("SELECT * FROM knowledge_items WHERE id = ?")
      .bind(knowledgeId)
      .first<Record<string, unknown>>();
    if (!before) {
      return response(
        { ok: false, error: "未找到该知识，未调用 AI。" },
        404,
      );
    }
    if (!legacyKnowledgeIds.has(knowledgeId)) {
      return response(
        { ok: false, error: "该接口只允许指定的旧知识进行定向回填。" },
        403,
      );
    }

    const editedFields = parseList(before.user_edited_fields);
    const hasManualSummary = editedFields.includes("essence_summary");
    const hasExistingSummary = Boolean(String(before.essence_summary ?? "").trim());
    const forceManualOverwrite =
      payload.force === manualOverwriteForce;

    if (hasManualSummary && !forceManualOverwrite) {
      return response(
        {
          ok: false,
          error: "该知识的精华提炼已有 Joyce 手动版本，默认不会覆盖。",
          status: "skipped_manual_version",
        },
        409,
      );
    }
    if (hasExistingSummary && (!hasManualSummary || !forceManualOverwrite)) {
      return response(
        {
          ok: false,
          error: "该知识已有精华提炼，未执行覆盖。",
          status: "skipped_existing_summary",
        },
        409,
      );
    }

    const generated = await generateKnowledgeEssence(
      String(before.original_text ?? ""),
      {
        title: String(before.title ?? ""),
        categories: parseList(before.categories),
        tags: parseList(before.tags),
        corePrinciples: parseList(before.core_principles),
        actionableTactics: parseList(before.actionable_tactics),
        applicableScenarios: parseList(before.applicable_scenarios),
      },
    );
    if (!generated.ok) {
      return response(
        {
          ok: false,
          error: generated.error,
          status: "generation_failed",
          preserved: true,
        },
        502,
      );
    }

    await db
      .prepare(
        `UPDATE knowledge_items
         SET essence_summary = ?
         WHERE id = ?
           AND (
             trim(COALESCE(essence_summary, '')) = ''
             OR (
               ? = 1
               AND instr(COALESCE(user_edited_fields, ''), '"essence_summary"') > 0
             )
           )`,
      )
      .bind(
        generated.essenceSummary,
        knowledgeId,
        forceManualOverwrite ? 1 : 0,
      )
      .run();

    const after = await db
      .prepare("SELECT * FROM knowledge_items WHERE id = ?")
      .bind(knowledgeId)
      .first<Record<string, unknown>>();
    const beforeWithoutEssence = { ...before };
    const afterWithoutEssence = { ...after };
    delete beforeWithoutEssence.essence_summary;
    delete afterWithoutEssence.essence_summary;
    const preserved =
      JSON.stringify(beforeWithoutEssence) === JSON.stringify(afterWithoutEssence);
    const applied =
      String(after?.essence_summary ?? "") === generated.essenceSummary;
    if (!applied) {
      return response(
        {
          ok: false,
          error: "精华提炼在保存前发生变更，已保留当前版本。",
          status: "skipped_concurrent_manual_version",
          preserved,
        },
        409,
      );
    }

    await db
      .prepare(
        `INSERT INTO audit_logs
          (id, action, entity_type, entity_id, before_data, after_data, source)
         VALUES (?, 'knowledge_essence_backfilled', 'knowledge', ?, ?, ?, 'ai')`,
      )
      .bind(
        crypto.randomUUID(),
        knowledgeId,
        JSON.stringify({ essenceSummary: before.essence_summary ?? null }),
        JSON.stringify({
          essenceSummary: generated.essenceSummary,
          rewritten: generated.rewritten,
          provider: generated.provider,
          model: generated.model,
          task: "knowledge_distillation",
          usage: generated.usage,
          otherFieldsPreserved: preserved,
        }),
      )
      .run();

    return response({
      ok: preserved,
      id: knowledgeId,
      status: preserved ? "generated" : "preservation_check_failed",
      characters: generated.essenceSummary.replace(/\s/g, "").length,
      rewritten: generated.rewritten,
      preserved,
    }, preserved ? 200 : 500);
  } catch (error) {
    return response(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "旧知识精华提炼生成失败，现有数据未被覆盖。",
      },
      500,
    );
  }
}
