# 17 · The Intelligence hub as a product

**12 findings** — 1 CRITICAL · 1 HIGH · 10 MEDIUM.

What a new org sees, and whether the numbers on the status board are real.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| The Facility Setup navigator computes every stage check from live counts against real org-scoped tables — no stored checklist state, so it cannot claim completion it hasn't verified | `app/(protected)/setup/page.tsx:55-107, 109-188` | I checked the four checks most likely to be fake. `document_assets`, `entity_mentions` and `document_related_resources` all carry `org_id NOT NULL` (20260609_phase1_normalization.sql:53, 20260929_mention_engine.sql:27, 20260806_intelligence_layer.sql:70), so the `.match({ org_id })` filter resolves rather than erroring to a permanent zero. And the 'Grow the web' check counting `document_related_resources` is honest: `approveProposal` writes exactly that table (lib/linkProposals.ts:111), so approving proposals really does advance the stage. This page is the correct model for the whole hub — it should be the front door, not a hidden admin page. |
| SemanticIndexPanel refuses to disappear — it renders a stated reason for every failure mode instead of vanishing | `components/knowledge/SemanticIndexPanel.tsx:132-169` | Missing migration, unreadable status, and zero-passages each get their own visible strip with the diagnosis and the remedy. It is the only panel in the hub that treats 'rendered nothing' as a bug rather than a state. The Intelligence Overview's infinite shimmer (finding 4) and DrawingIntelPanel's `if (!intel) return null` (DrawingIntelPanel.tsx:64) are the same class of problem this component already solved — the pattern exists in-repo and just needs applying. |
| The feature atlas is a real, tested map of the product that the command palette searches by intent | `lib/featureAtlas.ts:29-186, components/navigation/GlobalCommandPalette.tsx:251-259, lib/__tests__/featureAtlas.test.ts:27-34` | 33 entries covering every Intelligence and admin destination, with tests asserting that 'api key' lands on /intelligence/setup and 'what now' lands on /setup. This is the discoverability backstop for a hub whose nav is otherwise incomplete — adding the one missing entry (/admin/ai-instructions) is a two-line fix that closes finding 10. |
| Per-user AI keys are enforced end to end, and the surfaces describe that honestly | `app/api/ai/connection/route.ts:1-16, 83-105, app/api/knowledge/ask/route.ts:452-455` | `GET` reads strictly `.eq("user_id", auth.userId)` and returns `effective: personal`; the ask route's semantic half is `const embedding = embeddingConnectionFrom(connRow); if (!embedding) return [];` against the asker's own row. So the Overview's card copy 'Keyword search only until a Voyage/OpenAI key is added' is literally true for the viewer, not a hedge. Any redesign of the status board must preserve this per-user truth rather than collapsing the keys into an org-level indicator. |
| Knowledge-source live sync is genuinely wired, not aspirational | `lib/knowledge.ts:806-811, components/knowledge/SourcesPanel.tsx:411-417` | SourcesPanel claims 'new documents index automatically, published revisions re-index, archived ones drop out.' My first scoped grep missed the wiring; a second bare-identifier search found `nudgeKnowledgeSources` called from CsvImportModal.tsx:195 and eleven sites in app/(protected)/documents/[libraryId]/page.tsx, with the maintenance cron as backstop. The claim holds — this is the doc-control→knowledge on-ramp for the owner's question 5 and it works. |
| The answer-proof experience (citation → proof card → cited page with the passage highlighted) is fully built and deterministic | `app/(protected)/knowledge/[id]/page.tsx:95-161, 292-340` | ProofCard marks the claim's own terms inside the stored quote via `highlightQuote(c.quote ?? "", proofTerms(context))` and reports `{hits} claim terms found in this passage`; FactCard surfaces each fact's own deduped sources as buttons that open the real page. This is the most finished thing in the hub and the reason the Knowledge tab is worth navigating to — it must not be disturbed by the ViewTabs fix in finding 7. |


---


<a id="hub-1"></a>

## HUB-1 · Drawing Intelligence is unreachable in every workspace — the only checkbox that enables it is dropped on save

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/knowledge/LibraryAiModal.tsx:37`, `components/knowledge/LibraryAiModal.tsx:86-90`, `components/knowledge/LibraryAiModal.tsx:229-243`, `app/(protected)/knowledge/[id]/page.tsx:1956-1960`, `lib/knowledge.ts:39-44`, `lib/knowledge.ts:279-289`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Repo-wide grep for `drawingIntel` returns five hits and none of them writes the flag — the modal's own state, its checkbox, the type declaration in knowledge.ts:44, and the strict `=== true` gate. There is no API route, migration default, or seed that sets it, so DrawingIntelPanel is unreachable in every workspace and the ticked box is silently discarded behind a success toast.

**Mechanism.** The library page mounts the panel behind a single flag: `{activeOrgId && library.aiFeatures?.drawingIntel === true && (<DrawingIntelPanel .../>)}` (page.tsx:1956). The only UI that could set that flag is LibraryAiModal's checkbox "This is a drawing set — enable Drawing Intelligence" (line 229-243), which writes to local state `setDrawingIntel(e.target.checked)`. But `save()` sends `await saveLibraryAiFeatures(library.id, { clarifyFacets, visionPages, visionAllPages, decoder: decoder.trim() || undefined, legendDocIds: ... })` (line 86-90) — `drawingIntel` is absent from the payload. Because every field of `KnowledgeAiFeatures` is optional (lib/knowledge.ts:24-48), TypeScript never flags the omission. And `saveLibraryAiFeatures` is a whole-column replace: `.update({ ai_features: features })` (lib/knowledge.ts:281) — so it does not merge, it overwrites, meaning even a value planted by SQL would be erased by the next save of any other setting on this modal.

**Failure scenario.** A DocCtrl uploads a P&ID set, opens Library AI setup, ticks "This is a drawing set — enable Drawing Intelligence", clicks Save setup, and gets the success toast "Library AI setup saved — applies to the next question." The page refreshes and no Drawing Intelligence panel appears. It never will, at any point, for any library, in any org. Everything that panel owns goes with it: the equipment census by category, the missing-sheet audit, one-way connector audit, OPC unreturned/no-ref audits, the per-sheet "what each document produced" readout, the "Record audit" button that writes drawing_audit_logs, and the "Equipment register (CSV)" export. DrawingIntelPanel is the sole consumer of `getDrawingIntel`, `downloadEquipmentRegister` and `recordDrawingAudit` (grep across app/components/lib returns no other caller), so three API surfaces and the whole drawing-audit pipeline are dead from the UI. This is the owner's question 6 — 'when P&IDs arrive, show which equipment is on which sheet' — the per-sheet tag index is built and then hidden behind a flag nothing can set.

**Evidence.**

```
LibraryAiModal.tsx:86-90 — `await saveLibraryAiFeatures(library.id, { clarifyFacets, visionPages, visionAllPages, decoder: decoder.trim() || undefined, legendDocIds: legendDocIds.size > 0 ? [...legendDocIds].slice(0, 3) : undefined, });` — no `drawingIntel` key. Three differently-shaped searches for the identifier (bare `drawingIntel`; quoted `'drawingIntel'`/`"drawingIntel"`/snake `drawing_intel`; case-insensitive `drawingintel`) across .ts/.tsx/.sql/.md return exactly five hits: the two useState/reset lines, the checkbox binding, the render gate, and the interface field. Zero writes. `grep -rn "drawing_intel|drawingIntel" supabase/migrations/*.sql scripts` returns nothing, so no migration or seed sets it either.
```

**Chain reaction.** EquipmentTablePanel.tsx:47 tells the reader "showing the first 400 — use the CSV export in Drawing intelligence for the full set", pointing at a panel that cannot render. SemanticIndexPanel.tsx:166 tells the reader to "run Rebuild index under Drawing intelligence", same dead target. The library page's own comment at page.tsx:1835-1838 records that Re-index was moved OUT of Drawing Intelligence because gating made it unreachable — the fix was applied to one button and the gate itself was left in place.

> **Verifier correction.** One addition, not a correction: knowledgeEmbedCore.ts:142-147 is the one place that MERGES ai_features (`const feats = { ...(lib?.ai_features ?? {}) }`), which means saveLibraryAiFeatures's whole-column replace also silently drops the `embedBuild` marker — a second casualty of the same non-merging update. Also worth noting the panel is advertised from three other surfaces that can never reach it (app/api/knowledge/ask/route.ts:1105 tells the user "the full tag list is in the library's Drawing intelligence panel").

**Done when.**

- [ ] `drawingIntel` is included in the `saveLibraryAiFeatures` payload in LibraryAiModal.save(), so ticking the box and saving makes the panel appear on reload
- [ ] `saveLibraryAiFeatures` either merges into the existing `ai_features` JSON or the call site is required to pass the complete object (e.g. by dropping `?` from the interface fields or taking a full-object parameter), so a partial payload can never silently erase a stored key
- [ ] The two copy references that point at Drawing Intelligence (EquipmentTablePanel.tsx:47, SemanticIndexPanel.tsx:166) name a control that exists on the surface the reader is looking at

---

<a id="hub-2"></a>

## HUB-2 · Whoever opens the Skills page first permanently owns every built-in skill — RLS then lets a Viewer disable the org's reasoning and connection skills

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/answerSkills.ts:46-71`, `lib/linkRules.ts:57-82`, `supabase/migrations/20261016_reasoning_skills.sql:51-58`, `supabase/migrations/20261015_connection_skills.sql:62-70`, `app/(protected)/intelligence/skills/page.tsx:68-79`, `app/(protected)/intelligence/skills/page.tsx:162-173`, `components/intelligence/ConnectionSkillsPanel.tsx:50-58`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed end to end, including the exploitability the finding rests on: `mayManage = canManageOrg || mine` is duplicated at ConnectionSkillsPanel.tsx:111-112, so a Viewer who happened to be first through the door can flip the org's built-in reasoning and connection skills off (delete is blocked for built-ins in the UI by the `!opts.builtin` guard, but the RLS DELETE policy would still permit it directly).

**Mechanism.** `seedBuiltinAnswerSkills(orgId, userId)` inserts every built-in with `created_by: userId` (answerSkills.ts:68) — the uid of whoever happens to load the page first. `seedBuiltinRules` does the identical thing (linkRules.ts:79). The skills page seeds unconditionally on mount for any authenticated member: `useEffect(... await Promise.all([seedBuiltinRules(activeOrgId, uid), seedBuiltinAnswerSkills(activeOrgId, uid)]) ...)` with no role check (skills/page.tsx:68-79). The RLS UPDATE policy is `USING (is_org_controller(org_id) OR created_by = auth.uid())` (20261016:51-54, and identically 20261015:62-65), so that seeder now holds write authority over all org built-ins forever. The UI agrees: `mayManage = canManageOrg || mine` and the On/Off control is gated only on `mayManage` (skills/page.tsx:246, 263, 162-173) — unlike the delete/visibility buttons, which are additionally gated on `!opts.builtin` (line 145).

**Failure scenario.** A brand-new workspace. A field engineer with role Viewer (or Contractor, Manager, Supervisor) types /intelligence/skills into the URL bar — the route has no role guard, `app/(protected)/layout.tsx` gates only on membership. The six built-in Reasoning Skills and the built-in Connection Skills seed with `created_by` = that person's uid. From then on, every card shows them a live On/Off toggle. They switch off "Basis of Design" and "Change Impact Review" because they don't recognise them. Every teammate's answers silently lose those disciplines, and no Admin can see who did it — the card still reads "Ships with the engine" (skills/page.tsx:143). RLS also permits that member to DELETE the built-in rows outright; only the UI declines to offer the button.

**Evidence.**

```
answerSkills.ts:60-70 — `await supabase.from("answer_skills").insert(want.map((b) => ({ org_id: orgId, builtin_key: b.builtin_key, ..., enabled: true, visibility: "org", created_by: userId, })));`. 20261016_reasoning_skills.sql:51-54 — `CREATE POLICY answer_skills_update ON answer_skills FOR UPDATE USING (is_org_controller(org_id) OR created_by = auth.uid())`. skills/page.tsx:246-247 — `const mine = r.created_by === uid; const mayManage = canManageOrg || mine;` then :263 `{toggleButton({ id: r.id, enabled: r.enabled, mayManage, onToggle: ... })}`. Verified the second seeding entry point independently: ConnectionSkillsPanel.tsx:54 `await seedBuiltinRules(activeOrgId, uid);` — mounted on /admin/proposed-links, which is the "Review" tab shown to every member in the strip.
```

**Chain reaction.** There are two independent seeding entry points (the Skills tab and the Review tab's ConnectionSkillsPanel), so the ownership can be claimed from either. The sidebar hides Intelligence from Viewer/Contractor (Sidebar.tsx:247-250) but the ViewTabs strip and direct URLs do not, so hiding the nav is not the guard it looks like.

> **Verifier correction.** The "Viewer" framing is overstated: components/navigation/Sidebar.tsx:246-249 filters the work nav for `activeRole === 'Viewer' || activeRole === 'Contractor'` down to Home/Documents/Drafting Requests/Projects, so a Viewer has no Intelligence link and would have to reach /intelligence/skills or /admin/proposed-links by direct URL. The realistic seeder-owner is any non-controller member who DOES see the Intelligence entry (Engineer/Manager/Supervisor). The defect and the consequence are unchanged; only the named role should be broadened to "any non-controller member".

**Done when.**

- [ ] Built-in skills seed with `created_by: null` (or a sentinel), so authorship-based write access applies only to skills a member actually authored
- [ ] Seeding is not triggered by a non-controller page load — either the seed runs server-side/on org creation, or the client seed is gated on `canManageOrg`
- [ ] Toggling a `builtin_key` skill requires `is_org_controller` in both the RLS policy and the UI gate, matching the existing delete/visibility treatment

---

<a id="hub-3"></a>

## HUB-3 · A brand-new org's front door offers no first step — the only order-of-operations navigator is invisible from the Intelligence hub and buried in a collapsed Admin drawer

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/intelligence/page.tsx:302-308`, `app/(protected)/intelligence/page.tsx:190-235`, `components/navigation/ViewTabs.tsx:106-114`, `components/navigation/Sidebar.tsx:143`, `components/navigation/Sidebar.tsx:252-253`, `app/(protected)/setup/page.tsx:109-188`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the one surface that answers "what do I do first" is unlinked from the AI front door, admin-only in the nav, and inside a drawer that starts collapsed.

**Mechanism.** /setup is the real onboarding surface: seven ordered stages (codebook → registry → documents → bridge → knowledge → connections → process), each with live counts and a "Continue here" marker computed from `stages.findIndex((s) => !s.checks.every((c) => c.ok))` (setup/page.tsx:190). The Intelligence hub never mentions it. `INTELLIGENCE_VIEWS` has no /setup tab (ViewTabs.tsx:106-114); the four JumpCards go to /assistant, /knowledge, /graph and /intelligence/setup (page.tsx:304-307); no status card links to it. /setup appears only in the Sidebar's `admin` array (Sidebar.tsx:253), which is built only when `isAdmin = activeRole === 'Admin' || activeRole === 'DocCtrl'` (line 209) and lives in a section that is closed by default: `useState<Set<string>>(new Set(['admin']))` (line 143).

**Failure scenario.** Day one of a new workspace. A DocCtrl clicks Intelligence. The status board shows: Chat key ✗ "No key saved — questions can't run" → Add key; Embeddings key ✗; Knowledge ✗ "Nothing indexed — the AI has nothing to read yet" → Upload documents; Database ✓ or Meaning index. "Waiting on you": "Nothing pending." "Recent questions": "Nobody has asked anything yet. Ask the first question — try 'what do we have on E-101?'". They click that, land on /assistant with no key and no indexed documents, and get an error. Nothing on the page says the actual first move is the Site Codebook, or that documents must be brought under control before the bridge can run, or that /setup exists and will resume from wherever they are. The two pages are also both called "Setup" — /intelligence/setup (the Setup tab, keys and caps) and /setup ("Setup navigator") — so even a user who finds the second one has no way to tell from the name which is which.

**Evidence.**

```
intelligence/page.tsx:302-307 — `<JumpCard href="/assistant" .../> <JumpCard href="/knowledge" .../> <JumpCard href="/graph" .../> <JumpCard href="/intelligence/setup" title="Setup" body="Keys, usage caps, playbooks, codebook — all configuration." />`. Sidebar.tsx:143 — `const [closedSections, setClosedSections] = useState<Set<string>>(new Set(['admin']));`. Sidebar.tsx:252 — `const admin: NavLeaf[] = isAdmin ? [{ label: 'Facility setup', href: '/setup', ... }, ...] : [];`. Confirmed by a second search shape: `grep -rn "/setup" components/navigation/Sidebar.tsx` returns line 253 only; `grep -n "ViewTabs" app/(protected)/setup/page.tsx` returns nothing, so /setup does not even carry the hub strip back.
```

**Chain reaction.** lib/featureAtlas.ts:111 does list Facility setup, so the command palette can find it — but only for someone who already knows to search for it. The hub's own copy at intelligence/page.tsx:3-10 claims it answers "what is it waiting on from me?", which is exactly what /setup computes and the Overview does not.

> **Verifier correction.** One real mitigation the finding missed, found by a second search shape (`grep -n "href:" lib/featureAtlas.ts` plus reading the entries): /setup IS in the feature atlas — lib/featureAtlas.ts:111-113, `label: "Facility setup", href: "/setup"`, with aliases including "setup", "onboarding", "getting started", "what now", "next step" — and GlobalCommandPalette.tsx:251-256 renders atlas hits under a "Place" badge, with lib/__tests__/featureAtlas.test.ts:29 asserting `searchAtlas("what now")[0]?.href === "/setup"`. So it is discoverable through the command palette by a user who thinks to open it. That is a discoverability path, not a front-door prompt, so the finding stands — but at MEDIUM, and "invisible" should read "absent from every visual navigation surface except the collapsed Admin drawer".

**Done when.**

- [ ] /intelligence surfaces the first incomplete setup stage (or at minimum a prominent link to /setup) when the workspace has no libraries, no assets, or no codebook entries
- [ ] The two "Setup" surfaces are distinguishable by name — e.g. the Intelligence tab reads "AI keys" and /setup keeps "Facility setup"
- [ ] /setup carries the Intelligence ViewTabs strip, or is reachable from the hub without opening a collapsed admin section

---

<a id="hub-4"></a>

## HUB-4 · Copy says six tabs; there are seven — and the sidebar hint omits the Skills library entirely

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/navigation/ViewTabs.tsx:104-114`, `app/(protected)/intelligence/page.tsx:3-5`, `components/navigation/Sidebar.tsx:237`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The facts are all correct, but two of the three cited locations are source comments that no user ever sees; the only user-visible defect is the Sidebar hint omitting the Skill Library. That is a copy nit, not a MEDIUM — and the Skill Library is separately discoverable via the tab row itself (ViewTabs.tsx:111) and the command palette (lib/featureAtlas.ts:99-102, aliased to "skills", "skill studio", "reasoning skills", …).

**Mechanism.** `INTELLIGENCE_VIEWS` holds seven entries (Overview, Ask, Knowledge, Graph, Review, Skills, Setup). The header comment directly above it still reads "One tool, six lenses". The Overview page's own doc comment enumerates the six and names Skills in none of them. The sidebar's hover hint — the one line describing what Intelligence contains — is "AI in one place — ask, knowledge, graph, link review, setup", which drops both Overview and Skills. Skills was added later (the Skill Library page) and the three descriptions of the tool were never updated.

**Failure scenario.** A user hovering the sidebar to decide whether Intelligence is where their answer lives is told the tool contains ask/knowledge/graph/link review/setup. The Skill Library — the surface where reasoning disciplines and the org's own numbering detectors are authored, and arguably the highest-leverage thing in the hub — is not in that list. They never open it. The stale prose also means the next person reading the code is told the hub has six tabs while looking at seven.

**Evidence.**

```
ViewTabs.tsx:104-114 — comment `// One tool, six lenses: everything AI lives here.` immediately above an array of seven `{ label: ... }` entries including `{ label: "Skills", href: "/intelligence/skills", icon: Puzzle }`. intelligence/page.tsx:4-5 — `// system never had. Six tabs (Overview · Ask · Knowledge · Graph · Review · // Setup) make one tool out of what used to be six scattered surfaces.` Sidebar.tsx:237 — `hint: 'AI in one place — ask, knowledge, graph, link review, setup'`.
```

**Done when.**

- [ ] The sidebar hint names every tab in INTELLIGENCE_VIEWS, Skills included
- [ ] The "six lenses"/"Six tabs" comments match the array, or drop the count so they cannot drift again

---

<a id="hub-5"></a>

## HUB-5 · Every fix CTA on the status board lands on a list page rather than the control that fixes it

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/intelligence/page.tsx:209-233`, `app/(protected)/knowledge/page.tsx:108-142`, `components/knowledge/SemanticIndexPanel.tsx:192-213`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. SURVIVES on substance for the two Knowledge-related CTAs, but the title's quantifier is false: the two key cards (page.tsx:190-204) point at `/intelligence/setup`, which renders `<KeyEditor …/>` and `<EmbeddingKeyEditor …/>` inline at setup/page.tsx:56-59 — the exact control that fixes them — and the Database CTA lands on the page hosting Database health. Two of five misroute, so LOW rather than MEDIUM.

**Mechanism.** The board's premise is stated in its own header comment: "Every ✗ links directly to its fix." Two of the four do not. "Knowledge — Nothing indexed" → `href="/knowledge" cta="Upload documents"`, but /knowledge is the shelf list; there is no upload there, and for a non-controller there is not even a New library button (knowledge/page.tsx:82-87, 114-117). "Meaning index — Index not built yet" → `href="/knowledge" cta="Build index"`, but the Build index button lives inside SemanticIndexPanel on /knowledge/[id] and is gated on `isController` (SemanticIndexPanel.tsx:192).

**Failure scenario.** A Manager sees "Nothing indexed — the AI has nothing to read yet" with a button reading "Upload documents". They click it and arrive at an empty-state card that tells them "Admin or Doc Control can create libraries of standards and reference PDFs that everyone can then query" — with no action available. The CTA promised an action their role cannot perform and the destination could not have offered anyway. Same for "Build index": the destination has no such control at any role.

**Evidence.**

```
intelligence/page.tsx:3-10 — `// Every ✗ links directly to its fix.` intelligence/page.tsx:215 — `href="/knowledge" cta="Upload documents"`; :232 — `href="/knowledge" cta="Build index"`. knowledge/page.tsx:114-117 — `description={isController ? "Create a library, drop your standards ..." : "Admin or Doc Control can create libraries ..."} action={isController ? <Button ...>New library</Button> : undefined}`. SemanticIndexPanel.tsx:192 — `{isController && ( building ? ... : <Button size="sm" variant="secondary" onClick={() => void build()}><Brain/> Build index ...` .
```

> **Verifier correction.** The title is overstated — the body says it correctly. The two key cards (:206-217) point at /intelligence/setup, which does hold the key controls, so it is two of four CTAs that miss, not "every" one. Retitle to "Two of the four fix CTAs land on a list page rather than the control that fixes it".

**Done when.**

- [ ] The Knowledge and Meaning-index CTAs deep-link to a specific library (or open the create-library flow) rather than the shelf list
- [ ] A card whose fix the viewer's role cannot perform states who can, instead of offering a button that dead-ends

---

<a id="hub-6"></a>

## HUB-6 · Org Playbooks — the standing instructions folded into every AI prompt — has no sidebar entry, no tab, and no feature-atlas entry

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/intelligence/setup/page.tsx:67-71`, `app/(protected)/knowledge/[id]/page.tsx:1643-1647`, `lib/featureAtlas.ts:75-105`, `components/navigation/Sidebar.tsx:252-269`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, including the chicken-and-egg the summary points at: the knowledge-library link only appears once instructions already exist, so an org with zero playbooks has exactly one discoverable path (the controller-only block on the Setup tab) and the command palette cannot find it at all.

**Mechanism.** /admin/ai-instructions is linked from exactly four places: the Teach-the-workspace block on /intelligence/setup (line 68), the Site Codebook page (:799), the Equipment sweep modal (:150), and a conditional link in the library Ask header that renders only `{instructionCount > 0 && ...}` — i.e. only once instructions already exist. It is absent from the Sidebar's admin array (which lists 16 other admin destinations including Site codebook) and absent from `FEATURE_ATLAS`, which otherwise catalogues all seven Intelligence destinations plus every admin page, and which the command palette searches under a "Place" badge specifically so "nobody should have to remember where a feature lives" (GlobalCommandPalette.tsx:251-253).

**Failure scenario.** An Admin who configures their key from the Knowledge page's AI-settings modal rather than the Setup tab never sees the Teach-the-workspace block. They then search the command palette for "instructions", "playbook", "house rules" — the atlas has no entry, so nothing comes back. Meanwhile the library's own Ask box would advertise it, but only after someone has already written one. The feature that shapes every answer in the workspace is discoverable only by people who already know it exists.

**Evidence.**

```
Four differently-shaped searches: `grep -rn "ai-instructions" --include=*.ts --include=*.tsx app components lib` returns exactly 6 hits (the page itself, TopBar's breadcrumb label map, and the four links above). `grep -n "href:" lib/featureAtlas.ts` lists 33 entries; `/admin/ai-instructions` is not among them. knowledge/[id]/page.tsx:1643 — `{instructionCount > 0 && (<Link href="/admin/ai-instructions" ...>{instructionCount} standing instruction{...} apply</Link>)}` — the affordance is conditional on the feature already being in use.
```

**Done when.**

- [ ] `/admin/ai-instructions` has a FEATURE_ATLAS entry with plain-language keywords (playbook, house rules, standing instructions, tell the AI), so the command palette finds it
- [ ] The library Ask header points at playbooks even when `instructionCount === 0` — an empty state that invites the first one rather than hiding the door

---

<a id="hub-7"></a>

## HUB-7 · Status-board cards shimmer forever when their data source fails — the skeleton is the permanent state, and two of four failure paths are silent

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/intelligence/page.tsx:137-143`, `app/(protected)/intelligence/page.tsx:107-135`, `app/(protected)/intelligence/page.tsx:245-249`, `app/(protected)/intelligence/page.tsx:277-282`, `app/(protected)/intelligence/page.tsx:320-330`, `supabase/migrations/20261014_coverage_timeout_headroom.sql:3`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. supabase-js resolves (never rejects) on an RPC HTTP 500, so a semantic_coverage failure lands in the FIRST handler with r.data null → row null → no patch → coverageKnown stays false → the Meaning-index card shimmers permanently for any non-admin (schemaGaps is only ever set under `if (isAdmin)` at :145). Both coverage failure modes (the `() => undefined` reject arm and the null-row arm) are silent; the counts path at :132-134 at least sets `error`, and both key arms set keysKnown — so 2 of 4 silent is accurate. Migration 20261014_coverage_timeout_headroom.sql:1-9 confirms this RPC really does time out in the field.

**Mechanism.** Each card shimmers until its own `*Known` flag flips. The coverage call flips `coverageKnown` only inside the success branch AND only when a row comes back: `(r) => { const row = (r.data?.[0] ...) ?? null; if (row) patch({ chunksTotal: ..., chunksEmbedded: ..., coverageKnown: true }); }` — the rejection handler is `() => undefined` (page.tsx:137-143). No patch, no flag, no error surfaced. The counts block is a single `Promise.all` of four queries (libraries, documents, pending proposals, recent asks); `countsKnown: true` is set only after all four resolve, and the catch sets `error` but never `countsKnown` (page.tsx:107-135). StatusCard with `pending` renders only pulsing grey bars and returns before the CTA (page.tsx:320-330).

**Failure scenario.** A workspace where `semantic_coverage` is missing (pre-20260930) or times out — migration 20261014 exists specifically because it was timing out, its header saying the browser 'sees rpc/semantic_coverage 500 every time the intelligence page' loads. A non-admin opens /intelligence on a fresh browser (no localStorage snapshot). The fourth card pulses grey indefinitely with no title text, no error, and no way to learn that meaning-based search is off. Separately, if the `knowledge_questions` table is un-migrated, the whole `Promise.all` rejects: the Knowledge card, the "Waiting on you" panel and the "Recent questions" panel all shimmer permanently while a raw Postgres error string shows in a red banner. The board's stated purpose — "is the machine on?" — inverts: the one state it cannot express is "I could not find out".

**Evidence.**

```
intelligence/page.tsx:137-143 — `void supabase.rpc("semantic_coverage", { p_org_id: activeOrgId }).then((r) => { const row = ...; if (row) patch({ ..., coverageKnown: true }); }, () => undefined, );`. Contrast the key fetch at :97-104, which correctly patches `keysKnown: true` in BOTH handlers: `() => patch({ keysKnown: true })`. The pattern was applied to one source and not the other two. 20261014_coverage_timeout_headroom.sql:3 — "semantic_coverage gets its own statement-timeout headroom (25s)", i.e. it is known to be slow enough to fail.
```

> **Verifier correction.** "Permanent" is overstated. patch() writes the whole Status object to localStorage under `intel-status-${orgId}` (:86-88), and the snapshot read at :79 forces `coverageKnown: true, countsKnown: true, keysKnown: true`. So on any device that has ever completed one successful load, a later coverage failure shows a STALE value rather than a shimmer — which is a different (arguably worse, silently wrong) bug. The permanent-skeleton case is real only on a device with no snapshot: a first visit, a new browser, or a workspace where the RPC/migration is missing. Severity MEDIUM.

**Done when.**

- [ ] Every data source patches its `*Known` flag in its rejection handler, the way the key fetch already does at page.tsx:97-104
- [ ] A card whose source failed renders a stated "couldn't check" state with a retry, not an indefinite skeleton
- [ ] The counts block does not let one failing query blank three panels — settle the four independently (Promise.allSettled or separate calls)

---

<a id="hub-8"></a>

## HUB-8 · The Connection Skills list is implemented twice — two independent components, two seeding entry points, two divergent authority surfaces

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/intelligence/ConnectionSkillsPanel.tsx:34-199`, `app/(protected)/intelligence/skills/page.tsx:292-352`, `components/intelligence/ConnectionSkillsPanel.tsx:180-183`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on both halves. The Review-tab panel deletes a custom skill on a single click with no confirm and no undo, while the Skills page gates the identical deleteLinkRule call behind appConfirm. The duplication is real too: both files independently import listLinkRules/seedBuiltinRules/setLinkRuleEnabled/setLinkRuleVisibility/deleteLinkRule and both call seedBuiltinRules(activeOrgId, uid) in their own effect (panel :54, page :73), and the surfaces already diverge (panel shows 4 patterns and no author; page shows 3 patterns, author line, and the Reasoning shelf).

**Mechanism.** ConnectionSkillsPanel (on the Review tab) and the Connection Skills shelf (on the Skills tab) both call `listLinkRules`/`seedBuiltinRules`/`setLinkRuleEnabled`/`setLinkRuleVisibility`/`deleteLinkRule`, both render name + kind badge + builtin/visibility badge + pattern chips + On/Off + visibility flip + delete, and both mount SkillStudio. They differ in ways that matter: the Skills page wraps delete in an `appConfirm` ("Delete this skill? … stops running and its definition is gone", skills/page.tsx:98-107) while ConnectionSkillsPanel deletes with no confirmation at all (`const remove = async (r: LinkRule) => { ... await deleteLinkRule(r.id); ... }`, line 74-79). The panel then links across to the page it duplicates: "Skill library ↗".

**Failure scenario.** A DocCtrl on the Review tab expands Connection skills, means to toggle a custom detector off, and hits the adjacent trash icon. On the Skills page that would have raised a confirm dialog; here the skill is gone immediately, with no undo. Separately, any change to skill affordances has to be made in two files, and the seeding hazard in the second finding above has two doorways instead of one.

**Evidence.**

```
ConnectionSkillsPanel.tsx:74-79 — `const remove = async (r: LinkRule) => { setBusyId(r.id); try { await deleteLinkRule(r.id); await refresh(); } catch ... };` with the button at :151-155 calling `void remove(r)` directly. skills/page.tsx:98-107 — `const removeConfirmed = async (id, name, fn) => { const ok = await appConfirm({ title: "Delete this skill?", ... tone: "danger" }); if (!ok) return; await guard(id, fn); };`. ConnectionSkillsPanel.tsx:180-183 — `<Link href="/intelligence/skills">Skill library <ArrowUpRight/></Link>`.
```

> **Verifier correction.** Small scoping note: the unconfirmed delete in ConnectionSkillsPanel is only reachable for non-builtin rules (`{!r.builtin_key && mayManage && (...)}` at :140), so the one-click loss is a member-authored skill, not a built-in. That narrows the blast radius but not the divergence.

**Done when.**

- [ ] One implementation backs both surfaces (the panel renders a compact mode of the shelf), so authority gates and confirmations cannot diverge
- [ ] Deleting a skill raises the same confirmation wherever it is offered
- [ ] Built-in seeding happens in one place, not once per surface

---

<a id="hub-9"></a>

## HUB-9 · The Meaning-index card never renders for an Admin, and reads green at 1% coverage or with nothing indexed at all

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/intelligence/page.tsx:217-234`, `app/(protected)/intelligence/page.tsx:145-167`, `app/(protected)/intelligence/page.tsx:261-270`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The mechanism is real — the ternary at :217 means an Admin whose schema-health call succeeds gets the Database card in the coverage card's slot, and ok= is true at 1/400 embedded — but 'never renders for an Admin' is literally false: schemaGaps starts null, so the Meaning-index card DOES render until /api/admin/schema-health answers, and renders permanently if that fetch is non-ok (:160 `if (!res.ok) return;`). More importantly the scenario's own admin holds the embedding key, so the row at :261-270 does render for them and states '16 of 400 passages embedded' — the coverage number is not actually withheld. Downgrade to LOW: a green check on a partially-built index whose exact percentage is printed beside it.

**Mechanism.** The fourth slot is an either/or: `{s.schemaGaps !== null ? (<StatusCard title="Database" .../>) : (<StatusCard title="Meaning index" .../>)}` (page.tsx:217-234). `schemaGaps` starts null and is only ever set inside `if (isAdmin) { ... }` (line 145). So the Database card displaces the Meaning-index card for exactly the role that would act on it. When the Meaning-index card does render, its ok-test is `ok={s.chunksTotal > 0 ? s.chunksEmbedded > 0 : true}` — green at one embedded passage out of a hundred thousand, and green ("Builds after your first uploads") when nothing exists at all, sitting next to a Knowledge card that is simultaneously amber for the same emptiness.

**Failure scenario.** An Admin finishes uploading 400 standards. Embedding stalls at 4% because the Voyage free tier rate-limits. The Overview shows "Database — All expected tables present" and no coverage card at all. The one row that would have told them (page.tsx:261-270) is additionally gated on `!!s.embeddingKey` — so an Admin who has not personally saved an embeddings key sees no coverage signal anywhere on the board, while every teammate's answers quietly degrade to keyword-only.

**Evidence.**

```
intelligence/page.tsx:228 — `ok={s.chunksTotal > 0 ? s.chunksEmbedded > 0 : true}` with `okText={s.chunksTotal > 0 ? `${coveragePct}% of passages embedded` : "Builds after your first uploads"}`. Line 261 — `{s.chunksTotal > 0 && s.chunksEmbedded < s.chunksTotal && !!s.embeddingKey && ( ... Meaning index {coveragePct}% built ... )}`. Line 145 — `if (isAdmin) { void (async () => { ... patch({ schemaGaps: gaps }); ... })(); }`.
```

> **Verifier correction.** Two precision fixes. (1) "never renders for an Admin" is too absolute: `isAdmin` at :51 is `activeRole === "Admin"` only (DocCtrl is excluded and still sees the Meaning-index card), and the fetch at :156-166 returns early on `if (!res.ok) return;` or throws into an empty catch, leaving schemaGaps null — so an Admin whose schema-health call fails DOES see the Meaning-index card. Read it as "displaced for an Admin whenever the schema-health check answers". (2) The finding already cites the partial mitigation at :261-270 — a partially-built index does surface a "Meaning index N% built" row in Waiting-on-you, but only when `!!s.embeddingKey`, so the 1%-green card is genuinely the only signal for an org without an embeddings key.

**Done when.**

- [ ] Database health and Meaning index each hold their own slot rather than competing for one, so an Admin sees both
- [ ] The Meaning-index card is only green above a defensible coverage threshold, and reads as "not built" rather than green when `chunksTotal === 0`
- [ ] The "Meaning index N% built" row is not suppressed by the viewer's personal embeddings key — coverage is a library fact, not a per-user one

---

<a id="hub-10"></a>

## HUB-10 · The Overview's instant-paint snapshot is keyed by org, not by user — the previous person's per-user AI status is painted for the next one on a shared workstation

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `app/(protected)/intelligence/page.tsx:70-84`, `app/(protected)/intelligence/page.tsx:147-165`, `app/api/ai/connection/route.ts:99-105`, `components/providers/RoleContext.tsx:260-280`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The key fact holds: the localStorage snapshot is keyed by org only, yet chatKey/embeddingKey are strictly per-user, so on a shared device the next signer-in gets the previous user's masked key state painted as known (no shimmer), and the `() => patch({ keysKnown: true })` failure arm at :103 leaves those stale values standing as authoritative. But RoleContext.tsx:271-278 does purge every `intel-status-*` / `schema-gaps-*` key on SIGNED_OUT, and in the normal path the stale paint is overwritten within one round-trip by the real getAiConnections result. Exposure is a 4-character key suffix plus a boolean, transient, and inside the same org — LOW.

**Mechanism.** `const snapKey = `intel-status-${activeOrgId}`;` and `const gapsKey = `schema-gaps-${activeOrgId}`;` — org-scoped, with no uid component. The snapshot holds per-user facts: `chatKey`/`embeddingKey` (the API returns only this member's row — `effective: personal`, route.ts:99-105) and admin-only `schemaGaps`. On read the snapshot is trusted absolutely: `setStatus((prev) => prev ?? { ...snap, keysKnown: true, countsKnown: true, coverageKnown: true })` — the shimmer that exists precisely to prevent a false "No key saved" is suppressed for another account's data. The keys are cleared only on an explicit `SIGNED_OUT` event handled in a live tab (RoleContext.tsx:260-278).

**Failure scenario.** A control-room workstation shared by a shift. The DocCtrl uses /intelligence, closes the browser without signing out (session expires on its own, no SIGNED_OUT handler runs). The next operator signs in, opens Intelligence, and the board paints — instantly and with no shimmer — "Chat key: Claude/OpenAI key active · ····4f2a", "Embeddings key: Meaning-based search enabled", plus the DocCtrl's schema-health count and the org's recent question list. They believe their AI is configured. They go to Ask and it fails, because the key was never theirs. The board's own comment says the shimmer exists to avoid "a default that reads as a false 'No key saved'"; the snapshot produces the mirror-image lie.

**Evidence.**

```
intelligence/page.tsx:70 — `const snapKey = `intel-status-${activeOrgId}`;` and :79 — `setStatus((prev) => prev ?? { ...snap, keysKnown: true, countsKnown: true, coverageKnown: true });`. :147 — `const gapsKey = `schema-gaps-${activeOrgId}`;`. api/ai/connection/route.ts:83-84 — `.eq("org_id", orgId).eq("user_id", auth.userId)`, so `chatKey`/`embeddingKey` are strictly per-user. RoleContext.tsx:275 — the cleanup runs only inside `if (event === "SIGNED_OUT")`.
```

> **Verifier correction.** Downgrade the verification to SUSPECTED, because the stated scenario is largely mitigated and the residual path is not observable from the repo. RoleContext.tsx:268-278 deliberately sweeps every `intel-status-` and `schema-gaps-` key on SIGNED_OUT, with the comment "they must not outlive the account that fetched them", and all five sign-out call sites go through `supabase.auth.signOut()` (Sidebar.tsx:293, profile/page.tsx:78, layout.tsx:99, app/page.tsx:225, SubscriptionGate.tsx:109), which fires that event in the live tab. The leak therefore needs an account switch where SIGNED_OUT never reaches a live tab (browser closed on an expired session, storage cleared out-of-band). The leaked content is also masked (last-4 only) plus a schema-gap count, and is normally overwritten within a second by the real fetch.

**Done when.**

- [ ] Both localStorage keys include the uid (e.g. `intel-status-${uid}-${orgId}`), so a snapshot can never be read by a different account
- [ ] The snapshot carries the uid it was written under and is discarded on mismatch, rather than relying on a sign-out handler having run

---

<a id="hub-11"></a>

## HUB-11 · The hub's most-used page drops the hub — /knowledge/[id] is the only Intelligence surface with no ViewTabs strip

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/knowledge/[id]/page.tsx:1600-1616`, `app/(protected)/knowledge/page.tsx:72`, `app/(protected)/assistant/page.tsx:131`, `app/(protected)/graph/page.tsx:444`, `app/(protected)/admin/proposed-links/page.tsx:155`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Factually correct — /knowledge/[id] is the one Intelligence surface with no tab strip. But it is not navigationally stranded: a labelled back-link to /knowledge sits in the header, so the cost is one extra click, not a dead end, and every other detail page in the app (documents/[libraryId], assets/[tag]) follows the same eyebrow-not-tabs convention. Consistency nit → LOW.

**Mechanism.** Every other tab target renders `<ViewTabs title="Intelligence" tabs={INTELLIGENCE_VIEWS} />`. The library detail page — where asking, uploading, sources, the semantic index and (nominally) drawing intelligence all live — renders `<PageShell><PageHeaderBar .../>` with no strip. Its only way back is an eyebrow button to /knowledge. The graph page also drifts: `<ViewTabs tabs={INTELLIGENCE_VIEWS} />` with no `title`, so the "INTELLIGENCE" label vanishes on that one page.

**Failure scenario.** A user is deep in a library reading a cited answer and wants the graph, or Review, or Skills. The tab strip they used to get here is gone. They go back to /knowledge, then across the strip — two extra navigations on the page people spend the most time on. The tool that was consolidated into "one tool, several views" stops being one tool at exactly the point of most engagement.

**Evidence.**

```
`grep -n "ViewTabs" app/(protected)/knowledge/[id]/page.tsx` returns nothing; the same grep returns a render line for /assistant (:131), /graph (:444), /knowledge (:72), /admin/proposed-links (:155), /intelligence (:179), /intelligence/setup (:38) and /intelligence/skills (:189). knowledge/[id]/page.tsx:1600-1603 — `<PageShell> <PageHeaderBar icon={BookOpen} eyebrow={<button onClick={() => router.push("/knowledge")} ...><ArrowLeft className="w-3 h-3" /> Knowledge</button>} ...`.
```

**Done when.**

- [ ] /knowledge/[id] renders the Intelligence ViewTabs strip like every other surface in the tool
- [ ] /graph passes `title="Intelligence"` so the strip is labelled identically everywhere

---

<a id="hub-12"></a>

## HUB-12 · Three surfaces name the same checkbox three different ways, and two of them route the reader through a panel that cannot render

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/knowledge/LibraryAiModal.tsx:213-216`, `components/knowledge/SemanticIndexPanel.tsx:158-168`, `components/knowledge/DrawingIntelPanel.tsx:432-436`, `components/knowledge/EquipmentTablePanel.tsx:45-49`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on both clauses. A grep for the exact strings shows 'These are CAD exports or scans' exists nowhere but SemanticIndexPanel's own advice text — the real label is 'Text doesn't extract from these files'. And both SemanticIndexPanel (:163 'run Rebuild index under Drawing intelligence') and EquipmentTablePanel (:47 'use the CSV export in Drawing intelligence') send the reader to a panel that is not mounted unless aiFeatures.drawingIntel === true, and which returns null when nothing was extracted — precisely the failure state that produces the advice.

**Mechanism.** The vision-indexing control is literally labelled "Text doesn't extract from these files — index every page as an image" (LibraryAiModal.tsx:214-216). SemanticIndexPanel's zero-passages empty state instructs: `Turn on <b>"These are CAD exports or scans"</b> in Library AI setup, run <b>Rebuild index</b> under Drawing intelligence, then come back here.` DrawingIntelPanel's own footer calls it a third thing: "Turn on <b>Index every page with AI vision</b> in Library AI setup and rebuild". Neither of the quoted names exists in the modal. Both of the routes that say "under Drawing intelligence" point at a panel gated on a flag that can never be set (see the first finding).

**Failure scenario.** A DocCtrl uploads an AutoCAD SHX-font drawing set. It indexes to almost nothing. SemanticIndexPanel correctly diagnoses it and gives the exact remedy — in words that appear nowhere in the product. The user opens Library AI setup, scans four checkboxes for "These are CAD exports or scans", does not find it, and closes the modal. Even if they guessed right, step two — "Rebuild index under Drawing intelligence" — sends them to a panel that will not appear. The correct control ("Re-index all") is in the Documents header a few hundred pixels away and is never named.

**Evidence.**

```
LibraryAiModal.tsx:214-216 — `<span className="block text-xs font-bold ...">Text doesn&apos;t extract from these files — index every page as an image</span>`. SemanticIndexPanel.tsx:164-166 — `Turn on{" "}<b>&ldquo;These are CAD exports or scans&rdquo;</b> in Library AI setup, run{" "}<b>Rebuild index</b> under Drawing intelligence, then come back here.` DrawingIntelPanel.tsx:433-435 — `Turn on <b>Index every page with AI vision</b> in Library AI setup and rebuild`. EquipmentTablePanel.tsx:47 — `showing the first 400 — use the CSV export in Drawing intelligence for the full set`.
```

> **Verifier correction.** Add a fourth dangling pointer found on a wider search: app/api/knowledge/ask/route.ts:1105 instructs the model to tell users "The full tag list is in the library's Drawing intelligence panel (equipment register export)" — the AI itself is scripted to send users to the unreachable panel.

**Done when.**

- [ ] All instructional copy quotes the checkbox by its actual on-screen label
- [ ] No instruction routes a reader through Drawing intelligence for an action that lives elsewhere — the general re-index is named as "Re-index all" in the Documents header, where page.tsx:1835-1838 says it was deliberately moved

---
