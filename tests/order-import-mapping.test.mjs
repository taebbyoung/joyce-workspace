import assert from "node:assert/strict";
import test from "node:test";
import { autoMapOrderHeaders, findOrderImportHeaderRow } from "../lib/order-import-mapping.ts";

const workbookRows = [
  ["整车订单统计表"],
  ["序号", "订单号", "客户代码", "车型", "数量", "单价", "总金额（USD）", "预付款日期", "预付款金额", "发货日期", "尾款日期", "尾款金额", "货款收清日期", "运输状态", "下单日期"],
  [1, "W24063", "GR04", "ADV", 36, 2600, 93600, "2025.2.4", 28056, "2025.4.14", "2025.5.27", 65520, "2025.5.27", "已签收", "2024.12.18"],
];

test("uses the real header row after a workbook title and maps every current order column", () => {
  const result = findOrderImportHeaderRow(workbookRows);
  assert.equal(result.index, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(result.mapping).filter(([key]) => [
    "orderNo", "customerCode", "model", "quantity", "unitPrice", "originalAmount",
    "depositDate", "depositAmount", "expectedShippingDate", "balanceDate", "balanceAmount",
    "balanceReceivedDate", "shipmentStatus", "orderDate",
  ].includes(key))), {
    orderNo: "订单号", customerCode: "客户代码", model: "车型", quantity: "数量", unitPrice: "单价",
    originalAmount: "总金额（USD）", depositDate: "预付款日期", depositAmount: "预付款金额",
    expectedShippingDate: "发货日期", balanceDate: "尾款日期", balanceAmount: "尾款金额",
    balanceReceivedDate: "货款收清日期", shipmentStatus: "运输状态", orderDate: "下单日期",
  });
});

test("normalizes full-width punctuation, whitespace, and English aliases", () => {
  const mapping = autoMapOrderHeaders(["  Order Number  ", "Vehicle Model", "总金额 ( USD )", "  货款收清 日期  "]);
  assert.equal(mapping.orderNo, "  Order Number  ");
  assert.equal(mapping.model, "Vehicle Model");
  assert.equal(mapping.originalAmount, "总金额 ( USD )");
  assert.equal(mapping.balanceReceivedDate, "  货款收清 日期  ");
});
