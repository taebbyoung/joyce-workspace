CREATE TABLE IF NOT EXISTS `backup_v21_tasks_priority_20260724` AS
SELECT * FROM `tasks`;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `backup_v21_projects_priority_20260724` AS
SELECT * FROM `projects`;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `work_sort_order` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `priority_reason` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `priority_source` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `priority_ranked_at` text;
--> statement-breakpoint
ALTER TABLE `projects` ADD `work_sort_order` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `projects` ADD `priority_reason` text;
--> statement-breakpoint
ALTER TABLE `projects` ADD `priority_source` text;
--> statement-breakpoint
ALTER TABLE `projects` ADD `priority_ranked_at` text;
--> statement-breakpoint
CREATE INDEX `tasks_work_sort_idx`
ON `tasks` (`work_sort_order`, `status`, `archived_at`, `deleted_at`);
--> statement-breakpoint
CREATE INDEX `projects_work_sort_idx`
ON `projects` (`work_sort_order`, `status`);
