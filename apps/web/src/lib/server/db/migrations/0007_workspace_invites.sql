-- Links by which the owner of a shared workspace lets someone with an account
-- join it. As with account links, only a hash of the token is stored, and a
-- link works once.
CREATE TABLE workspace_invites (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	token_hash text NOT NULL UNIQUE,
	workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	-- Ownership is never handed out by link; an owner promotes a member.
	role text NOT NULL CHECK (role IN ('editor', 'viewer')),
	created_by uuid REFERENCES users (id) ON DELETE SET NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz NOT NULL,
	used_at timestamptz,
	used_by uuid REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX workspace_invites_workspace_idx ON workspace_invites (workspace_id);
