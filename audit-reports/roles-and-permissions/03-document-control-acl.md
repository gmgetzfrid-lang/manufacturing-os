# 03 · Document control ACL

The per-file / per-subfolder grant model — the thing you built to escape the
Windows "grant the whole directory" problem.

**Headline: you solved it.** The model is materially better than NTFS. This
report is about the three places it does not behave the way the design says.

**5 findings** — 0 CRITICAL, 2 HIGH, 3 MEDIUM.

> See [`../README.md`](../README.md) for the resolution protocol. Line numbers
> drift — **match on the quoted code.**

---

## What the model actually does

| Capability | NTFS | Here |
|---|---|---|
| Grant one file without granting its folder | No — inherited ACE or break inheritance wholesale | **Yes** — a document carries its own `acl`, and `inherit: false` breaks the chain at that node |
| See a file inside a folder you cannot browse | No | **Yes** — `visibility: 'hidden' \| 'private'` plus an explicit `discover` grant (`canBlindDrill`) |
| Time-boxed grants | No (needs external tooling) | **Yes** — `AccessRule.expiresAt`, evaluated on read |
| Grant to a group | Yes (AD groups) | **Yes** — `team` subject, and `user` / `role` / `org` |
| Enforced below the UI | Yes (kernel) | **Yes** — `RESTRICTIVE` RLS policies calling `node_visible()` |
| Deny that beats allow | Yes | **Yes** — `denied` wins, and an `admin` grant does not override an explicit deny |

The chain is precomputed into `acl_index` — a flattened, chain-merged bucket —
so the database can evaluate a single JSONB column instead of walking the tree
on every row. That is the right shape.

**Where it is enforced:** `documents_acl_select` and `collections_acl_select`
(`supabase/migrations/20260708_acl_rls_enforcement.sql:85-92`), both
`AS RESTRICTIVE FOR SELECT`, so a row must pass **both** the permissive org
policy and the ACL policy. A direct API call cannot route around it.

---

## DOCACL-1 · Role-based ACL rules match the primary role only

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control
- **Locations:**
  - `supabase/migrations/20260708_acl_rls_enforcement.sql:58-59` — `SELECT role INTO v_role FROM org_members WHERE uid = auth.uid() … LIMIT 1`
  - `supabase/migrations/20260708_acl_rls_enforcement.sql:74-75` — teams, by contrast: `SELECT array_agg(team_id::text) INTO v_teams FROM team_members`
  - `lib/acl.ts:69-70` — the TypeScript side does the same: `case "role": return !!ctx.role && ctx.role === (id as Role)`
  - `lib/acl.ts:20` — `SubjectContext.role?: Role` — singular, no `roles` array
- **Related:** `ROLE-1`, `ADD-1`
- **Re-verified:** hardening pass — **SURVIVES**. `SELECT role INTO v_role FROM org_members … LIMIT 1` (`20260708_acl_rls_enforcement.sql:58-59`) — singular column, so a role held only in `roles[]` matches no ACL rule.

**Mechanism.** `node_visible` is defined once, in `20260708`, and never
redefined. It reads a single `role` column. Teams in the same function are read
as an **array** and matched against all of them — so the function already
demonstrates the correct pattern one line away from the defect.

**Failure scenario.** Document Control grants `read` on the pressure-vessel
folder to the role `Drafter`. A senior drafter holds `["Manager", "Drafter"]`;
`primaryRole` resolves to `Manager` (rank 90 > 50). The database compares the
rule against `Manager`, finds no match, and the folder stays invisible **to the
one person the grant was written for**. No error, no warning — the rule is
simply inert.

The inverse is equally live: a rule *denying* a role misses anyone who holds
that role as a secondary, so a deny you believe is in place is not.

This is the same root cause that makes the six department roles unusable as ACL
subjects (`ROLE-1`).

**Remediation.** Make `node_visible` roles-aware, exactly as six newer policies
already are:

```sql
SELECT role, roles INTO v_role, v_roles FROM org_members
  WHERE uid = auth.uid() AND org_id = p_org AND status = 'active' LIMIT 1;
-- then match the bucket against v_role AND every element of v_roles
```

`acl_subject_in_bucket` takes `p_role text` — widen it to `p_roles text[]` and
use the same `bool_or` shape it already uses for teams. Mirror the change in
`lib/acl.ts`'s `SubjectContext` so the two layers agree.

**Done when.**
- An ACL rule naming a role reaches every member holding it, primary or not.
- A deny rule naming a role reaches them too.
- A test covers a member whose primary role is not the granted one.

---

## DOCACL-2 · The default is open — this is deny-by-exception, not grant-by-exception

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control
- **Locations:**
  - `supabase/migrations/20260708_acl_rls_enforcement.sql:52-55` — `IF p_visibility IS NULL OR p_visibility = 'normal' THEN RETURN true;`
  - `supabase/migrations/20260708_acl_rls_enforcement.sql:10-15` — the header, which states this is deliberate: *"FAIL-SAFE by design (chosen to avoid lockouts)"*
  - `app/(protected)/documents/[libraryId]/page.tsx:2450` — new nodes inherit `library.defaultNewAcl`
- **Re-verified:** hardening pass — **SURVIVES**, and the migration says so in its own header: *"FAIL-SAFE by design (chosen to avoid lockouts): visibility 'normal' / NULL -> always visible to org members"* (`:10-11`), implemented at `:52-55`. Recording it as a **deliberate** design choice rather than an oversight is the point — the finding is that the choice is undocumented outside this file.

**Mechanism.** A node whose visibility is `normal` or unset is visible to every
active org member, regardless of any ACL rules on it. Restriction requires
explicitly setting `hidden` or `private`.

This was a considered trade — the comment says so, and avoiding a lockout on a
document-control system is a legitimate reason. But it is the **opposite** of
the NTFS default you were working around, and it changes what "I set up
permissions" means.

**Failure scenario.** An admin opens the permission drawer on a sensitive folder
and adds an allow rule for the QA team, believing they have restricted it. The
folder's visibility is still `normal`, so **every org member can read it** — the
rule added access for a group that already had it. The drawer shows a rule
count; nothing says the node is still open.

At scale this compounds: the whole library is readable by default, and the six
"department" roles someone might reach for to restrict it do not work
(`ROLE-1`).

**Remediation.** Keep the fail-safe default — do not invert it globally, that
risks exactly the lockout it was written to avoid. Instead:

1. **Make the state visible.** In the permission drawer and the explorer, show a
   prominent "Open to all members" badge on any node whose visibility is
   `normal`, next to the rule count. Rules on an open node should render as
   "no effect while this node is open."
2. **Offer the one-click flip.** "Restrict to the people listed below" sets
   `visibility = 'private'` and keeps the rules — make it obvious that this is
   the step that makes a grant meaningful.
3. **Let a library set its own default** so a genuinely sensitive library starts
   private while the general-drawings library stays open.

**Done when.**
- An open node is unmistakably labelled as open wherever its rules are shown.
- Adding a rule to an open node warns that the node is still visible to everyone.
- A library can default new nodes to restricted.

---

## DOCACL-3 · `Admin` and `DocCtrl` always see everything, with no way to scope them

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control
- **Locations:**
  - `supabase/migrations/20260708_acl_rls_enforcement.sql:58-62` — the controller bypass, evaluated before any rule
  - `lib/permissions.ts` — `isControllerRole`
- **Re-verified:** hardening pass — **SURVIVES**. `-- Admin / DocCtrl -> always visible` (`20260708_acl_rls_enforcement.sql:12`), with no scoping mechanism anywhere.

**Mechanism.** The bypass runs before the deny check, so an explicit deny on a
controller has no effect at the database.

**Failure scenario.** This is right for `Admin` — the recoverability rail, and
the same reasoning that protects critical capabilities. It is less obviously
right for `DocCtrl`, which is an operational role you may want several of.

You said you were thinking you could *"assign permissions"* for document
control. As built you cannot scope a controller: every `DocCtrl` sees every
document in the org, including HR files, legal correspondence, and any library
they have no business in. A large site with per-area document controllers cannot
express that — the moment someone needs to control Area 3's drawings they can
read everything.

**Remediation.** Split the concern:
- Keep the unconditional bypass for `Admin` only.
- Give `DocCtrl` a **scope**: a list of library ids (or a team) their controller
  authority applies within. `node_visible` checks the scope before granting the
  bypass; an unscoped controller keeps today's org-wide behaviour so nothing
  breaks on upgrade.
- Surface the scope in the member editor so "document controller for Area 3" is
  something you can actually say.

This is the single change that would make document control assignable the way
you described.

**Done when.**
- A `DocCtrl` can be scoped to one or more libraries.
- An unscoped controller behaves exactly as today.
- The scope is visible in the member editor and in the view-as simulator.

---

## DOCACL-4 · `acl_index` is denormalized and must be rebuilt by the writer — nothing verifies it

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control / data-integrity
- **Locations:**
  - `lib/acl.ts:279` — `buildAclIndexFromChain`
  - `app/(protected)/documents/[libraryId]/page.tsx:600, 2072, 2451` — the three write sites that rebuild it
  - `components/permissions/PermissionDrawer.tsx:274` — the fourth
  - `lib/libraryCollections.ts:94` — `buildAclIndex` on collection create
  - `supabase/migrations/20260708_acl_rls_enforcement.sql:85-92` — the policies that trust it
- **Re-verified:** hardening pass — **SURVIVES**. `acl_index` is rebuilt by whichever writer touches the node (`acl.ts:279` and three separate call sites in `documents/[libraryId]/page.tsx`), and nothing anywhere recomputes or verifies it. Same family as `DB-4`, `DB-5` and `OWN-20`.

**Mechanism.** The database enforces against the **flattened** `acl_index`, not
the source `acl`. That index is rebuilt in application code at five call sites.
There is no trigger, no constraint, and no periodic reconciliation asserting
that `acl_index` still reflects `acl` plus the current parent chain.

**Failure scenario.** Move a folder to a new parent, or edit a library-level
rule, and every descendant's `acl_index` is now stale — it encodes the *old*
inherited chain. Because the database trusts the index, the stale value is what
gets enforced. A revoked grant keeps working, or a new grant does not take
effect, and nothing in the UI reveals the divergence: the drawer renders `acl`,
which is correct, while the database enforces `acl_index`, which is not.

A missed rebuild fails silently in whichever direction the stale data points.

**Remediation.** Move the index derivation into the database — a trigger on
`acl`, `collection_id` and `library_id` that recomputes `acl_index` for the row
and its descendants — so it cannot be forgotten by a new write path. If that is
too large a change, add a reconciliation check (a query comparing recomputed vs
stored for a sample, run in the maintenance cron) that reports drift as a
health signal.

**Done when.**
- Moving a folder updates every descendant's `acl_index`.
- Editing a library rule propagates to descendants.
- Drift between `acl` and `acl_index` is detectable.

---

## DOCACL-5 · The database collapses every action to "any allow", so read vs discover vs download is UI-only

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** access-control
- **Locations:**
  - `supabase/migrations/20260708_acl_rls_enforcement.sql:77-80` — *"Any allow grant (any action) lets the row through; finer read-vs-discover distinctions stay in the app layer."*
  - `supabase/migrations/20260708_acl_rls_enforcement.sql:69-72` — deny checks only `read` and `discover`
  - `lib/acl.ts:133-137` — the app layer, which does distinguish all ten actions
  - `app/api/storage/download-url/route.ts:93-95` — the download route re-checks `acl_index` deny separately, because the row-level policy cannot
- **Re-verified:** hardening pass — **SURVIVES**, quoted from the code: *"Any allow grant (any action) lets the row through; finer read-vs-discover distinctions stay in the app layer"* (`:78-79`). Deny is action-aware (`:69-72`); allow is not.

**Mechanism.** `PermissionAction` has ten values — `discover`, `read`,
`download`, `upload`, `createFolder`, `editMetadata`, `write`, `publish`,
`managePermissions`, `admin`. The database honours the *existence* of any allow,
and only checks deny for `read` and `discover`.

**Failure scenario.** Grant someone `discover` only — the intent being "you may
see that this document exists, but not open it." At the database they pass
`documents_acl_select` and the **row** is returned, including its title, number,
revision and metadata. The app layer is what withholds the content.

That is defensible for a row-level policy, and the download route does add its
own deny re-check. But it means the finer distinctions are enforced by
application discipline rather than by the database, which is the opposite of the
guarantee the rest of the ACL provides — and a new API route that forgets the
re-check inherits the gap silently (the previous run's `SEC-10` is an example of
exactly that shape).

**Remediation.** Either document the boundary explicitly — "row visibility is
coarse by design; content actions are checked at the route, and every route that
serves content must call the shared helper" — and add that helper so there is
one thing to remember, or extend `node_visible` to take the required action and
check the matching bucket. The first is cheaper and probably right; the second
is stronger.

Whichever is chosen, a test should assert that a `discover`-only grant does not
yield document content through any route.

**Done when.**
- The read/discover boundary is either enforced at the database or centralized in one helper every content route uses.
- A `discover`-only grant is proven not to leak content.

---

## Verified sound — do not "fix" these

- **Deny beats allow, and `admin` does not override an explicit deny.**
  `lib/acl.ts:133-137` — an `admin` grant short-circuits *unless* `admin` itself
  is denied, and a specific denied action still wins. This is subtle and correct.
- **Rule expiry is evaluated on every read**, not by a sweep, so an expired
  grant cannot linger (`lib/acl.ts:80-84`).
- **A revoked member keeps no grants.** `isActiveMember === false` clears all
  allows while preserving denies (`lib/acl.ts:113-117`) — defense in depth
  against a stale rule naming a departed uid.
- **`inherit: false` genuinely resets the chain**, including visibility, rather
  than merely adding rules (`lib/acl.ts:176-180`).
- **The policies are `RESTRICTIVE`**, so they AND with the org policies rather
  than widening anything.
- **The permission drawer picks subjects by name**, resolving users and teams
  rather than making an admin type UUIDs (`components/permissions/PermissionDrawer.tsx:165-187`).
- **`lib/__tests__/acl.test.ts` is the best-tested module in this audit** —
  inheritance, expiry, deny precedence, blind drilling and subject types all
  pinned.

---

## Report progress

| ID | Severity | Status |
|---|---|---|
| DOCACL-1 | HIGH | OPEN |
| DOCACL-2 | HIGH | OPEN |
| DOCACL-3 | MEDIUM | OPEN |
| DOCACL-4 | MEDIUM | OPEN |
| DOCACL-5 | MEDIUM | OPEN |
