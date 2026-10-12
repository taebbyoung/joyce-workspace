export type OrderSalesAttributionRow = Record<string, unknown>;

const ACTUAL_SHIPMENT_STATUSES = new Set([
  "in_transit",
  "arrived",
  "delivered",
  // Read-only compatibility for records that have not yet been normalized.
  "shipped",
  "completed",
]);

function field(
  order: OrderSalesAttributionRow,
  camelCase: string,
  snakeCase: string,
) {
  return order[camelCase] ?? order[snakeCase];
}

function normalizeDate(value: unknown) {
  const date = String(value ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date
    ? null
    : date;
}

function normalizedToday(today?: string) {
  return normalizeDate(today) ?? getSalesBusinessDate();
}

export function getSalesBusinessDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function shippingStatus(order: OrderSalesAttributionRow) {
  return String(field(order, "shipmentStatus", "shipment_status") ?? "").trim();
}

function shippingDate(order: OrderSalesAttributionRow) {
  const shipmentDate = normalizeDate(
    field(order, "shipmentActualShippingDate", "shipment_actual_shipping_date"),
  );
  if (shipmentDate) return shipmentDate;
  return normalizeDate(
    field(order, "expectedShippingDate", "expected_shipping_date"),
  );
}

function fullPaymentReceivedDate(order: OrderSalesAttributionRow) {
  return normalizeDate(
    field(order, "balanceReceivedDate", "balance_received_date"),
  );
}

function daysBetween(later: string, earlier: string) {
  return Math.round(
    (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) /
      86_400_000,
  );
}

export function isActualShippingDate(
  order: OrderSalesAttributionRow,
  today?: string,
) {
  const date = shippingDate(order);
  if (
    normalizeDate(field(order, "shipmentActualShippingDate", "shipment_actual_shipping_date"))
  ) return Boolean(date && date <= normalizedToday(today));
  return Boolean(
    date &&
      date <= normalizedToday(today) &&
      ACTUAL_SHIPMENT_STATUSES.has(shippingStatus(order)),
  );
}

export function getEffectiveActualShippingDate(
  order: OrderSalesAttributionRow,
  today?: string,
) {
  return isActualShippingDate(order, today) ? shippingDate(order) : null;
}

export function getSalesAttributionDate(
  order: OrderSalesAttributionRow,
  today?: string,
) {
  return getSalesAttribution(order, today).attributionDate;
}

export function getSalesAttribution(
  order: OrderSalesAttributionRow,
  today?: string,
) {
  const effectiveActualShippingDate = getEffectiveActualShippingDate(
    order,
    today,
  );
  const paymentDate = fullPaymentReceivedDate(order);
  const attributionDate =
    effectiveActualShippingDate && paymentDate
      ? effectiveActualShippingDate > paymentDate
        ? effectiveActualShippingDate
        : paymentDate
      : effectiveActualShippingDate ?? paymentDate;
  return {
    effectiveActualShippingDate,
    fullPaymentReceivedDate: paymentDate,
    attributionDate,
    year: attributionDate?.slice(0, 4) ?? null,
    status:
      effectiveActualShippingDate && paymentDate
        ? "final"
        : attributionDate
          ? "provisional"
          : "unattributed",
  } as const;
}

export function getSalesYear(
  order: OrderSalesAttributionRow,
  today?: string,
) {
  return getSalesAttribution(order, today).year;
}

export function getShippingDateState(
  order: OrderSalesAttributionRow,
  today?: string,
) {
  const date = shippingDate(order);
  const currentDate = normalizedToday(today);
  const actualStatus = ACTUAL_SHIPMENT_STATUSES.has(shippingStatus(order));

  if (!date) {
    return {
      kind: actualStatus ? "missing_actual" : "missing",
      date: null,
      daysOverdue: null,
      label: actualStatus ? "请填写实际发货日期。" : "发货日期待补",
    } as const;
  }
  if (date > currentDate) {
    return {
      kind: "expected",
      date,
      daysOverdue: null,
      label: `预计发货：${date}`,
    } as const;
  }
  if (actualStatus) {
    return {
      kind: "actual",
      date,
      daysOverdue: null,
      label: `实际发货：${date}`,
    } as const;
  }
  const daysOverdue = daysBetween(currentDate, date);
  return {
    kind: daysOverdue > 0 ? "overdue" : "expected",
    date,
    daysOverdue,
    label:
      daysOverdue > 0
        ? `预计发货：${date} · 已逾期${daysOverdue}天`
        : `预计发货：${date} · 今天待发`,
  } as const;
}

export function isExpectedShippingInMonth(
  order: OrderSalesAttributionRow,
  month: string,
  today?: string,
) {
  const date = shippingDate(order);
  return Boolean(
    String(field(order, "orderStatus", "order_status") ?? "active") !==
      "completed" &&
      date?.slice(0, 7) === month &&
      !isActualShippingDate(order, today),
  );
}

export function sumAttributedVehicleSales(
  orders: OrderSalesAttributionRow[],
  year: string | number,
  today?: string,
) {
  const targetYear = String(year);
  return orders.reduce((sum, order) => {
    if (
      order.deleted_at ||
      String(order.currency_status ?? "") !== "confirmed" ||
      getSalesYear(order, today) !== targetYear
    ) {
      return sum;
    }
    const amount = Number(order.cny_amount);
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);
}

export function groupAttributedOrdersByYear(
  orders: OrderSalesAttributionRow[],
  today?: string,
) {
  const groups = new Map<string, OrderSalesAttributionRow[]>();
  for (const order of orders) {
    if (order.deleted_at) continue;
    const year = getSalesYear(order, today);
    if (!year) continue;
    const group = groups.get(year);
    if (group) group.push(order);
    else groups.set(year, [order]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => Number(right) - Number(left))
    .map(([year, groupedOrders]) => ({
      year,
      orders: groupedOrders,
      totalCnyAmount: groupedOrders.reduce((sum, order) => {
        if (String(order.currency_status ?? "") !== "confirmed") return sum;
        const amount = Number(order.cny_amount);
        return Number.isFinite(amount) ? sum + amount : sum;
      }, 0),
    }));
}

export function buildAttributedSalesTrend(
  orders: OrderSalesAttributionRow[],
  year: string | number,
  today?: string,
) {
  const targetYear = String(year);
  const totals = new Map<string, number>();
  for (const order of orders) {
    if (order.deleted_at || String(order.currency_status ?? "") !== "confirmed") {
      continue;
    }
    const month = getSalesAttributionDate(order, today)?.slice(0, 7);
    const amount = Number(order.cny_amount);
    if (!month?.startsWith(`${targetYear}-`) || !Number.isFinite(amount)) continue;
    totals.set(month, (totals.get(month) ?? 0) + amount);
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, amount]) => ({ month, amount }));
}

export function buildAttributedCustomerContribution(
  orders: OrderSalesAttributionRow[],
  year: string | number,
  today?: string,
) {
  const targetYear = String(year);
  const totals = new Map<string, number>();
  for (const order of orders) {
    if (
      order.deleted_at ||
      String(order.currency_status ?? "") !== "confirmed" ||
      getSalesYear(order, today) !== targetYear
    ) {
      continue;
    }
    const amount = Number(order.cny_amount);
    if (!Number.isFinite(amount)) continue;
    const customerCode = String(order.customer_code ?? "").trim() || "NO-CODE";
    totals.set(customerCode, (totals.get(customerCode) ?? 0) + amount);
  }
  return [...totals.entries()]
    .map(([customer_code, amount]) => ({ customer_code, amount }))
    .sort((left, right) => right.amount - left.amount);
}
