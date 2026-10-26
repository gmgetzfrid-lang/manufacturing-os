"use client";

// SafetyMomentBox — the turnover's safety moment, in the space the old
// "safety moment" checkbox had.
//
// Three columns: the next shift's riskiest kinds of work (ranked from the
// schedule as soon as the report opens), each with two lessons from real
// incidents — what went wrong somewhere, then what to check here — and the
// pages they came from. The supervisor can add a line the schedule doesn't
// show ("one crane pick at 02:00") and build it with one click; it's saved
// for the shift, so every screen and the printout show the same thing.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  rankHazards, hazardContext, sourceLabel,
  type HazardJobInput, type RankedHazard, type SafetyMoment,
} from "@/lib/safetyMoment";

export interface SafetyMomentState {
  moment: SafetyMoment | null;
  loaded: boolean;
  building: boolean;
  error: string | null;
  warning: string | null;
  /** False when the report has no workspace to bill (no build button). */
  canBuild: boolean;
  build: (hazards: RankedHazard[], note: string, shiftLabel: string) => void;
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : {};
}

/** The saved moment for a project's shift, and building a new one. */
export function useSafetyMoment(o: {
  orgId?: string; projectId: string; shiftStart: number; shiftKind: "day" | "night";
}): SafetyMomentState {
  const { orgId, projectId, shiftStart, shiftKind } = o;
  const key = `${projectId}:${shiftStart}`;
  const [got, setGot] = useState<{ key: string; moment: SafetyMoment | null } | null>(null);
  const [run, setRun] = useState<{ key: string; building: boolean; error: string | null; warning: string | null } | null>(null);

  useEffect(() => {
    let alive = true;
    supabase.from("shift_safety_moments").select("moment")
      .eq("project_id", projectId).eq("shift_start", new Date(shiftStart).toISOString()).maybeSingle()
      .then(({ data }) => { if (alive) setGot({ key, moment: (data as { moment?: SafetyMoment } | null)?.moment ?? null }); },
        () => { if (alive) setGot({ key, moment: null }); });
    return () => { alive = false; };
  }, [key, projectId, shiftStart]);

  const build = useCallback((hazards: RankedHazard[], note: string, shiftLabel: string) => {
    if (!orgId) return;
    setRun({ key, building: true, error: null, warning: null });
    (async () => {
      try {
        const res = await fetch("/api/projects/safety-moment", {
          method: "POST",
          headers: { "content-type": "application/json", ...(await authHeader()) },
          body: JSON.stringify({ orgId, projectId, shiftStart, shiftKind, shiftLabel, hazards, note }),
        });
        const body = (await res.json().catch(() => null)) as { moment?: SafetyMoment; warning?: string; error?: string } | null;
        if (!res.ok || !body?.moment) throw new Error(body?.error || `Couldn't build it (HTTP ${res.status}).`);
        setGot({ key, moment: body.moment });
        setRun({ key, building: false, error: null, warning: body.warning ?? null });
      } catch (e) {
        setRun({ key, building: false, error: (e as Error).message, warning: null });
      }
    })();
  }, [orgId, projectId, shiftStart, shiftKind, key]);

  const r = run?.key === key ? run : null;
  const moment = got?.key === key ? got.moment : null;
  const loaded = got?.key === key;
  return useMemo(() => ({
    moment, loaded,
    building: !!r?.building, error: r?.error ?? null, warning: r?.warning ?? null,
    canBuild: !!orgId, build,
  }), [moment, loaded, r, orgId, build]);
}

const muted = "text-orange-900/75 dark:text-orange-200/70";

export function SafetyMomentBox({ jobs, safety, shiftKind, shiftLabel, print, stamp }: {
  jobs: HazardJobInput[];
  safety: SafetyMomentState;
  shiftKind: "day" | "night";
  /** "Night shift Mon, Oct 26 18:00–6:00" — tells the search when. */
  shiftLabel: string;
  print: boolean;
  /** Date + time in the schedule's time zone. */
  stamp: (ms: number) => string;
}) {
  const { moment } = safety;
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const noteText = note ?? moment?.note ?? "";
  // The ranking follows the note as it's typed: name a crane pick and it
  // takes its place among the three.
  const hazards = useMemo(() => rankHazards(jobs, { note: noteText }), [jobs, noteText]);
  const when = shiftKind === "night" ? "Tonight's" : "Today's";
  const showEditor = !print && safety.canBuild && (!moment || editing);
  const building = safety.building;

  // Built: the lessons. Not yet: the three jobs, so the meeting still sees
  // what's riskiest even before (or without) the search.
  const cols = moment && !editing
    ? moment.items.map((it) => ({ key: it.kind, title: it.title, context: it.context, gems: it.gems }))
    : hazards.map((h) => ({ key: h.kind, title: h.label, context: hazardContext(h), gems: null }));

  if (cols.length === 0 && (print || !safety.canBuild)) return null;

  return (
    <div className="keep rounded-md border border-orange-300 bg-orange-50/70 px-3 py-2 space-y-2 dark:border-orange-900 dark:bg-orange-950/25">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-orange-800 dark:text-orange-300">
          <ShieldAlert className="w-3 h-3 self-center" aria-hidden="true" /> Safety moment
        </span>
        <span className={`text-[11.5px] ${muted}`}>
          {cols.length ? `${when} ${cols.length === 1 ? "riskiest job" : `${cols.length} riskiest jobs`}` : "Nothing on the schedule stands out — name the work below."}
        </span>
        <span className="flex-1" />
        {moment && !editing && !print && safety.canBuild && (
          <button type="button" onClick={() => setEditing(true)} disabled={building}
            className="inline-flex items-center gap-1 text-[11px] font-bold text-orange-800 hover:underline disabled:opacity-50 dark:text-orange-300">
            <RefreshCw className="w-3 h-3" aria-hidden="true" /> Rebuild
          </button>
        )}
      </div>

      {cols.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 print:grid-cols-3 gap-x-4 gap-y-3">
          {cols.map((c, i) => (
            <div key={c.key} className="min-w-0 space-y-1.5">
              <div className="border-b border-orange-200 pb-1 dark:border-orange-900/60">
                <div className="text-[12.5px] font-extrabold leading-tight text-[var(--color-text)]">{i + 1} · {c.title}</div>
                {c.context && <div className={`text-[10.5px] leading-snug ${muted}`}>{c.context}</div>}
              </div>
              {c.gems?.map((g) => (
                <p key={g.what} className="text-[11.5px] leading-snug">
                  <span className="text-[var(--color-text-muted)]">{g.what}</span>{" "}
                  <b className="font-bold text-[var(--color-text)]">{g.do}</b>
                </p>
              ))}
              {c.gems && c.gems.length === 0 && (
                <p className={`text-[11px] italic ${muted}`}>No lesson it could back with a source — talk this one through.</p>
              )}
              {c.gems && c.gems.length > 0 && (
                <div className="text-[10px] leading-tight">
                  {c.gems.map((g, k) => (
                    <span key={g.source.url}>
                      {k > 0 && <span className={muted}> · </span>}
                      <a href={g.source.url} target="_blank" rel="noreferrer" title={g.source.title ?? g.source.url}
                        className="text-orange-800 underline decoration-orange-300 underline-offset-2 hover:text-orange-950 dark:text-orange-300 dark:decoration-orange-800 dark:hover:text-orange-100">
                        {sourceLabel(g.source)}
                      </a>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showEditor && (
        <form className="flex flex-col sm:flex-row gap-2 sm:items-center"
          onSubmit={(e) => { e.preventDefault(); if (!building && hazards.length) { safety.build(hazards, noteText, shiftLabel); setEditing(false); } }}>
          <label className="sr-only" htmlFor="safety-note">Anything the schedule doesn&apos;t show</label>
          <input id="safety-note" value={noteText} onChange={(e) => setNote(e.target.value)} disabled={building} maxLength={500}
            placeholder="Add anything the schedule doesn't show (optional) — e.g. one crane pick at 02:00 over the pipe rack"
            className="min-w-0 flex-1 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)]" />
          <div className="flex items-center gap-2">
            {editing && (
              <button type="button" onClick={() => { setEditing(false); setNote(null); }} className={`text-[11.5px] font-bold ${muted} hover:underline`}>Cancel</button>
            )}
            <button type="submit" disabled={building || hazards.length === 0}
              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-orange-600 px-3 py-1.5 text-[12px] font-bold text-white hover:bg-orange-700 disabled:opacity-50">
              {building && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
              {building ? "Searching…" : moment ? "Rebuild" : "Build safety moment"}
            </button>
          </div>
        </form>
      )}
      {!print && building && (
        <p className={`text-[11px] ${muted}`}>Searching real incidents for {cols.map((c) => c.title.toLowerCase()).join(", ")} — about a minute.</p>
      )}
      {!print && safety.error && <p className="text-[11.5px] font-semibold text-rose-700 dark:text-rose-300">{safety.error}</p>}
      {!print && safety.warning && <p className="text-[11px] text-amber-800 dark:text-amber-300">{safety.warning}</p>}
      {!print && moment && !editing && (
        <p className={`text-[10px] ${muted}`}>
          Built {stamp(Date.parse(moment.builtAt))}
          {moment.builtByName ? ` by ${moment.builtByName}` : ""}{moment.note ? ` · note: “${moment.note}”` : ""}
        </p>
      )}
    </div>
  );
}
