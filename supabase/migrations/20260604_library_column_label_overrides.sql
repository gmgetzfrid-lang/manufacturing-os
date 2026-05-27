-- 20260604_library_column_label_overrides.sql
-- Allow admins to rename system column labels (e.g. "Doc No" -> "Sheet No")
-- without losing the underlying column key. Stored as a JSONB map
-- { "documentNumber": "Sheet No", ... } on the library row.

ALTER TABLE libraries
  ADD COLUMN IF NOT EXISTS column_label_overrides JSONB DEFAULT '{}';
