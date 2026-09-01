import assert from "node:assert/strict";
import test from "node:test";
import { groupOrderImportRows, importDate, importText } from "../lib/order-import.ts";

test("groups continuation rows into one order with every vehicle and payment", () => {
  const groups = groupOrderImportRows([
    {
      rowNumber: 2, orderNo: "W24063", customerCode: "GR04", model: "ADV", quantity: "36", unitPrice: "2600",
      originalAmount: "93600", originalCurrency: "USD", depositDate: "2024.12.17", depositAmount: "14988",
      expectedShippingDate: "2025.4.14", balanceReceivedDate: "2025.5.27", shipmentStatus: "已签收",
    },
    { rowNumber: 3, model: "iTank", quantity: "6", unitPrice: "2800", depositDate: "2025.2.24", depositAmount: "13068" },
    { rowNumber: 4, model: "iTango", quantity: "4", unitPrice: "3000", balanceDate: "2025.4.8", balanceAmount: "30000" },
    { rowNumber: 5, balanceDate: "2025.5.27", balanceAmount: "35520" },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].orderNo, "W24063");
  assert.deepEqual(groups[0].items.map((item) => item.description), ["ADV", "iTank", "iTango"]);
  assert.deepEqual(groups[0].payments.map((payment) => [payment.paymentType, payment.paymentDate, payment.amount]), [
    ["deposit", "2024-12-17", 14988], ["deposit", "2025-02-24", 13068],
    ["balance", "2025-04-08", 30000], ["balance", "2025-05-27", 35520],
  ]);
  assert.equal(groups[0].originalAmount, 93600);
  assert.equal(groups[0].balanceReceivedDate, "2025-05-27");
});

test("normalizes slash and skips empty template rows", () => {
  const groups = groupOrderImportRows([
    { rowNumber: 2, orderNo: "W1", customerCode: "GR04", originalAmount: "100", model: "ADV", quantity: "1", unitPrice: "100", balanceDate: "/", balanceAmount: "/" },
    { rowNumber: 3, serial: "99" },
  ]);
  assert.equal(importText("/"), "");
  assert.equal(importDate("2025.2.4"), "2025-02-04");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].payments.length, 0);
});

test("flags invalid partial payment and conflicting order fields", () => {
  const groups = groupOrderImportRows([
    { rowNumber: 2, orderNo: "W2", customerCode: "GR04", originalAmount: "100", model: "ADV", quantity: "1", unitPrice: "100", depositDate: "2025-01-01" },
    { rowNumber: 3, originalAmount: "120" },
  ]);
  assert.ok(groups[0].issues.includes("invalid_payment_record"));
  assert.ok(groups[0].issues.includes("conflicting_order_field"));
});
