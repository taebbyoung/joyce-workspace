export type WorkPriorityKind = "tasks" | "projects";
export type WorkPrioritySection = "today" | "upcoming" | "projects";

function shanghaiDate() {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

async function currentIds(
  db: D1Database,
  section: WorkPrioritySection,
): Promise<string[]> {
  if (section === "projects") {
    const rows = await db
      .prepare(
        `SELECT id FROM projects
         WHERE lower(status) NOT IN ('completed', 'archived')
         ORDER BY CASE WHEN COALESCE(work_sort_order, 0) > 0 THEN 0 ELSE 1 END,
                  work_sort_order, created_at, id`,
      )
      .all<{ id: string }>();
    return rows.results.map((row) => row.id);
  }

  const dateExpression =
    "COALESCE(reminder_date, next_action_date, due_date, '')";
  const comparison =
    section === "today"
      ? `(${dateExpression} = '' OR ${dateExpression} <= ?)`
      : `${dateExpression} > ?`;
  const rows = await db
    .prepare(
      `SELECT id FROM tasks
       WHERE deleted_at IS NULL AND archived_at IS NULL
         AND status IN (
           'pending', 'in_progress', 'snoozed',
           '待处理', '进行中', '延期'
         )
         AND ${comparison}
       ORDER BY CASE WHEN COALESCE(work_sort_order, 0) > 0 THEN 0 ELSE 1 END,
                work_sort_order, created_at, id`,
    )
    .bind(shanghaiDate())
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

export async function saveManualWorkOrder(
  db: D1Database,
  kind: WorkPriorityKind,
  section: WorkPrioritySection,
  ids: string[],
) {
  if (
    (kind === "projects" && section !== "projects") ||
    (kind === "tasks" && section === "projects")
  ) {
    throw new Error("排序区域与记录类型不匹配。");
  }
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length || uniqueIds.length !== ids.length || uniqueIds.length > 300) {
    throw new Error("排序列表无效。");
  }

  const current = await currentIds(db, section);
  const validIds = new Set(current);
  if (uniqueIds.some((id) => !validIds.has(id))) {
    throw new Error("列表已发生变化，请刷新后再拖动。");
  }
  const completeIds = [
    ...uniqueIds,
    ...current.filter((id) => !uniqueIds.includes(id)),
  ];
  const now = new Date().toISOString();
  const table = kind === "projects" ? "projects" : "tasks";
  const statements = completeIds.map((id, index) =>
    db
      .prepare(
        `UPDATE ${table}
         SET work_sort_order = ?, priority_source = 'manual',
             priority_ranked_at = ?
         WHERE id = ?`,
      )
      .bind((index + 1) * 100, now, id),
  );
  statements.push(
    db
      .prepare(
        `INSERT INTO audit_logs
          (id, action, entity_type, after_data, source, created_at)
         VALUES (?, 'work_priority_manually_reordered', ?, ?, 'user', ?)`,
      )
      .bind(
        crypto.randomUUID(),
        kind,
        JSON.stringify({ section, ids: completeIds }),
        now,
      ),
  );
  await db.batch(statements);
}
