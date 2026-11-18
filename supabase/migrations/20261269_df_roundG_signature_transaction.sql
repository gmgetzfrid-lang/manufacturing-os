-- ─────────────────────────────────────────────────────────────────────────────
-- 20261269_df_roundG_signature_transaction.sql
--
-- drafting-flow EVID-11 done-whens 2–4 — F4 SIGNATURE TRANSACTION (assigned
-- by the integrator, 2026-11-18, DEC-31; DEC-90 rulings: industry best
-- practice, fail-safe, no regression). One DEC-30 paste.
--
--   (1) record_signature_transaction(p_signature jsonb, p_audit jsonb,
--       p_pair jsonb, p_paired_at timestamptz) — NEW. The signing route
--       (app/api/signatures/sign) calls it on the service-role key, after it
--       has verified the re-authentication, read the signer from org_members,
--       taken the content hash from the version row and gated the intent —
--       none of which moves here. It performs exactly the writes the signing
--       act performs today, in today's order, with today's columns and
--       values, inside ONE transaction:
--         a. the e_signatures row — the route's own insert payload, column for
--            column (the ceremony trigger sees the service role, as today);
--         b. its ESIGNATURE_CAPTURED audit mirror — the route's own row, with
--            the signature's id in details.signatureId, as today. A mirror
--            the database refuses is kept in the audit outbox
--            (audit_dead_letters, DEC-109) IN THE SAME TRANSACTION and the
--            route answers today's warning; if the outbox write fails too,
--            NOTHING is written (no signature without a trail);
--         c. only when the browser names the roster row the signature
--            authorises (p_pair) — the read-and-understood roster
--            (document_acknowledgments) or the review sign-off roster
--            (document_review_signoffs) — the roster UPDATE the browser makes
--            today (lib/acknowledgments.ts recordAcknowledgment,
--            lib/reviewControl.ts recordReviewSignoff), with the same filters
--            and the same patch, performed AS THE SIGNER: the JWT claims are
--            set to the signer for that one statement (and restored after),
--            so the roster guards (enforce_document_ack_guard,
--            enforce_review_signoff_guard, review_signoff_owner_stamp) judge
--            it exactly as they judge the browser's write today; the row
--            level security the browser's write passes through (doc_ack_update
--            / doc_review_signoff_update USING and WITH CHECK, and the SELECT
--            policies its read-back needs) is re-done in the statement's WHERE
--            — on the signer's own row every one of them reduces to "the
--            signer is an active member of the row's workspace". A write that
--            matches no row raises P0002 and a guard's refusal raises its
--            23514: the signature and its mirror are rolled back with it, so a
--            signature never exists without its sign-off or the reverse.
--       SECURITY INVOKER, search_path pinned, executable by the service role
--       ONLY (never a client role: a signed-in caller who reached it would
--       mint a signature without a ceremony — it also refuses any caller
--       carrying a user JWT). Not a widening of who may sign anything: every
--       check the route makes stays in the route; every check the database
--       makes on the roster write is still made by the database.
--   (2) The reconciliation (EVID-11 done-when 4) — read-only statements over
--       e_signatures ↔ the rosters ↔ the audit trail
--       (lib/signatureReconciliation.ts, held here verbatim and pinned by a
--       test): their COUNTS are inventory rows below, before and after the
--       change. This paste writes no row, so the two agree.
--
-- APP BEFORE AND AFTER THE PASTE (the F4 deploy):
--   * App deployed, not pasted: the route's call answers PGRST202 / 42883
--     and it takes today's path, byte for byte — the service-role insert,
--     the checked audit insert (a refused one now also kept in the outbox),
--     the browser's own roster write. Nothing else changes.
--   * Pasted, app not deployed: nothing calls the function; the old app
--     writes what it always wrote.
--   * Both: every signature and its mirror land in one transaction, and a
--     read-and-understood or review sign-off lands with its roster row or
--     not at all ("Nothing was signed" — the signer signs again).
-- PASTE / DEPLOY ORDER: either order is safe; RECOMMENDED deploy first, then
-- paste. Paste AFTER 20261050 (the ceremony), 20261070 (the review guard),
-- 20261159 (the review sign-off owner stamp),
-- 20261219 (the audit outbox) and 20261242 (the ticket roster ledger the
-- reconciliation reads) — the first statement refuses, changing nothing,
-- without them. Independent of every other pending migration; re-creates no
-- existing function, policy or trigger. Re-runnable (CREATE OR REPLACE; the
-- grants re-stated); re-pasting changes nothing. NEVER-RE-PASTE notes: none.
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- REVERSAL: DROP FUNCTION public.record_signature_transaction(jsonb, jsonb,
-- jsonb, timestamptz); — the route answers PGRST202 and takes today's path.
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                   AND table_name = 'e_signatures' AND column_name = 'reauth_method')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_signature_ceremony' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '20261269 needs 20261050 (the signing ceremony) pasted first; nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                   AND table_name = 'document_review_signoffs' AND column_name = 'slot_group')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_review_signoff_guard' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_ack_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '20261269 needs 20261047 and 20261070 (the roster guards) pasted first; nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_review_signoff_owner_stamp' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '20261269 needs 20261159 (the review sign-off owner stamp) pasted first; nothing was changed.';
  END IF;
  IF to_regclass('public.audit_dead_letters') IS NULL THEN
    RAISE EXCEPTION '20261269 needs 20261219 (the audit outbox) pasted first; nothing was changed.';
  END IF;
  IF to_regclass('public.ticket_review_slots') IS NULL THEN
    RAISE EXCEPTION '20261269 needs 20261242 (the ticket roster ledger) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate counts only; captured BEFORE the DDL) ────
DROP TABLE IF EXISTS df_round_g_269_before;
CREATE TEMP TABLE df_round_g_269_before AS
SELECT 1 AS ord, 'inventory (before apply): e-signatures (all workspaces) — none is changed' AS inventory,
       COUNT(*)::text AS n FROM e_signatures
UNION ALL
SELECT 2, 'inventory (before apply): read-and-understood roster rows marked acknowledged — none is changed',
       COUNT(*)::text FROM document_acknowledgments WHERE status = 'acknowledged'
UNION ALL
SELECT 3, 'inventory (before apply): review sign-off rows marked signed — none is changed',
       COUNT(*)::text FROM document_review_signoffs WHERE status = 'signed'
UNION ALL
SELECT 4, 'inventory (before apply): record_signature_transaction present (0 = first apply; 1 = a re-run)',
       (to_regprocedure('public.record_signature_transaction(jsonb, jsonb, jsonb, timestamptz)') IS NOT NULL)::int::text
UNION ALL
SELECT 5, 'reconciliation (before apply): e-signatures with no ESIGNATURE_CAPTURED trail (no audit row naming it, no dead letter kept or recovered)',
       (SELECT COUNT(*) FROM (SELECT s.org_id, s.id FROM e_signatures s
 WHERE NOT EXISTS (SELECT 1 FROM audit_logs a
                    WHERE a.action = 'ESIGNATURE_CAPTURED' AND a.org_id = s.org_id
                      AND a.details ->> 'signatureId' = s.id::text)
   AND NOT EXISTS (SELECT 1 FROM audit_logs a
                    WHERE a.action = 'ESIGNATURE_CAPTURED' AND a.org_id = s.org_id
                      AND NOT (a.details ? 'signatureId') AND lower(a.resource_id) = s.resource_id::text
                      AND a.user_id = s.signer_user_id AND a.details ->> 'intent' = s.intent)
   AND NOT EXISTS (SELECT 1 FROM audit_dead_letters d
                    WHERE d.action = 'ESIGNATURE_CAPTURED' AND d.org_id = s.org_id
                      AND d.entry -> 'row' -> 'details' ->> 'signatureId' = s.id::text)
   AND NOT EXISTS (SELECT 1 FROM audit_logs a
                    WHERE a.action = 'AUDIT_DEAD_LETTER' AND a.org_id = s.org_id
                      AND a.details -> 'lost' -> 'details' ->> 'signatureId' = s.id::text)) q)::text
UNION ALL
SELECT 6, 'reconciliation (before apply): read-and-understood roster rows marked acknowledged whose signature is missing or not the assignee own for that revision',
       (SELECT COUNT(*) FROM (SELECT r.org_id, r.id FROM document_acknowledgments r
 WHERE r.status = 'acknowledged'
   AND NOT EXISTS (SELECT 1 FROM e_signatures s
                    WHERE s.id = r.signature_id AND s.org_id = r.org_id AND s.signer_user_id = r.assignee_user_id
                      AND (r.document_version_id IS NULL OR s.document_version_id IS NULL
                           OR s.document_version_id = r.document_version_id))) q)::text
UNION ALL
SELECT 7, 'reconciliation (before apply): review sign-off rows marked signed whose signature is missing or not the reviewer own for that draft',
       (SELECT COUNT(*) FROM (SELECT r.org_id, r.id FROM document_review_signoffs r
 WHERE r.status = 'signed'
   AND NOT EXISTS (SELECT 1 FROM e_signatures s
                    WHERE s.id = r.signature_id AND s.org_id = r.org_id AND s.signer_user_id = r.reviewer_user_id
                      AND s.document_version_id IS NOT DISTINCT FROM r.document_version_id)) q)::text
UNION ALL
SELECT 8, 'reconciliation (before apply): ticket review slots satisfied by a signature that does not exist in the workspace',
       (SELECT COUNT(*) FROM (SELECT t.org_id, t.id FROM ticket_review_slots t
 WHERE t.status = 'satisfied' AND t.signature_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM e_signatures s WHERE s.id = t.signature_id AND s.org_id = t.org_id)) q)::text
UNION ALL
SELECT 9, 'reconciliation (before apply): read-and-understood signatures whose signer is on that document roster (any revision) but that no roster row carries',
       (SELECT COUNT(*) FROM (SELECT s.org_id, s.id FROM e_signatures s
 WHERE s.intent = 'Acknowledged' AND s.resource_type = 'document'
   AND EXISTS (SELECT 1 FROM document_acknowledgments r
                WHERE r.document_id = s.resource_id AND r.assignee_user_id = s.signer_user_id)
   AND NOT EXISTS (SELECT 1 FROM document_acknowledgments r WHERE r.signature_id = s.id)) q)::text
UNION ALL
SELECT 10, 'reconciliation (before apply): review signatures whose signer is on that document review roster (any draft) but that no sign-off row carries',
       (SELECT COUNT(*) FROM (SELECT s.org_id, s.id FROM e_signatures s
  JOIN document_versions v ON v.id = s.document_version_id
 WHERE s.intent = 'Reviewed' AND s.resource_type = 'document_version'
   AND EXISTS (SELECT 1 FROM document_review_signoffs r
                WHERE r.document_id = v.record_id AND r.reviewer_user_id = s.signer_user_id)
   AND NOT EXISTS (SELECT 1 FROM document_review_signoffs r WHERE r.signature_id = s.id)) q)::text;

BEGIN;

-- ── 1. the signing act, in one transaction ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_signature_transaction(
  p_signature jsonb, p_audit jsonb, p_pair jsonb, p_paired_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public AS $fn$
DECLARE
  v_sig         e_signatures%ROWTYPE;
  v_kind        text := NULLIF(p_pair ->> 'kind', '');
  v_row_id      uuid;
  v_ids         uuid[];
  v_audit       jsonb;
  v_audit_err   text;
  v_prev_claims text;
  v_prev_sub    text;
BEGIN
  -- The service role only (EXECUTE is granted to it alone); a caller carrying
  -- a user JWT would be minting a signature with no ceremony.
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'record_signature_transaction is the signing route alone.' USING ERRCODE = '42501';
  END IF;
  IF v_kind IS NOT NULL AND v_kind NOT IN ('acknowledgment', 'review_signoff') THEN
    RAISE EXCEPTION 'record_signature_transaction: unknown roster kind %', v_kind USING ERRCODE = '22023';
  END IF;
  IF v_kind IS NOT NULL AND p_paired_at IS NULL THEN
    RAISE EXCEPTION 'record_signature_transaction: a roster write needs its time' USING ERRCODE = '22023';
  END IF;

  -- a. the signature — the insert payload of the route, column for column.
  INSERT INTO e_signatures (org_id, resource_type, resource_id, document_version_id, content_hash,
                            intent, statement, signer_user_id, signer_name, signer_role, signer_email,
                            signature_image, user_agent, signed_at, reauth_method, reauth_at, metadata)
  SELECT r.org_id, r.resource_type, r.resource_id, r.document_version_id, r.content_hash,
         r.intent, r.statement, r.signer_user_id, r.signer_name, r.signer_role, r.signer_email,
         r.signature_image, r.user_agent, r.signed_at, r.reauth_method, r.reauth_at, r.metadata
    FROM jsonb_populate_record(NULL::e_signatures, p_signature) r
  RETURNING * INTO v_sig;

  -- b. its audit mirror — the row of the route, naming the signature. A refused
  --    mirror is kept in the outbox (DEC-109) in this same transaction; an
  --    outbox write that fails too undoes everything.
  v_audit := jsonb_build_object(
    'action', p_audit ->> 'action', 'resource_id', p_audit ->> 'resource_id',
    'resource_type', p_audit ->> 'resource_type', 'org_id', p_audit ->> 'org_id',
    'user_id', p_audit ->> 'user_id', 'user_email', p_audit ->> 'user_email', 'user_role', p_audit ->> 'user_role',
    'details', COALESCE(p_audit -> 'details', '{}'::jsonb) || jsonb_build_object('signatureId', v_sig.id::text),
    'metadata', NULL);
  BEGIN
    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, user_role, details)
    SELECT r.action, r.resource_id, r.resource_type, r.org_id, r.user_id, r.user_email, r.user_role, r.details
      FROM jsonb_populate_record(NULL::audit_logs, v_audit) r;
  EXCEPTION WHEN OTHERS THEN
    v_audit_err := SQLERRM;
    BEGIN
      INSERT INTO audit_dead_letters (org_id, action, entry, error, source, reported_by)
      VALUES (v_sig.org_id, 'ESIGNATURE_CAPTURED', jsonb_build_object('row', v_audit, 'reporter', NULL),
              left(v_audit_err, 2000), 'server', NULL);
    EXCEPTION WHEN OTHERS THEN
      -- Neither the mirror nor the outbox: nothing is kept (the signer reads
      -- this sentence; the two refusals go to the detail for diagnosis).
      RAISE EXCEPTION 'The audit trail could not record this signature, so it was not kept. Try again; if it keeps happening, tell your administrator.'
        USING ERRCODE = 'P0001', DETAIL = left('mirror: ' || v_audit_err || ' / outbox: ' || SQLERRM, 2000);
    END;
  END;

  -- c. the roster row the signature authorises, written AS THE SIGNER (the
  --    guards judge it as they judge the browser write today); the row level
  --    security that write passes through is re-done in the WHERE.
  IF v_kind IS NOT NULL THEN
    v_prev_claims := current_setting('request.jwt.claims', true);
    v_prev_sub := current_setting('request.jwt.claim.sub', true);
    PERFORM set_config('request.jwt.claims',
      jsonb_build_object('sub', v_sig.signer_user_id::text, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_sig.signer_user_id::text, true);

    IF v_kind = 'acknowledgment' THEN
      IF v_sig.intent IS DISTINCT FROM 'Acknowledged' OR v_sig.resource_type IS DISTINCT FROM 'document' THEN
        RAISE EXCEPTION 'record_signature_transaction: an acknowledgment pairs an Acknowledged signature on a document'
          USING ERRCODE = '22023';
      END IF;
      v_row_id := NULLIF(p_pair ->> 'rosterId', '')::uuid;
      WITH done AS (
        UPDATE document_acknowledgments a
           SET status = 'acknowledged', signature_id = v_sig.id, acknowledged_at = p_paired_at, updated_at = p_paired_at
         WHERE a.assignee_user_id = v_sig.signer_user_id AND a.status = 'pending'
           AND CASE WHEN v_row_id IS NOT NULL THEN a.id = v_row_id
                    WHEN v_sig.document_version_id IS NOT NULL
                      THEN a.document_id = v_sig.resource_id AND a.document_version_id = v_sig.document_version_id
                    ELSE a.document_id = v_sig.resource_id END
           AND EXISTS (SELECT 1 FROM org_members om
                        WHERE om.org_id = a.org_id AND om.uid = v_sig.signer_user_id AND om.status = 'active')
        RETURNING a.id)
      SELECT array_agg(id) INTO v_ids FROM done;
    ELSE
      IF v_sig.intent IS DISTINCT FROM 'Reviewed' OR v_sig.resource_type IS DISTINCT FROM 'document_version' THEN
        RAISE EXCEPTION 'record_signature_transaction: a review sign-off pairs a Reviewed signature on a draft'
          USING ERRCODE = '22023';
      END IF;
      v_row_id := NULLIF(p_pair ->> 'signoffId', '')::uuid;
      IF v_row_id IS NULL THEN
        RAISE EXCEPTION 'record_signature_transaction: a review sign-off names its row' USING ERRCODE = '22023';
      END IF;
      WITH done AS (
        UPDATE document_review_signoffs s
           SET status = 'signed', signature_id = v_sig.id, signed_at = p_paired_at, updated_at = p_paired_at
         WHERE s.id = v_row_id AND s.reviewer_user_id = v_sig.signer_user_id
           AND EXISTS (SELECT 1 FROM org_members om
                        WHERE om.org_id = s.org_id AND om.uid = v_sig.signer_user_id AND om.status = 'active')
        RETURNING s.id)
      SELECT array_agg(id) INTO v_ids FROM done;
    END IF;

    PERFORM set_config('request.jwt.claims', COALESCE(v_prev_claims, ''), true);
    PERFORM set_config('request.jwt.claim.sub', COALESCE(v_prev_sub, ''), true);

    IF v_ids IS NULL THEN
      RAISE EXCEPTION 'record_signature_transaction: no % row of the signer matched; nothing was signed', v_kind
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'signature', to_jsonb(v_sig),
    'paired', CASE WHEN v_kind IS NULL THEN NULL
                   ELSE jsonb_build_object('kind', v_kind, 'rosterIds', to_jsonb(v_ids)) END,
    'auditError', v_audit_err);
END;
$fn$;
REVOKE ALL ON FUNCTION public.record_signature_transaction(jsonb, jsonb, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_signature_transaction(jsonb, jsonb, jsonb, timestamptz) TO service_role;

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 3 on a correct paste. Inventory rows: n = the count
-- (the reconciliation counts after equal those before: this paste writes no row).
SELECT "check", ok, n FROM (
SELECT 1 AS sec, 1 AS ord, 'EVID-11: record_signature_transaction exists; SECURITY INVOKER, search_path pinned; only the service role executes it (no client role, no PUBLIC)' AS check,
       COALESCE((SELECT NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                   FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = 'record_signature_transaction'), false)
       AND has_function_privilege('service_role', 'public.record_signature_transaction(jsonb, jsonb, jsonb, timestamptz)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.record_signature_transaction(jsonb, jsonb, jsonb, timestamptz)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.record_signature_transaction(jsonb, jsonb, jsonb, timestamptz)', 'EXECUTE') AS ok,
       NULL::text AS n
UNION ALL
SELECT 1, 2, 'the guards the roster write is judged by are installed and enabled (ceremony on e_signatures; acknowledgment guard; review sign-off guard and owner stamp)',
       (SELECT COUNT(*) = 4 FROM pg_trigger
         WHERE NOT tgisinternal AND tgenabled = 'O'
           AND tgname IN ('trg_signature_ceremony', 'trg_document_ack_guard', 'trg_review_signoff_guard', 'trg_review_signoff_owner_stamp')),
       NULL
UNION ALL
SELECT 1, 3, 'the audit outbox takes the service role write a refused mirror needs',
       has_table_privilege('service_role', 'public.audit_dead_letters', 'INSERT'),
       NULL
UNION ALL
SELECT 2, ord, inventory, NULL, n FROM df_round_g_269_before
UNION ALL
SELECT 3, 1, 'reconciliation (after): e-signatures with no ESIGNATURE_CAPTURED trail (no audit row naming it, no dead letter kept or recovered)', NULL,
       (SELECT COUNT(*) FROM (SELECT s.org_id, s.id FROM e_signatures s
 WHERE NOT EXISTS (SELECT 1 FROM audit_logs a
                    WHERE a.action = 'ESIGNATURE_CAPTURED' AND a.org_id = s.org_id
                      AND a.details ->> 'signatureId' = s.id::text)
   AND NOT EXISTS (SELECT 1 FROM audit_logs a
                    WHERE a.action = 'ESIGNATURE_CAPTURED' AND a.org_id = s.org_id
                      AND NOT (a.details ? 'signatureId') AND lower(a.resource_id) = s.resource_id::text
                      AND a.user_id = s.signer_user_id AND a.details ->> 'intent' = s.intent)
   AND NOT EXISTS (SELECT 1 FROM audit_dead_letters d
                    WHERE d.action = 'ESIGNATURE_CAPTURED' AND d.org_id = s.org_id
                      AND d.entry -> 'row' -> 'details' ->> 'signatureId' = s.id::text)
   AND NOT EXISTS (SELECT 1 FROM audit_logs a
                    WHERE a.action = 'AUDIT_DEAD_LETTER' AND a.org_id = s.org_id
                      AND a.details -> 'lost' -> 'details' ->> 'signatureId' = s.id::text)) q)::text
UNION ALL
SELECT 3, 2, 'reconciliation (after): read-and-understood roster rows marked acknowledged whose signature is missing or not the assignee own for that revision', NULL,
       (SELECT COUNT(*) FROM (SELECT r.org_id, r.id FROM document_acknowledgments r
 WHERE r.status = 'acknowledged'
   AND NOT EXISTS (SELECT 1 FROM e_signatures s
                    WHERE s.id = r.signature_id AND s.org_id = r.org_id AND s.signer_user_id = r.assignee_user_id
                      AND (r.document_version_id IS NULL OR s.document_version_id IS NULL
                           OR s.document_version_id = r.document_version_id))) q)::text
UNION ALL
SELECT 3, 3, 'reconciliation (after): review sign-off rows marked signed whose signature is missing or not the reviewer own for that draft', NULL,
       (SELECT COUNT(*) FROM (SELECT r.org_id, r.id FROM document_review_signoffs r
 WHERE r.status = 'signed'
   AND NOT EXISTS (SELECT 1 FROM e_signatures s
                    WHERE s.id = r.signature_id AND s.org_id = r.org_id AND s.signer_user_id = r.reviewer_user_id
                      AND s.document_version_id IS NOT DISTINCT FROM r.document_version_id)) q)::text
UNION ALL
SELECT 3, 4, 'reconciliation (after): ticket review slots satisfied by a signature that does not exist in the workspace', NULL,
       (SELECT COUNT(*) FROM (SELECT t.org_id, t.id FROM ticket_review_slots t
 WHERE t.status = 'satisfied' AND t.signature_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM e_signatures s WHERE s.id = t.signature_id AND s.org_id = t.org_id)) q)::text
UNION ALL
SELECT 3, 5, 'reconciliation (after): read-and-understood signatures whose signer is on that document roster (any revision) but that no roster row carries', NULL,
       (SELECT COUNT(*) FROM (SELECT s.org_id, s.id FROM e_signatures s
 WHERE s.intent = 'Acknowledged' AND s.resource_type = 'document'
   AND EXISTS (SELECT 1 FROM document_acknowledgments r
                WHERE r.document_id = s.resource_id AND r.assignee_user_id = s.signer_user_id)
   AND NOT EXISTS (SELECT 1 FROM document_acknowledgments r WHERE r.signature_id = s.id)) q)::text
UNION ALL
SELECT 3, 6, 'reconciliation (after): review signatures whose signer is on that document review roster (any draft) but that no sign-off row carries', NULL,
       (SELECT COUNT(*) FROM (SELECT s.org_id, s.id FROM e_signatures s
  JOIN document_versions v ON v.id = s.document_version_id
 WHERE s.intent = 'Reviewed' AND s.resource_type = 'document_version'
   AND EXISTS (SELECT 1 FROM document_review_signoffs r
                WHERE r.document_id = v.record_id AND r.reviewer_user_id = s.signer_user_id)
   AND NOT EXISTS (SELECT 1 FROM document_review_signoffs r WHERE r.signature_id = s.id)) q)::text
) AS final_rows
ORDER BY sec, ord;
