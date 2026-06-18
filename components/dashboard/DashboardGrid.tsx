"use client";

import React, { useCallback, useEffect, useState } from "react";
import { LayoutGrid, Pencil, Check, Plus, Loader2 } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import type { DashboardConfig, DashboardWidget, WidgetType, DocControlSettings } from "@/lib/dashboard/types";
import { loadDashboardConfig, saveDashboardConfig, newWidgetId } from "@/lib/dashboard/config";
import { WIDGET_CATALOG } from "./widgets";
import WidgetFrame from "./WidgetFrame";
import AddWidgetModal from "./AddWidgetModal";
import LibrarySettingsModal from "./LibrarySettingsModal";

function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export default function DashboardGrid() {
  const { uid, userEmail, hasAnyRole } = useRole();
  const isAdmin = hasAnyRole(["Admin", "DocCtrl"]);

  const [config, setConfig] = useState<DashboardConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsWidget, setSettingsWidget] = useState<DashboardWidget | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    if (!uid) return;
    loadDashboardConfig(uid).then((cfg) => {
      if (alive) { setConfig(cfg); setLoaded(true); }
    });
    return () => { alive = false; };
  }, [uid]);

  const mutate = useCallback((next: DashboardConfig) => {
    setConfig(next);
    if (uid) void saveDashboardConfig(uid, next);
  }, [uid]);

  const addWidget = (type: WidgetType) => {
    if (!config) return;
    const meta = WIDGET_CATALOG[type];
    const widget: DashboardWidget = { id: newWidgetId(), type, width: meta.defaultWidth, settings: {} };
    mutate({ ...config, widgets: [...config.widgets, widget] });
  };
  const removeWidget = (id: string) => {
    if (!config) return;
    mutate({ ...config, widgets: config.widgets.filter((w) => w.id !== id) });
  };
  const toggleWidth = (id: string) => {
    if (!config) return;
    mutate({ ...config, widgets: config.widgets.map((w) => w.id === id ? { ...w, width: w.width === "full" ? "half" : "full" } : w) });
  };
  const saveSettings = (id: string, settings: DocControlSettings) => {
    if (!config) return;
    mutate({ ...config, widgets: config.widgets.map((w) => w.id === id ? { ...w, settings } : w) });
    setSettingsWidget(null);
  };
  const reorder = (from: number, to: number) => {
    if (!config || from === to) return;
    mutate({ ...config, widgets: arrayMove(config.widgets, from, to) });
  };

  if (!loaded || !config) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-[var(--color-accent)] animate-spin" />
      </div>
    );
  }

  const existingTypes = config.widgets.map((w) => w.type);

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--color-accent)] text-white shrink-0">
            <LayoutGrid className="w-5 h-5" />
          </span>
          <div>
            <h1 className="text-xl font-black text-[var(--color-text)]">Dashboard</h1>
            <p className="text-xs text-[var(--color-text-muted)]">{userEmail ? `Welcome back, ${userEmail}` : "Your workspace at a glance"}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setEditing((e) => !e)}
          className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-colors ${
            editing
              ? "bg-[var(--color-accent)] text-white hover:opacity-90"
              : "bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-canvas)]"
          }`}
        >
          {editing ? <><Check className="w-4 h-4" /> Done</> : <><Pencil className="w-4 h-4" /> Customize</>}
        </button>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {config.widgets.map((widget, index) => (
          <div
            key={widget.id}
            className={widget.width === "full" ? "md:col-span-2" : "md:col-span-1"}
            draggable={editing}
            onDragStart={() => setDragIndex(index)}
            onDragOver={(e) => { if (editing) e.preventDefault(); }}
            onDrop={() => { if (dragIndex !== null) reorder(dragIndex, index); setDragIndex(null); }}
            onDragEnd={() => setDragIndex(null)}
          >
            <WidgetFrame
              widget={widget}
              editing={editing}
              onRemove={() => removeWidget(widget.id)}
              onToggleWidth={() => toggleWidth(widget.id)}
              onOpenSettings={() => setSettingsWidget(widget)}
            />
          </div>
        ))}

        {/* Add tile — always present so empty space invites customization. */}
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="md:col-span-1 min-h-[120px] rounded-2xl border-2 border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors flex flex-col items-center justify-center gap-2"
        >
          <Plus className="w-6 h-6" />
          <span className="text-sm font-bold">Add widget</span>
        </button>
      </div>

      <AddWidgetModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        existingTypes={existingTypes}
        isAdmin={isAdmin}
        onAdd={(type) => addWidget(type)}
      />
      <LibrarySettingsModal
        key={settingsWidget?.id ?? "none"}
        open={!!settingsWidget}
        widget={settingsWidget}
        onClose={() => setSettingsWidget(null)}
        onSave={(settings) => { if (settingsWidget) saveSettings(settingsWidget.id, settings); }}
      />
    </div>
  );
}
