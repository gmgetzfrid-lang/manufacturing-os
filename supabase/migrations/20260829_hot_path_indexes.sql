-- 20260829_hot_path_indexes.sql
--
-- Indexes for the query paths the daily cron + inbox now hit on every run.
-- Purely additive; apply in the Supabase SQL editor.

-- scanReviews sweeps pending sign-offs per org daily.
CREATE INDEX IF NOT EXISTS doc_review_signoffs_org_status_idx
  ON document_review_signoffs (org_id, status);

-- Live-intent lookups (overlap advisories, supersede notices) filter by
-- document over unexpired rows.
CREATE INDEX IF NOT EXISTS document_intents_doc_expires_idx
  ON document_intents (document_id, expires_at);

-- Ticket queues + KPIs filter by org + status constantly.
CREATE INDEX IF NOT EXISTS tickets_org_status_idx
  ON tickets (org_id, status);

-- The stale-checkout escalation dedupe probes notifications by metadata.
CREATE INDEX IF NOT EXISTS notifications_metadata_gin_idx
  ON notifications USING GIN (metadata jsonb_path_ops);

-- Distribution-ack nagging scans unacknowledged rows per org.
CREATE INDEX IF NOT EXISTS distribution_acks_org_pending_idx
  ON distribution_acks (org_id, requested_at) WHERE acknowledged_at IS NULL;
