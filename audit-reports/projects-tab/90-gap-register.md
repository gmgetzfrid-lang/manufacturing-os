# 90 · Gap register — build specs

**10 capabilities the Projects/Project-Controls surface needs and does not have.**

Numbered from **401** so they never collide with `roles-and-permissions`
(`GAP-1`…`GAP-15`), `drafting-flow` (`GAP-101`…`GAP-114`), `notifications`
(`GAP-201`…`GAP-207`) or `intelligence` (`GAP-301`…`GAP-312`).

---

## ⚠ How this register differs from the others

**It was derived from the findings, not from a design run.** The other four
registers came out of dedicated design agents that read the owner's intent and
proposed capabilities. This area was audited first, before that pattern existed,
and its 133 findings are overwhelmingly *defects to repair* rather than
*capabilities to build*.

So the specs below are the **capabilities those defects imply** — the cases where
fixing the finding means building something that does not exist, rather than
correcting something that does. Each names its source findings.

**Consequences for how you use it:**

- Every spec **inherits the verification status of its source findings**. Per this
  area's own README, every `CRITICAL` and `HIGH` was verified first-hand at the
  time of the audit against commit `6a14d7d`. That was several sessions ago —
  **re-read the cited code before building** (`DEC-29`).
- Where a finding is a straight repair with no missing capability, it stays a
  finding and is **not** duplicated here. The findings remain the primary record.
- `11-upload-door-controls.md` was already a design note. `GAP-401` supersedes it
  as a spec; the note stays as the reasoning behind it.

---

## Verdicts at a glance

| Gap | Capability | Verdict | Effort | Blocked on |
|---|---|---|---|---|
| [GAP-401](#gap-401) | The unauthenticated upload door as a real boundary | **BUILD** | M | — |
| [GAP-402](#gap-402) | A write that cannot silently fail | **BUILD_NARROW** | S | — |
| [GAP-403](#gap-403) | Stable row identity for schedule re-import | **BUILD** | M | — |
| [GAP-404](#gap-404) | Evidence that actually evidences | **BUILD** | M | `GAP-402` |
| [GAP-405](#gap-405) | Gates with teeth — no blank-reason bypass | **BUILD_NARROW** | S | `GAP-402` |
| [GAP-406](#gap-406) | The award as a transaction, with a repair path | **BUILD** | M | `GAP-402` |
| [GAP-407](#gap-407) | One number, one source, on the bid tab | **BUILD_NARROW** | S | — |
| [GAP-408](#gap-408) | The timeline sees the controls program | **BUILD** | M | — |
| [GAP-409](#gap-409) | The registry at scale — pagination and caching | **BUILD_NARROW** | S | — |
| [GAP-410](#gap-410) | An accessibility baseline for safety surfaces | **BUILD** | M | — |

---

<a id="gap-401"></a>
## GAP-401 · The unauthenticated upload door as a real boundary

**Verdict: BUILD** · Effort: **M** · Sources: `SEC-1`, `SEC-4`, `SEC-5`–`SEC-8`, `11-upload-door-controls.md`

### Why it is a capability and not a fix

`SEC-1` — an unauthenticated upload link can put **executing JavaScript on the
app's own origin**. `SEC-4` — the external door runs as **service role**, so every
database-level document-control guard is skipped.

Those are not two bugs to patch. Together they say the external door has no
boundary: it is a hole with a token in front of it. What has to exist is a
**contract for untrusted content** that every external entry point goes through.

### Scope

**In:** content-type and magic-byte validation; a serving origin that is not the
app's; size and rate limits per token; a token model with entropy, expiry and
revocation; and — the structural one — **the door stops using the service role**
and instead assumes a constrained identity that the DB guards still apply to.

**Out:** redesigning the intake workflow. This is the boundary, not the flow.

### Do not

- **Do not fix `SEC-1` with an extension allowlist.** Filenames are attacker-controlled.
  Validate content and serve from an origin where execution cannot hurt you.
- **Do not keep the service role and add application-layer checks.** That is the
  defect: the guards exist in the database and the door routes around them. An
  application check is a second implementation that will drift.
- **Do not treat the token as authentication.** It is a capability URL — it can be
  forwarded, logged and shoulder-read.

### Acceptance

1. An uploaded HTML/SVG/JS file cannot execute on the app's origin. A test uploads
   one and asserts the response headers and origin.
2. Every DB-level document-control guard applies to content entering by this door.
3. Tokens expire, can be revoked, and revocation is effective immediately.
4. Rate limits are enforced server-side and fail **open** on a limiter error —
   matching `app/api/auth/signup/route.ts:19-33`, the house pattern.

**Related:** the new `document-control` area's intake lens covers the promote
pipeline this door feeds. Read both.

---

<a id="gap-402"></a>
## GAP-402 · A write that cannot silently fail

**Verdict: BUILD_NARROW** · Effort: **S** · Sources: `SAF-3`, `UX-1`, and the same class in three other areas

### The pattern, found four times across five audits

- `SAF-3` — **a write denied by row-level security reports success and writes an
  audit row claiming it happened.**
- `UX-1` — **five of the wizard's six writes fail silently, and four fields are
  lost permanently.**
- `PERS-7` / `EVID-6` (drafting-flow) — `logAuditAction` cannot detect a failed
  audit write.
- Six client-side ticket writes never check the returned error.

One root: **`supabase-js` resolves with `{ error }` rather than throwing**, so an
unchecked call reads as success.

### Scope

**In:** one checked-write helper that every mutation path uses, which surfaces the
error, and a lint rule or test that fails when a raw `.insert`/`.update`/`.delete`
result is discarded.

**Out:** rewriting every call site by hand in one change (`DEC-31`). Ship the
helper and the guard, convert the safety-critical paths, and open a finding for
the remainder.

### Do not

- **Do not write the audit row before the write it describes succeeds.** `SAF-3`
  is worse than a lost write: it is a **false record**.
- **Do not catch and toast.** A lost safety write needs to block, not to inform.

### Acceptance

1. An RLS-denied write surfaces as a failure everywhere, and writes no audit row.
2. A test forces a denial on a PSSR/closeout path and asserts nothing is recorded.
3. A raw discarded write result fails the build or the lint step.

---

<a id="gap-403"></a>
## GAP-403 · Stable row identity for schedule re-import

**Verdict: BUILD** · Effort: **M** · Sources: `SCH-2`, `SCH-3`, `SCH-1`, `SCH-6`

### The need

`SCH-3` — **CSV re-import matches rows by position**, so inserting one row
scrambles every row after it. `SCH-2` — re-importing the weekly schedule **wipes
progress the crew logged in the app**.

A weekly re-import is the normal case, not an edge case. Positional matching means
the normal case corrupts data.

### Scope

**In:** a stable external identity per task (the source system's id where one
exists, otherwise a deterministic key), a merge that distinguishes
*added / removed / changed / unchanged*, and preservation of app-side state —
progress, notes, attachments — across import.

Plus `SCH-1`: date parsing must not silently rewrite day/month as month/day. The
comment claims a guard the code lacks; make the code true or the comment go.

**Out:** a full two-way sync.

### Do not

- **Do not auto-apply the merge.** Show the diff. A re-import that silently
  deletes tasks is the same class of harm as `SCH-2`.
- **Do not infer identity from the task name.** Names get edited.
- **Do not treat "row missing from the new file" as "task deleted."** It may be a
  filtered export.

### Acceptance

1. Inserting a row at the top of the source file leaves every other row's identity
   and progress intact. A test pins exactly this.
2. Re-import presents a reviewable diff before writing.
3. An ambiguous date is rejected with a named column, never guessed.

---

<a id="gap-404"></a>
## GAP-404 · Evidence that actually evidences

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-402` · Sources: `SAF-1`, `SAF-2`

### The need

`SAF-1` — **a contractor's self-typed filename can turn a PSSR item green.**
`SAF-2` — **the AI can mark thirty of forty PSSR items not-applicable behind one
count-only confirmation.**

This is a pre-startup safety review in a PSM plant. A green item has to mean
something a person is willing to sign.

### Scope

**In:** an evidence contract per checklist item — what kind of artifact satisfies
it, and what the system verified about that artifact (it exists, it is attached to
this project, it is of the declared type). A filename is a label, not evidence.

And for bulk AI action: **per-item review, not a count.** A confirmation that says
"30 items" without naming them is not consent.

**Out:** removing AI assistance. Proposing is fine. Asserting is not.

### Do not

- **Do not accept a name as proof of a thing.** `SAF-1` in one sentence.
- **Do not let a bulk confirmation cover items the user has not seen.** If thirty
  items are being changed, thirty items get shown.
- **Do not render an AI-marked item identically to a human-verified one** — the
  same discipline `GAP-303` sets for the intelligence layer.

### Acceptance

1. An item cannot go green on a string alone.
2. A bulk AI action requires per-item review; a test asserts a count-only path
   cannot write.
3. Every satisfied item records who or what satisfied it, and how.

---

<a id="gap-405"></a>
## GAP-405 · Gates with teeth

**Verdict: BUILD_NARROW** · Effort: **S** · Depends on: `GAP-402` · Sources: `SAF-4`

**Every route to a green closeout gate accepts a blank reason on one keypress.**

The gate exists; it just does not hold. This is the same shape as the
minor-correction bypass in the drafting flow: a control that renders and does not
constrain.

### Do not

- **Do not add a second confirmation dialog.** Two dialogs someone clicks through
  is one dialog. Require the substance — a typed reason, minimum length, the same
  bar `lib/checkinOutcomes.ts` already sets: *"no canned text, no
  get-out-of-jail-free cards."*
- **Do not make it a client-side check.**

### Acceptance

1. A blank or whitespace reason is rejected server-side on every closeout route.
2. The reason is recorded, attributed and visible on the closeout record.
3. A test enumerates every route to a green gate and asserts each rejects blank.

---

<a id="gap-406"></a>
## GAP-406 · The award as a transaction, with a repair path

**Verdict: BUILD** · Effort: **M** · Depends on: `GAP-402` · Sources: `MON-1`

**A failed award leaves the document permanently awarded with no commitment, and
nothing can repair it.**

Two capabilities: the award becomes atomic, **and** there is a way back from the
records already in that state. The second matters more — the first prevents new
damage, the second addresses damage already done.

### Do not

- **Do not build only the transaction.** Existing broken rows stay broken and
  invisible.
- **Do not repair by deleting.** An award that half-happened is a financial event;
  reversing it is an event too, with an actor and a reason.

### Acceptance

1. A failure at any step leaves no partial award.
2. A query identifies existing awarded-without-commitment documents.
3. Repair is an auditable action, not a silent correction.

---

<a id="gap-407"></a>
## GAP-407 · One number, one source, on the bid tab

**Verdict: BUILD_NARROW** · Effort: **S** · Sources: `BID-1`, `BID-2`, `BID-3`, `BID-4`

**The table scores the AI's total; the Award button posts the human's corrected
total.** Two numbers, one screen, and the decision is made on the one that is not
being shown.

`BID-2` compounds it: **there is no way to open the quote you are being asked to
award.**

### Scope

**In:** a single authoritative total per bid, with the AI-parsed value and any
human correction both visible and distinguishable; and a link from every bid row
to the source document.

**Out:** re-scoring. `BID-3` and `BID-4` are scoring-logic defects — fix them as
findings once the number is unambiguous.

### Do not

- **Do not hide the AI's original value once corrected.** The correction is the
  record (`GAP-303`, same principle).
- **Do not let a bid be awardable without its source being openable.**

### Acceptance

1. One total drives both the score and the award; a test asserts they cannot differ.
2. AI-parsed and human-corrected are visually distinct.
3. Every bid row opens its quote.

---

<a id="gap-408"></a>
## GAP-408 · The timeline sees the controls program

**Verdict: BUILD** · Effort: **M** · Sources: `SAF-6`

**The project timeline cannot see the controls program at all.** Change orders,
checklists, turnover, punch, cost events — none of it appears on the one surface
meant to show what happened to a project.

For a PSM project record, a timeline missing the compliance program is the wrong
timeline.

### Do not

- **Do not put everything on it.** A timeline showing every cost row is unusable.
  Decide per event type whether it is a *milestone* or *noise*, and record the
  decision.
- **Do not build a second event store.** These events already exist as rows.

### Acceptance

1. Change orders, checklist completions, turnover and punch closure appear.
2. Each links to its record.
3. The event vocabulary is one list, extended deliberately.

---

<a id="gap-409"></a>
## GAP-409 · The registry at scale

**Verdict: BUILD_NARROW** · Effort: **S** · Sources: `PERF-1`, `PERF-2`

**The companies registry fires over eleven hundred queries per page view**, with
no cache and no pagination. **Exporting all projects is 360 sequential round
trips** behind a button that gives no feedback.

Both are the N+1 pattern. The capability is pagination plus batched fetch plus
progress on anything long-running.

### Do not

- **Do not fix this with a client-side cache.** It moves the cost, and stale
  company data drives award decisions.
- **Do not leave the export unbatched and just add a spinner.**

### Acceptance

1. Registry page load issues a bounded number of queries independent of row count.
2. Export batches, reports progress, and is cancellable.
3. A test asserts the query count does not grow with the number of companies.

---

<a id="gap-410"></a>
## GAP-410 · An accessibility baseline for safety surfaces

**Verdict: BUILD** · Effort: **M** · Sources: `A11Y-1`, `A11Y-2`, `A11Y-3`

**File pickers are unreachable by keyboard, including on the public vendor
portal.** **Checklist item status is conveyed entirely by an eight-pixel coloured
dot — on the PSSR surface.** **Milestone row tints make the row unreadable in dark
mode.**

The middle one is the serious one. Colour-only status on a pre-startup safety
review fails for roughly one in twelve men, and PSSR items are read under time
pressure by whoever is on shift.

### Scope

**In:** keyboard reachability for every control including the public portal; status
conveyed by shape or text as well as colour on every compliance surface; and a
contrast pass on both themes.

**Out:** a full WCAG programme. This is the safety-surface baseline.

### Do not

- **Do not add a tooltip and call the dot fixed.** A tooltip is not available to a
  keyboard user mid-walkdown, and it is not available at a glance.
- **Do not fix dark mode by disabling the tint.** The tint carries meaning; give it
  a legible form.

### Acceptance

1. Every control on the public portal is keyboard-reachable and focus-visible.
2. No compliance surface conveys status by colour alone. A test asserts the
   accessible name of a status cell includes its state.
3. Both themes pass contrast on the milestone and checklist surfaces.

---

## What deliberately did NOT become a gap

Recorded so nobody looks for a spec that should not exist.

| Finding | Why it stays a finding |
|---|---|
| `SEC-2` private projects not private | A repair to existing RLS, not a new capability. |
| `SEC-3` review guarantee self-destructs | A defect in an existing guard. |
| `SAF-5` auto-supersede is a raw column write | Route it through the existing post-publish pipeline — the pipeline already exists. |
| `MON-2` S-curve planned line starts wrong | Arithmetic. |
| `SCH-4`, `SCH-5`, `SCH-7` | Cycle handling, three contradictory overdue rules, a missing optimistic lock — all repairs to code that exists. |
| `UX-*` truth-in-interface findings | Copy and render fixes. Numerous, cheap, and not capabilities. |
