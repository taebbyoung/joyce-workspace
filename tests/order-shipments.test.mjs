import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { attachShipmentSummaries, summarizeOrderShipments } from "../lib/order-shipments.ts";
import { getSalesAttributionDate } from "../lib/order-sales-attribution.ts";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("every saved shipment batch counts as actual dispatch", () => {
  const orderItems = [
    { id: "adv", quantity: 6 },
    { id: "itank", quantity: 4 },
  ];
  const noShipment = summarizeOrderShipments(orderItems, [], []);
  assert.deepEqual([noShipment.orderedQuantity, noShipment.shippedQuantity, noShipment.pendingQuantity], [10, 0, 10]);

  const shipments = [{ id: "s1", actual_shipping_date: null }];
  const items = [{ shipment_id: "s1", order_item_id: "adv", quantity: 3 }];
  const first = summarizeOrderShipments(orderItems, shipments, items);
  assert.deepEqual([first.orderedQuantity, first.shippedQuantity, first.pendingQuantity], [10, 3, 7]);
  assert.deepEqual(
    first.itemSummaries.map(({ orderItemId, ordered, shipped, pending }) => ({ orderItemId, ordered, shipped, pending })),
    [
      { orderItemId: "adv", ordered: 6, shipped: 3, pending: 3 },
      { orderItemId: "itank", ordered: 4, shipped: 0, pending: 4 },
    ],
  );

  shipments.push({ id: "s2", actual_shipping_date: "2026-09-01" });
  items.push(
    { shipment_id: "s2", order_item_id: "adv", quantity: 3 },
    { shipment_id: "s2", order_item_id: "itank", quantity: 2 },
  );
  const second = summarizeOrderShipments(orderItems, shipments, items);
  assert.deepEqual([second.shippedQuantity, second.pendingQuantity], [8, 2]);
  assert.equal(second.status, "partially_shipped");

  shipments.push({ id: "s3", actual_shipping_date: "2026-09-20" });
  items.push({ shipment_id: "s3", order_item_id: "itank", quantity: 2 });
  const complete = summarizeOrderShipments(orderItems, shipments, items);
  assert.deepEqual([complete.shippedQuantity, complete.pendingQuantity], [10, 0]);
  assert.equal(complete.status, "fully_shipped");

  const edited = summarizeOrderShipments(orderItems, shipments, items.map((item) =>
    item.shipment_id === "s1" ? { ...item, quantity: 2 } : item,
  ));
  assert.deepEqual([edited.shippedQuantity, edited.pendingQuantity], [9, 1]);

  const deleted = summarizeOrderShipments(
    orderItems,
    shipments.filter((shipment) => shipment.id !== "s2"),
    items,
  );
  assert.deepEqual([deleted.shippedQuantity, deleted.pendingQuantity], [5, 5]);
});

test("sales attribution uses the latest actual shipment date for multi-shipment orders", () => {
  const [order] = attachShipmentSummaries(
    [{ id: "o1", expected_shipping_date: "2024-01-01", shipment_status: "delivered", balance_received_date: "2026-08-15" }],
    [{ id: "i1", order_id: "o1", quantity: 10 }],
    [
      { id: "s1", order_id: "o1", actual_shipping_date: "2026-08-10" },
      { id: "s2", order_id: "o1", actual_shipping_date: "2026-09-02" },
    ],
    [{ shipment_id: "s1", order_item_id: "i1", quantity: 4 }],
  );
  assert.equal(order.shipment_actual_shipping_date, "2026-09-02");
  assert.equal(getSalesAttributionDate(order, "2026-09-10"), "2026-09-02");
});

test("migration enforces ownership and positive quantities while APIs protect aggregate dispatch", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE order_items (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, quantity REAL)");
  db.exec(await source("drizzle/0021_order_shipments.sql"));
  db.exec("INSERT INTO order_items VALUES ('i1','o1',10)");
  db.exec("INSERT INTO order_shipments (id,order_id,batch_no) VALUES ('s1','o1',1),('s2','o1',2)");
  db.exec("INSERT INTO order_shipment_items (id,shipment_id,order_id,order_item_id,quantity) VALUES ('si1','s1','o1','i1',6)");
  assert.throws(() => db.exec("INSERT INTO order_shipment_items (id,shipment_id,order_id,order_item_id,quantity) VALUES ('si3','s2','o1','i1',0)"));
  assert.throws(() => db.exec("INSERT INTO order_shipment_items (id,shipment_id,order_id,order_item_id,quantity) VALUES ('si4','s2','wrong','i1',1)"), /FOREIGN KEY/);
  assert.throws(() => db.exec("DELETE FROM order_items WHERE id='i1'"), /FOREIGN KEY/);
});

test("shipment CRUD is independent and whole-order saves protect shipped item identities", async () => {
  const [route, shipmentRoute, workspace, ui] = await Promise.all([
    source("app/api/orders/route.ts"),
    source("app/api/orders/shipments/route.ts"),
    source("app/api/workspace/route.ts"),
    source("app/WorkspaceApp.tsx"),
  ]);
  assert.match(shipmentRoute, /action === "delete_shipment"/);
  assert.match(shipmentRoute, /action !== "save_shipment"/);
  assert.match(shipmentRoute, /shipment_quantity_exceeds_ordered|发货数量超过订单数量/);
  assert.match(shipmentRoute, /请填写实际发货日期/);
  assert.match(route, /已有发货记录，请先调整对应发货批次/);
  assert.match(route, /数量不能低于已发数量/);
  assert.match(workspace, /orderShipmentItems/);
  assert.match(ui, /首次启用分批发货/);
  assert.match(ui, /已发 .*待发/);
  assert.doesNotMatch(ui, /<span>已分配 \{selectedShipmentSummary/);
  assert.doesNotMatch(ui, /<span>未分配 \{selectedShipmentSummary/);
  assert.match(ui, /订单 .*已发 .*剩余可发/);
  assert.match(ui, /该批次为已发货记录/);
  assert.match(ui, /删除后会影响订单已发数量、待发数量及销售归属日期/);
  assert.match(ui, /setShipmentDraft\(openNext \? \{/);
});

test("legacy importer remains shipment-table independent", async () => {
  const importer = await source("app/api/orders/import/route.ts");
  assert.doesNotMatch(importer, /order_shipments|order_shipment_items/);
});
