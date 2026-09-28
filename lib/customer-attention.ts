import {
  getCustomerFollowUpDueDate,
  getCustomerFollowUpState,
  normalizeCustomerGrade,
} from "./customer-priority.ts";

type CustomerRow = Record<string, unknown>;

function dateKey(value: unknown) {
  const key = String(value ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return "";
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? key
    : "";
}

export function customerFollowUpDueDate(customer: CustomerRow) {
  return getCustomerFollowUpDueDate(customer);
}

export function buildCustomerFollowUpAttention(customer: CustomerRow, todayValue: string) {
  const customerId = String(customer.id ?? "").trim();
  const lifecycle = String(customer.lifecycle ?? "");
  const today = dateKey(todayValue);
  const dueDate = customerFollowUpDueDate(customer);
  const state = getCustomerFollowUpState(customer, today);
  if (!customerId || customer.deleted_at || !today || !dueDate || state.kind !== "overdue" && state.kind !== "due" || !["existing", "potential_customer"].includes(lifecycle)) return null;

  const company = String(customer.company ?? "").trim() || "客户";
  const customerCode = String(customer.customer_code ?? "").trim();
  const overdueDays = state.overdueDays;
  const explicitNextFollow = dateKey(customer.next_follow);
  const grade = normalizeCustomerGrade(lifecycle, customer.grade);
  const gradeLabel = grade ? lifecycle === "existing" ? `${grade}类` : `${grade}级` : "";
  return {
    kind: "customer",
    id: customerId,
    order_id: null,
    source_type: "customer",
    source_id: customerId,
    title: lifecycle === "existing" && customerCode ? `${customerCode} · ${company}` : company,
    message: overdueDays === 0
      ? gradeLabel ? `${gradeLabel} · 今天需要跟进` : "今天需要跟进"
      : gradeLabel ? `${gradeLabel} · 已逾期${overdueDays}天未跟进` : `已逾期${overdueDays}天未跟进`,
    risk_level: "Medium",
    evidence_source: explicitNextFollow ? "customers.next_follow" : "customers.last_contact_at/default_cycle",
    attention_date: dueDate,
  };
}

export function syncCustomerFollowUpAttention(attention: CustomerRow[], customer: CustomerRow | undefined, today: string) {
  if (!customer) return attention;
  const customerId = String(customer.id ?? "");
  const withoutCustomer = attention.filter((item) => !(String(item.source_type || item.kind) === "customer" && String(item.source_id || item.id) === customerId));
  const item = buildCustomerFollowUpAttention(customer, today);
  return item ? [...withoutCustomer, item] : withoutCustomer;
}
