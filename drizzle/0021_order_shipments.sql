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
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS order_shipments_order_batch_idx ON order_shipments(order_id, batch_no);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS order_shipments_id_order_idx ON order_shipments(id, order_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS order_shipments_order_sort_idx ON order_shipments(order_id, sort_order, batch_no);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS order_items_id_order_idx ON order_items(id, order_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS order_shipment_items (
  id TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (shipment_id, order_id) REFERENCES order_shipments(id, order_id),
  FOREIGN KEY (order_item_id, order_id) REFERENCES order_items(id, order_id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS order_shipment_items_shipment_item_idx ON order_shipment_items(shipment_id, order_item_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS order_shipment_items_order_idx ON order_shipment_items(order_id, order_item_id);
