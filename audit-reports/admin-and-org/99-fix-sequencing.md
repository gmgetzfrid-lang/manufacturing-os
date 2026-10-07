# 99 · Execution order

**Binding, not advisory.** No findings of its own — this is the plan the 55
findings are worked against.

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

These are the four most serious findings in the entire engagement across all nine
areas. None of them requires a role, a session in the right org, or a guessed id
beyond what the surface hands out.

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

1. **`ORG-1`** — `/api/admin/restore/apply` writes caller-supplied rows into
   **arbitrary orgs and arbitrary tables**. This is a cross-tenant write primitive
   exposed on an admin route. Nothing else in this area matters until it is closed.
2. **`BKP-1`** — exports embed **live unauthenticated bearer tokens**: share links,
   transmittal portal links, and writable ones. An export handed to a vendor is a
   set of working credentials.
3. **`ALOG-1`** — the capability policy is read from and written to
   `org_configurations.value`, **a column that does not exist**. The column is
   `data`. If confirmed, the entire capability-policy layer is inert and every
   org is running shipped defaults.
   ⚠ **This corroborates `DEC-36`**, which recorded the same column-name error
   from the other direction. Reproduce it first — the blast radius is every
   authority decision the policy is supposed to configure.
4. **`ORG-2`** — `org_members` has **no DELETE policy**, so "Remove from
   workspace" silently deletes nothing and reports success. Offboarding does not
   offboard.
5. **`BKP-2`** — `cost_documents` binaries are referenced by nothing the system
   knows about and are absent from every backup.
6. Everything else in severity order.

---

## Integrator notes

- *2026-10-02 (admin-and-org Round G, P3 fourth review fix pass; item 2 corrected at the sixth) — two handoffs for the integrator to route; P3 does not edit these files.*
  1. **Proposed: P6.** `/admin/storage` (`app/(protected)/admin/storage/page.tsx:743-775`) still shows "Download JSON" and "Download ZIP" to every member its surface admits (Admin, Manager, DocCtrl). Since P3 (`BKP-8`) the data-export routes behind them are Admin-only, so a Manager or DocCtrl who clicks one gets the raw 403 JSON (`{"error":"Exporting the whole workspace…"}`) in the page's error slot. The buttons should show only to a member holding the data-export surface's entry (`adminSurface("data-export").entry`, by the full collection, `hasAnyRole` on the client), with a line pointing others to an Admin. P6's plan entry lists that file for its label region only, so this is a scope addition for P6 or the integrator to assign. Recorded under `BKP-8`'s Scope / residual and `DEC-87` Risk.
  2. **For P7's audit-action registry (`ALOG-11`).** P3 writes three actions the viewer should name:
     - `DATA_EXPORT`: a person's export or a scheduled push. The row names who took it (`user_id`, `user_email`, and the role the surface admitted them by in `user_role`), or the machine for a scheduled push (`user_id` NULL).
     - `DATA_EXPORT_FILES`: the file lists, on two ledgers. Every row is a machine row (`user_id` NULL, `user_email` `system:export-ledger`, `user_role` `system`), and the exporter is in `details.exportedBy`.
       - A person's export writes to the workspace's ledger: `resource_type` `org_export_ledger`, `resource_id` the workspace. *(Corrected at the P3 sixth review fix pass. This note used to say a person's rows carry the exporter, which stopped being true at the fifth.)*
       - A push to a destination writes to that destination's ledger: `resource_type` `export_destination`, `resource_id` the destination.
     - `DATA_EXPORT_UNDELIVERED`: an export recorded as leaving that then did not. A machine row naming the record id.

     Both ledgers read only machine rows (`user_id` NULL), which `audit_logs_insert` keeps members from writing. P7's planned `ALOG-7` trigger should leave a service-role insert's `user_id` NULL, so that both the workspace's and every destination's ledger still hold (`DEC-87` §3). For the viewer, "who took which drawing" is `lib/dataExport.ts rebuildExportList(sb, orgId, recordId)`. It takes a `DATA_EXPORT` row's record id, gives that export's file list with each file's document and revision, checked against the record's digest, and names who took it (sixth review fix pass). *(Corrected at A&O P3 fix pass 7, two things to check:)*
     - **`undelivered`.** Check it before saying the exporter took the files. Non-null (`{ error, at }`) means the export was recorded as leaving and then did not arrive: its `DATA_EXPORT_UNDELIVERED` machine row. The list is what it carried, but nothing reached the other end. *(Corrected at A&O P3 fix pass 8:)* null means no failure is recorded, not that the files arrived. Do not show it as "delivered": a delivery killed mid-flight (Vercel ending the function at its 300 s `maxDuration`, a container restart on a self-host) records nothing, and its run row stays "running"; and the row is read up to a day after the record (`UNDELIVERED_READ_WINDOW_MS`), since a delivery off Vercel has no time limit. Say "no delivery failure recorded".
     - **`exporter.userId` is who took it.** `email` and `role` are whatever the inserter wrote, because `audit_logs_insert` checks a member's insert for `user_id = auth.uid()` and an org the member belongs to, never the email or the role (`20260813:85-90`; *corrected at A&O P3 fix pass 8*: this read "checks only `user_id = auth.uid()`"). On a member's row they are display hints until `ALOG-7`'s trigger resolves them from `org_members`; show the uid's current member, not the stored email. A machine row (`user_id` NULL) can be written only by the service role, so its label is the app's own.
- *2026-10-02 (admin-and-org Round G, A&O P3 fix pass 7) — `BKP-6` closed by P3; one paste for the user.*
  1. **Withdrawn: the P7 proposal for `BKP-6`.** From the sixth review fix pass, `BKP-6`'s Assigned line proposed P7 for Done-when 3's remainder: the retention counts on `export_runs`. P7's plan entry names no `export_runs`, run route or data-export page, while P3's lists the residual, so by the integrator's ruling P3 shipped it. `BKP-6` is RESOLVED with the paste pending; P7 has nothing to do for it.
  2. **Paste `supabase/migrations/20261172_ao_roundG_export_run_retention.sql`** (`DEC-30`, one paste, idempotent). It adds `export_runs.retention_deleted` and `retention_failed` (nullable integers) and changes no policy, grant or function.
     - *Order.* Either order with P3's deploy is safe; deploying first is the usual order. Either order with `20261154` too.
     - *Before the paste.* The app's run-row update that names the columns is refused (PGRST204 / 42703) and written again without them, so a run closes exactly as before, its counts in its diagnostics, and the page shows them from there.
     - *After it.* Both run routes write a purge's counts to the row, and the page reads them there.
     - *What to check.* The final SELECT's seven probes are all true, the "after" counts follow, and the inventory says whether it was a first apply.
     - *Rollback.* `ALTER TABLE export_runs DROP COLUMN IF EXISTS retention_deleted, DROP COLUMN IF EXISTS retention_failed;`. The app keeps working.
  3. **`BILL-3`'s leftover-bucket gates — P3's, closed at fix pass 8.** Under `SUBSCRIPTION_ENFORCE`, the scheduled gate's plan limb (`lib/exportEntitlement.ts scheduledRunGate`, fed `dest.bucket`), the sweep's disable-on-lapse (`!!dest.bucket`) and Run Now (`|| bucket`) treated a webhook row carrying a leftover bucket name as a bucket destination: off plan, the conversion PATCH allows since fix pass 7 was undone that night (the sweep disabled the webhook) and Run Now refused it 402. The edit form cannot clear a stored bucket. With the flag off (`DEC-18`), every scheduled run of it carried a "plan gate would skip" notice. *(Corrected at A&O P3 fix pass 8: this read "Residual for `BILL-3` (pre-existing, not P3's change)" and left it to "whoever turns the flag on". Run Now's gate and the sweep's disable were P3's own, written on this branch; only the plan limb is on master. P3 made the three agree (`pushesToBucket`, s3 / r2 with a bucket); nothing here is left for the integrator. See the fix pass 8 note below.)*
- *2026-10-02 (admin-and-org Round G, A&O P3 fix pass 8) — no new paste; one owner named.*
  1. **`BILL-3`'s leftover-bucket gates: closed by P3.** Run Now, the sweep's plan limb and its disable-on-lapse test a bucket destination as PATCH does, s3 / r2 with a bucket (`lib/exportRunner.ts pushesToBucket`). `lib/exportEntitlement.ts` is not edited (the sweep hands its gate the bucket only for such a row). Turning `SUBSCRIPTION_ENFORCE` on no longer disables a converted webhook. The one wart left is the create form's (a bucket typed before switching the type to webhook makes that create 402 off plan, `XEDGE-8`'s create gate); it is P4's, as `BILL-3`'s owner (`04-billing.md`, Scope / residual).
  2. **For P7 (the recall).** Item 2 above is corrected in place: `undelivered: null` is "no delivery failure recorded", not "delivered"; the UNDELIVERED read now runs a day past the record. `rebuildExportList`'s signature and answer shape are unchanged.
  3. **For whoever deploys on the Docker self-host.** A delivery there has no time limit (`next start` does not enforce `maxDuration`), and P3 adds none: a deadline would fail a slow upload that works today. A run killed mid-delivery (a restart) leaves its run row "running" and records no failure.
- *2026-10-02 (integrator, at the A&O P3 merge) — the handoffs above are routed.* Recorded in `audit-reports/fleet-plans/admin-and-org.json`:
  1. **P6** takes the `/admin/storage` export buttons (P3 handoff 1). Its entry for `app/(protected)/admin/storage/page.tsx` now names that change beside the label region.
  2. **P7** takes the registry and viewer notes (P3 handoff 2 and fix-pass-8 item 2), as a `dependsOn` line. `BKP-6` is not P7's.
  3. **P4** takes `BILL-3`'s create-form wart (fix-pass-8 item 1), as a `dependsOn` line beside `DEC-87` §2's machine-row convention.
  4. `DEC-44 (A&O P3)` was renumbered `DEC-87`, and every mention moved with it. `20261172` is row 127 of `MIGRATION-PASTE-ORDER.md`.
- *2026-10-07 (admin-and-org Round G, P9 — permissions console truth and access recertification) — one paste, three handoffs.*
  1. **Paste `supabase/migrations/20261188_ao_roundG_access_recert_events.sql`** (`ALOG-2`, `RET-4`; DEC-30, one paste, idempotent; NARROWS only). Either order with the P9 deploy; deploying first is the usual order (from that deploy a refused attestation record is said and the library's dates are put back). Independent of every other pending file. Expect nine probes true, then the counts-only inventory ("FOR ALL policies before": 2 on a first apply, 0 on a re-run). Rollback in the file's header.
  2. **For P8 (`app/(protected)/admin/users/page.tsx`, not edited here):** after a member removal or a role change the page may call `invalidateCapabilityPolicy(activeOrgId)` (`lib/capabilityPolicy.ts`) so the admin's own tab re-reads the policy (and `revoke_member`'s grant strip) at once. A browser display refresh only — every server-side authority decision already reads the policy fresh (`WF-10`, resolved).
  3. **For the integrator — projects-and-cost `QUAL-14` done-when 2** (a PERSON-scoped project grant) stays OPEN: it needs the grant op's scope and both evaluators' grant loops, the SQL half a re-creation of `org_capability_allows_for` from its newest body (`20261137`). Proposed owner: drafting-flow DF-P11 (the next planned re-creation), with the admin-and-org files it names. Until then a project is granted by role (the editor's new project-scoped rules).
  4. **For the integrator — a proposed LOW finding on drafting-flow `AUTHZ-7`**: the affordance surfaces that draw controls from the cached policy show the defaults unlabelled during a database fault (no authority widens). And intelligence `DACL-5` criterion 3's drawer half is admin-and-org P7's (`PermissionDrawer.tsx`); the simulator half landed here.
