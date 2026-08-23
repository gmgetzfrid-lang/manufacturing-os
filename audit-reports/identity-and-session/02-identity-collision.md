# 02 · Identity collision — two sign-in methods, one person

**5 findings** — 1 CRITICAL · 2 HIGH · 2 MEDIUM.

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

- **Severity:** CRITICAL
- **Status:** OPEN
- **Verification:** CONFIRMED (the absence of the constraint); SUSPECTED (whether duplicates exist in your data today — see the query)
- **Locations:** `supabase/schema.sql:8-16`, `supabase/schema.sql:33-49`, `app/(protected)/projects/[id]/page.tsx:870-872`
- **Re-verified:** hardening pass — **SURVIVES** with its stated split intact — **and the same independence caveat as `SESS-1`.** The absence of any unique constraint on `users.email` is CONFIRMED and mechanically checkable. Whether duplicates exist in production remains SUSPECTED and is not answerable from this repository; the three queries in the finding are still the way to settle it.

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

- [ ] the three queries above have been run against production and the result recorded here
- [ ] a unique index on `lower(email)` exists for `users`, added **after** any existing duplicates are reconciled (adding it first will simply fail)
- [ ] a decision is recorded in `DECISIONS.md` on whether identity linking is required — if it is, the Supabase setting is documented alongside the constraint, because the constraint alone cannot force two providers onto one auth user
- [ ] `org_members` carries a partial unique index on `(org_id, lower(email))` for `status = 'active'`, so the same person cannot hold two active memberships in one workspace regardless of how many identities they accumulate

---

<a id="ident-2"></a>

## IDENT-2 · Team Management's email lookup uses `maybeSingle()` and discards its error, so two profiles sharing an email are read as "no profile" and the membership is attached to an arbitrary identity

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/create-user/route.ts:80-107`, `app/api/admin/create-user/route.ts:8-19`

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

- [ ] the lookup selects up to two rows and **fails loudly** on more than one, with a message naming the collision, rather than falling through to creation
- [ ] the `error` from every `maybeSingle()` on this route is destructured and handled — the same pass should cover `:111-116`
- [ ] `findAuthUserIdByEmail` refuses to guess when it finds more than one match instead of returning the first
- [ ] a test seeds two profiles on one email and asserts the route returns a 409 naming both `uid`s, and writes no membership row

---

<a id="ident-3"></a>

## IDENT-3 · Email matching is case-sensitive in three server routes and case-folded in a fourth, so the same address can both miss an existing account and create a second one

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/auth/signup/route.ts:77-82`, `app/api/admin/create-user/route.ts:83`, `app/api/admin/create-user/route.ts:9`, `app/api/auth/request-access/route.ts:30-36`

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

- [ ] every email comparison in the codebase normalises both sides — one shared helper, not four call sites each remembering
- [ ] the `lower(email)` unique index from `IDENT-1` is the backstop, so a route that forgets cannot create the duplicate anyway
- [ ] emails are stored normalised on write, so `org_members.email` and `users.email` do not disagree with each other about the same person

---

<a id="ident-4"></a>

## IDENT-4 · The device-wide "prefer Microsoft" flag and the workspace key are not scoped to an identity, so one browser's state carries across two accounts

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/supabase.ts:39-58`, `components/providers/RoleContext.tsx:44`, `components/providers/RoleContext.tsx:130-140`, `app/(protected)/profile/page.tsx:77`, `components/providers/RoleContext.tsx:260-280`

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

- [ ] `manufacturingos.activeOrgId` is namespaced by `uid`, or cleared in the same `SIGNED_OUT` block that purges the status snapshots
- [ ] a `uid` change between the stored key's owner and the current session invalidates the candidate rather than inheriting it
- [ ] the profile page's "stop preferring Microsoft" control is discoverable from the sign-in screen too, since that is where someone stuck in the wrong identity actually is

---

<a id="ident-5"></a>

## IDENT-5 · The signup route's duplicate-email refusal is the only thing standing between a mistyped case and a second account, and it fails open

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/auth/signup/route.ts:77-95`

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

---
