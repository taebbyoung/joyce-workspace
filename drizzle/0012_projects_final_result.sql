CREATE TABLE IF NOT EXISTS backup_v46_projects_final_result_20260812 AS
SELECT * FROM projects;

ALTER TABLE projects ADD COLUMN final_result TEXT;
