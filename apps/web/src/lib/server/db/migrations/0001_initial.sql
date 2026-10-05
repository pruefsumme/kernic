-- Users, sessions, workspaces, projects and compile jobs.

CREATE TABLE users (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	-- Always stored lowercased; uniqueness is therefore case-insensitive.
	email text NOT NULL UNIQUE CHECK (email = lower(email)),
	display_name text NOT NULL,
	password_hash text NOT NULL,
	is_admin boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now(),
	disabled_at timestamptz
);

CREATE TABLE sessions (
	-- SHA-256 of the session token. The token itself only exists in the user's cookie.
	token_hash text PRIMARY KEY,
	user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT now(),
	last_seen_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz NOT NULL
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE workspaces (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	name text NOT NULL,
	kind text NOT NULL CHECK (kind IN ('personal', 'team')),
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
	workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX workspace_members_user_id_idx ON workspace_members (user_id);

CREATE TABLE projects (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	name text NOT NULL,
	-- Project-relative path of the Typst file that is compiled.
	entry_path text NOT NULL,
	-- Incremented on every change to the project's files. A render is current
	-- only if it was built from the latest revision.
	revision bigint NOT NULL DEFAULT 0,
	created_by uuid REFERENCES users (id) ON DELETE SET NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX projects_workspace_id_idx ON projects (workspace_id);

CREATE TABLE compile_jobs (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
	requested_by uuid REFERENCES users (id) ON DELETE SET NULL,
	format text NOT NULL CHECK (format IN ('svg', 'pdf')),
	-- queued -> running -> succeeded | failed (document errors) | errored (infrastructure)
	status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'errored')),
	-- Project revision the source snapshot was taken at; null until the job starts.
	revision bigint,
	-- Hash over the snapshot's paths and file hashes.
	source_hash text,
	entry_path text,
	diagnostics jsonb NOT NULL DEFAULT '[]',
	page_count integer,
	typst_version text,
	duration_ms integer,
	error text,
	created_at timestamptz NOT NULL DEFAULT now(),
	started_at timestamptz,
	finished_at timestamptz
);

CREATE INDEX compile_jobs_project_idx ON compile_jobs (project_id, created_at DESC);
CREATE INDEX compile_jobs_pending_idx ON compile_jobs (created_at) WHERE status IN ('queued', 'running');
