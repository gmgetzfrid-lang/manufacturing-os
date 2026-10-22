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
- **Status:** RESOLVED
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

**Resolution (2026-10-20, drafting-flow Round G).** DF-P11 AFTER-DC — record-only close, verified against the merged code (owner document-control `RG-6`, RESOLVED).

**Done-when.**
- ✓ `effectiveReviewControlForDocument` throws on a failed read (`lib/reviewControl.ts:73-85`, through `lib/containerChain.ts` `loadContainerChain`, which throws on every PostgREST error, `:84-100`) — as `effectiveDocClassForDocument` does.
- ✓ RevUpModal holds publishing until the policy resolves; a failed read is an explicit `"unknown"` state that blocks publish with the reason (`components/documents/RevUpModal.tsx:231-255`, `:348`, `:786-790`), never `{mode: "none"}`.
- ✓ `setLevelRevUp` refuses a sheet whose policy could not be read (`lib/documentLifecycle/setRevUp.ts:82-118`).
- Tests: `lib/__tests__/dcRoundFReviewGate.test.ts` "effectiveReviewControlForDocument throws on a PostgREST error on any read", "RevUpModal: publishing is held until the policy RESOLVES…", "setLevelRevUp (the batch path) refuses a sheet whose policy could not be read".

**Scope / residual.** None.

---

<a id="hand-2"></a>

## HAND-2 · Any active org member can release the safety hold the publish guard depends on

- **Severity:** HIGH
- **Status:** RESOLVED (pending `20261239`)
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

**Partial (2026-10-20, drafting-flow Round G).** DF-P11 AFTER-DC, with its three review fix passes. Fix pass 3 found that done-when 1 holds only for workspaces that store NO `holds.release` entry (see the remainder below), so the finding stays OPEN; done-whens 2 and 3 are met. Reproduced on `29d92ac`: `holds.release` shipped `["*"]` in both evaluators (`lib/capabilityPolicy.ts`, `org_capability_allows_for` newest body `20261137`). Built under `DEC-90` ruling (3):
- `lib/capabilityPolicy.ts` — `holds.release` defaults to `["Admin","DocCtrl","$opener"]`: the controller tier (exactly `checkout.force_release`'s) plus `HOLD_OPENER_TOKEN` (`"$opener"`), an identity token no role matches that admits a hold's own opener to release / re-date THAT hold. `holdOpenerTokenOn(policy)` reads it from the base list; `validateCapabilityPolicy` allows the token on `holds.release` only. Fix pass 2: the opener is a token IN the list, not an unconditional OR — an org whose Admin stored a narrower list (`["Admin"]`, "only Admins lift holds") is honoured exactly as written.
- `supabase/migrations/20261239_df_roundG_holds_release_grant_scope.sql` — re-creates `org_capability_allows_for` from its newest body (`20261137`, grants as `20261224` left them) with the one CASE row changed; adds `hold_opener_may_update(org, opened_by)` (SECURITY DEFINER, `search_path` pinned; fix pass 3: PUBLIC and anon revoked, EXECUTE for `authenticated` and `service_role` only, because the policy below is re-created `TO authenticated` — anon has no UPDATE policy on `document_holds` and touches 0 rows without planning the function; recorded as a `signed-in` row in `lib/__tests__/rls/definerDecisions.ts`): true only for the caller who IS the hold's opener (`p_opened_by IS DISTINCT FROM auth.uid()` refuses a NULL session uid first), an active member of its org, while the org's effective `holds.release` list (stored bare list, a rule list's first unconditional rule, else the shipped default) names `"$opener"`; and re-creates the `document_holds_update` policy from its newest body (`20260901`) with ONE added leg, `OR hold_opener_may_update(org_id, opened_by)`, scoped `TO authenticated` (fix pass 3; probe 111 checks the role list). All lineDiff / shape-pinned in `lib/__tests__/dfRoundG_P11_migration.test.ts` (the function's unconditional-rule loop is the evaluator's, line for line). `opened_by` is pinned once a hold is placed (`20261073`), so the leg cannot be re-pointed; the release still needs a reason and is attributed to the session (`20261073`).
- The app mirrors it: `lib/holds.ts` `holdControlsFor(…, hold)` and `assertHoldCapability`'s `openedBy` (read checked with the hold's org, `readHoldOrg`), `lib/checkoutAffordances.ts` `holdAffordances(…, hold)` — each gated on `isHoldOpener && holdOpenerTokenOn`; `components/documents/HoldStrip.tsx` and `app/(protected)/admin/holds/page.tsx` decide Release / Re-date per hold; `components/documents/InspectorPanel.tsx` hands the strip `canEdit = canReleaseHold || canOpenHold`; `components/permissions/CapabilityPolicyEditor.tsx` shows the token as its own tick on the Release-a-hold row ("The hold's own opener may release or re-date it"), never as an unexplained stored token.
- Done-when 2 (fix pass 2): `lib/holds.ts` `releaseHold` — when the releaser is not the hold's opener — awaits `noticeOpenerOfRelease({ phase: "pending" })` BETWEEN the permission gate and the UPDATE: the existing `hold_released` kind (no new kind, nothing in `lib/notify/**`), addressed to the opener, "<releaser> is releasing the "<reason>" hold you placed: <release reason>", its bell row on the retried path (`inappRetry`, DELIV-16) so the answer says whether it landed. Not landed, or the send threw, or the opener's membership could not be read → the release is refused with a sentence and nothing is written. If the UPDATE then fails, `phase: "failed"` tells the opener it did not go through and the hold stands. An opener who is no longer an active member cannot be told (emit reaches active members only, NEDGE-3) and does not freeze the stop. The post-commit notice to the whole hold audience is unchanged.
- Fix pass 3 (the stored `["*"]`): `components/permissions/CapabilityPolicyEditor.tsx` `joinPolicyFromEditor` no longer writes a row equal to its shipped default (as a set, with no override) — every save used to write every capability, which froze the old `holds.release: ["*"]` in every workspace whose Admin changed any row; absent IS the default to both evaluators and to the policy route's critical-change check (`canonicalEntry`), so no answer changes today. A `holds.release` row still exactly `["*"]` is named on the row as the old default (`holdsReleaseOnOldDefault`) with "Use the shipped default", which sets the row and is saved through the impact preview like any change — an explicit Admin decision. `20261239`'s inventory row 1 now counts workspaces whose stored `holds.release` is exactly `["*"]`, apart from row 2 (any other stored list or a rule list); the other rows are renumbered 3–8.
- **Who gains or loses it.** **Nobody gains.** In an org on the shipped default every role outside Admin / DocCtrl loses release and re-date of a hold placed by SOMEONE ELSE — Manager, Supervisor, DraftingSupervisor, the Engineer tiers, Drafter, Requester, Contractor and custom roles (Viewer / Auditor already had no live control: `holdControlsFor` subtracts read-only roles); **everyone keeps release and re-date of a hold they placed** (the default names `"$opener"`). Why the management tier (Manager, Supervisor) is not kept as a legitimate operational releaser under `DEC-90` ruling (3), although it holds `ticket.force_close`: the close gate (`app/api/tickets/workflow-action/route.ts`, LIFE-6 / `DEC-25`) releases only holds whose `origin_ticket_id` is the ticket being closed — the as-built discrepancy hold `CheckInPanel` places on that request — and only through the closer's explicit release-or-keep resolution, with a reason, written as `HOLD_RELEASED` rows; it never reaches a hold placed on the document from its hold strip, which is the controller's veto. Release on the hold itself reaches every hold, so it stays the controller tier's unless an Admin ticks Manager or Supervisor on the row (said in `CAPABILITY_DEFS` and the migration header). DraftingSupervisor, the Engineer tiers, Drafter, Requester and Contractor hold no comparable path. An org that STORED a list keeps exactly what it had — before the paste its list decided, after it still decides — and that includes the incidental `["*"]` (the remainder below). The ticket close gate's release of its own hold (`DEC-25`) runs as the service role and is unaffected; the aging-hold audience already falls back to the controller tier (`DEC-35`); widening is one Admin decision in the grid (a role, the opener tick) or a personal `holds.release` grant.

**Done-when.**
- Partly met. `holds.release` ships to the controller tier (matching `checkout.force_release`) plus the hold's own opener as a configurable token, and widening is an explicit Admin decision — but only in a workspace that stores NO `holds.release` entry (counted by `20261239`'s inventory row 3) or whose Admin stored a list on purpose. NOT met for a workspace whose grid save stored the old `["*"]` incidentally (inventory row 1 counts them; the paste cannot tell an incidental `["*"]` from a chosen one, and leaves it deciding — everyone still releases there until an Admin acts). From fix pass 3 no new incidental entry is written, and the grid names the stored `["*"]` with a one-click shipped default. Pending migration `supabase/migrations/20261239_df_roundG_holds_release_grant_scope.sql` for the database half (the app half is live on deploy).
- ✓ Releasing a hold opened by someone else requires a reason recorded on the hold row (`releaseHold`, `20261073`'s guard) and notifies the opener before the release commits (`noticeOpenerOfRelease`, awaited and checked before the UPDATE; a notice that cannot be queued refuses the release; a failed UPDATE is followed up on the same kind). The one case not told: an opener who has left the workspace (nobody to tell).
- ✓ `lib/documentGuards.ts` ("holds are deliberate 'do not advance' flags reserved for the controller tier") matches the shipped policy — a controller's hold; an opener lifts only their own, and only while the org's list names the opener.
- Tests: `lib/__tests__/dfRoundG_P11_grants.test.ts` (the default; every role named above refused; a stored `*` and a grant still widen; the opener keeps release of their own hold; fix pass 2: a stored `["Admin"]` refuses the opener on every surface, ticking the token back on returns it, rule lists read as the database reads them, the token valid on `holds.release` only); `lib/__tests__/dfRoundG_P11_holdReleaseNotice.test.ts` (fix pass 2: the opener's notice is sent and landed BEFORE the UPDATE — order pinned on one call log; a notice that did not land, a send that threw or reached nobody refuses with nothing written; a failed UPDATE sends "did not go through"; the opener releasing their own hold sends none; a departed opener does not freeze the hold; a membership read that fails refuses); `lib/__tests__/dfRoundG_P11_editorOpenerToken.test.ts` (rendered: the opener tick on the row, ticked under the default, unticked for a stored list, saved as the token; fix pass 3: a save writes only rows that differ from their default — changing "Assign drafters" sends that row alone, never `holds.release`; a stored `["*"]` is named on the row, kept on an unrelated save, and "Use the shipped default" saves it away; `joinPolicyFromEditor` answers exactly as a fully written policy for every capability); `lib/__tests__/sweepRoundD3.test.ts` (a default-equal row is left out, same answer); `aoRoundGP9PermissionsConsole.test.ts` (`assertHoldCapability`); `checkoutAffordances.test.ts`; `holds.test.ts`; `dcRoundFP24HoldCheckoutPolicyFault.test.ts`, `dcRoundFP24InspectorPolicyFault.test.ts`. Committed runtime proof: `lib/__tests__/rls/dfP11HoldsRelease.test.ts` (`npm run test:db`, PostgreSQL 16 replay of every migration) — a controller's hold: Supervisor, Engineer, Drafter, Requester, Viewer and a suspended member touch 0 rows; Admin, DocCtrl, a Manager also holding DocCtrl and a granted Drafter release; the opener re-dates and releases their own; fix pass 2: an org storing `["Admin"]` — the opener and DocCtrl touch 0 rows, ticking `"$opener"` back (bare list, or a rule list's base rule) returns the leg; another non-controller cannot use the leg, a suspended opener holds nothing, `opened_by` cannot be re-pointed; an org storing `*` keeps it; the paste as one script on a copy put back to `20260901`'s policy (opener refused before, admitted after; the `["Admin"]` org's opener refused before AND after; probes 100–112 true; inventory rows 1–8 counts, fix pass 3: row 1 equals the workspaces storing exactly `["*"]` and row 2 the other stored lists, and a `["*"]` workspace's drafter still releases a controller's hold after the paste — the remainder; the policy's role list is `authenticated` and anon cannot execute `hold_opener_may_update`; a re-paste clean). `lib/__tests__/rls/intelI28DefinerOracles.test.ts` stores `holds.release: ["*"]` in its world, so its 20261224 before/after comparison is not confused by this file's default change.

**Scope / residual.** Pending paste of `supabase/migrations/20261239_df_roundG_holds_release_grant_scope.sql` (after `20261137` and `20261033`; deploy the app first). An opener who has left the workspace is not told before a release (nobody to tell; the release is still attributed and audited). A re-date of someone else's hold is not pre-notified (it does not lift the stop).

**Remainder (closed by the integrator's ruling below; it was owned by the integrator, DEC-31).** Workspaces whose stored `holds.release` is exactly `["*"]` — the old default, written by every grid save before fix pass 3 whether or not anyone chose it — keep "everyone releases" after the paste. Their number is `20261239`'s inventory row 1 (read it from the paste's result set). Two ways to close it, for the integrator to rule on: (a) leave it to each workspace's Admin through the grid, which now names the row as the old default and offers "Use the shipped default" (built; no data is changed without an Admin); or (b) an integrator-approved data step that rewrites `holds.release` only where the stored value equals `["*"]` exactly (a separate migration with its own inventory; it would also override any Admin who chose `["*"]` on purpose, which the stored data cannot distinguish). Until one is ruled, done-when 1 stays partly met.

**Ruled by the integrator at the DF-P11 merge, 2026-10-21 (DEC-90)** — the Remainder above, option (a). The shipped default is narrowed to the controller tier, `[Admin, DocCtrl]` (plus the hold's own opener as the `"$opener"` token, `DEC-112` item 1, which keeps the release ruling (3) protects); a `holds.release` list a workspace has STORED is that workspace Admin's own decision and is NOT rewritten — silently changing who may release holds in a live workspace would itself be a regression — so no data step is taken and `20261239` is unchanged. The Action-permissions grid's note (`components/permissions/CapabilityPolicyEditor.tsx:525`, `data-testid="holds-release-old-default"`) tells the Admin that "everyone" is stored for this action, that the hold-release change did not rewrite it, and names the recommended, shipped default, offered in one action ("Use the shipped default", `:538`, saved through the impact preview); loading the grid writes nothing. `20261239`'s inventory row 1 counts these workspaces. Tests: `lib/__tests__/dfRoundG_P11_editorOpenerToken.test.ts` "a stored holds.release of exactly ["*"] is named on the row as the old default …" (the note's wording, kept on an unrelated save, adopted in one action) and "HAND-2 dw1 as ruled: loading a workspace that stores ["*"] writes nothing …".

**Done-when (as ruled).**
- ✓ 1 by ruling — `holds.release` ships to the controller tier (with the opener token), widening is an explicit Admin decision, and a stored list (including an incidental `["*"]`, counted by inventory row 1 and named on the grid with the one-action recommended default) is the workspace Admin's.
- ✓ 2 and ✓ 3 as recorded above.

**Scope / residual.** Pending paste of `20261239` (after `20261137` and `20261033`; deploy the app first). The accepted residuals above are unchanged (an opener who has left the workspace is not told before a release; a re-date is not pre-notified).

---

<a id="hand-3"></a>

## HAND-3 · The drafting ticket never becomes a document revision — the two systems share no write path

- **Severity:** HIGH
- **Status:** OPEN
- **Assigned:** drafting-flow DF-P9 TICKET-PAGE (done-when 3: the page shows the source's drift through `SourceDriftBanner`) — by the integrator, 2026-10-13 (at the DF-P2 merge, DEC-31: DF-P2 has merged and named these limbs in drafting-flow `99-fix-sequencing.md`, "Hand-offs from DF-P2"; fleet plan updated).
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

**Partial (2026-10-02, drafting-flow Round G).** Re-verified against `f1ac550`. The write path exists since roles-and-permissions [`LIFE-1`](../roles-and-permissions/07-document-lifecycle.md) / `GAP-6` / `DEC-22` (Round C2, `a84f712`; migration `20261049` **applied & verified live 2026-09-02** — MIGRATION-PASTE-ORDER row 51): a ticket carrying `metadata.source_document.id` and a Final attachment offers "Publish as revision of …" to publish authority on the document's library (`app/(protected)/requests/[id]/page.tsx:2165-2175`), which pre-seeds `RevUpModal` and runs `revUpDocument` unchanged (hold gate, review gate, `runPostPublishSideEffects`); `/api/tickets/handback` records the resulting version on the ticket (`metadata.deliverable`, shown as "Published as Rev …", `:2155-2159`); closing without one writes `metadata.deliverable.state = "not_in_register"` plus a history line (`app/api/tickets/workflow-action/route.ts:397-414`), shown as an amber chip (`page.tsx:2160-2164`). `20261049` writes `related_ticket_id` for provenance only (DEC-23 deleted the waiver — `PROJ-11`).

**Done-when.**
- ✗ (in part; in `DEC-22`'s shape) ✓ A ticket with a source document opens a real `document_versions` row through `revUpDocument`, by an explicit, library-authority-gated action, and `/api/tickets/handback` records the resulting version (it checks the version belongs to the source document, `app/api/tickets/handback/route.ts:48-62`) — never auto-published on close, which `DEC-22` forbids. ✗ The close-time substitute for "blocked from closing" (`DEC-22`'s visible, queryable "not in the register" state) and the recorded version id both live in `tickets.metadata`, which any member can write from the browser (`metadata` is not in `ticket_update_guard`, `supabase/migrations/20261038_rp_phase4_ticket_workflow_rails.sql:184-205`; the `SM-2` / `PERS-1` residual, **DF-P1**). (a) The close decides from it: the note runs only `if (src?.id && deliverableStateOf(ticket.metadata)?.state !== "published")` (`app/api/tickets/workflow-action/route.ts:400`), and `noteDeliverableNotInRegister` returns `null` over a `published` state (`lib/ticketHandback.ts:101-102`; `deliverableStateOf` accepts any string `version_id`, `:73-79`). So a member who writes `metadata.deliverable = { state: "published", version_id: "<any string>", revision_label: "9" }` before the close gets no not-in-register state, no history line and no note — and the page shows a green "Published as Rev 9" (`app/(protected)/requests/[id]/page.tsx:1636`, `:2155-2159`) with nothing in the register. (b) After the close, any member can erase or overwrite the state. So a ticket can close neither blocked nor marked, "recording" a version id no register holds — the done-when's (b) branch, as `DEC-22` reshaped it, does not hold on that path. *Overstated (records fix, 2026-10-02): this line read "✓ (in `DEC-22`'s shape) … the close leaves the visible, queryable 'not in the register' state instead of being blocked", with no caveat.*
- ✗ The stamp neither names the controlled revision nor says "not a controlled revision": the print path watermarks `"UNCONTROLLED COPY"` (`page.tsx:589`) but the download path watermarks a ticket Final `"CONTROLLED COPY"` (`page.tsx:661`, recorded at `:694`), and both footers say only `${ticketId} deliverable Rev ${deliverableRev} at time of … — scan the QR to confirm it is still the latest.` (`:591-593`, `:663-665`).
- ✗ (in part) Drift is flagged — "Rev advanced — register now at Rev N" (`page.tsx:2134-2140`, `LIFE-13`) — but by comparing rev *labels* (`revDrift(sourceRef.rev, sourceDoc.doc?.rev)`), not a captured base version id; the canonical `source_document` shape carries rev text, no version id.

**Scope / residual.** The ticket-deliverable stamp says "UNCONTROLLED COPY" until it is a register revision → **DF-P10** (`PHYS-9`, the FileViewerModal region; DF-P10 also passes `controlState` to PS-STAMP's stamper). The captured base version id on `source_document` → **DF-P2** (`HAND-7`, "the shape carries rev text, no version id"). The fleet plan named DF-P4 for this cluster's residual; on HEAD that residual is `DCW-4`'s (tickets with no source document) — HAND-3's own done-whens are scoped to tickets *with* one. Neither DF-P10's nor DF-P2's brief names HAND-3; both halves are rows in `99-fix-sequencing.md`, "Hand-offs from DF-P0", so the integrator appends HAND-3 to both briefs and the packages that close `PHYS-9` / `HAND-7` re-check this finding (review fix pass). Added by the records fix (2026-10-02): the forgeable deliverable state behind done-when 1 → **DF-P1** (`metadata` service-only in its `ticket_update_guard` re-creation, and a close-time check that reads a `published` deliverable against the register rather than `metadata` alone — the same limb as `DCW-4`'s); the integrator appends HAND-3 to DF-P1's brief too.

**Partial (2026-10-02, drafting-flow Round G).** DF-P1 RAILS — the DF-P1 limb of done-when 1 (the records fix's: `metadata` service-only and a register-backed close) is closed; done-whens 2 and 3 are DF-P10's and DF-P2's, so this stays OPEN. Same change and evidence as [`DCW-4`](./03-doc-control-wiring.md#dcw-4): `tickets.metadata` is service-only after the paste (`20261166:280`, **Pending migration:** `supabase/migrations/20261166_df_roundG_ticket_rails.sql` (`DEC-30`: one paste, not a widening, after `20261038` / `20261039`, and after the DF-P1 app deploy, never before it: `AUTHZ-13`, "Paste order") — the database half is not closed in any database until it is pasted.), and a close checks a recorded `published` deliverable against `document_versions` (the named version, in the ticket's org, of the source document, with `related_ticket_id` = this ticket — `app/api/tickets/workflow-action/route.ts:544-578`), recording anything else as not in the register, but only when the register read succeeded. A failed read is a 503 with nothing written, so a real publication is never rewritten (DF-P1 fix pass, 2026-10-02). Tests: `lib/__tests__/dfRoundG_P1_rails.test.ts:960`, "DCW-4 / HAND-3 (DF-P1 limb)".

**Done-when.**
- ✓ (in `DEC-22`'s shape) A ticket with a source document opens a real `document_versions` row through `revUpDocument` by an explicit, authority-gated action, the hand-back records the version, and — now — a close is either backed by that version in the register or leaves the visible not-in-register state; neither can be forged from a browser after the paste.
- ✗ The stamp neither names the controlled revision nor says "not a controlled revision" (unchanged).
- ✗ (in part) Drift is flagged by rev labels, not a captured base version id (unchanged).

**Scope / residual.** The stamp → **DF-P10** (`PHYS-9`); the captured base version id → **DF-P2** (`HAND-7`) — both as the DF-P0 record handed them.

**Partial (2026-10-07, drafting-flow Round G).** DF-P2 CREATE — the base-version limb DF-P0 handed to DF-P2 (`99-fix-sequencing.md`, "Hand-offs from DF-P0"), the same work as `HAND-7`: a new ticket's `metadata.source_document` carries `version_id` captured at creation, `revDrift` compares version ids when both sides carry one, and `SourceDriftBanner` flags a moved source by version id.

**Done-when.**
- ✓ (in `DEC-22`'s shape) Unchanged (DF-P1).
- ✗ The stamp (unchanged) → DF-P10.
- ✗ (in part) A captured base version id now exists and the banner compares it; the ticket page's existing chip (`revDrift(sourceRef.rev, sourceDoc.doc?.rev)`) still passes rev labels until DF-P9 mounts the banner or passes `{ versionId, rev }` sides.

**Scope / residual.** The stamp → **DF-P10** (`PHYS-9`); the page's comparison → **DF-P9** (the banner mount, `HAND-7`).

**Partial (2026-10-13, drafting-flow Round G).** DF-P10 DELIVERABLE-PRINT — the stamp limb (done-when 2), in the FileViewerModal region, with public-surfaces `PHYS-9`'s control state. Reproduced on `596d34e`: the download watermarked a ticket Final `"CONTROLLED COPY"` (`app/(protected)/requests/[id]/page.tsx:661`) and both footers said only `… deliverable Rev N at time of … — scan the QR to confirm it is still the latest.` (`:591-593`, `:663-665`).
- `lib/ticketDeliverableCopy.ts` (new) `ticketCopyPlan`: every ticket file is stamped `controlState` "uncontrolled" (a Draft "review") — never controlled — and its footer describes the file itself: "This file is `<ticket>` deliverable Rev `<the file's own rev>` — not a controlled document revision — scan the QR to confirm it is still the latest." (a Draft: "review draft Rev `<rev>`"; a file the page knows is superseded leads "SUPERSEDED by Rev `<N>` at time of printing / download — this file is `<ticket>` deliverable Rev `<rev>`, not the current revision — not a controlled document revision — scan the QR for the current status."; the last issue of a ticket being re-worked adds "— a newer revision is in progress at time of printing / download —"; with no recorded rev: "… no deliverable revision is recorded for this file, so which printing this is cannot be confirmed. Not a controlled document revision."). The page's two paths stamp from it (`page.tsx:611`, `:670`).
- Tests: `lib/__tests__/verifyTicketVerdict.test.ts` "PHYS-9 / HAND-3 — … 'not a controlled document revision'" (every file type, both paths) and "no public origin → no QR", which pins that the statement survives when the stamper strips the scan instruction.

**Done-when.**
- ✓ (in `DEC-22`'s shape) Unchanged (DF-P1).
- ✓ The ticket deliverable stamp explicitly states "not a controlled document revision" (the stamp is of the ticket's file, which is never the register version even after a publish).
- ✗ (in part) Unchanged → DF-P9 (the page's comparison, `HAND-7`).

**Scope / residual.** Done-when 3's page half → **DF-P9** (as assigned). Nothing left for DF-P10.

**Partial (2026-10-14, drafting-flow Round G).** DF-P9 TICKET-PAGE — done-when 3's page half. The ticket page's Rev chip compares version ids when the request captured one: `revDrift({ versionId: sourceRef.versionId, rev: sourceRef.rev }, { versionId: sourceDoc.doc.currentVersionId, rev: sourceDoc.doc.rev })` (`app/(protected)/requests/[id]/page.tsx`:2512; the source read now selects `current_version_id`), so a sheet re-issued under the same label reads "Rev advanced", and a row with no captured id falls back to labels as before. `SourceDriftBanner` is mounted on the ticket (`app/(protected)/requests/[id]/page.tsx`:2474, `HAND-7`). A failed source read is its own state, never "restricted" (`DCW-5`).

**Done-when.**
- ✓ (in `DEC-22`'s shape) Unchanged (DF-P1).
- ✗ The stamp (unchanged) → DF-P10 (`PHYS-9`).
- ✓ A ticket whose source has advanced is flagged against the captured base version id — `lib/__tests__/dfRoundG_P9_ticketDetail.test.ts` "DCW-5 / HAND-3 / HAND-7 — the source card" ("the Rev chip compares version ids: a re-issued sheet under the same label has moved"; REGRESSION: the same version reads current).

**Scope / residual.** Done-when 2 → DF-P10 (`PHYS-9`). Status stays OPEN for it.

*Assigned (2026-10-21, the integrator at the DF-P8 merge, DEC-31):* re-verify every done-when against what DF-P1, DF-P2, DF-P9 and DF-P10 landed and close by record, or name what remains → drafting-flow **DF-P23 TRANSITION RECORD AND RECONCILE** (the last Scope line above still points done-when 2 at DF-P10, whose own Partial says nothing is left for it).

---

<a id="hand-4"></a>

## HAND-4 · The sign-off rows the DB review guard counts are writable by the publisher the guard is meant to constrain

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Resolution (2026-10-20, drafting-flow Round G).** DF-P11 AFTER-DC — record-only close, verified against the merged code (owners document-control `DRLS-6` / `RG-1` / `RG-2`, roles-and-permissions `SURF-13`, all RESOLVED; newest bodies `20261070` and `20261193`).

**Done-when.**
- ✓ (by trigger, not by the policy's WITH CHECK) `enforce_review_signoff_guard` (newest body `supabase/migrations/20261070_dc_roundF_review_gate_slots.sql:182-275`) pins `reviewer_user_id`, `slot`, `document_version_id`, `document_id`, `org_id` to their OLD values (`:190`), and only the named reviewer, with their own e-signature for this draft, may move a row to `signed` (`:227`, `:254`).
- ✓ `doc_review_signoff_insert` (`20261070:125-147`) admits only rows born `pending` with no signature, written by the publisher tier (`is_org_controller` / effective owner / `user_can_publish_on_library`).
- ✓ (bound by version, not by content hash) the publish guard counts only signed rows with a non-null `signature_id` whose e-signature was made by that reviewer (`supabase/migrations/20261193_dc_roundF_ifc_rev_up_first_issue.sql:541`, `:583`, `:789`); the signature is bound to the draft's `document_version_id` (`20261070:254`), so it binds the reviewed revision rather than a stored hash.
- Tests: `lib/__tests__/dcRoundFReviewGate.test.ts` "RG-4 / DRLS-6", `reviewSignoffIntegrity.test.ts` (RG-1).

**Scope / residual.** Done-when 3 is met through the version binding; a check that the e-signature's `content_hash` equals the promoted version's `file_hash` is not separately enforced (DC's records accept the version binding).

---

<a id="hand-5"></a>

## HAND-5 · Trusted intake links publish controlled revisions through the service role, skipping the publish guard and the entire post-publish pipeline

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Resolution (2026-10-02, drafting-flow Round G).** Closed by pointer to roles-and-permissions [`OWN-4`](../roles-and-permissions/05-ownership-publish.md) (Phase 3, 2026-08-24), as rebuilt by projects Round G `J1` (`ee68448`, the intake door as a boundary) and re-verified against `f1ac550`. The trusted auto-publish no longer writes `documents` directly: it runs `publish_revision` acting as the link's creator (`publishThroughContract`, `app/api/intake/upload/route.ts:380-425`), after the route has re-checked, in order (`:1147-1210`): legal hold and active holds through HLD-1's shared fail-closed gate — `const holdDecision = decideHoldGate(await readActiveHolds(docId, supabaseAdmin));` (`:1154`); a live checkout; the creator's current publish authority on the library; and the effective review policy — `supabaseAdmin.rpc("review_control_mode_for", …)`, `mode === "require"` or an unreadable policy demotes (`:1194-1202`). Any refusal — including the contract's own `case "on_hold":` (`:414-415`) — DEMOTES the upload to review rather than publishing. A successful promote runs the shared pipeline: `await runPostPublishSideEffects({ … settle: true, serviceClient: supabaseAdmin })` under the service role (`:1386-1403`).
- Tests: `lib/__tests__/intakeUploadRoute.test.ts:613` (publish through the contract as the creator, provenance stamp, the pipeline bound to the service role) and `:634-659` (an active hold, an unreadable hold state, a legal hold, a checkout, a creator without authority, a require-sign-off library, an unreadable review policy, and the contract's hold / lock / MOC refusals each DEMOTE, with no pipeline run).
- Pending migration that this close depends on, said plainly: `review_control_mode_for` is created by `supabase/migrations/20261070_dc_roundF_review_gate_slots.sql`, which is **not yet pasted** (MIGRATION-PASTE-ORDER §4 row 65, PASTE; §3B "paste with the deploy"). Until it is, `modeErr` is set and every trusted auto-publish demotes to review — the review half of done-when 1 holds as a refusal, never as a bypass.

**Done-when.**
- ✓ The auto-supersede branch re-checks active holds and the effective review policy in the route before promoting (`:1147-1202`).
- ✓ The intake promote calls the same `runPostPublishSideEffects` pipeline (`:1390-1403`).
- ✓ A document with an active hold cannot be advanced by any intake link: the route's hold gate demotes, `publish_revision` refuses `on_hold`, and the review path's finalize runs the publish guard under a real `auth.uid()`.

**Scope / residual.** `OWN-4` done-when 3 (consulting the library owner before a project names their library as an intake target) is an intake-creation flow, tracked with the projects-tab intake findings — not this finding's contract.

---

<a id="hand-6"></a>

## HAND-6 · review_control and doc_class resolve only the document's immediate folder — every intermediate folder in the container chain is skipped

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Resolution (2026-10-20, drafting-flow Round G).** DF-P11 AFTER-DC — record-only close, verified against the merged code (owner document-control `RG-3`, RESOLVED).

**Done-when.**
- ✓ Both resolvers walk the full ancestor chain nearest-first through `path_ids` before the library: `lib/containerChain.ts:75-100` (`loadContainerChain`), used by `lib/reviewControl.ts:78` and `lib/docClass.ts:79`.
- ✓ `scanReviews` walks the same chain in memory (`folderChainFromMap`, `lib/reviewControl.ts:1219`) and `ReviewGateSection` asks `effectiveReviewControlForDocument` (`components/documents/ReviewGateSection.tsx:103`).
- ✓ `lib/__tests__/dcRoundFReviewGate.test.ts` "library=none / mid-folder=require / leaf-folder=undefined resolves to require", "the same fixture resolves to require from the live rows (path_ids walked nearest first)", "docClass walks the same chain".

**Scope / residual.** None.

---

<a id="hand-7"></a>

## HAND-7 · An as-built request records the source revision as a text snapshot with no version id, so nothing detects the drawing moving underneath the drafting cycle

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** drafting-flow DF-P9 TICKET-PAGE (done-when 2: mount `SourceDriftBanner` on the ticket page and the queue's 'source moved' chip) and DF-P6 REVIEW-MODEL (done-when 3: approving over a drifted source needs a recorded acknowledgement) — by the integrator, 2026-10-13 (at the DF-P2 merge, DEC-31: DF-P2 has merged and named these limbs in drafting-flow `99-fix-sequencing.md`, "Hand-offs from DF-P2"; fleet plan updated).
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

**Partial (2026-10-07, drafting-flow Round G).** DF-P2 CREATE.
- **The captured version.** The canonical shape gains `version_id`: `lib/sourceDocRef.ts` `buildSourceDocumentRef` always writes it (`null` when unknown), and `app/api/tickets/create/route.ts` fills it at request time from the register (`capturedVersion`, `:254-266`): a named version kept only when it is a version of that document; otherwise the document's `current_version_id` when the rev the requester saw is still current (or none was shown); `null` when the rev they saw is no longer current (never the wrong version). The check-in passes the version it checked in against.
- **The comparison.** `revDrift` compares version ids when both sides carry one and falls back to rev labels for historical rows. New `components/requests/SourceDriftBanner.tsx` reads each source document's live `current_version_id` (in the ticket's org) and says "The source revision has moved since this request was raised", naming each sheet that moved; a failed read or an unreadable document says nothing.

**Done-when.**
- ✓ (1) `metadata.source_document` captures the version id alongside the display rev — `lib/__tests__/ticketCreateRoute.test.ts`, "HAND-7 / GAP-8 — the source documents, in this workspace, with the version each was raised against"; `lib/__tests__/sourceDocRef.test.ts`.
- ✗ (in part) (2) The banner is built and tested (`lib/__tests__/sourceDriftBanner.test.ts`) but not mounted: the ticket page and the drafting queue are DF-P9's files.
- ✗ (3) Approving a deliverable drafted from a superseded base requires no acknowledgement yet.

**Scope / residual.** (2) → **DF-P9** (its brief mounts `SourceDriftBanner` on the ticket page as one line; the drafting-queue chip is added in `99-fix-sequencing.md`, "Hand-offs from DF-P2"). (3) → proposed **DF-P6** (the approval actions' review model), same section.

**Partial (2026-10-14, drafting-flow Round G).** DF-P9 TICKET-PAGE — done-when 2. `SourceDriftBanner` is mounted at the top of the ticket's Incoming Assets (`app/(protected)/requests/[id]/page.tsx`:2474, with the ticket's metadata and org), and the queue shows a **"Source moved"** chip on a row whose source has moved (`app/(protected)/requests/page.tsx` `rowChips`, :645, `data-testid="chip-source-moved"`): one `documents` read per page of rows (`id, rev, current_version_id`, this workspace, as the viewer, chunked by 100), compared through `SourceDriftBanner`'s `driftedSources` (version ids when captured); a document the viewer cannot see, or a failed read, says nothing. The page's Rev chip compares version ids too (`HAND-3`).

**Done-when.**
- ✓ (1) DF-P2.
- ✓ (2) The ticket and the drafting queue show a "source revision has moved" banner / chip — `lib/__tests__/dfRoundG_P9_ticketDetail.test.ts` "REGRESSION: the same version reads current; the drift banner is mounted with the ticket's metadata", and the version-id case; the queue chip is `driftedSources` (DF-P2's tested component) over the page's documents read.
- ✗ (3) Approving over a superseded base requires no acknowledgement yet. **Owner:** drafting-flow **DF-P6** (as assigned).

**Scope / residual.** (3) → DF-P6.

**Partial (2026-10-21, drafting-flow Round G).** DF-P6 REVIEW-MODEL — done-when 3, the route half only. *Corrected at the DF-P6 review fix pass (DEC-29): this block first said every issuing approval of a moved source "says so in its description and carries `requiresSourceDriftAck`", and that the route reads the documents "as the caller". The engine half (`lib/workflow.ts` reads `WorkflowContext.sourceDrift` and then adds the note and `requiresSourceDriftAck` to every issuing approval — tested in `lib/__tests__/reviewModel.test.ts`) has NO caller yet: neither the request page nor the route passes `sourceDrift`, so no approval's description mentions a move and the flag is never set. It is the seam for the page (DF-P9). The route reads with the service role, scoped to the request's workspace.*

What the route does on every issuing approval (`approve_draft_ifc`, `approve_minor_correction`, `engineer_approve_final`, `override_engineer_final`, and a roster sign-off): it reads the source documents' live revisions (`documents`, service role, `org_id` = the request's workspace) and compares them with the revision the request captured (`revDrift`), then:
- `sourceDriftAcknowledged: true` → applies and records "Approved over a moved source, acknowledged by the approver: …" in the history line and the audit row (`sourceDrift`);
- `sourceDriftAcknowledged: false` → refused 409 `source_drift_unacknowledged`, nothing written; for a roster sign-off the refusal also writes `TICKET_SIGN_SLOT_NOT_APPLIED` naming the e-signature the panel minted (DF-P5's rule for refused sign-offs — added at the review fix pass);
- absent (the request page does not send it yet) → applies, recording "…not acknowledged (the page did not ask)" — a page that has not caught up never blocks an approval that works today (REGRESSION);
- a documents read that FAILS → the approval applies (fail-open by design while the page cannot ask; a move cannot be proved either way) and the audit row records `sourceDriftUnchecked: true`. Once the page sends the acknowledgement, the owner below may turn this into a 503.

Tests: `lib/__tests__/dfRoundG_P6_reviewRoute.test.ts` "HAND-7 done-when 3 — an approval over a moved source" (three cases) and "fix pass (review, minor 12) — a roster sign-off refused over an unacknowledged move names its signature".

**Done-when.**
- ✓ (1) DF-P2.
- ✓ (2) DF-P9.
- ✗ (in part) (3) Approving over a superseded base requires an explicit acknowledgement — enforced for any client that knows about the move (an explicit `false` is refused) and recorded for every approval; the request page's confirmation (a checkbox on the approval dialog that sends `sourceDriftAcknowledged`) is not built — the page is DF-P9's file and outside this package's plan.

**Scope / residual.** The page half → drafting-flow **DF-P9** follow-up: pass the drift labels the page already computes for `SourceDriftBanner` into `getActions` (`sourceDrift`), so the approval says so and carries `requiresSourceDriftAck`, and send `sourceDriftAcknowledged` from the approval dialog; the route should then compute the same labels before `getActions` and refuse an absent acknowledgement (and a failed read, 503) when the action carries the flag. Stays OPEN.

*Assigned (2026-10-21, the integrator at the DF-P6 merge, DEC-31; DF-P9, the package first named, merged on 2026-10-14):* the page half (done-when 3) → drafting-flow **DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS**.

**Resolution (2026-10-21, drafting-flow Round G).** DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS — done-when 3, the page half and the binding route half, under DEC-90 ruling (2) for DF-P18 ("the source-drift acknowledgement is required only when an action carries requiresSourceDriftAck; a failed documents read refuses (503) only such an action"). Reproduced on the base: no caller passed `WorkflowContext.sourceDrift`, so no approval carried `requiresSourceDriftAck`; the route applied an approval with no acknowledgement ("not acknowledged (the page did not ask)") and applied it on a failed documents read (`sourceDriftUnchecked`). Landed:
- The page: `components/requests/SourceDriftBanner.tsx` hands the moved sheets it reads to the page (`onDrift`, `page.tsx:3162`); the page passes their labels into `getActions` (`sourceDrift`, `page.tsx:2405`, worded as the route words them — `lib/requestPageReview.ts` `sourceDriftLabels`), so exactly the issuing approvals (and a roster sign-off) say so and carry `requiresSourceDriftAck`; taking such an action asks first (`appConfirm`, `page.tsx:1964`) and sends `sourceDriftAcknowledged: true` only for the approval it asked about (`driftAckRef`). The roster panel (`components/requests/TicketRosterPanel.tsx`) shows an acknowledgement checkbox when the page passes a move and sends the field with its dry run and its post (`rosterDriftNote`).
- *Corrected at the DF-P18 fix pass (review blocker, DEC-29):* the page's read is the browser's, so `documents_acl_select` limits it (an approver who cannot see a restricted source sheet, a read still in flight or failed gets no labels), while the route reads as the service role. The page therefore never asked, and the route refused every time, which blocked an approval that works today. The route is now the source of truth. Its 409 carries the moved sheets' labels (`moved`). The page's `executeWorkflowAction` (`askDriftAndResend`) and the roster panel's dry run (`openCeremony`) read them (`lib/requestPageReview.ts` `sourceDriftRefusalLabels`), ask from them (`sourceDriftConfirmation`), and resend ONCE with `sourceDriftAcknowledged: true`. The page also asks after a hold has been resolved. The panel shows its checkbox ticked from the route's labels, and a post refused for a move made after the dry run shows the checkbox again. Declining sends nothing more.
- The route (`app/api/tickets/workflow-action/route.ts`): the labels are computed BEFORE `getActions` (`:588`, only for an issuing approval or a sign-off on a request with source documents — every other action reads nothing) and passed in the engine's context, so the route and the page read one rule; an action carrying the flag without `sourceDriftAcknowledged: true` is refused (409 `source_drift_unacknowledged` with `moved`, the labels, so the client can ask; nothing written; a refused sign-off names its minted signature, DF-P5's rule; a dry run is refused with nothing recorded); a documents read that fails refuses an issuing approval or a sign-off on a request with source documents (503 `source_drift_unchecked`). That is wider than ruling (2)'s "only such an action", because with a failed read no action carries the flag. It is recorded as **`DEC-44 (DF-P18-review-model-page)` item 2, an interpretation of ruling (2) for the integrator to confirm**: it changes what the base did, which was to apply the action and record `sourceDriftUnchecked`. The dead `sourceDriftUnchecked` audit key is removed. With the acknowledgement, the history line and the audit row record the move as acknowledged.
- REGRESSION (ruling (2)): an unmoved source, a request with no source documents and every non-issuing action apply exactly as before; a workspace's page with no move shows no prompt and no checkbox.

Tests: `lib/__tests__/dfRoundG_P6_reviewRoute.test.ts` (DF-P6's "REGRESSION: a page that does not ask yet still approves …" is rewritten to the ruling: absent → 409, unmoved → as before, failed read → 503; plus "a request with NO source documents …" and "a non-issuing action …" REGRESSION cases); `lib/__tests__/dfRoundG_P18_reviewModelPageRoute.test.ts` ("HAND-7 dw3 (DF-P18) — a roster sign-off over a moved source": dry run refused / answered, the post's refusal naming the signature, a failed read → 503, an unmoved source as before); `lib/__tests__/dfRoundG_P18_reviewModelPage.test.ts` ("HAND-7 dw3 — the page passes the drift into getActions": labels, the engine flag only with labels, the page's source pins, the panel's note; the fix pass adds `sourceDriftRefusalLabels` and the page's and panel's resend pins). Added at the fix pass: `lib/__tests__/dfRoundG_P18_reviewModelPageRoute.test.ts` "HAND-7 dw3 (DF-P18 fix pass) — the route is the source of truth" (an approval and a dry run from a client with NO labels: the 409 names the move, the confirmation is built from it, and the resend with the acknowledgement applies and records it), and `lib/__tests__/dfRoundG_P18_reviewModelPageRender.test.ts` "TicketRosterPanel — a moved source only the route can see" (rendered: the dry run's 409, one confirmation, one resend with the acknowledgement, the ceremony opens; declining sends nothing more; REGRESSION, an unmoved source asks nothing).

**Done-when.**
- ✓ (1) DF-P2.
- ✓ (2) DF-P9.
- ✓ (3) Approving a deliverable drafted from a superseded base requires an explicit acknowledgement. It is asked on the page and in the roster panel, and the route requires it for every issuing approval and sign-off it flags. This includes an approver whose browser cannot read the source sheet: the route's 409 names the move, and the page or panel asks from those labels (fix pass); a consent-window close over a moved source already holds for a sign-off (DF-P7, `lib/consentWindowScan.ts` `source_moved`).

**Scope / residual.** None. The route used to fail open on a failed read. It now returns the 503 the DF-P6 record named (`DEC-44 (DF-P6-review-model)` reversal (2), now applied; `DEC-44 (DF-P18-review-model-page)` item 2). That is this package's interpretation of ruling (2), for the integrator to confirm, and reversal (2) of item 2 restores fail-open. No migration.

---

<a id="hand-8"></a>

## HAND-8 · As-built markups are never persisted anywhere; the only escape route silently falls back to the clean original

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Partial (2026-10-02, drafting-flow Round G).** Re-verified against `f1ac550`. Markup is persisted (roles-and-permissions [`LIFE-3`](../roles-and-permissions/07-document-lifecycle.md) / `GAP-7` / `DEC-24`, `f7d9fd5`; migration `20261051` **applied & verified live 2026-09-02**; drafting-flow `LEAK-5` RESOLVED on the same record) and the "shared" claim was made honest (`LIFE-8`, `6f0c522`). The pdf-lib failure branch the fleet plan asked to check still falls back silently.

**Done-when.**
- ✓ Markup state is persisted per (document, version, user) and autosaved on page switch and close (`document_markups`, `lib/markups.ts`; LIFE-3's record).
- ✗ A failed bake in **Send to Drafting** still substitutes the clean original without telling the user, on **two** branches: the `catch` — `components/viewers/FullScreenViewer.tsx:950-958` — `try { const baked = await bakeMarkupIntoPdf(bytes, states); … draftKey = await stashDraft(…); } catch (e) { console.error("bake markup for drafting failed; falling back to clean original", e); }` — and, before it, `const bytes = await ensureBytes(); if (bytes) { … }` (`:949-950`), which skips the bake with no message at all when the bytes cannot be fetched (the second branch added in the review fix pass). Either way, with `draftKey` empty, the handler attaches `sourceFileUrl` (`:980-983`) and drops the "(marked-up sheet attached …)" line from the description (`:963`). (The book viewer's equivalent does surface it — `components/viewers/MultiDocViewer.tsx:959-962` alerts — and `downloadWithMarkup` surfaces its own failures.) The redlines are no longer *lost* (they are in `document_markups`), but the request is filed against the clean sheet with no warning.
- ✓ Marking a request "shared" no longer claims an artifact that does not exist: the inbox toast reads "Noted on the document's activity thread — hand the marked-up sheet over there or on the ticket." (`app/(protected)/inbox/page.tsx:146-150`), and the share posts a `markup_ref` row on the document's thread (`lib/markupRequests.ts:137-150`).

**Scope / residual.** The silent fallback lives in the **Send to Drafting** handler — `const sendToDrafting = async () => {` (`components/viewers/FullScreenViewer.tsx:912`), the catch at `:950-958`, the clean-original attach at `:980-983`, the hand-off to `/requests/new` at `:985` — **not** in `downloadWithMarkup` (`:1000` onward), the region the public-surfaces plan gave PS-STAMP ("FullScreenViewer downloadWithMarkup (~977-1065)"; `downloadWithMarkup` already surfaces its own failures). So the fleet plan's condition ("if it still falls back, the residual is PS-STAMP's downloadWithMarkup region") is not met, and PS-STAMP has merged in any case. Owner: **DF-P9** (the ticket-side UI package; the handler's only job is to open the request form DF-P9's sibling pages sit beside): on a failed bake — the `catch` **or** an empty `ensureBytes()` — an `appAlert` saying the marked-up sheet could not be attached and a confirm-or-abort before routing to `/requests/new`, never a silent clean-original substitution; the persisted markup (`document_markups`, LIFE-3) means the user loses nothing by aborting. The edit is confined to `sendToDrafting` (`:912-990`). Concurrency (review fix pass): the plan runs DF-P9 now on the premise that it touches no document-control file, and `FullScreenViewer.tsx` is one DC has touched — but DC's re-owned `HLD-1` limb (the markup export's hold stamp, `ce39cf6`) merged with DC P15 (`b9cdfdc`) before `f1ac550`, and no unmerged package in any fleet plan lists this file, so there is no in-flight hunk to sequence behind; if a later DC package claims the file, DF-P9's hunk is disjoint from `downloadWithMarkup` (`:1000` onward) and lands first or rebases. DF-P9's brief does not list `FullScreenViewer.tsx`; the integrator must add the line, in the form the plan already uses for re-owned remainders (`99-fix-sequencing.md`, "Hand-offs from DF-P0").

**Resolution (2026-10-14, drafting-flow Round G).** DF-P9 TICKET-PAGE — the Send to Drafting fallback, confined to `sendToDrafting` (`components/viewers/FullScreenViewer.tsx`; `downloadWithMarkup` untouched). When the sheet has markups and the bake cannot run — `ensureBytes()` returned nothing, or `bakeMarkupIntoPdf` / `stashDraft` threw — the viewer asks (`appConfirm`, :1020): "Your markups could not be attached — your markups stay on this sheet while it is open, but <why>. Cancel to stay — <what the download can do>. Or send the request with the clean sheet (it will say the markups are not attached)", followed by what leaving does, worded from what this viewer can do (`markupsPersist`, :981): with a parent that persists markups (`onPageStatesChange` — the library's markup store) "Sending saves your markups to this document as you leave the viewer (as closing it does)", and the sheet's states are handed to it after the choice and before the hand-off (:1029); without one (the store could not be read, so the seed is read-only and no callback is passed) "Nothing is saving your markups in this viewer — sending leaves it and they are lost, so try to download them first if you need them". *DF-P9 integrator fix pass (say only what is true):* the dialog used to promise "'Download w/ Markup' saves a copy you can attach to the request" whatever had failed — but that button fetches the same file and bakes the same way (`ensureBytes`, `lib/markupExport.ts`), so after a failed fetch or bake it would fail too. The hint is now worded per failure (`downloadHint`, :991): the file could not be fetched → "'Download w/ Markup' needs the same file, so it may not work either until the file can be fetched"; the bake threw → "'Download w/ Markup' bakes them the same way, so it may fail too"; the bake worked but the hand-off store (`stashDraft`) failed → "the marked-up copy could not be kept for the request form … 'Download w/ Markup' may still save a copy you can attach to the request". **Cancel** stays on the sheet and sends nothing (the button is not left "sending"); **Send the clean sheet** attaches the original and the request's description says "(the requester's markups could NOT be attached — the clean sheet is attached)". No markup, or a bake that works, behaves exactly as before. *(Corrected at the DF-P9 review fix pass: the first wording told every person "your markups are saved on this document" — not true at that moment, since the viewer persists only through its parent when it closes, and not at all on a read-only seed — and the request's description repeated the claim.)*

**Done-when.**
- ✓ Markup state is persisted (LIFE-3; unchanged).
- ✓ A failed bake surfaces a blocking question instead of silently substituting the clean original — `lib/__tests__/dfRoundG_P9_sendToDrafting.test.ts` (rendered: fetch failure → asked, Cancel sends nothing, and with no persisting parent the question says the markups are lost and to download first, never "saved"; bake throws → asked, the clean sheet is attached and the request says so; with a persisting parent the question says leaving saves them and the states reach the parent after the choice, before the hand-off — Cancel hands nothing over; REGRESSION: no markup → no question, the original attached; a bake that works → the marked-up draft; integrator fix pass: after a failed fetch or bake the question never says the download "saves a copy" and says why it may fail too, and only a failed hand-off store offers the download as a way to keep a copy).
- ✓ The "shared" claim is honest (LIFE-8; unchanged).

**Scope / residual.** None.

---

<a id="hand-9"></a>

## HAND-9 · Externally submitted revisions are approved with the roster gate explicitly turned off, and no roster is ever opened for them

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-10-20, drafting-flow Round G).** DF-P11 AFTER-DC — record-only close, verified against the merged code (owners document-control `RG-10` and `REV-5`, projects-and-cost `SEC-13`, RESOLVED).

**Done-when.**
- ✓ (at approval, not at upload) a gated document's intake submission opens the resolved roster before anything publishes: `components/projects/IntakePanel.tsx:404-458` resolves `effectiveReviewControlForDocument` and calls `openReviewRoster` for the pending version when the policy requires sign-off; the upload route refuses to repoint a draft with a live roster (`RG-10`).
- ✓ IntakePanel passes `requireRosterComplete: rosterRequired` (`:466`) — `false` only for a roster-free policy.
- ✓ (made moot) an intake approval can no longer bypass a configured gate: the publish guard refuses an external submission's promote that skipped a required roster (`SEC-13`, `supabase/migrations/20261193_dc_roundF_ifc_rev_up_first_issue.sql:674-721`), so there is no bypass to label.

**Scope / residual.** None.

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
- **Status:** RESOLVED
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

**Resolution (2026-10-20, drafting-flow Round G).** DF-P11 AFTER-DC — record-only close, verified against the records and code of document-control `REV-11`, `REV-15`, `REV-17`, `REV-18` (all RESOLVED).

**Done-when.**
- ✓ (in the owner's form) split / merge / upload resolve the effective review control and record why they did not route (`reviewPolicy` on every creation event); in a require-mode library a non-controller is refused (REV-11, DEC-63 §2). Class and policy reach the new documents through the shared container chain (`HAND-6`); a document-level `doc_class` / `review_control` on a source is not copied.
- ✓ `createNewDocWithFirstVersion` paths start the review clock and the ack roster or record why not on a persisted event (`REV-15`).
- ✓ A non-controller's unreviewed first issue in a review-gated container is refused at the database (`REV-17` / `REV-18`, `20261139` / `20261144` and successors, newest guard `20261193`), pending those pastes as recorded there.

**Scope / residual.** The database halves wait on the DC pastes recorded under `REV-17` / `REV-18`.

---

<a id="hand-12"></a>

## HAND-12 · The Rev Up form defaults to a change type that waives both the review gate and the PSM MOC gate, and remembers that choice per library

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-10-20, drafting-flow Round G).** DF-P11 AFTER-DC — record-only close, verified against the merged code (owner document-control `RG-11`, RESOLVED).

**Done-when.**
- ✓ The change type opens unset (`components/documents/RevUpModal.tsx:118`, `:181`) and Publish needs a choice.
- ✓ The remembered per-library value never restores the change type (`:166-182` restores the issue type only).
- ✓ A Minor / Correction publish past a gate writes `REVIEW_GATE_SKIPPED` with the declared reason (`:425`) — a claim someone made.

**Scope / residual.** None here; the evidence pack now lists audit rows in full (`EVID-10`).

---

<a id="hand-13"></a>

## HAND-13 · documentGuards' documented DB backstop for the checkout lock no longer exists — the trigger was replaced three times and the lock check was dropped

- **Severity:** LOW
- **Status:** RESOLVED
- **Assigned:** 2026-10-21, the integrator at the document-control P32 merge (DEC-31): done-when 2's remainder → document-control P33 VERSION ROW INTEGRITY (`DCK-16`, `DCK-17`); the door (b) departure is ratified under DEC-90.
- **Pending migration:** `supabase/migrations/20261245_dc_roundG_publish_guard_lock_leg.sql` (the lock leg; after `20261193`, paste guide row 187, HOLD behind row 150) and then `supabase/migrations/20261247_dc_roundG_version_row_integrity.sql` (the version row's column guard; after `20261245`). Done-when 2 holds at the database once both are pasted (DEC-30).
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

**Partial (2026-10-20, drafting-flow Round G).** DF-P11 AFTER-DC — verified against document-control `DCK-6` (RESOLVED).

**Done-when.**
- ✓ `lib/documentGuards.ts:14-20` states that the hold check lives in the publish-guard trigger and the lock check only in `publish_revision`.
- ✗ Not met: neither alternative is taken. The trigger has no lock check (`DCK-6` chose not to restore it), and non-RPC pointer writes remain — `lib/documentLifecycle/common.ts:411` (a new document's first pointer) and `lib/reviewControl.ts:1134` (`promoteThreeStep`, the pre-`20261151` fallback of a reviewed promote). A direct `current_version_id` PATCH by someone with publish authority is not checked against a foreign checkout.

**Scope / residual.** Done-when 2 → document-control P32 PUBLISH GUARD LOCK LEG (assigned by the integrator at the DF-P11 merge, 2026-10-21, DEC-31): a lock leg in `enforce_document_publish_guard` (newest body `20261193`) compatible with the authorized-publisher override, or the removal of the non-RPC paths. Not this package's: re-creating the publish guard is outside its plan entry (`DEC-31`).

**Partial (2026-10-21, document-control Round G).** P32 PUBLISH GUARD LOCK LEG (assigned at the DF-P11 merge, DEC-31; ruled under DEC-90: fail-safe, no regression). *(Corrected at P32's fix pass 3, the second review: this block was first headed Resolution and the record set RESOLVED, but done-when 2's "so no path lacks both" does not hold as written after `20261245` — two non-RPC pointer writes still pass a foreign checkout with neither check, both recorded below with owners — and the door (b) departure from DEC-90 ruling (1) still awaits ratification. The status is back to OPEN; what landed is unchanged.)* Reproduced on HEAD `125ca3b`: the newest guard body (`20261193`) has no `checked_out_by` reference outside comments, and on the I-17 PostgreSQL 16 harness a library publisher, the document's owner, Document Control and an Admin each moved `documents.current_version_id` of a document another person had checked out with a bare `UPDATE` (the "before" column of `lib/__tests__/rls/dcP32PublishGuardLock.test.ts`). Taken as done-when 2's first alternative — the guard leg; no publish path is removed:
- `supabase/migrations/20261245_dc_roundG_publish_guard_lock_leg.sql` re-creates `enforce_document_publish_guard` from `20261193` (found by scanning; lineDiff-pinned) with ONE block (`:855-940`), placed after every earlier refusal and before the controller return: a write that makes a NEW revision current (a pointer move to a revision, a first pointer included) on a document whose `OLD.checked_out_by` is not the signed-in actor is refused with `insufficient_privilege` (42501), naming the holder — Document Control included — unless it is one of the two doors that already decide the lock: **(a)** `publish_revision`'s own promote, recognised by the revision it names having been inserted by this actor in this transaction (`created_at = now()`, the transaction's start, which no separate PostgREST request can reproduce) on top of the revision being replaced — `publish_revision` reaches that write only for the holder, an unlocked document, a recorded publisher override with its reason (DCK-8) or Document Control's recorded force, and answers `locked_by_other` otherwise, so DCK-6's constraint holds as written (the publisher-with-reason override passes; a hold never — the hold limbs are untouched); **(b)** the reviewed promote of the document's pending draft still marked `in_review` (`finalize_reviewed_promote`, `20261151`, and `lib/reviewControl.ts` `promoteThreeStep`, its pre-`20261151` fallback) — neither has ever read the lock, so a review finished while someone holds a checkout publishes as it does today (DEC-90 ruling 2: what legitimate users do keeps working). Since the review fix pass 2 door (b) admits only a pending row still `in_review` that is SHAPED as a reviewed draft (`20261245:922-935`) — it carries a bound reviewer roster (`COALESCE(v_primary_reqs, 0) > 0` — the review gate earlier in the same body has already refused one that is not complete), or it is an external submission as the intake door writes it — no member as creator (NULL, or the link's own id, which a live column default yields under the door's bound identity, SEC-22), `provenance = 'external'`, its `intake_link_id` a link of this org whose scope holds the document (the document's authoring link — `documents.authored_by_link_id`, which a signed-in session can never write, `trg_documents_authorship_fixed`, `20261141` — or a link it is assigned to: the door's own scope rule, `20261184` `intake_door_submit_version`). The first version admitted any pending draft labelled `in_review`, so a library publisher could get past it with three PostgREST writes (the P32 review's reproduction: INSERT an in-review `'external'` draft naming any `intake_link_id` — `document_versions_insert_integrity`'s publisher limb admits it — point the pending pointer at it, promote it), which the guard's review gate let through in any library whose review mode is not `require`; that draft fails both limbs now and is refused 42501. Door (b) reads only the version row, and every column it reads is writable by a library publisher (`document_versions_insert_integrity`, `20261214:509-525`; `document_versions_update_integrity`, `20261037:177-189`), so a publisher can still make an admissible row from an existing or a new one — the two remainders under done-when 2 below (`DCK-16`, `DCK-17`). No extra test on the version row was added inside the block as defence in depth: `released_at IS NULL`, `superseded_at IS NULL` or `supersedes_version_id = OLD.current_version_id` read columns the same publisher can rewrite first, so each would be forgeable and would only lengthen the forgery; the fix belongs to those policies (a column guard). The service role is never judged (the guard returns for it first). Nothing else is created or re-created; no row moved; DRLS-16 grants unchanged (EXECUTE revoked from every client role; SECURITY DEFINER, `search_path` pinned). DEC-30 one paste: prerequisite (refuses without `20261193`'s REV-28 block, changing nothing) → TEMP counts-only inventory (documents checked out; with / without a current revision; with a pending draft in review; with one NOT in review; with an in-review draft naming an intake link, no roster, not shaped as the door writes one — expected 0) → BEGIN/COMMIT → one SELECT (check, ok, n), seven probes.
- `lib/documentGuards.ts:14-40` (header comment only, outside the plan's list — reported): the database rule stated on both sides of the paste (lock in `publish_revision` only until `20261245`; the trigger's lock leg and its two doors after it), so done-when 1 stays true after the paste.
- **No app change, no deploy order.** No app path writes a pointer the block refuses: every rev-up and revert goes through `publish_revision`; a review's promote is door (b); a new document's first pointer (`lib/documentLifecycle/common.ts:411`, `lib/revisions.ts:1066` in `createDocumentWithFile`) is its creator's, right after the INSERT (a checkout by someone else inside that window would now refuse it, failing closed through the creation's own checked first-pointer refusal — `common.ts:415-416`, `revisions.ts:1067-1068`); and the legacy rev-up fallback this record's chain reaction names no longer exists on HEAD — since REV-8 a missing `publish_revision` throws `PublishContractUnavailableError` (`lib/revisions.ts:98-145`), nothing published. The app works before the paste (today's guard) and after it (the same answers; only a direct PATCH over another person's checkout is refused).
- **Paste order:** AFTER `20261193` (required), so behind the same gates (paste guide row 150 and the rows it waits on). Never re-paste `20261193`, `20261185`, `20261182`, `20261174`, `20261165`, `20261164`, `20261159`, `20261151`, `20261144`, `20261139`, `20261105` or any earlier guard migration after it.
- **PostgreSQL 16 cases** (`npm run test:db`, the I-17 harness: schema.sql + every numbered migration replayed; "before" = a copy with `20261193`'s guard put back; every case in a rolled-back transaction): K-1 a publisher / the owner / Document Control / an Admin PATCH the pointer of a document the holder has checked out — admitted before, 42501 after, pointer unchanged; K-2 a first pointer write by a non-holder — admitted before, 42501 after; the holder's — admitted both; K-3 the holder's PATCH — admitted both; K-4 a PATCH on an unlocked document (publisher, Document Control) — admitted both; K-5 no authority — refused both; K-6 the service role — admitted both; K-7 a title edit over a foreign checkout — same answer both; P-1 `publish_revision` with no override — `locked_by_other` both, nothing written; P-2 the publisher / owner override with a reason — published both, `REV_LOCK_OVERRIDDEN` (via override) recorded; P-2r the publisher's override REVERT (`revertToVersion`'s door: `reverted_from_version_id` = A, a new label, a reason) — published both, the new row superseding A, recorded; P-2f the publisher's override onto a document with NO current revision yet, held by someone else (a first publish: `supersedes_version_id` NULL = the NULL pointer replaced) — published both, recorded; P-3 a 2-character reason, and an override by someone without authority — the same refusal both; P-4 Document Control's `p_force` — published both, recorded (via force); P-5 the holder's publish and an unlocked publish — published both; P-6 the override over a held, checked-out document — `on_hold` both; R-1 `finalize_reviewed_promote` by a publisher and by Document Control who do not hold the checkout — promoted both; R-2 the three-step fallback's write — admitted both; R-3 a pending draft NOT marked in review promoted by a non-holder — admitted before, 42501 after (door (b) cannot be borrowed by a draft not marked in review); the holder's — admitted both; R-5 (review fix pass 2, the review's reproduction) the publisher's own INSERT of an in-review `'external'` draft with a creator and an `intake_link_id` that names no link — admitted both (the client INSERT policy is not the guard's); on a document whose such draft was inserted a day earlier, the pending-pointer PATCH and then the promote (three-step shape, and `finalize_reviewed_promote`) — both admitted before; after, the pointer PATCH admitted and the promote 42501, pointer unchanged; the holder's — the same answer both; R-6 a no-creator draft naming the org's REAL link on a document outside its scope (neither authored by it nor assigned to it), promoted by a non-holder — admitted before, 42501 after; R-7 a GENUINE external submission (creator the link's id; and NULL, with the replay's NOT NULL dropped inside the probe as the live table does not enforce it) on a document the link authored and on one assigned to it, approved by a publisher who does not hold the checkout through `finalize_reviewed_promote` (IntakePanel's approve under a roster-free policy) and through the three-step write — promoted both; R-8 the remainder `DCK-16` records — the publisher's own INSERT of a member-less `'external'` draft naming the link that already scopes the document (creator the link's id, or NULL) — admitted both; R-8u (fix pass 3, the second review's second probe) the same by UPDATE — an ordinary revision on the intake-born document re-shaped as the door's submission (`in_review`, `'external'`, the authoring link, the link as creator), pointed at and promoted by a non-holder — admitted both; R-9 (fix pass 3, the second review's blocker) the remainder `DCK-17` records — an earlier revision that went through review (approved, released, superseded, a complete signed primary roster) relabelled `in_review` by a publisher, pointed at and promoted over the holder's checkout — three writes admitted both, the pointer back on the old revision; without the relabel the same promote is 42501 after; R-10 (fix pass 3, the review's minor) a genuine submission on a document the project owner has since unassigned from its link, approved through `finalize_reviewed_promote` by a non-holder — promoted before, 42501 after (the intake limb reads the link's scope when the promote runs; fail-safe); the holder's approval — promoted both; R-4 a revision the same person made in an earlier request — 42501 after (door (a) cannot be borrowed); D-1 the file pasted as one script onto the "before" copy — seven probes true, six count rows (the seeded R-6 draft among them), a re-paste clean; D-2 onto a database whose guard is `20261185`'s — refused by the prerequisite, the guard unchanged. The harness's full run (18 files, 250 tests after the review fix passes' cases) is green with the file in the sequence.
- Tests: `lib/__tests__/dcRoundGPublishGuardLockMigration.test.ts` (12: base found by scan, nothing removed, every new line the block, body minus block = base byte for byte, the block's exact code and place, door (a) pinned to `publish_revision`'s lock-then-insert-then-promote order, door (b) pinned to `finalize_reviewed_promote`'s and `promoteThreeStep`'s one-write shape, DRLS-16, the one-paste shape, each prosrc probe true on the new body and the P32 probes false on the base, the header — and, added by the review fix, `publish_revision`'s INSERT pinned to stamp `created_at` with `v_now` (`NOW()`) and `supersedes_version_id` with the replaced pointer whether or not it is a revert, a first publish or an override; and, added by the review fix pass 2 (13 tests now), door (b)'s two limbs pinned: the roster limb after the review gate that refuses an incomplete roster, the intake limb to the shape `intake_door_submit_version`'s newest body and the route's legacy insert write — no `created_by`, `'external'`, the link — and the door's scope rule); `lib/__tests__/rls/dcP32PublishGuardLock.test.ts` (29, the cases above; fix pass 3 added R-8u, R-9 and R-10, and the shape test's runtime census names them).
- **Pending migration:** `supabase/migrations/20261245_dc_roundG_publish_guard_lock_leg.sql` — paste after `20261193`; what it closes holds once it is pasted (DEC-30).

**Done-when.**
- ✓ The `documentGuards.ts` header states which invariants the trigger enforces and which live only in the RPC / app layer — `lib/documentGuards.ts:14-40` (DF-P11's ✓, kept true after the paste: the lock leg and its two doors are named, and the database before the paste is described as it is).
- ✗ **Not met as written** ("… so no path lacks both"). The first alternative is built — the trigger regains a lock check compatible with the authorized-publisher override, `20261245:911-940`; `publish_revision`'s override, override revert, override first publish and force pass through door (a) unchanged, a hold never passes, and a bare PATCH over a foreign checkout is refused 42501 (pending apply, as above) — but after the paste two non-RPC pointer writes still pass another person's checkout with neither the RPC's lock check nor the trigger's, both through door (b) and the three-step PATCH shape, because every column door (b) reads on the version row is publisher-writable: **(a)** a forged door-shaped draft on an intake-born or link-assigned document — a member-less `'external'` row naming the link that already scopes it, made by INSERT (`document_versions_insert_integrity`, R-8) or by UPDATE of an existing row (`document_versions_update_integrity`, R-8u) — [`DCK-16`](../document-control/01-checkout.md#dck-16), MEDIUM, owner proposed: projects; **(b)** on any document with a reviewed revision in its history, that revision relabelled from `approved` / `superseded` back to `in_review` (its old signed roster still satisfies the roster limb) and promoted — an unrecorded revert over a live checkout (R-9) — [`DCK-17`](../document-control/01-checkout.md#dck-17), MEDIUM, owner proposed: document-control (the policy is roles-and-permissions' `20261037`); its done-when names the columns a signed-in session must not be able to move back: `review_state` to `in_review` from `approved` / `rejected` / `superseded`, `released_at` and `superseded_at` cleared, `supersedes_version_id` changed. The integrator assigns both owners (DEC-31). Done-when 2 is met when both land (a column guard on `document_versions`, or the two policies narrowed) and R-8, R-8u and R-9 answer refused after those pastes. *(History: the first tick stood on a door (b) that admitted any pending draft labelled `in_review`, which a library publisher could forge as an intake submission and promote over a colleague's checkout — R-5; review fix pass 2 narrowed door (b), R-5 and R-6 now refused, and kept the tick with `DCK-16` named; P32's fix pass 3, on the second review's relabel reproduction, withdrew the tick.)* **Departure for explicit ratification:** door (b) admits a non-holder's reviewed promote over a checkout (rulings (1)/(2) as written would refuse it — it is neither the authorized-publisher override path nor the lock holder's; refusing it breaks finishing a review while the drafter keeps the checkout through `submitForReview`, which does not release it) — residual `DCK-15`. Until it is ratified this record stays OPEN even once `DCK-16` and `DCK-17` land.

**Scope / residual.** **Departure for explicit ratification:** door (b) admits a non-holder's reviewed promote over a checkout (rulings (1)/(2) as written would refuse it — it is neither the authorized-publisher override path nor the lock holder's; refusing it breaks finishing a review while the drafter keeps the checkout through `submitForReview`, which does not release it) — residual `DCK-15`. Door (b) is the one write over another person's checkout the database still admits outside `publish_revision`: the reviewed promote of the pending draft in review that carries a bound roster the review gate proved complete, or is an external submission shaped as the intake door writes it (no member creator, `'external'`, a link of the org that scopes the document). It never read the lock at any layer, the app tells the holder nothing when it lands, and nothing records it as passing a checkout — recorded as new finding [`DCK-15`](../document-control/01-checkout.md#dck-15) (LOW; owner proposed: document-control, the integrator assigns, DEC-31). A status-only act over a checkout (supersede, archive, a status edit) moves no pointer and is not judged here (the app tells the holder of a supersede, split or merge — `notifyHolderOfRetirement`). `promoteThreeStep` stays in the code (DEC-90 ruling 2: the guard leg is preferred over removal); after this paste it passes a foreign checkout only as door (b). Remainders of door (b) itself, which reads only publisher-writable columns of the version row: the forged intake draft the trigger cannot tell from the door's on a link-scoped document (a publisher's own INSERT through the client policy, R-8, or an UPDATE re-shaping an existing row, R-8u) — new finding [`DCK-16`](../document-control/01-checkout.md#dck-16) (MEDIUM; owner proposed: projects, which owns `document_versions_insert_integrity`; the integrator assigns, DEC-31): the fix is that policy refusing a signed-in session's row that carries `intake_link_id` / `provenance = 'external'` / a creator other than itself, which no app path writes (the intake route and the door are the only writers, as the service role or `intake_door`), and the same columns guarded on UPDATE; and an earlier reviewed revision relabelled back to `in_review` and promoted through the roster limb, on ANY document with a reviewed history (R-9) — new finding [`DCK-17`](../document-control/01-checkout.md#dck-17) (MEDIUM; owner proposed: document-control; the policy is roles-and-permissions' `20261037` `document_versions_update_integrity`; the integrator assigns, DEC-31): a signed-in session must not move `review_state` back to `in_review` from `approved` / `rejected` / `superseded`, clear `released_at` / `superseded_at`, or change `supersedes_version_id`. **Fail-safe, recorded (R-10):** the intake limb reads the link's scope as it is when the promote runs, so a genuine submission on a document the project owner unassigned from the link after it was submitted (`components/projects/IntakePanel.tsx` `updateAssigned`) is refused 42501 when approved over a foreign checkout, where it was promoted before the paste. Nothing is lost: the submission stays pending, and once the holder checks the document in (or the approver asks them to), the approval lands. The pre-apply inventory's sixth count sees only drafts already outside scope at paste time, not ones unassigned later. The user-facing answer is the gap: IntakePanel shows `finalizeReasonMessage`'s pass-through "Couldn't publish: This document is checked out by …; publish it from the revision flow with an override reason …", a path that cannot publish an intake submission. Mapping that 42501 sentence to "ask the holder to check it in, then approve" belongs to `lib/reviewControl.ts` (outside this package's plan), recorded as a done-when on [`DCK-15`](../document-control/01-checkout.md#dck-15) (owner proposed: document-control, the same file and owner).

**Resolution (2026-10-21, document-control Round G).** P33 VERSION ROW INTEGRITY (done-when 2's remainder, assigned at the P32 merge, DEC-31; the door (b) departure was ratified by the integrator at that merge under DEC-90 — "a review the gate proved complete stays finishable while the drafter keeps the checkout"). What landed: `supabase/migrations/20261247_dc_roundG_version_row_integrity.sql` — `document_versions_insert_integrity` re-created from its newest body (`20261214`) with a provenance limb, and one column guard on `document_versions` (`enforce_document_version_row_integrity()`) — closes the two forgeable remainders this record named: [`DCK-16`](../document-control/01-checkout.md#dck-16) (a door-shaped draft made by INSERT or UPDATE: refused) and [`DCK-17`](../document-control/01-checkout.md#dck-17) (an earlier reviewed revision relabelled back to `in_review`: refused; and, found while enumerating, a reviewed pending draft moved onto another document: refused). The untold, unrecorded genuine promote this record's residual named is [`DCK-15`](../document-control/01-checkout.md#dck-15), resolved app-side in the same package (the holder told, a `REVIEW_PROMOTED_OVER_CHECKOUT` row with `via: "review_promote"` — a routine revisions action, not `publish_revision`'s destructive override record — the Inspector's note, the lock refusal's words); a promote made outside the app is new finding [`DCK-18`](../document-control/01-checkout.md#dck-18) (LOW) — a record-keeping gap, not a path past the lock. On the I-17 harness (`lib/__tests__/rls/dcP32PublishGuardLock.test.ts`, "before" = both pastes undone): R-8 ("the remainder DCK-16 records") and R-8u ("…, by UPDATE") and R-9 ("the remainder DCK-17 records") now answer admitted before and refused after; "a GENUINE external submission" (R-7) and "finalize_reviewed_promote by a publisher" (R-1) still promote on both sides; every other P32 case answers as P32 recorded it. P33's own runtime suite is `lib/__tests__/rls/dcP33VersionRowIntegrity.test.ts`.

**Done-when.**
- ✓ The `documentGuards.ts` header states which invariants the trigger enforces and which live only in the RPC / app layer — unchanged since DF-P11 / P32 (`lib/documentGuards.ts:14-40`).
- ✓ The trigger regains a lock check compatible with the authorized-publisher override (`20261245`'s lock leg: `publish_revision`'s override, override revert, first publish and force pass as door (a), a hold never), and after `20261247` no path makes a new revision current over another person's checkout with neither check except door (b) — the ratified reviewed promote of a pending draft whose row a signed-in session can no longer forge (no `'external'` / link / foreign creator by INSERT or UPDATE, no move back into review, no cleared release or supersession, no rewritten base, no move between documents). Holds at the database once both files are pasted (DEC-30), for writes made from the paste on: a door-shaped in-review row a signed-in session wrote BEFORE `20261247` (`'external'`, the link, created by NULL or the link's id) cannot be told from the door's genuine submission, is not refused, and door (b) can still promote it over a checkout until it is decided, withdrawn or voided — the file's inventory row 2 (informational; it counts genuine pending submissions too) shows the operator how many pending external submissions exist (`supabase/migrations/20261247_dc_roundG_version_row_integrity.sql:185-196`); that residual is recorded on [`DCK-18`](../document-control/01-checkout.md#dck-18). The contractor door's own submission keeps working on both of its paths after the paste — the role switch as `intake_door` with no WARNING or fallback, and the bound-claims fallback (pinned at P33's final fix pass, which found and fixed the column guard sending the switched INSERT to its fallback).

**Scope / residual.** Pending the two pastes, in order (`20261245` after `20261193`; `20261247` after `20261245`). Door (b) itself is the ratified departure; its record-keeping outside the app is `DCK-18`. Under DEC-29 the database half is stated as it is: `20261247` judges writes made from the paste on; a door-shaped submission already pending before the paste is not refused and door (b) can still promote it over a checkout until it is retired (decided, withdrawn or voided); the inventory's informational row 2 lets the operator see how many pending external submissions exist. Owner of that residual: [`DCK-18`](../document-control/01-checkout.md#dck-18) (LOW, a done-when added at P33's final fix pass) — not reopened here as a Partial, because no write the paste admits creates such a row. Nothing in this package edits `lib/documentGuards.ts`.

---
