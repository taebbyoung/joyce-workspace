import { ensureWorkspace, getD1 } from "@/db/runtime";
import {
  nextRecurringDate,
  taskRecurrenceRules,
} from "@/lib/task-recurrence";

export const runtime = "edge";

const allowedStatuses = new Set([
  "pending",
  "in_progress",
  "completed",
  "snoozed",
  "cancelled",
]);

function text(value: unknown, max = 5000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function nullable(value: unknown, max = 5000) {
  return text(value, max) || null;
}

function errorResponse(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function taskResponse(
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

export async function GET(request: Request) {
  try {
    await ensureWorkspace();
    const url = new URL(request.url);
    if (url.searchParams.get("view") !== "completed") {
      return errorResponse("不支持的任务列表。", 400);
    }
    const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit")) || 30));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const result = await getD1()
      .prepare(
        `SELECT * FROM tasks
         WHERE deleted_at IS NULL
           AND status IN ('completed', '已完成', 'Completed')
         ORDER BY CASE WHEN completed_at IS NULL OR trim(completed_at) = '' THEN 1 ELSE 0 END,
                  completed_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(limit + 1, offset)
      .all<Record<string, unknown>>();
    const hasMore = result.results.length > limit;
    return Response.json({
      tasks: result.results.slice(0, limit),
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
    });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "已完成任务加载失败。",
      500,
    );
  }
}

export async function POST(request: Request) {
  const requestStartedAt = performance.now();
  try {
    await ensureWorkspace();
    const payload = (await request.json()) as Record<string, unknown>;
    const action = text(payload.action, 40);
    const id = text(payload.id, 100);
    if (!id) return errorResponse("缺少任务 ID。");

    const db = getD1();
    const databaseStartedAt = performance.now();
    const now = new Date().toISOString();
    const existing = await db
      .prepare("SELECT * FROM tasks WHERE id = ? LIMIT 1")
      .bind(id)
      .first<Record<string, unknown>>();
    if (!existing) return errorResponse("任务不存在。", 404);

    if (action === "restore_trash") {
      if (!existing.deleted_at) {
        return errorResponse("任务不在回收站中。");
      }
      await db.batch([
        db
          .prepare(
            `UPDATE tasks
             SET deleted_at = NULL, purge_after = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .bind(now, id),
        db
          .prepare(
            `INSERT INTO audit_logs
              (id, action, entity_type, entity_id, before_data, after_data, source)
             VALUES (?, 'task_restored_from_trash', 'task', ?, ?, ?, 'user')`,
          )
          .bind(
            crypto.randomUUID(),
            id,
            JSON.stringify(existing),
            JSON.stringify({ restoredAt: now }),
          ),
      ]);
      return taskResponse({ ok: true, id }, requestStartedAt, databaseStartedAt);
    }

    if (existing.deleted_at) {
      return errorResponse("任务已在回收站中，请先恢复。");
    }

    if (action === "delete") {
      const purgeAfter = new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000,
      ).toISOString();
      await db.batch([
        db
          .prepare(
            `UPDATE tasks
             SET deleted_at = ?, purge_after = ?, updated_at = ?
             WHERE id = ?`,
          )
          .bind(now, purgeAfter, now, id),
        db
          .prepare(
            `INSERT INTO audit_logs
              (id, action, entity_type, entity_id, before_data, after_data, source)
             VALUES (?, 'task_moved_to_trash', 'task', ?, ?, ?, 'user')`,
          )
          .bind(
            crypto.randomUUID(),
            id,
            JSON.stringify(existing),
            JSON.stringify({ deletedAt: now, purgeAfter }),
          ),
      ]);
      return taskResponse(
        { ok: true, id, purgeAfter },
        requestStartedAt,
        databaseStartedAt,
      );
    }

    if (action === "update") {
      const definitions: Array<{
        input: string;
        column: string;
        value: (raw: unknown) => unknown;
      }> = [
        { input: "title", column: "title", value: (raw) => text(raw, 200) },
        { input: "priority", column: "priority", value: (raw) => text(raw, 40) },
        { input: "dueDate", column: "due_date", value: (raw) => nullable(raw, 10) },
        {
          input: "reminderDate",
          column: "reminder_date",
          value: (raw) => nullable(raw, 10),
        },
        {
          input: "recurrenceRule",
          column: "recurrence_rule",
          value: (raw) => text(raw, 20) || "none",
        },
        {
          input: "nextAction",
          column: "next_action",
          value: (raw) => nullable(raw),
        },
        { input: "notes", column: "notes", value: (raw) => nullable(raw) },
      ];
      const supplied = definitions.filter(({ input }) =>
        Object.prototype.hasOwnProperty.call(payload, input),
      );
      if (supplied.some(({ input, value }) => input === "title" && !value(payload[input]))) {
        return errorResponse("任务内容不能为空。");
      }
      const recurrenceValue = supplied.find(
        ({ input }) => input === "recurrenceRule",
      );
      if (
        recurrenceValue &&
        !taskRecurrenceRules.has(String(recurrenceValue.value(payload.recurrenceRule)))
      ) {
        return errorResponse("提醒周期无效。");
      }
      const values = supplied.map(({ input, value }) => value(payload[input]));
      if (supplied.length) {
        await db.batch([
          db
            .prepare(
              `UPDATE tasks SET ${supplied
                .map(({ column }) => `${column} = ?`)
                .join(", ")}, updated_at = ? WHERE id = ?`,
            )
            .bind(...values, now, id),
          db
            .prepare(
              `INSERT INTO audit_logs
                (id, action, entity_type, entity_id, before_data, after_data, source)
               VALUES (?, 'task_updated', 'task', ?, ?, ?, 'user')`,
            )
            .bind(
              crypto.randomUUID(),
              id,
              JSON.stringify(existing),
              JSON.stringify(payload),
            ),
        ]);
      }
      const task = supplied.length
        ? {
            ...existing,
            ...Object.fromEntries(
              supplied.map(({ column }, index) => [column, values[index]]),
            ),
            updated_at: now,
          }
        : existing;
      return taskResponse({ ok: true, id, task }, requestStartedAt, databaseStartedAt);
    }

    if (action === "archive") {
      await db.batch([
        db
          .prepare(
            "UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?",
          )
          .bind(now, now, id),
        db
          .prepare(
            `INSERT INTO audit_logs
              (id, action, entity_type, entity_id, before_data, after_data, source)
             VALUES (?, 'task_archived', 'task', ?, ?, ?, 'user')`,
          )
          .bind(
            crypto.randomUUID(),
            id,
            JSON.stringify(existing),
            JSON.stringify({ archivedAt: now }),
          ),
      ]);
      return taskResponse({ ok: true, id }, requestStartedAt, databaseStartedAt);
    }

    if (action === "restore") {
      await db.batch([
        db
          .prepare(
            "UPDATE tasks SET archived_at = NULL, updated_at = ? WHERE id = ?",
          )
          .bind(now, id),
        db
          .prepare(
            `INSERT INTO audit_logs
              (id, action, entity_type, entity_id, before_data, after_data, source)
             VALUES (?, 'task_restored_from_archive', 'task', ?, ?, ?, 'user')`,
          )
          .bind(
            crypto.randomUUID(),
            id,
            JSON.stringify(existing),
            JSON.stringify({ restoredAt: now }),
          ),
      ]);
      return taskResponse({ ok: true, id }, requestStartedAt, databaseStartedAt);
    }

    if (action === "status") {
      const status = text(payload.status, 40);
      if (!allowedStatuses.has(status)) {
        return errorResponse("任务状态无效。");
      }
      const reminderDate =
        status === "snoozed"
          ? nullable(payload.reminderDate ?? payload.snoozedUntil, 10)
          : null;
      if (status === "snoozed" && !reminderDate) {
        return errorResponse("稍后任务必须设置提醒日期。");
      }

      const recurrence = String(existing.recurrence_rule ?? "none");
      const baseDate = String(
        existing.reminder_date ??
          existing.next_action_date ??
          existing.due_date ??
          new Date().toISOString().slice(0, 10),
      );
      const nextDate =
        status === "completed" ? nextRecurringDate(baseDate, recurrence) : null;
      const recurringContinues = Boolean(nextDate);
      const statusUpdate = recurringContinues
        ? db
            .prepare(
              `UPDATE tasks SET
                status = 'pending',
                snoozed_until = NULL,
                reminder_date = ?,
                completed_at = NULL,
                cancelled_at = NULL,
                updated_at = ?
               WHERE id = ?`,
            )
            .bind(nextDate, now, id)
        : db
            .prepare(
              `UPDATE tasks SET
                status = ?,
                snoozed_until = ?,
                reminder_date = CASE WHEN ? = 'snoozed' THEN ? ELSE reminder_date END,
                completed_at = ?,
                cancelled_at = ?,
                updated_at = ?
               WHERE id = ?`,
            )
            .bind(
              status,
              reminderDate,
              status,
              reminderDate,
              status === "completed" ? now : null,
              status === "cancelled" ? now : null,
              now,
              id,
            );
      const statements = [
        statusUpdate,
        db
          .prepare(
            `INSERT INTO audit_logs
              (id, action, entity_type, entity_id, before_data, after_data, source)
             VALUES (?, 'task_status_updated', 'task', ?, ?, ?, 'user')`,
          )
          .bind(
            crypto.randomUUID(),
            id,
            JSON.stringify(existing),
            JSON.stringify({
              status,
              reminderDate,
              recurringContinues,
              nextReminderDate: nextDate,
            }),
          ),
      ];

      if (status === "completed") {
        if (existing.customer_id) {
          statements.push(
            db
              .prepare(
                `INSERT INTO timeline_events
                  (id, customer_id, event_type, title, content, occurred_at,
                   source_type, source_id, evidence)
                 VALUES (?, ?, 'task_completed', ?, ?, ?, 'task', ?, ?)`,
              )
              .bind(
                crypto.randomUUID(),
                existing.customer_id,
                `完成任务：${String(existing.title)}`,
                existing.notes ?? existing.next_action ?? null,
                now,
                id,
                JSON.stringify({ completedAt: now }),
              ),
          );
        }
      }

      await db.batch(statements);
      const task = recurringContinues
        ? {
            ...existing,
            status: "pending",
            snoozed_until: null,
            reminder_date: nextDate,
            completed_at: null,
            cancelled_at: null,
            updated_at: now,
          }
        : {
            ...existing,
            status,
            snoozed_until: reminderDate,
            reminder_date:
              status === "snoozed" ? reminderDate : existing.reminder_date,
            completed_at: status === "completed" ? now : null,
            cancelled_at: status === "cancelled" ? now : null,
            updated_at: now,
          };
      return taskResponse(
        {
          ok: true,
          id,
          task,
          recurringContinues,
          nextReminderDate: nextDate,
        },
        requestStartedAt,
        databaseStartedAt,
      );
    }

    return errorResponse("未知任务操作。");
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "任务更新失败。",
      500,
    );
  }
}
