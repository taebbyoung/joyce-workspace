import { ensureWorkspace, getD1 } from "@/db/runtime";
import {
  buildHomeBootstrapData,
  homeNonCustomerAttentionSql,
} from "@/lib/home-bootstrap";
import { ensureOrderRiskSeeded } from "@/lib/order-risk-bootstrap";
import { getSalesBusinessDate } from "@/lib/order-sales-attribution";

export const runtime = "edge";

type Row = Record<string, unknown>;

async function all<T>(sql: string, ...bindings: unknown[]) {
  const result = await getD1().prepare(sql).bind(...bindings).all<T>();
  return result.results;
}

export async function GET() {
  const requestStartedAt = performance.now();
  try {
    await ensureWorkspace();
    const db = getD1();
    const today = getSalesBusinessDate();
    const year = today.slice(0, 4);
    await ensureOrderRiskSeeded(db);

    const [
      metrics,
      accessorySales,
      customerCounts,
      salesAttributionOrders,
      todayTasks,
      todayTaskCount,
      attentionCustomers,
      nonCustomerAttention,
    ] = await Promise.all([
      db
        .prepare(
          `SELECT
            COALESCE(SUM(CASE WHEN currency_status = 'confirmed' AND deleted_at IS NULL AND COALESCE(order_status, 'active') <> 'completed' THEN cny_amount ELSE 0 END), 0) AS active_order_value,
            SUM(CASE WHEN currency_status = 'needs_confirmation' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS currency_review_count
           FROM orders`,
        )
        .first<Row>(),
      db
        .prepare(
          "SELECT amount_cny FROM accessory_sales_totals WHERE sales_year = ? LIMIT 1",
        )
        .bind(year)
        .first<Row>(),
      db
        .prepare(
          `SELECT
            SUM(CASE WHEN lifecycle = 'existing' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS existing_count,
            SUM(CASE WHEN lifecycle = 'potential_customer' AND grade = '1' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS a_potential_count,
            SUM(CASE WHEN lifecycle = 'potential_lead' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS lead_count
           FROM customers`,
        )
        .first<Row>(),
      all<Row>(
        `SELECT customer_code, expected_shipping_date, shipment_status,
                balance_received_date, cny_amount, currency_status, deleted_at
         FROM orders
         WHERE currency_status = 'confirmed' AND deleted_at IS NULL`,
      ),
      all<Row>(
        `SELECT id, title, status, reminder_date, next_action_date, due_date,
                priority, snoozed_until, archived_at, deleted_at, completed_at
         FROM tasks
         WHERE deleted_at IS NULL AND archived_at IS NULL AND completed_at IS NULL
           AND status IN ('pending', 'in_progress', 'Pending', 'In Progress', '待处理', '进行中', 'snoozed', 'Snoozed', '延期')
           AND (status NOT IN ('snoozed', 'Snoozed') OR snoozed_until <= ?)
           AND COALESCE(NULLIF(reminder_date, ''), NULLIF(next_action_date, ''), NULLIF(due_date, '')) <= ?
         ORDER BY
           CASE WHEN COALESCE(work_sort_order, 0) > 0 THEN 0 ELSE 1 END,
           work_sort_order,
           CASE status WHEN '待处理' THEN 1 WHEN '进行中' THEN 2 ELSE 3 END,
           COALESCE(reminder_date, next_action_date, due_date, '9999-12-31'),
           updated_at DESC
         LIMIT 6`,
        today,
        today,
      ),
      db
        .prepare(
          `SELECT COUNT(*) AS total
           FROM tasks
           WHERE deleted_at IS NULL AND archived_at IS NULL AND completed_at IS NULL
             AND status IN ('pending', 'in_progress', 'Pending', 'In Progress', '待处理', '进行中', 'snoozed', 'Snoozed', '延期')
             AND (status NOT IN ('snoozed', 'Snoozed') OR snoozed_until <= ?)
             AND COALESCE(NULLIF(reminder_date, ''), NULLIF(next_action_date, ''), NULLIF(due_date, '')) <= ?`,
        )
        .bind(today, today)
        .first<{ total: number }>(),
      all<Row>(
        `SELECT id, lifecycle, grade, customer_code, company, next_follow,
                last_contact_at, last_follow, deleted_at
         FROM customers
         WHERE deleted_at IS NULL
           AND lifecycle IN ('existing', 'potential_customer')`,
      ),
      all<Row>(homeNonCustomerAttentionSql, today),
    ]);

    const data = buildHomeBootstrapData({
      today,
      metrics,
      currentYearAccessorySales: Number(accessorySales?.amount_cny ?? 0),
      customerCounts,
      salesAttributionOrders,
      tasks: todayTasks,
      attentionCustomers,
      nonCustomerAttention,
      todayTaskTotal: Number(todayTaskCount?.total ?? 0),
      todayTaskLimit: 6,
    });
    const databaseDuration = Math.max(0, performance.now() - requestStartedAt);
    return Response.json(data, {
      headers: {
        "cache-control": "no-store",
        "server-timing": `db;dur=${databaseDuration.toFixed(1)}, total;dur=${databaseDuration.toFixed(1)}`,
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "首页加载失败。" },
      { status: 500 },
    );
  }
}
