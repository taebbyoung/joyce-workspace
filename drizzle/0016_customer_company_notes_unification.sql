CREATE TABLE IF NOT EXISTS `backup_v67_customers_company_notes_20260826` AS
SELECT * FROM `customers`;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `backup_v67_customer_memory_company_notes_20260826` AS
SELECT * FROM `customer_memory`;
--> statement-breakpoint
UPDATE `customers`
SET `company_background_notes` = CASE
  WHEN TRIM(COALESCE(`company_background_notes`, '')) = ''
    THEN '【V1 原备注】' || CHAR(10) || TRIM(`legacy_notes`)
  ELSE RTRIM(`company_background_notes`) || CHAR(10) || CHAR(10) ||
    '【V1 原备注】' || CHAR(10) || TRIM(`legacy_notes`)
END
WHERE TRIM(COALESCE(`legacy_notes`, '')) <> ''
  AND INSTR(COALESCE(`company_background_notes`, ''), '【V1 原备注】') = 0
  AND INSTR(COALESCE(`company_background_notes`, ''), TRIM(`legacy_notes`)) = 0;
--> statement-breakpoint
UPDATE `customers`
SET `company_background_notes` = CASE
  WHEN TRIM(COALESCE(`company_background_notes`, '')) = ''
    THEN '【V1 合作备注】' || CHAR(10) || TRIM((
      SELECT `relationship_notes` FROM `customer_memory` m WHERE m.`customer_id` = `customers`.`id`
    ))
  ELSE RTRIM(`company_background_notes`) || CHAR(10) || CHAR(10) ||
    '【V1 合作备注】' || CHAR(10) || TRIM((
      SELECT `relationship_notes` FROM `customer_memory` m WHERE m.`customer_id` = `customers`.`id`
    ))
END
WHERE EXISTS (
  SELECT 1 FROM `customer_memory` m
  WHERE m.`customer_id` = `customers`.`id`
    AND TRIM(COALESCE(m.`relationship_notes`, '')) <> ''
)
  AND INSTR(COALESCE(`company_background_notes`, ''), '【V1 合作备注】') = 0
  AND INSTR(COALESCE(`company_background_notes`, ''),
    TRIM((SELECT `relationship_notes` FROM `customer_memory` m WHERE m.`customer_id` = `customers`.`id`))) = 0;
