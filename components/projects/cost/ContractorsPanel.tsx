"use client";

// Costs › Contractors: one page per contractor, everything about what it
// was hired to send and what it sent: its company and quote on the Costs
// tab, its crews on the schedule, its staffing plan (read from its sheet
// or typed in), its rate sheet, and every shift: the plan's heads, the
// heads counted at the meeting, what they cost at the rates, overtime, and
// where the cost is heading against the quote and the budget line.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronRight, Download, FileUp, HardHat, Loader2, Plus, Trash2, X } from "lucide-react";
import { saveFile } from "@/lib/saveFile";
import { openContractor } from "@/lib/costsNav";
import { supabase } from "@/lib/supabase";
import { activeOnly } from "@/lib/activeMilestones";
import { loadShiftRecords, type ShiftRecord } from "@/lib/shiftRecord";
import { companyOf, countOf, shiftCounts } from "@/lib/manpower";
import { shiftWindow, type ShiftKind } from "@/lib/shiftReport";
import { useShiftTimes } from "@/lib/shiftTimesStore";
import { saveStaffingPlan } from "@/lib/nextPlanStore";
import { mergePlan, withoutRange, sourcesOf, planSpan, bandTarget, COMMON_CRAFTS, fillRange, nextDay, parseStaffingGrid, planFromGrid, setShiftHeads, type PlanCraft, type PlanGrid, type StaffingPlan } from "@/lib/staffingPlan";
import { headCost, matchCraft, paidHoursOf, parseRateGrid, rateOf, RULES, type RateSheet } from "@/lib/rateSheet";
import { crewShifts, crewSummary, type CrewShiftRow, type CrewSummary } from "@/lib/crewCost";
import { contractorList, loadCrewSettings, saveContractorLink, saveCrewCompany, saveRateSheet, type Contractor, type CrewSettings } from "@/lib/crewSettings";
import { saveParty, type CostAccount, type CostEntry, type CostParty } from "@/lib/costs";
import { lineOfDoc, type CostDocument } from "@/lib/costDocs";
import type { ProjectPhase } from "@/lib/projectPhases";
import { appConfirm } from "@/components/providers/DialogProvider";
import { invalidateCrewSettings } from "@/lib/useCrewSettings";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { SubTabs } from "@/components/projects/SubTabs";
import FileThumb from "@/components/ui/FileThumb";
import { useFileDrag } from "@/hooks/useFileDrag";
import { tryUpload } from "@/lib/uploadRetry";
import { fileSize } from "@/components/projects/cost/FilePreview";
import { sayError } from "@/components/projects/sayError";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { MoreDetails } from "@/components/ui/MoreDetails";
import { AnswerLine, answerButton } from "@/components/projects/cost/Answer";

const btn = "inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] whitespace-nowrap disabled:opacity-50 transition-colors";
const pri = "inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-body font-medium hover:bg-[var(--color-accent-hover)] whitespace-nowrap disabled:opacity-50 transition-colors";
const field = "rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] px-2.5 h-9 pointer-coarse:h-11 text-body text-[var(--color-text)] placeholder:text-[var(--color-text-faint)]";
const label = "text-body font-medium text-[var(--color-text)]";
const card = "rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] p-4 sm:p-5";
/** An error said plainly where it happened. */
const Err = ({ children }: { children: React.ReactNode }) => <ErrorNote compact title={children} next="" />;

/** A sheet to read (Excel or CSV): drop it on the button or pick it. */
function SheetPick({ label: text, cls, disabled, onFile }: { label: React.ReactNode; cls: string; disabled?: boolean; onFile: (f: File) => void }) {
  const drag = useFileDrag((fs) => onFile(fs[0]), disabled);
  return (
    <label {...drag.bind} className={`${cls} cursor-pointer ${drag.ring}`}>
      <FileUp className="w-4 h-4" /> {drag.over ? drag.say : text}
      <input type="file" accept=".xlsx,.xls,.csv" className="sr-only" disabled={disabled} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onFile(f); }} />
    </label>
  );
}

/** The sheet picked: what it is, and Try again when it couldn't be read. */
function PickedSheet({ file, failed, onRetry }: { file: File; failed?: boolean; onRetry?: () => void }) {
  return (
    <div className="flex items-center gap-2 text-caption">
      <FileThumb file={file} size={28} />
      <span className="min-w-0 flex-1 truncate text-[var(--color-text)]">{file.name} <span className="text-[var(--color-text-muted)]">· {fileSize(file.size)}</span></span>
      {failed && onRetry && <button type="button" onClick={onRetry} className={btn}>Try again</button>}
    </div>
  );
}
const money = (n: number | null | undefined) => (n == null ? "-" : `$${Math.round(n).toLocaleString("en-US")}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "Mon 10/26 day" from "2026-10-26:day". */
export function shiftLabel(key: string, short = false): string {
  const [day, kind] = key.split(":");
  const d = new Date(`${day}T12:00:00Z`);
  const w = d.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric", timeZone: "UTC" });
  return short ? `${w.replace(/^\w+, /, "")} ${kind === "night" ? "N" : "D"}` : `${w} ${kind}`;
}
const dayLabel = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export interface ContractorsProps {
  orgId: string; projectId: string; canManage: boolean;
  actor: { uid: string; email: string | null };
  tz: string;
  phases: ProjectPhase[]; phase: string | null;
  parties: CostParty[]; accounts: CostAccount[]; entries: CostEntry[]; docs: CostDocument[];
  onPartiesChanged: () => void;
  onQuotes: () => void;
  /** Costs › Budget's company list, to add a company not on the schedule. */
  onAddCompany?: () => void;
  /** A contractor's page to open on (asked for from elsewhere). */
  initial?: string | null;
  /** Setup › Staffing plans: each contractor's crews and staffing plan only
   *  (rates, quote and cost stay on Costs › Contractors). */
  mode?: "staffing";
}

/** What a contractor has in, and its numbers over the shifts in view. */
interface Crew {
  c: Contractor;
  plan: StaffingPlan | null;
  sheet: RateSheet | null;
  quote: CostDocument | null;
  line: CostAccount | null;
  rows: CrewShiftRow[];
  sum: CrewSummary;
}

export default function ContractorsPanel(p: ContractorsProps) {
  const times = useShiftTimes(p.projectId);
  const [settings, setSettings] = useState<CrewSettings | null>(null);
  const [crews, setCrews] = useState<string[]>([]);
  const [work, setWork] = useState<Map<string, number>>(new Map());
  const [records, setRecords] = useState<Map<string, ShiftRecord>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(p.initial ?? null);
  // Setup has no phase picker: the staffing step keeps its own.
  const [ownPhase, setOwnPhase] = useState<string | null>(null);
  const phaseId = p.mode === "staffing" ? ownPhase : p.phase;
  const [now] = useState(() => Date.now());

  const [tick, setTick] = useState(0);
  const load = useCallback(async () => { setTick((t) => t + 1); }, []);
  useEffect(() => {
    let live = true;
    void Promise.all([
      loadCrewSettings(p.projectId),
      activeOnly((a) => { const q = supabase.from("milestones").select("responsible_party").eq("project_id", p.projectId); return a ? q.is("cancelled_at", null) : q; }),
      loadShiftRecords(p.projectId).catch(() => new Map<string, ShiftRecord>()),
    ]).then(([s, ms, recs]) => {
      if (!live) return;
      setSettings(s);
      const names = ((ms.data ?? []) as Array<{ responsible_party: string | null }>).map((m) => m.responsible_party?.trim() ?? "").filter(Boolean);
      const n = new Map<string, number>(); for (const c of names) n.set(c, (n.get(c) ?? 0) + 1);
      setCrews([...n.keys()].sort()); setWork(n);
      setRecords(recs);
    }, (e: Error) => { if (live) setErr(sayError(e)); });
    return () => { live = false; };
  }, [p.projectId, tick]);

  const scope = phaseId ? p.phases.find((x) => x.id === phaseId) ?? null : null;
  const inScope = useCallback((key: string) => { const d = key.split(":")[0]; return !scope || ((!scope.start || d >= scope.start) && (!scope.end || d <= scope.end)); }, [scope]);

  const list: Crew[] = useMemo(() => {
    if (!settings) return [];
    const of = (crew: string) => companyOf(crew, settings.manpower);
    return contractorList(crews, p.parties, settings).map((c) => {
      const plan = settings.staffing[c.company] ?? null, sheet = settings.rateSheets[c.company] ?? null;
      // The shifts in view: the plan's, and any this contractor was counted or held over on.
      const keys = new Set(Object.keys(plan?.shifts ?? {}));
      for (const [k, r] of records) {
        if (Object.entries(r.crews ?? {}).some(([crew, cc]) => of(crew) === c.company && countOf(cc).total != null)) keys.add(k);
        if ((r.holdOver ?? []).some((h) => h.crew && of(h.crew) === c.company)) keys.add(k);
      }
      const ordered = [...keys].filter((k) => /^\d{4}-\d{2}-\d{2}:(day|night)$/.test(k) && inScope(k)).sort();
      const windows = ordered.map((k) => { const [day, kind] = k.split(":"); return shiftWindow(day, kind as ShiftKind, p.tz, times); });
      const counts = shiftCounts(records, windows, settings.manpower);
      const holds = new Map(ordered.map((k) => [k, records.get(k)?.holdOver ?? []]));
      const rows = crewShifts({ company: c.company, plan, sheet, counts, holds, companyOf: of, now });
      const quotes = c.party ? p.docs.filter((d) => d.kind === "quote" && d.partyId === c.party!.id && d.status !== "void") : [];
      const quote = quotes.find((d) => d.status === "awarded") ?? null;
      const lineId = settings.contractors[c.company]?.lineId ?? (quote ? lineOfDoc(quote, p.entries) : null);
      return { c, plan, sheet, quote, line: p.accounts.find((a) => a.id === lineId) ?? null, rows, sum: crewSummary(rows, { plan, sheet }) };
    }).sort((a, b) => b.c.crews.reduce((n, x) => n + (work.get(x) ?? 0), 0) - a.c.crews.reduce((n, x) => n + (work.get(x) ?? 0), 0) || a.c.company.localeCompare(b.c.company));
  }, [settings, crews, work, records, p.parties, p.docs, p.entries, p.accounts, p.tz, times, now, inScope]);

  if (!settings) return err ? <ErrorNote title="Couldn't load the contractors." next={err} onRetry={() => void load()} /> : <SkeletonRows rows={4} cols={2} what="contractors" />;
  const cur = open ? list.find((x) => x.c.company === open) ?? null : null;
  const setS = (f: (s: CrewSettings) => CrewSettings) => setSettings((s) => (s ? f(s) : s));
  const phasePills = p.mode === "staffing" && p.phases.length > 1 ? (
    <SubTabs label="Phase" value={phaseId ?? "__all"} onChange={(id) => setOwnPhase(id === "__all" ? null : id)} className="border-b border-[var(--color-border)]"
      items={[{ id: "__all", label: "Whole project" }, ...p.phases.map((x) => ({ id: x.id, label: x.name }))]} />
  ) : null;
  if (cur) return <><div className={phasePills ? "mb-3" : ""}>{phasePills}</div><ContractorPage {...p} x={cur} scope={scope} settings={settings} allCrews={crews} setSettings={setS} onBack={() => setOpen(null)} reload={load} paidShift={(c) => paidHoursOf(c, shiftHoursOf(times))} /></>;

  if (p.mode === "staffing") return (
    <div className="space-y-3" data-staffing-setup>
      {err && <Err>{err}</Err>}
      <p className="text-body text-[var(--color-text-muted)]">{(() => { const n = list.filter((x) => !x.plan).length; return list.length ? (n ? `${plural(n, "contractor")} still without a staffing plan.` : "Every contractor has a staffing plan.") : ""; })()}</p>
      {list.length === 0 ? <p className="text-body text-[var(--color-text-muted)]">No contractor crews on the schedule yet.</p> : (
        <ul className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)]">
          {list.map((x) => {
            const days = x.plan ? Object.keys(x.plan.shifts).map((k) => k.split(":")[0]).sort() : [];
            return (
              <li key={x.c.company} className="flex items-center gap-3 px-3 py-2.5" data-contractor={x.c.company}>
                <span aria-label={x.plan ? "Staffing plan in" : "No staffing plan yet"} className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: x.plan ? "var(--state-released)" : "var(--state-held)" }} />
                <span className="min-w-0 flex-1">
                  <b className="block text-body text-[var(--color-text)]">{x.c.company}</b>
                  <span className="block text-caption text-[var(--color-text-muted)]">{x.plan ? `${days.length ? `${shortDay(days[0])} to ${shortDay(days[days.length - 1])}` : "No shifts"}` : "No staffing plan yet"}{x.c.crews.length ? ` · crews: ${x.c.crews.join(", ")}` : ""}</span>
                  {p.phases.length > 1 && (
                    <span className="mt-1 flex flex-wrap gap-1.5">
                      {p.phases.map((ph) => {
                        const has = !!x.plan && Object.keys(x.plan.shifts).some((k) => { const d = k.split(":")[0]; return (!ph.start || d >= ph.start) && (!ph.end || d <= ph.end); });
                        const src = x.plan ? sourcesOf(x.plan).find((s2) => (!ph.start || s2.from >= ph.start) && (!ph.end || s2.to <= ph.end)) : null;
                        return (
                          <button key={ph.id} type="button" onClick={() => { setOwnPhase(ph.id); setOpen(x.c.company); }} className={`inline-flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-2 -ml-2 rounded-lg text-body hover:bg-[var(--color-surface-2)] ${has ? "text-[var(--color-text)]" : "font-medium text-[var(--state-held-text)]"}`}>
                            <span aria-hidden className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: has ? "var(--state-released)" : "var(--state-held)" }} />{ph.name}: {has ? (src?.file || "typed in") : p.canManage ? "Upload" : "None"}
                          </button>
                        );
                      })}
                    </span>
                  )}
                </span>
                <button type="button" onClick={() => { setOwnPhase(null); setOpen(x.c.company); }} className={!x.plan && p.canManage && x.c.company === list.find((y) => !y.plan)?.c.company ? pri : btn}>{x.plan ? "Open" : p.canManage ? "Put it in" : "Open"}</button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-caption text-[var(--color-text-muted)]">Kern Energy crews are counted at the meeting but have no staffing plan from a contractor.</p>
    </div>
  );

  // The answer: how many contractors still owe something, the first of
  // them one tap away. Those with something to put in come first.
  const owing = list.filter((x) => stepsOf(x).some((st) => !st.done));
  const ordered = [...owing, ...list.filter((x) => !owing.includes(x))];
  const kernNote = "Kern Energy crews are counted at the meeting but are not billed, so they have no page here.";
  return (
    <div className="space-y-4" data-contractors>
      {err && <Err>{err}</Err>}
      {list.length === 0 ? (
        <AnswerLine action={p.onAddCompany ? <button type="button" onClick={p.onAddCompany} className={answerButton}><Plus className="w-4 h-4" /> Add a company</button> : undefined}>
          No contractor crews on the schedule and none on the Costs tab yet. <HelpTooltip>{kernNote}</HelpTooltip>
        </AnswerLine>
      ) : (
        <AnswerLine value={owing.length ? owing.length : undefined}
          action={owing.length ? <button type="button" onClick={() => setOpen(owing[0].c.company)} className={answerButton}>Open {owing[0].c.company}</button> : undefined}
          sub={scope ? `Showing ${scope.name}.` : undefined}>
          {owing.length
            ? <>of {plural(list.length, "contractor")} {owing.length === 1 ? "has" : "have"} something still to put in.</>
            : <>Everything is in for every contractor ({list.length}).</>}
          {" "}<HelpTooltip>What each contractor should send, and what it sent: its quote and budget line, its staffing plan, its rate sheet, and every shift&apos;s head count. {kernNote}</HelpTooltip>
        </AnswerLine>
      )}
      {list.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {ordered.map((x) => <ContractorCard key={x.c.company} x={x} onOpen={() => setOpen(x.c.company)} />)}
        </div>
      )}
    </div>
  );
}

const shortDay = (d: string) => { const [, m, dd] = d.split("-").map(Number); return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${dd}`; };
const shiftHoursOf = (t: { dayStart: string; nightStart: string }) => {
  const m = (s: string) => { const [h, mi] = s.split(":").map(Number); return h * 60 + (mi || 0); };
  const d = (m(t.nightStart) - m(t.dayStart) + 1440) % 1440;
  return d > 0 ? d / 60 : 12;
};

function stepsOf(x: Crew): Array<{ name: string; done: boolean; says: string }> {
  const crafts = Object.keys(Object.assign({}, ...Object.values(x.plan?.byCraft ?? {})));
  return [
    { name: "Quote and budget line", done: !!x.quote || !!x.line, says: x.quote ? `${money(x.quote.totalAmount)} quote${x.line ? `, ${x.line.name}` : ""}` : x.line ? `${x.line.name}, no quote awarded` : "Not in" },
    { name: "Staffing plan", done: !!x.plan, says: x.plan ? `${planRange(x.plan)}${x.plan.file ? "" : ", typed in"}` : "Not in" },
    { name: "Rate sheet", done: !!x.sheet && x.sum.unpriced.length === 0, says: !x.sheet ? "Not in" : x.sum.unpriced.length ? `${plural(x.sum.unpriced.length, "craft")} with no rate` : `${plural(Object.keys(x.sheet.crafts).length, "craft")} priced` },
    { name: "Every day", done: x.sum.counted > 0, says: x.sum.counted ? `${plural(x.sum.counted, "shift")} counted${x.sum.uncounted ? `, ${x.sum.uncounted} not` : ""}` : crafts.length || x.c.crews.length ? "No head counts yet" : "Nothing to check yet" },
  ];
}
const planRange = (plan: StaffingPlan) => { const ks = Object.keys(plan.shifts).sort(); return ks.length ? `${dayLabel(ks[0].split(":")[0])} to ${dayLabel(ks[ks.length - 1].split(":")[0])}` : "No shifts"; };

function ContractorCard({ x, onOpen }: { x: Crew; onOpen: () => void }) {
  const steps = stepsOf(x);
  const left = steps.filter((s) => !s.done).length;
  return (
    <button type="button" onClick={onOpen} className={`${card} text-left hover:border-[var(--color-main)] transition-colors flex flex-col gap-2.5 ${left ? "" : "bg-[var(--color-surface-2)]/40"}`} data-contractor={x.c.company}>
      <span className="flex items-center gap-2">
        <HardHat className="w-4 h-4 text-[var(--color-text-muted)]" />
        <b className="min-w-0 flex-1 text-reading text-[var(--color-text)] truncate">{x.c.company}</b>
        <span className={`inline-flex items-center gap-1.5 text-body whitespace-nowrap ${left ? "font-medium text-[var(--state-held-text)]" : "text-[var(--color-text)]"}`}><span aria-hidden className="w-[7px] h-[7px] rounded-full" style={{ background: left ? "var(--state-held)" : "var(--state-released)" }} />{left ? `${left} to put in` : "All in"}</span>
      </span>
      <span className="text-caption text-[var(--color-text-muted)]">{x.c.crews.length ? `Crews: ${x.c.crews.join(", ")}` : "No crews on the schedule"}</span>
      <ol className="space-y-1">
        {steps.map((s) => (
          <li key={s.name} className="flex items-center gap-2 text-caption">
            <span aria-label={s.done ? "Done" : "To do"} className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: s.done ? "var(--state-released)" : "var(--color-border-strong)" }} />
            <span className="font-medium text-[var(--color-text)]">{s.name}</span>
            <span className="min-w-0 truncate text-[var(--color-text-muted)]">{s.says}</span>
          </li>
        ))}
      </ol>
      {x.sum.forecast != null && <span className="text-caption text-[var(--color-text)]"><b>{x.sum.counted ? "Forecast" : "Plan"} {money(x.sum.forecast)}</b>{x.line ? ` of the ${x.line.name} line, ${money(x.line.budget)}` : ""}</span>}
      <span className="mt-auto inline-flex items-center gap-1 text-caption font-medium text-[var(--color-text)]">Open <ChevronRight className="w-3.5 h-3.5" /></span>
    </button>
  );
}

// ─── One contractor ────────────────────────────────────────────────

function ContractorPage(p: ContractorsProps & {
  x: Crew; scope: ProjectPhase | null; settings: CrewSettings; allCrews: string[];
  setSettings: (f: (s: CrewSettings) => CrewSettings) => void; onBack: () => void; reload: () => Promise<void>;
  paidShift: (s: RateSheet | null) => number;
}) {
  const { x } = p;
  const co = x.c.company;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (key: string, f: () => Promise<void>) => { setBusy(key); setErr(null); try { await f(); invalidateCrewSettings(p.projectId); } catch (e) { setErr(sayError(e)); } finally { setBusy(null); } };
  const steps = stepsOf(x);
  const go = (id: string) => document.querySelector(`[data-section="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="space-y-4" data-contractor-page={co}>
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={p.onBack} className={btn}><ArrowLeft className="w-4 h-4" /> {p.mode === "staffing" ? "Staffing plans" : "Contractors"}</button>
        <h3 className="min-w-0 flex-1 text-reading font-medium text-[var(--color-text)] truncate">{co}</h3>
      </div>
      {err && <Err>{err}</Err>}

      {p.mode === "staffing" ? (
        <>
          <CrewsSection {...p} co={co} busy={busy} act={act} />
          <PlanSection {...p} co={co} busy={busy} act={act} />
          <p className="text-caption text-[var(--color-text-muted)]">The same plan shows on {co}&apos;s page in Costs › Contractors, with its rate sheet, quote and every shift&apos;s cost. <button type="button" onClick={() => openContractor(co)} className="text-[var(--color-accent-text)] hover:underline cursor-pointer">Open it there</button></p>
        </>
      ) : (<>
      <Answer x={x} scope={p.scope} />

      <nav className="flex flex-wrap gap-1.5" aria-label="Sections">
        {steps.map((s, i) => (
          <button key={s.name} type="button" onClick={() => go(["money", "plan", "rates", "daily"][i])} className={`shrink-0 inline-flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-2 rounded-lg text-body hover:bg-[var(--color-surface-2)] ${s.done ? "text-[var(--color-text)]" : "font-medium text-[var(--state-held-text)]"}`}>
            <span aria-hidden className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: s.done ? "var(--state-released)" : "var(--state-held)" }} />{s.name}
          </button>
        ))}
      </nav>

      <MoneySection {...p} co={co} busy={busy} act={act} />
      <CrewsSection {...p} co={co} busy={busy} act={act} />
      <PlanSection {...p} co={co} busy={busy} act={act} />
      <RatesSection {...p} co={co} busy={busy} act={act} />
      <DailySection x={x} scope={p.scope} />
      </>)}
    </div>
  );
}

/** The answer, before any input: what was paid for what, against the plan and the money. */
function Answer({ x, scope }: { x: Crew; scope: ProjectPhase | null }) {
  const s = x.sum;
  const where = scope ? scope.name : "This project";
  const p2 = scope ? scope.name : null;
  if (!x.plan && !x.sheet && !s.counted) return null;
  const lastCounted = [...x.rows].reverse().find((r) => r.counted != null);
  return (
    <section className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-4 sm:p-5" data-crew-answer>
      {s.paidToDate != null && s.counted ? (
        <AnswerLine value={money(s.paidToDate)}>
          paid (estimate) through {shiftLabel(lastCounted!.key)} for {plural(s.countedHeads, "head")}; the plan was {money(s.planOnCounted)}{s.plannedOnCounted ? ` for ${s.plannedOnCounted}` : ""}.
        </AnswerLine>
      ) : s.planTotal != null ? (
        <AnswerLine value={money(s.planTotal)}>for {x.c.company}&apos;s plan{p2 ? ` in ${p2}` : ""}.</AnswerLine>
      ) : s.counted ? (
        <AnswerLine value={s.countedHeads}>
          head{s.countedHeads === 1 ? "" : "s"} counted on {plural(s.counted, "shift")}; the plan had {s.plannedOnCounted}.{x.sheet ? "" : " Add the rate sheet to see what they cost."}
        </AnswerLine>
      ) : (
        <AnswerLine>No head counts yet.{x.sheet ? "" : " Add the rate sheet to see what they cost."}</AnswerLine>
      )}
      {(() => {
        const parts = [s.counted && x.plan ? (s.short ? `${plural(s.short, "shift")} came in short of the plan` : "No shift came in short of the plan") : "",
          s.overtime ? `overtime added ${money(s.overtime)}` : "",
          s.counted && s.forecast != null ? `${where} forecast ${money(s.forecast)}${s.planTotal != null ? ` against a plan of ${money(s.planTotal)}` : ""}` : ""].filter(Boolean);
        const money2 = [x.quote ? `Quote ${money(x.quote.totalAmount)}` : "", x.line ? `${x.line.name} line ${money(x.line.budget)}` : ""].filter(Boolean).join(", ");
        const text = [parts.join("; "), money2].filter(Boolean).join(". ");
        return text ? <p className="mt-2 text-body text-[var(--color-text-muted)]">{text}.</p> : null;
      })()}
      {s.uncounted > 0 && <p className="mt-1 text-caption font-medium text-[var(--state-held-text)]">{s.uncounted === 1 ? "1 shift that has started is not counted yet. It is priced at the plan until it is." : `${s.uncounted} shifts that have started are not counted yet. They are priced at the plan until they are.`} Count them at Shift › Meeting.</p>}
      {s.unpriced.length > 0 && <p className="mt-1 text-caption font-medium text-[var(--state-held-text)]">No rate for {s.unpriced.join(", ")}: left out of every cost until it has one.</p>}
    </section>
  );
}

type SectionProps = ContractorsProps & { x: Crew; co: string; settings: CrewSettings; allCrews: string[]; setSettings: (f: (s: CrewSettings) => CrewSettings) => void; busy: string | null; act: (k: string, f: () => Promise<void>) => Promise<void>; scope: ProjectPhase | null; reload: () => Promise<void>; paidShift: (s: RateSheet | null) => number };

function Section({ id, title, done, sub, help, children }: { id: string; title: string; done: boolean; sub?: string; help?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={`${card} space-y-3 scroll-mt-4`} data-section={id}>
      <div className="flex items-start gap-2">
        <span aria-label={done ? "Done" : "To do"} className="mt-[9px] w-[7px] h-[7px] rounded-full shrink-0" style={{ background: done ? "var(--state-released)" : "var(--state-held)" }} />
        <div className="min-w-0 flex-1">
          <h4 className="flex items-center gap-1.5 text-reading font-medium text-[var(--color-text)]">{title}{help && <HelpTooltip>{help}</HelpTooltip>}</h4>
          {sub && <p className="text-body text-[var(--color-text-muted)]">{sub}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

// ─── Company, quote and budget line ────────────────────────────────

function MoneySection(p: SectionProps) {
  const { x, co } = p;
  const link = p.settings.contractors[co] ?? {};
  const [pick, setPick] = useState("");
  const addParty = () => p.act("party", async () => {
    const r = await saveParty({ orgId: p.orgId, projectId: p.projectId, patch: { name: co, kind: "contractor" }, actor: p.actor });
    if (!r.ok || !r.id) throw new Error(r.error ?? "Couldn't add it to the Costs tab.");
    await saveContractorLink(p.projectId, co, { partyId: r.id });
    p.setSettings((s) => ({ ...s, contractors: { ...s.contractors, [co]: { ...s.contractors[co], partyId: r.id } } }));
    p.onPartiesChanged();
  });
  const linkParty = (id: string) => p.act("party", async () => {
    await saveContractorLink(p.projectId, co, { partyId: id || null });
    p.setSettings((s) => ({ ...s, contractors: { ...s.contractors, [co]: { ...s.contractors[co], partyId: id || null } } }));
  });
  const setLine = (id: string) => p.act("line", async () => {
    await saveContractorLink(p.projectId, co, { lineId: id || null });
    p.setSettings((s) => ({ ...s, contractors: { ...s.contractors, [co]: { ...s.contractors[co], lineId: id || null } } }));
  });
  const quotes = x.c.party ? p.docs.filter((d) => d.kind === "quote" && d.partyId === x.c.party!.id && d.status !== "void") : [];
  return (
    <Section id="money" title="Quote and budget line" done={!!x.quote || !!x.line} help="What it was hired for, and the budget line its cost comes out of.">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <span className={label}>Company on the Costs tab</span>
          {x.c.party ? <div className="text-body font-medium text-[var(--color-text)]">{x.c.party.name}{link.partyId && p.canManage && <button type="button" onClick={() => void linkParty("")} className="ml-2 inline-flex items-center justify-center gap-1.5 h-8 pointer-coarse:h-11 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">Change</button>}</div>
            : p.canManage ? (
              <div className="flex gap-1.5 flex-wrap">
                {p.parties.length > 0 && <select aria-label="Company on the Costs tab" value={pick} onChange={(e) => { setPick(e.target.value); if (e.target.value) void linkParty(e.target.value); }} className={`${field} min-w-0 flex-1`}><option value="">Pick one</option>{p.parties.filter((y) => y.status !== "inactive").map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}</select>}
                <button type="button" disabled={!!p.busy} onClick={() => void addParty()} className={btn}>{p.busy === "party" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add {co}</button>
              </div>
            ) : <div className="text-body text-[var(--color-text-muted)]">Not on the Costs tab</div>}
        </div>
        <div className="space-y-1">
          <span className={label}>Quote</span>
          {x.quote ? <div className="text-body text-[var(--color-text)]"><b>{money(x.quote.totalAmount)}</b> awarded{x.quote.fileName ? `, ${x.quote.fileName}` : ""}</div>
            : <div className="text-body text-[var(--color-text-muted)]">{quotes.length ? `${plural(quotes.length, "quote")} in, none awarded.` : "None awarded."} <button type="button" onClick={p.onQuotes} className="text-[var(--color-accent-text)] hover:underline">{quotes.length ? "Award one in Quotes" : "Add it in Quotes"}</button></div>}
        </div>
        <div className="space-y-1">
          <span className={label}>Budget line</span>
          {p.canManage ? (
            <select aria-label="Budget line" value={x.line?.id ?? ""} disabled={!!p.busy} onChange={(e) => void setLine(e.target.value)} className={`${field} w-full`}>
              <option value="">Pick the line it comes out of</option>
              {p.accounts.filter((a) => a.status !== "closed").map((a) => <option key={a.id} value={a.id}>{a.name} ({money(a.budget)})</option>)}
            </select>
          ) : <div className="text-body text-[var(--color-text)]">{x.line ? `${x.line.name} (${money(x.line.budget)})` : "Not picked"}</div>}
        </div>
      </div>
    </Section>
  );
}

// ─── Crews on the schedule ─────────────────────────────────────────

function CrewsSection(p: SectionProps) {
  const { x, co } = p;
  const others = p.allCrews.filter((c) => !x.c.crews.includes(c));
  const assign = (crew: string, to: string) => p.act(`crew:${crew}`, async () => {
    await saveCrewCompany(p.projectId, crew, to);
    p.setSettings((s) => { const of = { ...(s.manpower.companyOf ?? {}) }; if (to) of[crew] = to; else delete of[crew]; return { ...s, manpower: { ...s.manpower, companyOf: of } }; });
  });
  if (!x.c.crews.length && !others.length) return null;
  return (
    <section className={`${card} space-y-2`} data-section="crews">
      <h4 className="flex items-center gap-1.5 text-body font-medium text-[var(--color-text)]">Its crews on the schedule <HelpTooltip>Their head counts at the meeting are {co}&rsquo;s.</HelpTooltip></h4>
      <div className="flex gap-1.5 flex-wrap items-center">
        {x.c.crews.map((c) => (
          <span key={c} className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border-strong)] px-2.5 py-1 text-body text-[var(--color-text)]">{c}
            {p.canManage && p.settings.manpower.companyOf?.[c] === co && <button type="button" aria-label={`Take ${c} off ${co}`} onClick={() => void assign(c, "")} className="ui-hit text-[var(--color-text-muted)] hover:text-[var(--state-overdue-text)]"><X className="w-3.5 h-3.5" /></button>}
          </span>
        ))}
        {p.canManage && others.length > 0 && (
          <select aria-label={`Add a crew to ${co}`} value="" onChange={(e) => e.target.value && void assign(e.target.value, co)} className={`${field} h-8 pointer-coarse:h-11 text-caption`}>
            <option value="">+ A crew of {co}&rsquo;s</option>
            {others.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
      </div>
    </section>
  );
}

// ─── Staffing plan ─────────────────────────────────────────────────

function PlanSection(p: SectionProps) {
  const { x, co } = p;
  const saved = x.plan;
  const [draft, setDraft] = useState<StaffingPlan | null>(null);
  const [read, setRead] = useState<{ g: PlanGrid; file: string; keep: Record<string, boolean>; direct: Record<string, boolean> } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // The sheet picked, and whether it couldn't be read (Try again keeps it).
  const [sheetFile, setSheetFile] = useState<{ file: File; failed: boolean } | null>(null);
  const plan = draft ?? saved;
  const blank = (): StaffingPlan => ({ file: "", at: new Date().toISOString(), by: p.actor.email, shifts: {}, crafts: [], byCraft: {} });

  // The plan as a sheet laid out like a contractor's: crafts down, each
  // date's day and night across, heads in the cells, totals at the foot.
  const download = async () => {
    if (!saved) return;
    const XLSX = await import("xlsx");
    const crafts = saved.crafts ?? [];
    const inScope = (k: string) => { const d = k.split(":")[0]; return !p.scope || ((!p.scope.start || d >= p.scope.start) && (!p.scope.end || d <= p.scope.end)); };
    const keys = [...new Set([...Object.keys(saved.byCraft ?? {}), ...Object.keys(saved.shifts)])].filter(inScope).sort();
    const label = (k: string) => { const [d, kind] = k.split(":"); const [, m, dd] = d.split("-").map(Number); return `${m}/${dd} ${kind === "night" ? "Night" : "Day"}`; };
    const rows: Array<Array<string | number>> = [[`${co} staffing plan`], [p.scope ? `${p.scope.name}` : "Whole project"], [], ["Craft", "On the tools", ...keys.map(label)]];
    for (const c of crafts) rows.push([c.name, c.direct ? "Yes" : "No", ...keys.map((k) => saved.byCraft?.[k]?.[c.name] ?? "")]);
    rows.push(["On the tools", "", ...keys.map((k) => saved.shifts[k]?.direct ?? 0)]);
    rows.push(["Supervision and support", "", ...keys.map((k) => saved.shifts[k]?.indirect ?? 0)]);
    rows.push(["Total", "", ...keys.map((k) => (saved.shifts[k]?.direct ?? 0) + (saved.shifts[k]?.indirect ?? 0))]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 34 }, { wch: 12 }, ...keys.map(() => ({ wch: 10 }))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Staffing plan");
    const data = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const ok = await saveFile(new Uint8Array(data), `${co} staffing plan${p.scope ? ` ${p.scope.name}` : ""}.xlsx`.replace(/[\\/:*?"<>|]+/g, " "), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    setMsg(ok ? null : "Tap Download again to save the file.");
  };

  const readFile = async (f: File) => {
    setMsg(null); setSheetFile({ file: f, failed: false });
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array", cellDates: true });
      const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
      const g = parseStaffingGrid(rows as unknown[][]);
      if (!g) { setSheetFile(null); setMsg("That doesn't look like a staffing plan: crafts down the side, dates across the top, a Day and a Night column under each date."); return; }
      const keep = Object.fromEntries(g.bands.map((b) => { const t = bandTarget(b, p.phases, scopeSpan(p)); return [b.name, p.scope ? t === p.scope.id || (t === "project" && p.phases.length <= 1) : t != null]; }));
      setRead({ g, file: f.name, keep, direct: Object.fromEntries(g.crafts.map((c) => [c.name, c.direct])) });
    } catch (e) { setSheetFile({ file: f, failed: true }); setMsg(sayError(e)); }
  };
  const range = p.scope ? { from: p.scope.start ?? null, to: p.scope.end ?? null } : null;
  const saveRead = () => read && p.act("plan", async () => {
    const picked = planFromGrid(read.g, (b) => !!read.keep[b.name], { file: read.file, at: new Date().toISOString(), by: p.actor.email }, read.direct);
    const span = range ?? planSpan(picked);
    const over = saved && span ? sourcesOf(saved).filter((x) => !(x.to < (span.from ?? "") || x.from > (span.to ?? "9999"))) : [];
    if (over.length && !(await appConfirm({ title: `Replace ${co}'s plan for ${p.scope ? p.scope.name : `${dayLabel(span!.from ?? "")} to ${dayLabel(span!.to ?? "")}`}?`, message: `What is in for those dates (${over.map((x) => x.file || "typed in").join(", ")}) is replaced by ${read.file}. Every other date stays as it is.`, confirmLabel: "Replace those dates" }))) return;
    const next = mergePlan(saved, picked, range);
    const kept = () => { p.setSettings((s) => ({ ...s, staffing: { ...s.staffing, [co]: next } })); setRead(null); setDraft(null); setSheetFile(null); };
    // Saving the plan read from the sheet: Try again saves it the same way.
    await tryUpload(read.file, () => saveStaffingPlan(p.projectId, co, next), { onRetried: kept });
    kept();
  });
  const saveDraft = () => draft && p.act("plan", async () => {
    await saveStaffingPlan(p.projectId, co, Object.keys(draft.shifts).length ? draft : null);
    p.setSettings((s) => { const st = { ...s.staffing }; if (Object.keys(draft.shifts).length) st[co] = draft; else delete st[co]; return { ...s, staffing: st }; });
    setDraft(null);
  });
  const remove = () => p.act("plan", async () => {
    if (!saved) return;
    if (!(await appConfirm({ title: p.scope ? `Remove ${co}'s plan for ${p.scope.name}?` : `Remove ${co}'s staffing plan?`, message: p.scope ? "Only that phase's dates are taken out; the rest of its plan stays. Head counts stay." : "Head counts stay; they are no longer held to a plan.", confirmLabel: "Remove plan", tone: "danger" }))) return;
    const next = range ? withoutRange(saved, range) : null;
    await saveStaffingPlan(p.projectId, co, next);
    p.setSettings((s) => { const st = { ...s.staffing }; if (next) st[co] = next; else delete st[co]; return { ...s, staffing: st }; });
  });

  // A stretch of dates named for the phase it falls in.
  const phaseOf = (x: { from: string; to: string }) => p.phases.find((ph) => ph.start && ph.end && x.from >= ph.start && x.to <= ph.end)?.name ?? null;
  const inPhase = saved && range ? Object.keys(saved.shifts).some((k) => { const d = k.split(":")[0]; return (!range.from || d >= range.from) && (!range.to || d <= range.to); }) : null;
  const phaseName = (b: PlanGrid["bands"][number]) => { const t = bandTarget(b, p.phases, scopeSpan(p)); return t == null ? "Outside this project's dates" : t === "project" ? "This project's dates" : `${p.phases.find((x) => x.id === t)?.name ?? "A phase"}'s dates`; };

  return (
    <Section id="plan" title={p.scope ? `Staffing plan, ${p.scope.name}` : "Staffing plan"} done={!!saved && (!range || !!inPhase)} help={`How many of each craft ${co} sends each day and night. Upload its sheet or type it in; each phase can have its own.`} sub={saved ? sourcesOf(saved).map((x) => { const ds = Object.keys(saved.shifts).map((k) => k.split(":")[0]).filter((d) => d >= x.from && d <= x.to).sort(); return `${phaseOf(x) ? `${phaseOf(x)}: ` : ""}${x.file || "typed in"}${ds.length ? ` (${dayLabel(ds[0])} to ${dayLabel(ds[ds.length - 1])})` : ""}`; }).join(" · ") : "Not in yet."}>
      {range && saved && !inPhase && <p className="text-caption font-medium text-[var(--state-held-text)]">Nothing in for {p.scope!.name} yet. Upload {co}&apos;s sheet for it; the other phases&apos; plans stay as they are.</p>}
      {sheetFile && <PickedSheet file={sheetFile.file} failed={sheetFile.failed} onRetry={() => void readFile(sheetFile.file)} />}
      {msg && <p className="text-caption font-medium text-[var(--state-held-text)]">{msg}</p>}
      {p.canManage && !read && (
        <div className="flex gap-1.5 flex-wrap">
          <SheetPick cls={saved || draft ? btn : pri} onFile={(f) => void readFile(f)} label={p.scope ? (inPhase ? `Read a new sheet for ${p.scope.name}` : `Upload ${p.scope.name}'s sheet`) : saved ? "Read a sheet (replaces only its dates)" : "Upload its staffing plan"} />
          {!plan && <button type="button" onClick={() => setDraft(blank())} className={btn}><Plus className="w-4 h-4" /> Type it in</button>}
          {saved && !draft && <button type="button" onClick={() => void download()} className={btn}><Download className="w-4 h-4" /> Download (Excel)</button>}
          {saved && !draft && (!range || inPhase) && <button type="button" disabled={!!p.busy} onClick={() => void remove()} className={btn}><Trash2 className="w-4 h-4" /> {p.scope ? `Remove ${p.scope.name}'s plan` : "Remove"}</button>}
        </div>
      )}

      {read && (
        <div className="rounded-xl border-2 border-[var(--color-border-strong)] p-3 space-y-3" data-plan-read>
          <div><b className="text-body text-[var(--color-text)]">Read: {read.file}</b><p className="text-caption text-[var(--color-text-muted)]">Found {plural(read.g.crafts.length, "craft")} with people, {dayLabel(read.g.from)} to {dayLabel(read.g.to)}. Keep the runs of dates for this project.</p></div>
          <ul className="grid gap-2">
            {read.g.bands.map((b) => (
              <li key={b.name} className="flex items-center gap-3 flex-wrap rounded-lg border border-[var(--color-border)] px-3 py-2" data-band={b.name}>
                <label className="inline-flex items-center gap-2 min-w-0 flex-1 basis-56 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4" checked={!!read.keep[b.name]} onChange={(e) => setRead({ ...read, keep: { ...read.keep, [b.name]: e.target.checked } })} />
                  <span className="min-w-0"><b className="block text-body text-[var(--color-text)]">{b.name}</b><span className="block text-caption text-[var(--color-text-muted)]">{dayLabel(b.from)} to {dayLabel(b.to)}, {plural(b.shifts.length, "shift")}, {b.heads} heads</span></span>
                </label>
                <span className={`text-caption font-medium ${bandTarget(b, p.phases, scopeSpan(p)) ? "text-[var(--state-released-text)]" : "text-[var(--color-text-muted)]"}`}>{phaseName(b)}</span>
              </li>
            ))}
          </ul>
          <div>
            <span className={label}>On the tools or supervision (read from each craft&rsquo;s code; tap to change)</span>
            <div className="mt-1 flex gap-1.5 flex-wrap">
              {read.g.crafts.map((c) => (
                <label key={c.name} className="inline-flex items-center gap-2 min-h-8 pointer-coarse:min-h-11 pr-3 text-body text-[var(--color-text)] cursor-pointer">
                  <input type="checkbox" checked={!!read.direct[c.name]} onChange={() => setRead({ ...read, direct: { ...read.direct, [c.name]: !read.direct[c.name] } })} className="w-4 h-4 accent-[var(--color-current)]" />
                  {c.name} <span className="text-[var(--color-text-muted)]">{read.direct[c.name] ? "on the tools" : "supervision"}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            <button type="button" disabled={!!p.busy || !Object.values(read.keep).some(Boolean)} onClick={() => void saveRead()} className={pri}>{p.busy === "plan" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {p.busy === "plan" ? "Keeping" : "Keep this plan"}</button>
            <button type="button" onClick={() => { setRead(null); setSheetFile(null); }} className={btn}>Cancel</button>
          </div>
        </div>
      )}

      {plan && !read && <PlanGridView {...p} plan={plan} onChange={p.canManage ? (next) => setDraft(next) : null} />}
      {draft && (
        <div className="flex gap-1.5 flex-wrap items-center">
          <button type="button" disabled={!!p.busy} onClick={() => void saveDraft()} className={pri}>{p.busy === "plan" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {p.busy === "plan" ? "Saving" : "Save the plan"}</button>
          <button type="button" onClick={() => setDraft(null)} className={btn}>Cancel</button>
          <span className="text-caption text-[var(--color-text-muted)]">Not saved yet.</span>
        </div>
      )}
    </Section>
  );
}
const scopeSpan = (p: { phases: ProjectPhase[] }) => ({ start: p.phases.map((x) => x.start).filter(Boolean).sort()[0] ?? null, end: p.phases.map((x) => x.end).filter(Boolean).sort().slice(-1)[0] ?? null });

/** The plan as a grid: crafts down the side, the shifts in view across. A
 *  run of days fills in one go; any one shift changes in its cell. */
function PlanGridView(p: SectionProps & { plan: StaffingPlan; onChange: ((next: StaffingPlan) => void) | null }) {
  const { plan } = p;
  const crafts = plan.crafts ?? [];
  const days = useMemo(() => {
    const set = new Set(Object.keys(plan.byCraft ?? plan.shifts).map((k) => k.split(":")[0]));
    if (p.scope?.start && p.scope.end) for (let d = p.scope.start; d <= p.scope.end; d = nextDay(d)) set.add(d);
    return [...set].filter((d) => !p.scope || ((!p.scope.start || d >= p.scope.start) && (!p.scope.end || d <= p.scope.end))).sort();
  }, [plan, p.scope]);
  const keys = days.flatMap((d) => [`${d}:day`, `${d}:night`]);
  const [craft, setCraft] = useState(crafts[0]?.name ?? COMMON_CRAFTS[0].name);
  const [other, setOther] = useState("");
  const [dn, setDn] = useState({ day: "11", night: "0" });
  const [range, setRange] = useState({ from: days[0] ?? "", to: days[days.length - 1] ?? "" });
  const pickList = [...crafts, ...COMMON_CRAFTS.filter((c) => !crafts.some((x) => x.name === c.name))];
  const fill = () => {
    if (!p.onChange || !range.from || !range.to || range.to < range.from) return;
    const name = craft === "__other" ? other.trim() : craft;
    if (!name) return;
    const known = pickList.find((c) => c.name === name);
    const c: PlanCraft = known ?? { name, code: "", direct: !/foreman|super|manager|safety|watch|clerk|qc|quality/i.test(name) };
    p.onChange(fillRange(plan, c, range.from, range.to, Number(dn.day) || 0, Number(dn.night) || 0));
  };
  const set = (c: string, k: string, v: string) => p.onChange?.(setShiftHeads(plan, c, k, Math.max(0, Math.round(Number(v) || 0))));
  const mix = (k: string) => plan.byCraft?.[k] ?? {};
  const box = useRef<HTMLDivElement>(null);
  const first = keys.find((k) => plan.shifts[k]) ?? null;
  useEffect(() => {
    const el = box.current, th = first ? el?.querySelector<HTMLElement>(`[data-key="${first}"]`) : null;
    const pin = el?.querySelector<HTMLElement>("th");
    if (el && th && pin) el.scrollLeft = Math.max(0, th.offsetLeft - pin.offsetWidth);
  }, [first]);
  return (
    <div className="space-y-2">
      {p.onChange && (
        // A craft and its heads a day and a night, filled over the dates in
        // view; other dates are folded (the button says which days it fills).
        <form onSubmit={(e) => { e.preventDefault(); fill(); }} className="space-y-1 rounded-xl border border-dashed border-[var(--color-border-strong)] p-2.5" data-plan-fill aria-label="Fill a craft's heads">
          <div className="flex gap-2 flex-wrap items-end">
            <label className="grid gap-0.5 min-w-0"><span className={label}>Craft</span>
              <select value={craft} onChange={(e) => setCraft(e.target.value)} className={`${field} w-56 max-w-full`}>{pickList.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}<option value="__other">Another craft…</option></select>
            </label>
            {craft === "__other" && <label className="grid gap-0.5"><span className={label}>Its name</span><input value={other} onChange={(e) => setOther(e.target.value)} className={`${field} w-44`} placeholder="Insulator Journeyman" /></label>}
            <label className="grid gap-0.5"><span className={label}>Day heads</span><input inputMode="numeric" value={dn.day} onChange={(e) => setDn({ ...dn, day: e.target.value })} className={`${field} w-20 text-center`} /></label>
            <label className="grid gap-0.5"><span className={label}>Night heads</span><input inputMode="numeric" value={dn.night} onChange={(e) => setDn({ ...dn, night: e.target.value })} className={`${field} w-20 text-center`} /></label>
            <button type="submit" disabled={!range.from || !range.to || range.to < range.from} className={btn}>
              {range.from && range.to ? `Fill ${dayLabel(range.from)} to ${dayLabel(range.to)}` : "Pick the dates to fill"}
            </button>
          </div>
          <MoreDetails label="Other dates" defaultOpen={!range.from || !range.to}>
            <div className="flex gap-2 flex-wrap items-end">
              <label className="grid gap-0.5"><span className={label}>From</span><input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} className={field} /></label>
              <label className="grid gap-0.5"><span className={label}>To</span><input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} className={field} /></label>
            </div>
          </MoreDetails>
        </form>
      )}
      {crafts.length === 0 ? <p className="text-caption text-[var(--color-text-muted)]">Pick a craft and fill its days to start the plan.</p> : (
        <div ref={box} className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
          <table className="text-caption border-collapse min-w-full">
            <thead><tr className="bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">
              <th className="sticky left-0 z-[1] bg-[var(--color-surface-2)] text-left font-medium px-2.5 py-2 min-w-[8rem] sm:min-w-[180px]">Craft</th>
              {keys.map((k) => <th key={k} data-key={k} className={`px-1 py-2 font-medium whitespace-nowrap ${k.endsWith("night") ? "text-[var(--color-text)]" : ""}`}>{shiftLabel(k, true)}</th>)}
            </tr></thead>
            <tbody>
              {crafts.map((c) => (
                <tr key={c.name} className="border-t border-[var(--color-border)]">
                  <td className="sticky left-0 z-[1] bg-[var(--color-surface)] px-2.5 py-1 font-medium leading-tight text-[var(--color-text)] max-w-[9rem] sm:max-w-none sm:whitespace-nowrap">{c.name} <span className="font-normal text-[var(--color-text-muted)]">{c.direct ? "tools" : "supv"}</span></td>
                  {keys.map((k) => {
                    const n = mix(k)[c.name] ?? 0;
                    return <td key={k} className="px-0.5 py-1 text-center">{p.onChange
                      ? <input aria-label={`${c.name}, ${shiftLabel(k)}`} inputMode="numeric" value={n || ""} onChange={(e) => set(c.name, k, e.target.value)} className={`w-10 h-8 pointer-coarse:h-11 rounded-md border text-center tabular-nums ${n ? "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] font-medium" : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-faint)]"}`} />
                      : <span className={`tabular-nums ${n ? "font-bold" : "text-[var(--color-text-faint)]"}`}>{n || "·"}</span>}</td>;
                  })}
                </tr>
              ))}
              <tr className="border-t-2 border-[var(--color-border-strong)] bg-[var(--color-surface-2)] font-medium">
                <td className="sticky left-0 bg-[var(--color-surface-2)] px-2.5 py-1.5 text-[var(--color-text)]">On the tools + supervision</td>
                {keys.map((k) => { const s = plan.shifts[k]; return <td key={k} className="px-1 py-1.5 text-center tabular-nums whitespace-nowrap text-[var(--color-text)]">{s ? `${s.direct}+${s.indirect}` : ""}</td>; })}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Rate sheet ────────────────────────────────────────────────────

function RatesSection(p: SectionProps) {
  const { x, co } = p;
  const saved = x.sheet;
  const planCrafts = useMemo(() => (x.plan?.crafts ?? []).map((c) => c.name), [x.plan]);
  const [draft, setDraft] = useState<RateSheet | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [sheetFile, setSheetFile] = useState<{ file: File; failed: boolean } | null>(null);
  const sheet: RateSheet = draft ?? saved ?? { crafts: {} };
  const crafts = [...new Set([...planCrafts, ...Object.keys(sheet.crafts)])];
  const edit = (f: (s: RateSheet) => RateSheet) => setDraft(f(JSON.parse(JSON.stringify(sheet)) as RateSheet));
  const shiftH = p.paidShift(null);
  const paid = paidHoursOf(sheet, shiftH);
  const numOrNull = (v: string) => { const n = Number(v.replace(/[$,\s]/g, "")); return v.trim() && Number.isFinite(n) && n >= 0 ? n : null; };
  const setRate = (c: string, k: "st" | "ot" | "dt", v: string) => edit((s) => {
    const r = { ...(s.crafts[c] ?? { st: 0 }) };
    const n = numOrNull(v);
    if (k === "st") r.st = n ?? 0; else r[k] = n;
    s.crafts[c] = r;
    if (!(r.st > 0) && r.ot == null && r.dt == null) delete s.crafts[c];
    return s;
  });
  const readFile = async (f: File) => {
    setMsg(null); setSheetFile({ file: f, failed: false });
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
      const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
      const got = parseRateGrid(rows as unknown[][]);
      if (!got) { setSheetFile(null); setMsg("No rates found in that sheet: it needs a row naming Straight time (and Overtime, Double time), with crafts down the side."); return; }
      edit((s) => {
        let pd: number | null = null;
        for (const r of got) {
          const name = matchCraft(r.craft, planCrafts) ?? r.craft;
          s.crafts[name] = { st: r.st, ot: r.ot, dt: r.dt };
          pd = pd ?? r.perDiem;
        }
        if (pd != null && s.perDiem == null) s.perDiem = pd;
        s.file = f.name; s.at = new Date().toISOString(); s.by = p.actor.email;
        return s;
      });
      setMsg(`Read ${plural(got.length, "rate")} from ${f.name}. Check them, then save.`);
    } catch (e) { setSheetFile({ file: f, failed: true }); setMsg(sayError(e)); }
  };
  const save = () => draft && p.act("rates", async () => {
    const kept = () => { p.setSettings((s) => ({ ...s, rateSheets: { ...s.rateSheets, [co]: draft } })); setDraft(null); setMsg(null); setSheetFile(null); };
    await tryUpload(draft.file || `${co} rate sheet`, () => saveRateSheet(p.projectId, co, draft), { onRetried: kept });
    kept();
  });
  const missing = planCrafts.filter((c) => !(sheet.crafts[c]?.st > 0));
  const rule = (k: "paidHours" | "stHours" | "dtAfter" | "perDiem", name: string, ph: string, unit: string) => (
    <label className="grid gap-0.5"><span className={label}>{name}</span>
      <span className="inline-flex items-center gap-1"><input inputMode="decimal" disabled={!p.canManage} value={sheet[k] ?? ""} placeholder={ph} onChange={(e) => edit((s) => ({ ...s, [k]: numOrNull(e.target.value) }))} className={`${field} w-20 text-right tabular-nums`} /><span className="text-caption text-[var(--color-text-muted)]">{unit}</span></span>
    </label>
  );
  const cols = "sm:grid-cols-[minmax(0,1fr)_6.5rem_6.5rem_6.5rem_7.5rem]";
  return (
    <Section id="rates" title="Rate sheet" done={!!saved && missing.length === 0}
      help={<>What {co} charges an hour for each craft. Type it in, or read it from their Excel sheet. For a PDF rate sheet, type the rates in. Overtime and double time left blank are 1.5 and 2 times straight time.</>}
      sub={saved?.file ? `Read from ${saved.file}.` : saved ? "Typed in." : "Not in yet."}>
      {msg && <p className="text-body font-medium text-[var(--color-text)]">{msg}</p>}
      {p.canManage && (
        <div className="flex gap-2 flex-wrap items-center">
          <SheetPick cls={btn} onFile={(f) => void readFile(f)} label="Read their rate sheet" />
        </div>
      )}
      {sheetFile && <PickedSheet file={sheetFile.file} failed={sheetFile.failed} onRetry={() => void readFile(sheetFile.file)} />}
      {crafts.length === 0 ? <p className="text-caption text-[var(--color-text-muted)]">Put in the staffing plan first: its crafts are the rows here.</p> : (
        <div className="rounded-xl border border-[var(--color-border)] text-body" data-rate-table>
          <div className={`hidden sm:grid ${cols} gap-x-2 px-3 py-2 bg-[var(--color-surface-2)] rounded-t-xl border-b border-[var(--color-border)] text-caption font-medium text-[var(--color-text-muted)]`}>
            <span>Craft</span><span className="text-right">Straight time</span><span className="text-right">Overtime</span><span className="text-right">Double time</span><span className="text-right whitespace-nowrap">One {paid} h shift</span>
          </div>
          {crafts.map((c) => {
            const r = sheet.crafts[c];
            const box = (k: "st" | "ot" | "dt") => {
              const typed = k === "st" ? (r?.st || null) : (r?.[k] ?? null);
              const auto = rateOf(sheet, c, k);
              const name = k === "st" ? "Straight time" : k === "ot" ? "Overtime" : "Double time";
              return (
                <label className="grid gap-0.5 min-w-0">
                  <span className="sm:hidden text-caption font-medium text-[var(--color-text-muted)]">{name}</span>
                  {p.canManage
                    ? <input aria-label={`${c} ${name.toLowerCase()}`} inputMode="decimal" value={typed ?? ""} placeholder={auto != null && k !== "st" ? String(Math.round(auto * 100) / 100) : "$/h"} onChange={(e) => setRate(c, k, e.target.value)} className={`${field} w-full text-right tabular-nums`} />
                    : <span className="tabular-nums text-right">{auto != null ? `$${Math.round(auto * 100) / 100}` : "-"}</span>}
                </label>
              );
            };
            const h = headCost(sheet, c, paid);
            return (
              <div key={c} className={`grid grid-cols-3 ${cols} gap-x-2 gap-y-1 items-center px-3 py-2 border-b last:border-b-0 border-[var(--color-border)]`} data-rate={c}>
                <div className="col-span-2 sm:col-span-1 font-medium text-[var(--color-text)] min-w-0">{c}{!planCrafts.includes(c) && <span className="ml-1.5 text-caption font-normal text-[var(--color-text-muted)]">not on the plan</span>}</div>
                <div className={`sm:order-last text-right tabular-nums ${h == null ? "text-[var(--state-held-text)] font-medium" : "text-[var(--color-text)]"}`}>{h == null ? "No rate" : <>{money(h)}<span className="sm:hidden text-caption text-[var(--color-text-muted)]"> a shift</span></>}</div>
                {box("st")}{box("ot")}{box("dt")}
              </div>
            );
          })}
        </div>
      )}
      {/* The pay rules: California's to start, each changed only if the
          contract says otherwise, so they are folded with a count. */}
      <MoreDetails label="Pay rules and per diem" total={4} defaultOpen={false}
        filled={(["paidHours", "stHours", "dtAfter", "perDiem"] as const).filter((k) => sheet[k] != null).length}>
        <p className="text-body text-[var(--color-text-muted)]">California daily overtime: time and a half after {sheet.stHours ?? RULES.stHours} hours, double time after {sheet.dtAfter ?? RULES.dtAfter}. Change it if the contract says otherwise.</p>
        <div className="flex gap-3 flex-wrap items-end">
          {rule("paidHours", "Paid hours a shift", String(shiftH), "h")}
          {rule("stHours", "Straight time for the first", String(RULES.stHours), "h")}
          {rule("dtAfter", "Double time past", String(RULES.dtAfter), "h")}
          {rule("perDiem", "Per diem a head", "0", "a day")}
        </div>
      </MoreDetails>
      {draft && (
        <div className="flex gap-1.5 flex-wrap items-center">
          <button type="button" disabled={!!p.busy} onClick={() => void save()} className={pri}>{p.busy === "rates" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {p.busy === "rates" ? "Saving" : "Save the rates"}</button>
          <button type="button" onClick={() => { setDraft(null); setMsg(null); }} className={btn}>Cancel</button>
          <span className="text-caption text-[var(--color-text-muted)]">Not saved yet.</span>
        </div>
      )}
    </Section>
  );
}

// ─── Every day ─────────────────────────────────────────────────────

function DailySection({ x, scope }: { x: Crew; scope: ProjectPhase | null }) {
  const rows = x.rows.filter((r) => r.plan || r.counted != null || r.hold);
  const priced = x.sum.planTotal != null;
  // Paid less plan, run up over the counted shifts.
  const running = rows.reduce<number[]>((acc, r) => { const last = acc.length ? acc[acc.length - 1] : 0; acc.push(r.counted != null ? last + (r.paid ?? 0) - (r.planCost ?? 0) : last); return acc; }, []);
  return (
    <Section id="daily" title="Every day: did we get what we paid for?" done={x.sum.counted > 0}
      help={<>{scope ? `${scope.name}, s` : "S"}hift by shift: the plan&apos;s heads, the heads counted at the meeting{priced ? ", and what they cost at the rate sheet" : ""}. Counted heads are priced at the plan&rsquo;s crafts for that shift. These are estimates from head counts and rates; posted invoices are what was really billed. Head counts go in at Shift › Meeting.</>}>
      {rows.length === 0 ? <p className="text-body text-[var(--color-text-muted)]">Nothing yet: no plan and no head counts{scope ? ` in ${scope.name}` : ""}.</p> : (<>
        {priced && (
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-body" data-crew-kpis>
            {[["Heads counted", x.sum.counted ? `${x.sum.countedHeads} of ${x.sum.plannedOnCounted}` : "None yet", x.sum.counted ? "against the plan, on the counted shifts" : "counted at the shift meeting"], ["Paid to date (estimate)", x.sum.counted ? money(x.sum.paidToDate) : "-", "head counts at the rate sheet"], ["Overtime to date", x.sum.overtime ? money(x.sum.overtime) : "None", "crews held over"], ["Forecast", money(x.sum.forecast), x.sum.counted ? `plan ${money(x.sum.planTotal)}` : "the plan, until heads are counted"]].map(([k, v, s]) => (
              <div key={k} className="min-w-0"><dt className="inline text-[var(--color-text-muted)]">{k} </dt><dd className="inline font-medium tabular-nums text-[var(--color-text)]">{v}</dd><dd className="inline text-[var(--color-text-muted)]">, {s}</dd></div>
            ))}
          </dl>
        )}
        <ul className="sm:hidden divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)]" data-crew-daily-list>
          {rows.map((r) => {
            const ph = r.plan?.heads ?? null, diff = r.counted != null && ph != null ? r.counted - ph : null;
            return (
              <li key={r.key} className={`px-3 py-2 text-body ${r.kind === "night" ? "bg-[var(--color-surface-2)]/50" : ""}`}>
                <div className="flex items-baseline gap-2">
                  <b className="min-w-0 flex-1 text-[var(--color-text)]">{shiftLabel(r.key)}</b>
                  {priced && <span className="tabular-nums text-[var(--color-text)]">{r.counted != null ? money(r.paid) : money(r.planCost)}</span>}
                </div>
                <div className="text-caption text-[var(--color-text-muted)]">
                  Plan {ph ?? "-"} · {r.counted != null ? <>Counted <b className="text-[var(--color-text)]">{r.counted}</b>{diff ? <b className={diff < 0 ? "text-[var(--state-held-text)]" : "text-[var(--state-overdue-text)]"}> ({diff < 0 ? `${-diff} short` : `${diff} over`})</b> : null}</> : r.started && ph ? <b className="text-[var(--state-held-text)]">Not counted</b> : "to come"}
                  {r.hold ? <> · Held over {r.hold.hands} × {r.hold.hours} h{r.hold.cost != null ? ` (${money(r.hold.cost)})` : ""}</> : null}
                  {priced && r.counted == null ? " · at the plan" : ""}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="hidden sm:block overflow-x-auto rounded-xl border border-[var(--color-border)]">
          <table className="w-full text-body border-collapse" data-crew-daily>
            <thead><tr className="bg-[var(--color-surface-2)] text-caption text-[var(--color-text-muted)]">
              <th className="text-left font-medium px-3 py-2">Shift</th><th className="text-right font-medium px-2 py-2">Plan</th><th className="text-right font-medium px-2 py-2">Counted</th><th className="text-left font-medium px-2 py-2">Against the plan</th><th className="text-right font-medium px-2 py-2">Overtime</th>
              {priced && <><th className="text-right font-medium px-2 py-2">Paid (est.)</th><th className="text-right font-medium px-2 py-2">Plan cost</th><th className="text-right font-medium px-3 py-2">Running</th></>}
            </tr></thead>
            <tbody>
              {rows.map((r, ri) => {
                const run = running[ri];
                const ph = r.plan?.heads ?? null, diff = r.counted != null && ph != null ? r.counted - ph : null;
                const w = r.counted != null && ph ? Math.min(100, (r.counted / Math.max(ph, r.counted)) * 100) : 0, m = ph && r.counted != null ? (ph / Math.max(ph, r.counted)) * 100 : 100;
                return (
                  <tr key={r.key} className={`border-t border-[var(--color-border)] ${r.kind === "night" ? "bg-[var(--color-surface-2)]/50" : ""}`} data-crew-shift={r.key}>
                    <td className="px-3 py-1.5 whitespace-nowrap text-[var(--color-text)]">{shiftLabel(r.key)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{ph ?? "-"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.counted != null ? <b>{r.counted}</b> : r.started && ph ? <span className="whitespace-nowrap inline-flex items-center gap-1.5 text-body font-medium text-[var(--state-held-text)]"><span aria-hidden className="w-[7px] h-[7px] rounded-full bg-[var(--state-held)]" />Not counted</span> : <span className="text-[var(--color-text-faint)]">to come</span>}</td>
                    <td className="px-2 py-1.5 min-w-[170px]">{diff != null && ph != null ? (
                      <span className="flex items-center gap-2">
                        <span className="relative h-2 w-24 rounded-full bg-[var(--color-surface-2)] border border-[var(--color-border)] overflow-hidden shrink-0" aria-hidden>
                          <span className={`absolute inset-y-0 left-0 rounded-full ${diff < 0 ? "bg-[var(--state-held)]" : diff > 0 ? "bg-[var(--state-overdue)]" : "bg-[var(--state-released)]"}`} style={{ width: `${w}%` }} />
                          <span className="absolute inset-y-[-2px] w-0.5 bg-[var(--color-text)] opacity-50" style={{ left: `${m}%` }} />
                        </span>
                        <span className={`text-caption ${diff ? "text-[var(--color-text)] font-medium" : "text-[var(--color-text-muted)]"}`}>{diff === 0 ? "As planned" : diff < 0 ? `${-diff} short` : `${diff} over plan`}{r.carried ? ", carried" : ""}</span>
                      </span>) : r.counted != null ? <span className="text-caption text-[var(--color-text-muted)]">No plan for this shift</span> : null}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">{r.hold ? <span>{r.hold.hands} × {r.hold.hours} h{r.hold.open ? " (still on)" : ""}{r.hold.cost != null && <b className="block">{money(r.hold.cost)}</b>}</span> : ""}</td>
                    {priced && <>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.counted != null ? money(r.paid) : "-"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{money(r.planCost)}</td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${run > 0 ? "text-[var(--state-overdue-text)] font-medium" : "text-[var(--color-text-muted)]"}`}>{r.counted != null ? `${run >= 0 ? "+" : "-"}${money(Math.abs(run))}` : ""}</td>
                    </>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </>)}
    </Section>
  );
}
