-- 20260610_phase2_search_completion.sql
--
-- Phase 2 completion — extend the tsvector-based search foundation to
-- the two surfaces the directive's example queries hit but
-- 20260607_search_foundation.sql skipped:
--
--   - document_versions (so "find revisions modified during TAR"
--     can match against change_log, moc_reference, signoff names)
--   - tickets (so "drawings awaiting engineering over 7 days" can
--     match by title/description/status/keyword)
--
-- Plus a documented synonym-dictionary extension path. The English
-- text-search config is the baseline; refineries that want
-- "exchanger" ⇄ "HE" ⇄ "heat exchanger" can add a custom dictionary
-- without touching the trigger.
--
-- Hold-state search is explicitly out of scope — holds don't exist
-- yet. That ships in Phase 5. The Phase 2 search surface is shaped
-- to accommodate holds when they arrive (separate per-table
-- tsvector + a thin lib function), not to predict their schema.

-- ─── document_versions.search_tsv ─────────────────────────────
-- Weighted: revision_label + moc_reference + source_file_name = A
-- (anchors a user would actually type), change_log = B, signoff
-- names = C.
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS search_tsv tsvector;

CREATE OR REPLACE FUNCTION document_versions_search_tsv_refresh()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
      setweight(to_tsvector('english', COALESCE(NEW.revision_label,'')),    'A')
   || setweight(to_tsvector('english', COALESCE(NEW.moc_reference,'')),     'A')
   || setweight(to_tsvector('english', COALESCE(NEW.source_file_name,'')),  'A')
   || setweight(to_tsvector('english', COALESCE(NEW.change_log,'')),        'B')
   || setweight(to_tsvector('english', COALESCE(NEW.issue_type,'')),        'B')
   || setweight(to_tsvector('english', COALESCE(NEW.change_type,'')),       'B')
   || setweight(to_tsvector('english', COALESCE(NEW.drawn_by_name,'')),     'C')
   || setweight(to_tsvector('english', COALESCE(NEW.checked_by_name,'')),   'C')
   || setweight(to_tsvector('english', COALESCE(NEW.approved_by_name,'')),  'C')
   || setweight(to_tsvector('english', COALESCE(NEW.created_by_name,'')),   'C');
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS document_versions_search_tsv_trg ON document_versions;
CREATE TRIGGER document_versions_search_tsv_trg
  BEFORE INSERT OR UPDATE OF revision_label, moc_reference, source_file_name,
                              change_log, issue_type, change_type,
                              drawn_by_name, checked_by_name, approved_by_name,
                              created_by_name
  ON document_versions
  FOR EACH ROW
  EXECUTE FUNCTION document_versions_search_tsv_refresh();

CREATE INDEX IF NOT EXISTS document_versions_search_tsv_idx
  ON document_versions USING GIN(search_tsv);

-- Idempotent backfill: touch a watched column to fire the trigger.
UPDATE document_versions SET revision_label = revision_label WHERE search_tsv IS NULL;

-- ─── tickets.search_tsv ───────────────────────────────────────
-- Weighted: ticket_id + title + requester_name = A, request_type +
-- unit + status = B, description + assigned drafter/engineer names
-- + search_keywords = C. Existing comments JSONB and history are NOT
-- flattened in — they grow without bound and would balloon the index
-- without proportionate value.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS search_tsv tsvector;

CREATE OR REPLACE FUNCTION tickets_search_tsv_refresh()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  keywords_text TEXT;
BEGIN
  keywords_text := COALESCE(array_to_string(NEW.search_keywords, ' '), '');
  NEW.search_tsv :=
      setweight(to_tsvector('english', COALESCE(NEW.ticket_id,'')),               'A')
   || setweight(to_tsvector('english', COALESCE(NEW.title,'')),                   'A')
   || setweight(to_tsvector('english', COALESCE(NEW.requester_name,'')),          'A')
   || setweight(to_tsvector('english', COALESCE(NEW.request_type,'')),            'B')
   || setweight(to_tsvector('english', COALESCE(NEW.unit,'')),                    'B')
   || setweight(to_tsvector('english', COALESCE(NEW.status,'')),                  'B')
   || setweight(to_tsvector('english', COALESCE(NEW.description,'')),             'C')
   || setweight(to_tsvector('english', COALESCE(NEW.assigned_drafter_name,'')),   'C')
   || setweight(to_tsvector('english', COALESCE(NEW.assigned_engineer_name,'')),  'C')
   || setweight(to_tsvector('english', keywords_text),                            'C');
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS tickets_search_tsv_trg ON tickets;
CREATE TRIGGER tickets_search_tsv_trg
  BEFORE INSERT OR UPDATE OF ticket_id, title, requester_name, request_type,
                              unit, status, description, assigned_drafter_name,
                              assigned_engineer_name, search_keywords
  ON tickets
  FOR EACH ROW
  EXECUTE FUNCTION tickets_search_tsv_refresh();

CREATE INDEX IF NOT EXISTS tickets_search_tsv_idx ON tickets USING GIN(search_tsv);

UPDATE tickets SET title = title WHERE search_tsv IS NULL;

-- ─── Synonym extension path (documentation only) ─────────────
--
-- To add a custom synonym dictionary for refinery vocabulary
-- ("exchanger" ⇄ "HE", "vessel" ⇄ "vsl", etc.):
--
--   1. Create a synonym dictionary file in the Postgres tsearch_data
--      directory (or use CREATE TEXT SEARCH DICTIONARY in newer
--      PG versions).
--   2. Create a custom text-search configuration that maps the
--      'asciiword' token type through the synonym dictionary
--      *before* the english_stem dictionary.
--   3. Swap `'english'` for the new config name in the trigger
--      functions above. Re-touch each table's watched columns to
--      rebuild search_tsv.
--
-- We deliberately do NOT install a default synonym dict — refineries
-- have site-specific vocabulary, and shipping a generic one would
-- create silent search drift.