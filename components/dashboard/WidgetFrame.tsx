"use client";

// WidgetFrame — the shared shell every dashboard widget renders inside.
//
// The frame carries the Command Deck's "console" flare so every widget reads as
// alive as the hero: ambient tone-tinted corner glows that bloom on hover, a
// faint grid weave, a vivid gradient top-rule, a glowing gradient icon badge,
// and real depth (shadow + hover-lift). The body content paints above all of it.
//
// `bare` widgets (the Command Deck itself) supply their OWN full hero shell, so
// the frame steps aside entirely — it hosts the body edge-to-edge and only
// floats the edit affordances (grip + remove/settings) on top.

import React from "react";
import Link from "next/link";
import { GripVertical, X, Settings2, ChevronRight } from "lucide-react";
import type { DashboardWidget } from "@/lib/dashboard/types";
import { WIDGET_CATALOG, toneGradient, toneWash, toneGlow } from "./widgets";

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

  // ── Bare widgets bring their own shell (e.g. the Command Deck hero) ──
  if (meta.bare) {
    return (
      <div className="group/widget relative h-full">
        <div className={editing ? "h-full pointer-events-none" : "h-full"}>
          <Body widget={widget} />
        </div>
        {editing && (
          <>
            <GripVertical className="absolute top-3 left-3 z-20 w-4 h-4 text-white/70 drop-shadow pointer-events-none" />
            <div data-no-drag className="absolute top-3 right-3 z-20 flex items-center gap-1">
              {meta.hasSettings && (
                <button type="button" onClick={onOpenSettings} title="Widget settings"
                  className="p-1.5 rounded-lg bg-black/40 backdrop-blur text-white/80 hover:text-white hover:bg-black/60 transition-colors">
                  <Settings2 className="w-4 h-4" />
                </button>
              )}
              <button type="button" onClick={onRemove} title="Remove widget"
                className="p-1.5 rounded-lg bg-black/40 backdrop-blur text-white/80 hover:text-white hover:bg-black/60 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  const [glowA, glowB] = toneGlow(meta.tone);

  return (
    <div
      className={`group/widget relative flex flex-col h-full rounded-2xl border overflow-hidden transition-all duration-300 bg-[var(--color-surface)] ${
        editing
          ? "border-dashed border-[var(--color-accent)] shadow-sm"
          : "border-[var(--color-border)] shadow-lg shadow-slate-900/[0.06] hover:shadow-xl hover:shadow-slate-900/[0.12] hover-lift"
      }`}
    >
      {/* ── The Command Deck's console flare, tinted to this widget's tone ── */}
      {/* Ambient corner glows — subtle at rest, bloom on hover. */}
      <div aria-hidden className={`pointer-events-none absolute -top-16 -right-12 w-44 h-44 rounded-full blur-3xl ${glowA} opacity-70 group-hover/widget:opacity-100 transition-opacity duration-500`} />
      <div aria-hidden className={`pointer-events-none absolute -bottom-20 -left-12 w-44 h-44 rounded-full blur-3xl ${glowB} opacity-50 group-hover/widget:opacity-90 transition-opacity duration-500`} />
      {/* Faint grid weave — the deck's "console" texture, theme-aware. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.035]"
        style={{ backgroundImage: "linear-gradient(var(--color-text) 1px, transparent 1px), linear-gradient(90deg, var(--color-text) 1px, transparent 1px)", backgroundSize: "26px 26px" }}
      />
      {/* Tonal wash up top. */}
      <div className={`pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b ${toneWash(meta.tone)} to-transparent`} />
      {/* Vivid gradient top-rule — the "powered / live" hairline. */}
      <div aria-hidden className={`pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r ${toneGradient(meta.tone)} opacity-90`} />

      {editing && (
        <>
          <GripVertical className="absolute top-4 left-2 w-4 h-4 text-[var(--color-text-muted)]/60 z-10 pointer-events-none" />
          <div data-no-drag className="absolute top-2.5 right-2.5 flex items-center gap-1 z-10">
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
        {/* Header — glowing gradient icon badge + label. The footer opens the tool. */}
        <div className="flex items-center gap-3 shrink-0">
          <span className={`relative inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br ${toneGradient(meta.tone)} text-white shadow-lg ring-1 ring-white/20 shrink-0`}>
            <span aria-hidden className={`pointer-events-none absolute -inset-1 rounded-2xl blur-md opacity-50 bg-gradient-to-br ${toneGradient(meta.tone)}`} />
            <Icon className="relative w-5 h-5" />
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
