-- 20260714_schema_catchup.sql
--
-- ONE-PASTE SCHEMA CATCH-UP for a database that's behind the app code.
--
-- Symptom this fixes:
--   * "Library not found" + a 400 when opening a library
--     (libraries/collections missing page_config / home_config / cover_* …)
--   * Execution schedule: can't mark in_progress / on_hold / blocked /
--     completed, and can't drag-drop to shift dates — the change reverts.
--     (milestones missing status_reason / actual_start_at / planned_start_at …
--      and/or the status CHECK constraint still rejects the newer statuses.)
--
-- Why: the app expects columns added by migrations 20260604 / 20260703 /
-- 20260705 / 20260706 / 20260709 / 20260710 / 20260711 / 20260712. If your DB
-- never applied them, every write to those columns returns PostgREST 400 and
-- the UI silently rolls back.
--
-- This file is the exact column set from those migrations, all IF NOT EXISTS,
-- so it is SAFE TO RUN whether or not you've applied some of them already. It
-- only ADDS columns/relaxes a CHECK — it never drops data.
--
-- HOW TO RUN: Supabase Dashboard → SQL Editor → paste this whole file → Run.

-- ── milestones ──────────────────────────────────────────────────────────────
ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS actual_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_by       UUID,
  ADD COLUMN IF NOT EXISTS completed_by_name  TEXT,
  ADD COLUMN IF NOT EXISTS status_reason      TEXT,
  ADD COLUMN IF NOT EXISTS parent_id          UUID REFERENCES milestones(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS planned_start_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS actual_start_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_summary         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS outline_level      INTEGER,
  ADD COLUMN IF NOT EXISTS wbs                TEXT,
  ADD COLUMN IF NOT EXISTS shift              TEXT,
  ADD COLUMN IF NOT EXISTS work_order_ref     TEXT,
  ADD COLUMN IF NOT EXISTS responsible_party  TEXT,
  ADD COLUMN IF NOT EXISTS responsible_kind   TEXT,
  ADD COLUMN IF NOT EXISTS responsible_org    TEXT,
  ADD COLUMN IF NOT EXISTS actual_party       TEXT,
  ADD COLUMN IF NOT EXISTS actual_kind        TEXT,
  ADD COLUMN IF NOT EXISTS actual_org         TEXT,
  ADD COLUMN IF NOT EXISTS location           TEXT,
  ADD COLUMN IF NOT EXISTS duration_hours     NUMERIC,
  ADD COLUMN IF NOT EXISTS attributes         JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS baseline_start_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS baseline_finish_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS baseline_set_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS baseline_set_by    UUID,
  -- Explicit finish-to-start dependencies (array of predecessor ids).
  ADD COLUMN IF NOT EXISTS depends_on         JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Allow the full status set the UI offers. Without this, writing
-- 'in_progress' / 'on_hold' / 'blocked' is rejected by the old CHECK.
ALTER TABLE milestones DROP CONSTRAINT IF EXISTS milestones_status_check;
ALTER TABLE milestones
  ADD CONSTRAINT milestones_status_check
  CHECK (status IN ('planned','in_progress','completed','missed','blocked','on_hold'));

-- ── libraries ───────────────────────────────────────────────────────────────
ALTER TABLE libraries
  ADD COLUMN IF NOT EXISTS column_label_overrides JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS color           TEXT,
  ADD COLUMN IF NOT EXISTS icon            TEXT,
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT,
  ADD COLUMN IF NOT EXISTS cover_tint      TEXT,
  ADD COLUMN IF NOT EXISTS home_config     JSONB,
  ADD COLUMN IF NOT EXISTS page_config     JSONB;

-- ── collections ─────────────────────────────────────────────────────────────
ALTER TABLE collections
  ADD COLUMN IF NOT EXISTS description     TEXT,
  ADD COLUMN IF NOT EXISTS color           TEXT,
  ADD COLUMN IF NOT EXISTS icon            TEXT,
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT,
  ADD COLUMN IF NOT EXISTS cover_tint      TEXT,
  ADD COLUMN IF NOT EXISTS home_config     JSONB,
  ADD COLUMN IF NOT EXISTS page_config     JSONB;

-- ── project team + responsibilities (20260716) ──────────────────────────────
ALTER TABLE project_members
  ADD COLUMN IF NOT EXISTS responsibility TEXT;
ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS responsible_user_id   UUID,
  ADD COLUMN IF NOT EXISTS responsible_user_name TEXT;
