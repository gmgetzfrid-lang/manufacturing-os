# 11 · The ticket → document handoff

**13 findings** — 6 HIGH · 7 MEDIUM.

Where the request flow meets controlled document lifecycle, and the as-built markup path.

> Each finding below survived an adversarial verification pass: a second agent read
> the cited code and tried to refute it. Refuted findings were dropped and are not
> recorded here. Severities marked by that pass override the original.


---


<a id="hand-1"></a>

## HAND-1 · A configured review gate fails OPEN when the policy can't be read — the resolver swallows query errors and RevUpModal's catch degrades to "none"

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/reviewControl.ts:40`, `lib/reviewControl.ts:45`, `lib/reviewControl.ts:48`, `components/documents/RevUpModal.tsx:195`, `components/documents/RevUpModal.tsx:210`, `lib/documentLifecycle/setRevUp.ts:84`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed fail-open, and no DB backstop catches it: supabase/migrations/20260822_review_completion_guard.sql:53 only raises when `COALESCE(v_primary_reqs, 0) > 0`, i.e. only when a roster already exists — and a gate that failed open never creates one. The contrast in the very same effect hook settles intent: the doc-class/MOC resolution at RevUpModal.tsx:199-202 deliberately fails CLOSED (`setDocClassUnknown(true)`), while the review gate silently degrades to 'none'.

**Mechanism.** `effectiveReviewControlForDocument` destructures only `{ data }` from both container reads and never inspects `error`. A failed read on `collections` or `libraries` yields `data === null`, which becomes `null` control, which `resolveEffectiveReviewControl` falls through to `NONE = { mode: "none" }`. The function returns a normal-looking "no policy" answer for "we could not check". RevUpModal compounds it: its try/catch sets `setReviewControl(null)` on throw, and line 210 coalesces to `{ mode: "none" }`. `willReview` is then false and the modal takes the direct-publish branch. The escape-hatch warning banner at line 643 is gated on `reviewControl && reviewControl.mode !== "none"`, so in this state the user is not even told the gate was skipped. The batch path is explicit about it: `catch { /* unresolved policy → direct publish, as before */ }`. This is the exact inverse of the sibling resolver: `effectiveDocClassForDocument` does `if (error) throw error` and its comment says why — "'we couldn't check' must never silently read as 'no class declared' — that's how a PSM gate quietly turns itself off."

**Failure scenario.** A drafter opens Rev Up on a P&ID in a library configured `mode: "require"` with three named reviewers. The `libraries` select returns an error (transient network, a PostgREST hiccup, an RLS change that narrows library visibility for non-controllers). The modal shows no review banner, no escape-hatch warning, and the Publish button behaves normally. The revision goes live as the controlled copy with zero sign-offs. The DB completion guard cannot catch it either: it only fires when the promoted version already carries roster rows, and a direct publish creates none.

**Evidence.**

```
lib/reviewControl.ts:44-49 —
  if (doc.collectionId) {
    const { data } = await supabase.from("collections").select("review_control").eq("id", doc.collectionId).maybeSingle();
    folder = (data as ControlCols)?.review_control ?? null;
  }
  const { data: lib } = await supabase.from("libraries").select("review_control").eq("id", doc.libraryId).maybeSingle();
  return resolveEffectiveReviewControl(doc.reviewControl ?? null, folder, (lib as ControlCols)?.review_control ?? null);

components/documents/RevUpModal.tsx:195-197 —
        const c = await effectiveReviewControlForDocument({ reviewControl: doc.reviewControl ?? null, collectionId: doc.collectionId ?? null, libraryId });
        if (alive) setReviewControl(c);
      } catch { if (alive) setReviewControl(null); }

lib/docClass.ts:96-99 (the correct pattern, same repo) —
    if (isMissingDocClassSchema(e)) { docClassSchemaMissing = true; return null; }
    // Real failure — the caller must decide, not inherit a silent "no class".
    throw new Error(`Couldn't resolve the document class: ...`);
```

**Chain reaction.** Nothing downstream can recover: with no roster rows the 20260822 DB guard is inert, `getReviewSummaries` reports the doc as not-in-review, and the doc-control register shows a clean Issued row. The bypass leaves no artifact at all.

**Done when.**

- [ ] `effectiveReviewControlForDocument` checks `error` on both container reads and throws, mirroring `effectiveDocClassForDocument`.
- [ ] RevUpModal's catch sets an explicit `reviewControlUnknown` state that fails CLOSED (routes through review, or blocks publish) rather than coalescing to `{mode:"none"}`.
- [ ] setRevUp.ts:84 stops treating an unresolved policy as permission to publish directly.

---

<a id="hand-2"></a>

## HAND-2 · Any active org member can release the safety hold the publish guard depends on

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260901_db_hard_enforcement.sql:53`, `supabase/migrations/20260901_db_hard_enforcement.sql:98`, `lib/capabilityPolicy.ts:87`, `lib/documentGuards.ts:117`, `lib/holds.ts:105`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed and internally inconsistent: documentGuards.ts:114-117 states holds are 'deliberate do-not-advance flags reserved for the controller tier' and refuses a library publisher's force, yet the same publisher can simply UPDATE released_at under the shipped '*' default. Note also that checkout.force_release is defaulted to ["Admin","DocCtrl"] and flagged `critical: true`, while holds.release is neither — so the weaker control guards the stronger promise. lib/holds.ts:105-109 additionally fails open on a policy-lookup error.

**Mechanism.** `evaluatePublishGuard` is built around the premise that holds are the controller tier's veto: `const canForceHold = forcing && isController;` with the comment "an active HOLD still stops them: holds are deliberate 'do not advance' flags reserved for the controller tier." But the hold itself is protected by `holds.release`, whose shipped default is `["*"]` in both enforcement layers — `defaultRoles: ["*"]` in capabilityPolicy.ts and `WHEN 'holds.release' THEN '["*"]'::jsonb` inside `org_capability_allows`, which the `document_holds_update` RLS policy calls. The client-side `assertHoldCapability` additionally fails open by design on any policy-lookup error ("policy lookup hiccup: fail open — matches historical behavior"), so the RLS default is the real boundary. The veto a controller places is removable by the person it was placed against.

**Failure scenario.** DocCtrl places a "Field Verification Needed" hold on a P&ID after a discrepancy report, specifically to stop revisions publishing until the field is walked. The Drafting Supervisor — who holds `publish` on that library but is not a controller — hits the hold when publishing. Rather than escalating, they open the hold strip, click Release (allowed: `holds.release` defaults to everyone), and publish immediately. Both actions are audited, but nothing prevented either, and the reviewer/controller learns about it from a notification after the fact.

**Evidence.**

```
lib/documentGuards.ts:115-121 —
  // A controller (Admin/DocCtrl) forces past EVERYTHING. A per-library publisher
  // (canControlLibrary, e.g. a granted Drafting Supervisor) may force past a
  // foreign CHECKOUT — but an active HOLD still stops them: holds are deliberate
  // "do not advance" flags reserved for the controller tier.
  const canForceLock = ...
  const canForceHold = forcing && isController;

supabase/migrations/20260901_db_hard_enforcement.sql:51-56 —
    v_tokens := CASE p_cap
      WHEN 'holds.open' THEN '["*"]'::jsonb
      WHEN 'holds.release' THEN '["*"]'::jsonb
      WHEN 'checkout.force_release' THEN '["Admin","DocCtrl"]'::jsonb

lib/capabilityPolicy.ts:87-88 —
  { id: "holds.release", area: "Holds", label: "Release a hold",
    description: "Release an open hold.", defaultRoles: ["*"] },
```

**Chain reaction.** The as-built check-in offers this same hold as the one mechanism that stops work from a known-wrong drawing (CheckInPanel.tsx:626-628: "stops new revisions publishing until the discrepancy is resolved") — and it is offered as an unchecked box (`useState(false)` at line 126), so the common case is a reported discrepancy with no hold at all, backed by a hold anyone can lift when there is one.

**Done when.**

- [ ] `holds.release` ships defaulting to the controller tier (matching `checkout.force_release`), with widening left to an explicit admin decision.
- [ ] Releasing a hold opened by someone else requires a reason recorded on the hold row and notifies the opener before the release commits.
- [ ] The comment in documentGuards.ts either matches the shipped policy or is corrected.

---

<a id="hand-3"></a>

## HAND-3 · The drafting ticket never becomes a document revision — the two systems share no write path

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/ticketTransitions.ts:221`, `lib/ticketTransitions.ts:247`, `app/api/tickets/workflow-action/route.ts:148`, `app/api/tickets/workflow-action/route.ts:240`, `app/(protected)/requests/[id]/page.tsx:577`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: no ticket transition writes documents.current_version_id or inserts a document_versions row. Corroborating dead code — `related_ticket_id` exists in supabase/schema.sql:334 and is READ at lib/revisions.ts:958 and documents/[libraryId]/page.tsx:1893, but a repo-wide grep finds no write to it anywhere. The only cross-link is advisory (lib/impact.ts:117 queries `metadata->source_document->>id`), and requests/[id]/page.tsx:577 stamps the ticket deliverable 'UNCONTROLLED COPY'.

**Mechanism.** `computeTransition` is the sole authority for every ticket action and it writes only ticket columns. Approving a draft sets `updates.deliverable_rev = issuedRevLabel(...)` — a string on the `tickets` row — and moves status to PENDING_IFC. The server route applies that object to `tickets` and nothing else. Its only contact with `documents` is a READ at line 240 (`.from("documents").select("current_version_id, library_id")`) used to seed a `document_intents` row. Three differently-shaped searches confirm the absence: (a) `grep -rn "revUpDocument|createDocumentWithFile|submitForReview"` across app/components/lib returns only RevUpModal, documentLifecycle/{merge,setRevUp}, DocumentLinkPicker and outputTemplates — no ticket file; (b) `grep -rn "document_versions|documents\""` inside app/api/tickets and app/(protected)/requests returns exactly one hit, the read above; (c) case-insensitive `grep -rin "publish|rev up|revUp"` over the whole requests UI returns zero hits. Meanwhile the ticket page stamps the deliverable PDF with `${ticketId} deliverable Rev ${deliverableRev} at time of download` plus a QR to /verify-ticket.

**Failure scenario.** A field engineer reports an as-built discrepancy on P-101 Rev 3. The ticket is drafted, engineer-approved, and issued as "Rev 1" (ticket-local numbering — unrelated to the document's Rev 3). The drafter uploads the final package under `submit_final`; the requester clicks Acknowledge & Close. The ticket now reads CLOSED / Rev 1, the QR verifies, and the crew prints the stamped package. The controlled document P-101 still says Rev 3 with the old PDF; `loadDocControlRegister` still reports Rev 3 as the current controlled copy; the distribution/ack roster was never re-opened; nobody holding a printed Rev 3 is recalled. The construction package in the field is a ticket attachment that looks like a controlled revision and is not one.

**Evidence.**

```
lib/ticketTransitions.ts:221-225 —
    case "approve_draft_ifc":
      updates.status = "PENDING_IFC";
      updates.deliverable_rev = issuedRevLabel(ticket.revisionCount);
      historyEntry.action = `${input.actionLabel} — issued Rev ${updates.deliverable_rev}`;
      break;

app/(protected)/requests/[id]/page.tsx:649-651 —
        footerNotice: deliverableRev
          ? `${ticketId ?? "Ticket"} deliverable Rev ${deliverableRev} at time of download — scan the QR to confirm it is still the latest.`
```

**Chain reaction.** Because no document version exists, `runPostPublishSideEffects` never runs for ticket work: no stale-copy recall to intent holders, no work-package pin-drift alert, no review-cycle reset, no fresh read-&-understood roster, no retention recompute. lib/impact.ts:117 keeps listing the ticket as "open work" only while its status is in OPEN_TICKET_STATUSES; once CLOSED the document shows no trace of the drafting cycle at all.

> **Verifier correction.** The mechanism is accurate but the framing overstates it as a broken write path rather than a documented separation. Verified: lib/ticketTransitions.ts:221-225 writes only ticket columns (`updates.deliverable_rev = issuedRevLabel(...)`); app/api/tickets/workflow-action/route.ts:148 applies that object to `.from("tickets")` (lines 156/174) and its only `documents` contact is the READ at line 241 (`.select("current_version_id, library_id")`) feeding a `document_intents` upsert. Absence re-checked three ways: (a) grep for revUpDocument|createDocumentWithFile|submitForReview|finalizeReviewedRevision|publish_revision across app/lib/components returns no ticket file; (b) grep for `from("documents")`/`document_versions` inside app/api/tickets and app/(protected)/requests returns exactly route.ts:241; (c) case-insensitive publish|rev up|revUp over app/(protected)/requests returns zero hits. Also: `related_ticket_id` (schema.sql:334) is read (revisions.ts:958) but never written anywhere, so the two rev chains genuinely never join. Two things the finding omits: docs/ARCHITECTURE.md:690-698 states the ticket rev chain is deliberately autonomous ("tracks deliverable revisions autonomously, like document control's rev chain"), and a human handoff path exists (CheckInPanel creates the ticket from a checkout; the drafter publishes through RevUpModal, with document_intents bridging the two). Cited location page.tsx:577 says "at time of printing"; the quoted "at time of download" string is at line 650.

**Done when.**

- [ ] A ticket reaching PENDING_IFC/FINAL_DRAFT with a `metadata.source_document.id` either (a) opens a real `document_versions` row through `revUpDocument`/`submitForReview` against that document, or (b) is blocked from closing until a controller does so — with the ticket recording the resulting `document_version_id`.
- [ ] The ticket deliverable stamp/QR either names the controlled document revision it produced, or explicitly states "not a controlled revision".
- [ ] A ticket whose source document has advanced since the request is flagged (compare against a captured base version id) rather than silently drafted against a stale rev.

---

<a id="hand-4"></a>

## HAND-4 · The sign-off rows the DB review guard counts are writable by the publisher the guard is meant to constrain

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260830_publisher_row_management.sql:34`, `supabase/migrations/20260830_publisher_row_management.sql:47`, `supabase/migrations/20260828_integrity_hardening.sql:223`, `supabase/migrations/20260822_review_completion_guard.sql:48`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the guard's only input is a status column the constrained publisher may write. A grep of supabase/migrations for triggers on document_review_signoffs finds none — nothing validates that a 'signed' row carries a matching e_signatures row or that signature_id/signed_at were set by the reviewer, so a direct PATCH satisfies the completion gate.

**Mechanism.** The review-completion guard computes `count(*) FILTER (WHERE slot='primary')` vs `count(*) FILTER (WHERE status='signed')` straight out of `document_review_signoffs`. The current UPDATE policy on that table (20260830, which replaced the tighter 20260828 version by adding the `user_can_publish_on_library` arm) permits an update when the actor is the reviewer, OR Admin/DocCtrl, OR the effective owner, OR anyone with publish authority on the library. Its WITH CHECK is only "is an active org member" — it does not pin `reviewer_user_id`, `status`, or `slot`. The INSERT policy is looser still: any active member may insert any row. Since the whole app is a browser client against PostgREST with RLS as the boundary, these policies are the enforcement, not a second layer behind one.

**Failure scenario.** A Drafting Supervisor holds `publish` on the P&ID library and submits a draft that requires two engineer sign-offs. They are blocked from finalizing. From the same authenticated session they PATCH `document_review_signoffs` for their draft's version, setting `status='signed'` on both reviewer rows (permitted: they satisfy the `user_can_publish_on_library` arm, and WITH CHECK only asks that they be an active member). `reviewCompletionForDraft` now returns complete, `finalizeReviewedRevision` promotes the draft, and the DB guard's counts agree. Alternatively any Viewer inserts one forged row `{slot:'alternate', status:'signed'}` against the pending version, raising `v_signed` without raising `v_primary_reqs`.

**Evidence.**

```
supabase/migrations/20260830_publisher_row_management.sql:41-50 —
    OR EXISTS (SELECT 1 FROM documents d WHERE d.id = document_review_signoffs.document_id
               AND (
                 user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid())
                 OR user_can_publish_on_library(d.library_id, auth.uid()::text, d.org_id)
               ))
  )
) WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_review_signoffs.org_id
          AND uid = auth.uid() AND status = 'active')
);

supabase/migrations/20260828_integrity_hardening.sql:223-227 —
CREATE POLICY doc_review_signoff_insert ON document_review_signoffs FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_review_signoffs.org_id
          AND uid = auth.uid() AND status = 'active')
);
```

**Chain reaction.** `recordReviewSignoff` normally binds an e-signature to the draft's content hash via `recordSignature`; a direct row write produces a `status='signed'` row with `signature_id NULL`, which neither `reviewCompletionForDraft` (reviewControl.ts:366) nor the SQL guard checks. The signature ceremony becomes optional for satisfying the gate.

**Done when.**

- [ ] The UPDATE policy's WITH CHECK pins `reviewer_user_id`, `slot`, and `document_version_id` to their OLD values, and only the reviewer themselves may move `status` to 'signed'.
- [ ] The INSERT policy restricts roster creation to controllers/owner/library publisher and rejects rows arriving with `status <> 'pending'`.
- [ ] Completion counts only rows with a non-null `signature_id` whose stored `content_hash` matches the version being promoted.

---

<a id="hand-5"></a>

## HAND-5 · Trusted intake links publish controlled revisions through the service role, skipping the publish guard and the entire post-publish pipeline

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/intake/upload/route.ts:302`, `app/api/intake/upload/route.ts:322`, `supabase/migrations/20260822_review_completion_guard.sql:32`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on both halves. The service-role write bypasses the hold check entirely, and a grep for runPostPublishSideEffects shows callers only in lib/revisions.ts:711,1304 and lib/reviewControl.ts:499 — never the intake route, so the ack-roster recompute, retention recompute, and supersede/watcher notifications never run for an auto-superseded intake revision. The route substitutes only its own controllers/owner notification and audit row.

**Mechanism.** `/api/intake/upload` is token-gated with no account (route header: "Token-gated (no account); the server does everything") and uses `supabaseAdmin`. On the `autoNow` branch it writes `current_version_id`, `rev`, `status: "Issued"` directly. `enforce_document_publish_guard()` begins `IF v_actor IS NULL THEN RETURN NEW; END IF;` — service-role writes carry no JWT, so auth.uid() is NULL and the trigger returns immediately. That skips all three of its checks: review completion, per-library publish authority, and the active-hold check. Separately, `grep -n "postPublish|runPostPublish|openReviewRoster|onDocumentIssued|recomputeRetention|effectiveReviewControl" app/api/intake/upload/route.ts app/api/intake/resolve/route.ts` returns zero hits — the shared pipeline that revUpDocument (revisions.ts:711) and finalizeReviewedRevision (reviewControl.ts:499) both run is absent here.

**Failure scenario.** DocCtrl places a "Field Verification Needed" hold on a drawing an intake link authored, because the field crew reported it does not match reality. The vendor, holding the same trusted link, uploads a new sheet. The route takes the autoNow branch, sets the document to Issued at the new rev, and supersedes the prior version — the hold is never consulted. Nobody who downloaded the previous rev is told their copy is stale, the ack roster is not reopened, and the review clock is not reset. The document silently advances past a hold that exists precisely to stop it advancing.

**Evidence.**

```
app/api/intake/upload/route.ts:302 —
  const autoNow = !!docId && !!link.allow_auto_supersede && linkAuthored;
app/api/intake/upload/route.ts:324-326 —
    await supabaseAdmin.from("documents")
      .update({ current_version_id: versionId, rev: revLabel || "A", revision: revLabel || "A", status: "Issued", pending_version_id: null, updated_at: nowIso })
      .eq("id", documentId);
supabase/migrations/20260822_review_completion_guard.sql:32-34 —
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;
```

**Chain reaction.** Every downstream protection keyed on the publish pipeline is silently absent for this class of revision: stale-copy recall, work-package pin drift, distribution acks, retention seeding, review-cycle reset. Because the guard is the same function the app's own lock/hold checks defer to, this is the one publish path in the system with no gate at all.

> **Verifier correction.** All quotes verified: route header line 3 ("Token-gated (no account); the server does everything"), `const autoNow = !!docId && !!link.allow_auto_supersede && linkAuthored;` at upload/route.ts:302, the supabaseAdmin documents UPDATE with `status: "Issued"` at 323-325, and `IF v_actor IS NULL THEN RETURN NEW; END IF;` at 20260822_review_completion_guard.sql:32-34 (exact line numbers confirmed by grep). The guard is defined four times (20260713, 20260812, 20260816, 20260822) and every version begins with the same NULL-actor early return, so a service-role write bypasses review completion, per-library authority AND the active-hold check. Post-publish pipeline absence re-checked: grep for postPublish|runPostPublishSideEffects|recomputeRetention|openReviewRoster|effectiveReviewControl in both intake routes returns nothing (exit 1); `openReviewRoster` has exactly one call site repo-wide, lib/revisions.ts:933. Two qualifiers the finding should carry: the branch fires only when an admin has set `allow_auto_supersede` on the link AND the target document is provably link-authored (own-work check at route.ts:242-252), and the route does notify Admin/DocCtrl plus the project owner (lines 336-355) even though the shared pipeline (supersede signals to intent holders, ack roster, review clock, retention) never runs.

**Done when.**

- [ ] The intake auto-supersede branch re-checks active holds and the effective review policy in the route before promoting, since the DB trigger cannot see it.
- [ ] The intake promote calls the same `runPostPublishSideEffects` pipeline as every other current-revision change.
- [ ] A document with an active hold cannot be advanced by any intake link regardless of trust level.

---

<a id="hand-6"></a>

## HAND-6 · review_control and doc_class resolve only the document's immediate folder — every intermediate folder in the container chain is skipped

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/reviewControl.ts:31`, `lib/reviewControl.ts:40`, `lib/docClass.ts:49`, `lib/docClass.ts:85`, `components/documents/ReviewGateSection.tsx:52`, `lib/reviewControl.ts:545`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed — every policy resolver consults exactly three levels (document, immediate collection, library) while the folder tree is arbitrarily deep, so a policy set on 'P&IDs' does not reach 'P&IDs / Unit 400 / Current'. An ancestor-chain helper already exists (lib/serverCollections.ts:52 walks `cur.parent_id` up to 200 hops) but no policy resolver calls it.

**Mechanism.** `resolveEffectiveReviewControl` is a three-slot fold — `for (const c of [docControl, folderControl, libraryControl]) if (c) return c;` — and `effectiveReviewControlForDocument` fills the middle slot from a single `.eq("id", doc.collectionId)` read. But `collections` is a tree: `supabase/schema.sql:94` declares `parent_id UUID REFERENCES collections(id)` and rows carry `path_ids UUID[]`. Nothing in the resolution path walks it. Two differently-shaped searches confirm: `grep -rn "path_ids" --include=*.ts --include=*.tsx lib components app` returns only collection move/rename/delete plumbing (serverCollections, libraryCollections, api/collections/*) — zero hits in reviewControl/docClass; and `grep -rn "review_control|reviewControl"` across the app shows three independent resolvers (lib/reviewControl.ts:45, ReviewGateSection.tsx:52, scanReviews at reviewControl.ts:547) that each read only the immediate `collection_id`. docClass.ts:85 has the identical shape and its header claims "Resolution mirrors review_control exactly" — it does, including this gap. The ReviewControlModal is opened with `level: "library" | "collection"` from the library page, so a policy CAN be saved on a folder at any depth.

**Failure scenario.** DocCtrl opens the "P&IDs" folder, sets change-control to `require` with the process-safety engineer as reviewer, and reasonably expects everything beneath it to inherit. Drawings actually live in "P&IDs / Unit 400 / Current". For those documents `doc.collectionId` is the "Current" folder, which has no `review_control`, so resolution falls straight through to the library — which is unset — and returns `{mode:"none"}`. Every Unit 400 P&ID publishes directly, forever, with the policy visibly configured and green in the folder's settings. The same fold governs `doc_class`, so a library-wide "these are drawings" declaration made at a nested folder also fails to reach the sheets, disabling the OSHA 1910.119(l) MOC gate for them (RevUpModal.tsx:219 requires `docClass === "drawing"`).

**Evidence.**

```
lib/reviewControl.ts:31-38 —
export function resolveEffectiveReviewControl(
  docControl?: ReviewControl | null, folderControl?: ReviewControl | null, libraryControl?: ReviewControl | null,
): ReviewControl {
  for (const c of [docControl, folderControl, libraryControl]) {
    if (c) return c;
  }
  return NONE;
}

supabase/schema.sql:90-98 —
CREATE TABLE IF NOT EXISTS collections (
  ...
  parent_id UUID REFERENCES collections(id) ON DELETE CASCADE,
  ...
  path_ids UUID[] DEFAULT '{}',
```

**Chain reaction.** Both safety gates that key off container inheritance — pre-publish review and the PSM MOC requirement — are silently disabled for any document more than one folder deep. Nothing surfaces the discrepancy: the folder's settings modal shows the saved policy, and the document's Rev Up modal shows no gate.

**Done when.**

- [ ] Both resolvers walk the full ancestor chain (`path_ids` is already materialized and maintained by serverCollections.ts) nearest-first before falling back to the library.
- [ ] `scanReviews` and ReviewGateSection use the same walk, so the daily scan and the inspector agree with the publish path.
- [ ] A test covers document → child folder (undefined) → parent folder (defined) → library, asserting the parent folder's policy wins.

---

<a id="hand-7"></a>

## HAND-7 · An as-built request records the source revision as a text snapshot with no version id, so nothing detects the drawing moving underneath the drafting cycle

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/new/page.tsx:291`, `components/documents/CheckInPanel.tsx:262`, `app/api/tickets/workflow-action/route.ts:254`, `lib/revisions.ts:439`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: no document_versions.id is captured on the ticket, so the stale-base machinery in lib/revisions.ts:437-450 (`expectedBaseVersionId` / provenance session|declared|unverified) has nothing to compare against for a ticket-sourced change. The one version-anchored artifact, document_intents.base_version_id, is anchored to whatever was current when the ticket entered DRAFTING and expires on a TTL, so it also cannot flag the redlined Rev 3 having been superseded by Rev 4.

**Mechanism.** Both request-creation paths store `metadata.source_document = { id, document_number, title, rev, path }` — `rev` is a display string ("3"), never `current_version_id`. The publish contract's whole stale-base machinery keys off version ids: `revUpDocument` compares `expectedBase` against the live `current_version_id` and throws `StaleBaseError` on drift. A ticket carries nothing that machinery can consume. The intent bridge does capture a version id, but only when the ticket enters DRAFTING and it takes whatever is current at that moment (`base_version_id: docRow?.current_version_id`) — not what the requester was looking at when they redlined.

**Failure scenario.** A field engineer redlines P-101 Rev 3 on Tuesday and files an as-built request. On Thursday, unrelated MOC work publishes Rev 4 through the normal path. On the following Monday a drafter picks up the ticket, opens the attached marked-up Rev 3 PDF, and drafts from it. Nothing in the ticket, the drafting queue, or the deliverable review flags that the redlines were made against a superseded revision — the ticket still reads "Source: P-101 Rev 3" as inert text. The Rev 4 changes are silently reverted in the drafted package.

**Evidence.**

```
app/(protected)/requests/new/page.tsx:291-297 —
        metadata.source_document = {
          id: sourceDocId,
          document_number: sourceDocNum,
          title: sourceDocTitle,
          rev: sourceDocRev,
          path: sourceFileUrl,
        };

components/documents/CheckInPanel.tsx:262 —
        source_document: { id: doc.id, document_number: doc.documentNumber ?? null, title: doc.title ?? null, rev: doc.rev ?? null, path: null },

lib/revisions.ts:461 —
    if (freshDoc && liveCurrent !== expectedBase) { ... throw new StaleBaseError({...}) }
```

**Chain reaction.** Because the ticket also never publishes a document version (see the CRITICAL finding), the drafted package never passes through `revUpDocument`'s base check either — there is no point in the entire ticket lifecycle at which the stale base could be caught.

**Done when.**

- [ ] `metadata.source_document` captures `current_version_id` at request time alongside the display rev.
- [ ] The ticket surface compares that captured version against the document's live `current_version_id` and shows a "source revision has moved" banner in the drafting queue and on the ticket.
- [ ] Approving a deliverable drafted from a superseded base requires an explicit acknowledgement.

---

<a id="hand-8"></a>

## HAND-8 · As-built markups are never persisted anywhere; the only escape route silently falls back to the clean original

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/viewers/FullScreenViewer.tsx:912`, `components/viewers/FullScreenViewer.tsx:916`, `lib/markupRequests.ts:123`, `app/(protected)/inbox/page.tsx:139`, `components/dashboard/widgets.tsx:795`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on both halves. Markup state lives only in the component's `pageStates` React state (FullScreenViewer.tsx:369) — there is no markup table in supabase/migrations, and markup_requests stores only a pasted `shared_markup_url`, which both resolve call sites (inbox/page.tsx:139, dashboard/widgets.tsx:795) omit entirely, so lib/markupRequests.ts:123 writes `shared_markup_url: null` even for status 'shared'.

**Mechanism.** Markups live in React state (`pageStates` / the fabric canvas) and are written to no table. Searching for a persistence target from two directions confirms it: `grep -rn "document_markups|markups"` across lib/ and components/viewers/ finds only the request-channel module, and `grep -rn "markup" supabase/migrations/*.sql` finds only the `markup_requests` table (a message thread) — no markup-state table. The single path out of the browser is FullScreenViewer's "send to drafting": it bakes the fabric layers into the PDF bytes and stashes the result in IndexedDB. If `bakeMarkupIntoPdf` throws, the catch logs to console and leaves `draftKey` empty, and the flow proceeds with the clean original attached. The user is never told. Separately, the "share my markups" loop is inert: `resolveMarkupRequest` writes `shared_markup_url: input.sharedMarkupUrl || null` unconditionally, and both of its call sites — inbox/page.tsx:139 and widgets.tsx:795 — omit that field entirely, so "shared" always stores NULL.

**Failure scenario.** A process engineer checks out P-101 for As-Built Verification, spends an hour redlining twelve changes across four sheets in the viewer, and clicks Send to Drafting. `pdf-lib` throws on that particular PDF (encrypted, malformed xref, oversize). The drafting request is created with the pristine Rev 3 PDF attached and a description that no longer mentions markups. The engineer closes the tab; the redlines are gone with no copy anywhere. The drafter receives "revise P-101" with a clean drawing. Meanwhile a colleague who asked to see those markups gets an inbox toast reading "The requester can see your markups are available" pointing at a NULL URL.

**Evidence.**

```
components/viewers/FullScreenViewer.tsx:911-917 —
          try {
            const baked = await bakeMarkupIntoPdf(bytes, states);
            const stem = ...;
            draftKey = await stashDraft([{ name: `${stem}.pdf`, blob: new Blob([baked as BlobPart], { type: "application/pdf" }), docId: d.id, docNumber: docNum }]);
          } catch (e) {
            console.error("bake markup for drafting failed; falling back to clean original", e);
          }

lib/markupRequests.ts:118-126 —
    .from("markup_requests")
    .update({
      status: input.status,
      response: input.response?.trim() || null,
      shared_markup_url: input.sharedMarkupUrl || null,
      resolved_at: now,
    })

app/(protected)/inbox/page.tsx:139-147 — resolveMarkupRequest({ markupRequestId, status, orgId, projectId, actorUserId, actorEmail, actorRole })  // no sharedMarkupUrl
```

**Chain reaction.** lib/checkinOutcomes.ts:170 tells the user "use Download w/ Markup in the viewer, then attach that file below" — the check-in flow's redline card depends on the same bake succeeding and the user manually re-attaching, with no verification that anything was attached. The as-built evidence chain has no durable store at any point between the engineer's screen and the ticket attachment.

> **Verifier correction.** The headline's 'only escape route' clause is FALSE and must be dropped. FullScreenViewer has a second, prominent export: `downloadWithMarkup` at line 956, wired to the 'Download w/ Markup' toolbar button at 1219-1227, which bakes markups into a downloadable PDF, stamps an honest footer (line 1014: 'WITH MARKUPS at time of export — markups are not part of the controlled revision'), and DOES surface failures to the user (setMarkupError at 1061, rendered at 1317). MultiDocViewer bakes at lines 685 and 843 and stashes via stashDraft. What survives, verified: (a) markup state lives only in React state (`pageStates`, MultiDocViewer's `markupStore` at line 351) — grep for markup across supabase/migrations and schema.sql finds only the `markup_requests` message table (20260527:92, schema.sql:948), no markup-state table; (b) the send-to-drafting catch at FullScreenViewer.tsx:915-917 only console.errors and proceeds with the clean original, with no user-visible signal — the description line even omits '(marked-up sheet attached…)' silently; (c) resolveMarkupRequest (lib/markupRequests.ts:118-124) writes `shared_markup_url: input.sharedMarkupUrl || null` and both call sites — inbox/page.tsx:139-147 and widgets.tsx:795-803 — omit the field, so 'shared' always stores NULL.

**Done when.**

- [ ] Markup state is persisted per document+user (autosaved) so a failed bake, a refresh, or a closed tab cannot destroy field redlines.
- [ ] A failed bake surfaces a blocking error instead of silently substituting the clean original.
- [ ] Marking a request "shared" either uploads and stores an actual `shared_markup_url` or the UI stops claiming markups are available.

---

<a id="hand-9"></a>

## HAND-9 · Externally submitted revisions are approved with the roster gate explicitly turned off, and no roster is ever opened for them

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/projects/IntakePanel.tsx:237`, `lib/reviewControl.ts:408`, `app/api/intake/upload/route.ts:330`, `supabase/migrations/20260822_review_completion_guard.sql:53`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: an externally submitted revision never gets a document_review_signoffs roster, the app gate is explicitly disabled, and the DB completion check is roster-conditional, so a library configured mode:'require' with two named reviewers is fully bypassed by the intake approve button. The remaining DB checks (publish authority, active hold) still apply to this path because it runs on the user's session client, not the service role — but they say nothing about who reviewed.

**Mechanism.** The intake upload route parks a non-trusted submission by setting `pending_version_id` only (route lines 330-334); it never calls `openReviewRoster`, so `document_review_signoffs` has zero rows for that version. IntakePanel's approve then calls `finalizeReviewedRevision({ requireRosterComplete: false })`, which skips the app-side `reviewCompletionForDraft` check outright. The DB backstop cannot substitute: its completion clause is guarded by `IF COALESCE(v_primary_reqs, 0) > 0` — with no roster rows, `v_primary_reqs` is 0 and the check is a no-op. The code comment asserts "the approve click IS the review", but that reasoning discards whatever the library/folder actually configured.

**Failure scenario.** A library is configured `mode: "require"` with two named process-safety reviewers. A contractor submits a revised P&ID through their assigned intake link. It lands as `pending_version_id`. A project owner with library publish authority — not a configured reviewer, and possibly the person who commissioned the work — opens the Intake tab and clicks Approve. `finalizeReviewedRevision` promotes it to `current_version_id` with `status: "Issued"`. Two required sign-offs that the org configured for exactly this document never happened, and the audit row reads REVISION_PUBLISHED_AFTER_REVIEW.

**Evidence.**

```
components/projects/IntakePanel.tsx:237-240 —
      const res = await finalizeReviewedRevision({
        orgId, documentId: p.docId, actorId: uid, actorName: userEmail ?? "Reviewer",
        requireRosterComplete: false,
      });

lib/reviewControl.ts:408-411 —
  if (input.requireRosterComplete !== false) {
    const { complete } = await reviewCompletionForDraft(input.documentId, pendingId);
    if (!complete) return { published: false, reason: "incomplete" };
  }

supabase/migrations/20260822_review_completion_guard.sql:53 —
    IF COALESCE(v_primary_reqs, 0) > 0 AND COALESCE(v_signed, 0) < v_primary_reqs THEN
```

**Chain reaction.** The register (`getReviewSummaries` → docControlRegister) reports this revision as normally published; nothing distinguishes it from one that passed the gate. The audit action REVISION_PUBLISHED_AFTER_REVIEW actively misrepresents what happened.

> **Verifier correction.** Quotes verified: IntakePanel.tsx:237-240 passes `requireRosterComplete: false`; reviewControl.ts:408-411 skips reviewCompletionForDraft on that flag; the intake non-trusted branch sets only pending_version_id (upload/route.ts:330-333); 20260822:53 guards the completion check behind `COALESCE(v_primary_reqs, 0) > 0`, which is 0 with no roster rows. openReviewRoster has exactly one call site repo-wide (revisions.ts:933), so intake submissions never get a roster. Two mitigations the finding omits: the panel is only rendered for project owner / Document Control (`{tab === "intake" && canManage && ...}` at app/(protected)/projects/[id]/page.tsx:515), and the promote at reviewControl.ts:434-438 runs through the browser client, so the publish-guard trigger DOES bind (authority via user_can_publish_on_library/effective owner, plus the active-hold check). The real, narrower defect is that no intake path ever consults the destination library/folder review_control, so a 'require' policy is silently inapplicable to external revisions.

**Done when.**

- [ ] The intake upload route resolves the effective review control and calls `openReviewRoster` for the pending version when a gate is configured.
- [ ] IntakePanel's approve stops passing `requireRosterComplete: false` when the document's effective review control is not `none`.
- [ ] An intake approval that bypasses a configured gate writes a distinct audit action, not REVISION_PUBLISHED_AFTER_REVIEW.

---

<a id="hand-10"></a>

## HAND-10 · Publishing as a BRANCH skips the review gate outright, without the warning the Minor escape hatch gets

- **Severity:** MEDIUM
- **Status:** REFUTED
- **Verification:** CONFIRMED
- **Locations:** `components/documents/RevUpModal.tsx:279`, `components/documents/RevUpModal.tsx:293`, `lib/revisions.ts:546`
- **Independently verified:** ⛔ **REFUTED** by a second independent adversarial pass — do not work this finding. Kept in place with the reason rather than deleted (`DEC-41`). The scenario is unreachable: in a library with mode 'require' and a non-Minor change type, willReview is true, so doPublish(false) goes to submitForReview and the conflict screen — the only place the 'publish as an unreconciled branch' button lives (:449-490) — never renders. A branch can therefore only be published on a rev-up where the gate was already legitimately waived (mode none, Minor/Correction per reviewControl.ts:59, or publisher_choice with the box unchecked); `!asBranch` at :279 is defensive, not a gate-skip. The claim of 'no warning' is also wrong: the branch panel carries an explicit consequence block at :463-467 plus a mandatory reason (:253) and a post-publish 'Published as an UNRECONCILED BRANCH' alert (:304-309).

**Mechanism.** The review branch is `if (willReview && !asBranch)`. When the user resolves a stale-base conflict by choosing "publish as a branch", control falls to `revUpDocument` with `p_new_status: "Issued"`, which never consults review control at all. The branch is not promoted to `current_version_id`, so the operational blast radius is bounded — but a full `document_versions` row is created and stamped Issued, and the amber escape-hatch banner (line 643) is not shown for this path, so the user is told nothing about having stepped around a configured gate.

**Failure scenario.** Two engineers work the same P&ID. The second to publish hits the conflict screen and, rather than reconciling, types a branch reason and publishes. In a library configured `mode: "require"`, that revision is created without any reviewer being notified. It lands in the DocCtrl open-items queue as debt, but it is a real Issued-labelled version row with a file that can be fetched, and nothing on it records that it never passed the gate its library requires.

**Evidence.**

```
components/documents/RevUpModal.tsx:279 —
      if (willReview && !asBranch) {

lib/revisions.ts:542-546 —
      p_force: input.force === true,
      p_override_lock: lockedByOther,
      p_as_branch: input.asBranch === true,
      p_branch_reason: input.branchReason?.trim() || null,
      p_new_status: "Issued",
```

**Chain reaction.** A branch is later reconciled by merging into a subsequent revision. If that merge goes through `documentLifecycle/merge.ts:170` → `revUpDocument`, it too bypasses the gate — the merge path has no review-control resolution at all, unlike setRevUp.ts which was patched for exactly this reason.

**Done when.**

- [ ] A branch publish in a review-gated library either routes through review or is recorded with an explicit `review_bypassed` marker visible in the DocCtrl queue and the version history.
- [ ] The escape-hatch warning banner covers the branch path, not just Minor/Correction.
- [ ] documentLifecycle/merge.ts resolves review control the way setRevUp.ts does.

---

<a id="hand-11"></a>

## HAND-11 · Split, merge, and file-upload paths create documents at status Issued with no review gate and no inherited class or policy

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/documentLifecycle/common.ts:178`, `lib/revisions.ts:344`, `lib/revisions.ts:384`, `components/documents/DocumentLinkPicker.tsx:107`, `lib/outputTemplates.ts:226`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Core point holds for split/merge only: createNewDocWithFirstVersion lands a doc at Issued with its first version current, opens no ack/review-cycle roster, and copies neither the source's document-level review_control nor doc_class override (20261012 migration columns). But three cited specifics are wrong — the template-filing path files at Draft, the upload path seeds review-cycle + ack rosters, and class/policy inheritance is resolved dynamically doc→folder→library (reviewControl.ts:40-49), so split targets that keep collection_id do inherit the folder/library policy. Creation is also documented as deliberately outside the publish guard (revisions.ts:312-315). Severity LOW.

**Mechanism.** `createNewDocWithFirstVersion` inserts `status: "Issued"` and then sets `current_version_id` in a follow-up update, with no review-control resolution anywhere in the module. It copies active holds from the source (common.ts:315) but not `review_control`, `doc_class`, or `owner_user_id`. `createDocumentWithFile` does the same with `status: input.status ?? "Issued"` and an explicit comment that it "does NOT run the publish guard". Both are reachable from user-facing flows: split/merge from the document lifecycle tools, `createDocumentWithFile` from DocumentLinkPicker and the output-template renderer.

**Failure scenario.** A DocCtrl splits a multi-sheet P&ID set that lives in a library configured `mode: "require"` with named reviewers. Each resulting sheet is created as a brand-new document at status Issued with its first version already current. No reviewer is notified, no roster is opened, and the new documents carry neither the source's `doc_class` (so the MOC gate is off for their next revision until someone re-declares it) nor any `review_control` of their own — they inherit only from whatever folder they land in, which, per the folder-chain finding, may be an intermediate folder the resolver never reads.

**Evidence.**

```
lib/documentLifecycle/common.ts:176-179 —
      rev: input.initialRevLabel,
      revision: input.initialRevLabel,
      status: "Issued",
      asset_tags: input.assetTags,

lib/revisions.ts:311-316 (the acknowledgement) —
 * Distinct from revUpDocument (which publishes a new revision over an EXISTING
 * doc and is gated by per-library publish authority): this is a creation, gated
 * by library write access at the UI/RLS layer, so it does NOT run the publish
 * guard.
```

**Chain reaction.** Split/merge outputs enter the doc-control register (`loadDocControlRegister` filters on `status.not.in.(Draft,Superseded,Void,Archived)`) as fully controlled documents indistinguishable from reviewed ones. `createDocumentWithFile` at least seeds the review clock, ack roster, and retention (revisions.ts:386-391); `createNewDocWithFirstVersion` does none of those three.

> **Verifier correction.** Quotes are accurate (common.ts:176-179 `status: "Issued"`; revisions.ts:311-316 comment; revisions.ts:339 `status: input.status ?? "Issued"`; call sites at DocumentLinkPicker.tsx:107 and outputTemplates.ts:226), but two claimed consequences do not hold. (1) The publish guard is NOT bypassed: both paths promote via a follow-up `documents` UPDATE setting current_version_id (common.ts:223-227, revisions.ts:386), and enforce_document_publish_guard fires on any documents UPDATE where current_version_id changes (20260822:36-38 — OLD NULL → NEW non-null is 'advancing'), so per-library publish authority, the effective-owner check and the active-hold check all bind for these browser-side creations; the revisions.ts:311-316 comment is the thing that is wrong. (2) 'No inherited class or policy' is misleading: review_control and doc_class are resolved dynamically from the destination library/collection at publish time (reviewControl.ts:44-48, docClass.ts:80-93), so a new doc does inherit its container's policy — what is not copied is a DOCUMENT-LEVEL override from the source doc on split/merge. createDocumentWithFile also runs onDocumentIssued, onDocumentIssuedAck and recomputeRetention (revisions.ts:388-394). Residual, real: split/merge/upload mint a controlled 'Issued' revision with no review cycle and drop source document-level review_control/doc_class/owner_user_id.

**Done when.**

- [ ] Documents created by split/merge inherit `doc_class` and `review_control` from their source, or land as Draft pending an explicit controlled release.
- [ ] `createNewDocWithFirstVersion` seeds the review clock, ack roster, and retention the way `createDocumentWithFile` does.
- [ ] A first version created into a review-gated container opens a roster rather than going straight to current.

---

<a id="hand-12"></a>

## HAND-12 · The Rev Up form defaults to a change type that waives both the review gate and the PSM MOC gate, and remembers that choice per library

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/documents/RevUpModal.tsx:97`, `components/documents/RevUpModal.tsx:145`, `components/documents/RevUpModal.tsx:210`, `components/documents/RevUpModal.tsx:218`, `lib/reviewControl.ts:59`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: a governance-relevant field defaults to the value that waives both gates and is remembered per library. The only mitigation is the amber banner at :643-652, which renders solely when `reviewControl.mode !== "none"` — in a library with no review policy the Minor default silently waives the PSM MOC gate with no notice at all, and nothing anywhere warns that Minor waived MOC.

**Mechanism.** `changeType` initializes to `"Minor"`. `effectiveModeForRevUp` returns `"none"` for Minor/Correction regardless of the configured policy, and `mocRequired` is computed as `(docClass === "drawing" || docClassUnknown) && !isMinorLike` — so the default state of the form has both the review gate and the OSHA 1910.119(l) MOC field switched off before the user touches anything. Line 145 then restores whatever was last used in that library from localStorage, and line 311 writes the successful choice back, so a single Minor publish becomes the sticky default for every subsequent publish in that library by that user. The form does display two amber warnings (lines 643-652 and 708-713), but they are advisory text on a form whose default already sits in the exempt state — and the review warning is additionally gated on `reviewControl` having resolved, which is not guaranteed (see the fail-open finding).

**Failure scenario.** A drafter publishes a genuine process change to a P&ID — a new isolation valve on a PSV discharge. They fill in the file, label, and narrative, glance at the amber note, and click Publish with Change Type still on the remembered "Minor". No MOC reference is required or recorded. The configured two-reviewer gate is skipped. The revision becomes the controlled copy immediately. `enforce_document_publish_guard` sees no roster rows and permits it. The MOC that OSHA requires for this change has no reference anywhere on the record, and the version row's `moc_reference` is NULL.

**Evidence.**

```
components/documents/RevUpModal.tsx:97 —
  const [changeType, setChangeType] = useState<DocumentVersion["changeType"]>("Minor");

components/documents/RevUpModal.tsx:218-219 —
  const isMinorLike = changeType === "Minor" || changeType === "Correction";
  const mocRequired = (docClass === "drawing" || docClassUnknown) && !isMinorLike;

lib/reviewControl.ts:58-61 —
  if (input.changeType === "Minor" || input.changeType === "Correction") return "none";
  if (input.relatedTicketId) return "none";
  return input.control.mode;
```

**Chain reaction.** Note also that the `relatedTicketId` escape hatch on line 60 has no live caller — RevUpModal.tsx:210 and setRevUp.ts:83 both call `effectiveModeForRevUp` without it — so the stated rationale ("a rev that came from a drafting ticket already had review") is untested code sitting next to the one hatch that is reachable by default.

> **Verifier correction.** Every citation is exact: RevUpModal.tsx:97 `useState<DocumentVersion["changeType"]>("Minor")`; line 145 `if (remembered?.changeType) setChangeType(remembered.changeType);`; line 311 writes `{ issueType, changeType }` back to `mfg.revup.${libraryId}`; lines 218-219 `mocRequired = (docClass === "drawing" || docClassUnknown) && !isMinorLike`; reviewControl.ts:59-61 returns 'none' for Minor/Correction. But the compensating controls are stronger than the finding allows: the escape-hatch banner (643-652) fires whenever a configured gate is being skipped by change type, the MOC-exemption banner (708-713) fires for `docClass === "drawing" && isMinorLike` and is NOT gated on reviewControl resolving, an explicit caller preset overrides the remembered value (lines 148-149), and changeLog is a hard required field. The residual issue is the sticky default itself, not an invisible waiver.

**Done when.**

- [ ] The change-type control has no pre-selected value on a drawing-class document in a review-gated library; the user must choose before Publish enables.
- [ ] The remembered per-library value never restores a gate-waiving change type — governance-relevant defaults are not remembered.
- [ ] A Minor/Correction publish on a drawing-class document records an explicit replacement-in-kind attestation, so the exemption is a claim someone made rather than a dropdown nobody touched.

---

<a id="hand-13"></a>

## HAND-13 · documentGuards' documented DB backstop for the checkout lock no longer exists — the trigger was replaced three times and the lock check was dropped

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/documentGuards.ts:13`, `supabase/migrations/20260713_document_publish_guard.sql:61`, `supabase/migrations/20260812_per_library_publish_authority.sql:133`, `supabase/migrations/20260822_review_completion_guard.sql:21`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Factually correct — the DB no longer backstops the checkout lock and the module comment is stale. But the removal was an explicit design decision (20260812:133-136), and the lock is still enforced for every lib path including the legacy fallback at revisions.ts:614: revUpDocument calls authorizePublish first (revisions.ts:417), which at :242 refuses a foreign checkout without an override reason and runs evaluatePublishGuard. Residual exposure is a raw PostgREST write by someone who already holds publish authority, so this is documentation drift plus a missing defense-in-depth layer — LOW.

**Mechanism.** `enforce_document_publish_guard()` is defined four times with CREATE OR REPLACE; only the first (20260713) contains a lock check. 20260812 removed it deliberately and says so; 20260816 and 20260822 rebuilt from that lineage and never restored it. `grep -rn "checked_out_by" supabase/migrations/*.sql` filtered to OLD./NEW. references returns exactly two lines, both in the superseded 20260713. The module header in documentGuards.ts still promises the DB enforces "the same rule" for any path that bypasses the lib — which is now true for holds and authority but false for the foreign-checkout lock. The lock is enforced only inside the `publish_revision` RPC and the client-side `authorizePublish`.

**Failure scenario.** An engineer, mid-audit, is told the checkout lock is enforced at the database and reasons that no code path can clobber a colleague's in-flight work. Any write to `documents.current_version_id` that does not go through the `publish_revision` RPC — the legacy fallback path at revisions.ts:614 that fires whenever the RPC is missing, or a future direct PostgREST update — will advance a document that another user holds checked out, with nothing at the DB layer to stop it. The false comment is what makes that path look safe to whoever reads it next.

**Evidence.**

```
lib/documentGuards.ts:13-16 —
//   2. A defense-in-depth Postgres trigger (see the matching migration)
//      enforces the same rule at the DB layer for any path that bypasses
//      the lib.

supabase/migrations/20260812_per_library_publish_authority.sql:133-136 —
  -- An authorized publisher MAY advance past a foreign checkout (the override-
  -- with-note flow lives in the app). We deliberately do NOT block on
  -- checked_out_by here. But an active HOLD still blocks them — holds are
  -- controller-only to bypass, and controllers already returned.
```

**Chain reaction.** revisions.ts:613-619 (`legacyRevUpAfterUpload`, "No base check — kept only so environments that haven't applied the migration keep working") is a live fallback triggered by `isMissingPublishRpc`. In an environment where the 20260823 RPC migration was not applied, that path has neither the RPC's lock check nor a DB trigger check — only the client-side guard, which is exactly the layer the header claims is backstopped.

**Done when.**

- [ ] The documentGuards.ts header states accurately which invariants the trigger enforces (holds, authority) and which live only in the RPC/app layer (foreign lock, base check).
- [ ] Either the trigger regains a lock check compatible with the authorized-publisher override, or the legacy non-RPC publish path is removed so no path lacks both.

---
