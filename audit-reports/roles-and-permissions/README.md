# Roles & Permissions — audit area

Read-only audit of the entire authority model: the 19-role roster, the additive
role array, the capability policy, the content ACL, **ownership and publish
authority**, the drafting workflow, the document lifecycle, delegation and teams,
every non-document surface, every door content can leave through, and the
database functions underneath all of it.

**No application code, test, or migration was modified at any point.**

---

## ⚠ Before you touch anything

1. **Read [`../README.md`](../README.md)** — the resolution protocol — and
   [`../DECISIONS.md`](../DECISIONS.md), which settles every judgment call this
   area would otherwise stop at. Code in `Remediation` sections is
   **illustrative, untested, and never a patch**.
2. **Read [`99-fix-sequencing.md`](./99-fix-sequencing.md).** In this area it is
   binding, not advisory. Three one-line changes switch on guards that have never
   executed; one RLS fix converts a security hole into silent data loss if
   shipped alone; one dead code path silently disables the document review gate
   the moment someone wires a feature to it.
3. **`GAP-` entries in [`90-gap-register.md`](./90-gap-register.md) are build
   work** — 12 buildable specs plus 3 marked `DECLINE` / `FOLD_INTO_FINDING`.
   Each carries a verdict, scope, design direction, dependencies, acceptance
   criteria, and a `Do not` list. Build order is in the sequencing file.

---

## Findings

**132 findings** — 18 CRITICAL, 45 HIGH, 65 MEDIUM, 4 LOW — plus **15 gap
specs**, of which 12 are buildable. *(Originally 124; the resolution session
added `LIFE-15`, `OWN-22`, `DB-8`, `CHAIN-7` in Phase 0 and `EGRESS-7`,
`EGRESS-8`, `SURF-17`, `SURF-18` in Phase 1, all found while working their
neighbours.)*

> **3 findings here carry `Status: REFUTED`** — `DRAFT-4`, `EGRESS-4`, `ROLE-6`. An independent pass disproved them; the reason is on the finding. Kept rather than deleted (`DEC-41`). **Do not queue them as work.**

Machine-readable index: [`findings.json`](./findings.json). `findings` and `gaps`
are separate arrays — both are work, but a gap carries a verdict and a dependency
chain rather than a severity, so a severity-sorted queue does not interleave
feature builds. Check `verdict` and `depends_on` before starting a gap.

| # | Report | Findings | Focus |
|---|---|---|---|
| 01 | [Role inventory](./01-role-inventory.md) | 6 | Which of the 19 roles are real, which are duplicates, which are labels |
| 02 | [Drafting authority & routing](./02-drafting-authority.md) | 5 | Approval by request type; triage-first routing |
| 03 | [Document control ACL](./03-document-control-acl.md) | 5 | The per-file / per-subfolder grant model |
| 04 | [Additive roles vs primary role](./04-additive-roles.md) | 5 | The half-finished migration underneath everything |
| 05 | [Ownership & publish authority](./05-ownership-publish.md) | 21 | Library/folder/document ownership as a publish grant; the 17 publish paths |
| 06 | [Request workflow & capability policy](./06-request-workflow.md) | 24 | The 12-status machine and the layer that is meant to configure it |
| 07 | [Document lifecycle & hand-offs](./07-document-lifecycle.md) | 14 | Checkout → markup → check-in → drafting request → **and back** |
| 08 | [Delegation & teams](./08-delegation-and-teams.md) | 9 | What an owner can *do*; whether teams are optional |
| 09 | [Non-document surfaces](./09-non-document-surfaces.md) | 16 | Membership, admin pages, projects, holds, retention, signatures, restore, cron |
| 10 | [Content egress](./10-content-egress.md) | 6 | Every door content can leave through |
| 11 | [Database authority functions](./11-database-authority.md) | 7 | The SQL layer: what reads what, and what is broken |
| 12 | [Coupling & change impact](./12-coupling-change-impact.md) | 6 | What a change reaches; what looks safe and is not |
| 90 | [**Gap register**](./90-gap-register.md) | 15 specs | Capabilities that do not exist. Verdict, scope, design, `Do not` traps |
| 99 | [**Execution order**](./99-fix-sequencing.md) | — | Binding. Phases, traps, and pairs that must ship together |

---

## Resolution status — session started 2026-08-24

**Phases 0, 1 and the safe parts of Phase 2 of
[`99-fix-sequencing.md`](./99-fix-sequencing.md) are complete.** Ship loop green
throughout: `tsc`, `eslint`, **1442 vitest**, full `next build`.

### Phase 2 — database honesty (the trap phase)

| Item | Outcome |
|---|---|
| `DB-3` / `DEC-1` step 1 | **RESOLVED** — signup seeds `roles:['Admin']`; backfill migration for existing rows. Prerequisite for all additive conversion |
| `DB-5` | **RESOLVED** — wizard writes `acl_index` and **merges** drawer grants (no over-revocation) |
| `DB-4` / `OWN-7` / `DEC-10` | **RESOLVED** — expiry-aware index builder + diff-guarded nightly rebuild; window narrowed to one cron cycle, not closed |
| `DB-1` (CRITICAL) | **BLOCKED** (`DEC-30`) — the two-worlds finding; activates a dormant enforcement rail against unobservable production state. World-determining query + full fix design recorded |
| `DB-2` (CRITICAL) | **BLOCKED** (`DEC-30`) — one-word fix that turns on a never-executed RESTRICTIVE guard; the required pre-ship activation inventory cannot be run here. Query + design recorded |
| `DEC-1` steps 2–3 | **Deferred** — the SQL rank function + `org_members` trigger "touches every membership row"; depends on `DB-3`'s backfill being applied first, and is safest shipped as its own change |

**Why the two CRITICALs are BLOCKED, not fixed:** both enable dormant
guards/enforcement against production data this session cannot observe. Per the
user's paramount "do not regress" constraint and `DEC-30`, that is the correct
outcome — each carries its unblocking query and complete fix design. A `BLOCKED`
finding is a result, not a gap.

### Phase 1 — the unauthenticated & cross-tenant doors (highest severity)

| Item | Outcome |
|---|---|
| `EGRESS-2` (CRITICAL) | **RESOLVED** — `/d/[number]` no longer resolves documents; it forwards to the protected page, which resolves client-side under RLS |
| `SURF-2` (CRITICAL) | **RESOLVED** — storage delete requires controller authority, safe key, fail-closed hold check, audit row (also closes `document-control/RET-2`, `intelligence/DACL-2`) |
| `EGRESS-1` (CRITICAL) | **RESOLVED** — cross-org share leak confirmed then closed: org-join + creator-authority re-check in both routes, per-verb RLS migration |
| `SURF-5` (HIGH) | **RESOLVED** Done-when 1–2 (cross-tenant drain); Done-when 3 (queue-insert lockdown) split to `SURF-17` |
| `EGRESS-5` / `DEC-19` (HIGH) | **RESOLVED** — org-scoped policy, rate-limited public door, org_id drift fixed, pending-requests card on `/admin/users` |

**Pending hand-applied migrations from Phase 1 (DEC-30), code deployed first:**
`20261022_document_shares_acl_scope.sql`,
`20261023_access_requests_scope_and_limit.sql`.

**New findings raised in Phase 1:** `EGRESS-7` (silent revoke no-op after the
UPDATE policy tightens), `EGRESS-8` (share tokens visible to non-readers),
`SURF-17` (the split queue-insert lockdown), `SURF-18` (no SELECT/UPDATE policy
on `email_notifications`).

### Phase 0 — free & independent

**Phase 0 of [`99-fix-sequencing.md`](./99-fix-sequencing.md) is complete.**
Ship loop green throughout: `tsc`, `eslint`, **1407 vitest** (23 added across 5
new test files), full `next build`.

| Item | Outcome |
|---|---|
| `LIFE-2` / `DEC-23` | **RESOLVED** — review-gate waiver deleted; test pins that a ticket id never waives review |
| `OWN-9` | **RESOLVED** — both pickers offer `DraftingSupervisor`; census test pins picker coverage of `ALL_ROLES` |
| `OWN-17` (partial) | `backfillVersion` authority gate landed; DB half waits on `EGRESS-6` (Phase 3) |
| `LIFE-5` (partial) | Relabel found **already overtaken** by intervening code — quoted in-file; body stays OPEN |
| `LIFE-13` | **RESOLVED** — ticket page renders the source-document backlink with live rev-drift check |
| `CHAIN-4` | **RESOLVED** — self-documenting model corrected claim-by-claim; Known gaps grew 3 → 5 |
| `DB-6` | **RESOLVED** (repo half) — `20261020_pin_search_path.sql` + lint test; **pending hand-applied migration** |
| `DEC-11` removals | `p_actor_role` retired (`20261019`), dead exports removed, owner indexes added (`20261021`), Capability vocabulary marked picker-only |
| `GAP-12` | **BUILT** — ownership columns/export on the console, wizard owner picker, menu renames |

**Pending hand-applied migrations (DEC-30), in order, code deployed first:**
`20261019_publish_revision_drop_dead_param.sql` →
`20261020_pin_search_path.sql` → `20261021_owner_lookup_indexes.sql`.

**New findings raised while working:** `LIFE-15` (source_document producer
shapes), `OWN-22` (Save-As path births unowned libraries), `DB-8`
(`REMEDIATION_APPLY_ALL.sql` second source of truth), `CHAIN-7` (DocCtrl
users-link vs page gate).

**Notes for the next phases, discovered en route:** the DEC-10 nightly
`acl_index` rebuild MUST filter `isRuleActive` or it re-imports expired rules
(`buildAclIndexFromRules` carries none — see `CHAIN-4`'s resolution); `OWN-6`'s
enforcement half may already be fixed in current code — re-verify before
re-fixing; the live `enforce_document_publish_guard` is the
`20260822_review_completion_guard.sql:21` definition.

---

## The headline

**The roles are not the problem.**

The role model has real issues — six department roles that gate nothing, three
duplicate Engineer tiers, and an additive migration that is genuinely half-done.
But they are second-order next to what the audit actually found:

> **Four separate paths bypass the publish guard entirely, ownership can be
> self-assigned by any member, and the confidentiality overlay has no matching
> integrity overlay.**

There are **five independent authority axes** — org role, additive role array,
capability policy, content ACL, and **ownership/publish**. The fifth was missed
in the first pass and turns out to carry the most authority: it grants publish
and supersede on controlled documents, it is reachable by any active member
(`OWN-1`, `OWN-2`), and it has no succession (`OWN-12`).

Three structural observations worth more than any individual finding:

1. **The capability layer is inert.** It reads `org_configurations.value`; the
   column is `data`. The read error is swallowed and an empty policy is cached.
   The entire 17-capability org-configurable layer, the delegation UI, and the
   "enforced server-side" promise have never worked (`DB-1`, `WF-1`).
2. **Role-based *denies* bind on any of your roles; role-based *allows* bind only
   on your headline role** — and the headline can be *demoted* by adding an
   unrelated role, because `ROLE_RANK` orders by org chart rather than by
   privilege. Adding a role can remove authority (`OWN-3`, `DB-7`).
3. **Nearly every check is grant-shaped, which fails closed.** That is why the
   additive gap is mostly an availability problem rather than a security one. The
   two restriction-shaped checks are the real security surface, and both are
   escalations (`CHAIN-1`).

---

## Answers to the questions that started this

### "Are these a bunch of dead roles?"

**Ten of nineteen carry a distinct capability set.** Four Engineer tiers collapse
to one (the token `"Engineer"` matches all four, and the code says the tiers
"were never enforced anywhere"). Seven roles grant exactly `["create_requests"]`
and nothing else.

But **none of them is free to delete.** Role identity is the role's *name*,
stored as a bare string inside customer JSON in seven places, with no version
field anywhere (`CHAIN-5`). And `Contractor` turned out to be load-bearing in a
place a first pass missed — it drives reduced navigation as a *restriction*
(`CHAIN-1`). Removal needs stable role ids and a blob migration first — which
`DEC-5` defers, so **`DEC-3` deprecates the five inert department roles in the
picker instead of deleting them**, and `DEC-4` keeps the Engineer tiers as the
labels they already are.

### "Only certain people can approve certain types of requests"

**Not supported today** — `policyAllows` takes no resource argument, and
`RequestType` reaches an authority decision in exactly one place in the codebase.
**`DEC-13` says build the resource dimension**, staged behind `WF-15` (validating
request types first, since authority keyed to unvalidated free text is a hole
rather than a feature). Spec: `GAP-1`.

### "Route requests to the drafting manager first for triage"

**Already built, and it works the way you described.** What is missing is the
teeth — no reason taxonomy that makes "we don't do that" a first-class outcome —
plus two live defects on that path (`WF-19`). `GAP-13`.

### "Assign profiles instead of multiple role additions"

**The mechanism largely exists** — per-person capability grants, additive,
expiring, audited, riding the same evaluator as roles. Two problems: it is
currently inert (`WF-1`), and it cannot reference a document or library at all
(`GAP-3`, `GAP-14`). The answer to "should I add more roles?" is no.

### "Windows makes you grant a whole directory — I was trying to solve that"

**You solved it, and the model is materially better than NTFS.** A document
carries its own ACL, `inherit: false` breaks the chain at any node, `hidden` /
`private` visibility supports blind-drilling to a single file via an explicit
`discover` grant, rules carry expiry, and it is enforced at the **database** as a
`RESTRICTIVE` policy. Its defects are real but they are defects in a sound design:
`DOCACL-1`, `DOCACL-2`, `DOCACL-3`, `OWN-7`, `DB-4`, `DB-5`.

### "Assign library owners; owners delegate a specific file"

**Half of it exists.** Per-library ownership works and can differ per library —
but it is hidden inside a modal named after a different feature, unvalidated,
silently failing, and writable by any member. **Delegation of a single file does
not exist**: the only primitive an owner can reach is ownership *reassignment*,
which is a transfer — the owner loses their own authority over that file.
`DEL-1`, `DEL-7`, `GAP-3`.

### "Teams need to be optional"

**They are, and this part is genuinely sound.** Every team lookup degrades
correctly at zero teams — verified path by path in report 08. Do not introduce a
`NOT NULL` team requirement anywhere in the ownership chain.

### "Ownership means being the approval of revision and superseding"

**Ownership grants execution, not approval.** An owner may press publish but is
never a required signer — `ReviewControl` has no owner slot. Worse, whether an
approved draft auto-publishes depends on *which reviewer happens to sign last*
(`OWN-11`). And ownership grants publish, roster, retention and legal-hold
authority **but not read access** (`DEL-2`) — an owner can be assigned to a
private library they cannot open.

### "As-built markup → drafting request → to be added"

**The first half is built and built well. The last three words do not exist.**
`close_ticket` is three lines; nothing returns the finished as-built to the
document. And there is a loaded trap waiting: `related_ticket_id` waives the
document review gate and no code path writes it — so the first person to wire
ticket→publish will silently disable reviewer sign-off on every as-built
(`LIFE-1`, `LIFE-2`, `GAP-6`).

### "Does it scale to everything?"

**The chassis does. The coverage does not.** The capability policy is a good
design that would carry the whole app. It currently covers requests, holds,
checkouts and two admin pages. The entire Project Controls program was built on
hardcoded checks with no capability ids at all. Every new surface has so far
re-invented its own authority instead of registering a capability (`SURF-9`).

---

## Method & limits

- Every role string was counted across `app/`, `lib/`, `components/`, `types/`,
  then classified as an authority gate, an ACL subject list, or a label.
- The database side was read from the full migration set, including every
  redefinition of `node_visible`, `user_is_effective_owner`,
  `enforce_document_publish_guard` and `publish_revision`.
- Eight independent analysis passes were run over separate areas, then every
  CRITICAL and most HIGH claims were **re-verified by reading the cited code
  directly** before being written up. Claims that did not survive that check were
  dropped.
- **No live database.** RLS findings are read from policy and function bodies.
  They are unambiguous reads, but migrations here are applied by hand, so the
  deployed state may carry drift the repository does not show. **A staging
  reproduction should confirm the CRITICAL findings before any of them is treated
  as certain** — see the note at the end of `99-fix-sequencing.md`.
- **No browser.** UI findings are confirmed by comparing the arguments a
  component passes against the arguments production passes; visible symptoms were
  not observed.

### One correction carried forward

An early pass classified `Contractor` as a pure label with no authority branch.
That was wrong — it is load-bearing at `components/navigation/Sidebar.tsx:248` as
a restriction-style check. The miss came from a search that matched only
double-quoted role literals. `ROLE-1` in report 01 should be read alongside
`CHAIN-1`.
