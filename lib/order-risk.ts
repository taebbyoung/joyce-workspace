import { getShippingDateState } from "@/lib/order-sales-attribution";

type RiskSeed = {
  level: "High" | "Medium" | "Low";
  title: string;
  reason: string;
  action: string;
  evidence: string;
  trigger: string;
};

function dateDistance(date: unknown) {
  const value = String(date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const target = Date.parse(`${value}T00:00:00Z`);
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((target - today) / 86_400_000);
}

export async function refreshOrderRisks(db: D1Database, orderId: string) {
  const order = await db
    .prepare("SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL")
    .bind(orderId)
    .first<Record<string, unknown>>();
  if (!order) return;
  if (String(order.order_status || "active") === "completed") {
    await db.prepare(
      "UPDATE order_risks SET status = 'resolved', updated_at = ? WHERE order_id = ? AND status = 'active'",
    ).bind(new Date().toISOString(), orderId).run();
    return;
  }

  const risks: RiskSeed[] = [];
  const deliveryDays = dateDistance(order.estimated_delivery_date);
  const expectedShippingDays = dateDistance(order.expected_shipping_date);
  const shippingDateState = getShippingDateState(order);
  const payment = String(order.payment_status || "");
  const production = String(order.production_status || "");
  const shipment = String(order.shipment_status || "");
  const shippingMethod = String(order.shipping_method || "");
  const orderLabel = String(order.order_no || order.pi_no || order.customer_code || orderId);

  if (order.currency_status === "needs_confirmation") {
    risks.push({
      level: "Medium",
      title: "订单币种或固定汇率待确认",
      reason: `${orderLabel} 尚未形成可用于人民币统计的确认金额。`,
      action: "核对原始币种、原始金额和本订单固定汇率。",
      evidence: `orders.currency_status=needs_confirmation; currency=${order.original_currency || "空"}; amount=${order.original_amount ?? "空"}`,
      trigger: "financial_status",
    });
  }

  if (
    ["unpaid", "balance_pending", "partial_payment"].includes(payment) &&
    shippingDateState.kind !== "actual" &&
    expectedShippingDays !== null &&
    expectedShippingDays <= 10
  ) {
    risks.push({
      level: expectedShippingDays <= 3 ? "High" : "Medium",
      title: "预计发货前仍有款项待收",
      reason: `预计发货日期为 ${String(order.expected_shipping_date).slice(0, 10)}，付款状态为 ${payment}。`,
      action: "核对货款收清安排，并确认发货条件。",
      evidence: `orders.expected_shipping_date=${String(order.expected_shipping_date).slice(0, 10)}; orders.payment_status=${payment}`,
      trigger: "payment_before_shipping",
    });
  }

  if (
    deliveryDays !== null &&
    deliveryDays < 0 &&
    shipment !== "delivered"
  ) {
    risks.push({
      level: "High",
      title: "已超过预计客户收货日期",
      reason: `预计客户收货日期 ${String(order.estimated_delivery_date).slice(0, 10)} 已过，但运输状态仍为 ${shipment || "未设置"}。`,
      action: "向承运方或客户核实实际到货和签收状态。",
      evidence: `orders.estimated_delivery_date=${String(order.estimated_delivery_date).slice(0, 10)}; orders.shipment_status=${shipment || "空"}`,
      trigger: "delivery_overdue",
    });
  }

  if (
    shippingDateState.kind === "overdue" &&
    !["production_completed", "inspection", "ready_to_ship", "cancelled"].includes(production)
  ) {
    risks.push({
      level: "High",
      title: "预计发货日期已过但生产未完成",
      reason: `预计发货日期 ${String(order.expected_shipping_date).slice(0, 10)} 已过，生产状态仍为 ${production || "未设置"}。`,
      action: "确认生产完成、验货和装运安排是否需要调整。",
      evidence: `orders.expected_shipping_date=${String(order.expected_shipping_date).slice(0, 10)}; orders.production_status=${production || "空"}`,
      trigger: "production_delay",
    });
  }

  if (
    shippingDateState.kind === "overdue"
  ) {
    risks.push({
      level: "High",
      title: `预计发货日期已逾期${shippingDateState.daysOverdue}天`,
      reason: `${shippingDateState.label}，运输状态仍为 ${shipment || "未设置"}。`,
      action: "确认实际发货安排，并更新预计发货日期或运输状态。",
      evidence: `orders.expected_shipping_date=${String(order.expected_shipping_date).slice(0, 10)}; orders.shipment_status=${shipment || "空"}`,
      trigger: "shipping_date_overdue",
    });
  }

  const shipped = ["in_transit", "arrived", "delivered"].includes(shipment);
  if (shippingMethod === "sea_freight" && shipped && !String(order.bl_number || "").trim()) {
    risks.push({
      level: shipment === "delivered" ? "Medium" : "High",
      title: "运输订单缺少BL号",
      reason: `运输状态为 ${shipment}，但订单未记录 BL No.。`,
      action: "向船公司或货代核对 BL No. 并补充到订单。",
      evidence: `orders.shipment_status=${shipment}; orders.bl_number=空`,
      trigger: "missing_bl",
    });
  }

  if (shippingMethod === "express" && shipped && !String(order.tracking_number || "").trim()) {
    risks.push({
      level: "High",
      title: "运输中快递订单缺少追踪号",
      reason: `运输状态为 ${shipment}，但订单未记录 Tracking No.。`,
      action: "向快递公司确认追踪号并补充到订单。",
      evidence: `orders.shipping_method=express; orders.shipment_status=${shipment}; orders.tracking_number=empty`,
      trigger: "missing_tracking",
    });
  }

  if (shippingMethod === "domestic" && shipped && !String(order.logistics_number || "").trim()) {
    risks.push({
      level: "High",
      title: "运输中订单缺少物流单号",
      reason: `运输状态为 ${shipment}，但订单未记录国内物流单号。`,
      action: "向物流公司确认物流单号并补充到订单。",
      evidence: `orders.shipping_method=domestic; orders.shipment_status=${shipment}; orders.logistics_number=empty`,
      trigger: "missing_logistics",
    });
  }

  if (shippingMethod === "air_freight" && shipped && !String(order.awb_number || "").trim()) {
    risks.push({
      level: "High",
      title: "运输中空运订单缺少AWB",
      reason: `运输状态为 ${shipment}，但订单未记录 AWB。`,
      action: "向航空承运方确认 AWB 并补充到订单。",
      evidence: `orders.shipping_method=air_freight; orders.shipment_status=${shipment}; orders.awb_number=empty`,
      trigger: "missing_awb",
    });
  }

  if (shipment === "abnormal" || payment === "abnormal") {
    risks.push({
      level: "High",
      title: "订单状态标记为异常",
      reason: `付款状态 ${payment || "未设置"}；运输状态 ${shipment || "未设置"}。`,
      action: "确认异常原因、责任人和下一步处理日期。",
      evidence: `orders.payment_status=${payment || "空"}; orders.shipment_status=${shipment || "空"}`,
      trigger: "status_exception",
    });
  }

  if (String(order.risk || "").trim()) {
    risks.push({
      level: "Medium",
      title: "人工记录的订单风险",
      reason: String(order.risk).trim().slice(0, 1000),
      action: "按人工备注核实并更新处理进度。",
      evidence: "orders.risk（Joyce 手工录入）",
      trigger: "manual",
    });
  }

  const now = new Date().toISOString();
  const acknowledged = await db
    .prepare(
      `SELECT trigger_type, evidence_source FROM order_risks
       WHERE order_id = ? AND status = 'acknowledged'`,
    )
    .bind(orderId)
    .all<{ trigger_type: string; evidence_source: string }>();
  const acknowledgedKeys = new Set(
    acknowledged.results.map((risk) => `${risk.trigger_type}\n${risk.evidence_source}`),
  );
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM order_risks WHERE order_id = ? AND status <> 'acknowledged'").bind(orderId),
    ...risks.filter((risk) => !acknowledgedKeys.has(`${risk.trigger}\n${risk.evidence}`)).map((risk) =>
      db
        .prepare(
          `INSERT INTO order_risks (
            id, order_id, risk_level, title, reason, recommended_action,
            evidence_source, trigger_type, status, detected_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          orderId,
          risk.level,
          risk.title,
          risk.reason,
          risk.action,
          risk.evidence,
          risk.trigger,
          now,
          now,
        ),
    ),
  ];
  await db.batch(statements);
}

export async function seedExistingOrderRisks(db: D1Database) {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      `INSERT INTO order_risks
        (id, order_id, risk_level, title, reason, recommended_action,
         evidence_source, trigger_type, status, detected_at, updated_at)
       SELECT lower(hex(randomblob(16))), id, 'Medium',
         '订单币种或固定汇率待确认',
         COALESCE(order_no, pi_no, customer_code, '订单') || ' 尚未形成可用于人民币统计的确认金额。',
         '核对原始币种、原始金额和本订单固定汇率。',
         'orders.currency_status=needs_confirmation', 'financial_status', 'active', ?, ?
       FROM orders
       WHERE deleted_at IS NULL AND COALESCE(order_status, 'active') <> 'completed'
         AND currency_status = 'needs_confirmation'`,
    ).bind(now, now),
    db.prepare(
      `INSERT INTO order_risks
        (id, order_id, risk_level, title, reason, recommended_action,
         evidence_source, trigger_type, status, detected_at, updated_at)
       SELECT lower(hex(randomblob(16))), id,
         CASE WHEN julianday(expected_shipping_date) - julianday(date('now')) <= 3 THEN 'High' ELSE 'Medium' END,
         '预计发货前仍有款项待收',
         '预计发货日期 ' || expected_shipping_date || '；付款状态 ' || payment_status,
         '核对货款收清安排，并确认发货条件。',
         'orders.expected_shipping_date=' || expected_shipping_date || '; orders.payment_status=' || payment_status,
         'payment_before_shipping',
         'active', ?, ?
       FROM orders
       WHERE deleted_at IS NULL
         AND COALESCE(order_status, 'active') <> 'completed'
         AND payment_status IN ('unpaid', 'partial_payment', 'balance_pending')
         AND expected_shipping_date IS NOT NULL
         AND COALESCE(shipment_status, '') NOT IN ('in_transit', 'arrived', 'delivered')
         AND julianday(expected_shipping_date) - julianday(date('now')) <= 10`,
    ).bind(now, now),
    db.prepare(
      `INSERT INTO order_risks
        (id, order_id, risk_level, title, reason, recommended_action,
         evidence_source, trigger_type, status, detected_at, updated_at)
       SELECT lower(hex(randomblob(16))), id, 'High',
         '预计发货日期已逾期' || CAST(julianday(date('now')) - julianday(expected_shipping_date) AS INTEGER) || '天',
         '预计发货：' || expected_shipping_date || ' · 已逾期' || CAST(julianday(date('now')) - julianday(expected_shipping_date) AS INTEGER) || '天，运输状态仍为 ' || COALESCE(shipment_status, '未设置') || '。',
         '确认实际发货安排，并更新发货日期或运输状态。',
         'orders.expected_shipping_date=' || expected_shipping_date || '; orders.shipment_status=' || COALESCE(shipment_status, '空'),
         'shipping_date_overdue', 'active', ?, ?
       FROM orders
       WHERE deleted_at IS NULL AND COALESCE(order_status, 'active') <> 'completed'
         AND expected_shipping_date < date('now')
         AND COALESCE(shipment_status, '') NOT IN ('in_transit', 'arrived', 'delivered')`,
    ).bind(now, now),
    db.prepare(
      `INSERT INTO order_risks
        (id, order_id, risk_level, title, reason, recommended_action,
         evidence_source, trigger_type, status, detected_at, updated_at)
       SELECT lower(hex(randomblob(16))), id, 'High',
         '已超过预计客户收货日期',
         '预计客户收货日期 ' || estimated_delivery_date || ' 已过，但运输状态仍为 ' || COALESCE(shipment_status, '未设置') || '。',
         '向承运方或客户核实实际到货和签收状态。',
         'orders.estimated_delivery_date=' || estimated_delivery_date || '; orders.shipment_status=' || COALESCE(shipment_status, '空'),
         'delivery_overdue', 'active', ?, ?
       FROM orders
       WHERE deleted_at IS NULL AND COALESCE(order_status, 'active') <> 'completed'
         AND estimated_delivery_date < date('now')
         AND COALESCE(shipment_status, '') <> 'delivered'`,
    ).bind(now, now),
    db.prepare(
      `INSERT INTO order_risks
        (id, order_id, risk_level, title, reason, recommended_action,
         evidence_source, trigger_type, status, detected_at, updated_at)
       SELECT lower(hex(randomblob(16))), id, 'High',
         '运输订单缺少BL号',
         '运输状态为 ' || shipment_status || '，但订单未记录 BL No.。',
         '向船公司或货代核对 BL No. 并补充到订单。',
         'orders.shipment_status=' || shipment_status || '; orders.bl_number=空',
         'missing_bl', 'active', ?, ?
       FROM orders
       WHERE deleted_at IS NULL AND shipping_method = 'sea_freight'
         AND COALESCE(order_status, 'active') <> 'completed'
         AND shipment_status IN ('in_transit', 'arrived', 'delivered')
         AND trim(COALESCE(bl_number, '')) = ''`,
    ).bind(now, now),
    db.prepare(
      `INSERT INTO order_risks
        (id, order_id, risk_level, title, reason, recommended_action,
         evidence_source, trigger_type, status, detected_at, updated_at)
       SELECT lower(hex(randomblob(16))), id, 'High',
         '运输中空运订单缺少AWB',
         '运输状态为 ' || shipment_status || '，但订单未记录 AWB。',
         '向航空承运方确认 AWB 并补充到订单。',
         'orders.shipping_method=air_freight; orders.shipment_status=' || shipment_status || '; orders.awb_number=empty',
         'missing_awb', 'active', ?, ?
       FROM orders
       WHERE deleted_at IS NULL AND shipping_method = 'air_freight'
         AND COALESCE(order_status, 'active') <> 'completed'
         AND shipment_status IN ('in_transit', 'arrived', 'delivered')
         AND trim(COALESCE(awb_number, '')) = ''`,
    ).bind(now, now),
    db.prepare(
      `INSERT INTO order_risks
        (id, order_id, risk_level, title, reason, recommended_action,
         evidence_source, trigger_type, status, detected_at, updated_at)
       SELECT lower(hex(randomblob(16))), id, 'High',
         '运输中快递订单缺少追踪号',
         '运输状态为 ' || shipment_status || '，但订单未记录 Tracking No.。',
         '向快递公司确认追踪号并补充到订单。',
         'orders.shipping_method=express; orders.shipment_status=' || shipment_status || '; orders.tracking_number=empty',
         'missing_tracking', 'active', ?, ?
       FROM orders
       WHERE deleted_at IS NULL AND shipping_method = 'express'
         AND COALESCE(order_status, 'active') <> 'completed'
         AND shipment_status IN ('in_transit', 'arrived', 'delivered')
         AND trim(COALESCE(tracking_number, '')) = ''`,
    ).bind(now, now),
    db.prepare(
      `INSERT INTO order_risks
        (id, order_id, risk_level, title, reason, recommended_action,
         evidence_source, trigger_type, status, detected_at, updated_at)
       SELECT lower(hex(randomblob(16))), id, 'High',
         '运输中订单缺少物流单号',
         '运输状态为 ' || shipment_status || '，但订单未记录国内物流单号。',
         '向物流公司确认物流单号并补充到订单。',
         'orders.shipping_method=domestic; orders.shipment_status=' || shipment_status || '; orders.logistics_number=empty',
         'missing_logistics', 'active', ?, ?
       FROM orders
       WHERE deleted_at IS NULL AND shipping_method = 'domestic'
         AND COALESCE(order_status, 'active') <> 'completed'
         AND shipment_status IN ('in_transit', 'arrived', 'delivered')
         AND trim(COALESCE(logistics_number, '')) = ''`,
    ).bind(now, now),
    db.prepare(
      `INSERT INTO order_risks
        (id, order_id, risk_level, title, reason, recommended_action,
         evidence_source, trigger_type, status, detected_at, updated_at)
       SELECT lower(hex(randomblob(16))), id, 'Medium',
         '人工记录的订单风险', substr(risk, 1, 1000),
         '按人工备注核实并更新处理进度。',
         'orders.risk（Joyce 手工录入）', 'manual', 'active', ?, ?
       FROM orders
       WHERE deleted_at IS NULL AND COALESCE(order_status, 'active') <> 'completed'
         AND trim(COALESCE(risk, '')) <> ''`,
    ).bind(now, now),
  ]);
}
