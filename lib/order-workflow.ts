export type OrderWorkflowRow = Record<string, unknown>;

export function isOrderCompleted(order: OrderWorkflowRow) {
  return String(order.order_status || "active") === "completed";
}

export function isDateInMonth(value: unknown, month: string) {
  return String(value || "").slice(0, 7) === month;
}

export function sortActiveOrders(
  orders: OrderWorkflowRow[],
  riskOrderIds: Set<string>,
) {
  return [...orders].sort((a, b) => {
    const manualPosition = (order: OrderWorkflowRow) => {
      const rawValue = order.open_sort_order;
      if (rawValue === null || rawValue === undefined || rawValue === "") return null;
      const value = Number(rawValue);
      return Number.isFinite(value) ? value : null;
    };
    const aPosition = manualPosition(a);
    const bPosition = manualPosition(b);
    if (aPosition !== null || bPosition !== null) {
      if (aPosition === null) return 1;
      if (bPosition === null) return -1;
      if (aPosition !== bPosition) return aPosition - bPosition;
    }
    const riskDifference =
      Number(riskOrderIds.has(String(b.id))) -
      Number(riskOrderIds.has(String(a.id)));
    if (riskDifference) return riskDifference;
    const firstNode = (order: OrderWorkflowRow) =>
      [order.expected_shipping_date]
        .map((value) => String(value || "").slice(0, 10))
        .filter(Boolean)
        .sort()[0] || "9999-12-31";
    const timeDifference = firstNode(a).localeCompare(firstNode(b));
    return timeDifference || String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
  });
}

export function sortCompletedOrders(orders: OrderWorkflowRow[]) {
  return [...orders].sort((a, b) => {
    if (!a.completed_at && !b.completed_at) return 0;
    if (!a.completed_at) return 1;
    if (!b.completed_at) return -1;
    return String(b.completed_at).localeCompare(String(a.completed_at));
  });
}
