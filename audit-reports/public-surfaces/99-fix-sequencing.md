# 99 · Execution order

**Binding, not advisory.** No findings of its own — this is the plan the 54
findings are worked against.

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

These are the four most serious findings in the entire engagement across all nine
areas. None of them requires a role, a session in the right org, or a guessed id
beyond what the surface hands out.

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

**`VFY-1`, `PHYS-1`, `OFF-1`, `PHYS-2` are the field-verdict cluster** and they are
this area's entire first phase. Do them together with the document-control half
(`REV-1`, `DIST-2`, `PKG-2`) — one design, one fix, one test suite.

The design question they share: **what should a scan assert?** Today the verdict
is computed from a narrow status set plus a live lookup. It should be computed
from what the artifact claimed when it was produced, compared against what is true
now — which is a different and strictly more informative answer, and the only one
that can say "this paper was current when printed and is not any more."

Then:

1. **`SHR-1`** — share rows carry **no org-consistency constraint** and both public
   routes resolve the document **org-blind**. A share link is a cross-tenant read
   primitive.
2. The remaining `SHR-*`, `PHYS-*` and `OFF-*` in severity order.

⚠ **`OFF-1` has a constraint the others do not.** Fixing cached verdicts means
touching the service worker, and `public/sw.js` carries two hard rules in its own
header — never cache RSC payloads, never synthesize a server error. Read them
before editing, and do not solve staleness by disabling the cache: offline is a
feature for a plant with poor coverage, and the fix is that a cached verdict must
say it is cached and how old it is.
