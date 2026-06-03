-- 20260710_library_home_config.sql
-- Optional, customizable "home" board for a library root (SharePoint-style
-- web parts). NULL/absent = the library behaves exactly as before (folders
-- + documents). When an admin enables it, the configured parts render
-- above the browser. Purely presentational.

ALTER TABLE libraries
  ADD COLUMN IF NOT EXISTS home_config JSONB;
