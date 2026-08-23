# 02 · Identity collision — two sign-in methods, one person

**6 findings** — 2 HIGH · 4 MEDIUM. **All worked 2026-08-23** — `IDENT-1` is
`BLOCKED` on production queries only this installation can run (the code and
migration halves are done), `IDENT-5` stays `REFUTED`, and `IDENT-6` was
found during resolution and fixed. *(This header previously claimed
1 CRITICAL · 2 HIGH · 2 MEDIUM — stale since the independent pass lowered
`IDENT-1` to HIGH; corrected as part of the resolution pass.)*

Your second question, answered directly: **yes, duplicate profiles in the same
org are possible, and the constraint you have does not prevent them.** Whether it
has already happened is a thirty-second query, given below.

> **One thing here cannot be settled from the repository.** Whether Microsoft
> sign-in and password sign-in resolve to *one* `auth.users` row or *two* is
> decided by a Supabase project setting (automatic identity linking for
> verified-email providers), not by code in this repo. Everything below is
> written so that it matters either way: if they are linked, the collision
> findings are latent; if they are not, they are live today. **Run the query in
> `IDENT-1` before deciding which.**

### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| `UNIQUE(org_id, uid)` on `org_members` | `supabase/schema.sql:33-49` | Genuinely prevents the same *auth user* being doubled in one org. It is doing its job — the gap is that identity is keyed on `uid`, and the collision this area is about happens one level up, between two `uid`s that are the same *person*. |
| `org_members.uid` is the only thing RLS ever trusts | `supabase/schema.sql:1033,1044,1048-1052` | `my_org_ids()` and every policy read `auth.uid()`. No policy resolves a person by email. This is why a duplicate identity produces a *wrong-role* or *no-access* experience rather than a cross-tenant leak — the boundary holds, the person's continuity does not. |
| The duplicate-email case is already detected and refused in one place | `app/(protected)/projects/[id]/page.tsx:870-872` | `.limit(2)` followed by *"Multiple accounts share that email — contact your admin."* Someone met this in production and defended the call site in front of them. It is the strongest evidence in the repo that this is a real condition, and the pattern the other call sites should copy. |
| The no-workspace screen already names this exact confusion | `app/(protected)/layout.tsx:92-96` | *"You may be signed in with a different account than usual (a personal vs. work Microsoft account, for example)."* The product already suspects identity duplication; it just has no mechanism that acts on the suspicion. |

---

<a id="ident-1"></a>

## IDENT-1 · Nothing anywhere makes an email address unique, so two auth identities for one person can hold two memberships with two different roles in the same org

- **Severity:** HIGH
- **Status:** BLOCKED
- **Verification:** CONFIRMED (the absence of the constraint); SUSPECTED (whether duplicates exist in your data today — see the query)
- **Locations:** `supabase/schema.sql:8-16`, `supabase/schema.sql:33-49`, `app/(protected)/projects/[id]/page.tsx:870-872`
- **Re-verified:** hardening pass — **SURVIVES** with its stated split intact — **and the same independence caveat as `SESS-1`.** The absence of any unique constraint on `users.email` is CONFIRMED and mechanically checkable. Whether duplicates exist in production remains SUSPECTED and is not answerable from this repository; the three queries in the finding are still the way to settle it.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **CRITICAL → HIGH** by this pass. The absence claim is confirmed repo-wide and the org_members constraint really does key on uid, not person. Severity lowered to HIGH because the CRITICAL scenario requires two auth.users rows sharing one email, which this repo cannot create: app/api/auth/signup/route.ts:91-100 has no recovery path for a duplicate-email createUser and simply 400s, and app/api/admin/create-user/route.ts:98-106 treats a failed createUser as "email already exists in auth" and recovers the existing id — both are evidence the auth layer already rejects a second identity for the same address. The report itself flags this premise as unverifiable from the repo (02-identity-collision.md, "One thing here cannot be settled from the repository").

**Mechanism.** `users` is declared with no uniqueness on `email`:

```sql
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  …
);
```

A search across `supabase/schema.sql` and all migrations for a unique constraint
or unique index touching `users.email` — including a case-folded
`lower(email)` index — returns **nothing**. (The repo does add
`orgs_name_unique_ci` for org names, so the technique is known and used; it was
simply never applied to identity.)

`org_members` then declares `UNIQUE(org_id, uid)`. That constraint is satisfied
by two rows with the **same `org_id`, same `email`, different `uid`** — because
the two rows carry two different `uid`s. Uniqueness is enforced on the identity,
and the thing you actually care about is the *person*, which the schema never
names.

So the arrangement you described — one profile, two ways in — is not something the
database models. It is something that happens to be true when Supabase links the
identities, and stops being true the moment it does not.

**Failure scenario.** Your Microsoft sign-in resolves to `uid_B`, distinct from
the `uid_A` your password created. An admin (possibly you) uses Team Management
to add your email; the row lands on one of them — see `IDENT-2` for why *which
one* is not deterministic — as Admin. The other `uid` either has no row (you get
the no-workspace hard stop) or has an older row at a lower role (you get that
role). Same email, same person, same org, two rows, two answers. Which one you
get depends on which button you pressed to sign in.

**Evidence.** The constraint that would prevent it does not exist:

```
grep -rn "users" supabase/migrations/*.sql supabase/schema.sql | grep -i "unique\|lower(email)"
  → (no output)
```

The application already knows the condition is reachable —
`app/(protected)/projects/[id]/page.tsx:870-872`:

```ts
const { data: userRows } = await supabase.from("users").select("id, email").eq("email", email).limit(2);
const candidates = (userRows ?? []) as Array<{ id: string; email: string }>;
if (candidates.length > 1) throw new Error("Multiple accounts share that email — contact your admin.");
```

**This is the only call site in the codebase that handles it.**

**Settle it in your own data before deciding severity.** Two queries — the first
finds duplicate *profiles*, the second finds duplicate *auth identities*, which
is the upstream cause:

```sql
-- Duplicate profiles sharing an email (case-insensitive)
SELECT lower(email) AS email, count(*), array_agg(id) AS uids
FROM users WHERE email IS NOT NULL
GROUP BY lower(email) HAVING count(*) > 1;

-- Duplicate auth identities, and which providers each holds
SELECT lower(u.email) AS email, count(DISTINCT u.id) AS auth_users,
       array_agg(DISTINCT i.provider) AS providers
FROM auth.users u LEFT JOIN auth.identities i ON i.user_id = u.id
WHERE u.email IS NOT NULL
GROUP BY lower(u.email) HAVING count(DISTINCT u.id) > 1;

-- The one that answers your actual question: same email, same org, two rows
SELECT m.org_id, lower(m.email) AS email, count(*) AS rows,
       array_agg(m.uid) AS uids, array_agg(m.role) AS roles, array_agg(m.status) AS statuses
FROM org_members m WHERE m.email IS NOT NULL
GROUP BY m.org_id, lower(m.email) HAVING count(*) > 1;
```

A healthy single identity shows **one** `auth.users` row whose `auth.identities`
array is `{azure,email}` — that is the linked case, and it is what you want.

**Chain reaction.** If duplicates exist, they are not confined to sign-in.
`org_members.uid` is the join key for e-signatures, acknowledgments, checkout
locks, audit rows and assignment. A person who signs in as the other identity is,
to every one of those tables, a different person: they cannot release their own
checkout, their acknowledgment does not count against the row assigned to them,
and their audit trail is split across two actors. In a PSM context a split
signer identity is the part that matters most — it is the difference between
"this person signed" and "an account with this person's email signed".

**Done when.**

- [ ] the three queries above have been run against production and the result recorded here → **the blocking step; see the Blocker block**
- [x] a unique index on `lower(email)` exists for `users`, added **after** any existing duplicates are reconciled (adding it first will simply fail) — *written*; applied by hand after the inventory (`DEC-30`)
- [x] a decision is recorded in `DECISIONS.md` on whether identity linking is required — **`DEC-42`**: linking is required; the setting and its verification query are documented there
- [x] `org_members` carries a partial unique index on `(org_id, lower(email))` for `status = 'active'`, so the same person cannot hold two active memberships in one workspace regardless of how many identities they accumulate — *written*, same migration

- **Status:** BLOCKED

**Resolution (code + migration halves — done).** Migration
`supabase/migrations/20261018_identity_email_unique.sql` carries, in order:
the three inventory queries as a mandatory STEP 0 with reconciliation
guidance (including the do-not-cascade-delete warning: `users.id` cascades
from `auth.users`, so the spare identity's uid-keyed rows must be reassigned
deliberately, never force-deleted); an idempotent email normalization of
`users`, `org_members` and `access_requests`; `users_email_unique_ci`; and
the partial `org_members_org_email_active_unique_ci`. The `schema.sql`
snapshot mirrors both indexes. The application half that makes the indexes
safe to rely on landed under `IDENT-2`/`IDENT-3`, and the create-user route
maps the index's 23505 on its insert path to the collision-refusal 409 so
the backstop firing reads as an explanation, not a raw database error.
- Commits: `8fef0f6`, `c111433`
- Files: `supabase/migrations/20261018_identity_email_unique.sql`, `supabase/schema.sql`, `audit-reports/DECISIONS.md` (DEC-42), `app/api/admin/create-user/route.ts`
- Pending migration: `supabase/migrations/20261018_identity_email_unique.sql` — **applied by hand, after STEP 0**.

**Blocker (`DEC-27` #4 / `DEC-30`).** The three inventory queries read
production data this repository cannot observe (`auth.users`,
`auth.identities`, live `org_members`). Which world this installation is in
— duplicates exist and must be reconciled, or they don't and the indexes
apply cleanly — decides the remaining work. Unblocking step: run STEP 0 of
the migration file against production, record the three result sets here,
reconcile per the in-file guidance if any rows return, then apply the rest
of the file. Also verify the `DEC-42` linking setting while in the
dashboard.

**What this brought to light.**
- The DB census for this fix confirmed the absence claim repo-wide at HEAD
  (no unique constraint or index on any email column existed anywhere in
  162 migrations + schema), and found the restore paths insert members as
  `status='inactive'` — deliberately outside the new partial index, so a
  restore can never collide with a live membership. `lib/dataRestore.ts`
  already normalizes emails (`trim`+`lowercase`) during reconciliation, so
  STEP 1's lowercasing cannot break restore matching.
- The bulk UPDATE in STEP 1 fires `trg_prevent_last_admin_update` per row,
  but the guard returns early when `auth.uid()` is null (SQL editor /
  service role), so the migration passes it — and that same exemption means
  **the trigger does not protect production from service-role writes at
  all**; the create-user route is the only guard on its own paths. Noted
  for the `roles-and-permissions` area, whose `DB-*` findings own that
  trigger.

---

<a id="ident-2"></a>

## IDENT-2 · Team Management's email lookup uses `maybeSingle()` and discards its error, so two profiles sharing an email are read as "no profile" and the membership is attached to an arbitrary identity

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/create-user/route.ts:80-107`, `app/api/admin/create-user/route.ts:8-19`
- **Re-verified:** hardening pass — **SURVIVES**. `const { data: existingProfile } = await supabaseAdmin.from("users").select("id").eq("email", email).maybeSingle()` (`create-user:80-84`) — `error` is not destructured, and `maybeSingle()` errors on more than one row, so two profiles read as none. The fallback `findAuthUserIdByEmail` then returns `data.users.find(…)` in `listUsers` page order.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed exactly as stated: the error is discarded (not merely ignored — never bound), and the fallback resolves the identity by whichever listUsers page order surfaces first, which the route never orders or disambiguates. This route runs on the service-role key, so RLS is not filtering the second row out.

**Independence caveat — resolved.** This area was written and verified by the same session, which made it the weakest grade in the corpus. It has since been challenged by a separate agent that was given only the claim and its citations and told to refute it; the outcome is on each finding's `Independently verified` line. `IDENT-5` did not survive. The area is now graded like the rest of the corpus (`DEC-41`).

**Mechanism.** Three steps, each individually reasonable, compose into a
non-deterministic outcome.

1. `:80-84` looks for an existing profile:

   ```ts
   const { data: existingProfile } = await supabaseAdmin
     .from("users").select("id").eq("email", email).maybeSingle();
   ```

   `maybeSingle()` resolves with an **error** when more than one row matches — and
   `error` is not destructured, so it is discarded. Two profiles sharing an email
   therefore produce `existingProfile === undefined`, which is indistinguishable
   from "this email is new". This is the swallowed-`supabase-js`-error shape the
   earlier audits found in four other areas, in its most consequential position:
   deciding *which human* a role is granted to.

2. `:89-94` concludes the email is new and calls `auth.admin.createUser`. That
   fails, because the email is registered.

3. `:99-106` falls back to `findAuthUserIdByEmail`, which pages through
   `listUsers` 200 at a time and returns `data.users.find(…)` — **the first
   match in whatever order the Admin API pages them** (`:8-19`). With two
   accounts on one email, "first" is not a property the caller controls or can
   predict, and it is not guaranteed stable between calls.

The role is then written to `org_members` for that arbitrarily chosen `uid`
(`:127-162`).

**Failure scenario.** You add yourself — or an admin re-adds you — as Admin. The
lookup silently mis-reads, the fallback picks your password identity, and the
Admin row lands there. You next sign in with Microsoft, which is your other
identity, and the app resolves *its* membership: a stale Viewer row, or none.
The Team Management screen shows you as Admin, because it is reading the row that
was written. Both screens are telling the truth about different rows.

**Evidence.**

```
app/api/admin/create-user/route.ts:80-84
  const { data: existingProfile } = await supabaseAdmin      ← no `error`
    .from("users").select("id").eq("email", email).maybeSingle();

app/api/admin/create-user/route.ts:13-15
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
  if (error || !data?.users?.length) return null;
  const match = data.users.find((u) => (u.email || "").toLowerCase() === target);
```

The correct handling exists in this repo already, at
`app/(protected)/projects/[id]/page.tsx:870-872` — select two, refuse on two.

**Done when.**

- [x] the lookup selects up to two rows and **fails loudly** on more than one, with a message naming the collision, rather than falling through to creation
- [x] the `error` from every `maybeSingle()` on this route is destructured and handled — the same pass should cover `:111-116`
- [x] `findAuthUserIdByEmail` refuses to guess when it finds more than one match instead of returning the first
- [x] a test seeds two profiles on one email and asserts the route returns a 409 naming both `uid`s, and writes no membership row

- **Status:** RESOLVED

**Resolution.** The route now fails loudly in both directions at every
lookup. The profile lookup selects two case-insensitively
(`ilike` on the escaped normalized address, so pre-normalization mixed-case
rows are found), returns 500 **without proceeding to creation** on a lookup
error, and returns 409 naming both uids (`collidingUids` in the body, the
projects-page message shape in the copy) on two rows. `findAuthUserIdByEmail`
became `findAuthUsersByEmail`: it collects every match across pages,
distinguishes "lookup failed" (refuse, 500) from "no match", and a
multi-match refuses with the same 409. The existing-member lookup
destructures its error and refuses on failure. The database backstop's
23505 on the insert path (a different uid already active on this email in
this org) maps to the same collision refusal.
- Commits: `8fef0f6`, `c111433`
- Files: `app/api/admin/create-user/route.ts`, `lib/identity.ts`
- Tests: `lib/__tests__/createUserRoute.test.ts::"returns 409 naming both uids and writes NO membership when two profiles share the email"`, `::"refuses to guess when the auth fallback finds two identities on one address"`, `::"fails closed (500, no writes) when the profile lookup itself errors"`
- Reproduced: the pre-fix mechanism was re-confirmed at HEAD (`error` never destructured at `:80-84`; `find(...)` first-match at `:14`); the new tests were written against the contract and fail against the old code by construction (the old route returned 200 and wrote a membership in the two-profile scenario the first test seeds).
- Verified: full suite (1360 tests) + ship loop green. The caller census confirmed the admin users page surfaces any `{error}` body verbatim in its modal and reads nothing but `error`/`uid`, so the 409 shape is safe, and the promised remove→re-add flow cannot trip the refusal (removal keeps exactly one profile row).

**What this brought to light.**
- This route was the *only* writer that could attach a role to the wrong
  human; the other admitting door (`signup`) mints a fresh identity instead,
  which is why its guard is a courtesy and `createUser` its enforcement
  (see `IDENT-5`'s refutation — consistent with what was found here).
- The response now carries `collidingUids` so an admin's error message can
  name what to clean up. The uids are already visible to org admins in Team
  Management; no new information class leaves the server.

---

<a id="ident-3"></a>

## IDENT-3 · Email matching is case-sensitive in three server routes and case-folded in a fourth, so the same address can both miss an existing account and create a second one

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/api/auth/signup/route.ts:77-82`, `app/api/admin/create-user/route.ts:83`, `app/api/admin/create-user/route.ts:9`, `app/api/auth/request-access/route.ts:30-36`
- **Re-verified:** hardening pass — **SURVIVES**. Three case-sensitive `eq("email", …)` comparisons (`signup:80`, `create-user:83`, `request-access:33`) against one case-folded matcher in the same file as the second (`create-user:9,14`), while org names get `ilike` in both `signup:65` and `request-access:16`.
- **Independently verified:** ✓ **SURVIVES, corrected** — independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The mismatch is confirmed, but the stated consequence — "proceeds to createUser, minting the second identity" — does not follow. signup/route.ts:91-100 calls `supabaseAdmin.auth.admin.createUser` and, on failure, returns 400 with the raw `authError.message`; it has no duplicate-recovery path, and create-user/route.ts:98-99's own comment ("Email may already exist in auth without a readable profile row") is the repo's acknowledgement that createUser rejects an already-registered address. So the observable damage is a confusing raw auth error instead of the friendly 409 at signup:83-88, and genuinely duplicated pending rows at request-access:30-43 — MEDIUM, not the manufacturing step for duplicate identities. Minor imprecision: the "fourth" location is the same route as the second (create-user), not a fourth route.

**Independence caveat — resolved.** This area was written and verified by the same session, which made it the weakest grade in the corpus. It has since been challenged by a separate agent that was given only the claim and its citations and told to refute it; the outcome is on each finding's `Independently verified` line. `IDENT-5` did not survive. The area is now graded like the rest of the corpus (`DEC-41`).

**Mechanism.** PostgREST's `eq` is a plain SQL `=`, which on `text` is
case-sensitive. Three routes compare emails that way:

| Route | Line | Comparison |
|---|---|---|
| `auth/signup` | `:80` | `.eq("email", email)` — the "account already exists" check |
| `admin/create-user` | `:83` | `.eq("email", email)` — the existing-profile lookup |
| `auth/request-access` | `:33` | `.eq("email", email)` — the duplicate-request check |

And one — inside the same file as the second — case-folds:
`findAuthUserIdByEmail` lowercases both sides (`create-user:9,14`). The repo also
demonstrates it knows how to do case-insensitive matching properly, using `ilike`
for org names in both `signup:65` and `request-access:16`. Identity is the one
place it was not applied.

Microsoft is the reason this stops being theoretical. Azure/Entra commonly
returns the UPN in whatever case the directory stores it — `Greg.Getzfrid@…` —
while a password signup typically carries whatever the person typed. Two casings
of one address will not match each other in three of the four places above.

**Failure scenario.** `signup:80` checks for `Greg@corp.com`, finds nothing
because the stored row is `greg@corp.com`, and proceeds to `createUser` — minting
the second identity that `IDENT-1` then cannot constrain and `IDENT-2` then
attaches roles to arbitrarily. The case-sensitivity is the *manufacturing step*
for the duplicates the other two findings are about.

**Evidence.**

```
app/api/auth/signup/route.ts:78-82        ← case-sensitive identity check
  .from("users").select("id").eq("email", email).maybeSingle();

app/api/admin/create-user/route.ts:9,14   ← case-folded, same file
  const target = email.toLowerCase();
  const match = data.users.find((u) => (u.email || "").toLowerCase() === target);

app/api/auth/signup/route.ts:65           ← the repo's own correct pattern, on org names
  .from("orgs").select("id, name").ilike("name", trimmedOrgName).maybeSingle();
```

**Done when.**

- [x] every email comparison in the codebase normalises both sides — one shared helper, not four call sites each remembering
- [x] the `lower(email)` unique index from `IDENT-1` is the backstop, so a route that forgets cannot create the duplicate anyway *(written; pending hand-apply per `IDENT-1`)*
- [x] emails are stored normalised on write, so `org_members.email` and `users.email` do not disagree with each other about the same person

- **Status:** RESOLVED

**Resolution.** `lib/identity.ts` is the one shared helper:
`normalizeEmail` (trim + lowercase, for storage and equality) and
`emailLikePattern` (normalized **and LIKE-escaped**, because emails may
legally contain `%` and `_` — an unescaped `ilike` on `a_b@x.com` would also
match `axb@x.com`). All three routes now normalize at the parse boundary,
look up case-insensitively, and store the canonical form on every write
(`org_members.email`, `users.email`, `access_requests.email`). The
request-access duplicate check also had the same discarded-error shape as
`IDENT-2` — it now refuses on a failed lookup instead of stacking a
duplicate row. The migration's STEP 1 brings pre-existing rows onto the same
canonical form.
- Commit: `8fef0f6`
- Files: `lib/identity.ts`, `app/api/auth/signup/route.ts`, `app/api/admin/create-user/route.ts`, `app/api/auth/request-access/route.ts`
- Tests: `lib/__tests__/identity.test.ts` (normalization, idempotence, wildcard escaping — including the Azure-UPN-vs-typed case), `lib/__tests__/createUserRoute.test.ts::"matches the profile case-insensitively on the normalized address (IDENT-3)"`
- Reproduced: the three case-sensitive `eq("email", …)` sites and the one case-folded matcher were re-confirmed at HEAD before changing anything.
- Verified: ship loop green. Lookups use `ilike` rather than `eq`-on-lowercase deliberately: stored rows written before normalization may be mixed-case, and an `eq` on the canonical form would miss exactly the accounts this finding is about.

**What this brought to light.**
- The independent verifier's correction stands confirmed in the fix: the
  observable damage was the confusing raw auth error (now the friendly 409 —
  folded in from refuted `IDENT-5`) and genuinely duplicated
  `access_requests` rows (now both refused-on-error and case-insensitive) —
  not a minted duplicate identity.
- Nobody could ever *see* a request-access failure: the signup page ignored
  the response entirely and showed "Request Sent" on any outcome. That is
  now `IDENT-6` (below), found by the caller census and fixed.

---

<a id="ident-4"></a>

## IDENT-4 · The device-wide "prefer Microsoft" flag and the workspace key are not scoped to an identity, so one browser's state carries across two accounts

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/supabase.ts:39-58`, `components/providers/RoleContext.tsx:44`, `components/providers/RoleContext.tsx:130-140`, `app/(protected)/profile/page.tsx:77`, `components/providers/RoleContext.tsx:260-280`
- **Re-verified:** hardening pass — **SURVIVES**. `LS_ORG_KEY = "manufacturingos.activeOrgId"` (`RoleContext.tsx:44`) and `PREFER_MS_KEY = "manufacturingos.preferMicrosoft"` (`supabase.ts:39`) are both bare constants with no uid component, and the `SIGNED_OUT` purge at `:269-278` clears only the `intel-status-`/`schema-gaps-` snapshots.
- **Independently verified:** ✓ **SURVIVES** — independent adversarial pass. Confirmed, and stronger than stated: sign-out clears the in-memory org (line 263) but leaves the localStorage workspace key for the next account, and app/(protected)/layout.tsx:99 — the NotAMemberScreen's "Sign out & switch account" button — calls `supabase.auth.signOut()` without `setPreferMicrosoft(false)`, so unlike profile/page.tsx:77, Sidebar.tsx:292 and SubscriptionGate.tsx:109, that button leaves the device flagged and the silent Microsoft sign-in at app/page.tsx:156-159 walks the user straight back into the identity they were trying to leave.

**Independence caveat — resolved.** This area was written and verified by the same session, which made it the weakest grade in the corpus. It has since been challenged by a separate agent that was given only the claim and its citations and told to refute it; the outcome is on each finding's `Independently verified` line. `IDENT-5` did not survive. The area is now graded like the rest of the corpus (`DEC-41`).

**Mechanism.** Two pieces of durable per-device state are keyed by nothing but a
constant string:

- `manufacturingos.preferMicrosoft` (`lib/supabase.ts:39`)
- `manufacturingos.activeOrgId` (`RoleContext.tsx:44`)

`resolveOrgAndRole` reads the workspace key **first**, ahead of the profile's
`default_org_id` (`:130-140`): *"Candidate org: this device's last workspace →
profile default."* That ordering is right for one identity and wrong for two —
identity B inherits identity A's candidate org, finds no membership there
(`:145-150` returns null, because the `uid` differs), and drops into the
self-heal branch that `ORGSEL-1` covers.

The sign-out handler is careful to clear other cross-account leakage —
`intel-status-*` and `schema-gaps-*` are purged at `:271-278` with the comment
*"they must not outlive the account that fetched them."* The workspace key is
not in that list; it is cleared only via `_setActiveOrgId(null)` in React state
at `:263`, which does not touch `localStorage`. The `preferMicrosoft` flag is
deliberately persistent and is cleared only from the profile page
(`profile/page.tsx:77`).

**Failure scenario.** You sign out of your Microsoft identity and sign in with
your password identity on the same browser. The stale `activeOrgId` is still
there and is consulted before your profile default. If your password identity
holds a different membership set, the resolution starts from the wrong candidate
and lands wherever `ORGSEL-1` sends it.

**Evidence.**

```
components/providers/RoleContext.tsx:131-134
  let orgId: string | null = null;
  try { if (typeof window !== "undefined") orgId = localStorage.getItem(LS_ORG_KEY); } catch {}
  if (!orgId) { … profile default_org_id … }
```

And the sign-out purge that names the principle but omits this key —
`RoleContext.tsx:269-278`.

**Done when.**

- [x] `manufacturingos.activeOrgId` is namespaced by `uid`, or cleared in the same `SIGNED_OUT` block that purges the status snapshots — **both**: cleared on `SIGNED_OUT`, and owner-stamped so surviving copies invalidate
- [x] a `uid` change between the stored key's owner and the current session invalidates the candidate rather than inheriting it
- [x] the profile page's "stop preferring Microsoft" control is discoverable from the sign-in screen too, since that is where someone stuck in the wrong identity actually is

- **Status:** RESOLVED

**Resolution.** The device workspace state moved into
`lib/workspaceDeviceState.ts`: the stored org now carries an **owner stamp**
(`manufacturingos.activeOrgId.owner`), resolution reads it through
`readStoredOrgIdFor(uid)` — a mismatched owner returns null *and clears the
stale value* — and the `SIGNED_OUT` purge clears the key alongside the
status snapshots. The pre-paint restore stays raw-read by necessity (no
session exists before first paint; the hydration-safety comment in
`RoleContext` explains why it cannot wait), which is exactly why validation
lives at resolution time. `app/signup/page.tsx`'s raw string literal — found
by the census, a second writer that would have silently missed any key
change — now writes through the same helper, stamped with the new account's
uid. The verifier's sharpest case is closed: `NotAMemberScreen`'s "Sign out
& switch account" clears the silent-Microsoft flag before signing out, so
silent SSO can no longer walk the user straight back into the identity they
are leaving; and the sign-in screen shows a "Turn off" control whenever
automatic Microsoft sign-in is armed on the device.
- Commit: `c111433`
- Files: `lib/workspaceDeviceState.ts`, `components/providers/RoleContext.tsx`, `app/(protected)/layout.tsx`, `app/page.tsx`, `app/signup/page.tsx`
- Tests: `lib/__tests__/workspaceDeviceState.test.ts::"rejects a workspace stored by a different identity — the cross-account bleed"` plus legacy-tolerance and SSR-safety cases.
- Reproduced: re-confirmed at HEAD that both keys were bare constants, the `SIGNED_OUT` purge listed only the snapshot prefixes, and the layout's sign-out button called `signOut()` without clearing the preference (unlike the four other sign-out surfaces, which all clear it).
- Verified: ship loop green. **Deliberately NOT done:** `preferMicrosoft` is
  not in the `SIGNED_OUT` purge — session *expiry* also emits `SIGNED_OUT`,
  and the flag's documented contract (`lib/supabase.ts:36-38`) is that only
  an explicit sign-out clears it, so purging there would break
  "open the app and you're already in". Explicit sign-out buttons (now all
  five of them) are the clearing path.

**What this brought to light.**
- The census surfaced `lib/dashboard/config.ts` as the in-repo precedent for
  uid-scoping (`manufacturingos.dashboard.<uid>`); the owner-stamp approach
  was chosen over renaming the key because renaming orphans every existing
  device's stored workspace on upgrade for no safety gain.
- `manufacturingos.customStamps` (custom stamp images in
  `FullScreenViewer.tsx`) is device-scoped user content with the same mild
  cross-account character — deliberately left alone here (sweeping it would
  destroy a user's stamps), noted for the `document-control` area if it ever
  matters.
- After the clear-on-sign-out, `users.default_org_id` becomes the only
  cross-sign-in restore — which made `ORGSEL-1`'s deterministic fallback
  more load-bearing, and exposed that admin-created accounts had no default
  at all (fixed in the create-user route; noted under `ORGSEL-1`).

---

<a id="ident-5"></a>

## IDENT-5 · The signup route's duplicate-email refusal is the only thing standing between a mistyped case and a second account, and it fails open

- **Severity:** MEDIUM
- **Status:** REFUTED
- **Verification:** CONFIRMED
- **Locations:** `app/api/auth/signup/route.ts:77-95`
- **Re-verified:** hardening pass — **SURVIVES**. The guard reads the `users` profile mirror rather than the auth identity, compares case-sensitively, and discards the multi-row error — three independent ways to conclude "this email is free" and proceed to `createUser`.
- **Independently verified:** ⛔ **REFUTED** by an independent adversarial pass — do not work this finding. Kept in place with the reason rather than deleted (`DEC-41`). The profile pre-check at 77-88 does fail open (the error is not destructured), but it is NOT "the only thing standing between a mistyped case and a second account": the createUser call at 91-96 — inside the finding's own cited line range — rejects an already-registered email and the route returns 400 without creating anything. No second auth identity is produced by this path, so the stated outcome ("a second auth user is created, and the person now has the two identities") is false. What remains is cosmetic: the user sees a raw auth error rather than "An account with this email already exists. Please sign in instead."

**Independence caveat — resolved.** This area was written and verified by the same session, which made it the weakest grade in the corpus. It has since been challenged by a separate agent that was given only the claim and its citations and told to refute it; the outcome is on each finding's `Independently verified` line. `IDENT-5` did not survive. The area is now graded like the rest of the corpus (`DEC-41`).

**Mechanism.** The route's guard is a profile lookup whose result decides whether
to mint an auth user:

```ts
const { data: existingUser } = await supabaseAdmin
  .from("users").select("id").eq("email", email).maybeSingle();
if (existingUser) return 409 "An account with this email already exists.";
… auth.admin.createUser({ email, password, email_confirm: true })
```

Three independent ways this reads "no account" when there is one: the case
mismatch of `IDENT-3`; the discarded multi-row error of `IDENT-2` (the `error`
field is again not destructured); and the fact that it queries the **`users`
profile table**, not `auth.users` — so an auth identity whose profile row was
never written (the exact case `create-user:99` exists to recover from) is
invisible to it.

Each of those makes the guard fail **open**, toward creating another account.
There is no failure mode in which it wrongly refuses.

**Failure scenario.** Someone signs in with Microsoft first — profile row upserted
client-side by `app/page.tsx:63-67`, which may or may not have completed — then
later starts a trial from the signup form with a differently-cased email. The
guard misses, a second auth user is created, and the person now has the two
identities that `IDENT-1` describes, with the second one owning a brand-new org.

**Evidence.**

```
app/api/auth/signup/route.ts:78-82
  const { data: existingUser } = await supabaseAdmin     ← `error` discarded
    .from("users").select("id").eq("email", email).maybeSingle();
```

Compare the org-name guard eleven lines above it (`:63-67`), which uses `ilike`
*and* is backed by a real database constraint the route names in its own rollback
comment — `orgs_name_unique_ci`. Org names get a case-insensitive check and a
database backstop. Identities get neither.

**Done when.**

- [ ] the check is case-insensitive and reads the auth identity, not just the profile mirror
- [ ] the `lower(email)` unique index from `IDENT-1` backs it, on the same reasoning the route already applies to `orgs_name_unique_ci`
- [ ] the `error` branch of the lookup refuses rather than proceeding — a signup guard that cannot read the table must not conclude the email is free

> **Resolution-pass note (2026-08-23).** Worked per the refutation, not per
> the original claim: the surviving item was the copy fix, and it landed in
> the `IDENT-3` pass — the signup route now maps the auth layer's
> duplicate-email rejection (`email_exists` / "already registered") to the
> same friendly 409 the profile pre-check produces, and the pre-check itself
> became case-insensitive with `limit(2)` as a side effect of the shared
> helper. The pre-check deliberately still treats a lookup error as
> "unknown" and proceeds, because the refutation's own finding is the
> ground truth here: `auth.admin.createUser` is the real enforcement and
> refuses a registered address regardless — failing closed on a transient
> profile-mirror error would block legitimate signups to guard a door that
> is already locked. Status stays REFUTED; nothing here counts toward the
> area's completion. Commit: `8fef0f6`.

---

<a id="ident-6"></a>

## IDENT-6 · The signup page renders "Request Sent" on every request-access outcome — 404, 409 and 500 all show success

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/signup/page.tsx:93-104`, `app/api/auth/request-access/route.ts:20-45`

**Mechanism.** Found during this area's resolution by the caller census (it
is the missing consumer of `IDENT-3`'s request-access fixes). The
`handleRequestAccess` handler awaited the fetch and then called
`setRequestSent(true)` **without ever inspecting the response** — no
`res.ok` check, no body read. The route's meaningful refusals — 404 *"No
organization named X was found"*, 409 *"You already have a pending
request"*, and any 500 — were all rendered as the full-screen "Request
Sent!" success state. Only a network-level rejection reached the catch.

**Failure scenario.** A field hand mistypes the facility's workspace name and
requests access. The server answers 404; the screen says the request was
sent and an admin will respond. Nobody ever comes, because no request
exists — and the person has been explicitly told not to follow up. The
admin-side pending-requests surface (`DEC-19`) makes this worse, not
better: even once admins can see requests, this one was never created.

**Resolution.** The handler now checks `res.ok`, surfaces the server's
`error` string in the page's existing error alert, and shows the success
state only on a 2xx. The route's refusals were already well-written; they
are simply visible now.
- Commit: `c111433`
- Files: `app/signup/page.tsx`
- Tests: not unit-testable in the node-only harness (a client page handler); the route's error contracts are exercised by its own guards, and the handler change is a four-line trace.
- Reproduced: read directly from HEAD before the fix — the fetch result was unbound and `setRequestSent(true)` unconditional.
- Verified: ship loop green; all three refusal shapes now land in the error alert with the server's own copy.

**Chain reaction.** `DEC-19` (build the pending-requests admin surface) —
when that lands, this fix is what guarantees the queue the admins see
matches what requesters believe they submitted. Also note the page still
sends a `message` field the route ignores and no UI populates; left as-is,
recorded here so the `DEC-19` implementer knows it is dead weight rather
than a wired feature.

**Done when.**

- [x] a non-2xx from `/api/auth/request-access` renders the server's error message, not the success screen
- [x] a 2xx still renders the success screen
- [x] the route's dup-check failure refuses rather than duplicating (landed under `IDENT-3`)

---
