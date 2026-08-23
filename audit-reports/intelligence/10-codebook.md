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

---

<a id="cb-3"></a>

## CB-3 · Codebook codes are unvalidated free text; a non-numeric code silently breaks the entire codec with no error anywhere

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

<a id="cb-4"></a>

## CB-4 · Codebook write authority is headline-role-only while the rest of the intelligence stack is additive-role aware — a Manager who holds DocCtrl is locked out of the codebook but can still bind knowledge libraries

- **Severity:** LOW
- **Status:** OPEN
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

---

<a id="cb-5"></a>

## CB-5 · Deleting or re-adding a codebook entry has no referential integrity and the confirm text understates the blast radius

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

<a id="cb-6"></a>

## CB-6 · Derived identity is a frozen snapshot: editing the codebook never re-decodes existing assets, so codes and units drift silently forever

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

<a id="cb-7"></a>

## CB-7 · Saving the drawing-number tab hardcodes mirrorsTag:true, silently resetting a non-mirroring org's rule — and there is no UI for it at all

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

<a id="cb-8"></a>

## CB-8 · Two equipment types may register the same tag prefix; typeForTag silently picks whichever sorts first and the admin UI never warns

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

<a id="cb-9"></a>

## CB-9 · asset_aliases are written with the codebook's normalizeTag and read with the registry's — the alias lookup and alias search can never match

- **Severity:** MEDIUM
- **Status:** OPEN
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

---

<a id="cb-10"></a>

## CB-10 · tagToCode is not injective: two different pieces of equipment collide onto one site code, and assets.code has no unique index to catch it

- **Severity:** MEDIUM
- **Status:** OPEN
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

---
