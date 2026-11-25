"use client";

// NewTurnaround - a new project starts from what the planner already has,
// asked once, up front:
//   * From a schedule (MS Project or P6 export, or CSV): its steps and
//     dates are the plan and its work orders are the scope. No work order
//     list is asked for: whoever has a schedule has planned past one.
//   * From a work order list (Excel or CSV): the scope; the schedule comes
//     later (imported, or made from the packages).
//   * Empty: just a name; the work is added as it comes.
// Then one screen to check what was found, name it, and make it. Shift
// times come from the workspace's last project as one line, opened only
// when this job is different. No description, purpose or goals: nothing in
// the app runs on them.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarRange, Check, ChevronDown, ChevronLeft, ChevronRight, FilePlus2, FileSpreadsheet, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
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
import { parseScheduleFileFromBytes, type ScheduleFormat } from "@/lib/scheduleParsers";
import { importMilestonesFromParsed } from "@/lib/milestones";
import { readScheduleScope, scheduleSource, importRows, SCHEDULE_ACCEPT } from "@/lib/scheduleScope";

const ROLES: ColumnRole[] = ["wo", "what", "equipment", "equipmentName", "category", "notes", "drafted", "approved", "addedBy", "added"];
type Start = "schedule" | "list" | "empty";
type Nights = "days" | "file" | "later";
const NIGHTS: Array<{ v: Nights; label: string; hint: string }> = [
  { v: "days", label: "Days only", hint: "No work is handed to a night crew." },
  { v: "file", label: "Days and nights", hint: "Work goes to nights where the schedule puts it." },
  { v: "later", label: "Decide with the schedule", hint: "Pick the jobs with night crews once the schedule is in." },
];
const FORMAT_WORD: Partial<Record<ScheduleFormat, string>> = {
  "msproject-xml": "Microsoft Project XML", "p6-xml": "Primavera P6 XML", "p6-xer": "Primavera P6 XER",
  "msproject-csv": "Microsoft Project CSV", "generic-csv": "CSV",
};

const hm12 = (v: string) => { const [h, m] = v.split(":").map(Number); if (!Number.isFinite(h)) return v; return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const tzShort = (tz: string) => tz.split("/").pop()!.replace(/_/g, " ");
/** A schedule file's name as a project name ("unit_2_TAR_schedule_rev3.xer" → "Unit 2 Tar Turnaround"). */
const nameFromSchedule = (file: string) => nameFrom("", file.replace(/\.[a-z0-9]+$/i, "").replace(/[_]+/g, " ").replace(/\b(schedule|sched|baseline|export|p6|xer|xml|csv|rev\.?\s*\d+|v\d+)\b/gi, " ").replace(/\s+/g, " ").trim() || "New");

export default function NewTurnaround({ orgId, actorUserId, actorEmail, actorRole, onClose }: {
  orgId: string; actorUserId: string; actorEmail?: string; actorRole?: string; onClose: () => void;
}) {
  const router = useRouter();
  const [start, setStart] = useState<Start | null>(null);
  // The work order list.
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [tab, setTab] = useState(0);
  const [map, setMap] = useState<ColumnMap | undefined>(undefined);
  const [showCols, setShowCols] = useState(false);
  // The schedule.
  const [sched, setSched] = useState<{ file: File; bytes: Uint8Array } | null>(null);
  // The rest.
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const [timezone, setTimezone] = useState<string>(() => browserTimeZone());
  const [times, setTimes] = useState<{ dayStart: string; nightStart: string; meetingBefore: number }>({ dayStart: DEFAULT_SHIFT_TIMES.dayStart, nightStart: DEFAULT_SHIFT_TIMES.nightStart, meetingBefore: 30 });
  const [timesFrom, setTimesFrom] = useState<string | null>(null);
  const [nights, setNights] = useState<Nights | null>(null);
  const [showShifts, setShowShifts] = useState(false);
  const [reading, setReading] = useState<Start | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<Start | null>(null);
  const listInput = useRef<HTMLInputElement>(null);
  const schedInput = useRef<HTMLInputElement>(null);

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

  const read: ScopeRead | null = useMemo(() => (start === "list" && sheets ? readScope(sheets[tab], map) : null), [start, sheets, tab, map]);
  const tabs = useMemo(() => (sheets ?? []).map((s) => ({ name: s.name, n: readScope(s).items.length })), [sheets]);
  // The schedule, read in the plant's zone (bare dates in the file are plant time).
  const parse = useMemo(() => (sched ? parseScheduleFileFromBytes(sched.file.name, sched.bytes, { timeZone: timezone }) : null), [sched, timezone]);
  const schedRead = useMemo(() => (parse && parse.rows.length ? readScheduleScope(parse.rows) : null), [parse]);

  const suggested = start === "list" && read && file ? nameFrom(read.title, file.name) : start === "schedule" && sched ? nameFromSchedule(sched.file.name) : "";
  const projectName = (named ? name : suggested).trim();
  const timesProblem = shiftTimesProblem({ dayStart: times.dayStart, nightStart: times.nightStart, meetingBefore: times.meetingBefore });
  // Nights: from the schedule when the project starts from one.
  const nightsNow: Nights = nights ?? (start === "schedule" ? "file" : "later");

  const takeList = async (f: File | undefined | null) => {
    if (!f) return;
    setError(null); setReading("list");
    try {
      const all = (await readSheets(f)).filter((s) => s.rows.length > 0);
      if (!all.length) throw new Error("That file has no rows in it.");
      if (!all.some((s) => readScope(s).items.length)) throw new Error("No work order numbers found in it (a column of 5 to 8 digit numbers). Check it's the work order list, or start from the schedule.");
      setFile(f); setSheets(all); setTab(pickSheet(all)); setMap(undefined); setNamed(false);
      setStart("list");
    } catch (e) {
      setError(sayError(e));
    } finally { setReading(null); }
  };

  const takeSchedule = async (f: File | undefined | null) => {
    if (!f) return;
    setError(null); setReading("schedule");
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const p = parseScheduleFileFromBytes(f.name, bytes, { timeZone: timezone });
      // An .mpp, an unknown file, or one with no rows: said here, nothing kept.
      if (!p.rows.length) throw new Error(p.warnings[0] || "No steps found in that file. Export it from MS Project as XML, or from P6 as XER or XML.");
      setSched({ file: f, bytes }); setNamed(false);
      setStart("schedule");
    } catch (e) {
      setError(sayError(e));
    } finally { setReading(null); }
  };

  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [busy, onClose]);

  const blocked = !projectName ? "Give the project a name." : timesProblem ? timesProblem : null;

  const create = async () => {
    if (blocked || !start) return;
    setBusy(true); setError(null);
    try {
      const project = await createProject({ orgId, name: projectName, description: "", timezone, actorUserId, actorEmail, actorRole });
      const projectId = project.id!;
      const problems: string[] = [];
      await saveProjectShiftTimes(projectId, {
        dayStart: times.dayStart, nightStart: times.nightStart, meetingBefore: times.meetingBefore,
        ...(nightsNow === "days" ? { nightJobs: [] } : nightsNow === "file" ? { nightJobs: "file" as const } : {}),
      }).catch((e) => { problems.push(`the shift times (${sayError(e)})`); });
      if (start === "list" && read && file) {
        await saveScope(projectId, {
          items: read.items, coming: read.coming, start: "list",
          source: { file: file.name, sheet: read.sheet, headers: read.headers, map: read.map },
          imports: [{ at: new Date().toISOString(), by: actorEmail, file: file.name, sheet: read.sheet, added: read.items.length, changed: 0, dropped: 0 }],
        }).catch((e) => { problems.push(`the work order list (${sayError(e)})`); });
      }
      if (start === "schedule" && parse && sched) {
        // The plan of record: baselined as it comes in.
        const res = await importMilestonesFromParsed({
          orgId, projectId, timeZone: timezone, baselineAll: true,
          source: scheduleSource(parse.format), importFile: sched.file.name,
          rows: importRows(parse), createdBy: actorUserId, createdByName: actorEmail,
        }).catch((e) => { problems.push(`the schedule (${sayError(e)}); import it from the Schedule tab`); return null; });
        if (res) {
          // Its work orders are the scope (none: the steps are the plan).
          await saveScope(projectId, {
            items: schedRead?.items ?? [], coming: [], start: "schedule",
            source: { file: sched.file.name, sheet: "", headers: [], map: {} }, imports: [],
          }).catch((e) => { problems.push(`the scope from the schedule (${sayError(e)})`); });
        }
      }
      const t = projectTypeOf(null, projectName);
      if (!isDefaultType(t)) await saveProjectType(projectId, t).catch(() => undefined);
      await seedTurnoverItems({ orgId, projectId, jobKind: "standard", actor: { uid: actorUserId, email: actorEmail ?? null } }).catch(() => undefined);
      router.push(`/projects/${projectId}?tab=plan`);
      if (problems.length) void appAlert({ tone: "danger", message: `The project was made, but ${problems.join("; ")} didn't save.` });
      onClose();
    } catch (e) {
      setError(sayError(e));
      setBusy(false);
    }
  };

  const restart = () => { setStart(null); setError(null); setNamed(false); setShowCols(false); };

  const equipment = read ? new Set(read.items.map((x) => x.equipment || x.wo)).size : 0;
  const many = read ? shared(read.items) : [];
  const conditional = read ? read.items.filter((x) => x.conditional).length : 0;
  const needs = read ? read.items.filter((x) => /need|add .*drawing|missing/i.test(x.notes)) : [];
  const cats = read ? byCategory(read.items) : [];
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: timezone, month: "short", day: "numeric", year: "numeric" }) : "");

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="nt-title" className="fixed inset-0 z-[200] bg-[var(--color-ink)]/55 flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="ui-float ui-float-in w-full max-w-2xl bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] overflow-hidden">
        <div className="px-6 pt-4 pb-4 border-b border-[var(--color-border)] flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h2 id="nt-title" className="font-display text-section font-semibold text-[var(--color-text)]">New project</h2>
            <p className="mt-0.5 text-body text-[var(--color-text-muted)]">
              {!start ? "Start from what you already have." : start === "schedule" ? `From the schedule: ${sched?.file.name}` : start === "list" ? `From the work order list: ${file?.name}` : "Starting empty."}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="-mr-2 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>
        </div>

        <input ref={listInput} type="file" accept={LIST_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void takeList(e.target.files?.[0]); e.target.value = ""; }} />
        <input ref={schedInput} type="file" accept={SCHEDULE_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void takeSchedule(e.target.files?.[0]); e.target.value = ""; }} />

        <div className="px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {!start ? (
            // ── How do you want to start? ──
            <fieldset>
              <legend className="text-reading font-semibold text-[var(--color-text)]">How do you want to start?</legend>
              <div className="mt-3 grid gap-2.5">
                <StartCard icon={CalendarRange} title="From a schedule" body="MS Project (XML) or Primavera P6 (XER or XML) export, or CSV. Its steps and dates are the plan, and its work orders are the scope."
                  action="Choose the schedule" busy={reading === "schedule"} dragging={drag === "schedule"}
                  onPick={() => schedInput.current?.click()} onDrag={(on) => setDrag(on ? "schedule" : null)} onFile={(f) => { setDrag(null); void takeSchedule(f); }} />
                <StartCard icon={FileSpreadsheet} title="From a work order list" body="Excel or CSV, as exported from Infor or sorted by hand. The schedule comes later: import it, or make it from the packages."
                  action="Choose the list" busy={reading === "list"} dragging={drag === "list"}
                  onPick={() => listInput.current?.click()} onDrag={(on) => setDrag(on ? "list" : null)} onFile={(f) => { setDrag(null); void takeList(f); }} />
                <StartCard icon={FilePlus2} title="Start empty" body="Just a name. Add the work, a list or a schedule from the project when you have them."
                  action="Start empty" onPick={() => { setError(null); setStart("empty"); }} />
              </div>
            </fieldset>
          ) : (
            // ── Check what was found, name it, make it ──
            <>
              {start === "schedule" && parse && schedRead && (
                <div className="grid gap-2">
                  <Found tone="ok">{schedRead.steps} step{schedRead.steps === 1 ? "" : "s"}{schedRead.from && schedRead.to ? `, ${day(schedRead.from)} to ${day(schedRead.to)}` : ""}</Found>
                  {schedRead.items.length > 0
                    ? <Found tone="ok">{schedRead.items.length} work order{schedRead.items.length === 1 ? "" : "s"} on it. They become the scope: no separate list needed.</Found>
                    : <Found tone="warn">No work order numbers on it. The steps are the plan; add work orders later if you want a package for each.</Found>}
                  {parse.warnings.slice(0, 2).map((w) => <Found key={w} tone="warn">{w}</Found>)}
                  {FORMAT_WORD[parse.format] && <p className="text-caption text-[var(--color-text-muted)]">Read as {FORMAT_WORD[parse.format]}. Baselined as it is when the project is made.</p>}
                </div>
              )}

              {start === "list" && read && file && (
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
                  <Fold open={showCols} onToggle={() => setShowCols((v) => !v)} title="Columns" summary={`${ROLES.filter((r) => read.map[r] != null).length} of ${ROLES.length} found. Change one if it's wrong.`}>
                    <div className="grid sm:grid-cols-2 gap-x-4 gap-y-3">
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
                  </Fold>
                </>
              )}

              <div>
                <label htmlFor="nt-name" className={labelCls}>Project name</label>
                <input id="nt-name" value={named ? name : suggested} onChange={(e) => { setName(e.target.value); setNamed(true); }} autoComplete="off" autoFocus={start === "empty"}
                  placeholder="e.g. Crude Unit Turnaround" className={fieldCls} />
                {suggested && !named && <p className="mt-1 text-caption text-[var(--color-text-muted)]">From the {start === "list" ? "list's title" : "file's name"}. Change it if it&apos;s off.</p>}
              </div>

              <Fold open={showShifts} onToggle={() => setShowShifts((v) => !v)} title="Shifts"
                summary={`Day ${hm12(times.dayStart)}, night ${hm12(times.nightStart)}, meeting ${times.meetingBefore ? `${times.meetingBefore} min before` : "at the change"}. ${NIGHTS.find((x) => x.v === nightsNow)!.label}. ${tzShort(timezone)} time.${timesFrom ? ` Same as ${timesFrom}.` : ""}`}>
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
                <fieldset className="mt-4">
                  <legend className={labelCls}>Night crews</legend>
                  <div className="grid sm:grid-cols-3 gap-2" role="radiogroup" aria-label="Night crews">
                    {NIGHTS.map((n) => (
                      <button key={n.v} type="button" role="radio" aria-checked={nightsNow === n.v} onClick={() => setNights(n.v)}
                        className={`rounded-lg border text-left p-3 ${nightsNow === n.v ? "border-[var(--color-current)] ring-1 ring-inset ring-[var(--color-current)]" : "border-[var(--color-border-strong)] hover:border-[var(--color-border-control)]"}`}>
                        <div className="text-body font-medium text-[var(--color-text)] flex items-center gap-1.5">{nightsNow === n.v && <Check aria-hidden className="w-4 h-4 text-[var(--color-current)]" />}{n.label}</div>
                        <div className="text-body leading-snug text-[var(--color-text-muted)] mt-0.5">{n.hint}</div>
                      </button>
                    ))}
                  </div>
                </fieldset>
                <div className="mt-4">
                  <span className={labelCls}>Plant time zone</span>
                  <TimeZoneSelect value={timezone} onChange={setTimezone} />
                </div>
              </Fold>
            </>
          )}

          {error && <ErrorNote title={error} />}
        </div>

        {start && (
          <div className="px-6 py-4 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={restart} disabled={busy}><ChevronLeft className="w-4 h-4" /> Start another way</Button>
            <span className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
              {blocked && <span id="nt-why" className="text-body text-[var(--color-text-muted)]">{blocked}</span>}
              <Button onClick={() => void create()} disabled={!!blocked} loading={busy} aria-describedby={blocked ? "nt-why" : undefined}>
                <Check className="w-4 h-4" /> Make the project
              </Button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** One way to start: the whole card is the button; a file can be dropped on it. */
function StartCard({ icon: Icon, title, body, action, onPick, onDrag, onFile, busy = false, dragging = false }: {
  icon: React.ComponentType<{ className?: string }>; title: string; body: string; action: string;
  onPick: () => void; onDrag?: (on: boolean) => void; onFile?: (f: File | undefined) => void; busy?: boolean; dragging?: boolean;
}) {
  return (
    <button type="button" onClick={onPick} disabled={busy} aria-label={`${title}: ${action}`}
      onDragOver={onFile ? (e) => { e.preventDefault(); onDrag?.(true); } : undefined}
      onDragLeave={onFile ? () => onDrag?.(false) : undefined}
      onDrop={onFile ? (e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); } : undefined}
      className={`group w-full text-left rounded-xl border p-4 flex items-start gap-3.5 transition-colors ${dragging ? "border-[var(--color-current)] bg-[var(--color-surface-2)]" : "border-[var(--color-border-strong)] hover:border-[var(--color-border-control)] hover:bg-[var(--color-surface-2)]"}`}>
      <Icon aria-hidden className="w-6 h-6 mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
      <span className="flex-1 min-w-0">
        <span className="block text-reading font-semibold text-[var(--color-text)]">{title}</span>
        <span className="block mt-0.5 text-body text-[var(--color-text-muted)]">{body}</span>
        {onFile && <span className="block mt-1.5 text-caption text-[var(--color-text-muted)]">{busy ? "Reading it…" : "Drop the file here, or click to choose it."}</span>}
      </span>
      <ChevronRight aria-hidden className="w-5 h-5 mt-0.5 shrink-0 text-[var(--color-text-muted)] group-hover:text-[var(--color-text)]" />
    </button>
  );
}

/** A setting most people only confirm: one line, opened when it's different. */
function Fold({ open, onToggle, title, summary, children }: { open: boolean; onToggle: () => void; title: string; summary: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)]">
      <button type="button" onClick={onToggle} aria-expanded={open} className="w-full flex items-start gap-2 min-h-11 px-3 py-2.5 text-left text-body text-[var(--color-text)]">
        <ChevronDown aria-hidden className={`ui-chevron w-4 h-4 mt-0.5 shrink-0 text-[var(--color-text-muted)] ${open ? "" : "-rotate-90"}`} />
        <span className="font-medium shrink-0">{title}</span>
        <span className="text-[var(--color-text-muted)] min-w-0">{summary}</span>
        <span className="ml-auto pl-2 shrink-0 font-medium text-[var(--color-accent-text)]">{open ? "Done" : "Change"}</span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
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
