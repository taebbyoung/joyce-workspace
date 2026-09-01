CREATE TABLE IF NOT EXISTS backup_v48_orders_workflow_20260813 AS
SELECT * FROM orders;

CREATE TABLE IF NOT EXISTS backup_v48_order_risks_workflow_20260813 AS
SELECT * FROM order_risks;

ALTER TABLE orders ADD COLUMN order_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE orders ADD COLUMN completed_at TEXT;
ALTER TABLE orders ADD COLUMN expected_shipping_date TEXT;
ALTER TABLE orders ADD COLUMN estimated_delivery_date TEXT;
ALTER TABLE orders ADD COLUMN progress_next_step TEXT;

UPDATE orders SET shipment_status = 'in_transit' WHERE shipment_status = 'shipped';
UPDATE orders SET shipment_status = 'not_arranged' WHERE shipment_status = 'not_shipped';
UPDATE orders SET shipment_status = 'delivered' WHERE shipment_status = 'completed';

UPDATE order_risks
SET status = 'resolved', updated_at = CURRENT_TIMESTAMP
WHERE status = 'active' AND trigger_type = 'after_sales';

UPDATE order_risks
SET status = 'resolved', updated_at = CURRENT_TIMESTAMP
WHERE status = 'active' AND order_id IN (
  SELECT id FROM orders WHERE COALESCE(order_status, 'active') = 'completed'
);

CREATE INDEX IF NOT EXISTS orders_workflow_idx
ON orders(order_status, completed_at DESC, expected_shipping_date, updated_at DESC);
