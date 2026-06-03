-- 20260712_collection_home_config.sql
-- Phase 4: let FOLDERS have their own customizable web-part home, like the
-- library root already does. Mirrors libraries.home_config. NULL = the
-- folder just shows its subfolders + documents (unchanged default).

ALTER TABLE collections ADD COLUMN IF NOT EXISTS home_config JSONB;
