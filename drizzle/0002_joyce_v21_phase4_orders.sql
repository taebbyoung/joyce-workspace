CREATE TABLE IF NOT EXISTS `backup_v21_orders_phase4_20260723` AS
SELECT * FROM `orders`;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `backup_v21_order_items_phase4_20260723` AS
SELECT * FROM `order_items`;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `pi_no` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `country` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `quantity` real;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `other_costs` real;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `deposit_amount` real;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `deposit_date` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `balance_amount` real;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `balance_expected_date` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `balance_received_date` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `container_number` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `bl_number` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `forwarder` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `vessel` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `voyage` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `port` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `documents` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `import_batch_id` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `source_type` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `deleted_at` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_customer_code_idx`
ON `orders` (`customer_code`, `deleted_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_order_no_idx`
ON `orders` (`order_no`, `deleted_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_pi_no_idx`
ON `orders` (`pi_no`, `deleted_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_status_idx`
ON `orders` (`payment_status`, `production_status`, `shipment_status`, `deleted_at`);
--> statement-breakpoint
UPDATE `orders`
SET
  `customer_id` = (
    SELECT `customers`.`id`
    FROM `customers`
    WHERE upper(trim(`customers`.`customer_code`)) =
          upper(trim(`orders`.`customer_code`))
      AND `customers`.`deleted_at` IS NULL
    LIMIT 1
  ),
  `customer_name` = COALESCE(
    NULLIF(trim(`customer_name`), ''),
    (
      SELECT `customers`.`company`
      FROM `customers`
      WHERE upper(trim(`customers`.`customer_code`)) =
            upper(trim(`orders`.`customer_code`))
        AND `customers`.`deleted_at` IS NULL
      LIMIT 1
    )
  ),
  `country` = COALESCE(
    NULLIF(trim(`country`), ''),
    (
      SELECT `customers`.`country`
      FROM `customers`
      WHERE upper(trim(`customers`.`customer_code`)) =
            upper(trim(`orders`.`customer_code`))
        AND `customers`.`deleted_at` IS NULL
      LIMIT 1
    )
  )
WHERE `customer_id` IS NULL
  AND trim(COALESCE(`customer_code`, '')) <> ''
  AND (
    SELECT COUNT(*)
    FROM `customers`
    WHERE upper(trim(`customers`.`customer_code`)) =
          upper(trim(`orders`.`customer_code`))
      AND `customers`.`deleted_at` IS NULL
  ) = 1;
