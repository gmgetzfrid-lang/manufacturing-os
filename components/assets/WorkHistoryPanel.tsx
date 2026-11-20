"use client";

// WorkHistoryPanel - every job done on this equipment, across projects:
// each work order with its project, dates, steps done, and the findings
// kept on the equipment for the next job (lib/equipmentHistory).

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { History, Loader2, Lightbulb } from "lucide-react";
import { loadEquipmentHistory, type EquipmentHistory, type HistoryJob } from "@/lib/equipmentHistory";
import { fmtInTz } from "@/lib/scheduleTz";

const STATUS: Record<string, { word: string; cls: string }> = {
  completed: { word: "Done", cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300" },
  in_progress: { word: "Under way", cls: "bg-[var(--color-surface-2)] text-[var(--color-text)]" },
  on_hold: { word: "On hold", cls: "bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" },
  blocked: { word: "Blocked", cls: "bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300" },
};

export default function WorkHistoryPanel({ orgId, assetId, code, tag, unitCode }: { orgId: string; assetId: string; code?: string | null; tag?: string | null; unitCode?: string | null }) {
  const key = `${orgId}:${assetId}:${code ?? ""}:${tag ?? ""}`;
  const [state, setState] = useState<{ key: string; data: EquipmentHistory | null; error: string | null }>({ key: "", data: null, error: null });
  useEffect(() => {
    let live = true;
    loadEquipmentHistory(orgId, { id: assetId, code, tag, unitCode })
      .then((data) => { if (live) setState({ key, data, error: null }); })
      .catch((e) => { if (live) setState({ key, data: null, error: (e as Error).message }); });
    return () => { live = false; };
  }, [orgId, assetId, code, tag, unitCode, key]);
  const ready = state.key === key;
  const data = ready ? state.data : null;
  const jobs = data?.jobs ?? [];
  const byProject = new Map<string, HistoryJob[]>();
  for (const j of jobs) byProject.set(j.projectId, [...(byProject.get(j.projectId) ?? []), j]);

  const day = (t: number | null, tz: string | null) => (t == null ? null : fmtInTz(t, tz || Intl.DateTimeFormat().resolvedOptions().timeZone, { month: "short", day: "numeric", year: "numeric" }));
  const span = (a: number | null, b: number | null, tz: string | null) => {
    const x = day(a, tz), y = day(b, tz);
    return x && y ? (x === y ? x : `${x} to ${y}`) : x ?? y ?? null;
  };

  return (
    <section className="bg-[var(--color-surface)] rounded-2xl shadow-[var(--shadow-card)] overflow-hidden">
      <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-[var(--color-border)] flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-[var(--color-text-muted)] inline-flex items-center gap-2">
          <History className="w-4 h-4" /> Work history
        </h2>
        {ready && data && <span className="text-[12px] text-[var(--color-text-muted)]">{jobs.length} work order{jobs.length === 1 ? "" : "s"} · {byProject.size} project{byProject.size === 1 ? "" : "s"}</span>}
      </div>
      {!ready ? (
        <div className="px-4 py-4 flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Reading the jobs…</div>
      ) : state.error ? (
        <div className="px-4 py-4 text-[12.5px] text-rose-700 dark:text-rose-300">Couldn&apos;t read the jobs: {state.error}</div>
      ) : jobs.length === 0 ? (
        <div className="px-4 py-4 text-[12.5px] text-[var(--color-text-muted)]">
          No work orders on it yet. A project&apos;s work orders show here once they&apos;re linked to it in the project&apos;s Setup › Units &amp; equipment{code ? `, or carry its number ${code} in the schedule` : ""}.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {[...byProject.entries()].map(([pid, js]) => (
            <li key={pid} className="px-4 py-3 space-y-1.5">
              <Link href={`/projects/${pid}?tab=work`} className="text-[14px] font-bold text-[var(--color-text)] hover:underline">{js[0].projectName}</Link>
              <ul className="space-y-1.5">
                {js.map((j) => {
                  const st = j.cancelled ? { word: "Cancelled", cls: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" } : STATUS[j.status] ?? { word: "Not started", cls: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" };
                  const did = span(j.actualStart, j.actualFinish, j.tz);
                  const plan = span(j.plannedStart, j.plannedFinish, j.tz);
                  return (
                    <li key={j.taskId} className="text-[12.5px]">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        {j.wo && <span className="font-mono font-bold text-[var(--color-text)]">WO {j.wo}</span>}
                        <span className="font-semibold text-[var(--color-text)] break-words">{j.name}</span>
                        <span className={`rounded px-1.5 py-px text-[13px] font-semibold ${st.cls}`}>{st.word}</span>
                      </div>
                      <div className="text-[var(--color-text-muted)]">
                        {[j.steps ? `${j.stepsDone} of ${j.steps} steps done` : `${j.pct}%`, did ? `worked ${did}` : null, plan ? `planned ${plan}` : null].filter(Boolean).join(" · ")}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {ready && (data?.findings.length ?? 0) > 0 && (
        <div className="px-4 py-3 border-t border-[var(--color-border)] space-y-1.5">
          <div className="text-[13px] font-semibold text-[var(--color-text-muted)] inline-flex items-center gap-1.5"><Lightbulb className="w-3.5 h-3.5" /> Findings on it, from every job</div>
          <ul className="space-y-1.5">
            {data!.findings.map((f) => (
              <li key={f.id} className="text-[12.5px]">
                <span className="font-semibold text-[var(--color-text)]">{f.topic || f.kind}:</span> <span className="text-[var(--color-text)]">{f.body}</span>
                {f.nextTime && <div className="text-[var(--color-text-muted)]">Next time: {f.nextTime}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
