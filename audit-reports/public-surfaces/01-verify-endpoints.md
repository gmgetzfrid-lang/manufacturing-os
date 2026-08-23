# 01 · The public verify endpoints

**14 findings** — 1 CRITICAL · 2 HIGH · 11 MEDIUM.

Unauthenticated. What each returns to someone holding only a scanned code.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| UUID-keyed entry points. Every public verify surface is keyed on a gen_random_uuid() primary key (documents.id, document_versions.id, document_holds.id, work_packages.id, tickets.id) and every route validates it against a strict UUID_RE before touching the DB. IDs are genuinely unguessable; there is no sequential-id enumeration path through /api/verify*, and mixed doc/version ids are rejected with a clean 404 (verify/route.ts:60-63). | `app/api/verify/route.ts:19,29-31,60-63; supabase/migrations/20260612_phase5_holds.sql:46; supabase/migrations/20260825_work_packages_acks.sql:22` | The enumeration risk on these four endpoints is entirely inherited from /d/[number] (already reported as DACL-3), not from the verify routes themselves. Do not 'fix' them by adding a second secret; fix the oracle. |
| publicOrigin() — every printed QR is built on NEXT_PUBLIC_SITE_URL, not window.location.origin, so a print made from a preview deploy still resolves against production instead of dead-ending on a Vercel auth wall. | `lib/publicOrigin.ts:17-21; used at lib/physicalBridge.ts:51-53, lib/downloads.ts:97` | This is the single most load-bearing correctness detail in the physical bridge and it is right. Any refactor of the QR builders must keep it. |
| No global auth middleware exists (no middleware.ts anywhere in the repo), and app/verify*, app/d, app/share, app/submit, app/transmittal sit outside the (protected) route group. The four verify pages are genuinely reachable with no session — the design intent is actually implemented. | `app/ (route groups); absence of /home/user/manufacturing-os/middleware.ts` | The 'no login wall in the field' promise is real. Any future middleware matcher must explicitly exempt /verify, /verify-hold, /verify-package, /verify-ticket, /d or every printed QR in the plant breaks at once. |
| handlePrintPack re-pins the whole package immediately before building the cover sheet, so paper and pins agree by construction at the moment of printing. | `app/(protected)/packages/page.tsx:157-176` | This is the correct half of the work-package tripwire and must be preserved; the defect is that the same re-pin is also reachable WITHOUT a print (finding 1). |
| refreshWorkPackage checks every single pin write and throws on a zero-row match rather than reporting success — the exact supabase-js {error}-not-thrown trap the earlier audits found six times, handled correctly here, with a comment naming the past incident. | `lib/workPackages.ts:206-228` | A worked example of the correct write-verification pattern for the rest of the codebase to copy. |
| effectiveStatusFor() / daysUntilEffective() — a single canonical, unit-tested helper for 'is this revision in force yet', using local-midnight date arithmetic. | `lib/effectiveDate.ts:21-36; lib/__tests__/effectiveDate.test.ts` | The public verify endpoint reimplements this instead of calling it (finding 8). The helper is the right answer; the fix is to import it. |
| Four in-repo canonical 'not current' status lists that all agree with each other and all include Void: NOT_CURRENT_STATUSES, staleCopies, the doc-control register filter, and viewerStatusBadge. | `lib/aiBoundary.ts:25; lib/staleCopies.ts:76; lib/docControlRegister.ts:101; lib/downloads.ts:52-68` | The vocabulary is settled everywhere except the two public field endpoints (finding 2). Fixing those means importing one of these, not writing a fifth list. |
| A working per-IP throttle pattern already exists (signup_attempts + clientIp + fail-open on missing table), with the reasoning written down. | `app/api/auth/signup/route.ts:10-33` | Finding 13 needs no new infrastructure and no new vercel.json cron entry — this is the template. |


---


<a id="vfy-1"></a>

## VFY-1 · A VOIDED drawing scans GREEN "CURRENT" — the public verify endpoints use a two-value retired set while four other places in the repo use the three-value one that includes Void

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify/route.ts:89-90`, `app/api/verify-package/route.ts:56`, `lib/aiBoundary.ts:25`, `lib/staleCopies.ts:76`, `lib/docControlRegister.ts:101`, `lib/downloads.ts:52-68`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Right, and reachable: `Void` is a first-class document status (types/schema.ts:613) offered in the status dropdown at components/documents/MetadataEditor.tsx:9/394. app/verify/[docId]/page.tsx:106 only special-cases Superseded/Archived too, so a Void document renders the full-screen emerald 'CURRENT — This print matches the current revision.' CRITICAL stands.

**Mechanism.** `const docRetired = d.status === "Superseded" || d.status === "Archived";` (verify/route.ts:89) and `const retired = d?.status === "Superseded" || d?.status === "Archived";` (verify-package/route.ts:56). The documents.status vocabulary is `["Draft","Issued","Superseded","Void","Archived","Locked"]` (components/documents/MetadataEditor.tsx:9). Every other consumer of that vocabulary in the repo treats Void as not-current: `NOT_CURRENT_STATUSES = new Set(["Superseded", "Void", "Archived"])` (aiBoundary.ts:25), `if (d.status === "Archived" || d.status === "Superseded" || d.status === "Void") continue;` (staleCopies.ts:76), `.or("status.is.null,status.not.in.(Draft,Superseded,Void,Archived)")` (docControlRegister.ts:101), and `case "Void": return { label: "Void", tone: "danger" };` (downloads.ts:62-63). The two public endpoints are the only places the list is short. A grep for 'Void' across app/api/verify*, app/api/verify-hold, app/api/verify-package, app/api/verify-ticket and all four page.tsx returns zero matches. This is the 'facility vocabulary hardcoded in application code' pattern the earlier audits flagged, now on the one surface where a wrong answer reaches a worker with a wrench.

**Failure scenario.** A P&ID is Voided — the drawing was issued in error, or the equipment it shows was never installed. Its current_version_id is unchanged and its status is 'Void', not 'Superseded'. A contractor scans the QR on his copy. /api/verify computes docRetired=false, isCurrent = versionId === current_version_id = true, and returns isCurrent:true. The page paints full-screen emerald with a 24px check mark, 'CURRENT — This print matches the current revision.' In the app the same document shows a red 'Void' badge (viewerStatusBadge, downloads.ts:62-63). The same voided sheet inside a work package returns retired:false, fresh:true, and contributes to 'PACK IS CURRENT'.

**Evidence.**

```
app/api/verify/route.ts:89-90 — `const docRetired = d.status === "Superseded" || d.status === "Archived";` / `const isCurrent = !docRetired && (!versionId || versionId === d.current_version_id);`  |  app/api/verify-package/route.ts:56 — `const retired = d?.status === "Superseded" || d?.status === "Archived";`  |  lib/aiBoundary.ts:25 — `export const NOT_CURRENT_STATUSES: ReadonlySet<string> = new Set(["Superseded", "Void", "Archived"]);`  |  components/documents/MetadataEditor.tsx:9 — `const DOCUMENT_STATUSES = ["Draft", "Issued", "Superseded", "Void", "Archived", "Locked"];`  |  grep for 'Void' across all eight verify files: ZERO MATCHES.
```

**Done when.**

- [ ] Both /api/verify and /api/verify-package import NOT_CURRENT_STATUSES from lib/aiBoundary.ts (or a shared lib/documentStatus.ts) instead of open-coding the comparison
- [ ] The verdict is computed by allow-list ('Issued'/'Locked' can be green) rather than by deny-list, so a status added later defaults to not-green
- [ ] A test asserts that status='Void' with versionId === current_version_id yields isCurrent:false / fresh:false

---

<a id="vfy-2"></a>

## VFY-2 · "Refresh pins" silently flips every already-printed work pack from red STALE to green PACK IS CURRENT — the tripwire is disarmed by a click, with the paper unchanged in the field

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify-package/route.ts:39-63`, `lib/workPackages.ts:192-228`, `app/(protected)/packages/page.tsx:108-128`, `lib/physicalBridge.ts:275`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: a repo-wide grep for `printed_at`/`last_printed` finds nothing, so no data anywhere records what the paper says. One correction to the wording: it is not fully 'silent' — the confirm dialog (packages/page.tsx:112-114) and the success toast (:121) both say 'then re-print the pack so the paper matches'. The tripwire is still disarmed with no technical trace, so HIGH stands.

**Mechanism.** The QR on a printed cover sheet encodes ONLY the package UUID — `qrPng(doc, `${origin()}/verify-package/${input.packageId}`)` (physicalBridge.ts:275). There is no print token, no print timestamp, no manifest hash. /api/verify-package therefore computes freshness from two LIVE values: `fresh: !retired && !!r.pinned_version_id && r.pinned_version_id === (d?.current_version_id ?? null)` (route.ts:61), where `r.pinned_version_id` comes from work_package_documents at read time. refreshWorkPackage() rewrites exactly that column for every member — `.update({ pinned_version_id: (d?.current_version_id as string | null) ?? null, pinned_rev_label: ... })` (workPackages.ts:212-219) — so after a refresh, pinned_version_id === current_version_id for every sheet by construction, staleCount becomes 0, and allFresh becomes true. handlePrintPack calls refresh-then-print together (packages/page.tsx:157-176), but handleRefresh (packages/page.tsx:108-128) is a separate 'Refresh pins' button (rendered at :293-299) that re-pins with nothing but an advisory string — 'then re-print the pack so the paper matches' (:113) and 'Re-print the pack.' (:122). Nothing enforces the reprint and nothing invalidates the QR already in the field.

**Failure scenario.** A pump-swap pack for U-200 is printed Monday with P&ID Rev 3. Tuesday an MOC issues P&ID Rev 4. The package owner opens /packages, sees '1 stale', clicks 'Refresh pins', confirms, and gets 'Package refreshed'. He does not reprint — the crew already has the folder. Wednesday morning the crew scans the cover sheet under the words 'SCAN BEFORE STARTING WORK. No login needed. Green = this pack is current.' The page returns allFresh:true and paints full-screen emerald: 'PACK IS CURRENT — Every sheet in this pack is still the current revision.' They break the line on a Rev 3 P&ID that Rev 4 re-routed. Before the refresh the same scan of the same paper was red 'PACK IS STALE'.

**Evidence.**

```
app/api/verify-package/route.ts:61 — `fresh: !retired && !!r.pinned_version_id && r.pinned_version_id === (d?.current_version_id ?? null),`  |  lib/workPackages.ts:212-219 — `.from("work_package_documents").update({ pinned_version_id: (d?.current_version_id as string | null) ?? null, pinned_rev_label: (d?.rev as string | null) ?? null, }).eq("id", r.id)`  |  app/(protected)/packages/page.tsx:122 — `showToast({ type: "success", title: "Package refreshed", message: "All pins moved to the current revisions. Re-print the pack." });`  |  lib/physicalBridge.ts:275 — `const qr = await qrPng(doc, `${origin()}/verify-package/${input.packageId}`);`  |  The design comment at supabase/migrations/20260825_work_packages_acks.sql:8-11 states the intent this breaks: 'A package pins the revision of each member document at assembly; if any member advances before the job closes, the package reads STALE'.
```

**Chain reaction.** The same live-membership read means sheets ADDED to the package after printing appear in the scan as fresh (addDocumentToPackage upserts pinned_version_id = current, workPackages.ts:181-189), inflating sheetCount and painting green while the crew's folder is physically missing that sheet; sheets REMOVED after printing vanish from the verdict while remaining in the folder. Both directions are invisible to the scanner.

> **Verifier correction.** "Silently" is wrong and should be struck: the flow warns twice — the appConfirm at page.tsx:111-116 says "Review what changed first if you haven't — then re-print the pack so the paper matches" and the success toast at :122 says "Re-print the pack." The button is also rendered only when `stale` is true (:291), and handlePrintPack refreshes-and-prints atomically so the normal path keeps paper and pins in sync. The defect is that the advisory is unenforced, not that the flip is unannounced — which is why I drop CRITICAL to HIGH: it requires a deliberate operator action taken against two on-screen instructions.

**Done when.**

- [ ] The printed cover sheet carries a per-print token (e.g. a row in a work_package_prints table recording package_id, printed_at, and the exact {document_id, version_id} manifest), and the QR encodes that token rather than the bare package UUID
- [ ] /api/verify-package resolves the token and compares the PRINTED manifest against each document's current_version_id, so re-pinning in the database cannot change the verdict for paper already issued
- [ ] A scan of a package UUID with no print token returns a non-green 'cannot confirm which printing this is' state rather than computing freshness from live pins
- [ ] Sheets present in the printed manifest but no longer in the package, and sheets in the package but not in the manifest, are both reported explicitly rather than silently folded into the live list

---

<a id="vfy-3"></a>

## VFY-3 · /verify/<docId> with no ?v= returns isCurrent:true unconditionally — and lib/downloads.ts stamps exactly that URL onto prints of documents with no current version

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify/route.ts:29-31,90`, `lib/downloads.ts:96-101`, `lib/docPack.ts:104-105`, `app/api/share/file/route.ts:114-115`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The mechanism is real and reachable (documents.current_version_id is nullable, schema.sql:144, while DocumentRecord.fileUrl is not, types/schema.ts:763, so a version-less document can still be printed). But 'unconditionally' is wrong — the docRetired guard at :89 still returns isCurrent:false for Superseded/Archived — and two of the four cited stamp sites actually GUARD against it: lib/docPack.ts:104-105 and app/api/share/file/route.ts:114-116 both emit `verifyUrl: undefined` when versionId is null rather than a bare /verify/<docId>. Only lib/downloads.ts produces the version-less URL, which narrows this to MEDIUM.

**Mechanism.** The guard at route.ts:30 is `if (!UUID_RE.test(docId) || (versionId && !UUID_RE.test(versionId)))` — `v` is optional. isCurrent at :90 is `!docRetired && (!versionId || versionId === d.current_version_id)`: with no versionId the second clause short-circuits TRUE, so the endpoint asserts the paper is current while holding no information whatsoever about which revision the paper is. printedRev comes back null and the page renders 'This print — Rev ?' in emerald beside the giant green CURRENT. buildVerifyUrl emits precisely this URL: `const version = ctx.versionId ?? ctx.doc.currentVersionId; ... return version ? `${base}?v=${version}` : base;` (downloads.ts:99-101) — currentVersionId is optional on DocumentRecord (types/schema.ts:638), and the verify route itself guards `if (d.current_version_id)` at :70, so the author knew it can be null. Two sibling call sites got this right by omitting the QR entirely when there is no version: docPack.ts:104 `versionId && publicOrigin() ? ... : undefined` and share/file/route.ts:114 `versionId && publicOrigin() ? ... : undefined`. downloads.ts does not.

**Failure scenario.** A document ingested without a version row (external-origin import, legacy attachment) is printed. buildVerifyUrl produces yourdomain/verify/<docId> with no ?v=. Anyone who scans it — forever, at any revision, past any number of subsequent rev-ups — gets full-screen emerald 'CURRENT — This print matches the current revision.' The stamp is a permanent green light. Independently, the truncation is trivially reachable by hand: a superseded print whose QR correctly shows red DO NOT USE flips to green the moment the query string is dropped, which is what happens when the URL is retyped from a photograph, bookmarked, or pasted through a system that splits on '?'.

**Evidence.**

```
app/api/verify/route.ts:90 — `const isCurrent = !docRetired && (!versionId || versionId === d.current_version_id);`  |  lib/downloads.ts:99-101 — `const version = ctx.versionId ?? ctx.doc.currentVersionId; const base = `${origin}/verify/${ctx.doc.id}`; return version ? `${base}?v=${version}` : base;`  |  lib/docPack.ts:104-105 — `verifyUrl: versionId && publicOrigin() ? `${publicOrigin()}/verify/${String(d.id)}?v=${versionId}` : undefined` (the correct guard)  |  app/api/verify/route.ts:70 — `if (d.current_version_id) {` (the route's own acknowledgement that it can be null).
```

**Chain reaction.** audit-reports/intelligence/06-document-acl-leaks.md:242 already noted that 'v' is optional, but framed it as a disclosure problem ('a document id alone is sufficient'). The verdict consequence — that the id-only form is not merely readable but affirmatively GREEN — is not covered there.

**Done when.**

- [ ] /api/verify requires both doc and v; a request with doc alone returns a 400 or a distinct 'cannot confirm which revision this print is' verdict, never isCurrent:true
- [ ] buildVerifyUrl returns undefined when no version can be resolved, matching lib/docPack.ts:104 and app/api/share/file/route.ts:114, so no print is stamped with an unqualifiable QR
- [ ] The page has no branch in which it prints 'Rev ?' next to a green CURRENT

---

<a id="vfy-4"></a>

## VFY-4 · "NOT YET IN EFFECT" drops hours early: /api/verify reimplements the effective-date comparison in server UTC instead of calling the repo's canonical local-date helper

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify/route.ts:91-94`, `lib/effectiveDate.ts:21-28`, `lib/docControlRegister.ts:187`, `supabase/migrations/20260819_effective_date.sql:17`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The divergence is real but the finding misdiagnoses the fix. effectiveStatusFor is RUNTIME-local, and this is a server route on a UTC host, so calling the canonical helper would compute the identical answer — the two only disagree because the register/badge call sites run in the browser (lib/docControlRegister.ts:187 uses the browser supabase client). A repo-wide grep for timezone/org-locale settings finds none, so there is no plant timezone to compare against; the actual defect is a one-day-boundary disagreement bounded by the UTC offset between the field page and the in-app badge. LOW.

**Mechanism.** `notYetEffective = isCurrent && !!effectiveDate && effectiveDate.slice(0, 10) > new Date().toISOString().slice(0, 10)` (route.ts:93-94). effective_date is a DATE column (20260819_effective_date.sql:17), so the left side is a calendar date in the plant's frame of reference. The right side is `toISOString()` — the SERVER's UTC calendar date. The repo already has the canonical answer, unit-tested, comparing at LOCAL midnight: `const today = new Date(); today.setHours(0, 0, 0, 0); const eff = new Date(`${effectiveDate.slice(0, 10)}T00:00:00`); if (eff.getTime() > today.getTime()) return "pending";` (effectiveDate.ts:23-27). The in-app register calls it (docControlRegister.ts:187); the public field endpoint does not. On a UTC host serving a US plant, the endpoint's 'today' rolls over 5-6 hours before the plant's does, and the comparison is `>` — strictly greater — so the amber guard releases early, never late.

**Failure scenario.** A revised operating procedure is issued with effective_date 2026-03-02 because it requires a training window. At 19:30 CST on 2026-03-01, a night-shift operator scans the print. The server's UTC date is already 2026-03-02, so '2026-03-02' > '2026-03-02' is false, notYetEffective is false, isCurrent is true, and the page paints emerald 'CURRENT — This print matches the current revision.' The banner the feature exists to show — 'NOT YET IN EFFECT ... until then, keep working to the prior in-force revision' — never appears. In the office the same document still shows its pending badge, because that path goes through effectiveStatusFor in the browser's local time.

**Evidence.**

```
app/api/verify/route.ts:91-94 — `// A published rev with a FUTURE effective date is the latest issue but is not yet in force — the field page must not flash an unqualified green.` / `const notYetEffective = isCurrent && !!effectiveDate && effectiveDate.slice(0, 10) > new Date().toISOString().slice(0, 10);`  |  lib/effectiveDate.ts:21-28 — the canonical `effectiveStatusFor`, using `today.setHours(0,0,0,0)` and `new Date(\`${effectiveDate.slice(0,10)}T00:00:00\`)`  |  grep for effectiveStatusFor across lib/app/components: called only from lib/docControlRegister.ts:187 and its test — never from the public endpoint.
```

**Chain reaction.** The same UTC-vs-local skew affects lib/effectiveDate.ts:62 `.lte("effective_date", todayISO())`, the daily scan that announces 'now in force' — it can fire the announcement on the evening before, matching the verify page's early green and making the two consistently wrong together rather than catching each other.

> **Verifier correction.** MEDIUM, not HIGH, and two framing points are off. (a) The blast radius is a window of hours on one day per effective date, after which the correct green verdict is what shows anyway. (b) 'The repo already has the canonical answer' oversells the fix: effectiveStatusFor is itself server-local, not plant-local, so calling it from a UTC-hosted route would produce the identical result; lib/effectiveDate.ts also imports lib/supabase and lib/inAppNotifications (:10-12), i.e. the browser client, so it is not directly importable into a route handler. The real fix is an org/plant timezone, which the repo does not appear to have — so 'the endpoint just failed to call the helper' misstates the remedy.

**Done when.**

- [ ] /api/verify imports effectiveStatusFor from lib/effectiveDate.ts rather than open-coding the comparison
- [ ] The comparison is made against the org's configured plant timezone, not the host's, so a UTC deployment and a plant in UTC-6 agree
- [ ] A test pins the clock to 19:30 local on the day before an effective date and asserts notYetEffective is true

---

<a id="vfy-5"></a>

## VFY-5 · /api/verify and /api/verify-package are blind to active holds — a document under a HOLD scans green while the hold card twenty feet away says the work is stopped

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify/route.ts:34-108`, `app/api/verify-package/route.ts:31-77`, `app/verify-hold/[holdId]/page.tsx:93-94`, `supabase/migrations/20260713_document_publish_guard.sql:70-79`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by reading both routes end to end. A hold blocks publication at the database level but is invisible to the two public endpoints the field actually scans, so a held drawing and its pack both render green while the printed hold card says stop.

**Mechanism.** Neither endpoint references document_holds. A grep for 'document_holds|hold' across app/api/verify/route.ts and app/api/verify-package/route.ts returns exactly one hit, and it is the word 'holding' inside a prose comment. Yet the hold concept is defined in this system as covering the work, not just the publish transition: the hold verify page's own copy is 'Do not advance this document or the work it covers' (verify-hold page.tsx:94), and the database refuses to advance a held document at all (20260713_document_publish_guard.sql:70-79). Three public surfaces therefore answer 'can I use this?' about the same document and only one of them knows about the hold — and it is the one keyed on a hold UUID that a field user only has if the tag is still attached and legible.

**Failure scenario.** An iso drawing goes on hold for 'Field Verification Needed' — the as-built does not match the field. The drawing is not superseded and no new revision exists, so current_version_id is unchanged. A crew scans their print: green CURRENT. They scan the work-package cover: green PACK IS CURRENT. Nothing in either answer mentions that the drawing is under an open hold placed precisely because it cannot be trusted. The hold's own tag is on the equipment in the field, not in the crew's folder.

**Evidence.**

```
grep -rn 'document_holds|hold' app/api/verify/route.ts app/api/verify-package/route.ts → one match, app/api/verify-package/route.ts:4, the word 'holding' in a comment. Zero code references.  |  app/verify-hold/[holdId]/page.tsx:94 — `? "Do not advance this document or the work it covers."`  |  supabase/migrations/20260713_document_publish_guard.sql:74-79 — `SELECT EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = NEW.id AND h.released_at IS NULL) INTO v_has_hold; IF v_has_hold THEN RAISE EXCEPTION 'Document has an active hold; ...'`
```

**Done when.**

- [ ] /api/verify returns an activeHolds count for the document and the page renders amber (not green) when it is non-zero, naming the hold categories
- [ ] /api/verify-package marks any sheet with an active hold as not-fresh, or reports holds as a separate non-green condition alongside staleness
- [ ] The three public surfaces give consistent answers about the same document being held

---

<a id="vfy-6"></a>

## VFY-6 · /api/verify-hold publishes the hold reason verbatim to the open internet, and the reason field accepts free text — the route's own comment claims free text is withheld

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify-hold/route.ts:46-56`, `components/documents/HoldStrip.tsx:190-203`, `supabase/migrations/20260612_phase5_holds.sql:26-33`, `app/verify-hold/[holdId]/page.tsx:110-113`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Right on both halves: the route withholds `notes` and `opened_by_name` but publishes `reason` verbatim to an unauthenticated endpoint, and `reason` is exactly the field the UI lets a controller type free text into. app/verify-hold/[holdId]/page.tsx:110-113 prints it under 'Reason' on the public page.

**Mechanism.** The route withholds notes, opened_by_name, released_by_name and released_reason, and says so: 'a photographed hold card must not disclose staff names or free-text operator notes ("waiting on legal re: incident …") to whoever scans it. Status, category, dates, and the doc label suffice' (route.ts:48-53). It then returns `reason: (h.reason as string) ?? null` (:55). But `reason` is not a category. The migration is explicit: 'reason is TEXT with NO check constraint. The four directive-named reasons ... live in the UI's predefined picker; orgs can also enter free-form reasons via "Other"' (20260612_phase5_holds.sql:26-33), and HoldStrip renders an unconstrained `<input ... placeholder="Custom hold reason">` whose value is passed straight to onOpen (HoldStrip.tsx:190-203, :81-88). The verify page then renders it in bold red as the card's most prominent fact (page.tsx:110-113). Alongside it the route publishes docLabel, which falls back to the document TITLE when document_number is null (`String(d.document_number || d.title || d.name || "")`, :43).

**Failure scenario.** Document Control places a hold with the custom reason 'Hold pending OSHA 1910.119 finding — Fuller incident, do not distribute'. printHoldCard produces the red tag; the tag hangs on a unit in an open yard for six weeks. A contractor, a visitor, a journalist, or anyone who photographs the tag scans the QR from outside the fence and, with no login, reads the reason string in bold, plus the drawing number or title, plus the revision, plus the date it was placed. The endpoint refused to show them the operator's note while showing them a field that the schema documents as accepting exactly that kind of note.

**Evidence.**

```
app/api/verify-hold/route.ts:55 — `reason: (h.reason as string) ?? null,`  |  app/api/verify-hold/route.ts:48-53 comment — 'a photographed hold card must not disclose staff names or free-text operator notes ... Status, category, dates, and the doc label suffice'  |  supabase/migrations/20260612_phase5_holds.sql:26-33 — '3. reason is TEXT with NO check constraint. ... orgs can also enter free-form reasons via "Other". The DB is intentionally permissive'  |  components/documents/HoldStrip.tsx:196 — `placeholder="Custom hold reason"` feeding :81-88 `const onOpen = async (reason: string) => { ... reason: reason.trim(), ... }`.
```

**Chain reaction.** This corrects the premise of the verifier note at audit-reports/intelligence/06-document-acl-leaks.md:252, which credited /api/verify-hold with deliberately withholding free text. It withholds one free-text column and publishes another.

> **Verifier correction.** The exposure delta is much smaller than 'publishes to the open internet' implies, and the finding omits the mitigating fact that decides severity: the printed hold card itself already prints the reason in plain text at 13pt bold red AND the free-text notes underneath it (lib/physicalBridge.ts:155-158 — `page.drawText(fit(`Reason: ${input.reason}`, …))` and `if (input.notes) page.drawText(fit(input.notes, …))`). Anyone positioned to scan or photograph the QR is reading that text on the tag regardless. What the endpoint adds is reachability by URL alone (a forwarded link, a photo cropped to the QR) — real, but a category-vs-free-text inconsistency in the route's own contract rather than a new disclosure channel.

**Done when.**

- [ ] The response returns the reason only when it matches the predefined picker vocabulary; a custom reason is reported as a generic category ('Other') to unauthenticated callers
- [ ] Either the reason column is split into reason_code (constrained) plus reason_text (never public), or the free-text path is closed
- [ ] The route comment is corrected to describe what is actually disclosed, including that docLabel falls back to the document title

---

<a id="vfy-7"></a>

## VFY-7 · /d/[number] is not punctuation-forgiving as documented, and silently redirects to a DIFFERENT drawing when the typed number is a substring of another

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/d/[number]/route.ts:19-36`, `app/d/[number]/route.ts:24-25`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves confirmed against the file's own header claim at :4-5 ('punctuation- and case-forgiving, same normalization as search'). Additional unclaimed exposure: the supabaseAdmin query at :27-32 is not scoped to any org, so the substring fallback can redirect to a document belonging to a different tenant.

**Mechanism.** Line 20 computes `norm` (lowercased, punctuation stripped) but the database query at :30 uses `raw` — `.ilike("document_number", `%${raw.replace(/[%_]/g, "")}%`)` — with punctuation intact. `norm` is only used at :35 as a tie-break among rows the punctuation-sensitive query already returned. So the comment at :24-25, 'Candidates by loose substring, then the exact normalized match wins (same punctuation-forgiving identity search uses)', describes behaviour that is not implemented: a user who types the number with different separators gets zero candidates and falls through. Separately, :36's fallback `?? (rows ?? [])[0]` redirects to the newest-updated row of a mere substring match when no exact normalized match is present in the window, and `.limit(25)` at :32 means a genuine exact match can be excluded from the window entirely by 25 more-recently-updated partial matches. There is no disambiguation page: the route always 307s to a single document.

**Failure scenario.** A technician reads '2002-D-10001' off a title block and types yourdomain/d/2002 D 10001 (or 2002_D_10001, or 2002.D.10001). The ilike pattern becomes %2002 D 10001% / %2002D10001% — no row matches, and he is dumped on /documents?q=... behind a login wall for a number the system holds. Worse case: he types the short form /d/10001. The ilike matches 2002-D-10001, 2003-P-100012 and SPEC-10001-A; the exact-normalized find fails (norm '10001' matches none of them exactly); the fallback redirects to whichever was updated most recently. He lands on a different drawing, deep-linked with ?doc=<id>, with no indication that the number he typed was not the number he got.

**Evidence.**

```
app/d/[number]/route.ts:20 — `const norm = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");`  |  :30 — `.ilike("document_number", `%${raw.replace(/[%_]/g, "")}%`)` — `raw`, not `norm`  |  :34-36 — `.find((r) => (r.document_number ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "") === norm) ?? (rows ?? [])[0] as { id: string; library_id: string } | undefined;`  |  :24-25 comment — 'Candidates by loose substring, then the exact normalized match wins (same punctuation-forgiving identity search uses); newest update first.'
```

**Chain reaction.** The same `?? rows[0]` fallback is the enumeration primitive already reported as DACL-3 in audit-reports/intelligence/06-document-acl-leaks.md:92-106 (unauthenticated, service-role, not org-scoped, hands out real document and library UUIDs that then feed /api/verify). This finding is the document-control half of the same three lines: even for a fully authorized user typing their own drawing number, the route can resolve to the wrong document — including another tenant's, since there is no org filter, in which case RLS then shows them an empty page for a drawing that exists in their own library.

> **Verifier correction.** HIGH is too strong. The route's own header comment at :6-7 is accurate — 'The target page enforces auth + RLS as always — this route only translates a number into a location; it reveals nothing' — so the failure mode is landing an authenticated user on the wrong document in the viewer, where the document number and title are displayed, not disclosing anything. Worth noting the finding missed the sharper problem on the same lines: the query runs through supabaseAdmin (:10, :26) with no org_id filter, so `rows[0]` can be another org's document id/library_id before RLS stops the target page.

**Done when.**

- [ ] The candidate query matches on a normalized column or expression (e.g. a generated normalized document_number with an index) so the punctuation-forgiving promise in the comment is actually what runs
- [ ] The `?? rows[0]` fallback is removed: zero exact normalized matches means the disambiguation/search page, never a silent redirect to a partial match
- [ ] More than one exact normalized match renders a chooser instead of picking by updated_at
- [ ] The query is scoped to the caller's org (which also closes the cross-tenant half of DACL-3)

---

<a id="vfy-8"></a>

## VFY-8 · A CLOSED work package still scans green "PACK IS CURRENT" — the verdict ignores packageStatus and closed_at entirely

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify-package/route.ts:65-76`, `app/verify-package/[packageId]/page.tsx:57-59,89-101`, `app/(protected)/packages/page.tsx:130-147`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The verdict-ignores-closure part is true, but 'ignores packageStatus and closed_at entirely' is not: page.tsx:97 appends `{result.closed ? " (This package has been closed.)" : ""}` to the sentence directly under the headline, so closure IS disclosed on the same screen. The green banner is also literally accurate — every sheet still is the current revision. That mitigation drops this to LOW.

**Mechanism.** `allFresh: sheets.length > 0 && staleCount === 0` (route.ts:73) is a pure revision comparison. packageStatus and closed are computed (:70-71) and returned, but the page's background colour and headline read only allFresh (`result?.allFresh ? "bg-emerald-600" : "bg-red-600"` at page.tsx:58; headline at :89-91). The closed state is demoted to a parenthetical appended to the sub-line: `{result.closed ? " (This package has been closed.)" : ""}` (page.tsx:100). Closing a package is described in the app as stopping the tripwire: 'A closed package stops watching its drawings and disappears from this list' (packages/page.tsx:133) and 'no longer watching its drawings' (:141). The public verdict does not stop.

**Failure scenario.** A turnaround job finishes and the package is closed. Months later the folder resurfaces in a shop drawer and someone scans the cover under 'SCAN BEFORE STARTING WORK'. The pins were never touched after closure, so staleCount is 0 and the phone fills with emerald 'PACK IS CURRENT — Every sheet in this pack is still the current revision', with the closure mentioned in eight words of small type at the end of a sentence. Because closure stops the rev-up notification (notifyPackagesOfRevUp targets OPEN/EXECUTING packages only, lib/workPackages.ts:246-249), the green is also the least trustworthy green in the system: nobody has been watching these drawings since the package closed.

**Evidence.**

```
app/api/verify-package/route.ts:73 — `allFresh: sheets.length > 0 && staleCount === 0,`  |  app/verify-package/[packageId]/page.tsx:58 — `loading || error ? "bg-slate-900" : result?.allFresh ? "bg-emerald-600" : "bg-red-600"`  |  app/verify-package/[packageId]/page.tsx:100 — `{result.closed ? " (This package has been closed.)" : ""}`  |  app/(protected)/packages/page.tsx:133 — `message: "A closed package stops watching its drawings and disappears from this list. Its record is kept."`
```

> **Verifier correction.** Trim the 'demoted to a parenthetical' framing — the closed state is disclosed, just not in the verdict: page.tsx:97 appends `{result.closed ? " (This package has been closed.)" : ""}` to the same bold sub-line directly under the headline, in the same white-on-colour type as the rest of the verdict copy, not buried in the card. Also note the verdict is not stale-blind for closed packs: pins are frozen at close, so any member that advanced afterwards still reads red. The genuine gap is a closed pack whose sheets happen not to have moved reading an unqualified PACK IS CURRENT.

**Done when.**

- [ ] A closed package produces its own verdict state (amber/grey 'PACKAGE CLOSED — this pack is retired, do not work from it') that is not green regardless of pin freshness
- [ ] packageStatus and closed drive the headline and background, not a trailing parenthetical
- [ ] The verdict acknowledges that a closed package's pins are no longer monitored, so freshness is not evidence

---

<a id="vfy-9"></a>

## VFY-9 · A never-issued DRAFT scans GREEN "CURRENT" — /api/verify has no concept of "issued", only of "not superseded"

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify/route.ts:89-90,103-106`, `app/verify/[docId]/page.tsx:99-110`, `lib/downloads.ts:52-68`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the only retirement test is Superseded/Archived, so a document whose status is Draft (or 'In Review', or 'Void' — all offered in components/documents/MetadataEditor.tsx:9 and BulkEditModal.tsx:32) with current_version_id set returns isCurrent:true, and app/verify/[docId]/page.tsx:99 renders 'CURRENT' on emerald with 'This print matches the current revision.' The narrated scenario is slightly off — a submit-for-review draft lands in pending_version_id, not current_version_id (lib/revisions.ts:1550, app/api/intake/upload/route.ts:330), so that particular version scans RED — but the template-filing path above produces exactly the claimed Draft-scans-green state, and Void scanning green is the same hole.

**Mechanism.** isCurrent is a pure deny-list: `!docRetired && (!versionId || versionId === d.current_version_id)` (route.ts:90). documents.status DEFAULT is 'Draft' (supabase/schema.sql, documents table). Any status outside {Superseded, Archived} — Draft, In Review, Void, Locked, or NULL — passes as green. The same repo already has the correct answer in a shared helper: viewerStatusBadge returns `{ label: "Draft — not issued", tone: "caution" }` for Draft and reserves 'Controlled' for Issued/Locked (downloads.ts:55-60). The public page then converts isCurrent:true into the strongest possible affirmative statement.

**Failure scenario.** An engineer downloads an in-progress Draft revision for markup. Because he does not hold the checkout, determineControlState returns 'uncontrolled' and the print is stamped 'UNCONTROLLED — FOR REVIEW ONLY' with a verify QR (downloads.ts:229-240). The paper reaches a contractor. He scans it, because the QR is the authority he was told to trust, and the phone fills with green: 'CURRENT — This print matches the current revision.' A drawing that has never been through review or approval has just been certified as current by the document-control system to an unauthenticated field user. docStatus is present in the JSON but the page only ever reads it in the not-current branch (page.tsx:106-110), so 'Draft' never appears on screen.

**Evidence.**

```
app/api/verify/route.ts:89-90 — `const docRetired = d.status === "Superseded" || d.status === "Archived"; const isCurrent = !docRetired && (!versionId || versionId === d.current_version_id);`  |  lib/downloads.ts:55-60 — `case "Issued": case "Locked": return { label: doc.rev ? `Controlled · Rev ${doc.rev}` : "Controlled", tone: "controlled" }; case "Draft": return { label: "Draft — not issued", tone: "caution" };`  |  app/verify/[docId]/page.tsx:100-102 — headline `{result.notYetEffective ? "NOT YET IN EFFECT" : result.isCurrent ? "CURRENT" : "DO NOT USE"}` with no Draft branch.
```

> **Verifier correction.** Overstated as HIGH. The paper that carries this QR is not silent about its status: the QR is only stamped on the uncontrolled branch (lib/downloads.ts:227-238 and :270-278 — determineControlState at :30-37 returns "controlled" only for the checkout holder, and the controlled branch is a pass-through with no stamp at all), so any print bearing this QR already carries the "UNCONTROLLED — FOR REVIEW ONLY" watermark and the footer "Rev X at time of issue — verify current revision before use" (buildFooterNotice, :81-89). The green sub-line at page.tsx:105 also says only "This print matches the current revision", which is literally true of a Draft. The defect is the missing not-issued branch, not a claim of controlled status.

**Done when.**

- [ ] isCurrent is an allow-list over the issued statuses (Issued, Locked) rather than a deny-list over Superseded/Archived
- [ ] A Draft or In Review document produces a distinct non-green verdict ('NOT ISSUED — this is not an approved revision'), not the red superseded copy and not green
- [ ] docStatus is surfaced on the page in every branch, so the field can see what state the document is actually in

---

<a id="vfy-10"></a>

## VFY-10 · A released HOLD card scans green "this tag can come down" while other holds on the same document are still active — the endpoint has document_id in hand and never asks

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify-hold/route.ts:28-32,54`, `app/verify-hold/[holdId]/page.tsx:92-95`, `supabase/migrations/20260612_phase5_holds.sql:20-24`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Factually correct — the endpoint has document_id in hand and never asks about sibling holds, and multiple concurrent holds are an explicit design goal. But the card is printed per hold (lib/physicalBridge.ts:150-171 stamps one `reason` and one holdId per card) and its own footer at :168 says 'A released hold shows GREEN when scanned — then this tag comes down', so 'this tag can come down' is literally true for that tag; the other hold's card is still hanging and still scans red. Missing-context enhancement rather than a wrong verdict — LOW.

**Mechanism.** `active: !h.released_at` (route.ts:54) is derived from the single hold row addressed by the URL. The route already loads `document_id` (route.ts:29) and already makes a second query against documents (route.ts:37-41) — it simply never queries document_holds for siblings. The holds migration states the opposite as the normal case: 'document_holds is a per-document log, NOT a single-column flag. Multiple holds can be open on the same document simultaneously (typical: "Awaiting Engineering" AND "Missing Vendor Data")' (20260612_phase5_holds.sql:20-24), and the partial unique index is on (document_id, reason) WHERE released_at IS NULL — explicitly permitting many concurrent holds per document. Each hold gets its own printed card (printHoldCard takes a single holdId, physicalBridge.ts:164), so a document with two holds has two red tags, and releasing one turns that tag's QR green.

**Failure scenario.** A vessel drawing carries two holds: 'Field Verification Needed' and 'Missing Vendor Data'. Two red HOLD cards hang on the equipment. Engineering releases the field-verification hold. Someone scans that card and gets full-screen emerald, 'RELEASED — This hold has been released — this tag can come down.' They take the tag down. The vendor-data hold is still open and its card may already have been lost, been rained on, or never printed. The publish guard in the database still refuses to advance the drawing (20260713_document_publish_guard.sql:70-79 raises on any unreleased hold), so the field's physical signal and the database's enforcement now disagree, and the visible evidence says the document is clear.

**Evidence.**

```
app/api/verify-hold/route.ts:54 — `active: !h.released_at,`  |  app/api/verify-hold/route.ts:29 — `.select("id, document_id, reason, notes, opened_by_name, opened_at, released_at, released_by_name, released_reason")` — document_id is fetched and used only to label the doc  |  app/verify-hold/[holdId]/page.tsx:93-95 — `{result.active ? "Do not advance this document or the work it covers." : "This hold has been released — this tag can come down."}`  |  supabase/migrations/20260612_phase5_holds.sql:22-24 — 'Multiple holds can be open on the same document simultaneously (typical: "Awaiting Engineering" AND "Missing Vendor Data").'
```

> **Verifier correction.** Severity dropped to MEDIUM because the released copy is tag-scoped, not document-scoped: app/verify-hold/[holdId]/page.tsx:87 reads "This hold has been released — this tag can come down", which is a true statement about that one tag, and the sibling hold still has its own printed card with its own QR that scans red. The asymmetry is real (the ACTIVE branch at :86 speaks about the document — "Do not advance this document or the work it covers") and worth fixing, but the finding's implied consequence — a worker concluding the document is unheld — is an inference about what someone reads, not something observable from the repo, and the second red tag physically remains in the field.

**Done when.**

- [ ] /api/verify-hold runs a second query for other rows on document_id WHERE released_at IS NULL and returns an otherActiveHolds count (and their reasons)
- [ ] The page renders amber, not green, when this hold is released but siblings remain — with copy along the lines of 'this hold is released, but N other holds are still active on this document; leave the equipment tagged'
- [ ] The green 'this tag can come down' copy is reachable only when zero holds are active on the document

---

<a id="vfy-11"></a>

## VFY-11 · An empty work package scans full-screen red "PACK IS STALE — 0 of 0 sheets changed since this pack was printed"

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify-package/route.ts:73`, `app/verify-package/[packageId]/page.tsx:89-101,116-118`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The '0 of 0' red screen is real and reads as nonsense. Severity is overstated: the failure direction is fail-closed (stop work), and the same page prints an accurate corrective line inside the card — page.tsx:118-120 `{result.sheets.length === 0 && (<div ...>This package has no sheets.</div>)}` — so the crew is not told a stale sheet exists that they must go find. Copy/verdict-taxonomy defect, LOW.

**Mechanism.** `allFresh: sheets.length > 0 && staleCount === 0` (route.ts:73) is false for an empty package because of the length guard, not because anything is stale. The page has no zero-sheet branch on the verdict path: it renders the red background, the X icon, the headline 'PACK IS STALE', and the templated sub-line `${result.staleCount} of ${result.sheetCount} sheet${result.sheetCount === 1 ? "" : "s"} changed since this pack was printed — get the new sheets before starting work.` (page.tsx:95-98) with both numbers zero. It also renders the 'Do not work from the outdated sheets' block, gated only on `!result.allFresh` (:120-125). The empty state that does exist, 'This package has no sheets.' (:116-118), is a small grey line inside the card underneath all of that.

**Failure scenario.** A cover sheet is printed for a package whose documents were later all removed, or a QR is scanned for a package assembled but never populated. The crew gets the identical full-screen red STOP they would get for a genuinely superseded pack, telling them zero of zero sheets changed and instructing them to obtain new sheets that do not exist. The two states — 'this pack is dangerous' and 'this pack is empty' — are visually indistinguishable at arm's length, which is precisely the distance the page is designed for.

**Evidence.**

```
app/api/verify-package/route.ts:73 — `allFresh: sheets.length > 0 && staleCount === 0,`  |  app/verify-package/[packageId]/page.tsx:95-98 — `: `${result.staleCount} of ${result.sheetCount} sheet${result.sheetCount === 1 ? "" : "s"} changed since this pack was printed — get the new sheets before starting work.`}`  |  app/verify-package/[packageId]/page.tsx:116-118 — `{result.sheets.length === 0 && (<div className="text-xs text-slate-500">This package has no sheets.</div>)}`
```

**Done when.**

- [ ] sheetCount === 0 yields a distinct verdict state ('NO SHEETS IN THIS PACK — cannot verify') with its own colour and headline
- [ ] The '0 of 0 sheets changed' sentence is unreachable
- [ ] The red STOP treatment is reserved for a package with at least one sheet that is actually stale or retired

---

<a id="vfy-12"></a>

## VFY-12 · None of the four public endpoints is rate limited or leaves any record that a scan happened — while /api/auth/signup, the one other unauthenticated route, has both

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify/route.ts:22-31`, `app/api/verify-hold/route.ts:17-25`, `app/api/verify-package/route.ts:21-29`, `app/api/verify-ticket/route.ts:38-49`, `app/api/auth/signup/route.ts:6-33`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves confirmed. The enumeration premise also checks out: app/d/[number]/route.ts is unauthenticated, queries with `supabaseAdmin` (service role, RLS bypassed) on a cross-tenant `ilike` over document_number (:26-32) and redirects with `dest.searchParams.set("doc", match.id)` (:45) — a free document-number-to-UUID oracle feeding /api/verify.

**Mechanism.** Three differently-shaped searches agree. (a) Reading all four routes end to end: each validates a UUID, opens a service-role client, queries, and returns — no throttle, no counter, no insert. (b) `grep -rn 'import' app/d app/api/verify*` returns only next/server, @supabase/supabase-js and lib/supabaseAdmin — these routes cannot reach a rate limiter or an audit logger because they import neither. (c) `grep -rn 'audit|logEvent|recordIntent|insert(' app/api/verify* app/d` returns ZERO MATCHES. The repo does have the pattern: signup counts attempts per x-forwarded-for IP against signup_attempts with a documented fail-open (`if (error) return false; // table absent / transient — fail open`, signup/route.ts:27), for the stated reason 'cap attempts per source IP per hour so nobody can loop it to enumerate accounts' (:6-8).

**Failure scenario.** Two consequences. (1) An attacker who has obtained one document UUID — the DACL-3 chain via /d/[number] supplies them at will — can drive /api/verify at full speed to walk a tenant's register, and nothing throttles it or records it; the operator has no signal an enumeration occurred and no log to hand a PSM auditor afterwards. (2) In the ordinary case, a contractor who scans a superseded print and gets red DO NOT USE generates no record at all. For an OSHA/PSM-regulated document-control system, 'this print was verified as superseded at 07:14 on 12 March and work proceeded anyway' is exactly the evidence that matters after an incident, and the system that showed the warning keeps nothing.

**Evidence.**

```
grep -rn 'audit|logEvent|recordIntent|insert(' app/api/verify app/api/verify-hold app/api/verify-package app/api/verify-ticket app/d → ZERO MATCHES  |  grep -rn 'import' over the same directories → only `next/server`, `@supabase/supabase-js`, `@/lib/supabaseAdmin`  |  app/api/auth/signup/route.ts:6-8 — 'Public, unauthenticated endpoint — cap attempts per source IP per hour so nobody can loop it to enumerate accounts or burn trial orgs.'  |  app/api/auth/signup/route.ts:19-28 — the working per-IP counter this could reuse.
```

> **Verifier correction.** Keep at MEDIUM but narrow the stated risk: the enumeration threat the signup limiter exists to stop does not transfer here, because all four endpoints are keyed on 128-bit UUIDs (guessing is infeasible) and return no file, URL, or person. What is actually missing is (i) request-volume protection on four unauthenticated handlers that each open a service-role client and hit the database, and (ii) any record that a field scan occurred, which for a PSM audit trail is arguably the larger loss.

**Done when.**

- [ ] Each verify endpoint applies a per-IP cap using the signup_attempts pattern (fail-open on a missing table), sized for real field use — a crew scanning a pack, not a script
- [ ] Every scan writes a row (endpoint, target id, verdict, ip, timestamp) so verification is evidence and enumeration is visible
- [ ] The retention/export tables account for the new scan table
- [ ] No new vercel.json cron entry is introduced — a third entry fails deployment on this plan (app/api/cron/maintenance/route.ts:286-291); any pruning rides the existing maintenance route

---

<a id="vfy-13"></a>

## VFY-13 · The public verify pages are indexable and carry no robots directive, and the four verdict endpoints send no cache directive of their own

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `app/layout.tsx:20-40`, `app/verify/[docId]/page.tsx`, `app/verify-package/[packageId]/page.tsx`, `app/api/verify/route.ts:96-108`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Both assertions are literally true. Impact is smaller than MEDIUM: all four verify pages are client components that fetch their data from /api/verify* after hydration, so the HTML a crawler is served contains no document number, title or rev — only the URL, which by hypothesis the leaker already had; and package.json pins `"next": "^16.1.0"`, where a route handler reading `req.nextUrl.searchParams` is dynamic and is served uncached with a no-store default, so the missing hand-written Cache-Control carries little practical risk.

**Mechanism.** There is no app/robots.ts, no public/robots.txt (public/ contains only icon-192.png, icon-512.png, icon.svg, sw.js), and the root metadata block (layout.tsx:20-40) sets title, description, keywords, openGraph and appleWebApp but no `robots` field — so nothing marks /verify/*, /verify-package/*, /verify-hold/* or /verify-ticket/* noindex. These pages render document numbers, document titles, work-package names, the full sheet list of a package, hold reasons and plant unit numbers. Separately, none of the four route handlers sets Cache-Control on its NextResponse.json; they rely entirely on the framework's default for dynamic handlers.

**Failure scenario.** A verify URL escapes into anything a crawler reads — an email thread indexed by a vendor portal, a support ticket, a QR-decoder site that logs and republishes decoded URLs, a contractor pasting the link into a public forum asking why his print is red. The page is then eligible for indexing under the plant's own domain, with the document number and title in the crawled body. A search for a drawing number returns a public page confirming it exists, what it is called, and what revision it is at. This is the disclosure surface that audit-reports/intelligence/06-document-acl-leaks.md:240-252 covers from the direct-request side, extended by the fact that nothing tells a crawler to stay away.

**Evidence.**

```
`ls public` → icon-192.png, icon-512.png, icon.svg, sw.js — no robots.txt.  |  `find app -maxdepth 2 -name 'robots*' -o -maxdepth 2 -name 'sitemap*'` → no output.  |  app/layout.tsx:20-40 — the Metadata object contains title, description, applicationName, authors, creator, publisher, keywords, appleWebApp, formatDetection, openGraph; no `robots` key.  |  Verdict fields rendered publicly: app/verify/[docId]/page.tsx:118-121 (docNumber, title), app/verify-package/[packageId]/page.tsx:105-115 (package name and every sheet label), app/verify-hold/[holdId]/page.tsx:100-113 (docLabel, docRev, reason).
```

> **Verifier correction.** SUSPECTED is the correct label and should stay. Discovery is the unproven link: all four surfaces are UUID-addressed, no sitemap exists, and nothing in the app links to them, so a crawler has no path in unless a URL is shared or leaked — meaning the exposure depends on a step nobody can observe from the repo. Note the cache half is also weaker than stated: these are dynamic route handlers reading searchParams, which Next does not cache by default, so the practical gap is the missing explicit no-store on a field-safety answer rather than an actual cached-verdict risk.

**Done when.**

- [ ] The four verify page segments export metadata with robots: { index: false, follow: false }, or an app/robots.ts disallows /verify, /verify-hold, /verify-package, /verify-ticket and /d
- [ ] The four API routes set an explicit Cache-Control: no-store rather than relying on framework defaults, so no intermediary caches a revision verdict
- [ ] A check confirms none of these paths appears in any generated sitemap

---

<a id="vfy-14"></a>

## VFY-14 · The verify routes over-select the exact fields they promise not to disclose, one careless spread away from publishing them

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `app/api/verify-hold/route.ts:29,35`, `app/api/verify/route.ts:36,56`, `app/api/verify-ticket/route.ts:51`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Nothing is disclosed today — every route hand-builds its JSON, and the `h as Record<string, unknown>` cast at verify-hold:34 is the only place a spread would be easy. The claim is true for verify-hold but over-generalized to 'the verify routes', and it describes a hypothetical future refactor rather than a present defect, so LOW (defensive-coding hardening) rather than MEDIUM.

**Mechanism.** /api/verify-hold selects `notes, opened_by_name, released_by_name, released_reason` (:29) — the four columns its own comment at :48-53 says must never reach a scanner — returns none of them, and then widens the row's type to `const h = hold as Record<string, unknown>` (:35), which is precisely the shape that makes `...h` compile silently. /api/verify selects `superseded_at` on the document (:36) and `superseded_at` on the printed version (:56) and uses neither; the version-level one is the signal that would catch a printed version that was superseded out from under a rolled-back current_version_id. /api/verify-ticket selects `revision_count` (:51) and never reads it, which is why a ticket sitting in REVISION_REQ after an issued Rev 1 — revision_count already incremented, deliverable_rev still '1' (lib/ticketTransitions.ts:253-256) — verifies as green LATEST ISSUE.

**Failure scenario.** Someone adds a field to the hold response — 'the field asked for the expected release date' — and writes `return NextResponse.json({ ...h, active: !h.released_at, ... })` because h is already a Record<string, unknown> and the select already contains everything. opened_by_name, released_by_name, released_reason and the operator's notes ship to the open internet in one line, past a code review that sees a one-field change. Nothing in the type system objects, because the guarantee lives only in a prose comment and in the discipline of hand-listing the response keys.

**Evidence.**

```
app/api/verify-hold/route.ts:29 — `.select("id, document_id, reason, notes, opened_by_name, opened_at, released_at, released_by_name, released_reason")` against :48-53 — 'a photographed hold card must not disclose staff names or free-text operator notes'  |  app/api/verify-hold/route.ts:35 — `const h = hold as Record<string, unknown>;`  |  app/api/verify/route.ts:36 and :56 — `superseded_at` selected twice, referenced nowhere in the response at :96-108  |  app/api/verify-ticket/route.ts:51 — `revision_count` selected, referenced nowhere in the verdict at :62-93.
```

**Chain reaction.** The unread revision_count is the same class of defect as the already-CONFIRMED ticket finding (audit-reports/roles-and-permissions/06-request-workflow.md:109 and WF-21 at :954-964: the verdict is computed from deliverable_rev and never reads ticket status) — the route fetches the fields that would make it correct and ignores them.

> **Verifier correction.** Downgraded to SUSPECTED: no spread operator exists in any of these handlers — every response is an explicit object literal — so this is latent hygiene, not an observable leak, and the finding's 'one careless spread away' is a hypothetical. The bundled verify-ticket sub-claim is also wrong as diagnosed. lib/ticketTransitions.ts:254-258 (engineer_request_revision) bumps revision_count and leaves deliverable_rev at '1', so verify-ticket returns verdict 'current' — but that verdict is defensible, since Rev 1 genuinely IS the latest issued deliverable; the endpoint's 'revision_in_progress' state (:80-81) is keyed on a letter rev appearing, i.e. once a draft is submitted. The gap is that REVISION_REQ before resubmission is invisible, not that a superseded print reads green.

**Done when.**

- [ ] Each verify route selects only the columns it actually returns, so the public contract is enforced by the query rather than by a comment
- [ ] The row is typed with an explicit interface rather than Record<string, unknown>, so a spread cannot compile
- [ ] revision_count is either used in the ticket verdict or dropped from the select

---
