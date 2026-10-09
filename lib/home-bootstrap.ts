import {
  buildAttributedCustomerContribution,
  buildAttributedSalesTrend,
  sumAttributedVehicleSales,
} from "./order-sales-attribution.ts";
import { buildCustomerFollowUpAttention } from "./customer-attention.ts";

type Row = Record<string, unknown>;

export type HomeBootstrapData = {
  generatedAt: string;
  metrics: {
    currentYearSales: number;
    currentYearVehicleSales: number;
    currentYearAccessorySales: number;
    activeOrderValue: number;
    existingCustomers: number;
    aPotentialCustomers: number;
    potentialLeads: number;
    currencyReviewCount: number;
  };
  salesTrend: Array<{ month: string; amount: number }>;
  contribution: Array<{ customer_code: string; amount: number }>;
  todayTasks: Row[];
  todayTaskTotal: number;
  attention: Row[];
};

export type HomeBootstrapInputs = {
  today: string;
  metrics: Row | null;
  currentYearAccessorySales: number;
  customerCounts: Row | null;
  salesAttributionOrders: Row[];
  tasks: Row[];
  attentionCustomers: Row[];
  nonCustomerAttention: Row[];
  todayTaskTotal?: number;
  todayTaskLimit?: number;
};

function normalizeTask(task: Row, today: string) {
  const snoozedUntil = String(task.snoozed_until ?? "");
  if (
    ["snoozed", "Snoozed"].includes(String(task.status)) &&
    snoozedUntil &&
    snoozedUntil <= today
  ) {
    return { ...task, status: "pending", effective_status: "pending" };
  }
  return { ...task, effective_status: task.status };
}

function isTodayTask(task: Row, today: string) {
  const due = String(
    task.reminder_date ?? task.next_action_date ?? task.due_date ?? "",
  );
  const status = String(task.effective_status ?? task.status);
  return (
    !["已完成", "completed", "Completed", "cancelled", "Cancelled"].includes(status) &&
    !task.archived_at &&
    !task.deleted_at &&
    ["待处理", "进行中", "pending", "in_progress", "Pending", "In Progress"].includes(status) &&
    Boolean(due && due <= today)
  );
}

export function buildHomeBootstrapData(inputs: HomeBootstrapInputs): HomeBootstrapData {
  const year = inputs.today.slice(0, 4);
  const normalizedTasks = inputs.tasks.map((task) => normalizeTask(task, inputs.today));
  const allTodayTasks = normalizedTasks.filter((task) => isTodayTask(task, inputs.today));
  const customerAttention = inputs.attentionCustomers
    .map((customer) => buildCustomerFollowUpAttention(customer, inputs.today))
    .filter((item): item is Row => Boolean(item));
  const attention = [...inputs.nonCustomerAttention, ...customerAttention].sort((left, right) =>
    String(left.risk_level || "").localeCompare(String(right.risk_level || "")) ||
    String(left.attention_date || "").localeCompare(String(right.attention_date || "")) ||
    String(left.source_type || "").localeCompare(String(right.source_type || "")) ||
    String(left.source_id || "").localeCompare(String(right.source_id || "")),
  );
  const currentYearVehicleSales = sumAttributedVehicleSales(
    inputs.salesAttributionOrders,
    year,
    inputs.today,
  );

  return {
    generatedAt: new Date().toISOString(),
    metrics: {
      currentYearVehicleSales,
      currentYearAccessorySales: inputs.currentYearAccessorySales,
      currentYearSales: currentYearVehicleSales + inputs.currentYearAccessorySales,
      activeOrderValue: Number(inputs.metrics?.active_order_value ?? 0),
      existingCustomers: Number(inputs.customerCounts?.existing_count ?? 0),
      aPotentialCustomers: Number(inputs.customerCounts?.a_potential_count ?? 0),
      potentialLeads: Number(inputs.customerCounts?.lead_count ?? 0),
      currencyReviewCount: Number(inputs.metrics?.currency_review_count ?? 0),
    },
    salesTrend: buildAttributedSalesTrend(inputs.salesAttributionOrders, year, inputs.today),
    contribution: buildAttributedCustomerContribution(
      inputs.salesAttributionOrders,
      year,
      inputs.today,
    ).slice(0, 8),
    todayTasks: inputs.todayTaskLimit
      ? allTodayTasks.slice(0, inputs.todayTaskLimit)
      : allTodayTasks,
    todayTaskTotal: inputs.todayTaskTotal ?? allTodayTasks.length,
    attention,
  };
}

export const homeNonCustomerAttentionSql = `SELECT kind, id, order_id, source_type, source_id, title, message, risk_level, evidence_source, attention_date FROM (
  SELECT 'order' AS kind, r.id, r.order_id, 'order' AS source_type, r.order_id AS source_id,
    COALESCE(o.order_no, o.pi_no, o.customer_code, '订单') AS title,
    r.title || '：' || r.reason AS message,
    r.risk_level, r.evidence_source, r.detected_at AS attention_date
  FROM order_risks r
  JOIN orders o ON o.id = r.order_id
    WHERE r.status = 'active' AND o.deleted_at IS NULL
      AND COALESCE(o.order_status, 'active') <> 'completed'
  UNION ALL
  SELECT 'task', id, NULL, 'task', id, title,
    '任务提醒日期已到：' || COALESCE(NULLIF(reminder_date, ''), NULLIF(next_action_date, ''), NULLIF(due_date, '')),
    'High',
    CASE
      WHEN NULLIF(reminder_date, '') IS NOT NULL THEN 'tasks.reminder_date'
      WHEN NULLIF(next_action_date, '') IS NOT NULL THEN 'tasks.next_action_date'
      ELSE 'tasks.due_date'
    END,
    COALESCE(NULLIF(reminder_date, ''), NULLIF(next_action_date, ''), NULLIF(due_date, ''))
  FROM tasks
  WHERE deleted_at IS NULL AND archived_at IS NULL AND completed_at IS NULL
    AND status IN ('pending', 'in_progress', 'Pending', 'In Progress', '待处理', '进行中', 'snoozed', 'Snoozed', '延期')
     AND COALESCE(NULLIF(reminder_date, ''), NULLIF(next_action_date, ''), NULLIF(due_date, '')) < ?
  )
  ORDER BY CASE risk_level WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
    CASE WHEN source_type = 'task' THEN attention_date ELSE '9999-12-31' END,
    attention_date,
    source_type,
    source_id`;
