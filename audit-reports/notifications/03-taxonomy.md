# 03 · Alerts vs notifications — the taxonomy

**16 findings** — 6 HIGH · 8 MEDIUM · 2 LOW. `TAX-15` and `TAX-16` opened by notifications Round G N7 CORNER, 2026-10-01 (DEC-31 remainders of `TAX-14` and `TAX-8`).

Every distinct way this app tells a person something, what each is for, and where they duplicate or contradict each other.

> Each finding below survived an adversarial verification pass: a second agent read
> the cited code and tried to refute it. Refuted findings were dropped and are not
> recorded. A severity set by that pass overrides the original.


### Already there — reusable substrate

| Thing | Where | Why it matters |
|---|---|---|
| `CornerDock` + `CornerPortal` - a working shared bottom-right dock with a graceful fallback when the dock isn't mounted | `components/ui/CornerDock.tsx:21-48` | The 'stack background-job messages gracefully bottom-right' request (complaint #5) is 80% built. Toasts, UploadIndicator and KnowledgeIndexIndicator already portal into it and stack with a gap. Only BackupIndicator and ServiceWorkerManager escaped; adding a `max-h`/`overflow-y-auto` and a visible-count cap finishes it. |
| Service-worker `push` + `notificationclick` handlers - the complete receive side of OS notifications, including click-to-focus-or-open with target URL routing | `public/sw.js:226-259` | Complaint #2 ('real OS-level notification presence') needs only the subscribe side and a sender. The banner rendering, icon, badge, tag/renotify and click routing already exist and are correct. |
| `push_subscriptions` table with endpoint/p256dh/auth/last_reminded_at, unique endpoint index and per-user RLS (service role bypasses for the sender) | `supabase/migrations/20260804_push_subscriptions.sql:7-36` | Storage and security for web push are already migrated and already registered in schemaExpectations/exportTables/dataRestore. No new migration is needed to ship push. |
| `notification_preferences.inapp_enabled` and `.push_enabled` columns, defaulted TRUE | `supabase/migrations/20260723_notifications_unify.sql:85-87` | Per-channel opt-outs are already stored; `emit()` just needs to read them, and /settings/notifications needs to render two more toggles using the existing `PrefRow`/`Toggle` components on that page. |
| `emit()` - the single-entry dispatcher with unified recipient resolution across subscriptions, ticket watchers, role pools and project membership, plus an exported `resolveRecipients` for preview | `lib/notify/dispatch.ts:67-132 and lib/notify/recipients.ts:23-72` | The correct fan-out spine already exists and honors email preferences. Only 13 call sites use it; migrating the remaining direct `notify`/`notifyMany`/raw-insert producers onto it is mechanical and is the prerequisite for any per-channel or per-kind policy. |
| `FirstRunHint` - the only surface in the app that persists a dismissal, hydration-safe via `useSyncExternalStore` with a documented storage-key namespace | `components/ui/FirstRunHint.tsx:26-50` | It is the ready-made pattern for 'dismissible corner banner whose dismissal is remembered' (complaint #3) and for fixing the EditOverlapBanner / KnowledgeIndexIndicator amnesia. The hydration-error footgun is already solved here. |
| `DialogProvider` / `appAlert`/`appConfirm`/`appPrompt` - a queued, themed replacement for native dialogs with a native fallback if the host isn't mounted | `components/providers/DialogProvider.tsx:46-151` | A clean, already-correct modal layer at z-[700]. It owns 'alert' as a *modal blocking question* - a genuinely distinct concept from a notification, and worth naming explicitly when splitting the vocabulary. |
| `NotificationCenter` slide-over that already accepts a filter parameter and reuses `AttentionFeed` verbatim | `components/notifications/NotificationCenter.tsx:34-45` | Making section badges honest (finding 5) is a small change: widen `AttnFilter` (or add a section param to `open()`) and filter `items` by `item.section` - the panel, portal, escape handling and mark-read plumbing are done. |
| `lib/ticketAttention.ts` - one pure, documented, unit-testable rule for 'does this need MY action', explicitly created to kill a prior two-copy drift | `lib/ticketAttention.ts:1-128` | Proof that the consolidation pattern works in this codebase, and the exact model to copy for the notification-kind registry: one exported pure module, a header comment explaining the drift it eliminated, and every surface importing it. |
| `AttentionItem.section` already exists on every feed item alongside `resourceId` and `link`, and is already tallied per-section by `sectionCounts` | `hooks/useTicketNotifications.ts:105-132 and 246-302` | The data needed to badge a library/folder/document row is already computed. Propagating badges down the chain (complaint #1) is a selector + consumer problem, not a data-model problem. |
| `countUnread(orgId)` - an exact head-count query already written but never called by the hook | `lib/inAppNotifications.ts:176-185` | Fixes the 50-row badge cap (finding 6) with no new query code. |
| Compliance email digest - one email per user per day summarizing new obligations, with per-user opt-out and 60s burst dedupe already honored | `app/api/cron/maintenance/route.ts:361-430 and lib/notifications.ts:50-100` | The escalation rung above the bell already exists for compliance kinds. `COMPLIANCE_KINDS` is also the best existing definition of 'this is an alert, not a notification' - the natural seed for the severity axis in a unified kind registry. |
| `lib/nudges.ts` `computeNudges` - a pure, unit-tested derivation of 'what should you DO' from the inbox snapshot, with severity and a jump target per nudge | `lib/nudges.ts:24-114 (tested in lib/__tests__/nudges.test.ts)` | A seventh signalling vocabulary today (rendered only on /inbox, never persisted), but it is the cleanest 'proactive prompt' engine in the codebase and the right place to host a login-time nudge banner (complaint #3) once it is given a durable surface. |


---


<a id="tax-1"></a>

## TAX-1 · Clicking a section badge opens the Notification Center UNFILTERED, so the panel that promises "click a 10, see the 10" shows a different number than the badge

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/navigation/Sidebar.tsx:532-545`, `components/notifications/NotificationCenter.tsx:76-85`, `components/notifications/NotificationCenter.tsx:112-117`, `components/cockpit/AttentionFeed.tsx:22`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Factually exact — I found no section-aware open() path anywhere (all five openCenter call sites pass only 'all' or 'action'), and even the 'red' branch maps a per-section actionRequired badge onto an app-wide action count. Severity is one notch high, though: nothing is lost or blocked — every item is present, navigable and additionally narrowable by AttentionFeed's KIND_GROUPS second axis (lines 64-69); the harm is a misleading count, not an unreachable item.

**Mechanism.** `SidebarLeaf` renders the per-section count from `sectionCounts[section]`, but its click handler calls `openCenter('action' | 'all')` - an `AttnFilter` with no section axis at all. `AttnFilter` is only `"all" | "action" | "unread"`. The Center then renders `items` (the whole org-wide feed) and its header states `${counts.all} items - every badge in the app counts these`, which is false for every section badge.

**Failure scenario.** Documents shows a blue 3 (three document-section items). The user clicks the 3. The panel opens headed "Needs your attention - 11 items - every badge in the app counts these" and lists 11 rows spanning requests, projects and documents. The user cannot tell which 3 the badge meant. This is the owner's complaint #1 restated: the number is a doorway that opens onto a different room.

**Evidence.**

```
components/navigation/Sidebar.tsx:537-541 -- `<button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); openCenter(leaf.badgeTone === 'red' ? 'action' : 'all'); }} title="See these notifications"`

components/notifications/NotificationCenter.tsx:116 -- `: `${counts.all} item${counts.all === 1 ? "" : "s"} - every badge in the app counts these.`}`

components/cockpit/AttentionFeed.tsx:22 -- `export type AttnFilter = "all" | "action" | "unread";`
```

> **Verifier correction.** The evidence quotes NotificationCenter.tsx:116 with an ASCII hyphen; the file uses an em dash ("— every badge in the app counts these."). Same for Sidebar's title text. Cosmetic transcription only.

**Done when.**

- [ ] `open()` accepts a section (or arbitrary predicate) and the Center filters `items` by `item.section`
- [ ] The Center header count equals the badge count that opened it, for every badge in the app
- [ ] The header copy is only claimed when true, or is scoped ("3 items in Documents")

---

<a id="tax-2"></a>

## TAX-2 · Every PSM/OSHA compliance notification kind falls through `sectionForKind` to section 'other', which no sidebar row renders - the badge trail dies before it starts

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** notifications N3 SURFACES (done-when 4: opening the badged section shows the badged items, via the section filter `TAX-1` / `TRAIL-3`) — by the integrator, 2026-10-01 (N2 merge; fleet plan `audit-reports/fleet-plans/notifications.json`).
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:71-103`, `hooks/useTicketNotifications.ts:100-102`, `components/navigation/Sidebar.tsx:229-235`, `app/api/cron/maintenance/route.ts:361-374`
- **Also surfaced independently as** [`DELIV-3`](./02-delivery-integrity.md#deliv-3) — two lenses found this separately. Fix once.
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The mechanism is real and the review_due walkthrough is correct. Two corrections: the title's "Every" is false — `doc_superseded` is in COMPLIANCE_KINDS and DOES map to 'documents' (line 82) — and the trail does not fully die, since these items still appear in the bell/Notification Center/`/inbox` (NotificationCenter.tsx:77 counts all items) and group under AttentionFeed's "Documents & revisions" matcher (line 66 matches `review`/`ack`/`effective`/`retention`). That is a routing/discoverability gap, not a dropped obligation.

**Mechanism.** `sectionForKind` enumerates 23 kinds and returns `'other'` for everything else. Of the 48 declared kinds, 25 hit that default - including every kind the maintenance cron itself lists as compliance-critical: `review_due`, `review_requested`, `review_overdue`, `review_complete`, `review_invalidated`, `review_alternate_activated`, `ack_requested`, `ack_overdue`, `ack_unsatisfiable`, `retention_eligible`, `access_recert_due`, `effective_now`, `owner_behind`, `deletion_requested`, plus `library_doc_added`, `library_doc_revised`, `revision_published_over_checkout`, `legal_hold_placed`, `legal_hold_released`, `owner_assigned`, `security_export`, `project_comment`, `orchestrator_message`. The Sidebar reads only `sectionCounts.documents`, `.projects` and `.requests` - `.other` and `.scratchpad` are computed and thrown away. All of these kinds have live producers (lib/reviewControl.ts, lib/acknowledgments.ts, lib/retention.ts, lib/effectiveDate.ts, lib/accessRecert.ts, lib/postPublish.ts, lib/ownership.ts). `'scratchpad'` is itself dead: app/(protected)/scratchpad/page.tsx is a bare `redirect("/inbox")` stub.

**Failure scenario.** A controlled P&ID hits its periodic-review date. `lib/reviewCycles.ts` writes a `review_due` row and the cron emails a digest. The bell's total count goes up by one, but `sectionCounts.documents` does not move, so the Documents nav row shows no badge. The engineer sees the bell number rise, opens Documents looking for what changed, and finds nothing highlighted anywhere - exactly the owner's "the trail goes cold". Same for an `ack_requested` read-and-understand obligation, the strongest compliance signal in the product.

**Evidence.**

```
hooks/useTicketNotifications.ts:100-102 -- `    default:\n      return 'other';\n  }` (no case for review_*, ack_*, retention_eligible, effective_now, legal_hold_*, access_recert_due, library_doc_*)

components/navigation/Sidebar.tsx:229-235 -- `{ label: 'Documents', ... ...badgeOf(sectionCounts.documents) }, ... { label: 'Projects', ... ...badgeOf(sectionCounts.projects) }, { label: 'Drafting Requests', ... ...badgeOf(sectionCounts.requests), }` -- `.other` and `.scratchpad` are never read

app/api/cron/maintenance/route.ts:361-368 -- `const COMPLIANCE_KINDS = [\n  "review_due", "owner_behind",\n  "ack_requested", "ack_overdue", "ack_unsatisfiable",\n  "retention_eligible", "access_recert_due", "effective_now",\n  "review_requested", "review_overdue", "review_complete",\n  "review_alternate_activated", "deletion_requested",`
```

> **Verifier correction.** Two numeric/scope errors. (1) 26 of the 48 kinds fall through to 'other', not 25 — the finding's enumerated list of 23 omits ack_complete, review_signed and task_reminder. (2) 'every kind the maintenance cron lists as compliance-critical' is 14 of 15: `doc_superseded` is in COMPLIANCE_KINDS (route.ts:369) and IS mapped, to 'documents' (useTicketNotifications.ts:84). Severity lowered CRITICAL->HIGH: these rows are not invisible. They are counted by the header bell (NotificationBell.tsx:57 `const unread = count`, where hook :312 `count: items.length` includes every notification row regardless of section), listed by NotificationCenter, the /inbox feed and the dashboard widget, and app/api/cron/maintenance/route.ts:372+ emails a per-user compliance digest built from COMPLIANCE_KINDS. What is genuinely lost is the per-section sidebar badge — the owner's 'trail goes cold' complaint — not all surfacing.

**Done when.**

- [ ] Every kind in `COMPLIANCE_KINDS` resolves to a section whose sidebar row actually renders a badge
- [ ] `sectionCounts.other` is either rendered somewhere or provably always zero (a test asserts no producible kind maps to 'other')
- [ ] The dead `'scratchpad'` section is removed (its page is a redirect stub; no producer writes `task_nudge`/`task_overdue_digest`/`morning_digest`)
- [ ] Opening the badged section shows the badged items - the count is reproducible one level down

**Partial (2026-10-01, notifications Round G).** **Reproduced first** on `b9cdfdc`: `lib/__tests__/notificationKinds.test.ts` was committed BEFORE any change (`e595cf5`) with the TODAY tables read from the source — `sectionForKind` returned `'other'` for 28 of the 50 union members (the audit's 26 plus `member_revoked` and `library_unowned`, added by R&P) and `'scratchpad'` for 3; `emptySectionCounts()` allocated five buckets; `components/navigation/Sidebar.tsx` badges three (`badgeOf(sectionCounts.documents|projects|requests)`); and the rendered hook, given one row of every kind written on `b9cdfdc`, tallied 33 rows into `other` and 3 into `scratchpad`, which no row reads. All seven assertions passed on the base, i.e. the defect reproduced as recorded. The cron's `COMPLIANCE_KINDS` (`app/api/cron/maintenance/route.ts:556-566`) was parsed and pinned too: 14 of its 15 kinds resolved to `'other'` (`doc_superseded` was the one mapped).

**Fix (package N2 KIND-REGISTRY, commit `95dbe50`; review fix `42d5df8`; final-review fix `9950e29`, whose line numbers these are).** New `lib/notificationKinds.ts` `KIND_META` (:88) classifies every `NotificationKind` in one literal — `section`, `actionRequired`, `compliance`, `icon`, `tone`, `group` — with `as const satisfies Record<NotificationKind, KindMeta>` (:192), and each kind's section decision written next to it (:89 requests, :97 documents — the moved kinds under :116, :157 projects — `project_comment` at :161, :164 bell-only). `NOTIFICATION_SECTIONS` (:38) is exactly `requests | documents | projects`. `hooks/useTicketNotifications.ts` `sectionForKind` (:96) reads it, with a `never` guard over the registry's own keys (:102), so a kind added to the union without an entry fails `tsc` twice (here and at the `satisfies`); `emptySectionCounts` (:138) allocates one bucket per rendered section and no other. `'scratchpad'` and `'other'` are gone from `AttentionSection`; a kind with `section: null` is bell-only — counted by the header bell, listed by the Center and `/inbox`, counted by no rail row, which is exactly where `'other'` left it. A legacy row whose kind is in no union (a retired `task_nudge`) resolves to null at runtime. Decision recorded as `DEC-81` in `DECISIONS.md` (provisional number; the integrator renumbers).

**Where each kind went** (`DEC-81` §3; the plan's default): every kind that badged a row on `b9cdfdc` badges the same row; the document-scoped kinds that fell to `'other'` — `ack_requested`, `ack_complete`, `ack_overdue`, `ack_unsatisfiable`, `review_due`, `review_requested`, `review_signed`, `review_invalidated`, `review_complete`, `review_overdue`, `review_alternate_activated`, `library_doc_added`, `library_doc_revised`, `effective_now`, `owner_assigned`, `owner_behind`, `deletion_requested`, `retention_eligible`, `legal_hold_placed`, `legal_hold_released`, `access_recert_due`, `revision_published_over_checkout` — badge **Documents**; `project_comment` badges **Projects**; `orchestrator_message`, `security_export`, `member_revoked`, `library_unowned`, the three storage kinds, `ai_cap_changed` and `transmittal_unstampable` are bell-only, each with its reason in the registry. Nothing was mapped to Documents wholesale, and no emitted kind was deleted. For ratification with §3: `ai_cap_changed` and `transmittal_unstampable` are bell-only beyond the plan's default list (the census found them written outside the union); and `review_requested` is overloaded — besides a document's sign-off request, the contractor-intake path writes it for three notices that open a project: every contractor quote (`app/api/intake/upload/route.ts:899-906` `notifyTeam`, "Quote received: …", `resource_type` 'project', `/projects/<id>?tab=costs`), every intake submission awaiting review (`app/api/intake/upload/route.ts:1533-1544`, the same `notifyTeam`, "Intake submission awaiting review: …", a `/projects/<id>` link), and the folded digest when nothing was published (`lib/intakeRateLimit.ts` `foldedDigestKind`, `resource_type` 'project', a `/projects/<id>` link). So a project-scoped quote or intake notice now raises the **Documents** badge (none of the three badged a row on `b9cdfdc`, where `review_requested` fell to `'other'`). The overload is written next to the kind (`lib/notificationKinds.ts:132-144`); kinds of their own for these notices — for `notifyTeam`'s quote and submission notices and for the digest (e.g. `intake_quote` / `intake_submission`, section `projects`) — are the intake path's owner's (projects).

- Files: `lib/notificationKinds.ts` (new), `lib/inAppNotifications.ts` (the union), `hooks/useTicketNotifications.ts`.
- Tests: `lib/__tests__/notificationKinds.test.ts` — "sectionForKind and KIND_META agree with TODAY + the departures, kind by kind"; "every kind that badged a row on b9cdfdc badges the same row now"; "the sections are exactly the rows the Sidebar badges" (parses `Sidebar.tsx`); "'other' is gone: the bell-only kinds are exactly the deliberate list"; "GAP-201 acceptance 1: a kind added without a KIND_META entry fails the type check" (type-checks the hook in memory with a probe kind appended: the `never` guard and the `satisfies` both fail; clean without it); and the rendered hook over one row of every kind written on `b9cdfdc` — every row still renders (55 items, as before), requests 5 (unchanged), documents 12 → 34, projects 2 → 3, and `sectionCounts` has exactly the three rendered keys. Plus "TAX-2 dw1: every compliance-digest kind badges the Documents row" and "a retired kind has no producer anywhere".
- Verified: loop on `fleet/N2-kind-registry` at `95dbe50`: `npx tsc --noEmit` exit 0; `npx eslint` on the 14 changed code and test files `--max-warnings=0` exit 0; `npx vitest run --maxWorkers=2` (full suite) exit 0 — 349 files, 7298 passed, 5 expected-fail. (Two default-worker runs on a machine at load 25 on 4 CPUs each timed out two unrelated fuzz tests at the 5 s default — a different pair each time, each passing alone.) After the review fix (`42d5df8`): `npx tsc --noEmit` exit 0; `npx eslint --max-warnings=0` on the five changed code and test files exit 0; `npx vitest run` (full suite, default workers) exit 0 — 349 files, 7302 passed, 5 expected-fail. `next build` is the integrator's. After the final-review fix (`9950e29`, comments only, and the record commits after it): `npx tsc --noEmit` exit 0; `npx eslint . --max-warnings=0` exit 0; `npx vitest run lib/__tests__/notificationKinds.test.ts lib/__tests__/notificationKindStorageProducers.test.ts lib/__tests__/notificationKindThreadProducer.test.ts` exit 0 — 3 files, 43 passed; `npx vitest run` (full suite) exit 0 — 349 files, 7302 passed, 5 expected-fail; `node audit-reports/build-index.mjs` ✓ corpus integrity.

**Done-when.**
- ✓ Every kind in `COMPLIANCE_KINDS` resolves to `'documents'`, a row the Sidebar badges (tested against the parsed cron list).
- ✓ `sectionCounts.other` no longer exists: the type cannot produce an unrendered bucket, and a test pins the bell-only kinds to an explicit list, every produced kind (the census) being classified.
- ✓ The `'scratchpad'` section is removed, with `task_nudge`, `task_overdue_digest`, `morning_digest` (and `task_reminder`) — no producer anywhere, SQL included (`PROD-8`).
- **Not done (N3, then N11):** "opening the badged section shows the badged items". The badge opens the Notification Center, which lists them, but unscoped: the section filter is `TAX-1` / `TRAIL-3` (N3, GAP-202 step 1), and the count one level down is `TRAIL-1` (N11).

**Scope / residual.** Stays OPEN for done-when 4 only; record RESOLVED when N3's section filter lands.

---

<a id="tax-3"></a>

## TAX-3 · Force-releasing a checkout emits five signals under two different names, and the tone of every one of them disagrees with the feed's own severity

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/checkoutEpisodes.ts:651-681`, `components/providers/NotificationListener.tsx:61-70`, `components/providers/NotificationListener.tsx:90`, `hooks/useTicketNotifications.ts:279`, `lib/notify/dispatch.ts:82-131`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Every element checks out — the system message toast, the notification-row toast, the durable bell row, the email (lib/notify/dispatch.ts:83 `const channels = input.channels ?? ["inapp", "email"]` with no override at the call site), and the info tone on an item the feed itself flags action-required. HIGH is a notch too far because no signal is lost: the victim gets a durable action-required feed row plus email; the defect is duplicate, mis-toned, mis-named noise.

**Mechanism.** `forceRelease` writes a `checkout_messages` system row whose text literally begins "SYSTEM ALERT:", then calls `emit()` which writes a `checkout_released` notification AND queues an email. The system row toasts to the whole org as title **"System Alert"** with `type: "info"` (blue Info icon). The notification row toasts a second time as **"Your checkout was force-released"**, also `type: "info"` - because `isError` only covers `checkout_conflict` and `hold_opened`. Yet the same `checkout_released` kind IS in the feed's `actionKinds`, so the bell renders it orange with "ACTION NEEDED". One event: two names, two blue toasts, an orange bell row, a sidebar badge and an email.

**Failure scenario.** Bob's checkout is force-released while he is on the Projects page. He sees a blue informational card saying "System Alert" (which he has learned to ignore, since every org member gets those) and a second blue card saying "Your checkout was force-released". Both auto-dismiss in 5-6s. If he was away from the keyboard, the only durable trace is a bell row he must notice is orange. The most consequential personal interrupt in the document-control model is delivered in the same visual tone as an FYI.

**Evidence.**

```
lib/checkoutEpisodes.ts:655 -- `text: `SYSTEM ALERT: checkout force-released by ${input.actorName}. All sessions ended.`,`

lib/checkoutEpisodes.ts:670-671 -- `kind: "checkout_released",\n        title: "Your checkout was force-released",`

components/providers/NotificationListener.tsx:90 -- `const isError = row.kind === "checkout_conflict" || row.kind === "hold_opened";`

hooks/useTicketNotifications.ts:279 -- `const actionKinds = new Set(['checkout_conflict', 'checkout_released', 'overlap_advisory', 'branch_open']);`
```

**Done when.**

- [ ] Toast tone is derived from the same action-required classification the feed uses - an action-required kind never renders as a blue `info` toast
- [ ] The "SYSTEM ALERT:" thread line and the notification title use one agreed wording for the event
- [ ] An action-required toast does not auto-dismiss, or leaves a persistent trace the user can reach after it vanishes
- [ ] No org-wide toast is emitted for an event that already has targeted recipients

---

<a id="tax-4"></a>

## TAX-4 · One checkout-thread post fires two toasts with two different wordings, and broadcasts a third to every org member regardless of document access

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/providers/NotificationListener.tsx:38-73`, `components/providers/NotificationListener.tsx:80-100`, `lib/activityThread.ts:97-99`, `lib/activityThread.ts:153-164`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. I specifically hunted for the guard that would refute the broadcast — a document-level RLS predicate or a client-side access check before showToast — and there is none in either place. Recipients of the durable notification get two cards with different wordings (amber warning + blue info), and every other active org member gets the raw message text regardless of library or document permission, which is the confidentiality angle that keeps this at HIGH.

**Mechanism.** `postActivity` inserts into `checkout_messages`, then fire-and-forgets `notifyCheckoutActivity` which inserts a `checkout_message` row into `notifications`. `NotificationListener` subscribes to BOTH tables at once: channel 1 is filtered `org_id=eq.${activeOrgId}` (the whole workspace, no ACL check on the document), channel 2 is filtered `user_id=eq.${uid}`. A participant therefore matches both and gets two toast cards for the same post - one titled `New Message from ${data.user_name}` with the raw text, one titled `${userName} posted to ${label}` with a 140-char snippet. Everyone else in the org gets the first toast even if they cannot open the document.

**Failure scenario.** Alice posts "pressure relief sizing looks wrong on sheet 3" in a checkout thread Bob is watching. Bob sees two stacked cards in the corner: an amber "New Message from Alice" and a blue "Alice posted to P-1204-03". He assumes two things happened. Meanwhile every other signed-in member of the workspace - contractors and viewers included - sees "New Message from Alice / pressure relief sizing looks wrong on sheet 3" for a document they have no rights to.

**Evidence.**

```
components/providers/NotificationListener.tsx:65-70 -- `showToast({ type: isSystem ? "info" : "warning", title: isSystem ? "System Alert" : `New Message from ${data.user_name}`, message: data.text || "New activity in document.", duration: 5000, });`

components/providers/NotificationListener.tsx:92-97 -- `showToast({ type: isError ? "warning" : isMention ? "info" : "info", title: row.title, message: row.body ?? "", duration: 6000, });`

lib/activityThread.ts:159-160 -- `title: `${input.userName} ${kindWord} ${label}`,\n      body: snippet,`

components/providers/NotificationListener.tsx:46 -- `filter: `org_id=eq.${activeOrgId}`,`
```

**Done when.**

- [ ] A single post produces at most one toast per recipient
- [ ] The `checkout_messages` realtime channel is either removed (the durable `checkout_message` notification already covers recipients) or scoped to documents the viewer can read
- [ ] No toast is shown for a resource the viewer lacks ACL on
- [ ] A test drives one `postActivity` and asserts exactly one `showToast` call per recipient

---

<a id="tax-5"></a>

## TAX-5 · Six independent hand-maintained taxonomies classify the same `notifications.kind` string; none derive from a shared registry, and they contradict each other

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/inAppNotifications.ts:10-58`, `hooks/useTicketNotifications.ts:71-103`, `hooks/useTicketNotifications.ts:279`, `components/notifications/NotificationBell.tsx:19-44`, `components/cockpit/AttentionFeed.tsx:36-53`, `components/cockpit/AttentionFeed.tsx:64-75`, `components/providers/NotificationListener.tsx:90`, `app/api/cron/maintenance/route.ts:361-374`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Factually airtight — eight, not six, hand-maintained kind classifiers exist and none derives from a registry; 'review_requested' likewise hits KIND_GROUPS 'documents' (k.includes("review")) while sectionForKind falls through to 'other'. Downgraded to MEDIUM because the demonstrated user-visible consequence is which filter chip a row files under (cosmetic/maintainability); no data is lost and no obligation is hidden by this finding on its own.

**Mechanism.** `NotificationKind` (lib/inAppNotifications.ts:10-58) declares 48 kinds. Six separate places then re-classify that same string, each with its own hand-written list and its own matching strategy (exact switch vs Record lookup vs substring `includes`): (1) `sectionForKind` -> which sidebar row badges; (2) `actionKinds` -> whether the feed says "Action needed"; (3) `KIND_ICON` -> the bell's icon; (4) `attentionVisual` -> the feed's icon+tone; (5) `isError` -> the toast's colour; (6) `COMPLIANCE_KINDS` -> whether it earns an escalation email. No table, constant, or type ties them together, so adding a kind silently gets six different default treatments. This IS the answer to "are alerts and notifications the same thing": the code has one storage concept (`notifications`) and six competing meanings layered on top of it.

**Failure scenario.** A `markup_request` row: `sectionForKind` returns `'documents'` so it badges the Documents nav row, but `groupOf('markup_request')` hits `KIND_GROUPS` "requests" (`k.includes("markup")`) so inside the Notification Center it files under "Requests" - the badge points one way, the feed files it the other. A `review_requested` row: `KIND_ICON` has no entry so the bell draws a generic `Bell`; `attentionVisual` matches `k.includes("rev")` so the feed draws `GitBranch` blue. Same row, two icons, two homes. Only 23 of 48 kinds have a `KIND_ICON` entry at all.

**Evidence.**

```
hooks/useTicketNotifications.ts:71-96 -- `export function sectionForKind(kind: NotificationRow['kind'] | 'ticket'): AttentionSection { switch (kind) { ... case 'markup_request': ... return 'documents';`

components/cockpit/AttentionFeed.tsx:67 -- `{ key: "requests", label: "Requests", match: (k) => k.includes("ticket") || k.includes("assign") || k.includes("approval") || k.includes("engineer") || k.includes("markup") },`

components/notifications/NotificationBell.tsx:166 -- `const Icon = KIND_ICON[item.kind] ?? Bell;`

components/cockpit/AttentionFeed.tsx:44 -- `if (k.includes("rev") || k.includes("revision") || k.includes("version")) return { Icon: GitBranch, tone: "blue" };`
```

> **Verifier correction.** Two evidence line numbers are off by one to two lines: the `{ key: "requests", ... }` KIND_GROUPS entry is at AttentionFeed.tsx:66 (not :67), and the `k.includes("rev")` line is at :46 (not :44); attentionVisual spans :35-51 (not :36-53) and KIND_GROUPS spans :63-68 (not :64-75). The quoted code text is verbatim-correct in every case. Severity lowered to HIGH: this is the shared root cause, but its concrete user-visible harms are reported separately as findings 2, 4, 11 and 12 — on its own it is an architecture/maintainability defect, not an independent failure.

**Done when.**

- [ ] A single exported registry (e.g. `lib/notificationKinds.ts`) maps every `NotificationKind` to `{ section, group, icon, tone, actionRequired, compliance }` in one literal
- [ ] `sectionForKind`, `KIND_ICON`, `attentionVisual`, `KIND_GROUPS`, `actionKinds`, `isError` and `COMPLIANCE_KINDS` all read from that registry instead of their own lists
- [ ] A type-level exhaustiveness check (`Record<NotificationKind, KindMeta>`) makes adding a kind without classifying it a compile error
- [ ] A test asserts the bell icon and the feed icon for every kind are the same component

**Partial (2026-10-01, notifications Round G).** **Reproduced first** on `b9cdfdc`: the TODAY test (`e595cf5`) pins the seven hand-maintained classifiers as they were — `sectionForKind`, `actionKinds`, the bell's `KIND_ICON` (parsed), the feed's `attentionVisual` and `KIND_GROUPS` (verbatim copies, checked against the source), the toast's `isError`, the cron's `COMPLIANCE_KINDS` (parsed) — and they disagree as recorded (e.g. `review_requested`: no bell icon, GitBranch in the feed, group Documents, section `'other'`).

**What landed (package N2, commit `95dbe50`).** The one table: `lib/notificationKinds.ts` `KIND_META`, `Record<NotificationKind, KindMeta>` via `satisfies`, carrying `section`, `actionRequired`, `compliance`, `icon`, `tone`, `group` (`pushWorthy` for N10). `sectionForKind` and the action flag (`actionKinds` is deleted) now derive from it. The other columns are filled at parity — `icon` = the bell's icon where it had one, else the feed's; `tone` / `group` = the feed's predicates; `compliance` = the cron's list — and a test asserts each column equals its predecessor kind by kind, with the departures named (the storage icons; `member_revoked`, whose feed icon/group came from "rev" in "revoked"). Decision: `DEC-81`.

- Files: `lib/notificationKinds.ts` (new), `hooks/useTicketNotifications.ts`, `lib/inAppNotifications.ts`.
- Tests: `lib/__tests__/notificationKinds.test.ts` ("action, compliance, icon, tone, group — the other classifiers, in one table", 7 cases; the type-check probe).
- Verified: loop on `fleet/N2-kind-registry` at `95dbe50`: `npx tsc --noEmit` exit 0; `npx eslint` on the 14 changed code and test files `--max-warnings=0` exit 0; `npx vitest run --maxWorkers=2` (full suite) exit 0 — 349 files, 7298 passed, 5 expected-fail. (Two default-worker runs on a machine at load 25 on 4 CPUs each timed out two unrelated fuzz tests at the 5 s default — a different pair each time, each passing alone.) After the review fix (`42d5df8`): `npx tsc --noEmit` exit 0; `npx eslint --max-warnings=0` on the five changed code and test files exit 0; `npx vitest run` (full suite, default workers) exit 0 — 349 files, 7302 passed, 5 expected-fail. `next build` is the integrator's.

**Done-when.**
- ✓ A single exported registry maps every `NotificationKind` to `{ section, group, icon, tone, actionRequired, compliance }` in one literal.
- **Partly:** `sectionForKind` and `actionKinds` read it (✓). **Not done (N3):** `KIND_ICON`, `attentionVisual`, `KIND_GROUPS`, `isError` (N3 SURFACES — those files are N3's next; note `isError` warns for `hold_opened`, which is not `actionRequired`, so N3 keeps its warning tone explicitly). **Not done (N6):** `COMPLIANCE_KINDS` in the cron (N6 EMAIL-PIPELINE, after DC P5 releases the file).
- ✓ The type-level exhaustiveness check (`satisfies Record<NotificationKind, KindMeta>`, plus the hook's `never` guard).
- **Not done (N3):** a test that the bell icon and the feed icon are the same component — it lands when both derive from `icon`.

**Scope / residual.** Per the fleet plan, record RESOLVED when N6 merges (acceptance 1 needs all seven maps). N5 seeds its `notification_kinds` table from `NOTIFICATION_KINDS` / `KIND_META`; N8 and N9 add their kinds here.

**Partial (2026-10-07, notifications Round G).** Package N6 EMAIL-PIPELINE-AND-CRON landed the cron's limb: `app/api/cron/maintenance/route.ts` `COMPLIANCE_KINDS` is derived from `KIND_META`'s `compliance` column (`(Object.keys(KIND_META)).filter((k) => KIND_META[k].compliance)`, :740) — the hand list is gone; the set is unchanged (`lib/__tests__/notificationKinds.test.ts` "compliance is the cron's COMPLIANCE_KINDS, unchanged" now pins the derivation and the set; `lib/__tests__/maintenanceDrain.test.ts` pins that no hand list remains). Done-when 2's remaining maps (`KIND_ICON`, `attentionVisual`, `KIND_GROUPS`, `isError`) and done-when 4 are N3's; the finding stays OPEN for them.

---

<a id="tax-6"></a>

## TAX-6 · The bell badge and the Notification Center are hard-capped at 50 unread notification rows, so a busy controller's true backlog is unreachable and unknowable

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:176`, `lib/inAppNotifications.ts:157-174`, `lib/inAppNotifications.ts:176-185`, `hooks/useTicketNotifications.ts:311-312`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The 50-row ceiling and the 'mark read → older rows page in → badge does not move' behavior are both real and confirmed. Downgraded to MEDIUM because the compliance backlog is NOT unknowable: lib/inbox.ts:249/309 computes an uncapped exact unread count, and /inbox renders dedicated, independently-sourced obligation lists — `data.reviewCyclesDueOnMe` (inbox/page.tsx:400), `data.distributionAcksPendingOnMe` (:416), `data.accessRecertsDue` (:430), plus listMyPendingAcks/listMyPendingReviews — so the actual PSM work items remain reachable outside the truncated bell feed.

**Mechanism.** `listMyNotifications({ onlyUnread: true, limit: 50, orgId })` applies `.limit(50)` server-side. `count` is then `items.length`, i.e. tickets + at most 50 notification rows. There is no pagination and no "N more" indicator - `AttentionFeed`'s "Show 30 more" only paginates within the 50 already fetched. `countUnread()` exists in lib/inAppNotifications.ts:176-185 and would give the true number, but the hook never calls it.

**Failure scenario.** After a bulk publish fans `ack_requested` out to 30 people and the nightly compliance scan adds `review_due` rows, a DocCtrl accumulates 180 unread rows. The bell shows 50-ish and stops moving. Marking items read makes the badge stay at the same number (older rows page in), which reads as a broken counter; more importantly the user has no way to see, or even learn the existence of, rows 51-180.

**Evidence.**

```
hooks/useTicketNotifications.ts:176 -- `let n = await listMyNotifications({ onlyUnread: true, limit: 50, orgId: activeOrgId })`

lib/inAppNotifications.ts:164 -- `.limit(opts?.limit ?? 50);`

hooks/useTicketNotifications.ts:311-312 -- `/** The single count every surface badges (the header bell + Home). */\n    count: items.length,`
```

> **Verifier correction.** One addition that strengthens rather than weakens it: lib/inbox.ts:164 DOES compute a true `unreadNotificationCount` via `select("*", { count: "exact", head: true })`, exposed at :110/:309 — but `grep -rn unreadNotificationCount` shows it is consumed by nothing except a test fixture (lib/__tests__/nudges.test.ts:12). So there are two dead true-count paths, not one, and the real backlog is indeed never displayed.

**Done when.**

- [ ] The badge shows the true unread count (via `countUnread`) even when the list is paged
- [ ] The feed can page past 50 rows, or explicitly says "showing the newest 50 of N"
- [ ] Marking rows read monotonically decreases the badge

---

<a id="tax-7"></a>

## TAX-7 · "Unread" names three different quantities and one of them is a dead export; the same panel labels the same filter "unread" in code and "Activity" in the UI

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:252-256`, `hooks/useTicketNotifications.ts:305`, `hooks/useTicketNotifications.ts:313-315`, `components/cockpit/AttentionFeed.tsx:85-89`, `components/notifications/NotificationCenter.tsx:76-80`, `app/(protected)/inbox/page.tsx:72-77`, `components/dashboard/widgets.tsx:673-677`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on every leg. `unreadCount` is dead — repo-wide grep for `unreadCount` returns only its own definition and return in the hook, no consumer; the same is true of `countUnread` and of lib/inbox.ts's `unreadNotificationCount` (declared :110, computed :249, returned :309, referenced only by a test fixture), so there is in fact a fourth orphaned 'unread' quantity the finding did not name.

**Mechanism.** Three distinct "unread" concepts share the word. (1) `notifications.read_at IS NULL` - the DB truth, driving `listMyNotifications({onlyUnread:true})`. (2) `tickets.unread_by` - a per-ticket array feeding the hook's `unreadCount` (only tickets that are unread AND not action-required). (3) `counts.unread` - computed independently in three separate files as `items.filter(i => !i.actionRequired).length`, i.e. "everything that isn't an action item", which includes notification rows regardless of read state. The `AttnFilter` key is literally `"unread"` but its user-facing label is `"Activity"`. The hook's own `unreadCount` and `totalNotifications` exports are consumed by nothing - verified with two search shapes (`rg -i unreadcount` and `grep -rn unreadCount --include=*.ts --include=*.tsx`), both returning only the three definition lines inside the hook itself.

**Failure scenario.** An engineer reads the Center header "11 items", the Activity chip "7", and the sidebar Documents badge "3", and cannot reconcile them because "unread" silently changes definition between them. A developer adding a surface picks `unreadCount` off the hook (it reads like the right thing), gets a ticket-only number that disagrees with every visible badge, and ships a fourth count.

**Evidence.**

```
hooks/useTicketNotifications.ts:254-256 -- `const unread = !!uid && !!t.unreadBy?.includes(uid);\n      if (!actionReq && !unread) continue;\n      if (actionReq) ar++; else ur++;`

hooks/useTicketNotifications.ts:313-315 -- `    actionRequiredCount,\n    unreadCount,\n    totalNotifications: items.length,`

components/cockpit/AttentionFeed.tsx:85-89 -- `const FILTERS: Array<{ key: AttnFilter; label: string; n: number }> = [ { key: "all", label: "All", n: counts.all }, { key: "action", label: "Action", n: counts.action }, { key: "unread", label: "Activity", n: counts.unread }, ];`

components/notifications/NotificationCenter.tsx:76-80 -- `const counts = { all: items.length, action: items.filter((i) => i.actionRequired).length, unread: items.filter((i) => !i.actionRequired).length, };`
```

**Done when.**

- [ ] The `AttnFilter` key is renamed to match its label (`"activity"`), or the label to match the key
- [ ] `counts` is computed once in the hook and consumed identically by AttentionFeed, NotificationCenter, the inbox page and the dashboard widget (currently duplicated in three files)
- [ ] The unused `unreadCount` and `totalNotifications` exports are removed or given a single documented meaning
- [ ] A vocabulary note in the hook states the difference between DB-unread, ticket-unread and non-action "activity"

**Resolution (2026-10-01, notifications Round G).** **Reproduced first** on `b9cdfdc`: `counts` was computed three times (`NotificationCenter.tsx:76-80`, `inbox/page.tsx:73-77`, `widgets.tsx:672-676`), the filter key was `"unread"` under the label "Activity" (`AttentionFeed.tsx:22`, `:88`), and the TODAY test (`e595cf5`) showed the hook's `unreadCount` 0 with 51 non-action items in the feed (ticket-only). `totalNotifications` had no reader (repo grep).

**Fix (commit `95dbe50`; review fix `42d5df8`).** The hook computes `counts` `{ all, action, activity, notifications }` once and exports `AttentionCounts`; the Center (:55), the cockpit (`inbox/page.tsx:36`) and the dashboard widget (`widgets.tsx:665`) destructure it and recount nothing; `AttentionFeed` takes `counts: AttentionCounts`, and `AttnFilter` is `"all" | "action" | "activity"` (:24, key = label; the three filter arms renamed with it). `notifications` counts the feed's notification rows — what "Mark all read" clears — and `AttentionFeed` offers that button whenever it is non-zero, on any filter: the header bell's rule (`hasNotifRows`). On `b9cdfdc` the button followed the non-action count, so a feed of only action rows lost it on all three feed surfaces while the bell kept it, and an unread ticket — which mark-all cannot clear — showed it. `totalNotifications` is removed; `unreadCount` keeps its name with one documented meaning (= `counts.activity`); the hook's header carries the vocabulary note (DB-unread, ticket-unread, action vs activity — and `lib/inbox.ts`'s `unreadNotificationCount` named as a DB-unread head count).

- Files: `hooks/useTicketNotifications.ts`, `components/cockpit/AttentionFeed.tsx` (the type, the props, `FILTERS`, the mark-all condition — nothing else), `components/notifications/NotificationCenter.tsx`, `app/(protected)/inbox/page.tsx`, `components/dashboard/widgets.tsx`.
- Tests: `lib/__tests__/notificationKinds.test.ts` "counts are computed once", "the filter key matches its label", "the Center, the cockpit and the widget take counts from the hook and recount nothing", "'Mark all read' is offered whenever the feed holds a notification row" (renders `AttentionFeed`: shown for an action-only feed and under a filter that shows none of its rows, hidden for a ticket-only feed; fails on the old `counts.activity` rule).
- Verified: loop on `fleet/N2-kind-registry` at `95dbe50`: `npx tsc --noEmit` exit 0; `npx eslint` on the 14 changed code and test files `--max-warnings=0` exit 0; `npx vitest run --maxWorkers=2` (full suite) exit 0 — 349 files, 7298 passed, 5 expected-fail. (Two default-worker runs on a machine at load 25 on 4 CPUs each timed out two unrelated fuzz tests at the 5 s default — a different pair each time, each passing alone.) After the review fix (`42d5df8`): `npx tsc --noEmit` exit 0; `npx eslint --max-warnings=0` on the five changed code and test files exit 0; `npx vitest run` (full suite, default workers) exit 0 — 349 files, 7302 passed, 5 expected-fail. `next build` is the integrator's.

**Done-when.**
- ✓ The `AttnFilter` key is `"activity"`, matching its label.
- ✓ `counts` is computed once in the hook and consumed identically by AttentionFeed, NotificationCenter, the inbox page and the dashboard widget.
- ✓ `totalNotifications` is removed; `unreadCount` has one documented meaning (the feed's non-action items).
- ✓ A vocabulary note in the hook states DB-unread, ticket-unread and non-action activity apart.

**Scope / residual.** `lib/inbox.ts` `unreadNotificationCount` (the fourth quantity the verifier found) is named in the note and otherwise untouched (not this package's file). The Center gains its section filter with N3.

---

<a id="tax-8"></a>

## TAX-8 · Dismissals are not remembered, and one indicator actively un-dismisses itself when new work arrives - contradicting its own comment

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** notifications N9 DC-OWNED-PRODUCERS-AND-KIND-SPLIT (done-when 3's re-formed overlap: `lib/intents.ts` `recordIntent` resets `created_at` when it re-declares an expired row) — by the integrator, 2026-10-02, at the N7 merge (DEC-31; the sender-on-another-device half is `TAX-16`, same owner).
- **Verification:** CONFIRMED
- **Locations:** `components/providers/KnowledgeIndexIndicator.tsx:50-55`, `components/providers/KnowledgeIndexIndicator.tsx:91`, `components/documents/EditOverlapBanner.tsx:41-42`, `components/documents/EditOverlapBanner.tsx:133-137`, `components/ui/FirstRunHint.tsx:26-50`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Substance holds: both dismissals are ephemeral React state and the indexing card genuinely un-hides itself whenever the poll finds queued work. One imprecision worth recording — the comment at :50-55 ('new work must NOT re-expand a card the user deliberately tucked away') governs `minimized`, not `hidden`, and `minimized` is in fact never reset by the drain, so the code does not literally contradict that comment; it fails to extend the same stickiness to the Dismiss affordance.

**Mechanism.** `KnowledgeIndexIndicator` documents `minimized` as "Sticky across drain passes - new work must NOT re-expand a card the user deliberately tucked away", but the sibling `hidden` state is reset to `false` inside the drain loop the moment a new document is picked up, and neither flag is persisted. `EditOverlapBanner`'s `dismissed` and `nudged` are plain component `Set`s - cleared by any remount or navigation. Contrast `FirstRunHint`, the only surface in the app that persists a dismissal (localStorage, `first_run_hint:` prefix, hydration-safe via `useSyncExternalStore`).

**Failure scenario.** A DocCtrl dismisses the "Knowledge indexing caught up" card. The 2-minute poll finds one more queued PDF, `setHidden(false)` fires, and the card is back - for the rest of the day, on every page. Likewise a user dismisses the amber overlap banner on a document, navigates away and back, and the banner returns with the same "Send heads-up" button they already used, since `nudged` is also component state - so they can re-nudge the same colleagues repeatedly with no record that they already did.

**Evidence.**

```
components/providers/KnowledgeIndexIndicator.tsx:52-55 -- `// Sticky across drain passes - new work must NOT re-expand a card the\n  // user deliberately tucked away.\n  const [minimized, setMinimized] = useState(false);`

components/providers/KnowledgeIndexIndicator.tsx:91 -- `          setHidden(false);`

components/documents/EditOverlapBanner.tsx:41-42 -- `const [dismissed, setDismissed] = useState<Set<string>>(new Set());\n  const [nudged, setNudged] = useState<Set<string>>(new Set());`
```

> **Verifier correction.** The 'contradicting its own comment' framing is wrong. The comment at :52-55 ('Sticky across drain passes — new work must NOT re-expand a card the user deliberately tucked away') governs `minimized`, declared at :55, and `minimized` is in fact never reset in the loop — that contract is honored. The flag the loop resets at :91 is the sibling `hidden` (the X-dismiss), which has no such comment. So the defect is real (dismiss is undone by new work; nothing persists across reload) but it does not contradict the stated comment.

**Done when.**

- [ ] Every dismissible signalling surface persists its dismissal on the same substrate `FirstRunHint` uses (or a shared `useDismissed(key)` hook)
- [ ] `setHidden(false)` is removed from the drain loop, or the dismissal is scoped to the current run and documented as such
- [ ] "Heads-up sent" survives a remount (derived from the notification rows, not local state)

**Partial (2026-10-01, notifications Round G).** Done-when 1 and 2 are met; done-when 3 is met only for an overlap that has not re-formed before the daily prune (below), so the finding stays OPEN (N7 fourth review: it was marked RESOLVED). Reproduced on `b9cdfdc` (KnowledgeIndexIndicator `setHidden(false)` at :164; EditOverlapBanner `dismissed` / `nudged` component state at :41-42). New `hooks/useDismissed.ts` (`useDismissed`, `useDismissedSet`, `clearDismissals`) generalises FirstRunHint's substrate. It keys `dismissed:<uid>:<orgId>:<key>`, reads through `useSyncExternalStore` with a "dismissed" server snapshot (hydration-safe, as FirstRunHint), wraps every storage access (an in-memory copy holds when storage throws), and clears every key on sign-out. KnowledgeIndexIndicator uses it (see STACK-6). In `components/documents/EditOverlapBanner.tsx`:
- **An overlap** is the document, the set of people in it (`overlapKey`) and when it formed: the moment its last person joined, i.e. each person's earliest live edit intent and the latest of those (`overlapFormedAt`, from `DocumentIntent.createdAt`). Anything the banner remembers counts only if it happened after the overlap formed, so a new person joining is a new overlap. The same people overlapping again after it dissolved is a new overlap only after the lapsed intent rows are pruned by the maintenance cron (`app/api/cron/maintenance/route.ts` step 4, daily). Until then a re-declared intent reuses its row: `lib/intents.ts` `recordIntent` upserts on `(document_id, user_id, kind, source)` and keeps `created_at`, so the re-formed overlap keeps its old formed time, and the old dismissal or "Heads-up sent" mark still covers it (N7 third review; the first wording claimed the opposite).
- **Dismiss** persists per overlap, stamped with the overlap's formed time (`overlapMark`, `overlapMarkAt`), which is a server timestamp. The first version stamped the browser's `Date.now()` and compared it with the server's `created_at`. On a PC whose clock ran behind, a dismissal or a send made soon after the overlap formed predated "formed" and never counted (N7 second review). Stamping the formed time compares server clock against server clock. The same people overlapping again later form later once the lapsed rows are pruned, so an old mark does not cover that overlap; before the prune it does (above).
- **"Heads-up sent ✓" from the rows.** It is derived from the `overlap_advisory` rows the viewer can read: addressed to the viewer, about the document, from someone in the overlap, within 14 days (`OVERLAP_HEADSUP_WINDOW_DAYS`) — and, since the review fix, sent after the overlap formed. A heads-up sent before the newest person joined never reached them, so the button is offered again. (The first version matched any advisory from anyone in the overlap in the window: when Sam joined after Pat's heads-up, the banner said "Heads-up sent" and hid the button although Sam was never told.)
- **The viewer's own send** is remembered for the overlap on the same substrate, stamped the same way, under the same rule. `notifyMany` skips the actor, and `notifications_own_select` (`20260723_notifications_unify.sql:37`) shows only rows addressed to the reader, so a heads-up the viewer sent cannot be read back from the client.

The `notifyMany` write is unchanged. Tests: `lib/__tests__/cornerJobs.test.ts` "TAX-8 — EditOverlapBanner…" ("Heads-up sent" from a received row, with the query's filters asserted; the viewer's send and the dismissal survive a remount; a new person shows it again), "TAX-8 (review fix) — 'Heads-up sent' counts only a heads-up sent after the overlap formed" (`overlapFormedAt`; an advisory from Pat dated before Sam's intent leaves the button offered; one dated after shows "Heads-up sent"; a send and a dismissal from an earlier overlap of the same two people do not carry over to the one live now; a new send is stamped with the live overlap's formed time), "TAX-8 (N7 review) — marks never mix the browser's clock with the server's" (`overlapMarkAt`; on a PC whose clock runs 3 minutes behind, a sent heads-up and a dismissal still stick across a remount — fails against the `Date.now()` stamps), "TAX-8 (N7 third review) — a re-formed overlap is new only once its lapsed intent rows are pruned" (pins `recordIntent`'s upsert, which never sends `created_at`, and the cron's prune; a mark stamped with the old formed time covers the overlap re-formed on the kept row, and not one re-formed on a fresh row) and the `useDismissed` suite.

**Done-when.**
- ✓ Every dismissible surface the finding names persists its dismissal on a shared `useDismissed` hook, FirstRunHint's substrate. The other dismissible banners found (StaleCheckoutBanner, SetupChecklist) already persist on their own keys; toasts and upload cards are transient by design.
- ✓ `setHidden(false)` is removed from the drain loop.
- Partial — NOT met as written. "Heads-up sent" survives a remount: derived from the notification rows wherever the viewer can read them, and counted only if sent after the overlap formed (after its newest person joined). That is correct for a first overlap and for one re-formed after the daily prune. It is not correct for the same people overlapping again before the prune: the re-declared intents keep their old `created_at`, the overlap keeps its old formed time, and an advisory from the earlier episode (inside the 14-day window) shows "Heads-up sent ✓" and hides the button although nobody was told about this one; an old dismissal hides the warning the same way. On `b9cdfdc` "sent" was never remembered, so it could never be false. The viewer's own send is per-browser, because RLS keeps sent rows from the sender — the cross-device remainder is opened as `TAX-16`.

**Scope / residual.** `TAX-16` (a sender's own heads-up from another device; it needs a server read of rows one sent, after N5's server-side notification route). A re-formed overlap between the same people counts as new only after the daily prune of lapsed intent rows: until then it keeps its old formed time, and an old dismissal or "Heads-up sent ✓" still covers it, the latter for an episode nobody was told about. Hand-off to `lib/intents.ts`'s owner (not this package's file): reset `created_at` when `recordIntent` re-declares an expired row, for example by deleting the expired row before the upsert; the test above then needs its pin updated. That is the remaining step: with it, done-when 3 is met and this finding can close. The banner's 14-day advisory window was not cut to the edit intent's 24-hour lifetime as a stopgap: a re-formation inside a day would still read "sent", and an overlap kept alive by renewed intents for longer than a day would lose a true "sent". No migration.

---

<a id="tax-9"></a>

## TAX-9 · In-app notifications have no preference gate, no throttle and no cap - `inapp_enabled` is stored but read by nothing, and a cron burst produces an unbounded toast stack

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260723_notifications_unify.sql:86`, `lib/notify/dispatch.ts:89-103`, `lib/inAppNotifications.ts:79-98`, `components/providers/ToastProvider.tsx:40-49`, `components/ui/CornerDock.tsx:25`, `app/(protected)/settings/notifications/page.tsx:7-9`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Every leg verified: no in-app preference gate, no throttle, no toast cap, and the dock cannot scroll or clip a tall stack. NotificationListener.tsx:80-100 fires one showToast per realtime INSERT with no coalescing, so an N-row cron burst does produce N stacked cards.

**Mechanism.** `emit()` gates the email channel through `queueEmail`, which reads `notification_preferences`. The in-app branch calls `notifyMany` unconditionally - `notify()` does a bare INSERT with no preference lookup. `inapp_enabled` (added by the unify migration "the unified dispatcher honors") is read nowhere (verified with `grep -rn inapp_enabled --include=*.ts --include=*.tsx` -> zero app hits; `rg` over all globs -> only the migration and schema.sql). `NotificationListener` then toasts EVERY inserted row for the user with no kind filter and no rate limit, and `ToastProvider.showToast` appends without a cap into a `CornerDock` that has no `max-height` and no `overflow`.

**Failure scenario.** The nightly maintenance cron inserts 40 compliance rows (`review_due`, `ack_overdue`, `retention_eligible`, ...) for a DocCtrl who happens to have the tab open. Supabase realtime delivers 40 INSERTs; `NotificationListener` calls `showToast` 40 times; `ToastProvider` renders 40 stacked cards in a fixed bottom-right column with no scroll. The stack runs off the top of the viewport, covers the page, and there is no bulk dismiss. No setting turns this off - the settings page says "In-app bell notifications are always on."

**Evidence.**

```
lib/notify/dispatch.ts:89-91 -- `if (channels.includes("inapp")) {\n    await notifyMany({` (no preference read)

lib/inAppNotifications.ts:80-93 -- `try {\n    const { error } = await supabase.from("notifications").insert({ ... });` (no preference read)

components/providers/ToastProvider.tsx:42 -- `setToasts((prev) => [...prev, { id, type, title, message, duration }]);`

components/ui/CornerDock.tsx:25 -- `className="fixed bottom-4 right-4 z-[300] flex flex-col items-end gap-2 pointer-events-none max-w-[calc(100vw-2rem)]"` (no max-height, no overflow)
```

> **Verifier correction.** Two overstatements. (1) The unify migration's actual comment is 'Per-channel preference switches for the unified dispatcher' — the finding presents 'the unified dispatcher honors' inside quotation marks, which is a paraphrase, not the file's text. (2) The cited settings page is a mitigation, not corroboration: app/(protected)/settings/notifications/page.tsx:7-9 states 'In-app bell notifications are always on — they're the persistent inbox; the email side is the opt-in noise layer', and its `Prefs` interface (:23-31) exposes only email_* toggles. So no user is ever promised an in-app toggle; `inapp_enabled` is a dead column, not a broken promise. Also, toasts self-remove after their duration (ToastProvider.tsx:44-48, 5-6s), so the stack is bounded by arrival rate within that window rather than truly unbounded. Severity lowered to MEDIUM accordingly; the substantive defect is the missing throttle/cap on a burst, which stands.

**Done when.**

- [ ] `emit()`'s in-app branch honors `inapp_enabled` (or the column is dropped)
- [ ] `ToastProvider` caps the visible stack (e.g. 3-4) and collapses the remainder into a "+N more" that opens the Notification Center
- [ ] `CornerDock` has a `max-h` with `overflow-y-auto` so the stack can never exceed the viewport
- [ ] `NotificationListener` does not toast bulk/system-generated kinds one-per-row; batched inserts produce one summary toast

---

<a id="tax-10"></a>

## TAX-10 · Nothing below the sidebar consumes the attention feed, so a badge can never propagate library -> folder -> document; and the one "poke a person" act has three names, none reachable from a drafting request

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:134`, `components/documents/EditOverlapBanner.tsx:79-97`, `components/documents/DistributionRecall.tsx:48-56`, `lib/staleCopies.ts:182-208`, `lib/orchestrator/tools.ts:505-515`, `app/(protected)/requests/[id]/page.tsx`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves confirmed. All four nudge paths require a document_id (the orchestrator tool at tools.ts:495 loads `d.document_number` / `d.library_id` before emitting), so none is reachable from a ticket stuck at PENDING_FINAL_APPROVAL.

**Mechanism.** `useTicketNotifications` is imported by exactly six files - Sidebar (:124), NotificationBell (:54), NotificationCenter (:55), dashboard widgets (:669 and :1223), and the inbox page (:38). Verified with two search shapes (`rg -n useTicketNotifications --glob '*.ts' --glob '*.tsx'` and `grep -rn useTicketNotifications --include=*.tsx`). No documents page, library page, folder tree, FileExplorer, request list or project page reads it, so no surface below the nav rail has the data to render a badge - the chain is not broken, it was never built. (As a side effect three to five copies of the hook mount simultaneously, each opening its own realtime channel and re-running the full up-to-500-row ticket fetch on every org-wide ticket or notification change.) Separately, three distinct implementations of "poke a specific colleague" exist under three names - `sendHeadsUp` (EditOverlapBanner, copy "Send heads-up"/"Heads-up sent", kind `overlap_advisory`), `nudgeStaleHolders` (copy "Recall sent to N people", kind `doc_superseded`), and the orchestrator's `notify_personnel` tool (title "About <docnum>", kind `orchestrator_message`). `rg -i 'nudge|remind|poke|heads.?up'` over app/(protected)/requests/[id]/page.tsx returns nothing.

**Failure scenario.** A user sees the red 3 on Drafting Requests, clicks through to /requests, and the list renders no per-row marker sourced from the feed - they must eyeball statuses to find which three. Inside a request stuck at PENDING_FINAL_APPROVAL there is no way to prod the assigned engineer, even though the app already has three working person-to-person notify paths elsewhere, each named differently.

**Evidence.**

```
hooks/useTicketNotifications.ts:134 -- `export function useTicketNotifications() {` (consumers: Sidebar.tsx:124, NotificationBell.tsx:54, NotificationCenter.tsx:55, widgets.tsx:669, widgets.tsx:1223, inbox/page.tsx:38)

components/documents/EditOverlapBanner.tsx:125-126 -- `<BellRing className="w-3 h-3" /> Send heads-up`

components/documents/DistributionRecall.tsx:105 -- `<CheckCircle2 className="w-3.5 h-3.5" /> Recall sent to {nudgedCount} {nudgedCount === 1 ? "person" : "people"}`

lib/orchestrator/tools.ts:509-511 -- `kind: "orchestrator_message",\n      title: `About ${d.document_number}`,`
```

> **Verifier correction.** The second half is materially overstated on two points and must not be acted on as written. (1) A person-to-person poke IS reachable from a drafting request: app/(protected)/requests/[id]/page.tsx:15 imports MentionableTextarea and renders it at :2052 in the comment composer; :1216 calls `extractMentionUids(text)` and :1235-1237 POSTs to /api/tickets/comment, which at route.ts:272 writes `kind: mentionSet.has(uid) ? "ticket_mention" : "ticket_comment"` — bell + email fan-out to the named engineer. So there are four poke implementations, not three, and the fourth lives exactly where the finding says none exists. The accurate complaint is that there is no *dedicated* nudge affordance on a request awaiting approval (the `rg -i 'nudge|remind|poke|heads.?up'` result of zero on that file is correct), only an @-mention buried in the comment box. (2) The hook's realtime subscription for notifications is filtered `user_id=eq.${uid}` (hook :225), not org-wide — only the tickets channel (:223) is org-wide, so 'every org-wide ticket or notification change' should read 'every org-wide ticket change, or any of my own notification changes'.

**Done when.**

- [ ] A `useAttentionFor(section | resourceId)` selector lets a library row, folder row and document row each render the count of feed items whose `resourceId` matches
- [ ] Opening a badged library shows the badged folder; opening that folder shows the badged document
- [ ] The feed is fetched once per page (context/provider) rather than once per mounted consumer
- [ ] One named person-to-person action ("Nudge") with one component and one kind replaces the three ad-hoc implementations, and is available from a drafting request's approval step targeting the assigned engineer

---

<a id="tax-11"></a>

## TAX-11 · Notification kinds are written that do not exist in the `NotificationKind` union - they get no icon, no section, and no classification anywhere

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** notifications N8 PRODUCERS-FREE (done-when 2: the eleven raw inserts onto notify(), each file once its own package has merged; the census stays a ratchet, not ratified as the ban) — by the integrator, 2026-10-02, at the N5 merge (DEC-31; fleet plan `audit-reports/fleet-plans/notifications.json`).
- **Assigned:** notifications N14 RAW-INSERT TAIL (done-when 2's sites whose owning package was still in flight when N8 launched: `app/api/ai/usage/route.ts` and `lib/orchestrator/tools.ts` (intelligence I-18), `app/api/cron/maintenance/route.ts` (N6), `app/api/tickets/comment/route.ts` and `app/api/tickets/workflow-action/route.ts` (drafting-flow DF-P1); N8 keeps the rest) — by the integrator, 2026-10-07, at N8's launch (DEC-31; fleet plan `audit-reports/fleet-plans/notifications.json`).
- **Verification:** CONFIRMED
- **Locations:** `lib/storageAlerts.ts:56-65`, `lib/storageUsage.ts:250-258`, `lib/inAppNotifications.ts:10-58`, `supabase/migrations/20260621_in_app_notifications.sql:17`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified end to end — these kinds miss KIND_ICON (NotificationBell.tsx:166 falls back to `Bell`), fall through sectionForKind's default to 'other' (which no sidebar row badges), and match no KIND_GROUPS predicate, so groupOf() returns 'other' and no chip is rendered for them (AttentionFeed.tsx:144-158 only maps KIND_GROUPS).

**Mechanism.** `notifications.kind` is untyped `TEXT` in SQL with no CHECK constraint. Two producers bypass `notify()`/`notifyMany()` entirely and insert raw rows with kinds absent from the TypeScript union: `storage_alert` (lib/storageAlerts.ts) and template-built `storage_platform_r2` / `storage_platform_db` (lib/storageUsage.ts, `kind: \`storage_${alert.key}\``). Because they are not in the union, they miss `KIND_ICON`, miss every `sectionForKind` case, miss `KIND_GROUPS` (no substring predicate matches "storage_"), miss `actionKinds`, and miss `COMPLIANCE_KINDS`. TypeScript cannot catch it because the insert is an untyped object literal against an untyped column.

**Failure scenario.** Storage crosses 90%. Every Admin gets a row titled "Storage critical - 96% full". In the bell it renders with a generic `Bell` icon; in the Notification Center's group chips it matches no group, so it lands in the hidden 'other' bucket with no chip and cannot be filtered to; no sidebar row badges. The most urgent infrastructure warning the product produces is the least visible one.

**Evidence.**

```
lib/storageAlerts.ts:60-63 -- `await sb.from("notifications").insert({\n        org_id: s.org_id, user_id: a.uid, kind: "storage_alert",\n        title: band === "crit" ? `Storage critical - ${pct}% full` : `Storage high - ${pct}% full`,`

lib/storageUsage.ts:255-257 -- `const { error } = await sb.from("notifications").insert({\n          org_id: org.id, user_id: a.uid, kind: `storage_${alert.key}`,`

supabase/migrations/20260621_in_app_notifications.sql:17 -- `  kind TEXT NOT NULL,                          -- ticket_comment | ticket_mention | ticket_status | checkout_conflict | project_member | hold_opened | ...` (no CHECK)
```

**Done when.**

- [ ] `storage_alert` / `storage_platform_*` are added to `NotificationKind` and classified in the shared registry
- [ ] Every insert into `notifications` goes through `notify()`/`notifyMany()` so the `NotificationKind` type is enforced at compile time
- [ ] A DB CHECK constraint (or a test scanning for raw `.from("notifications").insert`) prevents the next unclassified kind

**Partial (2026-10-01, notifications Round G).** **Reproduced first** on `b9cdfdc`, as `PROD-10` (the storage raw inserts). The producer census written for this package (`lib/__tests__/notificationKinds.test.ts`, the TypeScript parser over every payload-shaped object under `app/`, `lib/`, `components/`, `hooks/`) found two MORE kinds written outside the union since the audit: `ai_cap_changed` (`app/api/ai/usage/route.ts:639`) and `transmittal_unstampable` (`app/api/transmittal/route.ts:337`, TRX-15).

**What landed (commit `95dbe50`).** All five off-union kinds join the union and `KIND_META` at their behaviour on the base (bell-only, FYI, the feed's icon/tone/group). The two storage producers route through `notify()`'s typed insert (`PROD-10`). The census evaluates every payload's kind — literals, branches, module constants, literal-typed parameters and return types; a raw insert's non-literal kind must be resolved against the type that bounds it — and fails on a kind outside the union and on a declared kind nothing writes. Raw inserts are counted as CALLS (review fix `42d5df8`): every `.from("notifications").insert(` call per file, whatever its rows, pinned in `RAW_SITES` (eleven in nine files); the census fails on a new call, on a pinned call whose rows it could not evaluate (rows from a parameter or another file), and on a notifications builder that leaves its chain (`const t = sb.from("notifications")`). Before the fix it counted payload literals, so an `insert(rows)` whose rows were built elsewhere went uncounted and unchecked.

- Files: `lib/inAppNotifications.ts`, `lib/notificationKinds.ts`, `lib/storageAlerts.ts`, `lib/storageUsage.ts`.
- Tests: `lib/__tests__/notificationKinds.test.ts` "the producer census" (6 cases — "the insert CALLS left are pinned", and a probe that the census counts an insert whose rows it cannot see and catches an escaped builder; a temporary `insert(rows)` helper in `lib/` failed the pin when tried); `lib/__tests__/notificationKindStorageProducers.test.ts`.
- Verified: loop on `fleet/N2-kind-registry` at `95dbe50`: `npx tsc --noEmit` exit 0; `npx eslint` on the 14 changed code and test files `--max-warnings=0` exit 0; `npx vitest run --maxWorkers=2` (full suite) exit 0 — 349 files, 7298 passed, 5 expected-fail. (Two default-worker runs on a machine at load 25 on 4 CPUs each timed out two unrelated fuzz tests at the 5 s default — a different pair each time, each passing alone.) After the review fix (`42d5df8`): `npx tsc --noEmit` exit 0; `npx eslint --max-warnings=0` on the five changed code and test files exit 0; `npx vitest run` (full suite, default workers) exit 0 — 349 files, 7302 passed, 5 expected-fail. `next build` is the integrator's.

**Done-when.**
- ✓ `storage_alert` / `storage_platform_*` are in `NotificationKind` and classified in the shared registry (and so are `ai_cap_changed`, `transmittal_unstampable`).
- **Not done — partly:** "every insert into `notifications` goes through `notify()` / `notifyMany()`". The two this finding cites do. Eleven raw inserts remain, in nine files other packages own (DEC-31 / fleet rule): `app/api/ai/usage/route.ts` (intelligence), `app/api/cron/maintenance/route.ts` (N6), `app/api/data-export/run/route.ts` (admin-and-org), `app/api/tickets/comment/route.ts` and `workflow-action/route.ts` ×2 (drafting-flow / N6), `app/api/transmittal/route.ts` ×2 (document-control / N9), `lib/intakeRateLimit.ts` (projects), `lib/orchestrator/tools.ts` (intelligence), `lib/projects.ts` (document-control / N9). Their kinds are checked by the census meanwhile; each moves to `notify()` with its owner. *(Integrator, at the admin-and-org P3 merge, 2026-10-02: the admin-and-org site moved from `app/api/data-export/run/route.ts` to `lib/exportAlerts.ts`. It is still one raw service-role insert of `security_export`, and the census pins it in its new file. The count is unchanged.)*
- ✓ (the test arm) A test scanning the raw `.from("notifications").insert` calls — each call counted, whatever its rows — prevents the next unclassified kind; N5's `notification_kinds` allowlist adds the database arm.

**Scope / residual.** Stays OPEN for done-when 2's eleven sites; record RESOLVED when they route through `notify()` (or the integrator accepts the census + N5's allowlist as closing it).

**Partial (2026-10-07, notifications Round G).** Done-when 2, N8 PRODUCERS-FREE's share as narrowed by the integrator at N8's launch (the sites whose owning package had merged: `app/api/transmittal/route.ts` ×2, `lib/exportAlerts.ts`, `lib/intakeRateLimit.ts`, `lib/projects.ts`). **Reproduced first** on `f8d5eb5`: the census pinned eleven raw `.from("notifications").insert(` calls in nine files (`lib/__tests__/notificationKinds.test.ts` `RAW_SITES`).

**What landed.**
- `lib/inAppNotifications.ts` — `notifyChecked(input, client?)`: the typed insert takes an optional client (`NotifyClient`), so a server writer that holds its own (a service-role route, the cron's) writes through the typed sink instead of a raw insert; `notifyWithReason` answers the refusal's text too. Additive: `notify()` and every existing call are unchanged.
- **Moved onto the typed sink (3 calls):** the transmittal portal's issuer notice of an unstampable PDF (`notifyWithReason(…, supabaseAdmin)`; the refusal is still logged with its reason — TRX-15's pin) and its acknowledgment receipt (`notifyChecked(…, supabaseAdmin)`), both in `app/api/transmittal/route.ts`; the checkout sweep's holder notices in `lib/projects.ts` `autoReleaseExpiredAdHoc` (on the sweep's own client — the RLS client in the browser, the cron's service-role client — the same row as the one-statement insert wrote; first landed as one `notifyChecked(…, db)` per holder, an unbounded `Promise.all` of single-row requests whose failures were each only logged — the review fix makes it `notifyBatchChecked(rows, db)`, ONE statement per batch of released sessions, all land or none, as the raw insert did, and the sweep logs when holders were not told).
- `lib/inAppNotifications.ts` `notifyBatchChecked(inputs, client?)` (review fix): the typed insert for many rows in one statement, answering how many landed (all, or 0 on a refusal — logged); `notifyWithReason` and it share one row mapper (`notificationRow`), so the row a batch writes is the row a single notice writes.
- **Stay raw (2 calls), each with its reason and a proof the census checks** (`RAW_RESOLVED` `why`): `lib/exportAlerts.ts` — a service-role writer with no session (a scheduled push names no actor) whose alert is ONE checked statement the export run records the outcome of (DEC-87); per-recipient `notify()` calls log and swallow each failure and land partially. `lib/intakeRateLimit.ts` `deliverFoldedDigest` — the cron's folded digest: ONE all-or-none statement whose landed count gates the flush marker (INTK-10 / SEC-8); `notify()` / `emit()` swallow failures, so a marker would be written for a digest nobody got.
- `RAW_SITES` shrinks from eleven calls in nine files to eight in seven; a new census test pins every remaining file as either kept-for-a-reason or N14's.
- Tests: `lib/__tests__/notificationKinds.test.ts` ("the insert CALLS left are pinned", "TAX-11 done-when 2 (N8)…" — the sweep's pin is now `notifyBatchChecked(released.map(…), db)`); `lib/__tests__/notificationWriteRails.test.ts` (the created_at census examines the raw sites and the sink's two inserts); `lib/__tests__/transmittalPortalRoute.test.ts`, `checkoutRoundF.test.ts`, `projects.test.ts` — the sweep writes ONE notifications insert for its holders (two holders, one statement), every assertion on the row's content kept (REGRESSION); `lib/__tests__/producers.test.ts` "TAX-11 … notifyBatchChecked" (three rows, one insert call, the typed row shape, the count; a refusal lands none and answers 0; nothing to send sends nothing).
- Verified: Loop on `fleet/N8-producers-free` at `3dd10b8`: `npx tsc --noEmit` exit 0; `npx eslint` on the 27 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exit 0 — 435 files, 9480 passed, 7 expected-fail. `next build` is the integrator's.

**Done-when.**
- ✓ (unchanged) the storage kinds are in the union and the registry.
- **Not done — partly:** "every insert into `notifications` goes through `notify()` / `notifyMany()`". N8's five sites: three moved, two stay raw for the recorded reasons above. The five sites whose owners were still in flight at N8's launch — `app/api/ai/usage/route.ts` and `lib/orchestrator/tools.ts` (intelligence I-18), `app/api/cron/maintenance/route.ts` (N6), `app/api/tickets/comment/route.ts` and `app/api/tickets/workflow-action/route.ts` ×2 (drafting-flow DF-P1) — are **notifications N14 RAW-INSERT TAIL**'s (the second Assigned line), untouched here.
- ✓ (unchanged) the census test arm, now with the kept sites' reasons pinned.

**Scope / residual.** Stays OPEN for N14's five files (six calls). For the two kept raw sites, done-when 2 as written is met only if the integrator accepts the recorded reasons (a checked single statement whose error text the caller records); the batch variant those reasons asked for now exists (`notifyBatchChecked` — one statement, `client` given, answers the landed count, but not the refusal's text), so moving them onto it (adding the reason to its answer if their callers must keep recording it) is the follow-up, owner N14. *(Superseded by fix pass 2 below. N8 moved both sites itself; they were N8's by the narrowed assignment, and N14's Assigned line never covered them. The claim that `notifyBatchChecked` "answers the landed count" was also overstated, and is corrected below.)*

**Partial (2026-10-07, notifications Round G — N8 fix pass 2).** The second review raised two findings on this record:
- **The count was overstated.** `notifyBatchChecked` returned the number of rows SENT. The insert rail (20261160 rule 5) skips a browser's row for a recipient who is not an active member (RETURN NULL; the statement still succeeds), so the checkout sweep's "NOT told" warning never fired for a suspended holder.
- **N8's two raw sites were handed to N14 with no owner.** The export alert's recorded reason ("per-recipient `notify()` calls land partially") had stopped holding once a one-statement batch sink existed.

**What landed.**
- `lib/inAppNotifications.ts`:
  - `notifyBatchWithReason(inputs, client?)` (:173) is ONE typed insert of every row on the given client. It answers `{ landed, error? }`. `landed` is the count the DATABASE gives for the statement (`insert(rows, { count: "exact" })`), so a row the rail skips is not counted. It also answers the refusal's text.
  - `notifyBatchChecked` (:155) is now its `landed` alone.
  - The count rides the insert, not a read-back. The reviewer's suggested `.insert(rows).select("id")` is a RETURNING. The own-rows SELECT policy (`notifications_own_select`, 20261161) refuses RETURNING for a row addressed to someone else, which is exactly what the browser sweep writes, so the whole statement would fail. `lib/dataRestore.ts` already counts written rows the same way, with `count: "exact"`.
  - A client that answers no count is taken at the statement's word. No production client does this: PostgREST counts every insert it is asked to.
- `lib/projects.ts` `autoReleaseExpiredAdHoc` logs how many holders were not told (":n of :m holder(s) were NOT told", :2083), including holders the rail skipped.
- **The export alert moved onto the sink.** `lib/exportAlerts.ts` `alertControllers` now writes through `notifyBatchWithReason(…, admin)` (:75), on the service-role client it holds. It stays ONE statement, the kind is now checked by the compiler, `error` keeps the refusal's text for the run's diagnostics (DEC-87), and `notified` is the database's count.
- **The folded intake digest moved onto the sink.** `lib/intakeRateLimit.ts` `deliverFoldedDigest` now writes through `notifyBatchWithReason(…, client)` (:483). It stays ONE statement on the cron's service-role client. A refusal still throws ("the digest's notices were refused: …"), so the flush writes no marker, and the landed count that gates the marker (INTK-10 / SEC-8) is the database's.
- **The census.** `lib/__tests__/notificationKinds.test.ts`:
  - `RAW_SITES` shrinks to six calls in five files, all N14's. The `RAW_RESOLVED` `why` entries are gone, and the "TAX-11 done-when 2 (N8)" test now requires that no raw site is kept for a reason.
  - It pins both moved call shapes (`notifyBatchWithReason([...recipients].map(…), admin)`, `notifyBatchWithReason(d.involved.map(…), client)`) and their refusal handling.
  - The census still resolves both kinds through the typed payloads (`security_export`; `doc_superseded` / `review_requested` through `foldedDigestKind`'s literal return type).
- **The created_at census.** `lib/__tests__/notificationWriteRails.test.ts` now examines six raw calls plus the sink's two inserts (at least 8).
- **The fake client.** `lib/__tests__/helpers/fakeSupabase.ts` answers an insert's `{ count: "exact" }` with the rows the statement wrote, so a row dropped by a transcribed BEFORE INSERT trigger is not counted. The change is additive.
- Tests:
  - `lib/__tests__/producers.test.ts` "TAX-11 … answers the rows that LANDED". The rail is transcribed as a trigger that drops a non-member's row: two rows sent, one counted. There is ONE insert call with `{ count: "exact" }` and no `.select()`. `notifyBatchWithReason` answers `{ landed: 0, error }` on a refusal.
  - `lib/__tests__/intakeDoorLibs.test.ts` (the digest: one row per recipient in ONE statement, the count, a refusal throws) and `lib/__tests__/dataExportRoutes.test.ts` (the export alerts) are unchanged and green (REGRESSION).
- Verified: Loop on `fleet/N8-producers-free` for fix pass 2 (all of N8's second-review fixes: `PROD-2`, `PROD-6`, `PROD-11`, this record, projects-tab `MON-11`): `npx tsc --noEmit` exit 0; `npx eslint` on the 13 changed code and test files `--max-warnings=0` exit 0; `npx vitest run` (full suite) exited **1** on all three full runs. The machine's load average was 16–28 on 4 cores. Every failure was a 5-second test timeout in a file this pass does not change, or in a census case that walks the whole source tree:
  - the `dependencies` fuzz;
  - `notificationWriteRails`' link census;
  - `notificationDispatchMembership`'s REASON_IN_TITLE census;
  - `customSkillRunner`'s 1.5 s stall case;
  - `dcRoundFOwnerStamp`;
  - `dcRoundFShareInventory`.
  The last run used `--maxWorkers=2` and ended with 433 of 436 files passing: 9,503 passed, 3 timed out, 7 expected-fail. Each failing file passes when run alone (dependencies 45/45, notificationWriteRails 79/79, notificationDispatchMembership 24/24, customSkillRunner 18/18, dcRoundFOwnerStamp 16/16, dcRoundFShareInventory 18/18). Every file this pass touches is green, both alone and in the full runs: the producer files, the censuses, intake, data export, checkout, projects and the schedule suites. `next build` is the integrator's.

**Done-when.**
- ✓ (unchanged) The storage kinds are in the union and the registry.
- **Not done — partly:** "every insert into `notifications` goes through `notify()` / `notifyMany()`", or through the typed sink they share, which carries the same compile-time `NotificationKind` check.
  - **N8's share is now met.** All five of N8's sites write through the typed sink: the transmittal portal's two, the checkout sweep's, the export alert's and the folded digest's. No raw site is kept by reason.
  - **What is left is N14's.** Six raw calls remain, in the five files the second Assigned line gives notifications N14 RAW-INSERT TAIL: `app/api/ai/usage/route.ts`, `lib/orchestrator/tools.ts`, `app/api/cron/maintenance/route.ts`, `app/api/tickets/comment/route.ts`, and `app/api/tickets/workflow-action/route.ts` ×2.
- ✓ (unchanged) The census test arm.

**Scope / residual.** Stays OPEN only for N14's five files (six calls). For a service-role writer that must report what landed, the batch sink (`notifyBatchWithReason`) is now the way onto the typed path.

---

<a id="tax-12"></a>

## TAX-12 · OS-level notification presence is a fully built shell with zero wiring: the service worker handles `push`, the `push_subscriptions` table and RLS exist, `push_enabled` is a stored preference - and nothing subscribes or sends

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `public/sw.js:226-240`, `public/sw.js:241-259`, `supabase/migrations/20260804_push_subscriptions.sql:1-36`, `supabase/migrations/20260723_notifications_unify.sql:85-87`, `lib/notify/dispatch.ts:20`, `components/pwa/ServiceWorkerManager.tsx:30-51`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed with no mitigation found: nothing calls registration.pushManager.subscribe, no VAPID key exists anywhere, no sender writes to the Web Push endpoint, and settings/notifications/page.tsx's Prefs (:24-31) omits push_enabled entirely. lib/schemaExpectations.ts:99 additionally makes the health check demand a table for a feature that has no client or server half.

**Mechanism.** `public/sw.js` registers a `push` listener that calls `self.registration.showNotification(...)` and a `notificationclick` listener that focuses/opens the target URL - the entire receive side is done. `push_subscriptions` (endpoint, p256dh, auth, last_reminded_at) exists with per-user RLS and a comment saying "The reminder cron (service role) reads every row". But no code calls `pushManager.subscribe`, no code inserts into `push_subscriptions`, no VAPID key appears anywhere, and no code sends web-push. Verified with three search shapes (`rg -niE 'web-?push|pushManager|requestPermission|showNotification'` over ts/tsx; `grep -rn push_subscriptions --include=*.ts --include=*.tsx`; `grep -rniE 'vapid'` over ts/tsx/sql/json/mjs): the only ts/tsx hits for `push_subscriptions` are lib/schemaExpectations.ts:99, lib/exportTables.ts:167 and lib/dataRestore.ts:92 - schema bookkeeping, never a read or write. `NotifChannel` in the dispatcher is only `"inapp" | "email"`.

**Failure scenario.** A user closes the tab. Nothing can reach them - no OS banner, no badge, no sound. The `push_enabled` toggle they'd expect isn't even rendered on /settings/notifications. The one place the app claims otherwise is the sw.js comment "fires whether the app is open or closed", which is currently false.

**Evidence.**

```
public/sw.js:226-239 -- `self.addEventListener("push", (event) => { ... event.waitUntil(self.registration.showNotification(title, options)); });`

supabase/migrations/20260804_push_subscriptions.sql:4-5 -- `-- One row per browser/device the user opted in from. The reminder cron\n-- (service role) reads every row; users manage only their own via RLS.`

supabase/migrations/20260723_notifications_unify.sql:85-87 -- `ALTER TABLE notification_preferences\n  ADD COLUMN IF NOT EXISTS inapp_enabled BOOLEAN NOT NULL DEFAULT TRUE,\n  ADD COLUMN IF NOT EXISTS push_enabled  BOOLEAN NOT NULL DEFAULT TRUE;`

lib/notify/dispatch.ts:20 -- `export type NotifChannel = "inapp" | "email";`
```

> **Verifier correction.** Severity lowered HIGH->MEDIUM. Nothing is broken by this — it is an unbuilt feature plus scaffolding whose comments assert a sender that does not exist. The user-facing consequence is zero today; the real cost is the misleading migration comment and the unused `push_enabled` column. Worth noting for the owner's complaint #2 that the receive half genuinely is done, so the remaining work is subscribe + VAPID + a sender.

**Done when.**

- [ ] A client-side opt-in calls `Notification.requestPermission()` + `registration.pushManager.subscribe({applicationServerKey})` and POSTs the subscription into `push_subscriptions`
- [ ] A server sender (VAPID keys in env) reads `push_subscriptions` and delivers for a defined subset of kinds
- [ ] `NotifChannel` gains `"push"`, `emit()` honors `push_enabled`, and /settings/notifications renders the toggle
- [ ] Revoked/410 endpoints are pruned from `push_subscriptions`

---

<a id="tax-13"></a>

## TAX-13 · Single kinds carry contradictory meanings: `checkout_released` means both "yours was taken" and "someone else's is stale"; `doc_superseded` means three different things

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/checkoutEpisodes.ts:670-672`, `app/api/cron/maintenance/route.ts:344-353`, `lib/staleCopies.ts:195-207`, `app/api/intake/upload/route.ts:349-351`, `app/api/cron/maintenance/route.ts:370-373`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and understated if anything: doc_superseded has eight distinct producers carrying at least four unrelated meanings, and checkout_released has three (checkoutEpisodes force-release, the cron stale-checkout escalation, and lib/projects.ts:1107). Nothing downstream can tell them apart — kind is the only discriminator any icon, tone, section or future mute/push filter has.

**Mechanism.** `kind` is the only routing/classification key the six taxonomies have, so overloading it makes every downstream decision wrong for at least one of the meanings. `checkout_released` is written both by `forceRelease` (title "Your checkout was force-released", audience = the victim) and by `escalateStaleCheckouts` (title "Checkout held N days - review needed", audience = Admin/DocCtrl about someone else). Both are flagged `actionRequired` by `actionKinds` and drawn with the same `Lock` icon. `doc_superseded` is written by the real supersede path, by `nudgeStaleHolders` as a manual recall (`metadata: { recall: true }`), and by the intake auto-publish path - and the cron's own comment admits "Manual distribution-ack requests/re-nudges ride on doc_superseded".

**Failure scenario.** An Admin's bell shows two orange "Action needed" rows with a padlock icon. One means "your work was destroyed, coordinate before publishing"; the other means "go poke Bob about his old checkout". Nothing in the icon, the tone or the section distinguishes them. Any future filter, mute or push-channel rule keyed on `checkout_released` necessarily hits both.

**Evidence.**

```
lib/checkoutEpisodes.ts:670-671 -- `kind: "checkout_released",\n        title: "Your checkout was force-released",`

app/api/cron/maintenance/route.ts:346-347 -- `kind: "checkout_released",\n      title: `Checkout held ${days} days - review needed`,`

lib/staleCopies.ts:198-199 -- `kind: "doc_superseded",\n    title: `Your copy of ${input.docLabel} is out of date`,`

app/api/cron/maintenance/route.ts:370-372 -- `// Manual distribution-ack requests/re-nudges ride on doc_superseded (the\n  // daily scan's nags use ack_requested/ack_overdue); voided sign-offs are\n  // obligations too.`
```

> **Verifier correction.** If anything understated: doc_superseded has eight producer sites carrying at least five distinct meanings, not three.

**Done when.**

- [ ] Each distinct human meaning has its own kind (e.g. `checkout_force_released` vs `checkout_stale_escalation`; `doc_recalled` vs `doc_superseded`)
- [ ] No kind's meaning depends on inspecting `metadata` to disambiguate
- [ ] Each new kind is classified in the shared registry with its own icon, section and severity

---

<a id="tax-14"></a>

## TAX-14 · Three floating-signal corners and four z-layers; BackupIndicator (z-300) covers the offline/update pills (z-200) in the same bottom-left corner, and two separate surfaces both announce "a new version is available" in different words

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** notifications N7 CORNER (dw1, dw2 — the fleet plan); dw3 → `TAX-15` (after public-surfaces PKG-1); dw4 → notifications N13 LAYERS SWEEP (new) — by the integrator, 2026-10-02, at the N7 merge (DEC-31; fleet plan `audit-reports/fleet-plans/notifications.json`).
- **Verification:** CONFIRMED
- **Locations:** `components/ui/CornerDock.tsx:3-13`, `components/providers/BackupIndicator.tsx:27`, `components/pwa/ServiceWorkerManager.tsx:74-88`, `components/projects/UndoToastHost.tsx:21`, `components/system/UpdatePill.tsx:41-48`, `app/(protected)/layout.tsx`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed including simultaneous mounting: app/(protected)/layout.tsx:61-65 mounts UpdatePill, CornerDock, BackupIndicator and KnowledgeIndexIndicator; app/layout.tsx:93 mounts ServiceWorkerManager; UndoToastHost is mounted by components/projects/ExecutionView.tsx:926 — so the Projects → Execution scenario has all of them live at once, and the two different 'new version' wordings come from two independent detectors (a waiting service worker vs. a polled /api/version build id).

**Mechanism.** `CornerDock` declares itself "ONE bottom-right corner for every floating surface" at z-[300]; toasts, UploadIndicator and KnowledgeIndexIndicator portal into it. But `BackupIndicator` never imports `CornerPortal` - it pins `fixed bottom-5 left-5 z-[300] w-[340px]`. `ServiceWorkerManager` (mounted globally in app/layout.tsx) pins `fixed bottom-4 left-4 z-[200]` - the same corner, 1px offset, lower z, so the 340px backup card paints over it. `UndoToastHost` (mounted in components/projects/ExecutionView.tsx:926) pins `fixed bottom-4 left-1/2 -translate-x-1/2 z-[280]` - bottom-centre. Separately, `UpdatePill` (top-centre, z-[100], polls /api/version) and `ServiceWorkerManager` (bottom-left, watches the SW waiting worker) are two independent detectors of the same fact with two different wordings, mounted in two different layouts so both can be live at once.

**Failure scenario.** A DocCtrl on the Projects -> Execution tab starts a full backup after a deploy, on flaky site Wi-Fi. The backup card (z-300, bottom-left) covers the amber "Offline - showing cached data" pill and the "Update available - tap to refresh" button (both z-200, bottom-left); an undo toast appears bottom-centre (z-280); upload + index cards stack bottom-right (z-300); and five minutes later "This tab is running an old version" appears top-centre. Five signals, four corners, and two of them are invisible.

**Evidence.**

```
components/ui/CornerDock.tsx:3-4 -- `// CornerDock - ONE bottom-right corner for every floating surface.`

components/providers/BackupIndicator.tsx:27 -- `<div className="fixed bottom-5 left-5 z-[300] w-[340px] max-w-[calc(100vw-2.5rem)] rounded-2xl ...">`

components/pwa/ServiceWorkerManager.tsx:74 -- `<div className="fixed bottom-4 left-4 z-[200] flex flex-col gap-2 pointer-events-none">` and :87 -- `Update available - tap to refresh`

components/system/UpdatePill.tsx:41 -- `<div className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] animate-pop">` and :47 -- `This tab is running an old version - tap to load the update`

components/projects/UndoToastHost.tsx:21 -- `<div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[280] flex flex-col items-center gap-2 pointer-events-none">`
```

> **Verifier correction.** Minor line drift: the ServiceWorkerManager container is at :73 (not :74) and its copy at :86 (not :87). Also worth noting the overlap only materializes while a backup is actually running — BackupIndicator.tsx:22 returns null when there is no progress object — so it is a conditional occlusion, which is consistent with the MEDIUM rating.

**Done when.**

- [ ] Exactly two docks exist and are documented: one for transient/action feedback, one for long-running background jobs; no two globally-mounted surfaces share a corner with different z-index values
- [ ] `BackupIndicator` and `ServiceWorkerManager` share one left dock as flex children, or move into `CornerPortal`
- [ ] One component owns "a newer build exists", fed by both the version poll and the SW waiting-worker signal - one wording, one placement, one prompt at a time
- [ ] A single `Z` constant module owns every overlay layer number

**Partial (2026-10-01, notifications Round G).** Reproduced: Observed in Chromium (Playwright, `/opt/pw-browsers/chromium-1194`) against the real components of `b9cdfdc` and of `fleet/N7-corner`, rendered by a component harness (a vite build of the actual files; only the database, auth, the storage transport and `next/navigation` stubbed — the full page needs Supabase). With a backup running and the browser offline, the base backup card (bottom-left, z-300) covered the offline pill (8,160 px²). Now:
- **Two docks, documented.** The bottom-right `CornerDock` holds background jobs pinned nearest the corner, with transient messages above; the bottom-centre `CentreDock` holds in-page action feedback (the undo stack) above the return chip. Both are described in `components/ui/CornerDock.tsx`'s header and in `lib/zLayers.ts`.
- **The backup in the dock.** `BackupIndicator` renders through `CornerPortal` (STACK-8).
- **One layer module.** `lib/zLayers.ts` lists the layer numbers, enforced by a scan test (STACK-10).

Bottom-right now holds the corner dock alone, bottom-left ServiceWorkerManager's pills alone, top-centre UpdatePill. Bottom-centre holds the `CentreDock`, whose two slots keep the layers their surfaces had (the graph chip at 40, the undo stack at 280; the undo host itself is ExecutionView's, not global). After: the backup card is in the dock and the offline pill is on top (overlap 0). Tests: `lib/__tests__/cornerDock.test.ts` (z scale, old fixed corners gone, the centre dock), `lib/__tests__/cornerJobs.test.ts` (backup in the jobs slot).

**Done-when.**
- Partial, NOT met as written. Two docks exist and are documented, but not in the shape the item names: the bottom-right corner dock holds both kinds (background jobs pinned nearest the corner, transient messages above them, in two slots of one dock), and the bottom-centre `CentreDock` holds two globally-mounted slots in one corner at different z values (the chip at 40, the undo stack at 280). The two layers are deliberate: one stacking box would have moved one of them against the drawers and modals between 40 and 280. Remaining step: the integrator ratifies `DEC-85` item 1 as this item's reading (one corner dock with two slots, one centre dock with two layers), or a later package splits the corner into a transient dock and a jobs dock and gives the centre dock one layer. *✓ on the ratified reading: the integrator ratified `DEC-85` item 1 as this item's reading at the N7 merge, 2026-10-02 (the reason is on `DEC-85` item 1; flagged for the user, and confirmed by the integrator under the user's delegation, 2026-10-07 — DEC-90).*
- ✓ `BackupIndicator` moves into `CornerPortal`.
- dw3 (one component owns "a newer build exists") — NOT done here. Per the plan and DEC-31 it needs `components/pwa/ServiceWorkerManager.tsx`, which is public-surfaces PKG-1's, so it is opened as `TAX-15`, to be worked after PKG-1 merges.
- Partial, NOT met as written. The item asks for a module that owns every overlay layer number; this one lists them. `lib/zLayers.ts` lists every overlay layer number in use (`Z_SCALE`) and names the ones the corner contract orders (`Z`). A scan test refuses an unlisted value: classes, inline styles and, since the review fix, a stylesheet's `z-index:`. About 150 call sites still carry their own literal class instead of reading the module (DEC-31). The earlier "owns every overlay layer number" overstated this (N7 second review). *Re-evaluated 2026-10-02 under the integrator's ratification:* `DEC-85` item 4 was ratified at the N7 merge as meeting `STACK-10` done-when 1 (the dock's two bands), not as a reading of this item. Still NOT met as written. Unmet: the module does not own every overlay layer number. Only the layers the corner contract orders read from it (the dock, the centre dock's slots, the three upload-starting modals); about 150 call sites keep their own literal. **Owner:** notifications N13 LAYERS SWEEP (new) — assigned by the integrator at the N7 merge, 2026-10-02 (no package in `audit-reports/fleet-plans/notifications.json` held those call sites; N3 SURFACES owns the notification center, N4 the feed provider). The integrator did not ratify the listing as this item's reading.

**Scope / residual.** Stays OPEN on dw3 (`TAX-15`) and dw4 (ownership of the layer numbers — notifications N13 LAYERS SWEEP; dw1 is met on the integrator's ratified reading of `DEC-85` item 1, 2026-10-02; N7 third review: it was ticked while saying "not by ownership"; the 2026-10-02 ratification of `DEC-85` item 4 covers `STACK-10`, not this item). No migration.

**Integrator note (2026-10-07, DEC-90 A14).** *Confirmed by the integrator under the user's delegation, 2026-10-07 (DEC-90): jobs and toasts never interleave and their priority is explicit, so one coordinated corner dock is better UX than two competing ones, and splitting it would move a component five review rounds stabilised for no visible change.* Done-when 1 stays ✓ on the confirmed reading of `DEC-85` item 1. The finding stays OPEN for done-when 3 (`TAX-15`) and done-when 4 (notifications N13 LAYERS SWEEP).

---

<a id="tax-15"></a>

## TAX-15 · Two surfaces still announce "a newer build exists", in two different words — the remainder of TAX-14

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** to be worked after public-surfaces PKG-1 merges, because it owns `components/pwa/ServiceWorkerManager.tsx`. Opened 2026-10-01 by notifications Round G N7 CORNER: the DEC-31 remainder of `TAX-14` done-when 3.
- **Assigned:** notifications N3 SURFACES — by the integrator, 2026-10-02, at the N7 merge (public-surfaces PKG-1, which owned `components/pwa/ServiceWorkerManager.tsx`, has merged).
- **Verification:** CONFIRMED (read on `b9cdfdc`)
- **Locations:** `components/system/UpdatePill.tsx:64,79` (top-centre, polls `/api/version`: "This tab is running an old version — tap to load the update"); `components/pwa/ServiceWorkerManager.tsx:181-194` (bottom-left, watches the service worker's waiting worker: "Update available — tap to refresh"); `app/(protected)/layout.tsx` mounts UpdatePill and `app/layout.tsx:93` mounts ServiceWorkerManager.
- **Independently verified:** — opened 2026-10-01 by N7 from `TAX-14`'s record; not yet challenged by a second party.

**Mechanism.** Two independent detectors report the same fact. UpdatePill compares the build id it booted with against `/api/version`. ServiceWorkerManager listens for a new worker reaching `installed` while one controls the page. Every deploy produces both signals (OFF-4 / OFF-11), so after a deploy both surfaces can be live at once: a top-centre pill and a bottom-left button, each with its own wording and its own reload path. UpdatePill's path goes through `loadLatestBuild`, which activates the waiting worker; it also asks before reloading over an upload in flight (`STACK-13`). The service-worker button's path is `applyServiceWorkerUpdate`, with no upload check beyond the page's `beforeunload` guard.

**Failure scenario.** After a deploy a user sees "This tab is running an old version" at the top and "Update available" at the bottom-left. They are unsure whether these are two updates or one. They tap the bottom-left button during an upload and get the browser's generic "Leave site?" prompt instead of the app's explanation.

**Done when.**

- [ ] One component owns "a newer build exists". It is fed by both the version poll and the waiting-worker signal: one wording, one placement, one prompt at a time.
- [ ] Its reload path is the one `loadLatestBuild` path and asks before reloading over an upload in flight (`confirmReloadDuringUploads`, `components/system/UpdatePill.tsx`).
- [ ] A test pins that only one surface renders when both signals are true.

**Closer:** the first notifications package after public-surfaces PKG-1 merges (the plan's "update-available unification").

---

<a id="tax-16"></a>

## TAX-16 · A heads-up's sender sees "Heads-up sent" only in the browser they sent it from

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** notifications, after N5 DISPATCH-AND-WRITE-HOLES moves notification writes to a server route. Opened 2026-10-01 by notifications Round G N7 CORNER: the DEC-31 remainder of `TAX-8` done-when 3.
- **Assigned:** notifications N9 DC-OWNED-PRODUCERS-AND-KIND-SPLIT, after N5 DISPATCH-AND-WRITE-HOLES merges — by the integrator, 2026-10-02, at the N7 merge.
- **Verification:** CONFIRMED (read on the N7 branch)
- **Locations:** `components/documents/EditOverlapBanner.tsx` ("Heads-up sent" derivation); `lib/inAppNotifications.ts:106-140` (`notifyMany` skips the actor); `supabase/migrations/20260723_notifications_unify.sql:37` (`notifications_own_select`: `user_id = auth.uid()`).
- **Independently verified:** — opened 2026-10-01 by N7; not yet challenged by a second party.

**Mechanism.** `TAX-8` made "Heads-up sent" survive a remount. It is derived from the `overlap_advisory` rows the viewer can read: one addressed to the viewer from someone in the overlap means a heads-up went round. A heads-up the viewer sent themselves cannot be read back. `notifyMany` writes no row for the actor, and RLS lets a member read only rows addressed to them. So the sender's own send is remembered on the dismissal substrate (`hooks/useDismissed.ts`): per account, per workspace, in that browser.

**Failure scenario.** A user sends a heads-up from their laptop, then opens the same document on a tablet. The tablet offers "Send heads-up" again. Sending it re-notifies the colleagues, who receive a second, identical advisory.

**Done when.**

- [ ] The sender's own heads-up is read from the server: a route that answers whether the caller sent an `overlap_advisory` about the document to the current set of people within the window (service role, filtered by `actor_user_id = caller`), or the write route returns and records it.
- [ ] The banner derives "Heads-up sent" from that answer on every device; the per-browser marker becomes a cache at most.

**Closer:** notifications, after N5's server-side notification route exists.

---
