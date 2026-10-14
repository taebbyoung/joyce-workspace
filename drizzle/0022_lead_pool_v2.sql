ALTER TABLE `customers` ADD COLUMN `source_lead_id` TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customers_source_lead_idx`
ON `customers` (`source_lead_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `lead_development_history` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `lead_id` TEXT NOT NULL,
  `development_at` TEXT NOT NULL,
  `channel` TEXT NOT NULL,
  `direction` TEXT NOT NULL,
  `summary` TEXT NOT NULL,
  `touch_number` INTEGER,
  `real_reply` INTEGER NOT NULL DEFAULT 0,
  `outcome` TEXT,
  `created_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `lead_development_history_lead_time_idx`
ON `lead_development_history` (`lead_id`, `development_at` DESC, `created_at` DESC);
