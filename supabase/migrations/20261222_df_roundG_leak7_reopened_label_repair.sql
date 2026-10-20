-- ─────────────────────────────────────────────────────────────────────────────
-- 20261222_df_roundG_leak7_reopened_label_repair.sql
--
-- drafting-flow Round G — DF-P12 DELIVERABLE FOLLOW-UPS: the LEAK-7 (a)-row
-- data repair (drafting-flow LEAK-7 / SM-5; DEC-15).
--
--   A ticket reopened BEFORE Round E (2026-09-17) went back to review under the
--   old three-line reopen_ticket, which kept its revision_count and its issued,
--   digits-only deliverable_rev. Such a row — LEAK-7 population (a) — sits at
--   PENDING_REVIEW / PENDING_FINAL_APPROVAL carrying an issued label, a state no
--   transition writes since Round E (submit_draft writes a letter label;
--   reopen_ticket nulls it and bumps the cycle). Since DF-P10 the verify
--   verdict reads its stale issue revision_in_progress and its next approval
--   re-cycles to a new number, so it is no longer unsafe; its counters are
--   still wrong. This file repairs them exactly as today's reopen_ticket
--   (lib/ticketTransitions.ts, WF-21 / DEC-15) would have: the label is
--   cleared, draft_iteration reset to 0, and revision_count moved to the
--   issued number N when it is below it (the usual N − 1 → N: "bump by one";
--   a count already at or past N — a reject_final before the old reopen — is
--   kept, so no number is skipped), with one history line saying so and
--   last_modified stamped (an open page's next action meets a fresh token).
--   Rev N stays the last issue on record: its history line is untouched.
--   A Final attached while the row sat in that state (attach_file is offered
--   at every live status) was recorded `rev: null` with the cycle it joined
--   in (`revCycle`, lib/ticketTransitions.ts joiningFileFields) — the OLD
--   count. The next issue stamps only the Finals of the cycle it closes
--   (stampIssuedFinals, the count before the issue), so where the count moves
--   such a Final's `revCycle` moves with it, from the old count to the new
--   one: it joined the new cycle, as it would have under today's reopen, and
--   the next issue stamps it. A Final of an earlier, rejected cycle (another
--   revCycle), a labelled file, and a file recorded before per-file
--   revisions (no `rev` key) are left exactly as they are; nothing else in
--   the attachments changes. Where the count is kept, nothing moves.
--
--   NOT repaired, counted (the inventory below):
--     (a′) a row of (a) that has since submitted a new draft carries a review
--          label of the SAME cycle as its real issue (1B after a real Rev 1).
--          Re-labelling it would contradict the drafts already printed under
--          that label; it reads "cannot confirm" until its next approval,
--          which re-cycles to a new number (SM-5, DF-P10).
--     (b)  a history that issues the same Rev N twice — two packages already
--          share the label; counters cannot tell their prints apart, and
--          neither can the file's identity (?a=): both packages' Finals
--          predate per-file revisions, so a new print carries no revision
--          (DF-P10's no-rev rule) and older paper names only the label (the
--          issued-twice rule) — every print answers "cannot confirm", never
--          green (lib/verifyTicketVerdict.ts).
--     (c)  an archived ticket carrying an issued label: its history is in the
--          archive bundle (a repeat there is unobservable from the database).
--     A row whose label is longer than six digits is left alone (it cannot be
--     a cycle number; counted), as is a row whose history is not an array.
--
-- PASTE / DEPLOY ORDER. Any time; either order with 20261221 and with the
-- DF-P12 deploy (no app code reads anything this file adds). The app before
-- and after the paste works the same for a repaired row: it reads as a ticket
-- reopened under DEC-15 — a print of Rev N answers revision_in_progress (as
-- the (a) row did since DF-P10), older prints superseded, and the next
-- approval issues Rev N+1 and stamps the Finals attached while the row sat
-- in the (a) state (before the paste the re-cycle reached the same number
-- with a note, and stamped them at the old count).
--
-- Not a widening. Runs as the paste's owner (auth.uid() IS NULL: the guard
-- passes it). Re-runnable: a second paste finds no (a) row and changes
-- nothing. Single paste: temp-table inventory (counts only) → BEGIN/UPDATE/
-- COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the repair) ────────
DROP TABLE IF EXISTS df_round_g_222_before;
CREATE TEMP TABLE df_round_g_222_before AS
SELECT 1 AS ord, 'inventory (before apply): LEAK-7 / SM-5 (a) — tickets under review still carrying an issued label (repaired by this paste)' AS inventory,
       COUNT(*)::text AS n
  FROM tickets
 WHERE status IN ('PENDING_REVIEW', 'PENDING_FINAL_APPROVAL')
   AND deliverable_rev ~ '^[0-9]{1,6}$'
   AND archived_at IS NULL
   AND (history IS NULL OR jsonb_typeof(history) = 'array')
UNION ALL
SELECT 2, 'inventory (before apply): (a) rows left alone — a label longer than six digits, or a history that is not an array',
       COUNT(*)::text
  FROM tickets
 WHERE status IN ('PENDING_REVIEW', 'PENDING_FINAL_APPROVAL')
   AND deliverable_rev ~ '^[0-9]+$'
   AND archived_at IS NULL
   AND (deliverable_rev !~ '^[0-9]{1,6}$' OR (history IS NOT NULL AND jsonb_typeof(history) <> 'array'))
UNION ALL
SELECT 3, 'inventory (before apply): (a′) under review on a review label of the same cycle as an issue its history records (not repaired: reads "cannot confirm" until its next approval re-cycles)',
       COUNT(*)::text
  FROM tickets t
 WHERE t.status IN ('PENDING_REVIEW', 'PENDING_FINAL_APPROVAL')
   AND t.deliverable_rev ~ '^[0-9]{1,6}[A-Z]+$'
   AND t.archived_at IS NULL
   AND jsonb_typeof(t.history) = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.history) AS h(entry),
                      LATERAL regexp_matches(COALESCE(h.entry ->> 'action', ''), '[[:<:]]issued Rev ([0-9]+)[[:>:]]') AS m(g)
                WHERE m.g[1]::numeric = substring(t.deliverable_rev from '^[0-9]+')::numeric)
UNION ALL
SELECT 4, 'inventory (before apply): LEAK-7 / SM-5 (b) — tickets whose history issues the same Rev label twice (any status; not repaired)',
       COUNT(*)::text
  FROM tickets t
 WHERE EXISTS (
   SELECT 1
     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.history) = 'array' THEN t.history ELSE '[]'::jsonb END) AS h(entry),
          LATERAL regexp_matches(h.entry ->> 'action', '[[:<:]]issued Rev ([0-9]+)[[:>:]]') AS m(g)
    GROUP BY m.g[1]
   HAVING COUNT(*) > 1)
UNION ALL
SELECT 5, 'inventory (before apply): LEAK-7 / SM-5 (c) — archived tickets carrying an issued label (history in the archive bundle; not repaired)',
       COUNT(*)::text
  FROM tickets
 WHERE archived_at IS NOT NULL
   AND deliverable_rev ~ '^[0-9]+$'
UNION ALL
SELECT 6, 'inventory (before apply): (a) rows whose count moves and that carry a Final waiting on the old cycle (rev null, revCycle = the count) — its revCycle moves to the new cycle with the count',
       COUNT(*)::text
  FROM tickets t
 WHERE t.status IN ('PENDING_REVIEW', 'PENDING_FINAL_APPROVAL')
   AND t.deliverable_rev ~ '^[0-9]{1,6}$'
   AND t.archived_at IS NULL
   AND (t.history IS NULL OR jsonb_typeof(t.history) = 'array')
   AND COALESCE(t.revision_count, 0) < CASE WHEN t.deliverable_rev ~ '^[0-9]{1,6}$' THEN t.deliverable_rev::int END
   AND jsonb_typeof(t.attachments) = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.attachments) AS f(e)
                WHERE f.e->>'type' = 'Final' AND jsonb_typeof(f.e->'rev') = 'null'
                  AND f.e->'revCycle' = to_jsonb(COALESCE(t.revision_count, 0)));

BEGIN;

-- ── the repair: what today's reopen_ticket does, once, for each (a) row ─────
-- (every right-hand side reads the row as it was: t.revision_count is the old count)
UPDATE tickets t
   SET revision_count  = GREATEST(COALESCE(t.revision_count, 0), t.deliverable_rev::int),
       deliverable_rev = NULL,
       draft_iteration = 0,
       last_modified   = NOW(),
       -- a Final waiting on the old cycle joins the new one with the count
       attachments     = CASE
                           WHEN jsonb_typeof(t.attachments) = 'array' AND COALESCE(t.revision_count, 0) < t.deliverable_rev::int THEN
                             (SELECT COALESCE(jsonb_agg(CASE
                                       WHEN f.e->>'type' = 'Final' AND jsonb_typeof(f.e->'rev') = 'null'
                                        AND f.e->'revCycle' = to_jsonb(COALESCE(t.revision_count, 0))
                                       THEN jsonb_set(f.e, '{revCycle}', to_jsonb(t.deliverable_rev::int))
                                       ELSE f.e
                                     END ORDER BY f.ord), '[]'::jsonb)
                                FROM jsonb_array_elements(t.attachments) WITH ORDINALITY AS f(e, ord))
                           ELSE t.attachments
                         END,
       history         = COALESCE(t.history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                           'action', 'Revision cycle restarted (data repair)',
                           'user', 'system',
                           'role', 'System',
                           'date', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                           'details', format(
                             'drafting-flow LEAK-7 / SM-5 (20261222): this request was reopened before the revision-cycle rule (DEC-15) and went back to review still labelled Rev %s. Rev %s stays the last issue on record; the label is cleared and the cycle moved on, so the next approval issues a new number, as a reopen does now.',
                             t.deliverable_rev, t.deliverable_rev)))
 WHERE t.status IN ('PENDING_REVIEW', 'PENDING_FINAL_APPROVAL')
   AND t.deliverable_rev ~ '^[0-9]{1,6}$'
   AND t.archived_at IS NULL
   AND (t.history IS NULL OR jsonb_typeof(t.history) = 'array');

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- expect ok = true on every probe; the inventory rows carry n.
SELECT 'LEAK-7 (a): no live ticket under review carries an issued label any more (other than the rows counted as left alone)' AS check,
       NOT EXISTS (SELECT 1 FROM tickets
                    WHERE status IN ('PENDING_REVIEW', 'PENDING_FINAL_APPROVAL')
                      AND deliverable_rev ~ '^[0-9]{1,6}$'
                      AND archived_at IS NULL
                      AND (history IS NULL OR jsonb_typeof(history) = 'array')) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'LEAK-7 (a): every ticket this file repaired is labelled null at a review status with a cycle at or past its issue, or has moved on since',
       NOT EXISTS (SELECT 1 FROM tickets t
                    WHERE t.status IN ('PENDING_REVIEW', 'PENDING_FINAL_APPROVAL')
                      AND t.deliverable_rev ~ '^[0-9]+$'
                      AND jsonb_typeof(t.history) = 'array'
                      AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.history) h(e)
                                   WHERE h.e->>'action' = 'Revision cycle restarted (data repair)'
                                     AND COALESCE(h.e->>'details', '') LIKE '%(20261222)%')),
       NULL
UNION ALL
SELECT inventory, NULL, n FROM (SELECT ord, inventory, n FROM df_round_g_222_before ORDER BY ord) b
UNION ALL
SELECT 'after: tickets carrying the 20261222 repair line (all pastes)', NULL,
       (SELECT COUNT(*) FROM tickets t
         WHERE jsonb_typeof(t.history) = 'array'
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.history) h(e)
                        WHERE h.e->>'action' = 'Revision cycle restarted (data repair)'
                          AND COALESCE(h.e->>'details', '') LIKE '%(20261222)%'))::text
UNION ALL
SELECT 'after: LEAK-7 / SM-5 (a) — tickets under review still carrying an issued label', NULL,
       (SELECT COUNT(*) FROM tickets
         WHERE status IN ('PENDING_REVIEW', 'PENDING_FINAL_APPROVAL')
           AND deliverable_rev ~ '^[0-9]+$'
           AND archived_at IS NULL)::text;
