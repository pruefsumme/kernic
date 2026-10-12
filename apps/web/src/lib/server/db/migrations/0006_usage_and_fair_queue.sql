-- Size of each project's files, kept current on every change, so that the use
-- of a workspace can be added up without reading the disk.
ALTER TABLE projects ADD COLUMN bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN file_count integer NOT NULL DEFAULT 0;
-- Set once the size has been measured; null for projects from before this column.
ALTER TABLE projects ADD COLUMN measured_at timestamptz;

-- The compile queue serves accounts in turn: it has to know, per account, how
-- many compiles are waiting and running.
CREATE INDEX compile_jobs_requester_idx ON compile_jobs (requested_by)
	WHERE status IN ('queued', 'running');
