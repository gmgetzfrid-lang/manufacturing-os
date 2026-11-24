"use client";

// NewTurnaround - a project starts from what the planner has (the work order
// list) and asks only what the app runs on from day one, each step saying
// what its answers are used for:
//   1 Work list  the Excel list: the approved tab and its columns are found
//   2 Scope      what was found, and the project's name (from the list)
//   3 Shifts     time zone, shift change times, the turnover meeting, nights:
//                the day/night split, the shift report, plan-by-now
//   4 Check      every answer and where it's used; what is asked later, and
//                when (the schedule, contractors' staffing and rates, roles,
//                letterhead, budget)
// No description, purpose or goals: nothing in the app runs on them.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, ChevronDown, FileSpreadsheet, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import StepPath from "@/components/ui/StepPath";
import TimeZoneSelect from "@/components/projects/TimeZoneSelect";
import { field as fieldCls, label as labelCls } from "@/components/admin/kit";
import { supabase } from "@/lib/supabase";
import { createProject } from "@/lib/projects";
import { seedTurnoverItems } from "@/lib/turnover";
import { projectTypeOf, isDefaultType } from "@/lib/projectType";
import { saveProjectShiftTimes, saveProjectType, shiftTimesProblem } from "@/lib/shiftTimesStore";
import { DEFAULT_SHIFT_TIMES, type ShiftTimes } from "@/lib/shiftReport";
import { browserTimeZone } from "@/lib/scheduleTz";
import { appAlert } from "@/components/providers/DialogProvider";
import { sayError } from "@/components/projects/sayError";
import { pickSheet, readScope, nameFrom, byCategory, shared, ROLE_WORD, type ColumnMap, type ColumnRole, type Sheet, type ScopeRead } from "@/lib/woIntake";
import { readSheets, saveScope, LIST_ACCEPT } from "@/lib/scopeStore";

const ROLES: ColumnRole[] = ["wo", "what", "equipment", "equipmentName", "category", "notes", "drafted", "approved", "addedBy", "added"];
const STEPS = ["Work list", "Scope", "Shifts", "Check"];
/** What each step's answers are used for, said at the top of the step. */
const USED_FOR = [
  "The work orders become the project's scope: grouped and counted, each one a package to draft, its equipment matched, and later the schedule and the RFQ's scope counts.",
  "The name is on every page, report and email. The list is checked here before anything is made.",
  "Every day and night split, the shift report and its email, the turnover meeting time, and plan-by-now all run on these.",
  "Nothing is made until you press Make the project.",
];
type Nights = "days" | "file" | "later";
const NIGHTS: Array<{ v: Nights; label: string; hint: string }> = [
  { v: "days", label: "Days only", hint: "No work is handed to a night crew." },
  { v: "file", label: "Days and nights", hint: "Work goes to nights where the schedule puts it." },
  { v: "later", label: "Decide with the schedule", hint: "Pick the jobs with night crews once the schedule is in." },
];

const hm12 = (v: string) => { const [h, m] = v.split(":").map(Number); if (!Number.isFinite(h)) return v; return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };

export default function NewTurnaround({ orgId, actorUserId, actorEmail, actorRole, onClose }: {
  orgId: string; actorUserId: string; actorEmail?: string; actorRole?: string; onClose: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [noList, setNoList] = useState(false);
  const [tab, setTab] = useState(0);
  const [map, setMap] = useState<ColumnMap | undefined>(undefined);
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const [timezone, setTimezone] = useState<string>(() => browserTimeZone());
  const [times, setTimes] = useState<{ dayStart: string; nightStart: string; meetingBefore: number }>({ dayStart: DEFAULT_SHIFT_TIMES.dayStart, nightStart: DEFAULT_SHIFT_TIMES.nightStart, meetingBefore: 30 });
  const [timesFrom, setTimesFrom] = useState<string | null>(null);
  const [nights, setNights] = useState<Nights>("later");
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [showCols, setShowCols] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Shift times and zone as the workspace's latest project has them, so most
  // people only confirm.
  useEffect(() => {
    let on = true;
    void Promise.resolve(supabase.from("projects").select("name, timezone, shift_times").eq("org_id", orgId).order("created_at", { ascending: false }).limit(5))
      .then(({ data }) => {
        if (!on) return;
        const p = ((data ?? []) as Array<{ name: string; timezone: string | null; shift_times: Partial<ShiftTimes> | null }>).find((x) => x.shift_times?.dayStart && x.shift_times?.nightStart);
        if (!p?.shift_times) return;
        setTimes({ dayStart: p.shift_times.dayStart!, nightStart: p.shift_times.nightStart!, meetingBefore: typeof p.shift_times.meetingBefore === "number" ? p.shift_times.meetingBefore : 30 });
        if (p.timezone) setTimezone(p.timezone);
        setTimesFrom(p.name);
      }, () => undefined);
    return () => { on = false; };
  }, [orgId]);

  const read: ScopeRead | null = useMemo(() => (sheets ? readScope(sheets[tab], map) : null), [sheets, tab, map]);
  const tabs = useMemo(() => (sheets ?? []).map((s) => ({ name: s.name, n: readScope(s).items.length })), [sheets]);
  const suggested = read && file ? nameFrom(read.title, file.name) : "";
  const projectName = (named ? name : suggested).trim();
  const timesProblem = shiftTimesProblem({ dayStart: times.dayStart, nightStart: times.nightStart, meetingBefore: times.meetingBefore });

  const take = async (f: File | undefined | null) => {
    if (!f) return;
    setError(null); setReading(true);
    try {
      const all = (await readSheets(f)).filter((s) => s.rows.length > 0);
      if (!all.length) throw new Error("That file has no rows in it.");
      if (!all.some((s) => readScope(s).items.length)) throw new Error("No work order numbers found in it (a column of 5 to 8 digit numbers). Check it's the work order list.");
      setFile(f); setSheets(all); setTab(pickSheet(all)); setMap(undefined); setNamed(false); setNoList(false);
      setStep(1);
    } catch (e) {
      setError(sayError(e));
    } finally { setReading(false); }
  };

  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [busy, onClose]);

  // Why Next can't be pressed yet, said beside it.
  const blocked = step === 0 && !read && !noList ? "Choose the list, or go on without one."
    : step === 1 && !projectName ? "Give the project a name."
    : step === 2 && timesProblem ? timesProblem : null;

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const project = await createProject({ orgId, name: projectName, description: "", timezone, actorUserId, actorEmail, actorRole });
      const projectId = project.id!;
      const problems: string[] = [];
      await saveProjectShiftTimes(projectId, {
        dayStart: times.dayStart, nightStart: times.nightStart, meetingBefore: times.meetingBefore,
        ...(nights === "days" ? { nightJobs: [] } : nights === "file" ? { nightJobs: "file" as const } : {}),
      }).catch((e) => { problems.push(`the shift times (${sayError(e)})`); });
      if (read && file) {
        await saveScope(projectId, {
          items: read.items, coming: read.coming,
          source: { file: file.name, sheet: read.sheet, headers: read.headers, map: read.map },
          imports: [{ at: new Date().toISOString(), by: actorEmail, file: file.name, sheet: read.sheet, added: read.items.length, changed: 0, dropped: 0 }],
        }).catch((e) => { problems.push(`the work order list (${sayError(e)})`); });
      }
      const t = projectTypeOf(null, projectName);
      if (!isDefaultType(t)) await saveProjectType(projectId, t).catch(() => undefined);
      await seedTurnoverItems({ orgId, projectId, jobKind: "standard", actor: { uid: actorUserId, email: actorEmail ?? null } }).catch(() => undefined);
      router.push(`/projects/${projectId}?tab=plan`);
      if (problems.length) void appAlert({ tone: "danger", message: `The project was made, but ${problems.join("; ")} didn't save. Set it on the project's Plan tab.` });
      onClose();
    } catch (e) {
      setError(sayError(e));
      setBusy(false);
    }
  };

  const next = () => { setError(null); if (step === 3) void create(); else if (!blocked) setStep(step + 1); };

  const equipment = read ? new Set(read.items.map((x) => x.equipment || x.wo)).size : 0;
  const many = read ? shared(read.items) : [];
  const conditional = read ? read.items.filter((x) => x.conditional).length : 0;
  const needs = read ? read.items.filter((x) => /need|add .*drawing|missing/i.test(x.notes)) : [];
  const cats = read ? byCategory(read.items) : [];

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="nt-title" className="fixed inset-0 z-[200] bg-[var(--color-ink)]/55 flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="ui-float ui-float-in w-full max-w-2xl bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] overflow-hidden">
        <div className="px-6 pt-4 pb-4 border-b border-[var(--color-border)]">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <h2 id="nt-title" className="font-display text-section font-semibold text-[var(--color-text)]">New project</h2>
              <p className="mt-0.5 text-body text-[var(--color-text-muted)]">4 short steps. Nothing else is asked until it&apos;s needed.</p>
            </div>
            <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="-mr-2 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>
          </div>
          <StepPath className="mt-4 max-sm:mt-2" steps={STEPS} current={step} onPick={(i) => { if (!busy && i < step) { setError(null); setStep(i); } }} />
        </div>

        <div className="px-6 py-5 space-y-5 max-h-[64vh] overflow-y-auto">
          {/* What this step's answers are used for. */}
          <p className="text-body text-[var(--color-text-muted)] border-l-2 border-[var(--color-border-strong)] pl-3"><span className="font-medium text-[var(--color-text)]">Used for: </span>{USED_FOR[step]}</p>
          <input ref={input} type="file" accept={LIST_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void take(e.target.files?.[0]); e.target.value = ""; }} />

          {step === 0 && (
            <>
              <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); void take(e.dataTransfer.files?.[0]); }}
                className={`rounded-xl border-2 border-dashed px-5 py-6 grid gap-2 justify-items-start ${drag ? "border-[var(--color-current)] bg-[var(--color-surface-2)]" : "border-[var(--color-border-strong)]"}`}>
                <FileSpreadsheet aria-hidden className="w-6 h-6 text-[var(--color-text-muted)]" />
                <div className="text-reading font-semibold text-[var(--color-text)]">{file ? file.name : "Drop your work order list here"}</div>
                <p className="text-body text-[var(--color-text-muted)] max-w-prose">Excel or CSV, as exported from Infor or sorted by hand. The approved tab and its columns are found for you. When the list grows, import it again from the project.</p>
                <Button onClick={() => input.current?.click()} loading={reading}>{file ? "Choose another file" : "Choose the file"}</Button>
              </div>
              <button type="button" onClick={() => { setNoList(true); setSheets(null); setFile(null); setStep(1); }}
                className="ui-hit text-body font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">No list yet: go on with just a name</button>
            </>
          )}

          {step === 1 && (
            <>
              {read && file ? (
                <>
                  {tabs.length > 1 && (
                    <div>
                      <label htmlFor="nt-tab" className={labelCls}>Tab used</label>
                      <select id="nt-tab" value={tab} onChange={(e) => { setTab(Number(e.target.value)); setMap(undefined); setNamed(false); }} className={fieldCls}>
                        {tabs.map((t, i) => <option key={t.name} value={i}>{t.name} · {t.n} work order{t.n === 1 ? "" : "s"}</option>)}
                      </select>
                    </div>
                  )}
                  <div className="grid gap-2">
                    <Found tone="ok">{read.items.length} work order{read.items.length === 1 ? "" : "s"} on {equipment} piece{equipment === 1 ? "" : "s"} of equipment</Found>
                    {read.coming.length > 0 && <Found tone="new">Scope still coming from {read.coming.length}: {read.coming.map((c) => `${c.what}${c.owner ? ` (${c.owner})` : ""}`).join(", ")}</Found>}
                    {many.length > 0 && <Found tone="warn">{many.length} piece{many.length === 1 ? " has" : "s have"} 2 or more work orders; each piece gets one package</Found>}
                    {conditional > 0 && <Found tone="warn">{conditional} depend on what inspection finds (the notes say inspect for cleanliness)</Found>}
                    {needs.length > 0 && <Found tone="warn">{needs.length} note{needs.length === 1 ? "" : "s"} ask for something: {[...new Set(needs.map((x) => x.notes.replace(/\s*-\s*\w+\.?$/, "")))].slice(0, 3).join("; ")}</Found>}
                  </div>
                  {cats.length > 0 && (
                    <div className="flex flex-wrap gap-1.5" aria-label="Work orders by group">
                      {cats.map((g) => <span key={g.category} className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-[var(--color-border)] text-body text-[var(--color-text)]">{g.category}<span className="tabular-nums text-[var(--color-text-muted)]">{g.items.length}</span></span>)}
                    </div>
                  )}
                  <div className="rounded-lg border border-[var(--color-border)]">
                    <button type="button" onClick={() => setShowCols((v) => !v)} aria-expanded={showCols} className="w-full flex items-center gap-2 min-h-11 px-3 text-left text-body text-[var(--color-text)]">
                      <ChevronDown aria-hidden className={`ui-chevron w-4 h-4 shrink-0 text-[var(--color-text-muted)] ${showCols ? "" : "-rotate-90"}`} />
                      <span className="font-medium shrink-0">Columns</span>
                      <span className="text-[var(--color-text-muted)] truncate">{ROLES.filter((r) => read.map[r] != null).length} of {ROLES.length} found. Change one if it&apos;s wrong.</span>
                    </button>
                    {showCols && (
                      <div className="px-3 pb-3 grid sm:grid-cols-2 gap-x-4 gap-y-3">
                        {ROLES.map((r) => (
                          <div key={r}>
                            <label htmlFor={`nt-col-${r}`} className={labelCls}>{ROLE_WORD[r]}</label>
                            <select id={`nt-col-${r}`} value={read.map[r] ?? -1} className={fieldCls} onChange={(e) => { const v = Number(e.target.value); setMap({ ...(map ?? read.map), [r]: v < 0 ? undefined : v }); }}>
                              <option value={-1}>Not in the list</option>
                              {read.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                            </select>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <p className="text-body text-[var(--color-text-muted)]">No list: the project starts empty. Import the list from its Plan tab whenever it&apos;s ready.</p>
              )}
              <div>
                <label htmlFor="nt-name" className={labelCls}>Project name</label>
                <input id="nt-name" value={named ? name : suggested} onChange={(e) => { setName(e.target.value); setNamed(true); }} autoComplete="off"
                  placeholder="e.g. Crude Unit Turnaround" className={fieldCls} />
                {read && !named && <p className="mt-1 text-caption text-[var(--color-text-muted)]">From the list&apos;s title: {read.title || file?.name}</p>}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              {timesFrom && <p className="text-body text-[var(--color-text-muted)]">Filled in from {timesFrom}. Change anything that&apos;s different on this job.</p>}
              <div className="grid sm:grid-cols-3 gap-x-4 gap-y-4">
                <div>
                  <label htmlFor="nt-day" className={labelCls}>Day shift starts</label>
                  <input id="nt-day" type="time" value={times.dayStart} onChange={(e) => setTimes({ ...times, dayStart: e.target.value })} className={fieldCls} />
                </div>
                <div>
                  <label htmlFor="nt-night" className={labelCls}>Night shift starts</label>
                  <input id="nt-night" type="time" value={times.nightStart} onChange={(e) => setTimes({ ...times, nightStart: e.target.value })} className={fieldCls} />
                </div>
                <div>
                  <label htmlFor="nt-meet" className={labelCls}>Turnover meeting</label>
                  <select id="nt-meet" value={times.meetingBefore} onChange={(e) => setTimes({ ...times, meetingBefore: Number(e.target.value) })} className={fieldCls}>
                    {[0, 15, 30, 45, 60].map((m) => <option key={m} value={m}>{m ? `${m} min before` : "At the change"}</option>)}
                  </select>
                </div>
              </div>
              <p className="-mt-2 text-caption text-[var(--color-text-muted)]">Day {hm12(times.dayStart)} to {hm12(times.nightStart)}, night {hm12(times.nightStart)} to {hm12(times.dayStart)}.</p>
              <fieldset>
                <legend className={labelCls}>Night crews</legend>
                <div className="grid sm:grid-cols-3 gap-2" role="radiogroup" aria-label="Night crews">
                  {NIGHTS.map((n) => (
                    <button key={n.v} type="button" role="radio" aria-checked={nights === n.v} onClick={() => setNights(n.v)}
                      className={`rounded-lg border text-left p-3 ${nights === n.v ? "border-[var(--color-current)] ring-1 ring-inset ring-[var(--color-current)]" : "border-[var(--color-border-strong)] hover:border-[var(--color-border-control)]"}`}>
                      <div className="text-body font-medium text-[var(--color-text)] flex items-center gap-1.5">{nights === n.v && <Check aria-hidden className="w-4 h-4 text-[var(--color-current)]" />}{n.label}</div>
                      <div className="text-body leading-snug text-[var(--color-text-muted)] mt-0.5">{n.hint}</div>
                    </button>
                  ))}
                </div>
              </fieldset>
              <div>
                <span className={labelCls}>Plant time zone</span>
                <TimeZoneSelect value={timezone} onChange={setTimezone} />
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
                <Row label="Name" value={projectName} use="Every page, report and email" />
                <Row label="Scope" value={read ? `${read.items.length} work orders, ${equipment} pieces of equipment${read.coming.length ? `; ${read.coming.length} still adding scope` : ""}` : "None yet"} use="Packages to draft, equipment, scope counts in RFQs" />
                <Row label="Shifts" value={`Day ${hm12(times.dayStart)}, night ${hm12(times.nightStart)}, meeting ${times.meetingBefore ? `${times.meetingBefore} min before` : "at the change"}`} use="Shift reports, the turnover meeting, plan-by-now" />
                <Row label="Night crews" value={NIGHTS.find((n) => n.v === nights)!.label} use="Which work is handed to nights" />
                <Row label="Time zone" value={timezone} use="Every date and time on the project" />
              </div>
              <div>
                <h3 className="text-body font-semibold text-[var(--color-text)]">Asked later, when it&apos;s needed</h3>
                <ul className="mt-1.5 grid gap-1 text-body text-[var(--color-text-muted)]">
                  <li><span className="font-medium text-[var(--color-text)]">The schedule</span> when you import it (MS Project or P6) or build it from the packages: then the critical path and the baseline.</li>
                  <li><span className="font-medium text-[var(--color-text)]">Contractors&apos; staffing plans and rates</span> when the work is awarded: the shift head counts and live cost run on them.</li>
                  <li><span className="font-medium text-[var(--color-text)]">The budget</span> when you have the AFE or estimate (Costs).</li>
                  <li><span className="font-medium text-[var(--color-text)]">Roles and people</span> on the Members tab, before the work starts.</li>
                </ul>
              </div>
            </>
          )}

          {error && <ErrorNote title={error} />}
        </div>

        <div className="px-6 py-4 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-wrap items-center gap-2">
          {step > 0 && <Button variant="secondary" onClick={() => { setError(null); setStep(step - 1); }} disabled={busy}><ChevronLeft className="w-4 h-4" /> Back</Button>}
          <span className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            {blocked && <span id="nt-why" className="text-body text-[var(--color-text-muted)]">{blocked}</span>}
            <Button onClick={next} disabled={!!blocked} loading={busy} aria-describedby={blocked ? "nt-why" : undefined}>
              {step === 3 ? <><Check className="w-4 h-4" /> Make the project</> : <>Next: {STEPS[step + 1]} <ChevronRight className="w-4 h-4" /></>}
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}

/** One thing found, as a line with its mark. */
function Found({ tone, children }: { tone: "ok" | "warn" | "new"; children: React.ReactNode }) {
  const cls = tone === "ok" ? "bg-[color-mix(in_srgb,var(--state-released)_10%,transparent)] text-[var(--state-released-text)]"
    : tone === "warn" ? "bg-[color-mix(in_srgb,var(--state-held)_12%,transparent)] text-[var(--state-held-text)]"
    : "bg-[var(--color-surface-2)] text-[var(--color-text)]";
  return (
    <div className={`flex items-start gap-2 rounded-md px-3 py-2 text-body font-medium ${cls}`}>
      <span aria-hidden className="shrink-0">{tone === "ok" ? "✓" : tone === "warn" ? "!" : "+"}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** A line of the check: the answer, and what it's used for. */
function Row({ label, value, use }: { label: string; value: string; use: string }) {
  return (
    <div className="px-3 py-2.5 grid sm:grid-cols-[7rem_1fr] gap-x-4 gap-y-0.5">
      <div className="text-body text-[var(--color-text-muted)]">{label}</div>
      <div className="min-w-0">
        <div className="text-body font-medium text-[var(--color-text)] break-words">{value}</div>
        <div className="text-caption text-[var(--color-text-muted)]">Used for: {use}</div>
      </div>
    </div>
  );
}
