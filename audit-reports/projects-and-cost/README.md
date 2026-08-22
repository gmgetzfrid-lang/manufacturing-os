# Projects & cost control — audit area

The project model and its server behaviour, scheduling and the critical path, the quality program, cost and bid tabulation, and the external contractor door.

**No application code, test, or migration was modified at any point.**

**The Projects *tabs UI* was audited separately** — [`../projects-tab/`](../projects-tab/README.md), 133 findings. This area is the model and the server beneath it. Where a defect belongs to both, it is recorded once and cross-referenced.

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

**69 findings** — 3 CRITICAL, 26 HIGH, 40 MEDIUM.

| # | Report | n | Note |
|---|---|---|---|
| 01 | [The project model, membership & lifecycle](./01-project-model.md) | 14 |  |
| 02 | [Scheduling — dependencies, critical path, import](./02-scheduling.md) | 14 |  |
| 03 | [The quality program — checklists, turnover, punch](./03-quality.md) | 13 |  |
| 04 | [Cost, change orders & bid tabulation](./04-cost-and-bids.md) | 14 |  |
| 05 | [External intake & the contractor door](./05-intake-door.md) | 14 |  |

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
