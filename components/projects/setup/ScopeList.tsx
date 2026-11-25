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
import { Check, ChevronDown, FileSpreadsheet, FileText, Upload, Package, CalendarRange, Handshake, RotateCcw, Plus } from "lucide-react";
import { planningPath, scheduleMatch, type PathKey } from "@/lib/planningPath";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { appConfirm, appPrompt } from "@/components/providers/DialogProvider";
import { cancelMilestone, restoreCancelledMilestone } from "@/lib/milestones";
import { sayError } from "@/components/projects/sayError";
import ProjectFilePlace, { useProjectFileHome } from "@/components/projects/ProjectFilePlace";
import JobsScheduleDialog from "@/components/projects/setup/JobsScheduleDialog";
import RfqDialog from "@/components/projects/setup/RfqDialog";
import { uploadProjectFile } from "@/lib/projectUpload";
import { applyScope, diffScope, isTypedItem, packageGroup, packageGroups, pickSheet, readScope, shared, typedItem, woKey, type ScopeDiff, type ScopeRead, type ScopeWO } from "@/lib/woIntake";
import { InlineAddRow, type AddField } from "@/components/ui/InlineAddRow";
import Timeline, { type TimelineItem, type TimelineTone } from "@/components/ui/Timeline";
import UserAvatar from "@/components/ui/UserAvatar";
import { loadScope, readSheets, saveScope, scheduleFacts, LIST_ACCEPT, OPEN_SCHEDULE_IMPORT, TYPED_SOURCE, type RemovedWO, type ScheduleFacts, type ScopeChange, type ScopeState } from "@/lib/scopeStore";
import { draftMissing, loadKit, loadPackages, PACKAGES_CHANGED, EMPTY_KIT, type PackageKit, type ProjectPackages } from "@/lib/woPackages";
import PackagesBar from "@/components/projects/packages/PackagesBar";
import WoRegister from "@/components/projects/setup/WoRegister";
import PackageBuilder from "@/components/projects/packages/PackageBuilder";
import PackageKitDialog from "@/components/projects/packages/PackageKitDialog";
import { useOrgBranding } from "@/components/providers/OrgBrandingProvider";
import { supabase } from "@/lib/supabase";

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
  // Work order packages: the workspace's kit and this project's packages.
  const [kit, setKit] = useState<PackageKit | null>(null);
  const [pkgs, setPkgs] = useState<ProjectPackages | null>(null);
  const [building, setBuilding] = useState<string | null>(null);
  const [kitOpen, setKitOpen] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [pkgNote, setPkgNote] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState("");
  const { logoUrl } = useOrgBranding();

  const loadPkgs = useCallback(() => {
    loadPackages(orgId, projectId).then(setPkgs, () => setPkgs({ packages: {} }));
  }, [orgId, projectId]);
  const load = useCallback(() => {
    loadScope(projectId).then(setScope, () => setScope(null));
    scheduleFacts(projectId).then(setFacts, () => setFacts(null));
    loadKit(orgId).then(setKit, () => setKit(EMPTY_KIT));
    loadPkgs();
  }, [projectId, orgId, loadPkgs]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    void Promise.resolve(supabase.from("orgs").select("name").eq("id", orgId).maybeSingle()).then(({ data }) => setWorkspace(String((data as { name?: string } | null)?.name ?? "")), () => undefined);
  }, [orgId]);
  // A package changed anywhere on this page (the builder, the bar): read again.
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent<{ projectId: string }>).detail?.projectId === projectId) loadPkgs(); };
    window.addEventListener(PACKAGES_CHANGED, on);
    return () => window.removeEventListener(PACKAGES_CHANGED, on);
  }, [projectId, loadPkgs]);
  // Opened from a notification ("Signed form back"): straight to that package.
  useEffect(() => {
    const k = new URLSearchParams(window.location.search).get("package");
    if (k) setBuilding(k);
  }, []);

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

  // A package built or approved: its work orders say so on the scope (the
  // planning path counts them).
  const markScope = async (wos: string[], what: "drafted" | "approved") => {
    const base = await loadScope(projectId);
    if (!base || !wos.length) return;
    const ids = new Set(wos);
    const at = new Date().toISOString();
    await save({ ...base, items: base.items.map((x) => (ids.has(x.wo) ? (what === "drafted" ? { ...x, drafted: true } : { ...x, drafted: true, approved: true, approvedBy: actorEmail, approvedAt: at }) : x)) });
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
  const addFromSchedule = async (wos: string[], why = "On the schedule, not in the list") => {
    const r = await addTyped(wos.map((w) => ({ what: facts?.byWo[w]?.name || `WO ${w}`, wo: w, group: "From the schedule" })), why);
    if (typeof r === "string") setError(r); else if (!r.ok) setError(r.text);
  };
  // Started from its schedule: the scope IS the schedule's work orders, so
  // the ones a re-imported schedule brings join the scope on their own
  // (each once; one taken off the scope stays off, under Removed).
  const fromSchedule = scope?.start === "schedule";
  const synced = useRef("");
  useEffect(() => {
    if (!canManage || !fromSchedule || !vs?.extra.length) return;
    const key = vs.extra.join(",");
    if (synced.current === key) return;
    synced.current = key;
    void addFromSchedule(vs.extra, "New on the schedule");
  }, [vs, canManage, fromSchedule]); // eslint-disable-line react-hooks/exhaustive-deps -- adds what the schedule brought, once
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
  // Packages: one per piece of equipment, built from the workspace's kit.
  const groupsByKey = packageGroups(sc.items);
  const pkgMissing = pkgs ? [...groupsByKey.keys()].filter((k) => !pkgs.packages[k] && !groupsByKey.get(k)!.some((x) => x.pkg)) : [];
  const kitEmpty = !!kit && !kit.forms.length && !kit.cover;
  const firstDraft = pkgs ? Object.values(pkgs.packages).find((p) => p.status === "draft") : undefined;
  const buildAll = async () => {
    if (!kit) return;
    setDrafting(true); setError(null); setPkgNote(null);
    try {
      const made = await draftMissing(orgId, projectId, groupsByKey, kit);
      await markScope(made, "drafted"); loadPkgs();
      setPkgNote(`${pkgMissing.length} package${pkgMissing.length === 1 ? "" : "s"} built from the kit. Open each to add drawings or photos and set the order, then approve it.`);
    } catch (e) { setError(sayError(e)); } finally { setDrafting(false); }
  };
  const actions: Partial<Record<PathKey, { label: string; run?: () => void; href?: string; alt?: { label: string; run: () => void } }>> = {
    scope: n ? undefined : { label: "Add the work", run: () => { document.getElementById("add-work")?.scrollIntoView({ behavior: "smooth", block: "center" }); (document.querySelector("#add-work input") as HTMLInputElement | null)?.focus(); } },
    pkg: pkgMissing.length && kitEmpty ? { label: "Set up the package kit", run: () => setKitOpen(true) }
      : pkgMissing.length ? { label: pkgMissing.length === groupsByKey.size ? `Build the ${pkgMissing.length} package${pkgMissing.length === 1 ? "" : "s"} from the kit` : `Build the other ${pkgMissing.length} package${pkgMissing.length === 1 ? "" : "s"}`, run: () => void buildAll(), alt: { label: "Check the kit first", run: () => setKitOpen(true) } }
      : firstDraft ? { label: `Check and approve ${firstDraft.wos[0] ? `WO ${firstDraft.wos[0]}` : firstDraft.equipment}`, run: () => setBuilding(firstDraft.key) }
      : firstWithout ? { label: `Attach the package for ${firstWithout.tag || (isTypedItem(firstWithout.wo) ? firstWithout.what.slice(0, 28) : `WO ${firstWithout.wo}`)}`, run: () => { if (home?.place) document.getElementById(`wo-${firstWithout.wo}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); pickPackage(firstWithout.wo); } }
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
                    : <Button className="mt-1 justify-self-start max-w-full" onClick={act.run} loading={s.key === "pkg" && (!!attaching || drafting)}>{act.label}</Button>)
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
        {pkgNote && <p role="status" className="px-1 text-body text-[var(--color-text)]">{pkgNote}</p>}
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

      {/* Once packages exist: printing, forms back, filing. Before that the
          path's Packages step leads (set up the kit, build them). */}
      {n > 0 && scope && kit && pkgs && Object.keys(pkgs.packages).length > 0 && !sc.skipped?.includes("pkg") && (
        <PackagesBar orgId={orgId} projectId={projectId} projectName={projectName} workspace={workspace} logoUrl={logoUrl} tz={tz} uid={uid} actorEmail={actorEmail} canManage={canManage}
          items={sc.items} kit={kit} all={pkgs} onOpenKit={() => setKitOpen(true)} />
      )}

      {n > 0 && scope && <section id="scope-list" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden" aria-labelledby="scope-title">
        <div className="px-5 pt-4 pb-3 flex flex-wrap items-start gap-x-4 gap-y-2">
          {/* On a phone the button goes under the title, so neither squeezes. */}
          <div className="min-w-0 flex-1 basis-full sm:basis-auto">
            <h2 id="scope-title" className="font-display text-section font-semibold text-[var(--color-text)]">Scope <span className="font-normal text-[var(--color-text-muted)] tabular-nums">· {n} {jobWord}</span></h2>
            <p className="text-caption text-[var(--color-text-muted)] break-words">{scope.source.sheet ? `From ${scope.source.file}, tab ${scope.source.sheet}${last ? `, imported ${when(last.at, tz)}${last.by ? ` by ${last.by}` : ""}` : ""}` : scope.start === "schedule" ? `From the schedule, ${scope.source.file}` : "Typed in on this page"}</p>
          </div>
          {canManage && <Button variant="secondary" onClick={() => input.current?.click()} loading={busy && !incoming}><Upload className="w-4 h-4" /> {scope.source.sheet ? "Import the list again" : "Import a work order list"}</Button>}
        </div>

        <div className="px-5 pb-4 flex flex-wrap gap-x-7 gap-y-2">
          <Metric label="Equipment" value={String(equipment)} />
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
            <div className="text-body font-semibold text-[var(--state-held-text)]">{fromSchedule ? "The schedule changed" : <>The schedule and the list don&apos;t match</>}</div>
            {vs.missing.length > 0 && <p className="text-body text-[var(--color-text)]"><b>{vs.missing.length}</b> {fromSchedule ? "in the scope, no longer on the schedule" : "in the list, not on the schedule"}: {vs.missing.slice(0, 8).map((x) => x.wo).join(", ")}{vs.missing.length > 8 ? ` + ${vs.missing.length - 8} more` : ""}. {fromSchedule ? (vs.missing.length === 1 ? "Remove it below if it isn't being done." : "Remove them below if they aren't being done.") : vs.missing.length === 1 ? "Add it to the schedule, or remove it below if it isn't being done." : "Add them to the schedule, or remove them below if they aren't being done."}</p>}
            {vs.extra.length > 0 && <p className="text-body text-[var(--color-text)]"><b>{vs.extra.length}</b> {fromSchedule ? "new on the schedule, not in the scope yet" : "on the schedule, not in the list"}: {vs.extra.slice(0, 8).join(", ")}{vs.extra.length > 8 ? ` + ${vs.extra.length - 8} more` : ""}</p>}
            {vs.extra.length > 0 && canManage && <Button variant="secondary" className="mt-1 justify-self-start" onClick={() => void addFromSchedule(vs.extra)}><Plus className="w-4 h-4" /> Add {vs.extra.length === 1 ? "it" : `these ${vs.extra.length}`} to the scope</Button>}
          </div>
        )}
        {/* (A project that started from its schedule: the scope IS the
            schedule's work orders, so there's nothing to say.) */}
        {vs && !vs.missing.length && !vs.extra.length && sc.start !== "schedule" && (
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

        {/* Every work order on its own row, with all the list says about it. */}
        <WoRegister projectId={projectId} items={scope.items} canManage={canManage} attaching={attaching} noPkg={!!sc.skipped?.includes("pkg")}
          onSched={vs ? onSched : null} byWo={facts?.byWo} since={since} packages={pkgs?.packages}
          onBuild={(k) => setBuilding(k)} onAttach={(wo) => pickPackage(wo)} onApprove={(wo) => void approve(wo)}
          onRemove={(x) => void remove(x)} onSave={(x, v) => saveEdit(x, v)} />
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

      {building && kit && pkgs && scope && (() => {
        const g = groupsByKey.get(building) ?? (scope.items.some((x) => x.wo === building) ? packageGroup(scope.items, building) : null);
        return g ? (
          <PackageBuilder orgId={orgId} projectId={projectId} projectName={projectName} workspace={workspace} logoUrl={logoUrl} tz={tz} actorEmail={actorEmail} canManage={canManage}
            group={g} kit={kit} all={pkgs} onClose={() => setBuilding(null)} onOpenKit={() => setKitOpen(true)}
            onMarkScope={(what) => markScope(g.map((x) => x.wo), what)} />
        ) : null;
      })()}
      {kitOpen && kit && (
        <PackageKitDialog orgId={orgId} kit={kit} actorEmail={actorEmail} workspace={workspace} projectName={projectName} onClose={() => setKitOpen(false)} onSaved={setKit} />
      )}
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
