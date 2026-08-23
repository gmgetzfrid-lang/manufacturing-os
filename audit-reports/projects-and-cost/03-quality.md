# 03 · The quality program — checklists, turnover, punch

**13 findings** — 1 CRITICAL · 4 HIGH · 8 MEDIUM.

Whether a green item means something a person would sign.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| `firstDocMatch`'s whole-word matching, with the reasoning written down and a regression test pinning it | `lib/checklistEngine.ts:113-126; lib/__tests__/projectControls.test.ts:360` | The comment explains that substring matching would cite "Rapid Response Plan" as a P&ID and "Extended Warranty" as NDE evidence, and the `\b` guards plus `escapeRe` implement it. Any fix that filters the document register by status must keep this matcher intact — it is the one part of the evidence engine that is deliberately conservative and proven so. |
| The human-override precedence rule: `manual_note` set means every automated pass keeps out | `lib/checklistEngine.ts:141; lib/checklists.ts:161; lib/checklists.ts:199` | Both automated writers honour it, the UI explains it to the user at the moment of decision (QualityTab.tsx:429), and it is the product's stated central promise. It is sound and must not be weakened by any change to the assessment or sweep paths — note that finding 4's fix must extend protection to satisfied-with-evidence items *without* removing this. |
| `user_owns_project()` requires an active `org_members` row, with the reasoning documented | `supabase/migrations/20261013_project_controls_program.sql:52-65` | Offboarding a user revokes their quality-write access immediately, whatever projects still name them owner, and `search_path` is pinned per the house SECURITY DEFINER pattern. Two prior audits cite this function as the correct model. Broadening quality-write authority (finding 7) must go through a helper of the same shape, not around it. |
| `setChecklistStatus`'s completion gate and `computeChecklistProgress`'s exclusion of N/A items are correct as written | `lib/checklists.ts:214-231; lib/checklists.ts:338-350` | The gate refuses completion while any applicable item is unsatisfied, and the message explains why. The defect is not the gate's logic but the error-swallowing read feeding it (finding 6) and the paths that make items N/A cheaply (SAF-2, SAF-4, finding 4). Fix the inputs; leave the gate. |
| `gatherProjectEvidenceState`'s per-query fault tolerance fails closed for evidence | `lib/checklists.ts:238-250` | A failed or pre-migration `turnover_items` / `project_checklists` read contributes an empty list, so probes return null and items go to `needs_evidence` rather than green. This is the correct direction for a safety sweep and contrasts sharply with the checklist-item read behind the completion gate (finding 6), which fails open. Preserve the asymmetry deliberately. |
| The turnover seed lists are written as plain-language explanations of what each artifact must contain | `lib/turnover.ts:57-86` | "Test pressure, hold time, test medium, and the witness signature"; "heat numbers must trace to what was installed"; "an uncalibrated gauge proves nothing". This is real B31.3/PSM domain content and the nesting by job kind is coherent. It is the strongest asset in the area and should be the anchor for any richer turnover model (finding 9, finding 12). |
| `companyScore` excludes unevidenced dimensions instead of scoring them 100 or 0 | `lib/companyScore.ts:1-12; lib/companyScore.ts:100-102` | `{ key: "quality", score: null, detail: "No quality evidence yet" }` — an unknown stays an unknown. This is the right pattern and is why MON-7's empty `party_id` produces an honest blank rather than a fabricated score. Any turnover/punch wiring must keep the null path. |
| The `audit()` helpers in both modules write project-scoped rows with the correct shape for the RLS insert policy | `lib/checklists.ts:87-93; lib/turnover.ts:121-127; supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:84-90` | `user_id = actor.uid` and an org the caller belongs to satisfy `audit_logs_insert`'s `WITH CHECK`, and `resource_type: 'project', resource_id: projectId` is exactly the shape SAF-6's one-line timeline fix would pick up. The rows are addressable; what they need is item-level detail (finding 3) and a reader. |


---


<a id="qual-1"></a>

## QUAL-1 · Auto-evidence never retracts: a satisfied safety item survives the deletion, voiding or supersession of the only document that proved it, and the citation cannot be traced back to any document row

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/checklistEngine.ts:135-158`, `lib/checklistEngine.ts:143`, `lib/checklistEngine.ts:154-156`, `lib/checklistEngine.ts:59-63`, `lib/checklists.ts:315-320`, `lib/checklists.ts:51`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Every leg holds. Line 143 (`if (item.status === "satisfied" && item.evidence.some((e) => e.source === "manual")) continue;`) confirms auto-satisfied items ARE re-swept — so the sweep sees the missing proof and still declines to retract. I also found the voiding case is worse than stated: the register query at lib/checklists.ts:258 (`.select("title, name, document_number").eq("collection_id", collectionId)`) filters on nothing at all, so a Voided or superseded document keeps supplying live evidence indefinitely.

**Mechanism.** `applyAutoEvidence` can only ever move an item *toward* green. The downgrade branch is guarded on `open`:

```ts
if (proof) {
  ... out.push({ id: item.id, status: "satisfied", addedEvidence: already ? [] : [{ label: proof, source: "auto" }] });
} else if (item.status === "open") {
  out.push({ id: item.id, status: "needs_evidence", addedEvidence: [] });
}
```

An item already at `satisfied` whose proof has vanished falls through both branches and is not returned at all, so `runAutoEvidence` writes nothing and the row stays `satisfied`. The skip at line 143 only protects human-attached evidence (`e.source === "manual"`), so this is the machine's own green going stale, not a human override.

Second half of the defect: the auto citation is a bare string. `AutoEvidenceResult.addedEvidence` is typed `Array<{ label: string; source: "auto" }>` — no `documentId` — even though `ChecklistItem.evidence` (lib/checklists.ts:51) declares `documentId?: string`. `runAutoEvidence` spreads that straight into the row (`patch.evidence = [...item.evidence, ...r.addedEvidence]`), so the stored proof is the literal text `Document on file: "E-301 Hydrotest Report Rev 0"` with no foreign key to anything.

**Failure scenario.** A contractor's "E-301 Hydrotest Report Rev 0" lands in the project intake folder; the sweep greens the PSSR pressure-test item and attaches the citation. Two weeks later the document is found to be the wrong equipment and is set to `Void` (or deleted, or renamed at revision). Every subsequent sweep leaves the item green — nothing in the codebase ever moves an item from `satisfied` back to `needs_evidence`. The PSSR completes and the project closes with a pressure-test line certified against a voided document. When a regulator asks which document proves that line, the record holds a free-text label, not a document id: there is no query that resolves the chip to a `documents` row, so nobody can even establish that the cited document has since been voided.

**Evidence.**

```
lib/checklistEngine.ts:154 `} else if (item.status === "open") {` — the sole path to `needs_evidence`. lib/checklistEngine.ts:62 `addedEvidence: Array<{ label: string; source: "auto" }>;` versus lib/checklists.ts:51 `evidence: Array<{ label: string; documentId?: string; href?: string; source: "auto" | "manual" }>;`. lib/checklists.ts:316 `if (r.addedEvidence.length > 0) patch.evidence = [...item.evidence, ...r.addedEvidence];`. Repo-wide grep for any writer that lowers a checklist item's status found only `updateChecklistItem` (human, lib/checklists.ts:203) and `applyAssessment`'s N/A flip (lib/checklists.ts:167) — no revalidation path exists.
```

**Chain reaction.** Distinct from SAF-1 (audit-reports/projects-tab/02-safety-compliance.md), which is about a bad green being *created* from an unreviewed Draft title. This is the green *persisting* after its basis is withdrawn — SAF-1's proposed fix (filter the gather to `Issued` documents) does not repair already-satisfied rows, because those rows are never re-examined. Feeds finding "MI sign-off is auto-evidence laundered into human-grade proof" and the closeout gates in app/(protected)/projects/[id]/page.tsx:627-651, which count only unresolved items.

**Done when.**

- [ ] `applyAutoEvidence` returns a downgrade for an item currently `satisfied` whose only evidence is `source: "auto"` and whose probe no longer returns proof.
- [ ] Auto-attached evidence carries the `documentId` it matched, and stale auto chips are removed (not merely supplemented) when the sweep re-runs.
- [ ] The evidence chip renders the cited document's current status, so a Void/Superseded citation is visible.
- [ ] A test pins: satisfy on a matching title, remove the title from `documentTitles`, re-run — the item is no longer satisfied.

---

<a id="qual-2"></a>

## QUAL-2 · Auto-evidence launders itself into human-grade proof: an MI checklist greened entirely by document-title matches, then completed, satisfies "mechanical integrity" items on every other checklist with no person in the chain

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/checklists.ts:288-293`, `lib/checklists.ts:290`, `lib/checklistEngine.ts:80-83`, `lib/checklists.ts:214-231`, `lib/checklistEngine.ts:74-79`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The laundering chain is real and reproducible as described — title strings become item-level greens, which become a checklist status, which becomes a proof token consumed by other checklists in the project, and no code anywhere distinguishes auto from manual at either hop. One nuance on the wording: a person is technically in the chain — someone with canManage must click "Mark complete" (QualityTab.tsx:381-384 → setChecklistStatus) — but that click attests to nothing item-level, so the substance of the finding is unaffected.

**Mechanism.** Two of the eight evidence rules do not probe documents at all — they probe the platform's own quality state:

```ts
{ match: /mechanical integrity|MI review|integrity (group|manager)/i,
  probe: (s) => (s.miChecklistComplete ? "Mechanical-integrity checklist complete" : null) },
{ match: /turnover|quality package|data book|documentation package/i,
  probe: (s) => s.turnoverAcceptedNames.length > 0 ? `Turnover items accepted: …` : null },
```

`miChecklistComplete` is computed as `checklists.some((c) => c.kind === "mi" && c.status === "complete")` — any MI checklist at status `complete`, with no requirement that a human decided any of its items. And an MI checklist reaches `complete` through `setChecklistStatus`, whose gate is satisfied by items at `status === "satisfied"` regardless of how they got there — including entirely by `runAutoEvidence` title matching.

The turnover rule is weaker still: the probe fires on `turnoverAcceptedNames.length > 0`, so **one** accepted turnover item of any kind satisfies **every** item on **every** checklist whose text mentions turnover, quality package, data book or documentation package. The label attached names the first three accepted items, which need have nothing to do with the checklist line.

**Failure scenario.** A contractor uploads six files through the tokened intake portal with titles containing "Weld Log", "NDE Report", "Hydrotest", "MTR", "As-Built" and "P&ID". A sweep greens the corresponding six lines of the MI checklist; the owner marks the MI checklist complete (the gate passes — every applicable item is `satisfied`). The PSSR is then swept: its line "New equipment reviewed by the mechanical integrity group" turns green citing "Mechanical-integrity checklist complete." No mechanical-integrity engineer opened anything. Separately, accepting the single "Work completion sign-off" turnover item greens the PSSR's "Turnover/quality package received" line citing that sign-off as if it were the data book.

**Evidence.**

```
lib/checklists.ts:290 `miChecklistComplete: checklists.some((c) => c.kind === "mi" && c.status === "complete"),` — the query at :246-247 selects only `kind, status`, so nothing about human involvement is available to test. lib/checklists.ts:220 `const blocking = items.filter((i) => i.applicability !== "na" && i.status !== "satisfied" && i.status !== "na");` — `satisfied` is accepted without regard to evidence source. lib/checklistEngine.ts:76-78 `probe: (s) => s.turnoverAcceptedNames.length > 0 ? ...` — a length test, not a match against the item's subject.
```

**Chain reaction.** SAF-1 establishes hop one (an unreviewed Draft title greens an item). This is hop two and three: that green becomes a completed checklist, and the completed checklist becomes cited proof on a *different* checklist — so SAF-1's blast radius is not one item but transitively every MI-referencing and turnover-referencing line in the project. Combined with finding 1 (no retraction), none of it can ever be walked back by the sweep.

> **Verifier correction.** "With no person in the chain" is too strong. A human clicks through every phase: Assess → the appConfirm → Apply (QualityTab.tsx:305), the sweep button (:378), Mark complete (:383), and turnover Accept (:573) is itself a human decision that stamps reviewed_by_name. Also, a fully auto-greened MI checklist is not reachable by the sweep alone — items matching none of the eight EVIDENCE_RULES are left at `open` (checklistEngine.ts:145) and block completion, so the path requires the AI assessment to first mark the non-matching items N/A. The accurate claim is that no human ever verifies an INDIVIDUAL item, and that a checklist greened by document-title regex is then treated by other checklists as equivalent to a human sign-off.

**Done when.**

- [ ] `miChecklistComplete` requires the MI checklist's items to carry human decisions (or the rule is deleted), not merely `status = 'complete'`.
- [ ] The turnover rule matches the checklist item's subject against the accepted item's name rather than firing on a non-empty list.
- [ ] `setChecklistStatus` distinguishes a checklist completed on auto-evidence from one completed on human sign-off, and only the latter is citable as evidence elsewhere.
- [ ] A test pins: an MI checklist satisfied purely by auto-evidence does not satisfy a PSSR mechanical-integrity item.

---

<a id="qual-3"></a>

## QUAL-3 · Deleting a project hard-deletes the entire PSSR/turnover/punch record by cascade — unmentioned in the confirmation, uncounted in the audit row, and exempt from retention, legal hold and every delete guard the document side has

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/projects.ts:599-617`, `supabase/migrations/20261013_project_controls_program.sql:141-142`, `supabase/migrations/20261013_project_controls_program.sql:156`, `supabase/migrations/20261013_project_controls_program.sql:174-175`, `supabase/migrations/20261013_project_controls_program.sql:193-194`, `app/(protected)/projects/[id]/page.tsx:407`, `supabase/migrations/20261013_project_controls_program.sql:253-288`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on all four legs, including the two claims of absence — no BEFORE DELETE trigger exists on any of project_checklists / checklist_items / turnover_items / punch_items / change_orders, and the audit row (lib/projects.ts:612-616) carries `details: { name: p.name }` with no counts. Substantially the same defect as PM-6 viewed from the quality-record side; both are accurate as written.

**Mechanism.** `deleteProject` carefully enumerates what must survive or be cleaned up — checkouts and markup requests are unlinked (`project_id: null`), milestones, activity and members are deleted explicitly with a comment explaining why — and then deletes the project row. The quality program is not named anywhere in the function. It does not need to be: every quality table declares `REFERENCES projects(id) ON DELETE CASCADE` (`project_checklists` :142, `turnover_items` :175, `punch_items` :194) and `checklist_items` cascades from `project_checklists` (:156). So one DELETE silently destroys every PSSR/MI/QA-QC checklist, every checked item with its evidence and human decisions, the whole turnover package with its reviewer sign-offs, and the punch list.

The audit row records `details: { name: p.name }` — not a count of what was destroyed. The confirmation text names the two things that *are* preserved and the one other thing deleted, and omits the quality program entirely:

```
`Delete "${project.name}"? This permanently removes the project and its schedule. Document checkouts are kept (just unlinked). This cannot be undone.`
```

No protection applies. `supabase/migrations/20260820_retention.sql` adds `retention_policy`, `retention_until`, `disposition_state`, `legal_hold` and `document_disposition_events` — to `libraries`, `collections` and `documents` only. `supabase/migrations/20260826_legal_hold_delete_guard.sql` installs `BEFORE DELETE` triggers on `documents` and `document_versions` only. Grep across all migrations for triggers on the four quality tables returns nothing. Their RLS is a plain `FOR ALL` (:262-288), so DELETE is granted to any org controller or the project owner.

**Failure scenario.** A project owner or any Admin/DocCtrl deletes a completed capital project to tidy the list, reading a confirmation that promises only the schedule will go. Gone in one statement: the completed PSSR with 120 items and their evidence citations, the turnover package with the QA/QC reviewer's name and date on each accepted NDE and MTR package, and the punch history. The `PROJECT_DELETED` audit row says `{name: "Unit 300 Repipe"}` — it cannot tell an investigator that 120 verified safety lines existed, let alone what they said. If the plant is under a legal hold or a PSM incident investigation, the documents are protected by a database trigger and the quality records that certify them are not.

**Evidence.**

```
lib/projects.ts:604-610 — `checkout_sessions`, `markup_requests`, `milestones`, `project_activity`, `project_members` each handled by name; no mention of `project_checklists`, `checklist_items`, `turnover_items`, `punch_items`. lib/projects.ts:612-616 — `details: { name: p.name }`. supabase/migrations/20261013:175 `project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,`. supabase/migrations/20260826_legal_hold_delete_guard.sql:30-33 `CREATE TRIGGER trg_documents_legal_hold_delete BEFORE DELETE ON documents`; grep for `TRIGGER` in 20261013_project_controls_program.sql returns zero matches, and a repo-wide grep of `supabase/migrations/*.sql` for the four table names outside 20261013 returns zero matches.
```

**Chain reaction.** Compounds SAF-6 (the project timeline never queries `resource_type='project'`, so the quality audit rows were already invisible in the app) and the evidence-pack omission below: after the cascade the only surviving trace of the quality program is `audit_logs` rows carrying aggregate counts, in a table no project surface reads.

> **Verifier correction.** Downgrade CRITICAL→HIGH. The destruction is not unauthorized or accidental-by-code: it requires a deliberate act by the project owner or an org Admin/DocCtrl, behind an appConfirm that already says "permanently removes… This cannot be undone", and it is audited. Milestones, activity and members are deleted deliberately by the same function, so cascading the project-scoped quality rows is arguably the intended shape of a project delete. The genuine defect — and it is real — is narrower than "silently destroys": (1) the confirmation enumerates what survives and omits the PSSR/turnover/punch program entirely, (2) the audit row records no count of what was destroyed, (3) unlike documents, these records carry no retention_policy/legal_hold column and no BEFORE DELETE guard, so a spoliation hold cannot reach them.

**Done when.**

- [ ] The delete confirmation enumerates the quality records that will be destroyed, with counts.
- [ ] `PROJECT_DELETED` audit details carry the counts of checklists, checklist items, turnover items and punch items removed.
- [ ] A project carrying any completed checklist or accepted turnover item cannot be hard-deleted — it archives, or requires an explicit second confirmation with a reason.
- [ ] A `BEFORE DELETE` guard covers the four quality tables the way 20260826 covers `documents`, and retention/legal-hold reaches quality records.

---

<a id="qual-4"></a>

## QUAL-4 · No qualified sign-off and no separation of duties anywhere in the quality program — only Admin/DocCtrl or the one project owner may record any decision, and that same person can author, auto-green, sign, complete and close alone

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20261013_project_controls_program.sql:262-288`, `supabase/migrations/20261013_project_controls_program.sql:57-65`, `app/(protected)/projects/[id]/page.tsx:68`, `app/(protected)/projects/[id]/page.tsx:133-134`, `types/schema.ts:26-46`, `components/projects/QualityTab.tsx:466-481`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Correct, including the separation-of-duties claim of absence: nothing in lib/checklists.ts, lib/turnover.ts or the migration compares the actor against the item's creator, `created_by`, `reviewed_by`, or a required second party, and there is no signature/attestation table (grep for signature/signed_by/attest across the quality layer returns only a prose hint string in lib/turnover.ts:67). One person holding owner or Admin/DocCtrl can create the checklist, run the sweep, mark items satisfied, mark the checklist complete, and accept turnover with no second actor at any step.

**Mechanism.** Every write policy on the four quality tables resolves to the same two authorities:

```sql
CREATE POLICY project_checklists_write ON project_checklists FOR ALL
  USING (is_org_controller(org_id) OR user_owns_project(project_id))
  WITH CHECK (is_org_controller(org_id) OR user_owns_project(project_id));
```

`is_org_controller` resolves to `role IN ('Admin','DocCtrl') OR roles && ARRAY['Admin','DocCtrl']` (supabase/migrations/20260814_documents_delete_controllers.sql:38); `user_owns_project` requires `projects.owner_user_id = auth.uid()`. The client mirrors it exactly: `const isAdmin = hasAnyRole(["Admin", "DocCtrl"]);` and `const canManage = isOwner || isAdmin;`.

`ALL_ROLES` contains `Safety`, `Operations`, `Maintenance`, `Engineer-1..4`, `Supervisor`, `Manager`, `Auditor` — none of which can write any row in `project_checklists`, `checklist_items`, `turnover_items` or `punch_items`. Project membership does not help: `user_owns_project` reads `projects.owner_user_id`, not `project_members`, so someone added as a project member with `role: 'owner'` still cannot write.

And there is no second signature. Grep across lib/checklists.ts, lib/turnover.ts, lib/checklistEngine.ts and components/projects/QualityTab.tsx for `eSignature`, `e_signatures`, `signoff`, `sign_off`, `captureSignature` returns nothing; no migration ties `e_signatures` or `document_review_signoffs` to any quality table. A sign-off is `updated_by_name = actor.email.split("@")[0]` plus a free-text note.

**Failure scenario.** A PSSR under 29 CFR 1910.119(i) requires the operating and maintenance representatives to confirm procedures, training and equipment. In this system the Operations lead and the mechanical-integrity engineer log in, see the checklist read-only (member_read grants SELECT to any active member), and have no button — `canManage` is false for them. The project owner clicks every line on their behalf; the record says the owner verified NDE, hydrotest, training and MOC. The same owner created the checklist, ran the AI assessment, ran the evidence sweep, marked the checklist complete, accepted every turnover item and marked the project complete — six roles, one uid, zero countersignatures. A regulator reading the record sees one name against the whole PSSR.

**Evidence.**

```
supabase/migrations/20261013:279-288 — identical `USING`/`WITH CHECK` pairs for `turnover_items_write` and `punch_items_write`. app/(protected)/projects/[id]/page.tsx:68 `const isAdmin = hasAnyRole(["Admin", "DocCtrl"]);` (the hardcoded facility vocabulary the prior audits flagged). types/schema.ts:39-42 `"Safety", "HR", "Maintenance", "Operations",`. components/projects/QualityTab.tsx:469-470 — the ✓ Satisfied control is rendered only under `canManage`. lib/checklists.ts:195 `updated_by_name: input.actor.email?.split("@")[0] ?? null` — the entirety of the identity captured on a safety sign-off.
```

**Chain reaction.** Interacts with finding 3: because the machine path writes no actor and the human path writes an email prefix, the record cannot separate machine verdicts from human ones *or* one human from another. audit-reports/roles-and-permissions covers the role vocabulary and `is_org_controller`'s missing `SET search_path`; what is new here is that the quality program inherited document-control's authority model wholesale, so the people a PSSR legally requires are locked out of it.

> **Verifier correction.** Frame it as a design gap rather than a code bug: nothing here is broken relative to what the code intends — the program was simply built without qualified-role gating, a second signature, or an e-signature binding, all of which exist elsewhere in the app for documents. The hardcoded ["Admin","DocCtrl"] vocabulary at page.tsx:68 belongs to the already-completed roles-and-permissions audit and should be cited to it, not re-counted here.

**Done when.**

- [ ] A discipline reviewer (Safety / Operations / Maintenance / Engineer) can be granted write authority on a specific project's quality records without being made Admin, DocCtrl or project owner.
- [ ] A checklist requiring sign-off cannot be completed by the same uid that created it and ran the sweep.
- [ ] A quality sign-off captures a bound identity (uid + timestamp + statement), not an email prefix and a free-text note.
- [ ] The UI does not render sign-off controls to users the policy will reject, and does not hide them from users the policy would accept.

---

<a id="qual-5"></a>

## QUAL-5 · Re-running the AI assessment silently converts already-satisfied items — evidence attached — to N/A, dropping them out of the completion gate while their green evidence chips stay on screen

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/checklists.ts:158-171`, `lib/checklists.ts:167`, `lib/checklists.ts:338-350`, `components/projects/QualityTab.tsx:455-464`, `components/projects/QualityTab.tsx:293-319`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. The one mitigation I found and weighed: the confirm dialog at QualityTab.tsx:307-309 discloses the count of proposed N/As and says "Items you've decided by hand are never touched" — but it never says already-satisfied, evidence-bearing items are among them, and "decided by hand" means manual_note specifically, so a reviewer who clicked "✓ Satisfied"... does get a note prompt (QualityTab.tsx:428-433 always passes promptNote), while the sweep's own greens have no note and are unprotected. Minor overstatement in the wording: the flipped row is rendered at `opacity-50` with an N/A status dot, so the stale chips are greyed rather than fully green.

**Mechanism.** `applyAssessment` guards on one thing only — a human's `manual_note`:

```ts
if (item.manualNote) { skippedHuman += 1; continue; }
...
if (p.applicability === "na" && item.status !== "na") patch.status = "na";
```

There is no guard on `item.status === "satisfied"` and none on the item already carrying evidence. An item that a previous sweep (or a previous assessment cycle followed by a sweep) turned green is treated exactly like an untouched `open` item: if the model returns `na` on this run, the row flips to `na`. The patch does not clear `evidence`, so the attached citation chips survive on a row now marked not-applicable.

Everything downstream then reads the item as excluded. `computeChecklistProgress` filters `applicability !== "na" && status !== "na"` out of `applicable`, so the denominator shrinks and `pct` rises. `setChecklistStatus`'s blocking filter (:220) uses the same exclusion. `gatherProjectSnapshot` skips it (lib/projectSnapshot.ts:84). The closeout gate reads "Checklists clear."

**Failure scenario.** A PSSR is worked for two weeks: the sweep and the reviewers green 40 of 60 items with citations. Someone then re-runs "Which items apply to this job?" — a button that stays enabled for the whole life of an open checklist (QualityTab.tsx:373-377) — because the SOW was updated. The model, seeing slightly different context, returns `na` for eleven previously-satisfied lines. The confirmation says only "(11 look not-applicable to this job, with reasons attached)." Eleven verified safety lines silently leave the count. The card still shows their green evidence chips beside a greyed row, because `evidence` was never cleared — the screen simultaneously asserts "proof on file" and "does not apply." Progress jumps, and the checklist becomes completable.

**Evidence.**

```
lib/checklists.ts:167 `if (p.applicability === "na" && item.status !== "na") patch.status = "na";` — the condition tests only the *destination*, never the origin. lib/checklists.ts:162-166 — the patch object contains `applicability`, `ai_rationale`, `updated_at` and (conditionally) `status`; `evidence` is absent. lib/checklists.ts:339 `const applicable = items.filter((i) => i.applicability !== "na" && i.status !== "na");`. components/projects/QualityTab.tsx:455-464 renders `item.evidence` unconditionally, with the N/A row merely at `opacity-50` (:440).
```

**Chain reaction.** SAF-2 covers the count-only confirmation dialog as a *review* failure — a rookie approving unseen N/As. This is the orthogonal defect: even a careful reviewer who reads every rationale is not told that eleven of the items being N/A'd were already verified with evidence, because the dialog reports only `applicability` counts and the API response (app/api/projects/checklist/route.ts:114-117) never fetches the items' current `status` or `evidence` to compare against. REL-6 item 7 flags `applyAssessment` as untested.

> **Verifier correction.** "Silently" overstates it slightly: QualityTab.tsx:305-309 puts an appConfirm in front of the write that reports how many proposals are N/A. It does not disclose that already-satisfied items are in scope, and its reassurance — "Items you've decided by hand are never touched" — actively reinforces the wrong mental model, since the only thing that is protected is a manual_note, not a satisfied status or attached evidence. The defect stands; the word to use is "undisclosed", not "silent".

**Done when.**

- [ ] `applyAssessment` refuses to downgrade an item that is `satisfied` or carries any evidence, or requires an explicit per-item human confirmation to do so.
- [ ] Any path that sets `applicability: 'na'` on an item with attached evidence either clears the evidence or records why proof exists for a line declared not-applicable.
- [ ] The confirmation dialog states how many proposed N/As target currently-satisfied items.
- [ ] A test pins: satisfied item + `na` proposal ⇒ not silently flipped.

---

<a id="qual-6"></a>

## QUAL-6 · A checklist item the machine turned green records no actor at all, and the sweep's audit row is a count — nothing in the system says which items were auto-satisfied or by which run

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/checklists.ts:311-324`, `lib/checklists.ts:315`, `lib/checklists.ts:321-323`, `supabase/migrations/20261013_project_controls_program.sql:165-167`, `lib/checklists.ts:192-196`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The core holds: the sweep stamps updated_at with no actor, and the audit row is a bare count. But the narrated scenario is impossible — updated_by_name is written only by updateChecklistItem, whose only caller always sets manual_note, and applyAutoEvidence skips any item with manual_note; so the stale-'mreyes' misattribution cannot occur (the column stays NULL). 'Nothing says which items were auto-satisfied' is also false: every auto-green carries an evidence entry with source:"auto", rendered as an emerald chip titled 'Found by the evidence sweep' (QualityTab.tsx:458-459).

**Mechanism.** `runAutoEvidence`'s per-item patch is:

```ts
const patch: Record<string, unknown> = { status: r.status, updated_at: new Date().toISOString() };
if (r.addedEvidence.length > 0) patch.evidence = [...item.evidence, ...r.addedEvidence];
```

`updated_by` and `updated_by_name` — both columns exist (migration :166-167) and both are written by the human path (`updateChecklistItem`, :192-196) — are left untouched. So the row's `updated_at` moves to the sweep's timestamp while `updated_by_name` keeps whatever human last touched the item, or stays NULL. The row cannot distinguish "a person verified this at 14:32" from "a title-matching regex fired at 14:32".

The compensating record is the audit row, and it is aggregate only:

```ts
await audit("CHECKLIST_AUTO_EVIDENCE", input.orgId, input.projectId, input.actor, {
  checklistId: input.checklistId, satisfied, needsEvidence,
});
```

No item ids, no item text, no citations, no per-item timestamps. The same shape applies to `applyAssessment` (`{ checklistId, applied, skippedHuman }`, :172-175), whose patch (:162-166) likewise omits `updated_by`.

**Failure scenario.** A regulator points at line 27 of the completed PSSR — "NDE performed and reports reviewed" — and asks who verified it and when. The row says `status: satisfied`, `updated_at: 2026-08-14T14:32Z`, `updated_by_name: 'mreyes'` (from an unrelated N/A decision three weeks earlier), evidence `Document on file: "NDE Report"`. `mreyes` did not verify it; a regex did. The audit trail holds one `CHECKLIST_AUTO_EVIDENCE` row saying `{satisfied: 41, needsEvidence: 6}` for a 120-item checklist, from which line 27's history cannot be reconstructed. Nothing in the database or the audit log can answer the question.

**Evidence.**

```
lib/checklists.ts:315 `const patch: Record<string, unknown> = { status: r.status, updated_at: new Date().toISOString() };` — contrast lib/checklists.ts:192-196 which sets `updated_by: input.actor.uid` and `updated_by_name`. supabase/migrations/20261013:166-167 `updated_by UUID,` / `updated_by_name TEXT`. lib/checklists.ts:321-323 — the audit details object. The UI's only actor display is gated on a manual note (components/projects/QualityTab.tsx:450-454 `{item.manualNote && ... Human decision{item.updatedByName ...}}`), so an auto-satisfied item shows no actor on screen either.
```

**Chain reaction.** SAF-2's remediation asks for item ids in the audit row for the *assessment* path only; the auto-evidence path is not covered there. PERF-7 notes the per-row errors are swallowed with a bare `continue` (lib/checklists.ts:318) — so the announced `satisfied` count can also exceed or undercount what was actually written, and there is no per-item record to reconcile against. Once finding 2's cascade runs, even the aggregate rows go.

> **Verifier correction.** Downgrade HIGH→MEDIUM and correct one factual overstatement. The finding says updated_by_name "keeps whatever human last touched the item" — that stale-attribution case is practically unreachable through the UI: every human override path in QualityTab (`override()` at :425-437) is called with a non-null promptNote by all three buttons (Mark satisfied / N/A / Reopen), so every human touch sets manual_note, and applyAutoEvidence:141 then permanently excludes that item from all future sweeps. The realistic state of an auto-satisfied row is therefore updated_by/updated_by_name = NULL — no actor, not a misattributed one. Reconstruction is also degraded rather than impossible: the CHECKLIST_AUTO_EVIDENCE audit row does carry the sweep runner's uid/email, the checklistId and a timestamp that matches the row's updated_at.

**Done when.**

- [ ] `runAutoEvidence` and `applyAssessment` stamp `updated_by`/`updated_by_name` with a distinguishable machine actor, not the calling human and not a stale value.
- [ ] The audit row records the item ids changed, their prior and new status, and the citation attached.
- [ ] A checklist item row (or a companion event row) can answer "who set this status, when, on what basis" without joining aggregate counts.
- [ ] The UI labels an auto-satisfied item as machine-verified, separately from a human decision.

---

<a id="qual-7"></a>

## QUAL-7 · Closing a punch item records an actor nobody can read, and a punch item carries no location, description or verification — the closeout snag list is a list of strings

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/turnover.ts:263-280`, `lib/turnover.ts:106-119`, `lib/turnover.ts:41-52`, `components/projects/QualityTab.tsx:685-701`, `supabase/migrations/20261013_project_controls_program.sql:191-204`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The data-model half is exactly right — a punch item is title + due date + status, and closed_by is a write-only orphan. The 'actor nobody can read' half is overstated: audit_logs records PUNCH_STATUS with the actor's email, item title and timestamp, and that trail is rendered in the project evidence pack (evidencePack.ts:193-194, 227-228), so who closed an item is recoverable.

**Mechanism.** `setPunchStatus` writes `closed_at` and `closed_by`:

```ts
if (input.status === "done" || input.status === "void") {
  row.closed_at = new Date().toISOString();
  row.closed_by = input.actor.uid;
}
```

but `punch_items` has no `closed_by_name` (contrast `created_by_name` at migration :203, and `checkout_episodes`, which carries both `closed_by` and `closed_by_name`), and `mapPunch` never maps `closed_by` at all — the `PunchItem` interface has no such field. A repo-wide grep for `closed_by` across `**/*.ts,tsx` returns the write in lib/turnover.ts, an unrelated `workPackages.ts` write, and the `checkoutEpisodes` mapper; nothing reads `punch_items.closed_by`. `closedAt` *is* mapped (:115) but the UI never renders it — the punch row shows title, due date and `createdByName` only.

The row itself is thin: `title`, `status`, `due_date`, `party_id`, and nothing else. No description, no equipment tag or location, no photo, no re-inspection record, no evidence of the fix.

**Failure scenario.** A regulator or an incoming shift asks who verified that "Reinstall insulation at E-301 north nozzle" was actually reinstalled, and what was done. The screen shows a struck-through line with the *creator's* name. The database holds a `closed_by` uuid no code path resolves to a name and no surface displays. The only other trace is a `PUNCH_STATUS` audit row, which per SAF-6 never reaches the project's Activity tab, and which per finding 2 is destroyed with the project. There is no record of what the fix was, who inspected it, or against what.

**Evidence.**

```
lib/turnover.ts:269 `row.closed_by = input.actor.uid;`. lib/turnover.ts:106-119 `mapPunch` — maps `closed_at` but not `closed_by`; lib/turnover.ts:41-52 `interface PunchItem` — no `closedBy` field. supabase/migrations/20261013:191-204 — the full `punch_items` DDL; `created_by_name TEXT` present, no `closed_by_name`. components/projects/QualityTab.tsx:687-693 renders `it.title`, `it.dueDate`, `it.createdByName` — `closedAt` is used only for the strikethrough class.
```

**Chain reaction.** SAF-4 covers the *reason* gap on punch-void (one unlabeled click, no prompt). This is the complementary attribution gap on both `done` and `void`: even where a reason existed, the closer's identity is unreadable. Together they mean the punch list — the surface the closeout gate counts and the contractor scorecard divides by (`punchClosed / punchTotal`, lib/companies.ts / lib/companyScore.ts:96-99) — cannot evidence a single closure.

> **Verifier correction.** One evidence line is wrong and should be dropped: the finding says "closedAt is used only for the strikethrough class". It is not — QualityTab.tsx:685-687 derives both the strikethrough and the opacity from `it.status !== "open"`, and `closedAt` appears nowhere in the component. The mapped closedAt is entirely unrendered, which makes the point stronger, not weaker.

**Done when.**

- [ ] `punch_items` carries `closed_by_name` and `mapPunch` exposes it; the UI shows who closed each item and when.
- [ ] A punch item can record what the snag is beyond a one-line title (location/tag, description) and what evidence closed it.
- [ ] Closing a punch item is distinguishable from voiding one in the rendered record, not only by dot colour.

---

<a id="qual-8"></a>

## QUAL-8 · The checklist completion gate is computed from a read whose error is discarded, so a policy denial or a missing migration lets an entirely unverified checklist be marked complete

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/checklists.ts:102-106`, `lib/checklists.ts:214-231`, `lib/checklists.ts:218-224`, `app/(protected)/projects/[id]/page.tsx:192-200`, `components/projects/QualityTab.tsx:335-341`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The fail-open mechanism is real, but neither cited trigger is reachable. Losing Admin/DocCtrl removes the WRITE, not the SELECT — the status update would fail, not the gate. And if 20261013 were unapplied, project_checklists would not exist either, so there would be no checklist to complete. What actually survives is a transient/network error on the item read silently passing the gate.

**Mechanism.** The only gate on completing a checklist reads its items through `listChecklistItems`, which discards the error:

```ts
export async function listChecklistItems(checklistId: string): Promise<ChecklistItem[]> {
  const { data } = await supabase.from("checklist_items").select("*")
    .eq("checklist_id", checklistId).order("seq", { ascending: true }).limit(600);
  return (((data ?? []) as Array<Record<string, unknown>>)).map(mapItem);
}
```

On any failure — RLS denial, missing table, network — `data` is null and the function returns `[]`. `setChecklistStatus` then computes `blocking` over an empty array, `blocking.length === 0`, and the status write proceeds:

```ts
const items = await listChecklistItems(input.checklist.id);
const blocking = items.filter((i) => i.applicability !== "na" && i.status !== "satisfied" && i.status !== "na");
if (blocking.length > 0) { return { ok: false, error: ... }; }
```

The gate fails **open**: an empty read is indistinguishable from "every item is green." The same shape sits behind the project closeout dialog — `gatherProjectSnapshot(...).catch(() => undefined)` leaves `gates` at `null`, and the gate panel is rendered only `{pendingStatus === "completed" && gates && ...}`, so a failed snapshot makes the four closeout gates vanish silently while the Confirm button (disabled only on `transitionBusy`) stays live.

**Failure scenario.** A member whose role loses Admin/DocCtrl mid-session (or a deployment where 20261013 has not been applied to a replica) opens a 120-item PSSR with 60 open items and clicks "Mark complete." `listChecklistItems` returns `[]` because the SELECT was denied; the gate passes; `project_checklists.status` is set to `complete`. The card renders the emerald "complete" badge with the shield icon. The checklist then counts as MI-complete for the auto-evidence rule above, and disappears from `gatherProjectSnapshot`'s open-checklist scan (lib/projectSnapshot.ts:77), so the closeout gate reads "Checklists clear." On the closeout dialog itself, a snapshot failure removes the gate list entirely — the operator sees no gates rather than failing gates, and confirms.

**Evidence.**

```
lib/checklists.ts:103 — `const { data } = await supabase...` with no `error` destructured. lib/checklists.ts:219-223 — the blocking computation and its early return. app/(protected)/projects/[id]/page.tsx:195-196 `void gatherProjectSnapshot(project.orgId, projectId).then((s) => { if (!cancelled) setGates(s); }).catch(() => undefined);`. app/(protected)/projects/[id]/page.tsx:627 `{pendingStatus === "completed" && gates && (() => {`. Note the write itself is *also* unchecked for zero rows (SAF-3), so a denied write reports success — but that is a different failure than the gate evaluating to "nothing blocks" on live data it never saw.
```

**Chain reaction.** Root cause is UX-10 in audit-reports/projects-tab/07-interface-truth.md, which reports the swallowed error as a ux/diagnosability problem ("No checklists yet" instead of "failed to load"). It does not report that one of those swallowed reads is load-bearing for a safety gate. REL-6 item 5 asks for exactly this test on `gatherProjectSnapshot` and has not been done. SAF-14 covers the *override* leaving no trace; this is the gate not being evaluated at all.

> **Verifier correction.** Both named triggers are refuted, which is why this drops to MEDIUM/SUSPECTED. (a) "Policy denial": there is no user who can write project_checklists but cannot read checklist_items. Both write disjuncts require active org membership — is_org_controller (20260814_documents_delete_controllers.sql:31-40) and user_owns_project (20261013:57-65, `JOIN org_members m ON … m.status = 'active'`) — and the generated member_read policy (20261013:253-259) grants SELECT to exactly that population. (b) "Missing migration": project_checklists and checklist_items ship in the same migration, so if the items table is absent the status UPDATE at :225 also errors, and that error IS checked and returned. The residual real window is a transient read failure (supabase-js resolves fetch failures as {error}) between a successful earlier load and a subsequent successful write, plus the general fragility of a gate that fails open. The closeout half is weaker still: gatherProjectSnapshot wraps every query in its own `safe()` (projectSnapshot.ts:15-17), so it effectively cannot reject and the `.catch(() => undefined)` is near-dead; and per finding 11 those gates are advisory by design, so their absence blocks nothing that would otherwise have been blocked.

**Done when.**

- [ ] `listChecklistItems` returns a distinguishable error, and `setChecklistStatus` refuses to complete when the item read failed.
- [ ] A checklist with zero items cannot be marked complete (today it passes the gate vacuously).
- [ ] The closeout dialog renders an explicit "gates could not be loaded" state and blocks Confirm, instead of omitting the panel.
- [ ] A test asserts: item read errors ⇒ `setChecklistStatus('complete')` returns `ok: false`.

---

<a id="qual-9"></a>

## QUAL-9 · The coach tells the project owner that closeout is gated on turnover acceptance; it is not, and the gates are explicitly advisory

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/projectHealth.ts:228-233`, `lib/projectHealth.ts:231`, `app/(protected)/projects/[id]/page.tsx:625-651`, `app/(protected)/projects/[id]/page.tsx:645-650`, `components/projects/QualityTab.tsx:14-17`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The copy claim is accurate — the coach asserts a gate that does not exist and Confirm is never blocked. But the confirmation dialog states the true position in plain language at the exact moment of decision, so nobody reaches 'Complete' still believing the system will stop them; this is misleading marketing copy, not an operative deception.

**Mechanism.** The coach item that the project page surfaces states a hard gate as fact:

```ts
if (s.turnoverRequired > 0 && s.turnoverAccepted < s.turnoverRequired) add({
  id: "turnover", kind: "quality", weight: 68,
  title: `Chase the turnover package — ${...} item${...} outstanding`,
  payoff: "Closeout is gated on acceptance; contractors are scored on it.",
```

Neither half is true. The closeout gates are warnings by construction — the code comment says so (`Warnings, not walls: the owner can complete anyway, on the record.`), the UI says so (`You can complete anyway — the open items stay on the record and in the report.`), and `transitionProjectStatus` (lib/projects.ts:259-276) queries no quality table before setting `status: 'completed'`. And "contractors are scored on it" fails because the scorecard joins on `turnover_items.party_id`, which no interface ever sets (MON-7).

The QualityTab header carries the matching claim: "Acceptance rates score the contractor."

**Failure scenario.** A project owner reads "Closeout is gated on acceptance" and reasonably concludes the system will stop them if turnover is incomplete. It does not — Confirm is disabled only on `transitionBusy`. The project closes with four turnover items never delivered, and per SAF-14 the audit row preserves no snapshot of which gates were open. The owner's mental model of what the platform enforces is wrong in the direction that matters.

**Evidence.**

```
lib/projectHealth.ts:231 `payoff: "Closeout is gated on acceptance; contractors are scored on it.",`. app/(protected)/projects/[id]/page.tsx:625-626 — the comment `Warnings, not walls: the owner can complete anyway, on the record.`; :648 — `You can complete anyway …`. components/projects/QualityTab.tsx:17 `//   reviewer's name on the record. Acceptance rates score the contractor.`
```

**Chain reaction.** Same shape as the sidebar-badge "doorway" and the non-existent `push_subscriptions` cron the prior audits recorded: user-facing copy asserting a mechanism that was never built. drafting-flow/12-projects-boundary.md:187 documents that the gates are advisory and that `transitionProjectStatus` checks nothing; SAF-14 documents the missing gate snapshot. Neither reports that the coach actively tells the user the opposite.

**Done when.**

- [ ] The coach copy states what actually happens ("open turnover items will be recorded on the closeout, not blocked"), or the gate is made real.
- [ ] No UI string claims contractor scoring from turnover until MON-7 is fixed.
- [ ] A single source of truth describes gate strictness, referenced by both the coach text and the dialog.

---

<a id="qual-10"></a>

## QUAL-10 · The one-click project Compliance Evidence Pack — the artifact positioned as the answer to a regulator — contains no checklist, no checklist item, no turnover item and no punch item

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/evidencePack.ts:146-162`, `lib/evidencePack.ts:218-228`, `lib/evidencePack.ts:230`, `app/(protected)/projects/[id]/page.tsx:340-348`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The structural claim holds — the pack has no quality sections. But 'contains no turnover item and no punch item' is literally false: the audit-trail section carries TURNOVER_REVIEWED / CHECKLIST_* / PUNCH_* rows with item name, status, actor and date, and a sibling one-click Report covers the quality rollups.

**Mechanism.** `gatherProjectEvidence` issues exactly five queries: `projects`, `project_members`, `milestones`, `audit_logs` (filtered `resource_type='project'`), and `transmittals`. `renderProjectEvidenceHtml` renders four sections: Team & responsibilities, Schedule, Transmittals, Audit trail. There is no query and no section for `project_checklists`, `checklist_items`, `turnover_items` or `punch_items`.

The footer asserts completeness: *"Assembled from the project record, team, schedule, and immutable audit trail."* The quality program's audit rows do reach the audit-trail table (both `audit()` helpers write `resource_type: "project", resource_id: projectId` — lib/checklists.ts:88-92, lib/turnover.ts:122-126), so `CHECKLIST_AUTO_EVIDENCE`, `TURNOVER_REVIEWED` and `PUNCH_STATUS` appear as raw JSON in the last table. But per finding 3 those rows carry counts, not item-level verdicts, and the 1000-row limit truncates oldest-first behaviour on a busy project.

**Failure scenario.** An auditor asks for the compliance package on the Unit 300 repipe. The owner clicks "Evidence pack" and prints a PDF containing the team roster, the Gantt task list, the transmittal receipts, and a wall of audit JSON. The completed PSSR, the accepted turnover package with reviewer names and dates, and the closed punch list — the documents the auditor actually asked for — are not in it. There is no other export surface: `lib/exportTables.ts` includes the four tables in the admin data export, which is a raw table dump, not a compliance artifact.

**Evidence.**

```
lib/evidencePack.ts:147-154 — the five-query `Promise.all`. lib/evidencePack.ts:218-228 — the four `<h2>` sections. lib/evidencePack.ts:230 — the footer string. lib/evidencePack.ts:6-7 — the document-level pack's header states the promise: "This is the 'your exit story is one click' promise made concrete for auditors (ISO-9001 / PSM evidence)."
```

**Chain reaction.** EVID-10 in audit-reports/drafting-flow/10-audit-evidence.md audits the *document* pack for missing signatures, and its verifier note explicitly observes that "the sibling project-level pack does include receipts (gatherProjectEvidence queries transmittals)" — the project pack was examined for transmittals, not for quality records, so this gap is unreported. Compounded by SAF-6: the Activity tab cannot show these audit rows either, and by finding 2: after a project delete, even the audit rows are gone.

> **Verifier correction.** One detail is backwards: the audit query is `.order("timestamp", { ascending: true }).limit(1000)`, so on a busy project it keeps the OLDEST 1000 rows and drops the most RECENT — i.e. the closeout-era quality decisions are the first thing to fall off the pack, which is worse than the finding states, not milder.

**Done when.**

- [ ] The project evidence pack renders every checklist with its items, each item's status, applicability, evidence citations and the actor who decided it.
- [ ] It renders the turnover package with per-item status, reviewer name, review date and note, and the punch list with closure dates and actors.
- [ ] The footer names what the pack does and does not cover.
- [ ] Items satisfied by the automated sweep are visually distinguished from human decisions in the printed pack.

---

<a id="qual-11"></a>

## QUAL-11 · Turnover acceptance is terminal in the interface — an erroneously accepted quality package can never be reopened or revoked, and there is no nonconformance record despite the rubric naming one

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/projects/QualityTab.tsx:568-582`, `components/projects/QualityTab.tsx:573-575`, `lib/turnover.ts:190-212`, `lib/checklistEngine.ts:176`, `lib/turnover.ts:223-234`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by repo-wide search: no reopen/revoke path, no 'acceptance withdrawn' field, no audit action for one, and no nonconformance record anywhere despite the rubric scoring contractors on having an NCR process. Severity MEDIUM is right.

**Mechanism.** The action buttons are rendered per current status and there is no branch for `accepted` or `waived`:

```tsx
{it.status === "open" && (<button ...>Received</button>)}
{(it.status === "received" || it.status === "rejected") && (<button ...>Accept</button>)}
{it.status === "received" && (<button ...>Reject</button>)}
{(it.status === "open" || it.status === "received") && (<button ...>Waive</button>)}
```

An `accepted` or `waived` row renders no controls at all. `reviewTurnoverItem` itself accepts any status, so the data layer permits reversal — only the UI is one-way. There is no "revoke acceptance" action, no audit action name for one, and no field recording that an acceptance was later withdrawn.

Rejection is also non-durable: a `rejected` item accepted later overwrites `reviewed_at`, `reviewed_by`, `reviewed_by_name` and `review_note` in place, so the rejection and its reason are erased from the row (they survive only in the `TURNOVER_REVIEWED` audit row, which SAF-6 shows no project surface reads). And nothing anywhere models a nonconformance: `QUALITY_MANUAL_RUBRIC` lists `{ key: "ncr", label: "Nonconformance handling", hint: "NCR process, disposition, corrective action" }` as something contractors are scored on, while the platform holds no NCR record of its own.

**Failure scenario.** A reviewer accepts "Material certs (MTRs)" and afterwards finds the heat numbers do not trace to what was installed — a B31.3 material-traceability failure. There is no way to undo the acceptance in the app. The turnover progress keeps counting it toward `accepted`, the closeout gate keeps reading "Turnover package fully accepted", and `computeTurnoverProgress` keeps it out of `outstanding`. The only remedy is a direct database write. Separately, the first rejection's reason — the record of what was wrong — is overwritten the moment the resubmission is accepted.

**Evidence.**

```
components/projects/QualityTab.tsx:570-582 — the four conditional buttons; no condition matches `accepted` or `waived`. lib/turnover.ts:198-205 — the update row rebuilds `reviewed_*` and `review_note` on each decision with no history. lib/turnover.ts:225 `const accepted = req.filter((i) => i.status === "accepted" || i.status === "waived").length;`. lib/checklistEngine.ts:176 — the NCR rubric area.
```

**Chain reaction.** SAF-4 covers the *entry* into `waived`/`accepted` being too cheap (blank reasons, waive available on never-delivered items). This is the exit: once in, there is no way out and no nonconformance trail. Together they make turnover status a ratchet toward green.

> **Verifier correction.** Strike the parenthetical "the TURNOVER_REVIEWED audit row, which SAF-6 shows no project surface reads" — it contradicts finding 8 in this same batch and the code. lib/evidencePack.ts:151 pulls audit_logs filtered to resource_type='project'/resource_id=projectId and :218-228 renders every row's action, actor and details JSON in the Audit trail section, and turnover.ts:208-210 stamps TURNOVER_REVIEWED with exactly those keys plus `{ itemId, name, status, note }`. The overwritten rejection reason therefore IS recoverable from the project Evidence Pack; what is lost is the row-level record and any in-app surface, and the erasure remains undisclosed at the point of the accept click.

**Done when.**

- [ ] An accepted or waived turnover item can be reopened, with a required reason, and the reversal is recorded and audited.
- [ ] A rejection's reviewer, date and note are preserved when the item is later accepted (a review history, not an overwrite).
- [ ] A rejected turnover item produces a nonconformance record the contractor's scorecard and the project report can both read.

---

<a id="qual-12"></a>

## QUAL-12 · checklist_items.org_id is caller-supplied and its WITH CHECK never ties it to the parent checklist, so a project owner can stamp quality rows with another workspace's org id

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20261013_project_controls_program.sql:272-278`, `supabase/migrations/20261013_project_controls_program.sql:250-260`, `lib/checklists.ts:130-134`, `supabase/migrations/20261013_project_controls_program.sql:153-155`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Correct as written, and worse than stated: lib/exportTables.ts:104 lists checklist_items among ORG_SCOPED_TABLES 'dumped by org_id', so injected rows would be pulled into workspace B's backup. In-app exposure is narrower than the summary implies — listChecklistItems (checklists.ts:103-104) and projectSnapshot.ts:80-82 both query by checklist_id, never by org_id, so org B's UI would not surface them.

**Mechanism.** `checklist_items` carries `org_id` but no `project_id`; the write policy authorizes on the *parent checklist*, and the `org_id` being written is never compared to it:

```sql
CREATE POLICY checklist_items_write ON checklist_items FOR ALL
  USING (is_org_controller(org_id) OR EXISTS (
    SELECT 1 FROM project_checklists c WHERE c.id = checklist_items.checklist_id AND user_owns_project(c.project_id)))
  WITH CHECK (is_org_controller(org_id) OR EXISTS (
    SELECT 1 FROM project_checklists c WHERE c.id = checklist_items.checklist_id AND user_owns_project(c.project_id)));
```

The `EXISTS` disjunct is satisfied purely by owning the checklist's project, so any `org_id` value passes the check. The read policy on the same table keys on that column alone (`m.org_id = checklist_items.org_id`), so the injected rows become readable by the *foreign* org's active members. The application never validates the pairing either — `createChecklist` writes `org_id: input.orgId` into the item rows (lib/checklists.ts:131) taken straight from its caller, with no comparison against the checklist header it just inserted.

**Failure scenario.** A project owner in workspace A inserts `checklist_items` rows against their own checklist while setting `org_id` to workspace B's id. The rows satisfy `checklist_items_write` (they own the parent project) and thereafter satisfy `checklist_items_member_read` for every active member of workspace B. Workspace B's users can read attacker-authored text — item wording, evidence labels, manual notes — attributed to their own org, and workspace B's admin data export (`lib/exportTables.ts:104` dumps `checklist_items` by org) collects them into B's compliance export. Conversely, quality rows can be moved *out* of an org's own read scope by stamping a foreign id, hiding them from that org's members while leaving them attached to a checklist the UI still lists.

**Evidence.**

```
supabase/migrations/20261013:273-277 — the policy text quoted above; the `org_id` in the `EXISTS` disjunct is never referenced. supabase/migrations/20261013:256 — the generated read policy `... WHERE m.org_id = checklist_items.org_id AND m.uid = auth.uid() AND m.status = 'active'`. supabase/migrations/20261013:153-155 — the DDL: `org_id UUID NOT NULL REFERENCES orgs(id)`, `checklist_id UUID NOT NULL REFERENCES project_checklists(id)`, with no constraint or trigger relating the two. A second-shape grep across `supabase/migrations/*.sql` for `checklist_items` outside 20261013 returns no additional policy, trigger or constraint.
```

**Chain reaction.** A variant of the RLS-composition weakness the prior audits recorded on tickets, notifications, email_notifications and project_documents: here the `WITH CHECK` exists but validates the wrong column. The three sibling tables (`project_checklists`, `turnover_items`, `punch_items`) all carry `project_id` and are checked against `user_owns_project(project_id)`, so this gap is specific to the one table that has no `project_id`.

> **Verifier correction.** Scope the impact honestly: this permits cross-tenant WRITE/pollution, not cross-tenant READ. The foreign org's members can only surface the injected rows via an org-scoped scan (the data export above), not through the Quality tab, which loads items by checklist_id from checklists it already owns. It is also not reachable through the app UI — orgId always comes from the active org context — so it requires a deliberate direct PostgREST call by an authenticated project owner.

**Done when.**

- [ ] `checklist_items`' `WITH CHECK` requires `org_id` to equal the parent `project_checklists.org_id` (or the column is dropped and org derived by join).
- [ ] `createChecklist` derives the item rows' `org_id` from the header row it just inserted rather than from its caller.
- [ ] A test or policy fixture pins that an item cannot be written with an `org_id` differing from its checklist's.

---

<a id="qual-13"></a>

## QUAL-13 · turnover_items.document_id is a dead foreign key: the accepted turnover record never points at the document that was accepted, and the evidence gather's turnover-document branch is permanently empty

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/turnover.ts:190-212`, `lib/turnover.ts:199`, `components/projects/QualityTab.tsx:518-534`, `components/projects/QualityTab.tsx:531`, `lib/checklists.ts:266-282`, `supabase/migrations/20261013_project_controls_program.sql:181`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by repo-wide search — no UI or server path anywhere attaches a document to a turnover item, so the FK at 20261013…:181 is dead and the evidence gather's turnover-document branch is structurally empty. The other read of turnover_items (QuotesPanel.tsx:577) selects only `name`.

**Mechanism.** `reviewTurnoverItem` accepts an optional `documentId` and writes it:

```ts
if (input.documentId !== undefined) row.document_id = input.documentId;
```

Its only caller in the repo never supplies one:

```ts
const res = await reviewTurnoverItem({ item, status, note, actor });
```

`seedTurnoverItems` (:148-155) and `addTurnoverItem` (:172-178) likewise omit the column. So `turnover_items.document_id` is NULL on every row the application creates, and there is no UI anywhere to attach a document to a turnover item.

That makes a second block dead as well. `gatherProjectEvidenceState` builds part of the auto-evidence document register from turnover attachments:

```ts
const turnoverDocs = await safe(
  supabase.from("turnover_items").select("document_id").eq("project_id", projectId).not("document_id", "is", null).limit(300) ...);
extraDocIds.push(...turnoverDocs.map((t) => t.document_id));
```

That query can only ever return zero rows, so the evidence register is reduced to the intake collection plus `sow_document_id` — i.e. exclusively the unreviewed contractor-uploaded folder that SAF-1 identifies as the false-green source, with the one legitimate curated channel switched off.

**Failure scenario.** QA/QC accepts the "NDE reports" turnover item after reading a 40-page package. The row records `status: accepted`, `reviewed_by_name: 'jchen'`, `reviewed_at`, and a note — and nothing that identifies which document was reviewed. Six months later the NDE package is superseded or three candidate files exist in the folder; nobody can establish which one `jchen` accepted. Meanwhile the checklist engine, which was designed to cite accepted turnover documents as proof, cites only intake-folder titles instead.

**Evidence.**

```
lib/turnover.ts:199 — the only assignment to `row.document_id`. Two differently-shaped searches confirm no caller reaches it: (a) grep for `reviewTurnoverItem` across `**/*.ts,tsx` returns exactly three hits — the definition (lib/turnover.ts:190), the import (QualityTab.tsx:36) and the call (QualityTab.tsx:531), which passes `{ item, status, note, actor }`; (b) grep for `turnover_items` across app/, lib/, components/, scripts/ returns every reference to the table — the two INSERTs (lib/turnover.ts:157, :172) list their columns explicitly and neither includes `document_id`, and the only other writes are the UPDATE at :206. lib/checklists.ts:270 — the `.not("document_id", "is", null)` filter that can never match.
```

**Chain reaction.** Same dead-FK shape the prior audits recorded for `checkout_sessions.linked_ticket_id`, `projects.linked_ticket_id` and `document_versions.related_ticket_id`. Distinct from MON-7 (audit-reports/projects-tab/03-money-ledger.md), which covers the *other* never-written column on the same table, `party_id`, and its effect on the company scorecard. Fixing this also gives SAF-1's remediation a curated, reviewed evidence channel to prefer over intake titles.

> **Verifier correction.** Two small precisions: the finding's grep count for reviewTurnoverItem is right but it overlooked a second seedTurnoverItems caller (components/projects/ProjectWizard.tsx:199) — harmless, since that call also omits the column (and omits partyId, which matters for finding 11). And document_id is not unwritable in absolute terms: lib/dataRestore.ts:326 restores turnover_items generically, so a backup could carry values. For rows the application creates, it is always NULL.

**Done when.**

- [ ] The turnover review UI requires (or at minimum offers) selecting the submitted document, and stores its id.
- [ ] The turnover row renders a link to the document and revision that was accepted.
- [ ] The auto-evidence register prefers documents attached to *accepted* turnover items over raw intake-folder titles.
- [ ] `document_id` is either written by the normal workflow or the column and its query branch are removed.

---
