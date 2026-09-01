CREATE TABLE IF NOT EXISTS backup_v40_orders_shipping_20260731 AS
SELECT * FROM orders;

CREATE TABLE IF NOT EXISTS backup_v40_order_risks_shipping_20260731 AS
SELECT * FROM order_risks;

ALTER TABLE orders ADD COLUMN shipping_method TEXT;
ALTER TABLE orders ADD COLUMN awb_number TEXT;
ALTER TABLE orders ADD COLUMN carrier_company TEXT;
ALTER TABLE orders ADD COLUMN tracking_number TEXT;
ALTER TABLE orders ADD COLUMN logistics_company TEXT;
ALTER TABLE orders ADD COLUMN logistics_number TEXT;

ALTER TABLE order_risks ADD COLUMN acknowledged_at TEXT;
ALTER TABLE order_risks ADD COLUMN acknowledged_by TEXT;

CREATE TABLE IF NOT EXISTS accessory_sales_totals (
  id TEXT PRIMARY KEY,
  sales_year INTEGER NOT NULL UNIQUE,
  amount_cny REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS accessory_sales_year_idx
  ON accessory_sales_totals(sales_year);
