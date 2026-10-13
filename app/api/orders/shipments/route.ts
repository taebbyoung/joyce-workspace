import { ensureWorkspace, getD1 } from "@/db/runtime";
import { refreshOrderRisks } from "@/lib/order-risk";
import { attachShipmentSummaries } from "@/lib/order-shipments";

export const runtime = "edge";

type Row = Record<string, unknown>;

const shipmentStatuses = new Set(["in_transit", "arrived", "delivered", "abnormal"]);
const shippingMethods = new Set(["sea_freight", "air_freight", "express", "domestic", "pickup", "other"]);

function text(value: unknown, max = 5000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function nullable(value: unknown, max = 5000) {
  return text(value, max) || null;
}

function dateOnly(value: unknown) {
  const valueText = text(value, 10);
  if (!valueText) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valueText)) throw new Error("发货日期格式无效。");
  return valueText;
}

function errorResponse(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

async function orderSnapshot(db: D1Database, orderId: string) {
  const [order, orderItems, orderPayments, orderShipments, orderShipmentItems, orderRisks] = await Promise.all([
    db.prepare("SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL").bind(orderId).first<Row>(),
    db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid").bind(orderId).all<Row>(),
    db.prepare("SELECT * FROM order_payments WHERE order_id = ? ORDER BY payment_type, payment_date, sort_order, created_at").bind(orderId).all<Row>(),
    db.prepare("SELECT * FROM order_shipments WHERE order_id = ? ORDER BY sort_order, batch_no").bind(orderId).all<Row>(),
    db.prepare("SELECT * FROM order_shipment_items WHERE order_id = ? ORDER BY shipment_id, created_at").bind(orderId).all<Row>(),
    db.prepare("SELECT * FROM order_risks WHERE order_id = ? AND status = 'active'").bind(orderId).all<Row>(),
  ]);
  return {
    ok: true,
    order: order ? attachShipmentSummaries([order], orderItems.results, orderShipments.results, orderShipmentItems.results)[0] : null,
    orderItems: orderItems.results,
    orderPayments: orderPayments.results,
    orderShipments: orderShipments.results,
    orderShipmentItems: orderShipmentItems.results,
    orderRisks: orderRisks.results,
  };
}

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const db = getD1();
    const payload = await request.json() as Row;
    const action = text(payload.action, 40);
    const orderId = text(payload.orderId, 100);
    if (!orderId) return errorResponse("缺少订单 ID。");
    const order = await db.prepare("SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL").bind(orderId).first<Row>();
    if (!order) return errorResponse("订单不存在。", 404);
    const now = new Date().toISOString();

    if (action === "delete_shipment") {
      const shipmentId = text(payload.shipmentId, 100);
      const shipment = await db.prepare("SELECT * FROM order_shipments WHERE id = ? AND order_id = ?").bind(shipmentId, orderId).first<Row>();
      if (!shipment) return errorResponse("发货批次不存在。", 404);
      await db.batch([
        db.prepare("DELETE FROM order_shipment_items WHERE shipment_id = ? AND order_id = ?").bind(shipmentId, orderId),
        db.prepare("DELETE FROM order_shipments WHERE id = ? AND order_id = ?").bind(shipmentId, orderId),
        db.prepare(`INSERT INTO audit_logs (id, action, entity_type, entity_id, before_data, after_data, source)
          VALUES (?, 'order_shipment_deleted', 'order_shipment', ?, ?, NULL, 'user')`)
          .bind(crypto.randomUUID(), shipmentId, JSON.stringify(shipment)),
      ]);
      await refreshOrderRisks(db, orderId);
      return Response.json(await orderSnapshot(db, orderId));
    }

    if (action !== "save_shipment") return errorResponse("不支持的发货批次操作。");
    const shipmentId = text(payload.shipmentId, 100) || crypto.randomUUID();
    const existing = await db.prepare("SELECT * FROM order_shipments WHERE id = ? AND order_id = ?").bind(shipmentId, orderId).first<Row>();
    if (payload.shipmentId && !existing) return errorResponse("发货批次不存在。", 404);
    const rawItems = Array.isArray(payload.items)
      ? payload.items.filter((entry) => {
          const row = entry && typeof entry === "object" ? entry as Row : {};
          return row.quantity !== "" && row.quantity !== null && row.quantity !== undefined && Number(row.quantity) !== 0;
        })
      : [];
    const seen = new Set<string>();
    const items = rawItems.map((entry) => {
      const row = entry && typeof entry === "object" ? entry as Row : {};
      const orderItemId = text(row.orderItemId ?? row.order_item_id, 100);
      const quantity = Number(row.quantity);
      if (!orderItemId || !Number.isFinite(quantity) || quantity <= 0) throw new Error("每个发货车型必须填写大于 0 的数量。");
      if (seen.has(orderItemId)) throw new Error("同一发货批次不能重复添加同一车型。");
      seen.add(orderItemId);
      return { id: text(row.id, 100) || crypto.randomUUID(), orderItemId, quantity };
    });
    if (!items.length) return errorResponse("请至少填写一个实际发货车型和数量。");
    const orderItems = await db.prepare("SELECT * FROM order_items WHERE order_id = ?").bind(orderId).all<Row>();
    const orderItemById = new Map(orderItems.results.map((item) => [String(item.id), item]));
    for (const item of items) if (!orderItemById.has(item.orderItemId)) return errorResponse("发货车型不属于当前订单。", 409);
    const shippedRows = await db.prepare(
      `SELECT order_item_id, COALESCE(SUM(quantity), 0) AS shipped
       FROM order_shipment_items WHERE order_id = ? AND shipment_id <> ? GROUP BY order_item_id`,
    ).bind(orderId, shipmentId).all<{ order_item_id: string; shipped: number }>();
    const shippedById = new Map(shippedRows.results.map((row) => [String(row.order_item_id), Number(row.shipped || 0)]));
    for (const item of items) {
      const ordered = Number(orderItemById.get(item.orderItemId)?.quantity || 0);
      const shipped = shippedById.get(item.orderItemId) || 0;
      if (shipped + item.quantity > ordered) {
        return errorResponse(`发货数量超过订单数量：已发 ${shipped}，本批 ${item.quantity}，订单 ${ordered}。`, 409);
      }
    }
    const shippingMethod = shippingMethods.has(text(payload.shippingMethod, 40)) ? text(payload.shippingMethod, 40) : null;
    const shipmentStatus = shipmentStatuses.has(text(payload.shipmentStatus, 40)) ? text(payload.shipmentStatus, 40) : "in_transit";
    const copyLegacy = Boolean(payload.copyLegacy) && !existing;
    if (copyLegacy) {
      const count = await db.prepare("SELECT COUNT(*) AS total FROM order_shipments WHERE order_id = ?").bind(orderId).first<{ total: number }>();
      if (Number(count?.total || 0) > 0) return errorResponse("该订单已经进入分批发货模式。", 409);
    }
    const sequence = existing ? { batch_no: Number(existing.batch_no), sort_order: Number(existing.sort_order) } : await db.prepare(
      "SELECT COALESCE(MAX(batch_no), 0) + 1 AS batch_no, COALESCE(MAX(sort_order), 0) + 100 AS sort_order FROM order_shipments WHERE order_id = ?",
    ).bind(orderId).first<{ batch_no: number; sort_order: number }>();
    const batchNo = Number(sequence?.batch_no || 1);
    const sortOrder = Number(sequence?.sort_order || batchNo * 100);
    const legacy = (key: string) => copyLegacy ? order[key] ?? null : null;
    const values = {
      batchName: nullable(payload.batchName, 100),
      shippingMethod: shippingMethod ?? legacy("shipping_method"),
      shipmentStatus: shipmentStatus || legacy("shipment_status") || "in_transit",
      expectedShippingDate: dateOnly(payload.expectedShippingDate) ?? legacy("expected_shipping_date"),
      actualShippingDate: dateOnly(payload.actualShippingDate) ?? (copyLegacy && ["in_transit", "arrived", "delivered", "shipped", "completed"].includes(String(order.shipment_status || "")) ? legacy("expected_shipping_date") : null),
      estimatedDeliveryDate: dateOnly(payload.estimatedDeliveryDate) ?? legacy("estimated_delivery_date"),
      containerNumber: nullable(payload.containerNumber, 100) ?? legacy("container_number"),
      blNumber: nullable(payload.blNumber, 100) ?? legacy("bl_number"),
      awbNumber: nullable(payload.awbNumber, 100) ?? legacy("awb_number"),
      carrierCompany: nullable(payload.carrierCompany, 300) ?? legacy("carrier_company"),
      trackingNumber: nullable(payload.trackingNumber, 100) ?? legacy("tracking_number"),
      logisticsCompany: nullable(payload.logisticsCompany, 300) ?? legacy("logistics_company"),
      logisticsNumber: nullable(payload.logisticsNumber, 100) ?? legacy("logistics_number"),
      shippingCompany: nullable(payload.shippingCompany, 300) ?? legacy("shipping_company"),
      forwarder: nullable(payload.forwarder, 300) ?? legacy("forwarder"),
      vessel: nullable(payload.vessel, 300) ?? legacy("vessel"),
      voyage: nullable(payload.voyage, 300) ?? legacy("voyage"),
      portOfLoading: nullable(payload.portOfLoading, 300) ?? legacy("port_of_loading"),
      portOfDischarge: nullable(payload.portOfDischarge, 300) ?? legacy("port_of_discharge"),
      eta: dateOnly(payload.eta) ?? legacy("eta"),
      notes: nullable(payload.notes, 5000),
    };
    if (!values.actualShippingDate) {
      return errorResponse("请填写实际发货日期。该批次按实际发货记录统计。");
    }
    const statement = existing
      ? db.prepare(`UPDATE order_shipments SET batch_name=?, shipping_method=?, shipment_status=?, expected_shipping_date=?, actual_shipping_date=?, estimated_delivery_date=?, container_number=?, bl_number=?, awb_number=?, carrier_company=?, tracking_number=?, logistics_company=?, logistics_number=?, shipping_company=?, forwarder=?, vessel=?, voyage=?, port_of_loading=?, port_of_discharge=?, eta=?, notes=?, updated_at=? WHERE id=? AND order_id=?`)
          .bind(...Object.values(values), now, shipmentId, orderId)
      : db.prepare(`INSERT INTO order_shipments (id, order_id, batch_no, batch_name, shipping_method, shipment_status, expected_shipping_date, actual_shipping_date, estimated_delivery_date, container_number, bl_number, awb_number, carrier_company, tracking_number, logistics_company, logistics_number, shipping_company, forwarder, vessel, voyage, port_of_loading, port_of_discharge, eta, notes, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(shipmentId, orderId, batchNo, ...Object.values(values), sortOrder, now, now);
    await db.batch([
      statement,
      db.prepare("DELETE FROM order_shipment_items WHERE shipment_id = ? AND order_id = ?").bind(shipmentId, orderId),
      ...items.map((item) => db.prepare(`INSERT INTO order_shipment_items (id, shipment_id, order_id, order_item_id, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(item.id, shipmentId, orderId, item.orderItemId, item.quantity, now, now)),
      db.prepare(`INSERT INTO audit_logs (id, action, entity_type, entity_id, before_data, after_data, source)
        VALUES (?, ?, 'order_shipment', ?, ?, ?, 'user')`)
        .bind(crypto.randomUUID(), existing ? "order_shipment_updated" : "order_shipment_created", shipmentId, JSON.stringify(existing ?? null), JSON.stringify({ ...values, items })),
    ]);
    await refreshOrderRisks(db, orderId);
    return Response.json(await orderSnapshot(db, orderId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "发货批次保存失败。";
    if (message.includes("shipment_quantity_exceeds_ordered")) return errorResponse("其他操作刚刚更新了已发数量，本批发货已超过订单数量，请刷新后重试。", 409);
    if (message.includes("shipment_order_mismatch") || message.includes("shipment_item_order_mismatch")) return errorResponse("发货批次与订单车型不匹配。", 409);
    return errorResponse(message, 500);
  }
}
