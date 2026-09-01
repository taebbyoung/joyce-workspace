CREATE TABLE IF NOT EXISTS `backup_v22_knowledge_structured_20260725`
AS SELECT * FROM `knowledge_items`;

CREATE TABLE IF NOT EXISTS `backup_v22_playbook_structured_20260725`
AS SELECT * FROM `sales_playbook_items`;

ALTER TABLE `knowledge_items` ADD COLUMN `categories` text DEFAULT '[]' NOT NULL;
ALTER TABLE `knowledge_items` ADD COLUMN `source_name` text;
ALTER TABLE `knowledge_items` ADD COLUMN `source_url` text;
ALTER TABLE `knowledge_items` ADD COLUMN `source_notes` text;
ALTER TABLE `knowledge_items` ADD COLUMN `essence_points` text DEFAULT '[]' NOT NULL;
ALTER TABLE `knowledge_items` ADD COLUMN `core_principles` text DEFAULT '[]' NOT NULL;
ALTER TABLE `knowledge_items` ADD COLUMN `actionable_tactics` text DEFAULT '[]' NOT NULL;
ALTER TABLE `knowledge_items` ADD COLUMN `applicable_scenarios` text DEFAULT '[]' NOT NULL;
ALTER TABLE `knowledge_items` ADD COLUMN `original_source_type` text;
ALTER TABLE `knowledge_items` ADD COLUMN `original_source_record_id` text;
ALTER TABLE `knowledge_items` ADD COLUMN `user_edited_fields` text DEFAULT '[]' NOT NULL;
ALTER TABLE `knowledge_items` ADD COLUMN `content_modified_at` text;

ALTER TABLE `sales_playbook_items` ADD COLUMN `title` text;
ALTER TABLE `sales_playbook_items` ADD COLUMN `principles` text DEFAULT '[]' NOT NULL;
ALTER TABLE `sales_playbook_items` ADD COLUMN `created_from` text;
ALTER TABLE `sales_playbook_items` ADD COLUMN `approved_by` text;
ALTER TABLE `sales_playbook_items` ADD COLUMN `approved_at` text;

UPDATE `knowledge_items`
SET
  `categories` = CASE
    WHEN `categories` = '[]' AND trim(COALESCE(`category`, '')) <> ''
      THEN json_array(`category`)
    ELSE `categories`
  END,
  `source_name` = COALESCE(NULLIF(`source_name`, ''), `source`),
  `original_source_type` = COALESCE(
    NULLIF(`original_source_type`, ''),
    CASE
      WHEN `source` = 'Universal Inbox' THEN 'universal_inbox'
      ELSE 'manual_or_import'
    END
  );

UPDATE `knowledge_items`
SET
  `essence_points` = CASE WHEN `essence_points` = '[]' THEN
    '["把销售沟通建立在客户真实痛点与决策链上","把服务体验视为长期关系和复购的一部分","用可验证的客户反馈持续修正沟通策略"]'
    ELSE `essence_points` END,
  `core_principles` = CASE WHEN `core_principles` = '[]' THEN
    '["先理解客户需求和顾虑，再提出方案","销售承诺必须与可交付的服务一致","重要沟通应围绕客户决策价值展开"]'
    ELSE `core_principles` END,
  `actionable_tactics` = CASE WHEN `actionable_tactics` = '[]' THEN
    '["记录客户痛点、异议与下一步","针对不同决策角色调整沟通重点","在关键节点主动确认客户体验"]'
    ELSE `actionable_tactics` END,
  `applicable_scenarios` = CASE WHEN `applicable_scenarios` = '[]' THEN
    '["客户开发","需求沟通","客户服务","长期关系维护"]'
    ELSE `applicable_scenarios` END
WHERE `id` = '771238a0-5b03-4e9e-916a-4702f9bd4fdf';

UPDATE `knowledge_items`
SET
  `essence_points` = CASE WHEN `essence_points` = '[]' THEN
    '["用客户痛点判断方案优先级，而不是堆叠产品卖点","识别真正影响采购的决策人和决策条件","拜访高层前应准备与其经营目标相关的证据"]'
    ELSE `essence_points` END,
  `core_principles` = CASE WHEN `core_principles` = '[]' THEN
    '["客户痛点必须由事实和提问验证","沟通对象不同，价值表达也应不同","高层沟通聚焦业务结果、风险和长期价值"]'
    ELSE `core_principles` END,
  `actionable_tactics` = CASE WHEN `actionable_tactics` = '[]' THEN
    '["拜访前列出已知痛点与待验证假设","梳理使用者、影响者和最终决策人","准备能支持关键价值判断的案例和数据"]'
    ELSE `actionable_tactics` END,
  `applicable_scenarios` = CASE WHEN `applicable_scenarios` = '[]' THEN
    '["客户痛点分析","关键客户拜访","高层决策沟通","销售方案准备"]'
    ELSE `applicable_scenarios` END
WHERE `id` = 'eda82392-1a24-4027-87b5-883d9210a666';

DROP INDEX IF EXISTS `sales_playbook_knowledge_idx`;
CREATE INDEX IF NOT EXISTS `sales_playbook_knowledge_idx`
ON `sales_playbook_items` (`knowledge_item_id`);

CREATE INDEX IF NOT EXISTS `knowledge_structured_status_idx`
ON `knowledge_items` (`human_review_status`, `ai_processing_status`, `updated_at`);
