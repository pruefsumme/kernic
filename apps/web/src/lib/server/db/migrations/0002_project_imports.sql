-- Uploaded archives that were analysed and are waiting for the user to confirm
-- or cancel the import. The extracted files are staged on disk under the same id.

CREATE TABLE project_imports (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	-- File name of the uploaded archive, for display.
	source_name text NOT NULL,
	-- analyzing -> ready -> imported, or analyzing -> rejected
	status text NOT NULL CHECK (status IN ('analyzing', 'ready', 'rejected', 'imported')),
	-- What the dry run found; see ImportReport in the application code.
	report jsonb,
	-- Why the archive was rejected.
	error text,
	project_id uuid REFERENCES projects (id) ON DELETE SET NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_imports_user_id_idx ON project_imports (user_id);
CREATE INDEX project_imports_created_at_idx ON project_imports (created_at);
