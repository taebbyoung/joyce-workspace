CREATE TABLE IF NOT EXISTS `backup_v22_knowledge_essence_summary_20260725`
AS SELECT * FROM `knowledge_items`;

ALTER TABLE `knowledge_items` ADD COLUMN `essence_summary` text;
