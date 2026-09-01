CREATE TABLE IF NOT EXISTS `backup_v21_tasks_cleanup_20260723` AS
SELECT * FROM `tasks`;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `deleted_at` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `purge_after` text;
--> statement-breakpoint
CREATE INDEX `tasks_cleanup_idx`
ON `tasks` (`deleted_at`, `purge_after`);
