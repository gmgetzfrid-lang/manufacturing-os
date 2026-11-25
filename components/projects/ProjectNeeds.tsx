"use client";

// What this project needs: everything the project will ask for, stage by
// stage, from the first day: before the work (setup), every shift, and to
// close. Each line says what it is set to now and where that came from (the
// app's default, set when the project was made, or set for this project,
// with when and by whom when that was recorded), and changes right there: a
// switch, a field, or Setup opened at that part, in place. Nothing turns up
// at close-out that wasn't on this list from the start.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { lastLoaded, keepLoaded } from "@/lib/warmLoads";
import { Check, ChevronDown, Loader2, Plus, Settings2 } from "lucide-react";
import type { Milestone, Project, ProjectMember } from "@/types/schema";
import { supabase } from "@/lib/supabase";
import { requestSetup, toDo, type SetupItemId } from "@/lib/scheduleSetup";
import { useSetupItems, SETUP_CLOSED_EVENT } from "@/components/projects/ScheduleSetup";
import { useShiftTimesState, useShiftTimesSaved } from "@/lib/shiftTimesStore";
import { useLetterhead } from "@/lib/letterheadStore";
import { useCrewSettings } from "@/lib/useCrewSettings";
import { contractorList } from "@/lib/crewSettings";
import { projectTypeOf, projectTypeSet } from "@/lib/projectType";
import { CRITICAL_MODES } from "@/lib/criticalPath";
import { parseClock } from "@/lib/shiftReport";
import { tzLabel } from "@/lib/scheduleTz";
import { phaseDates, type ProjectPhase } from "@/lib/projectPhases";
import { cleanOrg, orgStanding, ORG_CHANGED } from "@/lib/eventOrganization";
import { loadCloseoutSettings, savePssrNeeded, CLOSEOUT_CHANGED, type CloseoutSettings } from "@/lib/closeoutSettings";
import { listTurnoverItems, seedTurnoverItems, addTurnoverItem, updateTurnoverItem, seedsForJobKind, type TurnoverItem } from "@/lib/turnover";
import { gatherProjectSnapshot } from "@/lib/projectSnapshot";
import type { ProjectStateSnapshot } from "@/lib/projectHealth";
import { readAfe, loadAfeHistory, type Afe, type AfeRevision } from "@/lib/costRevisions";
import { listMaterials } from "@/lib/materials";
import { latestStamp, pssrSource, turnoverSource, jobSizeWord, JOB_SIZES, type Source, type Stamp } from "@/lib/requirementSource";
import { stampsOf, saveJobKind } from "@/lib/projectStamps";
import { readPssrs, listOk, openCloseoutView, type PssrList } from "@/components/projects/CloseoutTab";
import { AfeEditor } from "@/components/projects/cost/CostEdits";
import { useFindingsReview } from "@/components/projects/Findings";
import { FINDINGS_SQL } from "@/lib/findings";
import { SourceLine, SourceHelp, Switch, NeededChoice } from "@/components/projects/NeedParts";
import { Card, heroQuiet } from "@/components/ui/PageHero";
import { fieldBox } from "@/components/admin/kit";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Skeleton } from "@/components/ui/Skeleton";
import { sayError } from "@/components/projects/sayError";

type State = "set" | "default" | "open" | "info";
interface Row { id: string; name: string; value: React.ReactNode; source: Source | null; state: State; action?: React.ReactNode; body?: React.ReactNode }

/** What was read for the list: null parts couldn't be read (shown as not known, never as clear). */
interface Facts {
  closeout: CloseoutSettings | null;
  items: TurnoverItem[] | null;
  pssrs: PssrList[] | null;
  snap: ProjectStateSnapshot | null;
  afe: Afe | null;
  afeHist: AfeRevision[];
  org: { recorded: boolean; filled: number; required: number; at: number | string | null; by: string | null } | null;
  stamps: Record<string, Stamp>;
  setupState: Record<string, string> | null;
  materials: number | null;
}

async function readFacts(orgId: string, projectId: string): Promise<Facts> {
  const [closeout, items, pssrs, snap, afe, afeHist, raw, setupState, materials] = await Promise.all([
    loadCloseoutSettings(projectId).catch(() => null),
    listTurnoverItems(orgId, projectId).catch(() => null),
    readPssrs(orgId, projectId),
    gatherProjectSnapshot(orgId, projectId).catch(() => null),
    readAfe(projectId).catch(() => null),
    loadAfeHistory(projectId).then((h) => h.history).catch(() => [] as AfeRevision[]),
    Promise.resolve(supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle())
      .then((r) => (r.error ? null : ((r.data as { shift_times?: Record<string, unknown> | null } | null)?.shift_times ?? {})), () => null),
    // The new-project steps' record (an older database has no column: not known).
    Promise.resolve(supabase.from("projects").select("setup_state").eq("id", projectId).maybeSingle())
      .then((r) => (r.error ? null : ((r.data as { setup_state?: Record<string, string> | null } | null)?.setup_state ?? null)), () => null),
    listMaterials(projectId).then((r) => r.rows.length).catch(() => null),
  ]);
  const o = raw && typeof raw.organization === "object" && raw.organization ? (raw.organization as Record<string, unknown>) : null;
  const st = raw ? orgStanding(cleanOrg(o)) : null;
  return {
    closeout, items, pssrs, snap, afe, afeHist, setupState, materials,
    stamps: stampsOf(raw),
    org: st ? { recorded: st.recorded, filled: st.filled, required: st.required, at: typeof o?.savedAt === "number" || typeof o?.savedAt === "string" ? (o.savedAt as number | string) : null, by: typeof o?.savedBy === "string" ? o.savedBy : null } : null,
  };
}

/** "06:00" → "6:00 AM". */
const ampm = (hm: string | undefined) => { const c = hm ? parseClock(hm) : null; return c ? `${c.h % 12 || 12}:${String(c.m).padStart(2, "0")} ${c.h < 12 ? "AM" : "PM"}` : "-"; };
const joinWords = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Where a line stands: a dot and a word. "To do" is the word in semibold
 *  (it needs someone) by its amber dot; set is a green dot with plain
 *  words; the app's default and lines kept for your information are muted. */
const MARK: Record<State, { word: string; dot: string; text: string } | null> = {
  set: { word: "Set", dot: "var(--state-released)", text: "text-[var(--color-text)]" },
  open: { word: "To do", dot: "var(--state-held)", text: "text-[var(--color-text)] font-semibold" },
  default: { word: "App default", dot: "var(--color-text-faint)", text: "text-[var(--color-text-muted)]" },
  info: null,
};
function Mark({ state }: { state: State }) {
  const m = MARK[state];
  if (!m) return null;
  return (
    <span className={`inline-flex items-center gap-1.5 text-body whitespace-nowrap ${m.text}`}>
      <span aria-hidden className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: m.dot }} />{m.word}
    </span>
  );
}

/** The columns every row lines up on: the need, what it's set to (and where
 *  that came from), where it stands, and the one way to change it. */
const COLS = "md:grid md:grid-cols-[minmax(10rem,15rem)_minmax(0,1fr)_7.5rem_10rem] md:gap-x-6 md:items-start";

function NeedRow({ r, tz, quiet }: { r: Row; tz: string; quiet?: boolean }) {
  // What's left to do stands out: its name and words at the reading size.
  const todo = r.state === "open";
  // "Asked by the post-event review: …" is a reason, not needed to act:
  // behind the "?" at the end of the line (rule B5).
  const asked = r.source?.kind === "asked" ? r.source : null;
  return (
    <li className={`px-4 sm:px-5 ${todo ? "py-3" : "py-2"}`} data-need-row={r.id} data-need-state={r.state}>
      <div className={`${COLS} max-md:flex max-md:flex-wrap max-md:items-baseline max-md:gap-x-3 max-md:gap-y-1`}>
        <div className={`min-w-0 max-md:flex-1 leading-snug ${todo ? "text-reading font-semibold text-[var(--color-text)]" : quiet ? "text-body text-[var(--color-text-muted)]" : "text-body font-medium text-[var(--color-text)]"}`}>{r.name}</div>
        <div className="min-w-0 max-md:order-3 max-md:basis-full">
          <div className={`leading-snug text-[var(--color-text)] ${todo ? "text-reading" : "text-body"}`}>
            {r.value}{asked && <SourceHelp source={asked} tz={tz} placement="top" className="ml-1 align-middle" />}
          </div>
          {/* Where the setting came from ("App default: …", "Set for this
              project …"): said on the folded list, where it's looked for. */}
          {r.source && !asked && <SourceLine source={r.source} tz={tz} className="mt-0.5" />}
        </div>
        <div className="max-md:order-2 md:pt-px"><Mark state={r.state} /></div>
        <div className="max-md:order-2 max-md:-my-1.5 md:justify-self-end flex items-center justify-end gap-2 min-w-0 md:-mt-1.5">{r.action}</div>
        {r.body && <div className="md:col-start-2 md:col-span-3 max-md:order-5 max-md:basis-full min-w-0">{r.body}</div>}
      </div>
    </li>
  );
}

/** One stage: a heading row, then what is still to do, then what's there
 *  to know; what is already set (or left on the app's default) folds into
 *  one line, "12 set · Show", each with where it came from when shown.
 *  The stage itself folds only when the person folds it (remembered on
 *  this device). */
function Stage({ id, projectId, title, rows, tz, editing }: { id: string; projectId: string; title: string; rows: Row[]; tz: string; editing?: string | null }) {
  const key = `needs.fold:${projectId}:${id}`;
  const [folded, setFolded] = useState(() => { try { return localStorage.getItem(key) === "1"; } catch { return false; } });
  const fold = (v: boolean) => { setFolded(v); try { if (v) localStorage.setItem(key, "1"); else localStorage.removeItem(key); } catch { /* this device only */ } };
  const [showSettled, setShowSettled] = useState(false);
  const open = rows.filter((r) => r.state === "open").length;
  const set = rows.filter((r) => r.state === "set").length;
  const settings = rows.filter((r) => r.state !== "info").length;
  const todo = rows.filter((r) => r.state === "open");
  const info = rows.filter((r) => r.state === "info");
  const settled = rows.filter((r) => r.state === "set" || r.state === "default");
  const onDefault = settled.length - set;
  // A setting being changed stays in sight while it's open.
  const settledOpen = showSettled || settled.some((r) => r.id === editing);
  return (
    <section className="min-w-0" data-need-stage={id}>
      <h3>
        <button type="button" onClick={() => fold(!folded)} aria-expanded={!folded}
          className="w-full flex items-center gap-3 px-4 sm:px-5 h-11 text-left bg-[var(--color-surface-2)] hover:bg-[color-mix(in_srgb,var(--color-text)_5%,var(--color-surface-2))] transition-colors">
          <ChevronDown aria-hidden className={`ui-chevron w-4 h-4 shrink-0 text-[var(--color-text-muted)] ${folded ? "-rotate-90" : ""}`} />
          <span className="font-display text-reading font-semibold text-[var(--color-text)]">{title}</span>
          <span className={`text-body tabular-nums ${open ? "font-medium text-[var(--state-held-text)]" : "text-[var(--color-text-muted)]"}`}>{open ? `${open} to do` : settings ? `${set} of ${settings} set` : `${rows.length}`}</span>
        </button>
      </h3>
      {!folded && (
        <ul className="py-2">
          {todo.map((r) => <NeedRow key={r.id} r={r} tz={tz} />)}
          {info.map((r) => <NeedRow key={r.id} r={r} tz={tz} />)}
          {settled.length > 0 && (
            <li>
              <button type="button" onClick={() => setShowSettled((v) => !v)} aria-expanded={settledOpen}
                className="w-full flex items-center gap-2 px-4 sm:px-5 min-h-11 text-left text-body text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] transition-colors">
                <ChevronDown aria-hidden className={`ui-chevron w-4 h-4 shrink-0 ${settledOpen ? "" : "-rotate-90"}`} />
                <span className="tabular-nums">
                  {set > 0 && `${set} set`}{set > 0 && onDefault > 0 && ", "}{onDefault > 0 && `${onDefault} on the app default`}
                </span>
                <span aria-hidden>·</span>
                <span className="font-medium text-[var(--color-accent-text)]">{settledOpen ? "Hide" : "Show"}</span>
              </button>
            </li>
          )}
          {settledOpen && settled.map((r) => <NeedRow key={r.id} r={r} tz={tz} quiet />)}
        </ul>
      )}
    </section>
  );
}

/** A row's one way to change it: a quiet link, not a boxed button. */
const changeLink = "inline-flex items-center min-h-8 pointer-coarse:min-h-11 text-body font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2 whitespace-nowrap disabled:opacity-50 disabled:no-underline";

export default function ProjectNeeds({ orgId, project, jobKind, phases, steps, members, canManage, uid, userEmail, refreshKey = 0, onPhases, onEdit, onTab, onLessons, onJobKind }: {
  orgId: string; project: Project; jobKind: string | null; phases: ProjectPhase[];
  /** The whole schedule (every phase, nothing cancelled); null while it's read. */
  steps: Milestone[] | null;
  members: ProjectMember[]; canManage: boolean; uid: string; userEmail: string | null;
  /** Bumped when the page re-reads. */
  refreshKey?: number;
  onPhases: () => void; onEdit: () => void; onTab: (tab: string) => void; onLessons: () => void;
  /** The job size changed (the page keeps it). */
  onJobKind: (kind: string) => void;
}) {
  const projectId = project.id!;
  const tz = project.timezone || "America/Los_Angeles";
  const ms = useMemo(() => steps ?? [], [steps]);
  const hasBaseline = useMemo(() => ms.some((m) => m.baselineFinishAt), [ms]);
  const { items: setup, critical } = useSetupItems({ projectId, timezone: project.timezone, milestones: ms, hasBaseline });
  const { times, loaded: timesLoaded } = useShiftTimesState(projectId);
  const shiftsSaved = useShiftTimesSaved(projectId);
  const lh = useLetterhead(projectId).lh;
  const crew = useCrewSettings(projectId);
  // What the job taught: Mark complete asks for this review to be finished first.
  const findings = useFindingsReview(orgId, projectId);
  const left = findings.ready && !findings.missing ? findings.state.toReview.length : 0;
  const actor = useMemo(() => ({ uid, email: userEmail }), [uid, userEmail]);
  const by = userEmail ?? null;

  // Opened before in this sign-in: the list as it read then, at once, while
  // it reads afresh (kept per workspace, account and project).
  const factsKey = `needs:${orgId}|${projectId}|${uid}`;
  const [facts, setFacts] = useState<Facts | null>(() => lastLoaded<Facts>(factsKey) ?? null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let live = true;
    void readFacts(orgId, projectId).then((f) => { if (live) setFacts(f); keepLoaded(factsKey, f); });
    return () => { live = false; };
  }, [orgId, projectId, refreshKey, tick, factsKey]);
  // A change made anywhere on the page (Close-out's PSSR, Setup, the roles) re-reads.
  useEffect(() => {
    const evs = [CLOSEOUT_CHANGED, SETUP_CLOSED_EVENT, ORG_CHANGED];
    evs.forEach((e) => window.addEventListener(e, reload));
    return () => evs.forEach((e) => window.removeEventListener(e, reload));
  }, [reload]);

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<"afe" | "turnover" | null>(null);
  const [newDoc, setNewDoc] = useState("");
  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(key); setErr(null);
    try { const r = await fn(); if (!r.ok) setErr(r.error ?? "Not saved."); else reload(); }
    catch (e) { setErr(sayError(e)); }
    finally { setBusy(null); }
  };

  const nameOf = useCallback((id: string | null | undefined) => {
    if (!id) return null;
    const m = members.find((x) => x.userId === id);
    return m?.userName || m?.userEmail || (id === project.ownerUserId ? project.ownerUserName ?? null : null);
  }, [members, project.ownerUserId, project.ownerUserName]);
  const madeStamp: Stamp = { at: project.createdAt ? String(project.createdAt) : null, by: nameOf(project.createdBy) };
  const item = (id: SetupItemId) => setup.find((i) => i.id === id);
  const change = (id: SetupItemId, label = "Change") => (canManage ? <button type="button" onClick={() => requestSetup(id)} className={changeLink} data-setup-open={id}>{label}</button> : undefined);
  const checking = <span role="status" aria-label="Checking" className="inline-flex w-40 max-w-full align-middle"><Skeleton className="w-full" /></span>;

  // ── Before the work ──
  const type = projectTypeOf(times.projectType, project.name);
  const typeSet = projectTypeSet(times.projectType);
  const nj = times.nightJobs;
  const baselineAt = useMemo(() => { const t = ms.map((m) => Date.parse(String(m.baselineSetAt ?? ""))).filter(Number.isFinite); return t.length ? Math.max(...t) : null; }, [ms]);
  const contractors = useMemo(() => {
    if (!crew) return null;
    const crews = [...new Set(ms.map((m) => m.responsibleParty?.trim() ?? "").filter(Boolean))];
    return contractorList(crews, [], crew).filter((c) => c.crews.length);
  }, [crew, ms]);
  const withPlan = contractors?.filter((c) => !!crew?.staffing[c.company]).map((c) => c.company) ?? [];
  const noPlan = contractors?.filter((c) => !crew?.staffing[c.company]).map((c) => c.company) ?? [];
  const withRates = contractors?.filter((c) => !!crew?.rateSheets[c.company]).map((c) => c.company) ?? [];
  const crewStamp = crew ? latestStamp([...Object.values(crew.staffing).map((p) => ({ at: p.at, by: p.by })), ...Object.values(crew.rateSheets).map((r) => ({ at: r.at ?? null, by: r.by ?? null }))]) : null;
  const afe = facts?.afe ?? null;
  const afeLast = facts ? [...facts.afeHist].reverse().find((h) => h.at) ?? null : null;
  const snap = facts?.snap ?? null;
  const ss = facts?.setupState ?? null;
  const missingInfo = snap ? [!snap.hasPurpose && "purpose", !snap.hasGoals && "goals", !snap.hasSow && "Summary of Work"].filter(Boolean) as string[] : [];
  const usual = seedsForJobKind(jobKind);

  const before: Row[] = [
    {
      id: "phases", name: "Phases",
      value: phases.length ? <>{plural(phases.length, "phase")}: {phases.map((p) => `${p.name} (${phaseDates(p).replace(" – ", " to ")})`).join(", ")}. Each has its own schedule, review and PSSR.</> : "One schedule for the whole project.",
      source: phases.length ? { kind: "set" } : { kind: "default", note: "one phase, the whole project" },
      state: phases.length ? "set" : "default",
      action: canManage ? <button type="button" onClick={onPhases} className={changeLink}>Change</button> : undefined,
    },
    {
      id: "jobsize", name: "Job size",
      value: <>{jobSizeWord(jobKind)}. The usual turnover list for it has {plural(usual.length, "document")}.</>,
      source: facts?.stamps.jobKind ? { kind: "set", stamp: facts.stamps.jobKind } : ss ? { kind: "made", stamp: madeStamp } : { kind: "default", note: "Standard project" },
      state: jobKind ? "set" : "default",
      action: canManage ? (
        <label className="inline-flex items-center md:w-full">
          <span className="sr-only">Job size</span>
          <select value={jobKind ?? "standard"} disabled={busy === "jobsize"} onChange={(e) => {
            const k = e.target.value as "small" | "standard" | "capital";
            void run("jobsize", async () => { const r = await saveJobKind(projectId, k, by); if (r.ok) onJobKind(k); return r; });
          }} className={`${fieldBox} h-9 pointer-coarse:h-11 md:w-full text-body max-sm:text-reading`}>
            {JOB_SIZES.map((j) => <option key={j.v} value={j.v}>{j.label}</option>)}
          </select>
        </label>
      ) : undefined,
    },
    {
      id: "type", name: "Project type",
      value: typeSet ? type.word : <>Read from the name: {type.word}</>,
      source: typeSet ? { kind: "set" } : { kind: "default", note: "read from the project's name" },
      state: typeSet ? "set" : "default", action: change("type"),
    },
    {
      id: "timezone", name: "Plant time zone",
      value: project.timezone ? tzLabel(project.timezone) : "Not set",
      source: project.timezone ? { kind: "set" } : { kind: "default", note: "UTC, so shifts and plan-by-now are hours off" },
      state: project.timezone ? "set" : "open", action: change("timezone"),
    },
    {
      id: "shifts", name: "Shift change times",
      value: !timesLoaded || shiftsSaved == null ? checking : shiftsSaved ? `Day starts ${ampm(times.dayStart)}, night starts ${ampm(times.nightStart)}` : "Not set",
      source: shiftsSaved ? { kind: "set" } : shiftsSaved === false ? { kind: "default", note: `day starts ${ampm(times.dayStart)}, night starts ${ampm(times.nightStart)} until set` } : null,
      state: shiftsSaved ? "set" : shiftsSaved === false ? "open" : "info", action: change("shifts"),
    },
    {
      id: "night", name: "Night shifts",
      value: !timesLoaded ? checking : nj === undefined ? "Not decided" : nj === "file" ? "As the schedule file has them" : nj.length ? `${plural(nj.length, "job")} run nights; the rest is day work` : "No night work: every job is day work",
      source: !timesLoaded ? null : nj === undefined ? { kind: "default", note: "every step the file put in night hours goes to nights" } : { kind: "set" },
      state: !timesLoaded ? "info" : nj === undefined ? "open" : "set", action: change("night"),
    },
    {
      id: "critical", name: "Critical path",
      value: critical ? CRITICAL_MODES.find((c) => c.value === critical)?.label ?? critical : "Not chosen",
      source: critical ? { kind: "set" } : { kind: "default", note: "read from the links, else the file, else the app's estimate" },
      state: critical ? "set" : "default", action: change("critical"),
    },
    {
      id: "baseline", name: "Baseline",
      value: hasBaseline ? "Progress is measured against the plan as captured." : "None. Progress is measured against today's plan.",
      source: hasBaseline ? { kind: "set", stamp: baselineAt ? { at: baselineAt } : null } : { kind: "default", note: "no baseline" },
      state: hasBaseline ? "set" : "default", action: change("baseline"),
    },
    {
      id: "equipment", name: "Units & equipment",
      // No schedule yet: nothing to set (the setup check counts that as done).
      value: !ms.length ? "No work orders yet." : item("equipment")?.checking ? checking : item("equipment")?.done ? "Set for every work order" : "Not set",
      source: ms.length && item("equipment")?.done ? { kind: "set" } : { kind: "default", note: "optional" },
      state: ms.length && item("equipment")?.done ? "set" : "default", action: change("equipment"),
    },
    {
      id: "roles", name: "Roles & responsibilities",
      value: !facts ? checking : !facts.org?.recorded ? "Not filled in" : `${facts.org.filled} of ${plural(facts.org.required, "required role")} named`,
      source: !facts ? null : facts.org?.recorded ? { kind: "set", stamp: facts.org.at != null || facts.org.by ? { at: facts.org.at, by: facts.org.by } : null } : { kind: "asked", by: "the post-event review", note: "its Organization line reads it" },
      state: !facts ? "info" : facts.org?.recorded && facts.org.filled === facts.org.required ? "set" : "open", action: change("roles"),
    },
    {
      id: "staffing", name: "Staffing plans and rate sheets",
      value: !contractors ? checking : !contractors.length ? "No contractor crews on the schedule yet." : <>
        {withPlan.length ? `Plans in for ${joinWords(withPlan)}.` : "No staffing plans in."}{noPlan.length && withPlan.length ? ` None for ${joinWords(noPlan)}.` : ""}{" "}
        {withRates.length ? `Rate sheets in for ${joinWords(withRates)}.` : "No rate sheets in."}
      </>,
      source: !contractors ? null : crewStamp ? { kind: "set", stamp: crewStamp } : { kind: "asked", by: "the post-event review and the shift meeting's head counts" },
      state: !contractors ? "info" : contractors.length && !noPlan.length && withRates.length === contractors.length ? "set" : contractors.length ? "open" : "default",
      action: change("manpower"),
    },
    {
      id: "budget", name: "Budget (AFE)",
      value: !facts ? checking : afe?.authorized != null ? `${afe.afeNumber ? `AFE ${afe.afeNumber}, ` : ""}${money(afe.authorized)} authorized` : "Not set",
      source: !facts ? null : afe?.authorized != null ? { kind: "set", stamp: afeLast ? { at: afeLast.at, by: afeLast.by } : null, note: afeLast?.note ? `${afeLast.note[0].toLowerCase()}${afeLast.note.slice(1)}` : undefined } : ss?.budget === "skipped" ? { kind: "skipped", stamp: madeStamp } : { kind: "asked", by: "the post-event review", note: "budget against spend" },
      state: !facts ? "info" : afe?.authorized != null ? "set" : "open",
      action: canManage && facts && editing !== "afe" ? <button type="button" onClick={() => setEditing("afe")} className={changeLink}>Change</button> : undefined,
      body: editing === "afe" && facts ? (
        <div className="mt-2">
          <AfeEditor orgId={orgId} projectId={projectId} afe={afe ?? { afeNumber: null, chargeAccount: null, authorized: null, docId: null }} actor={actor} cur="USD" quietSave
            onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
        </div>
      ) : undefined,
    },
    {
      id: "info", name: "Purpose, goals and Summary of Work",
      value: !snap ? checking : missingInfo.length ? `No ${joinWords(missingInfo)} yet.` : "All written.",
      source: !snap ? null : !missingInfo.length ? { kind: "set" } : ss && (ss.sow === "skipped" || ss.purpose === "skipped") ? { kind: "skipped", stamp: madeStamp } : { kind: "asked", by: "the project report" },
      state: !snap ? "info" : missingInfo.length ? "default" : "set",
      action: canManage ? <button type="button" onClick={onEdit} className={changeLink}>Change</button> : undefined,
    },
    {
      id: "print", name: "Printed reports and slides",
      value: lh ? `Letterhead: ${lh.name}` : "Plain pages, no letterhead",
      source: lh ? { kind: "set", stamp: lh.savedAt ? { at: lh.savedAt } : null } : { kind: "default", note: "reports print on plain pages" },
      state: lh ? "set" : "default", action: change("print"),
    },
  ];

  // ── Every shift ──
  const shift: Row[] = [
    {
      id: "heads", name: "Head count at each shift meeting", value: "Taken on Shift, at the meeting.",
      source: { kind: "asked", by: "the post-event review", note: "man-hours and labor cost are worked out from it" }, state: "info",
      action: <button type="button" onClick={() => onTab("today")} className={changeLink}>Open Shift</button>,
    },
    {
      id: "incidents", name: "Incident line on each shift report", value: "Answered on Shift, in the report.",
      source: { kind: "asked", by: "the post-event review", note: "its safety line reads it" }, state: "info",
    },
    {
      id: "materials", name: "Materials register",
      value: !facts ? checking : facts.materials == null ? "Couldn't be read." : facts.materials ? `${plural(facts.materials, "line")}.` : "Empty.",
      source: { kind: "asked", by: "the post-event review", note: "parts each job needed, against what was ordered" },
      state: !facts || facts.materials == null ? "info" : facts.materials ? "set" : "open",
      action: <button type="button" onClick={() => onTab("materials")} className={changeLink}>Open Materials</button>,
    },
  ];

  // ── To close ──
  const cs = facts?.closeout ?? null;
  const byPhase = cs?.pssrByPhase ?? {};
  const pssrOf = (id: string | null) => {
    const v = id ? byPhase[id] : { notNeeded: cs?.pssr === "not_needed", at: cs?.pssrAt ?? null, by: cs?.pssrBy ?? null };
    const list = id ? (v?.checklistId ? facts?.pssrs?.find((x) => x.list.id === v.checklistId) : undefined) : facts?.pssrs?.[0];
    return { v, list, needed: !v?.notNeeded, ok: !!v?.notNeeded || listOk(list) };
  };
  const pssrRows = (phases.length ? phases.map((p) => ({ id: p.id as string | null, name: p.name })) : [{ id: null, name: "The job" }]).map((x) => ({ ...x, ...pssrOf(x.id) }));
  const pssrBody = facts && cs && facts.pssrs ? (
    <div className="mt-2 grid gap-3">
      {pssrRows.map((x) => (
        <div key={x.id ?? "job"} className="flex items-center gap-x-3 gap-y-1.5 flex-wrap">
          <span className="min-w-0 flex-1 basis-40">
            <span className="block text-body font-medium text-[var(--color-text)]">{x.name}</span>
            <span className="block text-body text-[var(--color-text)]">{!x.needed ? "Not needed" : x.list ? `${x.list.satisfied} of ${x.list.applicable} items done` : "Not uploaded yet"}</span>
            <SourceLine source={pssrSource(x.v, phases.length > 0)} tz={tz} />
          </span>
          {canManage
            ? <NeededChoice needed={x.needed} what={`${x.name}'s PSSR`} disabled={!!busy || (!!x.list && x.needed)} onChange={(v) => void run(`pssr:${x.id}`, () => savePssrNeeded(projectId, x.id, v, by))} />
            : null}
        </div>
      ))}
    </div>
  ) : null;

  const items = facts?.items ?? null;
  const required = (items ?? []).filter((i) => i.required);
  const inCount = required.filter((i) => i.status === "accepted" || i.status === "waived").length;
  const turnoverBody = editing === "turnover" && items ? (
    <div className="mt-2">
      {items.length > 0 && (
        <ul>
          {items.map((it) => (
            <li key={it.id} className={`py-1.5 flex items-center gap-3 text-body ${it.required ? "" : "opacity-70"}`}>
              <Switch on={it.required} label={`${it.name} needed for this project`} disabled={!canManage || !!busy}
                onChange={() => void run(it.id, () => updateTurnoverItem({ item: it, patch: { required: !it.required }, actor }))} />
              <span className="min-w-0 flex-1 break-words text-[var(--color-text)]" title={it.description ?? undefined}>{it.name}</span>
              <span className="shrink-0 text-body text-[var(--color-text-muted)]">{it.required ? "Needed" : "Not needed"}</span>
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <div className="py-2 flex items-center gap-2 flex-wrap">
          {required.length === 0 && (
            <button type="button" disabled={!!busy} onClick={() => void run("seed", async () => { const r = await seedTurnoverItems({ orgId, projectId, jobKind, actor }); return { ok: r.ok, error: r.error }; })} className={changeLink}>
              Start from the usual list ({usual.length} for a {jobSizeWord(jobKind).toLowerCase()})
            </button>
          )}
          <input value={newDoc} onChange={(e) => setNewDoc(e.target.value)} aria-label="Add a document this project needs" placeholder="e.g. Hydrotest record"
            onKeyDown={(e) => { if (e.key === "Enter" && newDoc.trim()) { const n = newDoc.trim(); setNewDoc(""); void run("add", () => addTurnoverItem({ orgId, projectId, name: n, required: true, actor })); } }}
            className={`${fieldBox} h-9 pointer-coarse:h-11 flex-1 min-w-40 text-body max-sm:text-reading`} />
          <Button size="sm" variant="secondary" disabled={!newDoc.trim() || !!busy} title={!newDoc.trim() ? "Type the document's name first" : undefined}
            onClick={() => { const n = newDoc.trim(); setNewDoc(""); void run("add", () => addTurnoverItem({ orgId, projectId, name: n, required: true, actor })); }}>
            <Plus className="w-3.5 h-3.5" /> Add
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>Done</Button>
        </div>
      )}
    </div>
  ) : null;

  const close: Row[] = [
    {
      id: "pssr", name: phases.length ? "PSSR for each phase" : "PSSR",
      value: !facts ? checking : !facts.pssrs || !cs ? "Couldn't be read." : pssrRows.every((x) => !x.needed) ? "Not needed for this project." : `${pssrRows.filter((x) => x.needed && x.ok).length} of ${pssrRows.filter((x) => x.needed).length} in. Uploaded on Close-out when the work is done.`,
      source: null,
      state: !facts || !facts.pssrs || !cs ? "info" : pssrRows.every((x) => x.ok) ? "set" : "open",
      body: pssrBody,
    },
    {
      id: "turnover", name: "Turnover documents",
      value: !facts ? checking : !items ? "Couldn't be read." : required.length ? `${plural(required.length, "document")} needed, ${inCount} in and accepted.` : "None needed.",
      source: items ? turnoverSource(items, project.createdAt ? String(project.createdAt) : null, nameOf) : null,
      state: !items ? "info" : required.length ? (inCount >= required.length ? "set" : "open") : "default",
      action: canManage && items && editing !== "turnover" ? <button type="button" onClick={() => setEditing("turnover")} className={changeLink}>Change</button> : undefined,
      body: turnoverBody,
    },
    {
      id: "punch", name: "Punch list cleared",
      value: !snap ? checking : snap.punchOpen ? `${snap.punchOpen} open` : "Nothing open",
      source: { kind: "default", note: "open punch items count as left to close" },
      state: !snap ? "info" : snap.punchOpen ? "open" : "set",
      action: <button type="button" onClick={() => onTab("quality")} className={changeLink}>Open Quality</button>,
    },
    {
      id: "co", name: "Change orders decided",
      value: !snap ? checking : snap.openChangeOrders ? `${snap.openChangeOrders} waiting on a decision` : "None waiting",
      source: { kind: "default", note: "change orders waiting on a decision count as left to close" },
      state: !snap ? "info" : snap.openChangeOrders ? "open" : "set",
      action: <button type="button" onClick={() => onTab("costs")} className={changeLink}>Open Costs</button>,
    },
    {
      id: "checklists", name: "Checklists resolved",
      value: !snap ? checking : !snap.checklistCount ? "No checklists on this project." : snap.checklistOpenItems + snap.checklistNeedsEvidence ? `${plural(snap.checklistOpenItems + snap.checklistNeedsEvidence, "item")} not resolved` : "All resolved",
      source: { kind: "default", note: "unresolved items are listed when you mark the project complete" },
      state: !snap ? "info" : !snap.checklistCount ? "default" : snap.checklistOpenItems + snap.checklistNeedsEvidence ? "open" : "set",
      action: <button type="button" onClick={() => onTab("quality")} className={changeLink}>Open Quality</button>,
    },
    {
      id: "cost", name: "Final cost posted",
      value: !snap ? checking : snap.spent === 0 ? `No invoices in yet${afe?.authorized != null ? ` (AFE ${money(afe.authorized)})` : ""}` : `${money(snap.spent)} invoiced${afe?.authorized != null ? ` of ${money(afe.authorized)} AFE` : ""}`,
      source: { kind: "asked", by: "Close-out", note: "post the last invoices before closing" }, state: "info",
      action: <button type="button" onClick={() => onTab("costs")} className={changeLink}>Open Costs</button>,
    },
    {
      id: "targets", name: "Review targets", value: "Set on the post-event review's score, phase by phase.",
      source: { kind: "asked", by: "the post-event review" }, state: "info",
      action: <button type="button" onClick={() => { openCloseoutView("review"); onTab("closeout"); }} className={changeLink}>Open the review</button>,
    },
    {
      id: "lessons", name: "Lessons & findings",
      value: !findings.ready ? checking : findings.missing ? `Can't be kept yet: run supabase/migrations/${FINDINGS_SQL} in the Supabase SQL editor.` : left ? `${plural(left, "finding")} to review, ${findings.state.kept.length} kept so far.` : `Reviewed, ${findings.state.kept.length} kept.`,
      source: { kind: "asked", by: "Mark complete", note: "it asks you to finish this review first" },
      state: !findings.ready || findings.missing ? "info" : left ? "open" : "set",
      action: <button type="button" onClick={onLessons} className={changeLink}>Open</button>,
    },
  ];

  const todo = toDo(setup).length;
  // How many needs are left to do, over all three stages: the card's lead.
  const openCount = [...before, ...shift, ...close].filter((r) => r.state === "open").length;
  // The row whose editor is open (the AFE's is the Budget row).
  const editingRow = editing === "afe" ? "budget" : editing;
  return (
    <Card label="What this project needs" pad={false} className="overflow-hidden"
      action={<span className="flex items-center gap-3">
        {busy && <span role="status" className="inline-flex items-center gap-1.5 text-body text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving</span>}
        {canManage && (
          <button type="button" onClick={() => requestSetup()} className={heroQuiet} data-needs-setup>
            <Settings2 className="w-4 h-4" /> Setup{todo ? <span className="font-medium text-[var(--state-held-text)]">{`${todo} to do`}</span> : <Check aria-label="all set" className="w-4 h-4 text-[var(--state-released-text)]" />}
          </button>
        )}
      </span>}>
      <div className="px-4 sm:px-5 pt-5 pb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1" data-needs-left={facts ? openCount : undefined}>
        {facts
          ? <span className="font-display text-title sm:text-hero leading-none font-bold tabular-nums text-[var(--color-text)]">{openCount}</span>
          : <Skeleton className="w-10 h-10" />}
        <span className="text-reading font-medium text-[var(--color-text)]">left to do</span>
      </div>
      {(!canManage || err) && (
        <div className="px-4 sm:px-5 pb-3 space-y-1">
          {!canManage && <p className="text-body text-[var(--color-text-muted)]">The project owner, a co-owner or an admin changes these.</p>}
          {err && <ErrorNote compact title={err} next="" />}
        </div>
      )}
      {/* The columns, once, over all three stages (wide screens). */}
      <div aria-hidden className={`${COLS} max-md:hidden px-4 sm:px-5 h-9 items-center text-body text-[var(--color-text-muted)]`}>
        <span>Need</span><span>Set to, and where that came from</span><span>Status</span><span />
      </div>
      <Stage id="before" projectId={projectId} title="Before the work" rows={before} tz={tz} editing={editingRow} />
      <Stage id="shift" projectId={projectId} title="Every shift" rows={shift} tz={tz} editing={editingRow} />
      <Stage id="close" projectId={projectId} title="To close" rows={close} tz={tz} editing={editingRow} />
    </Card>
  );
}
