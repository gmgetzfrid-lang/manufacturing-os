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
| **Remediation** | The suggested fix. It is a starting point, not a specification. |
| **Done when** | Acceptance criteria. Do not mark `RESOLVED` until these hold. |

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
