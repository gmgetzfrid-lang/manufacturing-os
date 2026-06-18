"use client";

import React from "react";
import Link from "next/link";
import { GripVertical, X, Settings2, ChevronRight } from "lucide-react";
import type { DashboardWidget } from "@/lib/dashboard/types";
import { WIDGET_CATALOG, toneGradient, toneWash } from "./widgets";

interface Props {
  widget: DashboardWidget;
  editing: boolean;
  onRemove: () => void;
  onOpenSettings: () => void;
}

export default function WidgetFrame({ widget, editing, onRemove, onOpenSettings }: Props) {
  const meta = WIDGET_CATALOG[widget.type];
  if (!meta) return null;
  const Icon = meta.icon;
  const Body = meta.Body;

  return (
    <div
      className={`group/widget relative flex flex-col h-full rounded-2xl border bg-[var(--color-surface)] overflow-hidden ${
        editing
          ? "border-dashed border-[var(--color-accent)] shadow-sm"
          : "border-[var(--color-border)] shadow-sm hover-lift"
      }`}
    >
      {/* Faint tonal wash up top — gives the card life without flooding it. */}
      <div className={`pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b ${toneWash(meta.tone)} to-transparent`} />

      {editing && (
        <>
          <GripVertical className="absolute top-4 left-2 w-4 h-4 text-[var(--color-text-muted)]/60 z-10 pointer-events-none" />
          <div className="absolute top-2.5 right-2.5 flex items-center gap-1 z-10">
            {meta.hasSettings && (
              <button type="button" onClick={onOpenSettings} title="Widget settings"
                className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
                <Settings2 className="w-4 h-4" />
              </button>
            )}
            <button type="button" onClick={onRemove} title="Remove widget"
              className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-red-600 hover:bg-red-50 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </>
      )}

      {/* min-h-0 lets the body flex region shrink so its internal scroll works. */}
      <div className={`relative flex-1 min-h-0 flex flex-col p-5 ${editing ? "pl-7" : ""}`}>
        {/* Header — gradient icon badge + label. The footer opens the whole tool. */}
        <div className="flex items-center gap-3 shrink-0">
          <span className={`inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br ${toneGradient(meta.tone)} text-white shadow-md ring-1 ring-white/15 shrink-0`}>
            <Icon className="w-5 h-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-[15px] font-black text-[var(--color-text)] tracking-tight truncate">{meta.title}</h3>
            <p className="text-[11px] text-[var(--color-text-muted)] truncate">{meta.description}</p>
          </div>
        </div>

        {/* Body is non-interactive while editing so drag/controls win over links. */}
        <div className={`flex-1 min-h-0 flex flex-col ${editing ? "pointer-events-none opacity-90" : ""}`}>
          <Body widget={widget} />
        </div>
      </div>

      {!editing && (
        <Link
          href={meta.href}
          className="relative flex items-center justify-between px-5 py-2.5 border-t border-[var(--color-border)] text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-surface-2)] transition-colors shrink-0"
        >
          <span>{meta.cta}</span>
          <ChevronRight className="w-4 h-4 transition-transform group-hover/widget:translate-x-0.5" />
        </Link>
      )}
    </div>
  );
}
