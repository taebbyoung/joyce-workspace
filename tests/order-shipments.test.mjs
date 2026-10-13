import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { attachShipmentSummaries, summarizeOrderShipments } from "../lib/order-shipments.ts";
import { getSalesAttributionDate } from "../lib/order-sales-attribution.ts";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("shipment quantities distinguish allocated, actually shipped, pending and unallocated", () => {
  const orderItems = [
    { id: "adv", quantity: 10 },
    { id: "itank", quantity: 6 },
  ];
  const shipments = [
    { id: "s1", batch_no: 1, actual_shipping_date: "2026-08-10" },
    { id: "s2", batch_no: 2, actual_shipping_date: null },
  ];
  const shipmentItems = [
    { shipment_id: "s1", order_item_id: "adv", quantity: 4 },
    { shipment_id: "s2", order_item_id: "adv", quantity: 3 },
    { shipment_id: "s2", order_item_id: "itank", quantity: 2 },
  ];
  const summary = summarizeOrderShipments(orderItems, shipments, shipmentItems);
  assert.deepEqual(
    [summary.orderedQuantity, summary.allocatedQuantity, summary.shippedQuantity, summary.pendingQuantity, summary.unallocatedQuantity],
    [16, 9, 4, 12, 7],
  );
  assert.equal(summary.status, "partially_shipped");
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

test("migration enforces ownership and positive quantities while APIs protect aggregate allocation", async () => {
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

test("shipment CRUD is independent and whole-order saves protect allocated item identities", async () => {
  const [route, shipmentRoute, workspace, ui] = await Promise.all([
    source("app/api/orders/route.ts"),
    source("app/api/orders/shipments/route.ts"),
    source("app/api/workspace/route.ts"),
    source("app/WorkspaceApp.tsx"),
  ]);
  assert.match(shipmentRoute, /action === "delete_shipment"/);
  assert.match(shipmentRoute, /action !== "save_shipment"/);
  assert.match(shipmentRoute, /shipment_quantity_exceeds_ordered|批次数量超过订单数量/);
  assert.match(route, /已有发货批次分配，不能删除/);
  assert.match(route, /数量不能低于已分配/);
  assert.match(workspace, /orderShipmentItems/);
  assert.match(ui, /首次启用分批发货/);
  assert.match(ui, /已发 .*待发/);
  assert.match(ui, /该批次已经实际发货/);
});

test("legacy importer remains shipment-table independent", async () => {
  const importer = await source("app/api/orders/import/route.ts");
  assert.doesNotMatch(importer, /order_shipments|order_shipment_items/);
});
