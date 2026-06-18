"use client";

import React from "react";
import Link from "next/link";
import { GripVertical, X, Settings2, Maximize2, Minimize2, ChevronRight } from "lucide-react";
import type { DashboardWidget } from "@/lib/dashboard/types";
import { WIDGET_CATALOG, toneChip } from "./widgets";

interface Props {
  widget: DashboardWidget;
  editing: boolean;
  onRemove: () => void;
  onToggleWidth: () => void;
  onOpenSettings: () => void;
}

export default function WidgetFrame({ widget, editing, onRemove, onToggleWidth, onOpenSettings }: Props) {
  const meta = WIDGET_CATALOG[widget.type];
  if (!meta) return null;
  const Icon = meta.icon;
  const Body = meta.Body;

  const header = (
    <div className="flex items-center gap-3">
      <span className={`inline-flex items-center justify-center w-9 h-9 rounded-xl ${toneChip(meta.tone)} shrink-0`}>
        <Icon className="w-5 h-5" />
      </span>
      <div className="min-w-0">
        <h3 className="text-sm font-black text-[var(--color-text)] truncate">{meta.title}</h3>
        <p className="text-[11px] text-[var(--color-text-muted)] truncate">{meta.description}</p>
      </div>
      {!editing && (
        <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
      )}
    </div>
  );

  return (
    <div
      className={`relative h-full rounded-2xl border bg-[var(--color-surface)] p-5 transition-shadow ${
        editing
          ? "border-dashed border-[var(--color-accent)] cursor-move shadow-sm"
          : "border-[var(--color-border)] hover:shadow-md"
      }`}
    >
      {editing && (
        <div className="absolute top-2.5 right-2.5 flex items-center gap-1 z-10">
          <button
            type="button" onClick={onToggleWidth} title={widget.width === "full" ? "Make half width" : "Make full width"}
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
          >
            {widget.width === "full" ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          {meta.hasSettings && (
            <button
              type="button" onClick={onOpenSettings} title="Widget settings"
              className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
            >
              <Settings2 className="w-4 h-4" />
            </button>
          )}
          <button
            type="button" onClick={onRemove} title="Remove widget"
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-red-600 hover:bg-red-50 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {editing && (
        <GripVertical className="absolute top-3 left-2 w-4 h-4 text-[var(--color-text-muted)]/60" />
      )}

      <div className={editing ? "pl-4" : ""}>
        {editing ? header : (
          <Link href={meta.href} className="group block">{header}</Link>
        )}
        {/* Body is non-interactive while editing so drag/settings win over links. */}
        <div className={editing ? "pointer-events-none opacity-90" : ""}>
          <Body widget={widget} />
        </div>
      </div>
    </div>
  );
}
