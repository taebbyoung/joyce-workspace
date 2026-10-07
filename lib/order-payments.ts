type PaymentRow = Record<string, unknown>;

export type EditorOrderPayment = {
  id: string;
  orderId: string;
  paymentType: string;
  paymentDate: string;
  amount: unknown;
  sortOrder: number;
  legacyMetadata: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};

function paymentText(value: unknown) {
  return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value);
}

export function normalizeOrderPayment(row: PaymentRow, fallbackSortOrder = 0): EditorOrderPayment {
  const sortOrder = Number(row.sortOrder ?? row.sort_order ?? fallbackSortOrder);
  return {
    id: paymentText(row.id),
    orderId: paymentText(row.orderId ?? row.order_id),
    paymentType: paymentText(row.paymentType ?? row.payment_type),
    paymentDate: paymentText(row.paymentDate ?? row.payment_date).slice(0, 10),
    amount: row.amount ?? "",
    sortOrder: Number.isFinite(sortOrder) ? sortOrder : fallbackSortOrder,
    legacyMetadata: row.legacyMetadata ?? row.legacy_metadata,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
  };
}

export function normalizeOrderPayments(value: unknown): EditorOrderPayment[] | null {
  if (!Array.isArray(value)) return null;
  const payments = value.map((entry, index) =>
    normalizeOrderPayment(entry && typeof entry === "object" ? entry as PaymentRow : {}, index),
  );
  return payments.every((payment) =>
    payment.id &&
    ["deposit", "balance"].includes(payment.paymentType) &&
    /^\d{4}-\d{2}-\d{2}$/.test(payment.paymentDate),
  ) ? payments : null;
}
