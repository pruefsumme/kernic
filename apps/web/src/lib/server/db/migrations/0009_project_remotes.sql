-- A Git repository elsewhere (on a Gitea or Forgejo, for example) that a
-- project's checkpoints are pushed to. One per project. The access token is
-- stored encrypted with a key that is not in the database.
CREATE TABLE project_remotes (
	project_id uuid PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
	url text NOT NULL,
	branch text NOT NULL,
	username text NOT NULL,
	token_sealed bytea NOT NULL,
	connected_by uuid REFERENCES users (id) ON DELETE SET NULL,
	connected_at timestamptz NOT NULL DEFAULT now(),
	last_pushed_at timestamptz,
	-- The checkpoint the repository's branch was at after the last push.
	last_pushed_checkpoint text
);
