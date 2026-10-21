"use client";

// AreaWorkPanel / ScheduledWorkPanel — WIRE-7 criteria 2-3 (intelligence
// Round G I-26), read through lib/areaWork.ts under the reader's own RLS.
//   * AreaWorkPanel (the Operating Areas page, inside the area's card): the
//     open holds on the area's documents, the open work packages that carry
//     one of them, and the open milestones whose location names the area or
//     one of its equipment.
//   * ScheduledWorkPanel (the asset hub): the open milestones whose location
//     names this equipment.
// A read that failed is said; an empty list is said as empty, never hidden.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarClock, Lock, Package, Loader2 } from "lucide-react";
import { loadAreaWork, loadAssetScheduledWork, type AreaWork, type LocatedMilestone } from "@/lib/areaWork";

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "no date");

function MilestoneRow({ m }: { m: LocatedMilestone }) {
  const where = m.match.kind === "asset" ? m.match.tag : `unit ${m.match.code}`;
  const body = (
    <>
      <span className="font-bold text-[var(--color-text)]">{m.name}</span>
      <span className="text-[var(--color-text-muted)]"> · {day(m.plannedAt)} · {m.status.replace("_", " ")}</span>
      <span className="text-[var(--color-text-faint)]" title={`Location: ${m.location}`}> · at {where}</span>
    </>
  );
  return (
    <li data-milestone={m.id} data-milestone-match={m.match.kind}>
      {m.projectId ? <Link href={`/projects/${m.projectId}`} className="hover:underline">{body}</Link> : body}
    </li>
  );
}

export function AreaWorkPanel({ orgId, unitCode }: { orgId: string; unitCode: string }) {
  // Keyed by what was read, so a change of area reads as loading again.
  const key = `${orgId}:${unitCode}`;
  const [answer, setAnswer] = useState<{ key: string; work: AreaWork | null; failed: string | null } | null>(null);
  useEffect(() => {
    let alive = true;
    loadAreaWork(orgId, unitCode)
      .then((w) => { if (alive) setAnswer({ key: `${orgId}:${unitCode}`, work: w, failed: null }); })
      .catch((e) => { if (alive) setAnswer({ key: `${orgId}:${unitCode}`, work: null, failed: (e as Error)?.message || "the read failed" }); });
    return () => { alive = false; };
  }, [orgId, unitCode]);
  const current = answer?.key === key ? answer : null;
  const work = current?.work ?? null;
  const failed = current?.failed ?? null;

  return (
    <div className="mt-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-[11px]" data-area-work>
      <div className="text-xs font-black text-[var(--color-text)] mb-1">In flight on this area</div>
      {failed ? (
        <div className="text-rose-700 dark:text-rose-300">The area&apos;s work could not be read ({failed}).</div>
      ) : !work ? (
        <div className="text-[var(--color-text-muted)] inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Reading holds, work packages and milestones…</div>
      ) : (
        <div className="space-y-1.5">
          <div data-area-work-holds={work.holds.length}>
            <div className="font-black text-[var(--color-text-muted)] inline-flex items-center gap-1"><Lock className="w-3 h-3" /> {work.holds.length} open hold{work.holds.length === 1 ? "" : "s"} on its documents</div>
            {work.holds.length > 0 && (
              <ul className="ml-4 list-disc">
                {work.holds.slice(0, 8).map((h) => (
                  <li key={h.id}>
                    {h.libraryId
                      ? <Link href={`/documents/${h.libraryId}?doc=${h.documentId}`} className="font-mono font-bold hover:underline">{h.documentLabel}</Link>
                      : <span className="font-mono font-bold">{h.documentLabel}</span>}
                    <span className="text-[var(--color-text-muted)]"> — {h.reason}{h.expectedReleaseAt ? ` · release expected ${day(h.expectedReleaseAt)}` : ""}</span>
                  </li>
                ))}
                {work.holds.length > 8 && <li className="text-[var(--color-text-faint)]">+{work.holds.length - 8} more</li>}
              </ul>
            )}
          </div>
          <div data-area-work-packages={work.workPackages.length}>
            <div className="font-black text-[var(--color-text-muted)] inline-flex items-center gap-1"><Package className="w-3 h-3" /> {work.workPackages.length} open work package{work.workPackages.length === 1 ? "" : "s"} carrying its documents</div>
            {work.workPackages.length > 0 && (
              <ul className="ml-4 list-disc">
                {work.workPackages.slice(0, 8).map((p) => (
                  <li key={p.id}>
                    <Link href="/packages" className="font-bold hover:underline">{p.name}</Link>
                    <span className="text-[var(--color-text-muted)]"> · {p.status} · {p.documents} of its document{p.documents === 1 ? "" : "s"} here</span>
                  </li>
                ))}
                {work.workPackages.length > 8 && <li className="text-[var(--color-text-faint)]">+{work.workPackages.length - 8} more</li>}
              </ul>
            )}
          </div>
          <div data-area-work-milestones={work.milestones.length}>
            <div className="font-black text-[var(--color-text-muted)] inline-flex items-center gap-1"><CalendarClock className="w-3 h-3" /> {work.milestones.length} scheduled milestone{work.milestones.length === 1 ? "" : "s"} located here</div>
            {work.milestones.length > 0 && (
              <ul className="ml-4 list-disc">
                {work.milestones.slice(0, 8).map((m) => <MilestoneRow key={m.id} m={m} />)}
                {work.milestones.length > 8 && <li className="text-[var(--color-text-faint)]">+{work.milestones.length - 8} more</li>}
              </ul>
            )}
          </div>
          {work.notes.length > 0 && (
            <div className="text-amber-700 dark:text-amber-300" data-area-work-incomplete>{work.notes.join(" ")}</div>
          )}
        </div>
      )}
    </div>
  );
}

export function ScheduledWorkPanel({ orgId, asset }: { orgId: string; asset: { id: string; tag: string } }) {
  const key = `${orgId}:${asset.id}:${asset.tag}`;
  const [answer, setAnswer] = useState<{ key: string; milestones: LocatedMilestone[]; note: string | null } | null>(null);
  const { id, tag } = asset;
  useEffect(() => {
    let alive = true;
    const k = `${orgId}:${id}:${tag}`;
    loadAssetScheduledWork(orgId, { id, tag })
      .then((r) => { if (alive) setAnswer({ key: k, ...r }); })
      .catch((e) => { if (alive) setAnswer({ key: k, milestones: [], note: `Scheduled work could not be read (${(e as Error)?.message || "the read failed"}).` }); });
    return () => { alive = false; };
  }, [orgId, id, tag]);
  const state = answer?.key === key ? answer : null;

  if (!state) return null;
  if (state.milestones.length === 0 && !state.note) return null;
  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm p-4" data-scheduled-work={state.milestones.length}>
      <div className="text-sm font-black text-[var(--color-text)] inline-flex items-center gap-2 mb-2"><CalendarClock className="w-4 h-4 text-cyan-600" /> Scheduled work</div>
      {state.milestones.length > 0 && (
        <ul className="space-y-1 text-xs">
          {state.milestones.map((m) => <MilestoneRow key={m.id} m={m} />)}
        </ul>
      )}
      <div className="text-[10px] text-[var(--color-text-faint)] mt-1">Milestones whose location names {asset.tag}.</div>
      {state.note && <div className="text-[11px] text-amber-700 dark:text-amber-300 mt-1" data-scheduled-work-note>{state.note}</div>}
    </div>
  );
}
