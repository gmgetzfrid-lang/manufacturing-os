# Meta-audit — an audit of the audits

**7 findings** — 2 HIGH · 4 MEDIUM · 1 LOW.

Ten audit areas, 96 reports, 1,098 findings, 58 gap specs, 5,230 code citations.
This document audits that corpus rather than the application.

It was commissioned because two defects were found in the delivered reports
within a day of shipping them, and **neither was visible from reading the
reports.** Both were caught by mechanical checks. That is the premise of
everything below: the corpus is large enough that reading it is no longer a way
to know whether it is sound.

**No application code, test, or migration was modified.** One tool inside
`audit-reports/` was changed — see `MA-1`.

---

## What is structurally sound

Stated first and with the same prominence as the defects, because most of what
was checked came back clean.

| Check | Result |
|---|---|
| Internal markdown links and anchors | **251 checked, 0 broken** |
| Cited code locations that resolve to a real file | **5,206 of 5,230 (99.5%)** |
| Cited line numbers within the file's actual length | **5,196 of 5,206** |
| README severity counts vs. each area's `findings.json` | **10 of 10 areas consistent** |
| Reports duplicating another report's content | **0** (the one that did is fixed) |
| Duplicate finding IDs within an area | **0** |
| Sampled `CRITICAL`s re-verified against source | **10 of 10 confirmed exactly** |

The accuracy sample was drawn at random (seeded) from all 114 `CRITICAL`s across
all ten areas and each was checked by opening the cited code:

| Finding | Verdict |
|---|---|
| `roles-and-permissions/EGRESS-1` | Confirmed — `document_shares_org_member FOR ALL`, active-member predicate in both `USING` and `WITH CHECK` |
| `drafting-flow/SM-2` | Confirmed — `tickets_org_access FOR ALL USING (...)`, no `WITH CHECK` |
| `roles-and-permissions/OWN-3` | Confirmed — `ROLE_RANK` puts `Manager: 90` above `DocCtrl: 70`; `primaryRole` returns the highest |
| `document-control/DIST-3` | Confirmed — the policy comment itself says *"any active member may update"* |
| `admin-and-org/BKP-2` | Confirmed by absence — `cost_documents` appears in neither `dataExport.ts` nor `storageOrphans.ts` |
| `projects-tab/SAF-4` | Confirmed — `onSubmit` settles with `inputRef.current?.value ?? ""`, no non-empty check |
| `drafting-flow/TIER-2` | Confirmed — `export type RequestType = string;` and no work-classification field exists anywhere |
| `intelligence/WIRE-1` | Confirmed — the Bridge writes `metadata[targetKey]` on `documents`, not to the join table |
| `intelligence/IEDGE-1` | Confirmed — header claims SECURITY INVOKER, call is `supabaseAdmin.rpc("graph_ask", …)` |
| `roles-and-permissions/WF-4` | Anchor correct; the claim is a synthesis over the whole engine rather than those lines, so confirmed in substance but not point-checkable |

**The adversarial verification layer demonstrably worked.** 557 of 1,156 findings
(48%) carry a recorded verifier correction; 28 had their severity explicitly
lowered by that pass. More tellingly: of the twelve findings whose citations this
meta-audit found to be broken, **ten had already been caught and corrected in
prose by their own verifier.** The two that were not both come from the
completeness critic, which by design ran after the verification stage and carries
a warning banner saying exactly that.

---

<a id="ma-1"></a>

## MA-1 · The machine-readable index carries pre-correction citations, and the index is what agents are told to read

- **Severity:** HIGH
- **Status:** FIXED (partially — see below)
- **Verification:** CONFIRMED

**Mechanism.** `build-index.mjs` scrapes each finding's `- **Locations:**` line
into `findings.json`. A verifier correction that rewrites those citations is
appended to the *body* as a block quote and never touches the Locations line. So
for every finding where the verifier said the line numbers were wrong, the index
still publishes the wrong ones.

`REV-9` is the clearest case. Its verifier wrote:

> *"Every cited line number is wrong — `lib/effectiveDate.ts` is 94 lines long,
> so `:91`, `:96-103`, `:106-112`, `:118-126` and `:131-138` do not exist. The
> real anchors are `:16`, `:23-24`, `:33-34`, `:45`, `:49`, `:62-63`."*

`findings.json` still lists `lib/effectiveDate.ts:96-103` and the rest.

This matters more than a stale field normally would, because the corpus's own
`README.md` directs consumers to the index precisely so they can avoid reading
the reports: *"the JSON is a derived index so an agent can query one area's
backlog without reading every report in it."* The one consumer the design
optimises for is the one that never sees the correction.

Five findings are confirmed to have citations corrected in prose:
`document-control/REV-9`, `drafting-flow/HAND-5`, `intelligence/CB-1`,
`intelligence/LIFE-8`, `notifications/TAX-5`.

**Fixed, partially.** `build-index.mjs` now emits
`has_verifier_correction: true` on every finding whose body carries one — 557 of
1,098. An agent reading the index can now tell that the entry has been challenged
and that the body may override it.

**Not fixed, deliberately.** The corrections are prose and rewrite different
fields in different ways; parsing them into structured overrides would be a
guess, and a wrong guess here silently republishes bad citations with the
authority of a machine-generated field. The flag says "read the body", which is
true and checkable. Doing more than that needs the corrections restructured at
the source, which means re-running verification, not re-parsing its output.

**Done when.**

- [ ] verification emits corrected locations as a structured field, not only as prose
- [ ] `locations` in the index reflects the corrected value where one exists
- [ ] until then, no tool treats `locations` as authoritative for a finding where `has_verifier_correction` is true

---

<a id="ma-2"></a>

## MA-2 · Three areas were self-verified rather than adversarially verified, they hold 46% of all CRITICALs, and no record survives of what they rejected

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED

**Mechanism.** The corpus presents ten areas in one structure, with one
resolution protocol, as though they were produced the same way. They were not.

Seven areas ran a **two-stage** process: an audit lens produced findings, then a
*separate agent* read the cited code and tried to refute each one. Refuted
findings were dropped and the refutation is preserved; surviving findings carry
the verifier's corrections inline, including severity changes.

Three areas ran a **one-stage** process. `roles-and-permissions` describes it as
*"CRITICAL and most HIGH claims were re-verified by reading the cited code
directly… Claims that did not survive that check were removed."* `projects-tab`
describes *"first-hand verification of every CRITICAL and HIGH claim by
re-reading the cited code."* `identity-and-session` — written by hand during this
engagement — is the third and is stated as such in its own README.

Both are legitimate. They are not equivalent, and the difference is not
disclosed at the level where someone chooses what to work on.

Two consequences:

1. **No adversarial challenge.** Self-verification checks "does the code say what
   I wrote", not "is there a reading under which this is wrong". The seven
   verified areas lowered 28 severities on exactly that basis.
2. **No record of rejections.** Refuted claims were removed before write-up, so
   nothing shows what was considered and dropped. In the verified areas the
   refutation survives and is auditable.

The severity distribution is consistent with this, though it does not prove it:

| Area | n | CRITICAL | CRITICAL % | verifier-corrected |
|---|---:|---:|---:|---:|
| `projects-tab` | 133 | 29 | **22%** | **0%** |
| `roles-and-permissions` | 124 | 21 | **17%** | **0%** |
| `identity-and-session` | 14 | 2 | **14%** | **0%** |
| `document-control` | 147 | 20 | 14% | 61% |
| `drafting-flow` | 139 | 15 | 11% | 37% |
| `public-surfaces` | 54 | 5 | 9% | 76% |
| `admin-and-org` | 55 | 5 | 9% | 75% |
| `intelligence` | 258 | 13 | 5% | 74% |
| `projects-and-cost` | 69 | 3 | 4% | 91% |
| `notifications` | 105 | 3 | 3% | 74% |

The three areas with no independent verification hold the three highest
`CRITICAL` densities, and **52 of the 114 `CRITICAL`s in the engagement — 46%**.

**This is a confidence claim, not an accuracy claim.** Two of the ten randomly
sampled `CRITICAL`s came from these areas — `EGRESS-1` and `SAF-4` — and both
verified exactly against source. There is no evidence here that any specific
finding is wrong. The finding is that a reader cannot tell which areas were
challenged and which were not, while the ordering of work is driven by a severity
that was set differently in each.

**Failure scenario.** Someone plans a quarter around the `CRITICAL` count,
reasonably assuming one bar was applied. Nearly half of those `CRITICAL`s carry a
severity no second party ever contested, and the areas where severities *were*
contested had 28 of them lowered.

**Done when.**

- [ ] every area's README states its verification method in the same place and the same words, at the top, not in a Method section at the bottom
- [ ] `findings.json` carries the method per area so a tool can weight by it
- [ ] the `CRITICAL`s in the three self-verified areas get an adversarial pass, or their severity is explicitly labelled as un-contested
- [ ] future areas preserve refutations rather than dropping them silently — the record of what was rejected is the evidence that anything was

---

<a id="ma-3"></a>

## MA-3 · `LIFE-1` … `LIFE-13` are defined in two different areas, so thirteen cross-references are ambiguous

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED

**Mechanism.** `intelligence/18-lifecycle.md` and
`roles-and-permissions/*` both use the `LIFE-` prefix, numbering from 1. Thirteen
IDs collide. The corpus deliberately has no combined index — *"ONE INDEX PER
AREA"* — so IDs are only unique within an area, and every cross-area citation is
written as a bare ID in prose.

A reference to `LIFE-8` in a sequencing file or a chain-reaction paragraph
therefore has two valid resolutions. `LIFE-8` is one of the five findings whose
citations a verifier corrected (`MA-1`), which is precisely the case where
resolving to the wrong one costs you.

Prefixes are otherwise disciplined — 1,098 findings across roughly 90 prefixes
with this one collision.

**Done when.**

- [ ] one of the two `LIFE-` series is renamed, and inbound references updated
- [ ] the index build fails on a prefix reused across areas
- [ ] cross-area references are written area-qualified (`intelligence/LIFE-8`)

---

<a id="ma-4"></a>

## MA-4 · Findings that two areas discovered independently do not cross-link, so one can be closed while its twin stays open

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED

**Mechanism.** Two pairs of findings describe the same defect from different
areas:

| | |
|---|---|
| `drafting-flow/AUTHZ-3` ↔ `roles-and-permissions/WF-5` | `requester_role` is client-stamped at INSERT and is the sole input to the engineer gate |
| `document-control/DIST-7` ↔ `public-surfaces/SHR-5` | Share downloads write zero rows to `download_audits` — the insert names a column that does not exist |

Of the four possible directions, **one** is linked: `AUTHZ-3` mentions `WF-5`.
`WF-5` does not mention `AUTHZ-3`, and the `DIST-7`/`SHR-5` pair does not link in
either direction.

The generator that built four of the areas emits an *"Also surfaced independently
as"* line automatically, but only for findings inside its own run. Pairs that
span runs were never linked.

**Failure scenario.** `DIST-7` is fixed in a document-control sprint. `SHR-5`
stays `OPEN`, someone picks it up next quarter, opens the code, finds it already
correct, and now has reason to distrust the corpus — which is the expensive part.
Or the reverse: both are worked simultaneously by different people.

The rate is low — 2 pairs in 1,098 findings — because the areas are genuinely
well separated. It is worth fixing because the cost lands on trust rather than on
time.

**Done when.**

- [ ] the four links are added
- [ ] a corpus-wide near-duplicate check runs at index build and reports unlinked pairs above a similarity threshold

---

<a id="ma-5"></a>

## MA-5 · `SCALE-1` and `SCALE-3` are cited in prose and in the index's `related` array, and no finding with those IDs exists

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED

**Mechanism.** `roles-and-permissions` references `SCALE-1` in its README
(*"re-invented its own authority instead of registering a capability
(`SCALE-1`)"*) and in its gap register, and `SCALE-3` in
`01-role-inventory.md`'s `Related` line — which `build-index.mjs` faithfully
copies into `findings.json`, so a tool following the `related` graph hits a dead
end.

Every other ID-shaped token in the corpus that does not resolve is a false
positive of the pattern — equipment tags (`PSV-42`, `SS-316`), standards
(`AES-256`, `SHA-256`, `UTF-8`, `ECMA-376`), timezones (`UTC-5`), example ticket
numbers (`KE-DDRT-26-0117`) and one regex fragment. Those are fine. `SCALE-1` and
`SCALE-3` are the only genuine dangling references.

The likely history is a report that was renumbered or cut without updating
inbound references — the same class as `MA-3`, from the other direction.

**Done when.**

- [ ] both references resolve, or are removed with a note on what was intended
- [ ] the index build fails on a `Related` entry that names an ID no area defines

---

<a id="ma-6"></a>

## MA-6 · The uncorrected bad citations are concentrated entirely in the one report that was never verified — which is the banner working, and also the argument for not shipping unverified reports beside verified ones

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED

**Mechanism.** Twelve findings cite lines past the end of the file or filenames
that do not exist. Ten were caught by their own verifier and carry a correction.
The two that were not — `XEDGE-3` (`apply/route.ts:214-224`, the file has 154
lines) and `XEDGE-14` (two Stripe routes, both cited past their end) — are both
from `document-control/11-edges-and-invariants.md`, the completeness critic.

The critic ran after the verification stage and its report carries a banner
saying every entry should be treated as `SUSPECTED` regardless of its stated
verification. The banner is correct and it is doing its job — the errors landed
exactly where it warned they would.

But those entries still say `**Verification:** CONFIRMED` on their own line,
because that field is the finder's self-assessment and nothing overrode it. The
banner is at the top of the file; the field is next to the finding; and
`findings.json` publishes the field with no trace of the banner. A tool filtering
for `verification == "CONFIRMED"` gets them.

The four wrong filenames follow the same split — `lib/pipeTrace.ts` and
`lib/drawingTrace.ts` (the real file is `lib/pidTrace.ts`),
`lib/notificationKinds.ts`, `components/projects/QuotesPanel.tsx` — all four were
caught by verifiers and corrected in prose.

**Done when.**

- [ ] a report that skipped verification has that state on every finding, not only in a banner — the `Verification` field reads `UNVERIFIED`, and the index carries it
- [ ] `XEDGE-3` and `XEDGE-14`'s citations are corrected or the findings re-anchored
- [ ] the critic runs *before* verification in future runs, so its output is refuted like everything else

---

<a id="ma-7"></a>

## MA-7 · Fourteen cited paths do not resolve, and the index cannot distinguish "deliberately outside the repo" from "wrong"

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED

**Mechanism.** Of 5,230 citations, 14 name a path that does not exist. They are
three different things and the index renders them identically:

| Kind | Examples | Legitimate? |
|---|---|---|
| Third-party source, deliberately cited, not installed here | `node_modules/@supabase/postgrest-js/src/PostgrestBuilder.ts:82`, `node_modules/pdfjs-dist/build/pdf.mjs` | **Yes** — `EVID-6`'s whole point is what `supabase-js` does on error |
| Build artifacts | `.next/static/chunks/…`, `public/pdf.worker.min.mjs` | **Yes** — they exist at runtime |
| Genuinely wrong filenames | `lib/pipeTrace.ts`, `lib/drawingTrace.ts`, `lib/notificationKinds.ts`, `components/projects/QuotesPanel.tsx` | **No** — all four corrected in prose by verifiers |
| Regex false positives | `../README.md`, `tables/document_shares.json` | Not citations at all |

Nothing marks which is which, so a tool that validates locations reports all
fourteen and a reader learns to ignore the check.

**Done when.**

- [ ] out-of-repo citations use a distinguishable form so a validator can pass them
- [ ] the index build validates in-repo citations and fails on one that does not resolve
- [ ] `build-index.mjs`'s path regex stops matching relative markdown links

---

## What this meta-audit could not check

Stated plainly, because the gaps bound what the clean results above mean.

**Quoted code was not verified corpus-wide.** Two attempts were made to check
that code quoted in Evidence blocks actually appears in the repository. The first
returned a 39% miss rate, the second 18%; sampling both showed the misses were
dominated by elisions (`…`, `...`), escaped `\n` in multi-line quotes, paraphrased
type signatures, and prose sitting in backticks. Neither run reached a precision
worth reporting, so **no corpus-wide quotation-accuracy figure exists** and none
should be inferred. This is the single largest hole: it is exactly the check that
would catch a fabricated quotation, and it was not achievable mechanically
against reports written for humans.

**Accuracy rests on a sample of ten.** Ten of 114 `CRITICAL`s were re-verified by
hand and all ten held. That supports "the `CRITICAL`s spot-check clean." It does
not support a precision figure for 1,098 findings, and it says nothing about
`HIGH` or `MEDIUM`, which were not sampled at all.

**Nothing was reproduced against a running system.** Same limit the underlying
audits carry: no live database, no browser, no AI provider. Every conclusion here
is about the corpus and the source, both of which are static and exact.

**Five areas can no longer be regenerated.** The workflow journals for
`drafting-flow`, `notifications`, `intelligence`, `projects-tab` and
`roles-and-permissions` were destroyed when the session container was reclaimed.
Their committed markdown is now the only record. If a generator-class defect
exists in those five, it cannot be diagnosed the way the two known ones were —
by re-reading the journal. The surviving journal is preserved at
`audit-reports/.evidence/`.

---

## The lesson, stated once

Four generator-class defects have now been found in this corpus. **Three were
invisible from reading the reports:**

1. A report shipped as a duplicate of a different lens's output, with fabricated
   cross-links, while the real report never shipped — caught by comparing report
   bodies.
2. A report shipped with an unearned "unverified" banner and three unapplied
   severity corrections — caught by tracing a fuzzy-match score.
3. The index shipping pre-correction citations — caught by resolving every cited
   path (`MA-1`).
4. The `LIFE-` collision — caught by counting IDs (`MA-3`).

Every one of them produced output that read as correct. The corpus is past the
size where reading it is a way of knowing it is sound; the checks in this
document should run at every index build, not once.
