type OrderSalesImpactValues = Record<string, unknown> | null | undefined;

function field(
  values: OrderSalesImpactValues,
  camelCase: string,
  snakeCase: string,
) {
  return values?.[camelCase] ?? values?.[snakeCase];
}

function normalizedNumber(value: unknown) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedCurrency(value: unknown) {
  const currency = String(value ?? "").trim().toUpperCase();
  return currency === "RMB" ? "CNY" : currency;
}

export function orderSalesImpactSnapshot(values: OrderSalesImpactValues) {
  const currency = normalizedCurrency(
    field(values, "originalCurrency", "original_currency"),
  );
  return {
    currency,
    originalAmount: normalizedNumber(
      field(values, "originalAmount", "original_amount"),
    ),
    fixedExchangeRateToCny:
      currency === "CNY"
        ? 1
        : normalizedNumber(
            field(
              values,
              "fixedExchangeRateToCny",
              "fixed_exchange_rate_to_cny",
            ),
          ),
  };
}

export function requiresOrderSalesImpactConfirmation(
  original: OrderSalesImpactValues,
  draft: OrderSalesImpactValues,
) {
  if (!original) return true;
  const before = orderSalesImpactSnapshot(original);
  const after = orderSalesImpactSnapshot(draft);
  return (
    before.currency !== after.currency ||
    before.originalAmount !== after.originalAmount ||
    before.fixedExchangeRateToCny !== after.fixedExchangeRateToCny
  );
}
