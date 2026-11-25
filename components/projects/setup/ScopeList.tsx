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
import { Check, ChevronDown, FileSpreadsheet, FileText, Paperclip, Upload, Package, CalendarRange, Handshake } from "lucide-react";
import { planningPath, type PathKey } from "@/lib/planningPath";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { appConfirm } from "@/components/providers/DialogProvider";
import { sayError } from "@/components/projects/sayError";
import ProjectFilePlace, { useProjectFileHome } from "@/components/projects/ProjectFilePlace";
import RfqDialog from "@/components/projects/setup/RfqDialog";
import { uploadProjectFile } from "@/lib/projectUpload";
import { againstSchedule, applyScope, byCategory, diffScope, packageGroup, pickSheet, readScope, shared, type ScopeDiff, type ScopeRead, type ScopeWO } from "@/lib/woIntake";
import { loadScope, readSheets, saveScope, scheduleFacts, LIST_ACCEPT, OPEN_SCHEDULE_IMPORT, type ScopeState } from "@/lib/scopeStore";

const SHOW = 6;
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

interface Facts { wos: string[]; crews: string[]; steps: number; awarded: number }

export default function ScopeList({ orgId, projectId, projectName, uid, canManage, noSchedule, actorEmail, finish }: {
  orgId: string; projectId: string; projectName: string; uid: string | null; canManage: boolean; noSchedule: boolean; actorEmail?: string;
  /** The target completion ("YYYY-MM-DD"), for the RFQ. */
  finish?: string;
}) {
  const [scope, setScope] = useState<ScopeState | null | undefined>(undefined);
  const [facts, setFacts] = useState<Facts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<{ file: File; read: ScopeRead; diff: ScopeDiff } | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [attaching, setAttaching] = useState<string | null>(null);
  const [rfqOpen, setRfqOpen] = useState(false);
  const [needPlace, setNeedPlace] = useState(false);
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
  const vs = useMemo(() => (scope && facts && facts.wos.length ? againstSchedule(scope.items, facts.wos) : null), [scope, facts]);

  const save = async (next: ScopeState) => { await saveScope(projectId, next); setScope(next); };

  const apply = async (file: File, read: ScopeRead, diff?: ScopeDiff) => {
    await save({
      items: applyScope(scope?.items ?? [], read.items), coming: read.coming,
      source: { file: file.name, sheet: read.sheet, headers: read.headers, map: read.map },
      imports: [...(scope?.imports ?? []), { at: new Date().toISOString(), by: actorEmail, file: file.name, sheet: read.sheet, added: diff?.added.length ?? read.items.length, changed: diff?.changed.length ?? 0, dropped: diff?.dropped.length ?? 0 }],
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
      setIncoming({ file: f, read, diff: diffScope(scope.items, read.items) });
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
        orgId, projectId, projectName, file, prefix: "PACKAGE", part: `WO ${wo}`,
        title: `Work package - ${[first.tag, first.equipmentName || first.equipment].filter(Boolean).join(" ")} - WO ${group.map((x) => x.wo).join(", ")}`,
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

  if (scope === undefined) return null;
  const fileInput = <input ref={input} type="file" accept={LIST_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void take(e.target.files?.[0]); e.target.value = ""; }} />;

  if (!scope) {
    if (!canManage || !noSchedule) return null;
    return (
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 grid gap-2 justify-items-start">
        {fileInput}
        <FileSpreadsheet aria-hidden className="w-6 h-6 text-[var(--color-text-muted)]" />
        <h2 className="font-display text-section font-semibold text-[var(--color-text)]">Start planning: import the work order list</h2>
        <p className="text-body text-[var(--color-text-muted)] max-w-prose">The Excel list of approved work orders. It becomes the scope; then a package for each piece of equipment, the schedule checked against it, and the RFQ written from it.</p>
        <Button onClick={() => input.current?.click()} loading={busy}><Upload className="w-4 h-4" /> Import the list</Button>
        {error && <ErrorNote title={error} />}
      </section>
    );
  }

  const n = scope.items.length;
  const equipment = new Set(scope.items.map((x) => x.equipment || x.wo)).size;
  const withPkg = scope.items.filter((x) => x.pkg || x.drafted).length;
  const approved = scope.items.filter((x) => x.approved).length;
  const conditional = scope.items.filter((x) => x.conditional).length;
  const many = shared(scope.items).length;
  const last = scope.imports[scope.imports.length - 1];
  const rfqs = scope.rfqs ?? [];
  const firstWithout = scope.items.find((x) => !x.pkg && !x.drafted);
  const onSched = new Set(vs?.on.map((x) => x.wo) ?? []);

  // The planning path (lib/planningPath): where each step stands; the
  // first one not done is next. Here, what each step's button does.
  const path = planningPath(scope, facts);
  const nextIdx = path.next;
  const actions: Partial<Record<PathKey, { label: string; run?: () => void; href?: string }>> = {
    pkg: firstWithout ? { label: `Attach the package for ${firstWithout.tag || `WO ${firstWithout.wo}`}`, run: () => { if (home?.place) document.getElementById(`wo-${firstWithout.wo}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); pickPackage(firstWithout.wo); } }
      : approved < n ? { label: "Approve the packages", run: () => document.getElementById("scope-list")?.scrollIntoView({ behavior: "smooth" }) } : undefined,
    sched: { label: facts?.steps ? "Import the schedule again" : "Import the schedule", run: () => window.dispatchEvent(new Event(OPEN_SCHEDULE_IMPORT)) },
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
              </li>
            );
          })}
        </ol>
        <p className="px-1 text-caption text-[var(--color-text-muted)]">{nextIdx < 0 ? "Planning is done. " : ""}After the award: the work (a shift report every shift, on the Shift tab), then close-out. The project takes you to each.</p>
        {needPlace && home && uid && (
          <div className="rounded-lg border border-[var(--color-border-strong)] p-3 grid gap-2">
            <p className="text-body text-[var(--color-text)]">First, pick where this project&apos;s packages are filed in document control. It&apos;s asked once.</p>
            <ProjectFilePlace orgId={orgId} projectId={projectId} uid={uid} canManage={canManage} home={home} onChange={(h) => { setHome(h); if (h.place) setNeedPlace(false); }} what="the packages" />
          </div>
        )}
        {error && <ErrorNote title={error} />}
      </section>

      <section id="scope-list" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden" aria-labelledby="scope-title">
        <div className="px-5 pt-4 pb-3 flex flex-wrap items-start gap-x-4 gap-y-2">
          {/* On a phone the button goes under the title, so neither squeezes. */}
          <div className="min-w-0 flex-1 basis-full sm:basis-auto">
            <h2 id="scope-title" className="font-display text-section font-semibold text-[var(--color-text)]">Scope <span className="font-normal text-[var(--color-text-muted)] tabular-nums">· {n} work orders</span></h2>
            <p className="text-caption text-[var(--color-text-muted)] break-words">From {scope.source.file}, tab {scope.source.sheet}{last ? `, imported ${when(last.at)}${last.by ? ` by ${last.by}` : ""}` : ""}</p>
          </div>
          {canManage && <Button variant="secondary" onClick={() => input.current?.click()} loading={busy && !incoming}><Upload className="w-4 h-4" /> Import the list again</Button>}
        </div>

        <div className="px-5 pb-4 flex flex-wrap gap-x-7 gap-y-2">
          <Metric label="Equipment" value={String(equipment)} />
          <Metric label="Packages" value={`${withPkg} of ${n}`} />
          {conditional > 0 && <Metric label="Depend on inspection" value={String(conditional)} />}
          {many > 0 && <Metric label="Pieces with 2+ WOs" value={String(many)} />}
          {scope.coming.length > 0 && <Metric label="Still adding scope" value={String(scope.coming.length)} />}
        </div>

        {incoming && (
          <div className="mx-5 mb-4 rounded-lg border border-[var(--color-border-strong)] p-4 grid gap-3">
            <div className="text-body font-semibold text-[var(--color-text)]">{incoming.file.name} against the list on the project</div>
            <div className="text-body text-[var(--color-text)]"><b>{incoming.diff.added.length}</b> new · <b>{incoming.diff.changed.length}</b> changed · <b>{incoming.diff.dropped.length}</b> dropped · {incoming.diff.same} the same</div>
            <DiffList title="New" rows={incoming.diff.added.map((x) => ({ wo: x.wo, text: x.what }))} />
            <DiffList title="Changed" rows={incoming.diff.changed.map((c) => ({ wo: c.after.wo, text: `${c.after.what} (${c.fields.map((f) => (f === "what" ? "description" : f)).join(", ")} changed)` }))} />
            <DiffList title="Dropped" rows={incoming.diff.dropped.map((x) => ({ wo: x.wo, text: `${x.what}${x.pkg ? " · has a package" : ""}` }))} tone="warn" />
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
            {vs.missing.length > 0 && <p className="text-body text-[var(--color-text)]"><b>{vs.missing.length}</b> in the list, not on the schedule: {vs.missing.slice(0, 8).map((x) => x.wo).join(", ")}{vs.missing.length > 8 ? ` + ${vs.missing.length - 8} more` : ""}</p>}
            {vs.extra.length > 0 && <p className="text-body text-[var(--color-text)]"><b>{vs.extra.length}</b> on the schedule, not in the list: {vs.extra.slice(0, 8).join(", ")}{vs.extra.length > 8 ? ` + ${vs.extra.length - 8} more` : ""}</p>}
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
                  {g.category} <span className="font-normal text-[var(--color-text-muted)] tabular-nums">· {g.equipment} piece{g.equipment === 1 ? "" : "s"}, {g.items.length} WO{g.items.length === 1 ? "" : "s"}</span>
                </div>
                <ul>
                  {rows.map((x) => <WoRow key={x.wo} x={x} items={scope.items} canManage={canManage} busy={attaching === x.wo} offSchedule={!!vs && !onSched.has(x.wo)}
                    onAttach={() => pickPackage(x.wo)} onApprove={() => void approve(x.wo)} />)}
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
      </section>

      {rfqOpen && (
        <RfqDialog projectName={projectName} projectId={projectId} scope={scope} crews={facts?.crews ?? []} actorEmail={actorEmail} finish={finish}
          onClose={() => setRfqOpen(false)}
          onMade={(r) => { setRfqOpen(false); void save({ ...scope, rfqs: [...rfqs, { at: new Date().toISOString(), by: actorEmail, service: r.service, to: [r.to] }] }).catch((e) => setError(sayError(e))); }} />
      )}
    </div>
  );
}

/** One work order: what and where, its number, and its package. */
function WoRow({ x, items, canManage, busy, offSchedule, onAttach, onApprove }: {
  x: ScopeWO; items: ScopeWO[]; canManage: boolean; busy: boolean; offSchedule: boolean; onAttach: () => void; onApprove: () => void;
}) {
  const group = packageGroup(items, x.wo);
  const ask = /need|add .*drawing|missing/i.test(x.notes);
  const noteShown = x.notes && !(x.conditional && /inspect for clean/i.test(x.notes)) ? x.notes : "";
  return (
    <li id={`wo-${x.wo}`} className="px-5 py-2.5 border-t border-[var(--color-border)] first:border-t-0 flex flex-wrap sm:flex-nowrap items-start gap-x-4 gap-y-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-body font-medium text-[var(--color-text)] break-words">{x.tag && <span className="ui-id mr-1.5">{x.tag}</span>}{x.equipmentName || x.equipment}</div>
        <div className="text-body text-[var(--color-text)] break-words">{x.what}</div>
        {(noteShown || x.conditional || offSchedule) && (
          <div className="text-caption break-words text-[var(--color-text-muted)]">
            {[x.conditional ? "Depends on inspection" : "", offSchedule ? "Not on the schedule" : ""].filter(Boolean).map((t) => <span key={t} className="mr-2 font-medium text-[var(--state-held-text)]">{t}</span>)}
            {noteShown && <span className={ask ? "font-medium text-[var(--state-held-text)]" : ""}>{noteShown}</span>}
          </div>
        )}
      </div>
      <div className="sm:text-right shrink-0 grid gap-1 sm:justify-items-end text-caption text-[var(--color-text-muted)]">
        <div className="tabular-nums">WO {x.wo}</div>
        {x.pkg ? (
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
            <Paperclip aria-hidden className="w-3.5 h-3.5" />{busy ? "Attaching..." : group.length > 1 ? `Attach package (${group.length} WOs)` : "Attach package"}
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
