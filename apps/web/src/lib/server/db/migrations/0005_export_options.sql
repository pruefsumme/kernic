-- Options of a PDF export (standard, pages, tags). Null for a preview and for an
-- export with the compiler's defaults.
ALTER TABLE compile_jobs ADD COLUMN options jsonb;
