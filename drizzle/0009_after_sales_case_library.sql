CREATE TABLE IF NOT EXISTS `backup_v22_after_sales_case_library_20260729`
AS SELECT * FROM `after_sales_cases`;

ALTER TABLE `after_sales_cases` ADD COLUMN `case_title` text;
ALTER TABLE `after_sales_cases` ADD COLUMN `order_no` text;
ALTER TABLE `after_sales_cases` ADD COLUMN `fault_date` text;
ALTER TABLE `after_sales_cases` ADD COLUMN `tags` text NOT NULL DEFAULT '[]';
ALTER TABLE `after_sales_cases` ADD COLUMN `troubleshooting_process` text;
ALTER TABLE `after_sales_cases` ADD COLUMN `confirmed_cause` text;
ALTER TABLE `after_sales_cases` ADD COLUMN `reuse_solution` text;
ALTER TABLE `after_sales_cases` ADD COLUMN `full_technical_report` text;

UPDATE `after_sales_cases`
SET
  `case_title` = COALESCE(NULLIF(TRIM(`case_title`), ''), NULLIF(TRIM(`code`), ''), NULLIF(TRIM(`issue_description`), ''), '历史售后技术案例'),
  `troubleshooting_process` = COALESCE(
    NULLIF(TRIM(`troubleshooting_process`), ''),
    NULLIF(TRIM(`actions_taken`), '')
  ),
  `reuse_solution` = COALESCE(
    NULLIF(TRIM(`reuse_solution`), ''),
    NULLIF(TRIM(`resolution`), '')
  ),
  `full_technical_report` = COALESCE(
    NULLIF(TRIM(`full_technical_report`), ''),
    '【历史原始资料】' || CHAR(10) ||
    CASE WHEN TRIM(COALESCE(`original_customer_description`, '')) <> ''
      THEN '客户原始描述：' || `original_customer_description` || CHAR(10) ELSE '' END ||
    CASE WHEN TRIM(COALESCE(`issue_description`, '')) <> ''
      THEN '故障现象：' || `issue_description` || CHAR(10) ELSE '' END ||
    CASE WHEN TRIM(COALESCE(`evidence`, '')) <> ''
      THEN '证据/测试结果：' || `evidence` || CHAR(10) ELSE '' END ||
    CASE WHEN TRIM(COALESCE(`diagnosis`, '')) <> ''
      THEN '历史诊断或判断（未自动视为确认原因）：' || `diagnosis` || CHAR(10) ELSE '' END ||
    CASE WHEN TRIM(COALESCE(`engineering_response`, '')) <> ''
      THEN '工程回复：' || `engineering_response` || CHAR(10) ELSE '' END ||
    CASE WHEN TRIM(COALESCE(`actions_taken`, '')) <> ''
      THEN '排查/处理过程：' || `actions_taken` || CHAR(10) ELSE '' END ||
    CASE WHEN TRIM(COALESCE(`parts_sent`, '')) <> ''
      THEN '配件记录：' || `parts_sent` || CHAR(10) ELSE '' END ||
    CASE WHEN TRIM(COALESCE(`resolution`, '')) <> ''
      THEN '历史解决记录：' || `resolution` ELSE '' END
  );

CREATE INDEX IF NOT EXISTS `after_sales_case_library_updated_idx`
ON `after_sales_cases` (`updated_at`);

CREATE INDEX IF NOT EXISTS `after_sales_case_library_model_idx`
ON `after_sales_cases` (`vehicle_model`);
