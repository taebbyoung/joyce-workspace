import { ensureWorkspace, getD1 } from "@/db/runtime";
import {
  generateGroundedWorkReport,
  type GroundedReportGroup,
} from "@/lib/ai-provider";

export const runtime = "edge";

const allowedScopes = new Set([
  "customer_followup",
  "orders",
  "after_sales",
  "lead_development",
  "projects",
  "internal",
  "content",
]);
const allScopes = [...allowedScopes];
const reportStatuses = new Set(["已完成", "进行中", "待跟进", "暂缓"]);

type Evidence = {
  id: string;
  sourceType: string;
  category: string;
  target: string;
  customerId?: string;
  projectId?: string;
  topic: string;
  description: string;
  state: "completed" | "in_progress" | "follow_up" | "paused";
  remark: string;
  date: string;
};

function fail(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function text(value: unknown, max = 5000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validDate(value: unknown) {
  const date = text(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function topicFor(value: string, fallback: string) {
  const input = value.toLowerCase();
  if (/控制器|controller|电池|battery|故障|技术|售后|维修|备件/.test(input)) {
    return "技术与售后问题";
  }
  if (/付款|尾款|定金|收款|payment|balance|deposit/.test(input)) {
    return "付款与收款";
  }
  if (/出货|物流|货代|船期|etd|eta|shipment|container|提单/.test(input)) {
    return "出货与物流";
  }
  if (/订单|order|pi\b|生产|验货/.test(input)) return "订单推进";
  if (/报价|价格|quote|price/.test(input)) return "报价与商务沟通";
  if (/开发|线索|lead|经销商|进口商/.test(input)) return "新客开发";
  if (/网站|官网|website/.test(input)) return "官网项目";
  if (/内容|linkedin|朋友圈|文案|post/.test(input)) return "内容运营";
  return fallback;
}

function taskState(row: Record<string, unknown>) {
  const status = String(row.status ?? "").toLowerCase();
  if (row.completed_at || ["completed", "已完成"].includes(status)) {
    return "completed" as const;
  }
  if (row.snoozed_until || ["snoozed", "延期"].includes(status)) {
    return "follow_up" as const;
  }
  if (
    row.archived_at ||
    row.cancelled_at ||
    ["cancelled", "archived", "暂停", "已归档"].includes(status)
  ) {
    return "paused" as const;
  }
  return "in_progress" as const;
}

function mergeState(items: Evidence[]) {
  if (items.some((item) => item.state === "follow_up")) return "待跟进" as const;
  if (items.every((item) => item.state === "completed")) return "已完成" as const;
  if (items.every((item) => item.state === "paused")) return "暂缓" as const;
  return "进行中" as const;
}

function isoWeek(dateText: string) {
  const date = new Date(`${dateText}T12:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return {
    year: date.getUTCFullYear(),
    week: Math.ceil(
      ((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
    ),
  };
}

function reportTitle(reportType: string, startDate: string, endDate: string) {
  if (reportType === "weekly") {
    const { year, week } = isoWeek(startDate);
    return `${year}年第${week}周工作周报`;
  }
  return `${startDate} → ${endDate} 自定义报告`;
}

async function collectEvidence(
  startDate: string,
  endDate: string,
  scopes: string[],
) {
  const db = getD1();
  const include = new Set(scopes);
  const evidence: Evidence[] = [];
  const inRange = (value: unknown) => {
    const date = String(value ?? "").slice(0, 10);
    return date >= startDate && date <= endDate;
  };
  const target = (code: unknown, name: unknown, fallback: string) =>
    text(code, 80) || text(name, 200) || fallback;

  const [tasks, snoozeEvents, timeline, orders, afterSales, projects, customers, content] =
    await Promise.all([
      db
        .prepare(
          `SELECT t.*, c.customer_code, c.company, c.lifecycle, p.title AS project_title
           FROM tasks t
           LEFT JOIN customers c ON c.id = t.customer_id
           LEFT JOIN projects p ON p.id = t.project_id
           WHERE t.deleted_at IS NULL
             AND (
               substr(COALESCE(t.completed_at, ''), 1, 10) BETWEEN ? AND ?
               OR substr(COALESCE(t.archived_at, ''), 1, 10) BETWEEN ? AND ?
               OR substr(t.updated_at, 1, 10) BETWEEN ? AND ?
             )`,
        )
        .bind(startDate, endDate, startDate, endDate, startDate, endDate)
        .all<Record<string, unknown>>(),
      db
        .prepare(
          `SELECT a.*, t.title, t.customer_id, t.project_id, t.deleted_at,
                  c.customer_code, c.company, c.lifecycle, p.title AS project_title
           FROM audit_logs a
           JOIN tasks t ON t.id = a.entity_id
           LEFT JOIN customers c ON c.id = t.customer_id
           LEFT JOIN projects p ON p.id = t.project_id
           WHERE a.entity_type = 'task'
             AND a.action = 'task_status_updated'
             AND t.deleted_at IS NULL
             AND substr(a.created_at, 1, 10) BETWEEN ? AND ?`,
        )
        .bind(startDate, endDate)
        .all<Record<string, unknown>>(),
      db
        .prepare(
          `SELECT e.*, c.customer_code, c.company, c.lifecycle
           FROM timeline_events e
           LEFT JOIN customers c ON c.id = e.customer_id
           WHERE substr(e.occurred_at, 1, 10) BETWEEN ? AND ?
             AND COALESCE(e.source_type, '') <> 'task'`,
        )
        .bind(startDate, endDate)
        .all<Record<string, unknown>>(),
      db
        .prepare(
          `SELECT o.*, c.company
           FROM orders o
           LEFT JOIN customers c ON c.id = o.customer_id
           WHERE o.deleted_at IS NULL
             AND substr(o.updated_at, 1, 10) BETWEEN ? AND ?`,
        )
        .bind(startDate, endDate)
        .all<Record<string, unknown>>(),
      db
        .prepare(
          `SELECT a.*, c.company
           FROM after_sales_cases a
           LEFT JOIN customers c ON c.id = a.customer_id
           WHERE substr(a.updated_at, 1, 10) BETWEEN ? AND ?`,
        )
        .bind(startDate, endDate)
        .all<Record<string, unknown>>(),
      db
        .prepare(
          `SELECT * FROM projects
           WHERE substr(updated_at, 1, 10) BETWEEN ? AND ?`,
        )
        .bind(startDate, endDate)
        .all<Record<string, unknown>>(),
      db
        .prepare(
          `SELECT * FROM customers
           WHERE deleted_at IS NULL
             AND substr(updated_at, 1, 10) BETWEEN ? AND ?`,
        )
        .bind(startDate, endDate)
        .all<Record<string, unknown>>(),
      db
        .prepare(
          `SELECT * FROM content_items
           WHERE substr(updated_at, 1, 10) BETWEEN ? AND ?`,
        )
        .bind(startDate, endDate)
        .all<Record<string, unknown>>(),
    ]);

  for (const row of tasks.results) {
    let category = "internal";
    if (row.after_sales_case_id) category = "after_sales";
    else if (row.order_id) category = "orders";
    else if (row.project_id) category = "projects";
    else if (row.customer_id) {
      category =
        row.lifecycle === "existing" ? "customer_followup" : "lead_development";
    }
    if (!include.has(category)) continue;
    const description = [
      text(row.title, 300),
      text(row.next_action, 500),
      text(row.notes, 500),
    ]
      .filter(Boolean)
      .join("：");
    const date =
      (inRange(row.completed_at) && String(row.completed_at).slice(0, 10)) ||
      (inRange(row.archived_at) && String(row.archived_at).slice(0, 10)) ||
      String(row.updated_at).slice(0, 10);
    const nextDate = text(
      row.snoozed_until ?? row.next_action_date ?? row.reminder_date,
      10,
    );
    evidence.push({
      id: String(row.id),
      sourceType: "task",
      category,
      target: row.project_id
        ? target(null, row.project_title, "内部工作")
        : target(row.customer_code, row.company, "内部工作"),
      customerId: text(row.customer_id, 100) || undefined,
      projectId: text(row.project_id, 100) || undefined,
      topic: topicFor(description, category === "projects" ? "项目推进" : "客户工作"),
      description,
      state: taskState(row),
      remark: nextDate ? `计划${nextDate}处理。` : "",
      date,
    });
  }

  for (const row of snoozeEvents.results) {
    let after: Record<string, unknown> = {};
    try {
      after = JSON.parse(String(row.after_data ?? "{}"));
    } catch {
      after = {};
    }
    if (after.status !== "snoozed") continue;
    const category = row.project_id
      ? "projects"
      : row.customer_id
        ? row.lifecycle === "existing"
          ? "customer_followup"
          : "lead_development"
        : "internal";
    if (!include.has(category)) continue;
    const nextDate = text(
      // Old audit records may still contain nextActionDate.
      after.reminderDate ?? after.nextActionDate,
      10,
    );
    evidence.push({
      id: String(row.id),
      sourceType: "task_snooze",
      category,
      target: row.project_id
        ? target(null, row.project_title, "内部工作")
        : target(row.customer_code, row.company, "内部工作"),
      customerId: text(row.customer_id, 100) || undefined,
      projectId: text(row.project_id, 100) || undefined,
      topic: topicFor(
        text(row.title, 300),
        category === "projects" ? "项目推进" : "客户工作",
      ),
      description: `安排后续跟进：${text(row.title, 300)}`,
      state: "follow_up",
      remark: nextDate ? `计划${nextDate}重新联系或处理。` : "已安排后续跟进。",
      date: String(row.created_at).slice(0, 10),
    });
  }

  for (const row of timeline.results) {
    const eventText = `${text(row.title, 300)} ${text(row.content, 800)}`;
    const category =
      /售后|故障|技术|after/i.test(String(row.event_type) + eventText)
        ? "after_sales"
        : /订单|付款|出货|order|shipment/i.test(
              String(row.event_type) + eventText,
            )
          ? "orders"
          : row.lifecycle === "existing"
            ? "customer_followup"
            : "lead_development";
    if (!include.has(category)) continue;
    evidence.push({
      id: String(row.id),
      sourceType: "timeline",
      category,
      target: target(row.customer_code, row.company, "客户跟进"),
      customerId: text(row.customer_id, 100) || undefined,
      topic: topicFor(eventText, "客户跟进"),
      description: eventText.trim(),
      state: /完成|关闭|resolved|completed/i.test(eventText)
        ? "completed"
        : "in_progress",
      remark: "",
      date: String(row.occurred_at).slice(0, 10),
    });
  }

  if (include.has("orders")) {
    for (const row of orders.results) {
      const description = [
        row.order_no ? `订单${row.order_no}` : "订单",
        row.model ? `车型${row.model}` : "",
        row.payment_status ? `付款${row.payment_status}` : "",
        row.production_status ? `生产${row.production_status}` : "",
        row.shipment_status ? `出货${row.shipment_status}` : "",
      ]
        .filter(Boolean)
        .join("，");
      const completed = ["completed", "已完成", "已交付"].includes(
        String(row.shipment_status),
      );
      const remark =
        text(row.risk, 600) ||
        (row.eta ? `ETA ${String(row.eta).slice(0, 10)}。` : "");
      evidence.push({
        id: String(row.id),
        sourceType: "order",
        category: "orders",
        target: target(row.customer_code, row.customer_name ?? row.company, "订单"),
        customerId: text(row.customer_id, 100) || undefined,
        topic: `订单${text(row.order_no ?? row.pi_no, 100) || "推进"}`,
        description,
        state: completed ? "completed" : "in_progress",
        remark,
        date: String(row.updated_at).slice(0, 10),
      });
    }
  }

  if (include.has("after_sales")) {
    for (const row of afterSales.results) {
      const description = [
        text(row.issue_description, 600),
        text(row.diagnosis, 400),
        text(row.actions_taken, 500),
        text(row.parts_sent, 300),
      ]
        .filter(Boolean)
        .join("；");
      const closed = /已关闭|closed|resolved|已解决/i.test(String(row.status));
      evidence.push({
        id: String(row.id),
        sourceType: "after_sales",
        category: "after_sales",
        target: target(row.customer_code, row.company, "售后"),
        customerId: text(row.customer_id, 100) || undefined,
        topic: topicFor(description, `售后${text(row.code, 80) || "问题"}`),
        description,
        state: closed ? "completed" : "in_progress",
        remark:
          text(row.resolution, 500) ||
          (closed ? "" : "当前仍在处理或验证中，不能视为已解决。"),
        date: String(row.updated_at).slice(0, 10),
      });
    }
  }

  if (include.has("projects")) {
    for (const row of projects.results) {
      evidence.push({
        id: String(row.id),
        sourceType: "project",
        category: "projects",
        target: text(row.title, 300) || "项目",
        projectId: String(row.id),
        topic: topicFor(`${row.title} ${row.notes}`, "项目推进"),
        description: [
          text(row.title, 300),
          row.progress !== null ? `进度${row.progress}%` : "",
          text(row.notes, 500),
        ]
          .filter(Boolean)
          .join("，"),
        state: /已完成|completed/i.test(String(row.status))
          ? "completed"
          : /暂停|cancelled|archived/i.test(String(row.status))
            ? "paused"
            : "in_progress",
        remark: text(row.next_step, 500),
        date: String(row.updated_at).slice(0, 10),
      });
    }
  }

  for (const row of customers.results) {
    const category =
      row.lifecycle === "existing" ? "customer_followup" : "lead_development";
    if (!include.has(category)) continue;
    if (
      row.lifecycle === "existing" &&
      !row.last_follow &&
      !row.next_follow &&
      !row.next_action &&
      !row.strategy
    ) {
      continue;
    }
    const description = [
      row.lifecycle === "potential_lead" ? "新增或更新潜在线索" : "更新客户跟进",
      text(row.profile, 500),
      text(row.strategy, 400),
    ]
      .filter(Boolean)
      .join("：");
    evidence.push({
      id: String(row.id),
      sourceType: "customer",
      category,
      target: target(row.customer_code, row.company, "客户"),
      customerId: String(row.id),
      topic: topicFor(description, category === "lead_development" ? "新客开发" : "客户跟进"),
      description,
      state: row.next_follow ? "follow_up" : "in_progress",
      remark: row.next_follow
        ? `计划${String(row.next_follow).slice(0, 10)}跟进。`
        : text(row.next_action, 500),
      date: String(row.updated_at).slice(0, 10),
    });
  }

  if (include.has("content")) {
    for (const row of content.results) {
      evidence.push({
        id: String(row.id),
        sourceType: "content",
        category: "content",
        target: "内容运营",
        topic: "内容运营",
        description: [
          text(row.topic, 300),
          text(row.platform, 80),
          text(row.draft, 500),
        ]
          .filter(Boolean)
          .join("："),
        state: /已发布|published|完成/i.test(String(row.status))
          ? "completed"
          : "in_progress",
        remark: row.published_date
          ? `发布日期${String(row.published_date).slice(0, 10)}。`
          : "",
        date: String(row.updated_at).slice(0, 10),
      });
    }
  }

  return evidence;
}

function groupEvidence(evidence: Evidence[]) {
  const groups = new Map<string, Evidence[]>();
  for (const item of evidence) {
    const key = `${item.target.toLowerCase()}|${item.category}|${item.topic}`;
    const current = groups.get(key) ?? [];
    current.push(item);
    groups.set(key, current);
  }

  const grounded: GroundedReportGroup[] = [];
  for (const items of groups.values()) {
    const remarks = items.map((item) => item.remark).filter(Boolean);
    grounded.push({
      target: items[0].target,
      topic: items[0].topic,
      evidence: items.map((item) => item.description).filter(Boolean),
      status: mergeState(items),
      remark: remarks.at(-1) ?? "",
    });
  }
  return grounded;
}

function sourceTrace(evidence: Evidence[]) {
  const details = new Map<
    string,
    { target: string; customerId?: string; projectId?: string; counts: Record<string, number> }
  >();
  for (const item of evidence) {
    const current = details.get(item.target) ?? {
      target: item.target,
      customerId: item.customerId,
      projectId: item.projectId,
      counts: {},
    };
    current.counts[item.sourceType] =
      (current.counts[item.sourceType] ?? 0) + 1;
    details.set(item.target, current);
  }
  return {
    summary: {
      activityCount: evidence.length,
      customerCount: new Set(
        evidence.map((item) => item.customerId).filter(Boolean),
      ).size,
      projectCount: new Set(
        evidence.map((item) => item.projectId).filter(Boolean),
      ).size,
    },
    details: [...details.values()],
  };
}

export async function GET() {
  try {
    await ensureWorkspace();
    const result = await getD1()
      .prepare(
        `SELECT * FROM work_reports
         ORDER BY confirmed_at DESC, created_at DESC
         LIMIT 100`,
      )
      .all<Record<string, unknown>>();
    return Response.json({ reports: result.results });
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "报告历史读取失败。",
      500,
    );
  }
}

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const payload = (await request.json()) as Record<string, unknown>;
    const action = text(payload.action, 40);

    if (action === "generate") {
      const reportType = text(payload.reportType, 20);
      const startDate = validDate(payload.startDate);
      const endDate = validDate(payload.endDate);
      if (!["weekly", "custom"].includes(reportType)) {
        return fail("报告类型无效。");
      }
      if (!startDate || !endDate || startDate > endDate) {
        return fail("请选择有效的开始和结束日期。");
      }
      const dayCount =
        Math.floor(
          (new Date(`${endDate}T12:00:00Z`).getTime() -
            new Date(`${startDate}T12:00:00Z`).getTime()) /
            86400000,
        ) + 1;
      if (dayCount > 366) return fail("单次报告范围不能超过 366 天。");
      const requestedScopes = Array.isArray(payload.scopes)
        ? payload.scopes.map(String).filter((scope) => allowedScopes.has(scope))
        : allScopes;
      if (!requestedScopes.length) return fail("请至少选择一个工作范围。");

      const evidence = await collectEvidence(
        startDate,
        endDate,
        requestedScopes,
      );
      const groups = groupEvidence(evidence);
      const generated = await generateGroundedWorkReport(groups, dayCount > 10);
      const trace = sourceTrace(evidence);
      return Response.json({
        draft: {
          reportType,
          title: reportTitle(reportType, startDate, endDate),
          startDate,
          endDate,
          scopes: requestedScopes,
          items: generated.items,
          sourceSummary: trace.summary,
          sourceDetails: trace.details,
          provider: generated.provider,
          warning: generated.warning,
        },
      });
    }

    if (action === "save") {
      const reportType = text(payload.reportType, 20);
      const startDate = validDate(payload.startDate);
      const endDate = validDate(payload.endDate);
      const rawItems = Array.isArray(payload.items) ? payload.items.slice(0, 200) : [];
      if (!["weekly", "custom"].includes(reportType) || !startDate || !endDate) {
        return fail("报告信息不完整。");
      }
      const items = rawItems
        .map((item) => {
          const row = (item ?? {}) as Record<string, unknown>;
          return {
            target: text(row.target, 300),
            content: text(row.content, 2000),
            status: text(row.status, 20),
            remark: text(row.remark, 1200),
          };
        })
        .filter(
          (item) =>
            item.target && item.content && reportStatuses.has(item.status),
        );
      if (!items.length) return fail("报告至少需要一条有效内容。");
      const scopes = Array.isArray(payload.scopes)
        ? payload.scopes.map(String).filter((scope) => allowedScopes.has(scope))
        : allScopes;
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const sourceSummary =
        payload.sourceSummary && typeof payload.sourceSummary === "object"
          ? payload.sourceSummary
          : {};
      const sourceDetails = Array.isArray(payload.sourceDetails)
        ? payload.sourceDetails.slice(0, 300)
        : [];
      await getD1()
        .prepare(
          `INSERT INTO work_reports
            (id, report_type, title, start_date, end_date, scopes, items,
             source_summary, source_details, version_of, confirmed_at,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          reportType,
          text(payload.title, 300) ||
            reportTitle(reportType, startDate, endDate),
          startDate,
          endDate,
          JSON.stringify(scopes),
          JSON.stringify(items),
          JSON.stringify(sourceSummary),
          JSON.stringify(sourceDetails),
          text(payload.versionOf, 100) || null,
          now,
          now,
          now,
        )
        .run();
      return Response.json({ ok: true, id, confirmedAt: now });
    }

    return fail("未知报告操作。");
  } catch (error) {
    return fail(error instanceof Error ? error.message : "报告操作失败。", 500);
  }
}
