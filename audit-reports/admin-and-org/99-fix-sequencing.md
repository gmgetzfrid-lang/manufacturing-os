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
- *2026-10-02 (admin-and-org Round G, P4) — two pastes; five notes for the integrator.*
  1. **Paste `supabase/migrations/20261175_ao_roundG_stripe_events_ledger.sql` and `supabase/migrations/20261176_ao_roundG_orgs_billing_columns_guard.sql`** (`DEC-30`, one paste each, idempotent).
     - *Order.* Either order with P4's deploy, and either order with each other.
     - *Before `20261175`.* The new webhook applies every event as the old one did, without the duplicate and ordering guards or the per-customer lock, and says so in the log and on each audit row (`details.ledger: "absent"`).
     - *Before `20261176`.* An Admin can still write the billing columns, and canceled workspaces keep the plan the old code left. Pasted before the deploy, paste `20261176` again after it (idempotent), so a workspace the old webhook cancels in between is cleared too.
     - *What to check.* Every probe true. `20261175`'s unique-index probe is false only in the world where two workspaces already share a Stripe customer: its rows count them. Clear the stray `stripe_customer_id`, then paste again. Its "after: stripe_event_locks rows" is 0 when no delivery is running. `20261176`'s two self-test rows are true (NULL on a database with no workspace). Its inventory reports, never rewrites, two shapes: "active" with no subscription id and a trial with no end. It counts the canceled workspaces still carrying a plan, which the paste clears (`BILL-3`); the BILL-3 probe says none is left.
     - *Rollback.* In each file's header.
  2. **For the user (`DEC-98` §2):** Stripe reconciliation (`BILL-2` Done-when 3) is WONTFIX for now, with the user as owner. `BILL-2` is RESOLVED for its other two criteria.
  3. **For A&O P5.**
     - *SURF-19's stripe limb.* `ADMIN_ROLES` in `app/api/stripe/{checkout,portal}/route.ts` is untouched. P4 added `liveSubscriptionRefusal` (checkout) and `customerOwnershipRefusal` (portal) after the gate line; P5 replaces only the gate line.
     - *ORG-9.* Done-when 3 (the enforcement half) stays OPEN for P5 (`BILL-10`).
  4. **For P7 (`ALOG-7` / `ALOG-11`).**
     - The webhook's rows are machine rows (`user_id` NULL, `user_email` `system:stripe-webhook`, `user_role` `system`); `ALOG-7`'s trigger must leave a service-role insert's `user_id` NULL (`DEC-87` §3).
     - Actions for the registry: `STRIPE_CUSTOMER_SUBSCRIPTION_CREATED`, `STRIPE_CUSTOMER_SUBSCRIPTION_UPDATED`, `STRIPE_CUSTOMER_SUBSCRIPTION_DELETED`, `STRIPE_INVOICE_PAYMENT_SUCCEEDED` (new), `STRIPE_INVOICE_PAYMENT_FAILED`, and `STRIPE_CHECKOUT_CREATED` (a person's row).
  5. **Files P4 touched beyond its plan entry:** `app/api/data-export/destinations/route.ts` and `app/(protected)/admin/data-export/page.tsx` (the create-form wart the integrator routed to P4); `lib/schemaExpectations.ts` and `lib/exportTables.ts` (one row each for `stripe_events` and `stripe_event_locks`, which the table tripwires require).
- *2026-10-02 (admin-and-org Round G, P4 review fix pass) — what changed for the integrator.*
  1. **`20261175` gains a second table, `stripe_event_locks`.** It is the webhook's one-event-per-customer lock: service role only, RLS on, no policy, empty while no delivery runs. The ordering index is renamed `stripe_events_subscription_order_idx` and now covers applied and superseded rows. Neither file had been pasted, so both were edited in place. A scratch database that holds the earlier draft's `stripe_events_subscription_applied_idx` can drop it; nothing reads it.
  2. **`20261176` now clears the plan on canceled workspaces** in its transaction (`BILL-3`). It is counted before and probed after. No other row is rewritten.
  3. **Records corrected in place:** `BILL-1` (a declined first checkout leaves the trial running), `BILL-3` (Done-when 1 in every delivery order; the residual), `BILL-4` (Done-when 3: the barrier split, superseded barriers and the lock; demote-only invoices; the residual), `BILL-8` (paused is not refused), and `DEC-98` §1, §3, §6, §7, Acceptance and Risk.
- *2026-10-02 (admin-and-org Round G, P4 second review fix pass) — what changed for the integrator.*
  1. **No DDL changed.** `20261175`'s header comment now describes the two new ledger reads and the 8 s lock wait. The paste instructions above stand.
  2. **`app/api/stripe/webhook/route.ts` declares `maxDuration = 30`** (the 8 s lock wait plus one event's work).
  3. **One test outside P4's own files:** `lib/__tests__/dcRoundFExportContract.test.ts` (`XEDGE-14`'s webhook block). Its mock orgs update now returns the row it wrote, because an update that writes no row is now recorded `unresolved`. The assertions are unchanged.
  4. **Records corrected in place:** `BILL-1` (an incomplete snapshot moves only the row the old code wrote; a deletion of a subscription that never started leaves the trial), `BILL-4` (Done-when 3's same-second rule; the lock wait; a write of no row; the residual), `DEC-98` §3, §6, Acceptance and Risk, and the `XEDGE-14` cross-note's count.
- *2026-10-02 (admin-and-org Round G, P6: storage quota, platform ceiling, branding upload key) — one paste, one setup line, and handoffs.*
  1. **Paste `supabase/migrations/20261177_ao_roundG_platform_operators.sql`** (`DEC-30`, one paste, idempotent).
     - *What it does.* It re-asserts that `platform_settings` is service-role only (RLS on, nothing granted to public / anon / authenticated), seeds the empty operator list (`platform_operators` = `{"uids": []}`, never clearing one) and comments the table. It creates no function, policy, trigger or grant.
     - *Order.* Either order with P6's deploy. Before the paste, the app finds no operator row, so nobody may change the plan ceilings (fail closed); every workspace still sees its own files, and a single-workspace server still sees its own figures.
     - *What to check.* The seven probes are all true; the after rows give the operator count (0 until the line below) and the workspace count.
     - *Rollback.* `DELETE FROM platform_settings WHERE key = 'platform_operators';`
  2. **Register the deployment's owner as platform operator**, or nobody can change the hosting-plan ceilings from `/admin/storage` (BILL-5, `DEC-99` §1). On a shared server, the deployment's storage alerts go to operators only. The line is in 20261177's header (by email); the storage page shows a refused Admin / DocCtrl the same thing with their own uid.
  3. **For A&O P7's audit-action registry (`ALOG-11`).** P6 writes four actions, each a person's row with the actor's real uid and the role the surface admitted them by:
     - `BRANDING_LOGO_UPLOAD` (`resource_type` `org_branding`, `details { path, contentType, size }`; ORG-5);
     - `STORAGE_QUOTA_CHANGED` and `ARCHIVE_SETTINGS_CHANGED` (`archive_settings`, `details.changes { <field>: { before, after } }`; BILL-7);
     - `PLATFORM_STORAGE_LIMITS_CHANGED` (`platform_settings`, `details { scope: "deployment", before, after }`; BILL-5 / BILL-7).
  4. **SURF-19's remaining limbs** are each one line, recorded in the finding's Partial block:
     - `app/api/admin/purge` and `archive-cancel` (A&O P7): `authorizeAdminSurface(req, orgId, "storage", "write")`.
     - `app/api/stripe/checkout` and `portal` (A&O P5): `authorizeAdminSurface(req, orgId, "billing", "write")`.

     The pin `lib/__tests__/roundE_D_rolesAdmin.test.ts` "…that STILL carry a constant…" lists exactly these four; drop each row as it converts.
  5. **Outside P6's plan:** `lib/storage.ts` (three lines). `getPresignedUploadUrl` sends the file's `size`, which the route signs as a logo's Content-Length, and appends the route's reason to "Failed to get upload URL (HTTP n)". Without it, the branding page's logo upload would be refused for want of a size.
- *2026-10-02 (admin-and-org Round G, P6 review fix pass) — three more files outside P6's plan, one new finding, no new paste.*
  1. **`app/(protected)/admin/restore/page.tsx`** ("Put the files back"). It is upload-url's second direct caller. It sent no size, so after `ORG-5` every workspace logo in a backup was refused 400 and counted as a bare failure. It now builds its request with `lib/storageKey.ts restoreUploadRequest`, PUTs the signed type, lists each failure's reason, and names a legacy SVG / GIF logo it cannot put back, with a link to Admin → Branding. Merge note: the A&O P1 restore work owns this page; the hunks are the files-back section (`uploadOne`, the progress panel) and the `FilesProgress` type, with the extension table moved to `lib/storageKey.ts contentTypeForKey`.
  2. **`app/api/cron/maintenance/route.ts`**, one statement in step 3 (storage alerts): `result.errors` gets the unmeasured count (`BILL-12`). No other step is touched. Sequence by merge order with the other packages' one-step hunks in this file.
  3. **`lib/adminSurfaces.ts`**, the header comment and one field doc: `writes` is enforced by the gate's write intent (`SURF-19`). No set changes.
  4. **Route `ORG-16`** (opened in `01-org-lifecycle.md`). Covers and backgrounds under `orgs/<org>/branding/` are member-writable with any Content-Type, `ORG-5`'s mechanism on the node decoration. The fix sits in upload-url but needs the documents area's node-customize authority.
  5. **`BILL-12` Done-when 2 is partial.** On a single-workspace server an Admin can get the quota alert and the platform R2 alert on the same day. A product call is needed to suppress one or merge them; see `DEC-99`'s fix-pass line.
- *2026-10-02 (admin-and-org Round G, P6 second review fix pass) — the same outside-plan files, one new finding, no new paste.*
  1. **`app/api/cron/maintenance/route.ts`**, step 9 (platform storage) this time, three statements: `runPlatformStorageAlerts`'s whole result is kept, and `platformAlertUnroutedError(platform)` is pushed into `result.errors` when a ceiling runs hot with no platform operator to tell (`BILL-5`). Step 3's statement from the first fix pass is unchanged. Still: sequence by merge order with N6 and N9's hunks in this file.
  2. **`app/(protected)/admin/restore/page.tsx`** ("Put the files back"), two statements: a logo's first 12 bytes are read and handed to `restoreUploadRequest(key, blob.size, head)`, so a JPEG stored at "….jfif" (a Windows name) or under no extension restores as what it is (`ORG-5`). A&O P1 owns the page; the hunk is inside `uploadOne`.
  3. **`components/branding/LogoUploadModal.tsx`** (P6's file): a new logo key's extension comes from `lib/storageKey.ts logoExtensionForType(file.type)`, never from `file.name`. **For the branding page's own uploader** (`app/(protected)/admin/branding/page.tsx`, outside P6, not edited): its `<input accept="image/*">` (`:111`) still invites an SVG or GIF that upload-url now refuses (415) — after the page has already set the object-URL preview and derived a palette from it (`:53-62`), so the preview shows a logo that was never stored until reload. The two-line swap for the page's owner, both helpers exported from `lib/storageKey.ts`: `accept={LOGO_CONTENT_TYPES.join(",")}` at `:111`, and a `logoUploadProblem(file.type, file.size)` pre-check at the top of `handleLogo` (`:53`, before the preview / palette step — show its `error`, return) beside `logoExtensionForType(file.type) ?? "png"` in place of the `file.name` extension at `:65`. Until then, a PNG / JPEG / WebP logo uploaded from that page under a ".jfif" or extensionless name still restores correctly, because the restore now reads the bytes.
  4. **New finding `BILL-15`** (04-billing.md): the single-workspace dual-alert remainder of `BILL-12` Done-when 2, with the two product options (suppress one, or merge into one bell naming both limits). Owner: the integrator, to route as a product call. Item 5 of the previous note is superseded by it.
  5. **The no-operator state is no longer silent.** Until the integrator registers an operator (note item 2 of the P6 deploy), a hot ceiling on a server with two or more workspaces bells each workspace's Admins without figures and appears in the cron's `errors`. Registering one restores the alert with figures, to the operator only.
- *2026-10-07 (admin-and-org Round G, P9 — permissions console truth and access recertification) — one paste, three handoffs, and (added at the review fix) one ruling for the integrator.*
  1. **Paste `supabase/migrations/20261188_ao_roundG_access_recert_events.sql`** (`ALOG-2`, `RET-4`; DEC-30, one paste, idempotent; NARROWS only). Either order with the P9 deploy; deploying first is the usual order (from that deploy a refused attestation record is said and the library's dates are put back). Independent of every other pending file. Expect nine probes true, then the counts-only inventory ("FOR ALL policies before": 2 on a first apply, 0 on a re-run). Rollback in the file's header.
  2. **For P8 (`app/(protected)/admin/users/page.tsx`, not edited here):** after a member removal or a role change the page may call `invalidateCapabilityPolicy(activeOrgId)` (`lib/capabilityPolicy.ts`) so the admin's own tab re-reads the policy (and `revoke_member`'s grant strip) at once. A browser display refresh only — every server-side authority decision already reads the policy fresh (`WF-10`, resolved).
  3. **For the integrator, at this merge: re-assign projects-and-cost `QUAL-14` done-when 2** (a PERSON-scoped project grant) **to drafting-flow DF-P11.**
     - Add `QUAL-14` to DF-P11's findings in `audit-reports/fleet-plans/drafting-flow.json`, with a `dependsOn` line saying its re-creation of `org_capability_allows_for` starts from the newest body (`20261137`) and carries the grant scope.
     - The criterion needs the grant op's scope and both evaluators' grant loops, plus the admin-and-org files the record names. It stays OPEN.
     - Until then a project is granted by role, through the editor's new project-scoped rules.
     - *(Review fix: this read "Proposed owner", which left the criterion with no accepted owner once P9 is done. `QUAL-14`'s Assigned line now asks for the same.)*
     - *Ruled 2026-10-08 (the integrator's fix pass on P9's branch): done-when 2 is an explicit Partial owned by DF-P11, not built here; the integrator adds it to DF-P11's plan entry at the merge. See the entry below.*
  4. **For the integrator — drafting-flow `AUTHZ-15` (LOW), opened at P9's second review fix**: during a database fault, the affordance surfaces that draw controls from the cached policy show the defaults unlabelled (no authority widens).
     - Confirm the owners its Assigned line proposes per surface:
       - drafting-flow DF-P9 for the requests pages and the ticket-notification hook;
       - document-control for transmittals, `HoldStrip`, `/admin/holds`, `InspectorPanel` and `CheckoutStatusCell`; the integrator names the remainder package.
     - Add it to those packages' plans.
     - Also: intelligence `DACL-5` criterion 3's drawer half is admin-and-org P7's (`PermissionDrawer.tsx`); the simulator half landed here.
     - *(Second review fix: this item first proposed the finding without opening it, so no package held that part of DEC-90 A26 once P9 merged.)*
  5. **For the integrator, at this merge: rule on admin-and-org `ALOG-9` done-when 3** ([DEC-35](../DECISIONS.md#dec-35), "Noted 2026-10-07"). The permissions page's `ADMIN_ROLES` is still a spelled literal, held equal to `ADMIN_SURFACES` by the SURF-9 census rather than derived from it.
     - Ruling (a): the census-held literal counts as one declaration. `ALOG-9` then resolves with no code.
     - Ruling (b): the census accepts a set derived from the registry, and the page derives it. One line in `app/(protected)/admin/permissions/page.tsx` plus `lib/__tests__/roundE_D_rolesAdmin.test.ts`; name the package.
     - `ALOG-9` stays OPEN until then.
     - *Ruled (b), 2026-10-08 (the integrator's fix pass on P9's branch): the page derives the set and the census accepts it; `ALOG-9` is RESOLVED and DEC-35 carries the Landed line. See the entry below.*
  6. **Second review fix (2026-10-07), for the next reviewer of the permissions explorer's snapshot.**
     - Only eight snapshot rows were checked against the code on 2026-10-07. The other 23 are tagged NOT RE-CHECKED on screen and named in `ALOG-14`'s *Scope / residual*.
     - *Ruled 2026-10-08 (the integrator's fix pass): the 23 rows are an explicit Partial on `ALOG-14`, owner **admin-and-org P7** (the ACL / `PermissionDrawer` package); the integrator adds it to P7's plan entry at the merge. P7 checks each row against the code and marks it `checked: true` with a pinning test, or removes it. (This read "whichever package next edits" the file — no owner, which DEC-31 does not allow.)*
- *2026-10-08 (integrator, at the A&O P9 merge — the fix pass on P9's branch, under the user's delegation) — three rulings, six review fixes, no new paste.*
  1. **`ALOG-9` done-when 3 — DEC-35 ruled (b).** `app/(protected)/admin/permissions/page.tsx` reads `ADMIN_ROLES` from `adminSurface("permissions")?.writes`; the SURF-9 census (`lib/__tests__/roundE_D_rolesAdmin.test.ts`) accepts a registry-derived `writes` set; the derived set is pinned equal to the old literal, so who may edit the console is unchanged. `ALOG-9` RESOLVED; DEC-35 carries the Landed line.
  2. **projects-and-cost `QUAL-14` done-when 2 — explicit Partial, owner drafting-flow DF-P11.** Not built here. The integrator adds it to DF-P11's plan entry in `audit-reports/fleet-plans/drafting-flow.json` at the merge (with the `dependsOn` line item 3 of the P9 entry asks for). The plan file is not edited on P9's branch.
  3. **The 23 NOT RE-CHECKED snapshot rows — explicit Partial on `ALOG-14`, owner admin-and-org P7.** The integrator adds it to P7's plan entry in `audit-reports/fleet-plans/admin-and-org.json` at the merge.
  4. **Also in the fix pass** (the final review's six minor issues): before `20261136` is pasted, View-as and the explorer no longer draw a policy grant of `quality.sign_off` as held — the probe runs once on mount and both panels say what holds today (`ORG-14`, `ALOG-14`); with no project picked an owner is drawn as able to sign off on the projects they own (`ORG-14` done-when 1 as written); the role model fold no longer calls the owner recertification path a known gap (DEL-6; `20261188`, pending its paste); the `"Viewer"` placeholder left in View-as's member mapping is gone — no role known is null and said so (DEC-91); `ALOG-14` row 6 and `QUAL-14` done-when 1 say "pending the paste of <file>".
