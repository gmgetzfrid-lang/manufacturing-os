# 01 · The producer census

**16 findings** — 3 HIGH · 11 MEDIUM · 2 LOW. `PROD-15` and `PROD-16` opened by notifications Round G N8 PRODUCERS-FREE, 2026-10-07 (DEC-31 remainders of `PROD-2`).

Which parts of the app notify, which are silent, and which vocabulary is dead. The completeness question, answered kind by kind.

> Each finding below survived an adversarial verification pass: a second agent read
> the cited code and tried to refute it. Refuted findings were dropped and are not
> recorded. A severity set by that pass overrides the original.


### Already there — reusable substrate

| Thing | Where | Why it matters |
|---|---|---|
| emit() — a complete unified dispatcher that already resolves four audience sources and fans out to bell + email with per-category preference gating | `/home/user/manufacturing-os/lib/notify/dispatch.ts:82-132` | Every silent subsystem can be wired with a single emit() call. The dispatcher already dedupes, drops the actor, honours notification_preferences via queueEmail, and maps categories to eventTypes. Nothing new needs building — the gaps are all missing callers, not missing infrastructure. |
| resolveFollowers / resolveRoleRecipients / resolveProjectMembers — the follow-system unifier | `/home/user/manufacturing-os/lib/notify/recipients.ts:23-72` | Folds the subscriptions table and the legacy tickets.watchers array into one lookup. resolveProjectMembers is fully implemented and has zero callers — turning the 13 hardcoded-audience emit sites into follower-aware ones is a one-line change per site. |
| effectiveOwnerForDocument + getOrgControllers — document ownership resolution with folder/library inheritance | `/home/user/manufacturing-os/lib/ownership.ts:36-82` | Already used by retention, reviewControl, effectiveDate, acknowledgments, CheckInPanel and InspectorPanel. Holds is the only compliance surface that skips it, so fixing the hold audience is an import plus one resolve call. |
| sectionForKind + SectionCounts — per-section badge machinery that already computes more than the UI renders | `/home/user/manufacturing-os/hooks/useTicketNotifications.ts:71-132` | The infrastructure for the owner's 'trail goes cold' complaint half-exists: notifications are already bucketed per sidebar section. Extending it downward (library -> folder -> document) means grouping the same rows by resource_id — the rows already carry resource_type and resource_id from every producer. |
| COMPLIANCE_KINDS digest — a curated list of the regulated obligation kinds | `/home/user/manufacturing-os/app/api/cron/maintenance/route.ts:361-371` | Someone already enumerated which kinds represent obligations vs. FYI. That list is the natural seed for a corrected `actionKinds` set in useTicketNotifications.ts:279 (currently only 4 kinds) and for an 'alerts vs notifications' vocabulary split. |
| NotificationListener — realtime bridge from notification INSERTs to toasts, already scoped per-recipient | `/home/user/manufacturing-os/components/providers/NotificationListener.tsx:76-98` | The postgres_changes subscription filtered to user_id=eq.uid is exactly the hook an OS-level Notification API call would attach to (owner complaint #2), and the per-kind tone switch at lines 89-91 is where an alert/notification distinction would be expressed. |
| Stale-workflow reconciler — auto-clears notifications whose underlying ticket has moved on | `/home/user/manufacturing-os/hooks/useTicketNotifications.ts:188-210` | A working pattern for self-clearing alerts, keyed on metadata.status + metadata.action. Extending the same idea to metadata.branchId would fix the permanent branch_open rows; extending it to holds/acks would keep the badge honest without user action. |
| WatchButton + subscriptions table — a working opt-in follow UI for document/project/asset/library | `/home/user/manufacturing-os/components/ui/WatchButton.tsx:10, /home/user/manufacturing-os/lib/subscriptions.ts:35-61` | The user-facing half of the follow system is shipped and reachable; only 4 of 17 emit sites honour it. Every fix in the hardcoded-audience finding is additive to something users can already do. |
| The /checkouts overlap 'Nudge to coordinate' button — the app's only working person-to-person poke | `/home/user/manufacturing-os/app/(protected)/checkouts/page.tsx:242-260, 488-517` | A shipped pattern (button -> notifyMany with kind checkout_conflict, with 'Heads-up sent' confirmation state) that owner complaint #6 can copy verbatim into the drafting-request page to poke a stalled engineer. |
| notifications.kind is unconstrained TEXT with no CHECK | `/home/user/manufacturing-os/supabase/migrations/20260621_in_app_notifications.sql:17` | Cuts both ways: it is why the off-union storage_* rows land successfully rather than erroring, and it means adding new kinds needs no migration — but also that nothing catches a typo'd or unmapped kind at any layer. |


---


<a id="prod-1"></a>

## PROD-1 · 26 of 48 NotificationKinds badge nothing: sectionForKind drops the entire compliance vocabulary into an unrendered 'other' bucket

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:71-103`, `hooks/useTicketNotifications.ts:124-132`, `components/navigation/Sidebar.tsx:229-235`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The claim is accurate and precisely counted. Downgraded from HIGH to MEDIUM because the summary's 'the user's legal obligation to read' framing overstates the blast radius: the notification is NOT swallowed — hooks/useTicketNotifications.ts:311 exposes `count: items.length` over the full merged feed, so the bell badge, NotificationCenter, and app/(protected)/inbox/page.tsx:36 (which consumes the same `items`) all surface ack_requested. Only the per-section sidebar badge is missing, and document-level AckSection/AckPill surfaces exist independently. Consistent with OS-12, which grades the identical defect MEDIUM.

**Mechanism.** sectionForKind() switches on only 22 of the 48 union members plus 'ticket'; everything else hits `default: return 'other'`. emptySectionCounts() allocates five buckets, but Sidebar.tsx consumes exactly three — sectionCounts.documents, sectionCounts.projects, sectionCounts.requests. 'scratchpad' and 'other' are tallied and thrown away. The 26 unmapped kinds are: revision_published_over_checkout, library_doc_added, library_doc_revised, project_comment, task_reminder, review_due, owner_assigned, owner_behind, deletion_requested, ack_requested, ack_complete, ack_overdue, ack_unsatisfiable, review_requested, review_signed, review_invalidated, review_complete, review_overdue, review_alternate_activated, effective_now, retention_eligible, legal_hold_placed, legal_hold_released, access_recert_due, orchestrator_message, security_export — plus the off-union storage_* kinds. This is the mechanical root of the owner's complaint #1: the badge cannot continue down the chain because for the PSM-critical kinds it never appeared on a section at all.

**Failure scenario.** A controlled document is issued and lib/acknowledgments.ts:501 emits ack_requested to every assignee. sectionForKind('ack_requested') returns 'other'. sectionCounts.other is incremented and then never read by any component. The Documents sidebar item shows no badge. The user's legal obligation to read-and-acknowledge an issued revision is visible only if they happen to open the bell dropdown, whose global count did include it. Same for review_requested (a sign-off gate that blocks publishing), review_overdue, legal_hold_placed, and retention_eligible.

**Evidence.**

```
hooks/useTicketNotifications.ts:100-102 —
    default:
      return 'other';

hooks/useTicketNotifications.ts:124-132 —
function emptySectionCounts(): SectionCounts {
  return {
    requests: { total: 0, actionRequired: 0 },
    scratchpad: { total: 0, actionRequired: 0 },
    documents: { total: 0, actionRequired: 0 },
    projects: { total: 0, actionRequired: 0 },
    other: { total: 0, actionRequired: 0 },
  };
}

components/navigation/Sidebar.tsx:229 —
      { label: 'Documents',   hint: 'Libraries · board · locks · packages · blocked', href: '/documents',    icon: FileStack, tone: 'blue', ...badgeOf(sectionCounts.documents)   },
```

**Chain reaction.** Because ack_* and review_* are also the kinds the maintenance cron digests (COMPLIANCE_KINDS at app/api/cron/maintenance/route.ts:361-371), the daily email digest becomes the ONLY reliable delivery path for the regulated obligations, and it fires at most once per 25h.

> **Verifier correction.** CRITICAL is overstated: the unmapped kinds are NOT invisible. useTicketNotifications returns `count: items.length` over ALL items (line 312), so every one of the 26 kinds still increments the header bell badge (NotificationBell.tsx:107-111) and renders in the bell drawer and the NotificationCenter (which filters only on actionRequired, NotificationCenter.tsx:81-84). Sidebar.tsx:125-127 states this as the intended split: 'The header bell owns the org-wide total; the rail doesn't duplicate it.' The real defect is narrower than the title: per-section rail badging is missing for 26 kinds, several of which (ack_requested, review_requested, library_doc_added/revised, revision_published_over_checkout, effective_now, legal_hold_*) plainly belong under Documents. That is a genuine root cause for complaint #1, but it is a rail-badge gap, not a 'badges nothing' gap.

**Done when.**

- [ ] sectionForKind maps every member of the NotificationKind union to a rendered section (or the union is narrowed to what is renderable)
- [ ] A compile-time exhaustiveness check (`const _never: never = kind`) in sectionForKind's default arm makes a new kind a build error until it is mapped
- [ ] Sidebar renders a badge for every section sectionCounts allocates, or emptySectionCounts stops allocating buckets nobody reads

**Resolution (2026-10-01, notifications Round G).** **Reproduced first** on `b9cdfdc`: `lib/__tests__/notificationKinds.test.ts` was committed BEFORE any change (`e595cf5`) with the TODAY tables read from the source — `sectionForKind` returned `'other'` for 28 of the 50 union members (the audit's 26 plus `member_revoked` and `library_unowned`, added by R&P) and `'scratchpad'` for 3; `emptySectionCounts()` allocated five buckets; `components/navigation/Sidebar.tsx` badges three (`badgeOf(sectionCounts.documents|projects|requests)`); and the rendered hook, given one row of every kind written on `b9cdfdc`, tallied 33 rows into `other` and 3 into `scratchpad`, which no row reads. All seven assertions passed on the base, i.e. the defect reproduced as recorded.

**Fix (package N2 KIND-REGISTRY, commit `95dbe50`; review fix `42d5df8`; final-review fix `9950e29`, whose line numbers these are).** New `lib/notificationKinds.ts` `KIND_META` (:88) classifies every `NotificationKind` in one literal — `section`, `actionRequired`, `compliance`, `icon`, `tone`, `group` — with `as const satisfies Record<NotificationKind, KindMeta>` (:192), and each kind's section decision written next to it (:89 requests, :97 documents — the moved kinds under :116, :157 projects — `project_comment` at :161, :164 bell-only). `NOTIFICATION_SECTIONS` (:38) is exactly `requests | documents | projects`. `hooks/useTicketNotifications.ts` `sectionForKind` (:96) reads it, with a `never` guard over the registry's own keys (:102), so a kind added to the union without an entry fails `tsc` twice (here and at the `satisfies`); `emptySectionCounts` (:138) allocates one bucket per rendered section and no other. `'scratchpad'` and `'other'` are gone from `AttentionSection`; a kind with `section: null` is bell-only — counted by the header bell, listed by the Center and `/inbox`, counted by no rail row, which is exactly where `'other'` left it. A legacy row whose kind is in no union (a retired `task_nudge`) resolves to null at runtime. Decision recorded as `DEC-81` in `DECISIONS.md` (provisional number; the integrator renumbers).

**Where each kind went** (`DEC-81` §3; the plan's default): every kind that badged a row on `b9cdfdc` badges the same row; the document-scoped kinds that fell to `'other'` — `ack_requested`, `ack_complete`, `ack_overdue`, `ack_unsatisfiable`, `review_due`, `review_requested`, `review_signed`, `review_invalidated`, `review_complete`, `review_overdue`, `review_alternate_activated`, `library_doc_added`, `library_doc_revised`, `effective_now`, `owner_assigned`, `owner_behind`, `deletion_requested`, `retention_eligible`, `legal_hold_placed`, `legal_hold_released`, `access_recert_due`, `revision_published_over_checkout` — badge **Documents**; `project_comment` badges **Projects**; `orchestrator_message`, `security_export`, `member_revoked`, `library_unowned`, the three storage kinds, `ai_cap_changed` and `transmittal_unstampable` are bell-only, each with its reason in the registry. Nothing was mapped to Documents wholesale, and no emitted kind was deleted. For ratification with §3: `ai_cap_changed` and `transmittal_unstampable` are bell-only beyond the plan's default list (the census found them written outside the union); and `review_requested` is overloaded — besides a document's sign-off request, the contractor-intake path writes it for three notices that open a project: every contractor quote (`app/api/intake/upload/route.ts:899-906` `notifyTeam`, "Quote received: …", `resource_type` 'project', `/projects/<id>?tab=costs`), every intake submission awaiting review (`app/api/intake/upload/route.ts:1533-1544`, the same `notifyTeam`, "Intake submission awaiting review: …", a `/projects/<id>` link), and the folded digest when nothing was published (`lib/intakeRateLimit.ts` `foldedDigestKind`, `resource_type` 'project', a `/projects/<id>` link). So a project-scoped quote or intake notice now raises the **Documents** badge (none of the three badged a row on `b9cdfdc`, where `review_requested` fell to `'other'`). The overload is written next to the kind (`lib/notificationKinds.ts:132-144`); kinds of their own for these notices — for `notifyTeam`'s quote and submission notices and for the digest (e.g. `intake_quote` / `intake_submission`, section `projects`) — are the intake path's owner's (projects).

- Files: `lib/notificationKinds.ts` (new), `lib/inAppNotifications.ts` (the union), `hooks/useTicketNotifications.ts`.
- Tests: `lib/__tests__/notificationKinds.test.ts` — "sectionForKind and KIND_META agree with TODAY + the departures, kind by kind"; "every kind that badged a row on b9cdfdc badges the same row now"; "the sections are exactly the rows the Sidebar badges" (parses `Sidebar.tsx`); "'other' is gone: the bell-only kinds are exactly the deliberate list"; "GAP-201 acceptance 1: a kind added without a KIND_META entry fails the type check" (type-checks the hook in memory with a probe kind appended: the `never` guard and the `satisfies` both fail; clean without it); and the rendered hook over one row of every kind written on `b9cdfdc` — every row still renders (55 items, as before), requests 5 (unchanged), documents 12 → 34, projects 2 → 3, and `sectionCounts` has exactly the three rendered keys.
- Verified: loop on `fleet/N2-kind-registry` at `95dbe50`: `npx tsc --noEmit` exit 0; `npx eslint` on the 14 changed code and test files `--max-warnings=0` exit 0; `npx vitest run --maxWorkers=2` (full suite) exit 0 — 349 files, 7298 passed, 5 expected-fail. (Two default-worker runs on a machine at load 25 on 4 CPUs each timed out two unrelated fuzz tests at the 5 s default — a different pair each time, each passing alone.) After the review fix (`42d5df8`): `npx tsc --noEmit` exit 0; `npx eslint --max-warnings=0` on the five changed code and test files exit 0; `npx vitest run` (full suite, default workers) exit 0 — 349 files, 7302 passed, 5 expected-fail. `next build` is the integrator's. After the final-review fix (`9950e29`, comments only, and the record commits after it): `npx tsc --noEmit` exit 0; `npx eslint . --max-warnings=0` exit 0; `npx vitest run lib/__tests__/notificationKinds.test.ts lib/__tests__/notificationKindStorageProducers.test.ts lib/__tests__/notificationKindThreadProducer.test.ts` exit 0 — 3 files, 43 passed; `npx vitest run` (full suite) exit 0 — 349 files, 7302 passed, 5 expected-fail; `node audit-reports/build-index.mjs` ✓ corpus integrity.

**Done-when.**
- ✓ Every member of the union maps to a section a surface renders: one of the three rows the Sidebar badges, or `null` = bell-only, which the header bell renders (the union is not narrowed; the bell-only set is an explicit, tested list).
- ✓ The compile-time guard: `const _never: never = kind` in `sectionForKind` (`hooks/useTicketNotifications.ts:102`), typed over `keyof typeof KIND_META`, plus the `satisfies` — proven by the in-memory type-check test.
- ✓ `emptySectionCounts` allocates only `requests`, `documents`, `projects`, the buckets the Sidebar reads; a test pins the two lists equal.

**Scope / residual.** NEDGE-1 stays REFUTED (DEC-41) and was not worked: the gap closed here is the per-section rail badge, not a missed notification. The trail below the rail (library / folder / document markers) is GAP-202 / `TRAIL-1`, N11; the badge's doorway to exactly its items is `TAX-1` / `TRAIL-3`, N3.

---

<a id="prod-2"></a>

## PROD-2 · Access requests notify nobody — a locked-out user's request lands in a table with no producer

- **Severity:** HIGH
- **Status:** RESOLVED
- **Ratified (integrator at the N8 merge, 2026-10-07, under the user's delegation):** done-when 1 is met **as narrowed by `DEC-92` item 1** (the per-org burst limit), now ratified — the text below records what held before ratification. As written ("emits … on insert") done-when 1 holds for the first five requests to an org in an hour, not past them. If the integrator does not ratify the narrowing, this finding is OPEN on done-when 1 (DEC-29). Recorded 2026-10-07 by N8's final review fix.
- **Verification:** CONFIRMED
- **Locations:** `app/api/auth/request-access/route.ts:44-57`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Repo-wide grep for `access_requests` returns only this route plus lib/schemaExpectations.ts:31, lib/dataRestore.ts:315, lib/exportTables.ts:91 and the migration — no producer and no reader. The finding's own summary is actually too charitable: it says an admin can find it by 'navigating to the members/access screen', but no such screen exists, so the row is unreachable from the UI entirely.

**Mechanism.** POST /api/auth/request-access inserts an access_requests row and returns { ok: true }. There is no notify(), no emit(), no email_notifications insert, and no notifications insert anywhere in the file. No org Admin or DocCtrl is told a person is waiting at the door. Two shapes searched: grep -rln 'access_request|accessRequest' across app/lib/components/supabase returned only this route, lib/schemaExpectations.ts, lib/exportTables.ts, lib/dataRestore.ts and one migration — i.e. no other file writes or reacts to the table; and the subsystem sweep for producers (notifyMany|inAppNotifications|notify/dispatch|from("notifications")|queueEmail) over every file mentioning access_requests returned an empty producer set.

**Failure scenario.** A new engineer submits a join request for the workspace. The row is written. The response tells them 'Please wait for an admin to respond.' No admin receives a bell row, an email, or a badge. The request is discovered only if an admin proactively navigates to the members/access screen. In a regulated environment this is the on-ramp to the whole document-control system.

**Evidence.**

```
app/api/auth/request-access/route.ts:44-57 —
    const { error: insertError } = await supabaseAdmin.from("access_requests").insert({
      org_id: orgId,
      org_name: orgRealName,
      display_name: displayName,
      email,
      status: "pending",
      created_at: new Date().toISOString(),
    });

    if (insertError) {
      return NextResponse.json({ error: `Failed to submit request: ${insertError.message}` }, { status: 500 });
    }

    return NextResponse.json({ ok: true, orgName: orgRealName });
```

**Done when.**

- [ ] The route emits to resolveRoleRecipients(orgId, ['Admin','DocCtrl']) on insert
- [ ] The approve/deny action notifies the requester by email at the address they supplied

**Resolution (2026-10-07, notifications Round G).** **Reproduced first** on `f8d5eb5`: `app/api/auth/request-access/route.ts` inserted the `access_requests` row and returned `{ ok: true }` (:103-116) with no producer of any kind in the file (`grep -cE 'notify|emit\(|queueEmail|from\("notifications"\)'` → 0); the decline route (`app/api/admin/access-requests/route.ts:58-69`) and the approval (`app/api/admin/create-user/route.ts` `resolvePendingAccessRequests`) wrote the status and told nobody.

**What landed (package N8 PRODUCERS-FREE, `DEC-92` item 1 — the plan's default).**
- `app/api/auth/request-access/route.ts` — `notifyAccessRequest` (:77) runs after the insert (called at :217): under `runWithServerClient(supabaseAdmin)` it resolves `ACCESS_REQUEST_AUDIENCE` (`lib/accessRequestOutcome.ts:32`, `["Admin", "DocCtrl"]`) through `resolveRoleRecipients` (active members, headline or additive role), writes one `access_request_pending` bell row each through `notifyMany` (no actor — the person at the door has no account; `link: "/admin/users"`, `resource_type: "access_request"`, the request id) and queues one email each through `queueEmail` (event `assignment`; subject "Access request waiting for review", no name in it — NEDGE-6; the requester's name and address in the body, made safe first — see the review fix below). Best-effort: a failure is logged, the response is unchanged. The insert now returns its id (`.select("id").maybeSingle()`), nothing else about the route moved (the rate limit, IDENT-3's duplicate check, the 404 / 409 / 400 / 500 answers).
- `lib/accessRequestOutcome.ts` (new) — `queueAccessRequestOutcome` queues the answer, server-side, rendered from the stored request (`renderAccessRequestOutcome`): the decline route (:76) after a decline THIS call made (the update now returns its rows), as external mail owned by the deciding controller (`metadata.external`, the transmittal route's shape); the create-user route (:54) when the membership resolved a pending request, to the new member at that address. A row already decided, or an "Add member" that answered no request, emails nobody.
- `lib/notificationKinds.ts` / `lib/inAppNotifications.ts` — `access_request_pending` (bell-only, FYI, `Briefcase` / orange / group `other` — the feed's predicates on the name). The row is written by the service role, so it lands before or after `20261181` is pasted (that paste adds it to `notification_kinds()` for parity — `DEC-86`).
- Tests: `lib/__tests__/producersRoutes.test.ts` (10 — the pool exactly the active Admin / DocCtrl holders incl. an additive DocCtrl, never the Engineer or the suspended Admin; no actor; one email each with the name only in the body; the 80-character bound; 404 / 409 / 429 / 400 notify nobody; a bell failure never changes the 200; a decline queues one external email to the request's address, a second decline none, a refused caller none; an approval emails the new member; an Add member with no request emails nobody; the message text with and without a public origin); `lib/__tests__/requestAccessRoute.test.ts`, `accessRequestDecline.test.ts`, `createUserRoute.test.ts` unchanged and green (REGRESSION).
- Verified: Loop on `fleet/N8-producers-free` at `3dd10b8`: `npx tsc --noEmit` exit 0; `npx eslint` on the 27 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 435 files, 9480 passed, 7 expected-fail. `next build` is the integrator's.

**Done-when.**
- ✓ The route emits to `resolveRoleRecipients(orgId, ['Admin','DocCtrl'])` on insert — bell + email (`notifyMany` + `queueEmail`, the two legs `emit()` composes; `emit()` itself takes a document / project / ticket / asset / library resource, and an access request is none of them).
- ✓ The approve / deny action notifies the requester by email at the address they supplied — a decline from `/api/admin/access-requests`, an approval from `/api/admin/create-user`, both queued server-side from the stored row.

**Scope / residual.** The notice links to Admin → Users, where the pending list is shown to Admins only (`isAdmin && pendingRequests.length > 0`, `app/(protected)/admin/users/page.tsx:374`; `access_requests_admin_select`, `20261023`), while both deciding routes admit a DocCtrl — a DocCtrl in the pool can add the member or decline, but cannot open the list the notice points at. Opened as **`PROD-15`** (below), not narrowed here (the plan's default stands, `DEC-92` item 1). admin-and-org P5 (ORG-8) and P8 (ALOG-4) edit `request-access` and `create-user` later and rebase on this.

**Review fix (2026-10-07, notifications Round G, N8 fix pass).** The review found that the notice as first landed let anyone at this public, unauthenticated door put their own text — a phishing line, a line break, a link — into a bell row and an email sent from the app's own sender to every Admin and DocCtrl: the address was only trimmed and lowercased, the name only cut to 80 characters, and the per-IP limiter (which fails open and exempts an unknown IP) was the only throttle, so rotating the "address" repeated it without limit. Before N8 that text was visible only on the Admin card. Closed at the door, with no response change:
- `lib/accessRequestOutcome.ts` — `wellFormedAddress` (:66): ONE address, at most 254 characters, no control or invisible character, the shape the decline path already checked (`^[^\s@]+@[^\s@]+\.[^\s@]+$`), and no `/` or `:` (a path or a scheme — text a mail client could turn into a web link); the decline and approval emails use the same check. `noticeSafeName` (:83): control and line-break characters become spaces, invisible formatting characters (zero-width, bidi) are dropped, every token that reads as a link (a scheme, `www.`, a dotted host) becomes "[link removed]", cut to 80. `ACCESS_REQUEST_EMAILS_PER_ORG_HOUR` (:92) = 5.
- `app/api/auth/request-access/route.ts` `notifyAccessRequest` (:77) — the bell row and the email carry only the safe name; an address that fails is shown as "invalid address" and gets **no email leg** (the bell still goes); and when more than 5 requests reached the org in the last hour (`requestsToOrgLastHour`, :46, a head count on `access_requests`) the pool gets the bell row only — a count that cannot be read also means bell only (fail closed). The request row, the per-IP limiter and every response are unchanged. *(Superseded by the second review fix below: past the cap the bell leg stops too, and `ACCESS_REQUEST_EMAILS_PER_ORG_HOUR` is now `ACCESS_REQUEST_NOTICES_PER_ORG_HOUR`.)*
- The stale-notice half: once a request is decided its pool notices are marked read for everyone — `clearAccessRequestNotices` (:175; `read_at` only, on the service role, keyed on `resource_type = 'access_request'` + `resource_id` = the request id, the `(org_id, resource_type, resource_id)` index; best-effort) — called by the decline route (:86) after a decline THIS call made, and by `create-user`'s `resolvePendingAccessRequests` (:65) for each request the membership resolved (the PROD-3 rule, applied to this kind).
- Tests: `lib/__tests__/producersRoutes.test.ts` (10 added — the reviewer's case: a name and an address carrying a newline, a phishing line and a URL — answered 200 as before, the bell with no line break and no link, the address shown invalid, no email; a scheme-and-path address and a 5 KB address — no email, never in the bell; control / zero-width / bidi characters dropped from the name; a burst of 8 requests — 8 bell rows, mail for the first 5 only; a count that cannot be read — bell only; `wellFormedAddress` and `noticeSafeName` case tables; a decline clears exactly that request's unread pool rows — not another request's, kind's or org's, not an already-read row; an approval clears them, an Add member with no request clears nothing; a refused caller clears nothing, and a clearing that fails never changes the decline's answer).
- Verified: Loop on `fleet/N8-producers-free` after the fix pass (code at `4896093`): `npx tsc --noEmit` exit 0; `npx eslint` on the 18 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 436 files, 9498 passed, 7 expected-fail. Two earlier full runs, made while the machine's load average was 20-26 on 4 cores, failed only on 5-second test timeouts and timing-dependent DOM tests (`cornerDock`, the `dependencies` and `rfqDocx` fuzzes, `dcRoundFOwnerStamp`, `customSkillRunner`, `j10bLabelsFormattersLinks`, `dcRoundFShareInventory`, and one census case in `notificationWriteRails` that timed out); each passes alone, and the final full run is clean. `next build` is the integrator's.

**Second review fix (2026-10-07, notifications Round G, N8 fix pass 2).** The second review found the per-org cap limited only the email leg: `notifyMany` ran for every inserted request before the cap was read, so a script at this public door — a new address each time, rotating or forged IPs (the per-IP limiter fails open, exempts an unknown IP and trusts the first `x-forwarded-for` entry, which can be forged off-Vercel — SHR-11) — wrote a bell row and a realtime toast per request into every Admin's and DocCtrl's bell, pushing their compliance notices (`ack_overdue`, `review_overdue`, `hold_opened`) out of the bell's 50-row list (TAX-6), with nothing telling them why. Fixed at the door; no response changed:
- `app/api/auth/request-access/route.ts` `notifyAccessRequest` (:128) reads the org's hourly request count FIRST (:137; `requestsToOrgLastHour` :47), and the cap gates BOTH legs. Past `ACCESS_REQUEST_NOTICES_PER_ORG_HOUR` (5 — `lib/accessRequestOutcome.ts:99`, renamed from `ACCESS_REQUEST_EMAILS_PER_ORG_HOUR` because it no longer caps only the email), or when the count cannot be read, a request gets no bell row and no email of its own.
- The pool is told ONCE instead: `notifyAccessRequestBurst` (:69) gives each pool member at most one UNREAD "More access requests are waiting for <org>" row. The row is `access_request_pending`, `resource_type` `'org'` (`ACCESS_REQUEST_BURST_RESOURCE_TYPE`, `lib/accessRequestOutcome.ts:104`), `resource_id` the org id, `metadata.accessRequestBurst`, no actor, linking to Admin → Users. Its words are the app's own and the org's stored name; nothing a stranger typed is in it. A member who already holds an unread one gets nothing more (no row, no toast) until they read it. It is one typed statement on the service role (`notifyBatchWithReason` — see `TAX-11`).
- The open-row check matches only rows with no actor (`.is("actor_user_id", null)`, :79). 20261160 stamps every signed-in writer as the actor, so no member's browser can forge the decoy row that would silence the notice. If that read fails, nothing is written: at most one row per member, never one per request. The row is keyed on the org, never on a request id, so deciding one request (`clearAccessRequestNotices`) does not clear it; it stays until read. Every request is still recorded and listed on Admin → Users.
- Known gap: two requests that land in the same instant past the cap can each see no open row and both write one. That member then holds two rows, bounded by concurrency rather than by the request rate. *(Fix pass 3: opened as `PROD-16`, owner notifications N14.)*
- Tests (`lib/__tests__/producersRoutes.test.ts`):
  - The burst is rewritten to the reviewer's case. Of 8 requests, only the first 5 get bell rows and mail. For the other 3, each pool member holds ONE burst row, and nothing typed at the door is in it. A member who read theirs is told again by the next request; the others are not.
  - A failed count: no bell row or email of the request's own, and one burst row each.
  - A forged member row (one with an actor) does not silence the burst notice.
  - A failed open-row read writes nothing.
  - The dedupe-read ratchet (`lib/__tests__/notificationWriteRails.test.ts`) lists the route's read with its actor-null watermark and checks both the read and 20261160's actor stamp.
- Verified: see `TAX-11`'s fix-pass-2 block (`03-taxonomy.md`) — one loop for the whole second fix pass.

**Done-when (after fix pass 2).** *(Corrected by the final review fix below: the first line ticked a narrower criterion than the one written.)*
- ✓ The route emits to `resolveRoleRecipients(orgId, ['Admin','DocCtrl'])` on insert, bell + email, for the first five requests to an org in an hour. Past that, the pool holds one standing notice that more are waiting, and the pending list names every request. A stranger can no longer turn the door into an unbounded run of bell rows.
- ✓ (unchanged) The approve / deny action notifies the requester by email at the address they supplied.

**Final review fix (2026-10-07, notifications Round G, N8 fix pass 3).** The final review raised two points on this record:
- **The burst notice stated a count nobody had read.** `notifyAccessRequestBurst` runs when the org's hourly count is over the cap AND when the count cannot be read (`recent === null`). Both used one body: "More than 5 people asked to join <org> within an hour…". On the second path that is untrue: a transient error on the head count turned an org's first and only request of the day into "more than five within an hour" in every Admin's and DocCtrl's bell. `app/api/auth/request-access/route.ts` `burstNotice` (:62) now words the row from the count: with a count over the cap, as before; with no count, "Access requests are waiting for <org>" as the title and "Access requests are waiting for <org>. Every request is listed under Admin → Users: review them there." as the body, with no number and no "more". The burst row's key, its dedupe, its link and every response are unchanged (:108).
- **The record ticked done-when 1 as narrowed, not as written.** Corrected below and in the Status block. The narrowing is `DEC-92` item 1. The concurrent double-burst row had no owner; it is now `PROD-16` (LOW), owner notifications N14.
- Tests: `lib/__tests__/producersRoutes.test.ts` "a count that could not be read is never stated as a number…" (new): with the count read failing, each pool member's burst row reads "Access requests are waiting for Acme Refining", with no digit, "More than" or "within an hour". REGRESSION: a count that was read and is over the cap keeps the "More than 5 … within an hour" title and body word for word. The case fails without the fix; every other `producersRoutes` case is unchanged and green.
- Verified: see `PROD-6`'s final-review block — one loop for the whole of fix pass 3.

**Done-when (after fix pass 3).**
- ✓ **as narrowed by `DEC-92` item 1 (pending the integrator's ratification).** The route emits to `resolveRoleRecipients(orgId, ['Admin','DocCtrl'])` on insert, bell + email, for the first five requests to an org in an hour (`ACCESS_REQUEST_NOTICES_PER_ORG_HOUR`). **As written it is not met past that.** A request past the cap, or any request while the org's count cannot be read, gets no bell row and no email of its own. Each pool member then holds at most one unread burst row: "More access requests are waiting…" when the count was read, "Access requests are waiting…" when it was not. A member who already holds an unread one gets nothing for that request. The pending list on Admin → Users names every request. Two requests that land at once past the cap can give a member two burst rows (`PROD-16`, owner N14).
- ✓ (unchanged) The approve / deny action notifies the requester by email at the address they supplied.

---

<a id="prod-3"></a>

## PROD-3 · branch_resolved goes only to the brancher, never to the DocCtrl pool that was alerted to branch_open

- **Severity:** HIGH
- **Status:** RESOLVED
- **Pending migration:** `supabase/migrations/20261181_notif_roundG_producers_free.sql` (DEC-30). RESOLVED is the code half. Done-when 2's database half — the pool's `branch_open` rows marked read — holds only once `20261181` is applied, and whether it is applied cannot be checked from here. Paste it after `20261160` / `20261161` and BEFORE the deploy: the same paste declares the three kinds N8 writes from the browser (`change_order_status`, `milestone_assigned`, `milestone_slipped`), whose rows are refused (and only logged) once `20261160` is live without it. Recorded 2026-10-07 by N8's final review fix.
- **Verification:** CONFIRMED
- **Locations:** `lib/branches.ts:148`, `lib/branches.ts:204-215`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed asymmetry, and it is worse than stated: resolveBranch passes `actorUserId: input.actorUserId`, which dispatch.ts:77 (`ids.delete(input.actorUserId)`) strips — so when the brancher resolves their own branch the recipient set is empty and emit() returns at dispatch.ts:84 before writing anything. The stale branch_open row is also not auto-reconciled: the cleanup at useTicketNotifications.ts:188-209 only touches rows carrying `metadata.status` + `metadata.action`, and announceBranchOpened's metadata is `{ branchId }` only.

**Mechanism.** announceBranch emits branch_open to `audience: { involved, roles: ["DocCtrl"] }` — every DocCtrl in the org gets an action-required alert (branch_open is in actionKinds at useTicketNotifications.ts:279). resolveBranch emits branch_resolved to `audience: { involved: [branch.createdBy] }` — the DocCtrl role pool is not in the audience. The opening and closing halves of the same workflow have asymmetric audiences.

**Failure scenario.** A drafter publishes off a stale base. Every DocCtrl receives 'Unreconciled branch opened on P-101', flagged Action needed, badged on the Documents section. The drafter later merges the branch. resolveBranch notifies only branch.createdBy — the drafter, who already knows. Every DocCtrl's alert stays unread and action-required. The stale-workflow reconciler at useTicketNotifications.ts:188-210 cannot clear it either: that reconciler only retires rows where `metadata.status` is a string and `metadata.action != null`, and branches.ts:149 writes `metadata: { branchId: input.branchId }` — neither key is present. The alert is permanent until manually dismissed.

**Evidence.**

```
lib/branches.ts:148 —
      audience: { involved, roles: ["DocCtrl"] },

lib/branches.ts:204-215 —
    await emit({
      orgId: input.orgId,
      category: "status",
      kind: "branch_resolved",
      title: `Branch ${input.resolution === "merged" ? "merged" : "withdrawn"}`,
      body: `${input.actorName} resolved the open branch: "${input.note.trim()}"`,
      resource: { type: "document", id: branch.documentId },
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      audience: { involved: [branch.createdBy] },
      metadata: { branchId: branch.id },
    });
```

> **Verifier correction.** Trivial naming: the function is `announceBranchOpened`, not `announceBranch`.

**Done when.**

- [ ] resolveBranch's audience mirrors announceBranch's: { involved: [branch.createdBy], roles: ['DocCtrl'] }
- [ ] Resolving a branch marks the matching unread branch_open rows read (match on metadata.branchId), so the queue self-clears

**Resolution (2026-10-07, notifications Round G).** **Reproduced first** on `f8d5eb5`: `resolveBranch` emitted `branch_resolved` to `audience: { involved: [branch.createdBy] }` (`lib/branches.ts:232`) while `announceBranchOpened` alerted `{ involved, roles: ["DocCtrl"] }` (:148), and nothing marked a `branch_open` row read — the hook reconciles ticket workflow rows only, and since `20261161` a browser may change only its OWN rows, so no client-side clear could ever reach the pool's rows.

**What landed (package N8, `DEC-92` item 5).**
- `lib/branches.ts:237` — `branch_resolved`'s audience is `{ involved: [branch.createdBy], roles: ["DocCtrl"] }`; the dispatcher drops only the actor, so a brancher resolving their own branch still tells the pool (active DocCtrls only, NEDGE-3).
- `lib/branches.ts:242` / `clearBranchOpenAlerts` (:253) — after the resolution, `supabase.rpc("clear_resolved_branch_alerts", { p_branch })`. **`20261181`** adds `clear_resolved_branch_alerts(uuid)`: SECURITY DEFINER, `search_path` pinned, REVOKEd from PUBLIC and anon, EXECUTE to authenticated only (DRLS-16); it acts only on a RESOLVED branch of an org the caller is an ACTIVE member of (any other id, or no `auth.uid()`, answers 0 — one answer, no cross-tenant oracle) and sets `read_at` on that org's unread `branch_open` rows whose `metadata @> {"branchId": …}` — `read_at` only, which 20261161's read_at-only trigger passes for a definer path on another member's rows. The same paste marks read, once, the backlog of unread alerts about branches already resolved (the inventory counts them before; a probe says none are left after). Before the paste (PGRST202 / 42883) the resolution succeeds and the alerts stay unread, as they always did — logged, never thrown.
- `lib/schemaExpectations.ts` — the schema-health panel probes the function (`p_branch: "schema-health-probe"`, refused as a uuid — the body never runs).
- Tests: `lib/__tests__/producers.test.ts` "PROD-3" (5 — the audience; the pool resolved by the real `resolveRecipients` when the brancher resolves, actor and suspended DocCtrl out; the RPC with the branch id; PGRST202 / 42883 keep today's path; an emit failure never fails the resolution); `lib/__tests__/notifProducersFree.test.ts` (the function's shape, the one-answer rule, the `read_at`-only write, the key matching `announceBranchOpened`'s metadata, the backlog, DRLS-16); `lib/__tests__/dcRoundFBranchMergeRefusal.test.ts` unchanged and green (REGRESSION).
- Verified: Loop on `fleet/N8-producers-free` at `3dd10b8`: `npx tsc --noEmit` exit 0; `npx eslint` on the 27 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 435 files, 9480 passed, 7 expected-fail. `next build` is the integrator's.

**Done-when.**
- ✓ `resolveBranch`'s audience mirrors `announceBranchOpened`'s role pool: `{ involved: [branch.createdBy], roles: ['DocCtrl'] }` (`lib/branches.ts:237`).
- ✓ Resolving a branch marks the matching unread `branch_open` rows read (matched on `metadata.branchId`) — once `20261181` is pasted (DEC-30: the database half is unobservable from here; the paste's probes report it). Before the paste the app keeps today's behaviour.

**Scope / residual.** The general class — any row whose condition has ended (holds, acks, reviews) — stays `TRAIL-9` (N4); this clears only the branch alerts, at the producer. PASTE / DEPLOY: `20261160` → `20261161` → `20261181`, then the deploy (either order is safe for this finding; the new kinds in the same paste are why it goes first).

---

<a id="prod-4"></a>

## PROD-4 · 13 of 17 emit() call sites hardcode their audience; the follower/watcher machinery is bypassed and audience.projectId is never used at all

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/notify/dispatch.ts:36-41`, `lib/distributionAcks.ts:145`, `lib/staleCopies.ts:205`, `lib/revisionImpact.ts:148`, `lib/workPackages.ts:286`, `lib/checkoutEpisodes.ts:676`, `lib/projects.ts:706`, `lib/notify/recipients.ts:65-72`, `lib/ticketTransitions.ts:130-132`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The 13-of-17 count is exact, and `audience.projectId` is genuinely never supplied, which makes resolveProjectMembers (lib/notify/recipients.ts:65-72) reachable only through a branch nothing takes — its sole references are the import and the call at dispatch.ts:74. Cited lib/ticketTransitions.ts:130-132 is not an emit() site but does hardcode recipients (`newUnreadBy = [ticket.requesterId, ticket.assignedDrafterId]`), consistent with the claim.

**Mechanism.** The dispatcher offers four audience sources: involved, followers, roles, projectId. Enumerating every `audience: {` block in the codebase yields 17 call sites. Only four pass `followers: true` (holds.ts:252, postPublish.ts:46, postPublish.ts:60, documents/[libraryId]/page.tsx:2313). Only two pass `roles` (holds.ts:252, branches.ts:148). ZERO pass `projectId` — resolveProjectMembers() at recipients.ts:65 is reachable only through a branch no caller takes. The remaining 13 sites pass a hand-built `involved` array, so a user who pressed the WatchButton on that document receives nothing. `channels` is likewise never passed by any caller (grep for `channels: [` returns nothing), so every emit always sends both in-app and email. The same hardcoding appears on the ticket side: computeTransition's default audience is `[ticket.requesterId, ticket.assignedDrafterId]` — assignedEngineerId is absent, even though app/api/tickets/comment/route.ts:92 correctly does `if (ticket.assignedEngineerId) involved.add(ticket.assignedEngineerId)`. The two ticket audiences disagree.

**Failure scenario.** A DocCtrl uses WatchButton (components/ui/WatchButton.tsx) to subscribe to a critical P&ID, writing a subscriptions row. Someone force-releases a checkout on it: lib/checkoutEpisodes.ts:676 emits to `{ involved: victims }` only. Someone's downloaded copy goes stale: lib/staleCopies.ts:205 emits to `{ involved: outdated.map(h => h.userId) }` only. A work package pinning it goes stale: lib/workPackages.ts:286 emits to `{ involved: [p.owner_user_id] }` only. The watcher hears about rev-ups and holds and nothing else. Separately, an engineer assigned via request_review is notified once (line 187 overwrites unread_by to [engineer.id]) and then falls out of every subsequent transition's audience until they act — line 296 only makes an ACTOR a watcher — so the person the ticket is blocked on stops hearing about it.

**Evidence.**

```
lib/notify/dispatch.ts:36-41 —
  audience: {
    involved?: string[];   // explicit stakeholders (requester/assignee/mentions)
    followers?: boolean;   // walk resolveFollowers(resource)
    roles?: string[];      // a role pool in the org
    projectId?: string;    // members of a project
  };

lib/notify/recipients.ts:65-72 (reachable, never reached) —
export async function resolveProjectMembers(projectId: string): Promise<string[]> {
  if (!projectId) return [];
  const { data } = await supabase
    .from("project_members")
    .select("user_id")
    .eq("project_id", projectId);
  return ((data as Array<{ user_id: string }> | null) ?? []).map((r) => r.user_id);
}

lib/ticketTransitions.ts:130-132 —
  const newUnreadBy = [ticket.requesterId, ticket.assignedDrafterId].filter(
    (id): id is string => !!id && id !== actorUid,
  );
```

> **Verifier correction.** The ticket half of this finding is substantially wrong and should be dropped. `newUnreadBy` at lib/ticketTransitions.ts:130-132 is only the DEFAULT; the switch overrides `updates.unread_by` to `[input.engineer.id]` for every engineer-routing action (lines 187, 244, 270) and to `[ticket.assignedDrafterId]` / `[ticket.requesterId]` elsewhere (234, 252, 258, 262). Lines 300-303 then merge `ticket.watchers` into unread_by, and line 296 auto-adds the actor as a watcher. Line 317 derives `recipients` from that merged array, and app/api/tickets/workflow-action/route.ts:337-350 notifies exactly those. So the ticket path does NOT bypass the watcher machinery and DOES reach the assigned engineer on engineer transitions — 'the two ticket audiences disagree' is only true for a residual case (a generic status change with an engineer who has never touched the ticket). Also note the doc bug the finding quotes without flagging: dispatch.ts:42 says 'Defaults to all three' while NotifChannel has only two members. Downgrade to MEDIUM: the 13 hardcoded sites are mostly targeted personal alerts (specific stale-copy holders, specific ack recipients) where a broadcast to watchers would be wrong.

**Done when.**

- [ ] Every document-scoped emit adds followers: true alongside its involved list
- [ ] Project-scoped emits pass audience.projectId instead of pre-resolving members by hand (lib/projects.ts:686-706 already resolves members ∪ watchers manually — that logic belongs in the dispatcher)
- [ ] computeTransition's newUnreadBy includes ticket.assignedEngineerId, matching the comment route
- [ ] A test asserts that a subscriptions row on a document causes that user to appear in resolveRecipients for every document-scoped kind

---

<a id="prod-5"></a>

## PROD-5 · CSV document import creates library documents without notifying subscribers, while the staged-upload path does

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/documents/CsvImportModal.tsx:166`, `app/(protected)/documents/[libraryId]/page.tsx:2300-2314`, `app/(protected)/documents/[libraryId]/page.tsx:2508`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: notifyLibrarySubscribers is a closure declared inside handleStagedUpload (page.tsx:2299-2315), so it is not even in scope for the CSV path, and the onImported handler does no notification of any kind. Library watchers get nothing from a CSV import.

**Mechanism.** There are exactly two client paths that insert into the documents table (grep for `from("documents")` combined with insert returns two hits). The staged-upload path defines notifyLibrarySubscribers() at page.tsx:2300 and calls it once at page.tsx:2508 with kind 'library_doc_added' and audience { followers: true }. CsvImportModal.tsx:166 inserts documents with no notification at all — grep of the file for 'notify|emit|dispatch|notifications' returns nothing. So library_doc_added, already the least-covered kind (a single emitter), is skipped entirely by the bulk-import route.

**Failure scenario.** A DocCtrl bulk-imports 200 drawings into a library via CSV. Every user who pressed Watch on that library — the exact mechanism task #92 ('Library subscriptions — watch button + notify on new/revised docs') was built for — receives nothing. Uploading the same 200 files through the staging modal would have notified all of them.

**Evidence.**

```
app/(protected)/documents/[libraryId]/page.tsx:2300-2313 (the path that notifies) —
    const notifyLibrarySubscribers = (count: number, firstName: string) => {
      if (!activeOrgId || !uid || count === 0) return;
      void import("@/lib/notify/dispatch").then((m) =>
        m.emit({
          ...
          kind: "library_doc_added",
          ...
          audience: { followers: true },
        })).catch(() => undefined);
    };

components/documents/CsvImportModal.tsx:166 (the path that does not) —
        const { error: insertErr } = await supabase.from("documents").insert({
```

**Done when.**

- [ ] CsvImportModal emits library_doc_added with audience { followers: true } after a successful batch
- [ ] The notify call is extracted to a shared helper both insert paths use, so a third insert path cannot silently skip it

**Partial (2026-10-07, notifications Round G).** **Reproduced first** on `f8d5eb5`: `components/documents/CsvImportModal.tsx` inserted documents (:187) with no producer in the file (0 matches), while the staged-upload path's closure (`app/(protected)/documents/[libraryId]/page.tsx:2394-2408`) emitted `library_doc_added` to the library's followers.

**What landed (package N8, `DEC-92` item 6).**
- `lib/libraryNotify.ts` (new) — `notifyLibraryDocsAdded({ orgId, libraryId, count, firstLabel, actorUserId, actorName })`, extracted verbatim from the page's closure (kind `library_doc_added`, category `watched`, the same title / body / link / resource, `audience: { followers: true }`, the actor dropped by the dispatcher) with one change, PROD-7 done-when 3: `channels: ["inapp"]`. Never throws; nobody is told for a zero count or a missing org / library / actor.
- `components/documents/CsvImportModal.tsx:255` — after a batch that inserted at least one row, `void notifyLibraryDocsAdded(...)` with the count, the first imported number and the signed-in actor; an optional `actorName` prop (absent, the notice says "Someone", as the page's closure does without an email).
- Tests: `lib/__tests__/producersCsvImport.test.ts` (3, rendered — a two-row import calls the helper once with count 2, "P-101" and the actor; a batch the database refused calls nothing; the modal imports the helper and never `emit()` itself); `lib/__tests__/producers.test.ts` "PROD-5" (2 — the verbatim notice with `channels: ["inapp"]`; the guards; a dispatch failure swallowed); the CSV import's own tests (`dcRoundFCsvImportUnitDecode`, `dcRoundFP15CsvImportStatus`) unchanged and green (REGRESSION).
- Verified: Loop on `fleet/N8-producers-free` at `3dd10b8`: `npx tsc --noEmit` exit 0; `npx eslint` on the 27 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 435 files, 9480 passed, 7 expected-fail. `next build` is the integrator's.

**Done-when.**
- ✓ `CsvImportModal` emits `library_doc_added` with `audience { followers: true }` after a successful batch (through the helper; in-app only).
- **Not done — partly:** "the notify call is extracted to a shared helper both insert paths use". The helper exists and the CSV path uses it; the staged-upload page still calls its own closure (dual channel) — that file is not N8's (document-control P6 / intake IS-P1 edit it), and the swap is **notifications N9**'s by plan (after DC P6 / IS-P1). Until then the two paths' channels differ (staged: in-app + email; CSV: in-app).

**Scope / residual.** Stays OPEN for done-when 2's page half — owner notifications N9 (swap `notifyLibrarySubscribers` at `page.tsx:2394` onto `notifyLibraryDocsAdded`, and pass `actorName` to `CsvImportModal`). PROD-7 done-when 3's `library_doc_added` arm closes with that swap. *(Fix pass 3: passing `actorName` is no longer needed for the notice to name the actor; see below.)*

**Final review fix (2026-10-07, notifications Round G, N8 fix pass 3).** The final review found every CSV-import notice read "Someone added …". The library page (`app/(protected)/documents/[libraryId]/page.tsx:3341-3352`, not N8's file) passes the modal `actorUserId` and no `actorName`, and the helper fell back to "Someone". The staged-upload closure names the uploader by the session's email (`userEmail`). The modal cannot read that email itself: `useRole()` throws outside `RoleProvider`, and the modal's own tests render it without one.
- `lib/libraryNotify.ts` `notifyLibraryDocsAdded` (:61) now looks the actor up when no name is passed (`actorEmailInOrg`, :47). It reads the actor's email in this org from `org_members` (the address the staged-upload path names), then their display name. It says "Someone" only when neither is known, and a failed read never throws. A name that IS passed is used verbatim, with no read, so the staged-upload path's words stay identical when N9 moves it onto the helper.
- `components/documents/CsvImportModal.tsx` — the `actorName` prop's comment says what happens without it. The call (:257) is unchanged.
- Tests: `lib/__tests__/producers.test.ts` "PROD-5" "a caller that passes no name (the CSV import…)" (new). The CSV import's uid-only call reads "dc1@acme.test added 200 documents…", the same words as the staged-upload path's call with that email. A passed name is verbatim, with no `org_members` read. A member with no email on file is named by display name. A failed read gives "Someone". The guard case now uses an actor nobody knows to pin "Someone". The new case fails without the fix.
- Verified: see `PROD-6`'s final-review block — one loop for the whole of fix pass 3.

---

<a id="prod-6"></a>

## PROD-6 · Cost control, change orders, checklists, turnover, punch, equipment registry and companies are all completely silent

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/changeOrders.ts`, `lib/costs.ts`, `lib/checklists.ts`, `lib/turnover.ts`, `lib/companies.ts`, `lib/equipmentBridgeServer.ts`, `lib/documentShares.ts`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Claim of absence verified repo-wide, including the punch-item code (which lives in lib/turnover.ts and lib/companies.ts, both zero) and the checklist API route. No caller-side compensating notification was found.

**Mechanism.** Two-shape verification. Shape 1: grep -c 'notify|queueEmail|emit(|notifications' over each file — all return 0. Shape 2: a subsystem sweep that collected every file mentioning change_orders/changeOrders, checklists, turnover, punch_items, equipment_registry, cost_items, lib/companies and document_shares, then grepped that whole file set for any producer pattern (notifyMany|inAppNotifications|notify/dispatch|from("notifications")|queueEmail) — every one returned an empty producer set. These are the modules shipped by tasks #189-#195 (the CV project-controls program); none of them were wired to the notification spine.

**Failure scenario.** A change order is raised against a project budget, a PSSR checklist item is signed off, a punch item is assigned, or a turnover package is marked complete. No stakeholder is notified through any channel. The information is available only by navigating to the relevant project tab. A change order awaiting approval can sit indefinitely with no escalation clock, unlike drafting requests (request_pending_approval) or reviews (review_overdue).

**Evidence.**

```
Producer sweep result (each subsystem's full file set grepped for any notification producer):
  changeOrders             producers:[]
  checklists               producers:[]
  turnover                 producers:[]
  punch                    producers:[]
  equipment                producers:[]
  costs                    producers:[]
  companies                producers:[]
  documentShares           producers:[]
```

**Done when.**

- [ ] Change-order submit/approve/reject emits to the project's members and the cost owner
- [ ] Punch/checklist assignment emits to the assignee
- [ ] A decision is recorded (in the union's comments or a doc) for each subsystem deliberately left silent, so 'silent' is a choice rather than an omission

**Partial (2026-10-07, notifications Round G).** **Reproduced first** on `f8d5eb5`: `lib/changeOrders.ts` notified only an approval's proposer (`notifyApproval`, :424 / :449, projects J3's MON-11 limb); `lib/turnover.ts`, `lib/checklists.ts` had no producer (0 matches each); `lib/costs.ts` and `lib/companies.ts` none either.

**What landed (package N8, `DEC-92` item 2).**
- `lib/changeOrders.ts` — `notifyChangeOrder` (:464): a change order proposed (:250), approved or rejected (:429) notifies the project's members (`resolveProjectMembers`) and its owner (`projects.owner_user_id`), kind `change_order_status` (new, section `projects`), bell + email, the actor never. On an approval the proposer is left out because `notifyApproval` (unchanged — kind `project_status`, "Your change order…") already tells them: one notice each. A rejection reaches the proposer here. A void is silent. Best-effort behind the money.
- `lib/turnover.ts` — `notifyTurnoverRejected` (:463, called at :444): projects-tab MON-11 done-when 3 (see that record).
- `lib/costs.ts`, `lib/companies.ts` — a header paragraph each recording that the module is deliberately silent and why (dw3).
- `lib/notificationKinds.ts` / `lib/inAppNotifications.ts` — `change_order_status`; `20261181` adds it to `notification_kinds()` (written from the browser: paste BEFORE the deploy, or its rows are refused once `20261160` is live — only logged).
- Tests: `lib/__tests__/producers.test.ts` "PROD-6 dw1" (5 — proposing reaches members + owner, never the proposer; rejecting includes the proposer, not the decider; approving keeps the proposer's own `project_status` notice and sends `change_order_status` to the others only; a void is silent; a failed notice never fails the proposal); `lib/__tests__/costDocs.test.ts` "MON-11: an approval notifies the proposer (and not the decider)" unchanged and green (REGRESSION).
- Verified: Loop on `fleet/N8-producers-free` at `3dd10b8`: `npx tsc --noEmit` exit 0; `npx eslint` on the 27 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 435 files, 9480 passed, 7 expected-fail. `next build` is the integrator's.

**Done-when.**
- ✓ Change-order submit / approve / reject emits to the project's members and the cost owner. "Cost owner" is read as the project owner (`projects.owner_user_id`, the money's owner on the project) and, since fix pass 2, also the budget line's control account manager (`cost_accounts.cam_user_id`) when the line names one. Nothing writes that column yet; see the second review fix.
- **Not done:** "punch / checklist assignment emits to the assignee". There is no person-assignee to emit to: a punch item and a turnover item are assigned to a contractor PARTY (`party_id` → `project_parties`, an external company with no account — `lib/turnover.ts` `assignContractor`), and a checklist has no assignee field at all (read 2026-10-07). The plan's default assumed one. Notifying someone else instead would claim more than the code does (DEC-29). Recorded in `DEC-92` item 2 for ratification: either the integrator accepts "silent — no person is assigned" (then this closes by record), or a person-assignee is built — a projects-area schema feature, not a notification.
- ✓ A decision is recorded for each subsystem deliberately left silent — `DEC-92` item 2 (cost control, companies, the equipment registry, checklist status changes and punch close-outs, document shares), and in the header of each such file N8 owns (`lib/costs.ts`, `lib/companies.ts`). `lib/equipmentBridgeServer.ts` is intelligence I-11's file (fleet rule): its record is the DEC entry; `lib/documentShares.ts` is document-control P1 SHARE's.

**Review fix (2026-10-07, notifications Round G, N8 fix pass).** The change-order notices showed a bare number ("for 12,000") while the award notice beside them names its currency. `lib/changeOrders.ts` `coAmountLabel` (:506) formats the amount in its budget line's currency (`cost_accounts.currency`, USD when unset or unreadable — the Costs tab's own default) with `fmtMoney` (`lib/costs.ts`), for `notifyChangeOrder` and for MON-11's `notifyApproval` alike. Test: `lib/__tests__/producers.test.ts` "the amount carries its budget line's currency…" (a CAD line: the proposal, the members' approval notice and the proposer's own approval notice all show `fmtMoney(12000, "CAD")`). Verified: the fix pass's loop (code at `4896093`), recorded in `PROD-2`'s review fix. *(Corrected by fix pass 2 below: `fmtMoney` rounds 10,000 and over to whole units, so the notices now use `coNoticeMoney`.)*

**Second review fix (2026-10-07, notifications Round G, N8 fix pass 2).** Two findings:
- **The exact amount.** `fmtMoney` rounds amounts of 10,000 and over to whole units, which is right for the Costs tab's columns. In a notice it is wrong: the notice says the amount "was approved and posted to the budget line", and the entry posted keeps the exact figure. The notices now use `lib/changeOrders.ts` `coNoticeMoney` (:512): the exact figure in the line's currency, to that currency's minor unit (two decimals for USD and CAD; "—" for a non-number). It is read once per notice with the CAM, below, by `coLine` (:526), which replaces `coAmountLabel`. This covers `notifyChangeOrder` and MON-11's `notifyApproval`. The currency fix stands, and `lib/costs.ts` is not touched.
- **The cost owner.** Done-when 1's "cost owner" was read in the first pass as the project owner, and the record did not say that the schema has a cost-account manager: `cost_accounts.cam_user_id` (`20260819`), the control account manager and the literal owner of the budget line a CO posts to. `notifyChangeOrder` (:467) now adds the line's `cam_user_id`, when set, to the members and the project owner for every event: proposed, approved and rejected. The dispatcher keeps active members only and drops the actor. One read of the line answers both the currency and the CAM. No app code writes `cam_user_id` today, so in practice the project owner is still who hears, until an admin feature or an import sets it. That person is then told without being a project member. *(Fix pass 3: on a private project, only while they can still see it — see below.)*
- Tests (`lib/__tests__/producers.test.ts`):
  - The CAD case now uses 12,345.67. The proposal, the members' approval notice and the proposer's own approval notice show `coNoticeMoney(12345.67, "CAD")` (contains "12,345.67"; not the tab's rounded `fmtMoney` figure; not USD).
  - A new case: a line naming a CAM adds them to the proposal's and the rejection's audience. A CAM who decides is not told of their own act, and a suspended CAM is dropped by the dispatcher.
  - The rejection test now expects `coNoticeMoney(500, "USD")`.
- Verified: see `TAX-11`'s fix-pass-2 block (`03-taxonomy.md`) — one loop for the whole second fix pass.

**Scope / residual.** Stays OPEN on done-when 2 — owner: the integrator (ratify `DEC-92` item 2's reading), else projects-tab (a person-assignee on punch / checklist items, then one emit at the assignment). The turnover rejection now notifies (MON-11).

**Final review fix (2026-10-07, notifications Round G, N8 fix pass 3).** Three findings on the change-order notices:
- **A failed line read was written as dollars.** `coLine` read only `data` from `cost_accounts`. A failed read, or a row the decider's RLS hides (no error, no row), left the currency at USD, so a 12,345.67 CO on a CAD line reached the proposer, every member, the owner and the CAM as US dollars, by bell and email. The CAM was also dropped without a word. `lib/changeOrders.ts` `coLine` (:550) now reads `{ data, error }`. If the line names a currency the notice cannot learn — a failed read, or no row — the amount is written with **no currency at all** (`coNoticeMoney(n, null)` → "12,345.67"), no CAM is told, and the miss is logged. USD stays only where the app itself means USD: a line whose `currency` column is empty (the Costs tab's default), and a CO with no budget line (the Change Orders panel shows it in USD).
- **Stored money took the writer's locale.** `coNoticeMoney` used `Intl.NumberFormat(undefined, …)`. The title and body are stored and read by other people, so a de-DE approver of a 1,500.00 USD CO wrote "1.500,00 $" into every member's bell. The test only held on an `en` runner. `coNoticeMoney` (:529) is now built by hand, like the schedule's `scheduleDateLabel`: digits grouped by ",", "." before the minor unit, and the ISO code in front ("CAD 12,345.67", "USD 1,500.00"). The minor unit comes from ISO 4217 (`CURRENCY_DIGITS`, :512: zero digits for JPY and others, three for BHD and others, otherwise two). A currency that is not a three-letter code makes no currency claim. No locale or ICU data changes it. This covers `notifyChangeOrder` and MON-11's `notifyApproval`.
- **People named by hand ignored private-project visibility (SEC-2).** `notifyChangeOrder` added the line's CAM, and a rejection's proposer, after checking only that each was an active org member. `change_orders`, `cost_accounts` and `turnover_items` are readable only where `project_visible_to_me` holds (`20260913:40`, `20261102`). So on a private project, a proposer since removed from the roster, or a CAM who was never on it, was told the CO's title, its exact amount and the decider's note. `lib/notify/recipients.ts` `projectVisibleAmong` (:134, new, beside `resolveProjectMembers`) applies the database's rule in the app:
  - a project that is not private keeps everyone;
  - a private one keeps its owner, its roster (`project_members`, the dispatcher's `{ projectId }` audience) and the org's controllers (an active Admin or DocCtrl, headline or additive — `resolveRoleRecipients`, never wider than `is_org_controller`);
  - a project that cannot be read keeps nobody named by hand.
  It only ever removes. `notifyChangeOrder` (:483) passes the CAM and a rejection's proposer through it, using the project row it already reads. MON-11's `notifyApproval` (:573) passes the proposer through it too: the approval notice carries the same amount. The members and the owner see the project by definition and are unchanged. The turnover creator is `MON-11`'s (projects-tab); the schedule's assignee is `PROD-11`'s.
- Tests (`lib/__tests__/producers.test.ts`, "PROD-6 dw1"):
  - "money is written the same for every reader…" (new): with `Intl.NumberFormat` forced to de-DE, the notice text is "USD 1,500.00", "USD 500.00", "CAD 12,345.67", "EUR 1,234,567.89", "USD -2,500.00", "JPY 1,500" and "BHD 12.346". A null or non-ISO currency gives the bare "12,345.67".
  - "when the budget line cannot be read…" (new): with the line read failing, the members' approval notice and the proposer's own notice say "12,345.67" with no currency, the CAM is not told, and the miss is logged. A row the decider cannot see gives the same result. REGRESSION: a line with an empty currency, and a CO with no line, still read "USD …".
  - "SEC-2: on a PRIVATE project the people named by hand…" (new): on a private project, a rejection reaches the owner and the roster but not the removed proposer or the off-roster CAM. The approval sends the removed proposer no notice of their own. A CAM on the roster, or a DocCtrl held additively, is kept. A project that cannot be read keeps none of the people named by hand. REGRESSION: the same people on a project that is not private are told as before.
  - The CAD case now expects "CAD 12,345.67". The rejection case's fixture now carries its budget line (currency empty, so USD): it had named a line that did not exist.
  - Each new case, and the changed CAD case, fails without the fix.
  - `lib/__tests__/costDocs.test.ts` "MON-11: an approval notifies the proposer" is unchanged and green (REGRESSION).
- Verified: one loop for the whole of fix pass 3 (`PROD-2`, `PROD-5`, `PROD-6`, `PROD-11`, `PROD-14`, projects-tab `MON-11`), code at `bbe3338`:
  - `npx tsc --noEmit`: exit 0.
  - `npx eslint --max-warnings=0` on the 11 changed code and test files: exit 0.
  - **Before the fix:** with the code changes stashed and the new tests kept, `producers.test.ts` and `producersRoutes.test.ts` failed exactly the 11 new or changed cases (56 passed).
  - **After the fix:** 28 related files pass, 665 tests: the five producer files, the censuses (`notificationKinds`, `notificationWriteRails`, `checkedWrite`, `checkedWrites`), `checkoutRoundF`, `projects`, `lifeSweep2`, `notificationDispatchMembership`, `costDocs`, `turnover`, the schedule suites and the access-request routes. 44 more files that import a changed module pass too: 964 tests, 4 expected-fail.
  - **The full suite:** `npx vitest run` exited **1**, with 424 of 436 files passing (9,491 tests passed, 24 failed, 7 expected-fail). The machine's load average was 30–40 on 4 cores. All 24 failures were in files this pass does not change: 10 were 5-second test timeouts, 13 were timing-dependent DOM cases in `cornerDock`, and 1 was a 1-second performance bound in `drawingText`. Run alone with `--testTimeout=60000`, each of the 12 files passes: `cornerDock` 63/63, `customSkillRunner` 18/18, `dcRoundFOwnerStamp` 16/16, `dcRoundFShareInventory` 18/18, `dependencies` 45/45, `drawingText` 119/119, `j10bLabelsFormattersLinks` 9/9, `notificationDispatchMembership` 24/24, `notificationWriteRails` 79/79, `restoreArchiveRoundTrip` 13/13, `rfqDocx` 9/9, `signInNext` 92/92. A full-suite exit 0 is not shown for this pass.
  - `next build` is the integrator's.
  - No migration changed: `20261181` is untouched.

**Done-when (after fix pass 3).**
- ✓ Change-order submit / approve / reject emits to the project's members and the cost owner: the project owner, and the line's CAM when set. On a private project the CAM is told only while they can see the project. A CAM who cannot see it cannot read the line either (`cost_accounts` is read under `project_visible_to_me`), so telling them would leak it.
- **Not done** (unchanged): punch / checklist assignment emits to the assignee.
- ✓ (unchanged) A decision is recorded for each subsystem deliberately left silent.

**Integrator at the N8 merge (2026-10-07) — ratified under the user's delegation (DEC-92 item 2).** The second limb ("punch / checklist assignment emits to the assignee") is **superseded by the ratified `DEC-92` item 2**, not met: punch and turnover items are assigned to a contractor PARTY (`party_id`, `20261013`) and checklist items have no assignee column, so there is no person to notify; the external party is told through the outcome channel (`MON-10`, DEC-56). Done-when 1 and 3 hold as written (above). RESOLVED on that basis; if a person-assignee is ever added to punch or checklist items, one emit at the assignment is the follow-up (projects-tab).
---

<a id="prod-7"></a>

## PROD-7 · Exported notification API that no caller uses: countUnread, resolveRecipients, and the dispatcher's channels option

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/inAppNotifications.ts:176-185`, `lib/notify/dispatch.ts:65-79`, `lib/notify/dispatch.ts:42-43`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Two of three sub-claims are exactly right and the >50-unread undercount consequence is confirmed. One correction: `resolveRecipients` is not literally callerless — it has one internal caller at lib/notify/dispatch.ts:83 (`const recipients = await resolveRecipients(input)`); what is unused is its documented external 'preview whom-would-this-notify' purpose (dispatch.ts:65-66).

**Mechanism.** countUnread(orgId) is exported and has zero call sites — verified with two shapes: bare `countUnread` across app/lib/components/hooks/scripts/types (1 hit, the definition) and case-insensitive `countunread` across the whole tree excluding node_modules/.next/.git (1 hit, the same definition). Every surface instead calls useTicketNotifications, which does its own listMyNotifications({ onlyUnread: true, limit: 50 }) and reports `count: items.length`. resolveRecipients is exported with the comment "so callers can preview/whom-would-this-notify without sending" — its only caller is emit() eight lines below it. The `channels?: NotifChannel[]` option documented as "Pass a subset to force-limit a noisy event" is passed by no call site (grep for `channels: [` returns nothing), so `input.channels ?? ["inapp","email"]` always takes the default and every notification is dual-channel.

**Failure scenario.** Two consequences. First, because countUnread is unused, the only unread count in the app is derived from a page of 50 (`listMyNotifications({ onlyUnread: true, limit: 50, orgId })` at useTicketNotifications.ts:176) unioned with open tickets — a user with more than 50 unread rows sees a count that silently understates reality and loses the oldest items from the feed entirely. Second, because channels is never used, a high-volume kind such as checkout_message (which fans out to every thread participant, every active session holder and every document subscriber on every chat post — activityThread.ts:126-139) sends an email for each one; there is no way to mark a kind in-app-only.

**Evidence.**

```
lib/inAppNotifications.ts:176-177 —
export async function countUnread(orgId?: string | null): Promise<number> {
  let q = supabase

lib/notify/dispatch.ts:42-43 —
  /** Defaults to all three. Pass a subset to force-limit a noisy event. */
  channels?: NotifChannel[];

hooks/useTicketNotifications.ts:176 —
        let n = await listMyNotifications({ onlyUnread: true, limit: 50, orgId: activeOrgId })
```

> **Verifier correction.** Note for whoever acts on this: impact is dead-code/API-hygiene only — no user-visible defect, no wrong behaviour. It belongs at the bottom of the queue, and the `limit: 50` cap in the path that replaced countUnread (useTicketNotifications.ts:176) is the more interesting consequence of the duplication: the bell badge silently saturates at 50 unread notification rows.

**Done when.**

- [ ] countUnread is either deleted or used as the badge source so the count is not capped at a 50-row page
- [ ] resolveRecipients gains its intended caller (a 'who will this notify' preview) or the comment is corrected
- [ ] Chatty kinds (checkout_message, library_doc_added) pass channels: ['inapp'] so email volume is proportionate; the doc comment says 'all three' but only two channels exist

**Partial / Scope note (2026-10-01, notifications Round G — N2 final review).** No fix for this finding lands here; this corrects done-when 3's premise. `checkout_message` — and, since N2 (`PROD-8`), `checkout_handoff` and `markup_request` for a thread's handoff and markup_ref posts — is written by the checkout thread through `notifyMany` (`lib/activityThread.ts:163-174`), which calls `notify` once per recipient (`lib/inAppNotifications.ts:128-162`); `notify` is the typed insert into `notifications` (`notifyChecked`, `lib/inAppNotifications.ts:92-122`) and nothing more. It is in-app only and never emails — it never reaches the dispatcher or `queueEmail` — and the thread has called `notifyMany` since the file was added (`a4ea830`), so the Failure scenario's "sends an email for each one" never held for `checkout_message`. Done-when 3's chatty-kind arm therefore reduces to `library_doc_added`, which `app/(protected)/documents/[libraryId]/page.tsx:2394-2408` writes through `emit()` with the default channels (`lib/notify/dispatch.ts:95`, in-app and email): notifications N8's `lib/libraryNotify.ts` (`channels: ['inapp']`) and N9's swap of that call site. Done-when 1, 2 and 3's doc-comment arm are untouched (N4).

---

<a id="prod-8"></a>

## PROD-8 · Five NotificationKinds have zero emitters anywhere in the repository — scratchpad leftovers plus checkout_handoff

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/inAppNotifications.ts:33-36`, `lib/inAppNotifications.ts:16`, `hooks/useTicketNotifications.ts:80-87`, `components/notifications/NotificationBell.tsx:26`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. All five kinds confirmed emitter-free. The checkout_handoff half is also confirmed downstream: CheckInPanel.tsx:423-428 routes handoff_release through postHandoff() rather than emitting checkout_handoff, so the Lock icon at NotificationBell.tsx:26 is unreachable.

**Mechanism.** task_reminder has ZERO references outside its own union declaration — searched bare identifier across app/lib/components/hooks/scripts/types (0 hits) and case-insensitively across the whole tree excluding node_modules/.next/.git (0 hits). task_nudge, morning_digest, and task_overdue_digest appear only in the consumer maps (sectionForKind cases and KIND_ICON), never in a producer — these are residue from task #76 'CLEAN-2: Remove scratchpad surface', which deleted the producer but left the vocabulary and the now-unrenderable 'scratchpad' section. checkout_handoff is separately dead because lib/activityThread.ts:158 hardcodes kind: "checkout_message" for ALL six activity kinds — the handoff distinction survives only inside the title string built at lines 145-152.

**Failure scenario.** A drafter uses CheckInPanel's postHandoff (components/documents/CheckInPanel.tsx:424) to leave a formal handoff note for the next person. The recipient's bell shows a generic MessageSquare 'checkout_message' icon reading 'Alice left a handoff on P-101' — indistinguishable in tone, icon, and section-routing from ordinary checkout chat. The Lock icon registered for checkout_handoff at NotificationBell.tsx:26 is never reachable.

**Evidence.**

```
lib/activityThread.ts:145-158 —
    const kindWord =
      input.kind === "question" ? "asked about" :
      input.kind === "proposal" ? "proposed on" :
      input.kind === "handoff" ? "left a handoff on" :
      ...
    await notifyMany({
      orgId: input.orgId,
      userIds,
      actorUserId: actor,
      actorName: input.userName,
      kind: "checkout_message",

lib/inAppNotifications.ts:33-36 —
  | "task_overdue_digest"     // legacy digest — your scratchpad has overdue tasks
  | "morning_digest"          // composed daily digest: overdue + today + aging dateless
  | "task_nudge"              // someone sent you a scratchpad task as a heads-up
  | "task_reminder"           // a precise scratchpad alarm ("remind me at 3pm") just elapsed
```

> **Verifier correction.** HIGH is overstated. This is dead vocabulary with no user-visible failure — nothing is silently dropped, because nothing is ever produced. Impact is type-surface and maintenance debt (plus the unrenderable 'scratchpad' bucket from finding 1), so MEDIUM.

**Done when.**

- [ ] task_reminder, task_nudge, morning_digest, task_overdue_digest removed from the union, from KIND_ICON, and from sectionForKind; the 'scratchpad' member of AttentionSection deleted
- [ ] notifyCheckoutActivity maps input.kind === 'handoff' to kind 'checkout_handoff' (and 'markup_ref' to 'markup_request') rather than collapsing all six to checkout_message

**Resolution (2026-10-01, notifications Round G).** **Reproduced first** on `b9cdfdc`: `task_reminder`, `task_nudge`, `morning_digest`, `task_overdue_digest` have no producer (the comment-stripped search over `app/`, `lib/`, `components/`, `hooks/`, `scripts/`, `types/`, `public/`, `supabase/`), and `lib/activityThread.ts:158` wrote `kind: "checkout_message"` for every post kind, so `checkout_handoff` was never written. `markup_request` had no producer either (PROD-14's, N8).

**Fix (commit `95dbe50`).** The four scratchpad kinds leave the union, `KIND_ICON` and `sectionForKind`; `'scratchpad'` leaves `AttentionSection`. `notifyCheckoutActivity` (`lib/activityThread.ts:158`) maps a `handoff` post to `checkout_handoff` and a `markup_ref` post to `markup_request`; every other post stays `checkout_message`. All three are Documents kinds, FYI, so no badge moves; the channel stays in-app (`notifyMany` has no email leg — so PROD-7's "chatty kinds pass `channels: ['inapp']`" has nothing to change at this site).

- Files: `lib/inAppNotifications.ts`, `lib/notificationKinds.ts`, `hooks/useTicketNotifications.ts`, `components/notifications/NotificationBell.tsx`, `lib/activityThread.ts`.
- Tests: `lib/__tests__/notificationKindThreadProducer.test.ts` (a handoff → `checkout_handoff`; a markup post → `markup_request`; chat / proposal / question / answer → `checkout_message`; a system post notifies nobody; all three badge Documents); `lib/__tests__/notificationKinds.test.ts` "a retired kind has no producer anywhere", "no declared kind without a producer".
- Verified: loop on `fleet/N2-kind-registry` at `95dbe50`: `npx tsc --noEmit` exit 0; `npx eslint` on the 14 changed code and test files `--max-warnings=0` exit 0; `npx vitest run --maxWorkers=2` (full suite) exit 0 — 349 files, 7298 passed, 5 expected-fail. (Two default-worker runs on a machine at load 25 on 4 CPUs each timed out two unrelated fuzz tests at the 5 s default — a different pair each time, each passing alone.) After the review fix (`42d5df8`): `npx tsc --noEmit` exit 0; `npx eslint --max-warnings=0` on the five changed code and test files exit 0; `npx vitest run` (full suite, default workers) exit 0 — 349 files, 7302 passed, 5 expected-fail. `next build` is the integrator's.

**Done-when.**
- ✓ `task_reminder`, `task_nudge`, `morning_digest`, `task_overdue_digest` removed from the union, from `KIND_ICON` and from `sectionForKind`; the `'scratchpad'` member of `AttentionSection` deleted.
- ✓ `notifyCheckoutActivity` maps `handoff` → `checkout_handoff` and `markup_ref` → `markup_request`.

**Scope / residual.** A `markup_ref` post is written when markups are SHARED against a request (`lib/markupRequests.ts:134-148`, LIFE-8), and the thread renders it as "Markup request"; its notification title still reads "… requested markup on …" (`kindWord`, unchanged here — the wording belongs with TAX-3/TAX-4, N3/N9). If N8 (PROD-14) makes the ask itself an action, it must split the share off rather than flag `markup_request` as a whole.

---

<a id="prod-9"></a>

## PROD-9 · Holds never notify the document owner, contradicting the union's own contract comment

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/holds.ts:238-253`, `lib/inAppNotifications.ts:24`, `lib/ownership.ts:79`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified there is no back door putting an owner in the follower set — no ownership code path inserts into `subscriptions`, so resolveFollowers (recipients.ts:23-45) cannot pick the owner up. Ironically setOwner's own body text promises 'You'll receive its notifications and review reminders.'

**Mechanism.** The union documents hold_opened as "a hold was opened on a doc the user owns / is on the project for". The emit at holds.ts:252 uses `audience: { followers: true, roles: ["Admin", "DocCtrl"] }` — neither the effective owner nor project members. grep of lib/holds.ts for 'owner' and 'project' returns zero hits. The resolver exists and is used by five other subsystems: effectiveOwnerForDocument() at lib/ownership.ts:79 is imported by retention.ts:15, reviewControl.ts:19, effectiveDate.ts:12, acknowledgments.ts:19, CheckInPanel.tsx:39 and InspectorPanel.tsx:37. Holds is the one compliance surface that skips it.

**Failure scenario.** A DocCtrl places a STOP-WORK hold on a P&ID whose owner is a process engineer who has not pressed Watch on it (ownership is assigned by lib/ownership.ts:130, watching is a separate opt-in). The hold fires to every Admin/DocCtrl and to subscribers. The document's accountable owner — the person answerable for it in the PSM record — is never told work on their document has been stopped, unless they coincidentally hold one of those roles or subscribed.

**Evidence.**

```
lib/holds.ts:252 —
      audience: { followers: true, roles: ["Admin", "DocCtrl"] },

lib/inAppNotifications.ts:24 —
  | "hold_opened"             // a hold was opened on a doc the user owns / is on the project for

lib/ownership.ts:79 (the unused-here resolver) —
  const { data } = await supabase.from("documents").select("owner_user_id, owner_name, collection_id, library_id").eq("id", documentId).maybeSingle();
```

> **Verifier correction.** Two adjustments. (1) The citation is off: `effectiveOwnerForDocument` is defined at lib/ownership.ts:35; line 79 is the documents SELECT inside `isEffectiveOwnerOfDocument`. The quoted text does appear at 79, but it is not the resolver's signature. (2) Partial mitigation: Admin and DocCtrl — who are the fallback owners per getOrgControllers (ownership.ts:92-95) and who run the hold queue at /admin/holds — do receive it. What is missed is a delegated non-controller owner and the project team. MEDIUM.

**Done when.**

- [ ] holds.ts resolves effectiveOwnerForDocument and adds the owner uid to the hold_opened/hold_released audience
- [ ] If the document is linked to a project, audience.projectId is passed so project members hear it too

---

<a id="prod-10"></a>

## PROD-10 · Storage alerts bypass the NotificationKind union entirely, one of them via a template literal

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/storageAlerts.ts:60-66`, `lib/storageUsage.ts:255-258`, `supabase/migrations/20260621_in_app_notifications.sql:17`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed — both bypass notify()/emit() with raw inserts, and the untyped `kind` column means they insert successfully rather than failing loudly. Downstream they fall through sectionForKind's `default: return 'other'` (useTicketNotifications.ts:100-101) and miss KIND_ICON (NotificationBell.tsx:19-44), so the generic-icon/no-badge rendering described is accurate.

**Mechanism.** Both files insert into the notifications table directly with the service-role client rather than going through notify(), so TypeScript never checks the kind. storageAlerts writes the literal 'storage_alert'; storageUsage writes a computed `storage_${alert.key}` whose value set cannot be enumerated statically. Neither is a member of NotificationKind. The DB does not catch it: the migration declares `kind TEXT NOT NULL` with no CHECK constraint (verified by grepping every CHECK (kind IN ...) in supabase/ — the notifications table has none, unlike site_codebook, checkout_messages, document_intents etc. which all do). The rows therefore land and render — NotificationBell.tsx:166 falls back with `KIND_ICON[item.kind] ?? Bell` — but sectionForKind returns 'other', so they badge nothing (see finding 1), and any future exhaustive switch over NotificationKind will silently miss them.

**Failure scenario.** The workspace crosses its storage quota. lib/storageAlerts.ts:60 writes a storage_alert row to every Admin/DocCtrl. It appears in the bell drawer with a generic Bell icon and no section badge. The 7-day dedupe at storageAlerts.ts:56-59 means if it is missed in the drawer, the next reminder is a week away. Meanwhile a developer adding an exhaustiveness check over NotificationKind would get a clean compile while these rows keep arriving.

**Evidence.**

```
lib/storageUsage.ts:255-257 —
        const { error } = await sb.from("notifications").insert({
          org_id: org.id, user_id: a.uid, kind: `storage_${alert.key}`,
          title: alert.title, body: alert.body, link: "/admin/storage",
        });

supabase/migrations/20260621_in_app_notifications.sql:17 —
  kind TEXT NOT NULL,                          -- ticket_comment | ticket_mention | ticket_status | checkout_conflict | project_member | hold_opened | …
```

> **Verifier correction.** One factual error: 'a computed `storage_${alert.key}` whose value set cannot be enumerated statically' is false. `hot` is declared at lib/storageUsage.ts:216 as a local array and receives exactly two literal pushes — `key: "platform_r2"` at :219 and `key: "platform_db"` at :231. The kind set is therefore statically known and finite: storage_alert, storage_platform_r2, storage_platform_db. That makes the fix trivial (three union members) rather than open-ended.

**Done when.**

- [ ] storage_alert (and each storage_${key} variant) is added to NotificationKind, or the storage alerts are folded into an existing kind
- [ ] Both call sites route through notify()/emit() so the kind is type-checked
- [ ] Optionally: a CHECK constraint or a trigger on notifications.kind so an unknown kind fails loudly instead of rendering as a generic bell

**Resolution (2026-10-01, notifications Round G).** **Reproduced first** on `b9cdfdc`: `lib/storageAlerts.ts:60-65` and `lib/storageUsage.ts:255-258` inserted raw rows with `storage_alert` and `` `storage_${alert.key}` ``; neither kind was in the union. `lib/__tests__/notificationKindStorageProducers.test.ts` fails on the base producers (3 of 6 — the rows lacked `notify()`'s columns and the kinds were undeclared) and passes after.

**Fix (commit `95dbe50`).** The set is finite (`storageUsage.ts`'s `hot[]` has two entries): `storage_alert`, `storage_platform_r2`, `storage_platform_db` join the union and `KIND_META` (bell-only, as `'other'` left them; HardDrive / Database icons, and the bell's `KIND_ICON` gains the three entries). Both watchdogs write through `notifyAsServiceRole` (`lib/storageAlerts.ts:23`) — `notify()`'s typed insert (`notifyChecked`, `lib/inAppNotifications.ts:101`) under the watchdog's service-role client for that call only (`lib/serverClientScope`, the intake door's pattern; the cron runs these steps outside its module-wide swap, so an unbound `notify()` would write as the anonymous client and be refused). `hot[]` carries a typed `kind: NotificationKind`, never a template string. The 7-day dedupe read is unchanged (it reads `kind = <the same kind>`). A refused write is no longer counted as an alert (`notifyChecked` answers whether the row landed; `notify()` keeps its fire-and-forget signature for its other callers).

- Files: `lib/storageAlerts.ts`, `lib/storageUsage.ts`, `lib/inAppNotifications.ts`, `lib/notificationKinds.ts`, `components/notifications/NotificationBell.tsx` (`KIND_ICON` entries only).
- Tests: `lib/__tests__/notificationKindStorageProducers.test.ts` (real `lib/supabase` proxy and `lib/inAppNotifications`, a service-role double: the row carries `notify()`'s full column set and the declared kind; the dedupe read stays; a refused write counts 0; the binding is for the write only — a marker on the double's builders shows which client the shared proxy resolves to: the probe sees both a scoped and a module-wide binding, and once the watchdog returns the proxy resolves to the anonymous client, so a watchdog that left its client bound fails (the earlier form of this case, comparing bound functions, could not fail — corrected in `42d5df8`); R2 and DB ceilings write `storage_platform_r2` / `_db`); the census in `lib/__tests__/notificationKinds.test.ts` (no raw insert left in either file).
- Verified: loop on `fleet/N2-kind-registry` at `95dbe50`: `npx tsc --noEmit` exit 0; `npx eslint` on the 14 changed code and test files `--max-warnings=0` exit 0; `npx vitest run --maxWorkers=2` (full suite) exit 0 — 349 files, 7298 passed, 5 expected-fail. (Two default-worker runs on a machine at load 25 on 4 CPUs each timed out two unrelated fuzz tests at the 5 s default — a different pair each time, each passing alone.) After the review fix (`42d5df8`): `npx tsc --noEmit` exit 0; `npx eslint --max-warnings=0` on the five changed code and test files exit 0; `npx vitest run` (full suite, default workers) exit 0 — 349 files, 7302 passed, 5 expected-fail. `next build` is the integrator's.

**Done-when.**
- ✓ `storage_alert` and each `storage_${key}` variant (`storage_platform_r2`, `storage_platform_db`) are in `NotificationKind`.
- ✓ Both call sites route through `notify()`'s typed insert, so the kind is type-checked.
- Not done here (optional): a database CHECK / trigger on `notifications.kind`. That is N5's `notification_kinds` allowlist (migration A, seeded from `KIND_META`); this package needs no migration.

**Scope / residual.** None in this finding.

---

<a id="prod-11"></a>

## PROD-11 · The entire milestones/schedule subsystem is silent — 20+ mutators, zero notifications

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Pending migration:** `supabase/migrations/20261181_notif_roundG_producers_free.sql` (DEC-30). Done-when 2's `milestone_assigned` and done-when 3's `milestone_slipped` are written from the browser. Once `20261160` is live, their rows are refused (22023) and only logged until `20261181` is applied, so paste it BEFORE the deploy. Whether it is applied cannot be checked from here. Done-when 1's `project_status` notice is an existing kind and lands either way. Recorded 2026-10-07 by N8's final review fix.
- **Verification:** CONFIRMED
- **Locations:** `lib/milestones.ts:155`, `lib/milestones.ts:233`, `lib/milestones.ts:293`, `lib/milestones.ts:346`, `lib/milestones.ts:456`, `lib/milestones.ts:565`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Absence verified for the whole module, not just the cited lines. lib/inbox.ts:154-158 does pull open/overdue milestones into the /inbox cockpit, so a slip is discoverable there as well as on the Schedule tab — but that is a pull surface, not a notification, so the claim stands.

**Mechanism.** lib/milestones.ts contains createMilestone, updateMilestone, applyMilestoneMoves, setMilestoneStatus, setMilestoneProgress, addMilestoneNote, deleteMilestone and importGhostMilestones. grep -c 'notify|queueEmail|emit(|notifications' over the file returns 0. A second-shape check — the producer sweep over every file matching 'milestones' — returned only lib/inbox.ts, components/dashboard/widgets.tsx and lib/projects.ts, all of which are notification READERS or notify about project membership/status, not milestones (lib/projects.ts's only milestone reference is a cascade delete at line 606-607). Assigning a milestone, slipping a date, rebaselining a schedule, or deleting a milestone reaches nobody.

**Failure scenario.** A project manager rebaselines the schedule via applyMilestoneMoves, pushing eight milestones two weeks right. Nobody on the project — not the owner, not project_members, not assignees — receives a bell row or an email. The slip is detectable only by opening the project's Schedule tab, or later via lib/nudges.ts:53-62, which derives an 'N milestones are overdue' string from the already-loaded inbox snapshot on the /inbox page — a passive pull, not a notification.

**Evidence.**

```
lib/nudges.ts:53-62 (the only 'milestone alerting' that exists — a pure derivation, not a producer) —
  const overdue = snap.milestonesOverdue ?? [];
  if (overdue.length > 0) {
    const oldest = overdue[0];
    nudges.push({
      id: "overdue-milestones",
      severity: "high",
      message: `${overdue.length} milestone${overdue.length === 1 ? " is" : "s are"} overdue...`,
```

> **Verifier correction.** Two overstatements. (a) '20+ mutators' is wrong — there are 14 exported mutators (create/update/applyMoves/setStatus/setProgress/addNote/delete/importGhost/importFromParsed/rebase/groupTasks/setTaskDuration/setBaseline/clearBaseline). (b) 'reaches nobody' applies only to push. lib/inbox.ts:156-159 pulls open milestones from -180d through +7d, splits them into `milestonesUpcoming`/`milestonesOverdue` (:241-245, :300-301) scoped to the user's projects, and lib/nudges.ts:53-62 raises a high-severity 'overdue-milestones' nudge from that snapshot. So a slipped date does surface on the Inbox/dashboard next time the user looks; what is absent is an event-time bell row or email. MEDIUM.

**Done when.**

- [ ] setMilestoneStatus and applyMilestoneMoves emit to audience { projectId } (the dispatcher branch that already exists and is unused)
- [ ] Milestone assignment notifies the assignee with a distinct kind
- [ ] A schedule slip past a baseline notifies the project owner

**Resolution (2026-10-07, notifications Round G).** **Reproduced first** on `f8d5eb5`: `lib/milestones.ts` had no producer of any kind (`grep -cE 'notify|emit\(|queueEmail|from\("notifications"\)'` → 0), and `audience.projectId` had no caller anywhere (PROD-4).

**What landed (package N8, `DEC-92` item 3 — the plan's default, applied per operation).**
- `lib/milestones.ts` — `notifyScheduleChange` (:176): `audience: { projectId }` (the dispatcher branch nothing took), kind `project_status`, **in-app only**, the actor dropped; called by `setMilestoneStatus` (:885) and, once per batch, by `applyMilestoneMoves` (`notifyMovedBatch` :758, from the RPC path :751 and the pre-migration row-by-row path :678) and `rebaseSchedule` (:2375).
- `notifyMilestoneAssigned` (:197): `updateMilestone` reads the prior `responsible_user_id` when the patch carries one and, when the stored value changed to a NEW person (not a clear, not the same one), emits `milestone_assigned` (new kind, section `projects`) to that person, bell + email (:525).
- `notifySlippedPastBaseline` (:214) + `slippedPastBaseline` (:169 — later than the baseline finish AND later than before): one `milestone_slipped` (new kind) to the project owner, bell + email, per operation — a drag cascade (:777), a rebase (:2382), a single edit (:529; the batch's row-by-row fallback passes `quietSlip` so it is told once) — naming how many tasks slipped.
- `lib/notificationKinds.ts` / `lib/inAppNotifications.ts` — `milestone_assigned`, `milestone_slipped` (`Flag` / emerald, the feed's milestone predicate; `KindIcon` gains `Flag`); `20261181` adds both to `notification_kinds()`.
- Tests: `lib/__tests__/producers.test.ts` "PROD-11" (8 — the slip rule; `setMilestoneStatus` → `{ projectId }`, in-app, resolved by the real dispatcher to the members minus the actor; a three-task batch → ONE members' notice and ONE owner's slip notice naming the one task past its baseline; a new assignee told, the same one and a clear not; a single edit past baseline told once and a pull-in not; a rebase → one + one; the owner moving their own schedule hears nothing, no owner no notice; a failed notice never fails the change); the schedule's own suites (`milestones`, `scheduleEngineWriters`, `scheduleImportWriters`, `milestoneRpcMigration`) unchanged and green (REGRESSION).
- Verified: Loop on `fleet/N8-producers-free` at `3dd10b8`: `npx tsc --noEmit` exit 0; `npx eslint` on the 27 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 435 files, 9480 passed, 7 expected-fail. `next build` is the integrator's.

**Done-when.**
- ✓ `setMilestoneStatus` and `applyMilestoneMoves` emit to `audience { projectId }` (and `rebaseSchedule`, the failure scenario's "push eight milestones two weeks right").
- ✓ Milestone assignment notifies the assignee with a distinct kind (`milestone_assigned`).
- ✓ A schedule slip past a baseline notifies the project owner (`milestone_slipped`, once per operation).

**Review fix (2026-10-07, notifications Round G, N8 fix pass).** The review found every `milestone_assigned` notice read "Someone made you responsible…": the assignment's only caller (`components/projects/TaskDetailPanel.tsx` `assign`, projects' file) passes `updatedBy` alone. `lib/milestones.ts` `actorLabel` (:202) now resolves the actor for the notice's words — the name the caller passed, else `updatedByEmail`, else the actor's `display_name` or email in this org (`org_members`); "Someone" only when none is known, and a failed read is never thrown. `notifyMilestoneAssigned` (:214) and `notifySlippedPastBaseline` (:243) use it. Test: `lib/__tests__/producers.test.ts` "the assignee learns WHO made them responsible…" (the task panel's uid-only call names the actor by email, then by display name; a passed name wins; an unknown actor is "Someone"). Verified: the fix pass's loop (code at `4896093`), recorded in `PROD-2`'s review fix.

**Second review fix (2026-10-07, notifications Round G, N8 fix pass 2).** Four findings:
- **The assignee was told the wrong finish date (blocker).** `notifyMilestoneAssigned` wrote `new Date(m.plannedAt).toLocaleDateString()` in the ASSIGNER's browser, and the stored text was read by someone else. A planned date is stored as wall-clock-as-UTC (projects-tab SCH-10; the board renders it in UTC), so a Los Angeles assigner of a date-only finish of 2026-10-07T00:00Z told the assignee "10/6/2026". A Tokyo assigner of a 17:00 finish wrote 10/8/2026. Either way the text was in the assigner's locale order (10/7 vs 7/10).
  - The fix is `lib/milestones.ts` `scheduleDateLabel` (:196). It takes the stored instant's schedule-time day (`toWallClock`, `lib/scheduleReflow.ts`, the board's reading) and writes it by hand as "7 Oct 2026", so no zone, locale or ICU version changes it. It returns "" for an instant that does not read.
  - `notifyMilestoneAssigned` (:249) uses it. So do the two reschedule notes that had the same mistake: `updateMilestone`'s (:559) and `applyMilestoneMoves`'s (:765). Those are older projects code, fixed here with the same helper rather than raised as a new projects-tab finding. The assignee and the activity trail now read the day the board shows.
- **A failed pre-read re-announced the same assignee.** The prior-responsible read ignored its error, so a failed read (RLS, network) looked like "nobody". Re-saving the same person then sent `milestone_assigned`, bell and email. Now a read error, or a throw, leaves the prior holder unknown (:516). No notice is sent, the miss is logged, and the edit itself goes ahead.
- **The board waited for the notices.** `applyMilestoneMoves`, `setMilestoneStatus` and `rebaseSchedule` awaited their notices before returning. That added the members, active-member, insert, projects, actor and email round trips to every drag, resize and status flip before the board could apply its new lock stamps and refresh. Every schedule notice now runs behind the write (`inBackground`, :185), and `updateMilestone`'s assignment and slip notices do too. Each notice still logs its own failure; anything that escapes is logged by `inBackground`, never thrown and never left as an unhandled rejection. `lib/milestones.ts` is browser code (no route imports it), so nothing cuts a background notice short except the tab closing.
- Tests (`lib/__tests__/producers.test.ts`):
  - **Board date in every zone.** Under `America/Los_Angeles`, `Asia/Tokyo` and `UTC`, a date-only finish and a 17:00 finish both read "(finish 7 Oct 2026)". The label is pinned for other months and for an unreadable instant. Without the fix the body reads 10/6/2026 in Los Angeles; that was reproduced on Node.
  - **Reschedule notes.** In Los Angeles and in Tokyo, a single edit and a batch move both note "Finish +3 days → 4 Nov 2026" / "→ 7 Nov 2026".
  - **Failed pre-read.** When the pre-read fails, the save stands, nothing is emitted and the miss is logged.
  - **No waiting.** The mutation returns while the notice's `emit` is still held, and the notice lands once released.
  - **Existing schedule cases.** These now flush the background notices before reading them (`flushNotices`, plus an `afterEach` so nothing leaks into the next test).
- Verified: see `TAX-11`'s fix-pass-2 block (`03-taxonomy.md`) — one loop for the whole second fix pass.

**Scope / residual.** The two new kinds are written from the browser: paste `20261181` BEFORE the deploy, or once `20261160` is live their rows are refused and only logged (the members' `project_status` notices land either way). Left silent by `DEC-92` item 3: imports (a reviewed merge, DEC-51), progress logging, notes, grouping, duration (it moves a start, never a finish) and deletion. The milestone owner-vs-assignee audience follows `projects.owner_user_id`; no effective-owner resolver exists for projects.

**Final review fix (2026-10-07, notifications Round G, N8 fix pass 3).** Two findings:
- **A burst of schedule notices queued on the writer's lock, one pooled connection per member.** `notifyScheduleChange` sent `project_status` to every member through `emit()` → `notifyMany`: one single-row insert per member, all at once. 20261160's insert rail counts a row again under `pg_advisory_xact_lock` on the writer when the same kind about the same verified resource already reached that person from that writer in the last minute (`v_same > 0`). So from the second drag, status flip or rebase on a project within a minute, all N inserts of each fan-out queued on one lock, one after another. Each held an API pool connection while it waited: the pool pressure 20261160's third review fix had set out to avoid.
  - `lib/notify/dispatch.ts` `EmitInput.inappOneStatement` (:62, new, optional) makes `emit()` write the in-app rows as ONE statement (`notifyBatchWithReason`, :198) instead of `notifyMany`. One statement holds one connection however the lock is taken.
  - `lib/milestones.ts` `notifyScheduleChange` (:228) passes it. The audience (`{ projectId }`, resolved by the dispatcher), the kind, the in-app-only channel, the words and `inBackground` are unchanged.
  - A row the rail skips (not an active member) does not sink the statement. A cap refusal (P0001: 60 of the same notice to one person in a minute) now refuses the whole statement, and is logged. The members receive the same schedule notices, so they near that cap together. A member who also got other `project_status` rows about the project from this writer in that minute can reach it first, and then nobody gets that notice. Before, only that member missed it.
  - Every other `emit()` caller is unchanged: one request per recipient, as before.
- **A new assignee was told about a private project they cannot see (SEC-2).** `notifyMilestoneAssigned` (:253) now passes the assignee of a project task through `projectVisibleAmong` (`lib/notify/recipients.ts:134`; the rule is described in `PROD-6`'s final-review block). On a private project, someone off the roster who is not the owner and not an Admin or DocCtrl is not told; the assignment itself still saves. A document-only task has no project to hide and is unchanged.
- Tests (`lib/__tests__/producers.test.ts`, "PROD-11"):
  - "the members' schedule notice is ONE insert statement…" (new) runs the real dispatcher over the in-memory PostgREST on a project with seven members besides the actor. Two status notices in a row write exactly two `notifications` inserts, each carrying all seven rows with the actor left out (14 rows). REGRESSION: an `emit()` without the flag still writes seven single-row inserts.
  - "dw1: setMilestoneStatus emits to audience { projectId }…" now also pins `inappOneStatement: true`.
  - "SEC-2: a new responsible person on a PRIVATE project…" (new): an outsider is not told, though the assignment saves. A roster member is told, and so is a DocCtrl off the roster. REGRESSION: on a project that is not private the outsider is told, as before.
  - Each new case fails without the fix. The schedule's own suites (`milestones`, `milestoneRpcMigration`, `scheduleEngineWriters`, `scheduleImportWriters`) are unchanged and green, and so is `notificationDispatchMembership` (the dispatcher).
- Verified: see `PROD-6`'s final-review block — one loop for the whole of fix pass 3.

**Done-when (after fix pass 3).** All three still hold as written:
- ✓ `setMilestoneStatus` and `applyMilestoneMoves` (and `rebaseSchedule`) emit to `audience { projectId }`. The in-app rows are now written as one statement.
- ✓ Milestone assignment notifies the assignee with a distinct kind. On a private project this holds only for an assignee who can see the project. Telling one who cannot would leak a project the database hides from them (SEC-2).
- ✓ A schedule slip past a baseline notifies the project owner (unchanged).

---

<a id="prod-12"></a>

## PROD-12 · Transmittal issue writes no internal notification; manual acknowledgment is silent while the portal path emits ack_complete

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/transmittals.ts:558-590`, `lib/transmittals.ts:593-620`, `app/api/transmittal/route.ts:148-158`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The asymmetry is exactly as described. issueTransmittal (:557-590) calls sendTransmittalEmail, but that is the outbound message to the external recipient, not an internal bell/email row — so 'issue writes no internal notification' holds too.

**Mechanism.** issueTransmittal() calls sendTransmittalEmail() (which uses queueExternalEmail at transmittals.ts:281 — the EXTERNAL recipient) and logAuditAction(). No bell row for anyone internal: no library watcher, no document owner, no project team learns a controlled document left the building. acknowledgeTransmittal() — the in-app manual path — writes only an audit log. The portal path in app/api/transmittal/route.ts:148-158 DOES insert an ack_complete notification plus an email_notifications row for the issuer. The same business event produces a notification through one door and nothing through the other. lib/transmittals.ts's only notification import is queueExternalEmail (line 19); it does not import inAppNotifications or notify/dispatch.

**Failure scenario.** A DocCtrl phones the contractor, confirms receipt, and records it via acknowledgeTransmittal in the app. The transmittal flips to acknowledged and an audit row is written; the issuer (if different from the recorder) gets nothing. The same contractor clicking the portal link instead would have produced a bell row and an email to the issuer. Two paths, two different notification outcomes for one recorded fact.

**Evidence.**

```
lib/transmittals.ts:576-590 —
  if (data) {
    await sendTransmittalEmail(rowToTransmittal(data as Record<string, unknown>), actor);
  }
  await logAuditAction({
    action: "TRANSMITTAL_ISSUED",
    ...
  });
}

app/api/transmittal/route.ts:148-157 (the path that DOES notify) —
  if (t.created_by) {
    await supabaseAdmin.from("notifications").insert({
      org_id: t.org_id, user_id: t.created_by,
      kind: "ack_complete",
      title: `Transmittal ${t.number} acknowledged`,
```

> **Verifier correction.** One mitigating surface worth noting: the issuer is not blind to un-acknowledged transmittals — lib/nudges.ts:66-78 raises a 'transmittals-unacknowledged' nudge off `snap.transmittalsAwaitingAck` for anything older than 7 days. That covers the issue leg partially; it does not cover the manual-ack leg.

**Done when.**

- [ ] acknowledgeTransmittal emits the same ack_complete row the portal route does, so both paths converge
- [ ] issueTransmittal emits an internal notification to the document owner / library followers that a controlled copy was distributed externally

---

<a id="prod-13"></a>

## PROD-13 · doc_superseded is overloaded across eight semantically distinct events — the kind carries no information

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/postPublish.ts:39`, `lib/postPublish.ts:177`, `lib/distributionAcks.ts:138`, `lib/distributionAcks.ts:322`, `lib/staleCopies.ts:198`, `lib/revisionImpact.ts:138`, `lib/workPackages.ts:279`, `app/api/intake/upload/route.ts:351`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, including the rendering consequence: `const actionKinds = new Set(['checkout_conflict','checkout_released','overlap_advisory','branch_open'])` (useTicketNotifications.ts:279) excludes doc_superseded, so a PSM ack obligation renders with the same GitBranch icon (NotificationBell.tsx:35) and no 'Action needed' flag as an informational rev-up notice.

**Mechanism.** Eight call sites emit kind 'doc_superseded' for eight different things: a rev-up announcement (postPublish:39), a second rev-up fan-out (postPublish:177), a NEW distribution-acknowledgment REQUEST (distributionAcks:138 — the recipient must act), an ack REMINDER (distributionAcks:322), a stale-copy RECALL (staleCopies:198), an upstream-impact advisory (revisionImpact:138), a work-package-went-stale alert (workPackages:279), and an intake auto-publish (intake/upload:351). Every one renders with the same GitBranch icon (NotificationBell.tsx:35), the same 'documents' section, and the same non-action-required tone — actionKinds at useTicketNotifications.ts:279 is `new Set(['checkout_conflict','checkout_released','overlap_advisory','branch_open'])`, which excludes doc_superseded. The distinction survives only in the free-text title. This is the mechanical answer to the owner's complaint #4: the vocabulary is unclear because one token means eight things.

**Failure scenario.** A distribution acknowledgment is requested — a PSM record obligation where the recipient must tap 'I have this revision'. It arrives in the bell as kind doc_superseded with a branch icon and no 'Action needed' flag, visually identical to the purely informational 'Doc X advanced to Rev 3' notice sitting next to it. The recipient reads it as FYI and does not act. lib/distributionAcks.ts:229-232 then has to search notifications by `.in("kind", ["ack_requested","ack_overdue","doc_superseded"])` to find its own rows again — the code itself cannot tell them apart.

**Evidence.**

```
lib/distributionAcks.ts:135-146 —
  await emit({
    orgId: input.orgId,
    category: "assignment",
    kind: "doc_superseded",
    title: `Please confirm: ${input.docLabel} Rev ${input.revLabel ?? "?"}`,
    body: `${input.actorName} needs your confirmation that you have the current revision...`,

lib/distributionAcks.ts:229-232 (the read-back that proves the ambiguity) —
      .from("notifications")
      ...
      .in("kind", ["ack_requested", "ack_overdue", "doc_superseded"])

hooks/useTicketNotifications.ts:279 —
    const actionKinds = new Set(['checkout_conflict', 'checkout_released', 'overlap_advisory', 'branch_open']);
```

> **Verifier correction.** Two factual corrections. (1) postPublish.ts:177 is not 'a second rev-up fan-out' — it is a document-RETIREMENT notice to work-package owners ('was ${input.newStatus.toLowerCase()} — it's in your pack', metadata `{ packageId, retirement: true }`), which if anything makes it a ninth distinct meaning. (2) 'the kind carries no information' / 'the distinction survives only in the free-text title' is wrong: five of the eight sites stamp a discriminator in metadata (`ackRequest` at distributionAcks:145 and :331, `recall` at staleCopies:206, `workPackageId` at workPackages:288, `retirement` at postPublish:180, `intake` at intake/upload:357), and distributionAcks.ts:228-240 reads those discriminators back to dedupe nudges. The design smell is real; the informational vacuum is not. MEDIUM.

**Done when.**

- [ ] distributionAcks uses ack_requested / ack_overdue (kinds that already exist) instead of doc_superseded
- [ ] staleCopies uses a distinct recall kind; revisionImpact and workPackages use distinct advisory kinds
- [ ] actionKinds includes every kind that demands a user action, so 'Action needed' is truthful

---

<a id="prod-14"></a>

## PROD-14 · markup_request is fully-wired dead vocabulary — createMarkupRequest never notifies the person being asked

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/markupRequests.ts:46-95`, `components/notifications/NotificationBell.tsx:34`, `hooks/useTicketNotifications.ts:85`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Claim verified including the project-feed conditional. One mitigation the finding omits: lib/inbox.ts:149-152 loads `markup_requests` where `requested_from_user_id = userId AND status = 'open'` into the /inbox cockpit, and the page can answer them (respondToMarkup), so the request is not entirely invisible — but only to someone who opens /inbox unprompted.

**Mechanism.** createMarkupRequest() inserts the markup_requests row, conditionally calls writeActivity() (only `if (input.projectId)`), and calls logAuditAction(). It never calls notify(), notifyMany(), emit(), or inserts into the notifications table. The kind 'markup_request' exists in the union with the comment "someone asked the user for markups", has an icon in KIND_ICON, and has a case in sectionForKind — the whole consumer side is built for a producer that does not exist. Searched three shapes: bare `markup_request` across app/lib/components/hooks (17 hits, all table names, resourceType strings, export/restore table lists, or the two UI maps); quoted `"markup_request"`/`'markup_request'` (only NotificationBell.tsx:34 and the union); and grep of lib/markupRequests.ts for notify|emit|dispatch|notifications (zero).

**Failure scenario.** An engineer opens MarkupRequestModal and asks a specific colleague to mark up a P&ID. The row is written with requested_from_user_id set. The colleague gets no bell row, no email, no badge. If the document has no projectId, not even a project-feed entry is written. The request sits in the markup_requests table until someone opens /inbox, which reads it at lib/inbox.ts:152 — the only surface where it is ever visible.

**Evidence.**

```
lib/markupRequests.ts:46-82 —
export async function createMarkupRequest(input: CreateMarkupRequestInput): Promise<MarkupRequest> {
  if (!input.message.trim()) throw new Error("Message is required");
  const { data, error } = await supabase
    .from("markup_requests")
    .insert({ ... requested_from_user_id: input.requestedFromUserId, ... })
    .select("*").single();
  if (error || !data) throw new Error(error?.message || "Failed to create markup request");

  // Post to project feed if applicable so the request is visible publicly.
  if (input.projectId) {
    await writeActivity({ ... type: "markup_requested", ... });
  }

  await logAuditAction({ action: "MARKUP_REQUESTED", ... });

lib/inAppNotifications.ts:26 —
  | "markup_request"          // someone asked the user for markups
```

> **Verifier correction.** CRITICAL and 'notifies nobody' are both wrong. The recipient IS told, through a pull surface rather than the bell: lib/inbox.ts:151-153 queries `markup_requests ... .eq("requested_from_user_id", userId).eq("status","open")` into `markupRequestsToMe`, which is rendered as a 'Markup requests for you' card at app/(protected)/inbox/page.tsx:266-269 and components/dashboard/widgets.tsx:823-826, headlined in components/cockpit/DailyBrief.tsx:49-50 and CommandDeck.tsx:326, and raised as a nudge at lib/nudges.ts:81-88. What is missing is the bell row and email, not the alert itself.

**Done when.**

- [ ] createMarkupRequest emits kind 'markup_request' to input.requestedFromUserId (via emit with category 'assignment')
- [ ] The notification fires regardless of whether projectId is set
- [ ] Resolving/sharing the markup (updateMarkupRequest at lib/markupRequests.ts:119-148) notifies the original requester

**Resolution (2026-10-07, notifications Round G).** **Reproduced first** on `f8d5eb5`: `lib/markupRequests.ts` had no producer (0 matches); `createMarkupRequest` wrote a project-feed entry only `if (input.projectId)` and `resolveMarkupRequest` (the function done-when 3 calls `updateMarkupRequest`) told nobody — while `/inbox` told the person asked "The requester has been told you declined" (`app/(protected)/inbox/page.tsx`), which nothing backed.

**What landed (package N8, `DEC-92` item 4).**
- `lib/markupRequests.ts` `createMarkupRequest` (:49) — after the row (and the feed entry when there is a project), `emit()` kind `markup_request`, category `assignment` (:95), to `requestedFromUserId`, project or not, linking to `/inbox` where it is answered; metadata `{ markupRequestId, requestStatus }` (never `status` + `action`, which the hook's ticket reconcile would read).
- `resolveMarkupRequest` (:139) — the update now returns the request's two parties; `emit()` kind `markup_request`, category `status` (:188), to `[requested_by, requested_from]` — the dispatcher drops the actor, so a share or decline reaches the requester and a cancel the person asked — linking to the document (`/documents/<library>?doc=<id>`, read from the document; no link without one). The kind stays FYI (DEC-81 §2; PROD-8's note: the thread's markup_ref share keeps the same kind, so the ask is not made an action here).
- Both best-effort: a failed notice never fails the request or its answer. `markup_request` was already declared, so these rows land before or after `20261181`.
- Tests: `lib/__tests__/producers.test.ts` "PROD-14" (3 — a request without a project notifies the person asked with category `assignment`; a dispatch failure never fails the request; a decline notifies the other side with the document link); `lib/__tests__/notificationKinds.test.ts` (the census still sees `markup_request` written).
- Verified: Loop on `fleet/N8-producers-free` at `3dd10b8`: `npx tsc --noEmit` exit 0; `npx eslint` on the 27 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 435 files, 9480 passed, 7 expected-fail. `next build` is the integrator's.

**Done-when.**
- ✓ `createMarkupRequest` emits kind `markup_request` to `input.requestedFromUserId` via `emit` with category `assignment`.
- ✓ The notification fires regardless of whether `projectId` is set.
- ✓ Resolving / sharing the markup (`resolveMarkupRequest`) notifies the original requester (and a cancel, the person asked).

**Scope / residual.** None in this finding. The thread's markup_ref title wording ("… requested markup on …" for a share) stays with TAX-3 / TAX-4 (N3 / N9), as PROD-8 recorded.

**Review fix (2026-10-07, notifications Round G, N8 fix pass).** The review found a share sent the requester TWO `markup_request` rows for one event: the thread's own notice for the `markup_ref` post (`lib/activityThread.ts` `notifyCheckoutActivity`, "… requested markup on …" — wrong for a share) whenever the requester was a participant or subscriber of the document's thread (the usual case), and the resolution notice ("… shared their markups"). Fixed by leaving the requester out of the thread's notice: `PostInput` gains `notifyExclude` (`lib/activityThread.ts:58`, dropped from the recipients at :142 — additive; no other caller passes it), and `resolveMarkupRequest` passes the requester (`lib/markupRequests.ts:173`). The requester gets exactly one row, the resolution notice; the thread's other watchers still get the thread's notice, wording unchanged (TAX-3 / TAX-4's). Tests: `lib/__tests__/producersMarkupShare.test.ts` (new, 2 — the real thread code and the real dispatcher over the in-memory PostgREST: a requester who is both a participant and a subscriber gets ONE row, "holder@acme.test shared their markups", while another watcher still gets the thread's row and the actor none; a decline posts no markup_ref and gives the requester one row; the first test fails without the fix); `lib/__tests__/producers.test.ts` "PROD-14" (the share passes `notifyExclude: [requester]`). Verified: the fix pass's loop (code at `4896093`), recorded in `PROD-2`'s review fix.

**Final review fix (2026-10-07, notifications Round G, N8 fix pass 3).** The final review found the notices had been placed BEFORE the durable writes. `createMarkupRequest` awaited `emit()` (recipients, the active-member read, the bell insert, the email lookup, `email_gate`, the email insert) before `logAuditAction`. `resolveMarkupRequest` awaited a documents read plus `emit()` before `writeActivity` and `logAuditAction`. Before N8 the audit row followed the write directly, and elsewhere in this package the notices run after the durable writes. A slow fan-out delayed the `MARKUP_*` audit row and the project-feed entry, and a tab closed during the email leg lost both: the request row said declined, and the audit trail did not say who answered.
- `lib/markupRequests.ts`: both notice blocks now run last, still best-effort (logged, never thrown).
  - `createMarkupRequest`: the row, then the feed entry when there is a project (:71), then `MARKUP_REQUESTED` (:87), then the notice (:112).
  - `resolveMarkupRequest`: the update, then the share's `markup_ref` post (unchanged), then the feed entry (:182), then `MARKUP_*` (:197), then the documents read and the notice (:224).
  - Who is told, with what words and link, is unchanged.
- Tests: `lib/__tests__/producers.test.ts` "PROD-14" "the notices run AFTER the durable writes…" (new). With a notice that never completes, the request's feed entry and `MARKUP_REQUESTED`, and the decline's feed entry and `MARKUP_DECLINED`, are all written. On the ordinary path, the call order is feed, then audit, then notice. The case fails without the fix. The other PROD-14 cases and `producersMarkupShare.test.ts` are unchanged and green.
- Verified: see `PROD-6`'s final-review block — one loop for the whole of fix pass 3.

---

<a id="prod-15"></a>

## PROD-15 · A DocCtrl told of an access request cannot open the list the notice links to

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** the integrator → admin-and-org P5 (`app/(protected)/admin/users/page.tsx` + `access_requests_admin_select`) — opened 2026-10-07 by notifications Round G N8 PRODUCERS-FREE as the DEC-31 remainder of `PROD-2`; the files are admin-and-org's, and P5 edits `app/api/auth/request-access/route.ts` next (ORG-8). If the integrator instead narrows the notice's audience to Admins (a change to `DEC-92` item 1), the change is `ACCESS_REQUEST_AUDIENCE` in `lib/accessRequestOutcome.ts`.
- **Verification:** CONFIRMED (read on `f8d5eb5` + N8)
- **Locations:** `app/(protected)/admin/users/page.tsx:84,137,374` (`isAdmin = hasAnyRole(['Admin'])` gates the pending read and the card); `supabase/migrations/20261023_access_requests_scope_and_limit.sql` §2 (`access_requests_admin_select`: Admin only); `app/api/admin/access-requests/route.ts:44-57` and `app/api/admin/create-user/route.ts:122-137` (both admit Admin OR DocCtrl); `lib/accessRequestOutcome.ts:32` `ACCESS_REQUEST_AUDIENCE` (imported by `app/api/auth/request-access/route.ts`; N8: the Admin / DocCtrl pool is told).
- **Independently verified:** — opened by N8 from the code above; not yet challenged by a second party.

**Mechanism.** PROD-2's notice (the plan's default, `DEC-92` item 1) reaches every active Admin and DocCtrl and links to Admin → Users. The pending-requests card there, and the RLS that feeds it, admit Admins only — but the two routes that act on a request (decline, and the membership grant that approves it) admit a DocCtrl too. The authority to act and the authority to see disagree; before PROD-2 nobody was told, so it never showed.

**Failure scenario.** A DocCtrl gets "Greg asked to join Acme Refining", clicks it, and lands on Admin → Users with no pending card. They can still add Greg as a member (the notice body carries his name and address) — which approves the request — but they cannot decline it from the UI, and they cannot see the other pending requests.

**Done when.**

- [ ] The people told about a request and the people who can see the pending list are the same set — either the list (card + `access_requests_admin_select`) admits the DocCtrl the routes already admit, or the notice's audience narrows to Admins (a change to `DEC-92` item 1, for the integrator to ratify).
- [ ] A test pins the two sets equal.

---

<a id="prod-16"></a>

## PROD-16 · Two access requests past the per-org cap that land at once can give a pool member two "more are waiting" rows

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** notifications N14 RAW-INSERT TAIL — named by notifications Round G N8 PRODUCERS-FREE (final review fix, 2026-10-07) as the DEC-31 remainder of `PROD-2`; the integrator confirms it in `audit-reports/fleet-plans/notifications.json` (N8 does not edit the plan). N14 already moves service-role writers onto the typed sink, which is where the fix lands.
- **Verification:** CONFIRMED by reading (`fleet/N8-producers-free`); not reproduced against a live database, where it needs two requests in flight at once.
- **Locations:** `app/api/auth/request-access/route.ts:85` `notifyAccessRequestBurst` (the open-row read, then the insert of the rows for members with none).
- **Independently verified:** — opened by N8 from the code above and from N8's final review; not yet challenged by a second party.

**Mechanism.** Past `ACCESS_REQUEST_NOTICES_PER_ORG_HOUR` requests to an org in an hour, `notifyAccessRequestBurst` gives each Admin / DocCtrl in the pool at most one unread `access_request_pending` row keyed on the org (`resource_type 'org'`). It does this in two steps on the service role: it reads which members already hold one (actor NULL, unread), and then inserts one for each member who does not. Nothing serialises the two steps. Two requests in flight together each see no open row, and each inserts one. The app cannot close the window: `notifications` takes no upsert from any app path (`lib/__tests__/notificationWriteRails.test.ts` "no app path deletes or upserts notification rows"), and nothing in the schema makes a second unread burst row for the same member and org impossible.

**Failure scenario.** A script at the public door fires requests in parallel past the cap. Each pool member can get one burst row and one toast per request that lands in the same instant, not one in all. The count is bounded by how many requests overlap, not by the request rate. Every request is still recorded and listed on Admin → Users, and the per-IP limiter still applies.

**Done when.**

- [ ] Two over-cap requests that land at once give a pool member at most one unread burst row for the org. For example, take the check and the insert in one SECURITY DEFINER function under a transaction advisory lock keyed on the org, granted to the service role only (DRLS-16). A partial unique index on its own is not enough: a conflict would fail the whole batch insert, and PostgREST cannot name a partial index in `ON CONFLICT`. So an index also needs such a function. Either way it is a migration in the DEC-30 one-paste shape.
- [ ] A test pins it with a concurrent pair, or a source pin on the serialising statement.

---
