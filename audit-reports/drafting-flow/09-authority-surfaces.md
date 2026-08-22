# 09 · Authority on every ticket surface

**13 findings** — 3 CRITICAL · 5 HIGH · 5 MEDIUM.

Every door into a ticket, and what each checks. Includes the public verify surface.

> Each finding below survived an adversarial verification pass: a second agent read
> the cited code and tried to refute it. Refuted findings were dropped and are not
> recorded here. Severities marked by that pass override the original.


---


<a id="authz-1"></a>

## AUTHZ-1 · "Approve with Minor Correction" is offered to the exact requester the engineer gate just blocked, and lands on the identical PENDING_IFC / issued-rev outcome

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/workflow.ts:199-234`, `lib/workflow.ts:222-228`, `lib/ticketTransitions.ts:221-235`, `app/api/tickets/workflow-action/route.ts:96-103`
- **Same root cause as** `SM-1` — Also owned as `TIER-7` in [`01-review-tiering.md`](./01-review-tiering.md), which frames the fix. `GAP-111` requires it inside the delivery gate. Fix once; close the rest citing this one.

**Mechanism.** At PENDING_REVIEW, `getActions` deliberately withholds `approve_draft_ifc` from a requester whose role needs engineering sign-off and substitutes `request_final_engineer_approval` — then, outside the if/else, unconditionally pushes `approve_minor_correction` for 'every requester tier by design'. In `computeTransition` the two actions are the same transition: `approve_draft_ifc` sets `status = 'PENDING_IFC'` and `deliverable_rev = issuedRevLabel(...)`; `approve_minor_correction` sets `status = 'PENDING_IFC'` and `deliverable_rev = issuedRevLabel(...)`. The only difference is the history label. Because the API route validates by asking the same `getActions`, the server actively authorizes the bypass — this is not a client-only gate, it is a hole in the policy itself. The same shape repeats at PENDING_FINAL_APPROVAL, where `approve_minor_correction` sits beside `engineer_approve_final` but does not set `engineer_approved_at`, so a ticket can reach IFC with no engineer-approval timestamp at all.

**Failure scenario.** A Maintenance-role requester gets a draft back. The green 'Send for Engineer Final Approval' button requires naming an engineer and waiting. Right below it is 'Approve with Minor Correction', which only asks for a comment. They type 'valve tag reads FV-101, should be FV-1001' and click. The ticket jumps to PENDING_IFC with Rev 1 issued, the drafter folds in the note, and the IFC package goes to the field. No engineer ever touched the drawing, and `engineer_approved_at` is null — so a later PSM audit that queries for engineer sign-off finds nothing while the ticket reads 'issued'.

**Evidence.**

lib/workflow.ts:203-209 (the gate) —
```
            actions.push({
              label: 'Send for Engineer Final Approval',
              action: 'request_final_engineer_approval',
```
lib/workflow.ts:220-228 (the bypass, in the same `if (canActAsRequester)` block, outside the else) —
```
          // The "fix this typo and it's approved" fast path: approve NOW with
          // ... Available to every requester tier by design.
          actions.push({
            label: 'Approve with Minor Correction',
            action: 'approve_minor_correction',
```
lib/ticketTransitions.ts:230-233 —
```
    case "approve_minor_correction":
      updates.status = "PENDING_IFC";
      updates.deliverable_rev = issuedRevLabel(ticket.revisionCount);
```
compare lib/ticketTransitions.ts:221-223 —
```
    case "approve_draft_ifc":
      updates.status = "PENDING_IFC";
      updates.deliverable_rev = issuedRevLabel(ticket.revisionCount);
```

**Chain reaction.** Compounds with finding 4: the org-wide `ticket.requester_review` capability means this bypass is available to any Requester-role member on any ticket, not just their own.

> **Verifier correction.** The PENDING_REVIEW leg is exactly as described and is the load-bearing half. The PENDING_FINAL_APPROVAL leg is overstated: at lib/workflow.ts:264-281 `approve_minor_correction` is inside `if (canActHere)`, where `canActHere = ticket.assignedEngineerId ? isAssignedEngineerIdentity || isManagement : allows('ticket.final_approve') || isManagement` — so only the assigned engineer, a final_approve holder, or management can press it there. It is not "the same shape"; the only real defect at that stage is that `approve_minor_correction` never sets `engineer_approved_at` (lib/ticketTransitions.ts:230-235 vs :247-254), leaving a missing sign-off timestamp rather than a missing engineer. The PENDING_REVIEW bypass does produce a ticket at PENDING_IFC with `engineer_approved_at` null and no engineer ever involved, so the finding's conclusion about the timestamp still holds by a different route.

**Done when.**

- [ ] `approve_minor_correction` is pushed only in the branch where `approve_draft_ifc` is also offered (i.e. only for approvers who may issue for construction); the engineer-routed requester gets a 'send with a correction note' variant that still lands on PENDING_FINAL_APPROVAL
- [ ] At PENDING_FINAL_APPROVAL, `approve_minor_correction` stamps `engineer_approved_at` like `engineer_approve_final` does
- [ ] A test asserts that for a ticket whose `requesterRole` needs engineer approval, no action returned at PENDING_REVIEW produces `newStatus === 'PENDING_IFC'`

---

<a id="authz-2"></a>

## AUTHZ-2 · The tickets table has one blanket RLS policy: any active org member can write any column of any ticket, so every workflow gate is decorative

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:1079-1081`, `app/(protected)/requests/page.tsx:620`, `app/(protected)/requests/[id]/page.tsx:1010-1014`, `supabase/migrations/20260901_db_hard_enforcement.sql:1-24`, `app/api/tickets/workflow-action/route.ts:15-26`
- **Same root cause as** `SM-2`, `PERS-1`, `EVID-1` — One `CREATE POLICY ... FOR ALL USING (...)` with no `WITH CHECK` (`supabase/schema.sql:1079-1081`). Four lenses found it independently. **One migration closes all four.** Fix once; close the rest citing this one.

**Mechanism.** `tickets` has exactly one policy — `CREATE POLICY "tickets_org_access" ON tickets FOR ALL USING (org_id IN (SELECT my_org_ids()))`. There is no WITH CHECK, so Postgres reuses the USING expression for INSERT/UPDATE; there is no column-level GRANT/REVOKE on the table, no CHECK constraint on `status`, and no BEFORE UPDATE trigger. `my_org_ids()` is simply every org where the caller is an active member. The browser talks to this table directly with the anon key plus the user's JWT and already performs UPDATEs today (`priority` on the queue page, `attachments`/`history` on the detail page), which proves ordinary members hold UPDATE. Everything the workflow-action route enforces — state machine, capability policy, engineer routing, CAS on status, the audit row, the notification fan-out — is one `supabase.from('tickets').update({ status: 'PENDING_IFC', deliverable_rev: '2' }).eq('id', …)` away from being skipped entirely. The DB-hardening migration that exists (20260901) explicitly covers holds, checkout force-release and document ACL denies while claiming it 'promotes the LAST app-layer-only enforcement to DATABASE-HARD'; tickets are not in it (grep for 'ticket' in that file returns nothing).

**Failure scenario.** A Drafter who wants their work to stop bouncing opens devtools on /requests, and runs one update against the Supabase REST endpoint setting their own ticket to `status: 'PENDING_IFC'` and `deliverable_rev: '2'`. No engineer ever saw it. The ticket now renders as an approved, issued Rev 2 everywhere: the queue, the traveler sheet, and the public /verify-ticket QR that the contractor in the field scans, which answers LATEST ISSUE in green. No audit_logs row exists because the audit write lives in the API route that was never called.

**Evidence.**

supabase/schema.sql:1079-1081 —
```
-- Tickets
CREATE POLICY "tickets_org_access" ON tickets FOR ALL
  USING (org_id IN (SELECT my_org_ids()));
```
schema.sql:1031-1034 — `CREATE OR REPLACE FUNCTION my_org_ids() ... SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active';`
Proof ordinary members hold UPDATE today — app/(protected)/requests/page.tsx:620:
```
        supabase.from('tickets').update({ priority: 1, last_modified: now }).eq('id', id)
```
supabase/migrations/20260901_db_hard_enforcement.sql:3-4 — `-- Promotes the last app-layer-only enforcement to DATABASE-HARD, removing`  `--  the "a scripted client could still…" caveat:` (its three rails are holds, checkout force-release, and document ACL denies — no ticket rail).

**Chain reaction.** This nullifies findings 2, 3, 4 and 10 as *separate* exploits — but it also means fixing them in TypeScript fixes nothing. It also feeds the ticket-shed deletion path (finding 7), because attachment JSON is part of what a member can rewrite.

**Done when.**

- [ ] A RESTRICTIVE policy (or BEFORE UPDATE trigger) on `tickets` rejects any authenticated UPDATE that changes `status`, `deliverable_rev`, `revision_count`, `assigned_*`, `history`, `archived_at` or `attachments` unless `auth.uid() IS NULL` (service role) — i.e. the workflow-action route becomes the only writer of workflow state
- [ ] INSERT is constrained so `requester_id = auth.uid()` and `status` is the engine's initial status
- [ ] A test proves a member session gets a policy violation for `update({status:'PENDING_IFC'})` on their own ticket and still succeeds for `priority`

---

<a id="authz-3"></a>

## AUTHZ-3 · `requester_role` is free text stamped by the client at INSERT and is the only input to the "must an engineer sign this off" decision

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/new/page.tsx:309`, `supabase/schema.sql:410`, `lib/ticketTransitions.ts:65`, `lib/workflow.ts:37-43`, `lib/workflow.ts:78`, `lib/workflow.ts:198-218`

**Mechanism.** The new-request page INSERTs the ticket row straight from the browser with `requester_role: activeRole`. The column is plain `requester_role TEXT` with no CHECK, no trigger and no RLS WITH CHECK (finding 1). The server-side workflow engine never re-derives it: `rowToTicket` reads `requesterRole: row.requester_role`, and `getActions` computes `const needsEngineerApproval = requiresEngineerApproval(ticket.requesterRole)`. `requiresEngineerApproval` returns false for anything matching Engineer/Admin/Manager/Supervisor/DocCtrl. So the branch at PENDING_REVIEW that exists specifically to stop non-engineers from issuing for construction is keyed on a string the requester wrote about themselves at ticket creation. The workflow-action route re-derives the CALLER's role from org_members (correctly) but takes the requester's claimed role from the row verbatim.

**Failure scenario.** An Operations tech files a request via the API (or a tampered form post) with `requester_role: 'Engineer-4'` — everything else identical, and `requester_id` still their own uid so the identity path grants them requester rights. A drafter produces the drawing. At PENDING_REVIEW the same tech is offered 'Approve (Issue for Construction)' instead of 'Send for Engineer Final Approval', clicks it, and the server agrees because it evaluates the requester's *claimed* role. The ticket moves to PENDING_IFC and the deliverable is issued as Rev 1 with no engineer having reviewed it. The history row will even read the tech's real role, so the forged field is invisible in the record.

**Evidence.**

app/(protected)/requests/new/page.tsx:309 — `        requester_role: activeRole,` (inside the object handed to `supabase.from('tickets').insert(ticketRow)` at :328)
supabase/schema.sql:410 — `  requester_role TEXT,`
lib/workflow.ts:78 — `    const needsEngineerApproval = requiresEngineerApproval(ticket.requesterRole);`
lib/workflow.ts:37-42 —
```
export function requiresEngineerApproval(requesterRole?: Role | string): boolean {
  if (!requesterRole) return true;
  if (isEngineerRole(requesterRole)) return false;
  if (isManagementRole(requesterRole)) return false;
```
lib/workflow.ts:200 — `          if (needsEngineerApproval && !isEng) {`

**Chain reaction.** Same root as finding 1 (client-writable ticket row). Prior audit report audit-reports/roles-and-permissions/06-request-workflow.md:239 filed this as WF-5; it is still present in the code as of this reading.

**Done when.**

- [ ] `requester_role` (and `requester_id`, `requester_name`, `requester_email`) are stamped server-side at insert from the authenticated membership, not accepted from the client
- [ ] `getActions` re-reads the requester's CURRENT role from org_members rather than trusting the row snapshot, or the gate is keyed on an explicit `engineer_approval_required` boolean written by the server at creation
- [ ] A test files a request with a forged `requester_role: 'Engineer-4'` and shows the PENDING_REVIEW action set still routes to `request_final_engineer_approval`

---

<a id="authz-4"></a>

## AUTHZ-4 · /api/storage/resolve issues signed URLs on org membership alone — the ACL enforcement its sibling download-url performs is absent

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/storage/resolve/route.ts:55-64`, `app/api/storage/resolve/route.ts:81-84`, `app/api/storage/download-url/route.ts:35-110`

**Mechanism.** `resolve` authenticates the bearer token, parses an org id out of the key (or from a document_versions/tickets lookup), checks only `org_members … status='active'`, then signs a 1-hour GET for any key. `download-url`, given the same key, additionally resolves the owning document, and for `private`/`hidden` visibility runs `canDiscover` against the ACL chain, plus honours explicit `deny.download` rules from `acl_index`. `resolve` does none of that. Worse, the org attribution is `v?.org_id ?? path.match(/^orgs\/([0-9a-fA-F-]{36})\//)?.[1]` guarded by `if (orgId) {` — a key that cannot be attributed to an org skips the membership check entirely and is signed for any authenticated user. Ticket attachment keys never have a document_versions row, so ticket binaries are governed by membership only on both routes.

**Failure scenario.** A Contractor-role member of the workspace reads the ticket rows they are not supposed to see (finding 8), harvests `attachments[].url` values and any `orgs/<org>/libraries/...` key they can observe, and GETs /api/storage/resolve?path=<key> for each. Every one comes back with `{archived:false, url:<signed>}` — including the bytes of a document whose ACL marks it private/hidden from them, which /api/storage/download-url would have refused with 'Not authorized for this document'.

**Evidence.**

app/api/storage/resolve/route.ts:55-64 —
```
  const orgId = v?.org_id ?? path.match(/^orgs\/([0-9a-fA-F-]{36})\//)?.[1];
  ...
  if (orgId) {
    const { data: m } = await supabaseAdmin
      .from("org_members").select("uid")
      .eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle();
    if (!m) return NextResponse.json({ error: "Not a member of this workspace" }, { status: 403 });
  }
```
versus app/api/storage/download-url/route.ts:48-50 —
```
    // Defense-in-depth (finding H7): membership alone isn't enough for a
    // restricted document. If this key belongs to a document that is private
    // or hidden AND the caller can't discover it under its ACL, deny
```
and :87-89 — `          if (!allowed) {`  `            return NextResponse.json({ error: "Not authorized for this document" }, { status: 403 });`

**Chain reaction.** Combined with finding 8 (any member can read every ticket row, including attachment keys) this is a workspace-wide content egress path for roles like Contractor and Viewer.

> **Verifier correction.** The ACL delta is real and exploitable; the "Worse" clause about un-attributable keys is not a resolve-specific defect and is not confirmed. download-url has the SAME hole in the same shape: app/api/storage/download-url/route.ts:35-36 is `const orgMatch = path.match(/^orgs\/([0-9a-fA-F-]{36})\//); if (orgMatch) {` with the comment at :34 literally saying "Non-org-prefixed keys keep their prior behavior" — every membership AND ACL check on that route is inside that `if`. So resolve is not uniquely worse there; resolve is in fact slightly stricter on attribution because it also consults document_versions.org_id and tickets.org_id before falling back to the prefix. Downgrade that sub-claim to SUSPECTED: lib/storageKey.ts:40-52 does not require an `orgs/` prefix, but I grepped every key-minting site in lib/ and app/ (plot-plans, project-costs, diagnostics, knowledge, output-templates, branding, project-intake, ticket attachments) and all are `orgs/${orgId}/…`, so there is no known object an attacker could name that skips the gate.

**Done when.**

- [ ] `resolve` runs the same document-visibility/`canDiscover` and `deny.download` checks as download-url — ideally by extracting one shared `authorizeStorageKey(user, path)` helper both routes call
- [ ] A key that cannot be attributed to an org is refused rather than signed
- [ ] A test proves a member with no ACL discovery rights on a private document gets 403 from BOTH routes for that document's key

---

<a id="authz-5"></a>

## AUTHZ-5 · Ticket-shed commit deletes R2 objects by keys read verbatim from member-writable attachment JSON, with none of the org-prefix guarding its own restore path applies

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/ticket-shed/commit/route.ts:136-139`, `app/api/admin/ticket-shed/commit/route.ts:186-194`, `app/api/admin/ticket-shed/commit/route.ts:73-88`, `app/api/admin/ticket-shed/restore/route.ts:101`, `app/api/admin/ticket-shed/restore/route.ts:140-144`

**Mechanism.** `keysFor` maps each attachment's `url` straight to an R2 key and `deleteR2Keys(keysToDelete)` issues DeleteObjects against the shared bucket. There is no check that the key starts with `orgs/<orgId>/`, that it belongs to this ticket, or that it is not also referenced by a live document version. The restore route in the same directory proves the authors know the guard is needed: it builds `const prefix = \`orgs/${orgId}/\`` and filters `.filter((k) => k && k.startsWith(prefix))` before writing bytes, explicitly documented as 'no within/cross-org overwrite'. The delete side has no equivalent. Because `tickets.attachments` is writable by any active member (finding 1), the key list is attacker-controlled input reaching a destructive privileged operation. The same list is also what the produce step reads out of R2 and bundles into the ZIP streamed to the admin.

**Failure scenario.** A member appends an attachment `{name:'scope.pdf', url:'orgs/<other-tenant-org-id>/libraries/<lib>/P&ID-2201_RevC.pdf'}` to one of their own long-closed tickets (or points it at their own org's controlled P&ID). Months later an admin runs the routine space-saver: produce bundles the referenced object into the archive ZIP, then commit calls DeleteObjects on that key. The controlled P&ID binary is gone from the bucket; the document row still says Rev C is current, so the library shows a live document whose bytes 404 — and the only copy is inside a ticket archive ZIP belonging to a different workspace.

**Evidence.**

app/api/admin/ticket-shed/commit/route.ts:136-139 —
```
  const keysFor = (t: TombstoneSource): string[] =>
    (Array.isArray(t.attachments) ? t.attachments : [])
      .map((a) => (a?.url || "").toString())
      .filter(Boolean);
```
:186,193 —
```
  const keysToDelete = freeIds.flatMap((id) => keysByTicket.get(id) ?? []);
  ...
  const { deleted: keysDeleted, errors: delErrors } = await deleteR2Keys(keysToDelete);
```
the guard that exists on the other side — app/api/admin/ticket-shed/restore/route.ts:101,142-143 —
```
  const prefix = `orgs/${orgId}/`;
  ...
        .map((a) => (a?.url || "").toString())
        .filter((k) => k && k.startsWith(prefix)),
```

**Chain reaction.** Depends on finding 1 for the write primitive. The identical unguarded pattern feeds the produce step, which turns it into a cross-tenant read (the object's bytes end up in the admin's archive ZIP).

**Done when.**

- [ ] `keysFor` filters to keys starting with `orgs/${orgId}/` exactly as restore does, and drops anything else with a counted, audited reason
- [ ] A key still referenced by a non-archived `document_versions.file_url` or by another live ticket is never deleted
- [ ] The produce step applies the same prefix filter before fetching bytes into the ZIP

---

<a id="authz-6"></a>

## AUTHZ-6 · `ticket.requester_review` grants requester authority org-wide, not per-ticket — any member holding the Requester role can approve anyone else's drafting request

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/capabilityPolicy.ts:72-73`, `lib/capabilityPolicy.ts:141-155`, `lib/workflow.ts:74`, `lib/workflow.ts:198-234`, `lib/workflow.ts:319-323`

**Mechanism.** `policyAllows(policy, cap, role, extraRoles, uid)` takes no resource argument — it can only answer 'does this role hold this capability anywhere in the org'. `canActAsRequester = isRequesterIdentity || allows('ticket.requester_review')`, and the shipped default for `ticket.requester_review` is `["Requester"]`. So the disjunction reads: you are this ticket's requester, OR your headline role is literally 'Requester' — in which case you can act as the requester on EVERY ticket in the workspace. The capability's own description says '(the ticket's own requester always can)', which reads as if the role token were a narrowing, when it is a widening. The same shape applies to `ticket.direct_approve` (default `["Engineer"]`) at PENDING_REVIEW and to FINAL_DRAFT closure. There is no per-library, per-unit or per-project scoping available anywhere in this evaluator, so an org cannot express 'Engineers may approve Unit 200 work only'.

**Failure scenario.** A 40-person refinery gives its operators the Requester role so they can file drawing requests. Any one of them can open any other person's ticket sitting at PENDING_REVIEW — a hot-tap isometric they have never seen — and click 'Approve with Minor Correction' (finding 3) or 'Request Revision'. The approval is recorded as legitimate: the server re-derives it through the same policy and writes the audit row with their name and role, so nothing flags it as out-of-band.

**Evidence.**

lib/capabilityPolicy.ts:72-73 —
```
  { id: "ticket.requester_review", area: "Requests", label: "Requester review",
    description: "Review returned drafts as a requester (the ticket's own requester always can).", defaultRoles: ["Requester"] },
```
lib/workflow.ts:74 — `    const canActAsRequester = isRequesterIdentity || allows('ticket.requester_review');`
lib/capabilityPolicy.ts:141-150 (no resource parameter) —
```
export function policyAllows(
  policy: CapabilityPolicy | null | undefined,
  cap: CapabilityId,
  role?: string | null,
  extraRoles?: string[] | null,
  uid?: string | null,
): boolean {
  const list = policy?.caps?.[cap] ?? DEFAULTS[cap] ?? [];
```

**Chain reaction.** Multiplies finding 3 from 'the requester can skip the engineer' to 'any Requester-role member can skip the engineer on any ticket'.

**Done when.**

- [ ] `policyAllows` takes the resource (ticket/library/unit) and the role token list is evaluated against a scope, or `ticket.requester_review` is redefined as a delegation list (named backups per requester) rather than an org-wide role token
- [ ] The default for `ticket.requester_review` no longer makes a plain Requester an approver on tickets they do not own
- [ ] The capability descriptions in CAPABILITY_DEFS say plainly 'anyone with this role can do this on ANY ticket', so an admin editing the policy sees the blast radius

---

<a id="authz-7"></a>

## AUTHZ-7 · loadCapabilityPolicy fails open to the shipped defaults on any query error, so a narrowed policy silently reverts to wider authority

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/capabilityPolicy.ts:165-196`, `lib/capabilityPolicy.ts:171-178`, `lib/capabilityPolicy.ts:193-195`, `lib/capabilityPolicy.ts:159-160`, `app/api/tickets/workflow-action/route.ts:95-96`

**Mechanism.** The loader destructures `const { data } = await …` and never inspects `error`. supabase-js does not throw on a failed query — it returns `{ data: null, error }` — so a PostgREST timeout, a schema-cache miss, or an RLS denial produces `data === null`, `raw = {}`, `caps = {}`, and every capability resolves to `DEFAULTS`. The surrounding `try/catch` returns `{}` for the same effect. Defaults are the WIDE end of the range for the caps an org is most likely to narrow (`ticket.direct_approve: ["Engineer"]`, `ticket.initial_review: [MGMT, "Engineer"]`, `holds.release: ["*"]`). Because it is the workflow-action route that calls this, a transient DB blip hands back exactly the authority an admin deliberately removed. The 60-second module cache means a narrowing also takes up to a minute to bind, per server instance.

**Failure scenario.** A refinery removes Engineer from `ticket.direct_approve` after an incident, so only the assigned engineer may approve. Postgres has a slow minute during a maintenance window. Every workflow-action request in that window loads `{}`, re-grants direct approval to every Engineer-N in the org, and an engineer with no connection to the job approves a draft to IFC. The audit row records a permitted action; nothing anywhere records that the policy was not actually consulted.

**Evidence.**

lib/capabilityPolicy.ts:171-177 —
```
  try {
    const { data } = await (client ?? supabase)
      .from("org_configurations")
      .select("value")
      .eq("org_id", orgId)
      .eq("key", "capability_policy")
      .maybeSingle();
    const raw = (data?.value as Record<string, unknown> | null) ?? {};
```
:193-195 —
```
  } catch {
    return {}; // defaults apply
  }
```
and the consumer — app/api/tickets/workflow-action/route.ts:95: `  const capPolicy = await loadCapabilityPolicy(ticket.orgId, supabaseAdmin);`

**Chain reaction.** None outbound, but it undermines every mitigation an org applies through the policy layer, including any fix for finding 4 delivered as a default change.

> **Verifier correction.** The mechanism is right and the consequence is understated, not overstated. This is very likely not an occasional-blip failure but a permanent one: lib/capabilityPolicy.ts:172-177 selects the column `value` from org_configurations, but the table is declared at supabase/schema.sql:52-59 as `key TEXT NOT NULL, data JSONB NOT NULL DEFAULT '{}'` — there is no `value` column. I searched two ways for one being added later — `grep -rn "org_configurations" supabase/ --include=*.sql` (every hit is a policy, an index, or a comment; none is an ALTER/ADD COLUMN) and `grep -rn "ADD COLUMN IF NOT EXISTS value|value JSONB" supabase/` (the only `value JSONB` is a different table in 20260920_per_user_keys_real_limits.sql:25). Every other app consumer of this table reads `data` (admin/requests/page.tsx:78, requests/new/page.tsx:131, lib/ticketRouting.ts:49, lib/orgBranding.ts:23). If the deployed DB matches the repo, `select("value")` errors on EVERY call, the ignored `error` yields `data === null`, and every org silently runs on DEFAULTS forever — and saveCapabilityPolicy (:228-234, upserting a `value` key) would fail too, meaning a narrowed policy may never have been persisted at all. The same assumption is baked into supabase/migrations/20260901_db_hard_enforcement.sql:44 `SELECT value INTO v_val FROM org_configurations`. I cannot read the live database, so the column's absence is repo evidence, not runtime proof — but it makes HIGH the right severity rather than MEDIUM.

**Done when.**

- [ ] The loader distinguishes 'no row stored' (use defaults) from 'lookup failed' (propagate), and the workflow-action route refuses the transition — or falls back to the last good cached policy — rather than silently widening
- [ ] `error` from the query is inspected, not discarded
- [ ] A stale cache entry is served in preference to defaults when a refresh fails

---

<a id="authz-8"></a>

## AUTHZ-8 · post_ticket_comment is SECURITY DEFINER, granted to `authenticated`, and takes the comment author's identity from the caller's JSON

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:521-560`, `supabase/schema.sql:544-545`, `supabase/schema.sql:553-558`, `app/api/tickets/comment/route.ts:101-106`

**Mechanism.** The RPC is `SECURITY DEFINER`, lives in `public`, and is `GRANT EXECUTE … TO authenticated`, so PostgREST exposes it at /rest/v1/rpc/post_ticket_comment to any signed-in user. It checks org membership (good) and then writes the caller-supplied JSONB verbatim: `COALESCE((p_comment->>'authorUid')::uuid, auth.uid())`, `p_comment->>'user'`, `p_comment->>'role'`, `COALESCE((p_comment->>'date')::timestamptz, NOW())`, and appends the whole blob to `tickets.comments` with `|| jsonb_build_array(p_comment)`. `p_unread` and `p_watchers` also overwrite the ticket's arrays wholesale. The API route always passes server-derived values, but the route is not the only caller the grant permits. On a drafting ticket the comment thread IS the review record — it is what the requester reads and what the audit tab renders.

**Failure scenario.** A contractor-role member (or any member) posts directly to the RPC with `{"user":"lead.engineer@refinery.com","role":"Engineer-4","authorUid":"<lead engineer's uid>","text":"Reviewed — scope is fine, proceed to IFC","date":"2026-08-01T09:00:00Z"}` and `p_watchers: []`. The ticket thread now shows a backdated engineering blessing attributed to a named PE, the real engineer is silently removed from the watcher list so they never see the ticket again, and `ticket_comments` carries the same forged `author_email`/`author_role` — so the DB copy corroborates the forgery instead of contradicting it.

**Evidence.**

supabase/schema.sql:544-545 —
```
    COALESCE((p_comment->>'authorUid')::uuid, auth.uid()),
    p_comment->>'user', p_comment->>'role',
```
supabase/schema.sql:553-557 —
```
  UPDATE tickets
     SET comments      = COALESCE(comments, '[]'::jsonb) || jsonb_build_array(p_comment),
         unread_by     = COALESCE(p_unread, unread_by),
         watchers      = COALESCE(p_watchers, watchers),
```
supabase/schema.sql:560 — `GRANT EXECUTE ON FUNCTION post_ticket_comment(UUID, JSONB, UUID[], UUID[]) TO authenticated, service_role;`

**Chain reaction.** Also defeats the author check in the comment edit/delete route (app/api/tickets/comment/route.ts:184 `const isAuthor = target.authorUid === caller.id || (!!callerEmail && target.user === callerEmail);`), which trusts the same forgeable fields.

> **Verifier correction.** Two facts the finding omits, one narrowing and one that makes it non-redundant. Narrowing: the function is NOT unguarded — schema.sql:532-535 reads `SELECT org_id, archived_at INTO v_org, v_archived FROM tickets WHERE id = p_ticket_id;` … `IF v_archived IS NOT NULL THEN RAISE EXCEPTION 'ticket is archived; restore it before commenting'; END IF;`, so archived stubs are protected (added deliberately by 20260810_archive_invariants.sql, whose header says exactly "post_ticket_comment is SECURITY DEFINER and callable directly, so the guard belongs in the DB too"). Non-redundant: the `tickets.comments` half of this adds nothing beyond finding 1 (a member can already UPDATE that JSONB directly), but the ticket_comments INSERT half is a real, otherwise-impossible write — ticket_comments has ONLY `ticket_comments_org_select … FOR SELECT` (schema.sql:511-518, and 20260726_ticket_comments.sql:43-44; I grepped every POLICY/GRANT on that table and found no INSERT policy), so RLS denies direct inserts and this RPC is the sole member-reachable path into the audit-rendered comments table, with author_uid/author_email/author_role/created_at all taken from caller JSON.

**Done when.**

- [ ] The function overwrites author identity from `auth.uid()` and the caller's org_members row instead of COALESCE-ing the payload — `authorUid`, `user`, `role`, `date` are ignored when `auth.uid()` is not null
- [ ] `p_unread`/`p_watchers` are merged additively rather than replacing the arrays, or are dropped from the signature and computed in SQL
- [ ] EXECUTE is revoked from `authenticated` and granted to `service_role` only, so the API route is the sole door

---

<a id="authz-9"></a>

## AUTHZ-9 · Additive roles buy no ticket authority: `extraRoles` is never passed by any caller, and the admin routes match the headline role by exact string

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/capabilityPolicy.ts:141-150`, `lib/workflow.ts:65`, `app/api/tickets/workflow-action/route.ts:88`, `app/api/tickets/workflow-action/route.ts:124-130`, `lib/serverAuth.ts:50-58`

**Mechanism.** `policyAllows` has an `extraRoles` parameter, but two differently-shaped searches (identifier grep across lib/app/components, and re-reading every call site) find it referenced only inside capabilityPolicy.ts itself — `getActions` hard-codes `null` for it. The workflow-action route derives `callerRole` from `member.role` (the mirrored headline) and never selects `roles`. Yet the SAME route reads the additive array when validating the picked engineer: `Array.isArray(refMember.roles) && refMember.roles.length > 0 ? refMember.roles : [String(refMember.role ?? "")]`. `authorizeOrgRole` likewise tests `allowedRoles.includes(role || "")`, an exact string match, so the DB helpers (`is_org_controller`, `org_capability_allows`) which DO honour `roles[]` and the app layer which does not disagree about who holds a capability.

**Failure scenario.** A DraftingSupervisor is given Engineer-3 as a secondary role so they can cover scope reviews. `primaryRole` keeps DraftingSupervisor as the headline. A ticket sits at PENDING_ENG_TEAM with no engineer assigned: `allows('ticket.eng_review')` tests only 'DraftingSupervisor' against `["Engineer"]` and returns false, so the ticket has no available actions for them and stalls. Meanwhile the engineer picker WILL offer them as a reviewer (it reads `roles`), so the org believes the delegation works — and any per-person grant an admin issues to fix it is evaluated by `uid` only, silently masking that the role half never worked.

**Evidence.**

lib/workflow.ts:65 —
```
    const allows = (cap: Parameters<typeof policyAllows>[1]) => policyAllows(policy, cap, userRole, null, userId);
```
app/api/tickets/workflow-action/route.ts:88 — `  const callerRole = (member.role as Role) ?? "Viewer";` (the select at :79 asks only for `"role, email, display_name"`)
versus the same file at :125-128 —
```
      const held: string[] = Array.isArray(refMember.roles) && refMember.roles.length > 0
        ? (refMember.roles as string[])
        : [String(refMember.role ?? "")];
      if (!held.some((r) => r.includes("Engineer"))) {
```
lib/serverAuth.ts:57 — `  if (!allowedRoles.includes(role || "")) return { error: "Insufficient role", status: 403 };`

**Chain reaction.** Guarantees drift between the DB rails (20260901's `org_capability_allows` unnests `roles[]`) and the app rails, so the same person is authorized in Postgres and denied in Next.js — or the reverse.

> **Verifier correction.** The title's second clause is FALSE and must be dropped before anyone acts on this. `extraRoles` IS passed by real callers — lib/holds.ts:99-100 does `const extra = (member?.roles as string[] | null) ?? [];` … `if (!policyAllows(policy, cap, role, extra, uid))`, and components/permissions/ViewAsSimulator.tsx:128 does `ok: policyAllows(policy, d.id, who.role, who.roles, who.uid)`. I found these with `grep -rn "policyAllows("` across the repo, which the original audit evidently did not run (its stated searches were an `extraRoles` identifier grep plus re-reading call sites — the identifier grep only finds the definition because callers pass a differently-named variable, which is exactly the trap the two-search rule is meant to catch). The accurate, still-actionable claim is narrower: the TICKET path alone drops additive roles — lib/workflow.ts:65 hard-codes `null`, and app/api/tickets/workflow-action/route.ts:79-88 selects only `"role, email, display_name"` and takes `member.role`. The divergence is therefore internal and sharper than described: the admin's own View-As simulator (which passes who.roles) will show a member holding ticket capabilities that the workflow-action route will refuse, and the DB helper org_capability_allows (20260901_db_hard_enforcement.sql:38-41, `COALESCE(roles, ARRAY[role])`) agrees with the simulator, not with the route.

**Done when.**

- [ ] The workflow-action route selects `roles` and passes it as `extraRoles`; `getActions` accepts and forwards it instead of `null`
- [ ] `authorizeOrgRole` tests the union of `role` and `roles[]`, matching `is_org_controller`
- [ ] A test gives a member a secondary Engineer role with a non-Engineer headline and asserts they get the engineering-review action

---

<a id="authz-10"></a>

## AUTHZ-10 · Drafting-request form configuration: the UI gate and the database gate disagree in both directions

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/admin/requests/page.tsx:64-69`, `app/(protected)/admin/requests/page.tsx:97-100`, `supabase/migrations/20260818_followups_rls.sql:72-82`, `supabase/migrations/20260818_followups_rls.sql:23-31`, `lib/roleCapabilities.ts:53`

**Mechanism.** The page redirects anyone whose headline role is not Admin or DocCtrl, then saves with a browser-side upsert of `org_configurations` key `'drafting'`. The RESTRICTIVE policy for that key requires `is_org_assign_drafters(org_id)` = Admin/Manager/Supervisor/DraftingSupervisor. DocCtrl is not in that set (ROLE_CAPABILITIES gives DocCtrl `doc_control, manage_org_config, view_requests, create_requests` — no `assign_drafters`). So DocCtrl is admitted to the editor and blocked at the write; Manager, Supervisor and DraftingSupervisor are authorized at the database but bounced from the page. Neither gate consults the capability policy that governs every other request-flow authority.

**Failure scenario.** A document controller adds the request types and unit list for a new area, hits Save, and gets 'Failed to save configuration.' with an RLS denial in the console — the only visible cause is the generic catch. They retry, then edit the underlying row by hand or ask an Admin to redo the work. Meanwhile a DraftingSupervisor, whose job is exactly this routing config, cannot reach the screen at all.

**Evidence.**

app/(protected)/admin/requests/page.tsx:66-68 —
```
    if (activeRole && !['Admin', 'DocCtrl'].includes(activeRole)) {
      router.push('/dashboard');
    }
```
:98-99 —
```
        .from('org_configurations')
        .upsert({ org_id: activeOrgId, key: 'drafting', data: settings }, { onConflict: 'org_id,key' });
```
supabase/migrations/20260818_followups_rls.sql:73-79 —
```
CREATE POLICY org_config_key_writes_upd ON org_configurations
  AS RESTRICTIVE FOR UPDATE
  USING (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN is_org_assign_drafters(org_id)
```
:26-30 —
```
    SELECT 1 FROM org_members WHERE uid = auth.uid() AND org_id = p_org AND status = 'active'
      AND (role IN ('Admin','Manager','Supervisor','DraftingSupervisor')
```

**Chain reaction.** None outbound; it is a self-contained authority mismatch, but it is the only writable surface for the request intake vocabulary, so a stuck save pushes people toward hand-editing the config row.

**Done when.**

- [ ] One predicate defines who may edit drafting config — ideally a capability id in CAPABILITY_DEFS — and the page guard, the save, and the RLS policy all derive from it
- [ ] The save surfaces the real RLS error text instead of a generic 'Failed to save configuration.'
- [ ] A test asserts the set of roles that can open the page equals the set the DB policy accepts

---

<a id="authz-11"></a>

## AUTHZ-11 · The issued-IFC and redline attachments are client-supplied objects appended to the ticket without validating that the key belongs to this ticket or org

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/tickets/workflow-action/route.ts:28-39`, `app/api/tickets/workflow-action/route.ts:143-144`, `lib/ticketTransitions.ts:170-171`, `lib/ticketTransitions.ts:280-283`, `app/(protected)/requests/[id]/page.tsx:1160-1173`

**Mechanism.** The route's `Body` accepts `redlineAttachment?: TicketAttachment | null` and `finalAttachment?: TicketAttachment | null` and passes them straight into `computeTransition`, which appends them to the attachments array with no inspection: `if (input.finalAttachment) currentAttachments = [...currentAttachments, input.finalAttachment];`. Nothing checks that `url` starts with `orgs/<ticket.orgId>/tickets/<ticket.ticketId>/`, that the object exists, that `name` matches the key, or that `uploadedBy` is the caller. The route carefully validates every other referenced entity (picked engineers must be active members holding an Engineer role, lines 113-131) — attachments are the gap.

**Failure scenario.** At submit_final the drafter posts `finalAttachment: {name:'ISO-2201-A_Rev2_IFC.pdf', url:'orgs/<org>/tickets/<other-ticket>/1699_supersededRevA.pdf', uploadedBy:'checker@refinery.com'}`. The ticket reaches FINAL_DRAFT showing an IFC package with a correct-looking filename and someone else's name on it, while the bytes served are a superseded revision from an unrelated ticket. Every downstream surface — the requester's acknowledge-and-close screen, the traveler sheet, the print pack — trusts the name and the ticket's issued rev, not the key.

**Evidence.**

app/api/tickets/workflow-action/route.ts:143-144 —
```
    redlineAttachment: body.redlineAttachment ?? undefined,
    finalAttachment: body.finalAttachment ?? undefined,
```
lib/ticketTransitions.ts:280-283 —
```
    case "submit_final":
      updates.status = "FINAL_DRAFT";
      if (input.finalAttachment) currentAttachments = [...currentAttachments, input.finalAttachment];
      break;
```
contrast the validation the same route does perform at :121-130 — `      return NextResponse.json({ error: "Referenced user is not an active member of this workspace" }, { status: 400 });` … `        return NextResponse.json({ error: "The selected reviewer does not hold an Engineer role" }, { status: 400 });`

**Chain reaction.** Feeds finding 7: an attachment key planted this way is later fed to DeleteObjects by ticket-shed commit.

**Done when.**

- [ ] The route rejects any attachment whose `url` is not `orgs/<ticket.orgId>/tickets/<ticket.ticketId>/…` and whose object does not HEAD successfully in R2
- [ ] `uploadedBy`, `uploadedAt`, `size` and `status` are stamped server-side from the authenticated caller, not accepted
- [ ] A test posts submit_final with a foreign key and expects 400

---

<a id="authz-12"></a>

## AUTHZ-12 · The public /api/verify-ticket surface returns internal workflow state and unit to anyone holding a ticket UUID, forever, unrated and unarchived-checked

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/verify-ticket/route.ts:37-54`, `app/api/verify-ticket/route.ts:91-103`, `app/api/verify-ticket/route.ts:6-10`, `app/api/verify/route.ts:60-63`

**Mechanism.** The route is unauthenticated by design and uses the service-role key, bypassing RLS. Its header claims 'The response contains ONLY revision-status facts (ticket number, title, printed rev vs current rev) — no files, no URLs, no people.' The actual payload also returns `unit` (which plant unit the work is in) and `ticketStatus` — the raw internal workflow enum (`PENDING_ENG_TEAM`, `REVISION_REQ`, `PENDING_FINAL_APPROVAL`) — plus `lastActivityAt`. There is no rate limit anywhere in the file or in lib (two searches: grep for rate/rateLimit in both verify routes returned nothing; `ls lib | grep -i rate` returned nothing), no check on `archived_at`, and no revocation: a QR printed once is a permanent read handle on that ticket's status. I checked the enumeration hypothesis and it does NOT hold: the route accepts only `t` matching a strict UUID regex against `tickets.id`, which is `UUID PRIMARY KEY DEFAULT gen_random_uuid()`. The human, sequential `ticket_id` (KE-DDRT-26-0001, from the gap-free counter in 20260724) is returned but is not accepted as input, so the ids are not guessable. The document sibling /api/verify additionally cross-checks that the version belongs to the document; verify-ticket has no analogous binding to check.

**Failure scenario.** A contractor is handed one stamped deliverable for a job in Unit 200. The QR gives them a permanent, login-free poller. They script it weekly and watch `ticketStatus` walk from PENDING_IFC to REVISION_REQ to PENDING_FINAL_APPROVAL — reading the plant's internal engineering churn on that unit long after their contract ends, with the org holding no way to revoke the link and no log that anyone is watching.

**Evidence.**

app/api/verify-ticket/route.ts:9-10 (the claim) —
```
//   * The response contains ONLY revision-status facts (ticket number,
//     title, printed rev vs current rev) — no files, no URLs, no people.
```
:91-101 (what it actually returns) —
```
  return NextResponse.json({
    ticketNumber: t.ticket_id ?? null,
    title: t.title ?? null,
    unit: t.unit ?? null,
    ...
    ticketStatus: t.status ?? null,
    lastActivityAt: t.last_modified ?? null,
```
:49-53 (service role, no archived filter) —
```
  const { data: row } = await sb
    .from("tickets")
    .select("id, ticket_id, title, unit, status, deliverable_rev, revision_count, last_modified")
    .eq("id", ticketId)
    .maybeSingle();
```

**Chain reaction.** Any surface that leaks a ticket UUID (finding 8's unscoped row reads; notification `link: /requests/<id>`; the traveler sheet) turns into a permanent public status feed for that ticket.

**Done when.**

- [ ] `ticketStatus` and `unit` are dropped, or `ticketStatus` is mapped to the same coarse verdict vocabulary the page renders (current / revision underway / superseded)
- [ ] A rate limit per IP and per ticket id is applied, and archived/closed-long-ago tickets answer with a generic 'contact the requester' rather than live state
- [ ] The route comment matches the payload field-for-field

---

<a id="authz-13"></a>

## AUTHZ-13 · Who-sees-which-tickets is enforced only by which query the React page chooses to run

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/page.tsx:279-299`, `supabase/schema.sql:1079-1081`, `app/(protected)/requests/[id]/page.tsx:913`

**Mechanism.** The queue page branches on the caller's roles: management/engineers get `.eq('org_id', activeOrgId)` (everything), Drafters get assigned + the unassigned pool, and everyone else — Requester, Contractor, Operations, Safety, Viewer — gets `.eq('requester_id', uid)`. That narrowing exists only in this client function. RLS on `tickets` is `USING (org_id IN (SELECT my_org_ids()))`, so the rows are all readable to any active member who issues their own query, and the detail page fetches by id with no scoping check of its own (`supabase.from('tickets').select('*').eq('id', ticketId).single()`). A ticket row carries `description`, the full `comments` and `history` JSONB, and `attachments[].url` — the R2 keys.

**Failure scenario.** A Contractor account is added to the workspace so an outside firm can file requests. Their queue shows only their own tickets, which is what the org believes the account can see. One REST call later they have every drafting ticket in the plant: turnaround scope descriptions, unit numbers, the reviewer discussion threads, and the storage keys for every attached drawing — which they then dereference through /api/storage/resolve (finding 6).

**Evidence.**

app/(protected)/requests/page.tsx:279 —
```
        if ((['Admin', 'Manager', 'Supervisor', 'DraftingSupervisor', 'DocCtrl'] as Role[]).some((r) => roles.includes(r)) || roles.some((r) => r.includes('Engineer'))) {
```
:296 —
```
          let q = supabase.from('tickets').select('*').eq('org_id', activeOrgId).eq('requester_id', uid);
```
and the policy that makes the narrowing optional — supabase/schema.sql:1080-1081: `CREATE POLICY "tickets_org_access" ON tickets FOR ALL`  `  USING (org_id IN (SELECT my_org_ids()));`

**Chain reaction.** Supplies the target list and the R2 keys for finding 6, and the ticket ids for finding 12's public verify oracle.

> **Verifier correction.** "the detail page fetches by id with no scoping check of its own" is wrong as written. app/(protected)/requests/[id]/page.tsx:913-917 does carry a check: `const { data } = await supabase.from('tickets').select('*').eq('id', ticketId).single();` … `if (activeOrgId && t.orgId && t.orgId !== activeOrgId) { router.push('/requests'); return; }`. It is an ORG check (redundant with RLS), not a role/requester check — the accurate statement is that the detail page applies no per-role or per-requester narrowing, so any active member who navigates to /requests/<id> renders any ticket in their org including description, full comments/history JSONB and attachments[].url. That is still the finding's substance.

**Done when.**

- [ ] A SELECT policy on `tickets` expresses the same rule the UI does: management/engineer/doc-control roles see the org, drafters see assigned + unassigned, everyone else sees tickets where they are requester, assigned engineer, or a watcher
- [ ] The queue and detail pages rely on that policy rather than re-implementing the filter
- [ ] A test signs in as a Contractor and confirms an unscoped `select('*')` returns only their own rows

---
