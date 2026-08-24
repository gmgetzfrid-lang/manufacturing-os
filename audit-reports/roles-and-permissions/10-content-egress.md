# 10 · Content egress — every door content can leave through

> **CLAIMED** session_01EwPqnfFHkE85ZXM4sTQvEU 2026-08-24T00:30:00Z

The document ACL is enforced at the database as a `RESTRICTIVE` policy, which is
genuinely good. This report is about the paths that never reach it.

**6 findings** — 3 CRITICAL, 2 HIGH, 1 MEDIUM.

> See [`../README.md`](../README.md) for the resolution protocol. Code in
> `Remediation` blocks is **illustrative, untested, and not a patch.** Line
> numbers drift — **match on the quoted code.**

---

## The shape of the problem

`documents_acl_select` and `collections_acl_select` (`20260708_acl_rls_enforcement.sql:85-91`)
are `RESTRICTIVE` SELECT policies that AND with the permissive org policy. Any
read that goes through the user's own Supabase session is correctly gated.

**Four independent paths do not:**

| Path | Why it escapes the ACL |
|---|---|
| `document_shares` → `/api/share/file` | service-role read, gated only by token possession; the share row's `document_id` is unconstrained |
| `/d/[number]` | `supabaseAdmin`, no auth, no `org_id` filter |
| `knowledge_chunks` | a permissive SELECT policy for every org member, with no ACL join |
| the AI orchestrator | `supabaseAdmin` for every tool, re-checking org membership only |

They compound: `/d/[number]` and the orchestrator hand out document UUIDs;
`document_shares` turns a UUID into bytes.

---

## EGRESS-1 · Any active member can publish any document to the public internet via a share link

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution.** The cross-org case was traced to a conclusion first (per the sequencing file's instruction): it **was** exploitable end to end — neither `/api/share/resolve` nor `/api/share/file` re-joined `document_id` to `share.org_id`, so an org-A member naming org-B's document UUID had B's stamped PDF served on token possession alone. Fixed in two halves:
- **Code (deploy-safe, closes the byte leak alone).** Both routes now join the documents lookup with `.eq("org_id", share.org_id)` (a cross-org share yields no document → 404), and re-check the creator's **current** authority via the new `lib/shareAuthorization.shareStillAuthorized` before serving — fail-closed, reusing `lib/knowledgeAccess` (`loadPrincipal` + `readableControlledDocIds`) so a share can never grant more than its creator holds today. If the sharer loses read access or leaves the org, the link stops serving (Done-when 4).
- **Migration (durable DB rail).** `supabase/migrations/20261022_document_shares_acl_scope.sql` splits the `FOR ALL` policy per verb: SELECT unchanged; INSERT requires membership **and** that `document_id` is a document in the same org that the creator can read (`node_visible(d.visibility, d.acl_index, d.org_id)` — the caller-aware read decision — with the explicit `d.org_id = document_shares.org_id` term load-bearing, since `node_visible` returns true for normal visibility without an org check); UPDATE/DELETE limited to creator or `is_org_controller`.
- Commit: `b2907b9`
- Files: `app/api/share/resolve/route.ts`, `app/api/share/file/route.ts`, `lib/shareAuthorization.ts`, `supabase/migrations/20261022_document_shares_acl_scope.sql`
- Tests: `lib/__tests__/shareAuthorization.test.ts` (fail-closed on null creator/principal/non-readable doc; controller shortcut), `lib/__tests__/shareResolveRoute.test.ts` (org-join asserted; cross-org → 404; lapsed-creator → 410). Both route tests fail against the pre-fix route.
- Reproduced: the recon agent traced every link (create via browser RLS INSERT whose `WITH CHECK` pins only `org_id`; resolve/file lookups by `id` alone); confirmed a logged-out browser with the token receives org B's bytes.
- Verified: Done-when 1 — creating a share now needs an ACL read decision on the document (INSERT policy). Done-when 2 — `document_id` cannot name an out-of-org document (org join, both app and DB). Done-when 3 — UPDATE/DELETE limited to creator or controller. Done-when 4 — `/api/share/file` re-checks the creator's current authority before serving. Suite 1429 green.
- Pending migration: `supabase/migrations/20261022_document_shares_acl_scope.sql` (apply after deploying the code; the code closes the leak without it).
- **What this brought to light:** (1) `revokeShareLink` (`lib/documentShares.ts:68-73`) updates by id with no authority scope — after the tightened UPDATE policy it becomes a silent 0-row no-op for a non-creator/non-controller, and `ShareLinkModal.tsx:77` swallows the error; recorded as new finding `EGRESS-7`. (2) `listShareLinks` selects `*` (incl. `token`) under the any-active-member SELECT policy, so a member who cannot read a document can still enumerate its live share tokens and pull `/api/share/file` — an intra-org bypass parallel to this one; recorded as `EGRESS-8`.
- **Verification:** CONFIRMED (same-org) / SUSPECTED (cross-org — the resolve path was not traced to a conclusion)
- **Blast radius:** security / confidentiality
- **Locations:**
  - `supabase/migrations/20260623_document_shares.sql:36-53` — the policy, with the comment *"Anyone in the org can create / list / revoke shares on docs in that org"*
  - `app/api/share/resolve/route.ts:20-48`, `app/api/share/file/route.ts:31-58` — served with the **service-role key**, gated only by token possession
  - `lib/orchestrator/tools.ts:84-120` — where the UUID comes from (`EGRESS-4`)
- **Related:** `EGRESS-2`, `EGRESS-4`, `SURF-2`
- **Re-verified:** hardening pass — **SURVIVES**. `document_shares_org_member FOR ALL` predicates both `USING` and `WITH CHECK` on nothing but active membership — no role, no document ACL.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed CRITICAL, and worse than described: neither route validates that `share.document_id` belongs to `share.org_id`, so the WITH CHECK (which only pins org_id to a membership the attacker legitimately has) does not stop a member from naming a document UUID from a DIFFERENT tenant. A repo-wide grep for document_shares across all migrations finds no later hardening — only bump_share_access (20260818_followups_rls.sql:95-101) and no trigger.

**Mechanism.** Both `USING` and `WITH CHECK` constrain **only `org_id`**:

```sql
CREATE POLICY document_shares_org_member ON document_shares FOR ALL
  USING (
    EXISTS (SELECT 1 FROM org_members
            WHERE org_members.org_id = document_shares.org_id
              AND org_members.uid = auth.uid()
              AND org_members.status = 'active')
  )
  WITH CHECK ( ...identical... );
```

**`document_id` is not constrained at all** — not to the org, and not to
documents the creator can read. There is no check that the creator can *see*
`document_id`. `/api/share/file` then serves the bytes with the service-role key
("Auth: possession of the unguessable token"), never re-evaluating the document
ACL.

**Failure scenario.** A Contractor-role member inserts one row into
`document_shares` naming a restricted drawing's UUID, then fetches
`/api/share/file?token=…` from any browser, logged out. They get the stamped PDF
of a document the ACL denies them.

**Chain reaction.** The UUID is easy to obtain even when `documents` SELECT is
blocked — see `EGRESS-4` (the orchestrator returns `document_id` for every
non-excluded doc in the org with no ACL filter) and `EGRESS-2`. The same
`FOR ALL` policy also lets any member **revoke other people's shares** and **null
out `expires_at`** on existing ones. Share rows are not revoked when a member is
removed — which, per `SURF-1`, never happens anyway.

**The cross-org question is worth answering deliberately.** Because `WITH CHECK`
validates the caller's membership of the *row's* `org_id` and never joins
`document_id` to it, nothing in the policy stops a member setting
`org_id = <their own>` and `document_id = <another tenant's document>`. Whether
that is exploitable end to end depends on whether the resolve path re-joins on
org. **Trace that before assuming it is contained.**

**Done when.**
1. Creating a share requires an ACL read decision on `document_id` for the
   creator.
2. `document_id` cannot name a document outside the row's `org_id`.
3. Updating and deleting a share is limited to its creator or a controller.
4. `/api/share/file` re-checks the ACL server-side against the creator's current
   authority before serving bytes.

---

## EGRESS-2 · `/d/[number]` is an unauthenticated, cross-tenant document enumeration oracle

- **Severity:** CRITICAL
- **Status:** RESOLVED

**Resolution.** The route no longer resolves documents at all. It held a service-role client and queried `documents` with no org filter, so an unauthenticated GET was a platform-wide existence/UUID oracle. Because Supabase sessions live in localStorage (no cookie a server route can read — verified: no middleware, no `@supabase/ssr`), the route cannot authenticate a browser navigation. So resolution moved to the client: `/d/[number]` now does **zero database work** and redirects to `/documents?d=<number>`, where the protected documents page resolves the number **client-side** via `searchDocuments` under the caller's own RLS-scoped session — org-scoped and ACL-enforced by the database, exactly like every other document view. A signed-out caller is bounced to sign-in by the protected layout and learns nothing.
- Commit: `67e6bdd`
- Files: `app/d/[number]/route.ts`, `app/(protected)/documents/page.tsx`
- Tests: `lib/__tests__/shortLinkRoute.test.ts` — the route always redirects to `/documents`, never emits a `/documents/{lib}?doc={id}` deep link (the old disclosure), and its source holds no admin client / no `documents` query.
- Reproduced: the pre-fix route ran `supabaseAdmin.from("documents").ilike(...)` with no `org_id` filter and redirected to `/documents/{library_id}?doc={id}` on a substring hit — a two-char probe returned the most-recently-updated matching document platform-wide.
- Verified: Done-when 1 — an unauthenticated `/d/<anything>` discloses nothing (no lookup; identical redirect for every input). Done-when 2 — an authenticated request resolves only documents the caller's RLS admits (own org, discoverable). Done-when 3 — a logged-in user scanning a printed QR still lands on the right document via client resolution. Suite green.
- **What this brought to light:** the login flow (`app/page.tsx`) always lands on `/dashboard` with no `next` param, so a signed-out user's typed number is lost after sign-in — Done-when does not require resume, but stashing the number before the kick and honouring it post-login is a small follow-up (noted, not filed as a finding — it is a UX nicety, not a defect).
- **Verification:** CONFIRMED
- **Blast radius:** security / confidentiality / cross-tenant
- **Locations:**
  - `app/d/[number]/route.ts:10` — `import { supabaseAdmin }`
  - `app/d/[number]/route.ts:26-32` — the query: **no `org_id` filter, no auth check anywhere in the file**
  - `app/d/[number]/route.ts:30` — `.ilike("document_number", '%${raw}%')` — a substring match
  - `app/d/[number]/route.ts:31-32` — `.order("updated_at", { ascending: false }).limit(25)`
  - `app/d/[number]/route.ts:1-7` — the file comment: *"The target page enforces auth + RLS as always — this route only translates a number into a location; **it reveals nothing**."*
- **Related:** `EGRESS-1`, `EGRESS-4`
- **Re-verified:** hardening pass — **SURVIVES**. `/d/[number]` runs `supabaseAdmin` (service role) against `documents` with **no org filter and no session at all**, then redirects on a match. Its own header comment — *"it reveals nothing"* — is false: a hit discloses that the number exists and leaks `library_id`. Same false-comment shape as `intelligence/IEDGE-1`.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed: the route's own comment is the refutation of the route. There is no middleware.ts anywhere in the repo and /app/d sits outside the (protected) route group, so nothing gates it. The redirect target itself is the disclosure (existence, numbering scheme, recency ordering, library id, document id) regardless of what the destination page later enforces, and those UUIDs are exactly the input EGRESS-1 needs.

**Mechanism.** The comment is half right and half wrong. The *target page* does
enforce auth — but the **redirect itself is the disclosure**. The route runs with
the service-role client, performs no authentication, and applies **no `org_id`
filter**. The response's `Location` header carries `documents/{library_id}?doc={id}`.

So an unauthenticated caller learns, for any string they try:

- whether a document number matching that substring exists **anywhere on the
  platform**, in any tenant;
- that document's `id` and `library_id` UUIDs.

And because the match is a **substring** ordered by `updated_at` with no exact
requirement — the fallback is `?? (rows ?? [])[0]` — a two-character probe like
`/d/01` returns the most recently updated document platform-wide whose number
contains "01", and redirects to it.

**Failure scenario.** A competitor walks `/d/` with common drawing-number
fragments from an unauthenticated script. They learn a customer's drawing
numbering scheme, which numbers exist, roughly when each was last revised (by
ordering), and a live document UUID for each. They then hand those UUIDs to a
low-privileged account inside their own trial org and create `document_shares`
rows (`EGRESS-1`).

**Chain reaction.** This is the entry point of the compound attack described at
the top of this report. Fixing it is narrow and independent — the route needs an
authenticated caller and an org scope — but note the feature's legitimate purpose
(*"typeable from a title block, pasteable in an email, printable next to a QR"*)
means the fix must keep working for a logged-in user who follows the link from a
printed drawing. Redirecting an unauthenticated caller to sign-in and resuming
afterwards preserves that.

**Done when.**
1. An unauthenticated request to `/d/<anything>` discloses nothing about whether
   a document exists.
2. An authenticated request resolves only documents in the caller's own org that
   the caller can discover.
3. A logged-in user scanning a printed QR still lands on the right document.

---

## EGRESS-3 · The AI orchestrator acts with service-role authority the caller does not have

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** security / confidentiality / data-integrity
- **Locations:**
  - `lib/orchestrator/tools.ts:92-119` — `find_documents`
  - `lib/orchestrator/tools.ts:129-145` — `search_documents`
  - `lib/orchestrator/tools.ts:227-256` — `check_permissions`
  - `lib/orchestrator/tools.ts:530-551` — `log_audit_completion`
  - `lib/orchestrator/tools.ts:473-517` — `notify_personnel`
  - `app/api/orchestrator/execute/route.ts:41-60`
  - the ACL-aware path it does **not** use: `lib/knowledgeAccess.ts:1-77`
- **Related:** `EGRESS-1`, `EGRESS-2`, `ADD-1`
- **Re-verified:** hardening pass — **SURVIVES**. `lib/orchestrator/tools.ts` imports `supabaseAdmin` at `:21` and uses it for every read (`:93, :133, :144, :149, :176`). Service role bypasses RLS, so no tool inherits the caller's slice.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed CRITICAL on every cited path. search_documents has the same shape — it calls `supabaseAdmin.rpc("graph_ask", ...)` (:133-135) and hand-filters only ai_excluded mirrors (:142-156), never the ACL. The one handler that does re-check something (notify_personnel, :493-496) checks recipient membership, not the caller's read rights on the document.

**Mechanism.** The file's own contract says *"NOTHING WIDENS ACCESS. Every
handler is org-scoped and re-checks the caller."* In practice the only re-check
is org membership plus `ai_excluded`. Every tool uses `supabaseAdmin`.

The worst is `check_permissions`, which reports authority **to the model**:

```ts
// RLS is the real gate; this reports what the caller can already see, so
// a "no" here is the same "no" the database would give.
const { data } = await supabaseAdmin
  .from("documents").select("id, document_number, status, org_id")
  .eq("id", String(args.document_id)).eq("org_id", ctx.orgId).maybeSingle();
if (!data) return { data: { readable: false, ... } };
```

**`supabaseAdmin` is the service-role client — RLS is not the gate here.** The
comment describes a mechanism that is not running. Every document in the org
returns `readable: true`.

And `log_audit_completion` upserts `drawing_audit_logs` with **no role check at
all**, on a table whose RLS grants only SELECT to members — so there is no
user-writable path, the AI is the sole writer, and it accepts a Viewer.

**Failure scenario.** A Contractor asks the assistant "find the Unit 30 hazard
review." `find_documents` returns number, title, rev, status and `open_url` for
documents whose library ACL denies them. They then ask about content and
`search_documents` returns passages. Separately they say "mark sheet P-2030-001
rev C as passed" and overwrite a real audit-completion record (the upsert
conflict target is `org_id,sheet_number,revision_code`).

**Chain reaction.** This feeds `EGRESS-1` — leaked UUIDs become share links.
`notify_personnel` sends notifications attributed to `actorName: "Document
controller"` rather than the real caller, corrupting attribution. And both
`app/api/orchestrator/execute/route.ts:42` and the tool context read
`member.role` singular, so a secondary-DocCtrl is denied here while the database
grants them (`ADD-1`).

**The right shape already exists in this codebase.** `/api/knowledge/ask` loads a
`KnowledgePrincipal` via `lib/knowledgeAccess.loadPrincipal` and filters every
read through `chainReadable`. The orchestrator should do the same rather than
inventing a second answer.

**Done when.**
1. Every orchestrator read is filtered by the calling user's actual document
   access, not merely their org membership.
2. `check_permissions` evaluates the real ACL, and its comment matches what it
   does.
3. `log_audit_completion` is gated on controller authority, and
   `drawing_audit_logs` has a matching write policy.
4. Notifications the AI sends are attributed to the real caller.

---

## EGRESS-4 · `knowledge_chunks` is readable by every member, bypassing the ACL-aware ask pipeline

- **Severity:** HIGH
- **Status:** REFUTED
- **Verification:** CONFIRMED
- **Blast radius:** confidentiality
- **Locations:**
  - `supabase/migrations/20260911_knowledge_ai.sql:136-140` — `knowledge_chunks_select` grants SELECT to any active org member
  - `supabase/migrations/20260911_knowledge_ai.sql:134-135` — the rationale, verbatim: *"direct member SELECT is allowed (it's the same content as the PDF)"*
  - `supabase/migrations/20260911_knowledge_ai.sql:146-149` — `knowledge_questions_select`, same shape
  - the seam it defeats: `lib/knowledgeAccess.ts:1-16` — *"retrieval excludes chunks of documents the ASKER can't read"*
- **Related:** `EGRESS-3`
- **Re-verified:** hardening pass — **SURVIVES**, and the migration's own justification is where it breaks. `knowledge_chunks_select` is `USING (active org member)` (`20260911_knowledge_ai.sql:136-140`), reasoned as *"direct member SELECT is allowed (it's the same content as the PDF)"* (`:134-135`) — which holds only if the member can read the PDF, and the ACL-aware ask pipeline exists precisely because they may not.
- **Independently verified:** ⛔ **REFUTED** by an independent adversarial pass — do not work this finding. Kept in place with the reason rather than deleted (`DEC-41`). The cited policy at 20260911:136-140 is superseded; source-linked (mirrored controlled-document) chunks — exactly the set /api/knowledge/ask filters per-asker at app/api/knowledge/ask/route.ts:168-180 (`.not("source_document_id","is",null)` → readableControlledDocIds) — are already closed to direct PostgREST reads, so the headline scenario cannot happen. Residual (a different, lesser issue): knowledge_questions_select (20260911:146-149) is still any-active-member with no later override, and 20260806:57-61 makes question+answer text org-wide full-text searchable, so an answer grounded in a restricted document is readable by every member — worth a separate MEDIUM finding, not this one.

**Mechanism.** The stated rationale holds for a standalone knowledge document.
**It does not hold for a source-linked one** — a knowledge document that mirrors
a controlled document. There, the PDF is ACL-protected and the chunk text is not.

**Failure scenario.** A member denied the restricted procedures library queries
`knowledge_chunks` directly through PostgREST and reads the full text of every
mirrored procedure. The careful per-asker filtering in `/api/knowledge/ask` never
runs. `knowledge_questions` similarly exposes the whole org's Q&A history, which
contains answer text extracted from restricted sources.

**Chain reaction.** Same class as `EGRESS-1` and `EGRESS-3` — three independent
routes around the document ACL, each rationalized separately. The ask route
already runs service-side, so restricting the direct member SELECT would not
break it.

**Done when.** A member who cannot read a source document cannot read its chunk
text or the answers derived from it, and `/api/knowledge/ask` still works
unchanged.

---

## EGRESS-5 · `access_requests` — cross-tenant read, and the requests go nowhere

- **Severity:** HIGH
- **Status:** RESOLVED

**Resolution.** All four DEC-19 deliverables landed.
- **Cross-tenant read.** `access_requests_admin_select` was an uncorrelated `EXISTS` — any Admin of any org read every org's requests. The new migration `20261023_access_requests_scope_and_limit.sql` org-correlates the SELECT policy (additive-roles aware: `role = 'Admin' OR roles && ARRAY['Admin']`).
- **org_id drift resolved.** The live route already filtered and inserted `org_id`; the `20260819` backfill `CREATE TABLE` was the stale side. The migration `ADD COLUMN IF NOT EXISTS org_id` (idempotent), backfills legacy rows by org name (unmatched stay NULL = visible to no one, fail closed), and registers the probe in `lib/schemaExpectations.ts`.
- **Unrate-limited public door.** `/api/auth/request-access` now mirrors the `signup_attempts` throttle exactly (8/IP/hour, fail-open, **shared** per-IP bucket), recording an attempt *before* the org lookup so the 404 org-name oracle and 409 duplicate probing both consume the window. The migration also drops the `WITH CHECK(true)` anonymous insert policy — the only writer is the service-role route — so a direct PostgREST insert can no longer bypass the rate limit.
- **No surface → a surface.** `/admin/users` gains an Admin-only pending-requests card (rendered only for Admins, matching the SELECT policy — a Manager would see a permanently empty list), each row with an "Add" action that pre-fills the member form.
- Commit: `44711ca`
- Files: `app/api/auth/request-access/route.ts`, `app/(protected)/admin/users/page.tsx`, `lib/schemaExpectations.ts`, `supabase/migrations/20261023_access_requests_scope_and_limit.sql`
- Tests: `lib/__tests__/requestAccessRoute.test.ts` — 429 gate before any org query or insert; an attempt recorded on a normal submission (both fail against the old route).
- Verified: an Admin sees only their own org's requests (org-correlated policy + explicit `.eq(org_id)`); the public route is rate-limited; a submitted request appears to an Admin. Suite 1431 green.
- Pending migration: `supabase/migrations/20261023_access_requests_scope_and_limit.sql` (code deployed first — the route already handles `org_id`).
- **What this brought to light:** `20260713_branding_admin_writes.sql:15` checks `role = 'Admin'` with **no** roles-array clause, unlike the additive form used here and in `20260817` — a member holding Admin only as a secondary role is refused there. Recorded under the additive-roles family (`ADD-*`); this fix used the additive form throughout.
- **Verification:** CONFIRMED
- **Blast radius:** confidentiality / cross-tenant
- **Locations:**
  - `supabase/migrations/20260819_orphan_tables_backfill.sql:26-30` — the SELECT policy, **with no `org_id` correlation**
  - `app/api/auth/request-access/route.ts:46-53` — unauthenticated and unrate-limited
  - no reader: a search for `access_requests` across `app/`, `lib/`, `components/` returns only this route plus the export/restore/schema plumbing
- **Related:** `SURF-9`
- **Re-verified:** hardening pass — **SURVIVES**, and it is cross-tenant. `access_requests_admin_select` is `USING (EXISTS (SELECT 1 FROM org_members WHERE uid = auth.uid() AND status = 'active' AND role = 'Admin'))` — **the subquery has no correlation to `access_requests.org_id`**, so any Admin of any workspace reads every workspace's requests. Paired with `FOR INSERT WITH CHECK (true)` (`:27`), the table is open to write and org-blind on read.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Both halves hold: the SELECT policy is un-scoped (cross-tenant read of display_name/email/org_name), and nothing in the app ever reads the table, so a submitted request reaches no admin. Two caveats worth recording: the migration header itself says it is a reconstruction and "the live database remains the source of truth", so production's policy may differ; and the route at lines 34/47 filters and inserts `org_id`, a column this CREATE TABLE does not define — on a fresh rebuild the request-access endpoint would 42703/PGRST204 outright.

**Mechanism.**

```sql
CREATE POLICY access_requests_admin_select ON access_requests FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE uid = auth.uid()
                 AND status = 'active' AND role = 'Admin'));
```

There is no correlation between the caller's org and the row's org. **Any Admin
of any workspace reads every access request in the database.** Note also the
backfilled table has no `org_id` column while the route inserts one — schema
drift worth resolving as part of this.

**Failure scenario.** A competitor starts a free trial (becoming Admin of their
own org) and reads the name, email and target company of everyone requesting
access to every customer's workspace.

Meanwhile **no product surface ever displays these rows**, so legitimate
requesters are ignored forever — and combined with the absent invite flow
(nothing writes `status='invited'`, per `SURF-1`), the only door in is
`/api/admin/create-user`.

**Chain reaction.** `access_requests_anyone_insert WITH CHECK (true)` also allows
unbounded direct anonymous inserts. `/api/auth/signup` is rate-limited via
`signup_attempts`; this route is not.

**Done when.**
1. An Admin reads only their own org's access requests.
2. The public route is rate-limited the way signup is.
3. The `org_id` column drift between the backfill migration and the route is
   resolved.
4. Per `DEC-19`, a pending-requests list exists on `/admin/users` and a submitted
   request appears in it. The current state — collected, never shown — is the
   worst of both; the security fixes above land regardless, and having landed
   them the remaining surface is a list view.

---

## EGRESS-6 · `document_versions` has no RESTRICTIVE UPDATE or INSERT guard

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** data-integrity
- **Locations:**
  - `supabase/schema.sql:1072` — permissive `document_versions_org_access FOR ALL`
  - `supabase/migrations/20260813:43` — a RESTRICTIVE **SELECT** overlay
  - `supabase/migrations/20260815:23` — a RESTRICTIVE **DELETE** overlay
  - **no RESTRICTIVE UPDATE or INSERT policy exists**
- **Related:** `OWN-5`, `OWN-17`
- **Re-verified:** hardening pass — **SURVIVES**. `document_versions_org_access … FOR ALL` (`schema.sql:1072`) with no RESTRICTIVE companion for INSERT or UPDATE.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. A repo-wide grep for RESTRICTIVE FOR UPDATE/INSERT returns 12 hits, none on document_versions — the closest (20260901_db_hard_enforcement.sql:152-174) guards `documents`, not its versions. Any active org member can therefore INSERT or UPDATE any version row in their org via PostgREST, including revision_label, file_url and released_at. MEDIUM is right: it is a defence-in-depth gap behind the app paths, not itself an ACL bypass (the RESTRICTIVE SELECT still hides unreadable documents).

**Mechanism.** The confidentiality overlay (SELECT) and the destruction overlay
(DELETE) were both added. The integrity overlay was not. Any active member can
insert a version row against any document, or update an existing one's
`revision_label`, `file_url`, `approved_by_name`, `file_hash` or `released_at`.

**Failure scenario.** This is the table-level reason `OWN-5` (the
`publish_revision` branch path) and `OWN-17` (`backfillVersion`, revision-label
correction) work at all. Even with those two application paths fixed, the raw
PostgREST route remains.

**Chain reaction.** Adding a RESTRICTIVE UPDATE/INSERT overlay here is the
durable fix for a family of findings — but it will refuse writes from every
legitimate publish path unless those paths are checked first. **`OWN-5` and
`OWN-17` should land before this**, so the guard is added on top of paths already
carrying real authority checks rather than in place of them.

**Done when.** A member who could not publish a revision cannot insert or amend a
`document_versions` row by any route, and every legitimate publish path still
succeeds.

---

## EGRESS-7 · Revoking a share is a silent no-op for a non-creator once the UPDATE policy tightens

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** security / availability
- **Locations:**
  - `lib/documentShares.ts:68-73` — `revokeShareLink` updates `document_shares` by `id` with no `.select()`, so a refused write returns success with zero rows
  - `components/documents/ShareLinkModal.tsx:75-79` — `revoke` awaits it and `refresh()`s; no rows-affected check
  - `supabase/migrations/20261022_document_shares_acl_scope.sql` — the new UPDATE policy (creator or controller) that makes the no-op reachable
- **Related:** `EGRESS-1`, `OWN-14`
- *(Raised while resolving `EGRESS-1`, 2026-08-24. Checked only by this session — `author` grade until independently challenged.)*

**Mechanism.** `EGRESS-1`'s migration correctly limits `document_shares` UPDATE to the creator or a controller. But `revokeShareLink` writes by `id` with no `.select()` — the exact silent-write-failure shape of `OWN-14`. After the policy lands, a member who is neither the share's creator nor a controller who clicks "Revoke" gets a 200 with zero rows changed; the modal refreshes and the share still shows as active, still serving. The link they believe they revoked is live.

**Failure scenario.** A DocCtrl revokes a colleague's over-broad share to a sensitive drawing. It is not their share and they are… actually a controller, so it works for them — but a Manager or the document's owner (non-controller) doing the same sees "revoked" and walks away while the token keeps serving.

**Done when.** `revokeShareLink` selects the affected row back and surfaces a visible error when zero rows change; the modal shows that error rather than a stale "active" state.

---

## EGRESS-8 · `listShareLinks` exposes live tokens to members who cannot read the document

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** security / confidentiality
- **Locations:**
  - `lib/documentShares.ts:59-66` — `listShareLinks` selects `*` (including `token`) by `document_id`
  - `supabase/migrations/20260623_document_shares.sql` / `20261022_document_shares_acl_scope.sql` — the SELECT policy is any active member of the row's org, with no document-read decision
- **Related:** `EGRESS-1`, `SURF-2`
- *(Raised while resolving `EGRESS-1`, 2026-08-24. Checked only by this session — `author` grade until independently challenged.)*

**Mechanism.** The `document_shares` SELECT policy gates on org membership, not on whether the member can read the shared document. `listShareLinks` returns every column including `token`. So a member who is denied read on a restricted drawing can still enumerate its live share tokens via PostgREST and fetch `/api/share/file?token=…` — an intra-org parallel to `EGRESS-1`'s cross-org leak. `EGRESS-1`'s creator-authority re-check on `/api/share/file` narrows this (the share serves on the *creator's* authority, not the enumerator's), but the token itself should not be visible to someone who cannot see the document.

**Done when.** A member who cannot read a document cannot retrieve its share rows' tokens; the SELECT policy (or the query) applies a document-read decision, or tokens are omitted from the member-visible projection.

---

## Verified sound — do not break

1. **The public token portals themselves** — `/api/share/*`, `/api/intake/*`,
   `/api/transmittal`. Token format is validated before any database touch,
   revoked and expired states are handled distinctly, each token is scoped to
   exactly one artifact, downloads are audited, and the transmittal serves the
   *as-sent* revision rather than the newest. **The token handling is good
   design** — `EGRESS-1` is about what a share row is allowed to point at, not
   about how the token is checked. (`OWN-4` concerns a different branch of the
   intake route.)
2. **`/api/storage/download-url`** — `assertSafeStorageKey` before the prefix
   gate, with the path-traversal reasoning written down; an org-prefix membership
   check; plus an ACL `canDiscover` check for private and hidden documents. This
   is the reference implementation for a gated read.
3. **`lib/knowledgeAccess.ts`** — a real principal, resolved once, with
   `chainReadable` filtering retrieval per asker. `/api/knowledge/ask` uses it
   correctly. **This is the pattern `EGRESS-3` should adopt rather than a new
   mechanism.**
4. **`documents_acl_select` / `collections_acl_select`** — RESTRICTIVE SELECT
   policies that AND with the permissive org policy, so an ACL denial cannot be
   OR'd away by a permissive policy elsewhere. The composition is correct; the
   findings in this report are all about paths that never reach it.
5. **`ai_excluded`** — a real, per-document opt-out honoured by the orchestrator's
   reads. It is the right primitive; it is just not a substitute for the ACL.
6. **`/api/cron/embed-drain`** — correctly scopes its user-session fallback to
   the caller's own orgs, which is exactly what `SURF-5` fails to do.
