-- Rendered preview pages are stored once per content hash and listed per job,
-- so a page that did not change between two compiles is neither stored nor
-- downloaded again. Each entry: {"hash": sha256, "width": pt, "height": pt}.

ALTER TABLE compile_jobs ADD COLUMN pages jsonb;
