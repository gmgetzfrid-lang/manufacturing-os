# 07 · Document lifecycle & cross-subsystem hand-offs

> **CLAIMED** session_01EwPqnfFHkE85ZXM4sTQvEU 2026-08-24T00:30:00Z

Every seam where a document originates work in another subsystem, and every
seam where that work is supposed to come back. Checkout → markup → check-in →
drafting request → draft → approval → **revision**.

**14 findings** — 2 CRITICAL, 5 HIGH, 7 MEDIUM.

> See [`../README.md`](../README.md) for the resolution protocol. Code in
> `Remediation` blocks is **illustrative, untested, and not a patch.** Line
> numbers drift — **match on the quoted code.**

---

## The short version

The stated requirement is:

> *"if someone checks out a P&ID and marks it up it needs to be as-built, then
> send the file to a drafting request to be added."*

**The first half is built, and built well. The second half is built twice,
inconsistently. The third half — "to be added" — does not exist at all.**

A field engineer *can* check out a P&ID with purpose "As-Built Verification",
report a discrepancy, get an MOC gate, and land a real `ASBUILT` ticket in the
assignment queue with the source document linked and a PSM escalation.
`CheckInPanel.createDraftingTicket` is among the strongest code in the
repository.

But **the markup she drew in the viewer is not the markup that reaches the
ticket** — those are two unconnected systems (`LIFE-3`). And **when the drafter
finishes the as-built, nothing returns it to the document** (`LIFE-1`). The
ticket closes; `DOC-123` still says Rev 3. The loop is open by construction, not
by bug.

---

## LIFE-1 · The drafting loop has no return path — a closed ticket never becomes a revision

- **Severity:** HIGH
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 7 build 4 / Round C2 — the hand-back, built to `GAP-6` on the `DEC-22` shape).** The loop has a return path, and it is the existing publish path. When a ticket carries `metadata.source_document.id` and a `Final` attachment, the source-document card offers **"Publish as revision of DOC-xxx"** — to a caller who holds publish authority **on that document's library** (`resolveCanControlLibrary`) or is the document's effective owner (`isEffectiveOwnerOfDocument`), the same pair `authorizePublish` checks when the publish runs; ticket authority plays no part. The action resolves the latest Final deliverable from storage into a `File`, loads the document record, and opens `RevUpModal` pre-seeded (the file, the issue purpose per `DEC-26`, the check-in's MOC position per `LIFE-5`, a change log naming the ticket, and `relatedTicketId` for provenance) — then `revUpDocument` does everything else: `authorizePublish` → `assertCanPublishRevision` (a hold refuses it exactly as a manual publish), the publish contract RPC, the audit row, and `runPostPublishSideEffects` (ack roster, supersede notifications, package pin-drift). A review-gated library opens the reviewer roster instead, as any publish would. The outcome is recorded on the ticket by `/api/tickets/handback`, which trusts nothing in the body: the named version must belong to the ticket's org and source document and carry `related_ticket_id = ticket` — the provenance `20261049` makes `publish_revision` write. Closing a ticket that has a source document and produced no revision now leaves `metadata.deliverable = { state: "not_in_register", register_rev, … }`, a history line, and a note in the close notification — never silence; the card shows it as an amber chip. Never auto-publish on close.
- Done-when: (1) ✓ visible, queryable "deliverable not yet in the register" state on close (`metadata.deliverable.state`, history, notification); (2) ✓ the ticket-originated publish goes through `assertCanPublishRevision` (it IS a `revUpDocument` call); (3) ✓ `runPostPublishSideEffects` fires (same call). `GAP-6` acceptance 1–5 hold (see its record).
- Found and fixed on the way: `rowToTicket` (`lib/ticketTransitions.ts`) never mapped the `metadata` column, so every SERVER-side reader of `ticket.metadata` — including the existing ticket ⇄ intent bridge in the workflow-action route, which keys on `metadata.source_document` — has been reading `undefined`. It maps it now; the bridge, the close-time state and the recording route all depend on it (pinned by the test).
- Migration: `20261049` — **applied & verified live 2026-09-02** (4/4 probes true; not a widening: `publish_revision` re-created with the live `20261040` body plus `related_ticket_id` in the INSERT). Files: `lib/ticketHandback.ts` (new), `components/documents/RevUpModal.tsx`, `lib/revisions.ts`, `app/(protected)/requests/[id]/page.tsx`, `app/api/tickets/handback/route.ts` (new), `app/api/tickets/workflow-action/route.ts`. Tests: `lib/__tests__/sweepRoundC2.test.ts` (helpers, the recording route driven with a mocked client, source pins, `20261049` line-diff against the live body).

- **Verification:** CONFIRMED
- **Blast radius:** safety / data-integrity
- **Locations:**
  - `lib/ticketTransitions.ts:284-287` — the entire `close_ticket` transition
  - `lib/ticketTransitions.ts:280-282` — `submit_final` (the IFC/Final file lands here)
  - `app/api/tickets/workflow-action/route.ts:263-270` — the only thing closure does to the document
  - `app/(protected)/requests/[id]/page.tsx:1360` — `finalFiles`, display only
  - `lib/revisions.ts:398-540` — `revUpDocument`'s input contract: takes a `File`, never a ticket
- **Related:** `LIFE-2`, `LIFE-5`, `LIFE-6`, `LIFE-11`, `GAP-7`
- **Re-verified:** hardening pass — **SURVIVES**. `close_ticket` sets `status = "CLOSED"` and nothing else (`ticketTransitions.ts:284-287`); no ticket path calls `revUpDocument` or any revision creator.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. The absence claim is correct: a closed ticket writes nothing to the document, and the ticket's IFC/Final attachment never becomes a version. CRITICAL overstates it, though — publishing is fully supported and the loop is not invisible: the drafter/controller can publish the returned file through RevUpModal, and lib/impact.ts:113-119 surfaces open tickets on the document by `metadata->source_document->>id`, so the pending work is displayed on the publish surface. This is a missing automated write-back plus a discipline dependency, i.e. HIGH.

**Mechanism.** `computeTransition` for `close_ticket` is three lines:
`updates.status = "CLOSED"`. The `Final` attachment is appended to the ticket's
`attachments` JSONB by `submit_final` and stays there permanently. The only
document-side effect of closure in the entire codebase is:

```ts
} else if (newStatus === "CLOSED" || newStatus === "FINAL_DRAFT") {
  await supabaseAdmin.from("document_intents").delete()
    .eq("document_id", srcDoc.id).eq("ticket_id", body.ticketId).eq("source", "ticket");
}
```

That is a *cleanup*, not a hand-back. Nothing writes `document_versions`,
nothing touches `documents.rev`, nothing tells the requester a revision is now
publishable. `revUpDocument` has no ticket-shaped entry point — it accepts a
browser `File` and a manually typed revision label.

**Failure scenario.** A reliability engineer walks Unit 200, finds a bypass line
that is not on P-200-301. She checks in with "Field is different — report it",
states MOC-2026-014 in progress, and a ticket is created. A drafter draws the
as-built, issues the IFC package, and the ticket closes. **P-200-301 still shows
Rev 3, still shows no bypass.** The corrected drawing exists only as an
attachment on a closed ticket. Six months later an operator pulls Rev 3 for a
line-break permit. Nothing in the document register ever indicated a problem.

**Chain reaction.** ⚠ **This is a build, not a repair** — the spec is `GAP-6`
and the shape is settled by `DEC-22`: an explicit, authority-gated "Publish as
revision of DOC-xxx" action on the ticket, offered to whoever holds publish
authority **on that document's library** — not to whoever can close tickets — that
pre-seeds the existing rev-up flow and then calls `revUpDocument` unchanged.

⚠ **`LIFE-2` / `DEC-23` must land first.** An agent building this will naturally
set `related_ticket_id` for provenance, and until the waiver is deleted that
silently disables required reviewer sign-off on every ticket-originated revision.

The guards it must respect are already known: the publish guard
(`lib/documentGuards.ts:109` — an active hold blocks, and only Admin/DocCtrl can
force); the MOC gate (`components/documents/RevUpModal.tsx:214-217`); the review
gate — which `LIFE-2` will silently waive if `related_ticket_id` is set; and
`runPostPublishSideEffects` (`lib/postPublish.ts:91`), which fans out supersede
notices, work-package pin-drift alerts, revision-impact warnings, resets the
review cycle, opens a fresh acknowledgment roster, and recomputes retention.
**A ticket-originated publish that does not run that pipeline is a revision
nobody has to acknowledge.**

**Emphatically not the fix: "auto-publish on close."** That bypasses the publish
guard and the MOC gate in one move.

**Done when.**
1. Closing a ticket that has a `source_document` and produced no document
   revision leaves a visible, queryable "deliverable not yet in the register"
   state — not silence.
2. Any publish path originating from a ticket is refused by
   `assertCanPublishRevision` when a hold is active, exactly as a manual publish
   is.
3. `runPostPublishSideEffects` fires for it — verified by a fresh ack roster and
   a supersede notification.

---

## LIFE-2 · `related_ticket_id` is a review-gate waiver that no code path writes — a loaded gun

- **Severity:** MEDIUM
- **Status:** RESOLVED

**Resolution.** The waiver branch is deleted outright per `DEC-23`: `effectiveModeForRevUp` no longer accepts a `relatedTicketId` at all — the field is gone from its input type, so re-arming the waiver now requires a deliberate signature change rather than one stray property. The docblock (which asserted the false rationale *"they don't need — or already had — review"*) now states the DEC-23 rule: ticket approval is not the document's roster, is not hash-bound, produces no e-signature, and never satisfies a document sign-off. The column stays, for provenance only, exactly as DEC-23 directs.
- Commit: `2af2ebe`
- Files: `lib/reviewControl.ts`, `lib/__tests__/reviewControl.test.ts`
- Tests: `lib/__tests__/reviewControl.test.ts::"never waives the gate because the rev came from a drafting ticket (DEC-23)"` — feeds the exact pre-DEC-23 waiver input (`{control: require, changeType: "Major", relatedTicketId: "t1"}`) and pins `"require"`. Failed against the waiver (returned `"none"`), passes after.
- Reproduced: repo-wide search of `related_ticket|relatedTicketId` confirmed the audit's census still exact — the waiver at `reviewControl.ts:60`, zero writers (schema column now at `supabase/schema.sql:347`, readers at `lib/revisions.ts:958`, `documents/[libraryId]/page.tsx:1893`, `types/schema.ts:774`), both gate callers omitting the field (`RevUpModal.tsx:210`, `setRevUp.ts:83`), and the old test at `:42` asserting the waiver as correct.
- Verified: Done-when 1 — no production call can waive review on a ticket id (the parameter no longer exists; tsc enforces it). Done-when 2 — no ticket approval satisfies any sign-off (the only bridge is deleted). Done-when 3 — the test encodes the surviving rule. Full suite 1407 green.
- **What this brought to light:** the Minor/Correction escape hatch is now the *only* waiver, and it is driven by a remembered per-user change-type default — `RevUpModal` already renders an amber "replacement-in-kind, no MOC required" notice for that case, which is the right shape. Also: `intelligence/WIRE-9` and `drafting-flow/PROJ-11` describe this same waiver — both are satisfied by this deletion (their "both callers pass relatedTicketId" remediation option was the *other* branch of the fork; DEC-23 chose deletion).
- **Verification:** CONFIRMED
- **Blast radius:** safety
- **Locations:**
  - `supabase/schema.sql:334` — `related_ticket_id UUID,` on `document_versions`
  - `lib/reviewControl.ts:55-62` — the waiver
  - `components/documents/RevUpModal.tsx:210` — the only production caller; omits it
  - `lib/documentLifecycle/setRevUp.ts:83` — second caller; omits it
  - `lib/revisions.ts:958`, `app/(protected)/documents/[libraryId]/page.tsx:1893` — readers
  - `lib/__tests__/reviewControl.test.ts:42` — a test asserting behavior no user can reach
- **Related:** `LIFE-1`, `LIFE-12`
- **Re-verified:** hardening pass — **SURVIVES**. `effectiveModeForRevUp` returns `"none"` on any truthy `relatedTicketId` (`reviewControl.ts:60`). Both occurrences of the column in application code — `documents/[libraryId]/page.tsx:1893` and `revisions.ts:958` — are **reads**. The waiver is unreachable today and fires the moment anything writes the column; "a loaded gun" is the right description.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → MEDIUM** by this pass. The factual claim is right (nothing writes the column) and in fact stronger than stated: even a populated column would not fire the waiver today, because neither of the two gate callers passes relatedTicketId. That makes it inert dead code whose harm is entirely contingent on LIFE-1 being built and wired a particular way. CRITICAL is not defensible for a branch with zero reachable callers; MEDIUM (latent-hazard / remove-or-gate) fits.

**Mechanism.** `effectiveModeForRevUp` contains three escape hatches:

```ts
if (input.control.mode === "none") return "none";
if (input.changeType === "Minor" || input.changeType === "Correction") return "none";
if (input.relatedTicketId) return "none";   // ← lib/reviewControl.ts:60
```

The third is documented as *"a rev that came from a drafting ticket always skips
the gate (they don't need — or already had — review)"*. But
`RevUpModal.tsx:210` calls it as `effectiveModeForRevUp({ control, changeType })`
— `relatedTicketId` is never in the object. A repo-wide search for
`related_ticket` returns four hits: the schema column and three *readers*.
**Zero writers.** The column is NULL in every row that has ever existed.

This is worse than dead code. It is a **live waiver of the document review gate,
armed and waiting for the first person who wires ticket → publish.** An agent
implementing `LIFE-1` will naturally set `related_ticket_id` for provenance, and
will thereby silently disable required reviewer sign-off on every ticket-
originated revision — including as-builts of P&IDs, the highest-consequence
documents in the system.

**Failure scenario.** `LIFE-1` gets built. Ticket-originated publishes now carry
`related_ticket_id`. The Process Safety library is configured
`review_control.mode = "require"` with two required reviewers. Every as-built
revision now publishes with **zero document-side sign-offs**, and
`document_review_signoffs` gets no rows at all. The stated rationale ("they
already had review") is false: ticket approval is `approve_draft_ifc` by the
*requester or an engineer* — it is not the document's reviewer roster, it is not
bound to the file's `content_hash`, and it produces no e-signature on the
version. The audit trail shows an approved P&ID with no reviewer.

**Chain reaction.** `document_review_signoffs` rows are what `recordReviewSignoff`
binds e-signatures to via `contentHash`. Skipping the roster skips
`recordSignature`, skips auto-finalize, and skips `invalidateDraftSignoffs`.
Anything reading sign-offs as evidence (`lib/evidencePack.ts`) shows a gap it
cannot explain.

**Fix this one first.** It is cheap, it is independent, and it is the trap that
`LIFE-1` springs. Treat the column and the waiver as two separate decisions:
writing `related_ticket_id` for provenance is genuinely valuable; letting it
waive review is not.

**Done when.**
1. No production call to `effectiveModeForRevUp` can waive review purely because
   a ticket id is present.
2. If a ticket approval is ever allowed to satisfy a document sign-off, it is
   gated on the approver being on that document's roster **and** the approval
   being bound to the same file hash — and it records a real sign-off row.
3. `lib/__tests__/reviewControl.test.ts:42` encodes whichever rule survives.

---

## LIFE-3 · Viewer markup is never persisted — the redline exists only in React state

- **Severity:** HIGH
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 7 build 1 / Round C4 — `GAP-7` on the `DEC-24` shape).** Markup lives server-side. `document_markups` (`20261051`) holds the viewer's own normalized per-page fabric JSON (scale 1.0, keyed by 1-based page — the shape `bakeMarkupIntoPdf` already consumes), one row per `(document, version, user)`, the checkout session recorded as provenance, last write per user per version. The register page now passes the three hooks the viewer always had: `initialPageStates` is seeded from the caller's stored markup when the sheet opens (the viewer mounts only once the seed is known), `onPageStatesChange` autosaves as the user moves between pages, `onCommit` saves on close and keeps the editor up until the write lands; a failed save is a toast, never silence. A markup with nothing drawn removes its row. The inspector's new **Markups** section lists every markup on the document — author, revision, pages marked, last updated — and opens the viewer seeded with it: the author continues, anyone else views (nothing is saved over someone else's row). Reads are as visible as the document (the policy's `documents` subquery runs under the caller's own RLS); writes are the author's own; controllers may delete. The baked PDF is a derivative for export and the drafting hand-off; the browser-local stash (`lib/draftHandoff.ts`) only carries a baked file into a request and is no longer the source of truth for anything.
- Done-when: (1) ✓ closing and reopening the viewer on the same document/version restores the user's markup; (2) ✓ (Round A) refreshing `/requests/new?draft=…` still yields the marked-up file; (3) ✓ a markup is discoverable from the document (inspector section) without anyone having downloaded anything.
- Scope: "autosaved as the user draws" (`DEC-24`) lands as autosave on every page switch and on close — the viewer reports page states when they change, and a page's state is captured when it is left; a keystroke-level save would need a debounced canvas listener inside the viewer and is deliberately not added (the spec's Design is "wire the hooks", its Do-not is "do not build a new viewer"). The book viewer (`MultiDocViewer`) keeps its in-memory per-sheet store for a session; wiring it to the same table is a follow-on, not a regression.
- Cross-area: closes drafting-flow [`LEAK-5`](../drafting-flow/04-flow-leaks.md) (its Done-when defers here).
- Migration: `20261051` — **pending apply** (new table; not a widening). Files: `lib/markups.ts` (new), `components/documents/MarkupsSection.tsx` (new), `components/viewers/FullScreenViewer.tsx`, `components/documents/InspectorPanel.tsx`, `app/(protected)/documents/[libraryId]/page.tsx`, `lib/exportTables.ts` / `lib/dataRestore.ts` (the table is exported with backups and restored after `document_versions`). Tests: `lib/__tests__/sweepRoundC4.test.ts` (the store with a mocked client — upsert key, ghost-row removal, refused write, pre-migration tolerance, author names; source pins; `20261051` shape).


**Partial (2026-09-02, Phase 6 severity sweep, Round A — the refresh slice).** `lib/draftHandoff.ts` no longer deletes the stash on read: `readDraft` is read-only and `discardDraft` runs only after the request insert succeeds, so refreshing `/requests/new?draft=…` before submitting still yields the marked-up file (Done-when 2 ✓; a StrictMode double-run cannot attach the file twice). Done-when 1 and 3 need the per-(document, version, user) markup store — that is `GAP-7` (Phase 7, independent) and stays OPEN here.
- Files: `lib/draftHandoff.ts`, `app/(protected)/requests/new/page.tsx`. Tests: `lib/__tests__/lifeSweep.test.ts`.

- **Verification:** CONFIRMED
- **Blast radius:** data-loss / safety
- **Locations:**
  - `components/viewers/FullScreenViewer.tsx:138-143` — `initialPageStates` / `onPageStatesChange` / `onCommit` props
  - `app/(protected)/documents/[libraryId]/page.tsx:3025-3039` — the **only** render site; passes none of the three
  - `components/viewers/FullScreenViewer.tsx:1093-1107` — `handleClose` reports state to a parent that is not listening
  - `components/viewers/MultiDocViewer.tsx:353-355` — explicit: *"Markups live in memory and are DISCARDED on close"*
  - `lib/draftHandoff.ts:53-66` — `takeDraft` **deletes on read**
  - `app/(protected)/requests/new/page.tsx:104-115` — reads (and thereby destroys) the stash on mount
- **Related:** `LIFE-4`, `LIFE-8`, `GAP-4`
- **Re-verified:** hardening pass — **SURVIVES**, by absence. `FullScreenViewer` exposes `initialPageStates`, `onPageStatesChange` and `onCommit` (`:138-143`); the call site passes **none of them** (`documents/[libraryId]/page.tsx:3025-3036`). Cross-area duplicate of `drafting-flow/LEAK-5` — fix once.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Verified end to end: markup is React state in the viewer, the hand-off stash is one-shot and deleted on read, and the destination form holds it only in memory with no unsaved-work warning — a refresh or tab restore loses the redlines with no error shown. HIGH is warranted for silent loss of safety-critical markup.

**Mechanism.** `FullScreenViewer` holds markup in `useState` and offers three
persistence hooks. The document library page — the surface where a controlled
P&ID is actually opened — renders it with `url`, `title`, `docNumber`, `rev`,
`document`, `userRole`, `currentUserId`, `currentUserEmail`, `onCheckout`,
`orgId`, `customColumns` and **nothing else**. `handleClose` computes a merged
page-state map, finds neither `onCommit` nor `onPageStatesChange`, and drops it.

The escape hatch is `stashDraft` → IndexedDB → `/requests/new?draft=…`. That
store is browser-local, and `takeDraft` **deletes the entry inside the `get`
success handler before returning.** The files then exist only as `File` objects
in the `/requests/new` component's state.

**Failure scenario.** An engineer marks up eight pages of P-200-301 over twenty
minutes and clicks "Send to Drafting". `/requests/new` loads, the stash is
consumed and deleted, the files sit in form state. The form requires Title,
**Unit**, and Detailed Scope. She opens another tab to look up the unit code,
comes back and refreshes out of habit — or her session token refreshes and the
page remounts. **Every markup is gone.** Not recoverable from IndexedDB
(deleted), not from the viewer (state discarded on close), not from the document
(never stored). Twenty minutes of field annotation on a live P&ID, destroyed by
a refresh, with no error and no trace in any audit table.

**Chain reaction.** This is the direct cause of the odd instruction in
`lib/checkinOutcomes.ts:169-170` — the check-in card tells the user to work
around it: *"use Download w/ Markup in the viewer, then attach that file
below."* The check-in flow cannot reach the markup programmatically, so it asks
the human to launder it through their filesystem. Persisting markup unblocks
`LIFE-8` and is the substance of `GAP-4`.

**Done when.**
1. Closing and reopening the viewer on the same document/version restores the
   user's markup.
2. Refreshing `/requests/new?draft=…` before submitting still yields the
   attached marked-up file.
3. A markup that exists is discoverable from the document without the user
   having downloaded anything.

---

## LIFE-4 · The book-viewer markup hand-off drops the source-document link entirely

- **Severity:** HIGH
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 6 severity sweep, Round A).** The book-viewer hand-off's document id now reaches the ticket. `requests/new` keeps the stashed sheet's `docId`/`docNumber` (`stashedDoc`), derives `srcDocId = sourceDocId || stashedDoc.id`, and uses it for `metadata.source_document`, the "Source Linked" history entry and the source chip — so a marked-up ticket is found by `lib/impact.ts` (`metadata->source_document->>id`) and by the drafting-intent bridge exactly like a "Send to Drafting" one.
- Done-when: (1) ✓ the Impact panel of the marked-up sheet lists the ticket (single sheet — `source_document` stays single-valued; multi-sheet provenance is `GAP-8`, and the first stashed sheet is the one recorded); (2) ✓ assignment produces the `document_intents` row (same id, same bridge); (3) ✓ the source-document confirmation renders for the marked-up case (`srcDocId || sourceFileUrl`), with copy that says the marked-up sheet is attached.
- Files: `app/(protected)/requests/new/page.tsx`. Tests: `lib/__tests__/lifeSweep.test.ts`.
- Ship loop green: `tsc`, `eslint`, vitest, `next build`.

- **Verification:** CONFIRMED
- **Blast radius:** safety / correctness
- **Locations:**
  - `components/viewers/MultiDocViewer.tsx:877-884` — the params it sends
  - `components/viewers/FullScreenViewer.tsx:928-943` — the params the single viewer sends (contrast)
  - `lib/draftHandoff.ts:8-13` — `DraftHandoffFile` carries `docId` / `docNumber`
  - `app/(protected)/requests/new/page.tsx:110` — `new File([f.blob], f.name, …)` — `docId` is discarded
  - `app/(protected)/requests/new/page.tsx:290-298` — `metadata.source_document` written only `if (sourceDocId)`
  - `lib/impact.ts:113-119` — the query that depends on it
- **Related:** `LIFE-13`, `GAP-3`
- **Re-verified:** hardening pass — **SURVIVES**, and the contrast is exact. `FullScreenViewer.tsx:928-935` sets `sourceDocId`, `sourceDocNum`, `sourceDocTitle`, `sourceDocRev`; `MultiDocViewer.tsx:878-884` sets only `title`, `description`, `draft` and `unit`. The book-viewer path drops the document link entirely.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Correct, and the wasted capability makes it sharper: lib/draftHandoff.ts:8-13 already carries `docId`/`docNumber` per file into IndexedDB, and the requests/new consumer ignores both. Book-viewer markups therefore create tickets invisible to the Impact panel. One nuance on the word 'entirely': MultiDocViewer.tsx:867-874 does write the document numbers and revs into the free-text description, so the link is lost machine-readably, not from human view. HIGH stands — the coordination guard is silently disabled.

**Mechanism.** `sendMarkupsToDrafting` builds `DraftHandoffFile[]` where each
entry *does* carry `docId` and `docNumber`, then sends only:

```ts
const params = new URLSearchParams({ title, description, draft: key });
if (unit) params.set("unit", unit);
```

No `sourceDocId`. On the receiving side, `takeDraft`'s result is mapped to plain
`File` objects, discarding the `docId` that rode along. `metadata.source_document`
is therefore never written for this path. The document numbers survive only as
prose inside `description` and inside the baked filename.

The consequence is precise and testable: `lib/impact.ts:117` finds open tickets
with `.eq("metadata->source_document->>id", documentId)`. **A ticket born from
the book viewer is invisible to the document's Impact panel.** It is equally
invisible to the ticket→intent bridge at
`app/api/tickets/workflow-action/route.ts:231-233`, which reads the same path —
so no `document_intents` row is created and the drafter's work generates **no
overlap advisory** for anyone else editing that sheet.

Even the single-doc path is partly broken: when markup exists it sets `draft` and
*skips* `sourceFileUrl`, so `metadata.source_document.path` becomes `''` and the
"Source document" confirmation chip at `app/(protected)/requests/new/page.tsx:408`
— gated on `sourceFileUrl` — **does not render precisely when a marked-up sheet
is attached.** The weakest confirmation appears exactly when the stakes are
highest.

**Failure scenario.** A reviewer marks up three sheets of a 14-sheet isometric
book and sends them to drafting as one request. Two weeks later someone opens
ISO-4471 to publish an unrelated revision. The Impact panel says "no open
drafting requests". They publish. The three marked-up sheets are now redlines
against a superseded revision, and no overlap advisory fired because no
`document_intents` row existed.

**Chain reaction.** Fixing this switches on three dormant behaviors for these
tickets: Impact-panel visibility, the ticket→intent bridge (and therefore
overlap advisories), and — should `LIFE-1` ever be built — eligibility for
hand-back. Note `source_document` is **single-valued**, so a genuinely
multi-sheet request still cannot be fully represented; see `GAP-3`.

**Done when.**
1. A ticket created from the book viewer appears in the Impact panel of every
   sheet it marked up.
2. Assigning a drafter to that ticket produces `document_intents` rows for those
   sheets.
3. The source-document confirmation renders on `/requests/new` for the marked-up
   case.

---

## LIFE-5 · The MOC position is captured, then abandoned — nothing carries it to the publish that needs it

- **Severity:** HIGH
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 7 build 4 / Round C2, with `LIFE-1` / `GAP-6`).** The two MOC gates now speak. The hand-back reads the check-in's position (`metadata.moc` — `completed` / `in_progress` with its number, or `none`) and carries it into `RevUpModal` as `presetMocOrigin`: a captured number prefills the MOC reference, and the field says where it came from ("MOC MOC-7 carried from request REQ-42 (in progress)"). A recorded **"no MOC"** cannot be silently contradicted: entering a number then requires an explicit acknowledgement under the field, and the contradiction is written into the change log ("MOC … recorded at publish contradicts the check-in's 'no MOC' position (request REQ-42) — acknowledged by the publisher"), so the laundering scenario leaves a trail where the auditor looks. Reconciliation: every ticket-originated `document_versions` row carries `related_ticket_id` (`20261049`), so `moc_reference` joins back to `tickets.metadata.moc` by the row itself.
- Done-when: (1) ✓ the MOC number shows without the publisher typing it; (2) ✓ a "no MOC" origin cannot silently acquire one (explicit acknowledgement, logged); (3) ✓ reconcilable by `related_ticket_id`.
- Files: `components/documents/RevUpModal.tsx`, `lib/ticketHandback.ts`, `app/(protected)/requests/[id]/page.tsx`. Tests: `lib/__tests__/sweepRoundC2.test.ts`.


> **Phase 0 partial — already overtaken (2026-08-24).** The "free, independent
> part" (relabel the RevUpModal MOC input, which said *optional* for a field
> the gate makes mandatory) no longer reproduces: intervening work rebuilt the
> modal so the mandatory case renders its own above-the-fold field labelled
> `"MOC Reference (required — drawing class)"` (or `"required — class
> unverified"`), submit is blocked at `RevUpModal.tsx:261-263` when required
> and empty, and the *"Optional ticket # from change platform"* hint now
> renders only inside `{!mocRequired && (…)}` (`RevUpModal.tsx:738-741`) —
> where it is true. The Minor/Correction exemption is also stated visibly
> (`:708-713`). No relabel needed; verified by direct read, quoted here so the
> next agent does not re-fix it. **The body of this finding — MOC captured at
> check-in and never carried to publish, the laundering scenario, Done-when
> 1–3 — remains OPEN** and lands with the `LIFE-1`/`GAP-6` hand-back work.
- **Verification:** CONFIRMED
- **Blast radius:** safety / compliance
- **Locations:**
  - `lib/checkinOutcomes.ts:87-93` — `mocRequirementFor`
  - `components/documents/CheckInPanel.tsx:224-229,264` — MOC written into ticket `metadata.moc`
  - `components/documents/CheckInPanel.tsx:378-384` — MOC written into `outcome_ref`
  - `components/documents/RevUpModal.tsx:214-217` — the publish-side MOC gate, **independently derived**
  - `lib/revisions.ts:522` — `moc_reference: mocReference?.trim() || null`
  - `components/documents/RevUpModal.tsx:739` — the input, labelled *"Optional ticket # from change platform"*
- **Related:** `LIFE-1`, `LIFE-6`
- **Re-verified:** hardening pass — **SURVIVES**. Cross-area duplicate of `drafting-flow/TIER-6` — `mocRequirementFor` computes the requirement (`checkinOutcomes.ts:87-93`) and `CheckInPanel.tsx:224-229` renders it into prose. Nothing carries it forward.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. The absence is verified: no code path reads a ticket's or a check-in's MOC state into the publish, so the published version's moc_reference is unvalidated free text typed weeks later, and the 'no MOC on record' flag never reaches the document record at all. HIGH is appropriate — this is the PSM/MOC linkage the publish gate exists to enforce.

**Mechanism.** Two MOC gates exist and they do not speak. At check-in, a
drawing-class discrepancy or revision request **requires** an MOC position, and
"no MOC exists" is deliberately allowed-but-flagged. That position is stored
twice — `tickets.metadata.moc` and `checkout_sessions.outcome_ref.moc` — and
read by nothing.

At publish, `RevUpModal` recomputes
`mocRequired = (docClass === "drawing" || docClassUnknown) && !isMinorLike` from
scratch and demands the number again as free text, described in the UI as an
*optional* reference from an external platform. No lookup, no prefill, no
comparison.

**Failure scenario.** The field report says "No MOC exists" — correctly,
honestly. The system flags it as an undocumented field change. Weeks later the
as-built is published and RevUpModal asks for an MOC number; the publisher types
`MOC-2026-088`, a different change they happen to remember. **The "undocumented
field change" finding has been laundered into a documented one.** The only
record that contradicts it is `metadata.undocumented_change: true` on a closed
ticket that nothing links to the version. Under a PSM audit, the version record
says the change was managed. It was not.

**Chain reaction.** Entangled with `LIFE-1` and `LIFE-2`. Any "MOC must match its
origin" rule has three publish-shaped call sites, not one:
`components/documents/RevUpModal.tsx`,
`lib/documentLifecycle/common.ts:266` (`supersedeDocument`), and
`lib/revisions.ts:1135` (revert).

**The free, independent part of this fix:** relabel the RevUpModal input.
*"Optional ticket # from change platform"* directly contradicts the gate that
makes it mandatory for non-minor drawing revisions. That is a one-line honesty
fix with no dependencies.

**Done when.**
1. A revision published from an as-built ticket shows the ticket's MOC number
   without the publisher typing it.
2. Publishing a drawing revision whose origin recorded "no MOC exists" cannot
   silently acquire an MOC number.
3. `document_versions.moc_reference` for ticket-originated revisions is
   reconcilable to `tickets.metadata.moc`.

---

## LIFE-6 · The "Field Verification Needed" hold is unlinked, unrecorded, and never released

- **Severity:** MEDIUM
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 6 severity sweep, Round B — built per `DEC-25`).** `document_holds.origin_ticket_id` (FK `ON DELETE SET NULL`, partial index on open holds) links a hold to the ticket whose check-in placed it; `openHold` writes it, the check-in passes it, `outcome_ref.holdId` was written in Round A2 and the history panel shows it. The close gate lives inside the workflow route's enforcement frame: closing a ticket that still has an open originating hold returns `409 holds_open` unless the closer either releases it now (released server-side, audited `HOLD_RELEASED`) or records why it stays (`HOLD_KEPT_ON_CLOSE` with the reason) — never auto-released. The ticket page turns the 409 into the two-way choice and re-sends with the resolution.
- Done-when: (1) ✓ `outcome_ref.holdId`; (2) ✓ the hold carries its ticket, the ticket's history entry links the hold; (3) ✓ a close over an open originating hold cannot be silent.
- Migration: `20261047` — **applied & verified live 2026-09-02** (10-point probe all true; inventory recorded BEFORE apply, all zero: no unsigned acknowledgments in history, no observer roster rows, no client-queued non-member mail, no external mail in 90 days, no unlinked field-verification holds).. Files: `lib/holds.ts`, `types/schema.ts`, `components/documents/CheckInPanel.tsx`, `app/api/tickets/workflow-action/route.ts`, `app/(protected)/requests/[id]/page.tsx`. Tests: `lib/__tests__/rpSweepMigrations.test.ts` (shape + line-diffs against the live predecessors), `lib/__tests__/sweepRoundB.test.ts`.


**Partial (2026-09-02, Phase 6 severity sweep, Round A2 — Done-when 1).** The check-in keeps the hold `openHold` returns and writes `outcome_ref.holdId` (the field `20261012` documented), remembered per card so a retry never opens a second hold; `CheckoutHistoryPanel` shows it (`LIFE-10`). Done-when 2 and 3 (the hold shows its originating ticket and vice versa; a close over an open originating hold cannot be silent — `DEC-25`) need `document_holds.origin_ticket_id` and the server-side close gate: they ship with the next migration round.
- Files: `components/documents/CheckInPanel.tsx`. Tests: `lib/__tests__/lifeSweep2.test.ts`.

- **Verification:** CONFIRMED
- **Blast radius:** availability / safety
- **Locations:**
  - `lib/checkinOutcomes.ts:65-66,132` — `allowHoldOffer` on the discrepancy card
  - `components/documents/CheckInPanel.tsx:364-375` — `await openHold({...})`, **return value discarded**
  - `components/documents/CheckInPanel.tsx:381-388` — `ref` contains `ticketId`, `ticketNumber`, `moc` — **no `holdId`**
  - `supabase/migrations/20261012_doc_class_and_checkin_outcomes.sql:27-29` — promises `outcome_ref` contains `holdId`
  - `lib/holds.ts:70-162` — `OpenHoldInput` has no ticket/session field
  - `lib/ticketTransitions.ts:284-287` — closure releases nothing
  - `components/documents/CheckInPanel.tsx:626-629` — the promise made to the user
- **Related:** `LIFE-1`, `LIFE-10`
- **Re-verified:** hardening pass — **SURVIVES**. `openHold({ reason: "Field Verification Needed", notes: note.trim(), … })` (`CheckInPanel.tsx:366-371`) carries no ticket id, no check-in id and no release condition.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. 'Unlinked' and 'no automatic release' hold. 'Unrecorded' and 'nobody can track' do not: lib/holds.ts:139-152 writes a HOLD_OPENED audit event and fires notifyHoldChange, app/(protected)/admin/holds/page.tsx lists active holds org-wide with metrics and a release button, HoldStrip shows and releases them on the document, and lib/impact.ts:127-133 counts them — while lib/documentGuards.ts:139-146 makes the hold genuinely block. Downgrade to MEDIUM: the hold is visible, auditable and releasable by a human; what is missing is the ticket linkage and the release-on-close automation.

**Mechanism.** The hold genuinely blocks publishing — `evaluatePublishGuard`
treats any active hold as a hard block, overridable only by Admin/DocCtrl, with
a defense-in-depth DB trigger behind it. The UI copy is accurate: *"stops new
revisions publishing until the discrepancy is resolved."*

But the hold is created with `reason`, `notes` and `openedBy` and nothing else.
`openHold` returns a `DocumentHold`; `CheckInPanel` awaits it and throws the
result away. The migration explicitly documents `outcome_ref` as holding
`{ ticketId, ticketNumber, versionId, revisionLabel, holdId, moc }`; the code
writes everything except `holdId`. `OpenHoldInput` has no field for a ticket
reference even if the caller wanted one.

So the hold that blocks the document knows nothing about the ticket that will
resolve it, the ticket knows nothing about the hold it created, and closing the
ticket does not release it.

**Failure scenario.** The engineer checks the box. A "Field Verification Needed"
hold blocks P-200-301. The drafter completes the as-built; the ticket closes.
**The hold is still open.** Combined with `LIFE-1` (nothing publishes anyway) the
document is permanently frozen at the wrong revision with an open block nobody
can trace to a resolved cause. When someone eventually tries to publish, the
guard refuses them — a library publisher is not a controller, and hold-override
is reserved for Admin/DocCtrl. They must find an Admin and force past a safety
hold whose originating ticket is closed and whose relationship to the change is
recorded nowhere. The hold appears on the org bottleneck dashboard as an aging
blocker with no owner.

**Chain reaction.** Holds feed `getHoldMetrics`, the org hold queue,
`lib/inbox.ts:148`, `app/(protected)/assets/[tag]/page.tsx:75`, `lib/timeline.ts`
and `lib/evidencePack.ts:22`. An orphan hold pollutes all of them and inflates
`longestActiveDays` permanently.

**Do not auto-release on close.** Releasing a safety hold must stay a deliberate
act. The fix is to make it *visible*: record the hold id where the migration
already says it goes, and surface the open hold to whoever closes the ticket.

**Done when.**
1. `checkout_sessions.outcome_ref.holdId` is populated whenever the hold offer is
   taken.
2. A hold's UI shows which ticket it came from, and the ticket shows which hold
   it opened.
3. Closing a ticket with an open originating hold cannot happen silently.

---

## LIFE-7 · The PSM undocumented-field-change alert is bell-only; every comparable alert gets email

- **Severity:** HIGH
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 6 severity sweep, Round A).** The PSM undocumented-change escalation now goes through `emit()` on a new `safety` notification category — bell AND email — whose event type (`safety_alert`) is deliberately unknown to `shouldSendForEvent`, so no per-category preference can mute it (the same mechanism a drawing recall uses). When the controller roster is empty the reporter sees a warning toast ("PSM alert has no recipient") and a `PSM_ALERT_UNROUTED` audit row is written — a hazard report never looks routed when it was not.
- Done-when: (1) ✓ rows land in `email_notifications` (via `queueEmail` inside `emit`); (2) ✓ `email_on_assignment: false` does not gate `safety_alert` (test pins the closed preference switch); (3) ✓ empty roster is visible and recorded.
- Files: `components/documents/CheckInPanel.tsx`, `lib/notify/dispatch.ts` (`NotifCategory` gains `safety`; `categoryToEventType` exported). Tests: `lib/__tests__/lifeSweep.test.ts`.
- Residual: the assignment-queue notify a few lines above stays bell-only on purpose (it is legitimately preference-gated).

- **Verification:** CONFIRMED
- **Blast radius:** safety
- **Locations:**
  - `components/documents/CheckInPanel.tsx:291-307` — the PSM escalation, uses `notifyMany`
  - `components/documents/CheckInPanel.tsx:399-411` — the *owner* path in the same file, uses `emit`
  - `lib/inAppNotifications.ts:104-137` — `notifyMany` inserts into `notifications` only
  - `lib/notify/dispatch.ts:22-45` — `emit` fans out to in-app **and** email
  - `lib/transitionIn.ts:339-352` — the lower-stakes intake collision correctly uses `emit`
  - `lib/checkinOutcomes.ts:200` — the card copy promising durability
- **Related:** `SURF-*`, `OWN-12`
- **Re-verified:** hardening pass — **SURVIVES**, and the asymmetry is inside one function. The PSM undocumented-field-change alert uses `notifyMany` — bell only (`CheckInPanel.tsx:296`) — while the lesser "change proposed" event a hundred lines later uses `emit` from `lib/notify/dispatch` (`:400-408`), which is the path that also mails.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Claim holds on every load-bearing point: the PSM escalation is bell-only, the identical-kind intake/portal events get email via emit(), and the daily compliance digest excludes this kind so there is no second chance at email. One overstatement: the check-in ticket's own assignment-queue notify (CheckInPanel.tsx:276) is also notifyMany/bell-only, so 'every comparable alert gets email' is not literally true within that file.

**Mechanism.** `CheckInPanel` uses both notification systems and picks the weaker
one for the more urgent event. The `sent_to_owner` card promises *"Your notes go
durably (in-app + email) to the document's effective owner"* and delivers via
`emit`. The PSM escalation for an undocumented field change — priority-1,
flagged `undocumented_change: true`, routed to org controllers — uses
`notifyMany`, a bare insert into `notifications`. No email. No preference-aware
queue. Nothing in `email_notifications`. The codebase's own best practice is
applied to intake collisions and withheld from PSM findings.

**Failure scenario.** An engineer reports a bypass line with no MOC on record at
4:45pm Friday. The escalation writes bell rows for two controllers. Neither opens
the app until Monday. Meanwhile the P&ID — unless the hold box was also checked —
remains publishable and distributable, and a night-shift operator pulls it for a
permit.

**Chain reaction.** Moving these to `emit` brings them under
`notification_preferences`. The category matters:
`kind: "request_pending_approval"` maps to `category: "assignment"`, gated by
`email_on_assignment`. **A PSM finding must not be silenceable by an assignment
preference.** Separately: if an org has no active Admin/DocCtrl,
`getOrgControllers` returns empty and the escalation reaches **nobody**, with no
fallback and no warning — contrast `lib/reviewControl.ts:243-256`, which
explicitly detects and reports an empty roster.

**Done when.**
1. An undocumented-change report produces rows in `email_notifications`, not just
   `notifications`.
2. A controller with `email_on_assignment: false` still receives it.
3. An org with no active controllers surfaces a visible "this had nowhere to go"
   state.

---

## LIFE-8 · `markup_requests.shared_markup_url` is never set; `markup_ref` thread messages have no producer

- **Severity:** MEDIUM
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 6 severity sweep, Round A2 — the honest narrow fix the finding names).** The inbox toast no longer claims "the requester can see your markups are available"; it says the share is noted on the document's activity thread. `resolveMarkupRequest` is now a checked write (a refused update throws instead of reporting "shared") and, on `shared`, posts the `markup_ref` message `ActivityThread` already renders — with the URL when one is supplied — so the pointer the UI can back exists. `shared_markup_url` stays writable for a future producer; it grants nothing.
- Done-when: (1) ✓ the UI stops claiming an artifact it cannot show; (2) ✓ a `markup_ref` row lands in `checkout_messages`.
- Files: `lib/markupRequests.ts`, `app/(protected)/inbox/page.tsx`. Tests: `lib/__tests__/lifeSweep2.test.ts`.

- **Verification:** CONFIRMED
- **Blast radius:** ux
- **Locations:**
  - `supabase/migrations/20260527_projects_and_collaboration.sql:109` — the column
  - `lib/markupRequests.ts:116-127` — `resolveMarkupRequest` accepts `sharedMarkupUrl`
  - `app/(protected)/inbox/page.tsx:139-147` — call site, omits it
  - `components/dashboard/widgets.tsx:795-802` — the other call site, omits it
  - `app/(protected)/inbox/page.tsx:150-156` — the toast: *"The requester can see your markups are available."*
  - `lib/activityThread.ts:240-246` — `postMarkupRef`, **zero callers**
  - `components/documents/ActivityThread.tsx:474-484` — the renderer for a message kind nothing produces
- **Related:** `LIFE-3`, `GAP-4`
- **Re-verified:** hardening pass — **SURVIVES**, by caller census. `sharedMarkupUrl` is an optional input written at `markupRequests.ts:123`, and **no caller anywhere passes it** — every other reference is either inside that module or a consumer that reads the column (`dataExport.ts:338`, `storageOrphans.ts:57`). The write path exists and is never exercised.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Both halves confirmed by repo-wide search: shared_markup_url is always written as null, and postMarkupRef is dead code, so a 'Share' produces only a status flip plus a project-feed line with no artifact, link, or thread entry.

**Mechanism.** The markup-request channel is a request/response with no payload.
Both call sites pass `status: "shared"` and neither passes `sharedMarkupUrl` or
`response`, so the column is universally NULL. The toast tells the requester
their colleague's markups "are available" — there is no artifact and no link.

Separately, the `markup_ref` activity-thread kind is fully built and completely
unreachable: the migration defines it with a documented `{ markup_request_id }`
payload, `postMarkupRef` constructs it correctly, `ActivityThread` renders it as
a violet card — and nothing calls the helper.

**Failure scenario.** Someone needs to see a colleague's in-progress redlines
before starting the connected sheet. They file a markup request; the colleague
clicks "Share". They get "Alice shared markups" and a `markup_shared` entry on
the project feed — and no file, no link, no thread entry. The system recorded a
successful collaboration that did not occur.

**Chain reaction.** Same root cause as `LIFE-3`: there is no persisted markup for
`shared_markup_url` to point at. Until that exists, **the honest narrow fix is to
stop the toast claiming availability it cannot deliver.**

**Done when.**
1. A resolved markup request with `status: "shared"` carries a non-null pointer
   to a viewable artifact — or the UI stops claiming one exists.
2. Sharing produces a `markup_ref` row in `checkout_messages` visible in
   `ActivityThread`.

---

## LIFE-9 · Tickets born inside the app skip fields the portal makes mandatory

- **Severity:** MEDIUM
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 6 severity sweep, Round A2).** Both in-app producers now satisfy the request form's required set: a check-in ticket carries `unit` derived from the document's own metadata (`unitOfDocumentMetadata`, the viewer hand-off's heuristic), and a collision ticket carries `unit` (from the intake sheet's metadata, best-effort), `target_completion_at` (the same SLA clock) and enrols its flagger as a watcher.
- Done-when: (1) ✓ title/description/unit present on all three origins (`unit` may be blank when the document's metadata names none — the same blank the form would refuse, surfaced under "no unit" rather than invented); (2) ✓; (3) ✓ for documents whose metadata carries a unit.
- Files: `components/documents/CheckInPanel.tsx`, `lib/transitionIn.ts`, `lib/sourceDocRef.ts`. Tests: `lib/__tests__/lifeSweep2.test.ts`.

- **Verification:** CONFIRMED
- **Blast radius:** correctness / ux
- **Locations:**
  - `app/(protected)/requests/new/page.tsx:201` — `if (!title || !description || !unit) return;`
  - `components/documents/CheckInPanel.tsx:236-267` — insert body: no `unit`
  - `lib/transitionIn.ts:304-331` — insert body: no `unit`, no `target_completion_at`, no `watchers`
  - `components/documents/CheckInPanel.tsx:246,252` — check-in *does* set SLA and watchers
  - `app/(protected)/requests/page.tsx:400,545,984,1046,1151` — unit in search, export and three UI surfaces
- **Related:** `LIFE-14`, `GAP-5`
- **Re-verified:** hardening pass — **SURVIVES**. `requests/new/page.tsx:201` refuses without `unit`; `CheckInPanel.tsx:236-247` inserts a ticket with no unit at all.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed — both in-app ticket producers bypass the portal's mandatory `unit`, and transitionIn additionally skips the SLA clock that CheckInPanel deliberately sets, so intake-collision tickets have no due date at all.

**Mechanism.** Three ticket-origination points, three field contracts:

| | portal form | check-in | collision flag |
|---|---|---|---|
| `unit` | **required** | ✗ | ✗ |
| `target_completion_at` | ✓ | ✓ | **✗** |
| `watchers` | ✓ | ✓ | **✗** |
| `source_document` | if param | ✓ | ✓ |
| audit row | ✗ | via `logCheckoutEvent` | ✓ `INTAKE_COLLISION_FLAGGED` |

`components/documents/CheckInPanel.tsx:244-246` carries an explicit comment —
*"Same SLA clock a portal request gets — check-in tickets must not be the ones
with no due date"* — showing the SLA omission was recognised and fixed in one
place and not the other. Collision tickets have no due date at all, so they never
go past-due, never appear in past-due chips, and never enter SLA warnings.

**Failure scenario.** A drafting supervisor works the queue by unit, filtering
"200" to batch the Unit 200 work. The as-built ticket has no unit, so it does not
match, and renders with an empty unit chip that reads as a data glitch. It sits
while unit-filtered work moves around it. Separately, an intake collision ticket
— the highest-priority kind, a genuine two-sources-of-truth conflict — never goes
past due and its flagger is not a watcher, so they are never told it moved.

**Chain reaction.** `unit` is derivable in both cases: check-in can read the
document's unit/area metadata using the heuristic the viewers already use
(`components/viewers/FullScreenViewer.tsx:891`,
`components/viewers/MultiDocViewer.tsx:863`), and the org Site Codebook is
already the fallback vocabulary at `app/(protected)/requests/new/page.tsx:139-150`.

**Done when.**
1. All three origins produce tickets satisfying the same required-field set the
   portal enforces.
2. A collision ticket has a target completion date and enrols its flagger as a
   watcher.
3. Unit-filtered queue views show check-in and collision tickets.

---

## LIFE-10 · `outcome_ref` is write-only, and the field-verification register the migration indexed has no reader

- **Severity:** MEDIUM
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 6 severity sweep, Round A2).** `outcome_ref` has a reader: `CheckoutHistoryPanel` maps it on every session row, links a check-in outcome to the ticket it spawned (`/requests/{id}`, labelled by ticket number), shows "hold placed" when `holdId` is present (written since this round — `LIFE-6`), and shows the attested revision on a field-verified row. A "Last field-verified" banner reads the register (`checkout_sessions` where `outcome IN (field_verified, discrepancy)`) and states the rev, date and person — and, when a later `discrepancy` exists, that it has been superseded.
- Done-when: (1) ✓; (2) ✓ (a later discrepancy visibly supersedes); (3) ✓.
- Files: `components/documents/CheckoutHistoryPanel.tsx`. Tests: `lib/__tests__/lifeSweep2.test.ts`.

- **Verification:** CONFIRMED
- **Blast radius:** safety / compliance
- **Locations:**
  - `lib/checkoutEpisodes.ts:461-467` — the only write
  - `supabase/migrations/20261012_doc_class_and_checkin_outcomes.sql:47-51` — the index and its stated purpose
  - `components/documents/CheckoutHistoryPanel.tsx:150-151` — reads `outcome` and `outcome_note` only
  - `components/documents/CheckInPanel.tsx:338-347` — the `FIELD_VERIFIED` audit row
- **Related:** `LIFE-6`, `GAP-6`
- **Re-verified:** hardening pass — **SURVIVES**, by census. `outcome_ref` appears only in `lib/checkoutEpisodes.ts` — the writer at `:466` and a comment at `:145`. Nothing reads it, and `checkout_sessions_outcome_idx` (`20261012…:49-51`) was built for a query the codebase never issues.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Half the finding is exactly right — outcome_ref is write-only, so the ticketId/versionId/holdId/moc pointers it stores are unreachable, and the (document_id, outcome) index from 20261012:47-51 is used by no query. But "no screen, no query, no report" is false: the checkout-history panel shows 'Field verified ✓' with its note per session, and FIELD_VERIFIED audit rows appear in the admin audit log (they are merely absent from ACTION_STYLE, so not in the action filter dropdown). Suggest LOW: the real gap is a dedicated 'last field-verified' report and a reader for outcome_ref, not a missing record.

**Mechanism.** The migration builds a partial index specifically to answer a
stated question:

```sql
-- Field-verification attestations and outcome reporting query by document +
-- outcome ("who last verified this P&ID against the field?").
CREATE INDEX IF NOT EXISTS checkout_sessions_outcome_idx
  ON checkout_sessions (document_id, outcome) WHERE outcome IS NOT NULL;
```

Nothing asks that question. `CheckoutHistoryPanel` renders a per-session label
inside a history drawer; it does not read `outcome_ref` and does not surface
verification currency anywhere a decision is made. `FIELD_VERIFIED` has exactly
one producer and zero consumers.

**Failure scenario.** Someone asks the question the index was built for: *"when
was P-200-301 last verified against the field?"* The data exists. There is no
screen, no query, no report and no API that answers it. A P&ID verified three
years ago and one verified yesterday are visually identical everywhere in the
app. There is also no staleness concept — no expiry, no reminder, no overdue
state — unlike periodic review (`lib/reviewCycles.ts`) and acknowledgment
(`lib/acknowledgments.ts:217`), which both have full status/grace/overdue
machinery.

**Chain reaction.** `discrepancy` outcomes are the negative counterpart and
should retire a prior `field_verified` claim — currently they do not, so a
document can simultaneously show a positive attestation and an open discrepancy
ticket. **The one-field fix worth doing on its own:** make the checkout-history
entry for a `discrepancy` or `revision_requested` outcome link to the ticket it
created. That is the single most useful traversal in the whole flow.

**Done when.**
1. A document shows when it was last field-verified and against which revision.
2. A `discrepancy` outcome visibly supersedes an earlier `field_verified` claim.
3. Checkout history entries link to the tickets they spawned.

---

## LIFE-11 · The as-built *intent* never reaches the revision — `issueType: "As-Built"` is an unconnected dropdown

- **Severity:** MEDIUM
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 7 build 4 / Round C2 — step 2, the launcher).** The hand-back is the launcher that knows: a ticket whose `request_type` is `ASBUILT` pre-seeds `issueType: "As-Built"` (`handbackPreset`, per `DEC-26`), and the modal shows "Defaulted to As-Built because request REQ-xxx is an as-built request — change it if that's wrong" — visible, overridable with intent, never silently defaulted. The Lifecycle board's As-Built column reads `issue_type` from the published versions, so an as-built ticket that completed through the hand-back now appears there.
- Done-when: (1) ✓ carried without the publisher remembering, visibly and overridably; (2) ✓ the board reflects completed as-built tickets (through the revision they produced).
- Files: `lib/ticketHandback.ts`, `components/documents/RevUpModal.tsx`, `app/(protected)/requests/[id]/page.tsx`. Tests: `lib/__tests__/sweepRoundC2.test.ts`.


**Partial (2026-09-02, Phase 6 severity sweep, Round A2 — step 1 of the fix).** `RevUpModal` accepts `presetIssueType` (+ an optional note), applies it after the remembered per-library value exactly like `presetChangeType`, and shows "Defaulted to … by the launcher — change it if that's wrong" beside the field — visible and overridable, per `DEC-26`. The launcher that KNOWS the publish is an as-built — the ticket→document hand-back (`LIFE-1` / `DEC-22`) — is what passes it; until that lands, Done-when 1 is not yet observable and this stays OPEN.
- Files: `components/documents/RevUpModal.tsx`. Tests: `lib/__tests__/lifeSweep2.test.ts`.

- **Verification:** CONFIRMED
- **Blast radius:** correctness / compliance
- **Locations:**
  - `types/schema.ts:760` — `issueType?: "Internal Review" | "Issued for Construction" | "As-Built" | "Void"`
  - `components/documents/RevUpModal.tsx:75` — the dropdown option
  - `components/documents/LifecycleBoard.tsx:67` — `if (d.issueType === "As-Built") return "As-Built"`
  - `components/documents/CheckInPanel.tsx:234` — `requestType = card.ticketKind === "asbuilt" ? "ASBUILT" : "Revision"`
  - `lib/checkinOutcomes.ts:133` — `ticketKind: "asbuilt"`
- **Related:** `LIFE-1`
- **Re-verified:** hardening pass — **SURVIVES** — **and the title is easy to misread.** `issue_type` *is* written to `document_versions` (`revisions.ts:512, 889, 1636`), so the dropdown is not unwired. What never connects is the **intent**: the check-in captures `ticketKind: "asbuilt"` → `request_type: "ASBUILT"`, and the publisher's `issueType` choice weeks later is an independent free selection with no knowledge of that ticket. The body states this correctly; verify against the body, not the headline.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Correct the claim, keep the severity: 'issueType: "As-Built" is an unconnected dropdown' is false — it is wired end-to-end to the version row and to the Lifecycle board (VersionHistoryPanel.tsx:284 and evidencePack.ts:56 also render it). What is missing is propagation of the as-built intent into the modal's default, so the wrong-column outcome in the summary still follows from the sticky "Issued for Construction" default.

**Mechanism.** The system knows a document needs to be as-built at three points
and forgets at each boundary. The check-in card sets `ticketKind: "asbuilt"`;
that becomes `request_type: "ASBUILT"` on the ticket; and there the chain stops.
`document_versions.issue_type` — which drives the As-Built column on the
Lifecycle board — is a free choice a publisher makes in a dropdown weeks later
with no knowledge of the ticket.

The stated requirement contains this exactly: *"it needs to be as-built, then
send the file to a drafting request."* The "needs to be as-built" is a
**classification of the resulting revision**, and it is currently carried only as
a `request_type` string on a ticket the revision has no relationship with.

**Failure scenario.** The as-built is published and `issueType` is left at its
default, "Issued for Construction". The Lifecycle board shows P-200-301 in the
**IFC** column, not As-Built. Anyone using that board to answer "which drawings
reflect installed condition?" gets the wrong answer.

**Chain reaction.** `issueType` also drives `BackfillVersionModal`,
`SetRevUpModal`, and `lib/filenameParser.ts:36` (which infers As-Built from
filenames — evidence the concept is considered load-bearing). Correct as-built
classification is a precondition for the turnover item *"Final as-built drawings
— the drafted, issued as-built revisions, not just field markups"*
(`lib/turnover.ts:76`), currently satisfied by manual attestation.

**Done when.**
1. A revision published from an as-built ticket carries `issue_type: "As-Built"`
   without the publisher remembering to select it — visibly, and overridable with
   intent rather than silently defaulted.
2. The Lifecycle board's As-Built column reflects as-built tickets that
   completed.

---

## LIFE-12 · Ticket approval and document approval are two universes with no bridge and no shared vocabulary

- **Severity:** MEDIUM
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 6 severity sweep, Round A2 — Done-when 1; 2 and 3 were already met by absence).** The ticket's Source Document card now loads the document's effective review control and states, before any approval, that publishing the deliverable requires reviewer sign-off (N configured reviewers) — or may route through review — and that approving the ticket does not satisfy it. No ticket action creates or satisfies a `document_review_signoffs` row (`DEC-23` deleted the only bridge; the test pins that the page never calls `recordReviewSignoff`).
- Files: `app/(protected)/requests/[id]/page.tsx`. Tests: `lib/__tests__/lifeSweep2.test.ts`.

- **Verification:** CONFIRMED
- **Blast radius:** process / compliance
- **Locations:**
  - Ticket side: `lib/workflow.ts:198-298`, `lib/workflow.ts:37-43` (`requiresEngineerApproval`), `app/api/tickets/workflow-action/route.ts:91-132`
  - Document side: `lib/reviewControl.ts:193-256` (`openReviewRoster`), `:283-320` (`recordReviewSignoff` → `recordSignature` bound to `contentHash`), `lib/eSignatures.ts`
  - The only declared bridge: `lib/reviewControl.ts:60` — dead (`LIFE-2`)
- **Related:** `LIFE-2`, `WF-*`
- **Re-verified:** hardening pass — **SURVIVES**. Cross-area duplicate of `drafting-flow/TIER-8` — the ticket engine's `approve_*` vocabulary and the document review gate share no state, no terms and no data path.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Verified as an absence claim by repo-wide search: the two approval systems share no table, no signature, and no vocabulary, and the only mechanism that could have bridged them — reviewControl.ts:60's `if (input.relatedTicketId) return "none"` — is dead (see LIFE-2). The duplicate-notification consequence in the summary follows directly. MEDIUM is appropriate for a design/integration gap with no data-integrity loss.

**Mechanism.** Two complete, well-built, mutually invisible approval systems.

*Ticket approvals*: a role/identity state machine enforced server-side with a
capability policy. Approval is a status transition plus a history entry and an
`audit_logs` row. **No signature. No content binding.**

*Document approvals*: a reviewer **roster** (primaries + alternates, expanded
from people/roles/teams), each sign-off an **e-signature bound to the draft's
`content_hash`**, with automatic invalidation when the draft changes,
timeout-driven alternate activation, and auto-finalize on the last signature.

Neither knows the other exists. The word "approve" means two incompatible things
depending on which page you are on.

**Failure scenario.** A senior engineer reviews the as-built package on the
ticket and clicks "Approve as Engineer (Issue for Construction)". He believes he
has approved the as-built. When the revision is later published, the library's
`review_control` roster names him as a required reviewer — so he is notified
*again* to review the same drawing, this time with an e-signature ceremony. He
either signs a second time (two approval records for one change, differing
timestamps) or dismisses it as a duplicate and blocks the publish.

**Chain reaction.** This is *why* `LIFE-2`'s waiver is so tempting and so wrong.
The correct reconciliation is narrow: a ticket approval can substitute for a
document sign-off only when the approver is on the roster **and** the approval is
bound to the same artifact hash. Everything needed to check that exists —
`document_review_signoffs.content_hash`, `recordSignature`, `expandReviewers` —
but nothing composes them. **Do not merge the two systems.**

**Done when.**
1. A ticket with a source document shows that document's review requirements
   before the deliverable is approved.
2. Reviewers can see, from the document, that a ticket approval already happened
   and by whom.
3. No path lets a ticket approval create or satisfy a `document_review_signoffs`
   row without an e-signature.

---

## LIFE-13 · The document→ticket link is one-way — the ticket page never shows its source document

- **Severity:** MEDIUM
- **Status:** RESOLVED

**Resolution.** The ticket page now renders a Source Document card at the top of "Incoming Assets": document number, title, "Raised against Rev N", a live read of the register's CURRENT revision with an amber "Rev advanced — register now at Rev M" badge on drift, and an "Open in register" deep link (`/documents/{libraryId}?doc={id}`, the same shape `lib/revisions.ts` uses). A new pure helper `lib/sourceDocRef.ts` normalizes all three producer shapes (`document_number` vs `number`, `""` vs absent fields) and a `revDrift` rule that returns `unknown` — never a freshness or drift claim — when either side is missing. RLS decides access: the current-rev read uses `maybeSingle()`, and a document the viewer cannot see renders the captured reference as plain text with "not accessible to you" — no error, no false claim.
- Commit: `2af2ebe`
- Files: `lib/sourceDocRef.ts`, `lib/__tests__/sourceDocRef.test.ts`, `app/(protected)/requests/[id]/page.tsx`
- Tests: `lib/__tests__/sourceDocRef.test.ts` — 7 tests pinning each producer shape verbatim, the no-id null case, and the drift rules (`same`/`drifted`/`unknown`, whitespace- and case-insensitive).
- Reproduced: grep of the whole 2000-line ticket page returned zero `source_document` references while all three producers write it (`CheckInPanel.tsx:262`, `requests/new/page.tsx:291`, `transitionIn.ts:322`) — link in the data, absent from the product, exactly as filed.
- Verified: Done-when 1 — the card links to the controlled document when the register row resolves. Done-when 2 — drift between the captured rev and `documents.rev` renders the amber badge; a ticket that captured no rev (the transitionIn shape) shows the register rev with no drift claim. tsc/eslint clean, suite 1407 green.
- **Hardened (2026-08-24 adversarial-review round).** The backlink lookup
  fetched the document by id alone, leaning on RLS — but a viewer who belongs
  to TWO workspaces resolves a same-id document from the other one, and the
  card would render it as this ticket's source with a false drift verdict.
  The query is now additionally scoped `.eq('org_id', <ticket's org>)`, so a
  cross-org id renders the captured reference as plain text (the
  `unavailable` branch), exactly like a document the viewer cannot see.
- **What this brought to light:** the three producers write three DIFFERENT shapes — recorded as new finding `LIFE-15` below. Also `metadata.source_document.path` has zero consumers anywhere (dead weight in the blob), and `lib/impact.ts:117` filters tickets on `metadata->source_document->>id`, which is unconstrained member-writable metadata — a forged id would surface an unrelated ticket in a document's Impact panel; the new card at least makes a forgery user-visible on the ticket itself.
- **Verification:** CONFIRMED
- **Blast radius:** correctness / ux
- **Locations:**
  - `components/documents/CheckInPanel.tsx:259-262` — writes `metadata.source_document`
  - `app/(protected)/requests/new/page.tsx:290-298` — writes it
  - `lib/transitionIn.ts:322` — writes it
  - `lib/impact.ts:113-119` — the document→ticket read
  - `app/api/tickets/workflow-action/route.ts:231-233` — the intent-bridge read
  - `app/(protected)/requests/[id]/page.tsx:1351,1796` — source files render as a flat filename list; **no reference to `source_document` anywhere in the file**
- **Related:** `LIFE-4`
- **Re-verified:** hardening pass — **SURVIVES**. `CheckInPanel.tsx:259-262` and `requests/new/page.tsx:290-298` both write `metadata.source_document` onto the ticket, and no ticket surface renders it — the link exists in the data and not in the product.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed one-way: the document surface reads the link, the ticket surface never renders it — no document number, no rev, no navigation back, so a drafter cannot see that metadata.source_document.rev is stale. MEDIUM is right.

**Mechanism.** Three producers write a structured backlink
`{ id, document_number, title, rev, path }`. Two server-side consumers read it.
The ticket detail page — the one screen a drafter actually works from — renders
none of it. The drafter sees `P-200-301_Rev3_markup.pdf` in a "Source Files" list
with no link to the controlled document, no indication of its current revision,
no visibility of active holds, and no way to know whether the document has
advanced since the request was filed.

**Failure scenario.** A drafter picks up the as-built ticket. The attached
marked-up PDF says Rev 3. He drafts against it. Meanwhile Rev 4 was published for
an unrelated change. He has no way to notice: the ticket shows a filename, not a
live document reference, and `metadata.source_document.rev` (which is `"3"`) is
not rendered even though it is the exact fact that would reveal the drift. He
delivers an as-built built on a superseded base.

The `doc_superseded` machinery *would* have caught this —
`notifySuperseded` (`lib/postPublish.ts:23-47`) targets live intent holders, and
the intent bridge does create a `document_intents` row when a ticket enters
DRAFTING — **provided the ticket has a `source_document.id`**, which is exactly
what the book-viewer path drops (`LIFE-4`). The safety net exists and is defeated
by a missing field, with no visible fallback on the ticket page.

**This requires no schema change** — it is a read of data that already exists.

**Done when.**
1. A ticket with a source document displays a working link to it.
2. The ticket shows when the source document's current revision differs from the
   revision the request was raised against.

---

## LIFE-14 · A check-in that fails after ticket creation orphans the ticket and leaves the checkout open

- **Severity:** MEDIUM
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 6 severity sweep, Round A2).** The durable key already existed: the check-in ticket carries `metadata.checkin.episodeId`. `CheckInPanel` now looks that ticket up on mount (open status, this episode) and reuses it before ever creating one, so a check-in interrupted after ticket creation and resumed in a new component instance links to the existing ticket. The 24 h ad-hoc sweep writes `auto_released` only over a NULL `outcome` — it can no longer overwrite a human verdict.
- Done-when: (1) ✓; (2) ✓ for the sweep path (the remaining way to leave a NULL outcome is a session close that never completes — visible in the history panel as an open session, not a false verdict).
- Files: `components/documents/CheckInPanel.tsx`, `lib/projects.ts`. Tests: `lib/__tests__/lifeSweep2.test.ts`.

- **Verification:** CONFIRMED
- **Blast radius:** data-integrity
- **Locations:**
  - `components/documents/CheckInPanel.tsx:155-159` — `doneRef` idempotency guard (component-scoped `useRef`)
  - `components/documents/CheckInPanel.tsx:359-390` — ticket created, *then* `finishAndRecord`
  - `components/documents/CheckInPanel.tsx:165-203` — `finishAndRecord`, which can throw
  - `lib/checkoutEpisodes.ts:475-480` — `if (endErr) throw new Error(endErr.message)`
- **Related:** `LIFE-9`
- **Re-verified:** hardening pass — **SURVIVES**. `doneRef` is a `useRef` (`CheckInPanel.tsx:155-159`) tracking what has already succeeded within the commit sequence at `:359-390`. It does not survive an unmount, so an interruption leaves the ticket created and the checkout open. Cross-area duplicate of `drafting-flow/LEAK-6`.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. REFUTES the summary's mechanism — the session-close timeout it describes is precisely the case doneRef covers, so a second tap reuses the ticket and re-fires no PSM alert (a duplicate needs a full remount/refresh, or a timeout on the ticket INSERT itself, neither of which is the stated scenario). What survives is milder: the checkout stays open and the check-in register/audit row is missing while a live ticket exists — and the open checkout is arguably the correct fail-safe. Suggest LOW rather than MEDIUM.

**Mechanism.** The ordering is deliberate and correct in spirit — the comments
explain that the audit row is written only after the session actually ends, since
"an audit record of a check-in that then failed would be a false record". Ticket
creation, uploads, hold placement and PSM escalation all happen first, guarded
against duplication by `doneRef`.

But `doneRef` is a `useRef` on the component. It survives re-renders; **it does
not survive unmount.** If `finishMySession` fails (RLS hiccup, network, a
concurrent force-release) and the user closes the modal rather than clicking
retry, the ticket, its uploads, the hold and the PSM alert are all committed
while the checkout stays active, `outcome` stays NULL, and no `CHECK_IN` audit
row is written. Reopening check-in starts a fresh `doneRef` — the retry then
creates a **second** ticket, a second upload set, and a second PSM alert.

**Failure scenario.** The engineer reports the discrepancy from a tablet on
marginal signal. The ticket and PSM alert commit; the session-close write times
out. She sees "Check-in failed", assumes nothing happened, and taps through again
with signal. Now there are two priority-1 ASBUILT tickets for the same finding,
two "undocumented field change" alerts, and P-200-301 still shows as checked out
to her.

**Chain reaction.** The stale checkout blocks other publishers via
`evaluatePublishGuard` until the expiry sweep records `auto_released` — which
**overwrites the outcome slot**, erasing any evidence a discrepancy was reported
through that session. `StaleCheckoutBanner` and the expiry sweep are the only
recovery, and neither reconciles the orphaned tickets.

**Done when.**
1. A check-in interrupted after ticket creation, resumed in a new component
   instance, links to the existing ticket rather than creating a second.
2. No path leaves a committed ticket with a NULL `outcome` on its originating
   session.

---

## LIFE-15 · Three producers of `metadata.source_document` write three different shapes

- **Severity:** LOW
- **Status:** RESOLVED

**Resolution (2026-09-02, Phase 6 severity sweep, Round A2).** `buildSourceDocumentRef` in `lib/sourceDocRef.ts` is the one producer shape — `{id, document_number, title, rev}`, `null` (never `""`) for anything unknown, no `path`, and `null` without a non-empty id — and all three producers write through it (`CheckInPanel`, `requests/new`, `lib/transitionIn`). `parseSourceDocument` stays tolerant for historical rows; the strict reader in `/api/intake/resolve` now goes through the parser too (it could not read the check-in shape before). Done-when ✓: a test pins the builder↔parser round-trip and every legacy shape.
- Files: `lib/sourceDocRef.ts`, `components/documents/CheckInPanel.tsx`, `app/(protected)/requests/new/page.tsx`, `lib/transitionIn.ts`, `app/api/intake/resolve/route.ts`. Tests: `lib/__tests__/lifeSweep2.test.ts`, `lib/__tests__/sourceDocRef.test.ts` (unchanged, still green).

- **Verification:** CONFIRMED
- **Blast radius:** correctness
- **Locations:**
  - `components/documents/CheckInPanel.tsx:262` — writes `{id, document_number, title, rev, path: null}`
  - `app/(protected)/requests/new/page.tsx:291-297` — writes `{id, document_number, title, rev, path}` where every field except `id` may be `""` (each comes from `searchParams.get(...) ?? ''`)
  - `lib/transitionIn.ts:322` — writes `{id, number, title}` — the key is `number`, not `document_number`, and there is no `rev` and no `path`
  - `lib/sourceDocRef.ts` — the read-side normalizer added by `LIFE-13`'s fix, which tolerates all three
- **Related:** `LIFE-13`, `LIFE-4`
- *(Found while resolving `LIFE-13`, 2026-08-24. Checked only by this session — treat per the `author` grade until independently challenged.)*

**Mechanism.** The same logical record is written under three shapes with no
shared writer. Any consumer that reads one shape strictly silently loses the
others — `intelligence/19-wiring.md:263` already records the inverse case
(consumers reading `source_document.number` get `undefined` for form/check-in
tickets). `LIFE-13`'s fix normalizes on read, which protects the ticket page
only; `lib/impact.ts` and the workflow-action intent bridge read only `.id` and
are unaffected, but the next consumer to want the rev or number walks into it.
The `path` field has **zero consumers anywhere** and `requests/new` writes empty
strings for absent params, polluting the stored blob.

**Failure scenario.** A future surface (e.g. the drafting queue) renders
"source: {document_number} Rev {rev}" — and shows blank for every ticket created
from `transitionIn` (no such keys) and "Rev " for tickets whose params were
empty strings, with no error anywhere.

**Remediation (illustrative).** A single `buildSourceDocumentRef()` writer-side
helper next to `parseSourceDocument`, used by all three producers: canonical
keys, `null` over `""`, drop `path`. The stored history stays as-is; the parser
keeps tolerating old rows.

**Done when.** All producers write one canonical shape, `parseSourceDocument`
still accepts historical rows, and a test pins both.

---

## Verified sound — do not break

1. **`lib/checkinOutcomes.ts` — the outcome decision engine.** Pure,
   exhaustively unit-tested, and the honesty invariants are real: every
   claim-creating branch demands a typed note, the MOC gate is class-and-change
   scoped, and **"no MOC exists" is never blocked** — reporting an undocumented
   change is deliberately frictionless. Deriving 2–4 cards from purpose + class +
   authority instead of showing a menu is the single best design call in this
   flow.
2. **The check-in idempotency and note-attribution guards.** `recordNote` is
   passed explicitly so a note typed under an abandoned card can never become
   another outcome's register entry. `filesToAttach = card.allowUploads ? files : []`
   stops files picked under a previous card riding along invisibly. `mocRef` is
   nulled when status is `none` so a stale number can never sit beside "no MOC" —
   a self-contradicting PSM record. Unusually careful code; `LIFE-14` is about
   `doneRef`'s scope, not about this reasoning.
3. **`lib/documentGuards.ts` + the DB trigger.** Lock/hold invariants enforced in
   the lib *and* in Postgres, state re-fetched authoritatively rather than
   trusted from the client, and the authority tiers correctly asymmetric.
   `overrideLock` deliberately does not touch the hold check. **Preserve exactly
   — any hand-back must go *through* it, not around it.**
4. **`lib/postPublish.ts` — the shared post-publish pipeline.** Built precisely
   because paths had diverged and the most-controlled route was skipping
   protections the direct route provided. **Any new publish path must call
   `runPostPublishSideEffects` or it recreates the exact bug this module was
   written to fix.**
5. **The intake redline round-trip.** The best-implemented hand-off in the
   codebase. `flagCollisionToDrafting` stamps `intake_collision.intakeLinkId`;
   `/api/intake/resolve` surfaces open collision tickets to the contractor
   portal; `/api/intake/upload` **verifies the link owns the ticket before
   attaching**, stores to a scoped R2 key, notifies both sides, and writes an
   `INTAKE_REDLINE` audit row. Bidirectional, authorized, audited. **This is the
   template the internal seams should follow.** (Note `OWN-4` concerns a
   different branch of that same route.)
6. **The ticket-internal redline loop.** A reviewer redlines a Draft, it uploads
   as a `REDLINE_`-prefixed Reference attachment with a `TICKET_REDLINE_CREATED`
   audit row, and the drafter finds it surfaced in the revision banner rather
   than buried in the file list. Complete and closed.
7. **`app/api/tickets/workflow-action/route.ts` — server-side workflow
   enforcement.** The client sends inputs only; the server re-authenticates,
   verifies active membership, re-validates the action against
   `WorkflowEngine.getActions` with the org's own capability policy, verifies a
   picked "engineer" actually holds an Engineer role, applies compare-and-set on
   both status and `last_modified`, and writes audit + notifications server-side
   so a closed tab cannot skip them. **Do not move any of this to the client.**
   (Its defects are `WF-*`, all within this correct frame.)
8. **`lib/reviewControl.ts` — sign-off integrity.** Signatures bind to the
   draft's `content_hash`; a new draft voids prior sign-offs and tells the
   earlier signers why; a roster that fails to save is escalated rather than
   passing silently; an empty primary roster notifies rather than leaving a draft
   unpublishable in silence; the last signature auto-finalizes with the DB
   re-checking completion transactionally. The only thing wrong here is the dead
   waiver at line 60 (`LIFE-2`).
9. **`lib/docClass.ts` — fail-closed class resolution.** A *transient* failure
   throws rather than returning null, because "we couldn't check" must never read
   as "no class declared" — that is precisely how a PSM gate quietly turns itself
   off. `RevUpModal` honours it: `docClassUnknown` is treated as `drawing` for the
   MOC gate. **Preserve the throw.**
