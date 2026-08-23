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
- [x] `roles-and-permissions` — 103 — **103/103 SURVIVE**, 2 corrections (`SURF-3` headline narrowed, `DB-6` count raised 13→23)
- [x] `drafting-flow` — 46 — **46/46 SURVIVE**
- [x] `document-control` — 13 — **13/13 SURVIVE**
- [x] `identity-and-session` — 12 — **12/12 SURVIVE**, all flagged non-independent
- [x] `notifications` — 11 — **11/11 SURVIVE**
- [x] `intelligence` — 10 — **10/10 SURVIVE**

## Outcome

**Phases A through E are complete.**

| | |
|---|---|
| Findings re-verified in the hardening pass | **364** |
| Refuted | **0** |
| Severity changed | **0** |
| Corrected without changing severity | **6** |
| Corpus now `author` or `unverified` | **0 of 1,098** |

**Every finding in the corpus has been challenged** — 734 `adversarial`, 364
`hardening-pass`. Every in-repo citation resolves, and `build-index.mjs` fails
the build if that stops being true.

### The six corrections

None changed a severity; each made a finding more accurate than it shipped.

| Finding | Correction |
|---|---|
| `roles-and-permissions/DB-6` | **Understated itself.** Says thirteen `SECURITY DEFINER` functions lack `search_path`; the real count is **23 of 44**, including `my_org_ids`, `is_org_admin` and `can_manage_node`. |
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

### What is deliberately still open

Recorded rather than hidden, because a deleted caveat is worse than a stated one.

- **`hardening-pass` is not `adversarial`.** It is one reader re-reading with
  intent to refute, not a separate agent. Equal in rigour, weaker in
  independence.
- **`identity-and-session` was written and verified by the same session.** All 14
  findings say so on themselves. Treat as `author`-grade until someone else reads
  them.
- **`IDENT-1`'s production half is unanswerable from this repository** — whether
  duplicate auth identities exist is a Supabase project setting. Three SQL
  queries in the finding settle it.
- **Verification corrections are still prose.** `locations` is correct in the
  index now, but making that structural needs a change to how verification runs.

---

## Outcome (Phases A–D)


**All of Phase A, B, C and D are done.** 65 previously-unchallenged `CRITICAL`s
re-verified; **65 survive, 0 refuted, no severity changed.** Every `CRITICAL` in
the corpus (116) is now `adversarial` or `hardening-pass`.

**What is deliberately still open**, recorded rather than hidden:

- **299 `HIGH` and `MEDIUM` findings remain `author` or `unverified`.** No
  independent challenge. `verified_by` carries this on every entry, so it shapes
  a queue without anyone having to remember it. This is the obvious next pass.
- **`identity-and-session/SESS-1` and `IDENT-1` were written and verified by the
  same session.** Their `Re-verified` lines say so. Treat as `author`-grade until
  someone else reads them.
- **`IDENT-1`'s production half is still unanswerable from this repository** —
  whether duplicate auth identities exist is a Supabase project setting. The three
  queries in the finding settle it in about thirty seconds.
- **Verification corrections are still prose.** `locations` is now correct in the
  index, but making that structural needs a change to how verification runs, not
  to how its output is parsed.
