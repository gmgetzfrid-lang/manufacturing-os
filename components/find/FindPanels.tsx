"use client";

// components/find/FindPanels.tsx — the pieces every surface renders around
// a find: who the query resolved to, how each result relates to it, what is
// happening around it right now, and how much of the scope has been read.
// One set of components so a result looks the same in the Documents graph,
// the palette, and the equipment page.

import React from "react";
import Link from "next/link";
import { Cpu, Factory, FolderKanban, Ticket, Lock, PenLine, AlertOctagon, Flag, Eye, EyeOff, MapPin, Quote, Tag, FolderOpen, Briefcase } from "lucide-react";
import type { FindEntity, FindActivity, FindCoverage, FindRelation, FindResult } from "@/lib/find/types";

const REL_ICON: Record<FindRelation["rel"], React.ComponentType<{ className?: string }>> = {
  drawn_on: MapPin, mentioned_in: Quote, tagged_to: Tag, filed_under: FolderOpen, in_project: Briefcase, linked_unit: Factory,
};
const REL_LABEL: Record<FindRelation["rel"], string> = {
  drawn_on: "drawn on", mentioned_in: "mentioned", tagged_to: "tagged", filed_under: "filed under", in_project: "project", linked_unit: "unit",
};

export function EntityStrip({ entities }: { entities: FindEntity[] }) {
  if (!entities.length) return null;
  const Icon = (k: FindEntity["kind"]) => (k === "asset" ? Cpu : k === "unit" ? Factory : FolderKanban);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Looking at</span>
      {entities.map((e) => {
        const I = Icon(e.kind);
        const body = (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5">
            <I className={`w-3.5 h-3.5 ${e.kind === "asset" ? "text-emerald-600" : e.kind === "unit" ? "text-purple-600" : "text-amber-600"}`} />
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
