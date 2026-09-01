CREATE TABLE IF NOT EXISTS `backup_v22_knowledge_workflow_20260725`
AS SELECT * FROM `knowledge_items`;

ALTER TABLE `knowledge_items` ADD COLUMN `ai_processing_status` text DEFAULT 'source_only' NOT NULL;
ALTER TABLE `knowledge_items` ADD COLUMN `human_review_status` text DEFAULT 'pending_review' NOT NULL;
ALTER TABLE `knowledge_items` ADD COLUMN `processed_at` text;
ALTER TABLE `knowledge_items` ADD COLUMN `reviewed_at` text;

ALTER TABLE `sales_playbook_items` ADD COLUMN `knowledge_item_id` text;

UPDATE `knowledge_items`
SET
  `ai_processing_status` = CASE
    WHEN `source` = 'Universal Inbox' AND trim(COALESCE(`summary`, '')) <> '' THEN 'completed'
    ELSE 'source_only'
  END,
  `human_review_status` = CASE
    WHEN `joyce_approved` = 1 THEN 'approved'
    ELSE 'pending_review'
  END,
  `processed_at` = CASE
    WHEN `source` = 'Universal Inbox' AND trim(COALESCE(`summary`, '')) <> '' THEN `updated_at`
    ELSE NULL
  END,
  `reviewed_at` = CASE WHEN `joyce_approved` = 1 THEN `updated_at` ELSE NULL END;

UPDATE `knowledge_items`
SET
  `category` = CASE
    WHEN `category` = '待 AI 复核' THEN '销售知识'
    ELSE `category`
  END,
  `ai_processing_status` = 'completed',
  `human_review_status` = 'approved',
  `processed_at` = COALESCE(`processed_at`, `updated_at`),
  `reviewed_at` = COALESCE(`reviewed_at`, `updated_at`),
  `review_status` = 'approved',
  `joyce_approved` = 1
WHERE `id` IN (
  '771238a0-5b03-4e9e-916a-4702f9bd4fdf',
  'eda82392-1a24-4027-87b5-883d9210a666'
);

CREATE INDEX IF NOT EXISTS `knowledge_workflow_idx`
ON `knowledge_items` (`human_review_status`, `ai_processing_status`, `updated_at`);

CREATE UNIQUE INDEX IF NOT EXISTS `sales_playbook_knowledge_idx`
ON `sales_playbook_items` (`knowledge_item_id`)
WHERE `knowledge_item_id` IS NOT NULL;
