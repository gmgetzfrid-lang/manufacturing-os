# Admin & org setup — audit area

Org lifecycle and membership, export/backup/restore, the audit log and admin rails, and billing and quotas.

**No application code, test, or migration was modified at any point.**

**The role model was audited separately** — [`../roles-and-permissions/`](../roles-and-permissions/README.md), 124 findings. This area is the org and membership lifecycle around it.

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

**71 findings** — 5 CRITICAL, 17 HIGH, 29 MEDIUM, 20 LOW.

| # | Report | n | Note |
|---|---|---|---|
| 01 | [Org lifecycle, membership & teams](./01-org-lifecycle.md) | 24 | `ORG-14` opened at the projects Round G J2b integration, 2026-10-01; `ORG-15` opened by the integrator at the A&O P0 merge, 2026-10-02; `ORG-16` (LOW) opened at the A&O P6 review fix pass, 2026-10-02; `ORG-17` and `ORG-18` (LOW) opened by A&O P10, 2026-10-13; `ORG-19`, `ORG-20` (LOW) opened by P11 and `ORG-21` (LOW) by the integrator at its merge, 2026-10-14; `ORG-22` (LOW) opened by P12 (minted as `ORG-19` on its branch, renumbered at its merge), 2026-10-14; `ORG-24` (LOW) opened by A&O P5 and resolved by the integrator's fix pass at its merge, 2026-10-20 |
| 02 | [Export, backup, restore & portability](./02-backup-restore.md) | 15 | `BKP-15` (LOW) opened at the intelligence I-09 merge, 2026-10-01 |
| 03 | [The audit log & admin rails](./03-audit-log.md) | 16 | The critic — spans all four areas from this run. `ALOG-15` opened by the integrator at the A&O P0 merge, 2026-10-02; `ALOG-16` (MEDIUM) opened by the integrator at the A&O P7 merge, 2026-10-13 |
| 04 | [Billing, quotas & platform limits](./04-billing.md) | 15 | `BILL-15` (LOW) opened at the A&O P6 second review fix pass, 2026-10-02 |

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
