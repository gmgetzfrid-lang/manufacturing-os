"use client";

// The 3D walkthrough panel that lives inside an operating area.
//
// Each area gets its own entry: saved environments for that area, and the door
// into building a new one from phone video. Scenes are stored in the browser's
// private filesystem — the proof of concept deliberately has no backend, and
// nothing here talks to a server.

import React, { useCallback, useEffect, useState } from "react";
import {
  Boxes, ChevronDown, ChevronRight, Loader2, Play, Trash2,
} from "lucide-react";

import { formatBytes } from "@/lib/recon/jobRunner";
import {
  deleteScene, listScenes, loadSceneManifest, loadScenePoints, type SavedSceneEntry,
} from "@/lib/recon/store";
import type { SceneData } from "@/lib/recon/types";
import { appConfirm } from "@/components/providers/DialogProvider";

import ReconstructionStudio from "./ReconstructionStudio";
import WalkthroughCanvas from "./WalkthroughCanvas";

/** Scenes are namespaced by area so one unit's walkthroughs stay its own. */
function areaPrefix(unitCode: string): string {
  return `area-${unitCode.replace(/[^A-Za-z0-9_-]/g, "")}-`;
}

export default function AreaWalkthroughPanel({
  unitCode,
  unitLabel,
}: {
  unitCode: string;
  unitLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [scenes, setScenes] = useState<SavedSceneEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [active, setActive] = useState<{ scene: SceneData; points: ArrayBuffer } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const prefix = areaPrefix(unitCode);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const all = await listScenes();
      setScenes(all.filter((s) => s.id.startsWith(prefix)));
    } finally {
      setLoading(false);
    }
  }, [prefix]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const openScene = useCallback(async (id: string) => {
    setLoadError(null);
    const manifest = (await loadSceneManifest(id)) as SceneData | null;
    const points = await loadScenePoints(id);
    if (!manifest || !points) {
      setLoadError("That environment could not be opened — its data may have been cleared.");
      return;
    }
    setActive({ scene: { ...manifest, points }, points });
  }, []);

  const removeScene = useCallback(async (id: string, label: string) => {
    const ok = await appConfirm(
      `Delete "${label}"? The reconstruction is stored only in this browser and cannot be recovered.`,
    );
    if (!ok) return;
    await deleteScene(id);
    void refresh();
  }, [refresh]);

  const handleSceneReady = useCallback((scene: SceneData, points: ArrayBuffer) => {
    setActive({ scene, points });
    setStudioOpen(false);
    void refresh();
  }, [refresh]);

  return (
    <div className="mb-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--color-surface-2)]"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-sky-200 bg-sky-100 dark:border-sky-900 dark:bg-sky-950">
          <Boxes className="h-4 w-4 text-sky-700 dark:text-sky-300" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-black text-[var(--color-text)]">
            3D walkthrough
          </span>
          <span className="block text-xs text-[var(--color-text-muted)]">
            Build a walkable 3D scene of this area from phone video — processed on your own computer
          </span>
        </span>
        {scenes.length > 0 && (
          <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-black text-sky-700 dark:bg-sky-950 dark:text-sky-300">
            {scenes.length}
          </span>
        )}
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-[var(--color-text-faint)]" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-text-faint)]" />
        )}
      </button>

      {open && (
        <div className="border-t border-[var(--color-border)] p-4">
          {loadError && (
            <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              {loadError}
            </div>
          )}

          {/* Saved environments */}
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading saved environments…
            </div>
          ) : scenes.length > 0 ? (
            <div className="mb-4 space-y-1.5">
              {scenes.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2.5"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${s.unified ? "bg-emerald-500" : "bg-amber-500"}`}
                    title={s.unified ? "One connected space" : "Clips did not fully merge"}
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-xs font-black text-[var(--color-text)]">
                      {s.label}
                    </span>
                    <span className="block text-[11px] text-[var(--color-text-muted)]">
                      {s.pointCount.toLocaleString()} points · {formatBytes(s.bytes)} ·{" "}
                      {s.generated ? new Date(s.generated).toLocaleString() : "unknown date"}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void openScene(s.id)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-2.5 py-1.5 text-[11px] font-black text-white hover:bg-sky-500"
                  >
                    <Play className="h-3 w-3" /> Walk through
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeScene(s.id, s.label)}
                    className="text-[var(--color-text-faint)] hover:text-red-600"
                    aria-label={`Delete ${s.label}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="mb-4 text-xs text-[var(--color-text-muted)]">
              No 3D environments captured for this area yet.
            </p>
          )}

          {!studioOpen ? (
            <button
              type="button"
              onClick={() => setStudioOpen(true)}
              className="inline-flex items-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-black text-white shadow hover:bg-sky-500"
            >
              <Boxes className="h-4 w-4" /> Create 3D environment
            </button>
          ) : (
            <ReconstructionStudio
              areaLabel={unitLabel}
              scenePrefix={prefix}
              onSceneReady={handleSceneReady}
              onClose={() => setStudioOpen(false)}
            />
          )}
        </div>
      )}

      {/* Viewer. Only mounted while the panel is open (or in full screen) — a
          live WebGL context behind a collapsed panel is pure waste. */}
      {active && (open || fullscreen) && (
        <div
          className={
            fullscreen
              ? "fixed inset-0 z-[100] bg-black"
              : "relative mx-4 mb-4 h-[560px] overflow-hidden rounded-xl border border-[var(--color-border)]"
          }
        >
          <WalkthroughCanvas
            scene={active.scene}
            points={active.points}
            isFullscreen={fullscreen}
            onToggleFullscreen={() => setFullscreen((v) => !v)}
            onClose={() => { setActive(null); setFullscreen(false); }}
          />
        </div>
      )}
    </div>
  );
}
