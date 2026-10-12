-- Links that show the rendered pages of one project to anyone who has the
-- link, without an account. Only a hash of the token is stored.
CREATE TABLE project_shares (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	token_hash text NOT NULL UNIQUE,
	project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
	created_by uuid REFERENCES users (id) ON DELETE SET NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	-- Null for a link that stays valid until it is withdrawn.
	expires_at timestamptz,
	last_opened_at timestamptz
);

CREATE INDEX project_shares_project_idx ON project_shares (project_id);
