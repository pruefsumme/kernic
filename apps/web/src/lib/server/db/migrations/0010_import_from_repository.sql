-- An import can also come from a Git repository instead of a ZIP archive. What
-- is needed to connect the new project to that repository afterwards is kept
-- with the staged import: the address, the branch, and the access token (if one
-- was entered), encrypted. All of it goes away with the import.
ALTER TABLE project_imports
	ADD COLUMN remote_url text,
	ADD COLUMN remote_branch text,
	ADD COLUMN remote_username text,
	ADD COLUMN remote_token_sealed bytea;
