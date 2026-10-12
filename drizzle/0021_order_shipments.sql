CREATE TABLE IF NOT EXISTS order_shipments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  batch_no INTEGER NOT NULL,
  batch_name TEXT,
  shipping_method TEXT,
  shipment_status TEXT NOT NULL DEFAULT 'not_arranged',
  expected_shipping_date TEXT,
  actual_shipping_date TEXT,
  estimated_delivery_date TEXT,
  container_number TEXT,
  bl_number TEXT,
  awb_number TEXT,
  carrier_company TEXT,
  tracking_number TEXT,
  logistics_company TEXT,
  logistics_number TEXT,
  shipping_company TEXT,
  forwarder TEXT,
  vessel TEXT,
  voyage TEXT,
  port_of_loading TEXT,
  port_of_discharge TEXT,
  eta TEXT,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS order_shipments_order_batch_idx ON order_shipments(order_id, batch_no);
CREATE INDEX IF NOT EXISTS order_shipments_order_sort_idx ON order_shipments(order_id, sort_order, batch_no);

CREATE TABLE IF NOT EXISTS order_shipment_items (
  id TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS order_shipment_items_shipment_item_idx ON order_shipment_items(shipment_id, order_item_id);
CREATE INDEX IF NOT EXISTS order_shipment_items_order_idx ON order_shipment_items(order_id, order_item_id);

CREATE TRIGGER IF NOT EXISTS order_shipment_items_validate_insert
BEFORE INSERT ON order_shipment_items
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM order_shipments s WHERE s.id = NEW.shipment_id AND s.order_id = NEW.order_id)
      THEN RAISE(ABORT, 'shipment_order_mismatch')
    WHEN NOT EXISTS (SELECT 1 FROM order_items i WHERE i.id = NEW.order_item_id AND i.order_id = NEW.order_id)
      THEN RAISE(ABORT, 'shipment_item_order_mismatch')
    WHEN COALESCE((SELECT SUM(si.quantity) FROM order_shipment_items si WHERE si.order_item_id = NEW.order_item_id), 0) + NEW.quantity
      > COALESCE((SELECT i.quantity FROM order_items i WHERE i.id = NEW.order_item_id), 0)
      THEN RAISE(ABORT, 'shipment_quantity_exceeds_ordered')
  END;
END;

CREATE TRIGGER IF NOT EXISTS order_shipment_items_validate_update
BEFORE UPDATE ON order_shipment_items
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM order_shipments s WHERE s.id = NEW.shipment_id AND s.order_id = NEW.order_id)
      THEN RAISE(ABORT, 'shipment_order_mismatch')
    WHEN NOT EXISTS (SELECT 1 FROM order_items i WHERE i.id = NEW.order_item_id AND i.order_id = NEW.order_id)
      THEN RAISE(ABORT, 'shipment_item_order_mismatch')
    WHEN COALESCE((SELECT SUM(si.quantity) FROM order_shipment_items si WHERE si.order_item_id = NEW.order_item_id AND si.id <> OLD.id), 0) + NEW.quantity
      > COALESCE((SELECT i.quantity FROM order_items i WHERE i.id = NEW.order_item_id), 0)
      THEN RAISE(ABORT, 'shipment_quantity_exceeds_ordered')
  END;
END;

CREATE TRIGGER IF NOT EXISTS order_items_protect_allocated_update
BEFORE UPDATE OF quantity ON order_items
WHEN NEW.quantity < COALESCE((SELECT SUM(si.quantity) FROM order_shipment_items si WHERE si.order_item_id = OLD.id), 0)
BEGIN
  SELECT RAISE(ABORT, 'order_item_quantity_below_allocated');
END;

CREATE TRIGGER IF NOT EXISTS order_items_protect_allocated_delete
BEFORE DELETE ON order_items
WHEN EXISTS (SELECT 1 FROM order_shipment_items si WHERE si.order_item_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'order_item_has_shipment_allocations');
END;
