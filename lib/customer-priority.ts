export type CustomerLifecycle = "potential_lead" | "potential_customer" | "existing";

export type CustomerPriorityRow = Record<string, unknown>;

export type FollowupState = {
  kind: "normal" | "due" | "overdue" | "missing" | "none";
  label: string;
  overdueDays: number;
};

export const POTENTIAL_GRADES = ["1", "2", "3", "4"] as const;
export const EXISTING_GRADES = ["A", "B", "C", "D"] as const;

export const EXISTING_CONTACT_CYCLES: Record<string, number> = {
  A: 7,
  B: 15,
  C: 30,
  D: 45,
};

export const POTENTIAL_CONTACT_CYCLES: Record<string, number> = {
  "1": 7,
  "2": 15,
  "3": 30,
  "4": 45,
};

export const POTENTIAL_FOLLOWUP_SUGGESTIONS: Record<string, string> = {
  "1": "建议7天内安排下一次跟进",
  "2": "建议15天内安排下一次跟进",
  "3": "建议30天内安排下一次跟进",
  "4": "建议45天内安排下一次跟进",
};

function dateKey(value: unknown) {
  const key = String(value ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return "";
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? key
    : "";
}

function ordinal(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function dayDifference(later: string, earlier: string) {
  return ordinal(later) - ordinal(earlier);
}

function addDays(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function normalizeCustomerGrade(lifecycle: unknown, grade: unknown) {
  const value = String(grade ?? "").trim().toUpperCase();
  if (lifecycle === "potential_customer") {
    return (POTENTIAL_GRADES as readonly string[]).includes(value) ? value : "";
  }
  if (lifecycle === "existing") {
    return (EXISTING_GRADES as readonly string[]).includes(value) ? value : "";
  }
  return "";
}

function customerCycle(customer: CustomerPriorityRow) {
  const lifecycle = String(customer.lifecycle ?? "");
  const grade = normalizeCustomerGrade(lifecycle, customer.grade);
  if (lifecycle === "existing") return EXISTING_CONTACT_CYCLES[grade] || 0;
  if (lifecycle === "potential_customer") return POTENTIAL_CONTACT_CYCLES[grade] || 0;
  return 0;
}

export function getCustomerFollowUpDueDate(customer: CustomerPriorityRow) {
  const manualDate = dateKey(customer.next_follow);
  if (manualDate) return manualDate;
  const lastContact = dateKey(customer.last_contact_at) || dateKey(customer.last_follow);
  const cycle = customerCycle(customer);
  return lastContact && cycle ? addDays(lastContact, cycle) : "";
}

/**
 * The single scheduling rule used by Customer Detail, lists, and Attention.
 * A manually scheduled customer.next_follow always wins over the grade cycle.
 */
export function getCustomerFollowUpState(
  customer: CustomerPriorityRow,
  todayValue: string,
): FollowupState {
  const today = dateKey(todayValue);
  const nextFollow = dateKey(customer.next_follow);
  if (nextFollow) {
    if (!today) return { kind: "normal", label: `下次跟进 ${nextFollow}`, overdueDays: 0 };
    const difference = dayDifference(today, nextFollow);
    if (difference > 0) return { kind: "overdue", label: `逾期${difference}天未跟进`, overdueDays: difference };
    if (difference === 0) return { kind: "due", label: "今天需要跟进", overdueDays: 0 };
    return { kind: "normal", label: `计划 ${nextFollow.slice(5)}`, overdueDays: 0 };
  }

  const lastContact = dateKey(customer.last_contact_at) || dateKey(customer.last_follow);
  if (!lastContact) return { kind: "missing", label: "未设置跟进", overdueDays: 0 };
  const cycle = customerCycle(customer);
  if (!cycle) return { kind: "none", label: "未评级", overdueDays: 0 };
  if (!today) return { kind: "normal", label: `最近联系 ${lastContact}`, overdueDays: 0 };
  const daysSince = Math.max(0, dayDifference(today, lastContact));
  const overdueDays = daysSince - cycle;
  if (overdueDays > 0) return { kind: "overdue", label: `逾期${overdueDays}天未跟进`, overdueDays };
  if (overdueDays === 0) return { kind: "due", label: "今天建议跟进", overdueDays: 0 };
  return { kind: "normal", label: `上次联系${daysSince}天前`, overdueDays: 0 };
}

// Compatibility wrappers keep existing callers stable while routing all of
// them through the same customer-level scheduling rule.
export function potentialFollowupState(customer: CustomerPriorityRow, today: string) {
  return getCustomerFollowUpState({ ...customer, lifecycle: "potential_customer" }, today);
}

export function existingContactState(customer: CustomerPriorityRow, today: string) {
  return getCustomerFollowUpState({ ...customer, lifecycle: "existing" }, today);
}

export function ratingReviewDue(customer: CustomerPriorityRow, todayValue: string) {
  const today = dateKey(todayValue);
  const reviewed = dateKey(customer.last_reviewed_at);
  return Boolean(today && reviewed && dayDifference(today, reviewed) > 30);
}

function followupRank(state: FollowupState) {
  return state.kind === "overdue"
    ? 0
    : state.kind === "due"
      ? 1
      : state.kind === "missing"
        ? 2
        : state.kind === "normal"
          ? 3
          : 4;
}

function cnyAmount(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function recentOrderDate(value: unknown) {
  const date = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(date) ? date : "";
}

function stableCustomerKey(row: CustomerPriorityRow) {
  return String(row.customer_code ?? "").trim() || String(row.company ?? "").trim();
}

export function sortCustomersForLifecycle(
  rows: CustomerPriorityRow[],
  lifecycle: CustomerLifecycle,
  today: string,
) {
  const withIndex = rows.map((row, index) => ({ row, index }));
  return withIndex
    .sort((left, right) => {
      if (lifecycle === "potential_customer") {
        const potentialBucket = (row: CustomerPriorityRow) => {
          const grade = normalizeCustomerGrade(lifecycle, row.grade);
          if (grade === "1") return 0;
          if (grade === "2" || grade === "3") return 1;
          if (grade === "4") return 2;
          return 3;
        };
        const bucketDifference = potentialBucket(left.row) - potentialBucket(right.row);
        if (bucketDifference) return bucketDifference;
        const stateDifference =
          followupRank(potentialFollowupState(left.row, today)) -
          followupRank(potentialFollowupState(right.row, today));
        if (stateDifference) return stateDifference;
        const leftDate = dateKey(left.row.next_follow) || "9999-12-31";
        const rightDate = dateKey(right.row.next_follow) || "9999-12-31";
        if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
      } else if (lifecycle === "existing") {
        const gradeOrder = ["A", "B", "C", "D", ""];
        const leftGrade = normalizeCustomerGrade(lifecycle, left.row.grade);
        const rightGrade = normalizeCustomerGrade(lifecycle, right.row.grade);
        const gradeDifference =
          gradeOrder.indexOf(leftGrade) - gradeOrder.indexOf(rightGrade);
        if (gradeDifference) return gradeDifference;
        const amountDifference = cnyAmount(right.row.total_sales_cny) -
          cnyAmount(left.row.total_sales_cny);
        if (amountDifference) return amountDifference;
        const leftOrderDate = recentOrderDate(left.row.latest_order_date);
        const rightOrderDate = recentOrderDate(right.row.latest_order_date);
        if (leftOrderDate !== rightOrderDate) {
          return rightOrderDate.localeCompare(leftOrderDate);
        }
        const stableDifference = stableCustomerKey(left.row).localeCompare(
          stableCustomerKey(right.row),
          "zh-CN",
        );
        if (stableDifference) return stableDifference;
        return left.index - right.index;
      }
      const companyDifference = String(left.row.company ?? "").localeCompare(
        String(right.row.company ?? ""),
        "zh-CN",
      );
      return companyDifference || left.index - right.index;
    })
    .map(({ row }) => row);
}
