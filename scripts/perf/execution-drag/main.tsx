// PERF-5 harness (projects-tab 09-performance-scale.md): the execution board
// alone, on stubbed data, for a timed drag in a real browser. See README.md.
import React from "react";
import { createRoot } from "react-dom/client";
import ExecutionView from "@/components/projects/ExecutionView";
import type { Milestone } from "@/types/schema";

// 400 rows: 20 phases of 19 leaf tasks each (380 leaves + 20 summaries),
// spread over a year, a third of the leaves chained finish-to-start.
const day = 86_400_000;
const t0 = Date.UTC(2026, 9, 1);
const iso = (ms: number) => new Date(ms).toISOString();
const rows: Milestone[] = [];
for (let p = 0; p < 20; p++) {
  const pStart = t0 + p * 18 * day;
  rows.push({
    id: `P${p}`, orgId: "o", projectId: "p", name: `Phase ${p + 1}`, weight: 1, isSummary: true,
    plannedStartAt: iso(pStart), plannedAt: iso(pStart + 40 * day), status: "planned", source: "manual", createdBy: "u", dependsOn: [],
  } as Milestone);
  for (let t = 0; t < 19; t++) {
    const s = pStart + t * 2 * day;
    rows.push({
      id: `T${p}-${t}`, orgId: "o", projectId: "p", parentId: `P${p}`, name: `Task ${p + 1}.${t + 1}`, weight: 1,
      plannedStartAt: iso(s), plannedAt: iso(s + 3 * day), status: t % 4 === 0 ? "in_progress" : "planned", percentComplete: t % 4 === 0 ? 40 : 0,
      source: "manual", createdBy: "u", dependsOn: t > 0 && t % 3 === 0 ? [`T${p}-${t - 1}`] : [],
    } as Milestone);
  }
}
(window as unknown as { __rows: number }).__rows = rows.length;
createRoot(document.getElementById("root")!).render(
  <ExecutionView milestones={rows} canEdit orgId="o" projectId="p" userId="u"
    onRefresh={() => undefined} onMoveMany={async () => ({ ok: true })} onSetStatus={async () => true} onSetProgress={async () => true} />,
);
