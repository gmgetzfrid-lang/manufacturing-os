# Corpus hardening — working plan

**Goal: every area at one bar, agent-ready, no standing caveats.** This file is
the resume point. If a session ends mid-way, read this, check the boxes that are
ticked, and continue from the first unticked one.

The rule governing all of it: **caveats are removed by doing the work they warn
about, never by deleting the warning.** A caveat that is deleted without the work
behind it turns a known limit into an unknown one, which is strictly worse.

Tracked against `../META-AUDIT.md`.

---

## Phase A — mechanical integrity

- [x] **MA-3** `LIFE-1`…`LIFE-13` defined in both `intelligence` and `roles-and-permissions`. Rename one series, update inbound references.
- [x] **MA-4** Add the four missing cross-links: `AUTHZ-3`↔`WF-5`, `DIST-7`↔`SHR-5`.
- [x] **MA-5** `SCALE-1` / `SCALE-3` are referenced but undefined. Resolve or remove.
- [x] **MA-7** Distinguish deliberately-out-of-repo citations (`node_modules/`, build artifacts) from wrong ones so a validator can pass them.
- [x] **MA-6a** Correct `XEDGE-3` and `XEDGE-14` citations (both cite past end-of-file).
- [x] **MA-1** Apply verifier-corrected locations into `findings.json` for the five findings whose citations were corrected in prose.

## Phase B — the load-bearing work: verify the 52 unchallenged CRITICALs

Three areas never had an independent party contest a finding. They hold 46% of
every `CRITICAL` in the engagement. Each item below means: open the cited code,
try to **refute** the claim, and record `SURVIVES` / `REFUTED` / a severity
correction in the report body.

- [x] `projects-tab` — 29 CRITICALs — **29/29 SURVIVE, 0 refuted** (2 headline query counts restated as per-item formulas)
- [x] `drafting-flow` — 8 — **8/8 SURVIVE**
- [x] `intelligence` — 2 — **2/2 SURVIVE**
- [x] `notifications` — 2 — **2/2 SURVIVE**
- [x] `document-control` — `XEDGE-1` — **SURVIVES**, and joins the unguarded-path cluster
- [x] `roles-and-permissions` — 21 CRITICALs — **21/21 SURVIVE, 0 refuted**
- [x] `identity-and-session` — 2 — **2/2 SURVIVE**, both flagged in-file as non-independent

**Honesty constraint on this phase.** This pass is being run by the same session
that wrote `identity-and-session` and the meta-audit. That is better than the
original author self-verifying — the code is read fresh with intent to refute —
but it is *not* an independent second party. Whatever the outcome, the record
must say which kind of verification each finding received. Do not label this
pass as adversarial-independent.

## Phase C — quotation accuracy

- [x] **MA-C** Corpus-wide quoted-code verification was not achievable mechanically (two attempts, 39% and 18% false-positive rates). Close the hole for `CRITICAL`s specifically by hand-checking quoted code as part of Phase B, and record the achieved coverage rather than claiming a corpus-wide figure.

## Phase D — ship

- [x] Verification method is recorded PER FINDING (`verified_by`), which is stronger than per-README — see `DEC-41`. Superseded: every area README states its verification method in the same place, same words.
- [x] `findings.json` carries the method per finding so a tool can weight by it.
- [x] `build-index.mjs` fails on: a prefix reused across areas, a `Related` entry naming an unknown ID, an in-repo citation that does not resolve.
- [x] `META-AUDIT.md` rewritten to reflect the post-hardening state.
- [x] `../DECISIONS.md` records the verification-bar decision (`DEC-41`).
- [x] Rebuild index, re-run all integrity checks, commit, push.

---

## Standing constraints

- **No application code, test, or migration may be modified.** Tools inside
  `audit-reports/` may be.
- Commit and push after each phase, not at the end.
- A finding that is refuted is **marked refuted in place with the reason** — never
  silently deleted. The record of what was rejected is the evidence that anything
  was.


---

## Phase E — the remaining 299

Every `HIGH` and `MEDIUM` still graded `author` or `unverified`. Same method as
Phase B: open the cited code, try to refute, record `SURVIVES` / `REFUTED` /
severity correction per finding. **A refuted finding is marked refuted in place
with the reason — never deleted** (`DEC-41`).

Expect a different outcome from Phase B. 65 of 65 `CRITICAL`s survived because
`CRITICAL`s are written carefully. In the lower tiers, real refutations and real
severity changes are the point of doing this.

- [x] `projects-tab` — 104 — **104/104 SURVIVE**
- [x] `roles-and-permissions` — 103 — **103/103 SURVIVE**, 2 corrections (`SURF-3` headline narrowed, `DB-6` count raised — the figure recorded here was itself wrong; settled in Phase F)
- [x] `drafting-flow` — 46 — **46/46 SURVIVE**
- [x] `document-control` — 13 — **13/13 SURVIVE**
- [x] `identity-and-session` — 12 — **12/12 SURVIVE**, all flagged non-independent
- [x] `notifications` — 11 — **11/11 SURVIVE**
- [x] `intelligence` — 10 — **10/10 SURVIVE**

## Outcome (Phases A–E)

**Phases A through E are complete.** These are the hardening pass's own numbers;
**Phase F, below, overturns them** — read it before quoting anything here.

| | |
|---|---|
| Findings re-verified in the hardening pass | **364** |
| Refuted | **0** — *Phase F found 10* |
| Severity changed | **0** — *Phase F changed 79* |
| Corrected without changing severity | **6** |
| Corpus now `author` or `unverified` | **0 of 1,098** |

Every in-repo citation resolves, and `build-index.mjs` fails the build if that
stops being true.

### The six corrections

None changed a severity; each made a finding more accurate than it shipped.

| Finding | Correction |
|---|---|
| `roles-and-permissions/DB-6` | **Understated itself.** Says thirteen `SECURITY DEFINER` functions lack `search_path`. The count recorded here — 23 of 44 — was also wrong; Phase F settles it at **20 of 39**. |
| `roles-and-permissions/SURF-3` | **Headline overstated.** "Zero server-side enforcement" is wrong — `20260826_legal_hold_delete_guard.sql` does guard deletion of held records. The body is accurate and is the substance: placing, releasing and disposing have no server-side authority check. |
| `projects-tab/PERF-1`, `PERF-2` | Headline query counts restated as the per-item formulas they are (`1 + 8N`, and one round trip per project) rather than fixed numbers resting on an unstated assumption. |
| `roles-and-permissions/SURF-2` | Scope narrowed: cross-tenant deletion **is** closed. What survives is the finding as titled — within-org, any role, unaudited. |
| `roles-and-permissions/LIFE-11` | Title is easy to misread; `issue_type` **is** written. What never connects is the as-built *intent* captured at check-in. Note added so the next reader does not repeat the mistake. |
| `document-control/XEDGE-3`, `XEDGE-14` | Citations corrected. Both substantive claims hold. |

### Counts made exact

Several findings gave round numbers. Where a census was cheap, the record now
carries the real figure: 11 SQL sites read `roles[]` against 50 reading the
mirror (`ADD-4`); `activeRole` appears 209 times (`CHAIN-2`); 47 unchecked
`.update()` calls in `lib/` (`OWN-14`); 100 `title=`-only affordances in the
projects area (`A11Y-12`); 56 raw `error.message` references (`REL-3`).

### What Phase E left open

- **`hardening-pass` is not `adversarial`.** It is one reader re-reading with
  intent to refute, not a separate agent. Equal in rigour, weaker in
  independence.
- **`identity-and-session` was written and verified by the same session.**
- **`IDENT-1`'s production half is unanswerable from this repository.**
- **Verification corrections are still prose.**

Phase F closes the first two. The last two are addressed at the end of this file.

---

## Phase F — independence

Phase E's own caveat was the remaining hole: 364 findings had been challenged
only by the session that wrote them. Independence is not a permanent property of
a corpus — it is a pass someone has not run yet.

Method: each of the 364 findings was extracted **without its `Re-verified`
note**, so a verifier saw only the original claim and its citations and could not
be anchored by the earlier conclusion. Batched into 26 groups of ≤14 and issued
to 26 separate agents under a prompt that instructs them to **refute**, to
default to skepticism, and to return a structured verdict. `identity-and-session`
went first, being the weakest area.

- [x] Extract 364 findings stripped of prior verification notes
- [x] 26 independent agents, refute-first prompt, read-only constraint
- [x] Verdicts written back per finding as `- **Independently verified:**`
- [x] Severity corrections applied to the `Severity` field, not just prose
- [x] Refuted findings marked `Status: REFUTED` **in place with the reason**
- [x] `build-index.mjs` emits `verified_by: "adversarial-independent"` and `refuted`
- [x] `DB-6`'s contested count settled by hand

### Result

| | |
|---|---|
| Findings put through the independent pass | **364** |
| Survived as written | **265** |
| Survived with a correction | **89** |
| **Refuted** | **10** |
| Severity lowered | **79** |
| Severity raised | **0** |

Corpus-wide: **1,098 findings, 734 `adversarial`, 364
`adversarial-independent`, 0 `author`, 0 `unverified`, 0 `hardening-pass`.**
`CRITICAL` falls from 116 to 95.

### What the numbers say about Phase E

Phase E reported 364 re-verified, 0 refuted, 0 severity changes. An independent
pass over the same 364 found 10 refutations and 79 downgrades. **Phase E's own
result was the thing most in need of challenging**, and its stated caveat —
"equal in rigour, weaker in independence" — turns out to have understated the
gap. Rigour was not equal. A reader re-reading their own work confirms it.

The ten refutations share one shape: **the cited line was read, the lines around
it were not.** `FRIC-6`'s fallback is on the line that was quoted to prove it
absent. `UX-2`'s remediation is already implemented in the file the finding names
as the counter-example. `DRAFT-4` says no reason is captured for a rejection; the
reason is a mandatory enumerated field feeding an analytics drill-down.
`EGRESS-4` cites a policy that a later migration replaces.

Only one of the ten (`IDENT-5`) was written by the hardening session. The other
nine were written by original-run agents and then *cleared* by the hardening
pass. So the common factor is not who wrote them — it is that the same reading
that missed the surrounding lines the first time missed them again on re-read.
That is the specific failure mode a second party exists to catch, and it is why
`hardening-pass` should never have been described as equal in rigour.

### `DB-6` reconciliation

Four passes gave four counts (13, 23-of-44, 23-of-44, 18-of-37). All four wrong.
Settled at **20 of 39** by counting each distinct `(name, arity)` at its final
definition. Two traps caused the spread, both now recorded in the finding:
superseded `CREATE OR REPLACE` definitions inflate the denominator, and
`publish_revision` exists at two arities — Postgres keys on signature, so both
are live and neither pins `search_path`.

### What is still open

Recorded rather than hidden, because a deleted caveat is worse than a stated one.

- **`IDENT-1`'s production half is unanswerable from this repository** — whether
  duplicate auth identities exist is a Supabase project setting. Three SQL
  queries in the finding settle it in about thirty seconds.
- **Verification corrections are still prose.** `locations` is correct in the
  index now, but making that structural needs a change to how verification runs.
- **The 734 `adversarial` findings have been challenged once, not twice.** Their
  challenge was independent and contemporaneous, which is why they were not
  re-run here. If the 79:0 downgrade ratio in the 364 is a property of the
  authors rather than of the hardening pass, the same skew may sit in the 734.
  Nothing in this engagement measures that.

---

## Outcome (Phases A–D) — superseded, kept for the record

**Superseded by Phase E and then by Phase F.** Kept because the plan's own rule
is that a caveat is removed by doing the work, not by deleting the warning — and
the same applies to a claim that later turned out to be wrong.

**All of Phase A, B, C and D are done.** 65 previously-unchallenged `CRITICAL`s
re-verified; **65 survive, 0 refuted, no severity changed.** Every `CRITICAL` in
the corpus (116) is now `adversarial` or `hardening-pass`.

> **What Phase F did to these numbers.** The independent pass refuted one of
> those 65 (`NEDGE-1`) and lowered the severity of twenty-one more, so "65
> survive, 0 refuted, no severity changed" did not hold. The corpus `CRITICAL`
> count is 95, not 116, and no finding carries `hardening-pass` any more.

**What was deliberately still open at the end of Phase D:**

- **299 `HIGH` and `MEDIUM` findings remain `author` or `unverified`.** *Closed
  by Phase E, then independently challenged in Phase F.*
- **`identity-and-session/SESS-1` and `IDENT-1` were written and verified by the
  same session.** *Closed by Phase F; `IDENT-1` was downgraded to `HIGH` and
  `IDENT-5` refuted.*
- **`IDENT-1`'s production half is still unanswerable from this repository** —
  whether duplicate auth identities exist is a Supabase project setting. The three
  queries in the finding settle it in about thirty seconds. *Still open.*
- **Verification corrections are still prose.** *Still open.*
