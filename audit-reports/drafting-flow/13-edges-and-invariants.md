# 13 · Edges, modalities & load-bearing invariants

**14 findings** — 1 CRITICAL · 8 HIGH · 5 MEDIUM.

What the seven lenses did not look at — plus the parts of this flow that are sound and must not be broken.

> ### Verification record — this file has now been checked
>
> This report was the completeness critic's output and originally shipped with a
> banner saying its findings had **not** been through the adversarial refutation
> pass the other reports had. That pass has now been run by hand against the
> source. The banner is replaced by this record.
>
> **Method.** Every `CRITICAL` and every `HIGH` was re-read against the cited
> code, including at least one negative search per absence claim. `MEDIUM`
> findings were not individually re-verified and are marked below — treat those
> as `SUSPECTED` and reproduce first, exactly as `DEC-29` requires.
>
> | ID | Result |
> |---|---|
> | `EDGE-1` | **CONFIRMED, severity lowered to `HIGH`.** The mechanism is exact and sharper than the title suggests — see the correction on the finding. |
> | `EDGE-2` | **CONFIRMED, retitled.** The verdict computation (`verify-ticket/route.ts:72-89`) reads only `deliverable_rev`; `t.status` is returned in the payload as `ticketStatus` and never enters a branch. See the correction — the general form is stronger than the `CANCELED` instance. |
> | `EDGE-3` | **CONFIRMED, and more precise than stated.** The management/engineer/DocCtrl branch and the requester branch both apply `.neq('status', 'CLOSED')`. The drafter's `assigned` query (`:159`) is the **only one that does not**. |
> | `EDGE-4` | Not individually re-verified as a whole, but one half is **REFUTED**: `resolveRoleRecipients` does filter `.eq("status", "active")`. See `EDGE-6`. |
> | `EDGE-5` | Not individually re-verified. Treat as `SUSPECTED`. |
> | `EDGE-6` | **CORRECTED — the claim is true of the picker, not of the notifier.** `lib/notify/recipients.ts:47-62` already reads the additive array: `const held = m.roles && m.roles.length > 0 ? m.roles : m.role ? [m.role] : []`. Any restatement of this finding must not implicate `resolveRoleRecipients`. |
> | `EDGE-7` | **CONFIRMED.** `sla_breached_at` has exactly one reference in application code — a read mapping at `requests/[id]/page.tsx:896`. No writer anywhere. |
> | `EDGE-8` | **CONFIRMED verbatim.** `void (async () => { … })()` at `:338`, then `setTimeout(() => router.push('/requests'), 500)` at `:360-363`. |
> | `EDGE-9` | **CONFIRMED verbatim.** Same evidence as `NEDGE-4` in the notifications area — one defect, two areas. `lib/publicOrigin.ts` exists for exactly this problem and is not used on this path. |
> | `EDGE-10`–`EDGE-14` | `MEDIUM`, not individually re-verified — **except `EDGE-12`, which is CONFIRMED and is the sharper finding of the two.** `email_notifications` has an INSERT policy and **no SELECT policy** for `authenticated` (`20260605_rls_policies_new_tables.sql:120-124`), so the dedupe read at `lib/notifications.ts:65-74` returns zero rows on every client-side path and can never suppress anything. `EDGE-14` is also **CONFIRMED**: no reader of `inapp_enabled` / `push_enabled` outside `exportTables.ts`. |
>
> `EDGE-11` is not a defect — it is the list of load-bearing invariants a fix must
> not disturb. It was not re-verified and should be read as a starting point for
> your own diff-check, not as a guarantee.


---


<a id="edge-1"></a>

## EDGE-1 · Every per-user email opt-out is silently ignored for the new-drafting-request notification: queueEmail reads the RECIPIENT's preferences under the SENDER's JWT, and RLS returns nothing

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/notifications.ts:53`, `lib/notifications.ts:59`, `lib/notifications.ts:61`, `lib/notifications.ts:147`, `lib/notify/dispatch.ts:105`, `app/(protected)/requests/new/page.tsx:342`, `supabase/migrations/20260605_rls_policies_new_tables.sql:112`
- **Re-verified:** hardening pass — **SURVIVES**. `queueEmail` reads `notification_preferences` (`notifications.ts:53`) and tests `prefs?.email_enabled === false` (`:59`) — under the **sender's** session. Own-row RLS means the recipient's row is invisible, `prefs` is null, the `=== false` test is false, and the mail goes out regardless of the opt-out.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed. The comment at dispatch.ts:105-106 ("queueEmail already checks notification_preferences ... so per-user opt-outs are honored automatically") is false for every client-side emit(). Note the scope is broader than the title: this affects ALL emit() callers, not just the new-request notification. By contrast app/api/tickets/comment/route.ts:283-285 reads prefs with supabaseAdmin and does honor them — proving the fix pattern already exists in-repo.

> **Verified, corrected, and lowered to `HIGH`.** The mechanism is real and is
> sharper than the title states. `queueEmail` **does** check preferences —
> `lib/notifications.ts:59-61` reads `email_enabled`, `digest_frequency ===
> "never"` and `shouldSendForEvent`. The defect is *where it runs*:
> `notification_preferences` carries `notif_prefs_own`, `FOR ALL TO authenticated
> USING (user_id = auth.uid())` (`20260605_rls_policies_new_tables.sql:112-115`).
> So when `queueEmail` executes **in the requester's browser**, the lookup for
> *another* person's row returns nothing, `prefs` is `null`, and
> `shouldSendForEvent(null, …)` returns `true` (`lib/notifications.ts:147`).
>
> **Every opt-out is bypassed on every client-initiated email**, not just the
> new-request one. Same root as `DELIV-2` and `EDGE-12`: preference and dedupe
> reads that only work under the service role are being made from the client.
>
> Lowered from `CRITICAL` to `HIGH` on calibration, not on doubt: in this area
> `CRITICAL` is reserved for an unapproved package reaching the field. An ignored
> email preference drives people out of the app, which is serious — it is not
> that.

**Mechanism.** queueEmail() runs in the browser against the anon client bound to the ACTOR's session. It looks up notification_preferences for input.toUserId — another person. The only policy on that table is notif_prefs_own ... USING (user_id = auth.uid()). So for every recipient who is not the actor the SELECT returns zero rows with no error, prefs is null, prefs?.email_enabled === false is false, prefs?.digest_frequency === "never" is false, and shouldSendForEvent(null, …) short-circuits on `if (!prefs) return true`. The email is queued unconditionally. The drain never re-checks: app/api/notifications/send-queued/route.ts reads only email_notifications and posts straight to Resend, so there is no second gate. The new-drafting-request notification — the entry point of the whole flow — is emitted through exactly this path (requests/new/page.tsx:342 emit({category:'assignment', kind:'request_pending_approval'}) → dispatch.ts:116 queueEmail). The comment at dispatch.ts:105 asserts the opposite. The two server-side ticket routes prove the correct pattern exists (workflow-action/route.ts:351 and comment/route.ts:276 both read prefs with supabaseAdmin), so only the client-side emit() producers are blind.

**Failure scenario.** A DraftingSupervisor turns off 'Assignments' (or Email notifications entirely) on /settings/notifications because she works her queue through the portal. She still receives an email for every new drafting request filed by anyone in the org, forever, because the requester's browser cannot read her preference row. She filters the sender to spam — and the one email class that DOES honor her preference (a genuine engineering-review request routed server-side) now lands in the same filtered folder and is never seen. The settings page told her the switch worked; the code could never make it work.

**Evidence.**

```
lib/notifications.ts:52-61
    const { data: prefs } = await supabase
      .from("notification_preferences")
      .select("*")
      .eq("user_id", input.toUserId)
      .maybeSingle();

    if (prefs?.email_enabled === false) return;
    if (prefs?.digest_frequency === "never") return;
    if (!shouldSendForEvent(prefs, input.eventType)) return;

lib/notifications.ts:147-148
function shouldSendForEvent(prefs: Record<string, unknown> | null, eventType: string): boolean {
  if (!prefs) return true;

supabase/migrations/20260605_rls_policies_new_tables.sql:110-115
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notif_prefs_own" ON notification_preferences;
CREATE POLICY "notif_prefs_own" ON notification_preferences
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

lib/notify/dispatch.ts:105-106
  // 2) Email — queueEmail already checks notification_preferences + dedupes
  //    within a 60s window, so per-user opt-outs are honored automatically.
```

**Chain reaction.** Fixing this by adding a cross-user SELECT policy on notification_preferences would leak every member's notification settings to every other member. The correct fix is to move emit()'s email leg server-side (a route holding supabaseAdmin, as workflow-action and comment already do) — which also fixes the browser-race finding and the relative-link finding in one move. Do not widen RLS.

**Done when.**

- [ ] emit()'s email leg resolves preferences with a service-role client on the server, or the requests/new call site is replaced by a server route that does
- [ ] A test asserts a recipient with email_enabled=false or email_on_assignment=false gets NO row in email_notifications when a different user files a request
- [ ] The false comment at lib/notify/dispatch.ts:105-106 is deleted or made true

---

<a id="edge-2"></a>

## EDGE-2 · Public field QR verification computes its verdict from `deliverable_rev` alone and never reads the ticket's status, so a reopened or withdrawn deliverable still scans green as "LATEST ISSUE"

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify-ticket/route.ts:71-88`, `app/api/verify-ticket/route.ts:100`, `app/verify-ticket/[ticketId]/page.tsx:26`, `app/verify-ticket/[ticketId]/page.tsx:35-38`
- **Re-verified:** hardening pass — **SURVIVES** — and this is the eighth instance of the field-verdict cluster. The verdict chain at `verify-ticket/route.ts:72-88` is built entirely from `printedRev`, `currentRev`, `latestIssued` and `inReview`. There is **no status term anywhere in it**: nothing consults whether the ticket was cancelled or the document voided or held, so a cancelled ticket's deliverable still scans `current`.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed: the status is fetched, transmitted, and then discarded by both the API and the page. One narrative detail is wrong — no code path anywhere in the repo ever SETS status to 'CANCELED' (grep finds it only in the type union, filter predicates and UI labels), so the 'withdrawn MOC' scenario is not reachable through the app. The reopen/reject-final path produces the identical green 'LATEST ISSUE' on a deliverable that is actively being revised, so the defect and its severity stand.

> **Verified, and retitled to the general case.** The original title led with a
> `CANCELED` ticket, which is the **weakest** instance: `SM-8` establishes that
> `CANCELED` is currently unreachable by any code path, so that specific scenario
> is hypothetical today.
>
> The general form is confirmed and reachable. `app/api/verify-ticket/route.ts:72-89`
> branches only on `printedRev`, `currentRev`, `latestIssued` and `inReview`.
> `t.status` is read into the response as `ticketStatus` (`:99`) and **never
> enters the verdict**. A ticket reopened for rework whose `deliverable_rev` is
> still the issued number resolves to `verdict: "current"`, and
> `app/verify-ticket/[ticketId]/page.tsx:35-38` renders that as a green
> **"LATEST ISSUE"** with *"This copy is the latest issued revision"*.
>
> `CRITICAL` retained: a field print scanning green while its deliverable is
> under rework is precisely the failure the QR exists to prevent. Read alongside
> `SM-5` — reopen re-issues the **same** revision number — which is what makes
> this reachable rather than theoretical.

**Mechanism.** The unauthenticated verify endpoint selects status from tickets and returns it as ticketStatus (route.ts:100). The verdict ladder (route.ts:71-88) branches only on printedRev vs deliverable_rev — there is no branch on ticket status anywhere, so a CANCELED ticket whose Rev 1 was previously issued still computes verdict = "current". The public page declares ticketStatus in its result type (page.tsx:26) and never reads it: the complete set of field reads in that file is result.checkedAt, currentRev, inReview, lastActivityAt, printedRev, ticketNumber, title, unit, verdict. ticketStatus appears exactly once, in the interface. The 'current' verdict renders as a full-bleed emerald panel with a check icon and the sentence 'This copy is the latest issued revision of this deliverable.'

**Failure scenario.** A drafting request for a tie-in isometric reaches PENDING_IFC, Rev 1 is issued, and a stamped print with the QR goes to a contractor. Two weeks later the MOC is withdrawn and the request is CANCELED. The contractor's foreman, holding the print at the unit, scans the QR to do the right thing. He gets a full-screen green 'LATEST ISSUE — This copy is the latest issued revision of this deliverable.' Nothing on the screen says the request was cancelled. He builds to a withdrawn isometric. The one fact that would have stopped him was already in the JSON response, one line above the code that renders the verdict.

**Evidence.**

```
app/api/verify-ticket/route.ts:71-84 (no status branch in the entire ladder)
  if (!printedRev || !currentRev) {
    verdict = "unknown";
  } else if (!isIssued(printedRev)) {
    verdict = "draft_copy";
  } else if (latestIssued && cycleOf(printedRev) < cycleOf(latestIssued)) {
    verdict = "superseded";
  } else if (inReview && latestIssued && printedRev === latestIssued) {
    verdict = "revision_in_progress";
  } else if (latestIssued && printedRev === latestIssued) {
    verdict = "current";

app/api/verify-ticket/route.ts:100
    ticketStatus: t.status ?? null,

app/verify-ticket/[ticketId]/page.tsx:26 (the ONLY occurrence of ticketStatus in the file)
  ticketStatus: string | null;

app/verify-ticket/[ticketId]/page.tsx:35-38
  current: {
    bg: "bg-emerald-600", icon: "check", headline: "LATEST ISSUE",
    sub: () => "This copy is the latest issued revision of this deliverable.",
  },
```

**Chain reaction.** The same page is the target of the ticket-traveler sheet and package print-pack QRs (lib/physicalBridge.ts builds those with publicOrigin()). Any fix must add the status branch in the ROUTE so every consumer of the JSON sees it, and must use a distinct verdict — a cancelled request's deliverable is not 'current', 'superseded', or 'unknown'.

**Done when.**

- [ ] The route returns a distinct verdict (e.g. 'withdrawn') when the ticket status is CANCELED, regardless of rev math
- [ ] The public page renders ticketStatus on the facts card and never gives a non-live ticket the emerald 'LATEST ISSUE' treatment
- [ ] A test covers { status: 'CANCELED', deliverable_rev: '1', printedRev: '1' } and asserts the verdict is not 'current'

---

<a id="edge-3"></a>

## EDGE-3 · A drafter's attention feed pulls CLOSED tickets into a 500-row cap, so a long-tenured drafter's oldest open assignments silently fall off the badge

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:28-31`, `hooks/useTicketNotifications.ts:156`, `hooks/useTicketNotifications.ts:159-161`, `hooks/useTicketNotifications.ts:170`
- **Re-verified:** hardening pass — **SURVIVES** — and it is more precise than a spot-check suggests. Lines 156 (management) and 170 (requester) **do** carry `.neq('status','CLOSED')`; the defect is line **160**, the Drafter's assigned query, which has no status filter at all. Every ticket ever assigned to that drafter competes for the same 500 slots, ordered `last_modified` DESC, so the rows dropped are the least recently touched — the definition of a stalled assignment.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The mechanism is exactly as claimed and the asymmetry with the two sibling queries makes it plainly an oversight: closed tickets consume the 500-row window only for the drafter branch, so an old open assignment can be pushed out and never reach isActionRequired. Severity lowered because the impact is confined to the badge/bell — the portal's own drafter fetch (app/(protected)/requests/page.tsx:286) applies no `.limit()` at all, so the ticket is still visible and actionable in the queue, and the failure needs 500+ rows carrying that one uid.

**Mechanism.** The hook is documented as 'Single source of truth for what needs my attention right now' and feeds the sidebar badge, the header bell and /inbox. Its three role branches are inconsistent: the management/engineer/DocCtrl branch (line 156) and the requester branch (line 170) both apply .neq('status','CLOSED'), but the Drafter branch's assigned query (line 160) applies NO status filter — .eq('assigned_drafter_id', uid).order('last_modified',{ascending:false}).limit(OPEN_TICKET_CAP). Every ticket ever assigned to that drafter, closed or cancelled, competes for the same 500 slots. Because the order is last_modified DESC, the rows dropped when the cap binds are the LEAST recently touched — precisely the definition of a stalled open assignment. The cap comment reasons the opposite way. Downstream, isActionRequired returns false for CLOSED so the closed rows contribute nothing but cap pressure; and a CLOSED ticket still carrying the drafter in unread_by renders in the feed permanently, since the unread branch has no status guard either.

**Failure scenario.** A drafter with three years on site has 600+ tickets bearing his uid, ~580 closed. His attention feed fetches the 500 most recently modified — almost all closed — and the two oldest DRAFTING requests, one a REVISION_REQ on a P&ID untouched for four months, fall outside the window. His sidebar badge omits them. The supervisor's board (a different query) still shows them assigned to him. Each side believes the other is watching.

**Evidence.**

```
hooks/useTicketNotifications.ts:28-31
// Cap open-ticket fetches so the attention feed can't pull an unbounded set
// (and re-pull it on every realtime change). Newest-first, so the most
// recently active tickets — the ones likely to need attention — are kept.
const OPEN_TICKET_CAP = 500;

hooks/useTicketNotifications.ts:159-161 (Drafter branch — no status filter)
          const [assigned, pool] = await Promise.all([
            supabase.from('tickets').select('*').eq('org_id', activeOrgId).eq('assigned_drafter_id', uid).order('last_modified', { ascending: false }).limit(OPEN_TICKET_CAP),
            supabase.from('tickets').select('*').eq('org_id', activeOrgId).eq('status', 'PENDING_ASSIGNMENT').order('last_modified', { ascending: false }).limit(OPEN_TICKET_CAP),

hooks/useTicketNotifications.ts:156 (management branch — has the filter)
          const { data } = await supabase.from('tickets').select('*').eq('org_id', activeOrgId).neq('status', 'CLOSED').order('last_modified', { ascending: false }).limit(OPEN_TICKET_CAP);
```

**Chain reaction.** Even the branches that DO filter use .neq('status','CLOSED'), which lets CANCELED through, and still order last_modified DESC — so an org with >500 live tickets loses its stalest work from the badge across every role. A fix should both add the terminal-status filter to the Drafter branch and change the retention rule so aging action-required work is preferentially kept rather than preferentially discarded.

**Done when.**

- [ ] The Drafter assigned-query excludes terminal statuses (CLOSED and CANCELED) as the other two branches do
- [ ] When the cap binds, the retained set is chosen by action-required/aging rather than most-recent activity — or the count is fetched separately (head:true) so the badge is exact even when the list is capped
- [ ] A test with 501 assigned tickets (500 closed, 1 old DRAFTING) asserts the DRAFTING one appears in items

---

<a id="edge-4"></a>

## EDGE-4 · Removing a member hard-deletes their org_members row with no check for in-flight drafting requests, stranding tickets on a non-member that nothing escalates and nobody is notified about

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/users/page.tsx:167-186`, `app/(protected)/admin/users/page.tsx:178`, `lib/ticketRouting.ts:95-104`, `lib/notify/dispatch.ts:136-142`, `lib/notify/recipients.ts:36-42`
- **Re-verified:** hardening pass — **SURVIVES**. `.from('org_members').delete().eq('id', member.id)` (`admin/users/page.tsx:178`) with no in-flight-work check. Note the interaction with `roles-and-permissions/SURF-1`: today that delete affects zero rows, so the stranding is latent and arrives the moment a `FOR DELETE` policy is added.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed: no in-flight-work check, no reassignment, no notification. The board keeps rendering the stranded ticket under the denormalized `assigned_drafter_name` (app/(protected)/requests/page.tsx:256 maps it and groups by assignedDrafterId), and the only recovery, the Reassign button at app/(protected)/requests/[id]/page.tsx:1596, is gated on `isAdmin` and requires someone to notice first. lib/ticketRouting.ts:32-41 filters on `status = 'active'`, so the deleted row simply drops out of every recipient pool with no fallback.

**Mechanism.** handleRemoveMember performs exactly one write: supabase.from('org_members').delete().eq('id', member.id). It never queries tickets. I searched three ways for a cleanup path (callers of handleRemoveMember; triggers on org_members in supabase/migrations — only the last-admin guards exist; and 'unassign|reassign.*inactive|no longer a member' across app/components/lib) and found none. Three consequences follow mechanically. (1) tickets.assigned_drafter_id still points at the departed uid while status is PENDING_DRAFTING/DRAFTING, and resolveTicketRecipients has no case for those statuses — the switch handles only PENDING_ENG_INITIAL, PENDING_ASSIGNMENT and PENDING_IFC, everything else hits `default: pool = []` — so no supervisor is ever told the work is stranded. (2) tickets.watchers still contains the removed uid; resolveFollowers reads that array with no membership filter. (3) dispatch.ts's emailsFor selects org_members .in("uid", uids) with NO status filter and no row now exists, so the address silently resolves to nothing and the recipient is dropped without a trace. lib/impact.ts — the app's only where-used engine — is document-scoped; there is no person-scoped impact preview.

**Failure scenario.** A contract drafter is removed from the workspace on his last day. Three drafting requests sit in DRAFTING against his uid, one an as-built for a relief header. Nothing changes on the portal — his denormalized assigned_drafter_name still renders, so the board looks staffed. No supervisor alert fires because PENDING_DRAFTING routes to nobody. Every subsequent comment or status email addressed to him is dropped by emailsFor with no error. The as-built sits untouched until the next PSM audit asks why a 90-day-old request assigned to someone who left in week two never moved.

**Evidence.**

```
app/(protected)/admin/users/page.tsx:176-180
    setRemovingId(member.id);
    try {
      const { error } = await supabase.from('org_members').delete().eq('id', member.id);
      if (error) throw error;
      setMembers((prev) => prev.filter((m) => m.id !== member.id));

lib/ticketRouting.ts:95-104
  switch (status) {
    case "PENDING_ENG_INITIAL":
      pool = fallbackToAdmins(members.filter((m) => engineerRoles.includes(m.role)));
      break;
    case "PENDING_ASSIGNMENT":
    case "PENDING_IFC":
      pool = supervisorTargeted();
      break;
    default:
      pool = [];
  }

lib/notify/dispatch.ts:136-142
  const { data } = await supabase
    .from("org_members")
    .select("uid, email")
    .eq("org_id", orgId)
    .in("uid", uids);
```

**Chain reaction.** Adding a status filter to emailsFor makes the drop explicit but does not un-strand the ticket. The real fix is a pre-removal impact query (open tickets where the member is requester/drafter/engineer) surfaced in the confirm dialog, plus a routing case so a PENDING_DRAFTING ticket whose assignee is no longer active escalates to the DraftingSupervisor pool. Do NOT solve it by soft-deleting org_members without auditing every membership query — several (dispatch.ts:136-142 above) do not filter status and would start emailing ex-employees.

**Done when.**

- [ ] The remove-member confirm dialog names the open tickets the person holds (requester, drafter, engineer) before deleting
- [ ] resolveTicketRecipients escalates a DRAFTING/PENDING_DRAFTING ticket whose assigned_drafter_id is not an active member
- [ ] emailsFor filters org_members on status='active', and a departed watcher is pruned or explicitly reported rather than silently dropped

---

<a id="edge-5"></a>

## EDGE-5 · Restoring a backup into a workspace that already has tickets collides on UNIQUE(org_id, ticket_id), abandons the rest of the tickets table on the first bad chunk, and leaves the number counter pointing at numbers the restore just re-created

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/dataRestore.ts:335-341`, `app/api/admin/restore/apply-table/route.ts:75-88`, `app/(protected)/admin/restore/page.tsx:193-207`, `supabase/schema.sql:444`, `supabase/schema.sql:495`, `supabase/migrations/20260724_ticket_numbering.sql:20-25`
- **Re-verified:** hardening pass — **SURVIVES**, and the file documents the hazard it falls into. `tickets` appears in `dataRestore.ts` only in the FK-order list (`:308`) and **not** in `CONFLICT_TARGETS`, so `conflictTargetFor("tickets")` returns `"id"` (`:347`) against `UNIQUE(org_id, ticket_id)` (`schema.sql:444`). The upsert errors, the fallback plain `insert` violates the same constraint, and `apply-table:81` returns 500 — abandoning every remaining chunk. The comment at `:335` describes exactly this class: *"upserting them on 'id' errors and breaks re-runnability."*
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. All three clauses hold. The dialog text at page.tsx:162 does promise 'Existing data is kept — this is additive'. remapRow (lib/dataRestore.ts:200-218) rewrites org_id and uids but never touches the human `ticket_id` string, and tickets is not in SKIP_TABLES (:86-93), so a same-record-code merge collides. ticket_number_counters restores with conflict target `org_id,year` + ignoreDuplicates, so the target org's existing next_seq survives untouched while the restore re-creates numbers below it — and lib/ticketNumber.ts:50-64 has no collision retry, so the next new request just fails.

**Mechanism.** Three interlocking facts. (1) tickets has both a uuid PK and UNIQUE(org_id, ticket_id) (schema.sql:444). conflictTargetFor('tickets') returns the default 'id' because CONFLICT_TARGETS lists no entry for tickets, so the upsert's ON CONFLICT clause cannot see a human-number collision; PostgREST attempts the insert and Postgres raises on the unique index. (2) apply-table's error path retries the identical chunk with a plain .insert() — the same violation — and returns 500. The client at restore/page.tsx:202 does `if (!res.ok) { tableFailed = true; break; }`, abandoning EVERY REMAINING CHUNK of that table while continuing to later tables; ticket_comments is ordered after tickets in RESTORE_TABLE_ORDER and has ticket_id UUID NOT NULL REFERENCES tickets(id), so its rows for the abandoned tickets then fail their FK too. (3) ticket_number_counters uses conflict target 'org_id,year' with ignoreDuplicates: true, so the target workspace's live counter is deliberately preserved — correct for a merge, fatal in combination: the restored tickets occupy human numbers the counter will hand out again.

**Failure scenario.** Two plants merge and an admin restores Plant B's backup into Plant A's workspace — the flow the confirm dialog explicitly supports ('Existing data is kept — this is additive'). Both used the default record code, so both have KE-DDRT-26-0001..0400. Chunk 1 of tickets violates the unique index, the client breaks, and roughly 400 drafting requests plus their comment threads are absent from the restore; the only signal is the table name in a failedTables list with no per-row detail. In the near-miss case where numbers do not yet overlap, the restore succeeds and Plant A's counter still reads 12 — so the next four hundred requests filed re-issue numbers that already identify Plant B's restored records. In a PSM register, two drafting requests answering to one number is an audit finding on its own.

**Evidence.**

```
supabase/schema.sql:444
  UNIQUE(org_id, ticket_id)

lib/dataRestore.ts:335-341 (no 'tickets' entry — falls through to 'id')
export const CONFLICT_TARGETS: Record<string, string> = {
  document_favorites: "user_id,document_id",
  curated_collection_items: "collection_id,document_id",
  team_members: "team_id,uid",
  ticket_number_counters: "org_id,year",
  archive_settings: "org_id",
  org_configurations: "org_id,key",
};

app/api/admin/restore/apply-table/route.ts:75-84
    const up = await sb.from(table).upsert(chunk, { onConflict: conflictTargetFor(table), ignoreDuplicates: true, count: "exact" });
    if (up.error) {
      const ins = await sb.from(table).insert(chunk, { count: "exact" });
      if (ins.error) {
        return NextResponse.json({ error: ins.error.message, inserted }, { status: 500 });
      }

app/(protected)/admin/restore/page.tsx:202
          if (!res.ok) { tableFailed = true; break; }
```

**Chain reaction.** Do NOT fix this by setting conflictTargetFor('tickets') to 'org_id,ticket_id' with ignoreDuplicates — that would silently DROP the restored ticket in favour of an unrelated live one bearing the same number, which is worse than failing. The number must be re-minted or namespaced on restore, and ticket_number_counters must be advanced to max(restored seq, live seq) per (org, year).

**Done when.**

- [ ] Restoring tickets into an org holding the same ticket_id either re-mints the number or fails loudly per-row rather than abandoning the rest of the chunked table
- [ ] The chunk loop reports which rows failed instead of breaking on the first bad chunk
- [ ] ticket_number_counters is advanced to the maximum of the live and restored sequence for every (org_id, year) touched by a restore
- [ ] A test restores a fixture whose ticket_id already exists in the target org and asserts no number is ever issued twice

---

<a id="edge-6"></a>

## EDGE-6 · The drafter assignment picker filters on the headline `role` column only, ignoring the additive roles[] model the rest of the system enforces — an org can reach a request nobody can be assigned to

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/[id]/page.tsx:241-247`, `components/requests/EngineerPickerModal.tsx:77-92`, `lib/notify/recipients.ts:52-62`, `app/api/tickets/workflow-action/route.ts:111-131`, `lib/roleCapabilities.ts:120-123`, `supabase/migrations/20260722_member_roles_collection.sql:13`
- **Also surfaced independently as** [`ROUTE-8`](./08-routing-and-attention.md#route-8) — two lenses found this separately, which raises confidence. Fix once.
- **Same root cause as** `ROUTE-8`, `ROUTE-10` — Also owned as `LEAK-2` in [`04-flow-leaks.md`](./04-flow-leaks.md). Settled by `DEC-1` — do that first and these collapse. Fix once; close the rest citing this one.
- **Re-verified:** hardening pass — **SURVIVES**, and the correct implementation sits beside it. `requests/[id]/page.tsx:246` filters `.eq('role','Drafter')` — headline only — while `EngineerPickerModal.tsx:80-88` reads the `roles` array with a comment explaining why (*"an Admin who also holds Engineer-2 must appear here too"*). Two pickers, one rule, one of them following it.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Claim holds, and it is worse than stated: WorkflowEngine.getActions is called with the headline role only (app/(protected)/requests/[id]/page.tsx:1350 `getActions(ticket, activeRole, ...)`, and lib/workflow.ts:65 passes `null` for extraRoles into policyAllows), so the same member also loses `ticket.self_assign` and cannot claim from the pool either. One cited location is wrong, though: components/requests/EngineerPickerModal.tsx:85-90 DOES read the additive array (`Array.isArray(m.roles) && ... : [String(m.role ?? "")]` then `held.some(r => r.includes("Engineer"))`), matching the server check at workflow-action/route.ts:124-130 — the engineer picker is not affected, only the drafter AssignmentModal.

**Mechanism.** Migration 20260722 introduced an additive role collection: org_members.roles TEXT[], with `role` demoted to a denormalized 'headline' = the highest-RANKED member of the collection (persistRoles at admin/users/page.tsx:132-137 writes both; primaryRole at roleCapabilities.ts:120-123 sorts by ROLE_RANK descending). Every other consumer reads the array first: resolveRoleRecipients does `const held = m.roles && m.roles.length > 0 ? m.roles : m.role ? [m.role] : []`; EngineerPickerModal selects uid,email,role,roles with the comment 'headline role OR the additive roles array (the server validates against both)'; the workflow-action route validates a picked engineer against refMember.roles first. The drafter picker does not — it is the single .eq('role', ...) member filter in the whole application (I grepped both quote styles across app, components and lib; the only other hit is project_members' unrelated 'owner' role). So any member whose collection contains 'Drafter' but whose headline resolves to a higher-ranked role is invisible in the assignment modal, even though the server would accept them: the route only requires active membership for body.assignment.id, with no role check.

**Failure scenario.** A small refinery has four people, each holding two hats: the two drafters are also Engineer-2, and the supervisor drafts as well. persistRoles sets every headline to the higher-ranked role. A new drafting request lands in PENDING_ASSIGNMENT. The supervisor opens the assign modal and it is empty — the org has three qualified drafters and the picker can see none of them. The request cannot be advanced through the UI, and the empty state says nothing about headline roles.

**Evidence.**

```
app/(protected)/requests/[id]/page.tsx:241-247
            const { data } = await supabase
              .from('org_members')
              .select('uid, email, role')
              .eq('org_id', activeOrgId)
              .eq('role', 'Drafter')
              .eq('status', 'active');
            setDrafters((data || []).map(r => ({ uid: r.uid, email: r.email, role: r.role })));

components/requests/EngineerPickerModal.tsx:77-88 (the correct pattern, right next door)
        // Pull every active engineer in the org — headline role OR the
        // additive roles array (the server validates against both, so an
        ...
          .select("uid, email, role, roles")
        ...
          const held: string[] = Array.isArray(m.roles) && (m.roles as string[]).length > 0
            ? (m.roles as string[])
            : [String(m.role ?? "")];

lib/notify/recipients.ts:59-61
    const held = m.roles && m.roles.length > 0 ? m.roles : m.role ? [m.role] : [];
    if (held.some((r) => want.has(r))) out.add(m.uid);
```

**Chain reaction.** lib/ticketRouting.ts:33-40 has the same shape one level down: listActiveMembers selects only uid, role, display_name, email and resolveTicketRecipients filters m.role === r — so the PENDING_ASSIGNMENT notification also misses additive-only DraftingSupervisors and silently falls back to Admins. Fix both, or the picker starts working while the alert telling someone to use it still goes to the wrong pool.

**Done when.**

- [ ] The drafter picker selects roles and matches against the collection with the headline as fallback, exactly as EngineerPickerModal does
- [ ] lib/ticketRouting.ts listActiveMembers/resolveTicketRecipients read the additive collection too
- [ ] The picker's empty state names the real reason ('no active member holds the Drafter role') rather than rendering blank

---

<a id="edge-7"></a>

## EDGE-7 · The entire SLA layer on drafting requests is inert: sla_breached_at is never written, no sla_warning is ever emitted, sla_defaults is never read — and the settings page promises the notification

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:433-434`, `app/(protected)/settings/notifications/page.tsx:143`, `lib/notifications.ts:122`, `lib/notify/dispatch.ts:56`, `lib/notifications.ts:237-243`, `app/(protected)/requests/page.tsx:508`, `vercel.json:3-12`
- **Same root cause as** `ROUTE-9` — `GAP-106` is the build. Depends on `LEAK-1` landing first so escalations reach someone who does not already know. Fix once; close the rest citing this one.
- **Re-verified:** hardening pass — **SURVIVES**, by census. `sla_breached_at`, `sla_breach_warned_at`, `sla_defaults` and `sla_warning` have **zero writes** across `app/` and `lib/`; the columns exist (`schema.sql:433-434`) and the preferences page advertises the feature (`settings/notifications/page.tsx:143`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed inert end to end. isPastDue/isNearingDue (lib/notifications.ts:216-232) are used only for two coloured badges at requests/[id]/page.tsx:1758-1761 and an inline overdue count at requests/page.tsx:508 — no notification path. app/api/cron/maintenance/route.ts contains zero occurrences of 'ticket' while it does run comparable time-based sweeps for checkouts, reviews, acks and retention, so the omission is specific to the drafting flow.

**Mechanism.** tickets.sla_breach_warned_at and tickets.sla_breached_at exist in the schema. I grepped sla_breach repo-wide and case-insensitive slabreach: the only hits are two read-mappings at app/(protected)/requests/[id]/page.tsx:895-896 and the type declarations at types/schema.ts:1136-1137. Nothing writes either column. I grepped sla_warning and `category: "sla"` in both quote styles: the eventType appears only in the preference switch, the category mapper and the settings UI — there is no emit() with category 'sla' anywhere. vercel.json schedules exactly two crons; the maintenance route contains zero occurrences of 'ticket' or 'sla' across its 443 lines. sla_defaults is likewise never read — the only hits are the schema tripwire, the export table list and the restore order — while lib/notifications.ts:235 calls the hardcoded DEFAULT_SLA_DAYS 'First fallback when an org hasn't configured sla_defaults rows' and Admin → Settings has no SLA UI. The only surviving SLA signal is client-side colouring at requests/[id]/page.tsx:1758-1761, visible only after you have already opened the ticket.

**Failure scenario.** An org configures request types with SLA-shaped labels ('1 - Urgent (1-2 Days)') and enables 'SLA warnings', which reads 'A ticket you're responsible for is at risk of breaching its target completion date.' An urgent inspection isometric is filed with a 1-day target on a Friday. Nobody opens the ticket. No warning email, no bell row, no cron scan, no sla_breached_at stamp is ever produced. On Monday the target has passed silently; the only trace is a red pill that renders if and when a human happens to open that one ticket detail page. The org believes it has an SLA clock. It has a colour.

**Evidence.**

```
app/(protected)/settings/notifications/page.tsx:143 (the promise)
          <PrefRow icon={AlertOctagon} title="SLA warnings" hint="A ticket you're responsible for is at risk of breaching its target completion date." on={prefs.email_on_sla_warning} onChange={(v) => setPrefs({ ...prefs, email_on_sla_warning: v })} />

supabase/schema.sql:433-434 (the columns nothing writes)
  sla_breach_warned_at TIMESTAMPTZ,
  sla_breached_at TIMESTAMPTZ,

lib/notifications.ts:275-282 (the fallback whose primary source is unreadable)
// First fallback when an org hasn't configured sla_defaults rows.
export const DEFAULT_SLA_DAYS: Record<string, number> = {
  INSPECTION: 1, RFI: 3, MOC: 7, ISO: 14, ASBUILT: 21,
};

vercel.json (only two crons; neither scans tickets)
  "crons": [ { "path": "/api/data-export/run-scheduled", ... }, { "path": "/api/cron/maintenance", ... } ]
```

**Chain reaction.** Related and smaller: the supervisor workload board at app/(protected)/requests/page.tsx:508 computes `overdue: count(g.tickets, (t) => !!t.targetCompletionAt && new Date(t.targetCompletionAt) < new Date())` with no status guard, unlike lib/notifications.ts:258-259 which excludes CLOSED and CANCELED. A CANCELED past-target ticket therefore counts as permanently overdue on a drafter's card. Fix the scan and this metric together, using isPastDue as the single rule.

**Done when.**

- [ ] The maintenance cron scans open tickets past (or nearing) target_completion_at, stamps sla_breach_warned_at/sla_breached_at once, and emits category 'sla' server-side
- [ ] Either sla_defaults gains a read path and an admin UI, or the table and its 'first fallback' comment are removed and DEFAULT_SLA_DAYS is documented as the only source
- [ ] requests/page.tsx:508 uses isPastDue so CANCELED/CLOSED tickets stop counting as overdue

---

<a id="edge-8"></a>

## EDGE-8 · The new-drafting-request fan-out runs in the requester's browser and races a 500 ms redirect — the one ticket transition whose notification is not server-guaranteed

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/new/page.tsx:338-358`, `app/(protected)/requests/new/page.tsx:360-363`, `app/(protected)/requests/new/page.tsx:10`, `app/api/tickets/workflow-action/route.ts:20-25`, `lib/notify/dispatch.ts:78-131`
- **Re-verified:** hardening pass — **SURVIVES**. `void (async () => { … await emit(…) })()` (`requests/new/page.tsx:338-349`) is fire-and-forget in the browser, racing `setTimeout(() => router.push('/requests'), 500)` (`:361-363`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Creation is genuinely the one transition whose fan-out is client-side; every other transition goes through the server route. lib/notify/dispatch.ts:80-131 does bell rows first (`await notifyMany`) and only then queues email, so a tab closed mid-flight leaves exactly the partial state described. Mild mitigation worth noting: `router.push` is a client-side App Router navigation, not a document unload, so the promise usually survives the redirect itself — the loss requires the user to actually close/kill the tab, which the 'lock the tablet' scenario covers.

**Mechanism.** Ticket creation writes the row with the client's supabase client, then fires an un-awaited async IIFE calling resolveTicketRecipients (2 queries) and emit() (followers query + role query + N notification inserts + an org_members email lookup + N x queueEmail, each doing a prefs SELECT, a dedupe SELECT, an insert and a fetch kick). Immediately after, a 500 ms setTimeout pushes the router to /requests. Every other ticket transition was deliberately moved server-side for exactly this reason — the workflow-action route's header says it 'fans out notifications + emails server-side, so neither can be skipped by a closed tab or a tampered client', and the comment route repeats it. Ticket CREATION is the one that stayed in the browser. A soft navigation keeps the promises alive in the same JS context, but a tab close, a hard reload, a phone locking or a lost network mid-chain aborts the sequence partway, leaving a committed ticket with some or none of its recipients notified and no server-side record that a fan-out was owed.

**Failure scenario.** An operator files an urgent MOC drafting request from a tablet in the field, sees 'Done!', and locks the tablet. The tickets row committed. The fan-out died after two of four bell rows and before any email was queued. The DraftingSupervisor never learns the request exists. It sits in PENDING_ASSIGNMENT — a status only surfaced to people who happen to load the app — with a target completion date nothing scans. The request the operator believes is 'in the system' is invisible until someone browses the portal.

**Evidence.**

```
app/(protected)/requests/new/page.tsx:338-345
      void (async () => {
        try {
          const recipients = await resolveTicketRecipients(activeOrgId, initialStatus, uid ?? undefined);
          if (recipients.length === 0) return;
          await emit({
            orgId: activeOrgId,
            category: 'assignment',
            kind: 'request_pending_approval',

app/(protected)/requests/new/page.tsx:360-363
      setUploadStatus('Done!');
      setTimeout(() => {
        router.push('/requests'); // Redirect to new route
      }, 500);

app/api/tickets/workflow-action/route.ts:24-25 (the standard this violates)
//   6. writes the audit row and fans out notifications + emails server-side,
//      so neither can be skipped by a closed tab or a tampered client.
```

**Chain reaction.** Moving creation into a server route fixes three findings at once: the fan-out becomes durable, the preference lookup gains the service-role client (fixing the RLS-blind opt-out), and the email link can be absolutized with publicOrigin(). It also lets the request number be allocated inside the same server step as the insert, addressing the sequence-gap finding.

**Done when.**

- [ ] Ticket creation posts to a server route that inserts the row AND fans out, in that order, before responding
- [ ] The client no longer imports emit from lib/notify/dispatch at app/(protected)/requests/new/page.tsx:10
- [ ] A recipient still receives the request_pending_approval bell row and email when the submitting tab is closed immediately after the response

---

<a id="edge-9"></a>

## EDGE-9 · Ticket notification emails carry root-relative links — every 'you were mentioned' and status email in the drafting flow has a dead button

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/tickets/comment/route.ts:255`, `app/api/tickets/comment/route.ts:296-300`, `app/api/tickets/workflow-action/route.ts:313`, `app/api/tickets/workflow-action/route.ts:389-394`, `lib/publicOrigin.ts:17-22`, `lib/transmittals.ts:389-392`
- **Re-verified:** hardening pass — **SURVIVES**. Same root as `notifications/NEDGE-4` — `const link = `/requests/${ticketId}?c=…`` at `comment/route.ts:263`, embedded as an `href` in mail. Fix once.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, including the claim of absence: app/api/notifications/send-queued/route.ts passes `html: row.body_html` straight through (:151) with no origin rewriting, so nothing absolutises the href downstream. lib/transmittals.ts:389-392 shows the same class of bug from the other side (`typeof window !== "undefined" ? window.location.origin : ""` — empty string on the server), while publicOrigin() is the correct helper that these paths simply do not call.

**Mechanism.** Both server-side ticket email producers build `const link = "/requests/" + ticketId` (workflow-action:313) or `"/requests/" + ticketId + "?c=" + comment.id` (comment:255) and drop that string straight into the outgoing HTML as <a href="${link}"> and into body_text. Those rows are queued into email_notifications and shipped to Resend verbatim by app/api/notifications/send-queued/route.ts, which passes html: row.body_html untouched. A root-relative href in an email resolves against the mail client's own origin, not the app. The codebase already knows this: lib/publicOrigin.ts exists specifically for links that 'leave the app', and lib/transmittals.ts:389-392 builds an absolute portalUrl for the transmittal email. I grepped publicOrigin / NEXT_PUBLIC_SITE_URL / absoluteUrl across app, components and lib — 21 call sites, all QR codes, print packs, share links and doc packs. Not one is an email body.

**Failure scenario.** An engineer @-mentions the process safety lead on a MOC drafting request: 'confirm the relief valve set point before we issue this.' She gets the email on her phone, taps 'Open ticket', and Gmail navigates to mail.google.com/requests/<uuid> — a 404 inside her mail client. The confirmation never happens and the package advances.

**Evidence.**

```
app/api/tickets/workflow-action/route.ts:313
  const link = `/requests/${ticketId}`;

app/api/tickets/workflow-action/route.ts:390-394
      body_html: `
        <p><b>${escapeHtml(actorEmail)}</b> performed <b>${escapeHtml(action.label)}</b> on <a href="${link}">${escapeHtml(ticketLabel)}</a>.</p>
        <p>Status: <b>${escapeHtml(newStatus)}</b></p>
        ${comment ? `<blockquote ...>${escapeHtml(comment)}</blockquote>` : ""}
        <p><a href="${link}">Open ticket</a></p>`,

app/api/tickets/comment/route.ts:255
  const link = `/requests/${ticketId}?c=${comment.id}`;

lib/publicOrigin.ts:17-22 (the helper that exists and is not used here)
export function publicOrigin(): string {
  const configured = (process.env.NEXT_PUBLIC_SITE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}
```

**Chain reaction.** lib/notifications.ts:248-253 ticketUrl() already returns an absolute URL when a window exists and a relative one on the server, so any server-side caller inherits the same bug. Fix both route call sites AND make ticketUrl server-safe, or the next server-side producer repeats it. Note publicOrigin() returns "" on the server when NEXT_PUBLIC_SITE_URL is unset, so the fix must fail loudly (or fall back to the request origin) rather than silently re-emitting a relative link.

**Done when.**

- [ ] Both ticket routes build their email link from publicOrigin() (or the request origin) and the resulting href starts with https://
- [ ] A test asserts no queued email_notifications row has a body_html href starting with '/'
- [ ] NEXT_PUBLIC_SITE_URL is documented as required for email delivery in .env.example, not only for QR printing

---

<a id="edge-10"></a>

## EDGE-10 · A cancelled backup still writes 'Every file verified by SHA-256' into backup-report.json, producing a partial archive that describes itself as complete

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/clientBackup.ts:128-142`, `lib/clientBackup.ts:150`, `lib/clientBackup.ts:184-188`, `lib/clientBackup.ts:200-205`
- **Re-verified:** hardening pass — **SURVIVES**. The report's note is chosen on `progress.errors.length > 0` alone (`clientBackup.ts:135-137`); a **cancellation** exits via `if (opts.isCancelled?.()) break;` (`:150`) without adding an error, so a partial archive still declares *"Every file verified by SHA-256."*
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed: cancellation is not an error, so the report takes the clean-run branch. The only in-archive hints of incompleteness are the `filesPacked` count and the short files-manifest.json versus the full file list in data.json — nothing states the run was aborted, and the note affirmatively claims completeness.

**Mechanism.** The binary loop begins `if (opts.isCancelled?.()) break;`. A cancel breaks out with the remaining files never attempted and, critically, never recorded — progress.errors only accumulates from fetch failures inside the loop body and from the missing-presigned-URL branch. Execution then falls through to the unconditional `await finalizePart(true)`, which writes files-manifest.json and backup-report.json. The report's note is chosen solely by `progress.errors.length > 0`; with an empty errors array a run cancelled after three of five hundred files writes 'Every file verified by SHA-256 in files-manifest.json.' Part 1 already contains the complete data.json envelope (every table), so the archive looks authoritative. progress.phase is set to 'cancelled' AFTER finalization and lives only in the in-memory indicator state — nothing about the cancellation is written into the zip.

**Failure scenario.** A records custodian starts the full backup before a migration window, realises it will run past the maintenance start, and cancels. The parts already downloaded sit in her Downloads folder. Eighteen months later, answering an auditor, someone opens backup-report.json, reads 'Every file verified by SHA-256', and treats the archive as the complete binary set for that date. It holds three drawings out of five hundred, and files-manifest.json agrees with itself because it only lists what was actually packed.

**Evidence.**

```
lib/clientBackup.ts:128-138 (the note, chosen only by errors.length)
      zip.file("backup-report.json", JSON.stringify({
        exportedAt: envelope.manifest.exportedAt,
        parts: [...partsList, partName(progress.part)],
        filesPacked,
        bytesPacked,
        errors: progress.errors,
        note: progress.errors.length > 0
          ? "Files listed under errors are NOT in this backup — re-run, or fetch them via data.json's presigned URLs (valid 24h)."
          : "Every file verified by SHA-256 in files-manifest.json.",
      }, null, 2));

lib/clientBackup.ts:150 (cancel leaves no trace in errors)
    if (opts.isCancelled?.()) break;

lib/clientBackup.ts:184-187 (finalize runs regardless; phase is set after)
  progress.phase = "finalizing";
  emit();
  await finalizePart(true);
  progress.phase = opts.isCancelled?.() ? "cancelled" : "done";
```

**Chain reaction.** The same asymmetry exists for the fatal path: startGlobalBackup's catch publishes phase 'failed' but parts already saved to disk carry no failure marker. Whatever marker is added for cancellation should cover both, and must live inside the zip (report and part filename), not only in the transient indicator.

**Done when.**

- [ ] A cancelled or failed run writes an explicit incomplete marker into backup-report.json (filesTotal vs filesPacked, plus a status) and never emits the 'Every file verified' note
- [ ] Files not attempted because of a cancel are enumerated or counted in the report, distinct from fetch errors
- [ ] The part filename or manifest makes an incomplete archive identifiable without opening the report

---

<a id="edge-11"></a>

## EDGE-11 · SOUND — the load-bearing invariants of this flow that a fix must not disturb

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/tickets/workflow-action/route.ts:66-131`, `app/api/tickets/workflow-action/route.ts:155-166`, `lib/ticketTransitions.ts:145`, `app/api/tickets/comment/route.ts:103-121`, `app/api/tickets/comment/route.ts:275-292`, `lib/ticketAttention.ts:66-110`, `supabase/migrations/20260724_ticket_numbering.sql:33-56`, `app/api/admin/ticket-shed/route.ts:180-200`, `app/api/admin/ticket-shed/commit/route.ts:145-190`, `supabase/schema.sql:408`, `supabase/schema.sql:776`
- **Re-verified:** Re-read in the hardening pass. **This entry documents what is SOUND rather than a defect**, so there is nothing to refute — its value is as a do-not-break list. The invariant it names is real: `workflow-action/route.ts:66-77` loads the ticket server-side and refuses an archived one before any transition.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. All six cited invariants verified as described; this is an accurate SOUND note rather than a defect claim. Worth flagging that the comment route's server-side, service-role preference read (:283-292) is the exact pattern EDGE-1/EDGE-12 show missing from the client-side queueEmail path — any fix there should copy it, not the reverse.

**Mechanism.** Seven things in this flow are genuinely right and are why the defects above are survivable. (1) SERVER-ENFORCED TRANSITIONS: workflow-action loads the ticket with the service role and re-derives authority explicitly — archived-stub gate, active-membership lookup, WorkflowEngine.getActions(ticket, callerRole, caller.id, capPolicy) against the org's own capability policy, and a check that any referenced assignee/engineer is an active member holding the right role. The client sends inputs, never a computed update. (2) COMPARE-AND-SET: the update is guarded .eq("status", ticket.status).eq("last_modified", ticket.lastModified) and computeTransition unconditionally stamps last_modified: now (ticketTransitions.ts:145), so the CAS token actually advances and two interleaved no-status-change actions cannot clobber each other's whole-array JSONB writes. (3) ATOMIC COMMENTS: the post_ticket_comment RPC appends with || in one transaction, and the legacy fallback fires ONLY on PGRST202 / 'could not find the function' — a real exception inside the function surfaces instead of being swallowed. (4) CORRECT SERVER-SIDE PREFERENCE HANDLING: both ticket routes read notification_preferences with supabaseAdmin and default to all-on when no row exists — the pattern the broken client path should migrate toward. (5) ONE ATTENTION RULE: lib/ticketAttention.isActionRequired is the single source consumed by badge, bell, /inbox and the portal's row badges; its header documents the exact drift (PENDING_IFC for supervisors) that centralising it fixed. (6) ATOMIC NUMBERING: next_ticket_number is SECURITY DEFINER with an active-member guard and ON CONFLICT (org_id, year) DO UPDATE SET next_seq = next_seq + 1 RETURNING — a row lock, so concurrent submissions cannot collide. (7) ALL-OR-NOTHING ARCHIVE CAPTURE: ticket-shed produce refuses to bundle a ticket unless every one of its binaries was read, claims rows with a conditional update before bundling, and commit stamps with .is("archived_at", null) then re-verifies which ids are still archived before deleting anything. Supporting these: requester_name/assigned_drafter_name are denormalized onto the ticket row (schema.sql:408) so a ticket stays readable after the person leaves, and audit_logs.org_id carries NO foreign key (schema.sql:776) so the audit trail is not cascade-deleted with an org.

**Failure scenario.** The risk is a well-intentioned fix undoing one of these. Concretely: 'simplifying' the comment route's fallback test to any RPC error would silently reroute genuine in-function failures back to the lossy client-shaped write that post_ticket_comment exists to replace. Moving number allocation client-side to close the sequence-gap finding would reintroduce collisions the row lock prevents. Loosening ticket-shed's all-or-nothing capture to 'archive what we could read' would let commit delete an attachment that is in no saved zip. Dropping the CAS on last_modified while editing computeTransition would let two reviewers' actions overwrite each other's history array.

**Evidence.**

```
app/api/tickets/workflow-action/route.ts:155-166
  // CAS on status AND last-modified: status alone let two no-status-change
  // actions (save_progress, comments) interleave and clobber each other's
  // whole-array attachments/comments/history writes.
  let baseQuery = supabaseAdmin
    .from("tickets")
    .update(updates)
    .eq("id", body.ticketId)
    .eq("status", ticket.status);
  baseQuery = ticket.lastModified
    ? baseQuery.eq("last_modified", String(ticket.lastModified))
    : baseQuery;

app/api/tickets/comment/route.ts:111-115
    const missing =
      (rpcErr as { code?: string }).code === "PGRST202" ||
      /could not find the function|does not exist in the schema cache/i.test(rpcErr.message ?? "");
    if (!missing) return NextResponse.json({ error: rpcErr.message }, { status: 500 });

app/api/tickets/comment/route.ts:276
    supabaseAdmin.from("notification_preferences").select("*").in("user_id", recipients),

supabase/migrations/20260724_ticket_numbering.sql:50-55
  INSERT INTO ticket_number_counters (org_id, year, next_seq)
  VALUES (p_org, p_year, 1)
  ON CONFLICT (org_id, year)
  DO UPDATE SET next_seq = ticket_number_counters.next_seq + 1
  RETURNING next_seq INTO v_seq;

app/api/admin/ticket-shed/route.ts:186-189
    // Read ALL of this ticket's binaries first. Only commit the ticket to the
    // archive if every one is captured — otherwise commit would later delete an
    // attachment that isn't in this ZIP (data loss). Any unreadable → skip ticket.
```

**Chain reaction.** Several defects above are best fixed BY extending these invariants rather than around them: move ticket creation into a server route modelled on workflow-action (fixes the browser race, the RLS-blind preferences, and the relative email link at once), and route SLA scanning through the maintenance cron with the same server-side preference read the two ticket routes already use.

**Done when.**

- [ ] Any change to the ticket flow preserves: server-side action validation against WorkflowEngine + capability policy, the (status, last_modified) CAS with last_modified always stamped, the narrow PGRST202-only RPC fallback, service-role preference reads, isActionRequired as the sole attention rule, RPC-based number allocation, and all-or-nothing archive capture
- [ ] Regression tests exist for the CAS (two concurrent save_progress actions → one 409) and for the RPC fallback narrowness (a non-PGRST202 error must not fall back)

---

<a id="edge-12"></a>

## EDGE-12 · The 60-second email burst-dedupe in queueEmail can never fire: email_notifications grants INSERT only, so the duplicate-detecting SELECT always returns empty

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/notifications.ts:63-75`, `supabase/migrations/20260605_rls_policies_new_tables.sql:117-124`, `supabase/migrations/20260529_phase_b_notifications.sql:63-64`
- **Re-verified:** hardening pass — **SURVIVES**, and the migration states the cause in its own comment. The dedupe issues a **SELECT** on `email_notifications` from the client (`notifications.ts:67-72`), while the only policy on that table is `FOR INSERT TO authenticated` (`20260605_rls_policies_new_tables.sql:121-124`) — the comment above it reads *"Client needs INSERT only; reads happen via service role which bypasses RLS."* With no SELECT policy the query returns zero rows every time, so `dupes` is always empty and the 60-second burst guard can never fire.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed. With RLS enabled and no SELECT policy, the dedupe query returns an empty set for every authenticated caller, so the 60-second burst guard is unreachable and its supporting index is dead weight. Same root cause as EDGE-1 (client-side queueEmail under the sender's JWT).

**Mechanism.** queueEmail's dedupe reads email_notifications filtered on to_user_id/event_type/resource_id within the last 60 s. The table's only policy is email_notif_insert ... FOR INSERT, and the migration's own comment states the intent: 'email_notifications is written by client (queueEmail) and read by service-role (the cron). Client needs INSERT only; reads happen via service role which bypasses RLS.' With RLS enabled and no SELECT policy, the browser's SELECT returns zero rows with no error every time, so `dupes.length > 0` is never true. I searched three ways for a later SELECT policy (grep 'email_notif', case-insensitive 'on email_notifications', and supabase/REMEDIATION_APPLY_ALL.sql) — none exists. The dedupe index built for this at 20260529_phase_b_notifications.sql:63-64 is therefore unused by this path.

**Failure scenario.** A supervisor is both an Admin and a watcher on a request, with adminsAlsoReceiveWhenSupervisorSet on. A burst of client-side emits about one ticket in the same minute each queue their own row for her. The guard written to collapse them — 'prevents burst-spam when a workflow action triggers multiple watchers + assignments simultaneously' — is inert, so she gets one email per emit. Combined with the opt-out being unenforceable on this path, she has no way to reduce the noise, and the emails that matter get buried.

**Evidence.**

```
lib/notifications.ts:63-75
    // Dedupe: if the same recipient got the same event for the same resource
    // within the last 60 seconds, suppress this one (prevents burst-spam when
    // a workflow action triggers multiple watchers + assignments simultaneously).
    const sixtySecAgo = new Date(Date.now() - 60_000).toISOString();
    const { data: dupes } = await supabase
      .from("email_notifications")
      .select("id")
      ...
    if (dupes && dupes.length > 0) return;

supabase/migrations/20260605_rls_policies_new_tables.sql:117-124
-- email_notifications is written by client (queueEmail) and read by
-- service-role (the cron). Client needs INSERT only; reads happen
-- via service role which bypasses RLS.
ALTER TABLE email_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "email_notif_insert" ON email_notifications;
CREATE POLICY "email_notif_insert" ON email_notifications
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = email_notifications.org_id AND uid = auth.uid() AND status = 'active'));
```

**Chain reaction.** This shares a root cause with the preference-blindness finding: both are client-side reads of another user's rows under RLS. Moving emit()'s email leg server-side fixes both together. Adding a self-scoped SELECT policy would NOT fix it — the dedupe reads the recipient's rows, not the actor's.

**Done when.**

- [ ] The dedupe runs where it can actually read (server-side with the service role), or is removed along with its comment and the dedupe index is documented as serving the drain only
- [ ] A test queues the same (recipient, event, resource) twice within 60 s and asserts exactly one email_notifications row

---

<a id="edge-13"></a>

## EDGE-13 · Ticket attachments upload to R2 before required fields are validated and before the row is inserted — a rejected submit strands binaries and burns a request number the register calls 'gap-free'

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/new/page.tsx:215`, `app/(protected)/requests/new/page.tsx:234-249`, `app/(protected)/requests/new/page.tsx:271-286`, `app/(protected)/requests/new/page.tsx:327-332`, `supabase/migrations/20260724_ticket_numbering.sql:4-6`, `lib/storageOrphans.ts:52`
- **Re-verified:** hardening pass — **SURVIVES**. `generateTicketNumber` is called at `:215` and the R2 uploads run at `:234-243`, both **before** the row insert. A submit rejected after that point strands the binaries and burns the ticket number.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed on every point: the counter is bumped before validation and never returned, so an aborted submit permanently gaps the 'gap-free' sequence, and the uploaded binaries have no row to hang on. Two partial mitigations worth noting — the base required fields are checked at :202 (`if (!title || !description || !unit) return;`) BEFORE the number is drawn, so the scenario needs an org with a required custom-category field; and the stranded objects are reclaimable by the orphan sweeper after MIN_AGE_DAYS = 7 (lib/storageOrphans.ts:25), if an admin runs it. MEDIUM is right.

**Mechanism.** handleSubmit runs strictly in this order: allocate the atomic request number (215), upload every selected file to R2 (234-249), THEN validate required custom-category fields (271-286, which appAlerts and returns on the first empty one), THEN insert the row (327-332, which throws on RLS denial or a unique-number violation). Both the validation bail-out and the insert failure occur after the counter has been irreversibly incremented by next_ticket_number (its ON CONFLICT DO UPDATE ... RETURNING commits independently) and after the binaries are already in the bucket with no row referencing them. The migration that introduced the counter states the guarantee being broken: 'An ATOMIC per-(org, year) counter so numbers are sequential, gap-free, and can never collide'.

**Failure scenario.** An operator fills the request form, attaches four field photos and a marked-up scan, and hits submit, leaving a required custom field ('Work Order #') blank. The five files upload — the slow part he watches — and only then does an alert tell him a field is missing. He fills it in and resubmits, consuming a second number and re-uploading the same five files. The register now reads ...-0041, ...-0043 with 0042 missing, plus five orphaned objects in the bucket. At the next audit the missing number has to be explained, and the honest answer ('the form validated after it allocated') is not one anybody wants to give a PSM auditor.

**Evidence.**

```
app/(protected)/requests/new/page.tsx:215
      const ticketNumber = await generateTicketNumber(activeOrgId);

app/(protected)/requests/new/page.tsx:234-237
      if (files.length > 0) {
        setUploadStatus(`Uploading ${files.length} files...`);
        for (const file of files) {
          const result = await uploadTicketAttachment({ file, orgId: activeOrgId, ticketId: ticketNumber });

app/(protected)/requests/new/page.tsx:272-285 (validation AFTER the uploads)
      // Validate required custom fields before insert
      for (const cat of (config.customCategories ?? []).filter((c) => c.enabled)) {
        ...
          if (empty) {
            await appAlert(`"${f.label}" (${cat.label}) is required.`);
            setIsSubmitting(false);
            setUploadStatus('');
            return;

supabase/migrations/20260724_ticket_numbering.sql:4-6
--   • An ATOMIC per-(org, year) counter so numbers are sequential, gap-free,
--     and can never collide even under simultaneous submissions. Resets yearly.
```

**Chain reaction.** lib/storageOrphans.ts:52 DOES register ticket attachments as a reference source, so the stranded binaries are reclaimable — but only by an admin manually running the sweeper and only after MIN_AGE_DAYS (7). The number gap has no recovery at all. Reordering (validate -> allocate -> upload -> insert) fixes both; if the number must be reserved early, correct the migration comment to say gaps are possible and why.

**Done when.**

- [ ] All client-side validation runs before any upload and before generateTicketNumber
- [ ] A failed insert either releases/reuses the allocated number, or the 'gap-free' claim in 20260724_ticket_numbering.sql is corrected
- [ ] A failed submit leaves no unreferenced object in R2, or explicitly deletes what it uploaded

---

<a id="edge-14"></a>

## EDGE-14 · notification_preferences.inapp_enabled / push_enabled were added for 'the unified dispatcher to honor' and no code reads them

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260723_notifications_unify.sql:83-87`, `supabase/schema.sql:658-659`, `lib/notify/dispatch.ts:4-6`, `lib/inAppNotifications.ts:81-96`
- **Re-verified:** hardening pass — **SURVIVES**, by census. `inapp_enabled` and `push_enabled` have **0 references** anywhere in `app/`, `lib/` or `components/`. The migration that added them says they exist *"for the unified dispatcher to honor"* (`20260723_notifications_unify.sql:83`).
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed by repo-wide search: the columns are written by no code and read by no code. The dispatcher's only channel gate is the caller-supplied `channels` array, so flipping inapp_enabled in the database changes nothing — and there is not even a settings-UI writer (app/(protected)/settings/notifications/page.tsx handles only the email_* fields), so the column is unreachable except by direct SQL.

**Mechanism.** Migration 20260723 adds both columns under the header 'Per-channel preference switches the unified dispatcher honors.' I grepped three shapes — inapp_enabled, case-insensitive inappenabled, and push_enabled — across every .ts/.tsx/.sql in the repo excluding node_modules and .next. The only hits are the migration itself and the schema mirror. emit()'s in-app leg calls notifyMany unconditionally, and notify() inserts the row with no preference lookup at all. The /settings/notifications page is at least honest about the resulting behaviour ('In-app bell notifications are always on'), so the user-facing lie is small — but the schema and the dispatcher's own docblock ('each honoring per-user, per-channel preferences') both claim a control that does not exist.

**Failure scenario.** An operator asks to stop the bell for drafting-request status changes because he only wants email. An admin finds inapp_enabled in the schema, flips it in the database, and reports it done. Nothing changes — every ticket_status row still lands in his bell. Time is spent debugging a column that was never wired, and trust in the settings surface erodes for the toggles that DO work.

**Evidence.**

```
supabase/migrations/20260723_notifications_unify.sql:83-87
-- ─── Per-channel preference switches for the unified dispatcher. ────────────
-- Default TRUE so existing users see no behavior change.
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS inapp_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS push_enabled  BOOLEAN NOT NULL DEFAULT TRUE;

lib/notify/dispatch.ts:4-6
// THE single entry point every producer should call. One event in → resolved
// recipients (from all follow systems) → fanned out to every delivery channel
// (in-app bell, email), each honoring per-user, per-channel preferences.

lib/inAppNotifications.ts:81-83 (no preference read anywhere in notify())
export async function notify(input: NotificationInput): Promise<void> {
  try {
    const { error } = await supabase.from("notifications").insert({
```

**Chain reaction.** If inapp_enabled is ever wired it must be read server-side for the same RLS reason as the email preference — a client-side emit() cannot see another user's row. Wire it in the same change that moves the email leg, not before.

**Done when.**

- [ ] Either emit()'s in-app leg gates on inapp_enabled (read server-side) and the settings page exposes it, or both columns are dropped and the dispatcher docblock stops claiming per-channel preferences

---

> Line citations into `lib/notifications.ts` re-pointed 2026-09-02 after the roles-and-permissions sweep removed the browser external-mail path (`SURF-17`); the cited symbols are unchanged.
