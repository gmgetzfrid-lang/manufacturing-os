# 99 · Execution order

**Binding, not advisory.** No findings of its own — this is the plan the 147
findings are worked against. Judgment calls are in
[`../DECISIONS.md`](../DECISIONS.md).

---

## The cross-area cluster: **the field is told the wrong answer**

Seven `CRITICAL`s in four different reports are one defect wearing different
clothes. In a plant, a QR badge or a printed stamp is what a person trusts when
they cannot check the database — and it is currently capable of saying **CURRENT**
about a drawing that is voided, superseded, or under a hold.

| Finding | Area | What the field sees |
|---|---|---|
| `VFY-1` | public-surfaces | A **VOIDED** drawing scans GREEN "CURRENT" |
| `PHYS-1` | public-surfaces | A document under an **active HOLD** verifies GREEN "CURRENT" |
| `OFF-1` | public-surfaces | The verdict is **cached and replayed offline** — superseded answered "CURRENT" |
| `PHYS-2` | public-surfaces | Printing an **older** ticket deliverable stamps it with the ticket's current revision |
| `REV-1` | document-control | Downloading an old revision **stamps, names, QR-links and audits it as current** |
| `DIST-2` | document-control | The QR endpoint — the only recall channel reaching paper — misreports a voided document |
| `PKG-2` | document-control | The cover-sheet QR verifies the **live database pin, not the paper** |

**Fix them as one piece of work, not seven.** They share a root: the verdict is
computed from a narrow status set and a live lookup, rather than from *what this
specific artifact asserted when it was printed*. The drafting-flow area found the
identical bug on the ticket verify endpoint (`EDGE-2`) — it reads
`deliverable_rev` and never reads status. That is now the eighth instance.

**This goes before everything else in all four areas.**

---

## The second cluster: **four ways in that skip every guard**

| Finding | Area | What it permits |
|---|---|---|
| `DRLS-2` | document-control | `revup_rollback_orphan` is an **unauthenticated, cross-tenant revision-delete RPC** |
| `ORG-1` | admin-and-org | `/api/admin/restore/apply` writes caller-supplied rows into **arbitrary orgs and arbitrary tables** |
| `EGR-1` | document-control | The transmittal portal signs the R2 key of **any document version** from member-controlled input |
| `PKG-1` | document-control | Any active member can **overwrite the bytes of an ISSUED revision in place** |
| `XEDGE-1` | document-control (critic) | `/api/templates/generate` reads **any object in the R2 bucket** by caller-supplied key and returns its parsed cell contents |

These are the five most serious findings in the entire engagement across all nine
areas. None of them requires a role, a session in the right org, or a guessed id
beyond what the surface hands out.

⚠ **`XEDGE-1` came from the completeness critic, which ran after the verification
stage** — it is the only member of this cluster that has not been adversarially
refuted. It cites the repo's own sibling route stating the rule it breaks
(`app/api/templates/route.ts:84-85`), which is strong, but per `DEC-29` reproduce
it before writing the fix. It is listed here rather than lower down because if it
holds it is the same class as the other four.

---

## The third cluster: `FOR ALL` with only `USING`

The shape found on `tickets`, `notifications`, `email_notifications` and
`project_documents` in earlier areas recurs here on `documents` (`DCK-3`) and
`checkout_sessions` (`DCK-2`) — **and `DRLS-1` shows why patching one table at a
time does not work**: the own-row hardening added for acknowledgments and review
sign-offs is **void**, because a permissive policy ORs it away.

**Read `DRLS-1` before writing any RLS fix in any area.** Adding a restrictive
policy alongside a permissive `FOR ALL` does nothing unless the permissive one is
narrowed too.

---

## This area, in order

1. **`DRLS-2`, `EGR-1`, `PKG-1`, `XEDGE-1`** — the unauthenticated / unguarded
   paths above. `XEDGE-1` is a *read* rather than a write, and it is the one item
   here to reproduce first.
2. **The field-verdict cluster** — `REV-1`, `DIST-2`, `PKG-2`, with the
   public-surfaces half.
3. **`DRLS-1` first, then `DCK-2`/`DCK-3`** — the permissive-policy problem before
   the per-table fixes, or the per-table fixes are decorative.
4. **`RG-1`, `RG-2`** — review completion can be forged by a single INSERT, and the
   publisher the gate exists to constrain can sign another reviewer's row. The
   review gate is the product's central safety claim.
5. **`DCK-1`** — the PSM MOC gate for drawing revisions is enforced **only in
   browser JavaScript**. No lib mutator, no RPC, no trigger.
6. **`RET-1`, then `XEDGE-4` and `XEDGE-13`** — the destructive, irreversible
   deletes. `RET-1`: a legal hold does not stop the shed permanently deleting the
   R2 binaries of held revisions. `XEDGE-4`: an export destination with a
   retention policy and **no prefix** enumerates and deletes the customer's entire
   bucket by age, and the run still records `succeeded`. `XEDGE-13`: the storage
   orphan sweep paginates its reference scan with no `ORDER BY`, then permanently
   deletes every object it did not happen to see. Both `XEDGE-*` are critic
   findings — reproduce before acting, but treat "a scheduled job can delete
   customer bytes it never wrote" as the class.
7. **`PKG-3`, `PKG-4`, `PKG-5`, `DIST-1`, `DIST-3`, `REV-2`** in severity order,
   with the remaining `XEDGE-*` folded in — several of them
   (`XEDGE-3` unaudited restore primitive, `XEDGE-9` SSRF-by-redirect,
   `XEDGE-10` encrypted credentials exported verbatim) extend findings already
   listed above rather than standing alone.

⚠ **`DCK-1` deserves a note.** A control enforced only in the client is not a
control; it is a suggestion with a confirmation dialog. This is the same shape as
the client-side-only admin guard found in the drafting-flow area and the one
`ALOG-*` reports on the admin surfaces. Treat "is this enforced server-side?" as a
standing question for every guard in this area.
