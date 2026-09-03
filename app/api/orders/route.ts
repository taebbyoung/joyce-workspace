import { ensureWorkspace, getD1 } from "@/db/runtime";
import {
  completedAtAfterOrderSave,
  hasOrderItemChanges,
  hasStoredOrderChanges,
} from "@/lib/order-change";
import { refreshOrderRisks } from "@/lib/order-risk";
import { requiresOrderSalesImpactConfirmation } from "@/lib/order-sales-impact";

export const runtime = "edge";

const paymentStatuses = new Set([
  "deposit_received",
  "balance_pending",
  "fully_paid",
  "abnormal",
  // Accepted only to preserve imported legacy records during editing.
  "unpaid",
  "partial_payment",
]);
const productionStatuses = new Set([
  "not_scheduled",
  "production_started",
  "inspection",
  "production_completed",
  "ready_to_ship",
  "cancelled",
]);
const shipmentStatuses = new Set([
  "not_arranged",
  "arranged",
  "ready_to_ship",
  "in_transit",
  "arrived",
  "delivered",
  // Accepted only to preserve legacy abnormal records during editing.
  "abnormal",
]);
const shippingMethods = new Set([
  "sea_freight",
  "air_freight",
  "express",
  "domestic",
  "pickup",
  "other",
]);

const persistedOrderFields = [
  "customer_id",
  "customer_code",
  "customer_name",
  "order_no",
  "pi_no",
  "order_date",
  "country",
  "model",
  "quantity",
  "original_currency",
  "original_amount",
  "fixed_exchange_rate_to_cny",
  "cny_amount",
  "other_costs",
  "currency_status",
  "payment_status",
  "deposit_amount",
  "deposit_date",
  "balance_amount",
  "balance_expected_date",
  "balance_received_date",
  "production_status",
  "shipment_status",
  "order_status",
  "completed_at",
  "expected_shipping_date",
  "estimated_delivery_date",
  "progress_next_step",
  "container_number",
  "bl_number",
  "forwarder",
  "vessel",
  "voyage",
  "etd",
  "eta",
  "port",
  "port_of_loading",
  "port_of_discharge",
  "shipping_company",
  "shipping_method",
  "awb_number",
  "carrier_company",
  "tracking_number",
  "logistics_company",
  "logistics_number",
  "production_notes",
  "documents",
  "due_date",
  "risk",
  "notes",
  "import_batch_id",
  "source_type",
  "updated_at",
] as const;

const editableOrderFields = persistedOrderFields.filter(
  (field) => !["order_status", "completed_at", "updated_at"].includes(field),
);

const statusAliases: Record<string, string> = {
  未收款: "unpaid",
  部分付款: "partial_payment",
  已收定金: "deposit_received",
  定金已收: "deposit_received",
  尾款待收: "balance_pending",
  已付清: "fully_paid",
  全款已收: "fully_paid",
  异常: "abnormal",
  未排产: "not_scheduled",
  生产中: "production_started",
  已投产: "production_started",
  生产完成: "production_completed",
  已完工: "production_completed",
  验货: "inspection",
  待发货: "ready_to_ship",
  已取消: "cancelled",
  未安排: "not_arranged",
  未发货: "not_arranged",
  待订舱: "arranged",
  已订舱: "arranged",
  已安排: "arranged",
  booking_pending: "arranged",
  booked: "arranged",
  已发货: "in_transit",
  运输中: "in_transit",
  已到港: "arrived",
  已到达: "arrived",
  已签收: "delivered",
  已完成: "delivered",
};

function text(value: unknown, max = 5000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function nullable(value: unknown, max = 5000) {
  return text(value, max) || null;
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const normalized =
    typeof value === "string" ? value.replace(/[,\s￥¥$€£]/g, "") : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStatus(
  value: unknown,
  allowed: Set<string>,
  fallback: string,
) {
  const raw = text(value, 100);
  const normalized = statusAliases[raw] ?? raw;
  return allowed.has(normalized) ? normalized : fallback;
}

function documentJson(value: unknown) {
  if (Array.isArray(value)) {
    return JSON.stringify(
      value.map((item) => text(item, 300)).filter(Boolean).slice(0, 100),
    );
  }
  const raw = text(value, 10000);
  if (!raw) return "[]";
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return JSON.stringify(
        parsed.map((item) => text(item, 300)).filter(Boolean).slice(0, 100),
      );
    }
  } catch {
    // Manual comma/newline lists are supported below.
  }
  return JSON.stringify(
    raw
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 100),
  );
}

function errorResponse(message: string, status = 400, details: object = {}) {
  return Response.json({ error: message, ...details }, { status });
}

function orderItems(value: unknown) {
  if (!Array.isArray(value)) return null;
  return value
    .map((item) => {
      const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        id: text(row.id, 100) || crypto.randomUUID(),
        description: text(row.model ?? row.description, 300),
        quantity: numberOrNull(row.quantity),
        unitPrice: numberOrNull(row.unitPrice),
      };
    })
    .filter((item) => item.description)
    .slice(0, 100);
}

function dateOnly(value: unknown) {
  const valueText = text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valueText)) return null;
  return valueText;
}

function orderPayments(value: unknown) {
  if (!Array.isArray(value)) return null;
  const rows = value.map((entry, index) => {
    const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const paymentType = text(item.paymentType ?? item.payment_type, 20);
    const paymentDate = dateOnly(item.paymentDate ?? item.payment_date);
    const amount = numberOrNull(item.amount);
    if (!new Set(["deposit", "balance"]).has(paymentType) || !paymentDate || amount === null || amount < 0) {
      throw new Error("每笔预付款或尾款都必须填写有效日期和金额。");
    }
    return {
      id: text(item.id, 100) || crypto.randomUUID(),
      paymentType,
      paymentDate,
      amount,
      sortOrder: Number.isInteger(Number(item.sortOrder)) ? Number(item.sortOrder) : index,
    };
  });
  if (rows.length > 100) throw new Error("每张订单最多保存 100 笔付款记录。");
  return rows;
}

function hasOrderPaymentChanges(existing: Record<string, unknown>[], next: ReturnType<typeof orderPayments>) {
  if (!next) return false;
  const comparable = (items: Record<string, unknown>[]) => items.map((item, index) => ({
    id: String(item.id || ""),
    paymentType: String(item.payment_type ?? item.paymentType ?? ""),
    paymentDate: String(item.payment_date ?? item.paymentDate ?? "").slice(0, 10),
    amount: Number(item.amount),
    sortOrder: Number(item.sort_order ?? item.sortOrder ?? index),
  }));
  return JSON.stringify(comparable(existing)) !== JSON.stringify(comparable(next));
}

export async function GET() {
  try {
    await ensureWorkspace();
    const db = getD1();
    const results = await Promise.all([
      db.prepare(`SELECT * FROM orders WHERE deleted_at IS NULL
        ORDER BY
          CASE WHEN COALESCE(order_status, 'active') <> 'completed' AND open_sort_order IS NOT NULL THEN 0 ELSE 1 END,
          CASE WHEN COALESCE(order_status, 'active') <> 'completed' THEN open_sort_order END,
          COALESCE(order_date, created_at) DESC,
          id DESC
        LIMIT 300`).all<Record<string, unknown>>(),
      db.prepare("SELECT * FROM order_items ORDER BY order_id, rowid").all<Record<string, unknown>>(),
      db.prepare("SELECT * FROM order_payments ORDER BY order_id, payment_type, payment_date, sort_order, created_at").all<Record<string, unknown>>(),
      db.prepare("SELECT * FROM order_risks WHERE status = 'active' AND trigger_type <> 'shipment_delay' ORDER BY detected_at DESC LIMIT 500").all<Record<string, unknown>>(),
      db.prepare("SELECT * FROM order_status_history ORDER BY created_at DESC LIMIT 500").all<Record<string, unknown>>(),
      db.prepare("SELECT * FROM accessory_sales_totals ORDER BY sales_year DESC").all<Record<string, unknown>>(),
    ]);
    return Response.json({
      orders: results[0].results,
      orderItems: results[1].results,
      orderPayments: results[2].results,
      orderRisks: results[3].results,
      orderStatusHistory: results[4].results,
      accessorySales: results[5].results,
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "订单数据加载失败。", 500);
  }
}

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const payload = (await request.json()) as Record<string, unknown>;
    const action = text(payload.action, 40);
    const db = getD1();
    const now = new Date().toISOString();

    if (action === "save_accessory_sales") {
      const salesYear = Number(payload.salesYear);
      const amountCny = numberOrNull(payload.amountCny);
      if (!Number.isInteger(salesYear) || salesYear < 2000 || salesYear > 2200) {
        return errorResponse("请输入有效年份。");
      }
      if (amountCny === null || amountCny < 0) {
        return errorResponse("配件销售金额必须是大于或等于 0 的数字。");
      }
      const existingTotal = await db
        .prepare("SELECT id FROM accessory_sales_totals WHERE sales_year = ?")
        .bind(salesYear)
        .first<{ id: string }>();
      const id = existingTotal?.id || crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO accessory_sales_totals
            (id, sales_year, amount_cny, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(sales_year) DO UPDATE SET
             amount_cny = excluded.amount_cny,
             updated_at = excluded.updated_at`,
        )
        .bind(id, salesYear, amountCny, now, now)
        .run();
      const accessorySales = await db
        .prepare("SELECT * FROM accessory_sales_totals WHERE sales_year = ?")
        .bind(salesYear)
        .first<Record<string, unknown>>();
      return Response.json({ ok: true, accessorySales });
    }

    if (action === "acknowledge_risk") {
      const id = text(payload.id, 100);
      if (!id) return errorResponse("缺少提醒 ID。");
      const risk = await db
        .prepare("SELECT * FROM order_risks WHERE id = ? AND status = 'active'")
        .bind(id)
        .first<Record<string, unknown>>();
      if (!risk) return errorResponse("提醒不存在或已处理。", 404);
      const acknowledgedBy = text(payload.acknowledgedBy, 100) || "Joyce";
      await db.batch([
        db.prepare(
          `UPDATE order_risks SET status = 'acknowledged',
             acknowledged_at = ?, acknowledged_by = ?, updated_at = ?
           WHERE id = ?`,
        ).bind(now, acknowledgedBy, now, id),
        db.prepare(
          `INSERT INTO audit_logs
            (id, action, entity_type, entity_id, before_data, after_data, source)
           VALUES (?, 'order_risk_acknowledged', 'order_risk', ?, ?, ?, 'user')`,
        ).bind(
          crypto.randomUUID(),
          id,
          JSON.stringify(risk),
          JSON.stringify({ status: "acknowledged", acknowledgedAt: now, acknowledgedBy }),
        ),
      ]);
      return Response.json({
        ok: true,
        risk: { ...risk, status: "acknowledged", acknowledged_at: now, acknowledged_by: acknowledgedBy, updated_at: now },
      });
    }

    if (action === "archive") {
      const id = text(payload.id, 100);
      if (!id) return errorResponse("缺少订单 ID。");
      const before = await db
        .prepare("SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL")
        .bind(id)
        .first<Record<string, unknown>>();
      if (!before) return errorResponse("订单不存在。", 404);
      await db.batch([
        db
          .prepare(
            "UPDATE orders SET deleted_at = ?, updated_at = ? WHERE id = ?",
          )
          .bind(now, now, id),
        db
          .prepare(
            `INSERT INTO audit_logs
              (id, action, entity_type, entity_id, before_data, after_data, source)
             VALUES (?, 'order_archived', 'order', ?, ?, ?, 'user')`,
          )
          .bind(
            crypto.randomUUID(),
            id,
            JSON.stringify(before),
            JSON.stringify({ deletedAt: now }),
          ),
      ]);
      return Response.json({ ok: true, id });
    }

    if (action === "complete" || action === "reopen") {
      const id = text(payload.id, 100);
      if (!id) return errorResponse("缺少订单 ID。");
      const before = await db
        .prepare("SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL")
        .bind(id)
        .first<Record<string, unknown>>();
      if (!before) return errorResponse("订单不存在。", 404);
      const completedAt = action === "complete" ? now : null;
      const orderStatus = action === "complete" ? "completed" : "active";
      const reopenedSortOrder = action === "reopen"
        ? Number((await db.prepare(`SELECT COALESCE(MIN(open_sort_order), 0) - 100 AS value
            FROM orders
            WHERE deleted_at IS NULL AND COALESCE(order_status, 'active') <> 'completed'`)
          .first<{ value: number }>())?.value ?? -100)
        : null;
      await db.batch([
        db.prepare(
          `UPDATE orders SET order_status = ?, completed_at = ?,
            open_sort_order = CASE WHEN ? = 'reopen' THEN ? ELSE open_sort_order END,
            updated_at = ?
           WHERE id = ?`,
        ).bind(orderStatus, completedAt, action, reopenedSortOrder, now, id),
        db.prepare(
          `INSERT INTO audit_logs
            (id, action, entity_type, entity_id, before_data, after_data, source)
           VALUES (?, ?, 'order', ?, ?, ?, 'user')`,
        ).bind(
          crypto.randomUUID(),
          action === "complete" ? "order_completed" : "order_reopened",
          id,
          JSON.stringify(before),
          JSON.stringify({ orderStatus, completedAt }),
        ),
      ]);
      if (action === "complete") {
        await db.prepare(
          `UPDATE order_risks SET status = 'resolved', updated_at = ?
           WHERE order_id = ? AND status = 'active'`,
        ).bind(now, id).run();
      } else {
        await refreshOrderRisks(db, id);
      }
      const [order, orderRisks] = await Promise.all([
        db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first<Record<string, unknown>>(),
        db.prepare("SELECT * FROM order_risks WHERE order_id = ? AND status = 'active'").bind(id).all<Record<string, unknown>>(),
      ]);
      return Response.json({ ok: true, order, orderRisks: orderRisks.results });
    }

    if (action === "reorder_open") {
      const receivedIds = Array.isArray(payload.ids)
        ? payload.ids.map((id) => text(id, 100)).filter(Boolean)
        : [];
      const ids = [...new Set(receivedIds)];
      if (!ids.length || ids.length !== receivedIds.length || ids.length > 300) {
        return errorResponse("未完成订单排序数据无效。");
      }
      const activeOrders = await db.prepare(`SELECT id FROM orders
        WHERE deleted_at IS NULL AND COALESCE(order_status, 'active') <> 'completed'`).all<{ id: string }>();
      const activeIds = activeOrders.results.map((order) => String(order.id));
      if (
        activeIds.length !== ids.length ||
        activeIds.some((id) => !ids.includes(id))
      ) {
        return errorResponse("未完成订单列表已变化，请刷新后重试。", 409);
      }
      await db.batch(ids.map((id, index) =>
        db.prepare(`UPDATE orders SET open_sort_order = ?
          WHERE id = ? AND deleted_at IS NULL AND COALESCE(order_status, 'active') <> 'completed'`)
          .bind((index + 1) * 100, id),
      ));
      return Response.json({ ok: true, ids });
    }

    if (action === "save_payment" || action === "delete_payment") {
      const orderId = text(payload.orderId, 100);
      const paymentId = text(payload.paymentId, 100);
      if (!orderId) return errorResponse("缺少订单 ID。");
      const order = await db
        .prepare("SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL")
        .bind(orderId)
        .first<Record<string, unknown>>();
      if (!order) return errorResponse("订单不存在。", 404);
      if (action === "delete_payment") {
        if (!paymentId) return errorResponse("缺少付款记录 ID。");
        const result = await db.prepare("DELETE FROM order_payments WHERE id = ? AND order_id = ?")
          .bind(paymentId, orderId).run();
        if (!result.meta.changes) return errorResponse("付款记录不存在。", 404);
      } else {
        const paymentType = text(payload.paymentType, 20);
        const paymentDate = dateOnly(payload.paymentDate);
        const amount = numberOrNull(payload.amount);
        if (!new Set(["deposit", "balance"]).has(paymentType) || !paymentDate || amount === null || amount < 0) {
          return errorResponse("请填写有效的付款类型、日期和金额。");
        }
        const id = paymentId || crypto.randomUUID();
        if (paymentId) {
          const result = await db.prepare(`UPDATE order_payments
            SET payment_type = ?, payment_date = ?, amount = ?, updated_at = ?
            WHERE id = ? AND order_id = ?`).bind(paymentType, paymentDate, amount, now, id, orderId).run();
          if (!result.meta.changes) return errorResponse("付款记录不存在。", 404);
        } else {
          const nextSort = await db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM order_payments WHERE order_id = ?")
            .bind(orderId).first<{ value: number }>();
          await db.prepare(`INSERT INTO order_payments
            (id, order_id, payment_type, payment_date, amount, sort_order, legacy_metadata, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)`).bind(id, orderId, paymentType, paymentDate, amount, nextSort?.value ?? 0, now, now).run();
        }
      }
      const completedAt = String(order.order_status || "active") === "completed" ? now : order.completed_at ?? null;
      await db.prepare("UPDATE orders SET updated_at = ?, completed_at = ? WHERE id = ?")
        .bind(now, completedAt, orderId).run();
      const [updatedOrder, orderPayments, orderRisks] = await Promise.all([
        db.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first<Record<string, unknown>>(),
        db.prepare("SELECT * FROM order_payments WHERE order_id = ? ORDER BY payment_type, payment_date, sort_order, created_at")
          .bind(orderId).all<Record<string, unknown>>(),
        db.prepare("SELECT * FROM order_risks WHERE order_id = ? AND status = 'active'")
          .bind(orderId).all<Record<string, unknown>>(),
      ]);
      return Response.json({ ok: true, order: updatedOrder, orderPayments: orderPayments.results, orderRisks: orderRisks.results });
    }

    if (action !== "save") return errorResponse("未知订单操作。");
    const id = text(payload.id, 100) || crypto.randomUUID();
    const existing = await db
      .prepare("SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL")
      .bind(id)
      .first<Record<string, unknown>>();
    const requiresFinancialConfirmation =
      requiresOrderSalesImpactConfirmation(existing, payload);
    if (requiresFinancialConfirmation && payload.confirmFinancialRisk !== true) {
      return errorResponse("保存订单前必须确认金额与汇率影响。", 409);
    }
    const customerCode = text(payload.customerCode, 40).toUpperCase();
    if (!customerCode) {
      return errorResponse("客户代码不能为空；订单必须通过客户代码关联。");
    }
    const customer = await db
      .prepare(
        `SELECT id, customer_code, company, country
         FROM customers
         WHERE upper(trim(customer_code)) = ? AND deleted_at IS NULL
         LIMIT 2`,
      )
      .bind(customerCode)
      .all<Record<string, unknown>>();
    if (customer.results.length !== 1) {
      return errorResponse(
        customer.results.length
          ? `客户代码 ${customerCode} 存在重复，请先整理客户资料。`
          : `客户代码 ${customerCode} 未找到。`,
        409,
        { code: customer.results.length ? "duplicate_customer_code" : "customer_not_found" },
      );
    }

    const linkedCustomer = customer.results[0];
    const currency = text(payload.originalCurrency, 10).toUpperCase();
    const originalAmount = numberOrNull(payload.originalAmount);
    const exchangeRate =
      currency === "CNY" || currency === "RMB"
        ? 1
        : numberOrNull(payload.fixedExchangeRateToCny);
    const confirmed =
      Boolean(currency) &&
      originalAmount !== null &&
      originalAmount >= 0 &&
      exchangeRate !== null &&
      exchangeRate > 0;
    const cnyAmount = confirmed ? originalAmount * exchangeRate : null;
    const paymentStatus = normalizeStatus(
      payload.paymentStatus,
      paymentStatuses,
      "unpaid",
    );
    const productionStatus = normalizeStatus(
      payload.productionStatus,
      productionStatuses,
      "not_scheduled",
    );
    const shipmentStatus = normalizeStatus(
      payload.shipmentStatus,
      shipmentStatuses,
      "not_arranged",
    );
    const shippingMethod = shippingMethods.has(text(payload.shippingMethod, 40))
      ? text(payload.shippingMethod, 40)
      : null;
    const retained = (key: string, max = 300) =>
      payload[key] === undefined ? (existing?.[key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`)] ?? null) : nullable(payload[key], max);
    const items = orderItems(payload.items);
    const payments = orderPayments(payload.payments);
    const existingItems = existing && items
      ? await db
          .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid")
          .bind(id)
          .all<Record<string, unknown>>()
      : { results: [] as Record<string, unknown>[] };
    const existingPayments = existing
      ? await db
          .prepare("SELECT * FROM order_payments WHERE order_id = ? ORDER BY payment_type, payment_date, sort_order, created_at")
          .bind(id)
          .all<Record<string, unknown>>()
      : { results: [] as Record<string, unknown>[] };
    const itemsChanged = Boolean(
      items && (!existing || hasOrderItemChanges(existingItems.results, items)),
    );
    const paymentsChanged = Boolean(
      payments && (!existing || hasOrderPaymentChanges(existingPayments.results, payments)),
    );
    const modelSummary = items
      ? itemsChanged
        ? items.map((item) => item.description).join("；").slice(0, 300)
        : existing?.model ?? null
      : nullable(payload.model, 300);
    const totalQuantity = items
      ? itemsChanged
        ? items.reduce(
            (sum, item) => sum + (item.quantity === null ? 0 : item.quantity),
            0,
          )
        : numberOrNull(existing?.quantity)
      : numberOrNull(payload.quantity);
    const nextOrder: Record<string, unknown> = {
      customer_id: String(linkedCustomer.id),
      customer_code: customerCode,
      customer_name: String(linkedCustomer.company),
      order_no: nullable(payload.orderNo, 100),
      pi_no: nullable(payload.piNo, 100),
      order_date: nullable(payload.orderDate, 10),
      country: nullable(linkedCustomer.country, 100) || (existing?.country ?? null),
      model: modelSummary || null,
      quantity: items ? (items.length ? totalQuantity : null) : totalQuantity,
      original_currency: currency || null,
      original_amount: originalAmount,
      fixed_exchange_rate_to_cny: exchangeRate,
      cny_amount: cnyAmount,
      other_costs: numberOrNull(payload.otherCosts),
      currency_status: confirmed ? "confirmed" : "needs_confirmation",
      payment_status: paymentStatus,
      deposit_amount: numberOrNull(payload.depositAmount),
      deposit_date: nullable(payload.depositDate, 10),
      balance_amount: numberOrNull(payload.balanceAmount),
      balance_expected_date: nullable(payload.balanceExpectedDate, 10),
      balance_received_date: nullable(payload.balanceReceivedDate, 10),
      production_status: productionStatus,
      shipment_status: shipmentStatus,
      order_status: existing?.order_status ?? "active",
      completed_at: existing?.completed_at ?? null,
      expected_shipping_date: nullable(payload.expectedShippingDate, 10),
      estimated_delivery_date: nullable(payload.estimatedDeliveryDate, 10),
      progress_next_step: nullable(payload.progressNextStep, 5000),
      container_number: retained("containerNumber", 100),
      bl_number: retained("blNumber", 100),
      forwarder: retained("forwarder", 300),
      vessel: retained("vessel", 300),
      voyage: retained("voyage", 100),
      etd: retained("etd", 10),
      eta: retained("eta", 10),
      port: payload.port === undefined ? (existing?.port ?? null) : nullable(payload.port, 300),
      port_of_loading: retained("portOfLoading", 300),
      port_of_discharge: retained("portOfDischarge", 300),
      shipping_company: retained("shippingCompany", 300),
      shipping_method: shippingMethod,
      awb_number: retained("awbNumber", 100),
      carrier_company: retained("carrierCompany", 300),
      tracking_number: retained("trackingNumber", 100),
      logistics_company: retained("logisticsCompany", 300),
      logistics_number: retained("logisticsNumber", 100),
      production_notes: nullable(payload.productionNotes, 10000),
      documents: payload.documents === undefined
        ? existing
          ? existing.documents ?? null
          : "[]"
        : documentJson(payload.documents),
      due_date: retained("dueDate", 10),
      risk: nullable(payload.risk, 5000),
      notes: nullable(payload.notes, 20000),
      import_batch_id: existing ? existing.import_batch_id ?? null : null,
      source_type: existing ? existing.source_type ?? null : "manual",
      updated_at: now,
    };
    const orderChanged = existing
      ? hasStoredOrderChanges(existing, nextOrder, editableOrderFields)
      : true;
    const changed = orderChanged || itemsChanged || paymentsChanged;
    nextOrder.completed_at = completedAtAfterOrderSave(existing ?? null, changed, now);
    const values = persistedOrderFields.map((field) => nextOrder[field]);

    if (existing && !changed) {
      const orderRisks = await db
        .prepare("SELECT * FROM order_risks WHERE order_id = ? AND status = 'active'")
        .bind(id)
        .all<Record<string, unknown>>();
      return Response.json({
        ok: true,
        unchanged: true,
        id,
        customerId: linkedCustomer.id,
        order: existing,
        orderItems: existingItems.results,
        orderPayments: existingPayments.results,
        orderRisks: orderRisks.results,
      });
    }

    if (existing) {
      await db
        .prepare(
          `UPDATE orders SET
            customer_id = ?, customer_code = ?, customer_name = ?,
            order_no = ?, pi_no = ?, order_date = ?, country = ?, model = ?,
            quantity = ?, original_currency = ?, original_amount = ?,
            fixed_exchange_rate_to_cny = ?, cny_amount = ?, other_costs = ?,
            currency_status = ?, payment_status = ?, deposit_amount = ?,
            deposit_date = ?, balance_amount = ?, balance_expected_date = ?,
            balance_received_date = ?, production_status = ?, shipment_status = ?,
            order_status = ?, completed_at = ?, expected_shipping_date = ?,
            estimated_delivery_date = ?, progress_next_step = ?,
            container_number = ?, bl_number = ?, forwarder = ?, vessel = ?,
            voyage = ?, etd = ?, eta = ?, port = ?, port_of_loading = ?,
            port_of_discharge = ?, shipping_company = ?, shipping_method = ?,
            awb_number = ?, carrier_company = ?, tracking_number = ?,
            logistics_company = ?, logistics_number = ?, production_notes = ?,
            documents = ?, due_date = ?,
            risk = ?, notes = ?, import_batch_id = ?, source_type = ?,
            updated_at = ?
           WHERE id = ?`,
        )
        .bind(...values, id)
        .run();
    } else {
      const initialOpenSortOrder = Number((await db.prepare(`SELECT COALESCE(MIN(open_sort_order), 0) - 100 AS value
          FROM orders
          WHERE deleted_at IS NULL AND COALESCE(order_status, 'active') <> 'completed'`)
        .first<{ value: number }>())?.value ?? -100);
      const insertValues = [...values];
      insertValues.splice(persistedOrderFields.indexOf("completed_at") + 1, 0, initialOpenSortOrder);
      await db
        .prepare(
          `INSERT INTO orders (
            customer_id, customer_code, customer_name, order_no, pi_no,
            order_date, country, model, quantity, original_currency,
            original_amount, fixed_exchange_rate_to_cny, cny_amount, other_costs,
            currency_status, payment_status, deposit_amount, deposit_date,
            balance_amount, balance_expected_date, balance_received_date,
            production_status, shipment_status, order_status, completed_at, open_sort_order,
            expected_shipping_date, estimated_delivery_date, progress_next_step,
            container_number, bl_number,
            forwarder, vessel, voyage, etd, eta, port, port_of_loading,
            port_of_discharge, shipping_company, shipping_method, awb_number,
            carrier_company, tracking_number, logistics_company, logistics_number,
            production_notes, documents, due_date,
            risk, notes, import_batch_id, source_type, updated_at, id, created_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?
          )`,
        )
        .bind(...insertValues, id, now)
        .run();
    }

    if (items && itemsChanged) {
      const itemStatements = [
        db.prepare("DELETE FROM order_items WHERE order_id = ?").bind(id),
        ...items.map((item) =>
          db
            .prepare(
              `INSERT INTO order_items
                (id, order_id, description, quantity, unit_price, legacy_metadata)
               VALUES (?, ?, ?, ?, ?, '{}')`,
            )
            .bind(item.id, id, item.description, item.quantity, item.unitPrice),
        ),
      ];
      await db.batch(itemStatements);
    }

    if (payments && paymentsChanged) {
      await db.batch([
        db.prepare("DELETE FROM order_payments WHERE order_id = ?").bind(id),
        ...payments.map((payment) =>
          db.prepare(
            `INSERT INTO order_payments
              (id, order_id, payment_type, payment_date, amount, sort_order, legacy_metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
          ).bind(
            payment.id,
            id,
            payment.paymentType,
            payment.paymentDate,
            payment.amount,
            payment.sortOrder,
            now,
            now,
          ),
        ),
      ]);
    }

    const watchedFields = [
      "payment_status",
      "production_status",
      "shipment_status",
    ] as const;
    if (existing) {
      const currentValues: Record<string, unknown> = {
        payment_status: paymentStatus,
        production_status: productionStatus,
        shipment_status: shipmentStatus,
      };
      const changes = watchedFields.filter(
        (field) => String(existing[field] ?? "") !== String(currentValues[field] ?? ""),
      );
      if (changes.length) {
        await db.batch(
          changes.map((field) =>
            db
              .prepare(
                `INSERT INTO order_status_history
                  (id, order_id, field_name, from_value, to_value, evidence, created_at)
                 VALUES (?, ?, ?, ?, ?, '用户确认保存订单', ?)`,
              )
              .bind(
                crypto.randomUUID(),
                id,
                field,
                existing[field] ?? null,
                currentValues[field] ?? null,
                now,
              ),
          ),
        );
      }
    }

    await refreshOrderRisks(db, id);
    await db.prepare("DELETE FROM order_risks WHERE order_id = ? AND trigger_type = 'manual'")
      .bind(id)
      .run();
    const manualRisk = nullable(payload.risk, 5000);
    if (manualRisk) {
      await db
        .prepare(
          `INSERT INTO order_risks (
            id, order_id, risk_level, title, reason, recommended_action,
            evidence_source, trigger_type, status, detected_at, updated_at
          ) VALUES (?, ?, 'Medium', '人工记录的订单风险', ?, '请按备注核实并更新处理进度',
            'orders.risk（Joyce 手工录入）', 'manual', 'active', ?, ?)`,
        )
        .bind(crypto.randomUUID(), id, manualRisk, now, now)
        .run();
    }

    await db
      .prepare(
        `INSERT INTO audit_logs
          (id, action, entity_type, entity_id, before_data, after_data, source)
         VALUES (?, ?, 'order', ?, ?, ?, 'user')`,
      )
      .bind(
        crypto.randomUUID(),
        existing ? "order_updated" : "order_created",
        id,
        JSON.stringify(existing ?? null),
        JSON.stringify(payload),
      )
      .run();
    const [order, savedItems, savedPayments, orderRisks] = await Promise.all([
      db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first<Record<string, unknown>>(),
      db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid").bind(id).all<Record<string, unknown>>(),
      db.prepare("SELECT * FROM order_payments WHERE order_id = ? ORDER BY payment_type, payment_date, sort_order, created_at").bind(id).all<Record<string, unknown>>(),
      db.prepare("SELECT * FROM order_risks WHERE order_id = ? AND status = 'active'").bind(id).all<Record<string, unknown>>(),
    ]);
    return Response.json({
      ok: true,
      id,
      customerId: linkedCustomer.id,
      order,
      orderItems: savedItems.results,
      orderPayments: savedPayments.results,
      orderRisks: orderRisks.results,
    });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "订单保存失败。",
      500,
    );
  }
}
