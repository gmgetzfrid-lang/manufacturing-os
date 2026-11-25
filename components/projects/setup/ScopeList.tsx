"use client";

// ScopeList - a project in planning, driven from its work order list (Plan
// tab). On top, the planning path: Scope, Packages, Schedule, RFQ, Award,
// each with where it stands, and one button for the next thing to do (then
// the work, and close-out). Under it, the scope itself: counts, who is still
// adding scope, the work grouped as the list groups it, and on each work
// order its package (attached into document control, numbered, shared by
// every work order on the same piece of equipment) and whether it's
// approved. Once a schedule is in, each work order is matched to it by
// number: missing from the schedule, and on the schedule but not in the
// list, are named. "Import the list again" shows what changed before
// anything changes; packages stay with their work orders.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, FileSpreadsheet, FileText, Paperclip, Upload, Package, CalendarRange, Handshake, Pencil, X, RotateCcw, Plus } from "lucide-react";
import { planningPath, scheduleMatch, type PathKey } from "@/lib/planningPath";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { appConfirm, appPrompt } from "@/components/providers/DialogProvider";
import { cancelMilestone, restoreCancelledMilestone } from "@/lib/milestones";
import { field as fieldCls } from "@/components/admin/kit";
import { sayError } from "@/components/projects/sayError";
import ProjectFilePlace, { useProjectFileHome } from "@/components/projects/ProjectFilePlace";
import JobsScheduleDialog from "@/components/projects/setup/JobsScheduleDialog";
import RfqDialog from "@/components/projects/setup/RfqDialog";
import { uploadProjectFile } from "@/lib/projectUpload";
import { applyScope, byCategory, diffScope, isTypedItem, packageGroup, pickSheet, readScope, shared, typedItem, woKey, type ScopeDiff, type ScopeRead, type ScopeWO, type WoOnSchedule } from "@/lib/woIntake";
import { InlineAddRow, type AddField } from "@/components/ui/InlineAddRow";
import Timeline, { type TimelineItem, type TimelineTone } from "@/components/ui/Timeline";
import UserAvatar from "@/components/ui/UserAvatar";
import { loadScope, readSheets, saveScope, scheduleFacts, LIST_ACCEPT, OPEN_SCHEDULE_IMPORT, TYPED_SOURCE, type RemovedWO, type ScheduleFacts, type ScopeChange, type ScopeState } from "@/lib/scopeStore";

const SHOW = 6;
const when = (iso: string, tz?: string) => new Date(iso).toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
/** A change to the scope on the timeline: the word and its dot. */
const KIND: Record<ScopeChange["kind"], { word: string; tone: TimelineTone }> = {
  added: { word: "Added", tone: "good" },
  removed: { word: "Removed", tone: "bad" },
  edited: { word: "Edited", tone: "info" },
  "put back": { word: "Put back", tone: "info" },
};

export default function ScopeList({ orgId, projectId, projectName, uid, canManage, noSchedule, actorEmail, finish, tz }: {
  orgId: string; projectId: string; projectName: string; uid: string | null; canManage: boolean; noSchedule: boolean; actorEmail?: string;
  /** The plant's time zone, for a schedule made from the jobs. */
  tz: string;
  /** The target completion ("YYYY-MM-DD"), for the RFQ. */
  finish?: string;
}) {
  const [scope, setScope] = useState<ScopeState | null | undefined>(undefined);
  const [facts, setFacts] = useState<ScheduleFacts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<{ file: File; read: ScopeRead; diff: ScopeDiff } | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [attaching, setAttaching] = useState<string | null>(null);
  const [rfqOpen, setRfqOpen] = useState(false);
  const [makeOpen, setMakeOpen] = useState(false);
  const [needPlace, setNeedPlace] = useState(false);
  // "Add a job" under the list opens its boxes (the list is the main job here).
  const [adding, setAdding] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pkgInput = useRef<HTMLInputElement>(null);
  const pkgFor = useRef<string | null>(null);
  const { home, setHome } = useProjectFileHome(orgId, projectId);

  const load = useCallback(() => {
    loadScope(projectId).then(setScope, () => setScope(null));
    scheduleFacts(projectId).then(setFacts, () => setFacts(null));
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => (scope ? byCategory(scope.items) : []), [scope]);
  const vs = useMemo(() => (scope ? scheduleMatch(scope.items, facts) : null), [scope, facts]);

  const save = async (next: ScopeState) => { await saveScope(projectId, next); setScope(next); };

  const apply = async (file: File, read: ScopeRead, diff?: ScopeDiff) => {
    const at = new Date().toISOString();
    await save({
      // Everything else stays: steps marked not needed, removed work, changes.
      ...(scope ?? {}),
      // Removed here stays removed; work added here stays; new work is dated.
      items: applyScope(scope?.items ?? [], read.items, (scope?.removed ?? []).map((r) => r.wo), at), coming: read.coming,
      source: { file: file.name, sheet: read.sheet, headers: read.headers, map: read.map },
      imports: [...(scope?.imports ?? []), { at, by: actorEmail, file: file.name, sheet: read.sheet, added: diff?.added.length ?? read.items.length, changed: diff?.changed.length ?? 0, dropped: diff?.dropped.length ?? 0 }],
      rfqs: scope?.rfqs ?? [],
    });
    setIncoming(null);
  };

  const take = async (f: File | undefined) => {
    if (!f) return;
    setError(null); setBusy(true);
    try {
      const sheets = (await readSheets(f)).filter((s) => s.rows.length > 0);
      const i = scope ? sheets.findIndex((s) => s.name === scope.source.sheet) : -1;
      const sheet = sheets[i >= 0 ? i : pickSheet(sheets)];
      if (!sheet) throw new Error("That file has no rows in it.");
      const sameLayout = scope && sheet.rows.some((r) => r.join("|") === scope.source.headers.join("|"));
      const read = readScope(sheet, sameLayout ? scope!.source.map : undefined);
      if (!read.items.length) throw new Error("No work order numbers found in it. Check it's the work order list.");
      if (!scope) { await apply(f, read); return; }
      setIncoming({ file: f, read, diff: diffScope(scope.items, read.items, (scope.removed ?? []).map((r) => r.wo)) });
    } catch (e) {
      setError(sayError(e));
    } finally { setBusy(false); }
  };

  const confirmApply = async () => {
    if (!incoming) return;
    const n = incoming.diff.dropped.length;
    if (n && !(await appConfirm({ title: `Drop ${n} work order${n === 1 ? "" : "s"} from the scope?`, message: `${incoming.diff.dropped.map((x) => x.wo).join(", ")} ${n === 1 ? "is" : "are"} not in the new list. Dropping takes ${n === 1 ? "it" : "them"} off the project's scope.`, confirmLabel: `Drop ${n} and apply`, tone: "danger" }))) return;
    setBusy(true); setError(null);
    try { await apply(incoming.file, incoming.read, incoming.diff); } catch (e) { setError(sayError(e)); } finally { setBusy(false); }
  };

  // ── Packages ──
  const pickPackage = (wo: string) => {
    // Where packages are filed is asked once, at the top: go there to ask it.
    if (!home?.place) { setNeedPlace(true); setError(null); document.querySelector("[aria-label='Planning path']")?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    pkgFor.current = wo; pkgInput.current?.click();
  };
  const attach = async (file: File | undefined) => {
    const wo = pkgFor.current;
    if (!file || !wo || !scope || !uid) return;
    const group = packageGroup(scope.items, wo);
    const first = group[0];
    setAttaching(wo); setError(null);
    try {
      const d = await uploadProjectFile({
        orgId, projectId, projectName, file, prefix: "PACKAGE", part: isTypedItem(wo) ? (first.tag || first.what.slice(0, 24)) : `WO ${wo}`,
        title: `Work package - ${[first.tag, first.equipmentName || first.equipment].filter(Boolean).join(" ") || first.what}${group.some((x) => !isTypedItem(x.wo)) ? ` - WO ${group.filter((x) => !isTypedItem(x.wo)).map((x) => x.wo).join(", ")}` : ""}`,
        actorUserId: uid, actorEmail,
      });
      const pkg = { documentId: d.documentId, label: d.label, href: `/documents/${home?.place?.libraryId ?? ""}?doc=${d.documentId}`, at: new Date().toISOString(), by: actorEmail };
      const ids = new Set(group.map((x) => x.wo));
      await save({ ...scope, items: scope.items.map((x) => (ids.has(x.wo) ? { ...x, pkg, drafted: true } : x)) });
    } catch (e) { setError(sayError(e)); } finally { setAttaching(null); pkgFor.current = null; }
  };
  const approve = async (wo: string) => {
    if (!scope) return;
    const ids = new Set(packageGroup(scope.items, wo).map((x) => x.wo));
    try {
      await save({ ...scope, items: scope.items.map((x) => (ids.has(x.wo) ? { ...x, approved: true, approvedBy: actorEmail, approvedAt: new Date().toISOString() } : x)) });
    } catch (e) { setError(sayError(e)); }
  };

  // ── Work typed in (no list, or a job that came in later) ──
  const blankScope = (): ScopeState => ({ items: [], coming: [], source: TYPED_SOURCE, imports: [] });
  const log = (base: ScopeState, ...c: Array<Omit<ScopeChange, "at" | "by">>): ScopeChange[] => {
    const at = new Date().toISOString();
    return [...(base.changes ?? []), ...c.map((x) => ({ ...x, at, by: actorEmail }))];
  };
  const addTyped = async (vals: Array<{ what: string; equipment?: string; wo?: string; group?: string }>, why?: string) => {
    const base = scope ?? blankScope();
    const at = new Date().toISOString();
    let items = base.items;
    const skipped: string[] = [];
    for (const v of vals) {
      if (!v.what?.trim()) continue;
      // One work order is on the scope once.
      const k = woKey(v.wo);
      if (k && items.some((x) => x.wo === k)) { skipped.push(`WO ${k} is already in the scope`); continue; }
      if (k && (base.removed ?? []).some((r) => r.wo === k)) { skipped.push(`WO ${k} was removed (put it back under Removed)`); continue; }
      items = [...items, { ...typedItem(v, items), addedAt: at }];
    }
    const added = items.slice(base.items.length);
    if (!added.length) return skipped.length ? `${skipped.join(". ")}.` : "Say what the work is.";
    try {
      await save({ ...base, items, changes: log(base, ...added.map((x) => ({ kind: "added" as const, wo: x.wo, what: x.what, ...(why ? { why } : {}) }))) });
      return { ok: true, text: `Added ${added.length}.${skipped.length ? ` ${skipped.join(". ")}.` : ""}` };
    } catch (e) { return { ok: false, text: sayError(e) }; }
  };

  // ── Changing the scope: remove (with why), put back, edit ──
  const nameOf = (x: ScopeWO) => (isTypedItem(x.wo) ? `"${x.what.length > 36 ? `${x.what.slice(0, 35)}...` : x.what}"` : `WO ${x.wo}`);
  const remove = async (x: ScopeWO) => {
    if (!scope || !uid) return;
    const on = facts?.byWo[x.wo];
    const live = on && !on.cancelled && on.steps > 0;
    // Its steps come off the schedule with it, unless they sit under a job
    // with other work orders (that's cancelled on the Work tab).
    const cancel = live && !on.mixed ? on.owners : [];
    const name = nameOf(x);
    const why = await appPrompt({
      title: `Remove ${name} from the scope?`,
      message: [
        cancel.length ? `Its ${on!.steps} step${on!.steps === 1 ? "" : "s"} on the schedule ${on!.steps === 1 ? "is" : "are"} cancelled with it.` : live ? "It's on the schedule under a job with other work orders: cancel its steps on the Work tab." : "",
        x.pkg ? "Its package stays in document control." : "",
        "You can put it back.",
      ].filter(Boolean).join(" "),
      placeholder: "Why (kept with the scope's changes)",
      confirmLabel: `Remove ${name}`, tone: "danger",
    });
    if (why === null) return;
    if (!why.trim()) { setError("Say why it's removed: it's kept with the scope's changes."); return; }
    setError(null);
    try {
      for (const id of cancel) await cancelMilestone({ id, note: `Removed from the scope: ${why.trim()}`, movedTo: "", actorUserId: uid, actorUserEmail: actorEmail });
      const gone: RemovedWO = { ...x, removedAt: new Date().toISOString(), removedBy: actorEmail, why: why.trim(), ...(cancel.length ? { cancelledIds: cancel } : {}) };
      await save({ ...scope, items: scope.items.filter((y) => y.wo !== x.wo), removed: [...(scope.removed ?? []), gone], changes: log(scope, { kind: "removed", wo: x.wo, what: x.what, why: why.trim() }) });
      if (cancel.length) { window.dispatchEvent(new CustomEvent("schedule:changed")); load(); }
    } catch (e) { setError(sayError(e)); }
  };
  const putBack = async (r: RemovedWO) => {
    if (!scope || !uid) return;
    setError(null);
    try {
      for (const id of r.cancelledIds ?? []) await restoreCancelledMilestone({ id, actorUserId: uid, actorUserEmail: actorEmail });
      const { removedAt, removedBy, why, cancelledIds, ...item } = r;
      await save({ ...scope, items: [...scope.items, item], removed: (scope.removed ?? []).filter((y) => y.wo !== r.wo), changes: log(scope, { kind: "put back", wo: r.wo, what: r.what }) });
      if (r.cancelledIds?.length) { window.dispatchEvent(new CustomEvent("schedule:changed")); load(); }
    } catch (e) { setError(sayError(e)); }
  };
  const saveEdit = async (x: ScopeWO, v: { what: string; equipment: string; wo: string }): Promise<string | null> => {
    if (!scope) return "The scope isn't loaded.";
    if (!v.what.trim()) return "Say what the work is.";
    // A job typed in without a number can be given its work order number.
    const k = woKey(v.wo);
    const wo = isTypedItem(x.wo) && k ? k : x.wo;
    if (wo !== x.wo && (scope.items.some((y) => y.wo === wo) || (scope.removed ?? []).some((y) => y.wo === wo))) return `WO ${wo} is already on the scope's record.`;
    const eqChanged = v.equipment.trim() !== x.equipment;
    const t = typedItem({ what: v.what, equipment: v.equipment }, []);
    const next: ScopeWO = { ...x, wo, what: t.what, ...(eqChanged ? { equipment: t.equipment, tag: t.tag, equipmentName: t.equipmentName } : {}) };
    const fields = [next.what !== x.what ? "description" : "", eqChanged ? "equipment" : "", wo !== x.wo ? "WO number" : ""].filter(Boolean);
    if (!fields.length) return null;
    try {
      await save({ ...scope, items: scope.items.map((y) => (y.wo === x.wo ? next : y)), changes: log(scope, { kind: "edited", wo, what: next.what, why: `${fields.join(", ")} changed` }) });
      return null;
    } catch (e) { return sayError(e); }
  };
  // On the schedule, not in the list: into the scope in one go.
  const addFromSchedule = async (wos: string[]) => {
    const r = await addTyped(wos.map((w) => ({ what: facts?.byWo[w]?.name || `WO ${w}`, wo: w, group: "From the schedule" })), "On the schedule, not in the list");
    if (typeof r === "string") setError(r); else if (!r.ok) setError(r.text);
  };
  const ADD_FIELDS: AddField[] = [
    { key: "what", label: "What the work is", placeholder: "e.g. Replace the 6\" gate valve", required: true },
    { key: "equipment", label: "Equipment", placeholder: "e.g. P-60" },
    { key: "wo", label: "WO number", placeholder: "If it has one" },
  ];
  // A planning step this job doesn't need (or does after all).
  const setSkip = async (key: PathKey, on: boolean) => {
    const base = scope ?? blankScope();
    const now = new Set(base.skipped ?? []);
    if (on) now.add(key); else now.delete(key);
    try { await save({ ...base, skipped: [...now] }); } catch (e) { setError(sayError(e)); }
  };

  if (scope === undefined) return null;
  const fileInput = <input ref={input} type="file" accept={LIST_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void take(e.target.files?.[0]); e.target.value = ""; }} />;
  // No work yet: the path still shows (adding the work first), for whoever
  // can plan it, until the project has a schedule of its own.
  if (!scope && (!canManage || !noSchedule)) return null;
  const sc = scope ?? blankScope();

  const n = sc.items.length;
  // "work orders" when the list has numbers; "jobs" for work typed in.
  const jobWord = sc.items.every((x) => isTypedItem(x.wo)) ? (n === 1 ? "job" : "jobs") : (n === 1 ? "work order" : "work orders");
  const equipment = new Set(sc.items.map((x) => x.equipment || x.wo)).size;
  const withPkg = sc.items.filter((x) => x.pkg || x.drafted).length;
  const approved = sc.items.filter((x) => x.approved).length;
  const conditional = sc.items.filter((x) => x.conditional).length;
  const many = shared(sc.items).length;
  const last = sc.imports[sc.imports.length - 1];
  const rfqs = sc.rfqs ?? [];
  const firstWithout = sc.items.find((x) => !x.pkg && !x.drafted);
  const onSched = new Set(vs?.on.map((x) => x.wo) ?? []);
  // Scope growth: what changed after the first RFQ went out.
  const since = rfqs[0]?.at;
  const addedSince = since ? sc.items.filter((x) => x.addedAt && x.addedAt > since).length : 0;
  const removedSince = since ? (sc.removed ?? []).filter((r) => r.removedAt > since).length : 0;
  const removed = sc.removed ?? [];
  const changes = sc.changes ?? [];

  // The planning path (lib/planningPath): where each step stands; the
  // first one not done is next. Here, what each step's button does.
  const path = planningPath(scope, facts);
  const nextIdx = path.next;
  // A schedule file to import, or (no file, as on a small job) one made from the jobs.
  const importSched = () => window.dispatchEvent(new Event(OPEN_SCHEDULE_IMPORT));
  const canMake = !facts?.steps && n > 0 && !!uid;
  const typedOnly = n > 0 && sc.items.every((x) => isTypedItem(x.wo));
  const actions: Partial<Record<PathKey, { label: string; run?: () => void; href?: string; alt?: { label: string; run: () => void } }>> = {
    scope: n ? undefined : { label: "Add the work", run: () => { document.getElementById("add-work")?.scrollIntoView({ behavior: "smooth", block: "center" }); (document.querySelector("#add-work input") as HTMLInputElement | null)?.focus(); } },
    pkg: firstWithout ? { label: `Attach the package for ${firstWithout.tag || (isTypedItem(firstWithout.wo) ? firstWithout.what.slice(0, 28) : `WO ${firstWithout.wo}`)}`, run: () => { if (home?.place) document.getElementById(`wo-${firstWithout.wo}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); pickPackage(firstWithout.wo); } }
      : approved < n ? { label: "Approve the packages", run: () => document.getElementById("scope-list")?.scrollIntoView({ behavior: "smooth" }) } : undefined,
    sched: !canMake ? { label: facts?.steps ? "Import the schedule again" : "Import the schedule", run: importSched }
      : typedOnly ? { label: "Make the schedule from the jobs", run: () => setMakeOpen(true), alt: { label: "Or import a schedule file", run: importSched } }
      : { label: "Import the schedule", run: importSched, alt: { label: "No schedule file? Make it from the jobs", run: () => setMakeOpen(true) } },
    rfq: { label: rfqs.length ? "Write another RFQ" : "Write the RFQ", run: () => setRfqOpen(true) },
    award: { label: "Open quotes", href: `/projects/${projectId}?tab=costs` },
  };
  const ICON: Record<PathKey, React.ComponentType<{ className?: string }>> = { scope: FileSpreadsheet, pkg: Package, sched: CalendarRange, rfq: FileText, award: Handshake };

  return (
    <div className="grid gap-4">
      {fileInput}
      <input ref={pkgInput} type="file" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void attach(e.target.files?.[0]); e.target.value = ""; }} />

      {/* The planning path: the five steps in order. The current one stands
          out (shaded, its button in it); done ones are checked; later ones
          sit back. The page's header says the next step in words. */}
      <section aria-label="Planning path" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 sm:p-4 grid gap-3">
        {/* Six columns: the current step takes two, so it and its button stand out. */}
        <ol className="grid gap-2 sm:grid-cols-6 sm:gap-3">
          {path.steps.map((s, i) => {
            const Icon = ICON[s.key];
            const now = i === nextIdx;
            const act = actions[s.key];
            return (
              <li key={s.key} className={`rounded-lg p-3 grid gap-1 content-start ${now ? "bg-[var(--color-surface-2)] ring-1 ring-inset ring-[var(--color-border-strong)] sm:col-span-2" : nextIdx < 0 && i === path.steps.length - 1 ? "sm:col-span-2" : ""}`}>
                <div className="flex items-center gap-2">
                  <span aria-hidden className={`shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full ${s.done ? "bg-[var(--state-released)] text-white" : now ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "border border-[var(--color-border-strong)] text-[var(--color-text-faint)]"}`}>
                    {s.done ? <Check className="w-4 h-4" /> : <Icon className="w-3.5 h-3.5" />}
                  </span>
                  <span className={`text-body ${now ? "font-semibold text-[var(--color-text)]" : s.done ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                    <span className="text-[var(--color-text-faint)] tabular-nums">{i + 1}.</span> {s.name}{s.done ? <span className="sr-only"> (done)</span> : now ? <span className="sr-only"> (next)</span> : null}
                  </span>
                </div>
                <p className={`text-caption min-w-0 ${now ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>{s.state}</p>
                {act && canManage && (now
                  ? (act.href
                    ? <Link href={act.href} className="mt-1 inline-flex items-center justify-center gap-1.5 min-h-10 pointer-coarse:min-h-11 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-body font-semibold hover:bg-[var(--color-accent-hover)]">{act.label}</Link>
                    : <Button className="mt-1 justify-self-start max-w-full" onClick={act.run} loading={s.key === "pkg" && !!attaching}>{act.label}</Button>)
                  : !s.done && (act.href
                    ? <Link href={act.href} className="inline-flex items-center min-h-9 pointer-coarse:min-h-11 text-caption font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">{act.label}</Link>
                    : <button type="button" onClick={act.run} className="justify-self-start inline-flex items-center min-h-9 pointer-coarse:min-h-11 text-caption font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">{act.label}</button>))}
                {act?.alt && canManage && now && <button type="button" onClick={act.alt.run} className="justify-self-start inline-flex items-center min-h-9 pointer-coarse:min-h-11 text-caption font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">{act.alt.label}</button>}
                {/* A small job can do without packages, an RFQ or an award. */}
                {canManage && s.key !== "scope" && s.key !== "sched" && (s.skipped
                  ? <button type="button" onClick={() => void setSkip(s.key, false)} className="justify-self-start inline-flex items-center min-h-9 pointer-coarse:min-h-11 text-caption font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">Needed after all</button>
                  : !s.done && <button type="button" onClick={() => void setSkip(s.key, true)} className="justify-self-start inline-flex items-center min-h-9 pointer-coarse:min-h-11 text-caption text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline underline-offset-2">Not needed for this job</button>)}
              </li>
            );
          })}
        </ol>
        <p className="px-1 text-caption text-[var(--color-text-muted)]">{nextIdx < 0 ? "Planning is done. " : ""}Then the work (a shift report every shift, on the Shift tab), then close-out. The project takes you to each.</p>
        {needPlace && home && uid && (
          <div className="rounded-lg border border-[var(--color-border-strong)] p-3 grid gap-2">
            <p className="text-body text-[var(--color-text)]">First, pick where this project&apos;s packages are filed in document control. It&apos;s asked once.</p>
            <ProjectFilePlace orgId={orgId} projectId={projectId} uid={uid} canManage={canManage} home={home} onChange={(h) => { setHome(h); if (h.place) setNeedPlace(false); }} what="the packages" />
          </div>
        )}
        {error && <ErrorNote title={error} />}
      </section>

      {n === 0 && (
        <section id="add-work" aria-labelledby="add-title" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 grid gap-3">
          <div>
            <h2 id="add-title" className="font-display text-section font-semibold text-[var(--color-text)]">Add the work</h2>
            <p className="text-body text-[var(--color-text-muted)] max-w-prose">Each job on its own line: what it is, and its equipment and work order number if it has them. Rows copied from Excel can be pasted into the first box. Or import a work order list.</p>
          </div>
          {canManage && <InlineAddRow fields={ADD_FIELDS} what="job" addLabel="Add" wrap
            onAdd={(v) => addTyped([{ what: v.what, equipment: v.equipment, wo: v.wo }])}
            onPasteRows={(rows) => addTyped(rows.map((r) => ({ what: r[0] ?? "", equipment: r[1], wo: r[2] })))} />}
          {canManage && <Button variant="secondary" className="justify-self-start" onClick={() => input.current?.click()} loading={busy}><Upload className="w-4 h-4" /> Import a work order list</Button>}
        </section>
      )}

      {n > 0 && scope && <section id="scope-list" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden" aria-labelledby="scope-title">
        <div className="px-5 pt-4 pb-3 flex flex-wrap items-start gap-x-4 gap-y-2">
          {/* On a phone the button goes under the title, so neither squeezes. */}
          <div className="min-w-0 flex-1 basis-full sm:basis-auto">
            <h2 id="scope-title" className="font-display text-section font-semibold text-[var(--color-text)]">Scope <span className="font-normal text-[var(--color-text-muted)] tabular-nums">· {n} {jobWord}</span></h2>
            <p className="text-caption text-[var(--color-text-muted)] break-words">{scope.source.sheet ? `From ${scope.source.file}, tab ${scope.source.sheet}${last ? `, imported ${when(last.at, tz)}${last.by ? ` by ${last.by}` : ""}` : ""}` : "Typed in on this page"}</p>
          </div>
          {canManage && <Button variant="secondary" onClick={() => input.current?.click()} loading={busy && !incoming}><Upload className="w-4 h-4" /> {scope.source.sheet ? "Import the list again" : "Import a work order list"}</Button>}
        </div>

        <div className="px-5 pb-4 flex flex-wrap gap-x-7 gap-y-2">
          <Metric label="Equipment" value={String(equipment)} />
          {!sc.skipped?.includes("pkg") && <Metric label="Packages" value={`${withPkg} of ${n}`} />}
          {conditional > 0 && <Metric label="Depend on inspection" value={String(conditional)} />}
          {many > 0 && <Metric label={`Pieces with 2+ ${jobWord.startsWith("work") ? "WOs" : "jobs"}`} value={String(many)} />}
          {scope.coming.length > 0 && <Metric label="Still adding scope" value={String(scope.coming.length)} />}
          {addedSince > 0 && <Metric label="Added since the RFQ" value={String(addedSince)} />}
          {removedSince > 0 && <Metric label="Removed since the RFQ" value={String(removedSince)} />}
        </div>

        {incoming && (
          <div className="mx-5 mb-4 rounded-lg border border-[var(--color-border-strong)] p-4 grid gap-3">
            <div className="text-body font-semibold text-[var(--color-text)]">{incoming.file.name} against the list on the project</div>
            <div className="text-body text-[var(--color-text)]"><b>{incoming.diff.added.length}</b> new · <b>{incoming.diff.changed.length}</b> changed · <b>{incoming.diff.dropped.length}</b> dropped · {incoming.diff.same} the same</div>
            <DiffList title="New" rows={incoming.diff.added.map((x) => ({ wo: x.wo, text: x.what }))} />
            <DiffList title="Changed" rows={incoming.diff.changed.map((c) => ({ wo: c.after.wo, text: `${c.after.what} (${c.fields.map((f) => (f === "what" ? "description" : f)).join(", ")} changed)` }))} />
            <DiffList title="Dropped" rows={incoming.diff.dropped.map((x) => ({ wo: x.wo, text: `${x.what}${x.pkg ? " · has a package" : ""}` }))} tone="warn" />
            {!!incoming.diff.stillRemoved?.length && <p className="text-body text-[var(--color-text-muted)]">Still in the list, removed here (they stay removed): {incoming.diff.stillRemoved.map((x) => x.wo).join(", ")}</p>}
            <p className="text-caption text-[var(--color-text-muted)]">Work added on this page isn&apos;t in the file, so it stays.</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={() => setIncoming(null)} disabled={busy}>Cancel</Button>
              <Button onClick={() => void confirmApply()} loading={busy}>Apply the changes</Button>
            </div>
          </div>
        )}

        {/* The schedule against the list, once there is a schedule. */}
        {vs && (vs.missing.length > 0 || vs.extra.length > 0) && (
          <div className="mx-5 mb-4 rounded-md bg-[color-mix(in_srgb,var(--state-held)_12%,transparent)] px-3 py-2.5 grid gap-1">
            <div className="text-body font-semibold text-[var(--state-held-text)]">The schedule and the list don&apos;t match</div>
            {vs.missing.length > 0 && <p className="text-body text-[var(--color-text)]"><b>{vs.missing.length}</b> in the list, not on the schedule: {vs.missing.slice(0, 8).map((x) => x.wo).join(", ")}{vs.missing.length > 8 ? ` + ${vs.missing.length - 8} more` : ""}. {vs.missing.length === 1 ? "Add it to the schedule, or remove it below if it isn't being done." : "Add them to the schedule, or remove them below if they aren't being done."}</p>}
            {vs.extra.length > 0 && <p className="text-body text-[var(--color-text)]"><b>{vs.extra.length}</b> on the schedule, not in the list: {vs.extra.slice(0, 8).join(", ")}{vs.extra.length > 8 ? ` + ${vs.extra.length - 8} more` : ""}</p>}
            {vs.extra.length > 0 && canManage && <Button variant="secondary" className="mt-1 justify-self-start" onClick={() => void addFromSchedule(vs.extra)}><Plus className="w-4 h-4" /> Add {vs.extra.length === 1 ? "it" : `these ${vs.extra.length}`} to the scope</Button>}
          </div>
        )}
        {vs && !vs.missing.length && !vs.extra.length && (
          <div className="mx-5 mb-4 rounded-md bg-[color-mix(in_srgb,var(--state-released)_10%,transparent)] px-3 py-2 text-body font-medium text-[var(--state-released-text)]">✓ Every work order in the list is on the schedule, and nothing else is.</div>
        )}

        {scope.coming.length > 0 && (
          <div className="mx-5 mb-4 rounded-md bg-[var(--color-surface-2)] px-3 py-2.5">
            <div className="text-body font-semibold text-[var(--color-text)]">Scope still coming</div>
            <ul className="mt-1 grid gap-0.5 text-body text-[var(--color-text)]">
              {scope.coming.map((c, i) => <li key={i}>{c.what}{c.owner && <span className="text-[var(--color-text-muted)]"> · {c.owner}</span>}</li>)}
            </ul>
          </div>
        )}

        <div className="border-t border-[var(--color-border)]">
          {groups.map((g) => {
            const isOpen = open[g.category] ?? false;
            const rows = isOpen ? g.items : g.items.slice(0, SHOW);
            return (
              <div key={g.category} className="border-b border-[var(--color-border)] last:border-b-0">
                <div className="px-5 py-2 bg-[var(--color-surface-2)] text-body font-semibold text-[var(--color-text)]">
                  {g.category} <span className="font-normal text-[var(--color-text-muted)] tabular-nums">· {g.equipment} piece{g.equipment === 1 ? "" : "s"}, {g.items.length} {g.items.every((x) => isTypedItem(x.wo)) ? "job" : "WO"}{g.items.length === 1 ? "" : "s"}</span>
                </div>
                <ul>
                  {rows.map((x) => <WoRow key={x.wo} x={x} items={scope.items} canManage={canManage} busy={attaching === x.wo} offSchedule={!!vs && !isTypedItem(x.wo) && !onSched.has(x.wo)} noPkg={!!sc.skipped?.includes("pkg")}
                    sched={facts?.byWo[x.wo]} late={!!since && !!x.addedAt && x.addedAt > since}
                    onAttach={() => pickPackage(x.wo)} onApprove={() => void approve(x.wo)} onRemove={() => void remove(x)} onSave={(v) => saveEdit(x, v)} />)}
                </ul>
                {g.items.length > SHOW && (
                  <button type="button" onClick={() => setOpen((o) => ({ ...o, [g.category]: !isOpen }))} aria-expanded={isOpen}
                    className="w-full flex items-center gap-1.5 px-5 min-h-11 text-left text-body font-medium text-[var(--color-accent-text)] hover:bg-[var(--color-surface-2)]">
                    <ChevronDown aria-hidden className={`ui-chevron w-4 h-4 ${isOpen ? "" : "-rotate-90"}`} />{isOpen ? "Show fewer" : `Show all ${g.items.length}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {/* Taken off the scope, with why: each can be put back. Quiet: the
            number struck through, the why in quotes, who as an avatar. */}
        {removed.length > 0 && (
          <details className="border-t border-[var(--color-border)] group">
            <summary className="px-5 min-h-11 flex items-center gap-1.5 cursor-pointer text-body font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]">
              <ChevronDown aria-hidden className="ui-chevron w-4 h-4 -rotate-90 group-open:rotate-0" />Removed <span className="font-normal tabular-nums">· {removed.length}</span>
            </summary>
            <ul className="px-5 pb-4 grid gap-3">
              {removed.map((r) => (
                <li key={r.wo} className="flex flex-wrap sm:flex-nowrap items-start gap-x-4 gap-y-1.5">
                  <div className="min-w-0 flex-1 text-[var(--color-text-muted)]">
                    <div className="text-body break-words">{isTypedItem(r.wo) ? <span className="line-through">{r.what}</span> : <><span className="mr-1.5 font-medium tabular-nums line-through">WO {r.wo}</span>{r.what}</>}</div>
                    <div className="text-caption break-words flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <span>&ldquo;{r.why}&rdquo;{r.cancelledIds?.length ? ". Its schedule steps were cancelled." : ""}</span>
                      <span className="tabular-nums">{when(r.removedAt, tz)}</span>
                      {r.removedBy && <UserAvatar email={r.removedBy} size={20} title={`Removed by ${r.removedBy}`} />}
                    </div>
                  </div>
                  {canManage && <button type="button" onClick={() => void putBack(r)} className="shrink-0 inline-flex items-center gap-1 min-h-9 pointer-coarse:min-h-11 px-2 rounded-md border border-[var(--color-border-strong)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><RotateCcw aria-hidden className="w-3.5 h-3.5" />Put back{r.cancelledIds?.length ? " (and its steps)" : ""}</button>}
                </li>
              ))}
            </ul>
          </details>
        )}
        {/* Every change made here, with who, when and why: a timeline. */}
        {changes.length > 0 && (
          <details className="border-t border-[var(--color-border)] group">
            <summary className="px-5 min-h-11 flex items-center gap-1.5 cursor-pointer text-body font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
              <ChevronDown aria-hidden className="ui-chevron w-4 h-4 -rotate-90 group-open:rotate-0" />Changes <span className="font-normal text-[var(--color-text-muted)] tabular-nums">· {changes.length}</span>
            </summary>
            <Timeline className="px-5 pt-1 pb-4" tz={tz} max={40}
              items={changes.map((c, i): TimelineItem => ({
                id: String(i), at: c.at,
                kind: KIND[c.kind]?.word ?? c.kind, tone: KIND[c.kind]?.tone ?? "muted",
                title: isTypedItem(c.wo) ? c.what : `WO ${c.wo}`,
                detail: c.why, who: c.by ? { email: c.by } : null,
              }))} />
          </details>
        )}
        {/* A job that came in later, typed in here: opens from one button. */}
        {canManage && (
          <div id="add-job" className="px-5 py-4 border-t border-[var(--color-border)]">
            {adding ? (
              <div className="grid gap-1">
                <InlineAddRow fields={ADD_FIELDS} what="job" addLabel="Add a job" wrap
                  onAdd={(v) => addTyped([{ what: v.what, equipment: v.equipment, wo: v.wo }])}
                  onPasteRows={(rows) => addTyped(rows.map((r) => ({ what: r[0] ?? "", equipment: r[1], wo: r[2] })))} />
                <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setAdding(false)}>Done</Button>
              </div>
            ) : (
              <Button variant="secondary"
                onClick={() => { setAdding(true); requestAnimationFrame(() => (document.querySelector("#add-job input") as HTMLInputElement | null)?.focus()); }}>
                <Plus className="w-4 h-4" /> Add a job
              </Button>
            )}
          </div>
        )}
      </section>}

      {makeOpen && uid && (
        <JobsScheduleDialog orgId={orgId} projectId={projectId} uid={uid} actorName={actorEmail} tz={tz} items={sc.items}
          onClose={() => setMakeOpen(false)} onMade={() => { setMakeOpen(false); load(); }} />
      )}
      {rfqOpen && scope && (
        <RfqDialog projectName={projectName} projectId={projectId} scope={scope} crews={facts?.crews ?? []} actorEmail={actorEmail} finish={finish}
          onClose={() => setRfqOpen(false)}
          onMade={(r) => { setRfqOpen(false); void save({ ...scope, rfqs: [...rfqs, { at: new Date().toISOString(), by: actorEmail, service: r.service, to: [r.to] }] }).catch((e) => setError(sayError(e))); }} />
      )}
    </div>
  );
}

/** One work order: what and where, its number, and its package. */
function WoRow({ x, items, canManage, busy, offSchedule, noPkg, sched, late, onAttach, onApprove, onRemove, onSave }: {
  x: ScopeWO; items: ScopeWO[]; canManage: boolean; busy: boolean; offSchedule: boolean;
  /** Packages marked not needed for this job: no package asks on the row. */
  noPkg: boolean;
  /** Its steps on the schedule, once there is one. */
  sched?: WoOnSchedule;
  /** Added after the RFQ went out (scope growth). */
  late: boolean;
  onAttach: () => void; onApprove: () => void; onRemove: () => void;
  onSave: (v: { what: string; equipment: string; wo: string }) => Promise<string | null>;
}) {
  const [edit, setEdit] = useState<{ what: string; equipment: string; wo: string } | null>(null);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const group = packageGroup(items, x.wo);
  // Where it stands on the schedule, in words.
  const schedSaid = !sched ? "" : sched.cancelled ? "Cancelled on the schedule" : !sched.steps ? "" : sched.done === sched.steps ? "Done on the schedule" : `On the schedule: ${sched.done} of ${sched.steps} step${sched.steps === 1 ? "" : "s"} done`;
  const ask = /need|add .*drawing|missing/i.test(x.notes);
  const noteShown = x.notes && !(x.conditional && /inspect for clean/i.test(x.notes)) ? x.notes : "";
  return (
    <li id={`wo-${x.wo}`} className="px-5 py-2.5 border-t border-[var(--color-border)] first:border-t-0 flex flex-wrap sm:flex-nowrap items-start gap-x-4 gap-y-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-body font-medium text-[var(--color-text)] break-words">{x.tag && <span className="ui-id mr-1.5">{x.tag}</span>}{x.equipmentName || (x.tag ? "" : x.equipment)}</div>
        <div className="text-body text-[var(--color-text)] break-words">{x.what}</div>
        {(noteShown || x.conditional || offSchedule || late) && (
          <div className="text-caption break-words text-[var(--color-text-muted)]">
            {[x.conditional ? "Depends on inspection" : "", offSchedule ? "Not on the schedule" : "", late && x.addedAt ? `Added ${new Date(x.addedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}, after the RFQ` : ""].filter(Boolean).map((t) => <span key={t} className="mr-2 font-medium text-[var(--state-held-text)]">{t}</span>)}
            {noteShown && <span className={ask ? "font-medium text-[var(--state-held-text)]" : ""}>{noteShown}</span>}
          </div>
        )}
        {schedSaid && <div className={`text-caption ${sched?.cancelled ? "text-[var(--state-held-text)] font-medium" : sched && sched.done === sched.steps ? "text-[var(--state-released-text)] font-medium" : "text-[var(--color-text-muted)]"}`}>{schedSaid}</div>}
        {canManage && !edit && (
          <div className="flex flex-wrap gap-x-1">
            <button type="button" onClick={() => { setEditErr(null); setEdit({ what: x.what, equipment: x.equipment, wo: isTypedItem(x.wo) ? "" : x.wo }); }} className="-ml-1 inline-flex items-center gap-1 min-h-9 pointer-coarse:min-h-11 px-1 text-caption font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><Pencil aria-hidden className="w-3.5 h-3.5" />Edit</button>
            <button type="button" onClick={onRemove} className="inline-flex items-center gap-1 min-h-9 pointer-coarse:min-h-11 px-1 text-caption font-medium text-[var(--color-text-muted)] hover:text-[var(--state-overdue-text)]"><X aria-hidden className="w-3.5 h-3.5" />Remove</button>
          </div>
        )}
        {edit && (
          <form className="mt-2 grid gap-2 sm:grid-cols-[1fr_10rem_9rem] items-end" onSubmit={(e) => { e.preventDefault(); setSaving(true); void onSave(edit).then((err) => { setSaving(false); if (err) setEditErr(err); else setEdit(null); }); }}>
            <label className="grid gap-1 text-caption text-[var(--color-text-muted)]">What the work is<input value={edit.what} onChange={(e) => setEdit({ ...edit, what: e.target.value })} className={fieldCls} /></label>
            <label className="grid gap-1 text-caption text-[var(--color-text-muted)]">Equipment<input value={edit.equipment} onChange={(e) => setEdit({ ...edit, equipment: e.target.value })} className={fieldCls} /></label>
            <label className="grid gap-1 text-caption text-[var(--color-text-muted)]">WO number<input value={edit.wo} disabled={!isTypedItem(x.wo)} placeholder="If it has one" onChange={(e) => setEdit({ ...edit, wo: e.target.value })} className={`${fieldCls} disabled:opacity-60`} /></label>
            <div className="sm:col-span-3 flex flex-wrap items-center gap-2">
              <Button type="submit" variant="secondary" loading={saving}>Save</Button>
              <Button type="button" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
              {!x.typed && <span className="text-caption text-[var(--color-text-muted)]">The next import of the list puts back what the list says.</span>}
            </div>
            {editErr && <p className="sm:col-span-3 text-body font-medium text-[var(--state-overdue-text)]">{editErr}</p>}
          </form>
        )}
      </div>
      <div className="sm:text-right shrink-0 grid gap-1 sm:justify-items-end text-caption text-[var(--color-text-muted)]">
        {!isTypedItem(x.wo) && <div className="tabular-nums">WO {x.wo}</div>}
        {noPkg && !x.pkg ? null : x.pkg ? (
          <>
            <Link href={x.pkg.href} className="inline-flex items-center gap-1 min-h-9 pointer-coarse:min-h-11 font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2"><FileText aria-hidden className="w-3.5 h-3.5" />{x.pkg.label}</Link>
            {x.approved
              ? <span className="inline-flex items-center gap-1.5"><span aria-hidden className="w-2 h-2 rounded-full bg-[var(--state-released)]" />Approved{x.approvedBy ? ` by ${x.approvedBy}` : ""}</span>
              : canManage
                ? <button type="button" onClick={onApprove} className="inline-flex items-center gap-1 min-h-9 pointer-coarse:min-h-11 px-2 rounded-md border border-[var(--color-border-strong)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><Check aria-hidden className="w-3.5 h-3.5" />Mark approved</button>
                : <span className="inline-flex items-center gap-1.5"><span aria-hidden className="w-2 h-2 rounded-full bg-[var(--state-held)]" />To approve</span>}
          </>
        ) : canManage ? (
          <button type="button" onClick={onAttach} disabled={busy} className="inline-flex items-center gap-1 min-h-9 pointer-coarse:min-h-11 px-2 rounded-md border border-[var(--color-border-strong)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-60">
            <Paperclip aria-hidden className="w-3.5 h-3.5" />{busy ? "Attaching..." : group.length > 1 ? `Attach package (${group.length} ${group.every((g) => isTypedItem(g.wo)) ? "jobs" : "WOs"})` : "Attach package"}
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="w-2 h-2 rounded-full bg-[var(--color-text-faint)]" />No package yet</span>
        )}
      </div>
    </li>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><div className="text-caption text-[var(--color-text-muted)]">{label}</div><div className="text-reading font-semibold tabular-nums text-[var(--color-text)]">{value}</div></div>;
}

function DiffList({ title, rows, tone }: { title: string; rows: Array<{ wo: string; text: string }>; tone?: "warn" }) {
  if (!rows.length) return null;
  return (
    <div>
      <div className={`text-body font-semibold ${tone === "warn" ? "text-[var(--state-held-text)]" : "text-[var(--color-text)]"}`}>{title} · {rows.length}</div>
      <ul className="mt-0.5 grid gap-0.5 text-body text-[var(--color-text)] max-h-48 overflow-y-auto">
        {rows.map((r) => <li key={r.wo} className="break-words"><span className="tabular-nums text-[var(--color-text-muted)]">WO {r.wo}</span> {r.text}</li>)}
      </ul>
    </div>
  );
}
