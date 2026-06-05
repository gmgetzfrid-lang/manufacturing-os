-- 20260721_tickets_metadata.sql
-- Fix: drafting requests could not be created at all.
--
-- The New Request form (/requests/new) and the admin "Custom Categories"
-- feature both write a `metadata` JSONB blob onto the ticket:
--   * metadata.custom_categories[categoryId][fieldKey]  — admin-defined fields
--   * metadata.source_document { id, document_number, title, rev, path }
--                                                       — "Send to Drafting"
-- ...but the column was never added to `tickets`. PostgREST rejects the whole
-- INSERT with an unknown-column error, so every portal-created request failed
-- silently (the client wasn't checking the error) and no ticket was stored —
-- invisible to the requester's queue AND the admin approval/assignment queue.
--
-- Additive + idempotent. Safe to run on a live database.

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS metadata JSONB;

COMMENT ON COLUMN tickets.metadata IS
  'Free-form JSONB for drafting requests: custom_categories (admin-defined '
  'fields) and source_document (the doc a request was raised from). Null when '
  'a request uses none of these.';
