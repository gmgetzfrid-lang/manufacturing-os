"use client";

// components/find/FindPanels.tsx — the pieces every surface renders around
// a find: who the query resolved to, how each result relates to it, what is
// happening around it right now, and how much of the scope has been read.
// One set of components so a result looks the same in the Documents graph,
// the palette, and the equipment page.

import React from "react";
import Link from "next/link";
import { Cpu, Factory, FolderKanban, Ticket, Lock, PenLine, AlertOctagon, Flag, Eye, EyeOff, MapPin, Quote, Tag, FolderOpen, Briefcase, ImageIcon, ChevronRight, Globe, ExternalLink, Crosshair } from "lucide-react";
import SignedImg from "@/components/assets/SignedImg";
import { globalGraphHref } from "@/lib/estate/lenses";
import type { FindEntity, FindActivity, FindCoverage, FindRelation, FindResult } from "@/lib/find/types";

const REL_ICON: Record<FindRelation["rel"], React.ComponentType<{ className?: string }>> = {
  drawn_on: MapPin, mentioned_in: Quote, tagged_to: Tag, filed_under: FolderOpen, in_project: Briefcase, linked_unit: Factory,
};
const REL_LABEL: Record<FindRelation["rel"], string> = {
  drawn_on: "drawn on", mentioned_in: "mentioned", tagged_to: "tagged", filed_under: "filed under", in_project: "project", linked_unit: "unit",
};

export function EntityStrip({ entities }: { entities: FindEntity[] }) {
  if (!entities.length) return null;
  const Icon = (k: FindEntity["kind"]) => (k === "asset" ? Cpu : k === "unit" ? Factory : k === "tag" ? Tag : FolderKanban);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Looking at</span>
      {entities.map((e) => {
        const I = Icon(e.kind);
        const body = (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5">
            <I className={`w-3.5 h-3.5 ${e.kind === "asset" ? "text-emerald-600" : e.kind === "unit" ? "text-purple-600" : e.kind === "tag" ? "text-slate-500" : "text-amber-600"}`} />
            <span className="font-bold">{e.label}</span>
            {e.sub && <span className="text-[var(--color-text-muted)]">· {e.sub}</span>}
            {e.via !== "typed" && <span className="text-[10px] text-[var(--color-text-faint)]">({e.via})</span>}
          </span>
        );
        return e.href ? <Link key={e.node} href={e.href} className="hover:underline">{body}</Link> : <span key={e.node}>{body}</span>;
      })}
    </div>
  );
}

/** What the estate holds on each piece of equipment the query named: the
 *  unit it sits in, what it is, its photos, and how many of the results are
 *  drawn with it, tagged to it, mention it or are filed under it — with the
 *  doors to its page and the global graph. A tag read off the drawings that
 *  the registry has never heard of says so, with the step that fixes it. */
export function EquipmentCards({ entities, results, onReveal, onUnit }: {
  entities: FindEntity[]; results: FindResult[];
  /** Centre the map on the results related to this entity. */
  onReveal?: (node: string) => void;
  /** Narrow to a unit. */
  onUnit?: (code: string) => void;
}) {
  const cards = entities.filter((e) => e.kind === "asset" || e.kind === "tag");
  if (!cards.length) return null;
  const countsFor = (node: string) => {
    const c = { drawn_on: 0, tagged_to: 0, mentioned_in: 0, filed_under: 0 };
    for (const r of results) {
      const kinds = new Set(r.relations.filter((x) => x.node === node).map((x) => x.rel));
      for (const k of kinds) if (k in c) c[k as keyof typeof c]++;
    }
    return c;
  };
  return (
    <div className="space-y-2">
      {cards.map((e) => {
        const c = countsFor(e.node);
        const related = c.drawn_on + c.tagged_to + c.mentioned_in + c.filed_under;
        const parts: string[] = [];
        if (c.drawn_on) parts.push(`drawn on ${c.drawn_on} sheet${c.drawn_on === 1 ? "" : "s"}`);
        if (c.tagged_to) parts.push(`tagged on ${c.tagged_to}`);
        if (c.mentioned_in) parts.push(`mentioned in ${c.mentioned_in}`);
        if (c.filed_under) parts.push(`${c.filed_under} filed under it`);
        return (
          <div key={e.node} className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20 p-2.5 text-xs">
            <div className="flex items-center gap-1 flex-wrap text-[11px] text-[var(--color-text-muted)]">
              {e.unitCode ? (
                <button onClick={() => onUnit?.(e.unitCode!)} className="inline-flex items-center gap-1 font-bold text-purple-700 hover:underline" title="Narrow to this unit"><Factory className="w-3 h-3" /> {e.unitLabel ?? e.unitCode}</button>
              ) : <span className="inline-flex items-center gap-1"><Factory className="w-3 h-3" /> no unit on record</span>}
              <ChevronRight className="w-3 h-3" />
              <span className="inline-flex items-center gap-1 font-bold text-emerald-700">{e.kind === "asset" ? <Cpu className="w-3 h-3" /> : <Tag className="w-3 h-3" />} {e.typeName ?? (e.kind === "asset" ? "Equipment" : "Tag")}</span>
            </div>
            <div className="mt-0.5 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-black text-[var(--color-text)]">{e.label}{e.code ? <span className="ml-1.5 text-[11px] font-semibold text-[var(--color-text-muted)]">{e.code}</span> : null}</div>
                {e.description && <div className="text-[11px] text-[var(--color-text-muted)] truncate">{e.description}</div>}
                <div className="text-[11px] text-[var(--color-text-muted)]">
                  {e.kind === "tag"
                    ? <>Read off the drawings; not in the equipment registry yet. Documents › the drawing library › <b>Equipment</b> sweep puts it there.</>
                    : related ? <>{parts.join(" · ")}{e.via !== "typed" ? ` · found ${e.via}` : ""}</> : <>Nothing in the results is linked to it yet{e.via !== "typed" ? ` · found ${e.via}` : ""}.</>}
                </div>
              </div>
              {e.kind === "asset" && (
                <div className="flex shrink-0 items-center gap-1">
                  {e.photoPaths?.length ? e.photoPaths.slice(0, 3).map((p) => (
                    <div key={p} className="w-11 h-11 rounded-lg overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface-2)]">
                      <SignedImg path={p} alt="" className="w-full h-full object-cover" placeholder={<ImageIcon className="w-4 h-4 m-auto text-[var(--color-text-faint)]" />} />
                    </div>
                  )) : <div className="w-11 h-11 rounded-lg border border-dashed border-[var(--color-border)] flex items-center justify-center" title="No photos on file"><ImageIcon className="w-4 h-4 text-[var(--color-text-faint)]" /></div>}
                  {(e.photos ?? 0) > 3 && <span className="text-[10px] text-[var(--color-text-muted)]">+{(e.photos ?? 0) - 3}</span>}
                </div>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {e.href && <Link href={e.href} className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[11px] font-semibold hover:underline"><ExternalLink className="w-3 h-3" /> Equipment page{e.photos ? ` · ${e.photos} photo${e.photos === 1 ? "" : "s"}` : ""}</Link>}
              {e.kind === "asset" && <Link href={globalGraphHref(e.node)} className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[11px] font-semibold hover:underline"><Globe className="w-3 h-3" /> Global graph</Link>}
              {related > 0 && onReveal && <button onClick={() => onReveal(e.node)} className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[11px] font-semibold hover:underline"><Crosshair className="w-3 h-3" /> Show on map</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function RelationChips({ relations, onPage }: { relations: FindRelation[]; onPage?: (r: FindRelation) => void }) {
  if (!relations.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {relations.slice(0, 6).map((r, i) => {
        const I = REL_ICON[r.rel];
        const clickable = !!onPage && r.page != null;
        return (
          <button key={i} type="button" disabled={!clickable} onClick={() => clickable && onPage!(r)} title={r.snippet ?? r.detail}
            className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-semibold ${r.rel === "drawn_on" ? "bg-sky-50 border-sky-200 text-sky-800" : r.rel === "mentioned_in" ? "bg-indigo-50 border-indigo-200 text-indigo-800" : "bg-slate-50 border-slate-200 text-slate-700"} ${clickable ? "hover:ring-1 hover:ring-sky-300 cursor-pointer" : "cursor-default"}`}>
            <I className="w-3 h-3" /> {REL_LABEL[r.rel]} {r.label}{r.detail ? ` · ${r.detail}` : ""}
          </button>
        );
      })}
      {relations.length > 6 && <span className="text-[10px] text-[var(--color-text-muted)]">+{relations.length - 6} more</span>}
    </div>
  );
}

export function PageHits({ pages, onPage }: { pages: FindResult["pages"]; onPage?: (page: number, knowledgeDocId: string) => void }) {
  if (!pages.length) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {pages.slice(0, 3).map((p, i) => (
        <li key={i} className="text-[11px] text-[var(--color-text-muted)]">
          <button type="button" onClick={() => onPage?.(p.page, p.knowledgeDocId)} className="font-bold text-sky-700 hover:underline">p.{p.page}</button> “{p.snippet}”
        </li>
      ))}
    </ul>
  );
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");

export function ActivityPanel({ activity, compact = false }: { activity: FindActivity; compact?: boolean }) {
  const total = activity.tickets.length + activity.checkouts.length + activity.markups.length + activity.holds.length + activity.projects.length + activity.milestones.length;
  if (!total) {
    return <div className="text-xs text-[var(--color-text-muted)]">Nothing in flight: no open requests, checkouts, markups, holds or scoped projects touch this.</div>;
  }
  const Row = ({ icon: I, tone, href, title, sub }: { icon: React.ComponentType<{ className?: string }>; tone: string; href: string; title: string; sub?: string }) => (
    <li>
      <Link href={href} className="flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-[var(--color-canvas)]">
        <I className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${tone}`} />
        <span className="min-w-0"><span className="block text-xs font-semibold truncate">{title}</span>{sub && <span className="block text-[11px] text-[var(--color-text-muted)] truncate">{sub}</span>}</span>
      </Link>
    </li>
  );
  const lim = compact ? 3 : 8;
  return (
    <ul className="space-y-0.5">
      {activity.projects.slice(0, lim).map((p) => <Row key={`p${p.id}`} icon={Briefcase} tone="text-amber-600" href={p.href} title={p.name} sub={`Project${p.status ? ` · ${p.status}` : ""} · ${p.why}`} />)}
      {activity.tickets.slice(0, lim).map((t) => <Row key={`t${t.id}`} icon={Ticket} tone="text-rose-600" href={t.href} title={`${t.ticketId} · ${t.title}`} sub={`Drafting request · ${t.status}${t.unit ? ` · ${t.unit}` : ""}${t.drafter ? ` · ${t.drafter}` : t.requester ? ` · ${t.requester}` : ""} · ${t.why}`} />)}
      {activity.checkouts.slice(0, lim).map((c) => <Row key={`c${c.id}`} icon={Lock} tone="text-blue-600" href={c.href} title={c.documentName} sub={`Checked out by ${c.user ?? "someone"} since ${when(c.since)}${c.projectName ? ` under ${c.projectName}` : ""}${c.mode ? ` · ${c.mode}` : ""}`} />)}
      {activity.markups.slice(0, lim).map((m) => <Row key={`m${m.id}`} icon={PenLine} tone="text-violet-600" href={m.href} title={m.documentName} sub={`Markup ${m.status} · ${m.requestedBy ?? "?"} → ${m.requestedFrom ?? "?"} · ${when(m.createdAt)}`} />)}
      {activity.holds.slice(0, lim).map((h) => <Row key={`h${h.id}`} icon={AlertOctagon} tone="text-red-600" href={h.href} title={h.documentName} sub={`On hold${h.reason ? `: ${h.reason}` : ""} · ${h.openedBy ?? ""} ${when(h.openedAt)}`} />)}
      {activity.milestones.slice(0, lim).map((m) => <Row key={`ms${m.id}`} icon={Flag} tone="text-emerald-600" href={m.href} title={m.name} sub={`Milestone${m.plannedAt ? ` · ${when(m.plannedAt)}` : ""}${m.projectName ? ` · ${m.projectName}` : ""}${m.status ? ` · ${m.status}` : ""}`} />)}
    </ul>
  );
}

export function CoverageLine({ coverage, onReadFolder }: { coverage: FindCoverage; onReadFolder?: (f: FindCoverage["unreadFolders"][number]) => void }) {
  if (!coverage.inScope) return null;
  const pct = Math.round((coverage.read / coverage.inScope) * 100);
  return (
    <div className="text-[11px] text-[var(--color-text-muted)] space-y-1">
      <div className="flex items-center gap-1.5">
        {pct >= 100 ? <Eye className="w-3 h-3 text-emerald-600" /> : <EyeOff className="w-3 h-3 text-amber-600" />}
        <span><b>{coverage.read}</b> of <b>{coverage.inScope}</b> files in this scope have had their contents read ({pct}%). Names and folders are always searched; contents only once read.</span>
      </div>
      {coverage.unreadFolders.length > 0 && coverage.unread > 0 && (
        <ul className="pl-4 space-y-0.5">
          {coverage.unreadFolders.slice(0, 3).map((f, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="truncate">{f.path || "Library root"} · {f.count} unread</span>
              {onReadFolder && <button type="button" onClick={() => onReadFolder(f)} className="shrink-0 rounded border border-[var(--color-border)] px-1.5 py-px text-[10px] font-bold hover:bg-[var(--color-canvas)]">Read these…</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
