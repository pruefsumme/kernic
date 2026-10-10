-- Account self-service, invitations and an audit log.

-- A public handle for a session, so one can be listed and revoked without
-- exposing anything derived from its token. Also what device it was created on.
ALTER TABLE sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE sessions ADD COLUMN user_agent text;
CREATE UNIQUE INDEX sessions_id_idx ON sessions (id);

-- Single-use links: an invitation creates an account for `email`; a reset lets
-- `user_id` choose a new password. Only a hash of the link's token is stored.
CREATE TABLE account_links (
	token_hash text PRIMARY KEY,
	kind text NOT NULL CHECK (kind IN ('invite', 'reset')),
	email text CHECK (email = lower(email)),
	user_id uuid REFERENCES users (id) ON DELETE CASCADE,
	created_by uuid REFERENCES users (id) ON DELETE SET NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz NOT NULL,
	used_at timestamptz,
	CHECK ((kind = 'invite' AND email IS NOT NULL) OR (kind = 'reset' AND user_id IS NOT NULL))
);

-- Append-only record of security-relevant actions. The actor's email is copied
-- so the record stays readable after the account is gone.
CREATE TABLE audit_events (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	at timestamptz NOT NULL DEFAULT now(),
	actor_id uuid REFERENCES users (id) ON DELETE SET NULL,
	actor_email text,
	action text NOT NULL,
	-- What the action was about, in words: an email address, a project name.
	subject text,
	address text
);

CREATE INDEX audit_events_at_idx ON audit_events (at DESC);
