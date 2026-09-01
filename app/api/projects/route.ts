import { ensureWorkspace, getD1 } from "@/db/runtime";

export const runtime = "edge";

function text(value: unknown, max = 5000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function nullable(value: unknown, max = 5000) {
  return text(value, max) || null;
}

function errorResponse(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function projectResponse(
  body: Record<string, unknown>,
  requestStartedAt: number,
  databaseStartedAt: number,
) {
  const databaseDuration = Math.max(0, performance.now() - databaseStartedAt);
  const totalDuration = Math.max(0, performance.now() - requestStartedAt);
  return Response.json(body, {
    headers: {
      "server-timing": `db;dur=${databaseDuration.toFixed(1)}, total;dur=${totalDuration.toFixed(1)}`,
    },
  });
}

export async function POST(request: Request) {
  const requestStartedAt = performance.now();
  try {
    await ensureWorkspace();
    const payload = (await request.json()) as Record<string, unknown>;
    const id = text(payload.id, 100);
    if (!id) return errorResponse("缺少项目 ID。");
    const action = text(payload.action, 40) || "update";

    const db = getD1();
    const databaseStartedAt = performance.now();
    const existing = await db.prepare("SELECT * FROM projects WHERE id = ? LIMIT 1").bind(id).first<Record<string, unknown>>();
    if (!existing) return errorResponse("项目不存在。", 404);
    const now = new Date().toISOString();

    if (action === "complete") {
      await db.batch([
        db.prepare(`UPDATE projects SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`).bind(now, now, id),
        db.prepare(`INSERT INTO audit_logs (id, action, entity_type, entity_id, before_data, after_data, source) VALUES (?, 'project_completed', 'project', ?, ?, ?, 'user')`).bind(crypto.randomUUID(), id, JSON.stringify(existing), JSON.stringify({ status: "completed", completed_at: now })),
      ]);
      return projectResponse({
        ok: true,
        project: { ...existing, status: "completed", completed_at: now, updated_at: now },
      }, requestStartedAt, databaseStartedAt);
    }

    if (action === "reopen") {
      await db.batch([
        db.prepare("UPDATE projects SET status = '进行中', completed_at = NULL, updated_at = ? WHERE id = ?").bind(now, id),
        db.prepare(`INSERT INTO audit_logs (id, action, entity_type, entity_id, before_data, after_data, source) VALUES (?, 'project_reopened', 'project', ?, ?, ?, 'user')`).bind(crypto.randomUUID(), id, JSON.stringify(existing), JSON.stringify({ status: "进行中", completed_at: null })),
      ]);
      return projectResponse({
        ok: true,
        project: { ...existing, status: "进行中", completed_at: null, updated_at: now },
      }, requestStartedAt, databaseStartedAt);
    }

    if (action === "delete") {
      const linkedTasks = await db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?").bind(id).first<{ count: number }>();
      const unlinkedTaskCount = Number(linkedTasks?.count || 0);
      await db.batch([
        db.prepare("UPDATE tasks SET project_id = NULL, updated_at = ? WHERE project_id = ?").bind(now, id),
        db.prepare(`INSERT INTO audit_logs (id, action, entity_type, entity_id, before_data, after_data, source) VALUES (?, 'project_deleted', 'project', ?, ?, ?, 'user')`).bind(crypto.randomUUID(), id, JSON.stringify(existing), JSON.stringify({ deleted_at: now, unlinked_task_count: unlinkedTaskCount })),
        db.prepare("DELETE FROM projects WHERE id = ?").bind(id),
      ]);
      return projectResponse(
        { ok: true, deleted: true, id, unlinkedTaskCount },
        requestStartedAt,
        databaseStartedAt,
      );
    }

    if (action !== "update") return errorResponse("不支持的项目操作。");
    const title = text(payload.title, 300);
    if (!title) return errorResponse("项目名称不能为空。");
    const status = text(payload.status, 40);
    if (!status) return errorResponse("请选择项目状态。");
    const nextStep = nullable(payload.nextStep);
    const notes = nullable(payload.notes);
    const finalResult = nullable(payload.finalResult);
    const completing = ["completed", "已完成"].includes(status);
    const completedAt = completing ? existing.completed_at || now : null;
    await db.batch([
      db.prepare(`UPDATE projects SET title = ?, status = ?, next_step = ?, notes = ?, final_result = ?, completed_at = ?, updated_at = ? WHERE id = ?`).bind(title, status, nextStep, notes, finalResult, completedAt, now, id),
      db.prepare(`INSERT INTO audit_logs (id, action, entity_type, entity_id, before_data, after_data, source) VALUES (?, 'project_updated', 'project', ?, ?, ?, 'user')`).bind(crypto.randomUUID(), id, JSON.stringify(existing), JSON.stringify({ title, status, next_step: nextStep, notes, final_result: finalResult, completed_at: completedAt })),
    ]);
    return projectResponse({
      ok: true,
      project: {
        ...existing,
        title,
        status,
        next_step: nextStep,
        notes,
        final_result: finalResult,
        completed_at: completedAt,
        updated_at: now,
      },
    }, requestStartedAt, databaseStartedAt);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "项目保存失败。", 500);
  }
}
