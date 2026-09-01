import {
  EXISTING_CONTACT_CYCLES,
  POTENTIAL_CONTACT_CYCLES,
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

function addDays(dateValue: string, days: number) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayDifference(later: string, earlier: string) {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

function lifecycleCycle(customer: CustomerRow) {
  const lifecycle = String(customer.lifecycle ?? "");
  const grade = normalizeCustomerGrade(lifecycle, customer.grade);
  if (lifecycle === "existing") {
    return { cycle: EXISTING_CONTACT_CYCLES[grade] || 0, label: grade ? `${grade}类` : "" };
  }
  if (lifecycle === "potential_customer") {
    return { cycle: POTENTIAL_CONTACT_CYCLES[grade] || 0, label: grade ? `${grade}级` : "" };
  }
  return { cycle: 0, label: "" };
}

export function customerFollowUpDueDate(customer: CustomerRow) {
  const explicitNextFollow = dateKey(customer.next_follow);
  if (explicitNextFollow) return explicitNextFollow;
  const { cycle } = lifecycleCycle(customer);
  const lastContact = dateKey(customer.last_contact_at) || dateKey(customer.last_follow);
  return cycle && lastContact ? addDays(lastContact, cycle) : "";
}

export function buildCustomerFollowUpAttention(customer: CustomerRow, todayValue: string) {
  const customerId = String(customer.id ?? "").trim();
  const lifecycle = String(customer.lifecycle ?? "");
  const today = dateKey(todayValue);
  const { cycle, label } = lifecycleCycle(customer);
  const dueDate = customerFollowUpDueDate(customer);
  if (!customerId || customer.deleted_at || !today || !dueDate || dueDate > today || !["existing", "potential_customer"].includes(lifecycle)) return null;

  const company = String(customer.company ?? "").trim() || "客户";
  const customerCode = String(customer.customer_code ?? "").trim();
  const overdueDays = Math.max(0, dayDifference(today, dueDate));
  const explicitNextFollow = dateKey(customer.next_follow);
  return {
    kind: "customer",
    id: customerId,
    order_id: null,
    source_type: "customer",
    source_id: customerId,
    title: lifecycle === "existing" && customerCode ? `${customerCode} · ${company}` : company,
    message: overdueDays === 0
      ? label && cycle ? `${label} · ${cycle}天周期 · 今天需要跟进` : "今天需要跟进"
      : label ? `${label} · 已逾期${overdueDays}天未跟进` : `已逾期${overdueDays}天未跟进`,
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
