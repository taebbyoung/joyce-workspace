CREATE TABLE IF NOT EXISTS backup_v45_projects_completed_at_20260812 AS
SELECT * FROM projects;

ALTER TABLE projects ADD COLUMN completed_at TEXT;

CREATE INDEX IF NOT EXISTS projects_completed_at_idx
  ON projects(completed_at DESC);
