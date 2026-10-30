"use client";

// One settings window for every widget, built from the catalog's field list:
// a title (rename this instance) plus whatever the widget declares — a
// default filter, a library, a toggle, a count.

import React, { useEffect, useState } from "react";
import { X, Loader2, Settings2, RotateCcw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { listKnowledgeLibraries } from "@/lib/knowledge";
import type { DashboardWidget, WidgetSettingField } from "@/lib/dashboard/types";
import { WIDGET_CATALOG } from "./widgets";

interface Props {
  widget: DashboardWidget;
  onClose: () => void;
  onSave: (settings: Record<string, unknown>) => void;
}

function useLibraries(kind: "doc" | "knowledge", needed: boolean) {
  const { activeOrgId } = useRole();
  const [list, setList] = useState<Array<{ id: string; name: string }> | null>(null);
  useEffect(() => {
    if (!needed || !activeOrgId) return;
    let alive = true;
    void (async () => {
      try {
        const rows = kind === "knowledge"
          ? (await listKnowledgeLibraries(activeOrgId)).map((l) => ({ id: l.id, name: l.name }))
          : (((await supabase.from("libraries").select("id, name").eq("org_id", activeOrgId).order("name")).data ?? []) as Array<{ id: string; name: string }>);
        if (alive) setList(rows);
      } catch { if (alive) setList([]); }
    })();
    return () => { alive = false; };
  }, [kind, needed, activeOrgId]);
  return list;
}

export default function WidgetSettingsModal({ widget, onClose, onSave }: Props) {
  const meta = WIDGET_CATALOG[widget.type];
  const fields: WidgetSettingField[] = meta?.settings ?? [];
  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...(widget.settings ?? {}) }));
  const docLibs = useLibraries("doc", fields.some((f) => f.type === "docLibraries"));
  const kLibs = useLibraries("knowledge", fields.some((f) => f.type === "knowledgeLibrary"));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!meta) return null;
  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));
  const input = "w-full h-9 px-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]";

  const renderField = (f: WidgetSettingField) => {
    const v = draft[f.key];
    switch (f.type) {
      case "select":
        return (
          <select value={(v as string) ?? f.default} onChange={(e) => set(f.key, e.target.value)} className={input}>
            {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        );
      case "toggle":
        return (
          <label className="inline-flex items-center gap-2 text-sm text-[var(--color-text)] cursor-pointer">
            <input type="checkbox" checked={(v as boolean) ?? f.default} onChange={(e) => set(f.key, e.target.checked)} className="w-4 h-4 accent-[var(--color-accent)]" />
            {(v as boolean) ?? f.default ? "On" : "Off"}
          </label>
        );
      case "number":
        return (
          <input type="number" min={f.min} max={f.max} value={(v as number) ?? f.default}
            onChange={(e) => set(f.key, Math.max(f.min, Math.min(f.max, Number(e.target.value) || f.default)))} className={`${input} w-28`} />
        );
      case "knowledgeLibrary":
        return kLibs === null ? <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)]" /> : kLibs.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">No knowledge libraries yet.</p>
        ) : (
          <select value={(v as string) ?? ""} onChange={(e) => set(f.key, e.target.value)} className={input}>
            <option value="">First library (default)</option>
            {kLibs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        );
      case "docLibraries": {
        const sel = new Set(Array.isArray(v) ? (v as string[]) : []);
        return docLibs === null ? <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)]" /> : docLibs.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">No libraries yet.</p>
        ) : (
          <div className="max-h-52 overflow-y-auto rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
            {docLibs.map((l) => (
              <label key={l.id} className="flex items-center gap-2.5 px-3 py-2 hover:bg-[var(--color-surface-2)] cursor-pointer">
                <input type="checkbox" checked={sel.has(l.id)} className="w-4 h-4 accent-[var(--color-accent)]"
                  onChange={() => { const n = new Set(sel); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); set(f.key, [...n]); }} />
                <span className="text-sm text-[var(--color-text)]">{l.name}</span>
              </label>
            ))}
          </div>
        );
      }
    }
  };

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2 min-w-0">
            <Settings2 className="w-5 h-5 text-[var(--color-accent)] shrink-0" />
            <div className="min-w-0">
              <h2 className="text-base font-black text-[var(--color-text)] truncate">{meta.title} settings</h2>
              <p className="text-xs text-[var(--color-text-muted)]">Only this widget changes.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 overflow-y-auto space-y-4">
          <div>
            <label className="block text-xs font-black text-[var(--color-text)] mb-1">Title</label>
            <input value={(draft.title as string) ?? ""} onChange={(e) => set("title", e.target.value.slice(0, 60))}
              placeholder={meta.title} className={input} />
            <p className="text-[11px] text-[var(--color-text-muted)] mt-1">Name this one - useful when you have two (e.g. “Ask - Piping”).</p>
          </div>
          {fields.map((f) => (
            <div key={f.key}>
              <label className="block text-xs font-black text-[var(--color-text)] mb-1">{f.label}</label>
              {renderField(f)}
              {f.help && <p className="text-[11px] text-[var(--color-text-muted)] mt-1">{f.help}</p>}
            </div>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-[var(--color-border)] flex items-center gap-2">
          <button onClick={() => setDraft({})} title="Back to this widget's defaults"
            className="mr-auto inline-flex items-center gap-1 px-2.5 py-2 rounded-lg text-xs font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">
            <RotateCcw className="w-3.5 h-3.5" /> Reset
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-[var(--color-surface-2)] border border-[var(--color-border)] text-sm font-bold text-[var(--color-text)] hover:bg-[var(--color-canvas)]">Cancel</button>
          <button onClick={() => onSave(draft)} className="px-4 py-2 rounded-xl bg-[var(--color-accent)] text-white text-sm font-bold hover:opacity-90">Save</button>
        </div>
      </div>
    </div>
  );
}
