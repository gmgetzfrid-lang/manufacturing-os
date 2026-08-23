# Audit Reports

Findings from read-only audits of this codebase, written so an agent can pick up
a report, **work it to completion without asking anyone**, and record what it
did.

**One folder per area of the app.** Everything about the Projects tabs lives in
`projects-tab/`; everything about roles and permissions lives in
`roles-and-permissions/`. **Areas are never mixed** — an agent working one area
never has to filter out another's findings, and each area carries its own
machine-readable index covering only itself.

```
audit-reports/
├── README.md                    ← you are here (the protocol)
├── DECISIONS.md                 ← every judgment call, pre-made and binding
├── build-index.mjs              ← regenerates every area's findings.json
├── projects-tab/
│   ├── README.md                ← that area's index, scope, and method
│   ├── findings.json            ← THIS AREA ONLY
│   └── NN-<domain>.md           ← one report per domain
├── roles-and-permissions/
│   ├── README.md
│   ├── findings.json            ← THIS AREA ONLY
│   ├── NN-<domain>.md
│   ├── 90-gap-register.md       ← build specs for missing capabilities
│   └── 99-fix-sequencing.md     ← the execution order. Read it first.
├── drafting-flow/
│   ├── README.md                ← includes the root-cause clusters. Read before claiming.
    ├── findings.json
    ├── 01–05 … design read      ← tiering, friction, wiring, leaks, discoverability
    ├── 06–12 … deep read        ← adversarially verified against the code
    ├── 13 … ⚠ UNVERIFIED        ← completeness critic; reproduce before acting
│   ├── 90-gap-register.md
│   └── 99-fix-sequencing.md
├── notifications/
│   ├── README.md                ← the direct answers live here
│   ├── findings.json
│   ├── 01–07 … verified
│   ├── 08 … verified by hand (record in-file)
│   ├── 90-gap-register.md
│   └── 99-fix-sequencing.md
├── intelligence/
    ├── README.md                ← the one idea, and the direct answers
    ├── findings.json
    ├── 01–20 … verified (246 of 273 survived refutation)
    ├── 21 … ⚠ UNVERIFIED
│   ├── 90-gap-register.md       ← GAP-301+
│   └── 99-fix-sequencing.md     ← three redo-pairs
├── document-control/            ← the core of the product
├── projects-and-cost/
├── admin-and-org/
└── public-surfaces/
```

The four areas above came from one 47-agent run and **share a cross-area cluster**
restated at the top of each of their sequencing files: seven CRITICALs saying the
field is told the wrong answer. Fix that as one piece of work, not seven.

To regenerate the indexes after editing any report:

```
node audit-reports/build-index.mjs
```

---

## ⚠ READ THIS FIRST — how to treat code in these reports

**These reports are an audit, not a patch set.**

Every code block, SQL snippet, schema sketch and `Remediation` section is
**illustrative** — written to make a finding concrete and show one plausible
direction. It is:

- **NOT tested.** None of it has been compiled, run, or executed against a
  database.
- **NOT written against the current file.** It was written from a snapshot and
  the code has almost certainly moved.
- **NOT a patch.** Do not apply any snippet verbatim, ever.

### What IS binding

| Source | Why it binds |
|---|---|
| **Mechanism** | What the code actually does today. Verify it; if it no longer holds, the finding is `INVALID`. |
| **Failure scenario** | Why it matters. This is the problem you are solving. |
| **Done when** | The acceptance criteria. This is the contract. |
| **[`DECISIONS.md`](./DECISIONS.md)** | The judgment calls, already made. You do not re-litigate these. |
| **Verified sound — do not break** | Load-bearing invariants. A fix that requires changing one of these is a design error in the fix. |

**Solve the `Failure scenario` so the `Done when` criteria hold.** How you get
there is your engineering judgement against the real code, not the report's
guess.

---

## You are working autonomously

There is no reviewer. Nobody is going to catch your mistake, and nobody is
waiting to answer a question. That cuts both ways, and the protocol reflects
both halves:

**You have more authority than a reviewed process would give you.** You may
mark a finding `INVALID`. You may mark it `WONTFIX`. You may delete dead code
where a decision says to. You may build the capabilities in the gap register.
You do not need permission for any of it.

**You carry the whole evidence burden.** Every `RESOLVED` has to stand on its
own to a reader who was not there — see `DEC-29`. "It looked right" is not a
result. A green build is not a result. A reproduction, a test that failed before
and passes after, and the `Done when` criteria individually checked — that is a
result.

### Where a judgment call is needed

**[`DECISIONS.md`](./DECISIONS.md) has already made it.** Forty calls covering
the role model, ownership, the workflow, the admin surfaces, the document
lifecycle, the review model, and this protocol. A report that used to say *"a
human must decide"* now cites a `DEC-` id. Follow it.

⚠ **`DEC-33`…`DEC-40` carry stated facility policy and override earlier
guidance where they conflict** — including guidance inside the drafting-flow gap
register, which is marked inline where it was revised.

If you hit a call that genuinely is not covered: **do not stop.** Make it
yourself using the same standard — pick the option that fails safe for a
PSM/OSHA-regulated document-control system, record it in your `Resolution` block
with your reasoning, and keep going. Then add it to `DECISIONS.md` as the next
free `DEC-` number so the next agent inherits it rather than re-deciding it.

### Where you stop

There is still a halt condition. It just does not involve waiting — see
`DEC-27`. Set `Status: BLOCKED`, write a `Blocker` block saying exactly what is
unresolvable and what you tried, and **move to the next finding.** Halt on:

1. The finding does not reproduce → `INVALID` (with quoted contradicting code).
2. The fix would require changing a "Verified sound" invariant.
3. Two readings give materially different behaviour and the code does not settle
   it.
4. The fix needs live database state you cannot observe → `DEC-30`.
5. The blast radius exceeds the scope rule → `DEC-31`.

A `BLOCKED` finding is a result. It is worth more than a guessed fix and far
more than silence.

---

## For the resolving agent

### Pick up work

1. **Pick one area folder.** Read its `README.md` — scope, headline, ordering
   constraints.
2. **Read that area's `99-fix-sequencing.md` if it has one, before you start.**
   In `roles-and-permissions` this is not advisory. Three one-line fixes activate
   guards that have never executed, and one RLS fix converts a security hole into
   silent data loss if shipped alone. The order is the safety.
3. **Claim the report file** (`DEC-32`) — one agent owns one file end to end.
   Commit the claim before starting.
4. Work findings in severity order — `CRITICAL` → `HIGH` → `MEDIUM` — **unless
   the sequencing file says otherwise, in which case it wins.**
5. One report file per session. Never two areas at once.

### Every finding carries

| Field | Meaning |
|---|---|
| **ID** | Stable handle, e.g. `SEC-3`. Never renumber. Cite it in commits and PRs. |
| **Severity** | `CRITICAL` / `HIGH` / `MEDIUM` |
| **Status** | `OPEN` / `IN_PROGRESS` / `RESOLVED` / `WONTFIX` / `INVALID` / `BLOCKED` |
| **Verification** | `CONFIRMED` (code path traced) or `SUSPECTED` (mechanism real, consequence unobserved). This is the *finder's* assessment — see `verified_by` for who challenged it. |
| **`verified_by`** | **How hard the claim was challenged, and by whom.** Index-only field; see the table below. |
| **Locations** | `path:line` anchors. **Line numbers drift** — match on the quoted code, not the number. |
| **Mechanism** | What the code actually does. |
| **Failure scenario** | The concrete way it hurts someone. |
| **Remediation** | **Illustrative only.** Not a patch, not a spec, not a decision. |
| **Chain reaction** | What else is coupled to this. Read before touching shared code. |
| **Done when** | Acceptance criteria. **This is the contract.** |

### How much to trust a finding — `verified_by`

`findings.json` carries a `verified_by` on every entry. **It is not the same as
`Verification`.** `Verification` is what the finder concluded; `verified_by` is
who, if anyone, tried to prove them wrong.

| Value | What happened | How to treat it |
|---|---|---|
| `adversarial` | A second agent read the cited code specifically to refute the claim during the original run. Refuted findings were dropped; survivors may carry a `Verifier correction` that overrides the finder's severity or citations. | Strongest grade in the corpus. Still reproduce before fixing (`DEC-29`). |
| `hardening-pass` | Re-read against source in the corpus hardening pass, with intent to refute. Carries a `Re-verified` line saying exactly what was checked. | Equivalent in rigour to `adversarial`, but by one reader rather than a separate agent. |
| `author` | Checked only by whoever wrote it, with no independent challenge. **No finding carries this grade any more** — the value survives so that a newly written finding is labelled honestly until someone challenges it. | Reproduce before acting, and read the severity as the author's own estimate. |
| `unverified` | From a completeness critic that ran *after* the verification stage. **No finding carries this any more** either. | Treat as `SUSPECTED` regardless of the stated `Verification`. |

**Every finding in the corpus has been challenged** — 1,098 of 1,098, split 734
`adversarial` and 364 `hardening-pass`. Nothing is `author` or `unverified`.

The two grades are not identical and the difference is worth knowing.
`adversarial` means a **separate agent** tried to refute the claim during the
original run, and the refutation is preserved. `hardening-pass` means the cited
code was re-read with intent to refute and the result recorded per finding —
equal in rigour, but by one reader rather than an independent second party.

**The floor of that is stated on the findings themselves.** Every entry in
`identity-and-session` carries an explicit independence caveat: that area was
written and verified in the same session, which makes it a re-read rather than a
challenge. Treat it as `author`-grade until someone else reads it.

**When you sort a queue, sort by severity *and* `verified_by`.**

### Before you change one line

1. **Re-read the cited code.** Line numbers drift; whole files get rewritten.
2. **Reproduce the finding.** If it does not reproduce, mark it `INVALID` with
   quoted contradicting code and stop. That is a valid, valuable outcome.
3. **Design the fix yourself** against what is actually there.
4. **If the report's suggestion conflicts with the code, the code wins.** Note
   the divergence in your `Resolution` block.
5. **Check the `Chain reaction` / `Related` notes** before touching anything
   shared. Several findings share a root cause; fixing the root once beats fixing
   five symptoms five ways.

### The bar for `RESOLVED` (`DEC-29`)

All five, every time:

1. **Reproduce first** — demonstrate the finding is real against current code.
2. **Test first where testable** — a failing test before, passing after, named in
   the `Resolution` block. If genuinely untestable, say so and say how you
   verified instead.
3. **Every `Done when` criterion checked individually.**
4. **The ship loop passes:** `npx tsc --noEmit` → `npx eslint <touched files>` →
   `npx vitest run` → full `next build`.
5. **Nothing in "Verified sound" changed.** Diff-check it.

### Migrations are applied by hand (`DEC-30`)

**Never assume a migration is applied, and never mark a finding `RESOLVED`
because a migration file exists.** Write the file *and* paste the complete SQL in
your response, mark the code half `RESOLVED`, and add an explicit
`Pending migration:` line. Where a fix depends on production data you cannot
observe, write the inventory query into the `Resolution` block and mark the
finding `BLOCKED` with that query as the unblocking step.

### Scope (`DEC-31`)

**Fix the finding, not the neighbourhood.** If a fix would touch more than
roughly five files, or change a public signature used in more than three places:
implement the narrowest piece that satisfies `Done when`, mark that `RESOLVED`,
and open a new finding with the next free ID for the remainder.

A finding that describes a systemic pattern is describing **why** a specific
narrow defect exists. It is not authorization to convert every call site. When a
report says a change is "a signature change across four evaluators", ship those
four together and nothing else.

### Record what you did

Edit the finding in place. Change `Status`, and append:

```markdown
- **Status:** RESOLVED

**Resolution.** <what changed, in one or two sentences>
- Commit: `<sha>`
- Files: `path/to/file.ts`, `path/to/other.ts`
- Tests: `lib/__tests__/foo.test.ts::"pins the zero-match case"`
- Reproduced: <how you confirmed the finding was real before fixing it>
- Verified: <how you know it works — test output, traced path, manual check>
- Pending migration: `supabase/migrations/<file>.sql` (if any)
```

Then update the run's `README.md` progress table and regenerate `findings.json`.

### Rules

- **Do not renumber, merge, or delete findings.** A finding you disagree with
  gets `INVALID` and a `Resolution` block explaining why. The record of what was
  looked at matters as much as the record of what was fixed.
- **Do not mark `RESOLVED` without a test** where the finding is testable.
- **Verify before you fix.** Some findings are `SUSPECTED`; some `CONFIRMED` ones
  may have been overtaken by later commits.
- **Never upgrade a `SUSPECTED` verification to `CONFIRMED`** unless you actually
  observed the consequence. Convenience is not evidence.
- **New defects you spot while working get a new ID** in the same report, not a
  silent fold-in.
- **Respect the dependency notes.** Resolving a shared root first is usually
  cheaper.

---

## This is a running production system

It is a PSM/OSHA-regulated document-control system. A permissions or
document-control change that is wrong does not merely cause a bug — it can hide a
drawing from the person who needs it, expose one that should be restricted, or
let an unqualified person approve a safety review.

That is not a reason to do less. It is the reason the evidence bar above is what
it is, and the reason `99-fix-sequencing.md` is binding rather than advisory. Work
the findings; prove each one.

---

## The gap register

Three areas carry a `90-gap-register.md` holding `GAP-` entries: capabilities the
system needs and does not have, most of them stated requirements from the
system's owner. The numbering never collides —
`roles-and-permissions` uses `GAP-1`…`GAP-15`, `drafting-flow` `GAP-101`…`GAP-114`,
`notifications` `GAP-201`…`GAP-207`, `intelligence` `GAP-301`…`GAP-312`, `projects-tab` `GAP-401`…`GAP-410`.

**These are build work.** Each carries a verdict, a scope, a design direction, its
dependencies, its acceptance criteria, and a `Do not` list naming the specific
wrong turn an implementing agent would otherwise take. Build them in the order
`99-fix-sequencing.md` gives.

They are held to the same evidence bar as findings, and several are explicitly
scoped **narrower** than the original requirement — the reduced version and what
was deliberately cut are stated in each spec.

---

## Status vocabulary

- **OPEN** — untouched.
- **IN_PROGRESS** — claimed. Never leave a session with a finding in this state.
- **RESOLVED** — fixed, verified, and the `Done when` criteria hold.
- **BLOCKED** — cannot proceed for one of the five reasons in `DEC-27`. Requires
  a `Blocker` block saying what is unresolvable and what you tried.
- **WONTFIX** — real, but deliberately not fixed. Requires the cost, the rejected
  alternative, and what would change the answer. On a `CRITICAL`, requires an
  independent second verification pass recorded in the block.
- **INVALID** — does not reproduce, or the analysis was wrong. Requires quoted
  contradicting code with `file:line`.

---

## Areas

| Area | Scope | Findings | Gaps | Index |
|---|---|---|---|---|
| **Projects tab** | The Projects tabs + the Project Controls program merged in PR #181 (`6a14d7d`) | 133 | 10 | [`projects-tab/`](./projects-tab/README.md) |
| **Roles & permissions** | The whole authority model: roles, additive roles, capability policy, content ACL, ownership & publish, the drafting workflow, document lifecycle, delegation & teams, non-document surfaces, content egress, and the database functions underneath | 124 | 15 | [`roles-and-permissions/`](./roles-and-permissions/README.md) |
| **Document control** | Checkout & the lock, revisions & publish, the review gate & e-signatures, holds, distribution & acknowledgment, transmittals, packages, retention & archive, content egress, and the RLS underneath | 147 | — | [`document-control/`](./document-control/README.md) |
| **Projects & cost** | The project model and server behaviour beneath the tabs, scheduling & critical path, the quality program, cost & bid tabulation, and the external contractor door | 69 | — | [`projects-and-cost/`](./projects-and-cost/README.md) |
| **Admin & org** | Org lifecycle & membership, export/backup/restore, the audit log & admin rails, billing & quotas | 55 | — | [`admin-and-org/`](./admin-and-org/README.md) |
| **Public & field** | The unauthenticated verify endpoints, share links, the physical bridge (QR/labels/stamps/print), and offline | 54 | — | [`public-surfaces/`](./public-surfaces/README.md) |
| **Intelligence layer** | Knowledge ingestion, ask & retrieval, embeddings, AI governance, the org graph, link proposals, the Site Codebook, the equipment Bridge, operating areas, process flows, drawing intelligence and the orchestrator — plus the document section's permission boundary | 258 | 12 | [`intelligence/`](./intelligence/README.md) |
| **Notifications & alerts** | Every way the app tells a person something: the bell, sidebar badges, toasts, the corner dock, progress indicators, email, and the service worker — producers, delivery, taxonomy, the badge trail, realtime, stacking, and the OS-notification substrate | 105 | 7 | [`notifications/`](./notifications/README.md) |
| **Drafting request flow** | The request flow end to end — intake, triage, assignment, drafting, review, approval, issue, closure — plus review tiering, document-control wiring, friction and latency, leaks, discoverability, and a second deep pass over the state machine, RLS, routing, authority surfaces, audit evidence, the document handoff and the Projects boundary | 139 | 14 | [`drafting-flow/`](./drafting-flow/README.md) |

**Areas overlap deliberately.** `roles-and-permissions` covered *authority* in
the drafting flow; `drafting-flow` covers *friction, wiring and
discoverability*. A defect belonging to both is recorded in full in one place and
cross-referenced from the other — never duplicated. Cross-references name the
owning ID, so follow them rather than fixing twice.

Both audits were **read-only**. No application code, test, or migration was
modified by either.
