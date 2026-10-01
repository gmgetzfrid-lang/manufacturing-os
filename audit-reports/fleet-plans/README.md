# Fleet plans

Package maps for closing each area with parallel agents (one worktree per
package, adversarial review, fix pass, merged and pushed per package). Written
by read-only planning agents from the area reports and the live code; kept in
the branch so a container recycle cannot lose them. `build-index.mjs` ignores
this directory (it has no `findings.json`). The five areas still missing here
(drafting-flow, intelligence, projects-tab, notifications, projects-and-cost)
are re-planned by agents that write their file into this directory.

**Ownership rule (integrator, 2026-10-01).** Every OPEN finding is named in a
package that has not yet merged, or in its plan's `userHeld` map, which lists
the ones waiting only on the user (a paste, a deploy, a ratification) with
what they wait for. When a package merges and leaves a Partial, its
remainder is re-owned in the same merge. The 2026-10-01 orphan sweep
re-owned 95 such remainders. It added new packages for work no planned
package fitted: intelligence I-15 to I-17, document-control P14 and P15,
and projects-joint J10b, J12 and J13. Each re-owned record carries an
`Assigned:` line saying so.
