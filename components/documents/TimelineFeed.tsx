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
  Download as DownloadIcon, Eye, LogIn, LogOut, AlertTriangle,
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
      <div className="text-body text-[var(--color-text-muted)] py-8 text-center border border-dashed border-[var(--color-border)] rounded-xl">
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
      return { Icon: Rewind, ringClass: "border-[var(--color-border-strong)]", bgClass: "bg-[var(--color-surface-2)]", iconColor: "text-[var(--color-text-muted)]" };
    }
    return { Icon: GitCommitVertical, ringClass: "border-[var(--state-released)]", bgClass: "bg-[color-mix(in_srgb,var(--state-released)_10%,transparent)]", iconColor: "text-[var(--state-released)]" };
  }
  if (event.kind === "project_activity") {
    if (event.action === "comment") return { Icon: MessageSquare, ringClass: "border-[var(--color-border-strong)]", bgClass: "bg-[var(--color-surface-2)]", iconColor: "text-[var(--color-text-muted)]" };
    return { Icon: Activity, ringClass: "border-[var(--color-border-strong)]", bgClass: "bg-[var(--color-surface-2)]", iconColor: "text-[var(--color-text-muted)]" };
  }
  if (event.kind === "hold") {
    if (event.action === "HOLD_RELEASED") return { Icon: Check, ringClass: "border-[var(--state-released)]", bgClass: "bg-[color-mix(in_srgb,var(--state-released)_10%,transparent)]", iconColor: "text-[var(--state-released)]" };
    return { Icon: AlertOctagon, ringClass: "border-[var(--state-held)]", bgClass: "bg-[color-mix(in_srgb,var(--state-held)_12%,transparent)]", iconColor: "text-[var(--state-held)]" };
  }
  // audit kind
  switch (event.action) {
    case "VIEW":          return { Icon: Eye,         ringClass: "border-[var(--color-border-strong)]", bgClass: "bg-[var(--color-surface-2)]", iconColor: "text-[var(--color-text-muted)]" };
    case "DOWNLOAD":      return { Icon: DownloadIcon, ringClass: "border-[var(--color-border-strong)]", bgClass: "bg-[var(--color-surface-2)]",   iconColor: "text-[var(--color-text)]" };
    case "CHECK_OUT":     return { Icon: LogOut,       ringClass: "border-[var(--state-held)]", bgClass: "bg-[color-mix(in_srgb,var(--state-held)_12%,transparent)]", iconColor: "text-[var(--state-held)]" };
    case "CHECK_IN":      return { Icon: LogIn,        ringClass: "border-[var(--state-released)]", bgClass: "bg-[color-mix(in_srgb,var(--state-released)_10%,transparent)]", iconColor: "text-[var(--state-released)]" };
    case "ABANDON":       return { Icon: AlertTriangle, ringClass: "border-[var(--color-border-strong)]", bgClass: "bg-[var(--color-surface-2)]", iconColor: "text-[var(--color-text)]" };
    case "FORCE_RELEASE": return { Icon: AlertTriangle, ringClass: "border-[var(--state-overdue)]",   bgClass: "bg-[color-mix(in_srgb,var(--state-overdue)_10%,transparent)]",   iconColor: "text-[var(--state-overdue)]" };
    case "JOIN":          return { Icon: LogIn,        ringClass: "border-[var(--color-border-strong)]", bgClass: "bg-[var(--color-surface-2)]", iconColor: "text-[var(--color-text-muted)]" };
    case "REV_UP":        return { Icon: GitBranch,    ringClass: "border-[var(--state-released)]", bgClass: "bg-[color-mix(in_srgb,var(--state-released)_10%,transparent)]", iconColor: "text-[var(--state-released)]" };
    case "REV_BACKFILL":        return { Icon: HistoryIcon,  ringClass: "border-[var(--color-border-strong)]",   bgClass: "bg-[var(--color-surface-2)]",   iconColor: "text-[var(--color-text-muted)]" };
    case "REVERT":              return { Icon: Rewind,       ringClass: "border-[var(--color-border-strong)]", bgClass: "bg-[var(--color-surface-2)]",  iconColor: "text-[var(--color-text)]" };
    case "MILESTONE_CREATED":   return { Icon: Flag,         ringClass: "border-[var(--color-border)]", bgClass: "bg-[var(--color-surface-2)]",   iconColor: "text-[var(--color-text)]" };
    case "MILESTONE_UPDATED":   return { Icon: Flag,         ringClass: "border-[var(--color-border)]", bgClass: "bg-[var(--color-surface-2)]",   iconColor: "text-[var(--color-text-muted)]" };
    case "MILESTONE_COMPLETED": return { Icon: Flag,         ringClass: "border-[var(--state-released)]", bgClass: "bg-[color-mix(in_srgb,var(--state-released)_10%,transparent)]", iconColor: "text-[var(--state-released)]" };
    case "MILESTONE_MISSED":    return { Icon: Flag,         ringClass: "border-[var(--state-overdue)]",    bgClass: "bg-[color-mix(in_srgb,var(--state-overdue)_10%,transparent)]",      iconColor: "text-[var(--state-overdue)]" };
    case "MILESTONE_BLOCKED":   return { Icon: Flag,         ringClass: "border-[var(--state-held)]",  bgClass: "bg-[color-mix(in_srgb,var(--state-held)_12%,transparent)]",    iconColor: "text-[var(--state-held)]" };
    case "MILESTONE_DELETED":   return { Icon: Flag,         ringClass: "border-[var(--color-border-strong)]",  bgClass: "bg-[var(--color-surface-2)]",    iconColor: "text-[var(--color-text-muted)]" };
    case "DOC_SPLIT":           return { Icon: Split,        ringClass: "border-[var(--state-held)]",  bgClass: "bg-[color-mix(in_srgb,var(--state-held)_12%,transparent)]",    iconColor: "text-[var(--state-held)]" };
    case "CREATED_FROM_SPLIT":  return { Icon: Split,        ringClass: "border-[var(--state-released)]", bgClass: "bg-[color-mix(in_srgb,var(--state-released)_10%,transparent)]",  iconColor: "text-[var(--state-released)]" };
    case "DOC_MERGED":          return { Icon: Merge,        ringClass: "border-[var(--state-held)]",  bgClass: "bg-[color-mix(in_srgb,var(--state-held)_12%,transparent)]",    iconColor: "text-[var(--state-held)]" };
    case "CREATED_FROM_MERGE":  return { Icon: Merge,        ringClass: "border-[var(--state-released)]", bgClass: "bg-[color-mix(in_srgb,var(--state-released)_10%,transparent)]",  iconColor: "text-[var(--state-released)]" };
    case "DOC_RENUMBERED":      return { Icon: Hash,         ringClass: "border-[var(--color-border-strong)]",  bgClass: "bg-[var(--color-surface-2)]",   iconColor: "text-[var(--color-text-muted)]" };
    case "SET_REV_UP":          return { Icon: Repeat2,      ringClass: "border-[var(--state-released)]", bgClass: "bg-[color-mix(in_srgb,var(--state-released)_10%,transparent)]", iconColor: "text-[var(--state-released)]" };
    case "DOC_SPLIT_REVERSED":  return { Icon: Undo2,        ringClass: "border-[var(--color-border-strong)]",  bgClass: "bg-[var(--color-surface-2)]",   iconColor: "text-[var(--color-text-muted)]" };
    case "DOC_MERGE_REVERSED":  return { Icon: Undo2,        ringClass: "border-[var(--color-border-strong)]",  bgClass: "bg-[var(--color-surface-2)]",   iconColor: "text-[var(--color-text-muted)]" };
    case "DOC_RENUMBER_REVERSED": return { Icon: Undo2,      ringClass: "border-[var(--color-border-strong)]",  bgClass: "bg-[var(--color-surface-2)]",   iconColor: "text-[var(--color-text-muted)]" };
    case "EQUIPMENT_STATE_CHANGED": return { Icon: Wrench,   ringClass: "border-[var(--color-border-strong)]",   bgClass: "bg-[var(--color-surface-2)]",     iconColor: "text-[var(--color-text)]" };
    case "SUPERSEDE_DOC": return { Icon: Stamp,        ringClass: "border-[var(--state-held)]", bgClass: "bg-[color-mix(in_srgb,var(--state-held)_12%,transparent)]", iconColor: "text-[var(--state-held)]" };
    case "ARCHIVE_DOC":   return { Icon: Archive,      ringClass: "border-[var(--color-border-strong)]", bgClass: "bg-[var(--color-surface-2)]", iconColor: "text-[var(--color-text-muted)]" };
    default:              return { Icon: HistoryIcon,  ringClass: "border-[var(--color-border-strong)]", bgClass: "bg-[var(--color-surface-2)]", iconColor: "text-[var(--color-text-muted)]" };
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
      <div className="flex-1 min-w-0 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-3 shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-body font-medium text-[var(--color-text)]">{event.summary}</div>
            <div className="text-body text-[var(--color-text-muted)] mt-0.5 flex items-center gap-2 flex-wrap">
              <span>{formatTime(event.timestamp)}</span>
              {(event.userName || event.userEmail) && (
                <>
                  <span className="text-[var(--color-text-faint)]">·</span>
                  <span>{event.userName || event.userEmail}</span>
                </>
              )}
              <span className="text-body font-medium text-[var(--color-text-faint)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded border border-[var(--color-border)]">
                {event.kind === "version" ? "Rev" : event.kind === "audit" ? "Audit" : event.kind === "hold" ? "Hold" : "Activity"}
              </span>
            </div>
            {showScope && event.scope && (event.scope.plantName || event.scope.unitName || event.scope.systemName) && (
              <div className="mt-1.5 flex items-center gap-1 text-body text-[var(--color-text-muted)]">
                {event.scope.plantName && <ScopeChip label={event.scope.plantName} tone="blue" />}
                {event.scope.unitName && <ScopeChip label={event.scope.unitName} tone="purple" />}
                {event.scope.systemName && <ScopeChip label={event.scope.systemName} tone="emerald" />}
              </div>
            )}
          </div>
          {reversible && (
            <button
              onClick={() => onReverseRequest?.(event)}
              className="shrink-0 inline-flex items-center gap-1 text-body font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-2)] border border-[var(--color-border)] px-1.5 py-1 rounded"
              title="Reverse this operation (audit-preserving)"
            >
              <Undo2 className="w-3 h-3" /> Reverse
            </button>
          )}
        </div>

        {/* Inline details for version events: change log */}
        {event.kind === "version" && event.details && typeof event.details.changeLog === "string" && event.details.changeLog && (
          <div className="mt-2 text-body text-[var(--color-text-muted)] whitespace-pre-wrap border-t border-[var(--color-border)] pt-2 flex items-start gap-1.5">
            <FileText className="w-3 h-3 mt-0.5 shrink-0 text-[var(--color-text-faint)]" />
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
    tone === "blue" ? "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]"
    : tone === "purple" ? "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]"
    : "bg-[color-mix(in_srgb,var(--state-released)_10%,transparent)] text-[var(--state-released)] border-[color-mix(in_srgb,var(--state-released)_35%,transparent)]";
  return (
    <span className={`inline-flex items-center gap-1 ${toneClass} border px-1.5 py-0.5 rounded font-display tabular-nums`}>
      <Layers className="w-2.5 h-2.5" /> {label}
    </span>
  );
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "-";
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), hour: "numeric", minute: "2-digit" });
  } catch { return "-"; }
}
