ALTER TABLE orders ADD COLUMN open_sort_order INTEGER;

CREATE INDEX IF NOT EXISTS orders_open_sort_order_idx
ON orders(order_status, open_sort_order, created_at, id);
