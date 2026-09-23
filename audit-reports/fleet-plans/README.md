# Fleet plans

Package maps for closing each area with parallel agents (one worktree per
package, adversarial review, fix pass, merged and pushed per package). Written
by read-only planning agents from the area reports and the live code; kept in
the branch so a container recycle cannot lose them. `build-index.mjs` ignores
this directory (it has no `findings.json`). The five areas still missing here
(drafting-flow, intelligence, projects-tab, notifications, projects-and-cost)
are re-planned by agents that write their file into this directory.
