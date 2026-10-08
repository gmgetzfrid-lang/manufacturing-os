# 90 · Gap register — build specs

**10 capabilities the Projects/Project-Controls surface needs and does not have.**

Numbered from **401** so they never collide with `roles-and-permissions`
(`GAP-1`…`GAP-15`), `drafting-flow` (`GAP-101`…`GAP-114`), `notifications`
(`GAP-201`…`GAP-207`) or `intelligence` (`GAP-301`…`GAP-312`).

---

## ⚠ How this register differs from the others

**It was derived from the findings, not from a design run.** The other four
registers came out of dedicated design agents that read the owner's intent and
proposed capabilities. This area was audited first, before that pattern existed,
and its 133 findings are overwhelmingly *defects to repair* rather than
*capabilities to build*.

So the specs below are the **capabilities those defects imply** — the cases where
fixing the finding means building something that does not exist, rather than
correcting something that does. Each names its source findings.

**Consequences for how you use it:**

- Every spec **inherits the verification status of its source findings**. Per this
  area's own README, every `CRITICAL` and `HIGH` was verified first-hand at the
  time of the audit against commit `6a14d7d`. That was several sessions ago —
  **re-read the cited code before building** (`DEC-29`).
- Where a finding is a straight repair with no missing capability, it stays a
  finding and is **not** duplicated here. The findings remain the primary record.
- `11-upload-door-controls.md` was already a design note. `GAP-401` supersedes it
  as a spec; the note stays as the reasoning behind it.

---

## Verdicts at a glance

| Gap | Capability | Verdict | Effort | Blocked on |
|---|---|---|---|---|
| [GAP-401](#gap-401) | The unauthenticated upload door as a real boundary | **BUILD** | M | — |
| [GAP-402](#gap-402) | A write that cannot silently fail | **BUILD_NARROW** | S | — |
| [GAP-403](#gap-403) | Stable row identity for schedule re-import | **BUILD** | M | — |
| [GAP-404](#gap-404) | Evidence that actually evidences | **BUILD** | M | `GAP-402` |
| [GAP-405](#gap-405) | Gates with teeth — no blank-reason bypass | **BUILD_NARROW** | S | `GAP-402` |
| [GAP-406](#gap-406) | The award as a transaction, with a repair path | **BUILD** | M | `GAP-402` |
| [GAP-407](#gap-407) | One number, one source, on the bid tab | **BUILD_NARROW** | S | — |
| [GAP-408](#gap-408) | The timeline sees the controls program | **BUILD** | M | — |
| [GAP-409](#gap-409) | The registry at scale — pagination and caching | **BUILD_NARROW** | S | — |
| [GAP-410](#gap-410) | An accessibility baseline for safety surfaces | **BUILD** | M | — |

---

<a id="gap-401"></a>
## GAP-401 · The unauthenticated upload door as a real boundary

**Verdict: BUILD** · Effort: **M** · Sources: `SEC-1`, `SEC-4`, `SEC-5`–`SEC-8`, `11-upload-door-controls.md`

### Why it is a capability and not a fix

`SEC-1` — an unauthenticated upload link can put **executing JavaScript on the
app's own origin**. `SEC-4` — the external door runs as **service role**, so every
database-level document-control guard is skipped.

Those are not two bugs to patch. Together they say the external door has no
boundary: it is a hole with a token in front of it. What has to exist is a
**contract for untrusted content** that every external entry point goes through.

### Scope

**In:** content-type and magic-byte validation; a serving origin that is not the
app's; size and rate limits per token; a token model with entropy, expiry and
revocation; and — the structural one — **the door stops using the service role**
and instead assumes a constrained identity that the DB guards still apply to.

**Out:** redesigning the intake workflow. This is the boundary, not the flow.

### Do not

- **Do not fix `SEC-1` with an extension allowlist.** Filenames are attacker-controlled.
  Validate content and serve from an origin where execution cannot hurt you.
- **Do not keep the service role and add application-layer checks.** That is the
  defect: the guards exist in the database and the door routes around them. An
  application check is a second implementation that will drift.
- **Do not treat the token as authentication.** It is a capability URL — it can be
  forwarded, logged and shoulder-read.

### Acceptance

1. An uploaded HTML/SVG/JS file cannot execute on the app's origin. A test uploads
   one and asserts the response headers and origin.
2. Every DB-level document-control guard applies to content entering by this door.
3. Tokens expire, can be revoked, and revocation is effective immediately.
4. Rate limits are enforced server-side and fail **open** on a limiter error —
   matching `app/api/auth/signup/route.ts:19-33`, the house pattern.

**Related:** the new `document-control` area's intake lens covers the promote
pipeline this door feeds. Read both.

**Partial (2026-10-01, projects Round G).** Assigned to projects-joint J12 SERVER REMAINDERS for its two open items — the door's constrained identity (Scope's "structural one", acceptance 2) and a serving origin that is not the app's (acceptance 1's origin half). **Neither is built here**, for reasons the integrator can act on:
- **The constrained identity** means rebuilding `app/api/intake/upload/route.ts` (and the direct-upload finalize) to write as an identity the database guards apply to — a per-request token scoped to one link, with insert policies for that link's project and library — instead of the service role. That route's tests (`lib/__tests__/intakeUploadRoute.test.ts`, `intakeDoorMigration.test.ts`) and the intake-door migrations of this wave (`20261149`–`20261151`) are document-control P14's; a rebuild of the door's identity beside them would collide. It needs its own package with those files.
- **A separate serving origin** is a second domain (or bucket host) that serves uploads with no cookies and no app script — a deployment change this tree cannot make or prove. What the tree holds already stands: the door stores only sniffed PDF / DWG / DXF / ZIP (`SEC-6`), every presigned download is an attachment unless a viewer asks and the type cannot be a page (`DEC-49`, `SEC-18`), and `nosniff` / the viewer's refusal to frame HTML or SVG (`SEC-1`'s egress half).
- Acceptances 3 (tokens: entropy, expiry, revocation effective immediately — J1, `SEC-19` hashing) and 4 (server-side rate limits failing open — J1, `intake_attempts`) hold as recorded on their findings.

Owed: (1) the door's constrained identity, in a package that owns the door's route, tests and migrations; (2) an `UNTRUSTED_CONTENT_ORIGIN` (or equivalent) that presigned GETs of door uploads use, with the operator step to stand it up.

*Assigned by the integrator, 2026-10-07, at the J12 merge (DEC-31):* both owed items → projects-joint **J16 INTAKE DOOR IDENTITY & UNTRUSTED ORIGIN** (new; after drafting-flow DF-P1, which edits the door's route). The separate origin's deployment is the user's operator step; J16 builds the code half (fleet plan `audit-reports/fleet-plans/projects-joint.json`).

**Partial (2026-10-07, projects Round G).** Package projects-joint J16 INTAKE DOOR IDENTITY & UNTRUSTED ORIGIN built the code half of both owed items. Neither closes GAP-401 as written, so it stays OPEN; each remainder has an owner below (`DEC-31`). Review fix pass 3 corrected three claims here: the degrade path covered only the two preconditions it tested (now: every privilege the live policies need, and a fallback for the rest); the 42P17 was "handed to the integrator" with no record (now `SEC-23`); and owed item 2 had two alternative owners and an operator check that could not pass (now one owner and the export's check). Review fix pass 4 corrected three more: a restrictive policy written for all roles that a link cannot satisfy **refuses** the door's new document or quote (500), which this block and `DEC-44 (J16)` had read as impossible (now detected by a fourth paste row and a shape test, below); the Regression line said every contractor flow answers exactly as before after the paste, while some trusted promotes now go to review (below, and "Judged is not admitted"); and the operator doc said "nothing else changes" although the browser-built Full ZIP fetches the new address cross-origin (now a check step). Review fix pass 5 corrected two more. Fix pass 4 kept a restrictive policy for all roles that the link fails as a **refusal**, so an upload that works today would answer 500 after the paste; such a policy is now a gap found **before** the switch, that write keeps the bound identity and is filed as before, and only the door's own policies refuse after the switch (below, "A policy the link may fail is a gap"). And the operator doc still said contractor files open "as before" and that setting the value early was harmless, while the in-app viewer fetches the file cross-origin like the Full ZIP once download-url adopts `signStorageGet` (now named, step 5 required, and the hand-off's done-when checks the viewer). The integrator fix pass after review 5 kept both: the file's header now says exactly what the code does (the readiness limb, the service-key INSERT it falls back to, the named-policy fallback after the switch, and the one unnamed refusal that is raised), the shape test pins that header and the two handlers' re-raise / fallback branches, the route cases file a new document and a quote exactly as today when such a policy is live and as the door identity when none is (and pin that the route never asks readiness itself), `untrustedContent.test.ts` pins this hand-off's viewer and curl checks, and the readiness function alone was re-run on a throwaway PostgreSQL 16 (below, R0–R10). Decision: `DEC-44 (J16)` (provisional number).

*Reproduced on HEAD `2de62f1` before the change.* Every content write in `app/api/intake/upload/route.ts` was a `supabaseAdmin` write (base `:383` publish, `:878` quote, `:978` redline, `:1365` document, `:1491` version, `:1531` pending pointer). The service role's JWT carries no `sub`, so `auth.uid()` is NULL, and every guard that would judge the write returns early: `enforce_document_publish_guard` (`20261174:181`, `IF v_actor IS NULL THEN RETURN NEW;`), `documents_authorship_fixed` (`20261141:222`), `enforce_document_insert_pointer_rail`, `enforce_document_register_rail` and `documents_unit_code_guard` (`20261131`, `20261138`), `enforce_document_hold_label_guard` (`20261074`), `enforce_project_record_guard` (`20261103`). Scratch PostgreSQL 16 run, step 0: a service-role `publish_revision` naming a creator with no publish authority on the library answered `published`, because the guard never ran.

*Owed item 1: the door's constrained identity. Built: the door's new documents and quotes are written under row-level security as a dedicated database role, and every content write runs under a bound identity the trigger guards judge. Not under row-level security: the submission, the pending pointer, the promote and the redline, each for a reason a scratch run of the whole sequence showed (below).*

**Correction (review fix pass 2, 2026-10-07).** The first version of this block said row-level security for the door needs the project's JWT signing secret, made `SEC-22` (a) wait on an operator step, and advised putting that secret in the app's environment. That was wrong. A role switch needs no JWT: PostgREST logs in as `authenticator`, so a NOLOGIN role granted to `authenticator` can be switched to with `set_config('role', …, true)` inside a SECURITY INVOKER function called under the service key. Postgres refuses the switch only inside a SECURITY DEFINER function. The JWT-secret advice is withdrawn: that secret can mint a token for any role or any member's `sub`, so a leak of the app's environment would get worse for nothing.

How it works now (`20261184`):
- **The role.** `intake_door`: NOLOGIN, NOINHERIT, no BYPASSRLS, a member of no role. It is granted to `authenticator` and nothing else. A pre-existing role of that name that can log in, create roles or bypass row-level security refuses the paste. It inherits no `TO authenticated` policy and adds no row to `auth.users`, which were the two reasons the hidden-auth-user route was rejected. That route stays rejected.
- **What the role holds.** USAGE on `public` and `auth`. Column INSERT on exactly the columns the door writes in `documents` and `cost_documents` (`created_by_name` only where the live table has it). It also holds what the existing rails read as the writer during a document INSERT: SELECT (`id`, `org_id`, `acl_index`) on `libraries` for `documents_deny_upload_guard`, and SELECT (`document_id`, `source`) plus DELETE on `document_assets`, because `documents_resync_assets` clears tag links after the insert. Row-level security shows a link none of those rows. It holds EXECUTE on its two policy predicates and, by name, on what the policies written for all roles call when they judge its INSERT (review fix pass 3): `my_org_ids()` (`documents_org_access`), `is_org_controller(uuid)`, `acl_index_denies(jsonb, uuid, uuid, text)` and `auth.uid()` (`documents_deny_upload_guard`), `is_org_controller(uuid)` (`cost_documents_write`) and `user_owns_project(uuid)` (`cost_documents_owner_write`). It held them only through PUBLIC before; by name, a later DRLS-16 `REVOKE … FROM PUBLIC` does not take them away (`auth.uid()` soft, like USAGE on `auth`). It has no UPDATE anywhere and nothing on `document_versions`.
- **The switch.** `intake_door_create_document` and `intake_door_file_quote` are now SECURITY INVOKER (EXECUTE still the service role's alone). Each resolves the link, checks scope and binds the identity as before. It then switches to `intake_door` for its one INSERT and switches back before anything else runs. The INSERT chooses its id first, because a RETURNING would also need read policies, which show a link nothing. `intake_door_rls_ready(p_new_document)` decides whether to switch, by asking `intake_door_rls_gaps(session_user, p_new_document)` (review fix pass 3) what the INSERT as `intake_door` would lack on this database: the session's login must be able to SET the role (MEMBER before PG16); a new document also needs USAGE on `auth`, because the INVOKER document triggers call `auth.uid()`; and the role must hold EXECUTE on every function, and SELECT on every column of another table, that the **live** INSERT and ALL policies of the table (for every role or for `intake_door`) use, read from `pg_policy` through `pg_depend` at run time, plus EXECUTE on `auth.uid()` for a new document; and (review fix pass 5) no restrictive INSERT or ALL policy of the table for every role that the link may fail may be live (the bullet below). If anything is missing, that write keeps the bound identity alone, which is exactly the shape before this fix. A privilege the check cannot see (a trigger's own read, a column grant) makes the INSERT as `intake_door` fail with "permission denied …": the door function catches exactly that (`insufficient_privilege` whose message starts "permission denied"), undoes the INSERT and its role switch, leaves a WARNING naming the privilege in the database log, and runs the same INSERT once more with the bound identity alone. A refusal by the door's own policies, and every other error, are raised; since review fix pass 5 a refusal naming any other policy is run again the same way (the bullet below). So no privilege gap refuses a contractor's upload; the first version said it degraded, but that held only for the two preconditions it tested.
- **A policy the link may fail is a gap** (review fix pass 5, reversing fix pass 4's "A policy's refusal is not a gap"). The INSERT as `intake_door` is judged by every policy written for all roles, so a RESTRICTIVE INSERT or ALL policy for every role that the link's identity cannot satisfy (one asking for membership, say) would **refuse** that new document or quote, an upload that works today. Fix pass 4 kept that refusal (the route answered 500, "Couldn't create the document" / "Couldn't record the quote", for every such upload until someone wrote a migration) and only reported the policy after the paste, which broke the rule that every flow working today keeps working. Now `intake_door_rls_gaps` names each such policy of the table, for PUBLIC or `intake_door`, as `policy <name>`, other than the door's own `*_intake_door_scope` (TO `intake_door` alone) and `documents_deny_upload_guard` while, by `pg_depend`, it reads nothing but `libraries`, `auth.uid()`, `is_org_controller` and `acl_index_denies` (the repository's shape; a link passes it, since row-level security shows a link no `libraries` row). That is fix pass 4's fourth-row predicate, moved into the function the door decides by. With such a gap `intake_door_rls_ready` is false, and that table's write runs with the bound identity under the service key: today's shape, every trigger guard still judging it, the upload filed. A refusal the check could not see (a policy made since it ran, or one written for a role `intake_door` inherits) is caught after the switch like a privilege gap: the INSERT runs again with the bound identity and a WARNING names the policy. Such a fallback never writes a row the door's own policy would refuse, short of a link revoked within the same request: every value its predicate reads (org, library, folder, author and status; for a quote the project, link, vendor, RFQ group, file prefix, party and status) is set or checked by the door function from the link it resolved. Only the door's own policies' refusal is raised after the switch: Postgres's unnamed "new row violates row-level security policy for table …" (no permissive policy admitted the row, and the door's permissive policy is the one a link can pass) or the named `*_intake_door_scope`. The route answers it as the write's own 500, because those policies are the link's boundary. The paste's fourth row-level-security row now reads this gap from `intake_door_rls_gaps('authenticator', …)`; false means such a policy is live and the door's writes on that table are filed with the bound identity, not refused. `prjRoundGJ16DoorIdentity.test.ts` still fails any migration after `20261184` that adds or re-writes one without a TO clause leaving `intake_door` out, a predicate naming it, or a `-- intake_door: <policy> …` comment, because such a policy would take the door's writes on that table off row-level security unannounced.
- **The policies.** On `documents` and on `cost_documents`: a PERMISSIVE and a RESTRICTIVE INSERT policy `TO intake_door`, each reading `intake_door_may_create(…)` / `intake_door_may_quote(…)` with the row's own columns. These SECURITY DEFINER predicates are `intake_door`'s alone to execute. They read the **bound** link through `intake_door_bound()`, which no role may execute. That function checks that the role is `intake_door`, the claims are the door's, and `sub` is the link. It then re-reads the link row, which must be neither revoked nor expired, with its project open. A new document must be a Draft in that link's intake library and intake folder, authored by that link. A quote must be a draft from a quote link on its own project, with the link's company and RFQ group, a party of that project, the file under the project's costs prefix, and no `created_by`. The restrictive half keeps every policy written for all roles from widening the door.
- **Where the paste cannot grant it.** The grants whose success depends on the hosted privilege layout are soft: authenticator's membership, USAGE on `auth` and EXECUTE on `auth.uid()`, where Postgres only warns without a grant option. A refusal leaves a notice. Three probe rows of the final SELECT say whether the door will switch, and they ask the same `intake_door_rls_gaps` the door functions decide by, for `authenticator` (review fix pass 3, minor: the first version's row tested MEMBER while the door tested SET, so a membership granted WITH SET FALSE read true while every door write skipped the switch): the switch, USAGE on `auth` for a new document, and the functions and columns the live policies use. A false row means the paste still applied, and that limb keeps the bound identity. The row should be sent back; `SELECT intake_door_rls_gaps('authenticator', true), intake_door_rls_gaps('authenticator', false);` lists what is missing. A fourth row (review fix pass 4; since review fix pass 5 it asks the same function): false means a restrictive policy for all roles that the link may fail is live (the bullet above), so the door's writes on that table keep the bound identity, filed as before, until it is settled. The same `intake_door_rls_gaps` query names it (`policy <name>`), and `SELECT polname, polrelid::regclass, pg_get_expr(polwithcheck, polrelid) FROM pg_policy WHERE polrelid IN ('public.documents'::regclass, 'public.cost_documents'::regclass) AND NOT polpermissive AND polcmd IN ('a', '*');` shows its predicate.

Not under row-level security, and why (scratch PostgreSQL 16, the **whole** sequence: `schema.sql` and every migration, applied as a non-superuser `postgres` with a Supabase-shaped `auth` schema and an `authenticator` login):
- **The submission.** Any INSERT into `document_versions` by a role that row-level security applies to fails at rewrite with 42P17 "infinite recursion detected in policy for relation document_versions". `20261037`'s `document_versions_insert_integrity` reads `document_versions` in its first-version test, and `document_versions_org_access` holds a subquery. This is **pre-existing and not the door's**: a signed-in member (a DocCtrl) inserting a version as `authenticated` gets the same 42P17 on the base `2de62f1`, and dropping that one policy turns it into an ordinary RLS answer. If the live database matches the sequence, every member's direct version insert fails today. If it does not, the live policy text differs from the repository's. Either way it belongs to the policy's owner: opened as projects-tab **`SEC-23`** (review fix pass 3), assigned to roles-and-permissions, with the reproduction, a live verification step (a paste-back of the policy's text plus one member revision upload) and its done-when. Until it is settled the door's submission keeps the bound identity under the service key, unchanged.
- **The pending pointer.** It is an UPDATE. `documents_acl_select`, a restrictive read policy for every role, hides even the link's own Draft from a writer with no membership, so the compare-and-set would match no row.
- **The promote, the redline and the housekeeping.** `publish_revision` is SECURITY DEFINER, and its documents write is judged by the trigger guards as the creator. The redline is the ticket rails' service-only append. The housekeeping writes are `SEC-22` (b).

Also in `20261184` (from the first pass unless marked):
- **Every door function** resolves the link **from its token hash in the database** (`intake_door_resolve`). A revoked, expired, gone or closed link is answered with 28000 and a HINT the route maps, so a revocation takes effect mid-request too. Every door function is revoked from PUBLIC, anon and authenticated and granted to the service role alone. The five helpers the INVOKER door functions call (`resolve`, `bind`, `unbind`, `rls_gaps` (review fix pass 3), `rls_ready`) are SECURITY INVOKER and the service role's alone. Each door function refuses a signed-in caller (DRLS-16): `intake_door_create_document` and `intake_door_file_quote` (INVOKER, the role switch), and `intake_door_submit_version`, `intake_door_point_pending`, `intake_door_promote` and `intake_door_append_redline` (SECURITY DEFINER).
  - Each refuses a write outside the link's scope (42501): a new document goes only into the project's intake library and intake folder, authored by the link; a version only onto a document the link authored or was assigned; the pending pointer only to the link's own in-review submission, and a replacement only from a trusted link of its own earlier one (`INTK-4` dw3); a promote only from a trusted link, only on its own, unassigned, approved document; a quote only from a quote link, onto its own project, with a party of that project; a redline only on a ticket that names the link; every storage key under the link's project prefix. A policy refusal is 42501 too, but without the door's HINT. Since review fix pass 3 the route maps only a 42501 carrying HINT `scope` or `not_configured` to the link's sentence; any other 42501 (a policy refusing what the door's own checks admitted, a privilege the database lacks, a guard's 42501) is answered as the write's own failure, 500 and a reference, never "This link isn't fully configured yet" or "This link can't file that quote", and never followed by the service-role write.
  - Each binds a transaction-local identity before its write and restores it before returning: `request.jwt.claims` plus the legacy claim GUCs are set to `{ sub, role: 'intake_door', intake_link_id, org_id, project_id }`. `sub` is the **link** for document, version, pointer and quote writes. For the promote it is the link's **creator**, so `publish_revision` and every guard on its documents write judge the creator, as `DEC-56` item 2 says (`SEC-4`'s residual: until now the route's own checks were the only check).
  - **The promote's version is allow-listed** (review fix pass 2, minor). `publish_revision` receives `jsonb_build_object` of exactly `revision_label`, `file_url`, `file_type`, `size`, `change_log`, `created_by_name` and `file_hash`, with `provenance` `'external'`. It is no longer `p_version || …`, so no `change_type`, `issue_type`, `moc_reference`, `reverted_from_version_id`, `related_ticket_id`, `source_*` or `*_by_name` from the caller can turn off RG-7's require-mode limb, the DCK-1 drawing-class MOC gate or any other limb. On the scratch run, a promote sent with `change_type 'Minor'`, `issue_type`, `moc_reference`, `reverted_from_version_id`, `related_ticket_id`, `source_file_key` and `provenance 'internal'` published a version with all of those NULL and provenance `external`.
  - The redline binds no identity. The ticket rails (`20261166`) keep a ticket's attachments service-only, so the door calls `append_ticket_redline`, and answers 42883 until that file is pasted.
  - INTK-16's `documents_authorship_fixed` is re-created from its newest body (`20261141`, found by scanning; lineDiff-pinned) with one added block. The block lets the door's identity record its **own** link as the author of the document it creates, and nothing else.
- **`app/api/intake/upload/route.ts`**: every content write, on both the multipart and the finalize path, first goes through the door function (`viaDoor`, `doorAnswer`, `doorRefused`). Only "the function is not there" sends the request down today's path, and `doorFunctionAbsent` decides it from the error's **code**: PGRST202, or a 42883 whose message **starts with** the door function's name (Postgres's own `function public.intake_door_…(…) does not exist`, or the redline door's `intake_door_append_redline:` raise). A guard's refusal is never read as "absent", whatever its message says, because a guard message can carry text the contractor chose, such as a document number (review fix pass: the first version also matched the message alone, so a document numbered "could not find the function public.intake_door_x" could turn the adoption guard's refusal of a promote into a service-role publish). Then the request writes exactly as before. The request learns this once and never asks the door again. A dead link is answered with the same codes as the checks before the body. A scope refusal (42501 with the door's HINT `scope` or `not_configured`) gets a sentence and a reference. Any other refusal is answered as that write's own failure, with the created document discarded and the stored object removed. None of these is ever followed by the service-role write. Guard refusals of the promote demote it to review with the route's own sentences. The provenance stamp is the door's when it promoted.
- `lib/schemaExpectations.ts`: two probes (`intake_door_promote`, `intake_door_point_pending`) name 20261184 when it is missing.
- **The intake folder** (review fix pass). `ensureIntakeFolder` uses the project's `intake_collection_id` only when it names a folder of the project's intake library in the link's org. The column is owner-writable and no database rail ties it to the library, while `intake_door_create_document` files only into such a folder. Any other value (a folder of another library or org, or one that is gone) is treated as unset: a folder is made in the intake library and claimed with a compare-and-set on the stale value, and the server log says so. The contractor's drawing is therefore filed the same way before and after the paste. Before this fix the route filed it into the foreign folder before the paste, and answered 403 with the revision sentence after it. A create the door still refuses for scope (the pointer moved between the route's check and the door's read) answers 409 "This link isn't fully configured yet — ask your contact to check the project's intake library and folder.", never the revision sentence.
- Tests:
  - `lib/__tests__/intakeUploadRoute.test.ts`. The harness models a database before the paste, and all 121 earlier cases pass on it (its seed now also carries the intake folder as a folder of the intake library, which the route checks; review fix pass). The "J16 (GAP-401)" block emulates the door functions over the same tables and runs the **same request before and after the paste**: a new document, a revision into review, an assigned document, the trusted promote, a quote, a redline and the direct finalize (in the INTK-15 block) each answer the same, write the same document, version and quote rows, notices and project reference, and make no service-role content write. It also covers guard refusals demoting, a link revoked, expired or closed mid-request, a scope refusal, "asked once", other errors, the door's 23505s, a lost pointer race, and the redline before 20261166. The review fix pass adds: a guard refusal of the promote whose message reads like "function not found" demotes with no service-role `publish_revision` (and P0001 / a 42883 naming another function on a create stay refusals, while a genuine PGRST202 / 42883 still takes today's path); a new document the door refuses for scope answers 409 `not_configured`; a stale intake folder pointer is re-homed, in both worlds. These cases emulate the door functions in JavaScript without the trigger guards, so they pin what the **route** does with each answer, not what the guards admit (Done-when 2). The pointer census counts `intake_door_promote` as a pointer mover.
  - `lib/__tests__/prjRoundGJ16DoorIdentity.test.ts`: the DEC-30 shape; DRLS-16 for every function the file adds; the lineDiff against the newest earlier definition; the bind and unbind order; scope parity with the keys the route builds; the route's parameter names against the SQL signatures; the absent-detection codes (code-only, no message-only match, and no other migration raises 42883 itself); the schema-health rows. Review fix pass 2 adds the role switch: the header no longer claims a JWT secret is needed; the role is NOLOGIN, made in the transaction, granted to `authenticator` alone, and a powerful pre-existing role refuses the paste; the two soft grants and their probe rows; the role's grants exactly, with the INSERT columns equal to each door function's INSERT list; the switch around the one INSERT (no RETURNING, back before the unbind) in the two INVOKER door functions and in no other function; `intake_door_rls_ready`; the four policies (a permissive and restrictive pair per table, INSERT only, nothing on `document_versions`); the bound-link reader and the predicates' limbs; and the promote's allow-list, keyed to the route's own version object. 17 of its 37 cases fail on the first pass's file. The route test's promote emulation now applies the same allow-list. Review fix pass 3 (43 cases; 11 fail on fix pass 2's file) adds: `intake_door_rls_gaps` (INVOKER, `search_path` pinned, the service role's alone) reading the live INSERT/ALL policies through `pg_depend` for EXECUTE and column SELECT, and `auth.uid()`; `intake_door_rls_ready` asking it for `session_user`; the three probe rows asking it for `authenticator`, with no `pg_has_role` of their own and the SET/MEMBER choice written once; the by-name EXECUTE grants (the four public helpers where they exist, `auth.uid()` soft), each a function a policy of the sequence calls; the role-switched INSERT inside a LOOP whose one handler catches only `insufficient_privilege` whose message starts "permission denied", warns, and re-runs the ONE INSERT with the bound identity (no second INSERT, no OTHERS handler, and no migration raises a message starting "permission denied"); and a detector that fails when a migration after `20261184` revokes EXECUTE on one of those helpers from PUBLIC, sweeps a schema's functions from PUBLIC, or drops one, without granting it back to `intake_door` (itself tested on DRLS-16-shaped SQL).
  - `lib/__tests__/intakeUploadRoute.test.ts`, review fix pass 3: a 42501 without the door's HINT (a privilege gap, a policy refusal, the resolver's signed-in refusal) on the new document, the quote and the submission answers 500 with a reference and the write's own sentence, removes the stored object and makes no service-role write; a 42501 with HINT `not_configured` / `scope` keeps its 409 / 403. It fails on fix pass 2's route.
  - `dcRoundFGuardFollowups`, `dcRoundFReviewGate` and `intakeAutoPublishAcks` now pin the new `versionRow` and model the database before the paste.
  - Review fix pass 4: `lib/__tests__/prjRoundGJ16DoorIdentity.test.ts` (47 cases; the fourth-row case fails on fix pass 3's file) pins the fourth row-level-security row limb by limb (it reads `pg_policy` and `pg_depend`, never the deparsed text; ok with n NULL; placed after the other three) and the header's "A POLICY'S REFUSAL IS NOT A GAP"; checks that the row's exclusions are exactly what the sequence holds (scanning `schema.sql` and every migration up to `20261184`, the one restrictive INSERT / ALL policy for every role on the two tables is `documents_deny_upload_guard`, whose newest definition calls only `auth.uid`, `is_org_controller` and `acl_index_denies` and reads only `libraries`); and runs the `restrictsDoor` detector over every migration after `20261184`. The detector is itself tested: the reviewer's hardening policy, FOR ALL or no FOR, TO public or `intake_door`, one inside a DO block, a `format()`-built one in a file naming the table, a re-created upload guard and an ALTER of it are caught; a TO clause leaving the role out, a predicate or a `-- intake_door: <policy>` comment naming it, a permissive or UPDATE policy, another table, a rename and `20261045`'s asset overlays are not.
  - Review fix pass 5: `lib/__tests__/prjRoundGJ16DoorIdentity.test.ts` (48 cases; five fail on fix pass 4's file). It pins the `policy <name>` limb of `intake_door_rls_gaps` piece by piece (the fix pass 4 predicate, read from `pg_policy` and `pg_depend`, written once in the file) and that the paste's fourth row reads `g LIKE 'policy %'` from `intake_door_rls_gaps('authenticator', …)`, with no "send back at once" and no 500. Every gap the function reports is read by one of the four rows. The two INVOKER door functions' handler is pinned line by line: it re-raises the door's own refusals (the unnamed permissive refusal and the named `*_intake_door_scope`, each the policy section 9 creates on that table) and anything that is neither "permission denied" nor another policy's refusal, and runs the INSERT again otherwise. No migration raises its own "permission denied …" or "new row violates …". The header's "A POLICY THE LINK MAY FAIL IS A GAP TOO" replaces "A POLICY'S REFUSAL IS NOT A GAP". The `restrictsDoor` sweep and its 18-case detector test stay. `lib/__tests__/untrustedContent.test.ts` pins the operator doc's viewer wording (below).
- **Scratch PostgreSQL 16 run, first pass** (a Supabase-shaped stub with the real `20261141` rail, `20261174` publish guard, `20261151` publish_revision, the `20261131` / `20261074` / `20261138` / `20261103` / `20261077` rails and, for 9b, `20261166`'s append). The migration applied twice, idempotently, with all 8 probes `t`.
  - **0** (the reproduction above).
  - **1**: create_document wrote a Draft in the intake folder, authored by K and written with `auth.uid() = K, role intake_door`, and the claims were empty afterwards.
  - **1b**: a duplicate key gives 23505 from inside the door.
  - **2**: another folder, or a quote link, is refused 42501.
  - **3**: a member stamping a link is refused (unchanged), a forged door identity for another link is refused, and the door never changes authorship.
  - **4**: a submission is forced to in_review, external and K; an unassigned org document is refused; an assigned one through K2 is accepted; a key outside the project is refused.
  - **5**: the pointer from NULL writes 1 row as K, a stale compare-and-set writes 0, and an untrusted replace is refused.
  - **6**: the promote by K (creator a DocCtrl) published, its documents write ran as the creator, and the version was stamped K.
  - **6b**: the same promote by a link whose creator has no publish authority is now refused by the guard ("You do not have authority to publish revisions in this library."), where step 0 had passed it.
  - **6c**: a require library is refused (RG-7).
  - **6d**: a hold gives on_hold; no creator and untrusted are refused.
  - **7**: revoked, expired, closed and unknown links give 28000 with the right HINT.
  - **8**: a quote takes its vendor and RFQ from the link; another project's party is refused; a documents link is refused.
  - **9**: the redline gives 42883 before 20261166; another link's ticket is refused; a gone ticket answers false.
  - **9b**: with 20261166 present, the append ran as the service pass and an archived ticket took none.
  - **10**: authenticated and anon may not execute, and a signed-in caller is refused inside.
- **Scratch PostgreSQL 16 run, review fix pass 2: the whole sequence.** The cluster carried `schema.sql` and every numbered migration before `20261184`, all applied as a **non-superuser** `postgres` (CREATEROLE, BYPASSRLS). It had a Supabase-shaped `auth` schema (`auth.uid()` reading `request.jwt.claims`), `anon`, `authenticated`, a BYPASSRLS `service_role`, and an `authenticator` LOGIN NOINHERIT role that is a member of all three. Every door call was made as PostgREST makes it: logged in as `authenticator`, `set_config('role', 'service_role', true)` and the service key's claims, then the RPC. Two privilege layouts were run: H1, where `postgres` holds a grant option on `auth`, and H2, where it does not (Postgres then only warns).
  - The paste applied in both, and again idempotently. All 14 probes were `t` in H1. In H2 only "row-level security for a NEW document" was `f`.
  - A probe trigger recorded who wrote each row. H1: the new document and the quote were inserted **as `intake_door`**, `sub` the link and role claim `intake_door`. The submissions (own and assigned documents) were written under the service key with the bound identity. The pointer moved 1 row. After every call the session was back to `service_role` with the service claims. H2: the new document fell back to the bound identity under the service key, and the quote still ran as `intake_door`. Inserting a document as `intake_door` in H2 fails with "permission denied for schema auth", which is why the readiness check exists.
  - Unchanged answers: the scope refusals (42501 `scope`), the revoked link (28000 `revoked`) and a duplicate key raised inside the door as `intake_door` (23505).
  - The policies as the boundary, tested as `intake_door` directly with forged bindings. The control insert was admitted. Refused by policy: another library and folder; status Issued; no author (which the rails would allow); **no identity bound at all** (`auth.uid()` NULL, which every trigger guard exempts); the revoked link's own author stamp (the link row is re-read); the claims of the door under the `authenticated` role; a quote with a vendor name the caller chose; a quote on another project; a quote from a documents link. `intake_door` may not SELECT or UPDATE `documents` or DELETE from `cost_documents`. A member may not execute the predicates, the door functions or `intake_door_rls_ready`. A DocCtrl's own document INSERT is still admitted.
  - The editor path: called from the SQL editor (session user `postgres`, which holds only ADMIN on the role in PG16, not SET), `intake_door_rls_ready` answers false and the write keeps the bound identity. The editor is never left as `intake_door`. With `authenticator`'s membership revoked, the quote fell back to the bound identity, and a re-paste restored the membership.
  - The allow-listed promote, above.
  - Two differences between the repository's base schema and the live table, mirrored on the run and not changed by this package: `documents.created_by_name` (which the intake route has always written) is not in `schema.sql`, and `schema.sql` declares `document_versions.created_by` NOT NULL, which the route's submissions (no `created_by`) and `20261037`'s "authorless" inventory show the live table does not enforce. The role's grant of `documents.created_by_name` is therefore made only where the column exists.
- **Scratch PostgreSQL 16 run, review fix pass 3** (the same whole-sequence cluster, fresh copies, the revised file pasted as the non-superuser `postgres` and again idempotently; door calls made as PostgREST makes them).
  - H1 (a grant option on `auth`): all 15 probes `t`. The new document and the quote were inserted as `intake_door`; the submission and the pointer as before; the scope refusals (42501 `scope`), the revoked link (28000 `revoked`) and a duplicate key raised inside the door (23505) unchanged; the policies still refused every forged write of review fix pass 2's list and admitted the controls. H2 (none): only the "row-level security for a NEW document" row `f`, `intake_door_rls_gaps('authenticator', true)` = `{"auth usage"}` and the quote's `{}`; Postgres warned "no privileges were granted" for `auth` and for `uid`.
  - **F1, the reviewer's scenario.** A DRLS-16-style `REVOKE EXECUTE … FROM PUBLIC` on `is_org_controller`, `my_org_ids`, `user_owns_project` and `acl_index_denies`: both inserts still ran as `intake_door`, because the role holds them by name. With `is_org_controller` then revoked from `intake_door` too, both `rls_gaps` answered `{"execute is_org_controller(uuid)"}`, readiness was false, and both rows were written with the bound identity under the service key. Nothing was refused. Before this fix, the same revoke made every new document answer 409 "not fully configured" and every quote 403.
  - **F2, a privilege the check does not read.** With DELETE on `document_assets` revoked from `intake_door` (the AFTER rail `documents_resync_assets` deletes as the writer), the INSERT as `intake_door` failed "permission denied for table document_assets"; the door function logged `WARNING: intake_door_create_document: permission denied for table document_assets — this new document is written with the bound identity alone …` and wrote the document with the bound identity. The same with the column INSERT of `file_hash` on `cost_documents` revoked: "permission denied for table cost_documents", WARNING, the quote written. After each call the session was back to `service_role` with the service claims.
  - **F3, the door's own policy refuses.** With the restrictive door policy forced to `false`, the create raised `new row violates row-level security policy "documents_intake_door_scope" for table "documents"` (42501) and wrote nothing: no fallback. (Still so after review fix pass 5, H7 below: the door's own policies are the boundary.)
  - **F4, the probe and the door agree** (review fix pass 3, minor). With `authenticator` granted `intake_door` WITH SET FALSE, `pg_has_role('authenticator', 'intake_door', 'MEMBER')` (the first version's probe) read true, the new probe row read false, and the quote kept the bound identity.
  - F5: with every privilege restored, both inserts ran as `intake_door` again.
- **Scratch PostgreSQL 16 run, review fix pass 4** (the same whole-sequence cluster; a fresh copy with a grant option on `auth`; the revised file pasted as the non-superuser `postgres`, then again idempotently: all 16 probes `t` both times; door calls as PostgREST makes them).
  - G1: the fourth row `t`; the new document and the quote inserted as `intake_door`.
  - **G2, the reviewer's scenario.** `CREATE POLICY cost_documents_member_insert ON cost_documents AS RESTRICTIVE FOR INSERT WITH CHECK (org_id IN (SELECT my_org_ids()))`. Both `intake_door_rls_gaps` answered `{}`, so the first three rows still read `t`; the fourth read `f`; the quote was refused, `new row violates row-level security policy "cost_documents_member_insert" for table "cost_documents"`, and no row was written. (That was fix pass 4's file; review fix pass 5 files the same quote with the bound identity, H2 below.)
  - G3, drift in the upload guard: `documents_deny_upload_guard` re-written with an added `org_id IN (SELECT my_org_ids())` limb. The fourth row read `f` (its `pg_depend` now names `my_org_ids`); the door's new document was refused by that policy; a DocCtrl's own document insert was still admitted. (Review fix pass 5: filed with the bound identity, H3 below.)
  - G4: the same membership policy written `TO authenticated`: the fourth row `t`; the quote filed as `intake_door`.
  - G5: one with a limb for the role (`current_user = 'intake_door' OR …`): the quote was filed, and the fourth row read `f` — it reads no intent, so such a policy is a false alarm to confirm from its text (the shape test accepts the stated limb).
  - G6: a restrictive policy for every role FOR UPDATE: the fourth row `t`.
  - G7: restored: the fourth row `t`; both inserts as `intake_door`. In all, 2 documents and 4 quotes written, every one as `intake_door`.
- **Scratch PostgreSQL 16 run, review fix pass 5** (the same whole-sequence cluster; a fresh copy `door_f5` with a grant option on `auth`; the revised file pasted as the non-superuser `postgres`, then again idempotently: all 16 probes `t` both times; door calls as PostgREST makes them, login `authenticator`, role `service_role`; script `j16fix5-pg/f5.sh` in the scratchpad). A trigger recorded the role and `sub` of each write.
  - H1, the repository's sequence: both `intake_door_rls_gaps` `{}`, the fourth row `t`; the new document and the quote inserted as `intake_door`, `sub` the link; the session back to `service_role` after each call.
  - **H2, the reviewer's G2** (`cost_documents_member_insert`, RESTRICTIVE FOR INSERT for every role, `org_id IN (SELECT my_org_ids())`): the quote's gaps `{"policy cost_documents_member_insert"}`, the fourth row `f`, the third `t`; the quote **filed**, written as `service_role` with `sub` the link and claim role `intake_door` (the bound identity); the new document, on the other table, still as `intake_door`.
  - **H3, the reviewer's G3** (the upload guard with a membership limb): the document's gaps `{"policy documents_deny_upload_guard"}`, the fourth row `f`; the new document **filed** with the bound identity; a DocCtrl's own insert still admitted; the quote still as `intake_door`.
  - H4: the same membership policy `TO authenticated`: no gap, the quote as `intake_door`.
  - H5: a RESTRICTIVE FOR ALL policy `TO intake_door` with `false`: the gap `{"policy documents_door_all"}`, the new document filed with the bound identity.
  - **H6, a refusal the check cannot see**: a role `scratch_x` granted to `intake_door` WITH INHERIT TRUE and a RESTRICTIVE FOR INSERT policy `TO scratch_x` with `false` on `cost_documents`. No gap (the policy names neither PUBLIC nor `intake_door`), so the quote switched, was refused by that named policy, and the handler logged `WARNING: intake_door_file_quote: new row violates row-level security policy "cost_documents_x" for table "cost_documents" — this quote is written with the bound identity alone …` and filed it with the bound identity.
  - **H7, the door's own policies still refuse**: `documents_intake_door_scope` forced to `false` raised `new row violates row-level security policy "documents_intake_door_scope" for table "documents"`; `cost_documents_intake_door_insert` forced to `false` raised the unnamed `new row violates row-level security policy for table "cost_documents"`. Neither fell back, and no row was written.
  - H8: DELETE on `document_assets` revoked from `intake_door`: the "permission denied" fallback with its WARNING, as in fix pass 3's F2.
  - H9, restored: no gap; both inserts as `intake_door`. In all, 6 documents and 6 quotes were filed and none refused, except the two forced refusals of the door's own policies in H7.
- **Scratch PostgreSQL 16 run, integrator fix pass (the readiness function alone).** A throwaway cluster (`initdb` under `/var/lib/postgresql/j16fix6`, stopped and deleted afterwards; script `j16fix6-pg/r.sh` in the scratchpad) carrying a stub of what the two functions read: `auth.uid()`, `libraries`, `documents`, `cost_documents`, `my_org_ids`, `is_org_controller`, `acl_index_denies`, `user_owns_project`; the roles `authenticator` (LOGIN NOINHERIT, a member of `intake_door` and `service_role`) and `intake_door` with the file's grants; and the repository-shaped policies (`documents_org_access`, `documents_deny_upload_guard` as `20260901` writes it, `cost_documents_write` / `cost_documents_owner_write` `TO authenticated`, the door's permissive and restrictive pair `TO intake_door` on each table, predicates stubbed: the function reads names, roles, commands and `pg_depend`). `intake_door_rls_gaps` and `intake_door_rls_ready` were loaded **verbatim** from `20261184` (the text between each `CREATE` and its `COMMENT ON`), and `intake_door_rls_ready` was asked as the door functions ask it: logged in as `authenticator`, `SET ROLE service_role`. Nothing else of the file ran here (no door INSERT, no paste: the whole-sequence runs above cover those). Gaps are given document / quote.
  - R0, the repository's shape: `{}` / `{}`; ready `true` / `true`.
  - R1, the reviewer's G2 (`cost_documents_member_insert`, RESTRICTIVE FOR INSERT for every role, `org_id IN (SELECT my_org_ids())`): `{}` / `{"policy cost_documents_member_insert"}`; ready `true` / `false`.
  - R2, the reviewer's G3 (`documents_deny_upload_guard` re-written with a membership limb, so `pg_depend` names `my_org_ids`): `{"policy documents_deny_upload_guard"}` / `{}`; ready `false` / `true`.
  - R3, RESTRICTIVE FOR ALL `TO public` on `documents`: `{"policy documents_all_public"}` / `{}`; ready `false` / `true`. R4, RESTRICTIVE FOR INSERT `TO authenticated, intake_door`: `{"policy documents_door_named"}` / `{}`; ready `false` / `true`.
  - R5, the membership policy `TO authenticated` only: no gap, ready both. R6, a PERMISSIVE FOR INSERT policy for every role, and RESTRICTIVE FOR UPDATE, DELETE and SELECT ones: no gap, ready both.
  - R7, a RESTRICTIVE FOR INSERT policy `TO scratch_x`, a role `intake_door` inherits: no gap, ready both — what the check cannot see; after the switch the handler's named-policy fallback (H6 above) files that write with the bound identity.
  - R8, `documents_intake_door_scope` re-created `TO intake_door, public` (no longer `TO intake_door` alone): `{"policy documents_intake_door_scope"}` / `{}`; ready `false` / `true`.
  - R9, `intake_door` revoked from `authenticator`, with R1's policy live: `{switch}` / `{switch,"policy cost_documents_member_insert"}`; ready `false` / `false`. R10, restored: as R0.
- Pending migration: `supabase/migrations/20261184_prj_roundG_intake_door_identity.sql`, pasted after 20261141. No deploy order is required. Never re-paste 20261141 after it.

*Owed item 2: `UNTRUSTED_CONTENT_ORIGIN`. The code half and the operator step are written; the export's issuer uses it; the two everyday issuers' adoption is pending, owned by another package.*
- **`lib/untrustedContent.ts`**: `isDoorUploadKey`; `untrustedContentOrigin()` validates the setting and accepts **only** storage's account endpoint that `lib/r2.ts` is configured with, `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` built from the same `R2_ACCOUNT_ID` (review fix pass: the first version accepted any other https host, so a typo, a wrong account ID or a custom domain would have been signed for and every door-upload download would have broken). It refuses, and logs once, non-https, a path, a port, credentials, the app's own host or a host under it, the host controlled documents are already served from, any other host, and any value when `R2_ACCOUNT_ID` is unset; `signStorageGet(command, { expiresIn })` signs a door upload's presigned GET **path-style against `UNTRUSTED_CONTENT_ORIGIN`**, and signs everything else as before. Storage serves a bucket at two signed addresses: `https://<bucket>.<account>.r2.cloudflarestorage.com`, the one `lib/r2.ts` signs today, and `https://<account>.r2.cloudflarestorage.com/<bucket>/…`. Both are storage's own hosts with no app cookie, page or script, but they are different origins, so the setting separates door uploads from the origin the controlled drawings are fetched from. A custom domain cannot be used, because storage refuses presigned requests on one. Tests: `lib/__tests__/untrustedContent.test.ts` uses the real AWS presigner, offline.
- **Operator step**: `docs/UNTRUSTED_CONTENT_ORIGIN.md`, written for a non-technical owner. It covers the exact value (`https://<your R2 account ID>.r2.cloudflarestorage.com`), where to find the account ID, where to set the value (Vercel Settings → Environment Variables, or `.env`), Redeploy, how to check it worked, and how to undo it. Its check step (review fix pass 3) uses what signs for the setting today: Admin → Data export → **Download JSON**, search for `project-intake/`, and its `"presignedUrl"` starts with the account host; it says the Intake tab's own links do not change until the hand-off below lands, so an unchanged Intake-tab link is not read as a broken setting. `lib/__tests__/untrustedContent.test.ts` pins that wording, the button and the export's call. `.env.example` lists the variable, blank.
  - **Cross-origin fetches** (review fix pass 4). The doc no longer says "nothing else changes". The browser-built Full ZIP (`lib/clientBackup.ts:228`) `fetch()`es each manifest URL cross-origin, so with the setting on, the door uploads in it come from the path-style account host, and nothing here verifies that storage answers the app origin's GET there with `Access-Control-Allow-Origin` (`untrustedContent.test.ts` signs offline). The check step therefore ends with step 5: run **Download Full ZIP** and confirm that `backup-report.json` lists no `project-intake/` or `project-costs/…/quote-` file under `errors`; if it does, undo the setting and report it. **CORS on the path-style host is an operator check, not done here** (it needs the live storage). The integrator can make the same check by hand: `curl -s -D - -o /dev/null -H "Origin: <app origin>" "<a door upload's presignedUrl from the export JSON>"` must answer with `Access-Control-Allow-Origin` for the app origin. The test pins the step, the button label, the report's name and the `files/` folder, and the fetch it describes.
  - **The in-app viewer** (review fix pass 5). The doc still said people open contractor files "as before", that "only the address in the browser's download bar is different", that setting the value early was harmless ("nothing breaks"), and that the everyday download links did not depend on step 5. Once the hand-off below lands, that is not so: the in-app viewer `fetch()`es the signed URL itself (`components/viewers/SecureDocViewer.tsx:170`), its full-screen view hands it to react-pdf, which fetches it too (`components/viewers/FullScreenViewer.tsx:1518`), and the marked-up download fetches the bytes (`FullScreenViewer.tsx:318`), all cross-origin from the path-style account host. Without `Access-Control-Allow-Origin` there for the app origin, a contractor drawing opened from the intake review may not display. The doc now names the viewer next to the Full ZIP, makes step 5 **required** before the setting is left in place (and again after the hand-off is deployed), drops the overstatements, and adds a check after the switch-over: open one contractor drawing from the **Intake** tab in the viewer and its full-screen view, and undo the setting if it does not display. `untrustedContent.test.ts` pins the new wording and the three fetch sites it describes.
- **The issuers.** The census of presigned-GET issuers (`lib/__tests__/presignedDisposition.test.ts`, which now counts a `signStorageGet` caller as an issuer) has three that sign door uploads. `lib/dataExport.ts` (the workspace export's per-file URLs, which an Admin opens in a browser) calls `signStorageGet` (review fix pass; `lib/__tests__/sec18ResolveExportDisposition.test.ts` signs a door drawing, redline and quote for the untrusted origin and a controlled drawing on the bucket host). The other two, the everyday ones, are `app/api/storage/download-url/route.ts` and `app/api/storage/resolve/route.ts`. Both belong to admin-and-org P6 in this wave, so J16 did not edit them. **Owner: the integrator at the J16 / P6 merge** (review fix pass 3: one owner; P6's brief does not carry it). The exact change, against base `2de62f1`:
  - `app/api/storage/download-url/route.ts` (`r2` is used only by the presign here, so its import goes too):
    ```diff
    -import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
    -import { r2, R2_BUCKET } from "@/lib/r2";
    +import { R2_BUCKET } from "@/lib/r2";
    +import { signStorageGet } from "@/lib/untrustedContent";
    @@ :213
    -  const url = await getSignedUrl(r2, command, { expiresIn: lifetime.seconds });
    +  const url = await signStorageGet(command, { expiresIn: lifetime.seconds });
    ```
  - `app/api/storage/resolve/route.ts` (`r2` stays: the archive HEAD at `:84` uses it):
    ```diff
    -import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
    +import { signStorageGet } from "@/lib/untrustedContent";
    @@ :92
    -    const url = await getSignedUrl(
    -      r2,
    -      new GetObjectCommand({ Bucket: R2_BUCKET, Key: path, ...disposition.overrides }),
    +    const url = await signStorageGet(
    +      new GetObjectCommand({ Bucket: R2_BUCKET, Key: path, ...disposition.overrides }),
    ```
  - **Done when:** `lib/__tests__/presignedDisposition.test.ts`'s census counts both files as `signStorageGet` callers, and its `.fails` case "download-url and resolve sign through signStorageGet, like the export" (an expected failure today, added by review fix pass 3) passes and has its `.fails` removed; the presignedDisposition and `sec18ResolveExportDisposition` suites pass; `docs/UNTRUSTED_CONTENT_ORIGIN.md`'s "When to do it" and "How to check it worked" sections are switched from the export to an Intake-tab download (its test then asks for that). Until then the setting changes only the export's URLs, the operator note says so, and its check step uses the export's JSON (review fix pass 3: the first version told the operator to check an Intake-tab download, whose link could not change yet). Review fix pass 4: a `.fails` case also "fails as expected" when a file it reads is gone, so a move or rename of either issuer could have made the owed adoption vanish silently. A plain case now fails when either file is moved, renamed or split (each must exist and sign exactly one presigned GET, `getSignedUrl(` or `signStorageGet(` with `new GetObjectCommand(`), and the `.fails` case returns early when a file is missing, so it passes and vitest reports it red. A run with `resolve/route.ts` renamed turned both cases (and the census) red. Also done when (review fix pass 5): with `UNTRUSTED_CONTENT_ORIGIN` set on a deployment carrying the change, a contractor PDF opened from the **Intake** tab in the in-app viewer (`SecureDocViewer`), and in its full-screen view, renders; and `curl -s -D - -o /dev/null -H "Origin: <app origin>" "<a door upload URL signed by /api/storage/download-url>"` answers with `Access-Control-Allow-Origin` for the app origin. If either fails, the setting is undone and the result recorded here before the hand-off is called done.

**Done-when (GAP-401's acceptance, as written).**
1. ◐ *An uploaded HTML/SVG/JS file cannot execute on the app's origin.* It holds as recorded: `SEC-6`'s sniff refuses it before storage, `DEC-49` / `SEC-18` sign every presigned GET as an attachment unless a viewer asks and the type cannot be a page, and `SEC-1`'s egress half refuses to frame one. Today those URLs are already on storage's host, not the app's. The separate-origin layer is built in code and the export's URLs use it, but download-url and resolve do not call it yet (owner above), and it needs the operator step, whose Full ZIP check (CORS on the path-style host) can only be made against the live storage; once the hand-off lands, the in-app viewer depends on the same CORS answer (review fix pass 5), and the hand-off's done-when checks it.
2. ◐ *Every DB-level document-control guard applies to content entering by this door.* Once 20261184 is pasted, every content write (new document, submission, pending pointer, trusted promote, quote) runs as an identity the trigger guards judge, and the redline goes through the ticket rails' own append for a ticket that names the link. The new document and the quote are also judged by **row-level security**, as the role `intake_door` under policies keyed on the bound link and under every policy written for all roles (review fix pass 2). This assumes the paste's first three row-level-security probe rows read true; if one reads false, that limb keeps the bound identity alone, and a single write that meets a privilege the readiness check could not see keeps it too, with a WARNING (review fix pass 3). Either way the upload is filed, never refused for it. A restrictive policy written for all roles that the link's identity may fail is a gap of the same kind (review fix pass 5, correcting fix pass 4, which let it refuse the upload with a 500): `intake_door_rls_gaps` finds it before the switch, that write keeps the bound identity and is filed, and the paste's fourth row and a shape test report it. On the repository's sequence there is none. Only the door's own policies refuse after the switch. Not under row-level security: the submission (42P17 on the repository's sequence, a pre-existing defect of `20261037`'s policy that refuses members too), the pending pointer (`documents_acl_select` hides the row from a non-member), the promote and the redline (each for the reason above). Nor are the door's housekeeping writes on its own rows: retiring a displaced submission, withdrawing a lost race, restoring, discarding a just-created document, the intake folder, and the project reference. Those remainders are projects-tab `SEC-22` (opened). Before the paste nothing changes.
   *Judged is not admitted (review fix pass).* The guards may refuse some promotes the route admits, and those demote to review with the route's sentence. Three are known: a document-level review override (`DEC-71`: the route's rail 4 reads `review_control_mode_for(doc.review_control, …)`, so a document-level `none` wins there, while the publish guard's REV-18 issue limb also reads the folder / library chain whenever the promote moves a Draft / In Review document into Issued, and refuses an unreviewed one); a race with a new hold; and authority revoked mid-request. The before-and-after route tests emulate the door functions without the trigger guards, so they pin the route's handling of each answer, not guard admission; guard admission rests on the limb-by-limb reading and the scratch PostgreSQL 16 run. Also, `intake_door_promote` stamps `intake_link_id` on the promoted version after `publish_revision`'s documents UPDATE, so the guard's SEC-13 / SEC-14 "external submission" limbs do not fire for the door's promote: it is judged as the creator's ordinary revision, where RG-7 (require mode, a version not Minor / Correction — the door's carries no change type) and DCK-1 (`publish_revision`'s drawing-class MOC gate) cover the same cases.
3. ✓ Tokens expire, can be revoked, and revocation takes effect immediately (J1, `SEC-19`). After the paste it also takes effect inside the door, mid-request (28000 `revoked` → 410).
4. ✓ Rate limits are enforced server-side and fail open (J1, `intake_attempts`). Unchanged.

**Scope / residual.** Four remainders are left. (a) `SEC-22` (owner: projects-tab, next round; no operator step) covers three things. First, the door's remaining content writes under row-level security: the submission, once roles-and-permissions settles `SEC-23` (`20261037`'s 42P17: on the repository's sequence **no** role subject to RLS can insert a `document_versions` row, members included; opened by review fix pass 3 with its reproduction and a live verification step), and the pointer, which needs a read policy for the link's own rows. Second, the door's housekeeping writes under the door identity. Third, a rail on the owner-writable intake pointers that the door's library scope reads. (b) The adoption of `signStorageGet` by download-url and resolve (owner: the integrator at the J16 / P6 merge; the diff and its done-when above; the export already uses it). (c) The operator's `UNTRUSTED_CONTENT_ORIGIN` step, which can be taken any time and checked on the export today, including the Full ZIP's cross-origin fetch from the account host (an operator check: CORS there is not verified by this package); the Intake tab's links follow once (b) is deployed, and from then the in-app viewer fetches the same way, so step 5 is required before the setting is left on and the viewer is checked after (b) (review fix pass 5). (d) `SEC-23` (roles-and-permissions). The 20261184 paste result's four row-level security rows should be sent back: if one of the first three reads false, that limb keeps the bound identity, and SEC-22 records which; if the fourth reads false, a restrictive policy for all roles that the link may fail is live, and the door's writes on that table keep the bound identity, filed as before, until it is given a TO clause or a limb for `intake_door` (SEC-22; review fix pass 5: fix pass 4 answered those uploads 500). Regression: the multipart upload and the direct two-step finalize, the redline branch, the portal (its register reads the same rows) and the intake review (the same version rows) answer as before, both before and after the paste. The **trusted promote** is the exception: after the paste it is judged by the publish guard and the register rail **as the creator**, so the cases listed under "Judged is not admitted" above (a document-level review override, a race with a new hold, authority revoked mid-request), and a creator without DRLS-3 register authority (the register rail, `20261131`), go to review instead of publishing. That is a deliberate change (`DEC-56` item 2). Its route tests emulate the door without the trigger guards, so they pin the route's handling of each answer, not guard admission.

---

<a id="gap-402"></a>
## GAP-402 · A write that cannot silently fail

**Verdict: BUILD_NARROW** · Effort: **S** · Sources: `SAF-3`, `UX-1`, and the same class in three other areas

### The pattern, found four times across five audits

- `SAF-3` — **a write denied by row-level security reports success and writes an
  audit row claiming it happened.**
- `UX-1` — **five of the wizard's six writes fail silently, and four fields are
  lost permanently.**
- `PERS-7` / `EVID-6` (drafting-flow) — `logAuditAction` cannot detect a failed
  audit write.
- Six client-side ticket writes never check the returned error.

One root: **`supabase-js` resolves with `{ error }` rather than throwing**, so an
unchecked call reads as success.

### Scope

**In:** one checked-write helper that every mutation path uses, which surfaces the
error, and a lint rule or test that fails when a raw `.insert`/`.update`/`.delete`
result is discarded.

**Out:** rewriting every call site by hand in one change (`DEC-31`). Ship the
helper and the guard, convert the safety-critical paths, and open a finding for
the remainder.

### Do not

- **Do not write the audit row before the write it describes succeeds.** `SAF-3`
  is worse than a lost write: it is a **false record**.
- **Do not catch and toast.** A lost safety write needs to block, not to inform.

### Acceptance

1. An RLS-denied write surfaces as a failure everywhere, and writes no audit row.
2. A test forces a denial on a PSSR/closeout path and asserts nothing is recorded.
3. A raw discarded write result fails the build or the lint step.

**Resolution (2026-10-01, projects Round G).** **Status: BUILT (narrow, as scoped).** The helper and the safety-critical conversions landed with projects Round G J2 QUALITY and J3 MONEY-LEDGER (`lib/checkedWrite.ts`; `lib/checklists.ts`, `lib/turnover.ts`, `lib/costs.ts`, `lib/costDocs.ts`, `lib/changeOrders.ts`). Package projects-joint J12 SERVER REMAINDERS did the two things Scope still asked for: it **opened the finding for the remainder** — projects-tab [`SAF-18`](./02-safety-compliance.md) — and **widened the census** that fails the build on a raw discarded write (`lib/__tests__/checkedWrite.test.ts` "census, widened — every lib file and the Projects surface"): every `lib/**` file and the Projects surface (`components/projects/**`, `app/api/projects/**`, `app/api/intake/**`, `app/(protected)/projects/**`) is scanned with the census's own `writeSites`; the 18 lib files and two Projects files with no unchecked `.update(` / `.delete(` must stay clean; the 48 lib files and six Projects files still carrying unchecked sites are on a ratchet that may only fall (158 sites in `lib`, 19 on the Projects surface, measured at `2af813b` + J12); and any file not named — new code — must be clean.
- Commits: `e605b0b`, `8a26824` (review fix pass: the in-flight files set aside).

**Done-when.**
1. ✓ An RLS-denied write surfaces as a failure and writes no audit row on the converted paths (J2 / J3, `SAF-3`).
2. ✓ A test forces a denial on a PSSR / closeout path and asserts nothing is recorded — `lib/__tests__/checklists.test.ts` "a refused write (RLS zero rows) reports an error and writes no audit row (SAF-3)", `turnover.test.ts`'s refusals.
3. ✓ A raw discarded write result fails the build — in the quality and money files (zero), in every clean file, in every NEW file under `lib/` and the Projects surface, and as a rise anywhere on the ratchet.

**Scope / residual.** The remaining 177 unchecked sites are `SAF-18`'s, converted file by file by their owners (DEC-31). Files that packages running beside this one are editing are set aside (`IN_FLIGHT` in the census, review fix pass): `components/projects/IntakePanel.tsx` and `components/projects/cost/QuotesPanel.tsx` (projects-joint J10b), `lib/acknowledgments.ts`, `lib/retention.ts`, `lib/revisions.ts` and `lib/reviewControl.ts` (document-control P14), `lib/holds.ts` and `lib/transmittals.ts` (document-control P15) and `lib/processFlows.ts` (intelligence I-09) — their counts stay measured in the lists, and the census does not judge them until their package merges. Merge note for the integrator and those owners: when a package above merges, remove its files from `IN_FLIGHT` (re-measuring a count the package changed); a NEW `lib` or Projects file any package adds must still carry no raw `.update(` / `.delete(` — that one cannot be set aside in advance; a file that is converted should have its number lowered in the same change.

---

<a id="gap-403"></a>
## GAP-403 · Stable row identity for schedule re-import

**Verdict: BUILD** · Effort: **M** · Sources: `SCH-2`, `SCH-3`, `SCH-1`, `SCH-6`

### The need

`SCH-3` — **CSV re-import matches rows by position**, so inserting one row
scrambles every row after it. `SCH-2` — re-importing the weekly schedule **wipes
progress the crew logged in the app**.

A weekly re-import is the normal case, not an edge case. Positional matching means
the normal case corrupts data.

### Scope

**In:** a stable external identity per task (the source system's id where one
exists, otherwise a deterministic key), a merge that distinguishes
*added / removed / changed / unchanged*, and preservation of app-side state —
progress, notes, attachments — across import.

Plus `SCH-1`: date parsing must not silently rewrite day/month as month/day. The
comment claims a guard the code lacks; make the code true or the comment go.

**Out:** a full two-way sync.

### Do not

- **Do not auto-apply the merge.** Show the diff. A re-import that silently
  deletes tasks is the same class of harm as `SCH-2`.
- **Do not infer identity from the task name.** Names get edited.
- **Do not treat "row missing from the new file" as "task deleted."** It may be a
  filtered export.

### Acceptance

1. Inserting a row at the top of the source file leaves every other row's identity
   and progress intact. A test pins exactly this.
2. Re-import presents a reviewable diff before writing.
3. An ambiguous date is rejected with a named column, never guessed.

**Partial (2026-10-01, projects Round G — record reconcile, J13).** Built by projects Round G package J6a SCHEDULE-IMPORT (merge `e48ab68`; `SCH-1`, `SCH-2` and `SCH-3` RESOLVED) and verified against HEAD `4dd0df7`. Acceptance 3 holds only in part, so this spec is not marked built.
1. ✓ Inserting a row at the top of the source file leaves every other row's identity and progress intact, and a test pins exactly this. A keyless row is keyed on its content, never its position (`lib/scheduleParsers.ts`, PT `SCH-3`). `lib/milestones.ts` `importMilestonesFromParsed` keeps progress recorded in the app. Tests: `scheduleImportWriters.test.ts` "SCH-3 · a row inserted at the top leaves every other row's identity AND progress intact (GAP-403 acceptance 1)" (:322), exit 0 (64 passed); `scheduleParsers.test.ts` "SCH-3 · row identity is content, not position" (:520), exit 0 (52 passed).
2. ✓ Re-import presents a reviewable diff before writing. A dry run builds the `ImportPlan` (added, changed, unchanged, not in the file, progress at risk), and `components/projects/ScheduleImportModal.tsx` shows a "Review changes" step before "Import N changes". An import never deletes. Tests: `scheduleImportModalReview.test.ts` (:91, :144), exit 0 (5 passed).
3. Partly. **Never guessed — ✓.** A file whose slash dates could be read in either order withholds every row (`lib/scheduleParsers.ts:341-349`: `needsDateConvention`, `rows: []`) until the user picks day/month or month/day on a radio with no default (`ScheduleImportModal.tsx:461-470`). A date that is impossible under the chosen order skips its row, and the skip is counted (`scheduleParsers.ts:1203`). Test: `scheduleParsers.test.ts` "SCH-1 · day/month is decided once from the whole file, never per row" (:210). **"With a named column" — not met.** The prompt names a sample value ("Every slash date (e.g. 06/01/2026) …", `scheduleParsers.ts:342-344` and the modal at :464). The skip warning says "a start or finish date could not be read" (:1203). Neither message names the header of the column the date came from. Owed: carry the start / finish column's header into both messages, or rule that the file-level prompt meets this criterion.

On the "Do not infer identity from the task name" rule: a keyless row's content key includes its name, and legacy position rows are adopted once by a name that is unique on both sides (PT `SCH-3`, which records the duplication residual). This spec's Scope allows a deterministic key where the source has no id; a file with a real id column is keyed on that column.

**Status: BUILT (2026-10-01, projects Round G — J10b UI REMAINDERS completed acceptance 3).**

**Resolution (2026-10-01, projects Round G).** The date question and the skip warning now name the column, spelled as the file spells its header.
- `lib/scheduleParsers.ts`:
  - `ParseResult.dateSource` (`{ columns, samples, conflict }`) records the start / finish columns the slash dates came from. It also records each sample shown with the column it came from (`samples[].column`) and the only order it can be read in (`samples[].reads`: `dmy` or `mdy` for a contradicting file's two sides, null for a sample that reads either way). *Review fix:* the first pass carried a single `sampleColumn`, which the modal applied to both sides of a contradiction.
  - The ambiguity warning reads `Every slash date in the "Start Date" and "Due Date" columns (e.g. 05/08/2026 in "Start Date") reads as either day/month or month/day. Choose how to read dates before importing — the choice applies to every row.`
  - A file that contradicts itself names the column of each side: `(15/08/2026 in "Finish" vs 08/15/2026 in "Start")`.
  - A row skipped under the chosen order is counted per column: `2 rows skipped (a start or finish date could not be read as month/day/year) — in "Finish" (1 row), "Start" (1 row).`
- `components/projects/ScheduleImportModal.tsx`: the date question names the same columns and the sample's column. A contradicting file gets its own sentence, which names each side with its own column: `This file contradicts itself about date order: 15/08/2026 in "Finish" can only be day/month, but 08/15/2026 in "Start" can only be month/day. Nothing is imported until you choose; the choice applies to the whole file, and a row whose dates cannot be read that way is skipped.` The first pass rendered `(e.g. 15/08/2026 vs 08/15/2026 in "Finish")`, which named the wrong column for 08/15/2026.
- The never-guessed half is unchanged. Rows are withheld until the order is chosen, on a radio with no default. XML and XER carry ISO dates and never reach the question.
- Tests: `lib/__tests__/j10bScheduleDateColumns.test.ts` (7):
  - the question naming two columns and the sample's column;
  - a single column;
  - the contradiction, in the warning and in `dateSource` (each side with its own column and order);
  - the per-column skip count under both orders;
  - XML, with no date source;
  - rendered: the import modal's question names the columns;
  - rendered: a contradicting CSV (Start `08/15/2026`, Finish `15/08/2026`) names each value with its own column, never both with one.

  The skip-message pin in `lib/__tests__/scheduleParsers.test.ts` now carries the column.

**Acceptance.**
1. ✓ Unchanged (J6a).
2. ✓ Unchanged (J6a).
3. ✓ An ambiguous date is rejected with a named column, never guessed.

**Scope / residual.** None for this spec. The existing `dates` record is unchanged; `dateSource` is additive.

---

<a id="gap-404"></a>
## GAP-404 · Evidence that actually evidences

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-402` · Sources: `SAF-1`, `SAF-2`

### The need

`SAF-1` — **a contractor's self-typed filename can turn a PSSR item green.**
`SAF-2` — **the AI can mark thirty of forty PSSR items not-applicable behind one
count-only confirmation.**

This is a pre-startup safety review in a PSM plant. A green item has to mean
something a person is willing to sign.

### Scope

**In:** an evidence contract per checklist item — what kind of artifact satisfies
it, and what the system verified about that artifact (it exists, it is attached to
this project, it is of the declared type). A filename is a label, not evidence.

And for bulk AI action: **per-item review, not a count.** A confirmation that says
"30 items" without naming them is not consent.

**Out:** removing AI assistance. Proposing is fine. Asserting is not.

### Do not

- **Do not accept a name as proof of a thing.** `SAF-1` in one sentence.
- **Do not let a bulk confirmation cover items the user has not seen.** If thirty
  items are being changed, thirty items get shown.
- **Do not render an AI-marked item identically to a human-verified one** — the
  same discipline `GAP-303` sets for the intelligence layer.

### Acceptance

1. An item cannot go green on a string alone.
2. A bulk AI action requires per-item review; a test asserts a count-only path
   cannot write.
3. Every satisfied item records who or what satisfied it, and how.

**Status: BUILT (2026-10-01, projects Round G — record reconcile, J13).** Built by projects Round G package J2 QUALITY (merge `798ca2f`; `SAF-1`, `SAF-2`, `QUAL-1`, `QUAL-2`, `QUAL-6` and `QUAL-13` resolved; `DEC-52`). Verified against HEAD `4dd0df7`.
1. ✓ An item cannot go green on a string alone. The evidence register admits only documents at `Issued` or `Locked` with a current version, outside `NOT_CURRENT_STATUSES`, and, for a document that came through the intake door, only once its CURRENT version is approved (`lib/checklists.ts:125`, `:667-755`). A sweep green must carry a citation that the DATABASE resolves to one of three rows: an admitted document, an accepted turnover item or a human-completed MI checklist. That is `checklist_auto_citation_ok` (`supabase/migrations/20261091_prj_roundG_quality_rails.sql:792`), enforced by `checklist_items_decision_rail` (:820-969); these are the only definitions. A person's green needs the person's own reason (the same rail). Tests: `checklists.test.ts` "an unreviewed Draft with a matching title does NOT enter the register; …" (:476) and "an external (intake) submission counts only once its version is approved" (:490), exit 0 (39 passed); `qualityRailsMigration.test.ts` "a sweep green's citation must RESOLVE to its row …" (:511), exit 0 (40 passed).
2. ✓ A bulk AI action requires per-item review, and a test asserts a count-only path cannot write. `applyAssessment` writes only `confirmedItemIds` (`lib/checklists.ts:453-472`). `AssessmentReview` (`components/projects/QualityTab.tsx:698`) lists every proposal, unticked by default. Test: `checklists.test.ts` "a count-only call (no confirmed ids) writes NOTHING and audits nothing" (:139).
3. ✓ Every satisfied item records who or what satisfied it, and how.
   - A person's write is stamped by the database with the caller's uid and sign-in name (`20261091:936-937`: `updated_by := auth.uid()`, `quality_actor_name`), and it carries the person's reason.
   - A machine write has `updated_by` NULL and one of two sentinel names. It is bounded to that machine's own columns and carries its citation (`evidence[].source` / `documentId`) (:871-931).
   - See `DEC-52` item 6.

Inside the register the match is still a title match. `DEC-52` item 1 records it as a labelled MACHINE green that cannot be cited (a completion holding one is `'auto'`), and names the stricter "suggested until verified" form as its reversal. Binding by equipment tag (`document_assets`) is a follow-on, not built.

Pending migration: `20261091` (DEC-30). Until it is applied, the citation rail and the actor stamp are the client data layer's only. The sweep cites only rows from the admitted register (`lib/checklists.ts:667-755`), and a person's write stamps `updated_by` from the signed-in actor in the browser (`lib/checklists.ts:536-539`), so nothing in the database refuses a string-only green or a forged actor yet. Acceptance 1 and 3 are met in full only once `20261091` is applied.

---

<a id="gap-405"></a>
## GAP-405 · Gates with teeth

**Verdict: BUILD_NARROW** · Effort: **S** · Depends on: `GAP-402` · Sources: `SAF-4`

**Every route to a green closeout gate accepts a blank reason on one keypress.**

The gate exists; it just does not hold. This is the same shape as the
minor-correction bypass in the drafting flow: a control that renders and does not
constrain.

### Do not

- **Do not add a second confirmation dialog.** Two dialogs someone clicks through
  is one dialog. Require the substance — a typed reason, minimum length, the same
  bar `lib/checkinOutcomes.ts` already sets: *"no canned text, no
  get-out-of-jail-free cards."*
- **Do not make it a client-side check.**

### Acceptance

1. A blank or whitespace reason is rejected server-side on every closeout route.
2. The reason is recorded, attributed and visible on the closeout record.
3. A test enumerates every route to a green gate and asserts each rejects blank.

**Partial (2026-10-01, projects Round G — record reconcile, J13; *corrected by the integrator at the J13 merge:* this read "Status: BUILT" on a reading of acceptance 2 it did not name).** Built by projects Round G package J2 QUALITY (merge `798ca2f`; `SAF-4` resolved; `DEC-52` item 4). Verified against HEAD `4dd0df7`. Acceptances 1 and 3 hold; acceptance 2 holds for the item's own record but not for the closeout report (below) — that limb is projects-joint J12's. The routes to a green closeout gate are SAF-4's three controls (checklist N/A, turnover waive, punch void) and every other checklist decision a person makes.
1. ✓ A blank or whitespace reason is rejected server-side on every route to a green gate. The rails live in `supabase/migrations/20261091_prj_roundG_quality_rails.sql`, the only definitions:
   - `quality_reason_ok` (:308): at least 10 characters after Unicode whitespace and zero-width characters are stripped, and no canned text;
   - `turnover_items_decision_rail` (:647-700): a waive, a reject and any reopen each need their OWN new reason;
   - `punch_items_void_rail` (:702-750): a void needs a reason;
   - `checklist_items_decision_rail` (:820-969): satisfied, N/A and item reopen each need a reason.

   The lib mirrors the bar (`lib/checklistEngine.ts:138`, `:161` `reasonProblem`), and the prompt cannot settle on a blank (`appPrompt({ required, minLength })`, `components/projects/QualityTab.tsx:105`). Pending migration: `20261091` (DEC-30). Until it is applied, the client data layer's check is the only one.
2. ◐ The reason is recorded, attributed and visible on the closeout record — *read as* visible on the item's record (the Quality tab); the printed closeout report (`lib/projectReport.ts:210-235`) carries counts, not the reasons, so the spec's "closeout record" is NOT met there (owner J12). It is stored in `review_note`, `closure_note` or `manual_note`. The database stamps the reviewer, closer or actor from `auth.uid()` and `quality_actor_name`, never from the client, and appends every turnover decision to `turnover_review_events`. The Quality tab shows it on the item: `components/projects/QualityTab.tsx:809-811` (checklist), `:1156-1159` (turnover), `:1357-1374` (punch). The printed report carries counts, not the reasons.
3. ✓ Tests enumerate every route to a green gate and assert that each rejects a blank. They are split by table rather than kept in one file:
   - `checklists.test.ts` "refuses a blank, short or canned reason on N/A, satisfied and reopen — nothing written, nothing audited" (:214);
   - `turnover.test.ts` "reject and waive refuse a blank, whitespace, short or canned reason …" (:87), "only an accepted or waived item can be reopened, and only with a real reason" (:150), and "void refuses a blank or canned reason; nothing written" (:231);
   - `qualityRailsMigration.test.ts`: the turnover, punch and checklist rails (:418, :438, :449-536) and `quality_reason_ok` (:397).

   Exit 0 for each file (39, 23 and 40 passed).

Outside this spec, because it is not a route to a green gate: completing the PROJECT over red gates takes an optional reason ("Reason (optional)", `app/(protected)/projects/[id]/page.tsx:779`; `lib/projects.ts:537` records `reason || null`). The gates stay red, and their state is recorded in `PROJECT_COMPLETED` and printed (PT `SAF-14`). This area's README lists that override as sound (`README.md:189`).

**Resolution (2026-10-01, projects Round G).** **Status: BUILT.** Package projects-joint J12 SERVER REMAINDERS closed acceptance 2's report limb. `lib/projectReport.ts` gathers every decision a person made on a closeout gate — checklist items a person decided (a note on the row and a person's uid: N/A, satisfied, or another status "with a note"), turnover items waived / rejected / accepted with a review note, punch items voided or closed with a closure note — each with the reason recorded, who recorded it and when, newest first. It reads them for the WHOLE project (`gatherCheckpointDecisions`): every non-void checklist and its noted items (100 checklists per filter), every decided turnover item, and every punch item, each paged past PostgREST's 1,000-row answer up to 20,000 rows (`REPORT_ROW_CEILING`) — review fix pass: the first landing collected checklist decisions inside the ten-line progress table's loop (the first 10 non-void checklists only) and punch decisions from a 500-row read, and said nothing of what it left out. A failed decisions read prints "Could not read the decisions on the record — they are left out, not shown as none" and is named with the report's other failed reads; a read that reaches its 20,000-row limit says the list is the first part of the record; `renderReportHtml` prints them under the Quality table as "Decisions on the record — each with the reason the person who made it recorded" (item, decision, reason, by + date; at most 200 rows, saying how many there are when there are more). A machine green (the evidence sweep's) carries a citation, not a reason, and is the evidence pack's to show (`QUAL-10`). The punch read became `select *` so the closure columns print where they exist, and a database without them is not a failed read; it is now paged too, so the report's open-punch count is the whole list's.
- Commits: `87a8436`, `8a26824` (review fix pass: the whole project, paged).
- Tests: `lib/__tests__/projectReport.test.ts` "the report prints each closeout decision with its reason (GAP-405)" (person-made decisions newest first with reason and actor; a machine green and undecided rows left out; the open punch count unchanged; no decisions → no section; review fix pass: "every decision on the project, not only the first ten checklists or 500 punch items" — 14 checklists with the rulings on checklists 11–14 and 1,200 voided punch items, all gathered, the progress table still ten lines, "(the newest 200 of 1204)" printed — and "a failed decisions read is said, never printed as 'no decisions'").

**Done-when.**
1. ✓ (above).
2. ✓ The reason is recorded, attributed and visible on the closeout record — on the item (above) and now on the printed closeout report.
3. ✓ (above).

**Scope / residual.** None for this spec. The printed table shows the newest 200 decisions and says how many there are; each read stops at 20,000 rows and says so.

---

<a id="gap-406"></a>
## GAP-406 · The award as a transaction, with a repair path

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-402` · Sources: `MON-1`

**A failed award leaves the document permanently awarded with no commitment, and
nothing can repair it.**

Two capabilities: the award becomes atomic, **and** there is a way back from the
records already in that state. The second matters more — the first prevents new
damage, the second addresses damage already done.

### Do not

- **Do not build only the transaction.** Existing broken rows stay broken and
  invisible.
- **Do not repair by deleting.** An award that half-happened is a financial event;
  reversing it is an event too, with an actor and a reason.

### Acceptance

1. A failure at any step leaves no partial award.
2. A query identifies existing awarded-without-commitment documents.
3. Repair is an auditable action, not a silent correction.

**Resolution (2026-10-01, projects Round G).** **Status: BUILT.** Acceptances 2 and 3 landed with projects Round G J3 MONEY-LEDGER (`listLedgerOrphans` / `cost_ledger_orphans` names awarded-or-posted paper without its entry; `repairCostDoc` re-posts or reverts, audited — `MON-1`, `COST-11`). Package projects-joint J12 SERVER REMAINDERS made the award itself one transaction (acceptance 1): `supabase/migrations/20261157_prj_roundG_server_remainders.sql` §3 `award_quote(p_doc, p_cost_account, p_expected_total, p_override_reason, p_confirmed_total)` — SECURITY INVOKER (every read and write the caller's own, under the same RLS and money rails), a NULL `auth.uid()` refused, EXECUTE revoked from PUBLIC and anon — locks the quote and re-checks it (a quote, still draft / parsed, the budget line on the project and in the document's currency, the total the caller's guard checked, the registry — `MON-12` — and, from review fix pass 3, COST-13's confirmed figure and read extent), returning `{ok:false, code}` with nothing written; then claims it, posts the commitment (`addEntry`'s row and its `COST_ENTRY_POSTED`), records the override, declines the open rivals by RFQ key, lists the open ungrouped quotes and writes `COST_DOC_AWARDED` (`oneTransaction: true`). A failure at any step after the claim raises, and the whole award rolls back. `lib/costDocs.ts` `awardQuote` runs its guard (currency, registry, read extent) against the row as read, then calls it, and returns the same shape as before — `{ok, error?, warning?, needsOverride?}`, the `warning` built from the function's `rivals` / `declined` / `ungroupedOpen`; on 42883 / PGRST202 (the migration not applied) the client sequence runs as before (the fallback, by the brief); any other database error is reported and the client sequence does NOT run behind it. Pending migration: `20261157` (DEC-30).
- Review fix pass 3. (a) `award_quote` wrote `totalConfirmed: true` whenever `p_confirmed_total` was not NULL and never checked it, so a direct `/rpc/award_quote` call with a "confirmed" 1 on a quote the AI read 8 of 20 pages of posted, and the award's own record claimed a confirmation that did not happen — the lib's `extentRefusal` (COST-13) had not run. It now re-checks COST-13 under its lock, before the claim, as `extentRefusal` does: a confirmed figure that is not the total in whole units → `{ok:false, code:'confirm_mismatch'}`; an AI-read total from a truncated read, or of unknown extent once `20261096` records it, with no confirmed figure → `{ok:false, code:'extent'}`. `lib/costDocs.ts` maps both to `extentRefusal`'s own sentences (`confirmMismatchMessage` / `extentMessage`, shared). (b) The registry re-check is the gate, not the binding (`cost_doc_company_barred`, projects-tab `MON-12` review fix pass 3): the refusal and the override row name the flagged company the award answers for; `COST_DOC_AWARDED` records the bound company. (c) Paste order: `20261157` goes in only after the J12 code is deployed (header HOW TO APPLY) — the earlier client sequence never sets the override setting, so its reasoned overrides would be refused by the rail.
- Review fix pass 5 (projects-tab `MON-12`). (a) The gate `award_quote` re-checks no longer lets a contractor's ACTIVE company stand in for the document's own link, so a quote the intake door filed against a contractor it matched by name answers for a do-not-use look-alike under the lock too; `COST_DOC_AWARDED` records the contractor's company as the binding. (b) With two or more non-exact do-not-use look-alikes the lib's prompt (`needsOverride`, sorted by name with `localeCompare`) and `award_quote`'s `COST_DOC_AWARD_OVERRIDE` (sorted by `c.name` under the database collation) could name different companies; both now order the exact name first, then the id in byte order, so the person types a reason for the company the override row records. *Overstated (review fix pass 6):* true of the lib's prompt only — the bid tab's own prompt and intent row (`QuotesPanel.tsx`, through `lib/bidTab.ts` `barredCompanyFor` over the id-ordered `listBarredCompanies`) still took the first do-not-use look-alike by id with no exact-name preference, so with an exact-name look-alike holding the higher id the bid tab asked about one company and `award_quote` recorded the other.
- Review fix pass 6 (projects-tab `MON-12`). `barredCompanyFor` now orders do-not-use look-alikes as `cost_doc_company_barred` and `flaggedLookAlike` do — the exact name first (`lower(name) = lower(btrim(vendor))`, spaces trimmed only), then the id in byte order, whatever order its list arrives in — so the bid tab's prompt, the lib's prompt and the override row `award_quote` writes name the same company (`costDocs.test.ts` "the bid tab's override prompt names the company the lib's prompt and award_quote's override row name …"). *(Corrected at fix pass 7: true of the lib's prompt; not of the bid tab's. The panel fed `barredCompanyFor` the letterhead the AI read, while `award_quote` reads the stored `cost_documents.vendor_name`, so with the stored name "Gulf Mechanical" and the letterhead "Gulf Mechanical, Inc." the panel named "Gulf Mechanical, Inc." and `award_quote` recorded "Gulf Mechanical". Pass 6 created that disagreement — before it both named the lower id. And a contractor's flagged company, which `award_quote` names first, was never the panel's question.)*
- J12 fix pass 7 (2026-10-02) (projects-tab `MON-12`). The bid tab's award prompt and intent row now ask `award_quote`'s own gate at the click. `QuotesPanel.tsx` `companyAwardAnswersFor` calls `cost_doc_company_barred` (SECURITY INVOKER, EXECUTE granted to authenticated) with `award_quote`'s four arguments read from the row — the stored vendor name, never the letterhead — as the same caller. So they name the company `award_quote`'s `COST_DOC_AWARD_OVERRIDE` records, a contractor's flagged company and an `inactive` one included. Before `20261157` (PGRST202 / 42883, the lib's own fallback test) the panel asks the client sequence's order: the explicit link of the org, the contractor's flagged company, then `barredCompanyFor` over the stored name. Any other error stops the award. Tests: `quotesPanelRender.test.ts` "MON-12 (J12 review fix 7) — the bid tab names the company the award records" (eight cases with their negative controls; all fail against `3a956cb`'s panel); `prjRoundGJ12Migration.test.ts` "J12 review fix 7: the bid tab's award prompt asks cost_doc_company_barred itself …". `MON-12` holds the detail. *(Corrected at fix pass 8: the prompt's override question is unchanged, but pass 7 also dropped the bid tab's stop for a bid only the LETTERHEAD could tie to a do-not-use company, a regression on `1cf5aad`; restored in J12 fix pass 8, below.)*
- J12 fix pass 8 (2026-10-02) (projects-tab `MON-12`). Before the call, the bid tab may now write a second kind of row. `COST_DOC_AWARD_LETTERHEAD_ACK` is a typed acknowledgement that the letterhead the AI read could be a do-not-use company the award's own question does not name. It is written as the intent row is, just before it (after every confirmation, before money moves, fail-closed), and closed with `COST_DOC_AWARD_LETTERHEAD_ACK_ABANDONED` when the intent cannot then be written or the award fails. It is never passed to `award_quote` as `p_override_reason`: the function gates the stored name and the links, not the letterhead, so it writes no `COST_DOC_AWARD_OVERRIDE` for it. The bid tab also asks its question again after its dialogs, just before the call, and asks a new reason when the answer moved. A move after that read, before the function's lock, is projects-joint J14's: an expected-company argument to `award_quote` (`MON-12` Scope / residual). Tests: `quotesPanelRender.test.ts` "MON-12 (J12 review fix 8) — …", run with the function absent and present, and "… the reviewer's nits". The two `awardQuote` calls are pinned to carry the override's reason only (`prjRoundGJ12Migration.test.ts`).
- J12 fix pass 9 (2026-10-02) (projects-tab `MON-12`). `award_quote`'s gate names ONE company, and a flagged contractor (an `inactive` one included) answers before the stored vendor name's do-not-use look-alike, so the function's `COST_DOC_AWARD_OVERRIDE` names the contractor and never that look-alike (review 9's S1). The bid tab now writes `COST_DOC_AWARD_LETTERHEAD_ACK` for that look-alike too, when no link of the org stands: the same row, before the intent row, `details.matchedOn` naming the vendor name on file, the letterhead or both, one row per company acknowledged, each closed by its own `_ABANDONED` row when the award does not happen. It is still never passed as `p_override_reason`. The function itself is unchanged: answering an `inactive` contractor after the look-alike, or recording every flagged company, is projects-joint J14's (`MON-12` Scope / residual).
- Commits: `6f89983` (the function), `5ace9cf` (the lib), `e03b655` (review fix pass 3: COST-13 under the lock, the gate), `74b11b5` (review fix pass 5: the contractor rule, one tie-break order), `3a956cb` (review fix pass 6: the bid tab's tie-break), `32814cd` (J12 fix pass 7: the bid tab asks `cost_doc_company_barred`), `d7ad34d` (J12 fix pass 8: the letterhead acknowledgement, never `p_override_reason`; the re-ask before the call), `2a4c2f5` (J12 fix pass 9: the stored name's look-alike behind a flagged contractor acknowledged, never `p_override_reason`).
- Tests: `lib/__tests__/costDocs.test.ts` "GAP-406 — awardQuote runs the award as one transaction when award_quote exists" (one call with the guard's total and nothing written by the client; the warning shape; guard refusals never call it and a reason is trimmed; the function's refusals read as the client sequence's sentences with no fallback; a database error reported with no fallback; 42883 / PGRST202 run the client sequence); `lib/__tests__/prjRoundGJ12Migration.test.ts` "GAP-406 — the award as one transaction" (order of the steps, refusals before the claim, raises after it, the currency rule, `addEntry`'s row, the rival key).
- Tests (review fix pass 3): `prjRoundGJ12Migration.test.ts` "re-checks COST-13 under the lock before the claim …" and "award_quote gates on the same rule and records the binding …"; `costDocs.test.ts` "the function's own refusals … read as the client sequence's sentences" now also plays `confirm_mismatch` and both `extent` sentences; the final SELECT's GAP-406 probe checks both codes come before the claim.
- Scratch: a private PostgreSQL 16 — refusals (flagged company with the company returned, a changed total, USD vs EUR, a foreign budget line, no total) wrote nothing; a failure injected into the commitment insert, and separately into the `COST_DOC_AWARDED` insert, rolled the whole award back (the quote and its rival still parsed, no entry, no audit row); a clean award posted the commitment ("Award — Gulf Mechanical (Piping)", reference Q-2), declined both rivals including a `' piping  '` case variant, and wrote both audit rows; a second award → `status`; a plain member → `not_found`; no session → 42501; anon → permission denied. Review fix pass 3 (`scratchpad/j12fix3/scenarios_fix3.sql`): read 8 of 20 with nothing confirmed → `extent`; the review's "confirmed" 1 → `confirm_mismatch`; unknown extent → `extent`; a full read with a wrong figure → `confirm_mismatch`; none of them wrote anything; the paper's 5000.4 typed back for 5000 awarded (`totalConfirmed` true, pages 8/20); a full read and a hand-typed total with nothing read awarded with `totalConfirmed` false.

**Done-when.**
1. ✓ A failure at any step leaves no partial award — with `20261157` applied (before it, J3's checked client sequence with its revert and the orphan line, as recorded on `MON-1`).
2. ✓ A query identifies existing awarded-without-commitment documents (J3).
3. ✓ Repair is an auditable action (J3).

**Scope / residual.** The bid tab's pre-award intent row (`COST_DOC_AWARD_OVERRIDE_DO_NOT_USE`, `QuotesPanel.tsx`) is still written by the panel before the call, and closed as abandoned when the award fails — unchanged. *(J12 fix pass 8:)* so is its letterhead acknowledgement (`COST_DOC_AWARD_LETTERHEAD_ACK`, closed by `COST_DOC_AWARD_LETTERHEAD_ACK_ABANDONED`). It is not an override, and `award_quote` never receives it. A `schemaExpectations` entry for `award_quote` is the A&O owner's file (named for the integrator).

---

<a id="gap-407"></a>
## GAP-407 · One number, one source, on the bid tab

**Verdict: BUILD_NARROW** · Effort: **S** · Sources: `BID-1`, `BID-2`, `BID-3`, `BID-4`

**The table scores the AI's total; the Award button posts the human's corrected
total.** Two numbers, one screen, and the decision is made on the one that is not
being shown.

`BID-2` compounds it: **there is no way to open the quote you are being asked to
award.**

### Scope

**In:** a single authoritative total per bid, with the AI-parsed value and any
human correction both visible and distinguishable; and a link from every bid row
to the source document.

**Out:** re-scoring. `BID-3` and `BID-4` are scoring-logic defects — fix them as
findings once the number is unambiguous.

### Do not

- **Do not hide the AI's original value once corrected.** The correction is the
  record (`GAP-303`, same principle).
- **Do not let a bid be awardable without its source being openable.**

### Acceptance

1. One total drives both the score and the award; a test asserts they cannot differ.
2. AI-parsed and human-corrected are visually distinct.
3. Every bid row opens its quote.

**Status: BUILT (2026-10-01, projects Round G — record reconcile, J13).** Built by projects Round G package J4 BIDTAB (merge `0a8cc63`; `BID-1`, `BID-2`, `BID-3` and `BID-4` resolved). Verified against HEAD `4dd0df7`.
1. ✓ One total drives both the score and the award, and a test asserts they cannot differ. Every bid-table entry goes through `withHumanTotal` (`lib/bidTab.ts:536`, applied by `bidFromRow` at `components/projects/cost/QuotesPanel.tsx:1058`). So the Price column, the value score's normalisation and the award confirm (`award`, :580) all read the row's `total_amount`, which is the figure `lib/costDocs.awardQuote` re-reads and posts (`postableTotal`). Test: `quotesPanel.test.ts` "display and award agree after setManualTotal: the row's total overlays the extraction and re-normalises the field" (:43), exit 0 (13 passed).
2. ✓ AI-parsed and human-corrected totals are visually distinct. A corrected row reads "corrected · AI read $X" in amber, and the AI's figure is kept as `extractedTotal` (`QuotesPanel.tsx:822-824`). The award confirm also says that the total was corrected by hand (:628).
3. ✓ Every bid row opens its quote. `OpenPdfButton` (:977) sits on read rows, typed-total rows, the not-yet-read strip and the invoice list (:312, :341, :436, :726, :777) and uses the existing presigned path. A row with no file says "no file".

---

<a id="gap-408"></a>
## GAP-408 · The timeline sees the controls program

**Verdict: BUILD** · Effort: **M** · Sources: `SAF-6`

**The project timeline cannot see the controls program at all.** Change orders,
checklists, turnover, punch, cost events — none of it appears on the one surface
meant to show what happened to a project.

For a PSM project record, a timeline missing the compliance program is the wrong
timeline.

### Do not

- **Do not put everything on it.** A timeline showing every cost row is unusable.
  Decide per event type whether it is a *milestone* or *noise*, and record the
  decision.
- **Do not build a second event store.** These events already exist as rows.

### Acceptance

1. Change orders, checklist completions, turnover and punch closure appear.
2. Each links to its record.
3. The event vocabulary is one list, extended deliberately.

**Partial (2026-10-01, projects Round G — record reconcile, J13).** Mostly built by projects Round G package J8 PROJECT-MODEL as `SAF-6` (merge `a388d22`) and verified against HEAD `4dd0df7`. Acceptance 2 does not hold, so this spec is not marked built.
1. ✓ Change orders, checklist completions, turnover and punch closure appear. `lib/timeline.ts` `getProjectTimeline` reads the project-scoped audit rows (:711-712) and the cost documents' audit rows (:745) through the vocabulary. Test: `timeline.test.ts` "an award, an approved change order, a turnover acceptance and a checklist ruling all appear; noise and mirrored rows do not" (:98), exit 0 (10 passed).
2. ✗ **Each links to its record: not built.** The Activity tab renders a controls event (`components/documents/TimelineFeed.tsx:130-190`, `TimelineRow`) as a summary line with a time, an actor and a kind tag, and nothing to click. The event does not carry its record as its resource either: a project-scoped row's `resource_id` is the project (`lib/timeline.ts:711-712`), and a cost row's is the cost document. Owed: a per-action link on the controls vocabulary's milestone events, rendered by the Activity tab. The link should go to the change order, checklist, turnover item or punch item, or at least to its tab (`?tab=costs` / `?tab=quality`).
3. ✓ The event vocabulary is one list, extended deliberately: `PROJECT_EVENT_VOCABULARY` (`lib/timeline.ts:407`), with every action classified as milestone, noise or mirrored. An unclassified action is shown (:477). Test: `timeline.test.ts` "the vocabulary is ONE map; an unclassified action is SHOWN, never silently dropped" (:131), exit 0.

**Status: BUILT (2026-10-01, projects Round G — J10b UI REMAINDERS completed acceptance 2).**

**Resolution (2026-10-01, projects Round G).** Each controls milestone now carries a link to its record's tab, and the Activity tab renders it.
- `lib/timeline.ts`:
  - `TimelineEvent.link` is `{ href, label } | null`.
  - `PROJECT_EVENT_TAB` is a per-action map held to the one vocabulary: every key is a `milestone` in `PROJECT_EVENT_VOCABULARY`. The award and change-order milestones map to Costs, the checklist / turnover / punch milestones to Quality, and the schedule milestones to Schedule.
  - `projectEventLink(action, projectId)` returns `/projects/<id>?tab=<tab>` labelled "Open in Costs", "Open in Quality" or "Open in Schedule". It returns nothing for an unmapped action or an empty id.
  - `getProjectTimeline` attaches the link to the project and cost audit rows it reads. Document events carry none.
- `components/documents/TimelineFeed.tsx`: `TimelineRow` renders the link (a Next `Link`) under the summary.
- The project page already follows a same-page `?tab=` navigation. That code is unchanged, and a test pins it.
- The link goes to the record's tab, the spec's "or at least to its tab". A project-scoped audit row's `resource_id` is the project, so there is no per-record id to deep-link to without a second event store, which the spec's "Do not" rules out.
- Tests: `lib/__tests__/j10bLabelsFormattersLinks.test.ts` "GAP-408 —" (4):
  - an award, a change order, a checklist ruling, a turnover review, a punch close and a schedule miss each carry their tab, and a download carries none;
  - the tab map is held to the vocabulary, and every controls milestone has a tab;
  - rendered: the feed shows the link on a linked row only;
  - the page's `?tab=` handling.

**Acceptance.**
1. ✓ Unchanged (J8).
2. ✓ Each links to its record, at the level of its record's tab (the spec's stated minimum).
3. ✓ Unchanged (J8). The tab map is now also checked against the one list.

**Scope / residual.** Not built: a deep link to the individual change order, checklist or item. It would need the record's id on the audit row and a per-tab focus parameter. The spec's minimum is met.

---

<a id="gap-409"></a>
## GAP-409 · The registry at scale

**Verdict: BUILD_NARROW** · Effort: **S** · Sources: `PERF-1`, `PERF-2`

**The companies registry fires over eleven hundred queries per page view**, with
no cache and no pagination. **Exporting all projects is 360 sequential round
trips** behind a button that gives no feedback.

Both are the N+1 pattern. The capability is pagination plus batched fetch plus
progress on anything long-running.

### Do not

- **Do not fix this with a client-side cache.** It moves the cost, and stale
  company data drives award decisions.
- **Do not leave the export unbatched and just add a spinner.**

### Acceptance

1. Registry page load issues a bounded number of queries independent of row count.
2. Export batches, reports progress, and is cancellable.
3. A test asserts the query count does not grow with the number of companies.

**Status: BUILT under the reading stated in acceptances 1 and 3 below (2026-10-01, projects Round G — record reconcile, J13; *qualified by the integrator at the J13 merge*).** Built by two projects Round G packages: J4 BIDTAB built the registry (PT `PERF-1`'s first two done-whens, merge `0a8cc63`), and J8 PROJECT-MODEL built the export (PT `PERF-2`, merge `a388d22`). Verified against HEAD `4dd0df7`.
1. ✓ read as: a page load never issues a query per company or per row; it is bounded by the page cap. Taken literally, "independent of row count" is not met: the count grows stepwise with id chunks, name-filter slices and 1,000-row evidence windows, as set out below. `/companies` reads one page on the server (`lib/companies.ts:128` `listCompaniesPage`), capped at `COMPANY_PAGE_SIZE` = 50 rows (:92; the page passes it at `app/(protected)/companies/page.tsx:86`). It then gathers that page's evidence in one batched pass (`gatherCompanyProfiles`, `lib/companies.ts:414`; called once per load at `page.tsx:92`). The batching lives in the gather's chunk loop: each table is read by `batchedRead` (:375) or `batched` (:386), one `.in()` read per chunk of `IN_CHUNK` = 200 ids (:338-343; the milestone read uses chunks of 80 project ids, `MILESTONE_PROJECT_CHUNK`, :407). Each chunk is paged in `GATHER_PAGE_ROWS` = 1,000-row windows, PostgREST's cap, until a short page (`readChunk`, :349, :360-369). The milestone read's company-name filter is split into slices of at most 50 names and about 2,400 characters (`orFilterChunks`, :392-402). The page's refresh callback (`page.tsx:83-99`) drops a stale gather's result through a cancel token, which the effect's cleanup sets on unmount or re-run (:101-107, the token at :106). The query count is therefore not constant. It grows only with id chunks, name-filter slices and 1,000-row windows, never per company. One company and a full page of 50 both cost 11 queries. 150 companies cost 13 (the name filter splits into three slices), and 150 companies with two parties each cost 18 (300 party ids are two chunks, so the five party-keyed reads run twice). Because the page is capped at 50, a page view stays at 11 unless one page's evidence runs past an id chunk or a 1,000-row window.
2. ✓ Export batches, reports progress, and is cancellable. `lib/projectExport.ts` reads in batches of `EXPORT_PROJECT_BATCH` = 100 (:32), reports progress per batch (:47, :99) and checks an `AbortSignal` between batches (:49). The Export All button is disabled while a run is in flight and shows "Exporting n/N…" with Cancel (`app/(protected)/projects/page.tsx:131-136`). Tests: `projectExport.test.ts` "3 projects and 99 projects cost the same number of reads …" (:92), "progress is reported and a cancel stops the export before anything is built" (:115), and "the Export All button cannot start a second run and shows progress with a cancel" (:158), exit 0 (12 passed).
3. ✓ read as: a test asserts that the query count never grows per company and is the same for one company as for a full page (≤ 50). Taken literally, "does not grow with the number of companies" is not met past one page, and the test asserts the growth: `companiesRegistry.test.ts` "a full page of companies costs the same query count as one, and even 150 stay far under 200" (:104) asserts 11 queries for 1 company and 11 for 50 (a page), then 13 for 150 and 18 for 150 with two parties each (:130-140), all under 200. Because the registry never loads more than one page of 50, a page view costs 11 unless its evidence runs past an id chunk or a 1,000-row window. If the user rules that the literal reading applies, this item is not met and the spec goes back to Partial. "The gather never issues a per-company query …" (:150) asserts no single-company filter and one batched `.in()` per table. Exit 0 (18 passed).

PT `PERF-1` stays OPEN on one item only: "Back does not re-run it". That item is held for the user to rule on (`audit-reports/fleet-plans/projects-joint.json`, `userHeld.PERF-1`). Meeting it would take the client-side cache this spec forbids ("Do not fix this with a client-side cache … stale company data drives award decisions"). Today, Back re-runs one gather of about 11 queries for the visible page. Nothing is owed under this spec.

---

<a id="gap-410"></a>
## GAP-410 · An accessibility baseline for safety surfaces

**Verdict: BUILD** · Effort: **M** · Sources: `A11Y-1`, `A11Y-2`, `A11Y-3`

**File pickers are unreachable by keyboard, including on the public vendor
portal.** **Checklist item status is conveyed entirely by an eight-pixel coloured
dot — on the PSSR surface.** **Milestone row tints make the row unreadable in dark
mode.**

The middle one is the serious one. Colour-only status on a pre-startup safety
review fails for roughly one in twelve men, and PSSR items are read under time
pressure by whoever is on shift.

### Scope

**In:** keyboard reachability for every control including the public portal; status
conveyed by shape or text as well as colour on every compliance surface; and a
contrast pass on both themes.

**Out:** a full WCAG programme. This is the safety-surface baseline.

### Do not

- **Do not add a tooltip and call the dot fixed.** A tooltip is not available to a
  keyboard user mid-walkdown, and it is not available at a glance.
- **Do not fix dark mode by disabling the tint.** The tint carries meaning; give it
  a legible form.

### Acceptance

1. Every control on the public portal is keyboard-reachable and focus-visible.
2. No compliance surface conveys status by colour alone. A test asserts the
   accessible name of a status cell includes its state.
3. Both themes pass contrast on the milestone and checklist surfaces.

**Resolution (2026-10-01, projects Round G).** Built by package J10 from its three sources. **(1)** The public portal: every file picker is `sr-only` in a label that shows focus, the submission-type toggle is a pressed-state button group, and the result is announced (`A11Y-1`, `A11Y-6`); the quotes panel's picker likewise. **(2)** Status by shape and word as well as colour on every compliance surface: `components/projects/StatusMark.tsx` gives each checklist, punch and rubric state its own glyph, a visually-hidden "Status: {word}." read with the row, and a visible legend (`A11Y-2`) — not a tooltip on a dot (the "Do not"). **(3)** Contrast in both themes on the milestone surface (`A11Y-3`, 2026-09-30) and the checklist surface (the marks' tones and chips at the 800 / 300 steps, computed).

**Acceptance.**
- ✓ 1. Every control on the public portal is keyboard-reachable and focus-visible (`a11yProjects.test.ts` "A11Y-1 —", rendered).
- ✓ 2. No compliance surface conveys status by colour alone; a test asserts the accessible name of a status cell includes its state (`a11yProjects.test.ts` "A11Y-2 —").
- ✓ 3. Both themes pass contrast on the milestone and checklist surfaces (`scheduleEngineUi.test.ts` "A11Y-3 ·"; `a11yProjects.test.ts` "A11Y-13 —") — including the dimmed rows, since the review fix below.

**Scope / residual.** Out of scope by the register's own line: a full WCAG programme. The schedule engine's remaining light slabs outside the milestone rows are `A11Y-13`'s (open).

*Review fix (2026-10-01, projects Round G).* Acceptance 3 was marked ✓ while two rows of the checklist surface failed it: N/A checklist rows rendered at `opacity-50` and closed punch rows at `opacity-55` — content rows, not disabled controls — which put their text (the muted rationale line most of all) under 4.5 : 1 in both themes, and the record computed only the cited pairs. Both rows are now set back by their status mark, the muted text token and (punch) a strike with the done / voided label, never whole-row opacity (`components/projects/QualityTab.tsx`); `a11yProjects.test.ts` computes the old composite (< 4.5) and the muted token at full strength (≥ 4.5 in light and dark) and pins both rows.

---

## What deliberately did NOT become a gap

Recorded so nobody looks for a spec that should not exist.

| Finding | Why it stays a finding |
|---|---|
| `SEC-2` private projects not private | A repair to existing RLS, not a new capability. |
| `SEC-3` review guarantee self-destructs | A defect in an existing guard. |
| `SAF-5` auto-supersede is a raw column write | Route it through the existing post-publish pipeline — the pipeline already exists. |
| `MON-2` S-curve planned line starts wrong | Arithmetic. |
| `SCH-4`, `SCH-5`, `SCH-7` | Cycle handling, three contradictory overdue rules, a missing optimistic lock — all repairs to code that exists. |
| `UX-*` truth-in-interface findings | Copy and render fixes. Numerous, cheap, and not capabilities. |
