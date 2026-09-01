CREATE TABLE IF NOT EXISTS `backup_customers_priority_20260817` AS
SELECT * FROM `customers`;

ALTER TABLE `customers` ADD `purchase_intent` TEXT;
ALTER TABLE `customers` ADD `purchase_ability` TEXT;
ALTER TABLE `customers` ADD `rating_reason` TEXT;
ALTER TABLE `customers` ADD `last_reviewed_at` TEXT;
