-- ─────────────────────────────────────────────────────────────────────────────
-- 20261255_df_roundG_consent_window.sql
--
-- drafting-flow Round G — DF-P7 CONSENT: the consent window (GAP-109) on the
-- availability record (GAP-113). DEC-38: no delivery record, no silent
-- advance. DEC-39: a warning before expiry; the non-response record lives on
-- the TICKET; an empty recipient set never advances.
--
--   (1) tickets gains ten nullable columns, nothing renamed — the window as
--       the ticket records it: consent_window_opened_at, _recipients (uids
--       FROZEN when it opens), _slot, _roster (the review it belongs to),
--       _warn_at, _closes_at, _warned_at, _expired_at, _objected_at,
--       _objected_by. All-or-none when open (CHECK). Workflow-owned: a
--       signed-in client may neither write nor insert one
--       (ticket_consent_window_guard, below — its own trigger, so
--       ticket_update_guard is NOT re-created here and keeps 20261250's body).
--   (2) ticket_notice_events (new) — the record that survives any bell purge:
--       one row per thing the clock did for one person (delivered, warned,
--       objected, expired, advanced, blocked) and EVID-9's "not emailed by
--       their choice" (not_emailed). APPEND-ONLY: an UPDATE is refused for
--       every role; a DELETE only once its ticket or its org is gone (their
--       ON DELETE CASCADE — the ticket shed keeps working), as
--       ticket_review_slot_events (20261242). Read as the ticket reads; a
--       not_emailed row only by the person it is about (a preference is
--       theirs). Only the service role writes.
--   (3) open_consent_window(...) — SECURITY DEFINER, search_path pinned,
--       EXECUTE for service_role only (DRLS-16), and it refuses any caller
--       with a session. In ONE transaction: one notification row per person
--       asked, one "delivered" event naming each row, and the ticket stamped
--       (the columns, the roster's mirror metadata.review_roster.consentWindow,
--       a history line naming everyone asked). Every person must be an active
--       member and one of the slot's own occupants; an empty set, a slot that
--       is not an open consent slot of the review open on the request, or a
--       count of rows that is not the count asked raises — and then nothing
--       at all is written: no rows, no timestamp, no clock (DEC-38).
--       The slot, its mode, its status and its occupants are read from the
--       roster LEDGER (ticket_review_slots, 20261242 — written only by the
--       service role), never from tickets.metadata alone: metadata stays
--       member-writable on a database where 20261166 is not applied, and a
--       forged roster must not open a window (DF-P7 fix pass). The metadata
--       mirror must agree as well. DEC-12 / DEC-37: the assigned drafter is
--       never asked (their silence is never a check), nor the requester on a
--       slot independent of the requester, nor (fix pass 2, DEC-37
--       slot-to-slot) anyone who signed, or can still sign, another slot of
--       this review that the consent slot must be independent of — or that
--       must be independent of it (the ledger's satisfied_by, primaries,
--       alternates and overriders).
--   (4) record_consent_window_warning(...) — the same shape for the reminder
--       (DEC-39): everyone asked (and the assignment queue the caller adds),
--       one "warned" event each, warned_at and the history line, together.
--   (5) ticket_review_slots (20261242): a slot may now be satisfied
--       'consent' — by a window that closed with no objection, a recorded
--       system act with no signer and no signature. The two CHECKs widen by
--       exactly that shape, and only on a consent_window slot (fix pass 2: a
--       blocking slot can never be recorded satisfied without a signer);
--       every other satisfied slot still names its signer and its signature.
--
-- The auto-advance itself (the cron's recorded system act — audit row first,
-- then the compare-and-set) is app code: app/api/cron/maintenance/route.ts
-- (one step, no new cron entry) → lib/consentWindowScan.ts.
--
-- WHERE A WINDOW CAN EXIST (DEC-90 rulings for DF-P7, enforced by the app —
-- lib/consentWindow.ts planConsentWindow): only on a routing slot a
-- workspace configures as consent_window; never on engineered work (the
-- highest class); never as the engineering sign-off; never with nobody to
-- ask; one per review. The seed and every unconfigured workspace have no
-- roster and so no window: today's blocking behaviour, exactly.
--
-- PASTE / DEPLOY ORDER. Paste AFTER 20261241 and 20261242 (the first
-- statement refuses otherwise, changing nothing). Independent of 20261250 /
-- 20261251 / 20261254, and of 20261166 (metadata workflow-owned): the two
-- functions trust the roster ledger, not metadata. Either order with the
-- DF-P7 deploy is safe; RECOMMENDED: deploy the app FIRST, then paste.
--   * App deployed, not pasted: the ticket row has no consent_window_*
--     columns, so every consent slot waits for a sign-off exactly as today
--     and the submission's response says so (consent windows need this
--     update); the maintenance step says "not run"; nothing reads a missing
--     column (42703 / PGRST204 / PGRST202 / 42883 / 42P01 / PGRST205 → today's
--     path, said).
--   * Pasted, app not yet deployed: the old app never calls the functions or
--     writes the columns; consent slots wait for a sign-off as before.
--   * A review already open at the paste keeps waiting for its sign-offs; a
--     window opens only when a draft is next submitted.
--
-- NOT A WIDENING for any person (no client gains a write; the two functions
-- are the service role's alone). It does let the workflow advance a review on
-- silence where a workspace configured a consent slot, so the inventory below
-- counts the configured consent slots and the reviews they sit on first.
-- Re-runnable: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS, each
-- CHECK dropped and re-added, CREATE OR REPLACE, DROP … IF EXISTS.
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'libraries' AND column_name = 'routing_control')
     OR to_regclass('public.ticket_review_slots') IS NULL
     OR to_regclass('public.ticket_review_slot_events') IS NULL THEN
    RAISE EXCEPTION '20261255 needs 20261241 (routing_control) and 20261242 (the review roster ledger) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate counts only; captured BEFORE the DDL) ────
DROP TABLE IF EXISTS df_round_g_255_before;
CREATE TEMP TABLE df_round_g_255_before AS
SELECT 1 AS ord, 'inventory (before apply): reviews open now (PENDING_REVIEW, roster not closed) whose roster carries a consent slot — each keeps waiting for its sign-offs; a window opens only when a draft is next submitted' AS inventory,
       COUNT(*)::text AS n
  FROM tickets t
 WHERE t.status = 'PENDING_REVIEW'
   AND jsonb_typeof(t.metadata->'review_roster') = 'object'
   AND (t.metadata->'review_roster'->>'closedAt') IS NULL
   AND jsonb_path_exists(t.metadata->'review_roster', '$.slots[*] ? (@.mode == "consent_window")')
UNION ALL
SELECT 2, 'inventory (before apply): routing tables (libraries + folders + documents) that declare a consent slot — from this paste a review under one may advance on silence where planConsentWindow allows it',
       ((SELECT COUNT(*) FROM libraries WHERE jsonb_path_exists(routing_control, '$.slots[*] ? (@.mode == "consent_window")'))
      + (SELECT COUNT(*) FROM collections WHERE jsonb_path_exists(routing_control, '$.slots[*] ? (@.mode == "consent_window")'))
      + (SELECT COUNT(*) FROM documents WHERE jsonb_path_exists(routing_control, '$.slots[*] ? (@.mode == "consent_window")')))::text
UNION ALL
SELECT 3, 'inventory (before apply): routing tables whose consent slot is filled by an engineering capability — such a slot never runs a window (it waits for a sign-off), and the editor refuses to save the table until it is made a sign-off (expected 0)',
       ((SELECT COUNT(*) FROM libraries WHERE jsonb_path_exists(routing_control, '$.slots[*] ? (@.mode == "consent_window" && (@.fill.capability == "ticket.final_approve" || @.fill.capability == "ticket.eng_review"))'))
      + (SELECT COUNT(*) FROM collections WHERE jsonb_path_exists(routing_control, '$.slots[*] ? (@.mode == "consent_window" && (@.fill.capability == "ticket.final_approve" || @.fill.capability == "ticket.eng_review"))'))
      + (SELECT COUNT(*) FROM documents WHERE jsonb_path_exists(routing_control, '$.slots[*] ? (@.mode == "consent_window" && (@.fill.capability == "ticket.final_approve" || @.fill.capability == "ticket.eng_review"))')))::text
UNION ALL
SELECT 4, 'inventory (before apply): consent slots on record in the roster ledger (ticket_review_slots, mode consent_window)',
       COUNT(*)::text FROM ticket_review_slots WHERE mode = 'consent_window';

BEGIN;

-- ── 1. the window on the ticket ─────────────────────────────────────────────
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS consent_window_opened_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS consent_window_recipients UUID[];
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS consent_window_slot TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS consent_window_roster UUID;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS consent_window_warn_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS consent_window_closes_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS consent_window_warned_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS consent_window_expired_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS consent_window_objected_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS consent_window_objected_by UUID;

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_consent_window_shape;
ALTER TABLE tickets ADD CONSTRAINT tickets_consent_window_shape CHECK (
  (consent_window_opened_at IS NULL AND consent_window_recipients IS NULL AND consent_window_slot IS NULL
   AND consent_window_roster IS NULL AND consent_window_warn_at IS NULL AND consent_window_closes_at IS NULL
   AND consent_window_warned_at IS NULL AND consent_window_expired_at IS NULL AND consent_window_objected_at IS NULL)
  OR
  (consent_window_opened_at IS NOT NULL AND consent_window_recipients IS NOT NULL AND cardinality(consent_window_recipients) > 0
   AND consent_window_slot IS NOT NULL AND consent_window_roster IS NOT NULL
   AND consent_window_warn_at > consent_window_opened_at AND consent_window_closes_at > consent_window_warn_at)
);
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_consent_window_objector;
ALTER TABLE tickets ADD CONSTRAINT tickets_consent_window_objector CHECK (consent_window_objected_by IS NULL OR consent_window_objected_at IS NOT NULL);

-- The columns are the workflow's: a signed-in client neither writes nor
-- inserts one. Its own trigger (SECURITY INVOKER, search_path pinned) so the
-- big guard keeps 20261250's body untouched; the service role passes.
CREATE OR REPLACE FUNCTION ticket_consent_window_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_bad TEXT[] := '{}';
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.consent_window_opened_at IS NOT NULL OR NEW.consent_window_recipients IS NOT NULL OR NEW.consent_window_slot IS NOT NULL
       OR NEW.consent_window_roster IS NOT NULL OR NEW.consent_window_warn_at IS NOT NULL OR NEW.consent_window_closes_at IS NOT NULL
       OR NEW.consent_window_warned_at IS NOT NULL OR NEW.consent_window_expired_at IS NOT NULL
       OR NEW.consent_window_objected_at IS NOT NULL OR NEW.consent_window_objected_by IS NOT NULL THEN
      RAISE EXCEPTION 'tickets: the consent window is the request workflow''s to open' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.consent_window_opened_at   IS DISTINCT FROM OLD.consent_window_opened_at   THEN v_bad := array_append(v_bad, 'consent_window_opened_at'); END IF;
  IF NEW.consent_window_recipients  IS DISTINCT FROM OLD.consent_window_recipients  THEN v_bad := array_append(v_bad, 'consent_window_recipients'); END IF;
  IF NEW.consent_window_slot        IS DISTINCT FROM OLD.consent_window_slot        THEN v_bad := array_append(v_bad, 'consent_window_slot'); END IF;
  IF NEW.consent_window_roster      IS DISTINCT FROM OLD.consent_window_roster      THEN v_bad := array_append(v_bad, 'consent_window_roster'); END IF;
  IF NEW.consent_window_warn_at     IS DISTINCT FROM OLD.consent_window_warn_at     THEN v_bad := array_append(v_bad, 'consent_window_warn_at'); END IF;
  IF NEW.consent_window_closes_at   IS DISTINCT FROM OLD.consent_window_closes_at   THEN v_bad := array_append(v_bad, 'consent_window_closes_at'); END IF;
  IF NEW.consent_window_warned_at   IS DISTINCT FROM OLD.consent_window_warned_at   THEN v_bad := array_append(v_bad, 'consent_window_warned_at'); END IF;
  IF NEW.consent_window_expired_at  IS DISTINCT FROM OLD.consent_window_expired_at  THEN v_bad := array_append(v_bad, 'consent_window_expired_at'); END IF;
  IF NEW.consent_window_objected_at IS DISTINCT FROM OLD.consent_window_objected_at THEN v_bad := array_append(v_bad, 'consent_window_objected_at'); END IF;
  IF NEW.consent_window_objected_by IS DISTINCT FROM OLD.consent_window_objected_by THEN v_bad := array_append(v_bad, 'consent_window_objected_by'); END IF;
  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'tickets: column(s) % are workflow-owned — use the request workflow actions', array_to_string(v_bad, ', ') USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION ticket_consent_window_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_ticket_consent_window_guard ON tickets;
CREATE TRIGGER trg_ticket_consent_window_guard
  BEFORE INSERT OR UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION ticket_consent_window_guard();

-- ── 2. the record that survives any bell purge (append-only) ────────────────
CREATE TABLE IF NOT EXISTS ticket_notice_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  roster_id UUID,
  slot_kind TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('delivered', 'warned', 'objected', 'expired', 'advanced', 'blocked', 'not_emailed')),
  recipient UUID,
  notification_id UUID,
  actor_id UUID,
  actor_name TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ticket_notice_events_ticket_idx ON ticket_notice_events (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS ticket_notice_events_roster_idx ON ticket_notice_events (roster_id, kind) WHERE roster_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ticket_notice_events_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'ticket_notice_events is append-only: a notice record is never rewritten.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A DELETE passes only once its ticket or its org is gone (the cascades of
  -- the ticket shed's delete and of an org's deletion — 20261242's rule).
  IF EXISTS (SELECT 1 FROM tickets WHERE id = OLD.ticket_id)
     AND EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id) THEN
    RAISE EXCEPTION 'ticket_notice_events is append-only: a notice record is removed only with its ticket.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION ticket_notice_events_append_only() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_ticket_notice_events_append_only ON ticket_notice_events;
CREATE TRIGGER trg_ticket_notice_events_append_only
BEFORE UPDATE OR DELETE ON ticket_notice_events
FOR EACH ROW EXECUTE FUNCTION ticket_notice_events_append_only();

ALTER TABLE ticket_notice_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_notice_events_read ON ticket_notice_events;
CREATE POLICY ticket_notice_events_read ON ticket_notice_events
  FOR SELECT TO authenticated
  USING ((kind <> 'not_emailed' OR recipient = auth.uid())
         AND EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_notice_events.ticket_id AND t.org_id = ticket_notice_events.org_id));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ticket_notice_events FROM anon, authenticated;
REVOKE ALL ON ticket_notice_events FROM anon;

-- ── 3. open_consent_window — rows and timestamp in ONE transaction ──────────
CREATE OR REPLACE FUNCTION open_consent_window(
  p_ticket UUID, p_roster UUID, p_slot TEXT, p_recipients UUID[],
  p_warn_at TIMESTAMPTZ, p_closes_at TIMESTAMPTZ, p_title TEXT, p_body TEXT, p_history JSONB
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_t tickets%ROWTYPE;
  v_slot JSONB;
  v_ls ticket_review_slots%ROWTYPE;
  v_now TIMESTAMPTZ := now();
  v_asked INTEGER;
  v_n INTEGER;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'open_consent_window is the request workflow''s alone' USING ERRCODE = '42501';
  END IF;
  -- DEC-39: nobody asked, nobody declined to object — never a window.
  IF p_recipients IS NULL OR cardinality(p_recipients) = 0 OR array_position(p_recipients, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'consent window: nobody to ask — no window is opened' USING ERRCODE = '22023';
  END IF;
  v_asked := (SELECT COUNT(DISTINCT r) FROM unnest(p_recipients) r);
  IF v_asked <> cardinality(p_recipients) THEN
    RAISE EXCEPTION 'consent window: a person is named twice' USING ERRCODE = '22023';
  END IF;
  IF p_warn_at IS NULL OR p_closes_at IS NULL OR p_warn_at <= v_now OR p_closes_at <= p_warn_at THEN
    RAISE EXCEPTION 'consent window: the reminder must fall after now and before the window closes' USING ERRCODE = '22023';
  END IF;
  IF p_history IS NULL OR jsonb_typeof(p_history) <> 'object' OR p_title IS NULL OR btrim(p_title) = '' THEN
    RAISE EXCEPTION 'consent window: the notice and its history line are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_t FROM tickets WHERE id = p_ticket FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'consent window: no such request' USING ERRCODE = 'P0002';
  END IF;
  IF v_t.status <> 'PENDING_REVIEW' OR v_t.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'consent window: the request is not in review' USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_t.metadata->'review_roster'->>'id', '') <> p_roster::text
     OR (v_t.metadata->'review_roster'->>'closedAt') IS NOT NULL THEN
    RAISE EXCEPTION 'consent window: that review is not the one open on the request' USING ERRCODE = '55000';
  END IF;
  IF v_t.consent_window_opened_at IS NOT NULL AND v_t.consent_window_roster = p_roster THEN
    RAISE EXCEPTION 'consent window: already open for this review' USING ERRCODE = '23505';
  END IF;
  SELECT s INTO v_slot
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_t.metadata->'review_roster'->'slots') = 'array'
                                   THEN v_t.metadata->'review_roster'->'slots' ELSE '[]'::jsonb END) s
   WHERE s->>'kind' = p_slot LIMIT 1;
  IF v_slot IS NULL OR v_slot->>'mode' IS DISTINCT FROM 'consent_window' OR v_slot->>'status' IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'consent window: that slot is not an open consent slot of this review' USING ERRCODE = '55000';
  END IF;
  -- The authority is the roster LEDGER (service-written), never metadata
  -- alone: the slot must be an open consent slot of THIS review there (not
  -- the management fallback), and every person asked one of ITS occupants.
  SELECT * INTO v_ls FROM ticket_review_slots
   WHERE ticket_id = p_ticket AND org_id = v_t.org_id AND roster_id = p_roster AND slot_kind = p_slot;
  IF NOT FOUND OR v_ls.mode <> 'consent_window' OR v_ls.status <> 'open' OR v_ls.fallback THEN
    RAISE EXCEPTION 'consent window: the review''s ledger has no open consent slot by that name — no window is opened' USING ERRCODE = '55000';
  END IF;
  IF NOT (p_recipients <@ v_ls.primaries) THEN
    RAISE EXCEPTION 'consent window: only the slot''s own occupants are asked' USING ERRCODE = '22023';
  END IF;
  -- DEC-12 / DEC-37: the producer's silence is never a check, nor that of a
  -- party the slot declares itself independent of.
  IF v_t.assigned_drafter_id IS NOT NULL AND v_t.assigned_drafter_id = ANY (p_recipients) THEN
    RAISE EXCEPTION 'consent window: the drafter is never asked — their silence is never consent' USING ERRCODE = '22023';
  END IF;
  IF 'requester' = ANY (v_ls.independent_of) AND v_t.requester_id = ANY (p_recipients) THEN
    RAISE EXCEPTION 'consent window: this slot is independent of the requester, who is never asked' USING ERRCODE = '22023';
  END IF;
  -- DEC-37 slot-to-slot (fix pass 2): nobody who signed, or can still sign,
  -- a slot of this review that this one must be independent of (or that
  -- must be independent of it) — their silence would stand for both.
  IF EXISTS (SELECT 1 FROM ticket_review_slots o
              WHERE o.ticket_id = p_ticket AND o.roster_id = p_roster AND o.slot_kind <> p_slot
                AND (o.slot_kind = ANY (v_ls.independent_of) OR p_slot = ANY (o.independent_of))
                AND ((o.status = 'satisfied' AND o.satisfied_by = ANY (p_recipients))
                     OR (o.status = 'open' AND (o.primaries && p_recipients OR o.alternates && p_recipients OR o.overriders && p_recipients)))) THEN
    RAISE EXCEPTION 'consent window: a person asked signs, or can sign, a sign-off this slot must be independent of — their silence is never a second look' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_recipients) r
              WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = v_t.org_id AND m.uid = r AND m.status = 'active')) THEN
    RAISE EXCEPTION 'consent window: a person to ask is no longer an active member — no window is opened' USING ERRCODE = '22023';
  END IF;

  -- The delivery record: one bell row per person, one "delivered" event
  -- naming each row — in this transaction, or not at all.
  WITH n AS (
    INSERT INTO notifications (org_id, user_id, kind, title, body, link, resource_type, resource_id, actor_name, metadata)
    SELECT v_t.org_id, r, 'ticket_status', p_title, p_body, '/requests/' || p_ticket::text, 'ticket', p_ticket::text, 'System',
           jsonb_build_object('action', 'consent_window_opened', 'status', 'PENDING_REVIEW',
                              'consentWindow', jsonb_build_object('roster', p_roster, 'slot', p_slot, 'closesAt', p_closes_at))
      FROM unnest(p_recipients) r
    RETURNING id, user_id
  )
  INSERT INTO ticket_notice_events (org_id, ticket_id, roster_id, slot_kind, kind, recipient, notification_id, actor_name, details)
  SELECT v_t.org_id, p_ticket, p_roster, p_slot, 'delivered', n.user_id, n.id, 'system:consent-window',
         jsonb_build_object('warnAt', p_warn_at, 'closesAt', p_closes_at)
    FROM n;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_asked THEN
    RAISE EXCEPTION 'consent window: not every person asked could be told (% of %) — no window is opened', v_n, v_asked USING ERRCODE = 'P0001';
  END IF;

  -- …and only then the clock: the columns, the roster's mirror, the history.
  UPDATE tickets SET
    consent_window_opened_at = v_now,
    consent_window_recipients = p_recipients,
    consent_window_slot = p_slot,
    consent_window_roster = p_roster,
    consent_window_warn_at = p_warn_at,
    consent_window_closes_at = p_closes_at,
    consent_window_warned_at = NULL,
    consent_window_expired_at = NULL,
    consent_window_objected_at = NULL,
    consent_window_objected_by = NULL,
    metadata = jsonb_set(metadata, '{review_roster,consentWindow}',
                 jsonb_build_object('slot', p_slot, 'openedAt', v_now, 'warnAt', p_warn_at, 'closesAt', p_closes_at, 'recipients', to_jsonb(p_recipients)), true),
    history = COALESCE(history, '[]'::jsonb) || jsonb_build_array(p_history || jsonb_build_object('date', v_now)),
    last_modified = v_now
  WHERE id = p_ticket;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION open_consent_window(UUID, UUID, TEXT, UUID[], TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION open_consent_window(UUID, UUID, TEXT, UUID[], TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, JSONB) TO service_role;

-- ── 4. record_consent_window_warning — the reminder, the same shape ─────────
CREATE OR REPLACE FUNCTION record_consent_window_warning(
  p_ticket UUID, p_roster UUID, p_recipients UUID[], p_title TEXT, p_body TEXT, p_history JSONB
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_t tickets%ROWTYPE;
  v_now TIMESTAMPTZ := now();
  v_asked INTEGER;
  v_n INTEGER;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'record_consent_window_warning is the request workflow''s alone' USING ERRCODE = '42501';
  END IF;
  IF p_recipients IS NULL OR cardinality(p_recipients) = 0 OR array_position(p_recipients, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'consent window: nobody to remind' USING ERRCODE = '22023';
  END IF;
  IF p_history IS NULL OR jsonb_typeof(p_history) <> 'object' OR p_title IS NULL OR btrim(p_title) = '' THEN
    RAISE EXCEPTION 'consent window: the reminder and its history line are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_t FROM tickets WHERE id = p_ticket FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'consent window: no such request' USING ERRCODE = 'P0002';
  END IF;
  IF v_t.status <> 'PENDING_REVIEW' OR v_t.archived_at IS NOT NULL
     OR v_t.consent_window_opened_at IS NULL OR v_t.consent_window_roster IS DISTINCT FROM p_roster
     OR v_t.consent_window_warned_at IS NOT NULL OR v_t.consent_window_expired_at IS NOT NULL OR v_t.consent_window_objected_at IS NOT NULL
     OR COALESCE(v_t.metadata->'review_roster'->>'id', '') <> p_roster::text THEN
    RAISE EXCEPTION 'consent window: no running window on this review awaits its reminder' USING ERRCODE = '55000';
  END IF;
  IF NOT (v_t.consent_window_recipients <@ p_recipients) THEN
    RAISE EXCEPTION 'consent window: the reminder must reach everyone who was asked' USING ERRCODE = '22023';
  END IF;
  v_asked := (SELECT COUNT(DISTINCT r) FROM unnest(p_recipients) r);

  WITH n AS (
    INSERT INTO notifications (org_id, user_id, kind, title, body, link, resource_type, resource_id, actor_name, metadata)
    SELECT v_t.org_id, r, 'ticket_status', p_title, p_body, '/requests/' || p_ticket::text, 'ticket', p_ticket::text, 'System',
           jsonb_build_object('action', 'consent_window_warned', 'status', 'PENDING_REVIEW',
                              'consentWindow', jsonb_build_object('roster', p_roster, 'slot', v_t.consent_window_slot, 'closesAt', v_t.consent_window_closes_at))
      FROM (SELECT DISTINCT r FROM unnest(p_recipients) r) x
    RETURNING id, user_id
  )
  INSERT INTO ticket_notice_events (org_id, ticket_id, roster_id, slot_kind, kind, recipient, notification_id, actor_name, details)
  SELECT v_t.org_id, p_ticket, p_roster, v_t.consent_window_slot, 'warned', n.user_id, n.id, 'system:consent-window',
         jsonb_build_object('asked', n.user_id = ANY (v_t.consent_window_recipients), 'closesAt', v_t.consent_window_closes_at)
    FROM n;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_asked THEN
    RAISE EXCEPTION 'consent window: not every person could be reminded (% of %) — the reminder is not recorded', v_n, v_asked USING ERRCODE = 'P0001';
  END IF;

  UPDATE tickets SET
    consent_window_warned_at = v_now,
    metadata = jsonb_set(metadata, '{review_roster,consentWindow,warnedAt}', to_jsonb(v_now), true),
    history = COALESCE(history, '[]'::jsonb) || jsonb_build_array(p_history || jsonb_build_object('date', v_now)),
    last_modified = v_now
  WHERE id = p_ticket;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION record_consent_window_warning(UUID, UUID, UUID[], TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_consent_window_warning(UUID, UUID, UUID[], TEXT, TEXT, JSONB) TO service_role;

-- ── 5. the roster ledger: a slot satisfied by a window, by exactly that shape
ALTER TABLE ticket_review_slots DROP CONSTRAINT IF EXISTS ticket_review_slots_satisfied_via_check;
ALTER TABLE ticket_review_slots ADD CONSTRAINT ticket_review_slots_satisfied_via_check
  CHECK (satisfied_via IS NULL OR satisfied_via IN ('primary', 'alternate', 'override', 'consent'));
ALTER TABLE ticket_review_slots DROP CONSTRAINT IF EXISTS ticket_review_slots_satisfied_shape;
ALTER TABLE ticket_review_slots ADD CONSTRAINT ticket_review_slots_satisfied_shape CHECK (
  (status = 'satisfied') = (satisfied_at IS NOT NULL AND (
    (satisfied_by IS NOT NULL AND signature_id IS NOT NULL AND satisfied_via IS DISTINCT FROM 'consent')
    OR (satisfied_via = 'consent' AND mode = 'consent_window' AND satisfied_by IS NULL AND signature_id IS NULL)))
);

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 10 on a correct paste. Inventory rows: n = the count.
-- One ordered result set (fix pass 2: the order is the outer ORDER BY,
-- never an ORDER BY inside a UNION ALL branch).
SELECT "check", ok, n FROM (
SELECT 1 AS sec, 1 AS ord, 'GAP-113: the ten consent_window_* columns are on tickets, all-or-none when open (CHECK)' AS check,
       (SELECT COUNT(*) = 10 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'tickets' AND column_name LIKE 'consent\_window\_%')
       AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_consent_window_shape')
       AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_consent_window_objector') AS ok,
       NULL::text AS n
UNION ALL
SELECT 1, 2, 'the columns are workflow-owned: a client neither writes nor inserts one (trigger enabled; SECURITY INVOKER, search_path pinned)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ticket_consent_window_guard' AND NOT tgisinternal AND tgenabled = 'O')
       AND (SELECT NOT prosecdef AND proconfig @> ARRAY['search_path=public'] FROM pg_proc WHERE proname = 'ticket_consent_window_guard'),
       NULL
UNION ALL
SELECT 1, 3, 'DEC-39: ticket_notice_events exists, row security on, append-only (BEFORE UPDATE OR DELETE trigger, enabled)',
       (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public' AND c.relname = 'ticket_notice_events')
       AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ticket_notice_events_append_only' AND NOT tgisinternal AND tgenabled = 'O'),
       NULL
UNION ALL
SELECT 1, 4, 'read follows the ticket (a not_emailed row only by its person); one SELECT policy; no write policy; no client write grant',
       (SELECT COUNT(*) = 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ticket_notice_events' AND cmd = 'SELECT'
         AND qual LIKE '%FROM tickets t%' AND qual LIKE '%not_emailed%')
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ticket_notice_events' AND cmd <> 'SELECT')
       AND NOT has_table_privilege('authenticated', 'public.ticket_notice_events', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.ticket_notice_events', 'UPDATE')
       AND NOT has_table_privilege('authenticated', 'public.ticket_notice_events', 'DELETE')
       AND NOT has_table_privilege('anon', 'public.ticket_notice_events', 'SELECT'),
       NULL
UNION ALL
SELECT 1, 5, 'DEC-38 / DRLS-16: open_consent_window is SECURITY DEFINER, search_path pinned, EXECUTE for service_role only',
       (SELECT prosecdef AND proconfig @> ARRAY['search_path=public'] FROM pg_proc WHERE proname = 'open_consent_window')
       AND NOT has_function_privilege('anon', 'public.open_consent_window(uuid,uuid,text,uuid[],timestamptz,timestamptz,text,text,jsonb)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.open_consent_window(uuid,uuid,text,uuid[],timestamptz,timestamptz,text,text,jsonb)', 'EXECUTE')
       AND has_function_privilege('service_role', 'public.open_consent_window(uuid,uuid,text,uuid[],timestamptz,timestamptz,text,text,jsonb)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 1, 6, 'DEC-38: the rows and the timestamp are ONE transaction — notifications, then the delivered events, then the count check, then the ticket stamp',
       (SELECT prosrc LIKE '%INSERT INTO notifications%INSERT INTO ticket_notice_events%''delivered''%GET DIAGNOSTICS v_n = ROW_COUNT;%IF v_n <> v_asked THEN%UPDATE tickets SET%consent_window_opened_at = v_now,%'
          FROM pg_proc WHERE proname = 'open_consent_window'),
       NULL
UNION ALL
SELECT 1, 7, 'fix pass: open_consent_window reads the roster ledger (ticket_review_slots) for the slot and its occupants, never asks the drafter, nor anyone who signs (or can sign) a slot it must be independent of',
       (SELECT prosrc LIKE '%FROM ticket_review_slots%p_recipients <@ v_ls.primaries%v_t.assigned_drafter_id = ANY (p_recipients)%p_slot = ANY (o.independent_of)%o.satisfied_by = ANY (p_recipients)%'
          FROM pg_proc WHERE proname = 'open_consent_window'),
       NULL
UNION ALL
SELECT 1, 8, 'DEC-39: record_consent_window_warning is SECURITY DEFINER, search_path pinned, service_role only, and reaches everyone asked',
       (SELECT prosecdef AND proconfig @> ARRAY['search_path=public'] AND prosrc LIKE '%consent_window_recipients <@ p_recipients%'
          FROM pg_proc WHERE proname = 'record_consent_window_warning')
       AND NOT has_function_privilege('anon', 'public.record_consent_window_warning(uuid,uuid,uuid[],text,text,jsonb)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.record_consent_window_warning(uuid,uuid,uuid[],text,text,jsonb)', 'EXECUTE')
       AND has_function_privilege('service_role', 'public.record_consent_window_warning(uuid,uuid,uuid[],text,text,jsonb)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 1, 9, 'the roster ledger takes a consent_window slot satisfied by a window (consent: no signer, no signature) and still requires both of every other satisfied slot',
       (SELECT pg_get_constraintdef(oid) LIKE '%consent%' FROM pg_constraint WHERE conname = 'ticket_review_slots_satisfied_via_check')
       AND (SELECT pg_get_constraintdef(oid) LIKE '%signature_id IS NOT NULL%' AND pg_get_constraintdef(oid) LIKE '%signature_id IS NULL%'
                   AND pg_get_constraintdef(oid) LIKE '%consent_window%'
              FROM pg_constraint WHERE conname = 'ticket_review_slots_satisfied_shape'),
       NULL
UNION ALL
SELECT 1, 10, 'the window notices are of a declared kind (notification_kinds() lists ticket_status — or the registry is absent and the rail with it)',
       COALESCE((SELECT bool_or(prosrc LIKE '%(''ticket_status'',%') FROM pg_proc WHERE proname = 'notification_kinds'), true),
       NULL
UNION ALL
SELECT 2, ord, inventory, NULL, n FROM df_round_g_255_before
UNION ALL
SELECT 3, 1, 'after: consent windows on record (tickets with consent_window_opened_at set — 0 right after the paste)', NULL,
       (SELECT COUNT(*) FROM tickets WHERE consent_window_opened_at IS NOT NULL)::text
) AS final_rows
ORDER BY sec, ord;
