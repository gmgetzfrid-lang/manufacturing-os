"use client";

// WoRegister - the project's work orders, one row each, with everything the
// list said about it: the WO number first, what the work is, its equipment
// (number, tag and name), when and by whom it was added, every note, any
// other column the file had, whether the list says its package is drafted
// or approved, and where its package and schedule stand. Grouped by
// category (as the list is), by equipment (one package each), or not at
// all; a search finds a WO, a tag, a name or words. Every row shows: no
// "show all". A table where there's room, a card per WO on a phone.

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, FileText, Package, Paperclip, Pencil, Search, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import MoreMenu, { type MoreItem } from "@/components/ui/MoreMenu";
import { field as fieldCls } from "@/components/admin/kit";
import { bandSeg, bandSegItem } from "@/components/admin/band";
import { byCategory, isTypedItem, packageGroup, type ScopeWO, type WoOnSchedule } from "@/lib/woIntake";
import { packageStage, type WoPackage } from "@/lib/woPackages";

type GroupBy = "category" | "equipment" | "none";
const GROUP_WORDS: Record<GroupBy, string> = { category: "Category", equipment: "Equipment", none: "None" };

type Edit = { what: string; equipment: string; wo: string };

export interface RegisterProps {
  projectId: string;
  items: ScopeWO[];
  canManage: boolean;
  /** The WO whose finished package file is uploading. */
  attaching: string | null;
  /** Packages marked not needed for this job. */
  noPkg: boolean;
  /** WOs found on the schedule; null when there's no schedule to match. */
  onSched: Set<string> | null;
  byWo?: Record<string, WoOnSchedule>;
  /** When the first RFQ went out: WOs added after it are scope growth. */
  since?: string;
  packages?: Record<string, WoPackage>;
  onBuild: (key: string) => void;
  onAttach: (wo: string) => void;
  onApprove: (wo: string) => void;
  onRemove: (x: ScopeWO) => void;
  onSave: (x: ScopeWO, v: Edit) => Promise<string | null>;
}

/** "11/20/26" → "Nov 20, 2026"; anything else as written. */
function dateSaid(s?: string): string {
  if (!s) return "";
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  const d = m ? new Date(Number(m[3].length === 2 ? `20${m[3]}` : m[3]), Number(m[1]) - 1, Number(m[2])) : new Date(s);
  return Number.isNaN(d.getTime()) || (!m && !/\d{4}-\d{2}-\d{2}/.test(s)) ? s : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const eqKey = (x: ScopeWO) => x.equipment || x.tag || `wo:${x.wo}`;
const eqTitle = (x: ScopeWO) => [x.tag, x.equipmentName].filter(Boolean).join(" ") || x.equipment || "No equipment";

/** Rows: a table where the list is wide, a card per WO where it isn't. */
const ROW_GRID = "grid gap-x-4 gap-y-1 [grid-template-columns:minmax(0,1fr)_auto] [grid-template-areas:'wo_menu'_'work_work'_'eq_eq'_'meta_meta'_'status_status'] @4xl:[grid-template-columns:6.5rem_minmax(0,2.3fr)_minmax(0,1.5fr)_7.5rem_minmax(0,1.5fr)_2.75rem] @4xl:[grid-template-areas:'wo_work_eq_meta_status_menu'] @4xl:items-start";

export default function WoRegister(p: RegisterProps) {
  const { projectId, items } = p;
  const storeKey = `mfgos:scope-group:${projectId}`;
  const [groupBy, setGroupByState] = useState<GroupBy>(() => {
    try { const v = window.localStorage.getItem(storeKey); return v === "equipment" || v === "none" ? v : "category"; } catch { return "category"; }
  });
  const setGroupBy = (g: GroupBy) => { setGroupByState(g); try { window.localStorage.setItem(storeKey, g); } catch { /* a convenience */ } };
  const [q, setQ] = useState("");
  const [shut, setShut] = useState<Record<string, boolean>>({});

  const query = q.trim().toLowerCase();
  const words = query.split(/\s+/).filter(Boolean);
  const shown = useMemo(() => {
    const ws = query.split(/\s+/).filter(Boolean);
    if (!ws.length) return items;
    return items.filter((x) => {
      const hay = [x.wo, x.what, x.equipment, x.tag, x.equipmentName, x.category, x.notes, x.addedBy, x.added, ...Object.values(x.extra ?? {})].join(" ").toLowerCase();
      return ws.every((w) => hay.includes(w));
    });
  }, [items, query]);

  const groups = useMemo(() => {
    if (groupBy === "none") return [{ key: "all", title: "", sub: "", items: shown }];
    if (groupBy === "category") {
      return byCategory(shown).map((g) => ({ key: `c:${g.category}`, title: g.category, sub: `${g.items.length} WO${g.items.length === 1 ? "" : "s"} on ${g.equipment} piece${g.equipment === 1 ? "" : "s"} of equipment`, items: g.items }));
    }
    const m = new Map<string, ScopeWO[]>();
    for (const x of shown) m.set(eqKey(x), [...(m.get(eqKey(x)) ?? []), x]);
    return [...m.entries()].map(([k, list]) => {
      const f = list[0];
      const num = f.equipment && f.equipment !== eqTitle(f) ? f.equipment : "";
      return { key: `e:${k}`, title: eqTitle(f), sub: [num, `${list.length} WO${list.length === 1 ? "" : "s"}`, [...new Set(list.map((x) => x.category))].join(", ")].filter(Boolean).join(" · "), items: list };
    });
  }, [shown, groupBy]);

  const typedOnly = items.every((x) => isTypedItem(x.wo));
  const second = groupBy === "equipment" ? "Category" : "Equipment";

  return (
    <div className="@container">
      {/* Find and group. */}
      <div className="px-5 pb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="relative flex-1 min-w-52 max-w-md">
          <Search aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)] pointer-events-none" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a work order" placeholder={typedOnly ? "Find a job, equipment or words" : "Find a WO, equipment, name or words"} className={`${fieldCls} pl-9`} />
        </div>
        <div className="flex items-center gap-2">
          <span id="wr-group" className="text-body text-[var(--color-text-muted)]">Group by</span>
          <div role="radiogroup" aria-labelledby="wr-group" className={bandSeg}>
            {(Object.keys(GROUP_WORDS) as GroupBy[]).map((g) => (
              <button key={g} type="button" role="radio" aria-checked={groupBy === g} onClick={() => setGroupBy(g)} className={bandSegItem(groupBy === g)}>{GROUP_WORDS[g]}</button>
            ))}
          </div>
        </div>
        {words.length > 0 && <span role="status" className="text-body tabular-nums text-[var(--color-text-muted)]">{shown.length} of {items.length} match</span>}
      </div>

      {/* The column headings, where it's a table. */}
      <div aria-hidden className={`hidden @4xl:grid ${ROW_GRID} px-5 py-2 border-t border-[var(--color-border)] text-caption font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]`}>
        <span className="[grid-area:wo]">{typedOnly ? "Job" : "WO"}</span>
        <span className="[grid-area:work]">Work</span>
        <span className="[grid-area:eq]">{second}</span>
        <span className="[grid-area:meta]">Added</span>
        <span className="[grid-area:status]">Package and schedule</span>
      </div>

      <div className="border-t border-[var(--color-border)]">
        {!shown.length && (
          <p className="px-5 py-4 text-body text-[var(--color-text-muted)]">No work order matches &ldquo;{q.trim()}&rdquo;. <button type="button" onClick={() => setQ("")} className="font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">Clear the search</button></p>
        )}
        {groups.map((g) => {
          const closed = !!shut[g.key] && !words.length;
          return (
            <section key={g.key} aria-label={g.title || "Work orders"} className="border-b border-[var(--color-border)] last:border-b-0">
              {g.title && (
                <button type="button" onClick={() => setShut((s) => ({ ...s, [g.key]: !closed }))} aria-expanded={!closed}
                  className="w-full flex items-center gap-1.5 px-5 min-h-11 text-left bg-[var(--color-surface-2)] hover:bg-[color-mix(in_srgb,var(--color-text)_5%,var(--color-surface-2))]">
                  <ChevronDown aria-hidden className={`ui-chevron w-4 h-4 shrink-0 text-[var(--color-text-muted)] ${closed ? "-rotate-90" : ""}`} />
                  <span className="text-body font-semibold text-[var(--color-text)]">{g.title}</span>
                  <span className="min-w-0 truncate text-body text-[var(--color-text-muted)] tabular-nums">· {g.sub}</span>
                </button>
              )}
              {!closed && (
                <ul>
                  {g.items.map((x) => <Row key={x.wo} x={x} p={p} groupBy={groupBy} />)}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Row({ x, p, groupBy }: { x: ScopeWO; p: RegisterProps; groupBy: GroupBy }) {
  const [edit, setEdit] = useState<Edit | null>(null);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const group = packageGroup(p.items, x.wo);
  const key = group[0]?.wo ?? x.wo;
  const pkg = p.packages?.[key];
  const others = group.filter((g) => g.wo !== x.wo && !isTypedItem(g.wo)).map((g) => g.wo);
  const sched = p.byWo?.[x.wo];
  const typed = isTypedItem(x.wo);
  const offSchedule = !!p.onSched && !typed && !p.onSched.has(x.wo);
  const late = !!p.since && !!x.addedAt && x.addedAt > p.since;
  const schedSaid = !sched ? "" : sched.cancelled ? "Cancelled on the schedule" : !sched.steps ? "" : sched.done === sched.steps ? "Done on the schedule" : `Schedule: ${sched.done} of ${sched.steps} step${sched.steps === 1 ? "" : "s"} done`;
  const ask = /need|add .*drawing|missing/i.test(x.notes);
  const extra = Object.entries(x.extra ?? {});
  const canPkg = p.canManage && !p.noPkg;

  const menu: MoreItem[] = p.canManage ? [
    { icon: <Pencil aria-hidden className="w-4 h-4" />, label: "Edit", onClick: () => { setEditErr(null); setEdit({ what: x.what, equipment: x.equipment, wo: typed ? "" : x.wo }); } },
    ...(canPkg && !pkg && !x.pkg ? [{ icon: <Paperclip aria-hidden className="w-4 h-4" />, label: "Attach a finished package file", onClick: () => p.onAttach(x.wo) }] : []),
    { icon: <X aria-hidden className="w-4 h-4" />, label: typed ? "Remove the job" : `Remove WO ${x.wo}`, tone: "bad" as const, line: true, onClick: () => p.onRemove(x) },
  ] : [];

  return (
    <li id={`wo-${x.wo}`} className={`${ROW_GRID} px-5 py-3 border-t border-[var(--color-border)] first:border-t-0`}>
      {/* WO */}
      <div className="[grid-area:wo] min-w-0 self-center @4xl:self-start">
        <span className="text-body font-semibold tabular-nums text-[var(--color-text)]">{typed ? "No WO" : <><span className="@4xl:hidden">WO </span>{x.wo}</>}</span>
      </div>

      {/* The work: what, the list's notes, flags, every other column. */}
      <div className="[grid-area:work] min-w-0">
        <div className="text-reading @4xl:text-body font-medium text-[var(--color-text)] break-words">{x.what || <span className="text-[var(--color-text-muted)]">No description</span>}</div>
        {(x.conditional || late || offSchedule) && (
          <div className="text-caption font-medium text-[var(--state-held-text)] flex flex-wrap gap-x-2">
            {x.conditional && <span>Depends on inspection</span>}
            {late && x.addedAt && <span>Added {new Date(x.addedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}, after the RFQ</span>}
            {offSchedule && <span>Not on the schedule</span>}
          </div>
        )}
        {x.notes && <div className={`text-caption break-words ${ask ? "font-medium text-[var(--state-held-text)]" : "text-[var(--color-text-muted)]"}`}><span className="text-[var(--color-text-muted)] font-normal">Notes: </span>{x.notes}</div>}
        {extra.length > 0 && (
          <div className="text-caption break-words text-[var(--color-text-muted)] flex flex-wrap gap-x-3">
            {extra.map(([k, v]) => <span key={k}>{k}: <span className="text-[var(--color-text)]">{v}</span></span>)}
          </div>
        )}
      </div>

      {/* Equipment (or the category, when grouped by equipment). */}
      <div className="[grid-area:eq] min-w-0 text-body text-[var(--color-text)] break-words">
        {groupBy === "equipment" ? (
          <span><span className="@4xl:hidden text-[var(--color-text-muted)]">Category: </span>{x.category}</span>
        ) : (
          <>
            <div>{x.tag && <span className="ui-id mr-1.5">{x.tag}</span>}{x.equipmentName || (x.tag ? "" : x.equipment) || <span className="text-[var(--color-text-muted)]">No equipment</span>}</div>
            {x.equipment && x.equipment !== x.equipmentName && (x.tag || x.equipmentName) && <div className="text-caption tabular-nums text-[var(--color-text-muted)]">{x.equipment}</div>}
            {groupBy === "none" && <div className="text-caption text-[var(--color-text-muted)]">{x.category}</div>}
          </>
        )}
      </div>

      {/* When and by whom it was added. */}
      <div className="[grid-area:meta] min-w-0 text-caption text-[var(--color-text-muted)] flex flex-wrap gap-x-1.5 @4xl:block">
        {x.added || x.addedBy ? (
          <>
            <span className="@4xl:hidden">Added</span>
            {x.added && <span className="tabular-nums @4xl:block @4xl:text-body @4xl:text-[var(--color-text)]">{dateSaid(x.added)}</span>}
            {x.addedBy && <span className="break-all @4xl:block"><span className="@4xl:hidden">by </span>{x.addedBy}</span>}
          </>
        ) : x.typed ? <span>Added here</span> : null}
      </div>

      {/* Its package (shared with the other WOs on the equipment) and the schedule. */}
      <div className="[grid-area:status] min-w-0 grid gap-1 justify-items-start text-caption text-[var(--color-text-muted)]">
        {p.noPkg && !x.pkg && !pkg ? null : pkg ? (() => {
          const s = packageStage(pkg);
          const word = pkg.status === "filed" ? "Filed" : pkg.status === "issued" ? "Printed" : pkg.status === "approved" ? "Approved" : "Draft";
          const dot = pkg.status === "filed" ? "bg-[var(--state-released)]" : pkg.status === "issued" ? "bg-[var(--state-held)]" : pkg.status === "approved" ? "bg-[var(--state-locked)]" : "bg-[var(--color-text-faint)]";
          return (
            <>
              <button type="button" onClick={() => p.onBuild(key)} className="inline-flex items-center gap-1 min-h-9 pointer-coarse:min-h-11 text-body font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2"><Package aria-hidden className="w-3.5 h-3.5" />Package</button>
              <span className="inline-flex items-center gap-1.5"><span aria-hidden className={`w-2 h-2 rounded-full ${dot}`} />{word}{s.forms && pkg.status !== "draft" ? `, ${s.signed} of ${s.forms} forms back` : ""}</span>
              {others.length > 0 && <span>Shared with WO {others.join(", ")}</span>}
            </>
          );
        })() : x.pkg ? (
          <>
            <Link href={x.pkg.href} className="inline-flex items-center gap-1 min-h-9 pointer-coarse:min-h-11 text-body font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2"><FileText aria-hidden className="w-3.5 h-3.5" />{x.pkg.label}</Link>
            {x.approved
              ? <span className="inline-flex items-center gap-1.5"><span aria-hidden className="w-2 h-2 rounded-full bg-[var(--state-released)]" />Approved{x.approvedBy ? ` by ${x.approvedBy}` : ""}</span>
              : p.canManage
                ? <Button variant="secondary" onClick={() => p.onApprove(x.wo)}><Check className="w-4 h-4" /> Mark approved</Button>
                : <span className="inline-flex items-center gap-1.5"><span aria-hidden className="w-2 h-2 rounded-full bg-[var(--state-held)]" />To approve</span>}
          </>
        ) : (
          <>
            {(x.approved || x.drafted) && <span className="inline-flex items-center gap-1.5"><span aria-hidden className={`w-2 h-2 rounded-full ${x.approved ? "bg-[var(--state-released)]" : "bg-[var(--state-locked)]"}`} />{x.approved ? "Approved" : "Drafted"}, per the list</span>}
            {canPkg
              ? <Button variant="secondary" onClick={() => p.onBuild(key)} loading={p.attaching === x.wo}><Package className="w-4 h-4" /> {group.length > 1 ? `Build package (${group.length} ${group.every((g) => isTypedItem(g.wo)) ? "jobs" : "WOs"})` : "Build package"}</Button>
              : !x.drafted && !x.approved && <span className="inline-flex items-center gap-1.5"><span aria-hidden className="w-2 h-2 rounded-full bg-[var(--color-text-faint)]" />No package yet</span>}
            {canPkg && others.length > 0 && <span>With WO {others.join(", ")} (same equipment)</span>}
          </>
        )}
        {schedSaid && <span className={sched?.cancelled ? "font-medium text-[var(--state-held-text)]" : sched && sched.done === sched.steps ? "font-medium text-[var(--state-released-text)]" : ""}>{schedSaid}</span>}
      </div>

      <div className="[grid-area:menu] justify-self-end self-start">
        {menu.length > 0 && <MoreMenu items={menu} label={typed ? `${x.what}: more` : `WO ${x.wo}: more`} iconOnly triggerClass="w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]" />}
      </div>

      {edit && (
        <form className="[grid-column:1/-1] mt-2 grid gap-2 @2xl:grid-cols-[1fr_10rem_9rem] items-end" onSubmit={(e) => { e.preventDefault(); setSaving(true); void p.onSave(x, edit).then((err) => { setSaving(false); if (err) setEditErr(err); else setEdit(null); }); }}>
          <label className="grid gap-1 text-caption text-[var(--color-text-muted)]">What the work is<input value={edit.what} onChange={(e) => setEdit({ ...edit, what: e.target.value })} className={fieldCls} autoFocus /></label>
          <label className="grid gap-1 text-caption text-[var(--color-text-muted)]">Equipment<input value={edit.equipment} onChange={(e) => setEdit({ ...edit, equipment: e.target.value })} className={fieldCls} /></label>
          <label className="grid gap-1 text-caption text-[var(--color-text-muted)]">WO number<input value={edit.wo} disabled={!typed} placeholder="If it has one" onChange={(e) => setEdit({ ...edit, wo: e.target.value })} className={`${fieldCls} disabled:opacity-60`} /></label>
          <div className="@2xl:col-span-3 flex flex-wrap items-center gap-2">
            <Button type="submit" variant="secondary" loading={saving}>Save</Button>
            <Button type="button" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
            {!x.typed && <span className="text-caption text-[var(--color-text-muted)]">The next import of the list puts back what the list says.</span>}
          </div>
          {editErr && <p className="@2xl:col-span-3 text-body font-medium text-[var(--state-overdue-text)]">{editErr}</p>}
        </form>
      )}
    </li>
  );
}
