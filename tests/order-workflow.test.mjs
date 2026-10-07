import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isDateInMonth,
  isOrderCompleted,
  sortActiveOrders,
  sortCompletedOrders,
} from "../lib/order-workflow.ts";
import {
  completedAtAfterOrderSave,
  hasOrderItemChanges,
  hasStoredOrderChanges,
} from "../lib/order-change.ts";
import { requiresOrderSalesImpactConfirmation } from "../lib/order-sales-impact.ts";
import {
  buildAttributedCustomerContribution,
  buildAttributedSalesTrend,
  getEffectiveActualShippingDate,
  getSalesAttribution,
  getSalesAttributionDate,
  getSalesYear,
  groupAttributedOrdersByYear,
  getShippingDateState,
  isExpectedShippingInMonth,
  sumAttributedVehicleSales,
} from "../lib/order-sales-attribution.ts";
import { normalizeOrderPayments } from "../lib/order-payments.ts";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("orders are split explicitly and completed orders use real completion time", () => {
  assert.equal(isOrderCompleted({ shipment_status: "delivered" }), false);
  assert.equal(isOrderCompleted({ order_status: "completed" }), true);
  assert.deepEqual(
    sortCompletedOrders([
      { id: "missing", completed_at: null },
      { id: "older", completed_at: "2026-08-11T08:00:00.000Z" },
      { id: "latest", completed_at: "2026-08-12T09:00:00.000Z" },
    ]).map((order) => order.id),
    ["latest", "older", "missing"],
  );
});

test("completed order saves refresh the last-update time only after real changes", () => {
  const completed = {
    order_status: "completed",
    completed_at: "2026-08-10T14:20:00.000Z",
    notes: "原备注",
    original_amount: 3000,
  };
  const now = "2026-08-14T17:50:00.000Z";
  assert.equal(
    completedAtAfterOrderSave(completed, false, now),
    completed.completed_at,
  );
  assert.equal(completedAtAfterOrderSave(completed, true, now), now);
  assert.equal(
    completedAtAfterOrderSave(
      { order_status: "active", completed_at: null },
      true,
      now,
    ),
    null,
  );
  assert.equal(
    hasStoredOrderChanges(
      completed,
      { ...completed, original_amount: 3000 },
      ["original_amount"],
    ),
    false,
  );
  assert.equal(
    hasStoredOrderChanges(completed, { ...completed, notes: "新备注" }, ["notes"]),
    true,
  );
  assert.equal(
    hasOrderItemChanges(
      [{ description: "ADV", quantity: 10, unit_price: 3000 }],
      [{ model: "ADV", quantity: 10, unitPrice: 3000 }],
    ),
    false,
  );
  assert.equal(
    hasOrderItemChanges(
      [{ description: "ADV", quantity: 10, unit_price: 3000 }],
      [{ model: "ADV", quantity: 12, unitPrice: 3000 }],
    ),
    true,
  );
});

test("active orders sort by risk, nearest workflow date, then update time", () => {
  const orders = [
    { id: "later", expected_shipping_date: "2026-09-10", updated_at: "2026-08-13" },
    { id: "risk", expected_shipping_date: "2026-10-01", updated_at: "2026-08-01" },
    { id: "soon", expected_shipping_date: "2026-08-20", updated_at: "2026-08-12" },
  ];
  assert.deepEqual(
    sortActiveOrders(orders, new Set(["risk"])).map((order) => order.id),
    ["risk", "soon", "later"],
  );
});

test("manual open-order positions override the historical active-order fallback", () => {
  const orders = [
    { id: "historical-risk", open_sort_order: null, expected_shipping_date: "2026-08-20", updated_at: "2026-08-12" },
    { id: "manual-last", open_sort_order: 200, expected_shipping_date: "2026-08-10" },
    { id: "manual-first", open_sort_order: 100, expected_shipping_date: "2026-10-01" },
  ];
  assert.deepEqual(
    sortActiveOrders(orders, new Set(["historical-risk"])).map((order) => order.id),
    ["manual-first", "manual-last", "historical-risk"],
  );
});

test("open-order drag persistence is limited to incomplete orders", async () => {
  const [route, app, migration] = await Promise.all([
    source("app/api/orders/route.ts"),
    source("app/WorkspaceApp.tsx"),
    source("drizzle/0019_open_orders_manual_sort.sql"),
  ]);
  assert.match(migration, /ADD COLUMN open_sort_order INTEGER/);
  assert.match(route, /action === "reorder_open"/);
  assert.match(route, /COALESCE\(order_status, 'active'\) <> 'completed'/);
  assert.match(route, /未完成订单列表已变化，请刷新后重试/);
  const orderInsert = route.match(/INSERT INTO orders \(([\s\S]*?)\) VALUES \(([\s\S]*?)\)`/);
  assert.ok(orderInsert);
  assert.equal(orderInsert[1].split(",").length, 56);
  assert.equal((orderInsert[2].match(/\?/g) || []).length, 56);
  assert.match(app, /open-order-drag-handle/);
  const ordersView = app.slice(app.indexOf("function OrdersView("), app.indexOf("function AfterSalesView("));
  assert.match(ordersView, /open-order-drag-handle[\s\S]*onPointerDown[\s\S]*setPointerCapture/);
  assert.doesNotMatch(ordersView, /open-order-drag-handle[\s\S]{0,280}draggable/);
  assert.match(ordersView, /disabled=\{!canReorderOpenOrders\}/);
  assert.match(ordersView, /正在保存排序…/);
  assert.match(app, /排序保存失败，请重试/);
});

test("monthly filters use dedicated dates only", () => {
  assert.equal(isDateInMonth("2026-08-31", "2026-08"), true);
  assert.equal(isDateInMonth("2026-09-01", "2026-08"), false);
});

test("one shipping date changes meaning only from date and shipment status", () => {
  const today = "2026-08-14";
  assert.equal(
    getShippingDateState({ expected_shipping_date: "2026-08-25", shipment_status: "ready_to_ship" }, today).label,
    "预计发货：2026-08-25",
  );
  assert.deepEqual(
    getShippingDateState({ expected_shipping_date: "2026-08-10", shipment_status: "ready_to_ship" }, today),
    {
      kind: "overdue",
      date: "2026-08-10",
      daysOverdue: 4,
      label: "预计发货：2026-08-10 · 已逾期4天",
    },
  );
  for (const shipment_status of ["in_transit", "arrived", "delivered"]) {
    assert.equal(
      getEffectiveActualShippingDate({ expected_shipping_date: "2026-08-10", shipment_status }, today),
      "2026-08-10",
    );
    assert.equal(
      getShippingDateState({ expected_shipping_date: "2026-08-10", shipment_status }, today).kind,
      "actual",
    );
  }
  assert.equal(
    getEffectiveActualShippingDate({ expected_shipping_date: "2026-08-10", shipment_status: "ready_to_ship" }, today),
    null,
  );
  assert.equal(
    getShippingDateState({ expected_shipping_date: null, shipment_status: "in_transit" }, today).label,
    "请填写实际发货日期。",
  );
});

test("sales attribution uses whichever key date has occurred and the later date when both exist", () => {
  const today = "2026-08-14";
  assert.equal(
    getSalesAttributionDate({
      expected_shipping_date: "2025-12-20",
      shipment_status: "delivered",
      balance_received_date: "2026-01-08",
    }, today),
    "2026-01-08",
  );
  assert.equal(
    getSalesYear({
      expected_shipping_date: "2026-01-08",
      shipment_status: "in_transit",
      balance_received_date: "2025-12-20",
      order_date: "2024-01-01",
      order_status: "completed",
    }, today),
    "2026",
  );
  assert.equal(
    getSalesYear({
      expected_shipping_date: "2026-03-10",
      shipment_status: "arrived",
      balance_received_date: "2026-03-01",
    }, today),
    "2026",
  );
  assert.equal(
    getSalesYear({
      expected_shipping_date: "2025-12-20",
      shipment_status: "ready_to_ship",
      balance_received_date: "2025-12-15",
    }, today),
    "2025",
  );
  assert.equal(
    getSalesYear({ expected_shipping_date: null, shipment_status: "delivered", balance_received_date: "2026-01-08" }, today),
    "2026",
  );
  assert.equal(
    getSalesYear({ expected_shipping_date: "2026-01-08", shipment_status: "delivered", balance_received_date: null }, today),
    "2026",
  );
  assert.equal(
    getSalesYear({ order_date: "2026-01-08", shipment_status: "ready_to_ship" }, today),
    null,
  );
});

test("sales attribution reports provisional, final, and unattributed states", () => {
  const today = "2026-12-20";
  assert.deepEqual(
    getSalesAttribution({
      expected_shipping_date: "2026-08-20",
      shipment_status: "in_transit",
    }, today),
    {
      effectiveActualShippingDate: "2026-08-20",
      fullPaymentReceivedDate: null,
      attributionDate: "2026-08-20",
      year: "2026",
      status: "provisional",
    },
  );
  assert.equal(
    getSalesAttribution({
      expected_shipping_date: "2026-08-20",
      shipment_status: "in_transit",
      balance_received_date: "2026-11-15",
    }, today).status,
    "final",
  );
  assert.equal(
    getSalesAttribution({
      expected_shipping_date: "2026-08-20",
      shipment_status: "ready_to_ship",
    }, today).status,
    "unattributed",
  );
});

test("sales attribution moves dynamically across years as later events occur", () => {
  const today = "2027-03-01";
  const shippedIn2026 = {
    expected_shipping_date: "2026-08-20",
    shipment_status: "in_transit",
  };
  assert.deepEqual(
    [
      getSalesAttribution(shippedIn2026, today),
      getSalesAttribution({ ...shippedIn2026, balance_received_date: "2026-11-15" }, today),
      getSalesAttribution({ ...shippedIn2026, balance_received_date: "2027-01-10" }, today),
    ].map(({ year, status }) => [year, status]),
    [["2026", "provisional"], ["2026", "final"], ["2027", "final"]],
  );

  const paidIn2026 = {
    expected_shipping_date: "2027-02-10",
    shipment_status: "ready_to_ship",
    balance_received_date: "2026-10-15",
  };
  assert.deepEqual(
    [
      getSalesAttribution(paidIn2026, "2026-12-20"),
      getSalesAttribution({ ...paidIn2026, shipment_status: "in_transit" }, today),
    ].map(({ year, status }) => [year, status]),
    [["2026", "provisional"], ["2027", "final"]],
  );

  const crossYearOrder = {
    ...shippedIn2026,
    balance_received_date: "2027-01-10",
    currency_status: "confirmed",
    cny_amount: 100,
  };
  assert.equal(sumAttributedVehicleSales([crossYearOrder], "2026", today), 0);
  assert.equal(sumAttributedVehicleSales([crossYearOrder], "2027", today), 100);
});

test("attributed sales, trend, and contribution share one year rule without mutating CNY amounts", () => {
  const today = "2026-08-14";
  const orders = [
    {
      id: "belongs-2026",
      order_date: "2025-01-01",
      expected_shipping_date: "2025-12-20",
      shipment_status: "delivered",
      balance_received_date: "2026-01-08",
      order_status: "completed",
      currency_status: "confirmed",
      cny_amount: 100,
    },
    {
      id: "missing-payment",
      order_date: "2026-01-01",
      expected_shipping_date: "2026-03-10",
      shipment_status: "in_transit",
      balance_received_date: null,
      currency_status: "confirmed",
      cny_amount: 200,
    },
    {
      id: "prior-year",
      expected_shipping_date: "2025-05-10",
      shipment_status: "delivered",
      currency_status: "confirmed",
      cny_amount: 999,
    },
  ];
  assert.equal(sumAttributedVehicleSales(orders, "2026", today), 300);
  assert.deepEqual(buildAttributedSalesTrend(orders, "2026", today), [
    { month: "2026-01", amount: 100 },
    { month: "2026-03", amount: 200 },
  ]);
  assert.deepEqual(
    buildAttributedCustomerContribution(
      orders.map((order, index) => ({ ...order, customer_code: `C${index + 1}` })),
      "2026",
      today,
    ),
    [
      { customer_code: "C2", amount: 200 },
      { customer_code: "C1", amount: 100 },
    ],
  );
  assert.equal(orders[0].cny_amount, 100);
});

test("completed orders group by the existing attribution year with order counts and confirmed CNY totals", () => {
  const groups = groupAttributedOrdersByYear([
    {
      id: "cross-year", expected_shipping_date: "2025-12-20", shipment_status: "delivered",
      balance_received_date: "2026-01-08", currency_status: "confirmed", cny_amount: 100,
    },
    {
      id: "one-date", expected_shipping_date: "2025-05-10", shipment_status: "delivered",
      currency_status: "confirmed", cny_amount: 200,
    },
    {
      id: "unconfirmed", balance_received_date: "2026-03-10", currency_status: "pending", cny_amount: 999,
    },
    { id: "unattributed", completed_at: "2026-08-14", order_date: "2026-01-01", cny_amount: 500 },
  ], "2026-08-14");
  assert.deepEqual(groups.map((group) => [group.year, group.orders.length, group.totalCnyAmount]), [
    ["2026", 2, 100],
    ["2025", 1, 200],
  ]);
});

test("this-month expected shipping excludes orders already actually shipped", () => {
  const today = "2026-08-14";
  assert.equal(
    isExpectedShippingInMonth({ expected_shipping_date: "2026-08-25", shipment_status: "ready_to_ship", order_status: "active" }, "2026-08", today),
    true,
  );
  assert.equal(
    isExpectedShippingInMonth({ expected_shipping_date: "2026-08-10", shipment_status: "in_transit", order_status: "active" }, "2026-08", today),
    false,
  );
  assert.equal(
    isExpectedShippingInMonth({ expected_shipping_date: "2026-08-25", shipment_status: "ready_to_ship", order_status: "completed" }, "2026-08", today),
    false,
  );
});

test("sales-impact confirmation only follows normalized CNY statistic inputs", () => {
  const original = {
    order_date: "2026-08-14",
    original_currency: " usd ",
    original_amount: 3000,
    fixed_exchange_rate_to_cny: 7.2,
    shipping_status: "arranged",
  };

  assert.equal(
    requiresOrderSalesImpactConfirmation(original, {
      orderDate: "2026-08-14",
      originalCurrency: "USD",
      originalAmount: "3000.00",
      fixedExchangeRateToCny: "7.2000",
      shippingMethod: "sea_freight",
      shippingStatus: "in_transit",
      expectedShippingDate: "2026-09-01",
      estimatedDeliveryDate: "2026-10-01",
      shippingCompany: "MSC",
      vessel: "TEST VESSEL",
      voyage: "V001",
      blNumber: "BL001",
      awbNumber: "AWB001",
      trackingNumber: "TRACK001",
      logisticsNumber: "LOG001",
      productionStatus: "production_started",
      paymentStatus: "balance_pending",
      progressNextStep: "follow up",
      notes: "ordinary edit",
      orderStatus: "completed",
    }),
    false,
  );
  assert.equal(
    requiresOrderSalesImpactConfirmation(original, {
      orderDate: "2026-08-14",
      originalCurrency: "USD",
      originalAmount: "3200",
      fixedExchangeRateToCny: "7.2",
    }),
    true,
  );
  assert.equal(
    requiresOrderSalesImpactConfirmation(original, {
      orderDate: "2026-08-14",
      originalCurrency: "EUR",
      originalAmount: "3000",
      fixedExchangeRateToCny: "7.2",
    }),
    true,
  );
  assert.equal(
    requiresOrderSalesImpactConfirmation(original, {
      orderDate: "2026-08-14",
      originalCurrency: "USD",
      originalAmount: "3000",
      fixedExchangeRateToCny: "7.3",
    }),
    true,
  );
  assert.equal(
    requiresOrderSalesImpactConfirmation(original, {
      orderDate: "2025-08-14",
      originalCurrency: "USD",
      originalAmount: "3000",
      fixedExchangeRateToCny: "7.2",
    }),
    false,
  );
  assert.equal(
    requiresOrderSalesImpactConfirmation(null, {
      orderDate: "2026-08-14",
      originalCurrency: "USD",
      originalAmount: "3000",
      fixedExchangeRateToCny: "7.2",
    }),
    true,
  );
  assert.equal(
    requiresOrderSalesImpactConfirmation(
      {
        order_date: "2026-08-14",
        original_currency: "RMB",
        original_amount: 3000,
        fixed_exchange_rate_to_cny: null,
      },
      {
        orderDate: "2026-08-14",
        originalCurrency: "CNY",
        originalAmount: "3000.00",
        fixedExchangeRateToCny: "9.9",
      },
    ),
    false,
  );
});

test("order workflow API is local, explicit and never calls AI", async () => {
  const [route, risks, app, migration, schema] = await Promise.all([
    source("app/api/orders/route.ts"),
    source("lib/order-risk.ts"),
    source("app/WorkspaceApp.tsx"),
    source("drizzle/0013_orders_active_completed_workflow.sql"),
    source("db/schema.ts"),
  ]);
  assert.match(route, /action === "complete" \|\| action === "reopen"/);
  assert.match(route, /order_status = \?, completed_at = \?/);
  assert.match(route, /completedAtAfterOrderSave\(existing \?\? null, changed, now\)/);
  assert.match(route, /if \(existing && !changed\)/);
  assert.doesNotMatch(route, /requestAi|requestJson|Gemini|DeepSeek/);
  assert.match(route, /requiresOrderSalesImpactConfirmation\(existing, payload\)/);
  assert.match(route, /requiresFinancialConfirmation && payload\.confirmFinancialRisk !== true/);
  assert.doesNotMatch(route, /if \(payload\.confirmFinancialRisk !== true\)/);
  assert.match(risks, /expected_shipping_date/);
  assert.match(risks, /预计发货日期已逾期/);
  assert.doesNotMatch(risks, /JOIN after_sales_cases/);
  assert.match(app, /未完成订单/);
  assert.match(app, /本月预计发货/);
  assert.match(app, /本月预计客户收货/);
  assert.match(app, /name="expectedShippingDate"/);
  assert.match(app, /name="estimatedDeliveryDate"/);
  assert.match(app, /货款收清日期[\s\S]*name="balanceReceivedDate"/);
  assert.match(app, /订单全部货款实际收齐的日期/);
  assert.doesNotMatch(app, /<label>尾款到账日期/);
  assert.match(app, /name="progressNextStep"/);
  assert.match(app, /onChange=\{updateSalesImpactConfirmation\}/);
  assert.match(app, /requiresSalesImpactConfirmation \? \(/);
  const ordersView = app.slice(app.indexOf("function OrdersView("), app.indexOf("function AfterSalesView("));
  const shipmentSection = ordersView.slice(
    ordersView.indexOf('<span>SHIPMENT</span>'),
    ordersView.indexOf('<span>AI RISK ALERT</span>'),
  );
  assert.match(shipmentSection, /name="shippingMethod"/);
  assert.match(shipmentSection, /name="shipmentStatus"/);
  assert.match(shipmentSection, /name="expectedShippingDate"/);
  assert.match(shipmentSection, /发货日期[\s\S]*name="expectedShippingDate"/);
  assert.match(shipmentSection, /name="estimatedDeliveryDate"/);
  assert.match(shipmentSection, /shippingMethod === "sea_freight"[\s\S]*name="shippingCompany"[\s\S]*name="vessel"[\s\S]*name="voyage"[\s\S]*name="blNumber"/);
  assert.match(shipmentSection, /shippingMethod === "air_freight"[\s\S]*name="awbNumber"/);
  assert.match(shipmentSection, /shippingMethod === "express"[\s\S]*name="trackingNumber"/);
  assert.match(shipmentSection, /shippingMethod === "domestic"[\s\S]*name="logisticsNumber"/);
  assert.doesNotMatch(shipmentSection, /name="etd"|name="eta"|name="portOfLoading"|name="portOfDischarge"|name="containerNumber"|name="forwarder"/);
  assert.doesNotMatch(ordersView, /上传提单并识别|订单文档|上传文档|\/api\/order-documents|\/api\/orders\/bl-confirm/);
  const shipmentOptions = app.slice(
    app.indexOf("const shipmentStatusOptions"),
    app.indexOf("const legacyShipmentStatusLabels"),
  );
  for (const status of ["not_arranged", "arranged", "ready_to_ship", "in_transit", "arrived", "delivered"]) {
    assert.match(shipmentOptions, new RegExp(`\\["${status}"`));
  }
  assert.doesNotMatch(shipmentOptions, /booking_pending|booked|已发货/);
  assert.match(risks, /shippingMethod === "air_freight"/);
  assert.match(risks, /missing_awb/);
  assert.doesNotMatch(risks, /dateDistance\(order\.eta\)|计划 ETA|shipment_delay/);
  assert.doesNotMatch(await source("lib/order-workflow.ts"), /order\.etd/);
  assert.match(route, /nullable\(payload\.expectedShippingDate, 10\)/);
  assert.match(route, /nullable\(payload\.estimatedDeliveryDate, 10\)/);
  assert.match(schema, /etd: text\("etd"\)/);
  assert.match(schema, /eta: text\("eta"\)/);
  assert.match(schema, /portOfLoading: text\("port_of_loading"\)/);
  assert.match(app, /mark|标记为已完成/);
  const completedOrderSection = ordersView.slice(
    ordersView.indexOf('completed-orders-section'),
    ordersView.indexOf('<Modal', ordersView.indexOf('completed-orders-section')),
  );
  const completedOrderRows = ordersView.slice(
    ordersView.indexOf("function renderCompletedOrders"),
    ordersView.indexOf("function openOrder"),
  );
  assert.match(
    ordersView,
    /订单 \/ 客户[\s\S]*整车明细[\s\S]*金额[\s\S]*交付[\s\S]*运输[\s\S]*操作/,
  );
  assert.doesNotMatch(completedOrderSection, /最后更新|formatCompletedAt/);
  assert.match(completedOrderSection, /completed-orders-tabs[\s\S]*本月预计客户收货/);
  assert.match(ordersView, /groupAttributedOrdersByYear\(completedOrders, getSalesBusinessDate\(\)\)/);
  assert.match(completedOrderSection, /completedOrdersTab === "delivery_month"/);
  assert.match(completedOrderSection, /role="tablist"/);
  assert.match(completedOrderSection, /role="tab"/);
  assert.doesNotMatch(completedOrderSection, /expandedCompletedYears|toggleCompletedYear|⌃|⌄/);
  assert.match(ordersView, /const orderItemsByOrderId = useMemo/);
  assert.match(completedOrderRows, /orderItemsByOrderId\.get\(String\(item\.id\)\)/);
  assert.match(completedOrderRows, /vehicleItems\.map\(\(orderItem\)/);
  assert.match(completedOrderRows, /orderItem\.description/);
  assert.match(completedOrderRows, /orderItemQuantityLabel\(orderItem\.quantity\)/);
  assert.doesNotMatch(completedOrderRows, /unit_price|unitPrice|行金额|\+\d+款/);
  assert.match(completedOrderRows, /vehicleItems\.length[\s\S]*: <strong className="order-primary-text">—<\/strong>/);
  assert.match(completedOrderRows, /completedOrderDeliveryLabel\(item\)/);
  assert.match(completedOrderRows, /completedOrderShippingLabel\(item\)/);
  assert.doesNotMatch(completedOrderRows, /orderShipmentDetail\(item\)|bl_number|vessel|voyage|tracking_number|awb_number|logistics_number/);
  assert.doesNotMatch(completedOrderSection, /fetch\(|\/api\/orders\?id=/);
  assert.match(app, /shipmentStatus === "delivered"[\s\S]*return "已签收"/);
  assert.match(app, /shipmentStatus === "arrived"[\s\S]*return "已到达"/);
  assert.match(app, /预计收货 \$\{deliveryDate\.slice\(5\)\}/);
  assert.match(app, /return \[method, status\]\.filter\(Boolean\)\.join\(" · "\) \|\| "—"/);
  assert.match(route, /SELECT \* FROM order_items WHERE order_id = \? ORDER BY rowid/);
  assert.match(ordersView, /更多[\s\S]*恢复为未完成[\s\S]*删除订单/);
  assert.match(ordersView, /确认将该订单恢复为未完成状态？恢复后，该订单将重新进入未完成订单列表。/);
  assert.doesNotMatch(ordersView, /重新打开/);
  assert.doesNotMatch(app.slice(app.indexOf("function OrdersView("), app.indexOf("function AfterSalesView(")), /loadWorkspace\(/);
  assert.match(migration, /backup_v48_orders_workflow_20260813/);
  assert.match(migration, /completed_at TEXT/);
  const workspaceRoute = await source("app/api/workspace/route.ts");
  assert.match(workspaceRoute, /SELECT \* FROM order_items ORDER BY order_id, rowid/);
  assert.match(workspaceRoute, /sumAttributedVehicleSales/);
  assert.match(workspaceRoute, /buildAttributedSalesTrend/);
  assert.match(workspaceRoute, /buildAttributedCustomerContribution/);
  assert.doesNotMatch(workspaceRoute, /substr\(order_date, 1, [47]\)/);
});

test("order payments use child records while full-payment date remains on the order", async () => {
  const [ordersApi, importer, app, migration] = await Promise.all([
    readFile(new URL("../app/api/orders/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/orders/import/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/WorkspaceApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0017_order_payment_records.sql", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `order_payments`/);
  assert.match(migration, /INSERT OR IGNORE INTO `order_payments`/);
  assert.match(ordersApi, /function orderPayments/);
  assert.match(ordersApi, /DELETE FROM order_payments WHERE order_id = \?/);
  assert.match(ordersApi, /balance_received_date/);
  assert.match(app, /\+ 新增\{title\}/);
  assert.match(app, /paymentRecordsByType/);
  const ordersView = app.slice(app.indexOf("function OrdersView("), app.indexOf("function AfterSalesView("));
  assert.match(ordersView, /<label>订单总金额<input name="originalAmount"/);
  assert.doesNotMatch(ordersView, /<label>原始金额<input name="originalAmount"/);
  assert.match(ordersView, /order-payment-group-heading[\s\S]*\+ 新增\{title\}/);
  assert.match(ordersView, /order-payment-record[\s\S]*编辑[\s\S]*删除/);
  assert.doesNotMatch(importer, /requestAi|gemini|deepseek/i);
  assert.match(importer, /groupOrderImportRows/);
});

test("payment mutations normalize API rows before retaining them for later order saves", () => {
  const apiRows = [
    { id: "P1", order_id: "order-1", payment_type: "deposit", payment_date: "2026-07-17", amount: 55000, sort_order: 0 },
    { id: "B1", order_id: "order-1", payment_type: "balance", payment_date: "2026-10-07", amount: 11000, sort_order: 1 },
    { id: "B2", order_id: "order-1", payment_type: "balance", payment_date: "2026-10-07", amount: 11000, sort_order: 2 },
    { id: "B3", order_id: "order-1", payment_type: "balance", payment_date: "2026-10-07", amount: 11000, sort_order: 3 },
  ];
  const payments = normalizeOrderPayments(apiRows);

  assert.ok(payments);
  assert.deepEqual(payments.map((payment) => [payment.id, payment.paymentType, payment.paymentDate, payment.sortOrder]), [
    ["P1", "deposit", "2026-07-17", 0],
    ["B1", "balance", "2026-10-07", 1],
    ["B2", "balance", "2026-10-07", 2],
    ["B3", "balance", "2026-10-07", 3],
  ]);
  assert.equal(normalizeOrderPayments(undefined), null);

  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE order_payments (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, payment_type TEXT NOT NULL, payment_date TEXT NOT NULL, amount REAL NOT NULL, sort_order INTEGER NOT NULL)");
    const insert = db.prepare("INSERT INTO order_payments (id, order_id, payment_type, payment_date, amount, sort_order) VALUES (?, ?, ?, ?, ?, ?)");
    for (const row of apiRows) {
      insert.run(row.id, row.order_id, row.payment_type, row.payment_date, row.amount, row.sort_order);
    }

    db.prepare("DELETE FROM order_payments WHERE id = ? AND order_id = ?").run("B2", "order-1");
    const afterDelete = normalizeOrderPayments(db.prepare("SELECT * FROM order_payments WHERE order_id = ? ORDER BY sort_order ASC").all("order-1"));
    assert.ok(afterDelete);
    assert.deepEqual(afterDelete.map((payment) => payment.id), ["P1", "B1", "B3"]);
    assert.deepEqual(afterDelete.filter((payment) => payment.paymentType === "deposit").map((payment) => payment.id), ["P1"]);
    assert.deepEqual(afterDelete.filter((payment) => payment.paymentType === "balance").map((payment) => payment.id), ["B1", "B3"]);

    db.prepare("DELETE FROM order_payments WHERE order_id = ?").run("order-1");
    for (const payment of afterDelete) {
      insert.run(payment.id, payment.orderId, payment.paymentType, payment.paymentDate, payment.amount, payment.sortOrder);
    }
    assert.deepEqual(
      db.prepare("SELECT id, payment_type FROM order_payments WHERE order_id = ? ORDER BY sort_order ASC").all("order-1").map((row) => ({ ...row })),
      [
        { id: "P1", payment_type: "deposit" },
        { id: "B1", payment_type: "balance" },
        { id: "B3", payment_type: "balance" },
      ],
    );
  } finally {
    db.close();
  }
});

test("active and completed orders share one quiet typography hierarchy", async () => {
  const [app, styles] = await Promise.all([
    source("app/WorkspaceApp.tsx"),
    source("app/globals.css"),
  ]);
  const ordersView = app.slice(
    app.indexOf("function OrdersView("),
    app.indexOf("function AfterSalesView("),
  );

  assert.match(ordersView, /active-order-header[\s\S]*order-primary-text[\s\S]*order-secondary-text/);
  assert.match(ordersView, /order-status-columns[\s\S]*order-label[\s\S]*order-primary-text[\s\S]*order-secondary-text/);
  assert.match(ordersView, /completed-order-open[\s\S]*order-primary-text[\s\S]*order-secondary-text/);
  assert.match(ordersView, /completed-order-item order-primary-text/);
  assert.match(ordersView, /order-action order-complete-button[\s\S]*标记为已完成/);
  assert.match(ordersView, /completed-order-more[\s\S]*className="order-action"[\s\S]*更多/);

  assert.match(styles, /\.order-workflow-section \.order-primary-text \{[\s\S]*font-size: 13px;[\s\S]*font-weight: 500;/);
  assert.match(styles, /\.order-workflow-section \.order-secondary-text,[\s\S]*font-size: 11px;[\s\S]*font-weight: 400;/);
  assert.match(styles, /\.completed-order-table \.table-head \{[\s\S]*font-size: 11px;[\s\S]*font-weight: 500;/);
  assert.match(styles, /\.order-action \{[\s\S]*min-height: 30px;[\s\S]*font-size: 12px;[\s\S]*font-weight: 500;/);
  assert.match(styles, /\.completed-order-more > \.order-action \{[\s\S]*font-weight: 400;/);
});
