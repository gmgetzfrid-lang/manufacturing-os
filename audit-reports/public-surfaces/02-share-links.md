# 02 · Share links & the short link

**14 findings** — 1 CRITICAL · 4 HIGH · 8 MEDIUM · 1 LOW.

Token entropy, expiry, revocation, and whether a share respects a hold.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| Share token generation has genuinely sufficient entropy | `lib/documentShares.ts:24-31` | randomToken uses crypto.getRandomValues over 32 bytes and slices the url-safe base64 to 32 characters — 192 bits of entropy. Combined with the UNIQUE constraint on document_shares.token (20260623:14) and its index (line 30), guessing is not a viable attack. Every finding above concerns what a *legitimately obtained or forged* token can reach, not brute force. Do not 'harden' this; it is correct. |
| Expiry and revocation ARE enforced server-side on both public routes, not display-only | `app/api/share/resolve/route.ts:38-41 and app/api/share/file/route.ts:48-51` | Both routes check revoked_at and compare expires_at against Date.now() before touching the document, returning 410. ShareLinkModal's dead/expired styling (lines 148-150) is a duplicate of a real server gate, not a substitute for one. The revocation weakness is downstream (the service worker cache) and in discoverability (no org-wide inventory), not in the check itself. |
| The raw-presigned-URL leak was correctly closed — no bucket URL ever reaches the browser | `app/api/share/resolve/route.ts:73-81 and app/api/share/file/route.ts:83-96` | resolve returns only `/api/share/file?token=...`, and file pulls bytes bucket→server (GetObjectCommand or a server-side fetch for legacy absolute URLs) and stamps before responding. The documented prior bug — client-side stamping CORS-blocked by the bucket, with a fallback that opened the raw unstamped file — is genuinely fixed. Any refactor must preserve this: the recipient must never receive an R2 URL. |
| /api/verify cross-checks that the version belongs to the document before answering | `app/api/verify/route.ts:63-66` | `if (!vr \|\| vr.record_id !== docId) return 404` is exactly the identity check the share routes omit when they resolve a document from a share row. It is the pattern to copy for the share/org mismatch fix, and it also reads documents.status (line 88) and effective_date (lines 90-93) — both controls the share routes should adopt. |
| /api/storage/download-url is the reference implementation for byte-level authorization | `app/api/storage/download-url/route.ts:29-113` | It validates the storage key against traversal (assertSafeStorageKey), gates on org-prefix membership, enforces private/hidden visibility via canDiscover, honours chain-resolved acl_index deny-download rules, and is archive-aware. Its stated principle — 'URL issuance is the enforcement point for bytes' — is the standard the share routes should be held to, and the checks can largely be lifted into a shared helper rather than rewritten. |
| The stamping pipeline itself is sound and fails safe | `lib/stamping.ts:238-300 and lib/stampLayout.ts:131-146` | applyStampToPdfDoc degrades gracefully (QR generation failure warns and continues; ink analysis returning null falls back to convention), and pickQrCorner/pickFooterEdge are pure, testable functions. The share-copy placement problem is entirely in the *inputs* the server route supplies, not in this code. |
| The service worker already articulates the correct caching principle for token-gated content | `public/sw.js:15-17 and 138-152` | It deliberately excludes cross-origin requests and never caches RSC payloads, with well-reasoned comments about signed URLs expiring and stale app code. Extending the same exclusion to /api/share/**, /api/verify** and /share/** is a small, in-idiom change — the reasoning is already written down, it just was not applied to same-origin token-gated routes. |


---


<a id="shr-1"></a>

## SHR-1 · Share rows carry no org-consistency constraint and both public routes resolve the document org-blind with the service role — a member of org A can mint a public internet link to any org B document whose UUID they can obtain

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260623_document_shares.sql:38-54`, `lib/documentShares.ts:46-54`, `app/api/share/resolve/route.ts:32-58`, `app/api/share/file/route.ts:42-58`, `app/d/[number]/route.ts:26-46`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Every link in the chain holds: the RLS WITH CHECK validates the attacker's own org_id while leaving document_id unvalidated, and neither public route re-checks the pairing before service-role-reading the version's storage key and streaming the bytes from R2. The UUID needed to weaponize it is handed out unauthenticated by app/d/[number]/route.ts (SHR-2). CRITICAL stands — this is cross-tenant exfiltration via a public URL.

**Mechanism.** document_shares has two independent FKs — org_id → orgs and document_id → documents — and nothing ties them together. There is no CHECK, no trigger, and no composite FK. The only RLS policy is document_shares_org_member (20260623:38-54), whose WITH CHECK is `EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = document_shares.org_id AND org_members.uid = auth.uid() AND org_members.status = 'active')`. It validates the org_id column against my membership and says nothing about document_id. createShareLink (documentShares.ts:46-54) is a client-side supabase.from("document_shares").insert with both columns fully attacker-controlled from the browser. So an active member of org A inserts {org_id: <org A>, document_id: <org B document>, token: <own token>} and RLS accepts it. Resolution then never re-checks: app/api/share/resolve/route.ts:43-47 does `sb.from("documents").select(...).eq("id", share.document_id)` with the SERVICE ROLE — no `.eq("org_id", share.org_id)` — and app/api/share/file/route.ts:53-57 repeats the identical org-blind lookup before streaming the bytes out of R2 (file/route.ts:92). The service role bypasses RLS on documents and document_versions entirely, so the only gate that ever ran was the one that checked the wrong column.

**Failure scenario.** A contractor holds a Viewer seat in org A (their own small engineering shop) on the same instance as a refinery, org B. They hit /d/2002-D-10001 unauthenticated (see the /d finding) and read the Location header `/documents/<libB>?doc=<docUUID>` — the refinery's document UUID, handed over with no session. Back in org A they open any document's share modal, and in the browser console re-issue the same insert with document_id swapped to the refinery's UUID. RLS passes (org_id is still org A, they are an active member). They open /share/<token>: /api/share/resolve returns the refinery's document number, title, rev and org name; /api/share/file streams the refinery's controlled P&ID PDF. Nothing in org B logs it, nothing in org B's UI shows the link exists, and revocation is impossible because no one in org B can see a document_shares row owned by org A.

**Evidence.**

```
20260623_document_shares.sql:47-54 `WITH CHECK ( EXISTS ( SELECT 1 FROM org_members WHERE org_members.org_id = document_shares.org_id AND org_members.uid = auth.uid() AND org_members.status = 'active'))` — document_id is unconstrained. resolve/route.ts:43-47 `const { data: doc } = await sb.from("documents").select("id, document_number, title, name, rev, current_version_id").eq("id", share.document_id as string).maybeSingle();` — share.org_id is selected at line 34 but used only for the audit insert at file/route.ts:131. Contrast app/api/verify/route.ts:63-66, which DOES cross-check the pair: `if (!vr || vr.record_id !== docId) { return NextResponse.json({ error: "Unknown document" }, { status: 404 }); }` — the exact guard the share routes omit.
```

**Chain reaction.** The prerequisite (a foreign document UUID) is supplied by app/d/[number]/route.ts, which is unauthenticated and unscoped. Fixing only /d leaves the hole open to anyone who has ever seen a document UUID in a URL, an exported CSV (lib/exportTables.ts:50 exports document_shares), a transmittal, or a verify QR. Adding `.eq("org_id", share.org_id)` to both routes closes the read side; a composite FK or trigger on document_shares closes the write side. Both are needed — the org-blind read is also what makes any future mis-scoped writer exploitable.

> **Verifier correction.** Two small evidence errors, neither substantive: (a) share.org_id is NOT used 'only for the audit insert' — resolve/route.ts:50 uses it for `sb.from("orgs").select("name").eq("id", share.org_id)`, meaning the landing page would render org A's name over org B's document; (b) the attack requires the attacker to first obtain a foreign document UUID, which is a separate step (finding 2's /d route is one supplier). Note also that the intra-org variant of this — an ACL-denied member minting a share for a document they cannot read — is already recorded in audit-reports/intelligence/06-document-acl-leaks.md:130; the cross-ORG variant here is new and should cite that report.

**Done when.**

- [ ] document_shares carries a DB-level guarantee that document_id belongs to org_id (composite FK against documents(id, org_id) with a matching unique index, or a BEFORE INSERT/UPDATE trigger that rejects the mismatch)
- [ ] app/api/share/resolve/route.ts and app/api/share/file/route.ts both filter the documents lookup by `.eq("org_id", share.org_id)` and 404 on mismatch
- [ ] a test inserts a share row whose document_id belongs to a different org than org_id and asserts the insert is rejected by the database, not just by the UI

**Resolution (2026-09-29, document-control Round F wave 2).** **Record-only close — resolved by roles-and-permissions `EGRESS-1`** (Round D, 2026-08-24; document-control `EGR-2` carries the same close), re-verified in the current tree: `20261022_document_shares_acl_scope.sql:44-57` makes the INSERT `WITH CHECK` require `d.id = document_shares.document_id AND d.org_id = document_shares.org_id` (plus the creator's read decision); `20261026` binds `created_by = auth.uid()` and makes `document_id` / `org_id` / `created_by` immutable by a BEFORE UPDATE trigger (now BEFORE INSERT OR UPDATE, `supabase/migrations/20261080_dc_roundF_share_minting_and_revocation.sql`, the body byte-carried); `20261037:119-135` is the newest live INSERT body and `supabase/migrations/20261080_dc_roundF_share_minting_and_revocation.sql` carries it byte-for-byte while adding arms; both public routes org-join the document lookup — `lib/shareServe.ts:146-151` `.eq("id", s.document_id).eq("org_id", s.org_id)` — and 404 a miss before the org name or a byte is read. The `/d/[number]` supplier of foreign UUIDs is `SHR-2` (→ `EGRESS-2`, PS-VERIFY).

**Done-when.**
1. ✓ (20261022 / 20261037, applied 2026-08-24 per the file headers) The WITH CHECK correlates the pair, and the 20261026 trigger keeps the pair immutable afterwards. It is a policy + trigger rather than a composite FK: a service-role writer bypasses the policy (not the trigger) — no service-role path inserts shares (the restore lands rows revoked, DEC-45).
2. ✓ Both routes filter by `org_id` and 404 on mismatch (`lib/__tests__/shareResolveRoute.test.ts`, `lib/__tests__/shareRoutes.test.ts`).
3. ◐ No live database in the loop; the rejection is proven statically — the policy text is pinned (`lineDiff` in `lib/__tests__/shareRoutes.test.ts` shows the 20261037 body intact under 20261080) and the routes' org-join is driven end-to-end. The 20261022 header records the live apply.

**Scope / residual.** None.

**Verification fix (2026-09-30, document-control Round F wave 2).** Citation only: the org-joined documents lookup moved from `lib/shareServe.ts:140-145` to `:146-151` when `SHR-3`'s serve-time download-deny check landed above it; the code and this finding's status are unchanged.

---

<a id="shr-2"></a>

## SHR-2 · /d/[number] is an unauthenticated cross-org document lookup that redirects to a substring match — it leaks foreign document UUIDs and can put the wrong drawing in a field worker's hands

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/d/[number]/route.ts:14-32` *(the whole current handler)*
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, including the exact fallback the summary describes: when no candidate's normalized number matches, `?? rows[0]` silently returns the most recently updated substring hit from ANY tenant. The route's own header comment — 'this route only translates a number into a location; it reveals nothing' — is contradicted by the Location header, which carries a foreign library_id and document UUID to an unauthenticated caller.

> **Cross-area update (2026-08-24) — this defect is RESOLVED under
> `roles-and-permissions/EGRESS-2` (commit `67e6bdd`).** SHR-2 is the
> public-surfaces name for the same `/d/[number]` oracle. The route no longer
> holds a service-role client and does no database query at all — it forwards
> to the protected `/documents` page, which resolves the number client-side
> under the caller's RLS (org-scoped, ACL-enforced). Both failure modes are
> gone: an unauthenticated caller gets an identical redirect for every input
> (no disclosure), and the wrong-target substring fallback is replaced by an
> exact-match-or-search resolution the caller could already perform. **The
> prose and `Evidence` below quote the pre-fix route and no longer match the
> code.** The public-surfaces owner should mark this `RESOLVED` with the
> cross-reference on their next pass; left OPEN here only because this session
> is scoped to the roles-and-permissions area (`DEC-32`).

**Mechanism.** The route has no auth check of any kind and there is no middleware.ts anywhere in the repo (confirmed by `find -maxdepth 2 -name middleware.ts` returning nothing and next.config.ts containing no matcher). It queries with `supabaseAdmin` — the service-role client (lib/supabaseAdmin.ts) — so RLS is bypassed, and the query at lines 26-32 carries NO `.eq("org_id", ...)` filter. Every other search in the codebase scopes by org (lib/globalSearch.ts:171 `.eq("org_id", orgId)`, lib/projects.ts:203, app/(protected)/admin/codebook/page.tsx:473); this one does not. Two separate failure modes follow. First, disclosure: on a match the route returns a 302 whose Location is `/documents/<library_id>?doc=<document id>` (lines 44-46), so an anonymous caller reads a foreign org's library UUID and document UUID directly out of the response headers, before any auth wall. Those are exactly the UUIDs /api/verify accepts unauthenticated (verify/route.ts:26-30), whose header comment asserts they 'only appear ON a printed copy the org itself issued' — /d hands them to anyone who can guess a drawing number. Second, wrong-target: the exact normalized match is only preferred, not required — line 36 is `?? (rows ?? [])[0]`, so when no candidate normalizes equal, the route silently redirects to whichever *substring* match across all orgs was updated most recently. The sanitizer at line 30 strips `%` and `_` but not `*`, which PostgREST itself translates to `%` in ilike patterns — so `/d/2*0` becomes `document_number=ilike.%2%0%`, a global wildcard scan. There is no rate limiting anywhere in lib/ or app/api/ (grep for rateLimit/ratelimit/rate_limit finds only knowledge-embed code), so the number space is freely enumerable.

**Failure scenario.** A pipefitter reads a smudged title block and types /d/D-101 on their phone. Their own org has no D-101, but org B (a different tenant) has 2002-D-1010 updated yesterday and their own org has PID-D-101-A. `find` at line 35 finds no exact normalized match ('d101' matches neither 'd1010' nor 'pidd101a'), so line 36 falls through to rows[0] — the newest by updated_at across *all* orgs, org B's 2002-D-1010. The fitter is redirected to /documents/<orgB library>?doc=<orgB doc>. The protected page will refuse to render org B's document, but the fitter has now been told a drawing exists at that number, and an attacker running the same request has org B's library and document UUIDs. Change the scenario so both candidates are in the fitter's own org and the page renders: they open the wrong isometric, work to it, and no part of the system ever indicates a near-miss match was substituted for an exact one.

**Evidence.**

```
app/d/[number]/route.ts:26-32 `const { data: rows } = await supabaseAdmin.from("documents").select("id, library_id, document_number, updated_at").filter("document_number", "not.is", null).ilike("document_number", `%${raw.replace(/[%_]/g, "")}%`).order("updated_at", { ascending: false }).limit(25);` — no org filter. Line 36: `?? (rows ?? [])[0] as { id: string; library_id: string } | undefined;`. Lines 44-46: `const dest = new URL(`/documents/${match.library_id}`, req.url); dest.searchParams.set("doc", match.id); return NextResponse.redirect(dest);`. Line 7 asserts `this route only translates a number into a location; it reveals nothing.` Compare lib/globalSearch.ts:196-198 `function escape(s: string): string { return s.replace(/[%_,]/g, "\\$&"); }` — the codebase already has a correct LIKE escaper that /d does not use.
```

**Chain reaction.** This is the disclosure primitive that arms the cross-tenant share-forgery finding: it is the only place in the app that hands a document UUID to an unauthenticated caller. It also undermines /api/verify's stated threat model — verify/route.ts:22-24 justifies being unauthenticated on the premise that the UUIDs are secret, which /d falsifies.

> **Verifier correction.** Three corrections. (1) Severity drops from CRITICAL to HIGH: the 'wrong drawing in a field worker's hands' half only lands within the worker's own org — a cross-org redirect target renders behind auth+RLS and shows them nothing, so cross-org the harm is UUID/metadata disclosure, not a wrong drawing. (2) The `*` → `%` translation is PostgREST runtime behavior that cannot be demonstrated from this repo; treat that sub-claim as SUSPECTED (the org-blind substring scan is confirmed regardless — `%…%` is already a substring match). (3) 'No rate limiting anywhere in lib/ or app/api/' is wrong: app/api/auth/signup/route.ts:19-39 has `signupRateLimited(ip)` backed by signup_attempts. Nothing applies to /d, so the enumerability conclusion stands, but the absence claim as written is false.

**Done when.**

- [ ] /d/[number] resolves only within the caller's authenticated org (session required, or the route redirects unauthenticated callers to login carrying the number as a query param and resolves after auth)
- [ ] a non-exact substring candidate is never auto-followed — no match means the /documents?q= fallback at lines 39-42, never rows[0]
- [ ] the ilike pattern is escaped with the same escaper as lib/globalSearch.ts:196 so `*`, `%`, `_` and `,` are all literal
- [ ] a test asserts /d/<number belonging to another org> never emits that org's document id or library id in the response

---

<a id="shr-3"></a>

## SHR-3 · A share link ignores every access control the internal download path enforces: holds, document status (Void/Superseded/Archived), private/hidden visibility, and explicit ACL deny-download

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/share/file/route.ts:42-81`, `app/api/share/resolve/route.ts:32-58`, `app/api/storage/download-url/route.ts:47-113`, `app/api/verify/route.ts:88`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. The core claim is right and HIGH is right: an ACL that explicitly denies download, and private/hidden visibility, are both enforced on the internal byte-issuing route and both absent from the share route — and RLS lets any member mint the share regardless of that ACL. The correction is factual scope: HOLDS and STATUS are not enforced on the internal download path either. Holds only block advancing a document (lib/documentGuards.ts:138-146 'Active holds block advancing', backstopped by 20260713_document_publish_guard.sql, which guards only current_version_id/Superseded transitions), and 'Void' appears in lib/downloads.ts:62-63 solely as a badge tone. So the share link does not bypass a hold/status download gate — no such gate exists anywhere.

**Mechanism.** The two share routes read exactly three fields to decide whether the bytes may leave: revoked_at, expires_at, and document_id. Grep across app/api/share/** finds zero references to document_holds, zero to `visibility`, zero to `acl`, and zero reads of documents.status. Meanwhile the authenticated download path enforces all of it: /api/storage/download-url denies private/hidden documents the caller cannot discover (lines 47-90, canDiscover) and honours explicit ACL deny-download rules from the chain-resolved acl_index (lines 91-113, 'URL issuance is the enforcement point for bytes, so an ACL "deny download" must not be routable around via a hand-built request'), and /api/verify reads status and refuses to call a Superseded/Archived doc current (verify/route.ts:88 `const docRetired = d.status === "Superseded" || d.status === "Archived";`). documents.status is a real, populated field — types/schema.ts:613 `export type DocumentStatus = "Draft" | "Issued" | "Superseded" | "Void" | "Archived" | "Locked";` and lib/documentLifecycle/common.ts:272 writes 'Superseded'. document_holds is a live table with an active-hold partial index (20260612_phase5_holds.sql:61-66) that four separate DB guards consult (20260713_document_publish_guard.sql:70, 20260812:138, 20260816:71, 20260822:79, 20260828:107). The share routes consult none of them.

**Failure scenario.** An engineer opens a hold on a piping isometric — reason 'Field Verification Needed' — because the as-built run does not match the drawing. Every internal publish path is now blocked by the DB guard. A share link created before the hold (or after — nothing stops creation either) still resolves: /api/share/file finds revoked_at null and expires_at in the future, pulls current_version_id's file from R2, stamps it 'UNCONTROLLED — SHARED COPY', and hands the held drawing to the outside fabricator, who cuts spool pieces to it. The parallel case is worse for Void: a drawing voided because its material spec was wrong keeps serving through any outstanding link, with no status signal on the landing page (share/[token]/page.tsx:108-142 renders document number, title, rev and org name — never status, never hold).

**Evidence.**

```
file/route.ts:47-51 is the entire authorization: `if (!share) return ... 404; if (share.revoked_at) return ... 410; if (share.expires_at && new Date(share.expires_at as string).getTime() < Date.now()) return ... 410;` — followed immediately by the document lookup at 53-57 which selects `"id, document_number, title, name, rev, current_version_id"`: status is not even fetched. Contrast download-url/route.ts:88-90 `if (!allowed) { return NextResponse.json({ error: "Not authorized for this document" }, { status: 403 }); }` and 110-112 `if (denied) { return NextResponse.json({ error: "Downloading this document is denied for your account" }, { status: 403 }); }`.
```

**Chain reaction.** Because ShareLinkModal is ungated (see the no-permission-gate finding), the ACL bypass is directly exploitable from inside: a user who is explicitly denied `download` on a document but can still discover it mints a share link on it and downloads through /api/share/file, which never evaluates acl_index. The deny rule that download-url/route.ts:91-113 exists to make unroutable is routable around in three clicks.

> **Verifier correction.** None material. One nuance worth carrying into the report: download-url's ACL block is wrapped in `try { ... } catch { /* fail open */ }` (:114-116), so the internal path is itself best-effort — the share path is still strictly weaker, since it never even attempts the checks.

**Done when.**

- [ ] /api/share/resolve and /api/share/file both fetch documents.status and refuse (or clearly mark) Void / Superseded / Archived / Draft before any byte or metadata leaves
- [ ] both routes check for an open document_holds row (released_at IS NULL) and refuse while a hold is active
- [ ] both routes evaluate visibility and the acl_index deny-download rules against the SHARER's principal at resolve time, mirroring app/api/storage/download-url/route.ts:47-113
- [ ] the /share landing page shows the document's control status, not just number/title/rev

**Resolution (2026-09-29, document-control Round F wave 2).** Same fix as document-control `DRLS-5` / `EGR-5` / `DIST-6` — the shared `lib/shareServe.ts` decision both routes run: `documents.status` + `archived_at` read; `Draft`, `NOT_CURRENT_STATUSES` (Void / Superseded / Archived) or an archived record refused `410 withdrawn` with the reason; an open `document_holds` row refused `423 on_hold` via `lib/holdGate.ts assertNotOnHold` (fail-closed on a read error) — and because the landing page is unauthenticated, the refusal names only the hold's predefined CATEGORY (`publicShareHoldReason` over `lib/holds.ts publicHoldReason`, the HLD-7 / VFY-6 rule `/api/verify-hold` follows), never the operator's free-text reason or a database error (that detail is logged server-side); the creator's CURRENT visibility / `acl_index` READ decision re-evaluated every resolve by `shareStillAuthorized` (R&P `EGRESS-1`, `lib/shareAuthorization.ts:23-40`, mirrors `lib/knowledgeAccess` — the read decision `/api/storage/download-url` enforces for private / hidden documents) so a read deny landing on the sharer kills the link, and the creator's CURRENT minting tier re-asked too (`creatorMayShare`: a controller by the role collection or a granted publisher of the library, else `410`); and minting refused for the same document states at the database (`supabase/migrations/20261080_dc_roundF_share_minting_and_revocation.sql` `document_share_refusal`) and in the app. The landing page shows the control status beside the revision and states the always-current rule.
- Files: `lib/shareServe.ts`, `lib/shareRules.ts`, `app/api/share/resolve/route.ts`, `app/api/share/file/route.ts`, `app/share/[token]/page.tsx`, `supabase/migrations/20261080_dc_roundF_share_minting_and_revocation.sql`
- Tests: `lib/__tests__/shareRoutes.test.ts` (the `DRLS-5` cases; "revoked / expired / cross-org / lapsed-authority refusals are unchanged and come before the status gate"; "an active hold refuses (423 on_hold) with only the hold's PUBLIC category …"; "publicShareHoldReason: predefined categories only …").
- Reproduced: base `file/route.ts:47-62` — the whole authorization was `revoked_at` / `expires_at` / org-join / `shareStillAuthorized`; `status` not selected; no `document_holds` reference under `app/api/share/**`.
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (194 files / 2595 tests, re-run after the second review fix pass).

**Done-when.**
1. ✓ Both routes fetch `status` and refuse Void / Superseded / Archived / Draft before any metadata or byte leaves.
2. ✓ Both routes check for an open `document_holds` row (`released_at IS NULL`) and refuse while one exists — or while the hold set cannot be read.
3. ✓ Visibility and the `acl_index` READ decision are evaluated against the SHARER's principal at resolve time (`shareStillAuthorized`, already since `EGRESS-1`; now on the one shared path), the sharer must still hold the minting tier, and — since the 2026-09-30 verification fix — the explicit ACL *deny-download* rule the internal route honours is evaluated against the SHARER too, by the same helper that route now calls (`lib/downloadDeny.ts memberDownloadDenied`, asked inside `creatorMayShare`, `lib/shareServe.ts:210-215`): a creator named by uid, by any role in their collection, or by a team gets `410` on both routes before any byte or metadata leaves, and so does one whose roles / teams cannot be read while a download deny exists (fail-closed). This criterion is about resolve time and holds in full; the MINT side (the INSERT policy still admits such a creator's row, which then never serves) is `SHR-14`.
4. ✓ The `/share` page renders `Rev X · <status>`, the always-current statement, and the withdrawn / on-hold states with the server's reason — for a hold, the predefined category only (a free-text reason reads "under an active hold"; an unreadable hold set reads "could not be confirmed").

**Scope / residual.** The mint-time rail is `supabase/migrations/20261080_dc_roundF_share_minting_and_revocation.sql` (pending apply — `DIST-6`). It has no download-deny arm: there is no SQL download-deny predicate to call (the database decides visibility and publish authority; members' downloads are refused only by `/api/storage/download-url`), so a granted publisher denied download on a document can still INSERT a share row for it — a row that never serves. Opened as `SHR-14` (DEC-31); nothing of it is claimed here.

**Verification fix (2026-09-30, document-control Round F wave 2).** An independent check of `f1ce4c7` found this finding RESOLVED while criterion 3 was ◐: a publisher granted on the library but DENIED DOWNLOAD on document X could mint a link to X, and the link served. Closed at SERVE time, in code: the member route's inline deny-download block is now `lib/downloadDeny.ts` (`memberDownloadDenied` over `downloadDeniedTo` — `acl_index.deny.{users,roles,teams}.download` against the uid, every role in the collection via `normalizeRoles` (a missing row reads as Viewer), and the teams; controllers not exempt, as on that route); `app/api/storage/download-url/route.ts:153-167` calls it (same evaluation, same fail-open posture on a read error); `creatorMayShare` (`lib/shareServe.ts:196-226`) calls the same helper for the share's CREATOR before the tier check and refuses on `denied` or `unreadable`, so both routes answer `410 revoked` (`authority_lapsed` on the access trail); `resolveShareForServing` selects `acl_index` with the document (`lib/shareServe.ts:148`). NOT closed at MINT time — see Scope / residual and `SHR-14`. Criterion 3 re-marked ✓ on what now holds; Status stays RESOLVED.
- Files: `lib/downloadDeny.ts` (new), `lib/shareServe.ts`, `app/api/storage/download-url/route.ts`
- Tests: `lib/__tests__/shareRoutes.test.ts` — "an explicit ACL download deny naming the CREATOR stops the link serving (SHR-3 criterion 3) …" (by uid, by an additive role, by team, a controller named by uid, an unreadable team set; a deny naming someone else, a read-only entry and no index all serve; the route and `creatorMayShare` share the helper) — it fails against `f1ce4c7`'s `lib/shareServe.ts` (200 where 410 is expected); `lib/__tests__/downloadDeny.test.ts` (the rule, and the member route through it — 403 for uid / additive role / team / controller, fail-open posture unchanged); `lib/__tests__/rpPhase5Additive.test.ts` (the CHAIN-1 headline-seed source pin re-pointed at the helper).
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (195 files / 2602 tests).

---

<a id="shr-4"></a>

## SHR-4 · Any active org member — including a Viewer — can mint a never-expiring public internet link to a controlled drawing, and no one can ever enumerate or bulk-revoke it

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/documents/InspectorPanel.tsx:574-580`, `components/documents/ShareLinkModal.tsx:27-33`, `components/documents/ShareLinkModal.tsx:61-73`, `lib/documentShares.ts:41-45`, `lib/documentShares.ts:59-66`, `supabase/migrations/20260623_document_shares.sql:20`
- **Also surfaced independently as** [`DIST-6`](../document-control/05-distribution.md#dist-6) — two lenses found this separately. Fix once.
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: no role check in the UI or in RLS, a never-expiring option in the picker, and per-document-only listing with per-row revoke. One caveat on 'no one can ever enumerate': document_shares is in the admin data-export table list (lib/exportTables.ts:50), so an Admin can dump the rows offline — but there is no in-app view, no query surface, and no bulk revoke, so the finding's operational point stands.

**Mechanism.** The Share button (InspectorPanel.tsx:575-580) has no role or ACL condition — its only guards are `selectedDoc.id && selectedDoc.orgId && uid` at line 561/1016. InspectorPanel gates other actions by role in exactly the way this one is not: line 156 `const isController = activeRole === 'Admin' || activeRole === 'DocCtrl';`, line 673 `canManage={["Admin", "DocCtrl", "Manager", "Supervisor"].includes(activeRole ?? "")}`. RLS agrees with the UI: document_shares_org_member's WITH CHECK grants INSERT to any active member regardless of role. The duration picker offers 'Never expires' to everyone (ShareLinkModal.tsx:32 `{ label: "Never expires", days: 0 }`), which documentShares.ts:43-44 turns into `expiresAt = null`, which both routes treat as no expiry (`if (share.expires_at && ...)` — a null short-circuits the check). The migration's own comment contradicts the UI it shipped with: 20260623:20 `expires_at TIMESTAMPTZ, -- null = no expiry (rare; admin sets)` — there is no admin gate anywhere. And the link is then unfindable: grep for listShareLinks/createShareLink/revokeShareLink returns exactly one consumer, ShareLinkModal, which queries `.eq("document_id", documentId)` (documentShares.ts:63). There is no org-wide share inventory in app/(protected)/admin/**. Worse, listShareLinks discards the error — `const { data } = await supabase...` at line 60-64, no `error` destructured — and returns `[]`, which the modal renders as the reassuring 'None yet.' (ShareLinkModal.tsx:143). revokeShareLink (documentShares.ts:69-72) is the same unchecked-write pattern: no `{ error }`, no rows-affected check, so a failed revoke returns void and the caller's catch never fires.

**Failure scenario.** A junior Viewer, helping a vendor, opens the inspector on a PSM-covered P&ID, picks 'Never expires', and pastes the URL into a vendor portal thread. That URL now serves the plant's current P&ID to anyone on the internet who sees it, forever, with no expiry to age it out. Nobody can find it: the only way to discover an outstanding link is to open the share modal on that specific document, and there are tens of thousands of documents. If a PSM auditor asks 'list every public link to a controlled document and who created it', the answer is unobtainable from the product. Layer the swallowed error on top: if the listShareLinks query fails for any reason, the controller who does open the right document is shown 'None yet.' and concludes there is nothing to revoke.

**Evidence.**

```
InspectorPanel.tsx:575-580 `<button onClick={() => setShareOpen(true)} title="Generate a public share link for someone outside the org" className="..."> <LinkIcon className="w-3 h-3" /> Share </button>` — no disabled, no role test. documentShares.ts:41-45 `const expiresAt = input.expiresInDays === undefined ? new Date(Date.now() + 30 * 86_400_000).toISOString() : input.expiresInDays === 0 ? null : new Date(...)`. documentShares.ts:59-66 `export async function listShareLinks(documentId: string): Promise<DocumentShare[]> { const { data } = await supabase.from("document_shares").select("*").eq("document_id", documentId)...; return ((data ?? []) as ...).map(rowToShare); }`. documentShares.ts:68-73 `export async function revokeShareLink(id: string, actorUserId: string): Promise<void> { await supabase.from("document_shares").update({ revoked_at: ..., revoked_by: actorUserId, }).eq("id", id); }`.
```

**Chain reaction.** This is the write half of the cross-tenant exfiltration chain — an ungated client-side insert into a table whose RLS validates the wrong column. It also makes the ACL-bypass finding exploitable by the least-privileged account in the org, and it means a member who is later deactivated leaves behind links that keep working: neither share route re-checks whether created_by is still an active member (they select created_by at resolve/route.ts:34 and use it only for the audit user_id).

> **Verifier correction.** 'No one can ever enumerate it' is overstated. document_shares is in ORG_SCOPED_TABLES (lib/exportTables.ts:50), so an Admin running the full-org backup (lib/dataExport.ts:31) receives every share row org-wide, including tokens. What genuinely does not exist is an in-app inventory screen or any bulk-revoke — revocation is one document at a time through the inspector, which is the operationally important half of the claim.

**Done when.**

- [ ] creating a share link requires an explicit capability (controller tier or an ACL 'share'/'download' grant), enforced both in InspectorPanel and by RLS on document_shares INSERT — not membership alone
- [ ] 'Never expires' is restricted to that same tier, or removed; a maximum expiry is enforced server-side
- [ ] an org-level admin view lists every non-revoked share link with document, creator, expiry and access count, and supports bulk revoke
- [ ] listShareLinks and revokeShareLink destructure and surface `{ error }`; a failed list renders an error state, never the empty state
- [ ] a document transitioning to Superseded / Void / Archived, or its creator being deactivated, revokes or disables its outstanding share links

**Resolution (2026-09-29, document-control Round F wave 2).** Same defect as document-control `DIST-6` — fixed once; that record carries the full description. Summary: minting is the controller tier (by the role collection) or a granted publisher of the document's library, enforced in the modal (`canMintShare`, `useRole().hasAnyRole`) and by the INSERT policy (`supabase/migrations/20261080_dc_roundF_share_minting_and_revocation.sql`: `is_org_controller OR user_can_publish_on_library`); "Never expires" is removed (`DURATION_OPTIONS` 1 / 7 / 30 / 90 days; `shareExpiryFor` refuses 0 and >90; the trigger enforces the 90-day ceiling on INSERT and on any `expires_at` change, measured from a `created_at` the database stamps (`now()` on a live INSERT, whatever the client sent) and never lets move, with up to an hour of browser-clock skew clamped to the ceiling rather than refused; the backfill caps live rows); `listShareLinks` / `revokeShareLink` were already checked writes (`EGRESS-7` / `EGRESS-8`, re-verified) and now write audit rows; a document transitioning to Superseded / Void / Archived stops serving (`DRLS-5`) and supersede revokes (`DIST-1`); a deactivated creator's links die at the next resolve (`shareStillAuthorized` → `loadPrincipal` returns null for a non-active member → 410), and so do the links of a creator who no longer holds the minting tier (`creatorMayShare`, `lib/shareServe.ts` — a Viewer-minted never-expiring link from before `20261080` stops serving at the wave-2 deploy); both audit writes are checked (a refused row is reported to the caller as `auditWarning`).
- Files / Tests / Reproduced / Verified: see `DIST-6`.
- Pending migration: `supabase/migrations/20261080_dc_roundF_share_minting_and_revocation.sql` — **not applied**.

**Done-when.**
1. ✓ (pending migration for the DB half) An explicit capability — controller or library publish grant — enforced in the modal and by RLS on INSERT.
2. ✓ "Never expires" removed; the 90-day maximum enforced server-side by trigger, on the database's clock (`created_at := now()` on a live INSERT; `created_at` immutable on UPDATE) — a client-supplied or later-moved `created_at` cannot extend it.
3. ✗ An org-level admin view of every live link with bulk revoke — not built (a new admin screen outside this package's files); opened as document-control `DIST-15` (DEC-31).
4. ✓ `listShareLinks` throws (the modal renders its own list-error banner, never "None yet.") and `revokeShareLink` throws on error or on zero rows for a LIVE row — verified (`EGRESS-7` / `EGRESS-8`); revoking a row that is already revoked is a no-op success with no second audit row (the update is filtered `.is("revoked_at", null)` and re-reads on zero rows).
5. ✓ Status transitions DISABLE the link (it answers `withdrawn` while the status is not current); supersede also revokes (`DIST-1`); split / merge / archive do not revoke yet (`REV-10`'s lifecycle half, P3 LIFECYCLE). Creator deactivation: `shareStillAuthorized` fails closed → 410; so does a creator who lost the minting tier (`creatorMayShare`).

**Scope / residual.** `DIST-15` (criterion 3) — no wave-2 package owns it; the integrator schedules it (see `DIST-15`'s owner line).

---

<a id="shr-5"></a>

## SHR-5 · Every external share download writes ZERO rows to download_audits — the insert names a `source` column that does not exist, and the failure is doubly swallowed
- **Also surfaced independently as** [`DIST-7`](../document-control/05-distribution.md#dist-7) — two areas found this separately. Fix once. **DIST-7's pass rated this CONFIRMED** on the same evidence; treat the `SUSPECTED` above as superseded.

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** SUSPECTED
- **Locations:** `app/api/share/file/route.ts:129-141`, `app/api/share/file/route.ts:120`, `supabase/schema.sql:789-799`, `app/api/share/file/route.ts:15-16`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Correct, and the 'doubly swallowed' characterization is precise: supabase-js resolves with `{ error }` instead of throwing, so PostgREST's PGRST204 rejection is discarded by the ignored return value, and the bare `catch {}` would have eaten it anyway. No console.warn, no metric — the route header comment at :15-16 ('The download_audits row is written HERE') describes behavior that never occurs.

**Mechanism.** file/route.ts:130-140 inserts into download_audits with `source: stamped ? "share_link" : "share_link_unstamped"`. download_audits has no `source` column: schema.sql:789-799 defines exactly id, org_id, document_id, version_id, user_id, user_email, created_at, expires_at, watermark_policy_id, and grep across every .sql in the repo finds no ALTER TABLE adding one (the only other download_audits line in supabase/ is the RLS enable at schema.sql:1022 and the policy at 1090). Every other writer in the codebase omits it — lib/downloads.ts:132-141 and lib/docPack.ts:112-123 both insert the nine real columns only; app/api/share/file/route.ts:139 is the sole call site that sends `source`. PostgREST rejects an unknown column with PGRST204 and inserts nothing. The error is then swallowed twice over: supabase-js resolves with `{ error }` instead of throwing, so the `try { ... } catch { }` at lines 129/141 catches nothing and the returned error object is never destructured or checked — and the catch block is empty with only the comment `/* pre-migration column drift — never block the share */`, so even a genuine throw would print nothing. The request proceeds to line 145 and returns the PDF.

**Failure scenario.** A document controller shares Rev 4 of a relief-valve P&ID with an outside inspector. The inspector downloads it. /api/share/file streams the stamped PDF and attempts the audit insert, which PostgREST rejects for the unknown `source` column; nothing is logged, nothing is thrown, no console line appears. Six weeks later a PSM auditor asks 'who outside the plant received this drawing and which revision did they get?' The distribution record shows nothing. The route's own header comment (lines 15-16, 'The download_audits row is written HERE (an actual download)') and the recipient-facing claim on the landing page (share/[token]/page.tsx:141, 'Access counted on the distribution record') are both false for every share that has ever been downloaded.

**Evidence.**

```
file/route.ts:130-140 `await sb.from("download_audits").insert({ org_id: share.org_id, document_id: doc.id, version_id: versionId, user_id: (share.created_by as string | null) ?? null, user_email: null, created_at: ..., expires_at: ..., watermark_policy_id: null, source: stamped ? "share_link" : "share_link_unstamped", });` followed by line 141 `} catch { /* pre-migration column drift — never block the share */ }`. schema.sql:789-799 is the complete table: `CREATE TABLE IF NOT EXISTS download_audits ( id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID REFERENCES orgs(id), document_id UUID REFERENCES documents(id) ON DELETE CASCADE, version_id UUID REFERENCES document_versions(id), user_id UUID NOT NULL, user_email TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), expires_at TIMESTAMPTZ, watermark_policy_id UUID );`. Note also `user_id UUID NOT NULL` while the route passes `?? null` — a second, independent reason the insert fails when created_by is null.
```

**Chain reaction.** lib/staleCopies.ts is built entirely on download_audits ('Every download is already recorded with the exact version it delivered', staleCopies.ts:6-8). getDocumentRecall (staleCopies.ts:124-137) reads download_audits to answer 'who is still holding an outdated copy of THIS drawing'. External share recipients — the population most likely to be holding an uncontrolled paper copy in the field with no way to be notified — are structurally invisible to recall. And even once the column is added, the design is still wrong: `user_id: share.created_by` attributes the pull to the sharer, and getDocumentRecall groups by user_id (staleCopies.ts:142-158), so N external downloads collapse into one row naming the internal employee, with user_email null.

> **Verifier correction.** Downgraded to SUSPECTED and HIGH. The claim that file/route.ts:139 is 'the sole call site that sends source' is FALSE: app/(protected)/requests/[id]/page.tsx:599 and :682 both insert into download_audits with `source: "drafting_print"` / `source: "drafting"` plus ticket_id, attachment_id, attachment_type, filename and watermark_text — six columns absent from schema.sql. That means either those paths are equally broken or the live database has drifted ahead of schema.sql (which is exactly what the route's own comment anticipates). Whether the insert actually fails is a live-DB fact this repo cannot settle, so the 'ZERO rows' consequence is not observable. Also refute the secondary claim: `user_id ?? null` is NOT a second failure reason — document_shares.created_by is declared `UUID NOT NULL` (20260623:17), so share.created_by is never null. What IS confirmed regardless of drift: the write result is never checked and the catch is empty, so a real failure is invisible.

**Done when.**

- [ ] the download_audits insert in app/api/share/file/route.ts succeeds against the real schema — either `source` is added by a migration (and to supabase/schema.sql) or removed from the insert
- [ ] the insert's `{ error }` is destructured and checked, and a failure is logged loudly rather than swallowed by an empty catch
- [ ] user_id is not silently null for a NOT NULL column — the external pull is attributed distinguishably from the sharer's own downloads (e.g. a share_id column, or a sentinel actor), so getDocumentRecall does not merge outsiders into the sharer
- [ ] a test drives GET /api/share/file end to end and asserts exactly one download_audits row exists afterward

**Resolution (2026-09-29, document-control Round F wave 2).** Same defect as document-control `DIST-7` / `EGR-3` — fixed once; those records carry the description. `20261068` (P2 EGRESS) added `source` / `share_id` / `transmittal_id` and made `user_id` nullable behind an attribution CHECK; `app/api/share/file/route.ts` writes `user_id: null, share_id, source` with the served `version_id`, checks `{ error }`, logs a refusal and refuses the download `503 unrecorded` BEFORE any byte leaves — except that the refusal which IS the unapplied `20261068` is logged as the deploy order and retried once in the pre-20261068 shape (sharer-attributed, as before), so a deploy ahead of the paste records and serves rather than locking every outside recipient out (`DIST-7`).
- Tests: `lib/__tests__/shareRoutes.test.ts` — "happy path: the record lands BEFORE the bytes …" asserts exactly one `download_audits` row after a GET with the exact keys; "ahead of 20261068 … retried ONCE in the pre-20261068 shape"; "a download_audits write refused in BOTH shapes refuses the download (503 unrecorded)"; "a refusal that is NOT the missing migration … is not retried".
- Pending migration: `supabase/migrations/20261068_dc_roundF_download_audits_record.sql` (P2 — **not applied**).

**Done-when.**
1. ✓ `source` added by migration (and `schema.sql` is the pre-migration baseline by convention — the numbered sequence is the source of truth).
2. ✓ `{ error }` destructured and checked; a failure is logged loudly and refuses the download (the missing-migration refusal first earns one retry in the table's older shape).
3. ✓ `user_id` is NULL by design behind `CHECK download_audits_attributed`; the pull is attributed by `share_id`, so `getDocumentRecall` keys it `share:<id>` and flags it external — never merged into the sharer.
4. ✓ The test drives `GET /api/share/file` through the route with a Proxy-chain service client and asserts exactly one `download_audits` insert (no live database in the loop; the insert is captured, not executed).

**Scope / residual.** Historical gap documented under `EGR-3`.

---

<a id="shr-6"></a>

## SHR-6 · "never an in-review draft" is enforced only on the fallback branch — the primary current_version_id path applies no review_state filter at all

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** SUSPECTED
- **Locations:** `app/api/share/resolve/route.ts:52-71`, `app/api/share/file/route.ts:60-80`, `lib/reviewControl.ts:429-446`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The code reads exactly as claimed — the comment 'Resolve the current PUBLISHED version's file (never an in-review draft)' sits directly above the branch that does not check. MEDIUM is right: reaching it requires the unchecked relabel at reviewControl.ts:445 to fail after the promote at :429 succeeded, which is a narrow window, but the filter's absence on the primary branch means nothing else would catch it.

**Mechanism.** Both routes carry the comment 'Resolve the current PUBLISHED version's file (never an in-review draft)' immediately above a two-branch resolution. Branch one (resolve:55-58, file:64-67) takes `doc.current_version_id`, fetches that row's file_url, and applies no filter whatsoever — review_state is not selected, let alone checked. Branch two (resolve:59-71, file:68-80) runs only `if (!storagePath)` and is the only place `.or("review_state.is.null,review_state.eq.approved")` appears. Since current_version_id is set on every normal document, branch one is the path that virtually always runs and branch two is near-dead. The guard the comment describes lives exclusively on the branch that does not execute. This is not hypothetical: reviewControl.ts:429-433 promotes the pending draft into current_version_id FIRST (`.update({ current_version_id: pendingId, rev: baseRev, ... status: "Issued", ... })`) and only stamps `review_state: "approved"` afterwards at line 445 — and that second update is itself unchecked (`await supabase.from("document_versions").update({...}).eq("id", pendingId);`, no `{ error }`), so a failure there leaves current_version_id permanently pointing at a row whose review_state is still 'in_review'. Bulk upload (app/(protected)/documents/[libraryId]/page.tsx:2475) also sets current_version_id with no review gate.

**Failure scenario.** The review-completion transaction promotes an approved draft (reviewControl.ts:430) and then the relabel/approve update at line 445 fails — a transient PostgREST error, an RLS edge, a network blip — and returns an unchecked `{ error }` that nothing reads. documents.current_version_id now names a document_versions row with review_state = 'in_review' and released_at = null. Every outstanding share link on that document immediately begins serving that row's file through branch one, stamped with a footer asserting a revision, to external recipients. The route's own comment says this cannot happen.

**Evidence.**

```
resolve/route.ts:52-58 `// Resolve the current PUBLISHED version's file (never an in-review draft).` then `let versionId: string | null = (doc.current_version_id as string | null) ?? null; if (versionId) { const { data: v } = await sb.from("document_versions").select("file_url").eq("id", versionId).maybeSingle(); storagePath = (v?.file_url as string | null) ?? null; }` — the select is `"file_url"` only. The filter exists solely at line 64 inside the `if (!storagePath)` block: `.or("review_state.is.null,review_state.eq.approved")`. file/route.ts:60-80 is byte-identical in structure. reviewControl.ts:430 vs 445 shows the promote-then-approve ordering with the second write unchecked.
```

**Chain reaction.** lib/timeline.ts:330 and :514 apply the same `.or("review_state.is.null,review_state.eq.approved")` predicate when reading versions, so the codebase has a consistent notion of 'published' that the share routes' hot path skips. Extending the filter to branch one costs one added column and one comparison and makes the comment true.

> **Verifier correction.** Downgraded from HIGH/CONFIRMED because the consequence is far narrower than stated and the supporting evidence partly refutes it. In-review drafts are parked in pending_version_id, never current_version_id: revisions.ts:901-911 sets `pending_version_id: insertedRow.id` with the comment 'Move the pending pointer only; the live controlled rev is untouched', and app/api/intake/upload/route.ts:325-333 does the same for the non-auto path. The cited bulk-upload path (documents/[libraryId]/page.tsx:2461-2474) inserts a version with review_state UNSET — null, which the fallback filter explicitly allows — so it demonstrates no divergence at all. The only way current_version_id points at an `in_review` row is the failure window at reviewControl.ts:444-446 (promote committed, the unchecked approve-stamp update failed). Real, but a residual-risk defect, not a routinely-exercised path.

**Done when.**

- [ ] the current_version_id branch in both share routes selects review_state (and released_at) and refuses to serve a version that is not null/approved
- [ ] the resolution logic is extracted into one shared helper so resolve and file cannot drift apart
- [ ] reviewControl.ts:445's update checks its `{ error }` so a failed approve does not silently leave an in_review row as current
- [ ] a test points current_version_id at an in_review version and asserts /api/share/file returns an error rather than the draft

**Resolution (2026-09-29, document-control Round F wave 2).** The resolution logic is ONE helper, `lib/shareServe.ts resolveShareForServing` — both routes import it and neither carries a version query any more; its version step is `lib/shareRules.ts resolveServedVersion`, which the share modal's "resolves to" also runs (P4's `dcRoundFReviewGate.test.ts` source pin was re-pointed at it). The `current_version_id` branch selects `id, file_url, revision_label, review_state, is_branch, superseded_at` and serves only when `versionServable` holds (review_state null / `approved`, not a branch, not superseded, has a file); a current row that fails with a file present is refused — `version: null` → resolve answers `fileUrl: null`, file answers `404 nofile` — and the fallback is NOT consulted (the pointer names an unpublished row: an anomaly to refuse, not to paper over). The failure window itself is closed by P4 (`RG-12`, wave 1): the approve-stamp update after the promote checks its error — `lib/reviewControl.ts:766` `const { data: relabeled, error: relabelErr } = …update({ review_state: "approved", … })` (verified).
- Files: `lib/shareServe.ts`, `lib/shareRules.ts` (`versionServable`, `resolveServedVersion`), both routes; `lib/__tests__/dcRoundFReviewGate.test.ts` (one source pin re-pointed)
- Tests: `lib/__tests__/shareRoutes.test.ts` — "a current pointer at an in_review row (SHR-6 failure window) is NOT served and NOT fallen past; a branch / superseded current row likewise" (asserts no fallback `order()` ran and no bucket read), "a version serves only when it has a file, is null/approved, not a branch and not superseded".
- Reproduced: base `file/route.ts:73-77` selected `file_url` only on the primary branch; the filter lived at `:83` inside `if (!storagePath)`; the test fails against the base files.
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (194 files / 2595 tests, re-run after the second review fix pass).

**Done-when.**
1. ✓ The `current_version_id` branch selects `review_state` (with `is_branch`, `superseded_at`) and refuses a version that is not null / approved. `released_at` is not selected: `review_state` is the field the publish contract writes and the fallback already filters on; adding `released_at` would refuse legacy null-`review_state` rows that predate the field.
2. ✓ One shared helper; the routes cannot drift.
3. ✓ Landed by P4 `RG-12` (`lib/reviewControl.ts:766` checks `relabelErr`).
4. ✓ The test points `current_version_id` at an `in_review` row and asserts `/api/share/file` answers 404, serves nothing, and does not fall back.

**Scope / residual.** None.

---

<a id="shr-7"></a>

## SHR-7 · A share link is bound to the document, not the revision — it silently follows every rev-up, and the stamped footer's rev comes from documents.rev rather than the version actually served

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260623_document_shares.sql:16`, `app/api/share/file/route.ts:62-80`, `app/api/share/file/route.ts:102-117`, `components/documents/ShareLinkModal.tsx:133-135`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The always-current behavior is real but is the documented design, not a defect: the migration header states the route 'generates a presigned download URL for the current version's storage path', and ShareLinkModal.tsx:133-135 promises only that 'Anyone with the resulting URL can open the document until it expires or you revoke it' — no revision pinning is claimed. The stamped copy also names the rev it actually contains and carries a verify QR. The 'footer rev comes from documents.rev rather than the version served' half is false on the primary path and can only diverge on the rare fallback branch (current_version_id set but its file_url null), so I'd drop this to LOW.

**Mechanism.** document_shares stores document_id and has no version_id column (20260623:12-28). Both routes re-resolve current_version_id at request time, so what the token delivers changes whenever the document is revved. Two distinct problems follow. First, scope drift: a link created and emailed while the sharer was looking at Rev 2 delivers Rev 5 months later with no new link and no notification to either party — and the reverse on the fallback branch, where versionId is the newest approved version (file:69-79) which need not be current_version_id. Second, label mismatch: the stamp's revision text is taken from the parent document row, not the version being streamed — file/route.ts:103 `const rev = (doc.rev as string | null) ?? null;` feeding line 113's footer — while the verify QR at line 115 correctly uses `versionId`. Whenever documents.rev and the served version's revision_label disagree (bulk upload at documents/[libraryId]/page.tsx:2475 sets current_version_id without touching rev; the fallback branch can select a version other than current), the footer and the filename at line 144 print a revision the bytes are not.

**Failure scenario.** A controller shares Rev 2 of a relief-system P&ID with an insurance inspector, notes 'for the Oct audit', 90-day expiry. In week 6 the drawing is revved to Rev 3 with a materially different relief path. The inspector re-opens their bookmarked link expecting the copy they were reviewing and receives Rev 3, footer reading 'Rev 3' — a different drawing, at the same URL, silently. Neither side is told the link's contents changed. The modal's only description of the behaviour (ShareLinkModal.tsx:134) says 'Anyone with the resulting URL can open the document until it expires or you revoke it' — it never says which revision, and the UI shows no rev at all on an existing link row (lines 198-206 render note, creator, expiry, revoked flag, access count).

**Evidence.**

```
20260623_document_shares.sql:16 `document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,` — no version column in the table. file/route.ts:62-67 `let versionId: string | null = (doc.current_version_id as string | null) ?? null; if (versionId) { const { data: v } = await sb.from("document_versions").select("file_url").eq("id", versionId).maybeSingle(); ... }` — evaluated per request. file/route.ts:113 `footerNotice: `${label} Rev ${rev ?? "?"} at time of download — scan the QR to confirm it is still current.`` where rev is doc.rev from line 103, while line 115 builds the verify URL from `versionId`. Contrast the transmittal model, which records the issued rev per recipient (InspectorPanel.tsx TransmittalTrail carries `rev: string | null` and 'flags recipients now holding a superseded rev').
```

**Chain reaction.** Because the served revision floats, the sharer's mental model of 'what I sent' and the recipient's 'what I received' can never be reconciled — and download_audits, the only record that would resolve it, is not being written at all (see the download_audits finding). Fixing the audit insert without pinning or surfacing the revision still leaves 'which rev did the vendor actually pull?' answerable only per-download, never per-link.

> **Verifier correction.** The label-mismatch half is largely refuted. Bulk upload does NOT desynchronize rev: documents/[libraryId]/page.tsx:2421 computes `const rev = item.rev.trim() || "0"`, writes it to documents.rev at :2436, and writes the SAME value as revision_label at :2463. reviewControl.ts:430 likewise sets rev/revision to baseRev and :445 sets revision_label to baseRev. The only remaining divergence is the fallback branch (file:68-80) selecting a version other than current_version_id when the current row has no file_url — a genuine but narrow case. The scope-drift half stands as described, though 'always delivers the current approved rev' is a defensible doc-control stance; the defect is that the sharer cannot pin a rev and neither party is told the payload changed.

**Done when.**

- [ ] the share model states its intent explicitly: either document_shares carries a version_id and serves that pinned revision, or the 'always current' behaviour is stated in ShareLinkModal and on the /share landing page
- [ ] the stamped footer's revision is read from the version actually streamed (document_versions.revision_label for versionId), not from documents.rev
- [ ] the existing-links list in ShareLinkModal shows which revision the link currently resolves to
- [ ] the download filename at file/route.ts:144 uses the same version-derived label as the footer

**Resolution (2026-09-29, document-control Round F wave 2).** The model is stated, everywhere the person meets it, and recorded as DEC-46: **a share always serves the CURRENT revision, no version pinning.** The modal's Create box says so ("today Rev X; if the document is revved, the same link serves the new revision"), every live link row says what the DOCUMENT serves right now as the ROUTES would decide it — "resolves to Rev X" from the served row's own label, "no published file to serve", or "not serving now" when the document is withdrawn / held (the modal's `loadShareDocumentContext` runs `lib/shareRules.ts resolveServedVersion`, the same function `lib/shareServe.ts` calls for both routes, and the refusal comes from `shareRefusalState`, the same status + hold rule) — and "couldn't confirm whether it is serving" when that refusal is only the modal's own failed read (a documents or hold read error: minting is refused, but the service-role routes may be serving). What a row does NOT compute is the per-link half of the routes' decision — whether that link's creator still holds the authority it serves on (`shareStillAuthorized`, `creatorMayShare`); the list states it instead ("A link serves on its creator's current authority: it also stops serving if they leave the organisation, can no longer read this document, are denied download on it, or no longer hold Document Control / Admin or a publish grant on this library."), the landing page says "This link always serves the **current** revision at the moment you download — it is not pinned to the revision it was shared at" beside `Rev X · <status>`, and the stamped footer reads `<label> Rev <served> (<status>) at time of download — a share always serves the current revision.` The label-mismatch half: `servedLabels` (`lib/shareServe.ts`) takes the revision from the SERVED row's `document_versions.revision_label` (`documents.rev` only when the row has no label) and both the footer and the `Content-Disposition` filename use it — the test serves a document whose `rev` is `A` from a version labelled `B` and asserts `P-101_RevB.pdf` and a `Rev B` footer.
- Files: `lib/shareServe.ts`, `lib/shareRules.ts` (`resolveServedVersion`), `lib/documentShares.ts` (`loadShareDocumentContext` → `served`; `shareRefusalState` → `confirmed`), `app/api/share/file/route.ts`, `app/api/share/resolve/route.ts`, `components/documents/ShareLinkModal.tsx`, `app/share/[token]/page.tsx`, `audit-reports/DECISIONS.md` (DEC-46)
- Tests: `lib/__tests__/shareRoutes.test.ts` — "happy path … the copy names the SERVED version's label" (filename + footer), "returns the served version's rev label …" (resolve), "loadShareDocumentContext resolves what a link serves by the ROUTES' rule (SHR-7) …" (label `B` not `rev` `A`; an in-review current row → nothing, as the server answers `nofile`; a read error → unknown), "shareRefusalState says whether a refusal is CONFIRMED … or only UNCONFIRMED …", the modal / page source pins (the unconfirmed branch precedes "not serving now"; the creator-authority sentence under the list).
- Reproduced: base `file/route.ts:113` `const rev = (doc.rev …)` feeding the footer at `:123` and the filename at `:154`; the modal's only description at `:149` never named a revision.
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (194 files / 2595 tests, re-run after the second review fix pass).

**Done-when.**
1. ✓ Intent stated explicitly: always current — in the modal, on the landing page, on the copy, and as DEC-46.
2. ✓ The footer's revision is the served version's `revision_label`.
3. ✓ Every live link row shows the revision the document currently resolves to — computed by the routes' own resolution (`resolveServedVersion`), not `documents.rev`. It reads "no published file" / "not serving now" when the DOCUMENT is one the server would answer `nofile` / refuse for, and "couldn't confirm" when the modal's own read failed. It is not a per-link verdict: a link whose creator has lapsed (left, lost read access, is denied download, lost the minting tier) is refused `410` by the server while its row still names the document's revision — the list says so in words rather than claiming the row is exact.
4. ✓ The filename uses the same version-derived label as the footer.

**Scope / residual.** None.

**Verification fix (2026-09-30, document-control Round F wave 2).** Two corrections to the modal. (a) Its context-load `catch` (`components/documents/ShareLinkModal.tsx:117-125`) cleared `canMint` and `served` but left `refusal` / `refusalConfirmed` from the previous read, so a CONFIRMED refusal ("existing links are not serving: …") could survive a later failed read; the catch now sets the unconfirmed refusal ("Couldn't confirm the document's state; it is treated as unshareable.", `refusalConfirmed` false), so the banner says whether existing links serve couldn't be confirmed. (b) The creator-authority sentence under the list now also names a download deny ("… can no longer read this document, are denied download on it, or …"), the check `SHR-3`'s verification fix added at serve time; the quote in the Resolution above is updated to the shipped text.
- Files: `components/documents/ShareLinkModal.tsx`
- Tests: `lib/__tests__/shareRoutes.test.ts` — the modal source pin ("the modal offers no never-expires option …") now asserts the catch body resets the refusal to the unconfirmed one, and the extended sentence. A source pin, not a rendered-component test.
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (195 files / 2602 tests).

---

<a id="shr-8"></a>

## SHR-8 · On shared copies the stamp is placed by a hardcoded fallback that assumes the bottom-right corner is empty — on an engineering drawing that is the title block

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/share/file/route.ts:107-118`, `lib/stamping.ts:257`, `lib/stamping.ts:100-101`, `lib/stampLayout.ts:150-154`, `lib/stampLayout.ts:131-146`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and worse than stated: even if sourceBytes were passed, lib/stamping.ts:100 `if (typeof document === "undefined") return null;` makes ink analysis impossible in any server route, so every server-stamped share copy is hardcoded to bottom-right QR + bottom footer. I found no guard anywhere on this path.

**Mechanism.** applyStampToPdfDoc chooses where to place the QR plate and footer from a per-page ink analysis: `const ink = opts.sourceBytes ? await analyzePageInk(opts.sourceBytes) : null;` (stamping.ts:257). The share route calls it without sourceBytes (file/route.ts:109-117 passes only userLabel, timestamp, watermarkText, footerNotice, verifyUrl), so ink is null and every page falls back to FALLBACK_INK (stamping.ts:271). FALLBACK_INK is `{ corners: { br: 0, bl: 1, tr: 1, tl: 1 }, topBand: 1, bottomBand: 0 }` (stampLayout.ts:150-154) — it asserts the bottom-right corner and the bottom band are blank. pickQrCorner scores br at 0 and returns 'br' (stampLayout.ts:131-140); pickFooterEdge(topBand=1, bottomBand=0) evaluates `0 > 1 + 0.06` false and returns 'bottom' (stampLayout.ts:144-146). On a drawing sheet the bottom-right corner is the title block — number, revision, approval signatures. Passing sourceBytes would not help either: analyzePageInk returns null immediately on the server (`if (typeof document === "undefined") return null;`, stamping.ts:100-101), so this path can never do better than the fallback as written. The internal callers do pass it and run in the browser: lib/docPack.ts:95-96 `await applyStampToPdfDoc(single, { sourceBytes: bytes, ...})` and components/viewers/FullScreenViewer.tsx:1007-1008.

**Failure scenario.** An outside fabricator downloads a shared piping isometric. The QR plate and the footer notice land over the bottom-right title block, covering the drawing number, revision letter and the checked/approved signature blocks — the fields a receiving shop reads first to confirm what it is holding. The recipient now has a marked copy whose identity block is obscured, and the route's own header comment (file/route.ts:12, 'stamped with the same applyStampToPdfDoc as internal downloads') asserts a parity with the internal path that does not exist, because the internal path supplies the analysis input and this one structurally cannot.

**Evidence.**

```
file/route.ts:109-117 — the StampOptions object contains no sourceBytes key. stamping.ts:46-48 documents the intent: `/** The original PDF bytes. When provided (and a DOM exists), each page is rasterized at thumbnail size to find its empty regions so the QR and footer land where the drawing ISN'T. Omit → conventional placements. */ sourceBytes?: ArrayBuffer | Uint8Array;`. stampLayout.ts:148-154 `/** Neutral fallback when raster analysis isn't available (no DOM, render failure): the historical placements. */ export const FALLBACK_INK: PageInk = { corners: { br: 0, bl: 1, tr: 1, tl: 1 }, topBand: 1, bottomBand: 0 };`. stamping.ts:100 `if (typeof document === "undefined") return null;`.
```

**Chain reaction.** Every server-side stamping path inherits this — the share download is currently the only one, but any future server-rendered pack or transmittal attachment will land in the same place. A server-capable ink analysis (pdfjs-dist under Node with a canvas shim) or a title-block-aware default (prefer top-left / top-right on landscape sheets) fixes all of them at once.

> **Verifier correction.** Scope note: the QR plate is bounded (stampLayout.ts:174, qrSize max 64pt, white backing at 0.92 opacity), so the obstruction is a corner plate, not a full overlay — and 'bottom-right is the title block' is a domain judgment about the org's drawings, not something the repo shows. The placement logic itself is confirmed exactly as claimed.

**Done when.**

- [ ] the server-side stamp either performs a real ink analysis or uses a fallback that does not assume the bottom-right corner is blank on a drawing sheet
- [ ] the parity claim in app/api/share/file/route.ts:12 is corrected or made true
- [ ] a stamped shared copy of a representative title-blocked drawing is inspected and the QR/footer do not overlap the title block

**Resolution (2026-10-01, public-surfaces Round F).** Reproduced against `c23611b`: with no DOM, `applyStampToPdfDoc` fell back to `FALLBACK_INK` (`{ br: 0, … bottomBand: 0 }`), which put the QR plate bottom-right and the footer bottom. In a fixture of four representative title-blocked sheets, every one had a mark over its title block. That held after the rotation fix too. Server-side ink analysis would need a Node canvas, a new native dependency, so the fix is a title-block-aware blind placement:
- `lib/stampLayout.ts` `fallbackInk(pageW, pageH)` replaces the `FALLBACK_INK` constant. The QR goes top-left, the one corner neither ISO 7200 nor ASME Y14.1 gives a block. The footer runs along the TOP, just right of the QR, in every orientation: the bottom band is the title block's on portrait and landscape sheets alike. `titleBlockReserve(pageW)` (≤ half the sheet, at most 520 pt) is left free on the right of the top band for the revision block (ASME Y14.35 puts it top-right; ≈ 504 pt on a large sheet).
  - *Corrected in the second review fix pass.* The first write-up ran a portrait page's footer along the BOTTOM ("a text page's footer margin"), narrowed by the right-hand reserve. A portrait sheet's title block takes most of the bottom width (ASME A: 450 of the 540 pt inside the border; ISO A4: 510 of 547), so the reserve did not clear it, and the narrower footer wrapped taller. The reviewer measured the share route's footer: 3 lines over an ASME A portrait title block (base: 1) and 4 over an ISO A4 portrait one (base: 2). The four fixtures were all displayed landscape, so done-when 3 had been claimed on a set that left out the most common small-drawing format.
- `lib/stamping.ts` uses the blind placement only for a page that was not measured (`measured ?? fallbackInk(width, height)`, `reserveRight: measured ? 0 : titleBlockReserve(width)`). A measured page in the browser still places by its ink.
- `app/api/share/file/route.ts`: the header comment now says the server stamp carries the same marks but placed BLIND, by the title-block-aware fallback. It no longer implies parity with the browser paths. This is a comment-only edit in P1's merged file.
- Tests:
  - `lib/__tests__/stampingRotation.test.ts` "SHR-8 — the blind stamp keeps the QR and the footer off the title block": seven sheets with title blocks drawn where the standards put them, each stamped with both server routes' footers (the share download's and the transmittal portal's). Displayed landscape: an ASME B landscape with a top-right revision block, an ANSI D stored portrait at `/Rotate 90`, an ISO A4 landscape with a 180 mm title block, and an ISO A3 stored portrait at `/Rotate 270`. Displayed portrait (added in the second review fix pass): an ASME A portrait (612×792) with a 450×180 pt title block and a 4 in revision block top-right, an ISO A4 portrait (595×842) with a 510×156 pt title block, and an ASME A stored landscape at `/Rotate 90`. The QR, caption and every footer line are on-page, never intersect a title or revision block, and stay out of the bottom half of the sheet, and the QR is top-left. A measured page is unaffected. The four landscape sheets fail on the base fallback; the three portrait sheets fail on the first write-up's bottom-footer fallback (6 of the 14 cases, checked by restoring it).
  - `lib/__tests__/stampLayout.test.ts` "fallbackInk — the blind placement is title-block-aware" (the footer edge is the top for landscape and portrait sizes alike).
  - `lib/__tests__/psStampRoundF.test.ts` "SHR-8 — the share route no longer claims a placement parity it cannot have".
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (258 files / 4636 tests: 4629 passed, 7 expected-fail). Re-run after the second review fix pass: `tsc` 0, `eslint` 0, full `vitest` green (258 files / 4653 tests: 4646 passed, 7 expected-fail).

**Done-when.**
1. ✓ The server-side stamp uses a fallback that does not assume the bottom-right corner is blank on a drawing sheet.
2. ✓ The parity claim in `app/api/share/file/route.ts`'s header is corrected.
3. ✓ Stamped copies of representative title-blocked drawings, portrait and landscape (ASME A and ISO A4 portrait included), are inspected programmatically: the drawn geometry of every mark is checked against the title and revision blocks, and none overlaps. There was no visual inspection; this audit has no browser. *Corrected in the second review fix pass:* the first claim rested on landscape sheets only, and portrait sheets did overlap (see above).

**Scope / residual.**
- The blind placement cannot know where a particular sheet's blocks are; it encodes the two standards' layout.
- On a portrait sheet the right-hand reserve is half the width (306 pt on Letter), so the footer's longest line ends by construction at most at x ≈ 288 pt on Letter (≈ 280 on A4). A revision block wider than about 4 in (inside a 0.5 in border) can meet it.
- The top footer is narrower on a portrait sheet, so it wraps to more lines: with the share notice, 7 lines (≈ 75 pt) on Letter beside the QR, in the top-left of the drawing field. On a text page that is the header margin. No title or revision block is there in either standard.
- *Corrected in the second review fix pass:* the first residual said a full-width bottom title block kept the footer "under that block's lower edge". The footer printed over the block, and not only for full-width blocks.
- The diagonal watermark crosses everything by design (15% opacity).
- See DEC-64 (public-surfaces PS-STAMP).

---

<a id="shr-9"></a>

## SHR-9 · The Field Mode service worker persistently caches the stamped share PDF and the resolve response, defeating Cache-Control: no-store — a revoked link keeps serving from the recipient's device

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `public/sw.js:196-213`, `public/sw.js:113-118`, `app/api/share/file/route.ts:152-158`, `app/layout.tsx:93`, `components/pwa/ServiceWorkerManager.tsx:30-33`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The caching is real, but the finding's framing overstates the consequence: the branch is NETWORK-FIRST, so an online recipient always gets the live 410 for a revoked link — the cache is served only when the fetch throws (offline). And the recipient already saved the stamped PDF to their filesystem via the anchor at page.tsx:75-81, so the SW copy adds essentially no exposure beyond the file they legitimately hold. LOW.

**Mechanism.** ServiceWorkerManager is mounted in the ROOT layout (app/layout.tsx:103 `<ServiceWorkerManager />`), not the (protected) layout, so it registers /sw.js for every visitor to /share/[token] — including outsiders with no account. The page fetches the file with `fetch(data.fileUrl)` (share/[token]/page.tsx:67), a same-origin non-navigate GET to /api/share/file. sw.js routes it: not cross-origin (line 118 guard passes), no _rsc header (line 145-152), not mode 'navigate', and /api/share/file matches neither the /_next/static prefix nor the static-extension regex at line 172-175 — so it falls through to the final 'Other same-origin GETs → network-first with cache fallback' handler at lines 196-213, which calls `cachePut(RUNTIME_CACHE, request, res)` on every successful response. cachePut (lines 113-118) gates only on `response.ok` and `response.type === "opaque"`; it never inspects Cache-Control. The route sets `"Cache-Control": "no-store"` at file/route.ts:149 specifically to prevent this, and the Cache API ignores it. The identical path caches /api/share/resolve's JSON. Both entries survive until VERSION is bumped (sw.js:36), because activate only deletes caches not starting with the current VERSION (lines 54-64).

**Failure scenario.** A vendor is sent a share link to a Rev 3 piping isometric. They open it on a tablet; the SW caches both the resolve JSON and the full stamped PDF into RUNTIME_CACHE. The drawing is found to have a wrong wall-thickness call-out and the controller revokes the link the same afternoon. The vendor's tablet goes into the plant, where cell coverage drops. Their fetch of /api/share/file throws, the SW's catch at line 207 finds the cached entry and returns it, and the tablet re-downloads and re-prints the superseded, revoked Rev 3 — with the revocation invisible, because the cached resolve JSON also replays the success state. Revocation is server-side-correct (file/route.ts:48) and still does not kill the copy.

**Evidence.**

```
sw.js:196-213 `event.respondWith((async () => { try { const res = await fetch(request); cachePut(RUNTIME_CACHE, request, res); return res; } catch (err) { const cached = await caches.match(request); if (cached) return cached; ... } })());`. sw.js:113-118 `function cachePut(cacheName, request, response) { if (!response || !response.ok || response.type === "opaque") return; const copy = response.clone(); caches.open(cacheName).then((c) => c.put(request, copy)).catch(() => undefined); }` — no Cache-Control inspection. file/route.ts:145-151 `return new NextResponse(Buffer.from(outBytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": ..., "Cache-Control": "no-store" } });`. sw.js:15-17 already states the principle it violates here: 'Deliberately NOT cached: cross-origin requests (Supabase, R2 signed URLs, Stripe, fonts) ... Signed URLs expire and auth must always hit the network, so we never serve those from cache.' — the same reasoning applies to a token-gated same-origin PDF and was not extended to it.
```

**Chain reaction.** The same handler caches every other token-gated same-origin GET on public surfaces, including /api/verify — so the 'is the paper in my hand still current?' answer can also be served stale from cache offline, which is precisely the condition (in the plant, no signal) the verify QR exists for.

> **Verifier correction.** Severity HIGH → MEDIUM, and the headline overstates. The handler is network-FIRST: the cached copy is only returned when `fetch` throws (:203-208), i.e. the device is offline. Online, a revoked link gets the fresh 410 and the stale entry is overwritten. So the confirmed defect is that a controlled PDF and its metadata are written to durable Cache Storage on an outsider's device in direct contradiction of no-store, surviving until VERSION changes (sw.js:36, :54-64) — not that a revoked link keeps serving in normal use. Also, a first-time visitor's first load is typically not yet controlled by the SW, so caching begins on a subsequent visit; nobody ran the app to check which.

**Done when.**

- [ ] sw.js's cachePut refuses any response carrying Cache-Control: no-store / no-cache / private
- [ ] /api/share/**, /api/verify** and /share/** are explicitly excluded from service-worker caching (an early return alongside the cross-origin guard at sw.js:118)
- [ ] VERSION is bumped so existing clients drop already-cached share payloads on activate
- [ ] a test asserts a response with Cache-Control: no-store is not written to RUNTIME_CACHE

---

<a id="shr-10"></a>

## SHR-10 · The recipient of a shared controlled document is never identified or logged — access_last_ip is a dead column and the routes capture nothing about who pulled the file

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260623_document_shares.sql:27`, `app/api/share/file/route.ts:129-140`, `app/api/share/resolve/route.ts:59`, `supabase/migrations/20260623_document_shares.sql:8-10`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Claim of absence confirmed by repo-wide search. The only recipient-side data captured is a count and a timestamp; the download_audits row that /api/share/file writes is attributed to the SHARER, so the distribution record cannot distinguish one recipient from four.

**Mechanism.** document_shares declares `access_last_ip TEXT` (20260623:27) under an `-- Audit` heading. Two differently-shaped searches — grep for access_last_ip across .ts/.tsx/.sql, and a repo-wide grep excluding node_modules — return exactly one hit: the CREATE TABLE line itself. Nothing writes it. bump_share_access (20260818:97-99) updates only access_count and access_last_at. Neither route reads any request header — no x-forwarded-for, no user-agent, no referer — and neither takes any recipient identity: there is no email gate, no name prompt, no acknowledgement step on the landing page (share/[token]/page.tsx renders only a download button). The one record that would have carried an actor, download_audits, sets `user_id: share.created_by` and `user_email: null` (file/route.ts:134-135), i.e. it names the internal sharer, not the outsider — and that insert fails outright anyway. So the total recorded fact about an external distribution is an integer that went up.

**Failure scenario.** A PSM incident review asks who outside the plant received the pre-incident revision of a P&ID. The share modal shows a link with note 'for John at the vendor' — free text typed by the sharer, ShareLinkModal.tsx:107-112 — and an access count of 4. Whether those four opens were John, John's four colleagues, someone who found the URL in a forwarded email thread, or a crawler is unknowable and unrecoverable. The link is also freely forwardable by design: possession of the token is the entire authorization (file/route.ts:14 'Auth: possession of the unguessable token'), so there is no reason to believe the accessor is the intended recipient at all.

**Evidence.**

```
20260623_document_shares.sql:24-28 `-- Audit\n  access_count INTEGER DEFAULT 0,\n  access_last_at TIMESTAMPTZ,\n  access_last_ip TEXT\n);` and the migration's own promise at lines 8-10: 'Each access bumps access_count and access_last_at for the audit trail.' file/route.ts:134-135 `user_id: (share.created_by as string | null) ?? null, // attributed to the sharer — the outsider has no account\n      user_email: null,`. No `req.headers.get(...)` call appears anywhere in app/api/share/**.
```

**Chain reaction.** Dead FK/columns nothing ever writes is an established pattern in this codebase (checkout_sessions.linked_ticket_id, projects.linked_ticket_id, document_versions.related_ticket_id per the prior audits); access_last_ip is the same shape but sits on the audit surface for external document distribution, where the missing data is the regulatory record. Combined with the failed download_audits insert and the possibly-dead access counter, a shared controlled drawing can leave the plant leaving no durable trace at all.

> **Verifier correction.** The conclusion 'the total recorded fact is an integer that went up' inherits finding 3's unresolved question — if the live download_audits table has drifted to include `source`, that row does land (naming the internal sharer, not the outsider). Either way the external recipient is unidentified, which is the finding's substance. Also worth noting the counter itself is best-effort and unchecked (resolve:83), so even the integer is not guaranteed.

**Done when.**

- [ ] access_last_ip is either populated (from the request's forwarded-for header, via bump_share_access taking it as a parameter) or dropped, so the schema stops advertising an audit field that does not exist
- [ ] each access records what can honestly be captured — timestamp, IP, user-agent — as a row per access, not just a counter
- [ ] a share can optionally require the recipient to identify themselves before the file is released, so 'who received this revision' is answerable
- [ ] the distribution record distinguishes an external share pull from the sharer's own internal download

**Resolution (2026-09-29, document-control Round F wave 2).** What can honestly be captured is captured, per access, and nothing is pretended. `supabase/migrations/20261081_dc_roundF_share_access_log.sql` creates `document_share_accesses` (`share_id`, `org_id`, `document_id`, `version_id`, `kind` ∈ {`resolve`, `download`, `refused`}, `reason` (refused rows only), `ip`, `user_agent`, `refused_minute`, `created_at`; RLS on; one controller-only SELECT policy; no member write policy — service-role written; attribution uuids, not FKs, so the trail outlives the share) and re-creates `bump_share_access(uuid)` pinned at its existing arity, writing NO IP. The accessor's IP lives ONLY on `document_share_accesses` (controllers read it): `document_shares` rows are readable by every member who can read the document (`/api/share/list`, `20261066`), so writing `access_last_ip` there would hand an outside recipient's IP to Viewers. `access_last_ip` therefore stays unwritten, and `20261081` sets its `COMMENT` to say it is unused by design and where the trail is. It is not dropped: older backups carry the key and the restore upserts it. `lib/shareServe.ts requestMeta` reads the first `x-forwarded-for` hop (else `x-real-ip`) and the user agent, bounded (64 / 512 chars); `recordShareAccess` writes one row per resolve (link opened) and per download (bytes left), checked and logged loudly on failure. A REFUSED attempt on a known share is recorded too — `resolveShareForServing(sb, token, meta)` writes a `kind: "refused"` row with the reason (`revoked`, `expired`, `notfound` (cross-org), `authority_lapsed`, `withdrawn`, `on_hold`) before returning the refusal, and the bytes route adds `nofile` and `unrecorded` — so someone still using a revoked link, and from where, is on the trail. Refused rows are bounded to one per share per minute: the route stamps `refused_minute` and `20261081`'s partial unique index `document_share_accesses_refused_bound (share_id, refused_minute) WHERE kind = 'refused'` refuses the rest (the `23505` is treated as the bound working, not logged). Served opens are bounded the same way, because a live token can be looped as easily as a dead one: `resolve_minute` plus `document_share_accesses_resolve_bound (share_id, COALESCE(ip, ''), resolve_minute) WHERE kind = 'resolve'` — one open per share per client IP per minute (a missing IP is one bucket). Download rows are NOT bounded: each is a copy that left, paired with its `download_audits` row (the bytes route stamps and streams a PDF per request, so a loop there is a real distribution, recorded as one). An unknown token has no share to attribute to and writes nothing. The `download_audits` row is attributed by `share_id` with `user_id` NULL (`DIST-7`), so an external pull never appears as the sharer. Recipient identification is NOT added — by the stated default (DEC-46): possession of the token is the whole authorization and the record says what it knows (IP, UA, when, which version) rather than a name nobody verified.
- Files: `supabase/migrations/20261081_dc_roundF_share_access_log.sql`, `lib/shareServe.ts`, `app/api/share/resolve/route.ts`, `app/api/share/file/route.ts`, `lib/exportTables.ts` (backup decision for the new table — excluded, with the reason)
- Tests: `lib/__tests__/shareRoutes.test.ts` — "requestMeta takes the first forwarded-for hop and the user agent, bounded, never identity", "happy path … the access row: IP + UA, kind download, no identity", "a refused attempt on a KNOWN share leaves one 'refused' access row with the reason, IP and UA …", "refused rows are BOUNDED to one per share per minute and served opens to one per share per client IP per minute … a download row is never bounded", "returns the served version's rev label … records the open (IP on the controller-only trail); bumps the counter WITHOUT the IP", "document_share_accesses: RLS on, one controller SELECT policy, no member write policy, attribution uuids not FKs" (both bound indexes, both shape CHECKs), "bump_share_access keeps its arity … no IP, service_role only" (and the `access_last_ip` column comment).
- Reproduced: repo-wide, `access_last_ip` appeared only in `20260623:27`; no `req.headers.get` under `app/api/share/**` on the base commit.
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (194 files / 2595 tests, re-run after the second review fix pass).
- Pending migration: `supabase/migrations/20261081_dc_roundF_share_access_log.sql` — **not applied**.

**Done-when.**
1. ✓ Superseded by the trail (pending migration): the column is neither populated nor dropped. Populating it would put an outside accessor's IP on a row every member who can read the document can read; the IP lives on the controller-only `document_share_accesses` row instead, and `20261081` sets the column's `COMMENT` to "Unused by design … The per-access IP trail is document_share_accesses", so the schema no longer advertises it as an audit field — and empties any value an earlier draft's two-argument counter left in it (`UPDATE document_shares SET access_last_ip = NULL WHERE access_last_ip IS NOT NULL`, counted before the transaction). (Dropping it would break the restore of older backups, which carry the key.)
2. ✓ (pending migration) One row per access — timestamp, IP, user agent, kind, version — in `document_share_accesses`, including every refused attempt on a known share (with the reason; bounded to one per share per minute); served opens bounded to one per share per client IP per minute; downloads one per copy.
3. ✗ By decision (DEC-46): no recipient identification step. The honest answer to "who received this revision" is the share's note plus the per-access trail; a name typed by the accessor would be unverified and the product default rejects it.
4. ✓ An external share pull is a `download_audits` row with `share_id` and `user_id` NULL — distinguishable from the sharer's own downloads (`lib/staleCopies.ts` flags it `external`).

**Scope / residual.** No prune job for `document_share_accesses` is added (the cron route is not this package's file; the plan notes' default was "pruned at 90 days"). What bounds growth today: refused rows at most one per share per minute, opens at most one per share per client IP per minute, downloads one per copy actually served — so a loop from one client adds at most two rows a minute per share, but many clients (or many forwarded-for values, if the platform passes a client-supplied header through) still add rows, and nothing removes them. A retention rule — the 90-day prune — belongs with the download record's, the `RET-*` owner (`document-control/08-retention.md`), recorded in DEC-46 §5; until one names it, rows are kept.

**Verification fix (2026-09-30, document-control Round F wave 2).** `supabase/migrations/20261081_dc_roundF_share_access_log.sql` is now idempotent over a paste of either earlier draft of itself (neither was handed out, but a draft-era table made the file fail: `CREATE TABLE IF NOT EXISTS` skipped it and the `resolve_minute` index then named a missing column). Before any index, it runs `ADD COLUMN IF NOT EXISTS` for `reason`, `refused_minute` and `resolve_minute`, gives a draft-era open its own `created_at` as its `resolve_minute` (so it satisfies the shape CHECK and never collides under the per-minute bound), and adds `document_share_accesses_refused_shape` / `_resolve_shape` only when `pg_constraint` lacks them, replacing the first draft's kind CHECK only when it does not admit `refused` (lines 82-117). It also empties `document_shares.access_last_ip` (line 163) — the column is unused and must not hold an outsider's IP; a DEC-30 temp inventory counts those rows BEFORE the transaction, and the final SELECT (still the one result set) adds the probes "no share carries access_last_ip" and "every column the routes write exists". Not run against a database (DEC-30: applied by hand).
- Files: `supabase/migrations/20261081_dc_roundF_share_access_log.sql`
- Tests: `lib/__tests__/shareRoutes.test.ts` — "idempotent over a paste of an EARLIER draft …" (the upgrade precedes every index, each constraint add is guarded, the inventory precedes BEGIN, one statement after COMMIT) and "bump_share_access keeps its arity …" (the only assignment to `access_last_ip` is the clear to NULL).
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (195 files / 2602 tests).
- Pending migration: `supabase/migrations/20261081_dc_roundF_share_access_log.sql` — **not applied**.

---

<a id="shr-11"></a>

## SHR-11 · The verify QR the shared copy promises is silently omitted whenever NEXT_PUBLIC_SITE_URL is unset — while the footer printed on the page tells the reader to scan it

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** document-control P12 WAVE-2 RESIDUALS for done-when 2 off Vercel — by the integrator, 2026-10-01 (fleet plan `audit-reports/fleet-plans/`).
- **Verification:** SUSPECTED
- **Locations:** `app/api/share/file/route.ts:114-116`, `lib/publicOrigin.ts:17-21`, `lib/stamping.ts:246-254`, `app/api/share/file/route.ts:113`, `.env.example:46`, `app/share/[token]/page.tsx:140-142`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed with no mitigating path: nothing logs or warns when the QR is dropped, and app/share/[token]/page.tsx:141 additionally promises the recipient the 'copy is watermarked with a verify QR'. The .env.example comment even claims a VERCEL_URL fallback that publicOrigin() does not implement.

**Mechanism.** file/route.ts:114-116 makes the verify URL conditional: `verifyUrl: versionId && publicOrigin() ? `${publicOrigin()}/verify/${doc.id}?v=${versionId}` : undefined`. publicOrigin() (publicOrigin.ts:17-21) returns the configured NEXT_PUBLIC_SITE_URL, else `window.location.origin` if a window exists, else the empty string. This route is a server route handler — there is no window — so with NEXT_PUBLIC_SITE_URL unset publicOrigin() returns "", the ternary yields undefined, and stamping.ts:246 `if (opts.verifyUrl)` skips QR generation entirely, leaving qrImage null and `pickQrCorner` never called (stamping.ts:268 `const qrCorner = qrImage ? pickQrCorner(...) : null;`). Nothing warns. Meanwhile the footer text at file/route.ts:113 is unconditional and ends '— scan the QR to confirm it is still current', and share/[token]/page.tsx:141 tells the recipient 'copy is watermarked with a verify QR'. .env.example:46 ships the variable blank (`NEXT_PUBLIC_SITE_URL=`), and app/layout.tsx:16-18 shows the codebase already treats it as commonly unset by falling back to VERCEL_URL — a fallback publicOrigin() does not have.

**Failure scenario.** NEXT_PUBLIC_SITE_URL is not configured (it is blank in .env.example and the deploy has a Vercel-assigned domain). An outside welder receives a shared isometric, downloads it, prints it, and takes the paper into the field. The footer instructs them to scan a QR to confirm currency. There is no QR anywhere on the sheet. The one control that makes an uncontrolled copy self-verifying is absent, and the instruction to use it is present — so the reader's most likely conclusion is that the print is fine and the QR fell off in copying, not that verification was never possible.

**Evidence.**

```
file/route.ts:109-117 `await applyStampToPdfDoc(pdfDoc, { userLabel: "shared-link", timestamp: new Date(), watermarkText: "UNCONTROLLED — SHARED COPY", footerNotice: `${label} Rev ${rev ?? "?"} at time of download — scan the QR to confirm it is still current.`, verifyUrl: versionId && publicOrigin() ? `${publicOrigin()}/verify/${doc.id as string}?v=${versionId}` : undefined, });`. publicOrigin.ts:18-21 `const configured = (process.env.NEXT_PUBLIC_SITE_URL || "").trim().replace(/\/+$/, ""); if (configured) return configured; if (typeof window !== "undefined") return window.location.origin; return "";`. stamping.ts:246-254 `if (opts.verifyUrl) { try { const { toDataURL } = await import("qrcode"); ... } catch (e) { console.warn("[stamping] QR generation failed (stamp continues without it)", e); } }` — no else, no warning when verifyUrl is simply absent.
```

**Chain reaction.** The same server-side publicOrigin() gap has already been reported against transmittal and ticket emails by the notifications and drafting-flow audits (audit-reports/notifications/08-edges-and-invariants.md:416-422, audit-reports/drafting-flow/13-edges-and-invariants.md:503-516, which explicitly notes 'publicOrigin() returns "" on the server when NEXT_PUBLIC_SITE_URL is unset, so the fix must fail loudly'). This is the same root cause reaching the printed page rather than an email.

> **Verifier correction.** Downgraded to MEDIUM/SUSPECTED: whether the trigger condition actually holds depends on deployment configuration this repo cannot see. `.env.example:46` being blank is a template placeholder, not evidence about production, and publicOrigin.ts:12-15 documents the variable as required in every environment. The confirmed part is the code shape — a conditional QR paired with an unconditional instruction to scan it and no diagnostic when it is skipped. Note this compounds with finding 10: with no verifyUrl there is no QR plate at all, so only the footer lands in the bottom band.

**Done when.**

- [ ] the footer text is conditional on the QR actually being stamped — no page ever instructs a reader to scan a QR that is not there
- [ ] publicOrigin() on the server falls back to the request origin (or VERCEL_URL, as app/layout.tsx:16-18 does) instead of returning an empty string, or the share download fails loudly rather than shipping an unverifiable copy
- [ ] stamping.ts logs when verifyUrl is absent, not only when QR generation throws
- [ ] .env.example documents NEXT_PUBLIC_SITE_URL as required for share/print verification

**Partial (2026-09-29, document-control Round F wave 2).** Item 1 landed; items 2–4 are `PHYS-11`'s (PS-STAMP's files), so the finding stays OPEN. The share footer is built by `shareFooterNotice` (`lib/shareServe.ts:240`) and the scan instruction is CONDITIONAL on the verify URL actually being passed to the stamp: with an origin, `… a share always serves the current revision. Scan the QR to confirm it is still current.`; without one, `… Verify the current revision with the issuing organisation before use.` — no copy ever tells its reader to scan a QR that is not there. The route computes `verifyUrl` once (`publicOrigin()` → `${origin}/verify/<doc>?v=<version>`, `undefined` when the origin is empty) and passes the same value to the footer and to `applyStampToPdfDoc`. `lib/publicOrigin.ts`, `lib/stamping.ts` and `.env.example` are PS-STAMP's files this wave (`PHYS-11`) and are untouched here.
- Files: `lib/shareServe.ts`, `app/api/share/file/route.ts`
- Tests: `lib/__tests__/shareRoutes.test.ts` — "the footer instructs a scan ONLY when a verify URL was stamped …", "with no public origin there is no verify URL and the footer never says 'scan' (SHR-11)".
- Reproduced: base `file/route.ts:123-126` — the footer literal `… scan the QR to confirm it is still current.` was unconditional while `verifyUrl` was `versionId && publicOrigin() ? … : undefined`.
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (194 files / 2595 tests, re-run after the second review fix pass).

**Done-when (this pass).**
1. ✓ The footer text is conditional on the QR being stamped.
2. — Not done here: `publicOrigin()`'s server fallback (production URL) is `PHYS-11` / PS-STAMP (`lib/publicOrigin.ts` is theirs). The share route now fails HONESTLY in that world (a copy without a scan instruction) rather than loudly; PS-STAMP's fallback removes the world.
3. — Not done here: `lib/stamping.ts` logging when `verifyUrl` is absent — `PHYS-11` / PS-STAMP.
4. — Not done here: `.env.example` documentation — PS-STAMP.

**Scope / residual.** Stays OPEN for items 2–4. **Closer: PS-STAMP** (public-surfaces, this wave) — `PHYS-11` (the server-side `publicOrigin()` fallback, the `lib/stamping.ts` warning when `verifyUrl` is absent, the `.env.example` note); whoever lands `PHYS-11` closes `SHR-11` by pointer (the same shape as `SHR-12` and `PHYS-13`: OPEN, the closer named).

**Verification fix (2026-09-30, document-control Round F wave 2).** Citation only: `shareFooterNotice` moved from `lib/shareServe.ts:224` to `:240` when `SHR-3`'s serve-time download-deny check landed above it; the code and this finding's status are unchanged.

**Partial (2026-10-01, public-surfaces Round F; first recorded as resolved — corrected at integration from the final review).** Items 2–4 are `PHYS-11` (03-physical-bridge.md), which landed in this package; item 1 landed in P1 SHARE (above).
- `lib/publicOrigin.ts`: on the server, an unset `NEXT_PUBLIC_SITE_URL` falls back to Vercel's production domain (`VERCEL_PROJECT_PRODUCTION_URL`, never the preview host `VERCEL_URL`). With neither, the share download fails honestly: the copy has no QR, no instruction to scan one, and a logged warning.
- `lib/stamping.ts` logs when `verifyUrl` is absent and, as a backstop for every caller, drops any scan instruction from a page that carries no QR.
- `.env.example` documents `NEXT_PUBLIC_SITE_URL` as required for share and print verification.
- Tests: `lib/__tests__/psStampRoundF.test.ts` ("PHYS-11 — publicOrigin() …", "PHYS-11 / SHR-11 — the stamp never tells a reader to scan a QR it does not carry"), plus P1's `shareRoutes.test.ts` SHR-11 pins, still green.
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (258 files / 4636 tests: 4629 passed, 7 expected-fail).

**Done-when.**
1. ✓ (P1) The footer text is conditional on the QR actually being stamped. The stamper now also enforces it for a QR that failed to generate.
2. ◐ On Vercel, `publicOrigin()` on the server falls back to Vercel's production domain instead of returning `""` (while the project exposes its system environment variables, the default). It chooses that over `VERCEL_URL`, which on a preview is the gated host. **Not met off Vercel** (self-hosted or Docker) with `NEXT_PUBLIC_SITE_URL` unset: the server still returns `""`, so the share download ships a QR-less copy. It is honest (no QR, no scan instruction, a server-side `console.warn`) but unverifiable, and it neither falls back nor fails loudly.
3. ✓ `lib/stamping.ts` logs when `verifyUrl` is absent, not only when QR generation throws.
4. ✓ `.env.example` documents `NEXT_PUBLIC_SITE_URL` as required.

**Scope / residual.** Stays OPEN for done-when 2 off Vercel (see `PHYS-11`'s residual). It closes when the share download, with no configured origin, falls back to the request's own origin (refusing a `*.vercel.app` or loopback host, as `recipientOrigin()` does) or refuses loudly — assigned to document-control P12, whose files include the share routes' residuals — or when every deployment sets `NEXT_PUBLIC_SITE_URL` (the operator; the Docker build argument is documented in `.env.example`).

**Resolution (2026-10-01, document-control Round F wave 2).** P12 WAVE-2 RESIDUALS — done-when 2 off Vercel, the one limb left after P1 SHARE (item 1) and PS-STAMP (items 2 on Vercel, 3, 4). Reproduced on `00560fb`: `app/api/share/file/route.ts` built `verifyUrl` from `publicOrigin()`, which on a server with neither `NEXT_PUBLIC_SITE_URL` nor `VERCEL_PROJECT_PRODUCTION_URL` returns `""`, so the copy shipped with no QR (honest, warned, but unverifiable) — neither a fallback nor a loud refusal.
- `app/api/share/file/route.ts` (the route's origin rule only; PS-STAMP's stamping rules unchanged): a private `verifyOrigin(req)` takes `configuredPublicOrigin()` (DEC-64 §1 steps 1–2, PS-STAMP's helper — no parallel origin rule); else the origin of the request URL as the server sees it (`req.nextUrl.origin`) unless its host is one an outside party cannot open, judged by PS-STAMP's `isUnreachableRecipientHost` (a `*.vercel.app` deployment host or loopback) exactly as `recipientOrigin()` judges a browser's page host; else `""`. With `""` the route refuses LOUDLY, before any byte is read: `503 { error: "unverifiable", message }`, a `console.error` naming `NEXT_PUBLIC_SITE_URL` and the Docker build argument, and a `refused` / `unverifiable` row on the share's access trail (`recordShareAccess`); nothing is stamped, no `download_audits` row is written, no copy leaves. The recipient's message says to ask the person who shared it to contact their Document Control — nobody is notified automatically, and it does not claim otherwise. When an origin exists the QR and the scan instruction are always stamped (the footer's "no QR, no scan" branch stays in `shareFooterNotice` and the stamper's backstop).
- **What "the request URL" is, by runtime.** On Vercel it carries the host the recipient reached: a custom domain is used, a `*.vercel.app` host is refused. Under `next start` — the repo's Docker image (`CMD npm run start`) — Next 16 builds the URL from the server's BIND address, not the `Host` header (`node_modules/next/dist/server/lib/router-utils/resolve-routes.js:110`: `${protocol}://${hostname || "localhost"}:${port}${req.url}` unless `experimental.trustHostHeader`), so it is `http://localhost:3000` (or `0.0.0.0` with `-H 0.0.0.0`) whatever the recipient typed. **Off Vercel with `NEXT_PUBLIC_SITE_URL` unset, every share download is therefore refused `503 unverifiable` until the variable is set** — the loud failure, not a fallback. Before this change the same deployment served an honest copy without a QR; operators must set `NEXT_PUBLIC_SITE_URL` (a build argument of the Docker image) before deploying it — recorded in `document-control/99-fix-sequencing.md` (P12 paste/deploy order). The `Host` / `X-Forwarded-Host` headers are never read.
- Tests: `lib/__tests__/shareRoutes.test.ts` — "with no configured origin the verify QR is built on the request URL's origin when it carries a public host (Vercel's custom domain …)" (and a configured origin still wins); "self-hosted under `next start` (the Docker image) with NEXT_PUBLIC_SITE_URL unset: the request URL is the BIND address, so every share download is refused LOUDLY …" — a `NextRequest` on `http://localhost:3000` and `http://0.0.0.0:3000` carrying a public `Host` / `X-Forwarded-Host`: 503, no bytes read, no copy, no record, the refusal on the access trail, a message that claims no notification, the log naming the variable and the bind address; "… on a host an outsider cannot open (*.vercel.app, loopback), the download is refused LOUDLY …" (a preview host, `localhost`, `127.0.0.1`); "the footer never tells a reader to scan a QR the copy does not carry" (the earlier route-level pin of item 1, now on `shareFooterNotice` directly, since the route no longer produces a QR-less copy). The `@/lib/publicOrigin` mock carries the real `isUnreachableRecipientHost`. The one pre-existing route test of the QR-less 200 ("with no public origin there is no verify URL and the footer never says 'scan'") was rewritten, because SHR-11 done-when 2 replaces that behaviour (the route now refuses instead of serving a copy without a QR); its footer half is now pinned on `shareFooterNotice`. All other share tests are unchanged and green — apart from harness support (the `@/lib/publicOrigin` mock now spreads the real module, and `fileGet` takes a base URL) and the newest-definition pin of the INSERT policy, which `SHR-14` moves to `20261140`.

**Done-when.**
1. ✓ (P1 SHARE) The footer text is conditional on the QR actually being stamped.
2. ✓ On Vercel (PS-STAMP) the server falls back to the production domain, and with that unexposed the request URL's own host (a custom domain) is used, a `*.vercel.app` host refused. Off Vercel (this pass) the item is met through its **"fails loudly"** branch: under `next start` the request URL is the bind address, so with `NEXT_PUBLIC_SITE_URL` unset the share download refuses (`503 unverifiable`, logged, on the access trail) rather than shipping an unverifiable copy. The request-origin limb fires off Vercel only where the request URL carries a public host (`experimental.trustHostHeader`, or `next start -H <public name>`).
3. ✓ (PS-STAMP) `lib/stamping.ts` logs when `verifyUrl` is absent.
4. ✓ (PS-STAMP) `.env.example` documents `NEXT_PUBLIC_SITE_URL` as required.

**Scope / residual.** Code only; no migration. **Operator action:** a self-hosted deployment must set `NEXT_PUBLIC_SITE_URL` (Docker build argument) before this commit is deployed, or every share download answers `503 unverifiable` (`document-control/99-fix-sequencing.md`). Under `next start -H <name>` the request URL is `http://<name>:<port>`; a name other than loopback / `0.0.0.0` is used as-is, which may not be the address recipients reach behind a proxy — setting `NEXT_PUBLIC_SITE_URL` removes the guess, as DEC-64 §1 says. **A private or single-label bind host is printed as-is, deliberately** (integration decision, 2026-10-01): `isUnreachableRecipientHost` refuses only `*.vercel.app`, loopback and `0.0.0.0`, so a request URL on a private address (`http://10.20.0.5:3000`) or a single-label intranet name (`http://docserver:3000`) becomes the verify QR. That QR is reachable only on that network — which is the point for a plant intranet install, whose phones on plant Wi-Fi reach it; refusing such hosts would drop the verify QR for every intranet deployment, a regression. `NEXT_PUBLIC_SITE_URL` overrides it. No code change; `lib/publicOrigin.ts` unchanged. No `Host` header is trusted; an opt-in to read it was not added. The share landing page (`app/share/[token]/page.tsx`, P1's) shows its generic failure for the new `unverifiable` answer rather than a dedicated sentence. A Vercel deployment with system-variable exposure off and nothing configured refuses share downloads on its `*.vercel.app` host instead of serving a QR-less copy — the loud failure the finding asks for.

---

<a id="shr-12"></a>

## SHR-12 · bump_share_access is SECURITY DEFINER with no SET search_path, its rpc error is unchecked, and it is the sole basis for the access counter the UI and landing page present as an audit trail

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260818_followups_rls.sql:95-102`, `app/api/share/resolve/route.ts:59`, `components/documents/ShareLinkModal.tsx:205`, `app/share/[token]/page.tsx:141`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Every factual element checks out. I lower it to LOW on impact: the real distribution record is the download_audits row written independently by app/api/share/file/route.ts:129-140, so a missing RPC degrades a convenience counter (stuck at 0) rather than destroying the audit trail; and the search_path gap is only exploitable by a role that can create objects in a schema it can prepend, which Supabase's authenticated/anon roles cannot do on `public` by default.

**Mechanism.** The function is declared `CREATE OR REPLACE FUNCTION bump_share_access(p_share uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ ... $$;` with no `SET search_path` clause — grep for search_path across 20260818_followups_rls.sql returns nothing, while ten-plus other functions in the same migration tree do set it (20260812_per_library_publish_authority.sql:37, 20260816_owner_publish_access.sql:10, 20260824_team_departments.sql:19, 20260831_capability_policy_and_rails.sql:44 and :81, 20260901_db_hard_enforcement.sql:29, and standalone `SET search_path = public` lines in 20260724, 20260726, 20260806, 20260810). The migration also issues no REVOKE, so EXECUTE defaults to PUBLIC — the anon role can call it. Separately, the caller swallows the outcome: resolve/route.ts:83 is `try { await sb.rpc("bump_share_access", { p_share: share.id }); } catch { /* best-effort */ }` — supabase-js resolves with `{ error }` rather than throwing, so the catch is unreachable for the failure mode that matters and the returned error is never destructured. If the function is missing from a given database (it lives in a migration named for an unrelated feature, 'followups_rls'), every resolve silently no-ops.

**Failure scenario.** An instance is provisioned where 20260818_followups_rls.sql has not been applied — plausible, since the share feature's own migration is 20260623 and nothing in lib/schemaExpectations.ts checks for the function (it registers the table only, schemaExpectations.ts:63). Every /share resolve calls a nonexistent RPC, PostgREST returns PGRST202, supabase-js resolves with an error nobody reads, and access_count stays 0 forever. The share modal renders `<Eye /> 0` next to every link (ShareLinkModal.tsx:205) and the landing page tells the recipient 'Access counted on the distribution record' (page.tsx:141). A controller reviewing outstanding links sees zeroes and concludes no outsider ever opened them.

**Evidence.**

```
20260818_followups_rls.sql:93-102 `-- Atomic share access counter (fixes the client-side "= 1" write). SECURITY DEFINER so it increments regardless of the caller's row access. CREATE OR REPLACE FUNCTION bump_share_access(p_share uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ UPDATE document_shares SET access_count = COALESCE(access_count, 0) + 1, access_last_at = now() WHERE id = p_share; $$;` — compare 20260816_owner_publish_access.sql:10 `RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$`. resolve/route.ts:83 `try { await sb.rpc("bump_share_access", { p_share: share.id }); } catch { /* best-effort */ }`.
```

**Chain reaction.** This is the same unpinned-search_path shape the roles-and-permissions audit established, and the same unchecked-supabase-write shape the audit-logger findings established — here they compound on the one counter the product presents to controllers as evidence of external distribution. It is also the *only* signal left, because the download_audits insert never succeeds (see that finding): if this counter is also silently dead, a share link has no observable trace whatsoever.

> **Verifier correction.** The impact framing needs pulling back. A repo-wide grep shows exactly one caller (resolve/route.ts:83) and it is the SERVICE ROLE, which already bypasses RLS — so SECURITY DEFINER buys this function nothing and the privilege-escalation story requires an attacker who already holds CREATE on a schema in the caller's search_path, which is not demonstrable here. The 'anon can call it' consequence is incrementing a counter on a share id they would have to guess. The durable, cheap-to-fix findings are the missing `SET search_path` (a hardening gap consistent with the pattern list) and the unchecked rpc result, which makes a missing-function environment silently no-op the counter the UI (ShareLinkModal.tsx:205) and landing page (share/[token]/page.tsx:141) present as an audit trail.

**Done when.**

- [ ] bump_share_access is recreated with `SET search_path = public`, matching every other SECURITY DEFINER function in the tree
- [ ] EXECUTE is revoked from PUBLIC/anon and granted only to the roles that need it
- [ ] the rpc call in resolve/route.ts destructures and logs `{ error }` instead of relying on an unreachable catch
- [ ] lib/schemaExpectations.ts checks for the function, not only the document_shares table

**Partial (2026-09-29, document-control Round F wave 2).** Items 1–3 landed; item 4 (the `lib/schemaExpectations.ts` row) did not, so the finding stays OPEN. `supabase/migrations/20261081_dc_roundF_share_access_log.sql` re-creates `bump_share_access(p_share uuid)` at its EXISTING arity — the 20260818 body byte-carried, only the CREATE-time `SET search_path = public` added, no IP (the accessor IP is controller-only, `SHR-10`) — so a route already deployed keeps resolving its `{ p_share }` call across the apply (a changed arity would have dropped the function it calls); a two-argument twin from an earlier draft of the file is dropped if present; `SECURITY DEFINER SET search_path = public`, with `REVOKE ALL … FROM PUBLIC, anon, authenticated` and `GRANT EXECUTE … TO service_role` (its only caller is the service-role resolve route; `20261027` had granted `authenticated`, which nothing used). `app/api/share/resolve/route.ts:59-60` destructures `{ error: bumpError }` from the RPC and `console.error`s it with the share id — a missing function or a refused call is visible, and the resolve still succeeds (the counter is a convenience; the record is `download_audits` + `document_share_accesses`). The old arity had already been pinned by `20261020`'s `ALTER FUNCTION` (document-control `DIST-14`, Phase 7f) — this file is the CREATE-time pin plus the grant correction.
- Files: `supabase/migrations/20261081_dc_roundF_share_access_log.sql`, `app/api/share/resolve/route.ts`
- Tests: `lib/__tests__/shareRoutes.test.ts` — "bump_share_access keeps its arity (a deployed route's call resolves across the apply): the 20260818 body byte-carried, only the CREATE-time pin added, no IP, service_role only", "a refused counter RPC is logged, never swallowed, and does not fail the resolve"; `lib/__tests__/searchPathPin.test.ts` census green.
- Reproduced: `20260818_followups_rls.sql:95-102` quoted (no `SET search_path`); base `resolve/route.ts:96` `try { await sb.rpc(...) } catch { /* best-effort */ }` — the returned error never read.
- Verified: `tsc` 0, `eslint` 0 on every touched file, full `vitest` green (194 files / 2595 tests, re-run after the second review fix pass).
- Pending migration: `supabase/migrations/20261081_dc_roundF_share_access_log.sql` — **not applied**.

**Done-when.**
1. ✓ (pending migration) Re-created with `SET search_path = public`.
2. ✓ (pending migration) EXECUTE revoked from PUBLIC / anon / authenticated, granted to `service_role` only — the apply-time probe checks `has_function_privilege` for all three.
3. ✓ The RPC's `{ error }` is destructured and logged.
4. ✗ Not done — `lib/schemaExpectations.ts` is not in this package's files (public-surfaces PS-VERIFY edits it this wave for its `verify_scans` row), so no `bump_share_access(uuid)` / `document_share_accesses` expectation was added.

**Scope / residual.** Item 4 keeps this finding OPEN. Owner: the integrator's tracked follow-up — PS-VERIFY edits `lib/schemaExpectations.ts` this wave but its brief does not list `SHR-12`, so nothing assigns it. Whoever adds the expectation (the function `bump_share_access(uuid)` and the `document_share_accesses` table, both from `20261081`) closes `SHR-12`.

---

<a id="shr-13"></a>

## SHR-13 · download_audits is protected by a FOR ALL policy with only USING — any active org member can rewrite or delete the distribution record for their org

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:1089-1091`, `supabase/schema.sql:1022`, `app/api/share/file/route.ts:129-140`, `lib/staleCopies.ts:124-137`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. I grepped all of supabase/ for `download_audits`: only three hits (table DDL :789, RLS enable :1022, this policy :1090). No migration adds a restrictive policy or revokes UPDATE/DELETE, so any active org member can delete or rewrite their org's distribution records from the browser client. Claim of absence confirmed.

**Mechanism.** schema.sql:1090-1091 is `CREATE POLICY "download_audits_org_access" ON download_audits FOR ALL USING (org_id IN (SELECT my_org_ids()));` — FOR ALL with a USING clause and no WITH CHECK. Per the composition rule, a FOR ALL policy with only USING reuses USING as the INSERT/UPDATE check, so the same predicate that governs SELECT also governs INSERT, UPDATE and DELETE: membership in the org is the whole test. There is no restrictive companion policy and no append-only guard (no trigger rejecting UPDATE or DELETE on this table appears in any migration). Nothing distinguishes the audit writer from any other member.

**Failure scenario.** An engineer downloads a drawing they should not have, or an outside share is pulled and later becomes contentious. Any active member of that org — the same person included — issues a DELETE or UPDATE against download_audits for their org_id from the browser client and the row is gone or altered. RLS permits it, no trigger blocks it, and there is no separate immutable log of the download. The 'distribution record' that share/[token]/page.tsx:141 invokes to reassure the recipient, and that lib/staleCopies.ts:6-8 calls the basis for stale-copy recall, is writable by every person it is meant to record.

**Evidence.**

```
schema.sql:1022 `ALTER TABLE download_audits ENABLE ROW LEVEL SECURITY;` and schema.sql:1089-1091 `-- Download Audits\nCREATE POLICY "download_audits_org_access" ON download_audits FOR ALL\n  USING (org_id IN (SELECT my_org_ids()));` — no WITH CHECK, no AS RESTRICTIVE companion, no FOR SELECT/INSERT split. Compare the adjacent audit_logs handling at schema.sql:1086-1087, which does split INSERT out with its own check: `CREATE POLICY "audit_logs_insert" ON audit_logs FOR INSERT WITH CHECK (user_id = auth.uid());`
```

**Chain reaction.** This is the exact FOR-ALL-USING-without-WITH-CHECK shape the prior audits confirmed on tickets, notifications, email_notifications and project_documents; download_audits is the same defect on the table that records who holds which revision of a controlled drawing. It also means that even after the share route's audit insert is repaired, the rows it writes carry no integrity guarantee — the fix for the insert is not complete without this.

> **Verifier correction.** This is not a new finding for the pub-share lens — it is a rediscovery of EVID-5 in audit-reports/drafting-flow/10-audit-evidence.md:212-251, which states the same policy shape, the same composition consequence, and the same downstream impact on lib/staleCopies.ts. Per the brief it should be CITED rather than re-reported; the pub-share-specific increment is only that the share route's server-side write (file/route.ts:130) is subject to the same member-deletable table.

**Done when.**

- [ ] download_audits splits its policy: SELECT scoped to the org, INSERT with an explicit WITH CHECK, and UPDATE/DELETE denied to ordinary members (a restrictive policy or a trigger making the table append-only)
- [ ] a test confirms a non-admin org member cannot DELETE or UPDATE a download_audits row
- [ ] the same review is applied to document_shares' own FOR ALL policy, whose USING clause lets any active member revoke, un-revoke, or rewrite expires_at on any share in the org

**Resolution (2026-09-29, document-control Round F wave 2).** **Record-only close.** The `download_audits` half is closed by `20261068` (document-control P2 EGRESS, wave 1 — DEC-44 §1, `DIST-9` / `DRLS-8`): the FOR ALL policy is dropped and exactly `download_audits_select FOR SELECT` + `download_audits_insert_own FOR INSERT WITH CHECK (org_id IN (SELECT my_org_ids()) AND user_id = auth.uid())` remain — no member UPDATE or DELETE; `lib/__tests__/downloadAudits.test.ts` replays `schema.sql` + every numbered migration and proves the live set. The `document_shares` half (criterion 3) is closed by `20261022` (per-verb split: UPDATE / DELETE creator-or-controller — verified) plus `supabase/migrations/20261080_dc_roundF_share_minting_and_revocation.sql` (revocation durable by trigger, `expires_at` capped, DELETE controller-only — `DRLS-7`). Drafting-flow `EVID-5` is the owning record for the policy shape; this is the cited increment.

**Done-when.**
1. ✓ (20261068, pending apply) SELECT org-scoped; INSERT with an explicit WITH CHECK; no UPDATE / DELETE policy for members.
2. ◐ Static: the policy census in `downloadAudits.test.ts` proves no UPDATE / DELETE / ALL policy survives the replayed sequence, and 20261068's apply-time probe asserts the same against `pg_policies`; `DRLS-8`'s record carries the live confirming query.
3. ✓ (20261022 applied 2026-08-24; 20261080 pending) `document_shares` is per-verb, un-revoke and re-dating are refused by trigger, DELETE is controller-only.

**Scope / residual.** None beyond the pending applies.

---

<a id="shr-14"></a>

## SHR-14 · The share INSERT rail does not refuse a creator who is denied download on the document — the mint succeeds, the modal offers it, and the link never serves

- **Severity:** LOW
- **Status:** OPEN
- **Assigned:** document-control P12 WAVE-2 RESIDUALS (the share INSERT rail is `20261080`, a document-control migration) — by the integrator, 2026-10-01 (fleet plan `audit-reports/fleet-plans/`).
- **Verification:** SUSPECTED
- **Locations:** `supabase/migrations/20261080_dc_roundF_share_minting_and_revocation.sql:150-177`, `lib/documentShares.ts:105-115`, `components/documents/ShareLinkModal.tsx:165`, `lib/downloadDeny.ts:65-86`, `lib/shareServe.ts:210-215`
- **Opened by:** document-control Round F wave 2 verification fix (P1 SHARE, 2026-09-30) as the DEC-31 remainder of `SHR-3` — the mint-time half of its deny-download limb (the serve-time half is closed; `SHR-3`'s criteria are resolve-time only). Author-graded: no independent challenge yet.
- **Owner:** unassigned — it needs a SQL download-deny predicate, and none exists: the database decides visibility (`node_visible`) and publish authority, never download, and members' downloads are refused only by `/api/storage/download-url` through `lib/downloadDeny.ts`. The integrator schedules it; it depends only on what wave 2 lands (`20261080`'s INSERT policy, `lib/downloadDeny.ts`).

**Mechanism.** `document_shares_insert` (`20261080:150-177`) admits a row when the caller is an active member, can read the document (`node_visible`), is a controller or a granted publisher of the library (`user_can_publish_on_library`), and `document_share_refusal` is NULL. None of those reads `acl_index.deny.*.download`. The modal's gate matches the policy, not the download rule: `canMintShare` (`lib/documentShares.ts:105-115`) asks only the controller tier / the publish RPC, and `showCreate` (`ShareLinkModal.tsx:165`) is `readable && canMint === true && refusal === null`. So a publisher granted on the library but denied download on one document by uid, role or team sees the Create box, mints, and gets a row. Since the `SHR-3` verification fix the row can never SERVE — `creatorMayShare` asks `memberDownloadDenied` for the creator (`lib/shareServe.ts:210-215`) and both routes answer `410 revoked` with an `authority_lapsed` access row — so no copy leaves. What remains is a dead link that looks live to its creator.

**Failure scenario.** A lead engineer holds a publish grant on the Piping library; a restricted vendor-proprietary isometric in it carries a download deny for their team. They open its share modal: Create is offered, the row lists "resolves to Rev C", and they email the link to a fabricator. The fabricator's first click lands on "Link revoked — The owner has revoked this share" (`app/share/[token]/page.tsx:117-118`) — nobody revoked it — and the engineer, seeing the link live in the modal, has no in-app way to learn why (the list's sentence names a download deny as one reason a link can stop serving, but does not say which link). The trail records the refused attempt.

**Remediation (illustrative).** A SQL twin of `lib/downloadDeny.ts` — e.g. `user_download_denied(p_acl_index jsonb, p_uid uuid, p_org uuid) RETURNS boolean`, `STABLE SECURITY DEFINER SET search_path = public`, reading `org_members.role` / `roles` (active) and `team_members` exactly as `memberDownloadDenied` does, controllers not exempt — added to `document_shares_insert` as `AND NOT user_download_denied(d.acl_index, auth.uid(), document_shares.org_id)` (joined through the same `documents d` row) and asked by the modal beside `canMintShare`, so the Create box explains instead of minting a dead link. A shape test pins the SQL rule to the TypeScript one (the pattern `document_share_refusal` ↔ `NOT_CURRENT_STATUSES` uses).

**Done when.**

- [ ] A SQL predicate mirrors `lib/downloadDeny.ts` (uid, any role in the collection, team; a missing role set reads as Viewer; controllers not exempt), SECURITY DEFINER with `search_path` pinned, and a test pins the two rules together
- [ ] `document_shares_insert` refuses a mint when that predicate names the creator; the migration's final SELECT probes it and its pre-apply inventory counts live shares whose creator a download deny names (those already answer `410` at serve time)
- [ ] The modal's mint gate asks the same predicate and says why instead of offering the Create box

**Partial (2026-10-01, document-control Round F wave 2).** P12 WAVE-2 RESIDUALS — done-when 1 and 2 landed (the database half, **pending migration** `supabase/migrations/20261140_dc_roundF_share_download_deny_rail.sql`, DEC-30); done-when 3 (the modal) is not done here, so the finding stays OPEN. Reproduced on `00560fb`: `document_shares_insert`'s newest body is `20261080` (no later migration re-creates it) and none of its arms reads `acl_index.deny.*.download`; `lib/downloadDeny.ts` said "There is no SQL twin".
- **The predicate** (`20261140` §1): `user_download_denied(p_acl_index jsonb, p_uid uuid, p_org uuid)`, STABLE SECURITY DEFINER, `search_path` pinned — the SQL twin of `downloadDeniedTo` + `memberDownloadDenied`: a deny names the uid, ANY role in the member's ACTIVE collection (`role` + `roles`, keeping only the roles the app knows — `role_rank(r) > 0`, `20261046`'s table, which a test pins to `ALL_ROLES`, the set `normalizeRoles` keeps; a collection with none — no active membership, an empty one, or only unknown strings — reads as Viewer), or any team the uid is on (`team_members` by uid, as the TypeScript reads it); controllers are not exempt. It is no oracle: a signed-in caller may ask only about themself (anything else raises `insufficient_privilege`); the service role may ask about anyone; `REVOKE … FROM PUBLIC, anon`, `GRANT EXECUTE … TO authenticated, service_role` (the INSERT policy runs as the caller) — the DRLS-16 rule, and `dcHotfixAnonExecute.test.ts` stays green. *(Review fix: the first landing kept role strings outside the app's set, so a member holding ONLY unknown strings read as Viewer in TypeScript but not in SQL and a Viewer download deny was missed at mint; the SQL now drops them exactly as `normalizeRoles` does.)*
- **The rail** (`20261140` §2): `document_shares_insert` re-created from `20261080`'s body byte for byte plus `AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = document_shares.document_id AND user_download_denied(d.acl_index, auth.uid(), document_shares.org_id))`. Nothing else is touched (the anchor guard, `document_share_refusal`, the other three policies).
- **DEC-30 inventory** (counts only; the predicate spelled out because it does not exist before the transaction): live share rows; of those, whose creator a download deny names by uid, by role (known roles only, Viewer when none), by team — they already answer `410` at serve time; kept, revocable from Admin → Share links (`DIST-15`). Probes: the function's definer / `search_path`, its three buckets, the known-role filter, the Viewer default and the self-only rule, `role_rank` present and ranking an unknown string 0, anon refused / authenticated granted, the new arm, the `20261080` arms kept, four policies.
- **Exercised** on a throwaway PostgreSQL 16 (stub schema, the real `20261080` policy, then `20261140`, applied twice; every probe `true`, inventory 5 live / 1 uid / 2 role / 1 team on the seed): a granted publisher denied by uid, by a role in the collection, by team — each mint refused by RLS; the same publisher on documents whose deny names someone else — inserted; a controller denied by role — refused (not exempt); asking about another member — `insufficient_privilege`; the service role asking about a member with an empty collection under a Viewer deny — `true`; anon — `permission denied`. Re-run after the review fix (fresh throwaway PostgreSQL 16, stub schema with `20261046`'s real `role_rank` and `20261080`'s policy; applied twice, every probe `true` both times): a member whose only role is an unknown string under a Viewer deny — `true`, and their mint refused by RLS; the same string beside Drafter — `false`, and the mint inserted; a deny naming the unknown string itself — `false`; a member with no membership under a Viewer deny — `true`; the role inventory counts the unknown-only creator's live link and not the Drafter's. The harness was a scratch script, not committed: CI carries the shape tests only.
- `lib/downloadDeny.ts` (comment only, outside this package's file list): the header now names the SQL twin instead of saying there is none.
- Tests: `lib/__tests__/dcRoundFWave2ResidualsMigrations.test.ts` "20261140 — SHR-14 …": the function's grants, its self-only rule, its buckets / active collection / Viewer default / no controller exemption, pinned against the TypeScript source; a table of cases run through a transcription of the plpgsql (with `20261046`'s `role_rank` table parsed from the migration) and through the REAL `memberDownloadDenied` (a fake client answering the member and teams, so `normalizeRoles` is exercised) agree, each against a stated expectation (uid, additive role, controller, no membership, empty collection, only an unknown role string, an unknown string beside a known role, a deny naming an unknown string, team, another action's deny); the known-role filter's table is exactly `ALL_ROLES` and `20261046` is `role_rank`'s only definition; the policy is `20261080`'s byte for byte plus the arm (lineDiff and the ordered cut); the only objects created are the function and the policy; every `prosrc` probe matches; the one-paste protocol. `shareRoutes.test.ts`'s newest-definition pin for the INSERT policy now names `20261140`.

**Done-when (this pass).**
1. ✓ A SQL predicate mirrors `lib/downloadDeny.ts` (uid, any known role in the collection, team; a missing or unknown-only role set reads as Viewer; controllers not exempt), SECURITY DEFINER with `search_path` pinned, and a test pins the two rules together (the role set against `ALL_ROLES`).
2. ✓ `document_shares_insert` refuses a mint when that predicate names the creator; the migration's final SELECT probes it and its pre-apply inventory counts live shares whose creator a download deny names. *(In `20261140`, not yet pasted.)*
3. — Not done: the modal's mint gate does not yet ask the predicate. `components/documents/ShareLinkModal.tsx` and `lib/documentShares.ts` (`canMintShare`, `createShareLink`'s refusal sentence) are outside this package's files. After the paste a denied creator's mint is refused, and the modal shows `SHARE_MINT_REFUSED` ("Only Document Control / Admin or a granted publisher …") — refused, no dead link, but the sentence does not name the download deny.

**Scope / residual.** Stays OPEN for done-when 3. **Pending migration:** `20261140` (paste after `20261080`; `role_rank` from `20261046`; independent of `20261139`). **Closer for the remainder:** whoever next owns the share modal — `canMintShare` asks `rpc('user_download_denied', { p_acl_index, p_uid: <self>, p_org })` (callable for oneself) for the document's index, and the modal and `createShareLink` say "you are denied download on this document" instead of offering Create.

---
