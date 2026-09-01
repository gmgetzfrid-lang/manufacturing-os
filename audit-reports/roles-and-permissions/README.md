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

### Adversarial review round — 2026-08-24 (every line changed this session)

After the migration verification, a **57-agent review fleet** (one adversarial
reviewer per logical cluster of the session's diff, then two independent
skeptics per finding — one reproducing the failure, one hunting a guard
elsewhere) swept all 57 files / ~3,000 lines changed this session. Outcome:
**18 confirmed findings, 2 split verdicts (both verified real on manual
re-check), 3 refuted; 2 clusters fully clean** (the share-egress routes and
the capability-policy fix). Every confirmed and split finding is FIXED, with
tests pinning each; details live as dated **"Hardened / Completed /
corrected (2026-08-24 adversarial-review round)"** notes inside the affected
findings' own records (`DB-4`, `DB-5`, `DB-3`, `DB-6`, `SURF-2`, `SURF-5`,
`EGRESS-1`, `EGRESS-5`, `EGRESS-7` → RESOLVED, `LIFE-13`). The heaviest:

- `lib/aclIndexRebuild.ts` could persist over-stripped (fail-open) indexes
  from failed or 1000-row-truncated reads, and never rebuilt `document_sets`
  at all — reads are now paginated + error-checked, orgs with failed reads
  are skipped whole, write failures surface into the cron's `errors`, sets
  are covered.
- `mergeWizardLibraryAcl` split rules by subject type; the wizard's own
  org-wide "Everyone" rule survived a restricting edit (fail-open) while
  drawer role-denies/publish grants were stripped (fail-closed) — the merge
  now splits by rule OWNERSHIP, and the page caches the merged ACL it
  actually persisted.
- `/api/storage/delete` wrote its custody row after destruction behind dead
  catch — it now writes custody BEFORE `r2.send` and fails closed on it.
- `document_shares.created_by` — the share's authority anchor — was
  forgeable at INSERT and repointable at UPDATE:
  **new migration `20261026_document_shares_anchor_integrity.sql`, applied &
  verified live 2026-08-24** (three-point probe all true).
- The `searchPathPin` lint censused re-created functions as dropped (fail
  open); its parser is corrected with drift self-checks.

Ship loop green after the round: `tsc`, `eslint`, full vitest, `next build`.

**2026-08-24 — ALL SEVEN MIGRATIONS VERIFIED APPLIED IN THE LIVE DATABASE.**
The operator pasted `supabase/APPLY_roles-and-permissions_2026-08-24.sql` (the
combined, idempotent script covering `20261019`–`20261025`) into the Supabase
SQL editor, then ran a 7-point read-only probe (one row per fix: old
`publish_revision` signature gone, every `SECURITY DEFINER` function pinned,
owner indexes, `document_shares` per-verb policies, `access_requests` scope,
roles backfill, `org_capability_allows`/`acl_index_denies` typo fixes). All
seven returned `applied = true`. The "pending hand-applied migration" caveats
below are therefore historical — code and database now agree for this area.

### Phase 3 — close the publish path (session 2026-08-24, continued)

| Item | Outcome |
|---|---|
| `OWN-14` (HIGH, Trap-2 prerequisite) | **RESOLVED** — all six named silent-write sites (plus five Trap-2 companions and two catch-less UI callers) now fail loudly; audit rows and notifications write only after a landed write; legal-hold counts are real |
| `OWN-1` (CRITICAL) | **RESOLVED** — 17-column sensitive-column guard on `libraries` (controller / current owner / manage-grant), cosmetic columns left member-writable per the 30-writer recon map; DELETE controllers-only RESTRICTIVE — migration `20261036` |
| `OWN-2` / `DEC-6` (CRITICAL) | **RESOLVED** — the documents access-change guard now covers `owner_user_id`/`owner_name`: takeover refused, current owner may reassign, first-claim on unowned default-open docs preserved — migration `20261036` |
| `OWN-5` (CRITICAL) | **RESOLVED** — `publish_revision` derives its actor from `auth.uid()` (forged `p_actor` refused), the branch path carries the promote's authority bar, EXECUTE revoked from PUBLIC; the v1 retry that upgraded a checkout-override into a controller force is retired — migration `20261036` |
| `OWN-4` (CRITICAL) | **RESOLVED** — intake auto-supersede now fails closed on holds, blocks on checkout, runs under the link CREATOR's live publish authority, and never stamps an unreviewed upload `approved`; failures demote to the pending-review path with the reason surfaced |

Remaining in Phase 3: `GAP-15`/`DEC-7` (the ownership branch in `node_visible` — read-visibility, lands separately) and `EGRESS-6` (the `document_versions` write overlay — last, on top of real authority checks). Ship loop green: `tsc`, `eslint`, **1602 vitest** (18 new), full `next build`. Migration `20261036_rp_phase3_publish_path.sql` **applied & verified live 2026-08-24** (6-point probe all true; inventory all zero).

### Phase 2 — database honesty (the trap phase)

| Item | Outcome |
|---|---|
| `DB-3` / `DEC-1` step 1 | **RESOLVED** — signup seeds `roles:['Admin']`; backfill migration for existing rows. Prerequisite for all additive conversion |
| `DB-5` | **RESOLVED** — wizard writes `acl_index` and **merges** drawer grants (no over-revocation) |
| `DB-4` / `OWN-7` / `DEC-10` | **RESOLVED** — expiry-aware index builder + diff-guarded nightly rebuild; window narrowed to one cron cycle, not closed |
| `DB-1` (CRITICAL) | **RESOLVED** — after the operator ran the inventory. Phantom `value` column → `data` in both the app (`lib/capabilityPolicy.ts`) and the SQL (`org_capability_allows`); defaults + the roles backfill preserve behaviour (no lockout). Migration `20261025` |
| `DB-2` (CRITICAL) | **RESOLVED** — `acl_index_denies` reads `team_members.uid` (was the phantom `user_id`). Inventory: 691 deny docs, no new lockouts. Migration `20261025` |
| `DEC-1` steps 2–3 | **Deferred** — the SQL rank function + `org_members` trigger "touches every membership row"; depends on `DB-3`'s backfill being applied first, and is safest shipped as its own change |

**Note on DB-1/DB-2:** these were initially held as `BLOCKED` per `DEC-30`
because they can activate dormant enforcement against production state I could
not observe. Once the operator ran the inventory query (691 deny documents),
the analysis showed the fixes preserve behaviour — shipped defaults keep holds
open, the roles backfill keeps Admin force-release working, and no new document
lockouts result — so both were completed. Migration `20261025` (apply after
`20261024`).

### Phase 1 — the unauthenticated & cross-tenant doors (highest severity)

| Item | Outcome |
|---|---|
| `EGRESS-2` (CRITICAL) | **RESOLVED** — `/d/[number]` no longer resolves documents; it forwards to the protected page, which resolves client-side under RLS |
| `SURF-2` (CRITICAL) | **RESOLVED** — storage delete requires controller authority, safe key, fail-closed hold check, audit row (also closes `document-control/RET-2`, `intelligence/DACL-2`) |
| `EGRESS-1` (CRITICAL) | **RESOLVED** — cross-org share leak confirmed then closed: org-join + creator-authority re-check in both routes, per-verb RLS migration |
| `SURF-5` (HIGH) | **RESOLVED** Done-when 1–2 (cross-tenant drain); Done-when 3 (queue-insert lockdown) split to `SURF-17` |
| `EGRESS-5` / `DEC-19` (HIGH) | **RESOLVED** — org-scoped policy, rate-limited public door, org_id drift fixed, pending-requests card on `/admin/users` |

**Hand-applied migrations from Phase 1 (DEC-30):**
`20261022_document_shares_acl_scope.sql`,
`20261023_access_requests_scope_and_limit.sql` — **applied & verified in the
live database 2026-08-24** (see the verification note at the top of this
section).

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
| `DB-6` | **RESOLVED** — `20261020_pin_search_path.sql` + lint test; migration **applied & verified in the live database 2026-08-24** |
| `DEC-11` removals | `p_actor_role` retired (`20261019`), dead exports removed, owner indexes added (`20261021`), Capability vocabulary marked picker-only |
| `GAP-12` | **BUILT** — ownership columns/export on the console, wizard owner picker, menu renames |

**Hand-applied migrations (DEC-30), in order:**
`20261019_publish_revision_drop_dead_param.sql` →
`20261020_pin_search_path.sql` → `20261021_owner_lookup_indexes.sql` —
**applied & verified in the live database 2026-08-24.**

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
- **No live database** *(at audit time — partially lifted 2026-08-24: the
  operator ran read-only probes from the Supabase SQL editor, confirming the
  `documents_deny_write_guard` trigger and both broken functions existed live —
  the "live bug" world — counting 691 deny-carrying documents, and verifying
  all seven remediation migrations applied)*. RLS findings are read from policy
  and function bodies. They are unambiguous reads, but migrations here are
  applied by hand, so the deployed state may carry drift the repository does
  not show. **A staging
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
