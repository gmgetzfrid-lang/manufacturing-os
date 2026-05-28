"use client";

// TimelineFeed — reusable rendering of TimelineEvent[] from lib/timeline.ts.
//
// Designed for two consumers initially (HistoryDrawer's per-document
// Timeline tab and the project detail page) so they share one visual
// language for audit/version/activity events. Renders a vertical
// timeline with a left-rail track, color-coded event dots, and per-
// event scope chips when context is attached.
//
// No data fetching here — callers pass the events. Loading and error
// states are also caller-owned.

import React from "react";
import {
  FileText, GitBranch, GitCommitVertical, History as HistoryIcon,
  Download as DownloadIcon, Eye, Lock, LogIn, LogOut, AlertTriangle,
  Archive, Rewind, Stamp, Layers, Activity, MessageSquare,
  AlertOctagon, Check, Flag, Split, Merge, Hash, Repeat2, Undo2, Wrench,
} from "lucide-react";
import type { TimelineEvent } from "@/lib/timeline";

interface TimelineFeedProps {
  events: TimelineEvent[];
  /** When set, renders the scope chips (Plant · Unit · System).
   *  Defaults true. Set false for already-scoped contexts like
   *  the per-document drawer where the scope is implicit. */
  showScope?: boolean;
  /** Empty-state copy. Defaults to "No history yet." */
  emptyMessage?: string;
  /** When provided, reversible audit events (DOC_SPLIT / DOC_MERGED
   *  / DOC_RENUMBERED) render a small "Reverse" button. Click
   *  passes the event up to the caller, which is responsible for
   *  opening a confirmation dialog and calling the appropriate
   *  reverse* lib function. */
  onReverseRequest?: (event: TimelineEvent) => void;
}

const REVERSIBLE_ACTIONS = new Set(["DOC_SPLIT", "DOC_MERGED", "DOC_RENUMBERED"]);
function isReversible(event: TimelineEvent): boolean {
  return event.kind === "audit" && REVERSIBLE_ACTIONS.has(event.action);
}

export default function TimelineFeed({ events, showScope = true, emptyMessage = "No history yet.", onReverseRequest }: TimelineFeedProps) {
  if (events.length === 0) {
    return (
      <div className="text-xs text-slate-500 py-8 text-center border border-dashed border-slate-200 rounded-xl">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Left rail */}
      <div className="absolute left-[15px] top-2 bottom-2 w-0.5 bg-slate-200" />

      <div className="space-y-3">
        {events.map((e) => (
          <TimelineRow key={e.id} event={e} showScope={showScope} onReverseRequest={onReverseRequest} />
        ))}
      </div>
    </div>
  );
}

// ─── Per-row rendering ─────────────────────────────────────────

interface RowVisuals {
  Icon: React.ElementType;
  ringClass: string;
  bgClass: string;
  iconColor: string;
}

function visualsFor(event: TimelineEvent): RowVisuals {
  // Color and icon by action. Stable mapping so a user reading the
  // feed develops muscle memory ("green dot = file released").
  if (event.kind === "version") {
    if (event.action === "VERSION_REVERT") {
      return { Icon: Rewind, ringClass: "border-purple-500", bgClass: "bg-purple-100", iconColor: "text-purple-700" };
    }
    return { Icon: GitCommitVertical, ringClass: "border-emerald-500", bgClass: "bg-emerald-100", iconColor: "text-emerald-700" };
  }
  if (event.kind === "project_activity") {
    if (event.action === "comment") return { Icon: MessageSquare, ringClass: "border-blue-400", bgClass: "bg-blue-50", iconColor: "text-blue-600" };
    return { Icon: Activity, ringClass: "border-slate-400", bgClass: "bg-slate-100", iconColor: "text-slate-600" };
  }
  if (event.kind === "hold") {
    if (event.action === "HOLD_RELEASED") return { Icon: Check, ringClass: "border-emerald-500", bgClass: "bg-emerald-50", iconColor: "text-emerald-700" };
    return { Icon: AlertOctagon, ringClass: "border-amber-500", bgClass: "bg-amber-50", iconColor: "text-amber-700" };
  }
  // audit kind
  switch (event.action) {
    case "VIEW":          return { Icon: Eye,         ringClass: "border-slate-300", bgClass: "bg-slate-100", iconColor: "text-slate-500" };
    case "DOWNLOAD":      return { Icon: DownloadIcon, ringClass: "border-blue-400", bgClass: "bg-blue-50",   iconColor: "text-blue-600" };
    case "CHECK_OUT":     return { Icon: LogOut,       ringClass: "border-amber-400", bgClass: "bg-amber-50", iconColor: "text-amber-700" };
    case "CHECK_IN":      return { Icon: LogIn,        ringClass: "border-emerald-400", bgClass: "bg-emerald-50", iconColor: "text-emerald-700" };
    case "ABANDON":       return { Icon: AlertTriangle, ringClass: "border-orange-400", bgClass: "bg-orange-50", iconColor: "text-orange-700" };
    case "FORCE_RELEASE": return { Icon: AlertTriangle, ringClass: "border-red-400",   bgClass: "bg-red-50",   iconColor: "text-red-700" };
    case "JOIN":          return { Icon: LogIn,        ringClass: "border-slate-300", bgClass: "bg-slate-50", iconColor: "text-slate-600" };
    case "REV_UP":        return { Icon: GitBranch,    ringClass: "border-emerald-500", bgClass: "bg-emerald-100", iconColor: "text-emerald-700" };
    case "REV_BACKFILL":        return { Icon: HistoryIcon,  ringClass: "border-slate-400",   bgClass: "bg-slate-100",   iconColor: "text-slate-600" };
    case "REVERT":              return { Icon: Rewind,       ringClass: "border-purple-500", bgClass: "bg-purple-100",  iconColor: "text-purple-700" };
    case "MILESTONE_CREATED":   return { Icon: Flag,         ringClass: "border-indigo-300", bgClass: "bg-indigo-50",   iconColor: "text-indigo-600" };
    case "MILESTONE_UPDATED":   return { Icon: Flag,         ringClass: "border-indigo-300", bgClass: "bg-indigo-50",   iconColor: "text-indigo-500" };
    case "MILESTONE_COMPLETED": return { Icon: Flag,         ringClass: "border-emerald-500", bgClass: "bg-emerald-100", iconColor: "text-emerald-700" };
    case "MILESTONE_MISSED":    return { Icon: Flag,         ringClass: "border-red-500",    bgClass: "bg-red-50",      iconColor: "text-red-700" };
    case "MILESTONE_BLOCKED":   return { Icon: Flag,         ringClass: "border-amber-500",  bgClass: "bg-amber-50",    iconColor: "text-amber-700" };
    case "MILESTONE_DELETED":   return { Icon: Flag,         ringClass: "border-slate-300",  bgClass: "bg-slate-50",    iconColor: "text-slate-500" };
    case "DOC_SPLIT":           return { Icon: Split,        ringClass: "border-amber-500",  bgClass: "bg-amber-50",    iconColor: "text-amber-700" };
    case "CREATED_FROM_SPLIT":  return { Icon: Split,        ringClass: "border-emerald-400", bgClass: "bg-emerald-50",  iconColor: "text-emerald-700" };
    case "DOC_MERGED":          return { Icon: Merge,        ringClass: "border-amber-500",  bgClass: "bg-amber-50",    iconColor: "text-amber-700" };
    case "CREATED_FROM_MERGE":  return { Icon: Merge,        ringClass: "border-emerald-400", bgClass: "bg-emerald-50",  iconColor: "text-emerald-700" };
    case "DOC_RENUMBERED":      return { Icon: Hash,         ringClass: "border-slate-400",  bgClass: "bg-slate-100",   iconColor: "text-slate-600" };
    case "SET_REV_UP":          return { Icon: Repeat2,      ringClass: "border-emerald-500", bgClass: "bg-emerald-100", iconColor: "text-emerald-700" };
    case "DOC_SPLIT_REVERSED":  return { Icon: Undo2,        ringClass: "border-slate-400",  bgClass: "bg-slate-100",   iconColor: "text-slate-600" };
    case "DOC_MERGE_REVERSED":  return { Icon: Undo2,        ringClass: "border-slate-400",  bgClass: "bg-slate-100",   iconColor: "text-slate-600" };
    case "DOC_RENUMBER_REVERSED": return { Icon: Undo2,      ringClass: "border-slate-400",  bgClass: "bg-slate-100",   iconColor: "text-slate-600" };
    case "EQUIPMENT_STATE_CHANGED": return { Icon: Wrench,   ringClass: "border-blue-400",   bgClass: "bg-blue-50",     iconColor: "text-blue-700" };
    case "SUPERSEDE_DOC": return { Icon: Stamp,        ringClass: "border-amber-500", bgClass: "bg-amber-50", iconColor: "text-amber-700" };
    case "ARCHIVE_DOC":   return { Icon: Archive,      ringClass: "border-slate-400", bgClass: "bg-slate-100", iconColor: "text-slate-600" };
    default:              return { Icon: HistoryIcon,  ringClass: "border-slate-300", bgClass: "bg-slate-50", iconColor: "text-slate-500" };
  }
}

function TimelineRow({ event, showScope, onReverseRequest }: { event: TimelineEvent; showScope: boolean; onReverseRequest?: (e: TimelineEvent) => void }) {
  const v = visualsFor(event);
  const { Icon } = v;
  const reversible = !!onReverseRequest && isReversible(event);
  return (
    <div className="flex items-start relative">
      {/* Dot */}
      <div className={`w-8 h-8 rounded-full ${v.bgClass} border-2 ${v.ringClass} flex items-center justify-center shrink-0 z-10 mr-3 ring-4 ring-white shadow-sm`}>
        <Icon className={`w-3.5 h-3.5 ${v.iconColor}`} />
      </div>

      {/* Body */}
      <div className="flex-1 min-w-0 bg-white border border-slate-200 rounded-lg p-3 shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-bold text-slate-800">{event.summary}</div>
            <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
              <span>{formatTime(event.timestamp)}</span>
              {(event.userName || event.userEmail) && (
                <>
                  <span className="text-slate-300">·</span>
                  <span>{event.userName || event.userEmail}</span>
                </>
              )}
              <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded border border-slate-200">
                {event.kind === "version" ? "Rev" : event.kind === "audit" ? "Audit" : event.kind === "hold" ? "Hold" : "Activity"}
              </span>
            </div>
            {showScope && event.scope && (event.scope.plantName || event.scope.unitName || event.scope.systemName) && (
              <div className="mt-1.5 flex items-center gap-1 text-[10px] text-slate-500">
                {event.scope.plantName && <ScopeChip label={event.scope.plantName} tone="blue" />}
                {event.scope.unitName && <ScopeChip label={event.scope.unitName} tone="purple" />}
                {event.scope.systemName && <ScopeChip label={event.scope.systemName} tone="emerald" />}
              </div>
            )}
          </div>
          {reversible && (
            <button
              onClick={() => onReverseRequest?.(event)}
              className="shrink-0 inline-flex items-center gap-1 text-[10px] font-bold text-slate-600 hover:text-slate-900 bg-slate-50 hover:bg-slate-100 border border-slate-200 px-1.5 py-1 rounded"
              title="Reverse this operation (audit-preserving)"
            >
              <Undo2 className="w-3 h-3" /> Reverse
            </button>
          )}
        </div>

        {/* Inline details for version events: change log */}
        {event.kind === "version" && event.details && typeof event.details.changeLog === "string" && event.details.changeLog && (
          <div className="mt-2 text-[11px] text-slate-600 whitespace-pre-wrap border-t border-slate-100 pt-2 flex items-start gap-1.5">
            <FileText className="w-3 h-3 mt-0.5 shrink-0 text-slate-400" />
            <span>{event.details.changeLog as string}</span>
          </div>
        )}
        {event.kind === "project_activity" && event.action === "comment" && typeof event.details === "object" && (
          <></>
        )}
      </div>
    </div>
  );
}

function ScopeChip({ label, tone }: { label: string; tone: "blue" | "purple" | "emerald" }) {
  const toneClass =
    tone === "blue" ? "bg-blue-50 text-blue-700 border-blue-200"
    : tone === "purple" ? "bg-purple-50 text-purple-700 border-purple-200"
    : "bg-emerald-50 text-emerald-700 border-emerald-200";
  return (
    <span className={`inline-flex items-center gap-1 ${toneClass} border px-1.5 py-0.5 rounded font-mono`}>
      <Layers className="w-2.5 h-2.5" /> {label}
    </span>
  );
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString();
  } catch { return "—"; }
}
