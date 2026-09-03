import { ensureWorkspace, getD1 } from "@/db/runtime";
import {
  groupOrderImportRows,
  importText,
  type ImportRow,
} from "@/lib/order-import";

export const runtime = "edge";

const paymentAliases: Record<string, string> = {
  unpaid: "unpaid", 未收款: "unpaid", partial_payment: "partial_payment", 部分付款: "partial_payment",
  deposit_received: "deposit_received", 已收定金: "deposit_received", 定金已收: "deposit_received",
  balance_pending: "balance_pending", 尾款待收: "balance_pending",
  fully_paid: "fully_paid", 已付清: "fully_paid", 全款已收: "fully_paid",
};
const shipmentAliases: Record<string, string> = {
  not_arranged: "not_arranged", 未安排: "not_arranged", 未发货: "not_arranged",
  arranged: "arranged", 已安排: "arranged", 待订舱: "arranged", 已订舱: "arranged",
  ready_to_ship: "ready_to_ship", 待发货: "ready_to_ship",
  shipped: "in_transit", 已发货: "in_transit", in_transit: "in_transit", 运输中: "in_transit",
  arrived: "arrived", 已到港: "arrived", 已到达: "arrived",
  delivered: "delivered", 已签收: "delivered", completed: "delivered", 已完成: "delivered",
};

function errorResponse(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function mappedStatus(value: string, aliases: Record<string, string>, fallback: string) {
  const raw = importText(value, 100);
  if (!raw) return fallback;
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");
  return aliases[raw] ?? aliases[normalized] ?? null;
}

async function validateGroups(sourceRows: ImportRow[]) {
  const db = getD1();
  const [customersResult, ordersResult] = await Promise.all([
    db.prepare(`SELECT id, customer_code, company, country FROM customers
      WHERE deleted_at IS NULL AND trim(COALESCE(customer_code, '')) <> ''`).all<Record<string, unknown>>(),
    db.prepare("SELECT order_no FROM orders WHERE deleted_at IS NULL").all<Record<string, unknown>>(),
  ]);
  const customers = new Map<string, Record<string, unknown>[]>();
  for (const customer of customersResult.results) {
    const code = importText(customer.customer_code, 40).toUpperCase();
    customers.set(code, [...(customers.get(code) ?? []), customer]);
  }
  const existingOrderNos = new Set(ordersResult.results.map((order) => importText(order.order_no, 100).toUpperCase()).filter(Boolean));
  const fileOrderNos = new Set<string>();

  return groupOrderImportRows(sourceRows).map((group) => {
    const issues = [...new Set(group.issues)];
    const orderKey = group.orderNo.toUpperCase();
    const customerCode = group.customerCode.toUpperCase();
    const matches = customers.get(customerCode) ?? [];
    const currency = importText(group.originalCurrency, 10).toUpperCase() || "USD";
    const shipmentStatus = mappedStatus(group.shipmentStatus, shipmentAliases, "not_arranged");
    const paymentStatus = mappedStatus(group.paymentStatus, paymentAliases, "unpaid");

    if (!group.orderNo) issues.push("missing_order_no");
    if (!customerCode) issues.push("missing_customer_code");
    else if (!matches.length) issues.push("customer_code_not_found");
    else if (matches.length > 1) issues.push("duplicate_customer_code");
    if (orderKey && existingOrderNos.has(orderKey)) issues.push("duplicate_existing_order");
    if (orderKey && fileOrderNos.has(orderKey)) issues.push("duplicate_in_file");
    if (orderKey) fileOrderNos.add(orderKey);
    if (group.originalAmount === null || group.originalAmount < 0) issues.push("invalid_amount");
    if (group.shipmentStatus && !shipmentStatus) issues.push("invalid_shipment_status");
    if (group.paymentStatus && !paymentStatus) issues.push("invalid_payment_status");
    if (currency !== "CNY" && currency !== "RMB" &&
      (!group.fixedExchangeRateToCny || group.fixedExchangeRateToCny <= 0) &&
      (group.cnyAmount === null || group.cnyAmount < 0)) issues.push("missing_exchange_rate");

    const customer = matches.length === 1 ? matches[0] : null;
    const blocking = issues.filter((issue) => issue !== "missing_exchange_rate");
    return {
      ...group,
      rowNumber: group.rowNumbers[0],
      customerCode,
      customerId: customer?.id ?? null,
      customerName: customer?.company ?? null,
      country: customer?.country ?? null,
      originalCurrency: currency,
      paymentStatus: paymentStatus ?? "unpaid",
      shipmentStatus: shipmentStatus ?? "not_arranged",
      issues: [...new Set(issues)],
      ready: blocking.length === 0,
    };
  });
}

type ValidatedRow = Awaited<ReturnType<typeof validateGroups>>[number];

function statementsForOrder(
  db: D1Database,
  row: ValidatedRow,
  batchId: string,
  now: string,
  openSortOrder: number,
) {
  const id = crypto.randomUUID();
  const rate = row.originalCurrency === "CNY" || row.originalCurrency === "RMB"
    ? 1
    : row.fixedExchangeRateToCny ?? (row.cnyAmount !== null && row.originalAmount ? row.cnyAmount / row.originalAmount : null);
  const cnyAmount = row.cnyAmount ?? (rate && row.originalAmount !== null ? row.originalAmount * rate : null);
  const confirmed = row.originalAmount !== null && cnyAmount !== null;
  const items = row.items;
  return [
    db.prepare(`INSERT INTO orders (
      id, customer_id, customer_code, customer_name, order_no, pi_no, order_date, country,
      model, quantity, original_currency, original_amount, fixed_exchange_rate_to_cny, cny_amount,
      currency_status, payment_status, balance_received_date, shipment_status, expected_shipping_date,
      estimated_delivery_date, open_sort_order, import_batch_id, source_type, legacy_metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'excel_import', ?, ?, ?)`).bind(
      id, row.customerId, row.customerCode, row.customerName, row.orderNo, row.piNo,
      row.orderDate, row.country, items.map((item) => item.description).join("；").slice(0, 300) || null,
      items.reduce((sum, item) => sum + Number(item.quantity || 0), 0) || null,
      row.originalCurrency, row.originalAmount, rate, cnyAmount,
      confirmed ? "confirmed" : "needs_confirmation", row.paymentStatus, row.balanceReceivedDate,
      row.shipmentStatus, row.expectedShippingDate, row.estimatedDeliveryDate, openSortOrder, batchId,
      JSON.stringify({ importRowNumbers: row.rowNumbers, importedAt: now, warnings: row.issues }), now, now,
    ),
    ...items.map((item, index) => db.prepare(`INSERT INTO order_items
      (id, order_id, description, quantity, unit_price, legacy_metadata)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(
      crypto.randomUUID(), id, item.description, item.quantity, item.unitPrice,
      JSON.stringify({ importRowNumber: item.rowNumber, sortOrder: index }),
    )),
    ...row.payments.map((payment, index) => db.prepare(`INSERT INTO order_payments
      (id, order_id, payment_type, payment_date, amount, sort_order, legacy_metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      crypto.randomUUID(), id, payment.paymentType, payment.paymentDate, payment.amount, index,
      JSON.stringify({ importRowNumber: payment.rowNumber }), now, now,
    )),
  ];
}

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const payload = await request.json() as Record<string, unknown>;
    const action = importText(payload.action, 30);
    const sourceRows = Array.isArray(payload.rows) ? payload.rows.slice(0, 500) as ImportRow[] : [];
    if (!sourceRows.length) return errorResponse("没有可预览的订单行。");
    const rows = await validateGroups(sourceRows);
    const readyRows = rows.filter((row) => row.ready);
    const reviewRows = rows.filter((row) => !row.ready);

    if (action === "preview") {
      return Response.json({ rows, summary: {
        total: rows.length, ready: readyRows.length, needsReview: reviewRows.length,
        missingCustomerCodes: rows.filter((row) => row.issues.includes("missing_customer_code")).length,
        unknownCustomerCodes: rows.filter((row) => row.issues.includes("customer_code_not_found")).length,
        currencyProblems: rows.filter((row) => row.issues.includes("missing_exchange_rate")).length,
      } });
    }
    if (action !== "confirm") return errorResponse("未知导入操作。");
    if (reviewRows.length) return errorResponse("请先处理预览中的错误订单，避免部分导入。");
    if (!readyRows.length) return errorResponse("没有可安全导入的订单。");
    const db = getD1();
    const now = new Date().toISOString();
    const batchId = crypto.randomUUID();
    const currentMinimum = await db.prepare(`SELECT COALESCE(MIN(open_sort_order), 0) AS value
      FROM orders
      WHERE deleted_at IS NULL AND COALESCE(order_status, 'active') <> 'completed'`).first<{ value: number }>();
    const minimumPosition = Number(currentMinimum?.value ?? 0);
    for (const [index, row] of readyRows.entries()) {
      await db.batch(statementsForOrder(
        db,
        row,
        batchId,
        now,
        minimumPosition - (readyRows.length - index) * 100,
      ));
    }
    await db.prepare(`INSERT INTO audit_logs
      (id, action, entity_type, entity_id, after_data, source)
      VALUES (?, 'orders_imported', 'order_import', ?, ?, 'excel_import')`).bind(
      crypto.randomUUID(), batchId,
      JSON.stringify({ imported: readyRows.length, rowNumbers: readyRows.flatMap((row) => row.rowNumbers) }),
    ).run();
    return Response.json({ ok: true, batchId, imported: readyRows.length, skipped: 0 });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "订单导入失败。", 500);
  }
}
