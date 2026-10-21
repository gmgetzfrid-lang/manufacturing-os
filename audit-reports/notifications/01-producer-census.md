# 01 · The producer census

**18 findings** — 2 HIGH · 12 MEDIUM · 4 LOW. `PROD-15` and `PROD-16` opened by notifications Round G N8 PRODUCERS-FREE, 2026-10-07 (DEC-31 remainders of `PROD-2`); `PROD-17` by N9, 2026-10-07; `PROD-18` by the N4 review fix pass, 2026-10-13. *(Counts corrected 2026-10-14 by document-control P26 fix pass 4 from the findings' Severity lines: HIGH `PROD-2`, `3`; MEDIUM `PROD-1`, `4`–`14` (`PROD-1` lowered from HIGH by its verifier); LOW `PROD-15`–`18`. The header had read 16 findings, 3 HIGH · 11 MEDIUM · 2 LOW.)*

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
- **Status:** RESOLVED
- **Assigned:** drafting-flow DF-P9 (done-when 3, `computeTransition` in `lib/ticketTransitions.ts` — the one remainder) — by the integrator, 2026-10-13 (N9 merge, DEC-31; fleet plans `audit-reports/fleet-plans/`); restated at the N15 fix pass 4, 2026-10-14. Done-whens 1 and 4 (as DEC-100 item 2 narrows them) were notifications N15's and are met (the N15 Partial below).
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


**Partial (2026-10-07, notifications Round G).** Package N9 DC-OWNED-PRODUCERS-AND-KIND-SPLIT, branch `fleet/N9-dc-producers-kind-split`. **Reproduced first** on `b154823`: `lib/projects.ts` `notifyProjectAudience` read `project_members` and `listFollowerIds("project", …)` by hand (:1446-1453) and passed the union as `audience: { involved: ids }` (:1467); no caller anywhere passed `audience.projectId`.

**What landed.**
- Done-when 2 — `lib/projects.ts` `notifyProjectAudience` (:1451) passes `audience: { projectId, followers: true }` (:1468): the dispatcher resolves the members (`resolveProjectMembers`) and the watchers (`resolveFollowers` on the project — the store `listFollowerIds` read), minus the actor, active members only — the same set, resolved once. The email is pinned to what it was when everyone was named: `email: { subject: title, bodyText: body ?? title }` (without it a follower would get the category subject — NEDGE-6). The `@/lib/subscriptions` import is gone from the file. `PROD-9`'s hold notice passes `audience.projectId` too (`lib/holds.ts`).
- Tests: `lib/__tests__/projects.test.ts` "PROD-4 dw2 (notifications N9) — a project notice's audience is the dispatcher's, not hand-resolved" (the audience and the pinned email; no `project_members` read and no `listFollowerIds` left in the function).
- Verified (loop on `fleet/N9-dc-producers-kind-split` after the review fix, 2026-10-08): `npx tsc --noEmit` exit 0; `npx eslint` on the changed `.ts` files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 460 files, 10039 passed, 8 expected fail (10047; the eighth is the compliance-digest tripwire). `next build` is the integrator's.

**Done-when.**
- **Not met — narrowed for ratification (`DEC-100` item 2):** "Every document-scoped emit adds followers: true". The producers without it write a notice addressed to the person in their own words, false for a follower: "Your downloaded copy … is out of date" (`lib/staleCopies.ts`, now `doc_recalled`), an acknowledgment request (`lib/distributionAcks.ts`, an obligation a follower does not hold), "Checkout force-released by …" to the holder (`lib/checkoutEpisodes.ts`), "a document pinned in your work package" (`lib/workPackages.ts`, `lib/postPublish.ts`), "a document connected to work you have checked out" (`lib/revisionImpact.ts`). A follower's own notice for the two events a watcher plausibly wants — a force-release on a watched document and its retirement — is opened as `PROD-17`.
- ✓ Project-scoped emits pass `audience.projectId` instead of pre-resolving members by hand.
- **Not met as written — another area's file:** `computeTransition`'s default `newUnreadBy` (`lib/ticketTransitions.ts:159`) still omits `assignedEngineerId`; the verifier's correction above records that the default is overridden per action and the comment / attachment action carries the engineer and the watchers (`:215`). `lib/ticketTransitions.ts` is drafting-flow's; owner drafting-flow.
- **Not met as written:** "a subscriptions row … in resolveRecipients for every document-scoped kind" — by `DEC-100` item 2 the personal kinds do not reach followers; the follow path itself is pinned by `lib/__tests__/notificationDispatchMembership.test.ts` (N5) and, for restores, `lib/__tests__/restoreSubscriptions.test.ts` (`NEDGE-8`).

**Scope / residual.** Stays OPEN on done-whens 1 and 4 until the integrator rules on `DEC-100` item 2 (ratified: both are superseded for the personal kinds and `PROD-17` carries the follower notice), and on done-when 3 (drafting-flow).

**Partial (2026-10-13, notifications Round G).** Package N15 RECIPIENT VISIBILITY AND NAMES, branch `fleet/N15-recipient-visibility` (base `89c9aaa`) — done-whens 1 and 4 as `DEC-100` item 2 (ratified) narrows them.

- Done-when 1, superseded for the personal kinds (`DEC-100` item 2, ratified): every non-personal document-scoped emit already passes `followers: true` (the supersede notice, the hold pair). The follower notice for a force-release and a retirement is `PROD-17`'s, landed here.
- Done-when 4: `lib/__tests__/recipientDiscovery.test.ts` "PROD-4 done-whens 1 and 4" censuses, from the source, every `emit()` in `app/` and `lib/` that passes `followers: true` on a `document` resource, by kind (`doc_superseded`, `hold_opened`, `hold_released`, and `PROD-17`'s `checkout_force_released_fyi` and `doc_retired` — the force-release FYI rode `checkout_message` until fix pass 2). For each kind it asserts that a `subscriptions` row on the document puts the watcher in `resolveRecipients`, with the discover check registered and passing.

**Done-when.**
- ✓ 1, as `DEC-100` item 2 narrows it.
- ✓ 2 (N9).
- Done-when 3 is not met: `lib/ticketTransitions.ts`, drafting-flow DF-P9.
- ✓ 4, as narrowed: every non-personal document-scoped kind.

**Scope / residual.** Stays OPEN on done-when 3 only (owner drafting-flow DF-P9).

**Resolution (2026-10-14, drafting-flow Round G).** DF-P9 TICKET-PAGE — done-when 3, the one remainder. `lib/ticketTransitions.ts` `computeTransition`'s default audience (`newUnreadBy`, :303) is now the requester, the drafter **and the assigned engineer** — the comment route's involved set — de-duplicated (one person can hold two parts) and never the actor. The per-action overrides (an assignment tells the assignee, an engineering-review request tells the picked engineer, `attach_file` adds readers) are unchanged. An engineer assigned for review used to be told once and then dropped from every later transition until they acted.

**Done-when.**
- ✓ 1, as `DEC-100` item 2 narrows it (N15).
- ✓ 2 (N9).
- ✓ 3 `computeTransition`'s `newUnreadBy` includes `ticket.assignedEngineerId` — `lib/__tests__/dfRoundG_P9_ticketPage.test.ts` "notifications PROD-4 done-when 3 — a transition's default audience includes the assigned engineer" (the drafter acting tells the requester and the engineer; the engineer acting is not told of their own act; one person in two parts is told once; REGRESSION: no engineer → the audience it always was). `lib/__tests__/ticketTransitions.test.ts` passes unchanged.
- ✓ 4, as narrowed (N15).

**Scope / residual.** None.

---

<a id="prod-5"></a>

## PROD-5 · CSV document import creates library documents without notifying subscribers, while the staged-upload path does

- **Severity:** MEDIUM
- **Status:** RESOLVED
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


**Resolution (2026-10-07, notifications Round G).** Package N9 DC-OWNED-PRODUCERS-AND-KIND-SPLIT, branch `fleet/N9-dc-producers-kind-split`, commit `2ef1a4f` — done-when 2's page half, the remainder N8 left. **Reproduced first** on `b154823`: `app/(protected)/documents/[libraryId]/page.tsx` `notifyLibrarySubscribers` still called `emit()` itself (:2439, `kind: "library_doc_added"`, default channels in-app + email) while the CSV path called `lib/libraryNotify.ts`.

**What landed.**
- The staged-upload closure (`page.tsx:2453`) calls `notifyLibraryDocsAdded({ orgId, libraryId, count, firstLabel, actorUserId: uid, actorName: userEmail ?? null })` — the same words (the uploader named by their email), in-app only (`PROD-7` done-when 3). `CsvImportModal` gets `actorName={userEmail ?? undefined}` from the page. `lib/libraryNotify.ts` header updated (both insert paths are callers).
- Tests: `lib/__tests__/kindSplitProducers.test.ts` "PROD-5 dw2 — the library page's staged upload tells followers through the one helper" (the call and its arguments, no `emit()` / `library_doc_added` in the closure, the modal's `actorName`, the helper's `channels: ["inapp"]`); `producersCsvImport.test.ts` / `producers.test.ts` "PROD-5" unchanged and green.
- Verified (loop on `fleet/N9-dc-producers-kind-split` after the review fix, 2026-10-08): `npx tsc --noEmit` exit 0; `npx eslint` on the changed `.ts` files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 460 files, 10039 passed, 8 expected fail (10047; the eighth is the compliance-digest tripwire). `next build` is the integrator's.

**Done-when.**
- ✓ `CsvImportModal` emits `library_doc_added` with `audience { followers: true }` after a successful batch (N8).
- ✓ The notify call is one shared helper both insert paths use.

**Scope / residual.** The staged-upload notice no longer emails followers (it did, in-app + email): the PROD-7 done-when 3 rule for a chatty kind, recorded in `DEC-92` item 6. A follower's bell still carries it.

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
- **Status:** RESOLVED
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


**Partial (2026-10-07, notifications Round G).** Package N9 DC-OWNED-PRODUCERS-AND-KIND-SPLIT, branch `fleet/N9-dc-producers-kind-split`, commit `2ef1a4f`. Done-when 3's chatty-kind arm is met: `library_doc_added` — the one chatty kind left by the N2 scope note above — is written by both insert paths through `lib/libraryNotify.ts` `notifyLibraryDocsAdded` with `channels: ["inapp"]` (the library page's staged upload moved onto it, `PROD-5`). Done-whens 1, 2 and 3's doc-comment arm are untouched (N4). Stays OPEN.

**Resolution (2026-10-13, notifications Round G).** Package N4 FEED-PROVIDER-AND-REALTIME, branch `fleet/N4-feed-provider`. **Reproduced** on `6503ea7`: `countUnread` (`lib/inAppNotifications.ts:282`) had no caller; the badge was `items.length` of a 50-row page.

What landed: `countUnread` is the badge's source — the attention feed reads it on every fetch (`hooks/useTicketNotifications.ts`, `fetchAll`) and its count is the true unread total (`TAX-6`, `DELIV-10`, `TRAIL-7`). Done-when 2 and done-when 3's doc-comment arm already hold at `6503ea7` (verified, no code here): `resolveRecipients`'s comment says emit() is its only caller and that no preview exists yet (`lib/notify/dispatch.ts:171-175`, N5 / N6), and `channels` is documented as "Defaults to both channels (in-app and email)" (`lib/notify/dispatch.ts:49-50`). Done-when 3's chatty-kind arm was met by N9 (`library_doc_added` in-app only — the Partial above).
- Tests: `lib/__tests__/attentionProvider.test.ts` (the count follows `countUnread`, not the page).

**Done-when.**
- ✓ `countUnread` is used as the badge source.
- ✓ `resolveRecipients`' comment is corrected (`lib/notify/dispatch.ts:171-175`, at base).
- ✓ The chatty kind is in-app only (N9), and the doc comment says "both channels" (`lib/notify/dispatch.ts:49`, at base).

**Scope / residual.** None.

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
- **Status:** RESOLVED
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


**Resolution (2026-10-07, notifications Round G).** Package N9 DC-OWNED-PRODUCERS-AND-KIND-SPLIT, branch `fleet/N9-dc-producers-kind-split`, commit `d05b368`. **Reproduced first** on `b154823`: `lib/holds.ts` `notifyHoldChange` emitted `audience: { involved: [...input.involved, ...pool], followers: true }` (:504) — the release pool and the follow list; nothing in the file read the document's owner or a project, while the union promises "a hold was opened on a doc the user owns / is on the project for" (`lib/inAppNotifications.ts:29`).

**What landed.**
- `lib/holds.ts` `holdOwnerAndProjects(orgId, documentId, doc)` (:483, new, exported): the document's effective owner through `lib/ownership.ts` `effectiveOwnerForDocument` (document > folder > library > the owning team's supervisor; active members only — OWN-16 / GAP-5), and the document's LIVE projects (`project_documents`, newest `last_seen_at` first, at most 20; a project in `CLOSED_PROJECT_STATUSES` is not working from it). `notifyHoldChange` (:545) reads the owner columns with the label and resolves this beside the release pool: the owner and the members of every live project but the first join `involved`; the first (most recently seen) rides `audience.projectId` — the dispatcher branch nothing took (`PROD-4`). Best-effort: a read that fails leaves that part out (logged), and the notice goes to the audience it always had. Only the notify audience changed in this file (admin-and-org P9 edits `assertHoldCapability`).
- Tests: `lib/__tests__/holds.test.ts` "PROD-9 (notifications N9) — the hold notice also reaches the document's effective owner and its LIVE projects' teams" (owner, `projectId` = the live project seen last, the other live project's member in `involved`, never a closed project's member) and "PROD-9: an unreadable project link leaves the notice to the audience it always had" (logged, never thrown); the hold suite unchanged and green.
- Verified (loop on `fleet/N9-dc-producers-kind-split` after the review fix, 2026-10-08): `npx tsc --noEmit` exit 0; `npx eslint` on the changed `.ts` files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 460 files, 10039 passed, 8 expected fail (10047; the eighth is the compliance-digest tripwire). `next build` is the integrator's.

**Done-when.**
- ✓ holds.ts resolves `effectiveOwnerForDocument` and adds the owner uid to the `hold_opened` / `hold_released` audience.
- ✓ A document linked to a project passes `audience.projectId` (its most recently seen live project; any other live project's members are named).

**Scope / residual.** A document with no owner at any rung falls back to the controllers, who are in the release pool already. The dispatcher drops the actor and inactive members, as for every audience. When `NEDGE-6`'s discover check is wired into the dispatcher it applies to these recipients too.

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
- **Status:** RESOLVED
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


**Resolution (2026-10-07, notifications Round G).** Package N9 DC-OWNED-PRODUCERS-AND-KIND-SPLIT, branch `fleet/N9-dc-producers-kind-split`, commit `d05b368`. **Reproduced first** on `b154823`: the portal route wrote the issuer's `ack_complete` row and a raw `email_notifications` insert (`app/api/transmittal/route.ts:789`, `:802-811`), while the register's receipt route (`app/api/transmittal/receipt/route.ts`, the server half of `acknowledgeTransmittal`) wrote the receipt and its audit row and told nobody (0 notify / emit calls in the file); `issueTransmittal` (`lib/transmittals.ts:1184`) sent the recipient's email and wrote no internal notice.

**What landed.**
- `lib/transmittalReceiptNotice.ts` (new, server-only) `tellIssuerOfReceipt(admin, input)` (:90): the ONE helper both doors call — the portal (`route.ts:791`, `via: "portal"`) and the register (`receipt/route.ts:86`, `via: "manual"`, after the audit row). It writes the same `ack_complete` bell row ("Transmittal <n> acknowledged", the body naming the portal or the recorder) and queues the same receipt email (`receiptEmailText` — the portal's subject and sentence word for word; the register's names who recorded it). Nobody is told of their own act: an issuer who records the receipt themselves gets neither. Best-effort; the route's answer never changes.
- `lib/transmittals.ts` `notifyTransmittalIssued(t, actor)` (:1277): one `transmittal_issued` notice per library the transmittal draws from — "Transmittal <n> issued: <doc or N documents> to <recipient>", the documents' effective owners named, the library's followers on, linking to /transmittals. Started without awaiting from `issueTransmittal` (:1264): a notice never fails or delays an issue. New kind `transmittal_issued` (Documents, FYI, not a compliance kind; `20261191` adds it to `notification_kinds()`).
- Tests: `lib/__tests__/transmittalNoticesN9.test.ts` (12 — both doors' bell row and email, the self-recorded and no-issuer skips, a refused bell row logged while the email still goes, the source pins on both routes; one notice per library with its owners and followers, an unreadable document list sending nothing; the email links absolute — `NEDGE-11`); `lib/__tests__/transmittalReceiptGate.test.ts` (4, real modules — `DELIV-15`); `transmittalPortalRoute.test.ts` and `dcRoundFTransmittals.test.ts` unchanged and green.
- Verified (loop on `fleet/N9-dc-producers-kind-split` after the review fix, 2026-10-08): `npx tsc --noEmit` exit 0; `npx eslint` on the changed `.ts` files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 460 files, 10039 passed, 8 expected fail (10047; the eighth is the compliance-digest tripwire). `next build` is the integrator's.

**Done-when.**
- ✓ A receipt recorded through `acknowledgeTransmittal` (the register's route) writes the same `ack_complete` row the portal does — both paths converge on one helper.
- ✓ `issueTransmittal` notifies the documents' owners and the libraries' followers that a controlled copy was distributed externally.

**Scope / residual.** The issue notice goes to a library's followers and its documents' owners, not to each document's own followers (a transmittal of thirty sheets would otherwise be thirty notices to one person). `transmittal_issued` has no bell icon of its own until N3 derives the bell's map from `KIND_META` (it draws the fallback there; its feed icon is `Send`).

---

<a id="prod-13"></a>

## PROD-13 · doc_superseded is overloaded across eight semantically distinct events — the kind carries no information

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** notifications N4 FEED-PROVIDER-AND-REALTIME (done-when 3) — by the integrator, 2026-10-13 (N9 merge, DEC-31; fleet plans `audit-reports/fleet-plans/`).
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


**Partial (2026-10-07, notifications Round G).** Package N9 DC-OWNED-PRODUCERS-AND-KIND-SPLIT, branch `fleet/N9-dc-producers-kind-split`, commit `d48617c`. **Reproduced first** on `b154823`: `doc_superseded` was written for a published revision (`lib/postPublish.ts:66`), a stale-copy recall (`lib/staleCopies.ts:306`, `:392`), an upstream-change advisory (`lib/revisionImpact.ts:138`), a work-package pin gone stale (`lib/workPackages.ts:684`), a package document retired (`lib/postPublish.ts:279`), and three distribution-ack requests (`lib/distributionAcks.ts:180`, `:195`, `:443`), whose read-back filtered on `["ack_requested", "ack_overdue", "doc_superseded"]` (:347).

**What landed.** One name per meaning (`TAX-13`; names from the plan): `doc_recalled` (`lib/staleCopies.ts:307`, `:394`), `doc_upstream_changed` (`lib/revisionImpact.ts:139`), `package_doc_stale` (`lib/workPackages.ts:685`), `package_doc_retired` (`lib/postPublish.ts:280`); the distribution-ack requests write `ack_requested` (`lib/distributionAcks.ts`, read back as `["ack_requested", "ack_overdue"]`, :355). `doc_superseded` keeps one meaning — a revision was published (the post-publish signal, the intake door's trusted publish, its folded digest). Each split kind keeps `doc_superseded`'s badge (Documents), action flag (FYI) and compliance flag, so no badge, count, digest line or dismiss rule moves. `20261191` adds them to `notification_kinds()` and re-files the rows already written by the discriminators the producers wrote (`recall`, `workPackageId`, `packageId` + `retirement`, `ackRequest`); a census test pins who may still write `doc_superseded`.
- Tests: `lib/__tests__/kindSplitProducers.test.ts`, `lib/__tests__/notificationKinds.test.ts` (N9's nine kinds in the union, sections, flags, the producer census), `lib/__tests__/notifKindSplitMigration.test.ts` (the re-create's lineDiff, the re-files), the write-rails census.
- Verified (loop on `fleet/N9-dc-producers-kind-split` after the review fix, 2026-10-08): `npx tsc --noEmit` exit 0; `npx eslint` on the changed `.ts` files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 460 files, 10039 passed, 8 expected fail (10047; the eighth is the compliance-digest tripwire). `next build` is the integrator's.

**Done-when.**
- ✓ distributionAcks uses `ack_requested` / `ack_overdue` instead of `doc_superseded`.
- ✓ staleCopies uses a distinct recall kind (`doc_recalled`); revisionImpact and workPackages use distinct advisory kinds (`doc_upstream_changed`, `package_doc_stale`; a retired pinned document `package_doc_retired`).
- **Not met — deferred by ratification:** "actionKinds includes every kind that demands a user action". `DEC-90` A11 ratified `DEC-81` §2's deferral: the PSM obligations stay FYI until their rows clear on discharge (notifications N4's per-kind flip). The split kinds follow their parents (FYI).

**Scope / residual.** Stays OPEN for done-when 3, owner notifications N4. Rows written before N9 with no discriminator keep `doc_superseded` (an upstream advisory carried none); `20261191`'s inventory counts them. The daily compliance digest's hand-kept `COMPLIANCE_KINDS` (the cron, N6's file) lacks the four split document kinds and the two intake kinds until N6's derivation lands — a binding merge order with a test tripwire (`TAX-13` Scope, `99-fix-sequencing.md`, `DEC-100` Risk).

**Partial (2026-10-13, notifications Round G — done-when 3).** Package N4 FEED-PROVIDER-AND-REALTIME, branch `fleet/N4-feed-provider`. **Reproduced** on `6503ea7`: the feed's action flag is `KIND_META.actionRequired` (`hooks/useTicketNotifications.ts:353`; the toast's at `components/providers/NotificationListener.tsx:86-88`), and every PSM obligation was `false` (`lib/notificationKinds.ts`, `DEC-81` §2's deferral), so "Action needed" was missing on an acknowledgment request, a sign-off request and a recertification due.

What landed — `DEC-81` §2 as `DEC-90` A11 ratified it ("each PSM kind flips to action-required in the same change that clears its row on discharge"):
- **The flips.** `ack_requested`, `review_requested`, `review_invalidated`, `access_recert_due`, `ack_overdue`, `review_overdue` → `actionRequired: true` in `KIND_META`. The split kinds of N9 inherit their parents' flags as before (`checkout_force_released`, `checkout_auto_released` stay actions; `doc_recalled` and the package / upstream kinds stay FYI — none asks the recipient to do something). `effective_now` stays FYI ("now in effect" — nothing to do).
- **The clearing, in the same change.** The reconcile pass (`lib/notificationReconcile.ts`, `POST /api/notifications/reconcile`, `lib/notificationReconcileServer.ts`) retires each once discharged: `ack_requested` when the recipient owes no acknowledgment on the document (no pending `document_acknowledgments` row, no unacknowledged `distribution_acks` row that still binds — the current version of a document that is not retired); `review_requested` / `review_invalidated` when the recipient owes no sign-off on the document's draft in review (`document_review_signoffs` pending for `documents.pending_version_id`); `access_recert_due` when the library's recertification is no longer due (`recertStatusFor`); `ack_overdue` when nobody owes an acknowledgment on the document; `review_overdue` when the document has no draft in review.
- **Fix pass (review): a kind is not proof of its producer.** Two producers write these kinds for something that is not a roster obligation, and the first draft retired both as soon as the recipient's feed loaded. (1) The check-in panel's "notify owner" outcome (`components/documents/CheckInPanel.tsx:445`, not N4's file) writes `review_requested` — "Change proposed to <doc> … review and release it" — to the owner or the controllers, with no sign-off roster behind it. The sign-off check now applies only to a row a roster provably wrote: one of the recipient's `document_review_signoffs` rows on the document was assigned, notified or updated within `REVIEW_ROSTER_WINDOW_MS` (10 minutes) of the row's `created_at` (`openReviewRoster`, the reminder scan and `invalidateDraftSignoffs` each stamp the roster row in the call that writes the notice); any other `review_requested` row is kept, as before N4 — including for an owner who signed an earlier draft. And no review row younger than `REVIEW_RECONCILE_GRACE_MS` (2 minutes) is retired: `invalidateDraftSignoffs` sends the voided-approval notice before the new draft's roster is written. (2) The maintenance cron's daily review-health nudge (`lib/intakeRateLimit.ts` `nudgeReviewHealth`) writes `review_overdue` on an example document whose draft is orphaned — "no draft in review" is the condition it reports. `reconcileClassOf` now leaves any `review_overdue` carrying `metadata.reviewHealth` / `reviewHealthDay` alone; it stays until read. (3) The rows below the loaded window, which count in the badges and the action count, are now sent for reconcile too (after the window's, within the 200-id cap), so a discharged obligation below the window no longer keeps a badge red.
- **Second review fix — the roster evidence ties the notice to the roster's actor, and the A11 rule is applied per row.** (1) The time-only evidence above was a guess that could retire an unrelated notice: the reminder scan moves `notified_at` and every sign-off moves `updated_at`, so a check-in notice written within 10 minutes of either counted as "from the roster" and was retired when the owner signed — failing open, against `DEC-90`'s fail-safe rule. `lib/notificationReconcileServer.ts` `rosterWrote` now requires the notice's `actor_user_id` to be the roster's opener (`assigned_by`) at its `assigned_at` (`openReviewRoster`), or no actor at the recipient row's `assigned_at` / `notified_at` (the reminder scan), or — for `review_invalidated` only — no actor at the `updated_at` of the row `invalidateDraftSignoffs` turned `invalidated`; `updated_at` on a live row is never evidence. The check-in panel's notice carries the person checking in as its actor, so it never matches. (2) `lib/notificationReconcile.ts` `isActionRow(row)` is now the one action rule: the kind's flag, except the cron's review-health nudge (`review_overdue` with `metadata.reviewHealth` / `reviewHealthDay`), which nothing clears and so reads as FYI — in the feed's items, its counts and badges (`hooks/useTicketNotifications.ts`, the loaded window and the tally below it) and the toast (`components/providers/NotificationListener.tsx`). (3) Action toasts have their own burst cap: at most two sticky amber cards per 6-second window, the rest one sticky "N more actions need you" card (`ACTION_SHOWN_MAX`, `actionSummary`) — a scan's twenty "Still unconfirmed" rows are three cards, not twenty with no timer.
- **Third review fix — every reminder clears, and conflicts keep their own card.** (1) Only the LATEST reminder could be tied to its roster: the reminder scan writes a `review_requested` and then moves the recipient row's `notified_at` forward once per cooldown (`lib/reviewControl.ts` `scanReviews`), so a day-5 reminder lay near neither `assigned_at` (day 0) nor the current `notified_at` (day 10), was never proven a roster notice, and — an action since N4 — stayed a red Action row after the reviewer signed. `rosterWrote` now also accepts an actor-less `review_requested` written at or after the recipient row's `assigned_at` minus `REVIEW_ROSTER_WINDOW_MS` (the roster existed when the notice was written): the check-in panel's notice always carries the person checking in as its actor (`components/documents/CheckInPanel.tsx`, `actorUserId: currentUser.uid`), so an actor-less `review_requested` is never that notice. The actor-bearing rule and the `review_invalidated` rule are unchanged. (2) The action-toast cap no longer folds the conflict class behind PSM rows: `components/providers/NotificationListener.tsx` `isConflictAction` (an action kind that is not a PSM obligation — `KIND_META.compliance` false: `checkout_conflict`, the checkout releases, `overlap_advisory`, `branch_open`) always gets its own sticky card, outside `ACTION_SHOWN_MAX`, as before N4. Tests: `lib/__tests__/notificationReconcile.test.ts` "reminders on day 5 and day 10 are BOTH retired once the reviewer signs on day 11; a check-in notice on the same document stays" (fails on the second-pass rule), "while the sign-off is still owed, every reminder is kept", `rosterWrote`'s new cases; `lib/__tests__/notificationListener.test.ts` "2 ack_requested + 1 checkout_conflict in one window — the conflict gets its OWN card".
- **Fourth review fix — an actor-less sign-off notice is the roster's only when it is the known writer's (integrator fix pass, 2026-10-13).** The third pass took ANY actor-less `review_requested` written after one of the recipient's roster rows on that document, with no upper bound — and `reconcileClassOf` still classed a legacy intake notice (`review_requested`, actor-less, `metadata.intake`, until `20261191` re-files it) as a sign-off, so on a database where `20261191` is not yet pasted a DocCtrl who once sat on that document's roster could have the contractor submission's only bell row retired as "discharged". Now (1) `lib/notificationReconcile.ts` `reconcileClassOf` (`:106`) returns null for a `review_requested` / `review_invalidated` carrying `metadata.intake`; (2) `lib/notificationReconcileServer.ts` `rosterWrote` (`:138`) ties an actor-less row to a roster only under the title of the one server writer that sends that kind with no actor (`REVIEW_NOTICE_TITLES`, `lib/notificationReconcile.ts:171`): the reminder scan's "Reminder — review …" (at its `notified_at`, or any time since the row was opened), `openReviewRoster`'s "Review requested: …" (a row opened by nobody, at its `assigned_at`), `invalidateDraftSignoffs`' "Re-review needed: …" (the row turned `invalidated`, at its `updated_at`); any other actor-less row is not the roster's and stays until read. (3) An actor-bearing notice must carry `openReviewRoster`'s title too, which closes the one shape the record left failing open — a check-in notice by the roster's own opener within 10 minutes of opening it. The titles are pinned against `lib/reviewControl.ts` and `components/documents/CheckInPanel.tsx`. Tests: `lib/__tests__/notificationReconcile.test.ts` "rosterWrote — an actor-less row is the roster's only when it is the KNOWN server writer's for its kind…", "the actor-less titles are the producer's…", "a legacy intake notice … is KEPT" (fails on the third-pass code).
- **One classification.** The feed, the badges, the toast and the Center all read `KIND_META.actionRequired` through `isActionRow` — no hand list exists (`lib/__tests__/notificationKinds.test.ts` pins the set and that each flipped kind has a discharge check).
- Tests: `lib/__tests__/notificationKinds.test.ts` (`PSM_FLIPPED_BY_N4`; "N4: each PSM obligation flipped to action-required has a discharge check that clears its row"; the toast tone and the counts follow); `lib/__tests__/notificationReconcile.test.ts` (the discharge cases for all six; fix pass: the check-in panel's payload kept, with and without an owner's earlier sign-off; the review-health nudge's payload kept and unclassified; the grace period across an invalidation and its new roster; second fix pass: "a check-in notice written minutes after the reminder scan stamped the owner's roster row is KEPT once the owner signs", `rosterWrote`'s cases, `isActionRow`); `lib/__tests__/notificationListener.test.ts` ("20 action rows in one window … at most ACTION_SHOWN_MAX sticky cards and ONE sticky 'N more actions need you' card"; the review-health nudge is an info toast); `lib/__tests__/attentionProvider.test.ts` ("the action rows BELOW the window are sent for reconcile too"); `lib/__tests__/notificationCenterScope.test.ts` and `lib/__tests__/notificationListener.test.ts` (FYI examples moved off `ack_requested`).
- Verified: loop on `fleet/N4-feed-provider`: `npx tsc --noEmit` exit 0; `npx eslint` on the 24 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 1 — 514 files, 11,352 passed, 10 expected fail, 4 failed, every one "Test timed out in 5000ms" in a file this package does not touch (`dcRoundFOwnerStamp`, `dcRoundFShareInventory`, `exportContractRoundTrip`, `notificationDispatchMembership`; load average 18–29 on the shared box), each exit 0 when rerun alone. `next build` is the integrator's.

**Done-when.**
- ✓ (N9) distributionAcks uses `ack_requested` / `ack_overdue`.
- ✓ (N9) staleCopies, revisionImpact and workPackages use their own kinds.
- **Partial** — "actionKinds includes every kind that demands a user action". Met for the limb `DEC-81` §2 names: the conflict class, N9's split kinds that inherit it, and the six PSM obligations above, each clearing once discharged — for `review_requested` every reminder the scan wrote, not only the latest (third review fix; the second pass's rule left all but the latest reminder an uncleared action row) — all derived from `KIND_META.actionRequired` (no hand list). **Not met as written:** kinds whose own text asks the recipient to act stay FYI because nothing clears their row on discharge yet, and `DEC-90` A11 forbids an action flag that cannot clear — `markup_request`, `deletion_requested`, `access_request_pending`, `intake_submission`, `request_pending_approval`, `owner_behind`, `ack_unsatisfiable`, `review_alternate_activated`, `milestone_assigned`. Opened as `PROD-18` (below), one discharge check per kind, owner: notifications N12 NUDGES (assigned by the integrator, 2026-10-13). (The first draft of this block checked done-when 3 outright; the review narrowed it.) Of the rows that are action-required by kind, two producers' rows cannot clear: the cron's review-health nudge — since the second review fix FYI per row (`isActionRow`), so A11 holds for it — and the check-in panel's "Change proposed to …" `review_requested`, which no row-level field on the client distinguishes from a sign-off request, so it stays an action until read: the one named `DEC-90` A11 exception, owner drafting-flow (give it its own kind; `PROD-18` lists it).
- Verified (review fix pass): loop on `fleet/N4-feed-provider`: `npx tsc --noEmit` exit 0; `npx eslint` on the 24 changed code and test files of the branch `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 1 — 514 files, 11,342 passed, 10 expected fail, 21 failed in 9 files this package does not touch (8 "Test timed out in 5000ms" — `customSkillRunner`, `dcRoundFOwnerStamp`, `dcRoundFShareInventory`, `dependencies`, `exportContractRoundTrip`, `notificationDispatchMembership`, `restoreArchiveRoundTrip`, `searchPathPin` — and 13 in `cornerDock` reading a DOM node that had not rendered; load average 23–28 on the shared box); each of the nine exits 0 when rerun alone. `next build` is the integrator's.

- Verified (third review fix pass): `npx tsc --noEmit` exit 0; `npx eslint` on the 7 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 1 — 514 files, 11,376 passed, 10 expected fail, 2 failed, both "Test timed out in 5000ms" in files this package does not touch (`dcRoundFOwnerStamp`, `dcRoundFShareInventory`; load average 19–25 on the shared box), each exit 0 when rerun alone with `--testTimeout=60000` (16 and 18 passed). `next build` is the integrator's.

- Verified (second review fix pass): `npx tsc --noEmit` exit 0; `npx eslint` on the 10 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 1 — 514 files, 11,353 passed, 10 expected fail, 19 failed in 6 files this package does not touch (6 "Test timed out in 5000ms" — `askRouteHonesty`, `dataExportRoutes` ×2, `dcRoundFShareInventory`, `dependencies`, `j14ExecutionDragMemo` — and 13 in `cornerDock` reading a DOM node that had not rendered; load average 15–25 on the shared box); each of the six exits 0 when rerun alone. `next build` is the integrator's.

**Scope / residual.** Stays OPEN for `PROD-18`. A discharged obligation clears on the recipient's next feed pass (load, tab return, every visible minute), not instantly. The check-in panel's proposed-change notice still uses the PSM kind `review_requested`, so it turns red as an action and stays until read; giving it its own FYI or action kind is drafting-flow's (the file's holder) — a DEC-31 remainder, recorded in `99-fix-sequencing.md`. What stays until read rather than clearing (the fail-safe side): an actor-bearing sign-off request (`openReviewRoster`'s) whose roster row's `assigned_at` is more than 10 minutes from it (a badly skewed browser clock; a re-opened roster whose upsert left the old row unstamped); an actor-less reminder written more than 10 minutes BEFORE the recipient row's `assigned_at` (only a browser clock skewed by more than that, or a roster row re-created after the reminder); a `review_invalidated` more than 10 minutes from its row's stamps. Ordinary repeat reminders are not in this set since the third review fix: every one written after the roster row was opened clears once the sign-off lands. One shape still matches by actor and time: a check-in notice written by the very person who opened the owner's roster, within 10 minutes of opening it — retired once the owner signs that draft; a metadata marker on the roster notices (`lib/reviewControl.ts`, not N4's file) would remove the inference, handed to that file's holder in `99-fix-sequencing.md`.

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
- **Status:** RESOLVED
- **Assigned:** the integrator → admin-and-org P5 (`app/(protected)/admin/users/page.tsx` + `access_requests_admin_select`) — opened 2026-10-07 by notifications Round G N8 PRODUCERS-FREE as the DEC-31 remainder of `PROD-2`; the files are admin-and-org's, and P5 edits `app/api/auth/request-access/route.ts` next (ORG-8). If the integrator instead narrows the notice's audience to Admins (a change to `DEC-92` item 1), the change is `ACCESS_REQUEST_AUDIENCE` in `lib/accessRequestOutcome.ts`.
- **Verification:** CONFIRMED (read on `f8d5eb5` + N8)
- **Locations:** `app/(protected)/admin/users/page.tsx:84,137,374` (`isAdmin = hasAnyRole(['Admin'])` gates the pending read and the card); `supabase/migrations/20261023_access_requests_scope_and_limit.sql` §2 (`access_requests_admin_select`: Admin only); `app/api/admin/access-requests/route.ts:44-57` and `app/api/admin/create-user/route.ts:122-137` (both admit Admin OR DocCtrl); `lib/accessRequestOutcome.ts:32` `ACCESS_REQUEST_AUDIENCE` (imported by `app/api/auth/request-access/route.ts`; N8: the Admin / DocCtrl pool is told).
- **Independently verified:** — opened by N8 from the code above; not yet challenged by a second party.

**Mechanism.** PROD-2's notice (the plan's default, `DEC-92` item 1) reaches every active Admin and DocCtrl and links to Admin → Users. The pending-requests card there, and the RLS that feeds it, admit Admins only — but the two routes that act on a request (decline, and the membership grant that approves it) admit a DocCtrl too. The authority to act and the authority to see disagree; before PROD-2 nobody was told, so it never showed.

**Failure scenario.** A DocCtrl gets "Greg asked to join Acme Refining", clicks it, and lands on Admin → Users with no pending card. They can still add Greg as a member (the notice body carries his name and address) — which approves the request — but they cannot decline it from the UI, and they cannot see the other pending requests.

**Done when.**

- [ ] The people told about a request and the people who can see the pending list are the same set — either the list (card + `access_requests_admin_select`) admits the DocCtrl the routes already admit, or the notice's audience narrows to Admins (a change to `DEC-92` item 1, for the integrator to ratify).
- [ ] A test pins the two sets equal.


**Resolution (2026-10-20, admin-and-org Round G).** Package P5, under the integrator's DEC-90 ruling (6): membership is the Admin's to grant, so the notice narrows to the Admins — the people the pending list already admits. Notice and list are now one set.

**Reproduced on `7f92269`.** `lib/accessRequestOutcome.ts:33` `ACCESS_REQUEST_AUDIENCE = ["Admin", "DocCtrl"]` (the request door's bell, email and burst notice all resolve it); the pending card and its read gate on `isAdmin = hasAnyRole(['Admin'])` (`app/(protected)/admin/users/page.tsx:96`, `:153`, `:448`); `access_requests_admin_select` (`20261023` §2, its newest definition) admits `m.role = 'Admin' OR m.roles && ARRAY['Admin']`.

**What landed.** `ACCESS_REQUEST_AUDIENCE = ["Admin"]` (`lib/accessRequestOutcome.ts:38`, with the reason), so the door's bell row, email and "more are waiting" burst notice reach every ACTIVE Admin (headline or additive) and no DocCtrl-only member. The list is unchanged (the page and the policy were already Admin-only). `clearAccessRequestNotices` still marks every recipient's row read once a request is decided, so a DocCtrl's notice from before this change clears with the decision. The decide routes are unchanged: `/api/admin/create-user` and `/api/admin/access-requests` still admit a DocCtrl (no regression; who may grant a membership is outside this finding).

**Tests.** `lib/__tests__/producersRoutes.test.ts`: the audience is `["Admin"]`; the bell's recipients are the two ACTIVE Admins (one additive, `mgr-adm`) and neither the DocCtrl nor the Manager-plus-DocCtrl; the email, burst-claim and burst-row expectations follow. `lib/__tests__/aoRoundGP5PublicDoors.test.ts` "PROD-15 — …" pins the two sets equal: the audience against the page's `isAdmin` gate and against `access_requests_admin_select`'s Admin clause in 20261023.

**Done-when.**
- [x] The people told about a request and the people who can see the pending list are the same set ✓ — the Admins (the notice's audience narrowed: a change to DEC-92 item 1, ratified under DEC-90 by the integrator's ruling for this package; DEC-92 carries the Landed line).
- [x] A test pins the two sets equal ✓.

**Scope / residual.** A DocCtrl can still add a member and decline a request by id through the routes (unchanged); they are no longer told about requests, as the list never showed them. If the product later wants DocCtrl to triage requests, both the list (card + policy) and `ACCESS_REQUEST_AUDIENCE` move together, and the pin above fails until they do.

---

<a id="prod-16"></a>

## PROD-16 · Two access requests past the per-org cap that land at once can give a pool member two "more are waiting" rows

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** notifications N14 RAW-INSERT TAIL — named by notifications Round G N8 PRODUCERS-FREE (final review fix, 2026-10-07) as the DEC-31 remainder of `PROD-2`; the integrator confirms it in `audit-reports/fleet-plans/notifications.json` (N8 does not edit the plan). N14 already moves service-role writers onto the typed sink, which is where the fix lands.
- **Verification:** CONFIRMED by reading (`fleet/N8-producers-free`); not reproduced against a live database, where it needs two requests in flight at once.
- **Locations:** `app/api/auth/request-access/route.ts:85` `notifyAccessRequestBurst` (the open-row read, then the insert of the rows for members with none).
- **Independently verified:** — opened by N8 from the code above and from N8's final review; not yet challenged by a second party.

**Mechanism.** Past `ACCESS_REQUEST_NOTICES_PER_ORG_HOUR` requests to an org in an hour, `notifyAccessRequestBurst` gives each Admin / DocCtrl in the pool at most one unread `access_request_pending` row keyed on the org (`resource_type 'org'`). It does this in two steps on the service role: it reads which members already hold one (actor NULL, unread), and then inserts one for each member who does not. Nothing serialises the two steps. Two requests in flight together each see no open row, and each inserts one. The app cannot close the window: `notifications` takes no upsert from any app path (`lib/__tests__/notificationWriteRails.test.ts` "no app path deletes or upserts notification rows"), and nothing in the schema makes a second unread burst row for the same member and org impossible.

**Failure scenario.** A script at the public door fires requests in parallel past the cap. Each pool member can get one burst row and one toast per request that lands in the same instant, not one in all. The count is bounded by how many requests overlap, not by the request rate. Every request is still recorded and listed on Admin → Users, and the per-IP limiter still applies.

**Done when.**

- [ ] Two over-cap requests that land at once give a pool member at most one unread burst row for the org. For example, take the check and the insert in one SECURITY DEFINER function under a transaction advisory lock keyed on the org, granted to the service role only (DRLS-16). A partial unique index on its own is not enough: a conflict would fail the whole batch insert, and PostgREST cannot name a partial index in `ON CONFLICT`. So an index also needs such a function. Either way it is a migration in the DEC-30 one-paste shape.
- [ ] A test pins it with a concurrent pair, or a source pin on the serialising statement.

**Resolution (2026-10-13, notifications Round G).** Package N14 RAW-INSERT TAIL (commit `fed6288`).

**Reproduced first** on a throwaway PostgreSQL 16, with the schema stubbed: `notifications` as in `20260621` / `20260723`; `org_members` holding 2 active pool members and 1 suspended. Two sessions ran today's two steps at once (read the open rows, wait 1 s, insert for the members without one). Each pool member got **2** burst rows.

**What landed.**
- `supabase/migrations/20261197_notif_roundG_burst_claim_digest_rail.sql` adds `claim_access_request_burst(p_org uuid, p_recipients uuid[], p_title text, p_body text)`.
  - It is SECURITY DEFINER with `SET search_path = public`. EXECUTE is revoked from PUBLIC, anon and authenticated and granted to service_role only (DRLS-16). It never reads `auth.uid()`.
  - It first takes `pg_advisory_xact_lock(hashtextextended('access-request-burst:' || p_org::text, 0))`. Then it counts the recipients who already hold an unread server burst row, and inserts one for each ACTIVE member of the org who holds none.
  - It answers `{told, already}`.
  - The row is the one the route writes: kind `access_request_pending`; the route's title and body; link `/admin/users`; resource `('org', the org id)`; no actor; metadata `{"accessRequestBurst": true}`.
  - The lock is held until the RPC's transaction commits. Each later statement in a READ COMMITTED plpgsql function takes a new snapshot, so the next claim for the org sees the last claim's rows.
- `app/api/auth/request-access/route.ts` `notifyAccessRequestBurst` (:85) calls the claim (:97) with the notice's words.
  - Before the paste (`42883` / `PGRST202`, matched by `lib/intakeRateLimit.ts` `isMissingFunction`), today's two steps run unchanged. The log line says they are unserialised.
  - Any other error writes nothing and logs, as an unreadable open-row read does.
  - The response never changes.
- **REGRESSION.** Who is told is unchanged: the same pool, ACTIVE members only, no row for a member who already holds an unread one, and a member who has read theirs is told again by the next request. The words, link and resource are unchanged, and the under-cap path is untouched. The census still forbids an upsert on `notifications`. The function is a plain INSERT, and the service role passes the 20261160 rail untouched.

**Exercised on PostgreSQL 16** (throwaway cluster under `/var/lib/postgresql`, deleted afterwards).
- The paste ran twice. Every probe read `true` both times, and the inventory came back as counts only.
- Two claims in flight together: A answered `{"told": 2, "already": 0}`. B waited for A's commit and answered `{"told": 0, "already": 2}`. Each member held one row.
- 50 concurrent claims wrote 2 rows for the 2 active members. The suspended member got none.
- After one member read theirs, the next claim answered `{"told": 1, "already": 1}`.
- `authenticated` and `anon` were refused ("permission denied for function claim_access_request_burst").

**Integrator fix pass (2026-10-13, the re-review's minors 1 and 2) — the paste's probes say only what they check.** `20261197` is not pasted yet; it was edited in place, keeping the DEC-30 one-paste shape (counts-only inventory in a TEMP table before the one `BEGIN … COMMIT`, ONE final SELECT), the lineDiff test against the newest `email_notif_insert` and DRLS-16. The function and the policy are unchanged; only the final SELECT changed.
- Probe 4 said `email_notifications` keeps "exactly" its three policies but only checked that the three names exist, so a fourth permissive INSERT or ALL policy — OR'd with `email_notif_insert` — passed it while re-admitting a member's `compliance_digest` row. It now checks the exact set: every policy on the table counted (`COUNT(*) = 3`) AND those three names among them. Its label says what a `false` means.
- Probe 5 ("no row was changed") compared a live count read before `BEGIN` with one read after `COMMIT`; a burst written, or one marked read, in between made a correct paste read `false`. It is no longer a check: the same count is an `AFTER:` information row (ok NULL) to read beside inventory row 1, labelled as moving under live traffic. That the file writes no row stays pinned by its shape (no INSERT / UPDATE / DELETE outside the function body).
- Expected result now: **`ok = true` × 4**, then the `AFTER:` count, then the 4 inventory counts.
- Pinned in `lib/__tests__/notifRoundGBurstDigestMigration.test.ts` (12 cases; the two changed ones failed on `4dea72e` first).
- **Exercised on PostgreSQL 16.13** (throwaway cluster under `/var/lib/postgresql`, stub schema with `20261047` §4's three policies verbatim; deleted afterwards):
  - A — clean paste: `ok = true` × 4, AFTER 1, inventory 1 / 0 / 0 / 0. Re-run: the same.
  - A — after the paste, a signed-in member's `compliance_digest` row for a colleague was refused ("new row violates row-level security policy"); their `ack_requested` row was admitted.
  - B — a stray `FOR ALL TO authenticated USING (true) WITH CHECK (true)` policy added: the new probe 4 read `false`; the old probe 4's text read `true` on the same database; and that database admitted the forged `compliance_digest` row.
  - C — `email_notif_update_admin_requeue` replaced by another name (three policies, two of the names): probe 4 read `false`.
  - D — live traffic between the inventory and the final SELECT (one session; another session wrote two burst rows and marked one read): the old probe 5's expression read `false`; the new final SELECT read `ok = true` × 4, with AFTER 2 beside BEFORE 1.
  - E — `service_role` claimed `{"told": 1, "already": 1}` (one active member already holding a row; a non-member skipped), then `{"told": 0, "already": 1}`; `authenticated` was refused.

**Tests.**
- `lib/__tests__/producersRoutes.test.ts` "PROD-16 — …" (3 cases). The fake service role transcribes the function, including its per-org lock:
  - After the paste, ONE call with the org, the pool and the words, and the app neither reads nor inserts `notifications` itself.
  - Two over-cap requests at once leave each pool member one row. Before the paste, the same path as today, logged as unserialised.
  - Any other error writes nothing.
  - The existing PROD-2 burst tests run unchanged on the pre-paste path.
- `lib/__tests__/notifRoundGBurstDigestMigration.test.ts`: the DEC-30 shape; the function defined once in the sequence; DRLS-16 grants; the lock taken before the read and the insert; and the row shape equal to the route's fallback, with its kind pinned to `KIND_META`.

**Done-when.**
- ✓ Two over-cap requests that land at once give a pool member at most one unread burst row for the org, once `20261197` is pasted. This is the done-when's own example: one SECURITY DEFINER function, a transaction advisory lock keyed on the org, service role only, in the DEC-30 one-paste shape. PostgreSQL 16 above.
- ✓ A test pins it with a concurrent pair (`producersRoutes.test.ts`, the transcribed lock) and a source pin on the serialising statement (`notifRoundGBurstDigestMigration.test.ts`).

**Scope / residual.**
- Until `20261197` is pasted, the route runs today's unserialised path and says so in its log line.
- Duplicate burst rows written before the paste are left as they are. Inventory row 2 counts the (org, member) pairs holding more than one.
- Paste and deploy order: either order is safe.

---

<a id="prod-17"></a>

## PROD-17 · A document's followers are not told when a checkout on it is force-released or when it is retired

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** Assigned (2026-10-14, the integrator at the P26 merge): document-control P28 STATUS-DOOR REMAINDERS — the doors still open: the library page's metadata-editor save to a retired status and `handleBulkArchive` (`app/(protected)/documents/[libraryId]/page.tsx`; after intelligence I-12 merges — it holds that page now), with the bulk editor's Superseded / Archived (`components/documents/BulkEditModal.tsx`), designed with the bulk archive (done-when 1, door (2)); a reversal parking replacements in `lib/documentLifecycle/reverse.ts`; a retention disposal in `lib/retention.ts`; and `skipsRetirementRecall` suppressing the watcher FYI for a row an open door already retired. Written by document-control P26 fix pass 4 under the integrator's rulings (`DEC-90`, 2026-10-14). *(Replaces the line that named document-control P26 STATUS-DOOR FOLLOW-UPS — assigned by the N15 fix pass 4 under the integrator's instruction (DEC-31), 2026-10-14 — for the Void / Archived status change and the split / merge doors. P26 landed the Archive dialog, a split, a merge and the `changeDocumentStatus` hook (the Partial below) and leaves the doors above. The force-release and supersede halves were notifications N15's (assigned by the integrator, 2026-10-13, N9 merge) and are done.)*
- **Verification:** CONFIRMED
- **Locations:** `lib/checkoutEpisodes.ts:775-790`, `lib/staleCopies.ts:300-320`, `lib/postPublish.ts:270-290`
- **Opened:** 2026-10-07, notifications Round G, package N9 — the follower half `PROD-4` done-when 1 asked for, which `DEC-100` item 2 keeps off the personal notices.

**Mechanism.** The force-release notice (`checkout_force_released`) goes to the holders whose checkout was released, in their own words ("Checkout force-released by …"); the retirement recall (`doc_recalled`) goes to the people holding downloaded copies ("Your copy … is out of date"); the package notice (`package_doc_retired`) to the package's owner. A member who WATCHES the document (WatchButton → `subscriptions`) hears none of the three: the words are false for them, so `followers: true` cannot be added to those emits.

**Failure scenario.** A DocCtrl watches a critical P&ID. A Supervisor force-releases a stale checkout on it, or it is voided; the watcher's bell says nothing.

**Done when.**

- [ ] A follower FYI notice, worded for a watcher ("<doc> was force-released by <actor>"; "<doc> was retired (<status>)"), reaches the document's followers for a force-release and for a retirement, minus the people the personal notice already told.
- [ ] A test asserts a subscriptions row on the document puts the watcher in that notice's recipients.

**Closer:** notifications N14 (or as the integrator routes it).

**Partial (2026-10-13, notifications Round G).** Package N15 RECIPIENT VISIBILITY AND NAMES, branch `fleet/N15-recipient-visibility` (base `89c9aaa`).

**Reproduced first** on `89c9aaa`: `forceReleaseDocument` emitted `checkout_force_released` to the holders only, and `recallRetiredDocument` emitted `doc_recalled` to the copy holders only. A watcher was told neither.

**What landed.**
- `lib/checkoutEpisodes.ts` `forceReleaseDocument`: after the holders' notice, a second `emit()` to `audience: { followers: true, exclude: <the holders told> }`.
  - Title "<doc> was force-released by <actor>"; the reason in the body only, never the title (NEDGE-6).
  - Kind `checkout_force_released_fyi` (fix pass 2 — new, declared in `KIND_META`, the union and `20261206`), category `watched`: a lock notice under Locks (Lock icon, not an action, not a compliance kind). *(Corrected at fix pass 2: it rode `checkout_message`, the checkout thread's bell-only chat kind — so the FYI showed under the Mentions filter with a chat icon, and gave that kind an email leg for the first time; the kind overloading `TAX-13` removed.)*
  - Both watcher FYIs pass `emailOnlyWithBell` (fix pass 2): `emit()` emails only the watchers whose bell row landed. Until `20261206` is pasted the rail refuses both kinds from the browser, so in that window a watcher gets neither the row nor the email (never an email the app cannot show).
- `lib/staleCopies.ts` `recallRetiredDocument`: before the copy-holder recall, an `emit()` to `audience: { followers: true, exclude: <the copy holders> }`.
  - Title "<doc> was retired (<status>)"; the body says who retired it and any replacement note, and never "your copy".
  - Kind `doc_retired` (fix pass — new, declared in `KIND_META`, the union and `20261206`'s `notification_kinds()`): `doc_recalled`'s badge, icon and group, but FYI and NOT a compliance kind, on the `watched` category. So the watcher's own email toggle governs its email, the daily compliance digest does not list it, a read one can be deleted (`20261161` keeps only compliance kinds dismiss-only), and `emit()` does not retry it as an obligation. *(Corrected at the fix pass: it rode `doc_recalled`, a compliance kind — so the FYI would have been in the compliance digest, gated by `compliance_digest` rather than the watcher's toggle, dismiss-only, and dead-lettered as an obligation; the claim that "the watcher's own email toggle governs it" held for the direct email only.)*
  - Sent even when nobody holds a copy.
  - Excludes everyone a personal notice about the same retirement told: the download-copy holders, and (fix pass) the checkout holder (`documents.checked_out_by` — the supersede leaves the checkout open; `notifyHolderOfRetirement` told them) and the owners of OPEN work packages pinning the document (`notifyPackagesOfRetirement` told them), read by `recallRetiredDocument` itself (`personallyToldOfRetirement`) so `lib/revisions.ts` (document-control's) is unchanged. `personallyToldElsewhere: { checkoutHolder, packageOwners }` (both true by default) lets a door that sends neither personal notice keep those people in the watchers' audience. A read that fails leaves that person in the audience (a second notice, never none).
- Both go through the dispatcher's discover filter (`NEDGE-6`): a watcher who may not discover the document is dropped.
- `lib/notify/dispatch.ts`: `audience.exclude`.

**Tests.**
- `lib/__tests__/checkoutRoundF.test.ts` "PROD-17": the follower notice's audience, words, reason placement and kind (`checkout_force_released_fyi`, never `checkout_message`; `emailOnlyWithBell`).
- `lib/__tests__/recipientDiscovery.test.ts` "TAX-17 / PROD-17 deploy window (fix pass 2)": with the rail refusing the kind, `emailOnlyWithBell` sends no email; reproduced without it (the email went with no row); after the paste one row and one email each; both FYIs pass it.
- `lib/__tests__/notifStaleEscalationMigration.test.ts` (fix pass 2): `checkout_force_released_fyi` is `checkout_handoff`'s flags (Locks, Lock), the row after `checkout_force_released`, lineDiff-pinned.
- `lib/__tests__/staleCopiesRecall.test.ts` "PROD-17": the retirement notice under `doc_retired`; (fix pass) the checkout holder and the open packages' owners excluded with the copy holders; a door that sends neither keeps them; the recall and its audit row unchanged.
- `lib/__tests__/recipientDiscovery.test.ts`: a subscriptions row puts the watcher in `resolveRecipients` for these kinds. (Fix pass) "PROD-17 (fix pass)", through the real dispatcher: a watcher who holds the checkout and a watcher who owns a pinning package each get exactly their personal notice, the plain watcher exactly one `doc_retired`; `doc_retired` is not in the digest set and the delete policy's registry flags it non-compliance.
- `lib/__tests__/maintenanceDrain.test.ts` "PROD-17 (notifications N15 fix pass)": the cron's compliance digest does not list a watcher's `doc_retired`; it still lists a copy holder's `doc_recalled`.
- `lib/__tests__/notifStaleEscalationMigration.test.ts`: `doc_retired` is the second added row (after `doc_recalled`, `false`), lineDiff-pinned.
- `20261206` on a throwaway PostgreSQL 16 (fix pass): before the paste a browser row of `doc_retired` is refused by the rail stand-in; after it, it is written, and a READ `doc_retired` row is deleted by its recipient under `20261161`'s `notifications_own_delete` while a read `doc_recalled` row and an unread `doc_retired` row are not.

**Done-when.**
- Done-when 1 is met for a force-release and for a retirement by SUPERSEDE (`lib/revisions.ts` `supersedeDocument` → `recallRetiredDocument`), minus every person that door's personal notices told (download holders, checkout holder, open packages' owners). **Not met** for a retirement through the other doors, which never call `recallRetiredDocument`, so no recall and no follower notice go out today:
  - a Void / Archived status change (`lib/revisions.ts` `changeDocumentStatus`, document-control P23's this round);
  - a split or merge retiring its sources (`lib/documentLifecycle/split.ts`, `merge.ts`).
- ✓ Done-when 2: a test asserts a subscriptions row puts the watcher in the notice's recipients.

**Scope / residual.** Stays OPEN on done-when 1's other retirement doors. Owner: ~~document-control (P23 holds `changeDocumentStatus`; the integrator routes split / merge)~~ document-control P26 STATUS-DOOR FOLLOW-UPS (to be planned by the integrator) — fix pass 4, see the Assigned line. One call fixes each door: `lib/staleCopies.ts` `recallRetiredDocument({ … newStatus })`, which now carries the follower notice; a door that does not tell the checkout holder or the package owners passes `personallyToldElsewhere: { checkoutHolder: false, packageOwners: false }`.
- ~~For the integrator to ratify:~~ *(Fix pass 4: ratified by the integrator under `DEC-90` — more than one kind, the new SECURITY DEFINER function and the paste-before-deploy rule in `20261206`; no code change.)* `doc_retired` and (fix pass 2) `checkout_force_released_fyi` are a second and third row in `20261206`, whose number the brief reserved for `notification_kinds()` plus one kind. ~~Until `20261206` is pasted (it is pasted AFTER the N15 deploy, `TAX-17`), the browser's rows of both kinds are refused by `20261160`'s rail and only logged, and (fix pass 2, `emailOnlyWithBell`) no email goes either, so watchers miss both FYIs in that window.~~ *(Fix pass 3: `20261206` is pasted BEFORE the deploy — `TAX-17` — so both kinds are declared before anything writes them and there is no window. Only a late paste would refuse them, with no email either, `emailOnlyWithBell`.)*
- *Fix pass 3 (2026-10-14):* the watchers' FYIs never stand in front of a safety notice or a UI return. `recallRetiredDocument` sends the copy holders' `doc_recalled` and writes its `DISTRIBUTION_RECALL` audit row FIRST, then the watchers' `doc_retired` (before, the FYI — its discover check, reads and inserts — ran first, so a hung discover route delayed the recall). `forceReleaseDocument` fires the watchers' `checkout_force_released_fyi` without awaiting it, so the release returns to `CheckoutStatusCell` / the document page at once. Tests: `staleCopiesRecall.test.ts` "fix pass 3 (the review's major)" (an FYI that never resolves: the recall and its audit row still land, in that order) and `checkoutRoundF.test.ts` "fix pass 3" (an FYI that never resolves: the release returns, the holder is told).

**Partial (2026-10-14, document-control Round G).** Package P26 STATUS-DOOR FOLLOW-UPS, branch `fleet/DC-P26-status-doors` (base `ce5a053`). No migration.

**Reproduced first** on `ce5a053`. The only caller of `recallRetiredDocument` was `supersedeDocument` (`lib/revisions.ts:3337-3338`). These doors called neither the recall nor any follower notice: `archiveDocument` (`lib/revisions.ts:2089`), `changeDocumentStatus` (`:2885`), `splitDocument` (`lib/documentLifecycle/split.ts:297-302`, after `notifyHolderOfRetirement`), and `mergeDocuments`' `finishMerge` (`lib/documentLifecycle/merge.ts:413`, `:511`). A retirement through them told no copy holder and no watcher. Recon also showed that **neither status editor sends a retirement through `changeDocumentStatus`**. Only a write to a controlled-issue status takes it: `app/(protected)/documents/[libraryId]/page.tsx:2810` and `components/documents/BulkEditModal.tsx:197`. A save to Void / Archived / Superseded is the editor's bare checked write (`page.tsx:2868`, `BulkEditModal.tsx:275`). So a recall placed only in `changeDocumentStatus` would reach neither editor's retirement.

**What landed.**
- `lib/revisions.ts` `recallOnRetirement` (new export, `:506-530`). The retirement doors' one call into `lib/staleCopies.ts` `recallRetiredDocument`, fired and never awaited, as `supersedeDocument` fires its own. `recallRetiredDocument` already orders its work: the copy holders' `doc_recalled` and its `DISTRIBUTION_RECALL` row first, then the watchers' `doc_retired`. The door returns exactly when it did; a recall or an FYI that never finishes does not hold it. The module is loaded once and the load is shared, so a merge's several recalls wait on one load. A door with no label in hand (a status write) has the row read for one, off the door's path. If the row cannot be read, the notice names "A document" and still goes. *(Fix pass 2: a recall that ~~does not run~~ never starts is logged, `console.warn` "[revisions] PROD-17: the retirement recall of document <id> did not run" with the error, `:524-529`. Before, it was swallowed without a trace: a failed load of `lib/staleCopies.ts` after a deploy, or a throw past `recallRetiredDocument`. The door is unaffected, and the next recall retries the load.)* *(Fix pass 3, the review: narrowed — only those two cases are logged, and `recallRetiredDocument` catches its own errors and returns 0, so in practice it is the failed load. A recall that starts and whose `download_audits` read fails (`lib/staleCopies.ts:298`, the error dropped) finds no holders: no `doc_recalled`, no `DISTRIBUTION_RECALL` row and no log line, while the watchers' `doc_retired` still goes and the door reports success. That is in `lib/staleCopies.ts`, the notifications area's file, and is opened as notifications **`DELIV-17`** (`02-delivery-integrity.md`, MEDIUM). It is the same for supersede's recall.)* *(Fix pass 4, the integrator (`DEC-90`): logged as an error, `console.error` (`lib/revisions.ts:537`), the way the file logs a retirement's other dropped duties (`[retire]`, `[publish]`); the message and the two cases are unchanged. `DELIV-17` is assigned to document-control P28.)*
- `changeDocumentStatus` (`:3007-3008`): after the checked UPDATE landed, when the write RETIRES the document (`isRetiredStatus(toStatus)`, out of a status that is not ~~retired~~ Superseded or Archived — fix pass 2), one recall goes with `newStatus` = the status written and `personallyToldElsewhere: { checkoutHolder: false, packageOwners: false }`. A re-save of a retired document (Void → Void, Archived → Void) recalls nothing. *(Fix pass 2: the skip is now `skipsRetirementRecall(fromStatus)` plus "not the status it already has". A move out of Superseded or Archived still recalls nothing. A move out of Void into another retired status (Void → Archived, Void → Superseded) recalls, for the reason given under the archive below.)* *(Fix pass 4, the integrator's ruling R1: the call carries `recallCopyHolders: recallsCopyHolders(fromStatus)` (`lib/revisions.ts:3053`): the copy holders are recalled only out of a controlled issue. A Draft or In Review moved straight into a retired status, and a Void moved into another, send the watchers' FYI only. A failed pre-write read counts as an issue, below.)* A failed pre-write read (`fromStatus` unknown) recalls: a second recall over none. A refused write throws first and recalls nothing. The returned outcome is unchanged. No editor routes a retirement here today (above), so this covers a caller that does.
- `archiveDocument` (`:2221`): `authorizeArchive` reads the legal hold and now also the status (`select("legal_hold, status")`, the same round trip), and returns it. After `ARCHIVE_DOC`, one recall goes, `Archived`, with both flags false, unless that fresh read says the document was ~~already retired~~ already Superseded or Archived (`skipsRetirementRecall`) *(fix pass 2: a Void prior ~~recalls~~ is not skipped; fix pass 4: its watchers are told and no copy holder is recalled)*: a Superseded / ~~Void~~ row is not recalled again, and its watchers are not told again. *(Fix pass: corrected — this said "its retirement recalled it", which the code does not know.)* Not recalling again is not proof the earlier retirement recalled anyone. A ~~Void,~~ Superseded or Archived set by either status editor's bare write, a reversal's parking, a retention disposal, or any retirement before DIST-1 recalled nothing (done-when 1's open doors below), so until those doors land, archiving such a row recalls no copies either. *(Fix pass 2, the review: **a Void row is now recalled.** The skip is `lib/revisions.ts` `skipsRetirementRecall` (`:547`), and only a Superseded or Archived prior skips. No live door that writes Void recalls: both status editors write it bare, and `changeDocumentStatus` would recall but no caller routes a retirement there. So for a Void row "already retired" meant "never recalled", and before this pass a document voided by an editor and archived later was never recalled by any door. A Superseded / Archived prior still skips, with the gap above. This is an interim rule: once a door that writes Void recalls (residual (1) below), archiving that Void sends a second recall, until "already recalled" is decided from the recall record — `DIST-16` done-when 2.)* *(Fix pass 4, the integrator's ruling R1 — **superseded for the copy holders:** a Void row is NOT recalled. The copy holders are recalled only when the archive takes away a controlled issue: the call carries `recallCopyHolders: recallsCopyHolders(priorStatus)` (`lib/revisions.ts:2264`; `recallsCopyHolders`, `:580`, is `lib/issueStatus.ts` `isControlledIssueStatus`). A Void, Draft or In Review row archived gets the watchers' FYI only; a controlled issue (Issued, IFC, a library's own status, or a status that is empty or the read did not give) is recalled as before. Fix pass 2's Void rule now holds for the FYI alone. So the second recall it foresaw no longer arises; a second watchers' FYI does, until `DIST-16` done-when 2. And a document voided by a status editor's bare write out of an issue has its copies recalled by no door, its later archive included, until P28 routes that write through `changeDocumentStatus` (residual (1)).)* The Archive dialog (`ArchiveConfirmModal`) is the Archived status change most people make, so it is treated as one of this record's doors.
- `splitDocument` (`split.ts:311`): after `notifyHolderOfRetirement`, one recall for the source, `Superseded`, "Replaced by <new numbers>.", with `personallyToldElsewhere: { checkoutHolder: true, packageOwners: false }`. The split tells the checkout holder itself and no package owner. It is skipped when `markSupersededAndLink`'s fresh read says the source was ~~already retired~~ already Superseded or Archived. *(Fix pass 2: skipped only for a Superseded or Archived source, `skipsRetirementRecall`. A Void source is ~~recalled~~ not skipped, as for the archive.)* *(Fix pass 4, R1: `recallCopyHolders: recallsCopyHolders(priorStatus)` (`split.ts:321`) — a Void, Draft or In Review source gets the watchers' FYI only.)*
- `finishMerge` (`merge.ts:533-543`): one recall per absorbed source that was not already retired, "Replaced by <kept / new number>.", with the same flags. The kept target is never recalled. *(Fix pass 2: "already retired" is Superseded or Archived, `skipsRetirementRecall`; a Void source is ~~recalled~~ not skipped (fix pass 4: its watchers are told, its copy holders are not recalled — `recallCopyHolders: recallsCopyHolders(priorStatus)`, `merge.ts:544`). **Per-holder count, for the integrator:** a person who downloaded several of the absorbed sources gets one `doc_recalled` bell and one preference-exempt `safety_recall` email per source. Merging 12 sheets into one sends a fitter who downloaded all 12 twelve bells and twelve emails in one burst. `MergeWizard` and `merge.ts` set a minimum of 2 sources and no maximum. This is the burst the fix pass cited to revert the bulk editor's per-row recall. It is ratified with the rest below or routed later, see the ratification paragraph.)* *(Fix pass 4: **ACCEPTED by the integrator under `DEC-90`** (ruling R2, 2026-10-14) — each source is a distinct document its holders may have printed. The cost stands as written, cap included (cost (b) below); only issued sources count toward it, since a Draft, In Review or Void source recalls no copy holder (R1).)*
- ~~`components/documents/BulkEditModal.tsx` (`:288`; outside this package's file list): after a row's bare checked write lands, a row that write retired is recalled once, not awaited.~~ *(Fix pass: **reverted** — the file is byte-identical to `ce5a053`'s, and its test file `dcRoundGStatusDoorsBulk.test.ts` is removed. The hunk was outside the brief's file list, decided "already retired" from the page's copy of the row rather than the database (a row superseded by another member after the page loaded was recalled twice; a row put back in force was not recalled), and started one recall chain per row: a 150-row bulk archive would send each copy holder up to 150 `doc_recalled` bells and preference-exempt `safety_recall` emails, where the bulk editor sent none before. The bulk editor's retirement is now open door (2) below, designed with the page's bulk archive.)*
- No second recall: none of these doors recalled before. `supersedeDocument` is unchanged (its one recall, defaults). *(Fix pass 4: still unchanged — supersede passes no `recallCopyHolders`, so it recalls the copy holders whatever the prior status, as it has since `DIST-1`; its regression test pins that its call carries no such field. R1 rules on the Archive dialog, a split and a merge.)* None of the new call sites runs inside another door. Supersede does not call `changeDocumentStatus` or `archiveDocument`; split and merge use `markSupersededAndLink`, not `supersedeDocument`; and neither status editor sends a retired status through `changeDocumentStatus` (above). A census test pins the call sites: `recallOnRetirement` is called from `lib/revisions.ts` (twice: archive, status change), `split.ts` and `merge.ts`, and from nowhere else (fix pass).
- What changes for the people told: on these doors the copy holders now get `doc_recalled` and the document carries a `DISTRIBUTION_RECALL` row *(fix pass 4: when the document was issued — a Draft, In Review or Void one gets neither, R1)*. That is DIST-1's retirement recall, which these doors never sent, and it is the `recallRetiredDocument` call this record prescribes. The watchers get `doc_retired` minus the copy holders and minus whoever the door's own personal notice told. Every notice the doors sent before (the split's / merge's checkout-holder notice) goes exactly as before. ~~**For the integrator to ratify under `DEC-90` (fix pass):**~~ **Ratified by the integrator under `DEC-90` (2026-10-14, ruling R1) for a document that was ISSUED (fix pass 4): the copy holders' recall is a departure from the brief's literal REGRESSION line**, which allows "exactly the notices it sends today plus the watchers' FYI". Before this branch an archive, a split or a merge (and a retirement routed through `changeDocumentStatus`, which no caller sends today) never emailed a copy holder. Now every person with a `download_audits` row on the document in the last ~~60~~ 365 days (`lib/staleCopies.ts` `DOC_RECALL_WINDOW_DAYS`, `DIST-11`), up to 1000 download rows (`DOC_RECALL_ROW_CAP`), gets a `doc_recalled` bell and a `safety_recall` email (preference-exempt, `DEC-90` A10) for each one. *(Fix pass 3, the review: corrected — this said "in the last 60 days". 60 days is the personal stale-copy list's window; `DIST-11` widened the per-document recall window from 60 to 365 days. So the audience to ratify is everyone who pulled any revision of the document in the past year, about six times the window first stated: a fitter who printed P-101 eleven months ago is told, by a bell and a preference-exempt email, that the copy is dead paper and to destroy old prints when someone archives, splits or merges it. The read has no order and the recall does not report its cap, so on a document with more than 1000 downloads in the year, which holders are left out is not defined and nothing says so.)* The brief contradicts itself here: the call it prescribes, `recallRetiredDocument`, sends the copy holders' recall first and the FYI after, and has no FYI-only entry. ~~The case for ratifying: `DIST-1` (document-control `05-distribution.md`) done-when 1's scope note names the retirement doors other than supersede as a gap and says "the recall helper is ready for it", and industry practice is that a retirement recalls the controlled copies in circulation (ISO 9001 §7.5.3, control of documented information, the norm `DEC-90` A5 cites).~~ **The case, as ratified (fix pass 4, restated on its own reasons):** retiring a controlled issue means telling the holders of its copies to stop using them. Supersede has done that since `DIST-1` (2026-08-24); an archive, a split or a merge retires an issue just as finally, and left its holders working from obsolete prints. That is the control of obsolete documents ISO 9001 §7.5.3 asks for (the norm `DEC-90` A5 cites). *(The third review: `DIST-1`'s scope note names only the Void door — there is no `voidDocument` to hook, Void is a raw metadata write, and "the recall helper is ready for it". It says nothing of the archive, a split or a merge, and is no longer cited for them.)* A document that was never issued is outside the ratification: it gets the watchers' FYI only (Fix pass 4 below). ~~If it is not ratified, the reversal is an FYI-only entry in `lib/staleCopies.ts` (the notifications area's file) for these four call sites.~~ *(Fix pass 4: that FYI-only entry now exists for the never-issued case — `recallRetiredDocument`'s `recallCopyHolders: false`.)* **Two further costs belong to the same ratification (fix pass 2, the review):**
  - **(a) The recall is never withdrawn.** Three doors put the document back in force: `unarchiveDocument` (`lib/revisions.ts:2466`), `reverseSplit` and `reverseMerge` (`lib/documentLifecycle/reverse.ts:778`, `:878`). None of them tells anyone. `doc_recalled` is a compliance kind (`lib/notificationKinds.ts:202`), so the holders' rows are dismiss-only, stay listed in the daily compliance digest, and are not reconciled. Example: a document archived by mistake and un-archived a minute later as Issued leaves nine holders told to destroy their prints and stop work, and a digest line saying "P-101 is now Archived — your copy is dead paper" for a drawing in force. Nothing corrects it. Before this branch the archive / un-archive and split / reversal pairs told nobody anything, so this inconsistency is new. A status editor's put-back of a retired issue has the same gap for supersede's recall. It is opened as **`DIST-16`** (document-control `05-distribution.md`, MEDIUM, owner document-control, to be planned with the open doors below): on a restore, one non-compliance withdrawal notice to the recipients of the document's standing `DISTRIBUTION_RECALL`, fired and never awaited, with its own kind. *(Fix pass 4: part of what R1 ratifies; `DIST-16` is assigned to document-control P28 STATUS-DOOR REMAINDERS (R3). A never-issued document's archive, split or merge recalls no one, so it leaves no recall to withdraw.)*
  - **(b) A merge sends one recall per absorbed source**, so a holder of N merged sheets gets N bells and N preference-exempt emails (the `finishMerge` bullet above). The case for accepting it under `DEC-90`: the sources are distinct documents, each with its own copy and recall, and a merge usually has few sources. If it is not accepted, the merge joins the bulk doors' batched per-recipient recall (open door (2)) once `lib/staleCopies.ts` has that entry. *(Fix pass 3, the review: with many sources and many holders the burst can reach `20261160`'s per-actor cap, 3,000 bell rows a minute across every recipient. Past it the rail refuses the rest of that minute's bell rows; `doc_recalled` is a compliance kind, so `notifyCompliance` dead-letters each refusal without a retry (a rate-limit refusal is `DETERMINISTIC_REFUSAL`, `DELIV-16`). An edge case, but part of what is ratified.)* *(Fix pass 4: **ACCEPTED by the integrator under `DEC-90`** (ruling R2): each source is a distinct document its holders may have printed. The cost is as stated here, the cap's edge case included.)*
- **The paste window (N15, `DEC-106`).** `doc_retired` is declared by `20261206`. Until it is pasted, `20261160`'s rail refuses the watchers' FYI row from the browser, and the refusal is only logged. `emailOnlyWithBell` then sends no email either. The copy holders' `doc_recalled` is a declared kind and is unaffected. The brief accepts this; the paste goes before the N15 deploy (`TAX-17`).
- `lib/__tests__/notificationWriteRails.test.ts`: `recallOnRetirement(input.actorUserId)` pinned in `ACTOR_CALLER_PASS_THROUGHS` (a one-hop forward of its callers' actor; every caller passes the signed-in member).

**Tests.**
- `lib/__tests__/dcRoundGStatusDoors.test.ts` (in-memory PostgREST; the real `lib/revisions.ts`, `lib/documentLifecycle/*` and `lib/audit.ts`, and, for the chain tests, the real `lib/staleCopies.ts`):
  - each door sends one recall with its `newStatus`, label, library and `personallyToldElsewhere`;
  - a recall that never finishes holds no door;
  - a refused archive, a refused status write and a rolled-back split recall nobody;
  - archiving, splitting or merging a document already retired (fix pass 2: Superseded or Archived) recalls nothing again, and the fresh read decides over the caller's copy;
  - a re-save of a retired document recalls nothing;
  - a failed pre-write read still recalls; an unreadable label still recalls, naming "A document";
  - regression: supersede sends exactly its one recall with its defaults, and a change that retires nothing recalls nothing;
  - through the real recall: `doc_recalled`, then its `DISTRIBUTION_RECALL` row, then `doc_retired` to `followers: true` minus the copy holders. The checkout holder stays in that audience for the status door and is left out for the split. A stalled FYI or a stalled recall does not hold the archive or the merge.
  - fix pass 2: archiving a voided document recalls it; a Void → Archived / Void → Superseded status change recalls, while Superseded → Archived and a same-status re-save do not; a Void source split or merged is recalled, while a Superseded one is not; `skipsRetirementRecall` skips only Superseded and Archived (Void, a status not retired, and `null` recall); a recall that ~~does not run~~ never starts (a rejected recall stands in for a failed module load) is logged with its document id and error, and the door returns as before (fix pass 3: narrowed, see `DELIV-17`). The three stalled-recall tests (status change, split, merge) now also assert the recall was started. The merge chain test asserts the one `doc_recalled`, and asserts no `DISTRIBUTION_RECALL` row, because the stalled notice never reaches it. With the recall dropped from any of those doors, the tests fail (checked by mutation); *(fix pass 4: the Void cases now assert the call with `recallCopyHolders: false` — the watchers' FYI, no copy-holder recall — and the log test spies `console.error`)*;
  - fix pass 4 (the integrator's rulings under `DEC-90`): `recallsCopyHolders` is `isControlledIssueStatus` of the prior status (Issued, IFC, Locked, a library's own, an empty or unread status: true; Draft, In Review, Void, Superseded, Archived: false). A Draft or In Review archive, a Draft → Void and an In Review → Archived status change, a Draft split and an In Review merge source each send their one call with `recallCopyHolders: false`; the Issued one beside them, `true`. Through the real `recallRetiredDocument`: archiving a Draft that two people downloaded sends no `doc_recalled` and writes no `DISTRIBUTION_RECALL`, and its watchers' `doc_retired` equals an Issued archive's field for field (label and id aside); an Issued archive with copy holders sends exactly one `doc_recalled` and one `DISTRIBUTION_RECALL`, then the FYI minus the holders; a Draft split, and an In Review source merged beside an Issued one, recall only the Issued source's holder, once, and every source's watchers get the FYI. Supersede's call carries no `recallCopyHolders`. Each door test here, and each stalled-recall test (archive, status change, split, merge), asserts the recall was sent, so a door that dropped it fails. Forcing `recallsCopyHolders` to true fails nine tests; ignoring `recallCopyHolders` in `recallRetiredDocument` fails the two real-chain never-issued tests (checked by mutation);
  - census (fix pass): `recallOnRetirement` is called from exactly those four doors, and neither `components/documents/BulkEditModal.tsx` nor the library page calls it or `recallRetiredDocument`. ~~A door that later routes a retirement through `changeDocumentStatus` or `archiveDocument` cannot add a second recall unnoticed.~~ *(Fix pass 3, the review: that census alone did not back the claim — a direct `recallRetiredDocument(` call anywhere but those two files went through.)* A second census (fix pass 3) counts direct `recallRetiredDocument(` calls over `app/`, `components/` and `lib/`, its own definition in `lib/staleCopies.ts` excluded, and pins exactly `{ "lib/revisions.ts": 2 }`: the one in `recallOnRetirement` and supersede's. A new call site of either function, a door that later routes a retirement through `changeDocumentStatus` or `archiveDocument` and also recalls included, fails one of the two censuses (checked by mutation).
- ~~`lib/__tests__/dcRoundGStatusDoorsBulk.test.ts`~~ (removed at the fix pass with the `BulkEditModal` hunk).

**Done-when.**
- Done-when 1 — **partly met; not ✓ as written.** Met (a watcher FYI, minus the people the door's personal notice told, after the copy holders' recall — fix pass 4: for a document that was issued; a never-issued one gets the FYI alone) for: a retirement by supersede (N15); the Archive dialog (`archiveDocument`); a split; a merge; and any retirement routed through `changeDocumentStatus`. **Not met** for five doors, in four groups, that still recall nothing and tell no watcher:
  - **(1) The library page's metadata-editor save** to Void / Archived / Superseded (`app/(protected)/documents/[libraryId]/page.tsx:2810`, `:2868`). It is the bare write, and `page.tsx` belongs to intelligence I-12 this round, so this package may not edit it. ~~The fix is one line~~ *(fix pass 2, the review: corrected — the routing is short but not free of other effects)*: route the retired statuses through `changeDocumentStatus` too (`if (toStatus !== undefined && (isControlledIssueStatus(toStatus) || isRetiredStatus(toStatus)))`). Its outcome for a retirement is `NO_STATUS_ISSUE` with no `notRecordedBecause`, which the page's branches already say nothing for. Do not also call `recallOnRetirement` there: that would be a second recall. **Widened as written, it would also change three things the next package must handle:**
    - (a) The uid / orgId guard (`page.tsx:2811-2813`) would refuse a retired save that the bare write accepts today, while the workspace is still loading. Its sentence ("which can issue the document") is false for Void. Keep the guard for issue statuses only, or reword it for retirements.
    - (b) Every retired save gains `readStatusIssueBasis`'s `select("*")` before the write (`lib/revisions.ts:2749`), one more round trip, against the brief's "same time" REGRESSION rule. Weigh it, or give the retirement branch a narrower read.
    - (c) A zero-row refusal changes wording. "Save refused — nothing was saved: the database updated no document (you may no longer have edit access to it)." (`page.tsx:2871`) becomes the wrapped "The status was NOT changed — you don't have authority …".
    - The next package pins the retired save's wording and its single write in a regression test.
    - *Consequence until it lands:* a Void set here recalls nothing, and nor does a Superseded / Archived set by this save or by the bulk editor (door (2)). ~~and a later archive through the Archive dialog recalls nothing either~~ *(Fix pass 2: a later archive, split or merge of a Void row now recalls (`skipsRetirementRecall`). A Superseded / Archived row set here is still never recalled by a later archive.)* Once this routing lands, a Void set here recalls, so archiving it later sends a second recall until `DIST-16` done-when 2 lands. *(Fix pass 4, R1: corrected. A later archive, split or merge of a Void row tells its watchers and recalls no copy holder — Void is not a controlled issue. So until this routing lands, the copies of a document voided here out of an issue are recalled by no door, its later archive included. Once it lands, the void itself recalls them (`changeDocumentStatus`, prior Issued), and a later archive sends no second recall — only a second watchers' FYI, until `DIST-16` done-when 2. A row voided here before then keeps its copies unrecalled.)*
  - **(2) The bulk retirements: the bulk editor's Superseded / Archived and the library page's bulk archive.** The bulk editor (`components/documents/BulkEditModal.tsx:275`) writes a retired status with its own bare checked write (fix pass: the first pass's per-row recall there is reverted, above). `handleBulkArchive` (`page.tsx:1061`) writes `status: "Archived"` itself and skips `archiveDocument` entirely. Routing each row through `archiveDocument` would bring the recall, and also the REV-6 draft void and the REV-10 share revocation it skips today, which the owner should weigh. Design both together: decide "already retired" from one fresh read per apply (`select("id, status").in("id", ids)`, never the page's copy; a failed read recalls, as `changeDocumentStatus` does), and send one batched recall per apply and per recipient, not one chain per row (a per-row recall sends a copy holder one `safety_recall` email per document, up to N for an N-row apply). A batched recall needs a new entry in `lib/staleCopies.ts`, the notifications area's file.
  - **(3) A reversal parking a split's or merge's replacements as Superseded** (`lib/documentLifecycle/reverse.ts:354`, called at `:806` and `:948`). This needs one `recallOnRetirement` per parked document after the reversal's saga lands.
  - **(4) A retention disposal** (`lib/retention.ts:261`, `disposeDocument` → `Archived`). A record retained from its creation can be live when disposed. This needs a recall when the disposed row was not already retired.
- **Also not met on the doors P26 did land (fix pass 3, the review):** the skip suppresses the whole `recallRetiredDocument` call, the watchers' `doc_retired` with the recall. So archiving, splitting or merging a row that one of the open doors above already set to Superseded or Archived tells no watcher, at either step. It closes with those doors (each retirement then tells its watchers at the first step) or with `DIST-16` done-when 2 ("already recalled" decided from the recall record). *(Fix pass 4: assigned to document-control P28 STATUS-DOOR REMAINDERS, R3.)*
- **Not in done-when 1's words, and new with this package (fix pass 2, the review):** un-archiving a document, or reversing the split or merge that retired it, does not withdraw the recall these doors now send. Recorded above (ratification, cost (a)) and opened as `DIST-16`, owner document-control ~~.~~ P28 STATUS-DOOR REMAINDERS (fix pass 4, R3).
- ✓ Done-when 2: unchanged from N15 (`recipientDiscovery.test.ts`). The chain tests here also assert the FYI's audience is `followers: true`.

**Scope / residual.** Stays OPEN on done-when 1's five doors above. Owner: ~~document-control, to be planned by the integrator (DEC-31)~~ document-control P28 STATUS-DOOR REMAINDERS (fix pass 4: assigned by the integrator at the P26 merge, R3 — the Assigned line above). The library-page doors (the metadata editor's save and the bulk archive) can go once intelligence I-12 has merged `app/(protected)/documents/**`; the bulk editor goes with the bulk archive. The reversal and disposal doors (`lib/documentLifecycle/reverse.ts`, `lib/retention.ts`) can go in the same package. Each single-document fix is one `recallOnRetirement` call (or the page's one-line routing), with the same `personallyToldElsewhere` rule: a door that tells neither the checkout holder nor the package owners passes both false; the bulk doors need the batched design above. Each new call site is added to the census in `dcRoundGStatusDoors.test.ts`. `DIST-16` (the recall's withdrawal on a restore, and "already recalled" decided from the recall record instead of the prior status) goes with these doors. ~~For the integrator: the copy-holder recall on these doors is a departure to ratify under `DEC-90` (above), together with its two costs: no withdrawal on a restore, and one recall per merged source. The Assigned line above names a finished package and is for the integrator to re-assign (fix pass 2).~~ *(Fix pass 4: ratified for an issued document (R1); cost (b) accepted (R2); cost (a) is `DIST-16`, owner P28; the Assigned line is replaced (R3).)* `audit-reports/notifications/99-fix-sequencing.md`'s N15 hand-off line ("a retirement through those doors calls no recall and tells no watcher") ~~is now stale for split, merge and the Archive dialog and is listed in the package report for the integrator to update~~ is corrected there by fix pass 4. *(Fix pass 3: a recall that starts and fails its holders read is silent — no recall, no audit row, no log line. It is opened as notifications `DELIV-17` (`02-delivery-integrity.md`, owner notifications, `lib/staleCopies.ts`), for the integrator to assign.)* *(Fix pass 4: assigned to document-control P28 STATUS-DOOR REMAINDERS, R3.)*

**Fix pass 4 (2026-10-14, document-control P26; the integrator's rulings under `DEC-90`).** The branch first took the integration head `d54655d` in (admin-and-org P12, P14, P15, drafting-flow DF-P4, intelligence I-17, I-27, projects J20, notifications N10). Its one conflict was in `DECISIONS.md` (both blocks kept); `lib/revisions.ts` merged cleanly with admin-and-org P12's one-line `applyEffectiveDate` change in `revUpDocument`, which no retirement door uses.
- **R1 — the copy-holder recall is ratified for a document that was ISSUED.** Retiring a controlled issue means telling the holders of its copies to stop using them, as supersede already does (the case above, restated on its own reasons). A document that was never issued gets the watchers' FYI only. "Never issued" is read from the status read fresh before the door's write, with the existing helper: `lib/revisions.ts` `recallsCopyHolders` (`:580`) is `lib/issueStatus.ts` `isControlledIssueStatus` — no list of its own. Each door passes `recallCopyHolders: recallsCopyHolders(priorStatus)` (archive `:2264`, status change `:3053`, `split.ts:321`, `merge.ts:544`). `lib/staleCopies.ts` `recallRetiredDocument` takes `recallCopyHolders` (`:304`, default true); false reads no `download_audits`, sends no `doc_recalled` and writes no `DISTRIBUTION_RECALL`, and the watchers' `doc_retired` goes as for any retirement. That edits the notifications area's file, in a field supersede and every other caller leave unset. This fixes the review's defect: archiving a never-issued Draft sent a preference-exempt `safety_recall` telling its downloaders to destroy old prints.
- **The "already retired" rule, one statement for the code, this record and `DEC-106`'s Landed line.** Two questions, both read from the prior status. (1) *Already retired?* Superseded or Archived (`skipsRetirementRecall`, `:559`): nothing goes again — no recall, no FYI. Void is not "already retired" in this sense, because no live door that writes Void recalls or tells a watcher. (2) *Does the retirement take away a controlled issue?* (`recallsCopyHolders`): Issued, IFC, a library's own status, or a status that is empty or was not read — the copy holders are recalled, then the watchers told. Draft, In Review, **Void** — the watchers' FYI only. So a Void prior gets the FYI and no copy-holder recall, at every door. Fix pass 2's "a Void prior recalls" is superseded for the copy holders; the sentences above that say it carry the correction.
- **What this leaves.** The copies of a document voided by a status editor's bare write out of an issue are recalled by no door, its archive, split or merge included, until P28 routes that write through `changeDocumentStatus` (residual (1)); a row voided before then keeps its copies unrecalled. Supersede is unchanged and recalls whatever the prior status. The Superseded / Archived skip still suppresses the watchers' FYI for a row an open door retired (P28, R3).
- **R2 — a merge sends one recall per absorbed issued source: accepted.** Each source is a distinct document its holders may have printed. The cost is recorded plainly in cost (b) and the `finishMerge` bullet: a holder of N such sources gets N bells and N preference-exempt emails in one burst, there is no maximum source count, and past `20261160`'s per-actor cap (3,000 bell rows a minute) the minute's remaining bell rows are dead-lettered without a retry.
- **R3 — the remainders have one owner, document-control P28 STATUS-DOOR REMAINDERS** (the integrator adds the package at merge): this record's open doors (the Assigned line above), `DIST-16` (document-control `05-distribution.md`) and notifications `DELIV-17` (`02-delivery-integrity.md`), each with that Assigned line.
- **A recall that fails to run is logged as an error** (`console.error`, `lib/revisions.ts:537`), no other change. A recall that runs and fails its holders read still logs nothing; that is `DELIV-17`'s.
- **Records (the third review):** the ratification no longer leans on `DIST-1`'s scope note, which names only the Void door; `99-fix-sequencing.md`'s N15 hand-off line is corrected; this file's header counts are corrected to its findings' Severity lines.
- Tests: `dcRoundGStatusDoors.test.ts`, the fix pass 4 bullet under Tests above.

**Resolution (2026-10-20, document-control Round G).** Package P28 STATUS-DOOR REMAINDERS, branch `fleet/P28-status-door-remainders` (base `a21c718`). No migration. Every retirement door now recalls once (for a document that was issued — `DEC-90` R1) and tells the watchers once; the integrator's DEC-90 rulings in the brief applied as written except where said below.

**Reproduced first** on `a21c718`: the library page's metadata save wrote Void / Superseded / Archived with its bare checked write (`app/(protected)/documents/[libraryId]/page.tsx:2921`, only an issue status went through `changeDocumentStatus` at `:2854`); `handleBulkArchive` wrote `status: "Archived"` itself (`:1079`); the bulk editor's Superseded / Archived was a bare write per row (`components/documents/BulkEditModal.tsx:278`); a reversal's park (`lib/documentLifecycle/reverse.ts:354`) and a retention disposal (`lib/retention.ts:261`) called no recall; `supersedeDocument` passed no `recallCopyHolders` (`lib/revisions.ts:3538`), so a Draft superseded sent its downloaders a preference-exempt `safety_recall`. None of those doors told a watcher.

**What landed.**
- **The metadata save** (`page.tsx:2916`, `saveMetadata`): a save to a retired status (`lib/issueStatus.ts` `isRetiredStatus`) goes through `changeDocumentStatus` — the same one checked UPDATE, the editor's payload as its `patch`, door `metadata` — whose P26 hook recalls / tells from the row it reads first (so a Void out of an Issued document recalls its copy holders; a Void out of a Draft tells the watchers only). The page calls no recall itself. The record's three costs, handled: (a) while the signed-in member or workspace is not yet known the save is the bare write it always was (no recall can be written without the actor — `console.error`), so the issue branch's guard sentence is untouched; (b) the extra pre-write read (`readStatusIssueBasis`) is accepted — the recall must be decided from the row read fresh (R1); (c) a write that matched no row keeps the bare write's sentence ("Save refused — nothing was saved: the database updated no document …"), mapped from `changeDocumentStatus`'s zero-row refusal; any other refusal reads "Save refused — nothing was saved: <the database's words>", as before.
- **The bulk archive** (`page.tsx:1075`, `:1109`, `handleBulkArchive`) and **the bulk editor's Superseded / Archived** (`BulkEditModal.tsx:178`, `:323`): one fresh read per apply before the write (the page widens its legal-hold read to `select("id, legal_hold, status")` — no extra round trip; the editor reads `select("id, status")` in chunks of 100), the writes exactly as before, then ONE batched recall per apply — `lib/staleCopies.ts` `recallRetiredBatch` (new), fired, never awaited: each copy holder gets one `doc_recalled` naming every retired document of the apply they hold a copy of (a one-document notice is `recallRetiredDocument`'s word for word), each document its own `DISTRIBUTION_RECALL` row (`batch: true`) and its watchers' `doc_retired`. A row already Superseded / Archived is left out (`skipsRetirementRecall`), copy holders only for a controlled-issue prior (`recallsCopyHolders`); a failed read leaves the prior unknown, which recalls; a refused row is left out.
  - **Departure, for the integrator to ratify (`DEC-90`):** the brief says "handleBulkArchive (through archiveDocument)". It is NOT routed through `archiveDocument`: one `archiveDocument` per row starts one recall chain per row — each copy holder one preference-exempt `safety_recall` per document, the burst this record's P26 fix pass reverted and the bulk editor "designed with the bulk archive" must not have — needs a reason the bulk archive never asked for (`archiveDocument` refuses an empty one: a new prompt), and costs about six round trips per row. The batched recall is the record's own design (open door (2)). What `archiveDocument` would also have brought — the REV-6 draft void, the REV-10 share revocation and the `ARCHIVE_DOC` record — is not this finding's (a recall and an FYI) and is opened as document-control **`REV-31`** (`02-revisions-publish.md`), owner document-control, to be planned by the integrator (`DEC-31`).
- **A reversal's park** (`reverse.ts:390` `recallParked`, called at `:902` / `:1056` after the reversal's record): one `recallOnRetirement` per parked sheet / target, "Superseded", "The split (merge) that created it was reversed.", neither personal notice sent elsewhere, with the archive's rules (`parkAsSuperseded` now answers the status it read for its put-back).
- **A retention disposal** (`lib/retention.ts:260`, `:294`): the status read fresh just before the write (its own read — the schedule's read is unchanged; a failed read recalls), then one `recallOnRetirement` after the disposal and its record — "Archived", "Disposed under its retention schedule." — loaded on demand (`lib/revisions.ts` imports `lib/retention.ts`).
- **Supersede of a never-issued document** (`lib/revisions.ts:3568`, the brief's only hunk there besides `DIST-16`'s two hooks): `recallCopyHolders: recallsCopyHolders(prior) || skipsRetirementRecall(prior)` from the status read before the write (`priorState`) — a Draft / In Review / Void superseded tells its watchers only; an issued one, and a re-run on a document already Superseded / Archived, recall as before. Every other notice supersede sends is unchanged (pinned).
- **The `skipsRetirementRecall` limb:** every door that writes Superseded or Archived now tells the watchers at that retirement, so the later door's skip no longer withholds an FYI nobody sent — for retirements from this deploy on (below).
- Censuses: `lib/__tests__/dcRoundGStatusDoors.test.ts` (`recallOnRetirement` call sites now include `reverse.ts` and `retention.ts`; the page and the bulk editor call neither single-document recall and `recallRetiredBatch` once each); `lib/__tests__/notificationWriteRails.test.ts` (`recallRetiredBatch(input.actorUserId)`, `withdrawRetirementRecall(input.actorUserId)` pass-throughs; their one-hop callers).

**Tests.** `lib/__tests__/dcRoundGP28StatusDoorRemainders.test.ts` (the batch: one notice per holder, the single-document notice identical to `recallRetiredDocument`'s, one record per document, FYIs after every recall; never-issued rows; a reversed split's parked sheets recalled and told, a Draft sheet told only, a refused reversal sending nothing; supersede of a Draft / an Issued / a re-run; the page's save routing, its zero-row sentence matched against the real `changeDocumentStatus` refusal, and the bulk archive's one read and one batch — source-pinned, the page being too large to render); `lib/__tests__/dcRoundGP28BulkRetire.test.ts` (jsdom, the real `BulkEditModal`: the same writes, one read before them, one batch with the right flags, the fresh read over the page's copy, a failed read recalls, refused rows left out, a change that retires nothing reads and recalls nothing); `lib/__tests__/dcRoundGP28Disposal.test.ts` (the disposal's recall, its flags, the skip, and every refusal answering as before with no recall). `lib/__tests__/isP1LibraryPage.test.ts` (the page's real `saveMetadata`, lifted: Issued → Void through `changeDocumentStatus` is still ONE UPDATE with exactly the bare write's columns, nothing issued or said; the zero-row sentence; before sign-in is known, the bare write). Updated censuses: `n17PushRosters.test.ts` (the page's second `changeDocumentStatus` call, single-document), `requestAcksClock.test.ts` (the emit categories of `lib/staleCopies.ts`).

**Done-when.**
- ✓ Done-when 1: a watcher FYI, minus the people the door's personal notice told, reaches the followers for a force-release (N15) and for a retirement through every door this record names — supersede, the Archive dialog, a status change, a split, a merge (P26), the metadata save, the bulk editor's Superseded / Archived, the bulk archive, a reversal's park and a retention disposal (P28). Not for: a save or bulk archive made before the page knows who is signed in (bare write, logged), and a document retired before this deploy by a door that told nobody — its later archive, split or merge still skips it (`skipsRetirementRecall`).
- ✓ Done-when 2: unchanged (`recipientDiscovery.test.ts`).

**Scope / residual.** `REV-31` (opened here, above). The second watchers' FYI on a Void archived later, and "already recalled" decided from the record, are `DIST-16` done-when 2 (Partial there). `20261206` is NOT pasted yet: until it is, every `doc_retired` FYI these doors send is refused by `20261160`'s rail and only logged (no email, `emailOnlyWithBell`) — the expected state; nothing here depends on the paste.

---

<a id="prod-18"></a>

## PROD-18 · Notices that ask the recipient to act still read as FYI, because nothing clears their row when the action is done

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** notifications N12 NUDGES (both done-whens: a discharge check per kind in `lib/notificationReconcile.ts` `reconcileClassOf` / `lib/notificationReconcileServer.ts`, then the kind's `KIND_META.actionRequired` in `lib/notificationKinds.ts` in the same change) — by the integrator, 2026-10-13 (N4 integrator fix pass, DEC-31; of the unlaunched notifications packages N12 is the one whose files already include `lib/notificationKinds.ts` and N4's provider; fleet plan `audit-reports/fleet-plans/notifications.json` updated at the N4 merge). Opened as the DEC-31 remainder of `PROD-13` done-when 3.
- **Verification:** CONFIRMED by reading (`fleet/N4-feed-provider`, review fix pass, 2026-10-13).
- **Locations:** `lib/notificationKinds.ts` (`KIND_META[...].actionRequired: false` for each kind below); `lib/notificationReconcile.ts` `reconcileClassOf` and `lib/notificationReconcileServer.ts` (no discharge check for them).
- **Opened:** 2026-10-13, notifications Round G, N4 review fix pass.
- **Independently verified:** — (`author`: opened by notifications N4 at its review fix pass, 2026-10-13, under DEC-31; not yet challenged)

**Mechanism.** `DEC-90` A11 (ratifying `DEC-81` §2) lets a kind be action-required only in the change that clears its row once the action is done — an "Action needed" that never clears trains people to ignore it. N4 did that for the six PSM obligations. These kinds ask the recipient to do something in their own words, but nothing retires their row on discharge, so they stay FYI Activity:

| Kind | Producer | Discharged when |
|---|---|---|
| `markup_request` | `lib/markupRequests.ts` | the markup request is answered or closed (`markup_requests.status` no longer `open`) |
| `deletion_requested` | `lib/ownership.ts` | the deletion request is approved, refused or withdrawn |
| `access_request_pending` | `app/api/auth/request-access/route.ts` | the access request is decided (`lib/accessRequestOutcome.ts`) |
| `intake_submission` | `app/api/intake/upload/route.ts`, `lib/intakeRateLimit.ts` | the submission is reviewed (its `review_state` leaves pending) |
| `request_pending_approval` | `app/(protected)/requests/new/page.tsx`, `lib/transitionIn.ts`, `components/documents/CheckInPanel.tsx` | the request leaves pending approval (the ticket's status) |
| `owner_behind` | `lib/reviewCycles.ts` | the periodic review is no longer overdue |
| `ack_unsatisfiable` | `lib/acknowledgments.ts` | the acknowledgment roster can be satisfied again (or is cancelled) |
| `review_alternate_activated` | `lib/reviewControl.ts` `activateAlternate` | the alternate's sign-off is given, or the draft leaves review |
| `milestone_assigned` | `lib/milestones.ts` | the milestone is completed or reassigned |

The reverse case (second review fix): a row that is action-required by its kind but that nothing clears. The cron's review-health nudge (`review_overdue` + `metadata.reviewHealth`) is FYI per row since N4's second fix pass (`lib/notificationReconcile.ts` `isActionRow`). The check-in panel's "Change proposed to …" notice (`components/documents/CheckInPanel.tsx:445`) borrows the sign-off kind `review_requested`, is kept by the reconcile pass (no roster evidence) and cannot be told apart on the client, so it reads as an action until read — the named `DEC-90` A11 exception, owner drafting-flow: give it its own kind (FYI, or an action with its own discharge check here).

**Failure scenario.** An Admin's `access_request_pending` ("approve this access request") or an approver's `deletion_requested` shows under Activity, with no "Action needed" and no red badge, beside the PSM obligations that do — so the most direct requests in the bell are the ones that look optional.

**Done when.**

- [ ] For each kind above, `reconcileClassOf` names a condition and `lib/notificationReconcileServer.ts` checks it (scoped to the org, retiring nothing on an unreadable read), with a test that the row clears once the action is done and is kept while it is not.
- [ ] Only then, in the same change, the kind's `KIND_META.actionRequired` becomes true (`lib/__tests__/notificationKinds.test.ts` pins that every action kind has a discharge check).

**Closer:** notifications N12 NUDGES (assigned 2026-10-13, above).

---
