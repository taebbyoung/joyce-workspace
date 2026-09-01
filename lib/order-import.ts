export type ImportRow = Record<string, unknown>;

export type ImportedPayment = {
  paymentType: "deposit" | "balance";
  paymentDate: string;
  amount: number;
  rowNumber: number;
};

export type ImportedOrderItem = {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  rowNumber: number;
};

export type ImportedOrderGroup = {
  rowNumbers: number[];
  orderNo: string;
  piNo: string | null;
  customerCode: string;
  orderDate: string | null;
  originalCurrency: string;
  originalAmount: number | null;
  fixedExchangeRateToCny: number | null;
  cnyAmount: number | null;
  paymentStatus: string;
  balanceReceivedDate: string | null;
  shipmentStatus: string;
  expectedShippingDate: string | null;
  estimatedDeliveryDate: string | null;
  items: ImportedOrderItem[];
  payments: ImportedPayment[];
  issues: string[];
};

export function importText(value: unknown, max = 5000) {
  if (value === null || value === undefined) return "";
  const result = String(value).trim().slice(0, max);
  return result === "/" ? "" : result;
}

export function importNumber(value: unknown) {
  const raw = importText(value, 100);
  if (!raw) return null;
  const normalized = raw.replace(/[,$￥¥€£\s]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function importDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString().slice(0, 10);
  }
  const raw = importText(value, 40);
  if (!raw) return null;
  const yearFirst = raw.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:\s|$)/);
  if (yearFirst) {
    const [, year, month, day] = yearFirst;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const date = new Date(raw);
  if (!Number.isNaN(date.valueOf()) && /^\d{1,2}[./-]\d{1,2}[./-]\d{4}/.test(raw)) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  return null;
}

function hasValue(row: ImportRow, keys: string[]) {
  return keys.some((key) => importText(row[key]));
}

function conflict(group: ImportedOrderGroup, key: keyof ImportedOrderGroup, next: unknown) {
  const value = typeof next === "number" ? next : importText(next);
  if (value === "" || value === null) return;
  const current = group[key];
  if (current === null || current === "" || current === undefined) {
    (group as Record<string, unknown>)[key] = value;
  } else if (String(current) !== String(value)) {
    group.issues.push("conflicting_order_field");
  }
}

const orderLevelFields: Array<[keyof ImportedOrderGroup, string, "text" | "date" | "number"]> = [
  ["customerCode", "customerCode", "text"],
  ["piNo", "piNo", "text"],
  ["orderDate", "orderDate", "date"],
  ["originalCurrency", "originalCurrency", "text"],
  ["originalAmount", "originalAmount", "number"],
  ["fixedExchangeRateToCny", "fixedExchangeRateToCny", "number"],
  ["cnyAmount", "cnyAmount", "number"],
  ["paymentStatus", "paymentStatus", "text"],
  ["balanceReceivedDate", "balanceReceivedDate", "date"],
  ["shipmentStatus", "shipmentStatus", "text"],
  ["expectedShippingDate", "expectedShippingDate", "date"],
  ["estimatedDeliveryDate", "estimatedDeliveryDate", "date"],
];

function appendRow(group: ImportedOrderGroup, row: ImportRow) {
  const rowNumber = Number(row.rowNumber) || 0;
  group.rowNumbers.push(rowNumber);
  for (const [key, source, type] of orderLevelFields) {
    const value = type === "number"
      ? importNumber(row[source])
      : type === "date"
        ? importDate(row[source])
        : importText(row[source]);
    if (importText(row[source]) && value === null) group.issues.push("invalid_date");
    conflict(group, key, value);
  }

  const description = importText(row.model, 300);
  const hasItem = hasValue(row, ["model", "quantity", "unitPrice"]);
  if (hasItem) {
    const quantity = importNumber(row.quantity);
    const unitPrice = importNumber(row.unitPrice);
    if (!description || quantity === null || unitPrice === null) {
      group.issues.push("invalid_product_item");
    } else {
      group.items.push({ description, quantity, unitPrice, rowNumber });
    }
  }

  for (const [paymentType, dateKey, amountKey] of [
    ["deposit", "depositDate", "depositAmount"],
    ["balance", "balanceDate", "balanceAmount"],
  ] as const) {
    const rawDate = importText(row[dateKey]);
    const rawAmount = importText(row[amountKey]);
    if (!rawDate && !rawAmount) continue;
    const paymentDate = importDate(row[dateKey]);
    const amount = importNumber(row[amountKey]);
    if (!paymentDate || amount === null || amount < 0) {
      group.issues.push("invalid_payment_record");
    } else {
      group.payments.push({ paymentType, paymentDate, amount, rowNumber });
    }
  }
}

export function groupOrderImportRows(rows: ImportRow[]) {
  const groups: ImportedOrderGroup[] = [];
  let current: ImportedOrderGroup | null = null;
  for (const row of rows.slice(0, 500)) {
    const orderNo = importText(row.orderNo, 100);
    if (orderNo) {
      current = {
        rowNumbers: [], orderNo, piNo: null, customerCode: "", orderDate: null,
        originalCurrency: "USD", originalAmount: null, fixedExchangeRateToCny: null,
        cnyAmount: null, paymentStatus: "", balanceReceivedDate: null,
        shipmentStatus: "", expectedShippingDate: null, estimatedDeliveryDate: null,
        items: [], payments: [], issues: [],
      };
      groups.push(current);
      appendRow(current, row);
      continue;
    }
    const isContinuation = hasValue(row, [
      "model", "quantity", "unitPrice", "depositDate", "depositAmount", "balanceDate", "balanceAmount",
      "customerCode", "originalAmount", "balanceReceivedDate", "shipmentStatus", "expectedShippingDate",
    ]);
    if (!isContinuation) continue;
    if (!current) {
      groups.push({
        rowNumbers: [Number(row.rowNumber) || 0], orderNo: "", piNo: null, customerCode: "", orderDate: null,
        originalCurrency: "USD", originalAmount: null, fixedExchangeRateToCny: null,
        cnyAmount: null, paymentStatus: "", balanceReceivedDate: null,
        shipmentStatus: "", expectedShippingDate: null, estimatedDeliveryDate: null,
        items: [], payments: [], issues: ["orphan_continuation_row", "missing_order_no"],
      });
      continue;
    }
    appendRow(current, row);
  }
  return groups;
}
