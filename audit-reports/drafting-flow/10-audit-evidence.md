# 10 · Audit trail & evidentiary completeness

**14 findings** — 1 CRITICAL · 5 HIGH · 8 MEDIUM.

Judged as a PSM/OSHA auditor would: what could this system prove, and what could it not?

> Each finding below survived an adversarial verification pass: a second agent read
> the cited code and tried to refute it. Refuted findings were dropped and are not
> recorded here. Severities marked by that pass override the original.


---


<a id="evid-1"></a>

## EVID-1 · Ticket approval history, status and issued-rev live in a client-writable JSONB column under a single org-wide FOR ALL RLS policy — the drafting approval chain can be rewritten or erased by any org member

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:1080-1081`, `lib/ticketTransitions.ts:139`, `lib/ticketTransitions.ts:144-148`, `lib/projects.ts:826-841`, `app/api/verify-ticket/route.ts:51-56`
- **Same root cause as** `SM-2`, `PERS-1`, `AUTHZ-2` — One `CREATE POLICY ... FOR ALL USING (...)` with no `WITH CHECK` (`supabase/schema.sql:1079-1081`). Four lenses found it independently. **One migration closes all four.** Fix once; close the rest citing this one.
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. I looked specifically for a rescue: there is no RESTRICTIVE policy on `tickets` in any migration (20260828_integrity_hardening, 20260831_capability_policy_and_rails and 20260901_db_hard_enforcement harden document_review_signoffs, document_acknowledgments, work_package_documents, document_holds and documents — never tickets), and the only trigger on the table is `tickets_search_tsv_trg`. The server route's WorkflowEngine enforcement is therefore entirely bypassable by a direct PATCH from any active member's own token; app/api/verify-ticket/route.ts:51-56 then serves the forged status/rev publicly. CRITICAL stands.

**Mechanism.** `tickets` carries exactly one RLS policy: `CREATE POLICY "tickets_org_access" ON tickets FOR ALL USING (org_id IN (SELECT my_org_ids()))` (supabase/schema.sql:1080). FOR ALL covers SELECT/INSERT/UPDATE/DELETE and, with no WITH CHECK, UPDATE inherits USING. There is no trigger on tickets other than the search_tsv trigger (supabase/migrations/20260610_phase2_search_completion.sql:89). The approval chain is `tickets.history`, a JSONB array that computeTransition rebuilds wholesale on every transition (`const newHistory = [...(ticket.history || []), historyEntry]; updates.history = newHistory`). The /api/tickets/workflow-action route enforces the state machine, but it is not the only writer: lib/projects.ts performs a browser-side read-modify-write of the entire array. So any authenticated active member of the org can issue `supabase.from("tickets").update({ history: [], status: "PENDING_IFC", deliverable_rev: "3", engineer_approved_at: <any> }).eq("id", <ticket>)` directly against PostgREST, bypassing the workflow route entirely.

**Failure scenario.** A drafter whose revision was rejected opens devtools (or any REST client with their own session token) and PATCHes the ticket row: history replaced with a fabricated 'Engineer approved final — issued Rev 2' entry naming a real engineer's email and role, status set to PENDING_IFC, deliverable_rev set to '2'. The ticket page renders the forged history as the record of approval. Worse, /api/verify-ticket — the UNAUTHENTICATED endpoint behind the QR stamped on printed deliverables — reads `deliverable_rev` straight off that same row (route.ts:51-56) and will tell a contractor holding the print in the field `verdict: "current"`. Nothing in audit_logs records the direct UPDATE, because audit rows are only written by the workflow route the attacker did not call.

**Evidence.**

```
supabase/schema.sql:1080-1081 —
  CREATE POLICY "tickets_org_access" ON tickets FOR ALL
    USING (org_id IN (SELECT my_org_ids()));

lib/ticketTransitions.ts:139,144-148 —
  const newHistory = [...(ticket.history || []), historyEntry];
  const updates: Record<string, unknown> = { last_modified: now, history: newHistory, unread_by: newUnreadBy };

lib/projects.ts:832-839 —
  const history = Array.isArray(existing?.history) ? existing.history : [];
  history.push({ action: "Converted to Project", user: input.actorEmail || input.actorUserId, date: new Date().toISOString(), details: `Project ${project.id} (${project.name})` });
  await supabase.from("tickets").update({ history }).eq("id", input.ticketId);
```

**Chain reaction.** TicketHistoryEntry (types/schema.ts:1097-1104) stores `user?: string` (an email string) and `role?: Role` — no user UUID, no signature id, no attachment reference — so even an untampered history entry cannot be cryptographically or referentially tied to a person or a file. The forged and the genuine entry are byte-identical in structure. Deleting the array entirely also removes the only in-app evidence that a rejection ever occurred, since audit_logs details record only `{ from, to, label }` (app/api/tickets/workflow-action/route.ts:222) and not the history contents.

**Done when.**

- [ ] tickets.history / status / deliverable_rev / engineer_approved_at are not directly UPDATE-able by authenticated members: either a restrictive RLS policy limits UPDATE to a narrow column set, or a BEFORE UPDATE trigger rejects any change that shrinks or rewrites existing history elements (append-only)
- [ ] Every ticket state change flows through /api/tickets/workflow-action (service role) — lib/projects.ts's client-side history push is moved server-side
- [ ] Each history entry carries the actor's UUID and, for approve actions, the e_signature id and the approved attachment's id + content hash
- [ ] A test proves a direct PostgREST update from a member session cannot truncate or rewrite tickets.history

---

<a id="evid-2"></a>

## EVID-2 · Any active org member can stamp 'acknowledged' on any other person's distribution-ack row, and the row has no acknowledged_by column to detect it

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260825_work_packages_acks.sql:131-139`, `lib/distributionAcks.ts:186-193`, `supabase/migrations/20260825_work_packages_acks.sql:99-116`, `supabase/migrations/20260828_integrity_hardening.sql:15-26`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Correct, including the pointed contrast: 20260828_integrity_hardening.sql:15-26 fixed exactly this hole for document_review_signoffs and document_acknowledgments (`reviewer_user_id = auth.uid()` / `assignee_user_id = auth.uid()`) and left distribution_acks untouched — the migration's own comment even documents the class of bug. No later ALTER adds an acknowledged_by column.

**Mechanism.** The distribution_acks UPDATE policy grants any active org member update rights on every row in the org, with no per-row recipient check and no WITH CHECK column restriction. The client helper `acknowledge(ackId)` writes `acknowledged_at` filtered only by `.eq("id", ackId)` — no `recipient_user_id = auth.uid()` predicate at any layer. The table stores `recipient_user_id`, `requested_at` and `acknowledged_at` but no `acknowledged_by` and no `acknowledged_via` (unlike `transmittals`, which has both — supabase/migrations/20260717_transmittals.sql:46 and 20260910_transmittal_portal.sql:22), so a row acknowledged by someone else is indistinguishable from a genuine one. The 20260828 integrity-hardening migration explicitly closed exactly this hole for `document_review_signoffs` and `document_acknowledgments` ('the old member-ALL policy let ANY org member update ANY sign-off row — i.e. sign a review on someone else's behalf') but never touched distribution_acks; three separate searches over supabase/ found no later policy on that table.

**Failure scenario.** Rev 5 of a P&ID goes out to twelve field personnel with acknowledgment requested. Two operators never open it. A coordinator who wants the dashboard to read 12/12 before a turnaround opens the ack list, reads the pending row ids (SELECT is granted org-wide by distribution_acks_org_select), and PATCHes acknowledged_at on both. The DistributionAcks panel now renders 'confirmed <date>' for those two operators (components/documents/DistributionAcks.tsx:190-196), scanDistributionAcks stops nagging them (it filters on `.is("acknowledged_at", null)`), and the escalation to the requester never fires. The regulator asks 'show me who confirmed they had Rev 5' and the system produces two confirmations that the named operators never made — with no field in the row that could reveal who actually clicked. The same policy also permits setting acknowledged_at back to NULL, rewriting recipient_user_id, or backdating requested_at.

**Evidence.**

```
supabase/migrations/20260825_work_packages_acks.sql:131-139 —
  -- Recipients acknowledge their own row; the requester may refresh
  -- requested_at on a re-nudge. Keep it simple: any active member may update
  -- (the app only ever writes acknowledged_at to rows where they are the
  -- recipient, or requested_at as the requester).
  CREATE POLICY distribution_acks_org_update ON distribution_acks FOR UPDATE USING (
    EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = distribution_acks.org_id
            AND org_members.uid = auth.uid() AND org_members.status = 'active')
  );

lib/distributionAcks.ts:186-193 —
  export async function acknowledge(ackId: string): Promise<void> {
    const { error } = await supabase
      .from("distribution_acks")
      .update({ acknowledged_at: new Date().toISOString() })
      .eq("id", ackId)
      .is("acknowledged_at", null);
    if (error) throw new Error(error.message);
  }
```

**Chain reaction.** The module header calls this table 'The audit answer to "prove the field knew about the change"' (lib/distributionAcks.ts:8-9) and the migration comments it as 'PSM-audit gold' — so this is the artifact the operator will hand a regulator. Because the write is a direct client UPDATE with no server route in between, no audit_logs row is produced by acknowledging at all (there is no logAuditAction call in lib/distributionAcks.ts), so even a genuine acknowledgment leaves no independent second record to reconcile against.

> **Verifier correction.** HIGH, not CRITICAL. This forges a downstream receipt record, not a release gate: nothing in the publish or ticket-approval path consults distribution_acks, and the UI's own read path (getMyPendingAck, lib/distributionAcks.ts:76-97) filters on `recipient_user_id = userId`, so exploitation requires a deliberate hand-crafted PostgREST call rather than a mis-click. The absence of acknowledged_by is what makes it undetectable, and that part is exactly right.

**Done when.**

- [ ] distribution_acks UPDATE policy restricts acknowledged_at writes to `recipient_user_id = auth.uid()`, with a WITH CHECK that prevents un-acknowledging or changing recipient_user_id/requested_at
- [ ] An `acknowledged_by UUID` (and ideally `acknowledged_via`) column is added and populated, so a row can prove who performed the act
- [ ] `acknowledge()` filters on the caller's uid as well as the row id, or moves behind a server route that does
- [ ] Acknowledging writes a corresponding audit_logs row so there are two independent records

---

<a id="evid-3"></a>

## EVID-3 · E-signatures — the strongest evidentiary artifact — are written directly by the browser with client-asserted signer name, role, intent and content hash

- **Severity:** HIGH
- **Status:** RESOLVED

**Resolution (2026-09-02, fixed under roles-and-permissions Round C3 as [`SURF-14`](../roles-and-permissions/09-non-document-surfaces.md) — the owning record; this one points there).** `recordSignature` calls `/api/signatures/sign`, which derives `signer_name`, `signer_role` and `signer_email` from `org_members` for the authenticated caller and ignores client-supplied values for those columns; `content_hash` is taken from the version row's `file_hash` (computed by the publish path from the bytes it stored) and a disagreeing client hash is refused; the database rail is the strongest available — `20261050` leaves NO INSERT policy on `e_signatures` and installs a BEFORE INSERT trigger that refuses any user-JWT insert, so a direct PostgREST insert (mismatched role, unauthorised intent, or otherwise) cannot land at all, and `intent = 'Approved'` is gated on approval capability by the role collection in the only writer. The test (`lib/__tests__/sweepRoundC3.test.ts`) drives the route with forged identity, a wrong password, a disagreeing hash and an unauthorised `Approved`, and pins the migration's policy set and trigger — the live-database refusal itself is by absence of any INSERT policy, which the migration's verification probe checks on apply. The drafting-flow area is unclaimed; its own pass re-verifies.

- **Verification:** CONFIRMED
- **Locations:** `lib/eSignatures.ts:103-137`, `supabase/migrations/20260720_e_signatures.sql:54-64`, `components/signatures/SignatureCaptureHost.tsx:50-63`, `lib/revisions.ts:177-181`, `lib/revisions.ts:873`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: there is no server route for signature capture (grep shows only client callers in lib/reviewControl.ts:296, lib/acknowledgments.ts:433, AckSection/ReviewGateSection), no check that the signer holds authority over the resource, and no server-side recomputation of content_hash (lib/revisions.ts:177-181 hashes the file in the browser). The one real constraint is that signer_user_id must equal the authenticated uid, so the underlying account is not forgeable — only the displayed name, role, intent, statement and hash are.

**Mechanism.** `recordSignature` inserts into e_signatures from the shared browser client. The RLS policy constrains exactly two things — `signer_user_id = auth.uid()` and active membership in the org. Everything that gives the signature its evidentiary meaning is unconstrained client input: `intent` ('Approved'), `statement`, `signer_name`, `signer_role`, `signer_email`, `document_version_id`, `content_hash`, and `user_agent` (read from `navigator.userAgent`, i.e. supplied by the signing client itself). signer_role comes from React context (`activeRole`) in SignatureCaptureHost.tsx:60 and is never re-derived server-side against org_members. The content hash is likewise a client artifact: sha256Hex runs in the browser over the File object (lib/revisions.ts:177-181) and its output is written to document_versions.file_hash and forwarded as the signature's content_hash — a grep for file_hash across app/ shows no server-side recomputation from the stored R2 object (only reads, and the shed/export routes echoing the stored value).

**Failure scenario.** A Viewer-role contractor with an active membership POSTs directly to /rest/v1/e_signatures with signer_user_id = their own uid (satisfying RLS), intent 'Approved', signer_role 'Lead Process Engineer', statement 'I approve this for construction', and the document_version_id of a P&ID draft. The row is accepted. SignaturePanel and any evidence gathering that reads e_signatures render it as a formal approval by a Lead Process Engineer. Separately, a modified client can upload file X to R2 while computing and submitting the SHA-256 of file Y, so the content_hash 'binding' the signature attests to bytes that were never issued — and because nothing recomputes the digest server-side, the mismatch is undetectable from within the system.

**Evidence.**

```
supabase/migrations/20260720_e_signatures.sql:58-64 —
  CREATE POLICY "e_signatures_self_insert" ON e_signatures
    FOR INSERT
    WITH CHECK (
      signer_user_id = auth.uid()
      AND EXISTS (SELECT 1 FROM org_members WHERE org_id = e_signatures.org_id AND uid = auth.uid() AND status = 'active')
    );

lib/eSignatures.ts:118-134 —
  const { data, error } = await supabase
    .from("e_signatures")
    .insert({
      ... intent: input.intent,
      statement: input.statement,
      signer_user_id: input.signerUserId,
      signer_name: input.signerName,
      signer_role: input.signerRole ?? null,
      ... user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
    })

lib/revisions.ts:177-181 —
  async function sha256Hex(file: File): Promise<string> {
    ...
    const digest = await crypto.subtle.digest("SHA-256", buf);
```

**Chain reaction.** The migration's own comment claims 'The content_hash binds the signature to the exact file/version content that was signed, so a later change can't silently ride on an old approval' — that guarantee holds only against accidental change, not against a client that lies, because both the hash and the signature are produced by the same untrusted process. The re-authentication work (verifySigningCredential, SSO_REAUTH_WINDOW_MS) hardens the UI ceremony but is entirely client-side and is not a precondition the database enforces on the INSERT.

> **Verifier correction.** One partial mitigation belongs in the finding: components/signatures/SignatureCeremony.tsx:45-79 requires a password re-authentication (verifySigningCredential) or a fresh SSO sign-in before the ceremony calls recordSignature. That raises the bar on the ceremony path, but it is client-side only — nothing in the RLS policy or a server route re-checks it — so a direct PostgREST insert still bypasses it, and it does not constrain intent, statement, signer_role, document_version_id or content_hash at all.

**Done when.**

- [x] recordSignature moves behind a server route that derives signer_name, signer_role and signer_email from org_members for the authenticated caller, and rejects client-supplied values for those columns
- [x] content_hash is computed or verified server-side against the object actually stored in R2 before the signature row is accepted — *verified against the version row's `file_hash`, the hash the publish path computed from the stored bytes*
- [x] A restrictive RLS policy or trigger prevents an INSERT whose signer_role does not match the caller's recorded role, and prevents intent='Approved' from a caller lacking approval capability — *no client INSERT exists at all (policy dropped, trigger refuses); the sole writer derives the role and gates the intent*
- [x] A test proves a direct PostgREST insert with a mismatched signer_role or an unauthorised intent is rejected — *at the route (unit) and by the migration's pinned policy set; the live refusal is checked by the migration's verification probe*

---

<a id="evid-4"></a>

## EVID-4 · The 'Approved' identity on a controlled revision is a free-text box; approved_by and approved_at are never written by any code path

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/documents/RevUpModal.tsx:732`, `lib/revisions.ts:893`, `supabase/migrations/20260828_integrity_hardening.sql:142-165`, `supabase/schema.sql:338-346`, `lib/evidencePack.ts:62`, `components/documents/VersionHistoryPanel.tsx:395`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Both halves verified: the identity is free text, and the two structured columns are dead. It is then rendered as an approval stamp (components/documents/VersionHistoryPanel.tsx:395 `<SignoffBit icon={<Stamp .../>} label="Approved" name={v.approvedByName} />`) and printed in the evidence pack's Approved column (lib/evidencePack.ts:61 `${esc(v.approved_by_name || "—")}`). The parallel real mechanism (document_review_signoffs + e_signatures) exists but is separate and does not populate or gate this field.

**Mechanism.** `approved_by_name` is a plain `<input>` in the rev-up modal, typed by whoever is publishing, trimmed and written straight to document_versions. The `publish_revision` RPC's INSERT column list includes drawn_by_name, checked_by_name and approved_by_name but does NOT include `approved_by` or `approved_at` (supabase/migrations/20260828_integrity_hardening.sql:142-165). Three differently-shaped searches — `grep "approved_at|approvedAt"` across all .ts/.tsx/.sql, `grep "approved_by\b"` across .ts/.tsx, and a case-insensitive `approved_?at` over lib/app/components — found only reads (lib/revisions.ts:962,969; app/(protected)/documents/[libraryId]/page.tsx:1897,1904) and the column definitions. No writer exists for either column anywhere in the repository. So every controlled revision in the database has approved_by = NULL and approved_at = NULL, and the only approval evidence is an unvalidated string typed by the publisher.

**Failure scenario.** A drafter rev-ups a P&ID to Rev 4 and types 'J. Okafor, PE' into the Approved By box. J. Okafor never saw the drawing. The Version History panel renders a stamp icon and 'Approved — J. Okafor, PE' (VersionHistoryPanel.tsx:395), and the one-click Compliance Evidence Pack prints it in the 'Approved' column of the revision-lineage table (evidencePack.ts:62) under a footer asserting the pack is assembled from the immutable audit trail. A regulator asked to accept this as proof of approval by a qualified person is being shown a string with no user id, no timestamp of approval distinct from the publish time, and no signature — indistinguishable from a genuine entry.

**Evidence.**

```
components/documents/RevUpModal.tsx:732 —
  <Field label="Approved By"><input value={approvedByName} onChange={(e) => setApprovedByName(e.target.value)} className={inputClass} /></Field>

lib/revisions.ts:893 —
  drawn_by_name: drawnByName?.trim() || null, checked_by_name: checkedByName?.trim() || null, approved_by_name: approvedByName?.trim() || null,

supabase/migrations/20260828_integrity_hardening.sql:142-148 (publish_revision INSERT column list) —
    INSERT INTO document_versions (
      org_id, record_id, revision_label, issue_type, change_type,
      file_url, file_type, size, change_log,
      created_by, created_by_name, created_at,
      supersedes_version_id, drawn_by_name, checked_by_name, approved_by_name,
      released_at, moc_reference, source_file_name, source_file_key, file_hash,

supabase/schema.sql:338,345-346 —
  approved_by UUID,
  approved_by_name TEXT,
  approved_at TIMESTAMPTZ,
```

**Chain reaction.** The e_signature review-gate path (lib/reviewControl.ts:288-300) DOES produce a real bound approval — but only for libraries whose review_control policy is configured; a library with review mode off publishes via revUpDocument with nothing but the typed name. The two paths write into the same document_versions row and the evidence pack renders them identically, so an auditor cannot tell from the pack which revisions were genuinely signed and which were self-attested.

> **Verifier correction.** Narrow the last sentence. 'The only approval evidence is an unvalidated string' is overstated: for ticket-originated revisions the ticket row carries engineer_approved_at plus a server-written TICKET_ENGINEER_APPROVE_FINAL audit row (app/api/tickets/workflow-action/route.ts:213-223), and for libraries with review_control mode 'require' the document_review_signoffs + e_signatures chain carries a real signer identity. What is confirmed is narrower and still serious: the identity columns designed to hold a verified approver on document_versions are dead, and on the version row itself the approver is free text. Note also that 20260818_review_before_publish.sql:10-11 states a ticket-originated rev always skips the review gate — which is precisely the drafting-request flow, so for that flow the free-text field is the version-level approval record.

**Done when.**

- [ ] approved_by (UUID) and approved_at are populated by publish_revision from an authenticated approver, or the free-text approved_by_name field is removed from the publish path
- [ ] The evidence pack distinguishes a signature-backed approval (joins e_signatures / document_review_signoffs) from a typed name, and labels the latter as unverified
- [ ] A query can enumerate every current controlled revision that has no signature-backed approval, so the operator knows the size of the gap

---

<a id="evid-5"></a>

## EVID-5 · download_audits — the record of who holds or printed a copy — is deletable by any org member and every write is an unawaited, error-swallowed client insert

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:1090-1091`, `app/(protected)/requests/[id]/page.tsx:592-600`, `components/viewers/MultiDocViewer.tsx:747`, `components/assets/FileReferenceModal.tsx:189`, `components/viewers/SecureDocViewer.tsx:52-59`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The deletable-by-any-member half is exactly right. Two sub-claims are overstated: not every write is unawaited (MultiDocViewer.tsx:747, FileReferenceModal.tsx:189 and lib/downloads.ts:132 await), and not every write is a client insert (app/api/share/file/route.ts:130 writes server-side with the service-role client). Every path does swallow the outcome. Lowered to MEDIUM because the codebase already treats this table as best-effort ambient telemetry rather than a record of account — lib/staleCopies.ts:14 states "orgs where download_audits is sparse simply show less".

**Mechanism.** download_audits carries one policy: `CREATE POLICY "download_audits_org_access" ON download_audits FOR ALL USING (org_id IN (SELECT my_org_ids()))` — FOR ALL with no WITH CHECK, so SELECT, INSERT, UPDATE and DELETE are all granted to every active org member. Two searches over supabase/ (regex `on +download_audits` and a policy-filtered grep) found no other policy. The writes are client-side and deliberately non-blocking: the ticket print path uses `void supabase.from("download_audits").insert({...}).then(() => {}, () => {})`, MultiDocViewer and FileReferenceModal wrap theirs in `try { await ... } catch (e) { console.error(e) }`. The in-app view record has the same shape — SecureDocViewer calls `logFileView({...}).catch(e => console.error(...))` without awaiting, guarded by a `loggedRef` that fires once per mount.

**Failure scenario.** A supervisor prints a stamped copy of a superseded P&ID and takes it to the field. The insert is fired with `void` while the print dialog opens; the user closes the tab before the request completes, or the request fails, and the row never exists. Later, after an incident, the operator runs the stale-copy recall (lib/staleCopies.ts, which is built entirely on download_audits) and the supervisor's copy is invisible — nobody is told to destroy it. In the adversarial case, any member who wants their download not to appear on the record simply issues a DELETE against download_audits for their own rows; because audit_logs has no DELETE trace of that operation, the deletion leaves nothing behind.

**Evidence.**

```
supabase/schema.sql:1090-1091 —
  CREATE POLICY "download_audits_org_access" ON download_audits FOR ALL
    USING (org_id IN (SELECT my_org_ids()));

app/(protected)/requests/[id]/page.tsx:592-600 —
    // Record the print on the audit trail either way.
    if (orgId && userId) {
      void supabase.from("download_audits").insert({
        org_id: orgId, ticket_id: ticketId ?? null, attachment_id: file.id,
        ... watermark_text: stamped ? "UNCONTROLLED COPY" : "UNSTAMPED (stamping failed)",
        source: "drafting_print",
      }).then(() => {}, () => {});

components/viewers/SecureDocViewer.tsx:52-59 —
    logFileView({ orgId, fileId: documentId, fileName: title, userId: uid, userEmail: userEmail || 'unknown', userRole: activeRole })
      .catch(e => console.error("Audit log failed", e));
```

**Chain reaction.** lib/staleCopies.ts:5-14 states 'Every download is already recorded with the exact version it delivered (download_audits)' and builds both the personal stale-copy list and the per-document distribution recall on that premise. Because the premise is a best-effort client write against a member-deletable table, the recall surface systematically under-reports and the operator's confidence in 'we recalled every copy' is unfounded. Note the server-mediated share path (app/api/share/file/route.ts:130) does write its row server-side — so the record's completeness varies by which button the user pressed.

**Done when.**

- [ ] download_audits and audit VIEW/DOWNLOAD rows are written server-side, in the same request that issues the signed URL or the stamped file, and the action fails visibly if the record cannot be written
- [ ] The FOR ALL policy is split: SELECT for members, INSERT restricted to the service role, and no UPDATE or DELETE policy at all (append-only, matching audit_logs)
- [ ] No download or print record is written with `void` or a discarded promise
- [ ] A test proves a member session cannot DELETE a download_audits row

---

<a id="evid-6"></a>

## EVID-6 · logAuditAction can never detect a failed audit write — every audit row in the system is silently droppable

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/audit.ts:16-32`, `node_modules/@supabase/postgrest-js/src/PostgrestBuilder.ts:82`, `node_modules/@supabase/postgrest-js/src/PostgrestBuilder.ts:371-372`, `node_modules/@supabase/postgrest-js/src/PostgrestBuilder.ts:534-536`
- **Also surfaced independently as** [`PERS-7`](./07-persistence-and-rls.md#pers-7) — two lenses found this separately, which raises confidence. Fix once.
- **Same root cause as** `PERS-7` — `supabase-js` resolves with `{error}` rather than throwing, so a swallowed audit insert reads as success. Same class of fix at every call site. Fix once; close the rest citing this one.
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Stands. The cited node_modules/@supabase/postgrest-js paths do not exist in this checkout (dependencies are not installed), but the app code settles it without them: even if the builder rejected, the catch swallows it, and since it resolves with an error object instead, the empty-string UUID insert (22P02) is dropped with no console output at all. The `.catch(() => {})` at reviewControl.ts:386 discards even that.

**Mechanism.** `logAuditAction` awaits `supabase.from("audit_logs").insert({...})` inside a try/catch and never reads the returned `error` field. supabase-js resolves rather than rejects on database errors: `protected shouldThrowOnError = false` (PostgrestBuilder.ts:82), the error is only thrown `if (error && this.shouldThrowOnError)` (line 534), and even network `fetchError`s are caught and converted into a resolved `{error}` result when shouldThrowOnError is false (lines 371-372). `throwOnError()` appears zero times in lib/, app/, components/ or hooks/. Therefore the catch block at lib/audit.ts:29 is unreachable for RLS denials, constraint violations, type errors, missing columns, and network failures alike — the function returns success in every case. This is the single funnel for VIEW, DOWNLOAD, CHECK_OUT/CHECK_IN/FORCE_RELEASE, HOLD_OPENED/RELEASED, REV_UP, SUPERSEDE_DOC, REVERT, ARCHIVE_DOC, DOC_SPLIT/MERGE/RENUMBER, SUBMIT_FOR_REVIEW, ESIGNATURE_CAPTURED, ACK_WAIVED, REVIEW_REQUESTED and REVISION_PUBLISHED_AFTER_REVIEW.

**Failure scenario.** A concrete, already-present instance: `activateAlternate` is called from the daily cron with `actorId: null` (lib/reviewControl.ts:558), and its audit call passes `userId: input.actorId ?? ""` (lib/reviewControl.ts:386). audit_logs.user_id is `UUID` (supabase/schema.sql:777), so the empty string is invalid input syntax (22P02) and the INSERT fails. logAuditAction swallows it, `.catch(() => {})` at the call site catches nothing because nothing threw, and no console line is ever emitted. The alternate reviewer is activated — changing who is authorised to approve the drawing — with zero audit record. Same pattern for REVIEW_REQUESTED (lib/reviewControl.ts:233-236) and REVIEW_CONTROL_SET (lib/reviewControl.ts:145-148) whenever actorId is null. A regulator asking 'show me the log of who was made an approver' gets nothing, and nobody at the operator ever saw an error.

**Evidence.**

```
lib/audit.ts:16-32 —
  export async function logAuditAction(entry: AuditEntry) {
    try {
      await supabase.from("audit_logs").insert({
        action: entry.action,
        ...
        user_id: entry.userId,
        ...
      });
    } catch (error) {
      console.error("Failed to write audit log:", error);
    }
  }

node_modules/@supabase/postgrest-js/src/PostgrestBuilder.ts:82 — `protected shouldThrowOnError = false`
line 534 — `if (error && this.shouldThrowOnError) { throw new PostgrestError(error) }`

lib/reviewControl.ts:386 —
  await logAuditAction({ action: "REVIEW_ALTERNATE_ACTIVATED", ..., userId: input.actorId ?? "", details: { signoffId: input.signoffId } }).catch(() => {});
```

**Chain reaction.** Because the audit trail is the substrate for lib/evidencePack.ts (gatherEvidence reads audit_logs), components/documents/HistoryDrawer.tsx, /activity and /admin/audit, a dropped row is invisible everywhere simultaneously — there is no reconciliation counter, no dead-letter table, and no alert. The system's own evidence pack footer claims the pack 'is assembled from the immutable audit trail', which cannot distinguish 'nothing happened' from 'the write failed'.

> **Verifier correction.** The 'single funnel' framing is too broad. The server-written ticket audit rows are NOT written through logAuditAction — app/api/tickets/workflow-action/route.ts:214 inserts into audit_logs directly via supabaseAdmin (service role, RLS bypassed), so the RLS-denial failure mode does not apply there (it has its own discarded-error problem, see finding 7). Severity is HIGH rather than CRITICAL: under normal operation the inserts succeed; what is confirmed is that a failure is undetectable and unlogged, not that rows are routinely lost. It is an evidence-durability defect, not an authorization bypass.

**Done when.**

- [ ] logAuditAction destructures and inspects `{ error }` from the insert and, on failure, escalates rather than returning normally (throw, or write to a durable dead-letter/outbox table that the maintenance cron drains and alerts on)
- [ ] No audit call site passes a non-UUID sentinel for user_id; system-initiated actions use a dedicated reserved system actor UUID or a nullable `actor_kind` column, not ""
- [ ] A test asserts that an audit insert returning `{ error }` produces a non-silent outcome (thrown, retried, or dead-lettered), and a second test asserts that a null-actor cron path still produces a durable audit row

---

<a id="evid-7"></a>

## EVID-7 · Distribution-ack reads fail closed to 'nothing here' via a module-level latch and blanket catches, so a missing record is indistinguishable from no record

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/distributionAcks.ts:30-40`, `lib/distributionAcks.ts:57-73`, `lib/distributionAcks.ts:76-97`, `components/documents/DistributionAcks.tsx:106`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and worse than stated: `resetAckSchemaFlag()` (lib/distributionAcks.ts:31) has zero callers anywhere in the repo (not even a test), so once the latch flips it stays flipped for the life of the module instance. A PGRST204 ("column not found in schema cache") from post-deploy drift is indistinguishable to the UI from "no acknowledgments requested", and the recipient's acknowledge bar disappears because getMyPendingAck returns null.

**Mechanism.** `ackSchemaMissing` is a module-scope boolean set on any error matching a broad predicate — which includes generic PostgREST codes PGRST204 and 42703 (schema-cache and undefined-column) that also fire for transient schema-cache staleness after a deploy, not just for a genuinely unapplied migration. Once set, `listAcksForVersion` and `getMyPendingAck` short-circuit to `[]` / `null` for the remainder of the page session with no further queries. Both functions additionally wrap everything in `try { ... } catch { return []; }` / `catch { return null; }`, so any other failure — an RLS denial, a network blip — also renders as an empty roster rather than an error.

**Failure scenario.** After a deploy leaves the PostgREST schema cache momentarily stale, a controller opens the inspector on a safety-critical revision. The first ack query returns PGRST204, the latch flips, and for the rest of that session every document shows 'no acknowledgments requested' and no recipient sees the 'I have this revision' bar (getMyPendingAck returns null, so the acknowledge affordance never renders — components/documents/DistributionAcks.tsx:106 is only reachable when myPending is non-null). No error toast, no console warning distinguishable from normal operation. The controller reasonably concludes distribution was never requested for these documents and does not chase the twelve people who are in fact outstanding.

**Evidence.**

```
lib/distributionAcks.ts:30-40 —
  let ackSchemaMissing = false;
  ...
  function isMissingAckSchema(err: unknown): boolean {
    const e = err as { code?: string; message?: string } | null;
    if (!e) return false;
    if (e.code === "42P01" || e.code === "PGRST205" || e.code === "PGRST204" || e.code === "42703") return true;

lib/distributionAcks.ts:57-72 —
  export async function listAcksForVersion(versionId: string): Promise<DistributionAck[]> {
    if (ackSchemaMissing) return [];
    try {
      ...
      if (error) {
        if (isMissingAckSchema(error)) { ackSchemaMissing = true; return []; }
        throw new Error(error.message);
      }
      ...
    } catch {
      return [];
    }
  }
```

**Chain reaction.** The write path is deliberately loud — requestAcks throws 'Acknowledged distribution needs the 20260825 migration applied first.' — but the read path is silent, so the asymmetry means the operator learns about the problem only if they try to request acks, never if they are merely looking at whether acks exist. An auditor shown this screen is being shown an absence of evidence rendered as evidence of absence.

> **Verifier correction.** One part is mechanism-plausible but not observable from the repo and should be marked SUSPECTED within the finding: that PGRST204/42703 'also fire for transient schema-cache staleness after a deploy'. That is a statement about PostgREST runtime behavior against a live database, which this repo cannot demonstrate. The latch-and-swallow behavior itself is CONFIRMED by reading.

**Done when.**

- [ ] listAcksForVersion and getMyPendingAck distinguish 'schema not migrated' (a named, surfaced state the UI renders as an explicit banner) from 'no acks requested' (an empty list) from 'query failed' (an error surfaced to the user)
- [ ] The ackSchemaMissing latch is scoped to a genuinely permanent condition (42P01 / PGRST205 only) or removed in favour of a schema check, so a transient PGRST204 does not blind the session
- [ ] The DistributionAcks panel renders a distinct 'could not load the distribution record' state rather than the empty state on failure
- [ ] A test asserts that a read error does not render as an empty roster

---

<a id="evid-8"></a>

## EVID-8 · Non-response is not recorded on the record itself — reminder history is a single last-write-wins timestamp, and the durable evidence of nagging lives only in purgeable notification rows

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/reviewControl.ts:585`, `lib/distributionAcks.ts:220-240`, `lib/distributionAcks.ts:257-272`, `supabase/migrations/20260825_work_packages_acks.sql:99-116`, `lib/acknowledgments.ts:507`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Correct on every part. scanDistributionAcks writes nothing back to distribution_acks — nine nags leave nine notification rows and no trace on the record — and app/api/admin/purge/route.ts:40-44 lists `notifications` as a purge target ("Bell items the recipient has already read. Disposable once read and aged"), so the only evidence of the nagging is expressly disposable. No logAuditAction call exists on any of these reminder paths.

**Mechanism.** Where the system chases non-response, it stores only a watermark. document_review_signoffs has a single `notified_at` that scanReviews overwrites on every nag (`update({ notified_at: new Date().toISOString() })`), so after six reminders the row shows one date. document_acknowledgments does the same (lib/acknowledgments.ts:507). distribution_acks stores requested_at and acknowledged_at and nothing else — no nag counter, no last_nagged_at; scanDistributionAcks derives its cooldown by querying recent `notifications` rows and reading `metadata.ackRequest` / `metadata.ackEscalation`. So the only place the sequence of reminders and escalations survives is the notifications table — which finding 8 shows gets read_at stamped by the system and is explicitly purge-eligible at MIN_DAYS = 7.

**Failure scenario.** Twelve months after issue, a regulator asks 'you say the operator never confirmed receipt of Rev 5 — show me what you did about it'. The distribution_acks row shows requested_at and a NULL acknowledged_at: it proves nobody confirmed, but proves nothing about the nine reminders and the two escalations to the requester, because those existed only as notification rows that a purge removed. The review sign-off row shows a single notified_at that is the date of the LAST nag, which reads as though only one reminder was ever sent. There is no field anywhere that records 'this person was reminded N times, escalated on date X, and never responded' as a durable fact of the record.

**Evidence.**

```
lib/reviewControl.ts:585 —
      await supabase.from("document_review_signoffs").update({ notified_at: new Date().toISOString() }).eq("id", r.id as string);

lib/distributionAcks.ts:227-239 (cooldown derived from notification rows, not from the ack row) —
    const { data: recent } = await supabase
      .from("notifications")
      .select("user_id, resource_id, metadata")
      .eq("org_id", orgId)
      .in("kind", ["ack_requested", "ack_overdue", "doc_superseded"])
      .gte("created_at", cooldownIso);
    ...
      if (meta.ackRequest) recentlyNagged.add(key);
      if (meta.ackEscalation) recentlyEscalated.add(key);

supabase/migrations/20260825_work_packages_acks.sql:110-113 (no nag/escalation columns) —
  requested_by UUID NOT NULL,
  requested_by_name TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
```

**Chain reaction.** This is the precise substrate the 'nobody acted and the system advanced anyway' requirement needs, and the honest answer is: the FACT of non-response is durable (a NULL acknowledged_at / a pending sign-off), the DILIGENCE around it is not. Compounding this, the one place the system advances on pure silence — auto-activating an alternate reviewer after timeoutDays (lib/reviewControl.ts:555-561) — routes its audit through logAuditAction with `userId: ""` and therefore produces no audit row at all (finding 1).

**Done when.**

- [ ] distribution_acks and document_review_signoffs / document_acknowledgments carry durable non-response fields: nag_count, first_notified_at, last_notified_at, escalated_at, escalated_to
- [ ] Every reminder and escalation writes an audit_logs row (durable, append-only) in addition to the notification row
- [ ] Any state change driven by non-response (alternate activation, timeout escalation) writes an audit row attributed to a real system actor UUID, and that write is verified rather than best-effort
- [ ] A single query can produce, for a given revision and person: requested on X, reminded on X1..Xn, escalated on Y, never responded as of Z

---

<a id="evid-9"></a>

## EVID-9 · Notification delivery evidence stops at 'handed to Resend', and a recipient with email preferences off produces no row at all

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:628-648`, `app/api/notifications/send-queued/route.ts:140`, `app/api/tickets/workflow-action/route.ts:363-383`, `app/api/tickets/workflow-action/route.ts:401-403`, `app/api/admin/purge/route.ts:40-44`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified: there is no Resend webhook or delivery-event handler anywhere under app/api (the only Resend reference in the repo is the send call itself), so nothing ever downgrades a 'sent' row on a later bounce, and a recipient with email_enabled=false leaves no evidentiary row at all — the 'suppressed' status value is unused.

**Mechanism.** email_notifications records `status` ('queued','sending','sent','failed','suppressed'), `attempt_count`, `last_attempted_at`, `sent_at` and `error_message`. 'sent' means the POST to https://api.resend.com/emails returned OK — nothing more. Two searches (a directory scan of app/api for any webhook/resend/email route, and a grep for resend.com/api.resend across all .ts) found exactly one Resend call site and only one webhook route in the codebase, /api/stripe/webhook; there is no inbound handler for delivery, bounce, complaint or open events. Separately, the recipient filter runs BEFORE the insert: `recipients.filter((uid) => emailByUid.has(uid) && wantsEmail(uid))`. A recipient whose notification_preferences has email_enabled = false, digest_frequency = 'never', or the relevant per-event flag off is dropped silently — no row with status 'suppressed', no row at all. And /api/admin/purge deletes email_notifications rows with status IN ('sent','suppressed') older than MIN_DAYS = 7.

**Failure scenario.** The final-approval email to the responsible engineer is queued and Resend accepts it; the engineer's corporate mail server then rejects it (full mailbox, quarantine, address change). email_notifications says status='sent', sent_at=<t> and the system will assert for the rest of the record's life that the engineer was emailed. Nobody is ever told it bounced. In a second variant, the engineer had turned email_on_assignment off two years earlier; there is no row whatsoever, so the record cannot distinguish 'we emailed them and they ignored it' from 'we never emailed them' from 'they opted out' — three legally very different stories. Eight days later a purge can remove whichever rows do exist.

**Evidence.**

```
supabase/schema.sql:640-645 —
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','suppressed')),
  attempt_count INT NOT NULL DEFAULT 0,
  last_attempted_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  error_message TEXT,

app/api/tickets/workflow-action/route.ts:382-384 —
  const emailRows = recipients
    .filter((uid) => emailByUid.has(uid) && wantsEmail(uid))
    .map((uid) => ({

app/api/admin/purge/route.ts:41-44 —
    label: "Delivered email queue rows",
    reason: "Outbound emails already sent or suppressed. The delivery is done; the queue row is a disposable byproduct.",
```

**Chain reaction.** Combined with finding 8 (in-app read_at corrupted and purgeable), this is the whole of the 'we told them' substrate. The operator's answer to 'prove you notified the responsible engineer' rests on a row that (a) proves only that a third-party API accepted a payload, (b) may not exist because of a preference set years earlier, and (c) is explicitly classified as a disposable byproduct by the product's own purge policy.

> **Verifier correction.** 'No row at all' is true only of email_notifications. The in-app bell row is inserted for every recipient unconditionally, before and independent of the email filter — app/api/tickets/workflow-action/route.ts:335-345 inserts one notifications row per recipient in `recipients`, with no preference test. So a preference-suppressed recipient still leaves a durable per-recipient notice row; what is missing is a 'suppressed' marker in the email queue explaining why no email went out. Combined with the absence of bounce/complaint webhooks this is a real evidentiary ceiling, but MEDIUM rather than HIGH.

**Done when.**

- [ ] A Resend webhook route ingests delivered/bounced/complained events and stamps them on the email_notifications row, so 'sent' and 'delivered' are distinct facts
- [ ] A preference-suppressed recipient still gets a row with status 'suppressed' and the suppressing reason, so non-delivery is recorded rather than absent
- [ ] email_notifications rows tied to approval, acknowledgment and distribution events are excluded from the purge, or their retention is governed by the record's retention policy rather than a 7-day floor
- [ ] A single query can produce, per recipient per event: queued / sent / delivered / bounced / suppressed-by-preference / never-attempted

---

<a id="evid-10"></a>

## EVID-10 · The one-click Compliance Evidence Pack omits every signature, sign-off, acknowledgment and distribution ack, while asserting it is assembled from the immutable audit trail

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/evidencePack.ts:18-32`, `lib/evidencePack.ts:125`, `lib/evidencePack.ts:62`, `components/documents/InspectorPanel.tsx:950`, `components/navigation/GlobalCommandPalette.tsx:205`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the only four tables queried are documents/document_versions/document_holds/audit_logs, so no signature, review sign-off, acknowledgment or distribution-ack row reaches the pack; the audit section is hard-capped at 1000 rows with no truncation notice; and both callers (InspectorPanel.tsx:950, GlobalCommandPalette.tsx:205) invoke the same gatherEvidence. Signatures appear only indirectly, via the best-effort ESIGNATURE_CAPTURED audit mirror that EVID-11 shows can be dropped.

**Mechanism.** `gatherEvidence` issues exactly four queries: documents, document_versions, document_holds and audit_logs (resource_type='document', limit 1000). It never reads e_signatures, document_review_signoffs, document_acknowledgments, distribution_acks, download_audits or notifications. The rendered pack therefore shows revision lineage (with the free-text drawn/checked/approved names and a truncated file_hash), holds, and the raw audit rows — and nothing that answers 'who signed', 'who was assigned to acknowledge', 'who confirmed receipt' or 'who holds a printed copy'. The footer states the pack 'is assembled from the immutable audit trail and revision records', and audit_logs is capped at the most recent 1000 rows with no indication in the output when that cap truncated the trail.

**Failure scenario.** An auditor asks for the evidence on DWG-1042 Rev 4. The operator clicks 'Evidence pack for this document' and produces a PDF whose Approved column reads a name someone typed (finding 4), whose audit section may be silently truncated at 1000 rows, and which contains no signature block, no reviewer roster, no acknowledgment roster and no distribution confirmations — even where all four exist in the database and would have been the strongest evidence available. The operator does not know the pack is incomplete, because the document promises completeness.

**Evidence.**

```
lib/evidencePack.ts:19-24 —
  const docQ = supabase.from("documents").select("*").eq("id", documentId).maybeSingle();
  let versionsQ = supabase.from("document_versions").select("*").eq("record_id", documentId).order("created_at", { ascending: true });
  ...
  const holdsQ = supabase.from("document_holds").select("*").eq("document_id", documentId).order("opened_at", { ascending: true });
  const auditQ = supabase.from("audit_logs").select("*").eq("resource_type", "document").eq("resource_id", documentId).order("timestamp", { ascending: true }).limit(1000);

lib/evidencePack.ts:125 —
  <div class="footer">Generated ${new Date().toLocaleString()} · ManufacturingOS · This pack is assembled from the immutable audit trail and revision records for ${number}.</div>
```

**Chain reaction.** This is the artifact the product positions as 'your exit story is one click' for ISO-9001 / PSM evidence (lib/evidencePack.ts:6-7). Because it is the operator's default answer to a regulator, its omissions define what the operator believes it can prove — and it happens to omit precisely the two things the regulator's question asks for: signature-backed approval, and who saw the drawing and when. It also never joins the ticket that originated the change, so the drafting-request approval chain does not appear in the document's evidence pack at all.

> **Verifier correction.** 'Shows nothing that answers who signed' is too strong. Acknowledgment signatures DO surface in the pack's audit-trail section: lib/acknowledgments.ts:429-436 records them with `resourceType: "document", resourceId: input.documentId`, and lib/eSignatures.ts:139-149 mirrors that into audit_logs as ESIGNATURE_CAPTURED with `details: { intent, statement, signerName }` — which the pack's `resource_type = 'document'` query picks up, alongside ACK_WAIVED (lib/acknowledgments.ts:486), REVIEW_REQUESTED (lib/reviewControl.ts:234) and REVISION_PUBLISHED_AFTER_REVIEW (:487). What is genuinely absent is: review sign-off signatures (recorded with `resourceType: "document_version"`, lib/reviewControl.ts:293, so outside the filter), the assignee roster itself, distribution_acks, and download_audits — plus the fact that every one of those mirrored audit rows is subject to finding 1's silent-drop. Note also that the sibling project-level pack does include receipts (gatherProjectEvidence queries transmittals, lib/evidencePack.ts:146-153), so the omission is specific to the document pack.

**Done when.**

- [ ] gatherEvidence additionally reads e_signatures, document_review_signoffs, document_acknowledgments, distribution_acks and download_audits for the document and its versions, and the pack renders each as its own section
- [ ] The pack renders the originating drafting ticket's approval history and any bound signature
- [ ] The audit_logs query pages beyond 1000 rows, or the pack states explicitly when the trail was truncated
- [ ] The footer's claim is corrected to state what the pack does and does not include, and flags revisions whose approval is a typed name rather than a signature

---

<a id="evid-11"></a>

## EVID-11 · The signature→audit mirror and the acknowledgment roster update are both best-effort with the error discarded — a signature can exist with no timeline entry, or a roster can stay 'pending' after a successful signature with nobody told

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/eSignatures.ts:139-149`, `lib/acknowledgments.ts:439-446`, `lib/reviewControl.ts:301-304`, `components/permissions/PermissionDrawer.tsx:291-302`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Every cited write discards its outcome. The zero-row scenario is real: lib/acknowledgments.ts:326-338 does set status 'void' on pending rows for a superseded revision, and the fallback UPDATE at 443-446 filters on `status = 'pending'`, so a voided roster row matches nothing and the call still returns without error. maybeNotifyComplete then counts remaining pending rows and can even declare the roster complete.

**Mechanism.** Three separate best-effort patterns sit on the evidentiary path. (1) `recordSignature` mirrors the signature into audit_logs with an explicit `.catch(() => { /* audit best-effort */ })` — and because logAuditAction never throws (see finding 1), that catch is decoration on top of an already-silent write. (2) `recordAcknowledgment` writes the roster patch `{ status: "acknowledged", signature_id, acknowledged_at }` and discards the result entirely — no `{ error }` destructure, no row-count check, and the fallback branch does not filter on the signer, so a zero-row update is indistinguishable from success. (3) `recordReviewSignoff` does the same for document_review_signoffs. The UI (SignatureCaptureHost.tsx:65) then shows 'Signed — recorded with your name and timestamp' on the strength of the e_signatures insert alone.

**Failure scenario.** An operator completes the read-and-understood ceremony on Rev 5. The e_signatures row is written. The document_acknowledgments UPDATE matches zero rows — because the roster row was voided by a concurrent recompute (lib/acknowledgments.ts:326-338 sets status 'void' on republish), or because the hardened doc_ack_update policy denied it. The operator sees a green 'Signed' toast. The ack roster still reads 'pending' for them, `maybeNotifyComplete` finds outstanding rows and never fires, the daily scan keeps nagging them for a document they signed, and the AckPill shows an under-count. Conversely the reverse asymmetry: a signature exists in e_signatures with no matching audit_logs ESIGNATURE_CAPTURED row, so the document timeline an auditor reads shows no sign of the approval at all.

**Evidence.**

```
lib/eSignatures.ts:139-149 —
  // Mirror into the audit trail so it appears in the resource timeline.
  await logAuditAction({
    ... action: "ESIGNATURE_CAPTURED",
    ...
  }).catch(() => { /* audit best-effort */ });

lib/acknowledgments.ts:439-446 —
  const patch = { status: "acknowledged", signature_id: sig.id, acknowledged_at: nowIso, updated_at: nowIso };
  if (input.rosterId) {
    await supabase.from("document_acknowledgments").update(patch).eq("id", input.rosterId);
  } else {
    let q = supabase.from("document_acknowledgments").update(patch)
      .eq("document_id", input.documentId).eq("assignee_user_id", input.signerUserId).eq("status", "pending");
    if (input.documentVersionId) q = q.eq("document_version_id", input.documentVersionId);
    await q;
  }
```

**Chain reaction.** The same swallow-the-result idiom is used for client-written audit rows elsewhere — components/permissions/PermissionDrawer.tsx:302 ends its NODE_ACL_CHANGED insert with `.then(() => undefined, () => undefined)` under a comment promising 'a permission change must always be reconstructable'. The pattern means the operator's confidence in the trail is calibrated to toasts, not to writes.

> **Verifier correction.** One sub-claim is factually wrong and should be dropped: 'the fallback branch does not filter on the signer' is not what the code does — lib/acknowledgments.ts:444 chains `.eq("document_id", input.documentId).eq("assignee_user_id", input.signerUserId).eq("status", "pending")`, so the fallback is scoped to the signer's own pending row. The unscoped-by-signer branch is the *rosterId* branch (:441, `.eq("id", input.rosterId)`), and that one is now backstopped by RLS — supabase/migrations/20260828_integrity_hardening.sql item 3 limits document_acknowledgments updates to the assignee's own row, so a wrong rosterId is denied (silently, which is the finding's real point). Severity MEDIUM: the roster patch normally targets the caller's own row and succeeds; the defect is that a zero-row or denied write is indistinguishable from success.

**Done when.**

- [ ] recordAcknowledgment and recordReviewSignoff destructure `{ error, data }`, request the affected row back (`.select()`), and surface a hard error to the signer when zero rows are updated
- [ ] The signature insert and the roster/sign-off update happen in one server-side transaction (or an RPC) so the two stores cannot diverge
- [ ] The ESIGNATURE_CAPTURED audit mirror is either transactional with the signature or dead-lettered on failure — never `.catch(() => {})`
- [ ] A reconciliation query/test proves every e_signatures row with intent Approved/Acknowledged has a matching roster row and audit row

---

<a id="evid-12"></a>

## EVID-12 · The ticket workflow audit row is written after the state change, non-transactionally, with its error discarded, and its details omit the deliverable rev and any artifact identity

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/tickets/workflow-action/route.ts:163-191`, `app/api/tickets/workflow-action/route.ts:213-223`, `lib/ticketTransitions.ts:247-253`, `types/schema.ts:1038-1047`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the audit insert is a separate, later, unchecked round-trip against a different table (no transaction), and its details carry only from/to/label — no deliverable_rev, no attachment id/hash. Partial mitigation: `historyEntry.action = ... issued Rev ${updates.deliverable_rev}` is written inside the same atomic tickets UPDATE, so the rev survives in the ticket's mutable history JSONB — but not in the immutable audit trail.

**Mechanism.** The route commits the ticket UPDATE (line 163), returns 500 or 409 on failure, and only then inserts the audit row — with the result discarded, so the same silent-failure mechanism as finding 1 applies (there is no `{ error }` destructure here either). The two writes are separate PostgREST round-trips against different tables with no transaction, so a process termination, timeout, or transient DB error between them leaves a committed approval with no audit row. Separately, the audit `details` payload is `{ from: ticket.status, to: newStatus, label: action.label }` — it does not carry `updates.deliverable_rev` (which the same function just computed at ticketTransitions.ts:250), nor the attachment id, filename, url or hash of the file being approved. TicketAttachment (types/schema.ts:1038-1047) has no hash and no version field at all.

**Failure scenario.** An engineer clicks 'Approve final'. The ticket flips to PENDING_IFC and deliverable_rev becomes '2'. The function instance is recycled (or the audit insert hits a transient error) before line 214 completes. The route already returned nothing to distinguish this case. The regulator later asks 'show me the audit record of the approval of Rev 2': audit_logs has no TICKET_ENGINEER_APPROVE_FINAL row, and the only trace is the tickets.history JSONB — which finding 2 shows any org member can rewrite. Even in the happy path, the surviving audit row says an approval moved the ticket from PENDING_FINAL_APPROVAL to PENDING_IFC but does not say WHICH revision or WHICH file was approved, so an approval cannot be matched to the bytes that went to the field.

**Evidence.**

```
app/api/tickets/workflow-action/route.ts:213-223 —
  // Audit — server-written, cannot be skipped by the client.
  await supabaseAdmin.from("audit_logs").insert({
    action: `TICKET_${action.action.toUpperCase()}`,
    resource_id: body.ticketId,
    resource_type: "ticket",
    org_id: ticket.orgId,
    user_id: caller.id,
    user_email: callerEmail,
    user_role: callerRole,
    details: { from: ticket.status, to: newStatus, label: action.label },
  });

lib/ticketTransitions.ts:247-252 —
  case "engineer_approve_final":
      updates.status = "PENDING_IFC";
      updates.engineer_approved_at = now;
      updates.deliverable_rev = issuedRevLabel(ticket.revisionCount);
```

**Chain reaction.** No e-signature is captured anywhere on the ticket approval path — `recordSignature` has exactly four call sites (SignatureCaptureHost, lib/reviewControl.ts:292, lib/acknowledgments.ts:429) and none of them are reachable from app/api/tickets/workflow-action or the requests page. So a drafting-request approval, the flow that puts a construction package in the field, produces no signature, no content hash, and an audit row that names neither the revision nor the file.

> **Verifier correction.** Two qualifiers. (1) This insert uses supabaseAdmin (service role), so RLS denial is not a live failure mode here — the residual risks are a transient DB/network error or the process dying between the two writes, which is a durability gap rather than an everyday one. (2) The approval is not left with *no* record: the same UPDATE that commits the status change also writes the history entry (lib/ticketTransitions.ts:120-142, including `historyEntry.action = \`${input.actionLabel} — issued Rev ${updates.deliverable_rev}\``) and engineer_approved_at onto the ticket row, so actor, timestamp and issued rev survive the loss of the audit row — subject to that column being client-writable, which is finding 2's problem, not this one. MEDIUM.

**Done when.**

- [ ] The ticket UPDATE and its audit row are written in one transaction (a Postgres RPC) so an approval cannot commit without its record
- [ ] The audit insert's `{ error }` is inspected and a failure is escalated or dead-lettered
- [ ] details carries deliverable_rev, the approved attachment's id/filename and a server-computed content hash of that attachment
- [ ] Approval actions (approve_draft_ifc, engineer_approve_final, approve_minor_correction) require a captured e_signature bound to that attachment before the transition commits

---

<a id="evid-13"></a>

## EVID-13 · Workflow transitions mass-stamp read_at on other users' unread notifications, destroying the only 'who saw it' evidence and making the rows immediately purge-eligible

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/tickets/workflow-action/route.ts:324-332`, `supabase/migrations/20260621_in_app_notifications.sql:26`, `app/api/admin/purge/route.ts:9-11`, `app/api/admin/purge/route.ts:34-38`, `app/api/admin/purge/route.ts:24`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The mechanism is real — the supersede UPDATE stamps read_at across every recipient's row, and a stamped row becomes purge-eligible. Two parts of the claim overstate it: rows are not 'immediately' purge-eligible (the purge also requires created_at older than the ≥7-day cutoff, plus Admin/DocCtrl auth and confirm:true), and read_at is nowhere consumed as evidence — a repo-wide grep shows it is read only by lib/inAppNotifications.ts / lib/inbox.ts to drive the unread bell badge, never by the evidence pack or any receipt surface. The cross-user stamping is also deliberate and documented in the code comment at 317-324 ('retire the old rows for everyone'). Real but low-impact: LOW.

**Mechanism.** `notifications.read_at` is documented as 'null = unread' and is the system's only per-recipient visibility signal. On every ticket transition, fanOut runs a service-role UPDATE that sets read_at = now() on EVERY unread workflow notification for that ticket — across all recipients, with no user filter and no org filter, keyed only on resource_id and the presence of metadata.action. The rows are not deleted or flagged; they are made indistinguishable from notifications a human actually opened. /api/admin/purge then treats `read_at IS NOT NULL` as the safety predicate for deletion, labelling such rows 'Bell items the recipient has already read. Disposable once read and aged', with a floor of MIN_DAYS = 7.

**Failure scenario.** An engineer is notified 'Final approval needed — DWG-1042'. They never open it. Eight days later a coordinator advances the ticket by another route; fanOut stamps read_at on the engineer's untouched row. An Admin/DocCtrl runs the purge with days=7 and the row is deleted. The regulator asks 'show me that the engineer was notified and whether they ever looked at it' and the system can produce nothing — not even the fact that a notification was created. The residual rows that survive are worse than absent: they assert read_at timestamps for people who never opened them, so an operator reading the table will over-state visibility.

**Evidence.**

```
app/api/tickets/workflow-action/route.ts:324-332 —
  try {
    await supabaseAdmin.from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("resource_id", ticketId)
      .is("read_at", null)
      .not("metadata->>action", "is", null);
  } catch (e) {
    console.warn("[workflow-action] superseding stale notifications failed:", e);
  }

app/api/admin/purge/route.ts:9-11 —
//   notifications        — read_at IS NOT NULL        (already-read bell items)
//   email_notifications  — status IN (sent,suppressed) (delivered queue rows)

app/api/admin/purge/route.ts:24 — const MIN_DAYS = 7;
```

**Chain reaction.** This is the substrate the stated 'nobody acted and the system advanced anyway' requirement would have to be built on, and it is actively corrupted: after this UPDATE runs, read_at can mean 'the user opened it', 'the user opened the ticket page' (app/(protected)/requests/[id]/page.tsx:927), or 'the workflow superseded it' — three different facts collapsed into one column with no discriminator. There is no separate delivered_at, seen_at, dismissed_at or superseded_at.

> **Verifier correction.** Two overstatements. 'No org filter' is immaterial — resource_id is the ticket UUID, so cross-org reach is not a real path. More importantly, read_at is not consumed as evidence anywhere: I traced every read_at reference in lib/ app/ components/ (lib/inAppNotifications.ts:170-221, lib/inbox.ts:165, app/(protected)/requests/[id]/page.tsx:927, purge route) and it only drives the unread badge/inbox filter and purge eligibility — no screen or export presents it as 'who saw it', and the purge route's own comment states the lasting record lives in audit_logs. The confirmed harm is narrower: unread rows are silently made purge-eligible at 7 days and the bell's unread state is destroyed for other users. MEDIUM.

**Done when.**

- [ ] Superseding a stale notification writes a distinct column (e.g. superseded_at, or metadata.superseded = true) and never touches read_at
- [ ] read_at is only ever written by an action the recipient took, and the writer is recorded
- [ ] The purge predicate for notifications excludes rows whose read_at was system-stamped, and notifications tied to approval/acknowledgment resources are exempt from purge entirely or retained for the record's retention period
- [ ] A query can answer, per recipient and per notification: created, delivered, seen, acted-on, or never-responded — with each state having its own column

---

<a id="evid-14"></a>

## EVID-14 · drawing_audit_logs keeps one row per (sheet, revision) and is upserted — a 'broken_connectors' verdict can be overwritten with 'passed', including by an AI orchestrator tool

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260929_mention_engine.sql:139-153`, `lib/orchestrator/tools.ts:544-548`, `app/api/knowledge/drawing/route.ts:453-456`, `lib/drawingAuditLog.ts:139-149`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed — one row per (org, sheet, revision) with an overwriting upsert, and no history table, so a prior broken_connectors verdict plus its audit_details defect list is destroyed by any later 'passed' write. Notably the route at 443-451 builds a RANK map so 'a clean sheet must never mask a broken one' — but that severity ranking is applied only within the incoming batch, never against the already-stored row. The orchestrator path does go through `proposal()` (tools.ts:415-426) for human confirmation, but the confirmation text is only "Record <sheet> rev <rev> as passed" — it never discloses that an existing broken_connectors finding will be overwritten.

**Mechanism.** The table has a UNIQUE index on (org_id, sheet_number, revision_code) and both writers use `upsert(..., { onConflict: "org_id,sheet_number,revision_code" })`. There is no history table, no versioning, and no append-only constraint — a second write for the same sheet at the same revision replaces `status` and wholesale replaces `audit_details`, destroying the prior findings list. `audited_at` is not included in the upsert payload (verdictRows in lib/drawingAuditLog.ts:141-148 emits org_id, document_id, sheet_number, revision_code, status, audit_details only), so on conflict the stored audited_at is left at its original value while the verdict changes underneath it. The second writer is `log_audit_completion`, a tool exposed to the AI orchestrator, whose sheet_number, revision and status come from model-generated arguments.

**Failure scenario.** The OPC reference audit records P-101-02 at Rev C as `broken_connectors` with the specific defect list in audit_details. Someone asks the orchestrator assistant to 'mark P-101-02 rev C as reviewed and passed'; the tool upserts status 'passed' with `audit_details: { note: "", by: <uid> }`. The original finding — that a connector on a live P&ID leads nowhere — is gone, with no prior-value record anywhere, and the row still carries the ORIGINAL audited_at so it reads as though the clean verdict was reached at the time of the real audit. `sheetsNeedingAudit` (lib/drawingAuditLog.ts:127-137) then treats the sheet as done and never re-audits it at that revision.

**Evidence.**

```
supabase/migrations/20260929_mention_engine.sql:150-151 —
  CREATE UNIQUE INDEX IF NOT EXISTS drawing_audit_logs_sheet_rev_idx
    ON drawing_audit_logs (org_id, sheet_number, revision_code);

lib/orchestrator/tools.ts:544-548 —
  const { error } = await supabaseAdmin.from("drawing_audit_logs").upsert({
    org_id: ctx.orgId, sheet_number: String(args.sheet_number),
    revision_code: String(args.revision), status,
    audit_details: { note: args.details ?? "", by: ctx.userId },
  }, { onConflict: "org_id,sheet_number,revision_code" });

lib/drawingAuditLog.ts:141-148 (no audited_at emitted) —
  return verdicts.map((v) => ({
    org_id: orgId,
    document_id: v.controlledDocumentId,
    sheet_number: v.sheetNumber,
    revision_code: v.revision,
    status: v.status,
    audit_details: { ...v.details, by: byUserId, knowledgeDocumentId: v.documentId },
  }));
```

**Chain reaction.** The module header for lib/drawingAuditLog.ts frames this table as 'turning a drawing audit into a RECORD' and argues 'An audit you can't cite is an opinion' — but a citable record that can be silently replaced in place is worse than an opinion, because it carries institutional authority. The table is also included in lib/exportTables.ts and lib/dataRestore.ts, so an overwritten verdict propagates into exports and restores as though it were the original.

> **Verifier correction.** Two things soften this materially. (1) The AI path is not autonomous: lib/orchestrator/tools.ts:541-545 calls `proposal("log_audit_completion", ...)` before the write, and `proposal` (tools.ts:408-427) returns `status: "awaiting_confirmation"` unless the exact tool+params fingerprint is already in `ctx.approved` — a human must approve that specific summary first. (2) The table's declared purpose is a scan cache, not a regulated verdict store: the migration header at :136-138 states it exists 'So the connector audit stops re-reading sheets that haven't been revised', and lib/drawingAuditLog.ts:127-136 uses it purely to skip already-audited sheets. Nothing gates a release on it. MEDIUM.

**Done when.**

- [ ] drawing_audit_logs is append-only: each audit run inserts a new row and the 'current verdict' is a view over the latest per (sheet, revision), or overwrites are recorded in a history/superseded table
- [ ] audited_at (and an actor/source column distinguishing engine-run from orchestrator-tool from human) is written on every upsert
- [ ] The orchestrator's log_audit_completion cannot downgrade a more severe existing verdict without an explicit human confirmation that is itself recorded in audit_logs
- [ ] A test proves re-recording the same (sheet, revision) preserves the earlier verdict and its findings

---
