CREATE TABLE IF NOT EXISTS `backup_v58_customers_contact_notes_20260819` AS
SELECT * FROM `customers`;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `backup_v58_customer_memory_contact_notes_20260819` AS
SELECT * FROM `customer_memory`;
--> statement-breakpoint
ALTER TABLE `customers` ADD `company_background_notes` TEXT;
--> statement-breakpoint
ALTER TABLE `customers` ADD `last_contact_at` TEXT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `customer_follow_ups` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `customer_id` TEXT NOT NULL,
  `follow_up_at` TEXT NOT NULL,
  `content` TEXT NOT NULL,
  `next_follow_up_date` TEXT,
  `channel` TEXT,
  `created_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customer_follow_ups_customer_time_idx`
ON `customer_follow_ups` (`customer_id`, `follow_up_at` DESC);
--> statement-breakpoint
UPDATE `customers`
SET `company_background_notes` = TRIM(
  '【历史客户记忆】' || CHAR(10) ||
  CASE WHEN TRIM(COALESCE((SELECT birthday FROM customer_memory m WHERE m.customer_id = customers.id), '')) <> ''
    THEN '生日：' || (SELECT birthday FROM customer_memory m WHERE m.customer_id = customers.id) || CHAR(10) ELSE '' END ||
  CASE WHEN TRIM(COALESCE((SELECT product_preference FROM customer_memory m WHERE m.customer_id = customers.id), '')) <> ''
    THEN '产品偏好：' || (SELECT product_preference FROM customer_memory m WHERE m.customer_id = customers.id) || CHAR(10) ELSE '' END ||
  CASE WHEN TRIM(COALESCE((SELECT communication_style FROM customer_memory m WHERE m.customer_id = customers.id), '')) <> ''
    THEN '沟通方式：' || (SELECT communication_style FROM customer_memory m WHERE m.customer_id = customers.id) || CHAR(10) ELSE '' END ||
  CASE WHEN TRIM(COALESCE((SELECT personality FROM customer_memory m WHERE m.customer_id = customers.id), '')) <> ''
    THEN '性格：' || (SELECT personality FROM customer_memory m WHERE m.customer_id = customers.id) || CHAR(10) ELSE '' END ||
  CASE WHEN TRIM(COALESCE((SELECT where_met FROM customer_memory m WHERE m.customer_id = customers.id), '')) <> ''
    THEN '认识来源：' || (SELECT where_met FROM customer_memory m WHERE m.customer_id = customers.id) || CHAR(10) ELSE '' END ||
  CASE WHEN TRIM(COALESCE((SELECT important_preferences FROM customer_memory m WHERE m.customer_id = customers.id), '')) <> ''
    THEN '重要偏好：' || (SELECT important_preferences FROM customer_memory m WHERE m.customer_id = customers.id) || CHAR(10) ELSE '' END ||
  CASE WHEN TRIM(COALESCE((SELECT relationship_notes FROM customer_memory m WHERE m.customer_id = customers.id), '')) <> ''
    THEN '关系备注：' || (SELECT relationship_notes FROM customer_memory m WHERE m.customer_id = customers.id) ELSE '' END
)
WHERE TRIM(COALESCE(`company_background_notes`, '')) = ''
  AND EXISTS (
    SELECT 1 FROM `customer_memory` m
    WHERE m.customer_id = customers.id
      AND (TRIM(COALESCE(m.birthday, '')) <> '' OR TRIM(COALESCE(m.product_preference, '')) <> ''
        OR TRIM(COALESCE(m.communication_style, '')) <> '' OR TRIM(COALESCE(m.personality, '')) <> ''
        OR TRIM(COALESCE(m.where_met, '')) <> '' OR TRIM(COALESCE(m.important_preferences, '')) <> ''
        OR TRIM(COALESCE(m.relationship_notes, '')) <> '')
  );
