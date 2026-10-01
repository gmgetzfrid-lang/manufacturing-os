# 99 · Execution order

**Binding, not advisory.** No findings of its own — this is the plan the 147
findings are worked against. Judgment calls are in
[`../DECISIONS.md`](../DECISIONS.md).

---

## The cross-area cluster: **the field is told the wrong answer**

Seven `CRITICAL`s in four different reports are one defect wearing different
clothes. In a plant, a QR badge or a printed stamp is what a person trusts when
they cannot check the database — and it is currently capable of saying **CURRENT**
about a drawing that is voided, superseded, or under a hold.

| Finding | Area | What the field sees |
|---|---|---|
| `VFY-1` | public-surfaces | A **VOIDED** drawing scans GREEN "CURRENT" |
| `PHYS-1` | public-surfaces | A document under an **active HOLD** verifies GREEN "CURRENT" |
| `OFF-1` | public-surfaces | The verdict is **cached and replayed offline** — superseded answered "CURRENT" |
| `PHYS-2` | public-surfaces | Printing an **older** ticket deliverable stamps it with the ticket's current revision |
| `REV-1` | document-control | Downloading an old revision **stamps, names, QR-links and audits it as current** |
| `DIST-2` | document-control | The QR endpoint — the only recall channel reaching paper — misreports a voided document |
| `PKG-2` | document-control | The cover-sheet QR verifies the **live database pin, not the paper** |

**Fix them as one piece of work, not seven.** They share a root: the verdict is
computed from a narrow status set and a live lookup, rather than from *what this
specific artifact asserted when it was printed*. The drafting-flow area found the
identical bug on the ticket verify endpoint (`EDGE-2`) — it reads
`deliverable_rev` and never reads status. That is now the eighth instance.

**This goes before everything else in all four areas.**

---

## The second cluster: **four ways in that skip every guard**

| Finding | Area | What it permits |
|---|---|---|
| `DRLS-2` | document-control | `revup_rollback_orphan` is an **unauthenticated, cross-tenant revision-delete RPC** |
| `ORG-1` | admin-and-org | `/api/admin/restore/apply` writes caller-supplied rows into **arbitrary orgs and arbitrary tables** |
| `EGR-1` | document-control | The transmittal portal signs the R2 key of **any document version** from member-controlled input |
| `PKG-1` | document-control | Any active member can **overwrite the bytes of an ISSUED revision in place** |
| `XEDGE-1` | document-control (critic) | `/api/templates/generate` reads **any object in the R2 bucket** by caller-supplied key and returns its parsed cell contents |

These are the five most serious findings in the entire engagement across all nine
areas. None of them requires a role, a session in the right org, or a guessed id
beyond what the surface hands out.

⚠ **`XEDGE-1` came from the completeness critic, which ran after the verification
stage** — it is the only member of this cluster that has not been adversarially
refuted. It cites the repo's own sibling route stating the rule it breaks
(`app/api/templates/route.ts:84-85`), which is strong, but per `DEC-29` reproduce
it before writing the fix. It is listed here rather than lower down because if it
holds it is the same class as the other four.

---

## The third cluster: `FOR ALL` with only `USING`

The shape found on `tickets`, `notifications`, `email_notifications` and
`project_documents` in earlier areas recurs here on `documents` (`DCK-3`) and
`checkout_sessions` (`DCK-2`) — **and `DRLS-1` shows why patching one table at a
time does not work**: the own-row hardening added for acknowledgments and review
sign-offs is **void**, because a permissive policy ORs it away.

**Read `DRLS-1` before writing any RLS fix in any area.** Adding a restrictive
policy alongside a permissive `FOR ALL` does nothing unless the permissive one is
narrowed too.

---

## This area, in order

1. **`DRLS-2`, `EGR-1`, `PKG-1`, `XEDGE-1`** — the unauthenticated / unguarded
   paths above. `XEDGE-1` is a *read* rather than a write, and it is the one item
   here to reproduce first.
2. **The field-verdict cluster** — `REV-1`, `DIST-2`, `PKG-2`, with the
   public-surfaces half.
3. **`DRLS-1` first, then `DCK-2`/`DCK-3`** — the permissive-policy problem before
   the per-table fixes, or the per-table fixes are decorative.
4. **`RG-1`, `RG-2`** — review completion can be forged by a single INSERT, and the
   publisher the gate exists to constrain can sign another reviewer's row. The
   review gate is the product's central safety claim.
5. **`DCK-1`** — the PSM MOC gate for drawing revisions is enforced **only in
   browser JavaScript**. No lib mutator, no RPC, no trigger.
6. **`RET-1`, then `XEDGE-4` and `XEDGE-13`** — the destructive, irreversible
   deletes. `RET-1`: a legal hold does not stop the shed permanently deleting the
   R2 binaries of held revisions. `XEDGE-4`: an export destination with a
   retention policy and **no prefix** enumerates and deletes the customer's entire
   bucket by age, and the run still records `succeeded`. `XEDGE-13`: the storage
   orphan sweep paginates its reference scan with no `ORDER BY`, then permanently
   deletes every object it did not happen to see. Both `XEDGE-*` are critic
   findings — reproduce before acting, but treat "a scheduled job can delete
   customer bytes it never wrote" as the class.
7. **`PKG-3`, `PKG-4`, `PKG-5`, `DIST-1`, `DIST-3`, `REV-2`** in severity order,
   with the remaining `XEDGE-*` folded in — several of them
   (`XEDGE-3` unaudited restore primitive, `XEDGE-9` SSRF-by-redirect,
   `XEDGE-10` encrypted credentials exported verbatim) extend findings already
   listed above rather than standing alone.

⚠ **`DCK-1` deserves a note.** A control enforced only in the client is not a
control; it is a suggestion with a confirmation dialog. This is the same shape as
the client-side-only admin guard found in the drafting-flow area and the one
`ALOG-*` reports on the admin surfaces. Treat "is this enforced server-side?" as a
standing question for every guard in this area.

⚠ **Deploy order — share links (Round F wave 2, P1 SHARE; DEC-46 §7).** Apply
`20261068` (wave 1, P2 EGRESS) → `20261080` → `20261081` before the wave-2
share routes deploy. `/api/share/file` writes its `download_audits` row with
`share_id` / `source` / a NULL `user_id` and fails closed when no record can
be written; ahead of `20261068` the refusal that IS the missing migration is
logged (`DEPLOY ORDER: …`) and the row is retried once in the table's older
shape (sharer-attributed, as before), so a deploy first degrades attribution
rather than refusing every external download. Ahead of `20261081` the
per-access rows fail (logged, not fatal); the counter RPC keeps its
one-argument arity and resolves either side of the apply. The integrator
still applies in the order above so the first external pull is attributed
to the share.

⚠ **Deploy order — the publish override and the documents rails (Round F
wave 2, P3 LIFECYCLE; DEC-63 (P3 LIFECYCLE)).** *(Corrected in the second
review fix: the first version said to apply `20261130` and `20261131`
"before the wave-2 app deploys" while `20261131`'s prerequisites are
themselves app changes.)*

**Hard rules.**

1. **`20261131` is NOT PASTEABLE until `DRLS-15` and `DRLS-17` are
   DEPLOYED.** Both are library-page fixes (P6 CHECKOUT's file; closers
   unassigned — the integrator assigns them, ideally into this merge). From
   the moment `20261131` is pasted:
   - `DRLS-15` — it refuses a `rev` that differs from the current revision's
     label, as one whole statement: the page's `saveMetadata` sends `rev`
     with every other edit and discards the error, so any metadata save
     that changes Rev silently loses ALL its edits, and the bulk editor's
     "Revision" field fails on every row. Fix: check `{ error }` and the row
     count, and stop sending `rev` (or send it only unchanged); drop
     Revision from the bulk editor.
   - `DRLS-17` — acknowledgment and sign-off evidence become a NO ACTION
     reference on its revision, so the page's delete flow (pointer cleared,
     then versions deleted, then the document) stops at the version step and
     leaves a live document with no current file. Fix: delete the document
     row directly, or pre-check and refuse before any write.
   Until `20261131` is applied, `DRLS-3`, `DRLS-13` and `REV-13` are landed
   but not live (recorded OPEN with a Partial block — `REV-13` since review
   fix 3: its intake-door half is the rail's), and `REV-14` / `DRLS-14`'s
   database halves wait with them.
2. **Set `NEXT_PUBLIC_FACILITY_TIME_ZONE` before the wave-2 app ships**
   (`REV-9`; the facility's IANA zone, e.g. `America/Chicago`; documented in
   `.env.example`). Unset, the app decides "in effect" in UTC-12 — the
   latest calendar, so never early anywhere, but late by the facility's UTC
   offset plus 12 hours (up to 26 hours for a UTC+14 site) for the badge
   and the "now in effect" notice; it logs the unset zone once per runtime,
   and `facilityTimeZoneHealth()` (`lib/effectiveDate.ts`) answers for a
   health surface. Make the app deploy conditional on it.
3. Do not re-paste `20261105` or any earlier `publish_revision` migration
   after `20261130`: it would re-create the 11-argument overload; re-running
   `20261130` removes it.

**Order.**

0. Paste the `DRLS-16` hotfix now (below) — migration `20261129_dc_hotfix_anon_execute.sql` — independent of everything else.
1. Deploy the `DRLS-15` and `DRLS-17` page fixes (assigned 2026-10-01 to package P12 WAVE-2 RESIDUALS, which ships them first). *Landed 2026-10-01 in P12's first commit (both RESOLVED in code): the metadata and bulk editors no longer write `rev` for a document with a current revision (the integration fix keeps it editable on a register row with none, which `20261131`'s rail admits) and the save is checked; the delete flow is one checked statement on the document row. Step 3 waits only for the app carrying that commit to be deployed.*
2. Paste `20261130` (the override reason inside `publish_revision`).
3. Paste `20261131` (the documents-table rails) — only now (rule 1).
4. Deploy the wave-2 app immediately after (rule 2 met), to keep the window
   below short.

If the integrator folds `DRLS-15` / `DRLS-17` into the wave-2 merge (one
deploy), the order is: paste `20261130` → deploy the app, with the page
fixes, immediately → paste `20261131`. Either way `20261131` never precedes
the page fixes.

**The two windows — both fail closed, neither publishes unguarded.**

- *`20261130` pasted, the old app still running* (steps 2–4 above): the
  old app never sends `p_override_reason`, so every publish OVER another
  user's checkout raises a raw `check_violation` ("publishing over another
  user's checkout needs a reason …") — nothing is published; ordinary
  publishes are the same call (the new parameter defaults to NULL) and
  work. Keep it short by deploying the app right after the paste.
- *the wave-2 app deployed, `20261130` not yet pasted* (the one-deploy
  order): an override publish is refused with "needs migration 20261130"
  (the named argument does not exist yet) — never published unguarded (the
  legacy fallback is gone, `REV-8`); ordinary publishes work. The wave-2 app
  needs nothing from `20261131` to run (the supersession pair constraint
  dates from `20260526`; its lineage writers' checks do not depend on the
  new policies).

⚠ **Deploy order — the field pack (Round F wave 2, P8 FIELD;
DEC-70).** Rewritten at P8's fourth review fix pass. The
ratification now gates a switch in the code, not the deploy:

1. **Deploy the P8 app.** The field-pack budget (`PKG-12`) ships OFF:
   `NEXT_PUBLIC_FIELD_PACK_BUDGET` is unset, and packs build as they did
   before P8. Nothing waits on the ratification, and nothing waits on
   PS-VERIFY. P8 now adds no verdict rule to `/api/verify-package`, only the
   VFY-19 when-fields; its two amber rules were withdrawn.
2. **Paste `20261143` WITH that deploy or just AFTER it, never before.**
   It narrows `work_packages` close / delete to the owner or a controller
   (`DRLS-10`). Pasted ahead of the app, it meets the old `/packages` page,
   which offers Close to every member and reads a zero-row close as success.
   A planner who does not own the package would be told "Package closed"
   while it stays open and reappears on reload. The P8 page offers Close
   only to the owner or a controller and reports a refused close.
   **Read the MEASURE rows** in its result set:
   - the packages and asset tags the field-pack budget would reach (over 150
     printable sheets; over 150 MB of recorded file size together);
   - the single files over 150 MB;
   - the files with no recorded size;
   - the live transmittal PDFs over 64 MiB (`TRX-15`).
3. **The user ratifies DEC-70 §2 against those counts.** The
   150-sheet / 1000-page / 150 MB budget is a stated default, not a measured
   one, and once on it removes a capability that worked before, with no
   override: one pack of a large work package, on a desktop too, and any
   work-package pack holding a file too large for any pack. The user can
   ratify it, change the three constants (`lib/docPack.ts`), or ask for the
   device-aware variant (refuse only where `navigator.deviceMemory` is low,
   warn elsewhere). Tell the counted owners first.
4. **Then switch it on.** Set `NEXT_PUBLIC_FIELD_PACK_BUDGET=on` and
   redeploy: a `NEXT_PUBLIC_` value is built into the bundle. On Vercel,
   set it in the project's environment. On a Docker self-host, set it in
   `.env` for `docker compose up --build`, or pass `--build-arg
   NEXT_PUBLIC_FIELD_PACK_BUDGET=on` to a raw `docker build`, then rebuild
   the image (`Dockerfile` and `docker-compose.yml` carry the arg since P8's
   fifth fix pass; `docs/SELF_HOST_DOCKER.md`).

For PS-VERIFY's owner, not a P8 prerequisite: whether a still-current
sheet a print could not read as a PDF (`unreadable_pdf` on the snapshot)
should read amber rather than red at the cover scan (public-surfaces
`VFY-19`'s residual).

`TRX-15`'s stricter portal rule (a PDF goes out stamped or not at all) is not
in this deploy: it is armed per item only by `TRX-16`'s issue-time mark, and
lands with the user's ratification of the `DEC-61` §5 amendment.

⚠ **Paste NOW, independent of wave 2 — `DRLS-16` (CRITICAL).** The live
11-argument `publish_revision` was never revoked from `anon`, and it reads a
NULL `auth.uid()` as a service-role call that may name any actor. The
hotfix is migration `20261129_dc_hotfix_anon_execute.sql` (2026-10-01; it
supersedes the one-statement snippet first written into the `DRLS-16`
record): it revokes `anon` on every overload of `publish_revision` and of
`post_ticket_comment` (the same NULL-uid shape) and its result set lists
every SECURITY DEFINER function `anon` can still execute, to be read back
into `DRLS-16`. `20261130` later drops the signature and grants the new one
without `anon`; `lib/__tests__/dcHotfixAnonExecute.test.ts` refuses any
future migration that re-opens the shape.

**`REV-9` closes** when every deployment names its zone (rule 2). The
`/api/verify` swap to `effectiveTodayISO()` this line first gave to P8 is
DONE — public-surfaces PS-VERIFY (2026-10-01, `REV-9`'s Partial block,
public-surfaces `VFY-4`); P8 does not redo it. Public-surfaces `VFY-4`
stays OPEN on the same operator limb.

⚠ **Paste order — P12 WAVE-2 RESIDUALS (2026-10-01).** Two one-paste
migrations; each pastes cleanly in any order relative to `20261129`–`20261131`
and to the other:

- `20261139_dc_roundF_first_issue_and_branch_closeout.sql` (`REV-17`,
  `DRLS-9`) — after `20261105` (the publish guard's base) and `20261061`
  (the branch policy's base). It re-creates `enforce_document_publish_guard`:
  **never re-paste `20261105` (or any earlier guard migration) after it**, or
  the first-issue block is dropped. Deploy the app carrying `REV-15`'s bulk
  upload change with or before it, so a refused first issue is asked up
  front instead of leaving a document with no file. **`REV-17`'s INSERT
  door closes only once `20261131` is live too:** the guard fires BEFORE
  UPDATE, so until `20261131`'s `trg_document_insert_pointer_rail` a member
  can INSERT a document already pointing at a revision and reach the issue as
  a non-first pointer move (see `REV-17`'s scope). Even with `20261131` live
  the refusal is not complete: a Draft first pointer followed by a status
  change to Issued bypasses it — `REV-18` (assigned to P13
  STATUS-TRANSITION). After the paste, a Minor /
  Correction rev-up that attaches the FIRST file to a pointerless issued
  register row in a require-mode library is refused with the creation
  sentence (`REV-17` / `REV-18`).
- `20261140_dc_roundF_share_download_deny_rail.sql` (`SHR-14`) — after
  `20261080` (the share INSERT policy's base); it reads `role_rank`
  (`20261046`), which its final SELECT probes.

Both narrow; their result sets carry the DEC-30 inventories to read back
into the records.

⚠ **Paste order — P13 STATUS-TRANSITION (2026-10-01).** One one-paste
migration, `20261144_dc_roundF_status_issue_transition.sql` (`REV-18`):
after `20261139` (the guard's base — it re-creates
`enforce_document_publish_guard` from `20261139`'s body, so **never re-paste
`20261139`, `20261105` or any earlier guard migration after it**, or the issue
rule is dropped). It is independent of `20261131` (the register rail never
fires on a status-only write), `20261129`, `20261130` and `20261140`; when
`20261131` is also pending, paste `20261131` first so `REV-17`'s INSERT door
is closed by the time this rule binds the status. Narrow; it also adds two
nullable columns the guard alone writes (`documents.retired_issue_status`,
`retired_issue_version_id` — the retirement stamp) and a BEFORE INSERT
trigger that clears them on a signed-in INSERT. Its result set carries the
DEC-30 inventory (issued-unreviewed documents under a require policy;
Draft / In Review documents whose next issue now needs a controller;
Superseded / Void / Archived documents, retired before the paste, whose
restore of an unreviewed revision now needs a controller; held Draft / In
Review documents) and a behaviour probe of `is_controlled_issue_status`.
Deploy the app carrying P13 with or before it, so the rev-up flow, the set
rev-up, the merge and the two status editors say the rule before the
database refuses. After the paste, in a require-mode library a
non-controller cannot issue an unreviewed Draft / In Review revision by any
door, nor restore to an issue status an unreviewed revision of a document
retired BEFORE the paste (or retired from a status that was not an issue) —
Document Control does it. The put-back of an issue retired after the paste
(a failed supersede / split / merge's compensation, an un-archive) is spared
the rule (review fix, `REV-18`). A retirement after the paste that took away
no issue is stamped `not-issued`, and its status-only exit into an issue is
refused over an active hold for everyone, a controller included (second
review fix). The script also grants EXECUTE on `is_controlled_issue_status`
to the guard's own owner when that role cannot already run it (the guard
runs as its owner) and probes it: a `false` on that row means every
signed-in issue write would fail with "permission denied" — stop and report
it. The un-archive dialog (third review fix) pre-selects Issued, as before,
unless the guard's stamp says the archive took away no issue — so before the
paste (no stamp columns) and for any legacy or service-role archive it
restores Issued exactly as it always did, and the database decides.

⚠ **Deploy note — P12 (operators, public-surfaces `SHR-11`).** Before
deploying the app carrying P12, a self-hosted deployment (the Docker image,
`next start`) must set `NEXT_PUBLIC_SITE_URL` to its public address — a
**build argument** of the image (`--build-arg NEXT_PUBLIC_SITE_URL=…`, or
`docker-compose.yml`'s `NEXT_PUBLIC_SITE_URL`). Without it every external
share download answers `503 unverifiable`: under `next start` the request URL
the route sees is the server's bind address (`http://localhost:3000`), which
no outside recipient can open, and the route refuses rather than issue a copy
whose verify QR cannot work. (Before P12 such a deployment served a copy with
no QR.) Vercel deployments are unaffected while the project exposes its
system environment variables (the production domain answers).

**Library page — lines P12 owns outside `uploadOne` (for identity `IS-P1`
and intelligence `I-12`, which edit `app/(protected)/documents/[libraryId]/page.tsx`
next).** In `handleStagedUpload`: the `landedShortfalls` declaration right
before `uploadOne`, and the one `notes.push` that reports it in the batch
report (after the "not started because you stopped the upload" note). Keep
both when rebasing; `REV-15`'s tests pin them. The P12 integration fix also
edits `saveMetadata` (one of the three named functions: `rev` only for a
document with no current revision) and, inside `uploadOne`, starts the
clocks before the `DOCUMENT_CREATED` record so the record carries
`complianceClockErrors`.

⚠ **Paste order — P15 SURFACE REMAINDERS (2026-10-01).** One one-paste
migration, `20261152_dc_roundF_hold_other_reason.sql` (public-surfaces
`VFY-6`): independent of every other pending migration; paste it
**BEFORE deploying the app carrying P15 (a prerequisite of that deploy)**.
It re-creates `20260612`'s open-reason unique
index so an open "Other" hold is keyed by (the md5 of) its note — the P15
picker writes the "Other" code with the description in the note instead of
free text in `reason` — and (second review fix) adds the database limb: a
signed-in hold's reason is a code ("Other" with a description), or
legacy text the org already carries (a lifecycle carry); an "Other" hold's
description cannot be changed; and (final review fix) no hold's reason can
be changed by an UPDATE, for anyone — exactly `20261073`'s identity rule,
with its exemptions (none) — so pasted before or after `20261073`, no
PATCH can put free text in `reason`, and the order between the two does
not matter. If the app ran ahead of the paste, a
document could hold only one open "Other" hold at a time: a second custom
hold — two different free-text reasons are placeable today — would be
refused, and a split / merge / reversal carrying two "Other" holds onto one
document would be refused and rolled back (fail closed). If the paste runs
ahead of the app (or the P15 deploy is rolled back), nothing stops (third
review fix): today's "Other…" picker writes free text into `reason`, and
the rail coerces it into an "Other" hold described by that text — the row
the P15 picker writes — instead of refusing it; only an "Other" hold with
no description is refused. The integrator orders it before the P15 deploy
in `MIGRATION-PASTE-ORDER.md`; the gap no longer needs to be short.
Widening (the index) and narrowing (the rail and the freeze); its result
set carries the DEC-30 inventory of the custom-reason holds placed before
P15 (kept, never rewritten). The P15 app
also asks `user_download_denied` (`20261140`, P12's) from the share modal;
before that paste the modal behaves as before and logs why (`SHR-14`).

**Handoffs from admin-and-org Round G P2 (2026-10-01).** Two more byte-freeing checks were left unowned when P9 merged. Admin-and-org P2 could not land them: neither is in P2's brief. Both are handed off; the integrator assigns the owner at the P2 merge (proposed: admin-and-org P3, after document-control P14 merges). (This paragraph first said both were P14's; P14's brief lists neither.) Each is recorded with its exact hunk and test shape:
1. **Intelligence `ILIFE-5`, the direct storage delete.** `app/api/storage/delete/route.ts` must refuse with 409 a key that a knowledge-library mirror still names, or that any other registered key column outside `document_versions` names. It must fail closed with 503 when the read errors. The check is `lib/storageKeyRegistry.ts keysReferencedOutside(supabaseAdmin, [path], ["document_versions.file_url", "document_versions.source_file_key"])`, placed after the hold / retention refusal and before the custody row. The hunk is in `audit-reports/intelligence/18-lifecycle.md`, `ILIFE-5`, "the second call site". The shed's two call sites have landed in A&O P2.
2. **Intelligence `ILIFE-6` criterion 3, the purge side.** `lib/storageOrphans.ts deleteOrphans` must re-check each candidate key just before its `DeleteObjects` batch, against every registered key column: `keysReferencedOutside` for the plain columns, and one containment read per key for the JSON-embedded ones. Any key still named is kept, and a read error deletes nothing. The scan reads its reference set page by page, so a reference that moves behind the cursor can be missing from it. The hunk is on `ILIFE-6`. A&O P2 owns the collector half of that file (`collectReferencedKeys`, keyset-paged); the purge half was P9's (`RET-7`).
