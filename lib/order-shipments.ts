export type ShipmentRow = Record<string, unknown>;

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function shipmentLabel(shipment: ShipmentRow) {
  const batchNo = number(shipment.batch_no ?? shipment.batchNo);
  const name = String(shipment.batch_name ?? shipment.batchName ?? "").trim();
  return name || `第${batchNo || 1}批`;
}

export function hasLegacyShipmentData(order: ShipmentRow) {
  return [
    "shipping_method", "shipment_status", "expected_shipping_date", "estimated_delivery_date",
    "container_number", "bl_number", "awb_number", "carrier_company", "tracking_number",
    "logistics_company", "logistics_number", "shipping_company", "forwarder", "vessel", "voyage",
    "port_of_loading", "port_of_discharge", "eta",
  ].some((key) => String(order[key] ?? "").trim() && !["not_arranged", "not_shipped"].includes(String(order[key])));
}

export function summarizeOrderShipments(
  orderItems: ShipmentRow[],
  shipments: ShipmentRow[],
  shipmentItems: ShipmentRow[],
) {
  const shipmentIds = new Set(shipments.map((shipment) => String(shipment.id)));
  const relevantItems = shipmentItems.filter((item) => shipmentIds.has(String(item.shipment_id ?? item.shipmentId)));
  const orderedQuantity = orderItems.reduce((sum, item) => sum + number(item.quantity), 0);
  const allocatedQuantity = relevantItems.reduce((sum, item) => sum + number(item.quantity), 0);
  const shippedQuantity = allocatedQuantity;
  const actualDates = shipments
    .map((shipment) => String(shipment.actual_shipping_date ?? shipment.actualShippingDate ?? "").slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  const itemSummaries = orderItems.map((item) => {
    const id = String(item.id);
    const allocated = relevantItems
      .filter((entry) => String(entry.order_item_id ?? entry.orderItemId) === id)
      .reduce((sum, entry) => sum + number(entry.quantity), 0);
    const shipped = allocated;
    const ordered = number(item.quantity);
    return { orderItemId: id, ordered, allocated, shipped, unallocated: Math.max(0, ordered - allocated), pending: Math.max(0, ordered - shipped) };
  });
  return {
    shipmentCount: shipments.length,
    orderedQuantity,
    allocatedQuantity,
    shippedQuantity,
    unallocatedQuantity: Math.max(0, orderedQuantity - allocatedQuantity),
    pendingQuantity: Math.max(0, orderedQuantity - shippedQuantity),
    actualShippingDate: actualDates.at(-1) ?? null,
    status: shippedQuantity <= 0 ? "not_shipped" : shippedQuantity >= orderedQuantity && orderedQuantity > 0 ? "fully_shipped" : "partially_shipped",
    itemSummaries,
  };
}

export function attachShipmentSummaries(
  orders: ShipmentRow[],
  orderItems: ShipmentRow[],
  shipments: ShipmentRow[],
  shipmentItems: ShipmentRow[],
) {
  return orders.map((order) => {
    const orderId = String(order.id);
    const orderShipments = shipments.filter((shipment) => String(shipment.order_id) === orderId);
    if (!orderShipments.length) return order;
    const summary = summarizeOrderShipments(
      orderItems.filter((item) => String(item.order_id) === orderId),
      orderShipments,
      shipmentItems,
    );
    return {
      ...order,
      shipment_count: summary.shipmentCount,
      shipment_ordered_quantity: summary.orderedQuantity,
      shipment_allocated_quantity: summary.allocatedQuantity,
      shipment_shipped_quantity: summary.shippedQuantity,
      shipment_unallocated_quantity: summary.unallocatedQuantity,
      shipment_pending_quantity: summary.pendingQuantity,
      shipment_summary_status: summary.status,
      shipment_actual_shipping_date: summary.actualShippingDate,
    };
  });
}
