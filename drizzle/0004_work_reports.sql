CREATE TABLE IF NOT EXISTS `work_reports` (
  `id` text PRIMARY KEY NOT NULL,
  `report_type` text NOT NULL,
  `title` text NOT NULL,
  `start_date` text NOT NULL,
  `end_date` text NOT NULL,
  `scopes` text DEFAULT '[]' NOT NULL,
  `items` text DEFAULT '[]' NOT NULL,
  `source_summary` text DEFAULT '{}' NOT NULL,
  `source_details` text DEFAULT '[]' NOT NULL,
  `version_of` text,
  `confirmed_at` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `backup_v21_work_reports_20260724` AS
SELECT * FROM `work_reports`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `work_reports_history_idx`
ON `work_reports` (`confirmed_at`, `start_date`, `end_date`);
