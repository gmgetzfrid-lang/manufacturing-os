-- 20260709_library_folder_customization.sql
-- SharePoint-grade visual customization for libraries and folders:
-- a brand color, an icon, a cover image, an optional "duotone" tint
-- (recolor the cover with the workspace palette), and folder
-- descriptions. Purely presentational — no effect on ACL/RLS.

ALTER TABLE libraries
  ADD COLUMN IF NOT EXISTS color           TEXT,
  ADD COLUMN IF NOT EXISTS icon            TEXT,
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT,
  ADD COLUMN IF NOT EXISTS cover_tint      TEXT;   -- 'none' | 'brand' | 'mono'

ALTER TABLE collections
  ADD COLUMN IF NOT EXISTS description     TEXT,
  ADD COLUMN IF NOT EXISTS color           TEXT,
  ADD COLUMN IF NOT EXISTS icon            TEXT,
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT,
  ADD COLUMN IF NOT EXISTS cover_tint      TEXT;
