# Identity & session — audit area

Read-only audit of how a person becomes a signed-in member with a role: the two
sign-in methods, identity resolution, workspace selection, and the render path
that decides what you are allowed to see.

Opened by a direct report from the owner: *"I'm still getting periodic issues
where I randomly get loaded into a viewer from my admin account."*

**No application code, test, or migration was modified at any point.**

---

## ⚠ Before you touch anything

1. **Read [`../README.md`](../README.md)** — the resolution protocol — and
   [`../DECISIONS.md`](../DECISIONS.md).
2. **Read [`99-fix-sequencing.md`](./99-fix-sequencing.md).** One item in Phase 0
   is a few lines and stops the reported symptom; almost everything else depends
   on a question you can answer with one SQL query.
3. **Run the three queries in [`IDENT-1`](./02-identity-collision.md#ident-1)
   first.** They decide whether half this area is live or latent. Planning the
   work before running them wastes the planning.

---

## The short answer

**Your instinct is half right, and the half that is wrong is the half that is
actually breaking.**

The Viewer symptom is **not** caused by your dual login. It is a render race, and
it would happen on password-only sign-in too:

> `app/(protected)/layout.tsx:35-52` branches on `loading`, then on
> `membershipState === "none"`, then on `membershipState === "error"`, then
> renders the entire application. There is **no branch for
> `membershipState === "resolving"`** — and two separate watchdogs
> (`RoleContext.tsx:88` at 6 s, `:241` at 8 s) deliberately set `loading` to
> `false` while resolution is still in flight. When that happens the app renders
> with `activeRole` at its initial value, which is the literal string `"Viewer"`
> (`RoleContext.tsx:65`), and `roles` at `[]`.

The provider's own docblock states the rule the layout breaks —
*"never a silent downgrade to Viewer"* (`RoleContext.tsx:34-39`). It handles the
two named ways of getting a fake Viewer app. It does not handle the third: never
finishing.

**Why it feels like a Microsoft problem.** Because it correlates with one. The
SSO path is the slowest route to the same race — a full redirect out and back, a
brand-new session, and *two* membership queries in a row (the login page runs its
own at `app/page.tsx:72-78`, then `RoleContext` runs it again at
`RoleContext.tsx:145-150`). Meanwhile the file itself documents that a Supabase
cold start *"can spend 5-10s on the first RLS-gated query of a session"*
(`:311-314`) — and gives the boot path 8 seconds with a watchdog at 6. You
noticed a real correlation and drew a reasonable, wrong conclusion from it.

**And the half you were right about.** Duplicate profiles in the same org are
genuinely possible, and the constraint you have does not stop them.
`org_members` has `UNIQUE(org_id, uid)` — which prevents one *auth user* being
doubled, not one *person*. There is **no unique constraint on `users.email`
anywhere in the schema or in any migration**. Two auth identities sharing your
email can hold two membership rows, in the same org, with two different roles.

Whether that is already true of your data depends on a Supabase setting this
repository cannot see. [`IDENT-1`](./02-identity-collision.md#ident-1) gives you
the query.

**One piece of evidence stands out.** Exactly one call site in the entire
codebase defends against this, and it does it properly —
`app/(protected)/projects/[id]/page.tsx:870-872` selects two rows and refuses:
*"Multiple accounts share that email — contact your admin."* Someone met this in
production and fixed the screen in front of them. It was never generalised.

---

## Findings

**14 findings** — 1 CRITICAL, 6 HIGH, 7 MEDIUM.

> **One finding here carries `Status: REFUTED`** — `IDENT-5`. An independent pass disproved it; the reason is on the finding. Kept rather than deleted (`DEC-41`). **Do not queue it as work.**

| # | Report | n | Focus |
|---|---|---|---|
| 01 | [**The Viewer window**](./01-the-viewer-window.md) | 5 | **Your symptom**, traced to four lines |
| 02 | [**Identity collision**](./02-identity-collision.md) | 5 | **Your dual-login question** — and the query that settles it |
| 03 | [Which workspace, which role](./03-org-and-role-selection.md) | 4 | Arbitrary picks in workspace and role selection |
| 99 | [**Execution order**](./99-fix-sequencing.md) | — | Binding. Phase 0 is a few lines |

Each report opens with a **substrate table** — what already exists, works, or is
load-bearing. In this area that table matters more than usual: the four-state
`MembershipState`, the throwing queries, the additive role model and the
hard-stop screens are all correct, well-reasoned code with the intent written
down beside them. Most findings here are a consumer failing to honour a model
that is already right, not a model that is wrong.

---

## Three defects, one symptom

This is the part that has made it hard to pin down.

| Defect | Contribution |
|---|---|
| [`SESS-1`](./01-the-viewer-window.md#sess-1) | Renders as Viewer whenever the answer is late |
| [`ORGSEL-1`](./03-org-and-role-selection.md#orgsel-1) | Unordered `limit(1)` picks an arbitrary workspace — possibly one where you really are a Viewer |
| [`IDENT-1`](./02-identity-collision.md#ident-1) | A second identity whose membership genuinely differs |

They compose. Fixing one reduces the frequency without eliminating it — which is
exactly the shape of a bug that resists diagnosis. Work them in the order
`99-fix-sequencing.md` sets, not by severity.

---

## What this is not

Worth stating plainly, because the symptom is alarming in a PSM system:

- **Not a permissions change.** Nothing revokes or grants anything. Your
  `org_members` row is untouched throughout.
- **Not a data-access breach.** RLS is enforced from the JWT and
  `org_members.role`, never from the client's `activeRole`
  (`supabase/schema.sql:1033,1044,1048-1052`). During a Viewer window the
  database still knows exactly who you are. You lose navigation and buttons, not
  rights.
- **Not cross-tenant.** Every policy resolves a person by `uid`. A duplicate
  identity produces a wrong-role or no-access experience for *you*; it does not
  put you in someone else's workspace.

The real costs are different, and they are not small: a control surface that
disappears without explanation, an audit trail that can split one person across
two actor ids, and — via [`ORGSEL-3`](./03-org-and-role-selection.md#orgsel-3) —
a second write path that silently deletes stacked roles, which is the mechanism
behind being both the drafting manager and the QA/QC.

---

## Method & limits

- **Read directly from source**, not produced by an agent sweep. Every line
  number cited was opened and checked.
- **No live database, no browser, no running app.** Render conditions, query
  construction and schema DDL are deterministic and exact.
- **One question cannot be answered from this repository**: whether your Supabase
  project links the Azure identity to the password identity onto a single
  `auth.users` row. That is a project setting. Every `IDENT-*` finding is written
  to hold either way, but their severity in your installation is set by the query
  in `IDENT-1`.
- **The Viewer window was not reproduced against a running app.** It is proven by
  construction from four cited lines. The honest reproduction is a browser with
  the membership query throttled past six seconds — worth writing *before* the
  fix, since it is what tells you whether this is your bug or merely a bug.
- Per `DEC-29`, reproduce before fixing.
