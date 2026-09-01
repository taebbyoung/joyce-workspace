CREATE TABLE IF NOT EXISTS `backup_v21_customers_20260723` AS
SELECT * FROM `customers`;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `backup_v21_contacts_20260723` AS
SELECT * FROM `contacts`;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `backup_v21_tasks_20260723` AS
SELECT * FROM `tasks`;
--> statement-breakpoint
ALTER TABLE `customers` ADD `city` text;
--> statement-breakpoint
ALTER TABLE `customers` ADD `address` text;
--> statement-breakpoint
ALTER TABLE `contacts` ADD `position` text;
--> statement-breakpoint
ALTER TABLE `contacts` ADD `whatsapp` text;
--> statement-breakpoint
ALTER TABLE `contacts` ADD `linkedin` text;
--> statement-breakpoint
ALTER TABLE `contacts` ADD `notes` text;
--> statement-breakpoint
ALTER TABLE `contacts` ADD `is_primary` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `contacts` ADD `deleted_at` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `next_action_date` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `reminder_date` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `snoozed_until` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `recurrence_rule` text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `completed_at` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `cancelled_at` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `archived_at` text;
--> statement-breakpoint
CREATE TABLE `customer_memory` (
  `customer_id` text PRIMARY KEY NOT NULL,
  `birthday` text,
  `product_preference` text,
  `communication_style` text,
  `personality` text,
  `where_met` text,
  `relationship_notes` text,
  `important_preferences` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `customer_custom_fields` (
  `id` text PRIMARY KEY NOT NULL,
  `customer_id` text NOT NULL,
  `label` text NOT NULL,
  `value` text,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `deleted_at` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `contacts_customer_idx` ON `contacts` (`customer_id`, `deleted_at`);
--> statement-breakpoint
CREATE INDEX `customer_custom_fields_customer_idx` ON `customer_custom_fields` (`customer_id`, `deleted_at`, `sort_order`);
--> statement-breakpoint
CREATE INDEX `tasks_lifecycle_idx` ON `tasks` (`status`, `archived_at`, `snoozed_until`, `reminder_date`);
--> statement-breakpoint
INSERT OR IGNORE INTO `contacts`
  (`id`, `customer_id`, `name`, `email`, `phone`, `position`, `is_primary`,
   `legacy_metadata`, `created_at`, `updated_at`)
SELECT
  'v21_primary_' || `id`,
  `id`,
  NULLIF(TRIM(`contact`), ''),
  NULLIF(TRIM(`email`), ''),
  NULLIF(TRIM(`phone`), ''),
  NULL,
  1,
  '{"source":"customers_flat_fields"}',
  COALESCE(`created_at`, CURRENT_TIMESTAMP),
  COALESCE(`updated_at`, CURRENT_TIMESTAMP)
FROM `customers`
WHERE
  (TRIM(COALESCE(`contact`, '')) <> ''
   OR TRIM(COALESCE(`email`, '')) <> ''
   OR TRIM(COALESCE(`phone`, '')) <> '')
  AND NOT EXISTS (
    SELECT 1 FROM `contacts`
    WHERE `contacts`.`customer_id` = `customers`.`id`
      AND `contacts`.`deleted_at` IS NULL
  );
