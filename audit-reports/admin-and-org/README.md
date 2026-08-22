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

**55 findings** — 5 CRITICAL, 17 HIGH, 33 MEDIUM.

| # | Report | n | Note |
|---|---|---|---|
| 01 | [Org lifecycle, membership & teams](./01-org-lifecycle.md) | 13 |  |
| 02 | [Export, backup, restore & portability](./02-backup-restore.md) | 14 |  |
| 03 | [The audit log & admin rails](./03-audit-log.md) | 14 | The critic — spans all four areas from this run. |
| 04 | [Billing, quotas & platform limits](./04-billing.md) | 14 |  |

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
