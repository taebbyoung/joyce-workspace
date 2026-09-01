export const orderImportFields = [
  { key: "orderNo", label: "订单号", aliases: ["订单号", "订单编号", "order no", "orderno", "order number"] },
  { key: "piNo", label: "PI号", aliases: ["pi号", "pi no", "pino", "pi number"] },
  { key: "orderDate", label: "下单日期", aliases: ["下单日期", "订单日期", "order date", "date"] },
  { key: "customerCode", label: "客户代码", aliases: ["客户代码", "客户编号", "customer code", "customercode"] },
  { key: "customerName", label: "客户名称", aliases: ["客户", "客户名称", "customer", "customer name", "company"] },
  { key: "country", label: "国家", aliases: ["国家", "country", "market"] },
  { key: "model", label: "车型", aliases: ["车型", "型号", "产品型号", "model", "product", "product model", "vehicle model"] },
  { key: "quantity", label: "数量", aliases: ["数量", "qty", "quantity"] },
  { key: "unitPrice", label: "单价", aliases: ["单价", "unit price", "price"] },
  { key: "originalCurrency", label: "原始币种", aliases: ["币种", "currency", "original currency"] },
  { key: "originalAmount", label: "总金额（USD）", aliases: ["金额", "订单总金额", "总金额", "总金额usd", "总金额（usd）", "总金额(usd)", "amount", "original amount", "usd amount", "total amount usd"] },
  { key: "fixedExchangeRateToCny", label: "固定汇率", aliases: ["汇率", "固定汇率", "exchange rate", "rate"] },
  { key: "cnyAmount", label: "CNY金额", aliases: ["人民币金额", "rmb amount", "cny amount", "cny金额"] },
  { key: "otherCosts", label: "其他费用", aliases: ["其他费用", "杂费", "other costs", "other fees"] },
  { key: "paymentStatus", label: "付款状态", aliases: ["付款状态", "payment", "payment status"] },
  { key: "depositAmount", label: "预付款金额", aliases: ["预付款", "预付款金额", "定金", "定金金额", "deposit", "deposit amount"] },
  { key: "depositDate", label: "预付款日期", aliases: ["预付款日期", "定金日期", "deposit date"] },
  { key: "balanceAmount", label: "尾款金额", aliases: ["尾款", "尾款金额", "balance", "balance amount"] },
  { key: "balanceDate", label: "尾款日期", aliases: ["尾款日期", "balance date"] },
  { key: "balanceExpectedDate", label: "尾款预计日期", aliases: ["尾款预计日期", "balance expected", "balance due"] },
  { key: "balanceReceivedDate", label: "货款收清日期", aliases: ["货款收清日期", "尾款到账日期", "full payment received", "balance received"] },
  { key: "productionStatus", label: "生产状态", aliases: ["生产状态", "production", "production status"] },
  { key: "shipmentStatus", label: "运输状态", aliases: ["运输状态", "发货状态", "shipment", "shipment status"] },
  { key: "expectedShippingDate", label: "发货日期", aliases: ["发货日期", "预计发货日期", "实际发货日期", "shipping date", "estimated shipping date", "expected shipping date"] },
  { key: "blNumber", label: "提单号", aliases: ["提单号", "bl号", "bl no", "bl number", "bill of lading"] },
  { key: "vessel", label: "船名", aliases: ["船名", "vessel"] },
  { key: "voyage", label: "航次", aliases: ["航次", "voyage"] },
  { key: "estimatedDeliveryDate", label: "预计客户收货日期", aliases: ["预计客户收货日期", "estimated delivery date", "customer delivery date"] },
  { key: "risk", label: "风险", aliases: ["风险", "risk", "risks"] },
  { key: "notes", label: "备注", aliases: ["备注", "notes", "remark", "comments"] },
] as const;

export const primaryOrderImportFieldKeys = new Set<string>([
  "orderNo", "customerCode", "model", "quantity", "unitPrice", "originalAmount",
  "depositDate", "depositAmount", "expectedShippingDate", "balanceDate", "balanceAmount",
  "balanceReceivedDate", "shipmentStatus", "orderDate",
]);

export function normalizeOrderImportHeader(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .toLowerCase()
    .replace(/[\s_\-—–/\\()[\]（）.:：]+/g, "");
}

export function autoMapOrderHeaders(headers: string[]) {
  const result: Record<string, string> = {};
  for (const field of orderImportFields) {
    const aliases = [field.label, ...field.aliases].map(normalizeOrderImportHeader);
    const match = headers.find((header) => aliases.includes(normalizeOrderImportHeader(header)));
    if (match) result[field.key] = match;
  }
  return result;
}

export function findOrderImportHeaderRow(matrix: unknown[][], maxRows = 20) {
  let best: { index: number; headers: string[]; mapping: Record<string, string> } | null = null;
  for (let index = 0; index < Math.min(matrix.length, maxRows); index += 1) {
    const headers = (matrix[index] || []).map((value, column) => {
      const label = String(value ?? "").trim();
      return label || `未命名列 ${column + 1}`;
    });
    const mapping = autoMapOrderHeaders(headers);
    if (!best || Object.keys(mapping).length > Object.keys(best.mapping).length) {
      best = { index, headers, mapping };
    }
  }
  if (!best || Object.keys(best.mapping).length === 0) {
    throw new Error("没有识别到可匹配的订单表头。");
  }
  return best;
}
