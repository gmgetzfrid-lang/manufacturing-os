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

- [ ] **MA-3** `LIFE-1`…`LIFE-13` defined in both `intelligence` and `roles-and-permissions`. Rename one series, update inbound references.
- [ ] **MA-4** Add the four missing cross-links: `AUTHZ-3`↔`WF-5`, `DIST-7`↔`SHR-5`.
- [ ] **MA-5** `SCALE-1` / `SCALE-3` are referenced but undefined. Resolve or remove.
- [ ] **MA-7** Distinguish deliberately-out-of-repo citations (`node_modules/`, build artifacts) from wrong ones so a validator can pass them.
- [ ] **MA-6a** Correct `XEDGE-3` and `XEDGE-14` citations (both cite past end-of-file).
- [ ] **MA-1** Apply verifier-corrected locations into `findings.json` for the five findings whose citations were corrected in prose.

## Phase B — the load-bearing work: verify the 52 unchallenged CRITICALs

Three areas never had an independent party contest a finding. They hold 46% of
every `CRITICAL` in the engagement. Each item below means: open the cited code,
try to **refute** the claim, and record `SURVIVES` / `REFUTED` / a severity
correction in the report body.

- [ ] `projects-tab` — 29 CRITICALs
- [ ] `roles-and-permissions` — 21 CRITICALs
- [ ] `identity-and-session` — 2 CRITICALs

**Honesty constraint on this phase.** This pass is being run by the same session
that wrote `identity-and-session` and the meta-audit. That is better than the
original author self-verifying — the code is read fresh with intent to refute —
but it is *not* an independent second party. Whatever the outcome, the record
must say which kind of verification each finding received. Do not label this
pass as adversarial-independent.

## Phase C — quotation accuracy

- [ ] **MA-C** Corpus-wide quoted-code verification was not achievable mechanically (two attempts, 39% and 18% false-positive rates). Close the hole for `CRITICAL`s specifically by hand-checking quoted code as part of Phase B, and record the achieved coverage rather than claiming a corpus-wide figure.

## Phase D — ship

- [ ] Every area README states its verification method in the same place, same words.
- [ ] `findings.json` carries the method per finding so a tool can weight by it.
- [ ] `build-index.mjs` fails on: a prefix reused across areas, a `Related` entry naming an unknown ID, an in-repo citation that does not resolve.
- [ ] `META-AUDIT.md` rewritten to reflect the post-hardening state.
- [ ] `../DECISIONS.md` records the verification-bar decision.
- [ ] Rebuild index, re-run all integrity checks, commit, push.

---

## Standing constraints

- **No application code, test, or migration may be modified.** Tools inside
  `audit-reports/` may be.
- Commit and push after each phase, not at the end.
- A finding that is refuted is **marked refuted in place with the reason** — never
  silently deleted. The record of what was rejected is the evidence that anything
  was.
