"use client";

// Setup › Manpower, bids & staffing plans: each crew's company (Schultz -
// Tower is Schultz), each company's bid manpower per day and night shift
// (direct, indirect), its rate when it bills by the hour, and its staffing
// plan (planned hands by date). The meeting's counts are held to these on
// the look-back.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, Upload } from "lucide-react";
import type { Milestone } from "@/types/schema";
import { companyOf, defaultCompany, loadManpowerSettings, saveManpowerSettings, cleanManpower, type CompanyBid, type ManpowerSettings } from "@/lib/manpower";
import { loadNextPlanSettings, saveStaffingPlan } from "@/lib/nextPlanStore";
import { parseStaffingGrid, type StaffingPlans } from "@/lib/staffingPlan";

export const MANPOWER_CHANGED = "manpower:changed";
const cache = new Map<string, ManpowerSettings>();

/** The project's manpower settings, kept current across the page. */
export function useManpowerSettings(projectId: string | null | undefined) {
  const [s, setS] = useState<ManpowerSettings | null>(() => (projectId ? cache.get(projectId) ?? null : null));
  const load = useCallback(() => {
    if (!projectId) return;
    void loadManpowerSettings(projectId).then((x) => { cache.set(projectId, x); setS(x); }).catch(() => setS({}));
  }, [projectId]);
  useEffect(() => {
    load();
    window.addEventListener(MANPOWER_CHANGED, load);
    return () => window.removeEventListener(MANPOWER_CHANGED, load);
  }, [load]);
  return s;
}

/** Set: some company has a bid. */
export const manpowerSet = (s: ManpowerSettings | null) => (s == null ? null : Object.keys(s.bids ?? {}).length > 0);

const field = "h-9 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[13px] text-[var(--color-text)]";
const numField = `${field} w-16 text-right font-mono`;
const btn = "inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-[12.5px] font-bold px-3.5 py-2 shadow-sm disabled:opacity-50";

export function ManpowerStep({ projectId, milestones, canManage, userEmail }: { projectId: string; milestones: Milestone[]; canManage: boolean; userEmail?: string }) {
  const saved = useManpowerSettings(projectId);
  const [draft, setDraft] = useState<ManpowerSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const s = draft ?? saved ?? {};
  // The crews on the schedule (and any already given a company).
  const crews = useMemo(() => {
    const set = new Set<string>();
    for (const m of milestones) { const c = m.responsibleParty?.trim(); if (c) set.add(c); }
    for (const c of Object.keys(s.companyOf ?? {})) set.add(c);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [milestones, s.companyOf]);
  const companies = useMemo(() => {
    const set = new Set<string>(crews.map((c) => companyOf(c, s)));
    for (const c of Object.keys(s.bids ?? {})) set.add(c);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [crews, s]);
  const change = (f: (x: ManpowerSettings) => ManpowerSettings) => { setMsg(null); setDraft((d) => f(d ?? saved ?? {})); };
  const setCompany = (crew: string, co: string) => change((x) => {
    const m = { ...(x.companyOf ?? {}) };
    if (!co.trim() || co.trim() === defaultCompany(crew)) delete m[crew]; else m[crew] = co.trim();
    return { ...x, companyOf: m };
  });
  const num = (v: string) => (v.trim() === "" ? null : Math.max(0, Number(v.replace(/[^0-9.]/g, ""))));
  const setBid = (co: string, f: (b: CompanyBid) => CompanyBid) => change((x) => ({ ...x, bids: { ...(x.bids ?? {}), [co]: f(x.bids?.[co] ?? {}) } }));
  const save = async () => {
    if (!draft) return;
    setBusy(true); setMsg(null);
    try {
      await saveManpowerSettings(projectId, cleanManpower(draft));
      setDraft(null);
      window.dispatchEvent(new CustomEvent(MANPOWER_CHANGED));
      setMsg("Saved for everyone on this project.");
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };
  if (!saved && !draft) return <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Reading…</div>;
  const ro = !canManage;
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="text-[12px] font-semibold text-[var(--color-text-muted)]">Each crew&apos;s company</div>
        <p className="text-[12px] text-[var(--color-text-muted)]">Read from the crew&apos;s name: Schultz - Tower and Schultz 1 are Schultz; (KE) crews are Kern Energy. Change any that&apos;s wrong.</p>
        {crews.length === 0 ? <div className="text-[12.5px] text-[var(--color-text-muted)]">No crews on the schedule yet.</div> : (
          <ul className="rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
            {crews.map((c) => (
              <li key={c} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[12.5px]">
                <span className="flex-1 min-w-[8rem] font-semibold text-[var(--color-text)] break-words">{c}</span>
                <input value={s.companyOf?.[c] ?? ""} placeholder={defaultCompany(c)} disabled={ro} list="mp-companies" aria-label={`${c}'s company`}
                  onChange={(e) => setCompany(c, e.target.value)} className={`${field} w-44 max-w-full`} />
              </li>
            ))}
          </ul>
        )}
        <datalist id="mp-companies">{companies.map((c) => <option key={c} value={c} />)}</datalist>
      </div>

      <div className="space-y-1.5">
        <div className="text-[12px] font-semibold text-[var(--color-text-muted)]">Bid manpower per shift, and rate</div>
        <p className="text-[12px] text-[var(--color-text-muted)]">From the contractor&apos;s bid or the AFE. Direct: on the tools. Indirect: supervision, safety, hole and fire watch, QC, tool room. The rate is per man-hour, for time-and-material contracts; leave it blank otherwise.</p>
        <ul className="space-y-2">
          {companies.map((co) => {
            const b = s.bids?.[co] ?? {};
            const box = (v: number | null | undefined, set: (n: number | null) => void, label: string) => (
              <input value={v ?? ""} disabled={ro} inputMode="decimal" aria-label={`${co} ${label}`} placeholder="-" onChange={(e) => set(num(e.target.value))} className={numField} />
            );
            return (
              <li key={co} className="rounded-lg border border-[var(--color-border)] px-3 py-2 space-y-1.5">
                <div className="font-bold text-[13px] text-[var(--color-text)]">{co}</div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-[var(--color-text-muted)]">
                  {(["day", "night"] as const).map((k) => (
                    <span key={k} className="inline-flex items-center gap-1.5">
                      <span className="w-10">{k === "day" ? "Days" : "Nights"}</span>
                      {box(b[k]?.direct, (n) => setBid(co, (x) => ({ ...x, [k]: { ...(x[k] ?? {}), direct: n } })), `${k} direct`)}
                      <span>direct</span>
                      {box(b[k]?.indirect, (n) => setBid(co, (x) => ({ ...x, [k]: { ...(x[k] ?? {}), indirect: n } })), `${k} indirect`)}
                      <span>indirect</span>
                    </span>
                  ))}
                  <span className="inline-flex items-center gap-1.5">$ {box(b.rate, (n) => setBid(co, (x) => ({ ...x, rate: n })), "rate per man-hour")} / man-hour</span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <StaffingPlansPart projectId={projectId} canManage={canManage} userEmail={userEmail} />

      {canManage ? (
        <div className="flex items-center gap-3">
          <button type="button" disabled={!draft || busy} onClick={() => void save()} className={btn}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save</button>
          {msg && <span className={`text-[12px] ${/^Saved/.test(msg) ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-300"}`}>{msg}</span>}
        </div>
      ) : <div className="text-[12px] text-[var(--color-text-muted)]">Only the project owner, a co-owner or an admin can change this.</div>}
    </div>
  );
}

/** Each contractor's staffing plan (planned hands by date, day and night),
 *  read from its spreadsheet: crafts down the side, dates across the top. */
function StaffingPlansPart({ projectId, canManage, userEmail }: { projectId: string; canManage: boolean; userEmail?: string }) {
  const [plans, setPlans] = useState<StaffingPlans | null>(null);
  const [company, setCompany] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    loadNextPlanSettings(projectId).then((s) => { if (live) setPlans(s.staffing); }).catch(() => { if (live) setPlans({}); });
    return () => { live = false; };
  }, [projectId]);
  const read = async (f: File) => {
    const co = company.trim();
    if (!co) { setMsg("Pick whose plan it is first."); return; }
    setBusy(true); setMsg(null);
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array", cellDates: true });
      const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
      const g = parseStaffingGrid(rows as unknown[][]);
      if (!g) { setMsg("That doesn't look like a staffing plan: crafts down the side, dates across the top, a Day and a Night column under each date."); return; }
      const plan = { file: f.name, at: new Date().toISOString(), by: userEmail ?? null, shifts: g.shifts, phases: g.phases };
      await saveStaffingPlan(projectId, co, plan);
      setPlans((p) => ({ ...(p ?? {}), [co]: plan }));
      setMsg(`Read for ${co}: ${g.crafts.length} crafts, ${g.from} to ${g.to}.`);
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async (co: string) => {
    setBusy(true); setMsg(null);
    try { await saveStaffingPlan(projectId, co, null); setPlans((p) => { const n = { ...(p ?? {}) }; delete n[co]; return n; }); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };
  const list = Object.entries(plans ?? {});
  return (
    <div className="space-y-1.5" data-staffing-plans>
      <div className="text-[12px] font-semibold text-[var(--color-text-muted)]">Staffing plans</div>
      <p className="text-[12px] text-[var(--color-text-muted)]">The contractor&apos;s spreadsheet of planned hands by date, day and night. Each shift&apos;s head count is held to it.</p>
      {plans == null ? <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Reading…</div>
        : list.length === 0 ? <div className="text-[12.5px] text-[var(--color-text-muted)]">None read yet.</div>
          : <ul className="rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
            {list.map(([co, sp]) => (
              <li key={co} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[12.5px]">
                <span className="flex-1 min-w-[10rem]"><b>{co}</b> <span className="text-[var(--color-text-muted)]">{sp.file}</span></span>
                {canManage && <button type="button" disabled={busy} onClick={() => void remove(co)} className="text-[12px] font-bold underline text-[var(--color-text-muted)] hover:text-rose-700">Remove</button>}
              </li>
            ))}
          </ul>}
      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <input value={company} onChange={(e) => setCompany(e.target.value)} list="mp-companies" placeholder="Whose plan (company)" aria-label="Whose staffing plan" className={`${field} w-48 max-w-full`} />
          <label className={`inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[12.5px] font-bold px-3 py-2 cursor-pointer hover:bg-[var(--color-surface-2)] ${busy ? "opacity-50 pointer-events-none" : ""}`}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Read a staffing plan (Excel)
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void read(f); }} />
          </label>
        </div>
      )}
      {msg && <div role="status" className="text-[12px] text-[var(--color-text)]">{msg}</div>}
    </div>
  );
}
