CREATE TABLE IF NOT EXISTS `backup_v67_orders_payment_records_20260826` AS
SELECT * FROM `orders`;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `order_payments` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL,
  `payment_type` text NOT NULL,
  `payment_date` text NOT NULL,
  `amount` real NOT NULL,
  `sort_order` integer NOT NULL DEFAULT 0,
  `legacy_metadata` text NOT NULL DEFAULT '{}',
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `order_payments_order_type_date_idx`
ON `order_payments` (`order_id`, `payment_type`, `payment_date`, `sort_order`);
--> statement-breakpoint
INSERT OR IGNORE INTO `order_payments`
  (`id`, `order_id`, `payment_type`, `payment_date`, `amount`, `sort_order`, `legacy_metadata`, `created_at`, `updated_at`)
SELECT 'legacy_deposit_' || `id`, `id`, 'deposit', substr(`deposit_date`, 1, 10), `deposit_amount`, 0,
       '{"source":"legacy_orders_fields"}', COALESCE(`created_at`, CURRENT_TIMESTAMP), COALESCE(`updated_at`, CURRENT_TIMESTAMP)
FROM `orders`
WHERE TRIM(COALESCE(`deposit_date`, '')) <> '' AND `deposit_amount` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `order_payments`
  (`id`, `order_id`, `payment_type`, `payment_date`, `amount`, `sort_order`, `legacy_metadata`, `created_at`, `updated_at`)
SELECT 'legacy_balance_' || `id`, `id`, 'balance', substr(`balance_expected_date`, 1, 10), `balance_amount`, 0,
       '{"source":"legacy_orders_fields"}', COALESCE(`created_at`, CURRENT_TIMESTAMP), COALESCE(`updated_at`, CURRENT_TIMESTAMP)
FROM `orders`
WHERE TRIM(COALESCE(`balance_expected_date`, '')) <> '' AND `balance_amount` IS NOT NULL;
