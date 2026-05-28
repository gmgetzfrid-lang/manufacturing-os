-- 20260606_operational_entity_graph.sql
--
-- Phase 1 — Operational Entity Graph.
--
-- Introduces the canonical Plant → Unit → System scope hierarchy that
-- documents and equipment hang off of. Until now, scope has lived as
-- freeform `unit TEXT` on tickets and as JSONB asset tags on documents.
-- That works at small scale but loses the operational graph the rest of
-- the platform (timelines, holds, scope-consolidation queue, whiteboard)
-- needs to query against.
--
-- Design choices:
--
-- 1. Strictly ADDITIVE. New tables, new nullable FK columns. No backfill,
--    no rewrite of existing rows, no destructive change. Every existing
--    document/asset/ticket keeps working with NULL scope until somebody
--    chooses to attach it.
--
-- 2. FK ON DELETE SET NULL on the document/asset side. Deleting a Unit
--    must never cascade into deleting drawings or equipment records —
--    the document is the source of truth, the scope is metadata.
--
-- 3. Per-org uniqueness on (org_id, code) where code is set. Two plants
--    in different orgs can share a code; within one org they cannot.
--    Names are NOT unique — refineries reuse names like "Crude Unit"
--    across plants, so uniqueness lives on the optional short code.
--
-- 4. RLS matches the existing org-member-all pattern from
--    20260605_rls_policies_new_tables.sql. Role-based authorization
--    (only Admins can delete a Plant) is application-level, not RLS.

-- ─── Plants ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  code        TEXT,                      -- short code, e.g. "BR" for Baton Rouge
  description TEXT,
  location    TEXT,                      -- physical/geographic location
  metadata    JSONB DEFAULT '{}',
  archived    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  created_by  UUID NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID
);
CREATE INDEX IF NOT EXISTS plants_org_idx ON plants(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS plants_org_code_uniq
  ON plants(org_id, code) WHERE code IS NOT NULL;

-- ─── Units (inside a Plant) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS units (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  plant_id    UUID NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,             -- "Crude Unit", "Coker", "FCC"
  code        TEXT,                      -- "U100", "U200"
  description TEXT,
  metadata    JSONB DEFAULT '{}',
  archived    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  created_by  UUID NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID
);
CREATE INDEX IF NOT EXISTS units_org_idx ON units(org_id);
CREATE INDEX IF NOT EXISTS units_plant_idx ON units(plant_id);
CREATE UNIQUE INDEX IF NOT EXISTS units_plant_code_uniq
  ON units(plant_id, code) WHERE code IS NOT NULL;

-- ─── Systems (inside a Unit) ────────────────────────────────────
-- "System" is operational language for a logically-grouped piece of a
-- Unit: feed system, overhead system, instrument-air system, etc.
CREATE TABLE IF NOT EXISTS systems (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  unit_id     UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  plant_id    UUID NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,             -- "Overhead System", "Reflux"
  code        TEXT,
  description TEXT,
  metadata    JSONB DEFAULT '{}',
  archived    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  created_by  UUID NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID
);
CREATE INDEX IF NOT EXISTS systems_org_idx ON systems(org_id);
CREATE INDEX IF NOT EXISTS systems_unit_idx ON systems(unit_id);
CREATE INDEX IF NOT EXISTS systems_plant_idx ON systems(plant_id);
CREATE UNIQUE INDEX IF NOT EXISTS systems_unit_code_uniq
  ON systems(unit_id, code) WHERE code IS NOT NULL;

-- ─── Hang scope off existing tables (nullable, additive) ────────
--
-- Assets and documents both gain optional plant/unit/system pointers.
-- They denormalize plant_id and unit_id down to the system level so
-- queries like "all documents in Plant X" don't need a 3-way join.
-- Trade-off: a system that moves to a different unit requires updating
-- denormalized refs on its children. Acceptable — scope reorganization
-- is rare and is exactly the kind of operation that should leave an
-- audit trail.

ALTER TABLE assets ADD COLUMN IF NOT EXISTS plant_id  UUID REFERENCES plants(id)  ON DELETE SET NULL;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS unit_id   UUID REFERENCES units(id)   ON DELETE SET NULL;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS system_id UUID REFERENCES systems(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS assets_plant_idx  ON assets(plant_id)  WHERE plant_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_unit_idx   ON assets(unit_id)   WHERE unit_id   IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_system_idx ON assets(system_id) WHERE system_id IS NOT NULL;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS plant_id  UUID REFERENCES plants(id)  ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS unit_id   UUID REFERENCES units(id)   ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS system_id UUID REFERENCES systems(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS documents_plant_idx  ON documents(plant_id)  WHERE plant_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_unit_idx   ON documents(unit_id)   WHERE unit_id   IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_system_idx ON documents(system_id) WHERE system_id IS NOT NULL;

-- ─── RLS ────────────────────────────────────────────────────────
-- Matches the pattern from 20260605_rls_policies_new_tables.sql:
-- any active member of the org may read/write rows for that org.
-- App-level role gating (only Admin/DocCtrl can write Plants etc.)
-- is enforced in lib/, not at the DB.

ALTER TABLE plants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "plants_member_all" ON plants;
CREATE POLICY "plants_member_all" ON plants
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = plants.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = plants.org_id AND uid = auth.uid() AND status = 'active'));

ALTER TABLE units ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "units_member_all" ON units;
CREATE POLICY "units_member_all" ON units
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = units.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = units.org_id AND uid = auth.uid() AND status = 'active'));

ALTER TABLE systems ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "systems_member_all" ON systems;
CREATE POLICY "systems_member_all" ON systems
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = systems.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = systems.org_id AND uid = auth.uid() AND status = 'active'));
