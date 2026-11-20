"use client";

// How far each running project's work is, read from its schedule the way the
// project's own page reads it (effort-weighted %, steps done, steps late).
// Home and its widgets ask for a handful of projects; each is read once a
// session and shared between every table that shows it.

import { useEffect, useState } from "react";
import { listMilestones } from "@/lib/milestones";
import { computeExecutionReport } from "@/lib/executionReport";

export interface WorkProgress { pct: number; done: number; steps: number; overdue: number }

/** null: the project has no schedule. Missing: not read (yet). */
const cache = new Map<string, WorkProgress | null>();
const inflight = new Map<string, Promise<WorkProgress | null | undefined>>();

function readOne(orgId: string, id: string, tz: string): Promise<WorkProgress | null | undefined> {
  const key = `${orgId}:${id}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const running = inflight.get(key);
  if (running) return running;
  const p = listMilestones({ orgId, projectId: id, includeGhost: true })
    .then((ms) => computeExecutionReport(ms.filter((m) => !m.cancelledAt), { tz, now: new Date() }))
    .then((r) => {
      const v: WorkProgress | null = r.totalLeaves ? { pct: r.pctComplete, done: r.done, steps: r.totalLeaves, overdue: r.overdue } : null;
      cache.set(key, v);
      return v;
    })
    .catch(() => undefined)
    .finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

/** Work progress for up to `cap` projects, read three at a time. */
export function useProjectProgress(
  orgId: string | null | undefined,
  projects: Array<{ id: string; timezone?: string | null }>,
  cap = 8,
): Map<string, WorkProgress | null> {
  const [map, setMap] = useState<Map<string, WorkProgress | null>>(new Map());
  const want = projects.slice(0, cap).map((p) => `${p.id}|${p.timezone || "America/Los_Angeles"}`).join(",");
  useEffect(() => {
    if (!orgId || !want) return;
    let alive = true;
    const queue = want.split(",").map((s) => s.split("|") as [string, string]);
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [id, tz] = next;
        const v = await readOne(orgId, id, tz);
        if (!alive) return;
        if (v !== undefined) setMap((m) => (m.get(id) === v ? m : new Map(m).set(id, v)));
      }
    };
    void Promise.all([worker(), worker(), worker()]);
    return () => { alive = false; };
  }, [orgId, want]);
  return map;
}
