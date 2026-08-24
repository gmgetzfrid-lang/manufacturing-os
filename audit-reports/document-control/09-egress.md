# 09 · Content egress

**8 findings** — 1 CRITICAL · 2 HIGH · 5 MEDIUM.

Every way bytes — or the knowledge that they exist — leave the system.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| assertSafeStorageKey — a single, well-reasoned traversal/control-byte gate every storage key passes through, with a comment that correctly explains WHY (R2 does not normalize "../", but the org-prefix gate authorizes against the first parsed prefix) | `/home/user/manufacturing-os/lib/storageKey.ts:1-52` | This is the correct shape for key authorization. Four of the five storage routes wire it in. Do not weaken it; the fix for delete/ is to add the same two lines, not to relax the check. |
| The download-url ACL guard: visibility + canDiscover + explicit acl_index deny-download enforcement at the point of URL issuance | `/home/user/manufacturing-os/app/api/storage/download-url/route.ts:48-115` | This is the ONLY place in app/api that consults an ACL before releasing bytes, and it is correct (chain-resolved acl_index, fails open only to the membership check). It is the reference implementation the other signed-URL issuers must be brought up to — not something to move or dilute. |
| resolveDocumentFile re-checks org_id on BOTH the document and the version row, with a comment explaining that the pointer columns are member-writable | `/home/user/manufacturing-os/lib/docFileServer.ts:16-35` | This is exactly the defense the transmittal portal's fileKeyForItem is missing. It proves the codebase already knows the rule; copy this pattern, don't reinvent it. |
| RESTRICTIVE node_visible() SELECT overlays on documents, collections, document_versions, document_sets and projects — so RLS-bound client queries (search, Cmd+K palette, where-used, supersession lineage) cannot return a private/hidden document's title | `/home/user/manufacturing-os/supabase/migrations/20260708_acl_rls_enforcement.sql:84-91 and /home/user/manufacturing-os/supabase/migrations/20260813_acl_close_gaps_and_audit_scope.sql:42-72` | Every client-side list surface I read (lib/search.ts searchDocuments, lib/globalSearch.ts, findRelatedDocuments step 4 which has no org filter of its own) is safe ONLY because of these policies. Every leak I found is a service-role route that bypasses them. Any refactor that moves a list query behind supabaseAdmin silently removes the only ACL predicate it has. |
| Server-side stamping in /api/share/file, with a header comment recording that the previous client-side stamp was CORS-blocked and its fallback leaked the raw file | `/home/user/manufacturing-os/app/api/share/file/route.ts:1-16, 107-125` | The 'no raw bucket URL ever reaches an outsider' invariant is real, deliberate, and hard-won. It is the standard the transmittal portal violates. |
| assertSafeExternalUrl + payload-HMAC (timestamp.sha256(body)) on webhook export delivery, with the replay/MITM reasoning recorded inline | `/home/user/manufacturing-os/lib/exportRunner.ts:277-314` | The delivery channel is hardened. The problem is the payload's contents, not its transport — fix exportTables, leave this alone. |
| The export coverage tripwire: every table must appear in ORG_SCOPED_TABLES, USER_SCOPED_FOR_ORG_TABLES, or EXPORT_EXCLUDED_TABLES with a written reason, enforced by lib/__tests__/exportCoverage.test.ts | `/home/user/manufacturing-os/lib/exportTables.ts:1-12, 171-181` | This is the right mechanism and it already carries the precedent for secret-bearing columns (ai_connections: 'secrets never leave the database'). The fix for the token leak belongs here as a column-level redaction list, so the tripwire keeps enforcing the decision. |
| /api/verify, /api/verify-package, /api/verify-hold, /api/verify-ticket each state their unauthenticated exposure contract in a header comment and hold to it (status facts only, no URLs, no files); verify-hold explicitly withholds operator notes and staff names | `/home/user/manufacturing-os/app/api/verify-hold/route.ts:48-52 and /home/user/manufacturing-os/app/api/verify/route.ts:1-12` | These are the model for how a public route should document and bound itself. verify/route.ts:60-63 also correctly rejects a version whose record_id does not match the doc — a mixed-ID probe gets a clean 404. |


---


<a id="egr-1"></a>

## EGR-1 · Transmittal portal signs the R2 key of ANY document version in the database from member-controlled JSONB — no org check, no ACL check

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution (2026-08-24, document-control Phase 1).** Confirmed end to end: `fileKeyForItem` resolved a browser-written item's version by `id` or `record_id + revision_label` with no `org_id` filter, and the service-role portal signed the bytes — the same forged-cross-org-pointer hole `lib/docFileServer.ts:26-28` guards elsewhere. Closed in three layers:
- **Read scope (closes the byte leak alone).** `fileKeyForItem(item, t.org_id)` now filters BOTH version lookups `.eq("org_id", t.org_id)`. A cross-org (or forged) item id resolves no file → 404, no signature.
- **Durable write rail.** New trigger `trg_transmittals_guard` (`20261027`) rejects any INSERT/UPDATE whose `items` JSONB names a `documentId`/`versionId` outside the row's org — so a transmittal naming out-of-org documents can never be persisted, in draft or issued state.
- **Server-minted token.** The same trigger mints `portal_token` on the issue transition, overriding any client value, so the creator cannot pre-choose or pre-know a token for a row they were not permitted to issue. (It mints only on the transition, never rotating an already-issued link.)
- **Audit attribution.** The `TRANSMITTAL_PORTAL_DOWNLOAD` row now records `user_id: t.created_by` (was `null`), so the egress is attributable to the issuing member.
- Done-when: (1) both lookups filter `.eq("org_id", t.org_id)` ✓; (2) the portal is no wider than the org — a forged/out-of-org item resolves nothing ✓ (full per-recipient acl_index evaluation is N/A: the recipient is anonymous, so authority rests on the issuer, enforced by the write rail); (3) items validated at write time by a DB trigger ✓; (4) `portal_token` generated server-side ✓; (5) audit records the issuing member ✓.
- Files: `app/api/transmittal/route.ts`, `supabase/migrations/20261027_dc_phase1_unguarded_doors.sql`
- Tests: `lib/__tests__/transmittalPortalRoute.test.ts` — in-org version signs + audit attributes to issuer; a version in another org → 404, no signature; a file not on the transmittal → 403.
- **What this brought to light:** the same repo enforces the missing org check at `lib/docFileServer.ts:26-28` — the portal was the one egress path that skipped the house pattern. `EGR-2` (the `document_shares` cross-org variant) is the sibling and was already closed in the roles-and-permissions area (`EGRESS-1` + `20261022`/`20261026`).

- **Verification:** CONFIRMED
- **Locations:** `app/api/transmittal/route.ts:39-55`, `app/api/transmittal/route.ts:66-82`, `lib/transmittals.ts:449`, `lib/transmittals.ts:453`, `lib/transmittals.ts:385-387`, `supabase/migrations/20260910_transmittal_portal.sql:40-51`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Survives, and the second resolution branch makes it easier than the summary claims: documentId + a guessable revision_label ('0','1','A') is enough, so the attacker never needs a version UUID. The portal GET also only rejects status='voided' (route.ts:61), so a self-created draft-then-issued transmittal the attacker never sends works fine, and the attacker knows its token because the client generated it. No org check exists at any layer of this path.

**Mechanism.** `items` on a transmittal is free-form JSONB written straight from the browser: `items: input.items ?? []` (lib/transmittals.ts:449) via the anon client. The RLS insert policy constrains only authorship and org membership — `WITH CHECK (created_by = auth.uid() AND EXISTS (... org_members ... status='active'))` (20260910:40-44) — and says nothing about what document ids the items name. `portal_token` is minted CLIENT-SIDE (`makePortalToken()`, lib/transmittals.ts:385-387, called at :453), so the creator knows the token before the row exists. The portal route then reads the row with `supabaseAdmin` (service role, RLS bypassed) and resolves the file with:

```
const { data: v } = await supabaseAdmin
  .from("document_versions").select("file_url, revision_label")
  .eq("id", item.versionId).maybeSingle();
...
  .from("document_versions").select("file_url, created_at")
  .eq("record_id", item.documentId).eq("revision_label", item.rev)
```

Neither lookup filters on `t.org_id`, and neither consults `documents.visibility` or `acl_index`. The only gate before signing is `items.find((i) => i.documentId === fileDoc)` (route.ts:67) — a check that the attacker's own JSONB contains the id they just put there. It then issues a presigned GET (route.ts:71-74). Contrast lib/docFileServer.ts:26-28, which re-checks `.eq("org_id", orgId)` on the version row with the comment "the pointer columns are member-writable, so a forged cross-org version id must never resolve" — the exact defense that is absent here.

**Failure scenario.** A Viewer in org A obtains a document id for a PSM-restricted drawing — either a hidden/private document in their own org (whose `documents` row RLS hides but whose id leaks through document_assets, project_documents, checkout_sessions or notes) or, cross-tenant, any competitor's drawing id harvested from the unauthenticated /d/[number] oracle (finding below). From the browser console they call createTransmittal({orgId: <their own org>, issueNow: true, items: [{documentId: '<victim doc uuid>', rev: '0'}]}). RLS accepts it: created_by is them, org_id is their org. They read back the portal_token they generated, then GET /api/transmittal?token=<t>&file=<victim doc uuid> and receive a 5-minute presigned URL to the raw, unstamped bytes of a document they have no read grant on, in an org they are not a member of. No audit row names them — the TRANSMITTAL_PORTAL_DOWNLOAD row at route.ts:75-80 records `user_id: null`.

**Evidence.**

```
app/api/transmittal/route.ts:41-43 — `.from("document_versions").select("file_url, revision_label").eq("id", item.versionId).maybeSingle();` and :47-50 — `.eq("record_id", item.documentId).eq("revision_label", item.rev)`: neither carries `.eq("org_id", …)`. route.ts:68 — `if (!item) return bad("That document is not on this transmittal.", 403);` is the whole authorization. 20260910_transmittal_portal.sql:40-44 WITH CHECK constrains created_by and org membership only. lib/docFileServer.ts:24-28 shows the same repo enforcing the missing check elsewhere.
```

**Chain reaction.** This is the terminal step of the worst chain in this area: /d/[number] (unauthenticated, service role) yields a document id for any tenant → a transmittal item names it → the portal signs its bytes. Each link is individually defensible; composed, they are an unauthenticated-to-bytes path that needs only one throwaway account in any org.

> **Verifier correction.** Two framing points to drop. (1) Client-side minting of portal_token (lib/transmittals.ts:385-387) is not load-bearing — createTransmittal does `.select("*").single()` at :455-456, so the creator reads the token back regardless. (2) The versionId path needs a foreign document_versions UUID, which is not directly enumerable; the documentId+rev path (:46-52) is the practical one, since a document UUID is obtainable from /d/[number] (roles-and-permissions EGRESS-2) and rev labels are guessable ('A', '0', '1'). Cite that chain rather than implying the version UUID is free.

**Done when.**

- [ ] fileKeyForItem takes the transmittal's org_id and both document_versions lookups filter `.eq("org_id", t.org_id)`, mirroring lib/docFileServer.ts:26-28
- [ ] The document named by the item is loaded and its visibility/acl_index evaluated before signing, or the item is rejected — the portal must not be a wider door than /api/storage/download-url
- [ ] Items are validated at write time (a DB trigger or a server route) so a transmittal cannot be persisted naming a document outside its own org
- [ ] portal_token is generated server-side, not by the browser, so the creator cannot know a token for a row they were not permitted to issue
- [ ] The TRANSMITTAL_PORTAL_DOWNLOAD audit row records the issuing member (t.created_by), not user_id: null

---

<a id="egr-2"></a>

## EGR-2 · document_shares WITH CHECK validates org_id but never that document_id belongs to that org — cross-tenant byte exfiltration via /api/share/file

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260623_document_shares.sql:38-54`, `lib/documentShares.ts:46-54`, `app/api/share/file/route.ts:42-58`, `app/api/share/file/route.ts:92-96`, `app/api/share/resolve/route.ts:43-48`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by repo-wide search: `document_shares` appears only in 20260623_document_shares.sql and 20260818_followups_rls.sql (the latter only defines bump_share_access) — there is no trigger, CHECK, or FK pairing (org_id, document_id). The policy is FOR ALL with no role gate, so any active member including a Viewer can insert an attacker-chosen token pointing at any documents.id, and both /api/share/resolve and /api/share/file serve it with the service role, bypassing RLS entirely.

**Mechanism.** This is the established missing-WITH-CHECK-authority pattern, in a subtler form: the policy HAS a WITH CHECK, but it constrains the wrong column.

```
CREATE POLICY document_shares_org_member ON document_shares FOR ALL
  USING   (EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = document_shares.org_id AND uid = auth.uid() AND status='active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = document_shares.org_id AND uid = auth.uid() AND status='active'));
```

Both clauses test `document_shares.org_id`. Nothing correlates `document_shares.document_id` with that org. `createShareLink` (lib/documentShares.ts:46-54) is a plain client-side insert, so an attacker sets org_id to their own org (passing the check) and document_id to any UUID in the database. Both public routes then resolve the document by id alone with the service role — `sb.from("documents").select(...).eq("id", share.document_id)` (share/file:53-57, share/resolve:43-47) — with no `.eq("org_id", share.org_id)` and no visibility check, and share/file streams the bytes at :92-96.

**Failure scenario.** A Viewer in org A inserts one row into document_shares: {token: <they choose it>, org_id: <org A>, document_id: <a drawing in org B, or a hidden PSM document in org A>}. RLS accepts the insert. They open /share/<token>. /api/share/resolve returns the victim document's number, title and rev; /api/share/file streams its full PDF. The download_audits row that would have recorded this is attributed to `share.created_by` — and, per the finding below, is never written at all. Because the token is chosen by the attacker and the URL is public, the leak is also anonymously re-distributable: anyone the attacker sends the URL to gets the same bytes with no account.

**Evidence.**

```
20260623_document_shares.sql:38-54 — both USING and WITH CHECK reference only `document_shares.org_id`; the table's own FK `document_id UUID NOT NULL REFERENCES documents(id)` (line 16) permits any document row in the database. app/api/share/file/route.ts:53-57 — `.from("documents").select("id, document_number, title, name, rev, current_version_id").eq("id", share.document_id as string)` with no org predicate. The route header at :14 states the whole auth model: "Auth: possession of the unguessable token" — but the token is not unguessable to the person who inserted the row.
```

**Chain reaction.** Same as the transmittal path: any document id obtained from /d/[number] or from an id-bearing join table becomes readable bytes. The two paths are independent, so fixing one leaves the other open.

> **Verifier correction.** Report this as a citation plus one increment, not as a new CRITICAL. intelligence DACL-4 (HIGH, CONFIRMED, audit-reports/intelligence/06-document-acl-leaks.md:121-136) already states 'document_id is entirely unconstrained, so the INSERT check never asks whether the inserter can see that document', with locations 20260623_document_shares.sql:37-54, lib/documentShares.ts:33-57, app/api/share/file/route.ts:42-58. roles-and-permissions EGRESS-1 (CRITICAL) covers the same insert path and carries the note 'CONFIRMED (same-org) / SUSPECTED (cross-org — the resolve path was not traced to a conclusion)'. The only genuinely new contribution here is closing that cross-org gap: the WITH CHECK predicate is satisfied by the attacker's OWN org_id while document_id names another tenant's row, and neither public route re-checks org, so cross-org is CONFIRMED. Align severity with DACL-4 (HIGH) and file it as 'EGRESS-1/DACL-4, cross-org half now confirmed'.

**Done when.**

- [ ] The WITH CHECK correlates the two columns, e.g. `EXISTS (SELECT 1 FROM documents d WHERE d.id = document_shares.document_id AND d.org_id = document_shares.org_id)` ANDed with the membership test
- [ ] /api/share/resolve and /api/share/file both add `.eq("org_id", share.org_id)` to the documents lookup so a mismatched row resolves to 404 regardless of RLS
- [ ] A share cannot be created for a document the creator cannot read — the ACL/visibility check from /api/storage/download-url:64-90 runs at share-creation time, at resolve time, or both
- [ ] createShareLink checks the returned {error} (see the unchecked-write finding) so a policy rejection surfaces to the user instead of appearing to succeed

---

<a id="egr-3"></a>

## EGR-3 · download_audits has no `source` column — every external share-link download fails its audit insert silently, so the PSM distribution record is empty for outsiders

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/share/file/route.ts:129-141`, `app/api/share/file/route.ts:14-16`, `supabase/schema.sql:789-799`, `lib/staleCopies.ts:40`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Repo-wide grep confirms the absence: no migration in supabase/migrations/ mentions download_audits at all, so nothing ever adds `source`. PostgREST rejects the whole insert (unknown column), and supabase-js returns `{error}` rather than throwing — so the catch never even fires and the discarded error means zero external-download rows exist. lib/staleCopies.ts:40 and every other reader query only (document_id, version_id, created_at), so nothing surfaces the gap.

**Mechanism.** share/file writes the distribution record with an extra column:

```
await sb.from("download_audits").insert({
  org_id: share.org_id, document_id: doc.id, version_id: versionId,
  user_id: (share.created_by as string | null) ?? null,
  ... watermark_policy_id: null,
  source: stamped ? "share_link" : "share_link_unstamped",
});
} catch { /* pre-migration column drift — never block the share */ }
```

The table is declared once, in supabase/schema.sql:789-799, with exactly nine columns: id, org_id, document_id, version_id, user_id, user_email, created_at, expires_at, watermark_policy_id. There is no `source`. Two differently-shaped searches confirm no migration ever adds one: `grep -rn "download_audits" supabase/` returns exactly three lines (CREATE TABLE at 789, ENABLE ROW LEVEL SECURITY at 1022, the policy at 1090), and `grep -rniE "alter table (public\.)?download_audits" . --include=*.sql` returns only the RLS line. PostgREST rejects the whole insert with PGRST204 for the unknown column. The route's own comment at :14-16 asserts the opposite: "The download_audits row is written HERE (an actual download)". Note also that supabase-js resolves with {error} rather than throwing — the empty catch is doubly ineffective, since nothing is thrown to catch.

**Failure scenario.** An org shares an issued P&ID with a contractor and relies on the share-link audit trail. After an incident, document control pulls the distribution record for that drawing to answer 'who held a copy of Rev 2'. Every internal pull is there; not one external share-link download is, because every insert has been rejected for the entire life of the feature. lib/staleCopies.ts, which reads download_audits (:40, :133) to flag who is carrying a superseded print, has never seen a single external recipient — so no outside holder of a superseded drawing is ever flagged. The /share/<token> page tells the recipient 'Audit logged'.

**Evidence.**

```
app/api/share/file/route.ts:139 — `source: stamped ? "share_link" : "share_link_unstamped",`. supabase/schema.sql:789-799 — the complete CREATE TABLE, nine columns, no `source`. The three-line grep result over all of supabase/ proves no migration adds it.
```

> **Verifier correction.** One caveat worth stating: CONFIRMED is against the repo's schema. The route's own comment ('pre-migration column drift') implies the author expected a column that a hand-applied change might have added to a live database; nobody can read the deployed DB from here. Phrase the consequence as 'fails against the schema as committed'.

**Done when.**

- [ ] A migration adds `source TEXT` to download_audits (and it is added to the export/restore column expectations), or the route stops sending the column
- [ ] The insert checks the returned {error} and logs loudly — an audit write that fails must be visible, not swallowed by `catch { }`
- [ ] A test inserts the exact payload share/file sends and asserts a row lands, so column drift on the distribution record fails the build
- [ ] Once fixed, note that historical share downloads are unrecoverable — the gap should be documented for the compliance record

---

<a id="egr-4"></a>

## EGR-4 · /api/storage/download-url lets the caller choose expiresIn with no clamp — a member can mint a 7-day credential-free URL to any document they can currently read

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/storage/download-url/route.ts:144-153`, `lib/storage.ts:118-154`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified there is no clamp anywhere between parse and sign; SigV4's own 604800s maximum is the only bound, exactly the 7 days the finding claims. The ACL/visibility/deny checks above (lines 55-115) gate WHO may mint the URL at mint time, but they explicitly `catch { /* fail open */ }` and, more importantly, bind nothing to the resulting credential-free URL's lifetime.

**Mechanism.** `const expiresIn = parseInt(req.nextUrl.searchParams.get("expiresIn") || "3600");` — the value flows straight into `getSignedUrl(r2, command, { expiresIn })` with no upper bound and no validation. SigV4 permits up to 604800 seconds. The resulting URL is a bearer capability: it carries no session, is not tied to the requester, and cannot be revoked short of rotating the R2 credentials. Every authorization the route performs — active membership (:36-46), the private/hidden canDiscover gate (:64-90), the explicit deny-download rule (:91-111) — is evaluated exactly once, at issuance, and then has no further hold on the bytes. A non-numeric value yields NaN, which is passed through unvalidated.

**Failure scenario.** A drafting contractor whose engagement ends Friday spends Thursday calling `/api/storage/download-url?path=<key>&expiresIn=604800` for every drawing in the unit. Their membership is set to inactive on Friday; the ACL is tightened; the documents are put on hold. All of it is irrelevant — the URLs they hold keep returning the raw controlled PDFs for another week, from any browser, with no account. The same technique turns any single moment of authorization into a week-long, freely forwardable link that no revocation reaches and that appears in no download_audits row (the audit row is written by lib/downloads.ts, not by this route).

**Evidence.**

```
app/api/storage/download-url/route.ts:144 — `const expiresIn = parseInt(req.nextUrl.searchParams.get("expiresIn") || "3600");` — no Math.min, no isNaN guard, no allow-list. :151 — `const url = await getSignedUrl(r2, command, { expiresIn });`. The only in-repo caller passes the default (lib/storage.ts:128-130), so clamping breaks nothing legitimate.
```

> **Verifier correction.** Two fixes. (1) The evidence claim 'the only in-repo caller passes the default' is FALSE — six call sites pass expiresIn explicitly: components/viewers/SecureDocViewer.tsx:107, components/viewers/FullScreenViewer.tsx:184, components/assets/FileReferenceModal.tsx:50, components/documents/InspectorPanel.tsx:226, lib/docPack.ts:32 (all literal 3600) and lib/storage.ts:129 (forwards a parameter defaulting to 3600 at :118). The intended conclusion survives — every caller uses 3600, so a clamp at 3600 breaks nothing — but the stated basis must be corrected. (2) Severity to MEDIUM: the requester must already have passed membership, canDiscover and the deny-download check for that exact key, so this extends the lifetime of a capability they already hold rather than granting access; the defect is the un-revocable window, not new reach.

**Done when.**

- [ ] expiresIn is clamped server-side to a small ceiling (the app's own default of 3600 is the only value any caller uses) and non-numeric input is rejected rather than passed through as NaN
- [ ] The same ceiling is applied at /api/storage/resolve:83 and /api/transmittal:74 so no issuer is looser than the others
- [ ] Consider whether long-lived access should route through a revocable share link (which has expiry and revoked_at) instead of a presigned URL, since only the former can be withdrawn

---

<a id="egr-5"></a>

## EGR-5 · A share link always serves the CURRENT version and ignores document status and active holds — a voided or held drawing keeps flowing to outsiders

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/share/file/route.ts:53-81`, `app/api/share/file/route.ts:102-118`, `app/api/verify/route.ts:34-108`, `lib/documentGuards.ts:139-146`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves confirmed and the status half is worse than stated: `Void` is a real status that docRetired does not test, so a voided document returns isCurrent:true and app/verify/[docId]/page.tsx:65,99 paints `bg-emerald-600` / "CURRENT". Holds are never consulted on either route — lib/documentGuards.ts:139-148 is the only hold block and it fires solely inside evaluatePublishGuard.

**Mechanism.** share/file selects `id, document_number, title, name, rev, current_version_id` and resolves `current_version_id` (:53-67). It never reads `status`, never reads `superseded_at`, and never queries document_holds. So the share serves whatever is current at download time — which is correct for freshness but means a link created for one revision silently becomes a link to a later one, and a document whose status has since become Void, Superseded or Archived is still delivered. The stamp does not compensate: the footer is `${label} Rev ${rev ?? "?"} at time of download` (:113), which states the rev but not the status, and the watermark is the generic 'UNCONTROLLED — SHARED COPY'. The QR points at /api/verify, which likewise never consults document_holds — it computes `isCurrent` from status and current_version_id only (verify/route.ts:89-90) and returns no hold field. Holds are enforced only against publishing (lib/documentGuards.ts:139-146), never against distribution.

**Failure scenario.** A drawing is put on an active hold — 'Field Verification Needed' — because a dimension is suspect. Publishing is correctly blocked. Distribution is not: the existing share link keeps serving the drawing to the vendor, and when the vendor scans the stamped QR the verify page answers 'current' in green, because /api/verify has no idea a hold is open. Separately, if the document is later Voided, the share link continues to deliver it with an UNCONTROLLED watermark that says nothing about the void — the recipient has no signal that the drawing was withdrawn.

**Evidence.**

```
app/api/share/file/route.ts:54-55 — the select list contains no `status` and no `superseded_at`; there is no reference to document_holds anywhere in the file. app/api/verify/route.ts:36 selects `status, current_version_id, superseded_at` but never queries document_holds; the response object at :96-108 has no hold field. lib/documentGuards.ts:139-146 shows holds gating publish and nothing else.
```

> **Verifier correction.** Split the credit and add the sharper sub-defect. The legal-hold half is already covered by intelligence DACL-4, whose title reads '...no ACL, no download-deny, no ack-gate and no legal-hold check' over the same route lines — cite it. What is genuinely new and worth leading with: /api/verify/route.ts:89 computes `const docRetired = d.status === "Superseded" || d.status === "Archived";` — it omits "Void", although the app's own not-current set includes it (lib/aiBoundary.ts:25 `NOT_CURRENT_STATUSES = new Set(["Superseded", "Void", "Archived"])`, matched by lib/staleCopies.ts:76). So a VOIDED drawing pulled through a share link is stamped, the QR is scanned, and /api/verify answers isCurrent:true. Also drop the 'link silently becomes a later revision' complaint as a defect: route.ts:60-61 documents serving the current published version deliberately, and the footer at :113 says 'Rev X at time of download'.

**Done when.**

- [ ] share/file (and share/resolve) refuse, or clearly mark, a document whose status is Void or Archived — a withdrawn drawing must not leave as a plain UNCONTROLLED copy
- [ ] The server-side stamp carries the document status and any active-hold notice, the way lib/downloads.ts:80-88 already surfaces an in-progress checkout in buildFooterNotice
- [ ] /api/verify reports active holds so a scanned QR cannot answer 'current' for a drawing that is operationally blocked
- [ ] A decision is recorded and reflected in the UI about whether a share tracks the current version or pins the version shared — today it silently does the former

---

<a id="egr-6"></a>

## EGR-6 · Share revocation and every download-audit write ignore supabase-js {error} — a revoked link can stay live and a failed distribution record reads as success

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/documentShares.ts:68-73`, `lib/documentShares.ts:59-66`, `lib/downloads.ts:131-146`, `lib/docPack.ts:114-123`, `components/viewers/MultiDocViewer.tsx:747`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. REFUTED in its headline mechanism: the share panel is NOT optimistic — it re-fetches after revoke, and the row is rendered from the server value (`const isRevoked = !!s.revokedAt` at line 148, showing "revoked" only at line 204), so a rejected UPDATE leaves the link visibly still live rather than reading as revoked. What survives is the narrower, already-covered point that every download-audit write discards its {error} (the same swallowing that makes EGR-3 silent), so I'd drop this to LOW as a code-hygiene finding.

**Mechanism.** The established pattern, on the two controls that matter most in this lens — revocation and the distribution record.

```
export async function revokeShareLink(id: string, actorUserId: string): Promise<void> {
  await supabase.from("document_shares").update({
    revoked_at: new Date().toISOString(), revoked_by: actorUserId,
  }).eq("id", id);
}
```

No destructuring of {error}, no row-count check, and the function returns void — so the caller cannot distinguish 'revoked' from 'nothing happened'. supabase-js resolves rather than throwing, so an RLS rejection, a column-drift error, or an id that matches no visible row all complete silently. The same shape governs the audit trail: lib/downloads.ts:132-145 wraps `await supabase.from("download_audits").insert(...)` in a try/catch whose catch can never fire, because nothing throws; docPack.ts:114-123 and MultiDocViewer.tsx:747 do the same for book and pack assembly. MultiDocViewer additionally sends `org_id: e.doc.orgId ?? null` (:727) — a null org_id fails the RLS check `org_id IN (SELECT my_org_ids())` (schema.sql:1090), producing exactly the silent rejection nobody sees.

**Failure scenario.** A drawing is discovered to have been shared with the wrong vendor. Document control opens the share panel and clicks Revoke; the UI shows the link as revoked because the local state was updated optimistically and the promise resolved. The UPDATE was in fact rejected. /api/share/file, which checks `share.revoked_at` (:48), still finds it null and keeps streaming the drawing to anyone with the URL — for the rest of its 30-day life, or forever if it was created with expiresInDays: 0 (lib/documentShares.ts:41-45). Separately, a book pull whose documents carry a null orgId writes no download_audits rows at all, so the stale-copy radar never learns those prints exist.

**Evidence.**

```
lib/documentShares.ts:68-73 — the full body of revokeShareLink; no `const { error } =`, no `.select()`, return type `Promise<void>`. Compare createShareLink at :46-56, which DOES check (`if (error) throw error;`) — the inconsistency is within the same file. lib/downloads.ts:142-145 — `} catch (e) { console.error("download_audits insert failed", e); }` guarding a call that does not throw. components/viewers/MultiDocViewer.tsx:747 — `try { await supabase.from("download_audits").insert(rows); } catch (e) { console.error(e); }`.
```

> **Verifier correction.** Three corrections. (1) The download_audits half duplicates drafting-flow EVID-5 (HIGH, CONFIRMED), whose locations are components/viewers/MultiDocViewer.tsx:747, components/assets/FileReferenceModal.tsx:189, app/(protected)/requests/[id]/page.tsx:592-600 — the same call sites — cite it. (2) The revocation consequence is SUSPECTED, not CONFIRMED: components/documents/ShareLinkModal.tsx:77 is `await revokeShareLink(id, createdBy); await refresh();`, and refresh() re-reads the rows from the database (lib/documentShares.ts:59-66), so a failed revoke leaves the row visibly un-revoked in the list rather than silently reading as success; and under document_shares_org_member (FOR ALL, active member, 20260623:38-54) the update normally succeeds for the sharer, so no error path that leaves a link live is demonstrated. The defect is the swallowed error and the void return, not a proven live-after-revoke. (3) Citation error: the MultiDocViewer `org_id: e.doc.orgId ?? null` line is 738, not 727, and the null-org_id RLS-rejection scenario is speculative — orgId is populated on every doc record loaded by that viewer.

**Done when.**

- [ ] revokeShareLink destructures {error}, requests `.select("id")`, throws when error is set OR zero rows were updated, and the caller surfaces the failure instead of optimistically marking the link dead
- [ ] listShareLinks (:59-66) likewise surfaces its error rather than returning [] on failure — an empty share list currently looks identical to a failed query
- [ ] Every download_audits write checks {error} and logs loudly; an audit write that fails must never be indistinguishable from one that succeeded
- [ ] MultiDocViewer skips (or repairs) rows with a null org_id rather than submitting writes RLS is guaranteed to reject

---

<a id="egr-7"></a>

## EGR-7 · The full-org export embeds live plaintext share/portal/intake tokens and ships them to an operator-configured external webhook or bucket

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/exportTables.ts:50-51`, `lib/exportTables.ts:54`, `lib/exportTables.ts:171-181`, `lib/dataExport.ts:300`, `lib/exportRunner.ts:159-162`, `lib/exportRunner.ts:277-314`, `app/api/data-export/structured/route.ts:53-57`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by absence-search: grep for redact/sanitize/scrub/token over lib/dataExport.ts and lib/exportRunner.ts finds no redaction step — the only `token` hits in exportRunner are S3 ContinuationToken pagination (lines 381-395). lib/exportTables.ts:171-181 (EXPORT_EXCLUDED_TABLES) excludes ai_connections for exactly the 'secrets never leave the database' reason, which shows the omission is an oversight rather than a policy. Export is gated to Admin/Manager/DocCtrl (app/api/data-export/structured/route.ts:55-57), but that does not constrain where the operator points the destination.

**Mechanism.** `ORG_SCOPED_TABLES` includes `"document_shares"` (:50), `"project_intake_links"` (:51) and `"transmittals"` (:54). `dumpTable` selects every column — `sb.from(table).select("*").range(...)` (dataExport.ts:300) — so `document_shares.token`, `project_intake_links.token` and `transmittals.portal_token` land in the envelope in plaintext. These are not descriptive data: each is the sole credential for an unauthenticated route that returns document bytes (/api/share/file, /api/transmittal?file=, /api/intake/*). The envelope is then written to `tables/document_shares.json` inside the ZIP (exportRunner.ts:159-162) and POSTed whole to `dest.webhook_url` (exportRunner.ts:308-312) or PUT to `dest.bucket`, nightly, unattended. The same file already carries the precedent: `ai_connections: "holds live AI provider API keys — secrets never leave the database"` (:173-174). That reasoning was never applied to the token columns. Migration 20260906_projects_hardening.sql:177-183 tightened `project_intake_links` SELECT to controllers and the project owner under the heading "tokens visible only to those who manage them" — the export re-widens exactly that, to Manager and DocCtrl (structured/route.ts:55-57) and to any external endpoint an admin ever configured.

**Failure scenario.** An org configures a nightly backup to their contractor's S3 bucket. Every night the ZIP carries every live, unexpired, unrevoked share token and transmittal portal token in the org. Anyone who can read that bucket — the contractor's staff, a mis-scoped IAM policy, a stale credential — can paste any token into /share/<token> or /transmittal/<token> and pull controlled drawings with no account, indefinitely, leaving no trace tied to them. Rotating the export destination does not help: the tokens in already-delivered ZIPs stay valid until each share individually expires, and shares created with expiresInDays: 0 never expire at all (lib/documentShares.ts:41-45). A Manager or DocCtrl can achieve the same by simply downloading /api/data-export/structured, which they are authorized to do.

**Evidence.**

```
lib/exportTables.ts:50-51,54 list the three token-bearing tables; :173-174 shows the codebase's own standard for secret-bearing columns. lib/dataExport.ts:300 — `let q = sb.from(table).select("*")`. lib/exportRunner.ts:160-162 — `for (const [name, rows] of Object.entries(envelope.tables)) { tableFolder?.file(`${name}.json`, JSON.stringify(rows, null, 2)); }`. lib/exportRunner.ts:308-312 — `await fetch(dest.webhook_url, { method: "POST", headers, body: zipBytes ... })`.
```

**Chain reaction.** A leaked backup is a permanent skeleton key to every share and transmittal in the org, and the fix for the two RLS findings above does not close it — those tokens are already valid for exactly the documents they were legitimately made for.

> **Verifier correction.** Downgrade to MEDIUM and state the mitigation. The ZIP already embeds the document binaries themselves (exportRunner.ts:174-176, MAX_EMBED_BYTES), so a backup holder does not gain document access from the tokens — the real increment is narrower: the tokens stay LIVE against production after the backup ages, and project_intake_links.token is a WRITE credential (it lets the holder submit versions through /api/intake/*), which no amount of backup content confers. Also soften 'nightly, unattended': scheduled delivery exists (app/api/data-export/run-scheduled/route.ts) but a cadence is per-destination configuration, not a repo fact, and the webhook URL passes assertSafeExternalUrl (exportRunner.ts:280).

**Done when.**

- [ ] A per-table column redaction map in lib/exportTables.ts nulls token, portal_token and any future bearer column, enforced by the same coverage tripwire that governs table membership
- [ ] dumpTable applies the redaction rather than select("*") for tables that declare one
- [ ] The export README/manifest states which columns were redacted, so a restore knows the shares must be re-issued rather than silently arriving dead
- [ ] Consider whether a restore should re-mint tokens; either way the decision is written down next to the ai_connections exclusion reason

---

<a id="egr-8"></a>

## EGR-8 · The transmittal portal hands outsiders RAW unstamped bytes, breaking the invariant /api/share/file was specifically built to guarantee

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/transmittal/route.ts:71-74`, `app/api/share/file/route.ts:1-16`, `app/api/share/file/route.ts:107-125`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the transmittal portal is a second, parallel outsider egress path that hands back exactly the artifact the share/file route's header comment (lines 5-12) says was the bug it was built to fix ('the page's fallback opened the RAW UNSTAMPED file in a new tab'). The portal is more correct than share/file in one respect — it serves the pinned as-sent revision (fileKeyForItem, lines 39-54) rather than the current one — but the bytes carry no watermark, rev footer, or verify QR.

**Mechanism.** Two routes serve the same audience — an external party holding a token, with no account — and they disagree about the copy-control rule. share/file pulls the bytes server-side and stamps them (watermark 'UNCONTROLLED — SHARED COPY', rev footer, verify QR) before responding, and its header records why the raw path was removed: "the old flow handed the browser a raw presigned R2 URL … its fallback opened the RAW UNSTAMPED file in a new tab. The copy-leak protection silently never applied to the one audience it matters most for: outsiders." The transmittal portal does exactly what that comment describes as the bug it fixed:

```
const url = await getSignedUrl(r2, new GetObjectCommand({
  Bucket: R2_BUCKET, Key: file.key,
  ResponseContentDisposition: `attachment; filename="${file.name.replace(/[^\w.\- ]+/g, "_")}"`,
}), { expiresIn: 300 });
```

It returns a bare presigned R2 URL. No stamping, no watermark, no rev-at-issue footer, no verify QR. Nor is anything written to download_audits — only an audit_logs row with `user_id: null` (:75-80), so the copy does not appear in the distribution record or in the stale-copy radar that reads it.

**Failure scenario.** A PM issues a transmittal to a fabricator. The fabricator downloads DWG-2002-D-10001 Rev 2 from the portal and gets a pristine, unmarked PDF — indistinguishable from a controlled master. It is printed, filed, and photocopied around the shop. Rev 3 issues two weeks later. Nothing on the paper says 'uncontrolled', nothing states the rev at time of issue, and there is no QR to scan — the one mechanism the app built for exactly this situation (buildVerifyUrl / /api/verify, lib/downloads.ts:90-102) is absent from the copy. A welder works to superseded spool dimensions from a document that looks authoritative.

**Evidence.**

```
app/api/transmittal/route.ts:71-74 issues a bare GetObjectCommand presign — no PDFDocument.load, no applyStampToPdfDoc anywhere in the file. app/api/share/file/route.ts:107-118 shows the stamping the sibling route performs for the identical audience; :7-13 is the recorded rationale. app/api/transmittal/route.ts:75-80 writes only audit_logs, never download_audits.
```

> **Verifier correction.** Downgrade to MEDIUM and restate the harm. The transmittal recipient is the intended, authorized destination for exactly these files at exactly these revisions — this is a copy-control and distribution-record gap, not unauthorized access, which is what separates it from the CRITICAL/HIGH egress items. Also soften 'the invariant share/file guarantees': share/file's stamping is itself best-effort — route.ts:120-125 catches a stamping failure and delivers the file unstamped, recording `source: "share_link_unstamped"` (which, per finding 6, never lands).

**Done when.**

- [ ] The transmittal portal streams bytes through the same server-side stamping path as /api/share/file (applyStampToPdfDoc with the as-sent rev in the footer and a /verify QR), rather than presigning the object
- [ ] A download_audits row is written for every portal pull so external copies appear in the distribution record and in lib/staleCopies.ts
- [ ] If an unstamped as-sent original is genuinely required for some transmittal purposes, it is an explicit per-transmittal flag with its own audit reason — not the default for every external download

---
