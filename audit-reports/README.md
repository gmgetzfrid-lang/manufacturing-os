# Audit Reports

Findings from read-only audits of this codebase, written so that an agent can
pick up a report, work it end to end, and record what it did.

Each audit run lives in its own dated folder. Each report inside a run is a
self-contained file covering one domain, sized to be worked in a single agent
context.

```
audit-reports/
├── README.md                        ← you are here (the protocol)
├── findings.json                    ← machine-readable index of every finding
└── <YYYY-MM-DD>-<run-name>/
    ├── README.md                    ← that run's index, scope, and method
    └── NN-<domain>.md               ← one report per domain
```

---

## ⚠ READ THIS FIRST — how to treat code in these reports

**These reports are an audit, not a patch set. Nothing in them is authorization
to change anything.**

Every code block, SQL snippet, schema sketch and `Remediation` section in every
report is **illustrative** — written to make a finding concrete and show one
plausible direction. It is:

- **NOT tested.** None of it has been compiled, run, or executed against a
  database.
- **NOT written against the current file.** It was written from a snapshot and
  the code has almost certainly moved.
- **NOT a patch.** Do not apply any snippet verbatim, ever.
- **NOT a design decision.** Where a remediation offers options A and B, the
  choice is the owner's, not yours.

### What IS binding

Three fields, and only these three:

| Field | Why it binds |
|---|---|
| **Mechanism** | What the code actually does today. Verify it; if it no longer holds, the finding is `INVALID`. |
| **Failure scenario** | Why it matters. This is the problem you are solving. |
| **Done when** | The acceptance criteria. This is the contract. |

**Solve the `Failure scenario` so the `Done when` criteria hold.** How you get
there is your engineering judgement against the real code, not the report's
guess.

### Before you change one line

1. **Re-read the cited code.** Line numbers drift; whole files get rewritten.
2. **Reproduce the finding.** If it does not reproduce, mark it `INVALID` with
   evidence and stop. That is a valid, valuable outcome.
3. **Design the fix yourself** against what is actually there.
4. **If the report's suggestion conflicts with the code, the code wins.** Note
   the divergence in your `Resolution` block.
5. **Check the `Chain reaction` / `Related` notes** before touching anything
   shared. Several findings share a root cause; fixing the root once beats
   fixing five symptoms five ways.

### Scope discipline — this is the important one

**No report in this directory ever authorizes a sweeping refactor, a rewrite, a
migration of the whole role model, or "changing everything."** If a report reads
that way to you, you are reading it wrong.

- Findings are deliberately **narrow and independently resolvable**. Work **one
  finding at a time.**
- A finding that describes a systemic pattern (e.g. "94% of the app reads the
  primary role") is describing **why** a specific narrow defect exists. It is
  **not** an instruction to convert 204 call sites.
- Where a report proposes a phased sequence, **the phases are separate pieces of
  work.** Do not collapse them.
- If a fix appears to require touching more than a handful of files, **stop and
  ask a human.** That is a design decision, not a bug fix.
- Never delete a role, a column, a capability or a policy because a report calls
  it "dead." Dead-code findings are for a human to decide on — removal is
  irreversible and the report may be wrong.

### Two different kinds of entry — do not confuse them

Reports contain two kinds of item, and they carry **completely different
authority**:

| | **Finding** | **Gap-register entry** |
|---|---|---|
| Says | Something is **wrong** | Something is **missing** |
| Evidence | Traced code that misbehaves | A requirement the owner stated, and what exists nearest |
| Has an ID | Yes (`SEC-3`, `OWN-2`, …) | Yes, prefixed `GAP-` |
| You may | Fix it, within its narrow scope | **Nothing — read only** |

**A `GAP-` entry is not a work order.** It is a requirement captured during the
audit so it is not lost. Gaps describe *features that do not exist*. Building a
feature is a design decision with a cost, a schema, a UI and a migration — it
needs a human to scope it and approve it.

**If you are an agent working this directory: never implement a `GAP-` entry.**
Read it, understand it, and if it blocks a finding you were fixing, stop and say
so. Gaps exist to inform a human's roadmap, not to authorize construction.

The same applies to any "what would need to exist" or "required capabilities"
prose in a report. That is analysis. It is not a specification and it is not
permission.

### This is a running production system

It is a PSM/OSHA-regulated document-control system. A permissions or
document-control change that is wrong does not merely cause a bug — it can hide
a drawing from the person who needs it, or expose one that should be
restricted, or let an unqualified person approve a safety review.

**Bias toward doing less.** A finding left `OPEN` with a good note is a better
outcome than a fix that broke a working surface.

---

## For the resolving agent

### Pick up work

1. Read `findings.json` for the full index, or a single report file for one
   domain's worth of context. `findings.json` is generated from the reports —
   **the reports are the source of truth**; regenerate the JSON if they diverge.
2. Work findings in severity order: `CRITICAL` → `HIGH` → `MEDIUM`. Within a
   severity, prefer findings whose `blast_radius` is `data-integrity`,
   `security`, or `safety` over `ux` and `performance`.
3. One report file per session is the intended unit of work. Do not try to
   resolve a whole run in one pass.

### Every finding carries

| Field | Meaning |
|---|---|
| **ID** | Stable handle, e.g. `SEC-3`. Never renumber. Cite it in commits and PRs. |
| **Severity** | `CRITICAL` / `HIGH` / `MEDIUM` |
| **Status** | `OPEN` / `IN_PROGRESS` / `RESOLVED` / `WONTFIX` / `INVALID` |
| **Verification** | `CONFIRMED` (code path traced) or `SUSPECTED` (mechanism real, consequence unobserved) |
| **Locations** | `path:line` anchors. **Line numbers drift** — match on the quoted code, not the number. |
| **Mechanism** | What the code actually does. |
| **Failure scenario** | The concrete way it hurts someone. |
| **Remediation** | **Illustrative only.** One plausible direction, untested, written against a snapshot. Not a patch, not a spec, not a decision. |
| **Chain reaction** | What else is coupled to this. Read before touching shared code. |
| **Done when** | Acceptance criteria. **This is the contract.** Do not mark `RESOLVED` until these hold. |

### Record what you did

Edit the finding in place. Change `Status`, and append a `Resolution` block:

```markdown
- **Status:** RESOLVED

**Resolution.** <what changed, in one or two sentences>
- Commit: `<sha>`
- Files: `path/to/file.ts`, `path/to/other.ts`
- Tests: `lib/__tests__/foo.test.ts::"pins the zero-match case"`
- Verified: <how you know it works — test output, traced path, manual check>
```

Then update the run's `README.md` progress table and regenerate `findings.json`.

### Rules

- **Do not renumber, merge, or delete findings.** A finding you disagree with
  gets `Status: INVALID` and a `Resolution` block explaining why. The record of
  what was looked at matters as much as the record of what was fixed.
- **Do not mark `RESOLVED` without a test** where the finding is testable
  (logic, data layer, API authorization). If it genuinely is not testable, say
  so in the `Resolution` block and explain how you verified it instead.
- **Verify before you fix.** Several findings are `SUSPECTED` and some
  `CONFIRMED` ones may have been overtaken by later commits. Re-read the cited
  code first. If it no longer reproduces, mark it `INVALID` with evidence —
  that is a real outcome, not a failure.
- **Fix the finding, not the neighbourhood.** Findings are deliberately narrow
  so they can be resolved independently. If you spot something new while
  working one, add it to the report as a new ID with the next free number
  rather than silently folding it into the fix.
- **Respect the dependency notes.** Some findings share a root cause; the ones
  that do say so under `Related`. Resolving the root first is usually cheaper.
- **Run the project's ship loop before committing:**
  `npx tsc --noEmit` → `npx eslint <touched files>` → `npx vitest run` →
  full `next build`. See `CLAUDE.md` / `docs/ARCHITECTURE.md`.
- **Migrations are applied by hand.** If a fix needs schema changes, write the
  migration file *and* paste the SQL in your response — do not assume it will
  be applied automatically.

---

## Status vocabulary

- **OPEN** — untouched.
- **IN_PROGRESS** — claimed by an agent or a person. Include who and when, so a
  stalled claim is visible.
- **RESOLVED** — fixed, verified, and the `Done when` criteria hold.
- **WONTFIX** — real, but a deliberate decision not to fix. Requires a reason
  and, for anything `CRITICAL` or `HIGH`, a human sign-off recorded in the
  `Resolution` block.
- **INVALID** — does not reproduce, or the analysis was wrong. Requires
  evidence.

---

## Runs

| Run | Date | Scope | Findings | Index |
|---|---|---|---|---|
| Project Controls | 2026-08-21 | Projects tabs + the Project Controls program merged in PR #181 (`6a14d7d`) | 133 | [`2026-08-21-project-controls/`](./2026-08-21-project-controls/README.md) |
