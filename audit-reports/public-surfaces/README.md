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

**62 findings** — 4 CRITICAL, 13 HIGH, 21 MEDIUM, 24 LOW.

| # | Report | n | Note |
|---|---|---|---|
| 01 | [The public verify endpoints](./01-verify-endpoints.md) | 20 | `VFY-15` – `VFY-20` (LOW) opened at PS-VERIFY, 2026-10-01 (provisional ids) |
| 02 | [Share links & the short link](./02-share-links.md) | 14 |  |
| 03 | [The physical bridge — QR, labels, stamps, print](./03-physical-bridge.md) | 14 | `PHYS-14` (MEDIUM) opened at PS-VERIFY, 2026-10-01 (provisional id) |
| 04 | [Offline, the service worker & the field device](./04-offline-pwa.md) | 14 |  |

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
