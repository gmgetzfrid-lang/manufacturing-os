"use client";

import React, { useEffect, useState } from "react";
import { X, Loader2, FileStack } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import type { DashboardWidget, DocControlSettings } from "@/lib/dashboard/types";

interface Props {
  open: boolean;
  widget: DashboardWidget | null;
  onClose: () => void;
  onSave: (settings: DocControlSettings) => void;
}

export default function LibrarySettingsModal({ open, widget, onClose, onSave }: Props) {
  const { activeOrgId } = useRole();
  const [libraries, setLibraries] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(() => {
    const initial = ((widget?.settings ?? {}) as DocControlSettings).libraryIds ?? [];
    return new Set(initial);
  });

  useEffect(() => {
    if (!open || !widget) return;
    let alive = true;
    void (async () => {
      if (!activeOrgId) { if (alive) setLoading(false); return; }
      try {
        const { data } = await supabase.from("libraries").select("id, name").eq("org_id", activeOrgId).order("name");
        if (alive) { setLibraries((data ?? []) as Array<{ id: string; name: string }>); setLoading(false); }
      } catch {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [open, widget, activeOrgId]);

  if (!open || !widget) return null;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2">
            <FileStack className="w-5 h-5 text-[var(--color-accent)]" />
            <div>
              <h2 className="text-base font-black text-[var(--color-text)]">Document Control widget</h2>
              <p className="text-xs text-[var(--color-text-muted)]">Choose which libraries to surface.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto">
          {loading ? (
            <div className="flex items-center gap-2 text-[var(--color-text-muted)] p-4"><Loader2 className="w-4 h-4 animate-spin" /> Loading libraries…</div>
          ) : libraries.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)] p-2">No libraries found for this workspace yet.</p>
          ) : (
            <>
              <p className="text-xs text-[var(--color-text-muted)] mb-2">Leave all unchecked to auto-show the first few.</p>
              <div className="space-y-1">
                {libraries.map((lib) => (
                  <label key={lib.id} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-[var(--color-surface-2)] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selected.has(lib.id)}
                      onChange={() => toggle(lib.id)}
                      className="w-4 h-4 rounded border-[var(--color-border)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
                    />
                    <span className="text-sm font-medium text-[var(--color-text)]">{lib.name}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-3 border-t border-[var(--color-border)] flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-[var(--color-surface-2)] border border-[var(--color-border)] text-sm font-bold text-[var(--color-text)] hover:bg-[var(--color-canvas)]">
            Cancel
          </button>
          <button
            onClick={() => onSave({ libraryIds: Array.from(selected) })}
            className="px-4 py-2 rounded-xl bg-[var(--color-accent)] text-white text-sm font-bold hover:opacity-90"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
