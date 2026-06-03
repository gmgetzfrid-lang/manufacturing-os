-- 20260711_page_config.sql
-- Per-page customization (SharePoint-style) for library roots and folders:
-- a header/hero band and (Phase 3) a page background. Stored as JSONB so
-- the shape can grow without migrations. NULL = sensible defaults; a page
-- only shows a header band when it (or an ancestor/library) has a cover
-- image or an explicit header setting, so un-customized libraries are
-- visually unchanged.
--
--   page_config = {
--     header:     { height: 'none'|'compact'|'standard'|'tall', layout: 'overlay'|'plain' },
--     background: { type: 'none'|'tint'|'image', imagePath, opacity, tint }
--   }

ALTER TABLE libraries   ADD COLUMN IF NOT EXISTS page_config JSONB;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS page_config JSONB;
