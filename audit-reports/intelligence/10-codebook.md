# 10 · The Site Codebook — the plant's decoder

**10 findings** — 1 HIGH · 9 MEDIUM.

Load-bearing for the Bridge, the graph and the flows reader. A defect here propagates everywhere.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| The pure-codec / data-access split, and the honest-degradation contract. Everything under "PURE CODEC" is side-effect free and separately testable; loadCodebook and loadCodebookAdmin both swallow a missing migration into EMPTY_CODEBOOK, and every codec function returns null rather than guessing when the book cannot place an input. | `lib/codebook.ts:108-261, lib/codebook.ts:322-346, lib/codebookServer.ts:8-36` | This is the reason the app genuinely works with no codebook at all, and it is what made this audit possible — I could execute the codec standalone. Every fix proposed above should stay inside this split: keep new validation pure and testable, and never let a codec function start guessing. |
| codebookToDecoderText — renders the codebook into the exact line format the drawing-text decoder parsers already consume ("20 = Crude Unit", "E- = Exchangers"), so knowledge libraries with no decoder of their own inherit the site's language with zero changes to the parsing layer. | `lib/codebookServer.ts:38-49, consumed at app/api/knowledge/ask/route.ts:144-145 and app/api/knowledge/drawing/route.ts:136` | This is the cleanest piece of wiring in the whole intelligence layer and the model for how the codebook should reach other subsystems — one adapter, no duplicated parsing. It is also the answer to "how wired can we make this": the same pattern would let the codebook reach the flows reader and the graph. |
| diffImport — AI proposals are diffed against the existing codebook and nothing is written until the user checks rows; blanks and model duplicates are dropped, prefix-set changes are order-insensitive, and the whole thing is pure with test coverage. | `lib/codebook.ts:283-303, tests at lib/__tests__/codebook.test.ts:161-192, applied at app/(protected)/admin/codebook/page.tsx:680-701` | The review-before-apply spine is correct and must be preserved — the missing piece is only shape validation of the codes themselves, which belongs inside this same pure function rather than bolted on elsewhere. |
| The author's own NOTE documenting the RLS headline-role hazard, and the server-side route that fixes it for one field with a loud affected-row check. | `lib/codebook.ts:382-387 (the note), app/api/area/knowledge-status/route.ts:283-315 (the pattern: loadPrincipal → isController → update → `.select("id")` → 500 if zero rows)` | The correct pattern for every codebook write already exists in this repo, complete with the "a denied write is a loud 403, never a green no-op" comment. Fixing the remaining client-side writes is applying an existing local pattern, not inventing one. |
| The unknownUnits landing bucket — assets whose unit_code is not in the codebook still get a card, with the explicit comment "an asset must never be invisible from the front door". | `app/(protected)/admin/assets/page.tsx:238-247` | This is the right instinct and must not be removed while fixing the mis-decode findings; it is the safety net that keeps mis-filed assets reachable. It should gain a warning affordance ("this area is not in the Site Codebook — fix or remap") rather than being replaced. |
| The unit-vote decode on the assets page, which validates a parsed unit against the codebook before suggesting it, and never overwrites a unit the user already picked. | `app/(protected)/admin/assets/page.tsx:985-1010 (`if (book.units.some((u) => u.code === topCode))` and `if (!next.has(assetId)) next.set(...)`)` | This is the exact guard the Bridge is missing. It is already written, already correct, and can be lifted verbatim into lib/equipmentBridgeServer.ts:96-100. |
| The Bridge's additive-only, idempotent apply: the document's equipment column is merged by array-union so a human-typed tag is never removed, discovery races resolve to the winner's row, per-tag failures never sink the batch, and unit backfill only touches rows whose unit_code IS NULL. | `lib/equipmentBridgeServer.ts:236-276, 217-233` | The write-side safety of the Bridge is sound; the defects are all upstream in what it decides to write. Fixes should target the locate step, not this machinery. |
| The governed AI leg on the codebook import route — caller's own key, provider allowlist, signed acceptable-use agreement, monthly spend cap, metering on both success and failure, bounded input, bounded output, hard timeout, and a last-line binary-content guard so a user's key is never spent on garbage. | `app/api/codebook/import/route.ts:67-163, 356-364` | This is the strongest governance contract in the codebase and the template every other AI route should match (app/api/flows/read/route.ts:110-135 already reimplements it inline, noting governedAiCall cannot carry images yet — that gap is worth closing centrally). |


### Consumed by I-13: the codec and registry contract (2026-09-30, intelligence Round G)

I-13 (GAP-305 unit identity, graph assembly) lands after this package and reads these exported names:
- from `lib/codebook.ts`: `tagKey`, `normalizeTag`, `splitTag`, `typeForTag`, `typeCandidatesForTag`, `tagToCode`, `codeToTag` / `DecodedSiteCode`, `siteCodeCollisions`, `codeProblem` / `isValidCode`, `prefixClaimsElsewhere`, `codebookProblems`, `parseDrawingNumber`, `explainDrawingNumberMiss`, `loadCodebook` (`loadCodebookAdmin` in `lib/codebookServer.ts` is unchanged);
- from `lib/assetCategorize.ts`: `planIdentityReview`, `codeUnitConflict`, `sharedSiteCodes`;
- from `lib/assets.ts`: `listAssetIdentities`.

Four contract changes a consumer must know about:
1. `codeToTag` now returns `DecodedSiteCode`, `{ tag: string | null, unitCode, typeCode, candidates: string[], ambiguous: boolean }`. It used to return `{ tag: string, unitCode, typeCode }`. For a type registered with several prefixes (Vessels: V, D), `tag` is null and `ambiguous` is true (`CB-10`), while `unitCode` is certain either way. Read the unit from it; never treat `.tag` as a string.
2. `typeForTag` returns null when two equipment types claim the tag's prefix. It used to return the first by sort order (`CB-8`). `typeCandidatesForTag` names the contenders. Such a tag is untyped, and `tagToCode` declines it too.
3. `tagToCode` returns null for a letter unit or equipment-type code (`CB-3`), so a legacy letter-coded unit derives no site code.
4. `normalizeTag` in `lib/assets.ts` (and in `lib/documentTags.ts`) is now `export const normalizeTag = tagKey`: a re-export of the one grammar instead of its own function declaration. The key it computes is unchanged, but the binding is a `const`, which is not hoisted. The `normalizeTag` in `lib/codebook.ts` is still the display spelling the codec parses, and it is not an identity key (`GAP-310`).

**Verification fix (2026-09-30, intelligence Round G).** This note is new. Before it, no record named the exports I-13 consumes or these four changes.

---


<a id="cb-1"></a>

## CB-1 · The Bridge decodes an operating unit out of arbitrary filenames and never checks the unit exists — mis-filed assets are written permanently

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/equipmentBridgeServer.ts:93-100`, `lib/equipmentBridgeServer.ts:117`, `lib/equipmentBridgeServer.ts:211-212`, `lib/codebook.ts:227-233`, `components/documents/EquipmentSweepModal.tsx:239-250`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The mechanism is real and I re-derived the decode by hand against the repo's own fixture (codebook.test.ts:37-43 segments unit(2)/drawing_type(2)/size(1)/iterable/sheet): "2024-VESSEL-LIST.PDF" yields unitCode "20", size "V", then the iterable finds no digits and returns early — so a filename becomes an operating unit, unvalidated. Severity is overstated at HIGH: it is a data-quality defect with no attacker, it needs a configured drawing-number decoder AND a document whose document_number fails to parse, and "permanently" is wrong — admin/assets/page.tsx:1307 and :1383 (`unit_code: unitCode || null`) let a human re-file any asset, and page.tsx:240-244 surfaces phantom units in the unknownUnits bucket rather than hiding them.

**Mechanism.** computeForKnowledgeDoc builds `numberCandidates = [srcDoc.document_number, kdoc.name, srcDoc.title, srcDoc.name]` (line 93) and takes the FIRST candidate that yields a unitCode: `for (const cand of numberCandidates) { const parsed = parseDrawingNumber(cand, book); if (parsed?.unitCode) { unitCode = parsed.unitCode; break; } }` (96-99). Two compounding gaps: (a) parseDrawingNumber sets `out.unitCode = chunk` unconditionally and only looks up the LABEL — `out.unitLabel = book.units.find((u) => u.code === chunk)?.label ?? null` (codebook.ts:228-229) — so any 2-digit run parses as a unit whether or not the org defined it; (b) the Bridge never re-checks `book.units`. The candidate list includes raw filenames (`kdoc.name`) and titles, so an ordinary document name is decoded as a drawing number. The bogus value then wins over the library's explicitly configured default, because the fallback is guarded `if (!unitCode && bridge?.defaultUnitCode)` (line 100). It flows into `code: tagToCode(tag, unitCode, book)` (117) and is written to every discovered asset as `unit_code: s.unitCode` / `code: s.code` (211-212). The reviewer cannot catch it: the sweep modal renders only `s.tag` and `s.code` (EquipmentSweepModal.tsx:239-250) and the string 'unit' appears nowhere in a suggestion row — and since the decoded unit is not in the codebook, there is no label that would reveal the error.

**Failure scenario.** A P&ID PDF is indexed whose `document_number` is blank or non-numeric (e.g. "P-101-DWG"), so parseDrawingNumber returns null for it and the loop falls through to `kdoc.name`, the upload filename. I ran the verbatim codec against the repo's own test codebook: "2024-Vessel-List.pdf" → {unitCode:"20", unitLabel:"Crude Unit", drawingTypeCode:"24", size:"V"}; "1201 As-Built Markup.pdf" → {unitCode:"12", unitLabel:null}; "2015 Scan.pdf" → {unitCode:"20", drawingTypeLabel:"Piping Isometric"}. Every equipment tag on that sheet is now created with unit_code "12" and site code "1230.22", filed into an operating area that does not exist. On /admin/assets they surface in the `unknownUnits` bucket (page.tsx:240-247) as a phantom operating area rather than as an error, and nothing ever re-decodes them (see the frozen-identity finding).

**Evidence.**

```
lib/equipmentBridgeServer.ts:96-100 — `for (const cand of numberCandidates) { const parsed = parseDrawingNumber(cand, book); if (parsed?.unitCode) { unitCode = parsed.unitCode; break; } }` / `if (!unitCode && bridge?.defaultUnitCode) unitCode = bridge.defaultUnitCode;`. lib/codebook.ts:227-229 — `out.unitCode = chunk; out.unitLabel = book.units.find((u) => u.code === chunk)?.label ?? null;`. The repo validates this exact thing elsewhere: app/(protected)/admin/assets/page.tsx:1003 gates the same decode with `if (book.units.some((u) => u.code === topCode))` before suggesting a unit. The Bridge has no such guard.
```

**Chain reaction.** A wrong unit_code produces a wrong site code for every asset on the sheet; assetCategorize's unit filing (lib/assetCategorize.ts:51-55) then reads that code back and treats it as truth; lib/orgGraph.ts:255 draws `addEdge('asset:'+a.id, 'cbunit:'+a.unit_code, 'unit')` creating a phantom unit node in the org graph; and the operating-area asset lists (page.tsx:218, 263) never show the asset in the area it really belongs to.

> **Verifier correction.** Two corrections. (1) Line number: the mitigating guard is at app/(protected)/admin/assets/page.tsx:994, not :1003 (:1018 for the `code: r.asset.code ?? tagToCode(...)` cite is correct). (2) Severity CRITICAL → HIGH. Three conditions must coincide: the org must have configured a drawing-number segment map (parseDrawingNumber returns null at codebook.ts:193 with no config, so an unconfigured org is immune), the document_number must be absent or unparseable (it is candidate #1), and the filename's leading characters must satisfy the leading segments. The result is mis-filed derived metadata on discovered assets — bad, and effectively permanent given finding 3 — but it is not a safety-system or access-control break, and the wrongly-decoded unit is often an existing unit (mis-filing) rather than a phantom.

**Done when.**

- [ ] equipmentBridgeServer.ts rejects a parsed unitCode that is not present in `book.units` before using it (mirroring the guard already at admin/assets/page.tsx:1003)
- [ ] the candidate list is restricted to `document_number` (the only field that is contractually a drawing number), or filename-derived decodes are marked low-confidence and require review
- [ ] EquipmentSweepModal renders the decoded unit code AND its codebook label per document, with an explicit warning when the code is not in the codebook
- [ ] a test covers `computeForKnowledgeDoc` with a blank document_number and a filename like "2024-Vessel-List.pdf" and asserts unitCode is null (or the library default), not "20"

---

<a id="cb-2"></a>

## CB-2 · Any active org member can write or delete the Bridge's proposal and applied ledger

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** intelligence I-11 THE BRIDGE & THE MEMORY — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260928_site_codebook.sql:108-111`, `lib/equipmentBridgeServer.ts:175-180`, `lib/equipmentBridgeServer.ts:278-285`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The write/delete authority claim is exactly right — any active member, Viewer included, can rewrite or DELETE the proposal and the applied ledger, and applyForDocument trusts the row. One sub-claim in the summary is wrong: the automatic post-ingest path is NOT a clean trigger, because computeForKnowledgeDoc recomputes and upserts `suggested` at line 124 immediately before calling applyForDocument at :130, destroying the injection. The real vector is the confused deputy in app/api/equipment-bridge/route.ts:128-141, where a WRITER_ROLES user's Apply reads the poisoned row with no recompute.

**Mechanism.** The write policy on document_equipment_suggestions is `FOR ALL` with the plain membership predicate and no role gate at all: `USING (org_id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active'))` (migration:109-111). Compare the codebook's own tables three lines earlier, which do gate on `role IN ('Admin','DocCtrl')` (migration:68-69). The `applied` array is the Bridge's idempotence base — applyForDocument reads it at 175-180 and unions into it at 279-285 — and `suggested` is the payload the apply step trusts wholesale (`const suggested = (Array.isArray(row.suggested) ? row.suggested : [])`, line 179), including each row's `unitCode` and `code`, which are written straight onto created assets at 211-212.

**Failure scenario.** A Viewer-role member issues a direct PostgREST update against document_equipment_suggestions for a P&ID and rewrites `suggested` to add a tag with an arbitrary `unitCode` and `code`. The next apply — including the automatic post-ingest auto-apply path (equipmentBridgeServer.ts:128-133), which runs with `userId: null` and no further validation — creates registry assets from that payload and writes the tags into the controlled document's equipment column (272-275). Alternatively, clearing `applied` makes the Bridge re-suggest and re-apply tags a controller had already reviewed; setting status to 'applied' with an empty `applied` array makes a pending sweep disappear from the review queue.

**Evidence.**

```
supabase/migrations/20260928_site_codebook.sql:108-111 — `CREATE POLICY doc_equip_sugg_write ON document_equipment_suggestions FOR ALL USING (org_id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active')) WITH CHECK (...same...);` — no role predicate, in the same migration file whose codebook policies at 66-73 do carry one. lib/equipmentBridgeServer.ts:179 — `const suggested = (Array.isArray(row.suggested) ? row.suggested : []) as Array<BridgeSuggestion & { unitCode?: string | null }>;` — consumed without re-derivation or validation.
```

**Chain reaction.** The document's equipment column is doc-control data on a controlled drawing; the audit entry written at equipmentBridgeServer.ts:287-294 records the apply but not who authored the suggestion row it applied.

> **Verifier correction.** Two mitigations the finding did not weigh, which cap this at MEDIUM rather than making it a real escalation. (1) `assets` itself is member-writable under the identical shape of policy — supabase/migrations/20260605_rls_policies_new_tables.sql:26-31 `assets_member_all ... USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = assets.org_id AND uid = auth.uid() AND status = 'active'))`. A member who wants to inject a bogus asset can simply insert one; the suggestions table grants nothing new there. The genuinely novel reach is the write into documents.metadata that a writer's Apply performs (equipmentBridgeServer.ts:272-274). (2) It is not invisible: EquipmentSweepModal renders every suggested tag chip before the reviewer clicks Apply. The correct framing is 'this table follows the permissive registry convention rather than the codebook's controlled one', not 'a Viewer can silently write doc-control data'.

**Done when.**

- [ ] document_equipment_suggestions write is restricted to Admin/DocCtrl (additively, per the previous finding), or to the service role only
- [ ] applyForDocument re-derives `code` from the tag + unit through the codebook rather than trusting the stored `suggested` payload
- [ ] a test asserts a Viewer's direct write to document_equipment_suggestions is refused

**Partial (2026-09-30, intelligence Round G).** The authority half is closed: `20261128_intel_roundG_registry_authority.sql` makes `document_equipment_suggestions` writable by the service role and controllers only (`is_org_controller`, same policy name and shape as 20260928, line-diffed in `lib/__tests__/intelRoundGRegistry.test.ts`) — a Viewer can no longer author the `suggested` payload a writer's Apply trusts. With that, the confused-deputy vector the verifier named is gone (only a controller or the service role writes the row). Pending migration: `supabase/migrations/20261128_intel_roundG_registry_authority.sql`.

**Done-when.**
1. ✓ Write restricted (controller tier by collection, plus the service role).
2. ✗ Not done here — `applyForDocument` re-deriving `code` from tag + unit (`tagToCode(s.tag, s.unitCode, book)`) instead of trusting the stored payload is a change to `lib/equipmentBridgeServer.ts`, which I-11 owns (its CB-1 / BR-7 work re-derives the unit and the code on the same lines).
3. Proved by static census; runtime test pending. The policy census in `lib/__tests__/intelRoundGRegistry.test.ts` shows the only write policy is controller-only and that nothing later re-opens it, but no database runs in the suite, so no test refuses a Viewer's JWT at runtime. (Supplementary, not a repo test: in the review-fix pass `20261128` was applied to a scratch Postgres 16 with stubbed auth and role helpers; there a Viewer's and a Manager's asset DELETE affected 0 rows, an Admin's deleted the row and wrote `ASSET_DELETED`, and a Viewer's INSERT into `document_equipment_suggestions` was refused with 42501.)

**Scope / residual.** Limb 2 is handed to I-11 (`lib/equipmentBridgeServer.ts`). A runtime refusal test waits for a database in the test suite.

---

<a id="cb-3"></a>

## CB-3 · Codebook codes are unvalidated free text; a non-numeric code silently breaks the entire codec with no error anywhere

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/codebook/import/route.ts:143`, `lib/codebook.ts:348-358`, `app/(protected)/admin/codebook/page.tsx:193-201`, `app/(protected)/admin/assets/page.tsx:1712-1721`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Right on every point. The asymmetry is decisive: lib/codebook.ts:159 `return `${unitCode}${type.code}.${padded}${parts.suffix}`` happily emits "CU30.22", but codeToTag at :166 requires `/^(\d+)\.(\d+)([A-Za-z]{0,2})$/` and parseDrawingNumber at :225 requires `^\d{width}$`, so a non-numeric code is write-only — derivable, never invertible, and nothing raises.

**Mechanism.** The whole codec assumes codes are digits: parseDrawingNumber tests `new RegExp(`^\\d{${width}}$`)` (codebook.ts:225), tagToCode concatenates `${unitCode}${type.code}` (159), and codeToTag requires `^(\d+)\.(\d+)([A-Za-z]{0,2})$` (166). Nothing enforces it on the way in. The AI import cleaner filters only on LENGTH — `.filter((r) => r.code.length > 0 && r.code.length <= 6 && r.label.length > 0 && r.label.length <= 80)` (import/route.ts:143) — so "CU", "20A", "Crude" all pass. `upsertEntry` only trims (`code: entry.code.trim()`, codebook.ts:350). The manual EntryTable add gates on `draft.code.trim()` being non-empty and nothing more (page.tsx:194). AddUnitModal on the assets page checks only non-empty and not-already-used (assets/page.tsx:1713-1714). The DB CHECK constraint covers `kind` only (migration:19); `code TEXT NOT NULL` has no shape constraint (migration:20).

**Failure scenario.** An admin AI-imports a standard whose unit table reads "CU — Crude Unit" and accepts the row (or simply types "CU" in the Units tab). I ran the verbatim codec with unit code "CU": tagToCode("E-22","CU") returns "CU30.22" — a code that codeToTag can never invert (it returns null), that parseDrawingNumber can never produce from a drawing number, and that therefore can never be matched back to a unit. Assets get written with code "CU30.22", the Bridge's drawing-number decode can never assign them to unit "CU", and the drawing-numbers live preview silently shows "Doesn't match the segments" (page.tsx:409) without ever pointing at the real cause. No error is raised at any layer.

**Evidence.**

```
app/api/codebook/import/route.ts:143 — `.filter((r) => r.code.length > 0 && r.code.length <= 6 && r.label.length > 0 && r.label.length <= 80)`. lib/codebook.ts:350 — `org_id: orgId, kind: entry.kind, code: entry.code.trim(), label: entry.label.trim(),`. supabase/migrations/20260928_site_codebook.sql:19-20 — `kind TEXT NOT NULL CHECK (kind IN (...)), code TEXT NOT NULL` (no code check). Executed probe: `tagToCode('E-22','CU') = CU30.22   codeToTag(that) = null`. Note the contrast: the same import route DOES validate prefixes properly — `.filter((p) => /^[A-Z]{1,4}$/.test(p))` (line 140) — so the shape check was written for prefixes and simply omitted for codes.
```

**Chain reaction.** An AI-imported codebook is never validated before use — the diff/apply flow (codebook.ts:283-303, applyImport 404-415) checks only for blanks and duplicates, so the model's output becomes the plant's identity decoder with no shape gate. Every consumer then degrades to a silent null: no site codes, no unit filing, no auto-categorization, no drawing-number decode.

> **Verifier correction.** Severity HIGH → MEDIUM. This requires a user to type a non-numeric code, and the failure mode is degradation (no drawing-number decode for that unit, no unit back-filing from codes) rather than corruption or a wrong answer. Note the module header's promise that 'none of it is hard-coded' is what makes this a real gap — the codec quietly requires digits — but nothing observed breaks for the numeric conventions the product documents and tests.

**Done when.**

- [ ] a shared `isValidCode` guard rejects non-digit codes at every entry point: import/route.ts's cleaner, upsertEntry, EntryTable.add, and AddUnitModal/AddCategoryModal
- [ ] a DB CHECK constraint on codebook_entries.code enforces the digit shape
- [ ] the import review list visually flags proposed rows whose code fails the shape check and leaves them unchecked by default
- [ ] the drawing-numbers live preview names the reason when a parse fails ("unit code 'CU' is not numeric") rather than only "Doesn't match the segments"

**Resolution (2026-09-30, intelligence Round G).** Reproduced first: `tagToCode("E-22","CU")` minted `CU30.22`, which `codeToTag` cannot invert. One shared guard, `lib/codebook.ts` `codeProblem(kind, code)` / `isValidCode` — unit and equipment-type codes are 1–6 digits (leading zeros kept); drawing-type codes keep their free shape (the package decision, `DEC-53`) — at every door: the AI import route's cleaner tags a failing row with the reason (`app/api/codebook/import/route.ts`), `diffImport` puts it in a new `rejected` bucket, `upsertEntry` refuses before writing, the codebook page's `EntryTable.add` blocks it with the message, and the Operating Areas `AddUnitModal` / `AddCategoryModal` refuse it. The codec itself now declines to mint an undecodable identity (`tagToCode` returns null for a letter unit or type code). The database binds it (`20261128` §4) with the trigger `trg_codebook_entries_code_digits` (`codebook_entries_code_digits_guard`). It fires BEFORE INSERT OR UPDATE OF code, kind and raises 23514 only for a NEW letter code: an insert, or an edit that changes the code or kind. There is no CHECK: `20261128` always drops `codebook_entries_code_digits` if an earlier paste added one, NOT VALID or validated (`DROP CONSTRAINT IF EXISTS`, §4), and a probe confirms it is absent. The inventory counts the legacy letter codes, and nothing is rewritten.

*Review fix (2026-09-30).* The first version added the CHECK NOT VALID and ran `codeProblem` on the code a row already had. Postgres checks a NOT VALID CHECK on every UPDATE of a violating row, so a legacy letter-coded unit such as `CU` froze. Pinning a library (`saveUnitLinks`), binding its knowledge library (the service-role UPDATE in `POST /api/area/knowledge-status`) and relabelling it were all refused. This was reproduced on a scratch Postgres 16. Now `upsertEntry` runs `codeProblem` only for a new row or when the code changes, and the database refuses only a new code, so those meta-only writes land. The knowledge-status route (another package's file) needs no 23514 mapping, because a meta-only UPDATE can no longer raise it. Tests: `lib/__tests__/codebook.test.ts` ("CB-3"), `lib/__tests__/intelRoundGRegistry.test.ts` ("a LEGACY letter-coded unit stays editable", "CB-3 binds a NEW code only").

*Second review fix (2026-09-30).* The trigger raised on the service role too, and Postgres fires a BEFORE INSERT trigger ahead of the ON CONFLICT arbiter. The org restore's additive upsert (`ON CONFLICT (id) DO NOTHING`) of a legacy `CU` row therefore failed with 23514 even when the row already existed, and the restore stopped at `codebook_entries`, skipping every later table. The validated CHECK of the clean world refused the same restore of any backup taken before the org replaced its letter codes. Now `codebook_entries_code_digits_guard` passes the service role first (`IF auth.uid() IS NULL THEN RETURN NEW; END IF;`, the rule of the delete audit and the CB-5 guard), and there is no CHECK: `20261128` drops one an earlier paste added. Every code a person writes is still refused at the database (the app's writers are all browser-client; `upsertEntry` refuses before writing). Verified on a scratch Postgres 16: as the service role, the live `CU` row's `ON CONFLICT (id) DO NOTHING` re-insert and a fresh org's `CU` insert both pass; as a person, a new `CZ` and a `20`→`CY` change raise 23514, and a meta-only update of `CU` passes; a re-run over an earlier NOT VALID CHECK removes it. Tests: `lib/__tests__/intelRoundGRegistry.test.ts` ("CB-3 — an org restore holding a legacy letter-coded unit carries on", with the 23514 reproduction; "the service role passes the digit rule first thing"; "there is NO CHECK").

**Pending migration:** `supabase/migrations/20261128_intel_roundG_registry_authority.sql` (inventory row: non-numeric unit / equipment-type codes; a probe confirms the CHECK is absent).

**Verification fix (2026-09-30, intelligence Round G).** The Resolution above still described the first version's two worlds (a CHECK "added VALIDATED when no legacy row violates it" and "the inventory says which world you are in"). `20261128` has had no such branch since the second review fix: it always drops the CHECK, and there is no "after" inventory row for it. The Resolution sentence now says exactly that. No code changed for this finding.

**Done-when.**
1. ✓ The shared guard rejects non-digit codes at the import cleaner, upsertEntry, EntryTable.add, AddUnitModal and AddCategoryModal.
2. ✓ in substance, by a trigger rather than the CHECK the limb names (`DEC-53` (3)): the database refuses every new letter code a person writes (INSERT and code changes, from the moment of apply). A CHECK was built and removed in review: NOT VALID it froze the legacy rows, and validated it made any backup holding a letter code unrestorable. The service role's writes (the org restore) pass.
3. ✓ The import review list shows such rows flagged with the reason and they can never be checked or applied (stronger than "unchecked by default").
4. ✓ The live preview names the reason ("Segment 1 (unit) expects 2 digits but found "CU"", plus "Unit code "CU" is not numeric…" when the codebook holds one) — `explainDrawingNumberMiss`.

**Scope / residual.** Legacy letter codes (the inventory counts them) stay fully usable for everything except decoding: relabel, pinned libraries and knowledge binding all work. The codebook problems banner flags each one with the way out: add a digit code for the unit or type, refile its equipment there (the asset drawer, or the unassigned panel's bulk filer after clearing the unit), then remove the letter code. Removal is refused while anything still references it (CB-5). The code cannot be renamed in place: that needs the rename-with-cascade CB-5 leaves open. There is no CHECK to add once they are gone: the trigger is the rule.

---

<a id="cb-4"></a>

## CB-4 · Codebook write authority is headline-role-only while the rest of the intelligence stack is additive-role aware — a Manager who holds DocCtrl is locked out of the codebook but can still bind knowledge libraries

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260928_site_codebook.sql:66-73`, `app/(protected)/admin/codebook/page.tsx:35`, `app/(protected)/admin/codebook/page.tsx:49`, `lib/roleCapabilities.ts:74-84`, `lib/knowledgeAccess.ts:38-43`, `lib/codebook.ts:382-387`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The asymmetry is exactly as described and is even acknowledged by the code's own NOTE. Severity should drop to LOW: this fails CLOSED (a lockout, not an escalation), and there is no silent-no-op variant to worry about because every codebook write surface gates on the same headline value — admin/assets/page.tsx:251 `canEditLinks = activeRole === "Admin" || activeRole === "DocCtrl"` — so the UI hides the control rather than firing an update that affects zero rows.

**Mechanism.** org_members carries an additive `roles` array (supabase/migrations/20260722_member_roles_collection.sql) and a mirrored headline `role` set to the HIGHEST-RANKED role held (`primaryRole`, roleCapabilities.ts:121-123). ROLE_RANK puts Manager at 90, Supervisor 80, DraftingSupervisor 75 — all ABOVE DocCtrl at 70 (roleCapabilities.ts:74-84). The codebook RLS write policy tests only the headline column: `role IN ('Admin', 'DocCtrl')` (migration:68-69, 72-73), and the admin page's `canWrite` tests the headline too: `const WRITER_ROLES = new Set(["Admin", "DocCtrl"]); ... const canWrite = !!activeRole && WRITER_ROLES.has(activeRole);` (page.tsx:35, 49) where RoleContext documents activeRole as "the headline (highest-ranked) of these" (RoleContext.tsx:22-23). Meanwhile lib/knowledgeAccess.ts:38-43 computes controller status from the UNION: `const roles = new Set([member.role, ...(member.roles ?? [])]); isController: roles.has("Admin") || roles.has("DocCtrl")`.

**Failure scenario.** A member holds roles ['Manager','DocCtrl']. primaryRole resolves to 'Manager' (rank 90 > 70) and that is what is mirrored into org_members.role. On /admin/codebook they see the amber banner "Read-only — only Admins and Document Controllers edit the codebook" (page.tsx:83) and every write control is hidden — even though they hold DocCtrl. The same person calls POST /api/area/knowledge-status, which gates on `principal.isController` (route.ts:288-290) computed from the union, and successfully writes `meta.knowledgeLibraryId` into the very same codebook_entries row (route.ts:305-310). One authority model per surface, on the same table.

**Evidence.**

```
lib/roleCapabilities.ts:74-84 — `Admin: 100, Manager: 90, Supervisor: 80, DraftingSupervisor: 75, DocCtrl: 70,`. lib/roleCapabilities.ts:121-123 — `return [...roles].sort((a, b) => (ROLE_RANK[b] ?? 0) - (ROLE_RANK[a] ?? 0))[0];`. supabase/migrations/20260928_site_codebook.sql:68 — `... AND role IN ('Admin', 'DocCtrl')` (no `OR roles && ARRAY[...]`, unlike supabase/migrations/20260817_org_members_escalation_and_config.sql:26 which writes `role IN ('Admin','Manager') OR roles && ARRAY['Admin','Manager']::text[]` — the additive-aware pattern already exists in this codebase). lib/knowledgeAccess.ts:38-43 — the union form. The author knew: lib/codebook.ts:382-387 carries a NOTE saying "the codebook RLS write policy checks only the headline role column, so a client-side update could silently affect zero rows for a member whose DocCtrl authority lives in the additive roles[] array" — and routes exactly one field (knowledgeLibraryId) server-side, leaving upsertEntry, deleteEntry, saveConfig, saveUnitLinks and applyImport client-side against the same policy.
```

**Chain reaction.** Because upsertEntry uses `.update(row).eq("id", entry.id)` and only throws on `error` (codebook.ts:354-357), an RLS-refused UPDATE returns zero rows with no error — an edit that is blocked looks like it saved until the refresh. deleteEntry (360-363) has the same shape. Only the INSERT/upsert branch fails loudly (23505/42501, handled at assets/page.tsx:1806-1810).

**Done when.**

- [ ] the codebook RLS write policies are additive-role aware, matching the `role IN (...) OR roles && ARRAY[...]` pattern already used in 20260817_org_members_escalation_and_config.sql
- [ ] admin/codebook's canWrite uses the union (hasAnyRole) rather than activeRole, so UI and RLS agree
- [ ] upsertEntry/deleteEntry/saveUnitLinks assert an affected-row count (`.select("id")` + length check, as /api/area/knowledge-status does at route.ts:312-314) so a refused write is a loud error, never a green no-op

**Resolution (2026-09-30, intelligence Round G).** Two of three limbs were already live and are verified by pointer: the codebook RLS write policies read the role COLLECTION since R&P `ADD-4` (`20261046`: `codebook_entries_write` / `codebook_config_write` = `caller_holds_any_role(org_id, Admin + DocCtrl)`, identical to `is_org_controller`; no later migration redefines them — census in `lib/__tests__/intelRoundGRegistry.test.ts`), and the page's `canWrite` reads the collection since R&P `ADD-1`. This round closes the third: every codebook write in `lib/codebook.ts` asks for its row back — `upsertEntry` (edit and upsert), `deleteEntry`, `saveUnitLinks`, `saveConfig` — and a refusal (zero rows, no error) is thrown as "Not saved — only Admin or Document Control can edit the Site Codebook"; `applyImport` attempts every row and reports what did not land with the count that did. The stale NOTE about the headline-only policy is rewritten. Tests: `lib/__tests__/intelRoundGRegistry.test.ts` ("CB-4 / IRLS-10").

**Done-when.**
1. ✓ Additive-role aware (20261046, R&P ADD-4 — verified by pointer and census).
2. ✓ `canWrite` uses the collection (R&P ADD-1 — verified in source).
3. ✓ upsertEntry / deleteEntry / saveUnitLinks (and saveConfig) assert an affected-row count.

**Scope / residual.** None.

---

<a id="cb-5"></a>

## CB-5 · Deleting or re-adding a codebook entry has no referential integrity and the confirm text understates the blast radius

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** intelligence I-16 CODEBOOK LIFECYCLE (new) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/codebook/page.tsx:208-216`, `lib/codebook.ts:356`, `lib/codebook.ts:360-363`, `supabase/migrations/20260928_site_codebook.sql:78-83`, `supabase/migrations/20261017_process_flows.sql:17-20`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: re-typing a mistyped unit code is delete-plus-add, which cascades to nothing, and the confirm text's "Nothing else is deleted" is technically true but misleading — assets keep the dead unit_code (surfacing in the unknownUnits bucket at admin/assets/page.tsx:240-244) and process_flows rows keep dangling to_ref/from_ref strings that now resolve to no unit.

**Mechanism.** Codes are referenced across the app as bare TEXT with no foreign key: `ALTER TABLE assets ADD COLUMN IF NOT EXISTS unit_code TEXT;` (migration:78) and process_flows stores `from_kind TEXT CHECK (... IN ('asset','unit')), from_ref TEXT` (20261017:17-18) where a unit ref is the raw code — /api/flows/read/route.ts:69 pushes `{ ref: 'U'+i, kind: 'unit', id: u.code, ... }`. codebook_entries has no ON DELETE behaviour toward any of them, and `deleteEntry` is a bare `.delete().eq("id", id)` (codebook.ts:361). The confirm dialog says only "Features stop recognizing this code. Nothing else is deleted." (page.tsx:211) — true but misleading: the DATA that referenced the code survives and becomes unresolvable. The code field is also not editable in EntryRow (only label and prefixes are, page.tsx:283-293), so correcting a mistyped code REQUIRES delete-and-re-add, forcing users down this path. And re-adding an existing code silently overwrites: `.upsert(row, { onConflict: "org_id,kind,code" })` (codebook.ts:356) with no confirmation, unlike AddUnitModal which does check (assets/page.tsx:1714).

**Failure scenario.** A controller notices unit "2O" was typed with a letter O instead of a zero. Because the code is not editable, they delete the row and add "20". Every asset already filed under "2O" keeps unit_code "2O" — nothing cascades — and now surfaces in the `unknownUnits` phantom-area bucket on /admin/assets (page.tsx:240-247). Any process_flows row whose from_ref/to_ref was "2O" now points at a unit that does not exist, and the unit's `meta.links` and `meta.knowledgeLibraryId` binding (written by /api/area/knowledge-status) are destroyed with the row. Separately, an admin retyping an existing unit code in the Units tab with a different label silently replaces the old label plant-wide with no prompt.

**Evidence.**

```
lib/codebook.ts:360-363 — `export async function deleteEntry(id: string): Promise<void> { const { error } = await supabase.from("codebook_entries").delete().eq("id", id); ... }`. lib/codebook.ts:356 — `: await supabase.from("codebook_entries").upsert(row, { onConflict: "org_id,kind,code" });`. supabase/migrations/20260928_site_codebook.sql:78 — `ALTER TABLE assets ADD COLUMN IF NOT EXISTS unit_code TEXT;` (no FK). app/api/flows/read/route.ts:69 — `units.forEach((u, i) => roster.push({ ref: \`U${i + 1}\`, kind: "unit", id: u.code, ... }))`. app/(protected)/admin/codebook/page.tsx:211 — `message: "Features stop recognizing this code. Nothing else is deleted."`.
```

**Chain reaction.** Because the app already tolerates orphans gracefully (the unknownUnits bucket exists precisely so "an asset must never be invisible from the front door", per the comment at assets/page.tsx:238-239), a codebook mistake degrades into a permanent, silent second taxonomy rather than an error anyone is asked to fix.

**Done when.**

- [ ] the delete confirm names the exact counts it will orphan (assets with this unit_code, process_flows refs, pinned links, knowledge binding)
- [ ] codes are editable in place with a cascade that rewrites the referencing rows, removing the need to delete-and-re-add
- [ ] re-adding an existing code shows the same 'already exists' guard the assets-page modals use, instead of silently upserting over the label

**Partial (2026-09-30, intelligence Round G).** Removal is now honest and guarded (the package decision, `DEC-53`: a unit or type still in use is refused with the counts). `EntryTable.remove` counts, before anything is deleted, the registry assets a unit files or codes (or a type types or codes) — `entryAssetReferences` over `listAssetIdentities` — and the process flows ending at a unit (`unitFlowReferenceCount`, both endpoints); any reference refuses the removal with the numbers ("… still in use: 312 assets filed under it or coded into it and 4 process flows ending at it. Refile them first"). An unreferenced entry's confirm names exactly what it loses (pinned libraries, the knowledge binding). Re-adding an existing code is refused with "already exists — edit its label in place" instead of silently upserting over the label.

*Review fix (2026-09-30).* The refusal was enforced only in the codebook page's `remove()`, so any other caller of `deleteEntry`, or a controller's direct PostgREST DELETE, could still strand equipment. `20261128` §6 adds `trg_codebook_entries_guard_in_use` (`codebook_entries_guard_in_use`, SECURITY DEFINER, `search_path` pinned). It fires BEFORE DELETE OR UPDATE OF code, kind and refuses (23503) a person's removal or re-coding of a unit or equipment type that stored identity still references: assets filed under the unit, assets whose site code's head is `<unit><type>` for the entry, and process flows ending at the unit. The refusal carries the counts. The service role's cascades (org purge, restore) pass, and so does an org already gone. `lib/codebook.ts` `deleteEntry` translates the refusal ("Refused — unit 20 is still referenced by 312 asset(s) and 2 process flow(s)…"). The page's own pre-count stays because it is friendlier and also counts tags a type's prefixes classify. This was exercised on a scratch Postgres 16: a unit or type still in use was refused, an unused type was removed, and the service role and an org-level cascade passed. Tests: `lib/__tests__/assetCategorize.test.ts`, `lib/__tests__/intelRoundGRegistry.test.ts` ("CB-5", "20261128 §6").

**Done-when.**
1. ✓ The confirm (or the refusal) names exact counts: assets, process-flow refs, pinned links, knowledge binding.
2. ✗ Not done — codes are still not editable in place, and there is no cascade rewriting `assets.unit_code`, the unit part of `assets.code` and `process_flows` refs. It is a multi-table rename that must be atomic (a SECURITY DEFINER function gated by `is_org_controller`, rewriting three tables in one transaction) and is larger than this package's brief; until it exists, the refusal above stops the delete-and-re-add path from stranding data.
3. ✓ Re-adding an existing code shows the "already exists" guard.

**Scope / residual.** Limb 2 (in-place code rename with a cascade) remains open for a later round. Until it lands, the database refuses a code change while the code is in use, so a rename can no longer strand equipment either. The guard's `20261128` must be applied.

---

<a id="cb-6"></a>

## CB-6 · Derived identity is a frozen snapshot: editing the codebook never re-decodes existing assets, so codes and units drift silently forever

- **Severity:** MEDIUM
- **Status:** OPEN
- **Assigned:** intelligence I-16 CODEBOOK LIFECYCLE (new) — by the integrator, 2026-10-01 (orphan sweep: the package that left this remainder has merged; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Locations:** `lib/equipmentBridgeServer.ts:211-212`, `lib/equipmentBridgeServer.ts:251-253`, `lib/assetCategorize.ts:51-57`, `app/(protected)/admin/assets/page.tsx:1016-1019`, `app/(protected)/admin/codebook/page.tsx:344-347`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The absence claim holds under a repo-wide search: every write of assets.code is a create-time or fill-a-blank write, so a padTo (or type-code, or prefix) change leaves every pre-existing asset carrying a code the current codebook would no longer produce, with nothing anywhere detecting the divergence.

**Mechanism.** `assets.unit_code` and `assets.code` are computed once, at the moment an asset is created or first filed, and then stored. Every write site is a create-or-fill-blank: equipmentBridgeServer.ts:211-212 on discovery; equipmentBridgeServer.ts:251-253 backfilling only rows `.is("unit_code", null)`; assetCategorize.ts:120 for assets with no unit; admin/assets/page.tsx:1018 which explicitly preserves any existing value (`code: r.asset.code ?? tagToCode(...)`). There is no recompute path anywhere in the repo. assetCategorize actively skips already-decided rows: `if (a.type_id) { alreadyCategorized += 1; continue; }` (line 57) and `if (!a.unit_code && a.code)` (line 51). Nothing on the admin codebook page warns that an edit leaves existing data behind — `deleteEntry`'s confirm says only "Features stop recognizing this code. Nothing else is deleted." (page.tsx:211). The codebook is also unversioned: codebook_entries and codebook_config carry only `updated_at`/`updated_by`, no version column and no history table, and assets record no stamp of which codebook produced their code.

**Failure scenario.** An org sets `padTo` to 2 six months after commissioning the registry (admin/codebook/page.tsx:428-429 exposes exactly this control). I verified with the verbatim codec: tagToCode("E-22","20") is "2030.22" at padTo 0 and "2030.022" at padTo 3 — the same physical exchanger. Assets created before the change keep "2030.22"; assets discovered after carry "2030.022". Two code conventions now coexist in one registry with nothing marking which is which, no way to tell them apart, and no migration. The same happens when an equipment type's code is corrected, when a tagPrefix is added (previously-unmatched assets stay uncategorized because assetCategorize only looks at `!a.type_id` rows, which is correct, but previously-MIScategorized ones are never revisited), or when a unit is deleted and re-added under a different code.

**Evidence.**

```
Two differently-shaped searches for a recompute path both returned nothing: (1) bare identifiers `recomputeCodes|redecode|reDecode|recodeAssets|backfillCodes|refreshCodes` across all .ts/.tsx — zero hits; (2) an exhaustive grep of every write to `assets.code`/`unit_code` (`code: tagToCode|unit_code:|code: s.code|patch.code`) returned only the create/fill-blank sites listed above. lib/assetCategorize.ts:57 — `if (a.type_id) { alreadyCategorized += 1; continue; }`. lib/equipmentBridgeServer.ts:245 — `.select("id, code").in("id", ids).is("unit_code", null);` (only blanks touched). A quoted-string search for `codebook_version|codebook_history|codebook_revisions` across .sql/.ts/.tsx returned zero hits — the decoder is unversioned.
```

**Chain reaction.** Because the codebook is the app's single decoder and the derived values are the app's stored truth, every consumer downstream of a stale code inherits the drift: the graph's asset→unit edges (orgGraph.ts:255), unit-scoped asset lists, the registry's site-code column, and process_flows unit refs which store the bare `u.code` string (api/flows/read/route.ts:69 pushes `id: u.code`).

> **Verifier correction.** Severity HIGH → MEDIUM, plus one mitigation the finding missed. There IS a per-asset remediation path: the asset editor at app/(protected)/admin/assets/page.tsx:1306-1384 lets a user edit unit_code and the site code by hand, and its derive effect at :1311-1315 deliberately refuses to overwrite an existing code (`if (asset?.code) return; // existing explicit code: never overwrite silently`) — which confirms the freeze is a deliberate policy, not an oversight. What is genuinely missing is any BULK or automatic re-decode after a codebook edit. That makes this a design gap producing stale derived metadata, not an active corruption bug.

**Done when.**

- [ ] a re-decode job exists (server-side, admin-triggered) that recomputes unit_code/code for assets whose derivation inputs changed, with a preview diff before it writes
- [ ] codebook_config and codebook_entries carry a version/revision, and assets record the codebook version their code was derived under
- [ ] the admin codebook page warns, before saving a padTo/code/prefix change, how many existing assets were derived under the old rule
- [ ] deleting or editing a code shows the count of assets, process_flows rows, and unit bindings that reference it

**Partial (2026-09-30, intelligence Round G).** A codebook edit now produces a re-decode plan and never a silent rewrite (the package decision, `DEC-53`). `lib/assetCategorize.ts` `planIdentityReview(assets, book)` lists every asset whose stored identity disagrees with the codebook as it stands — a code the codebook now derives differently after a padding / type-code / prefix edit (`code_rederives`) and a code naming a different unit than the filing (`code_names_other_unit`, AREA-11). The Operating Areas page shows it as an Identity review panel with the derived code beside the stored one, accepted per asset (or the shown batch) through the checked `updateAsset` under RLS (the writer tier). Before a padTo / mirroring (NumberingTab) or a prefix (EntryRow) edit is saved, `confirmRederivation` shows how many existing codes the edit would derive differently (`rederivationImpact`). Deleting a code shows its reference counts (CB-5). Tests: `lib/__tests__/assetCategorize.test.ts` ("CB-6").

**Done-when.**
1. Partly — the plan with a preview diff and per-asset acceptance exists ✓, but it runs in the browser under the user's RLS (the writer tier the database enforces), not as a server-side admin job.
2. ✗ Not done — codebook_config / codebook_entries carry no version and assets record no derivation stamp. Drift is detected by re-derivation against the live codebook (which says WHAT differs); a stamp (which would say under WHICH version) needs a schema change outside this package's brief.
3. ✓ The codebook page warns, before saving a padTo / mirroring / prefix change, how many existing assets were derived under the old rule.
4. ✓ Deleting a code shows the counts of assets, process flows and unit bindings that reference it (codes are not editable in place — CB-5 limb 2).

**Scope / residual.** Limbs 1 (server-side job) and 2 (version stamp) remain.

---

<a id="cb-7"></a>

## CB-7 · Saving the drawing-number tab hardcodes mirrorsTag:true, silently resetting a non-mirroring org's rule — and there is no UI for it at all

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** SUSPECTED
- **Locations:** `app/(protected)/admin/codebook/page.tsx:344-347`, `lib/codebook.ts:155-156`, `lib/codebook.ts:337-340`, `supabase/migrations/20260928_site_codebook.sql:47`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves of the claim are true. The only way an org can hold mirrorsTag:false is an imported/restored codebook_config row, and the first Save on the Drawing numbers tab silently flips it back to true — after which tagToCode (codebook.ts:155-159) starts minting derived codes for a scheme that does not mirror the tag.

**Mechanism.** NumberingTab's save writes `iterableRule: { mirrorsTag: true, padTo: Math.max(0, Math.min(6, padTo)) }` (page.tsx:346) — the flag is a literal, not read from `book.iterableRule.mirrorsTag`. Nothing in the app renders a control for mirrorsTag (the tab shows only segments and padTo). tagToCode treats it as load-bearing: `if (!mirrorsTag) return null; // non-mirroring schemes need per-asset codes, not derivation` (codebook.ts:156). So the value can only be set to false out-of-band (the DB default at migration:47 is true, and lib/dataRestore.ts:278 restores codebook_config verbatim from an export).

**Failure scenario.** An org whose codes do NOT mirror the tag number sets mirrorsTag:false (via an imported/restored codebook_config, the only route available). tagToCode correctly returns null for every tag, so the app declines to derive codes and the org assigns them per-asset by hand — the documented degradation. Then a controller opens the Drawing numbers tab to adjust padding or add a segment and clicks Save. mirrorsTag flips to true with no prompt and no visible change, and from that moment the Bridge starts deriving and writing WRONG site codes onto every newly discovered asset (equipmentBridgeServer.ts:117 → 212), permanently, because nothing re-decodes.

**Evidence.**

```
app/(protected)/admin/codebook/page.tsx:344-347 — `await saveConfig(orgId, { drawingNumber: segments.length > 0 ? { segments } : null, iterableRule: { mirrorsTag: true, padTo: Math.max(0, Math.min(6, padTo)) }, }, uid);`. lib/codebook.ts:155-156 — `const { mirrorsTag, padTo } = book.iterableRule; if (!mirrorsTag) return null;`. lib/codebook.ts:338 — the loader does read it (`mirrorsTag: (cfg?.iterable_rule as IterableRule | undefined)?.mirrorsTag ?? true`), so the round-trip is broken only on the write side. A grep for `mirrorsTag` across .ts/.tsx finds it in codebook.ts (type, EMPTY_CODEBOOK, tagToCode, loader), codebookServer.ts (loader), the test, and this one hardcoded write — no UI control anywhere.
```

**Chain reaction.** The padTo control on the same panel has the sibling problem: changing it produces a second code convention for the same equipment (verified: tagToCode("E-22","20") is "2030.22" at padTo 0 and "2030.022" at padTo 3) with no migration of existing assets.

> **Verifier correction.** Verification CONFIRMED → SUSPECTED, and the finding should be reframed. The stated harm — 'silently resetting a non-mirroring org's rule' — has no reachable trigger: the DB default is true (migration:47), the app's only writer hardcodes true, and nothing in the product can ever set it false, so the state being clobbered cannot arise in-app (the lib/dataRestore.ts path just restores config a CCR-managed instance could not have produced either). What is CONFIRMED is the inverse and arguably worse gap: a site whose code iterable does NOT mirror the tag number has no way to say so, so tagToCode derives codes for them that they cannot switch off. Treat this as dead configuration plus a missing control, not a silent reset.

**Done when.**

- [ ] NumberingTab preserves `book.iterableRule.mirrorsTag` on save instead of writing a literal true
- [ ] mirrorsTag is either exposed as a control with an explanation, or removed from the type if non-mirroring schemes are not actually supported
- [ ] saving a padTo change warns how many existing assets carry codes derived under the previous padding

**Resolution (2026-09-30, intelligence Round G).** The numbering tab (`app/(protected)/admin/codebook/page.tsx`) holds `mirrorsTag` in state from `book.iterableRule.mirrorsTag` and saves the org's value — the `mirrorsTag: true` literal is gone (pinned by test). A labelled control explains the rule ("Site codes mirror the tag number … Off: your code iterables are assigned per asset, so the app never derives a site code"). Before a padding or mirroring change is saved, `confirmRederivation` counts the existing assets whose code the current rule derived and the edited rule derives differently (or not at all) — `rederivationImpact` in `lib/assetCategorize.ts` — and says they are NOT rewritten and where to review them.

**Done-when.**
1. ✓ Preserves `book.iterableRule.mirrorsTag` on save.
2. ✓ Exposed as a control with an explanation (non-mirroring schemes are supported by the codec already: `tagToCode` returns null).
3. ✓ A padTo change warns with the count of assets carrying codes derived under the previous padding (with examples).

**Scope / residual.** The warned-about codes are remedied in the Operating Areas identity review (CB-6).

---

<a id="cb-8"></a>

## CB-8 · Two equipment types may register the same tag prefix; typeForTag silently picks whichever sorts first and the admin UI never warns

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/codebook.ts:137-143`, `app/(protected)/admin/assets/page.tsx:1786-1789`, `app/(protected)/admin/codebook/page.tsx:193-201`, `supabase/migrations/20260928_site_codebook.sql:31`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Accurate, including the detail that the winner is deterministic-by-sort rather than random. Both admin entry points validate the type CODE for collisions and neither looks at prefixes, so a second type claiming an in-use prefix is accepted in silence and every one of its tags is then typed and coded as the first type.

**Mechanism.** typeForTag scans every equipment type and keeps the first exact prefix match (`if (parts.prefix === up && up.length > bestLen)` — with equal lengths, the first wins and later matches are ignored, codebook.ts:140). Iteration order is `book.equipmentTypes` in the order loaded, which is `.order("sort").order("code")` (codebook.ts:325). Nothing forbids two types sharing a prefix: the DB unique key is `UNIQUE (org_id, kind, code)` (migration:31) — on the CODE, not on prefixes. Neither writer checks: EntryTable.add (codebook/page.tsx:197-201) validates nothing but non-emptiness, and AddCategoryModal's guard compares only codes — `existingTypeCodes.some((c) => c.trim().toLowerCase() === tc.toLowerCase())` (assets/page.tsx:1787).

**Failure scenario.** An org registers type 30 "Exchangers" ["E"] and later type 45 "Ejectors" ["E"] (both are real refinery classes that share the E prefix at some sites). I ran the verbatim codec with exactly that book: typeForTag("E-22") returns "Exchangers" and tagToCode("E-22","20") returns "2030.22" — every ejector in the plant is coded and categorized as an exchanger, deterministically and silently. Reordering the rows by `sort` in the admin UI would flip the answer for the whole plant with no indication that anything changed.

**Evidence.**

```
lib/codebook.ts:140 — `if (parts.prefix === up && up.length > bestLen) { best = t; bestLen = up.length; }`. supabase/migrations/20260928_site_codebook.sql:31 — `UNIQUE (org_id, kind, code)`. app/(protected)/admin/assets/page.tsx:1787 — the only duplicate guard in the app, and it compares codes not prefixes. Executed probe: `typeForTag('E-22') = Exchangers -> code 2030.22` for a book holding both Exchangers[E] and Ejectors[E].
```

**Chain reaction.** Because the mis-typed asset is written once and never re-decoded (see the frozen-identity finding), fixing the codebook later does not fix the assets already filed under the wrong type.

**Done when.**

- [ ] upsertEntry (or a DB constraint) refuses a tagPrefix already claimed by another equipment_type in the same org
- [ ] the equipment-types tab shows a duplicate-prefix warning inline
- [ ] typeForTag returns an explicit ambiguity result rather than a silent first-wins pick when two types match

**Resolution (2026-09-30, intelligence Round G).** Reproduced: with Exchangers[E] and Ejectors[E], `typeForTag("E-22")` returned Exchangers by sort order. Now: `typeCandidatesForTag` names every type claiming the tag's prefix and `typeForTag` answers null when there are two (no opinion — reordering rows can no longer re-type the plant; `tagToCode` declines too); `upsertEntry` re-reads the org's equipment types and refuses a prefix another type claims ("Prefix E- is already claimed by 30 Exchangers"), as do the codebook page's add/edit rows (`prefixClaimsElsewhere`) and the Operating Areas `AddCategoryModal`; `diffImport` rejects an AI proposal whose prefix is already held (by an existing type or an earlier row of the same proposal). The codebook page shows a problems banner and flags the affected rows (`codebookProblems`). Tests: `lib/__tests__/codebook.test.ts` ("CB-8"), `lib/__tests__/intelRoundGRegistry.test.ts`.

**Done-when.**
1. ✓ upsertEntry refuses a prefix already claimed by another equipment type (and the two direct-insert paths check first).
2. ✓ The equipment-types tab shows the duplicate-prefix warning (banner + flagged rows) for data that already has one.
3. ✓ typeForTag returns an explicit no-opinion result on a tie; typeCandidatesForTag exposes the contenders.

**Scope / residual.** None.

---

<a id="cb-9"></a>

## CB-9 · asset_aliases are written with the codebook's normalizeTag and read with the registry's — the alias lookup and alias search can never match

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/assetAliases.ts:17`, `lib/assetAliases.ts:65`, `lib/assets.ts:77-79`, `lib/assets.ts:161-166`, `lib/search.ts:32`, `lib/search.ts:50-55`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by exhaustive grep on the column. Writes land uppercase ("THENORTHFURNACE"), so the two `.eq()` lookups in assets.ts and search.ts — both case-sensitive equality against a lowercase key — can never match any row. Only lib/assetAliases.ts:83 resolveAliasToAssetIds happens to use the codebook normalizer and therefore works; the other alias consumers (linkProposerServer.ts:261, mentionIndexer.ts:44, knowledge/ask/route.ts:373) sidestep the bug by reading the raw `alias` text.

**Mechanism.** There are four distinct normalizeTag implementations in the repo (lib/codebook.ts:112, lib/assets.ts:77, lib/pidTrace.ts:60, lib/documentTags.ts:130) and the alias column is written under one convention and read under another. `addAssetAlias` imports from the codebook — `import { normalizeTag } from "@/lib/codebook";` (assetAliases.ts:17) — and stores `alias_normalized: normalizeTag(alias)` (line 65), which UPPERCASES and preserves dashes. `getAssetByTag`'s alias fallback uses assets.ts's own local normalizeTag (defined at 77-79 as `(tag || "").toLowerCase().replace(/[^a-z0-9]+/g, "")`) in `.eq("alias_normalized", normalizeTag(tag))` (line 163). lib/search.ts:32 imports normalizeTag from "@/lib/assets" and queries the same column with it at line 50-55.

**Failure scenario.** A user teaches the alias "the north furnace" for asset H-3. addAssetAlias stores alias_normalized = "THENORTHFURNACE" (codebook normalizeTag: uppercase, whitespace stripped, no leading-letter+digit anchor match). Someone later types "the north furnace" into global search: search.ts:50 computes key = "thenorthfurnace" (lowercase) and the `.eq("alias_normalized", key)` finds nothing. Same for getAssetByTag's fallback at assets.ts:163, whose comment promises "a pre-renumber tag or a vendor name resolves to the same hub, so an old link in an email still lands somewhere real" — it never does. resolveAliasToAssetIds (assetAliases.ts:82-89) uses the codebook normalizer on both sides so it works, which is why the break is invisible from the alias CRUD screen. The entire semantic-alias feature is dead on the two surfaces users actually reach it from.

**Evidence.**

```
lib/assetAliases.ts:17 and :65 — `import { normalizeTag } from "@/lib/codebook";` … `alias_normalized: normalizeTag(alias),`. lib/assets.ts:77-79 — `export function normalizeTag(tag: string): string { return (tag || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }` — a local definition, not an import (verified by reading assets.ts:1-12, which imports only supabase and a type). lib/assets.ts:163 — `.eq("org_id", orgId).eq("alias_normalized", normalizeTag(tag))`. lib/search.ts:32 — `import { normalizeTag, type Asset } from "@/lib/assets";`, used at :50 `const key = normalizeTag(q);` then :55 `.eq("alias_normalized", key)`. An exhaustive grep for `alias_normalized` across .ts/.tsx/.sql returned exactly these read/write sites plus the migration's indexes (20260807_link_proposals.sql:125,136,138).
```

**Chain reaction.** lib/equipmentBridgeServer.ts:46 defines its own third copy (`const assetNorm = (tag) => tag.toLowerCase().replace(/[^a-z0-9]+/g, "")`) with a comment naming the convention it must match — evidence the divergence is already a known hazard that was patched locally rather than centrally.

> **Verifier correction.** Two corrections. (1) Scope: this does NOT break alias matching everywhere. Three other consumers read the raw `alias` text and are unaffected — app/api/knowledge/ask/route.ts:373-379 (substring match on lowercased alias), lib/mentionIndexer.ts:44-52 (dictionary of raw aliases), lib/linkProposerServer.ts:261-266. Exactly two lookups are broken: getAssetByTag's alias fallback (assets.ts:161-169) and search's alias→document path (search.ts:49-61). Worth noting the one consistent reader, assetAliases.ts:82 resolveAliasToAssetIds, has zero callers. (2) 'Can never match' is overstated: a digits-only alias with no punctuation normalizes identically under both. Any alias containing a letter or punctuation cannot match. Severity HIGH → MEDIUM: two nickname-lookup features silently return nothing; no data is corrupted and the primary tag lookups are unaffected.

**Done when.**

- [ ] one normalizeTag is the single source of truth for the alias/tag identity column, imported by assetAliases.ts, assets.ts, and search.ts alike
- [ ] a data migration re-normalizes existing alias_normalized values to the chosen convention
- [ ] a test asserts addAssetAlias → getAssetByTag and addAssetAlias → search round-trip for a phrase alias like "the north furnace"
- [ ] the surviving duplicate normalizers (pidTrace, documentTags) carry a comment stating they are deliberately a different identity and must never touch tag_normalized/alias_normalized

**Resolution (2026-09-30, intelligence Round G).** Closed with `GAP-310` in one commit (`2675323`): the alias column is written and read in THE one grammar, `lib/codebook.ts` `tagKey` (the registry key, identical to `normalize_tag()`), and `20261127_intel_roundG_one_tag_grammar.sql` rewrites every existing row (collision-safe) plus a BEFORE trigger for every future writer. Reproduced first: `lib/__tests__/intelRoundGGrammar.test.ts` fails 7/11 against the pre-fix `lib/assetAliases.ts` (the stored key was `THENORTHFURNACE`, the readers looked up `thenorthfurnace`) and passes after. `removeAssetAlias` is now a checked delete (a refusal is thrown; `components/assets/AliasPanel.tsx` shows it).

*Review fixes (2026-09-30).* The trigger drops (RETURN NULL) an INSERT whose key another row of the asset already holds, so an org restore carrying two spellings of one alias carries on instead of raising 23505 at `asset_aliases`. In the second review the empty key joined that rule: an alias with no letter or digit re-keys to `''`, so two of them on one asset in a backup ("?" and "#", distinct under the old grammar) collided on the unique index and stopped the restore. The second is now dropped too (inert either way). Verified on a scratch Postgres 16; tests in `lib/__tests__/intelRoundGGrammar.test.ts` ("an org restore carries on past two spellings", "two aliases with no letter or digit", each with its 23505 reproduction).

**Pending migration:** `supabase/migrations/20261127_intel_roundG_one_tag_grammar.sql`.

**Done-when.**
1. ✓ One normalizer is the source of truth for the identity columns: `lib/assetAliases.ts` imports `tagKey`, `lib/search.ts` imports `tagKey`, `lib/assets.ts` `normalizeTag` IS `tagKey`.
2. ✓ The data migration re-normalizes existing `alias_normalized` values (20261127; pending paste).
3. ✓ `addAssetAlias → getAssetByTag` and `addAssetAlias → searchDocuments` round-trip for "the north furnace" (and "F-101" in four spellings) — `lib/__tests__/intelRoundGGrammar.test.ts`.
4. ✓ `lib/pidTrace.ts` carries the comment that its uppercase key is a different identity and never touches the identity columns; `lib/documentTags.ts`'s copy was not a different identity at all, so it became a re-export instead.

**Scope / residual.** None beyond applying 20261127.

---

<a id="cb-10"></a>

## CB-10 · tagToCode is not injective: two different pieces of equipment collide onto one site code, and assets.code has no unique index to catch it

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/codebook.ts:149-160`, `lib/codebook.ts:165-183`, `supabase/migrations/20260928_site_codebook.sql:83`, `lib/__tests__/codebook.test.ts:105-110`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Correct, and the collision is reachable with the exact codebook the project ships in its own tests. The asset rows stay distinct (they are keyed on tag_normalized), but their site identity — the thing the org navigates and prints by — is shared, and codeToTag inverts "2010.1" to V-1 unconditionally, so the drum is silently renamed to the vessel on every round trip.

**Mechanism.** An equipment type carries a LIST of tag prefixes (`meta.tagPrefixes`, e.g. Vessels = ["V","D"]). tagToCode composes `${unitCode}${type.code}.${padded}${parts.suffix}` (line 159) using only the TYPE's code — the prefix that identified the type is discarded. So every prefix registered under one type maps to the same code space. The inverse, codeToTag, reconstructs the tag from `const prefix = (type.meta.tagPrefixes ?? [])[0]` (line 177) — always the FIRST prefix. The docstring at 162-164 promises "Invert a site code back to a tag" and the test at 105-110 asserts "round-trips through tagToCode", but the test's four cases (E-22, H-3, EA-101, V-1201) every one uses a type's first-and-only or first prefix, so the defect is invisible to it.

**Failure scenario.** An org registers Vessels with prefixes ["V","D"] — exactly the codebook in the repo's own test fixture (codebook.test.ts:25). I ran the verbatim codec: tagToCode("V-1","20") = "2010.1" and tagToCode("D-1","20") = "2010.1" — the drum D-1 and the vessel V-1 are two physically distinct assets that now carry an identical site code. codeToTag("2010.1") returns {tag:"V-1"}, so D-1's identity is silently rewritten to V-1 on any inverse. Because supabase/migrations/20260928_site_codebook.sql:83 creates `idx_assets_org_code` as a PLAIN index (`CREATE INDEX ... ON assets (org_id, code)`), not UNIQUE, the database accepts both rows. In a PSM/OSHA context two vessels sharing one site identity is a records-integrity failure.

**Evidence.**

```
lib/codebook.ts:159 — `return `${unitCode}${type.code}.${padded}${parts.suffix}`;` (prefix discarded). lib/codebook.ts:177 — `const prefix = (type.meta.tagPrefixes ?? [])[0];` (first prefix always). supabase/migrations/20260928_site_codebook.sql:83 — `CREATE INDEX IF NOT EXISTS idx_assets_org_code ON assets (org_id, code);` — no UNIQUE. Executed probe output: `tagToCode(V-1,20)=2010.1  codeToTag -> {"tag":"V-1",...}` and `tagToCode(D-1,20)=2010.1  codeToTag -> {"tag":"V-1",...}`.
```

**Chain reaction.** lib/assetCategorize.ts:52 calls codeToTag on stored codes to file assets into units; anything keyed on `assets.code` (search, exports, the registry's dual-identity display at admin/assets/page.tsx:1018) treats the colliding pair as one identity.

> **Verifier correction.** Severity CRITICAL → MEDIUM. The 'wrong inverse' half has no production consumer: two differently-shaped searches (`codeToTag(` across all .ts/.tsx, and `.eq("code"` across the repo) show codeToTag's only non-test caller is lib/assetCategorize.ts:52, which uses `decoded.unitCode` for unit filing and pushes `tag: a.tag` (the asset's own tag) — the reconstructed tag is discarded. No code path resolves an asset by `code` (the three `.eq("code"` hits are all codebook_entries unit lookups). So the real, confirmed harm is narrower than stated: two assets can display the same 'full site identity' pill and a code search (lib/search.ts:79, an ilike) returns both. Nothing breaks or mis-files.

**Done when.**

- [ ] either tagToCode encodes which prefix produced the code, or the codebook forbids more than one tagPrefix per equipment type (and the admin UI enforces it)
- [ ] codeToTag returns an ambiguity signal instead of silently picking tagPrefixes[0] when the type has more than one prefix
- [ ] a unique partial index exists on assets (org_id, code) WHERE code IS NOT NULL, so a collision is refused rather than stored
- [ ] the round-trip test at codebook.test.ts:105-110 includes a non-first prefix case such as ["D-1","20"] and passes

**Resolution (2026-09-30, intelligence Round G).** Reproduced with the repo's own fixture: V-1 and D-1 (Vessels: V, D) both derive `2010.1` and the inverse renamed D-1 to V-1. Decision (`DEC-53`): a site code encodes the TYPE, so prefixes registered on one type share its number space by the site's own standard; the app neither encodes the prefix into the code nor forbids multi-prefix types (either would impose a numbering convention on the site — the DEC-35 spirit). Instead: (a) `codeToTag` returns an ambiguity signal — `{ tag: null, ambiguous: true, candidates: ["V-1","D-1"] }` — for a multi-prefix type and never silently picks the first prefix (the unit, which is all the categorizer reads, stays certain); (b) the registry refuses a second asset on one code: `20261128` creates a UNIQUE partial index `assets_org_code_unique` on `(org_id, code)` for non-blank codes when no org carries a duplicate (otherwise the plain index stays and the inventory counts them), and `lib/assets.ts` translates a collision into "Site code … is already carried by another asset"; (c) the codebook page's problems banner names every multi-prefix type ("V-1 and D-1 derive the same site code"), `siteCodeCollisions` names derived collisions, and the Operating Areas identity review lists codes already shared by two assets with a door into each (`sharedSiteCodes`).

*Review fix (2026-09-30).* Two things the index made worse are fixed.
- **A collision on a DERIVED code no longer loses the row.** `lib/assets.ts` `createAsset({ codeOptional })` and `updateAsset(id, patch, by, { codeOptional })` re-send a write that collides on `assets_org_code_unique` without the code, so the asset is still created or filed. `updateAsset` returns `codeDropped` and `isSiteCodeTaken` recognises the refusal.
  - The master-list import plans against every code already carried: `planAssetImport` takes `codeHolders` from `listAssetIdentities` (archived rows included) and tracks the codes earlier rows of the file claim. A derived or given code that is already taken (V-1 / D-1, E-022 / E-22) is dropped from the row with a note, and the row still lands filed. The commit writes with the code optional and lists the rows that landed without it.
  - The bulk filer (`UnassignedAssignPanel.assign`) now tries each row separately, writes the derived code as optional, reports what was filed without a code or not filed at all, and refreshes the page in `finally`. Before, the first collision stopped the loop partway and left the page stale.
  - Such an asset appears in the identity review as `derived_code_taken`, naming the holder (`planIdentityReview(assets, book, codeHolders)`), with a door to set its own code.
- **Archived assets are counted.** The shared-code list is computed over every identity, archived included, which is what the index and the inventory count. Archived holders are marked, and one opens from the registry (`getAsset`).

Tests: `lib/__tests__/codebook.test.ts` ("CB-10"), `lib/__tests__/assetCategorize.test.ts` ("CB-10 — the identity review lists…", "CB-10 — the import plan drops…", "an ARCHIVED holder counts"), `lib/__tests__/intelRoundGRegistry.test.ts` ("a DERIVED code is optional", "the bulk filer and the importer never lose a row").

*Second review fix (2026-09-30).* The first fix held "never the asset" only for this package's app writers. The service role's writes still lost the row: the Bridge's discovery insert failed on the index and its retry does not match the index name, so D-1 was never created beside V-1; its matched-asset backfill sends `{unit_code, code}` in one patch, so a code collision swallowed the filing; and an org restore stopped at `assets` for a backup row whose code another asset now carries. `20261128` adds `assets_code_one_holder` (BEFORE INSERT OR UPDATE OF code, `search_path` pinned): when the SERVICE ROLE writes a code another asset of the org already carries (a committed holder: the trigger cannot see a parallel insert), an INSERT lands without it. An UPDATE then kept the row's own code; the verification fix below makes that a refusal and has the Bridge re-send its backfill without the code. It excludes `NEW.id`, so a restore's `ON CONFLICT (id)` skip of a live row is unchanged. A person's write passes through to the index. The drawer's auto-derived code is now written as optional too (it saves without it and says so); only a code a person typed is refused, with the code named. Proven by driving the Bridge's own `applyForDocument` (I-11's file, not edited by this fix) against the in-memory stand-in: without the trigger D-1 is not created and E-022 stays unfiled; with the transcribed trigger D-1 lands filed without the code and E-022 is filed. The restore round trip covers a live id, a reused code and a pre-index duplicate pair. Verified on a scratch Postgres 16 (service-role insert and backfill, restore, a person's refusal). Tests: `lib/__tests__/intelRoundGRegistry.test.ts` ("CB-10 — the Bridge and the org restore meet a taken site code", "a code the service role INSERTS yields", "the drawer's auto-derived code is optional").

**Verification fix (2026-09-30, intelligence Round G).** An independent verification of `8a19bfa` found three places where the second fix claimed more than the code did.
- **A parallel insert of one code lost the asset.** `assets_code_one_holder` sees committed rows only. Two drawings ingested in parallel (V-7 and D-7 both derive `2010.7`) both passed it, the index refused the second with 23505 on `assets_org_code_unique`, the Bridge's only retry matched a missing column, and its lookup by tag found nothing, so D-7 was silently not created. Reproduced on a scratch Postgres 16 with two sessions. Now `lib/equipmentBridgeServer.ts` `applyForDocument` re-sends such an insert once with the code blank (the trigger's own policy for a taken code). The file is I-11's; the change is small and is declared under `filesOutsidePlan`. The Bridge records every tag it writes without its derived code as `codesLeftBlank`, both in the `EQUIPMENT_BRIDGE_APPLIED` audit row and in its result. That covers the retried race, an insert the trigger blanked (read back from the insert's returned code), and a backfill re-sent without its code. Any other service-role writer that races on one code (a restore beside a Bridge run, a SQL insert) still gets the 23505.
- **A service-role UPDATE to a taken code changed nothing and still answered UPDATE 1.** The trigger kept `OLD.code` and raised only a NOTICE, so a SQL-editor cleanup done in the wrong order silently did nothing. The UPDATE path now raises 23505 with `CONSTRAINT assets_org_code_unique` and a message naming the holder ("assets_org_code_unique: site code 2010.1 is already carried by V-1 (asset …); E-22 keeps its code"). Only an INSERT is blanked: restores and the Bridge's discovery insert. The Bridge's matched-asset backfill sends `{unit_code, code}` in one patch, so on that refusal it re-sends `{unit_code}` alone and the filing lands. The message carries the index name, so `lib/assets.ts` and the Bridge recognise it as they recognise the index's own refusal. The probe now pins the RAISE and the absence of `NEW.code := OLD.code`.
- **The restore claim was wider than the code.** `20261128` §5 said "the identity review lists the asset". The review lists one only when the asset is filed and the dropped code is the one the codebook derives for it (`derived_code_taken`). Any other code a restore drops, such as one a person typed, is recorded by the trigger's NOTICE alone. The comment and this record now say so. The review is not widened (the smaller honest change); the gap is a residual below.

Verified on a scratch Postgres 16 (stub `auth.uid()`, the verifier's seed). A service-role INSERT of a taken code lands without it, with a NOTICE naming the holder. A service-role UPDATE raises 23505 naming the holder, both non-blank → taken and the backfill shape blank → taken, and the re-sent `{unit_code}` lands. The correct cleanup order (clear the holder, then move the code) works, and a person's write still meets the index. The restore chunk and its re-run behave as before. Two concurrent sessions reproduce the race, and a re-send with the code NULL lands. The migration re-runs with every probe true. Tests: `lib/__tests__/intelRoundGRegistry.test.ts` ("two drawings ingested in parallel …", "index only …: the Bridge re-sends once without the code", "E-022's backfill is REFUSED by the trigger … and re-sent without the code", "a service-role UPDATE to a taken code … is refused with 23505 naming the holder", and the shape test pinning the RAISE).

**Pending migration:** `supabase/migrations/20261128_intel_roundG_registry_authority.sql` (inventory row: assets sharing a code; the after row says whether the unique index was created).

**Done-when.**
1. ✓ By decision (`DEC-53`): neither listed option — the code encodes the type by the site's standard; injectivity is enforced where it can be, at the registry (unique index) and in the UI warnings.
2. ✓ codeToTag returns an ambiguity signal for a multi-prefix type.
3. ✓ The unique partial index exists once the duplicate inventory is zero (two worlds; nothing is rewritten). The identity review lists the duplicates to resolve, archived holders included, since the index counts them too. The index refuses a duplicate code, and the writers that derive one keep the asset. A service-role INSERT (the org restore, the Bridge's discovery insert) yields the code at the database trigger. The Bridge re-sends, once and without the code, a discovery insert the index refuses in a race and a backfill the trigger refuses. The app writes a derived code as optional (the importer, the bulk filer, the drawer). A code a person typed is refused, with the code named, and a service-role UPDATE to a taken code is refused, naming the holder. Another service-role writer racing on one code (a restore beside a Bridge run) gets the index's 23505.
4. ✓ The round-trip test includes the non-first prefix (`D-1`) and asserts it is a candidate of an ambiguous inverse.

**Scope / residual.** If the inventory shows duplicates, a person resolves them in the identity review and 20261128 is re-run to create the index. `lib/equipmentBridgeServer.ts` is I-11's file. This package edited it once, for the two re-sends without the code (`filesOutsidePlan`), and I-11 may surface `codesLeftBlank` in its coverage report. Two remainders are not built here:
- A code a restore drops that is not the asset's derived code (one a person typed) is recorded only by the trigger's NOTICE. The restore route does not surface notices, and the identity review lists such an asset only when the dropped code is its derived one. **Closer: admin-and-org P1** (the restore route): compare each restored asset's backup code with the stored one and list the dropped codes in the restore result.
- `CategorizeBanner` (`components/assets/UnitOpsPanels.tsx:46`, I-09's file) still plans without identities: `planCategorization(assets, types, book)` proposes a code an archived asset holds. It writes the derived codes without saying so, and its result line shows neither `codesDerived` nor `codesTaken`. A taken code is caught at apply as `codesTaken` rather than as a failure, but it is not shown. The Operating Areas page's own "Fill site codes from codebook" path already plans against every identity and reports both. **Closer: I-09**: pass `listAssetIdentities` as the fourth argument and show both counts in the result line.

---
