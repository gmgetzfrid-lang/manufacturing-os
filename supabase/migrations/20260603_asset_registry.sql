-- 20260603_asset_registry.sql
-- Tagged Asset Registry — canonical equipment / instrument / valve
-- records with attached photo galleries.
--
-- Design choices:
-- 1. Generic 'assets' table, not 'equipment' — types are configurable
--    so a refinery uses 'Pump/Vessel/Instrument' and a pharma site can
--    add 'Reactor/Fermenter/Bioreactor' without code changes.
-- 2. Tag is UNIQUE per org, normalized at insert time. Avoids the
--    `FE-201` vs `FE201` vs `FE 201` triple-entry problem.
-- 3. Photos have a 3-state lifecycle (current/needs_verification/
--    superseded) so when an MOC modifies equipment we can flag the
--    affected photos for human review without deleting history.

-- ─── Asset types (per-org configurable taxonomy) ────────────────
CREATE TABLE IF NOT EXISTS asset_types (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,             -- "Pump", "Vessel", "Valve"
  icon       TEXT,                      -- lucide icon name (e.g. "activity")
  color      TEXT,                      -- palette key ("blue","amber",...)
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (org_id, name)
);
CREATE INDEX IF NOT EXISTS asset_types_org_idx ON asset_types(org_id, sort_order);

-- ─── Assets (canonical record per physical thing) ───────────────
CREATE TABLE IF NOT EXISTS assets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,            -- canonical: "FE-201"
  tag_normalized TEXT NOT NULL,         -- lowercase + stripped, for matching
  type_id     UUID REFERENCES asset_types(id) ON DELETE SET NULL,
  description TEXT,
  location    TEXT,                     -- "Unit 200 cold side, north side"
  library_id  UUID REFERENCES libraries(id) ON DELETE SET NULL,
  archived    BOOLEAN NOT NULL DEFAULT FALSE,
  metadata    JSONB DEFAULT '{}',
  cover_photo_id UUID,                  -- references asset_photos.id (set after photos exist)
  created_by  UUID NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (org_id, tag_normalized)
);
CREATE INDEX IF NOT EXISTS assets_org_tag_idx ON assets(org_id, tag);
CREATE INDEX IF NOT EXISTS assets_type_idx ON assets(type_id);
CREATE INDEX IF NOT EXISTS assets_library_idx ON assets(library_id) WHERE library_id IS NOT NULL;

-- ─── Photos attached to assets ──────────────────────────────────
CREATE TABLE IF NOT EXISTS asset_photos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  asset_id        UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  file_url        TEXT NOT NULL,        -- R2 storage path
  file_size       BIGINT,
  content_type    TEXT,
  captured_at     TIMESTAMPTZ,          -- when photo was taken (from EXIF or user-set)
  caption         TEXT,
  -- Lifecycle:
  status          TEXT NOT NULL DEFAULT 'current'
                  CHECK (status IN ('current','needs_verification','superseded')),
  status_reason   TEXT,                 -- "MOC-211 modified inlet"
  status_marked_by UUID,
  status_marked_at TIMESTAMPTZ,
  -- Provenance:
  uploaded_by     UUID NOT NULL,
  uploaded_at     TIMESTAMPTZ DEFAULT NOW(),
  metadata        JSONB DEFAULT '{}'    -- EXIF, GPS, etc.
);
CREATE INDEX IF NOT EXISTS asset_photos_asset_idx ON asset_photos(asset_id, status, captured_at DESC);
CREATE INDEX IF NOT EXISTS asset_photos_org_idx ON asset_photos(org_id);

-- Seed default asset types for any org that doesn't have any yet.
-- Customer admins can rename / delete / add new ones from the UI.
INSERT INTO asset_types (org_id, name, icon, color, sort_order)
SELECT o.id, t.name, t.icon, t.color, t.sort_order
FROM orgs o
CROSS JOIN (VALUES
  ('Equipment','box','slate',0),
  ('Pump','activity','blue',1),
  ('Vessel','box','purple',2),
  ('Valve','droplet','emerald',3),
  ('Instrument','zap','amber',4),
  ('Exchanger','zap','orange',5)
) AS t(name, icon, color, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM asset_types WHERE org_id = o.id
)
ON CONFLICT DO NOTHING;
