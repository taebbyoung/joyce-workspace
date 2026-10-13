type PaymentAmount = {
  amount?: unknown;
};

export type OrderPaymentSummary = {
  total: number | null;
  received: number;
  pending: number | null;
  overpaid: number | null;
  status: "missing_total" | "pending" | "settled" | "overpaid";
};

function moneyValue(value: unknown) {
  if (value === "" || value === null || value === undefined) return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function getOrderPaymentSummary({
  orderAmount,
  payments,
}: {
  orderAmount: unknown;
  payments: PaymentAmount[];
}): OrderPaymentSummary {
  const totalValue = moneyValue(orderAmount);
  const total = totalValue === null ? null : roundMoney(totalValue);
  const received = roundMoney(payments.reduce((sum, payment) => {
    const amount = moneyValue(payment.amount);
    return sum + (amount === null ? 0 : amount);
  }, 0));

  if (total === null) {
    return { total, received, pending: null, overpaid: null, status: "missing_total" };
  }
  if (received > total) {
    return {
      total,
      received,
      pending: null,
      overpaid: roundMoney(received - total),
      status: "overpaid",
    };
  }
  const pending = roundMoney(total - received);
  return {
    total,
    received,
    pending,
    overpaid: null,
    status: pending === 0 ? "settled" : "pending",
  };
}
