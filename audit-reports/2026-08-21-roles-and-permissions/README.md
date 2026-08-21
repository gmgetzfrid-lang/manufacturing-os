# Roles & Permissions Audit — 2026-08-21

Read-only audit of the authority model: the 19-role roster, the capability
policy layer, the drafting-request workflow, the document-control ACL, and
whether any of it scales to the rest of the app.

**No code was modified.**

---

> ## ⚠ STATUS: IN PROGRESS — DO NOT WORK THIS RUN YET
>
> **This run is incomplete and its scope was wrong.** The first pass answered a
> set of questions rather than auditing the system, and it missed at least one
> entire authority axis. Findings already written are verified and stand, but
> **coverage is partial** — do not treat the absence of a finding here as
> evidence that an area is sound.
>
> ### Known missing: the ownership axis
>
> Not covered below, confirmed to exist, and material to the whole model:
>
> - `user_is_effective_owner(doc_owner, collection, library, uid)` — a real
>   ownership cascade (document owner → folder owner → library owner,
>   most-specific wins), `SECURITY DEFINER SET search_path = public`.
>   Defined in `supabase/migrations/20260816_owner_publish_access.sql:9` and
>   **redefined** in `supabase/migrations/20260824_team_departments.sql:18`.
> - It feeds the publish guard (`20260816:62`), the review-completion guard
>   (`20260822:70`), integrity hardening (`20260828:237,272`) and publisher row
>   management (`20260830:43,64`) — so ownership is already an approval
>   authority for revision and supersede.
> - `libraries.owner_team_id` resolves to `teams.supervisor_user_id` — a
>   **single person**, not the team's members.
> - `user_can_publish_on_library(library, uid, org)`
>   (`20260812_per_library_publish_authority.sql`) — a separate axis again:
>   per-library publish authority granted through the library's ACL.
> - `lib/ownership.ts` (151 lines) and `lib/docControlRegister.ts` (246 lines) —
>   an ownership subsystem not examined in the reports below.
>
> ### Also still being mapped
>
> The full set of **23 database authority functions**; content egress across
> every door (share links, transmittals, knowledge/AI, search, graph, public
> verify pages, export/restore); every non-document surface (teams, projects,
> checkouts, holds, legal holds, retention, signatures, the AI orchestrator,
> admin pages, restore, cron); and a coupling / change-impact analysis
> (per-role blast radius, layer-contradiction census, scaling).
>
> **There are at least five independent authority axes** — org role, additive
> role array, capability policy, content ACL, and ownership/publish. The reports
> below cover the first four, and the fourth only partially.
>
> This banner will be removed when the run is complete.

---

## Your questions, answered

> **Partial.** These answers were written before the ownership axis was
> found. Question 5 in particular (document control / folder permissions)
> is answered without reference to library, folder or document ownership,
> which is a second mechanism governing the same surface. Re-read after the
> ownership report lands.

### 1. "Are these a bunch of dead roles?"

**Partly — six of nineteen are dead as authority, and dead as access groups too.**

Of 19 roles, only **10 have a distinct capability set**. The rest are duplicates:

| Collapse | Roles | Effect |
|---|---|---|
| Four names, one role | `Engineer-1` … `Engineer-4` | The token `"Engineer"` matches all four. The code says so: *"the tiers were never enforced anywhere and remain a labeling convention."* |
| Seven names, one role | `Requester`, `Accounting`, `Safety`, `HR`, `Maintenance`, `Operations`, `Contractor` | All grant exactly `["create_requests"]`. Nothing distinguishes them. |

The six department roles are not *entirely* pointless — they can be named as
subjects in a document ACL rule, which is a real function. But **that function
is broken for them** (see `ROLE-1`): the database matches ACL role rules against
a member's *primary* role only, and all six rank below `Requester`. So anyone who
can file a request cannot be reached by an ACL rule naming their department.

**Verdict: 10 real roles, 3 duplicate Engineer tiers, 6 department labels that
gate nothing and cannot currently do the one job left to them.**

### 2. "Only certain people can approve certain types of requests"

**Not supported today. This is the single biggest gap in the model.**

The authority check is `policyAllows(policy, capability, role, extraRoles, uid)`
— there is **no request-type parameter**. `RequestType` is `string` (open,
org-configurable), and it never reaches an authority decision. Any member with
`ticket.eng_review` can approve *every* type of request.

This is `DRAFT-1`, and report `02` sets out the two ways to close it.

### 3. "Route requests to the drafting manager first for triage"

**You already have this, and it already works the way you described.**

`WorkflowEngine.getInitialStatus` returns `PENDING_ASSIGNMENT` for everything —
type and requester role are both ignored. Engineering review is an *optional*
branch the assigner triggers with "Flag for Engineering Review," never an
automatic gate. `lib/ticketRouting.ts` targets the `DraftingSupervisor` when one
is set, falling back to Admins, with an org setting for whether Admins keep
receiving.

So the triage-first shape is built. What's missing is the *teeth*: the assigner
can approve or reject, but nothing records **why** a request was rejected as
out-of-scope, and there is no reason taxonomy to make "we don't do that" a
first-class outcome. See `DRAFT-4`.

### 4. "Assign profiles instead of multiple role additions"

**The mechanism you're describing already exists — it's called a user grant.**

`lib/capabilityPolicy.ts` supports **per-person delegation of a single
capability**, additive-only, with an optional expiry:

```ts
addUserGrant({ orgId, uid, cap: "ticket.assign", expiresAt: "2026-09-30", note: "…" })
```

Grants ride the same evaluator as roles, so there is no parallel system to
collide with, and every policy change is audited with a full before/after.

That is a better fit for your problem than adding roles, and it is already
built. The catch is `ADD-1`/`ADD-2`: the additive role array is barely plumbed
in, and the admin simulator that's supposed to let you *verify* a person's
authority evaluates it differently than production does.

### 5. "Windows makes you grant a whole directory — I was trying to solve that"

**You did solve it. The model is materially better than NTFS.** A document can
carry its own ACL, `inherit: false` breaks the chain at any node, `hidden` /
`private` visibility supports blind-drilling to a single file via an explicit
`discover` grant, rules carry expiry, and it is enforced at the **database** as
a `RESTRICTIVE` policy — not just in the UI.

Three real caveats, in report `03`:

- **`DOCACL-1`** — role-based rules match the primary role only, so a rule
  naming `Drafter` misses a Manager who is also a Drafter.
- **`DOCACL-2`** — the default is *open*. `visibility = 'normal'` returns true
  for every org member, so this is deny-by-exception, not grant-by-exception.
  That is the opposite of the NTFS default and worth deciding deliberately.
- **`DOCACL-3`** — `Admin` and `DocCtrl` see everything, always, with no
  override. You cannot scope a document controller to one library.

### 6. "Project ownership, and the AI"

Both sit **outside** the capability policy entirely, on their own hardcoded
rails. Project membership is a separate three-value role (`owner` /
`collaborator` / `observer`, of which `observer` does nothing — see the previous
run's `UX-14`), and the AI orchestrator reads the singular `member.role`.
**Not yet audited in depth** — see the status banner.

### 7. "Does it scale to everything?"

**The chassis does. The coverage does not.**

The capability policy is a genuinely good design — 17 capabilities, org
configurable, per-person grants, critical-capability guardrails, server-enforced,
fully audited. It would carry the whole app.

But it currently covers **requests, holds, checkouts and two admin pages** and
nothing else. The entire Project Controls program — costs, quality, companies,
the closeout gates — was built on hardcoded `is_org_controller` /
`user_owns_project` checks with no capability ids at all. Every new surface has
so far re-invented its own authority instead of registering a capability. That
is the thing that will not scale. See `SCALE-1`.

---

## Reports

| # | Report | Findings | Focus | State |
|---|---|---|---|---|
| 01 | [Role inventory](./01-role-inventory.md) | 6 | Which of the 19 are real, which are dead, and why | Written |
| 02 | [Drafting authority & routing](./02-drafting-authority.md) | 5 | Approval by request type; triage-first routing | Written |
| 03 | [Document control ACL](./03-document-control-acl.md) | 5 | The per-file / per-subfolder grant model | Written — **ownership axis missing** |
| 04 | [Additive roles vs primary role](./04-additive-roles.md) | 5 | The half-finished migration underneath everything | Written |
| — | Ownership & publish authority | — | Library / folder / document ownership, per-library publish | **Not yet written** |
| — | DB authority function map | — | All 23 functions, contradictions, `search_path`, service-role bypasses | **Not yet written** |
| — | Content egress | — | Every door content can leave through | **Not yet written** |
| — | Non-document surfaces | — | Teams, projects, checkouts, holds, AI, admin, restore, cron | **Not yet written** |
| — | Coupling & change impact | — | Per-role blast radius, layer contradictions, scaling | **Not yet written** |

**21 findings so far** — 2 CRITICAL, 10 HIGH, 9 MEDIUM. The count will grow
substantially; treat it as a floor, not a total.

---

## The one structural recommendation

If you change one thing, make it this:

> **Stop adding roles. Start adding capabilities, and use teams for grouping.**

The roster grew to 19 because every new distinction needed a name. But the model
already separates the three concerns properly, and you are only using one of
them:

| Concern | Right mechanism | Status |
|---|---|---|
| *What may this person do?* | Capability + per-person grant | Built, barely used |
| *Which people belong together?* | **Team** | Built, admin UI exists, **additive and correctly evaluated** — a user's every team counts, unlike their roles |
| *What is this person called?* | Role | Doing all three jobs today |

Teams are the direct answer to your department problem. `team_members` is a
proper join table, `team` is a first-class ACL subject, and `node_visible`
aggregates **all** of a user's teams — so unlike roles, a team grant never gets
shadowed by a higher-ranked one. Six department roles become six teams and
immediately start working.

Then the roster shrinks to what actually carries authority: `Admin`, `Manager`,
`Supervisor`, `DraftingSupervisor`, `DocCtrl`, `Engineer`, `Drafter`,
`Requester`, `Auditor`, `Viewer` — ten roles, each with a distinct capability
set, with request-type scoping added on top (`DRAFT-1`).

---

## Method & limits

- Every role string was counted across `app/`, `lib/`, `components/`, `types/`,
  then each hit classified as an authority gate, an ACL subject list, or a
  label. Counts in report `01` are from that pass.
- The database side was read from the migration set, including every definition
  of `node_visible`, `acl_subject_in_bucket` and the capability helpers.
- **No live database.** RLS findings are read from policy and function bodies.
  They are unambiguous reads, but a staging repro would confirm them.
- **No browser.** The `ViewAsSimulator` divergence (`ADD-2`) is confirmed by
  comparing the arguments it passes against the arguments production passes; the
  visible symptom was not observed.
