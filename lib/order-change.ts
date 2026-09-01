export type ComparableOrderRow = Record<string, unknown>;

function comparableValue(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return String(value);
}

export function hasStoredOrderChanges(
  existing: ComparableOrderRow,
  next: ComparableOrderRow,
  fields: readonly string[],
) {
  return fields.some(
    (field) => comparableValue(existing[field]) !== comparableValue(next[field]),
  );
}

type ComparableOrderItem = {
  description?: unknown;
  model?: unknown;
  quantity?: unknown;
  unit_price?: unknown;
  unitPrice?: unknown;
};

function comparableItem(item: ComparableOrderItem) {
  return {
    description: String(item.description ?? item.model ?? "").trim(),
    quantity: comparableValue(item.quantity),
    unitPrice: comparableValue(item.unit_price ?? item.unitPrice),
  };
}

export function hasOrderItemChanges(
  existing: ComparableOrderItem[],
  next: ComparableOrderItem[],
) {
  if (existing.length !== next.length) return true;
  return existing.some((item, index) => {
    const before = comparableItem(item);
    const after = comparableItem(next[index]);
    return (
      before.description !== after.description ||
      before.quantity !== after.quantity ||
      before.unitPrice !== after.unitPrice
    );
  });
}

export function completedAtAfterOrderSave(
  existing: ComparableOrderRow | null,
  changed: boolean,
  now: string,
) {
  if (!existing) return null;
  if (String(existing.order_status || "active") !== "completed") {
    return existing.completed_at ?? null;
  }
  return changed ? now : existing.completed_at ?? null;
}
