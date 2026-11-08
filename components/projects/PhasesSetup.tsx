"use client";

// PhasesSetup - split a project into phases (Transmix 1 and 2: one AFE, two
// turnarounds), and the phase picker every schedule screen follows.
//
//   Phases: the project's name, each phase's name and dates, and the AFE
//   split by dragging the line between phases (or typing a % or $). The
//   schedule already on the project is the first phase; another phase's
//   schedule is imported into it from Plan › Import.
//
//   PhaseBar: All phases (the whole project) or one phase, remembered on
//   the device for the project.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Layers, Plus, Trash2, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/ui/Modal";
import { appConfirm } from "@/components/providers/DialogProvider";
import {
  type ProjectPhase, evenShares, fitShares, moveDivider, setShare, phaseAmount, shareOfAmount,
  startPhases, newPhaseId, phaseDates, phaseProblems,
} from "@/lib/projectPhases";
import { saveAfe } from "@/lib/costRevisions";
import { noEmDash } from "@/lib/noEmDash";

export const PHASE_COLORS = ["#0f766e", "#4338ca", "#b45309", "#be185d", "#0369a1", "#4d7c0f"];
export const phaseColor = (i: number) => PHASE_COLORS[i % PHASE_COLORS.length];

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const parseMoney = (s: string) => { const n = Number(s.replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : null; };

// ─── The picker ─────────────────────────────────────────────────────────

const pickKey = (projectId: string) => `project.phase:${projectId}`;

/** The phase picked on this device for the project (null: all phases). */
/** The phase picked on the project: the one asked for in the link, else the
 *  one picked last on this device ("all" when All phases was), else
 *  `fallback` (the phase running today), else all. */
export function usePhasePick(projectId: string | null | undefined, phases: ProjectPhase[], fallback: string | null = null): [string | null, (id: string | null) => void] {
  // Read on the first render in the browser (the bar shows only once the
  // project has loaded, so the server never draws it).
  const [raw, setRaw] = useState<string | null>(() => {
    if (typeof window === "undefined" || !projectId) return null;
    try { return new URL(window.location.href).searchParams.get("phase") ?? localStorage.getItem(pickKey(projectId)); } catch { return null; }
  });
  const known = (id: string | null) => !!id && phases.some((p) => p.id === id);
  const pick = known(raw) ? raw : raw === "all" ? null : known(fallback) ? fallback : null;
  const set = useCallback((id: string | null) => {
    setRaw(id ?? "all");
    if (!projectId) return;
    try {
      localStorage.setItem(pickKey(projectId), id ?? "all");
      const u = new URL(window.location.href);
      if (id) u.searchParams.set("phase", id); else u.searchParams.delete("phase");
      window.history.replaceState(null, "", u.toString());
    } catch { /* best effort */ }
  }, [projectId]);
  return [pick, set];
}

/** All phases or one: the schedule, reports and costs follow it. */
export function PhaseBar({ phases, pick, onPick, onEdit }: { phases: ProjectPhase[]; pick: string | null; onPick: (id: string | null) => void; onEdit?: () => void }) {
  if (!phases.length) return null;
  const seg = (on: boolean) => `shrink-0 inline-flex items-center gap-1.5 h-9 px-3 text-[13px] font-bold border-r last:border-r-0 border-[var(--color-border-strong)] ${on ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`;
  return (
    <div className="flex items-center gap-2 flex-wrap mb-4">
      <span className="text-[11px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">Phase</span>
      <div className="inline-flex max-w-full overflow-x-auto rounded-lg border border-[var(--color-border-strong)]" role="group" aria-label="Phase">
        <button type="button" aria-pressed={pick === null} onClick={() => onPick(null)} className={seg(pick === null)}>All phases</button>
        {phases.map((p, i) => (
          <button key={p.id} type="button" aria-pressed={pick === p.id} onClick={() => onPick(p.id)} className={seg(pick === p.id)} title={phaseDates(p)}>
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: phaseColor(i) }} />
            {p.name}
            <span className={`font-semibold text-[11.5px] ${pick === p.id ? "opacity-80" : "text-[var(--color-text-muted)]"}`}>{phaseDates(p)}</span>
          </button>
        ))}
      </div>
      {onEdit && <button type="button" onClick={onEdit} className="h-9 px-3 rounded-lg border border-[var(--color-border-strong)] text-[12.5px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] inline-flex items-center gap-1.5"><Layers className="w-4 h-4" /> Phases</button>}
    </div>
  );
}

// ─── The slider ─────────────────────────────────────────────────────────

/** The AFE as one bar, a piece per phase; drag a line to move the split. */
function SplitBar({ phases, total, onShares }: { phases: ProjectPhase[]; total: number; onShares: (s: number[]) => void }) {
  const bar = useRef<HTMLDivElement | null>(null);
  const drag = useRef<number | null>(null);
  const shares = phases.map((p) => p.share);
  const at = (clientX: number) => {
    const r = bar.current?.getBoundingClientRect();
    return r && r.width > 0 ? ((clientX - r.left) / r.width) * 100 : 0;
  };
  const onMove = (e: React.PointerEvent) => {
    if (drag.current == null) return;
    // Half a percent steps: easy to land on 50/50.
    onShares(moveDivider(shares, drag.current, Math.round(at(e.clientX) * 2) / 2));
  };
  // Where each line between two phases sits, % along the bar.
  const cuts = phases.slice(0, -1).map((_, i) => shares.slice(0, i + 1).reduce((a, b) => a + b, 0));
  return (
    <div className="select-none touch-none" onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <div ref={bar} className="relative h-12 rounded-xl overflow-hidden flex">
        {phases.map((p, i) => (
          <div key={p.id} className="h-full flex items-center justify-center text-white text-[12.5px] font-bold whitespace-nowrap overflow-hidden px-1" style={{ width: `${p.share}%`, background: phaseColor(i) }}>
            {p.share >= 12 ? `${p.name} · ${p.share}% · ${money(phaseAmount(total, p.share))}` : p.share >= 5 ? `${p.share}%` : ""}
          </div>
        ))}
      </div>
      <div className="relative -mt-12 h-12 pointer-events-none">
        {phases.slice(0, -1).map((p, i) => {
          const left = cuts[i];
          return (
            <button key={p.id} type="button" aria-label={`Line between ${p.name} and ${phases[i + 1].name}, ${left.toFixed(1)}%`}
              onPointerDown={(e) => { drag.current = i; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); }}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 5 : 0.5;
                if (e.key === "ArrowLeft") { e.preventDefault(); onShares(moveDivider(shares, i, left - step)); }
                if (e.key === "ArrowRight") { e.preventDefault(); onShares(moveDivider(shares, i, left + step)); }
              }}
              className="pointer-events-auto absolute -top-1 w-5 h-14 -ml-2.5 rounded-lg bg-white border-2 border-slate-900 shadow-md cursor-ew-resize focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              style={{ left: `${left}%` }} />
          );
        })}
      </div>
    </div>
  );
}

// ─── Setup ──────────────────────────────────────────────────────────────

interface SetupProps {
  orgId: string; projectId: string; projectName: string;
  phases: ProjectPhase[];
  uid: string; userEmail: string | null;
  onClose: () => void; onSaved: () => void;
}

export function PhasesSetup({ orgId, projectId, projectName, phases: saved, uid, userEmail, onClose, onSaved }: SetupProps) {
  const [name, setName] = useState(projectName);
  const [phases, setPhases] = useState<ProjectPhase[]>(saved);
  const [afe, setAfe] = useState<{ number: string | null; account: string | null; authorized: number | null; docId: string | null } | null>(null);
  const [linesTotal, setLinesTotal] = useState<number | null>(null);
  const [afeDraft, setAfeDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The AFE, the budget lines' total, and the schedule's dates (phase 1's).
  useEffect(() => {
    let live = true;
    void (async () => {
      const [p, lines, first, last] = await Promise.all([
        supabase.from("projects").select("afe_number, charge_account, authorized_amount, budget_doc_id").eq("id", projectId).maybeSingle(),
        supabase.from("cost_accounts").select("budget").eq("project_id", projectId),
        supabase.from("milestones").select("planned_start_at, planned_at").eq("project_id", projectId).not("planned_start_at", "is", null).order("planned_start_at", { ascending: true }).limit(1),
        supabase.from("milestones").select("planned_at").eq("project_id", projectId).not("planned_at", "is", null).order("planned_at", { ascending: false }).limit(1),
      ]);
      if (!live) return;
      const row = (p.data ?? null) as { afe_number?: string | null; charge_account?: string | null; authorized_amount?: number | null; budget_doc_id?: string | null } | null;
      const a = { number: row?.afe_number ?? null, account: row?.charge_account ?? null, authorized: row?.authorized_amount == null ? null : Number(row.authorized_amount), docId: row?.budget_doc_id ?? null };
      setAfe(a);
      setAfeDraft(a.authorized != null ? String(a.authorized) : "");
      setLinesTotal(((lines.data ?? []) as Array<{ budget: number | null }>).reduce((s, x) => s + Number(x.budget ?? 0), 0));
      // No phases yet: start with two, the schedule there as phase 1.
      if (!saved.length) {
        const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-CA") : null);
        const f = (first.data?.[0] ?? null) as { planned_start_at?: string | null } | null;
        const l = (last.data?.[0] ?? null) as { planned_at?: string | null } | null;
        setPhases(startPhases("Phase", { start: day(f?.planned_start_at), end: day(l?.planned_at) }));
      }
    })();
    return () => { live = false; };
  }, [projectId, projectName, saved]);

  const total = afe?.authorized ?? linesTotal ?? 0;
  const problems = useMemo(() => phaseProblems(phases), [phases]);
  const edit = (i: number, patch: Partial<ProjectPhase>) => setPhases((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const shares = (s: number[]) => setPhases((ps) => ps.map((p, j) => ({ ...p, share: s[j] })));
  const add = () => setPhases((ps) => {
    if (!ps.length) return startPhases("Phase", { start: null, end: null });
    const last = ps[ps.length - 1];
    const half = Math.round((last.share / 2) * 10) / 10;
    return [...ps.slice(0, -1), { ...last, share: Math.round((last.share - half) * 10) / 10 }, { id: newPhaseId(), name: `Phase ${ps.length + 1}`, start: null, end: null, share: half }];
  });
  const remove = async (i: number) => {
    const p = phases[i];
    if (!(await appConfirm({ message: `Remove ${p.name}? Its schedule stays on the project and goes back into ${i === 0 ? phases[1]?.name ?? "the project" : phases[0].name}. Its share of the AFE goes to the other phases.`, confirmLabel: "Remove phase", tone: "danger" }))) return;
    setPhases((ps) => { const rest = ps.filter((_, j) => j !== i); return rest.map((x, j) => ({ ...x, share: fitShares(rest.map((r) => r.share))[j] })); });
  };

  const save = async () => {
    setErr(null);
    if (problems.length) { setErr(problems[0]); return; }
    setBusy(true);
    try {
      // The AFE amount typed here goes through the AFE's own history.
      const typed = afeDraft.trim() ? parseMoney(afeDraft) : null;
      if (afe && typed != null && typed !== afe.authorized) {
        const r = await saveAfe({ orgId, projectId, before: { afeNumber: afe.number, chargeAccount: afe.account, authorized: afe.authorized, docId: afe.docId },
          next: { afeNumber: afe.number, chargeAccount: afe.account, authorized: typed }, note: "Entered with the phases", actor: { uid, email: userEmail } });
        if (!r.ok) { setErr(r.error ?? "The AFE amount wasn't saved."); return; }
      }
      // One phase left is no phases: the whole project, one schedule.
      const keep = phases.length > 1 ? phases.map((p) => ({ ...p, name: noEmDash(p.name.trim()) })) : [];
      // Saved with the project's settings (projects.shift_times), where the
      // shift times, letterhead and project type save: no new column needed.
      const { data: cur, error: readErr } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
      if (readErr) { setErr(`Not saved. The database said: ${readErr.message}`); return; }
      const settings = { ...(((cur as { shift_times?: Record<string, unknown> | null } | null)?.shift_times) ?? {}), phases: keep };
      const patch: Record<string, unknown> = { shift_times: settings };
      if (name.trim() && name.trim() !== projectName) patch.name = noEmDash(name.trim());
      const { data, error } = await supabase.from("projects").update(patch).eq("id", projectId).select("id");
      if (error) { setErr(`Not saved. The database said: ${error.message}`); return; }
      if (!data?.length) { setErr("Not saved - only the project's owner, a co-owner or an admin can change the phases."); return; }
      // A copy in the phases column, when the database has it.
      void supabase.from("projects").update({ phases: keep }).eq("id", projectId).then(() => undefined, () => undefined);
      onSaved();
      onClose();
    } finally { setBusy(false); }
  };

  const input = "h-9 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-[13px] text-[var(--color-text)]";
  return (
    <Modal onClose={onClose} size="xl" dismissable={!busy}>
      <ModalHeader icon={Layers} title="Phases" subtitle="One project, one AFE, split into phases: each with its own dates, schedule, reports and share of the budget." onClose={onClose} />
      <ModalBody className="space-y-5">

        <label className="block">
          <span className="block text-[11px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1">Project name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={`${input} w-full max-w-lg`} />
        </label>

        <div>
          <span className="block text-[11px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1">AFE{afe?.number ? ` ${afe.number}` : ""}</span>
          <div className="flex items-center gap-2 flex-wrap">
            <input value={afeDraft} onChange={(e) => setAfeDraft(e.target.value)} inputMode="decimal" placeholder={linesTotal ? money(linesTotal) : "$0"} aria-label="AFE amount" className={`${input} w-44`} />
            <span className="text-[12.5px] text-[var(--color-text-muted)]">
              {afe?.authorized != null ? "Authorized amount, split between the phases below."
                : linesTotal ? `No AFE amount entered: splitting the budget lines' total, ${money(linesTotal)}. Type the AFE amount to split it instead.`
                  : "Type the AFE amount to split it."}
            </span>
          </div>
        </div>

        <div>
          <div className="grid grid-cols-[minmax(0,1.4fr)_repeat(2,minmax(0,1fr))_80px_110px_36px] gap-2 items-end text-[11px] font-black uppercase tracking-widest text-[var(--color-text-muted)] pb-1 max-sm:hidden">
            <span>Phase</span><span>Starts</span><span>Finishes</span><span className="text-right">Share</span><span className="text-right">Budget</span><span />
          </div>
          <div className="space-y-2">
            {phases.map((p, i) => (
              <div key={p.id} className="grid grid-cols-2 sm:grid-cols-[minmax(0,1.4fr)_repeat(2,minmax(0,1fr))_80px_110px_36px] gap-2 items-center rounded-xl sm:rounded-none border sm:border-0 border-[var(--color-border)] p-2 sm:p-0">
                <div className="col-span-2 sm:col-span-1 flex items-center gap-2 min-w-0">
                  <span className="w-6 h-6 rounded-md shrink-0 text-white text-[12px] font-black flex items-center justify-center" style={{ background: phaseColor(i) }}>{i + 1}</span>
                  <input value={p.name} onChange={(e) => edit(i, { name: e.target.value })} aria-label={`Phase ${i + 1} name`} className={`${input} min-w-0 flex-1 font-bold`} />
                </div>
                <input type="date" value={p.start ?? ""} onChange={(e) => edit(i, { start: e.target.value || null })} aria-label={`${p.name} starts`} className={input} />
                <input type="date" value={p.end ?? ""} min={p.start ?? undefined} onChange={(e) => edit(i, { end: e.target.value || null })} aria-label={`${p.name} finishes`} className={input} />
                <div className="relative">
                  <input value={String(p.share)} inputMode="decimal" aria-label={`${p.name} share`} onChange={(e) => { const v = Number(e.target.value.replace(/[%\s]/g, "")); if (Number.isFinite(v)) shares(setShare(phases.map((x) => x.share), i, v)); }}
                    className={`${input} w-full text-right pr-6`} />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[12px] text-[var(--color-text-muted)]">%</span>
                </div>
                <input key={`${p.id}:${p.share}:${total}`} defaultValue={money(phaseAmount(total, p.share))} inputMode="decimal" aria-label={`${p.name} budget`}
                  onBlur={(e) => { const v = parseMoney(e.target.value); if (v != null && total > 0) shares(setShare(phases.map((x) => x.share), i, shareOfAmount(total, v))); }}
                  className={`${input} w-full text-right font-bold`} />
                <button type="button" onClick={() => void remove(i)} disabled={phases.length <= 1} aria-label={`Remove ${p.name}`} className="justify-self-end w-9 h-9 rounded-lg text-[var(--color-text-faint)] hover:text-rose-600 hover:bg-[var(--color-surface-2)] disabled:opacity-30 flex items-center justify-center"><Trash2 className="w-4 h-4" /></button>
              </div>
            ))}
          </div>
        </div>

        {phases.length > 1 && (
          <div>
            <div className="flex items-baseline justify-between gap-2 mb-2">
              <span className="text-[13px] font-bold text-[var(--color-text)]">Split the {afe?.authorized != null ? "AFE" : "budget"}: drag the line</span>
              <button type="button" onClick={() => shares(evenShares(phases.length))} className="text-[12.5px] font-bold text-[var(--color-accent)]">Split evenly</button>
            </div>
            <SplitBar phases={phases} total={total} onShares={shares} />
            <p className="mt-2 text-[12px] text-[var(--color-text-muted)]">Or type a % or $ above. It always adds up to 100%{total ? ` of ${money(total)}` : ""}.</p>
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={add} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-[var(--color-border-strong)] text-[13px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><Plus className="w-4 h-4" /> Add phase</button>
        </div>
        {phases.length > 1 && (
          <p className="text-[12.5px] text-[var(--color-text-muted)] rounded-xl bg-[var(--color-surface-2)] p-3">
            The schedule already on the project is <b className="text-[var(--color-text)]">{phases[0].name}</b>. For {phases.slice(1).map((p) => p.name).join(", ")}: pick it at the top of the project, then Plan › Import its schedule. Each phase is tracked on its own; All phases is the whole project.
          </p>
        )}
        {err && <div role="alert" className="text-[12.5px] font-semibold text-rose-700 dark:text-rose-400">{err}</div>}
      </ModalBody>
      <ModalFooter>
        {problems.length > 0 && <span className="mr-auto text-[12px] text-amber-700 dark:text-amber-400">{problems[0]}</span>}
        <button type="button" onClick={onClose} disabled={busy} className="h-9 px-4 rounded-lg border border-[var(--color-border-strong)] text-[13px] font-bold">Cancel</button>
        <button type="button" onClick={() => void save()} disabled={busy || problems.length > 0} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[13px] font-black disabled:opacity-50">
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} Save phases
        </button>
      </ModalFooter>
    </Modal>
  );
}
