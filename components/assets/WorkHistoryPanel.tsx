"use client";

// WorkHistoryPanel - every job done on this equipment, across projects:
// each work order with its project, dates, steps done, and the findings
// kept on the equipment for the next job (lib/equipmentHistory).

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { loadEquipmentHistory, type EquipmentHistory, type HistoryJob } from "@/lib/equipmentHistory";
import { fmtInTz } from "@/lib/scheduleTz";
import { CopyId } from "@/components/ui/CopyId";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { SkeletonText } from "@/components/ui/Skeleton";

const STATUS: Record<string, { word: string; pill: string }> = {
  completed: { word: "Done", pill: "is-good" },
  in_progress: { word: "Under way", pill: "" },
  on_hold: { word: "On hold", pill: "is-warn" },
  blocked: { word: "Blocked", pill: "is-bad" },
};

export default function WorkHistoryPanel({ orgId, assetId, code, tag, unitCode }: { orgId: string; assetId: string; code?: string | null; tag?: string | null; unitCode?: string | null }) {
  const key = `${orgId}:${assetId}:${code ?? ""}:${tag ?? ""}`;
  const [state, setState] = useState<{ key: string; data: EquipmentHistory | null; error: unknown }>({ key: "", data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    loadEquipmentHistory(orgId, { id: assetId, code, tag, unitCode })
      .then((data) => { if (live) setState({ key, data, error: null }); })
      .catch((e) => { if (live) setState({ key, data: null, error: e ?? true }); });
    return () => { live = false; };
  }, [orgId, assetId, code, tag, unitCode, key, attempt]);
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
    <section className="min-w-0">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1 mb-3 min-h-8">
        <h2 className="font-display text-[20px] leading-tight font-semibold text-[var(--color-text)]">Work history</h2>
        {ready && data && jobs.length > 0 && (
          <span className="text-[14px] text-[var(--color-text-muted)] tabular-nums">
            {jobs.length} work order{jobs.length === 1 ? "" : "s"}, {byProject.size} project{byProject.size === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] overflow-hidden">
      {!ready ? (
        <div className="px-4 py-4"><SkeletonText lines={3} /></div>
      ) : state.error ? (
        <ErrorNote compact className="px-4 py-4" error={state.error} title="Couldn't read the jobs." onRetry={() => setAttempt((n) => n + 1)} />
      ) : jobs.length === 0 ? (
        <div className="px-4 py-4 text-[14px] text-[var(--color-text-muted)]">
          No work orders on it yet. A project&apos;s work orders show here once they&apos;re linked to it in the project&apos;s Setup › Units &amp; equipment{code ? `, or carry its number ${code} in the schedule` : ""}.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {[...byProject.entries()].map(([pid, js]) => (
            <li key={pid} className="px-4 py-3 space-y-1.5">
              <Link href={`/projects/${pid}?tab=work`} className="text-[15px] font-semibold text-[var(--color-accent-text)] hover:underline">{js[0].projectName}</Link>
              <ul className="space-y-1.5">
                {js.map((j) => {
                  const st = j.cancelled ? { word: "Cancelled", pill: "is-muted" } : STATUS[j.status] ?? { word: "Not started", pill: "is-muted" };
                  const did = span(j.actualStart, j.actualFinish, j.tz);
                  const plan = span(j.plannedStart, j.plannedFinish, j.tz);
                  return (
                    <li key={j.taskId} className="text-[14px]">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        {j.wo && <CopyId value={j.wo} label="work order number">WO {j.wo}</CopyId>}
                        <span className="font-semibold text-[var(--color-text)] break-words">{j.name}</span>
                        <span className={`ui-pill ${st.pill}`}>{st.word}</span>
                      </div>
                      <div className="text-[13px] text-[var(--color-text-muted)] tabular-nums">
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
          <div className="text-[14px] font-semibold text-[var(--color-text)]">Findings on it, from every job</div>
          <ul className="space-y-1.5">
            {data!.findings.map((f) => (
              <li key={f.id} className="text-[14px]">
                <span className="font-semibold text-[var(--color-text)]">{f.topic || f.kind}:</span> <span className="text-[var(--color-text)]">{f.body}</span>
                {f.nextTime && <div className="text-[var(--color-text-muted)]">Next time: {f.nextTime}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
      </div>
    </section>
  );
}
