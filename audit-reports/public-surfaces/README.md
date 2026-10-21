# Public & field surfaces — audit area

The four unauthenticated verify endpoints, share links and the short link, the physical bridge (QR, labels, stamps, print), and offline/the service worker.

**No application code, test, or migration was modified at any point.**

**Everything here is reachable without a session**, or is a physical artifact that outlives the screen it was printed from. Both classes fail differently from the rest of the app: a leak is public, and a stale print is trusted.

---

## ⚠ Before you touch anything

1. **Read [`../README.md`](../README.md)** — the resolution protocol — and
   [`../DECISIONS.md`](../DECISIONS.md).
2. **Read [`99-fix-sequencing.md`](./99-fix-sequencing.md)** before claiming a file.
3. **This area came from a 47-agent run covering four areas at once.** The
   completeness critic's report spans all four and lives in
   [`../document-control/11-edges-and-invariants.md`](../document-control/11-edges-and-invariants.md)
   — read it alongside this area's reports.

---

## Findings

**69 findings** — 4 CRITICAL, 13 HIGH, 22 MEDIUM, 30 LOW.

| # | Report | n | Note |
|---|---|---|---|
| 01 | [The public verify endpoints](./01-verify-endpoints.md) | 20 | `VFY-15` – `VFY-20` (LOW) opened at PS-VERIFY, 2026-10-01 (provisional ids) |
| 02 | [Share links & the short link](./02-share-links.md) | 14 |  |
| 03 | [The physical bridge — QR, labels, stamps, print](./03-physical-bridge.md) | 20 | `PHYS-14` (MEDIUM) opened at PS-VERIFY, 2026-10-01 (provisional id); `PHYS-15` (LOW) opened at the document-control P22 merge, 2026-10-07; `PHYS-16` (LOW) opened at public-surfaces PS-P7, 2026-10-07; `PHYS-17` (LOW) opened by drafting-flow DF-P10, 2026-10-13; `PHYS-18` (LOW) opened by drafting-flow DF-P12, 2026-10-14 (counted at the integrator's DF-P12 merge fix pass); `PHYS-19` (LOW) opened by public-surfaces PS-P9, 2026-10-20 — single copies WONTFIX and retention ruled at the PS-P9 merge (DEC-90); the cover-print link and the settled-print void assigned to PS-P10 (counted at the integrator's PS-P9 merge fix pass); `PHYS-20` (MEDIUM) opened by public-surfaces PS-P10, 2026-10-20, and resolved at the PS-P10 merge under the integrator's ruling (DEC-90), pending `20261240` (counted at the integrator's PS-P10 merge fix pass) |
| 04 | [Offline, the service worker & the field device](./04-offline-pwa.md) | 15 | `OFF-15` (LOW) opened at identity-and-session IS-P1, 2026-10-07 |

Every report except the critic was **adversarially verified** — a second agent
read the cited code and tried to refute each finding. Across the whole run, 333
raw findings were produced and **311 survived**; 22 were refuted and dropped, and
several severities were lowered by that pass. The lowered value is what is
recorded.

Each report opens with a **substrate table** — what already exists, works, or is
load-bearing. That is deliberately as prominent as the defects.

---

## Method & limits

- **No live database, no browser, no running app.** RLS policies, call graphs and
  deterministic logic are read from code and are exact. Anything about what a user
  *sees* is read from render conditions and is marked `SUSPECTED`.
- The run was seeded with the recurring defect shapes the five earlier audits
  found — the `FOR ALL` policy with only `USING`, the swallowed `supabase-js`
  error, dead FK columns, comments describing unbuilt behaviour, hardcoded
  facility vocabulary — so the lenses hunted those directly rather than
  rediscovering them.
- Per `DEC-29`, reproduce before fixing.
