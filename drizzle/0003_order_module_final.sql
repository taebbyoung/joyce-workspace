CREATE TABLE IF NOT EXISTS `backup_v21_orders_final_20260724` AS
SELECT * FROM `orders`;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `backup_v21_order_items_final_20260724` AS
SELECT * FROM `order_items`;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `port_of_loading` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `port_of_discharge` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `shipping_company` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `production_notes` text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `order_documents` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL,
  `document_type` text DEFAULT 'other' NOT NULL,
  `file_name` text NOT NULL,
  `mime_type` text,
  `file_size` integer,
  `sha256` text,
  `r2_key` text NOT NULL,
  `recognition_status` text DEFAULT 'not_requested' NOT NULL,
  `recognition_json` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `order_documents_order_idx`
ON `order_documents` (`order_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `order_risks` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL,
  `risk_level` text NOT NULL,
  `title` text NOT NULL,
  `reason` text NOT NULL,
  `recommended_action` text,
  `evidence_source` text NOT NULL,
  `trigger_type` text NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `detected_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `order_risks_order_idx`
ON `order_risks` (`order_id`, `status`, `risk_level`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `order_status_history` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL,
  `field_name` text NOT NULL,
  `from_value` text,
  `to_value` text,
  `evidence` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `order_status_history_order_idx`
ON `order_status_history` (`order_id`, `created_at`);
