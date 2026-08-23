"use client";

// The walkable view of a finished reconstruction.
//
// The three.js engine lives in lib/walkthrough/viewer.ts and knows nothing about
// React; this component owns its lifecycle and draws the chrome around it — the
// controls overlay the brief asks for, the mode switch, and the honesty banner
// that appears when the clips did not actually fuse into one space.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle, Compass, Eye, Gauge, Info, Maximize2, Minimize2, Move3d, Route,
  RotateCcw, X,
} from "lucide-react";

import type { SceneData } from "@/lib/recon/types";
import {
  WalkthroughViewer, type TouchNavState, type ViewMode, type ViewerStats,
} from "@/lib/walkthrough/viewer";

/** Matches WalkthroughViewer.STICK_RANGE; the ring is drawn at this radius. */
const STICK_RANGE = 64;

export default function WalkthroughCanvas({
  scene,
  points,
  onClose,
  onToggleFullscreen,
  isFullscreen = false,
  className = "",
}: {
  scene: SceneData;
  points: ArrayBuffer;
  onClose?: () => void;
  /** Rendered inside the toolbar so the host does not have to position it. */
  onToggleFullscreen?: () => void;
  isFullscreen?: boolean;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<WalkthroughViewer | null>(null);

  const [mode, setMode] = useState<ViewMode>("first-person");
  const [locked, setLocked] = useState(false);
  const [stats, setStats] = useState<ViewerStats | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [showPaths, setShowPaths] = useState(false);
  const [pointSize, setPointSize] = useState(1.0);
  const [edl, setEdl] = useState(0.55);
  const [error, setError] = useState<string | null>(null);
  const [touchNav, setTouchNav] = useState<TouchNavState | null>(null);
  const [coarse, setCoarse] = useState(false);
  const [touchStarted, setTouchStarted] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let viewer: WalkthroughViewer | null = null;
    try {
      viewer = new WalkthroughViewer({
        container,
        scene,
        points,
        onModeChange: setMode,
        onPointerLockChange: setLocked,
        onStats: setStats,
        onTouchNav: (state) => {
          setTouchNav(state);
          if (state.stick || state.looking) setTouchStarted(true);
        },
      });
      viewerRef.current = viewer;
      setCoarse(viewer.pointerIsCoarse());
    } catch (err) {
      const message = err instanceof Error
        ? `The 3D viewer could not start: ${err.message}`
        : "The 3D viewer could not start.";
      // Deferred: setting state synchronously inside an effect cascades renders.
      queueMicrotask(() => setError(message));
    }

    return () => {
      viewer?.dispose();
      viewerRef.current = null;
    };
  }, [scene, points]);

  const setViewerMode = useCallback((next: ViewMode) => {
    viewerRef.current?.setMode(next);
    setMode(next);
  }, []);

  const reset = useCallback(() => {
    viewerRef.current?.resetView();
  }, []);

  const togglePaths = useCallback(() => {
    setShowPaths((prev) => {
      viewerRef.current?.setShowPaths(!prev);
      return !prev;
    });
  }, []);

  const changePointSize = useCallback((value: number) => {
    setPointSize(value);
    viewerRef.current?.setPointSize(value);
  }, []);

  const changeEdl = useCallback((value: number) => {
    setEdl(value);
    viewerRef.current?.setEdlStrength(value);
  }, []);

  const report = scene.report;

  return (
    <div className={`relative w-full h-full bg-[#0b0f14] overflow-hidden ${className}`}>
      <div ref={containerRef} className="absolute inset-0" />

      {error && (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div className="max-w-md rounded-xl border border-red-800 bg-red-950/80 p-4 text-sm text-red-200">
            {error}
          </div>
        </div>
      )}

      {/* Honesty banner: a split reconstruction must never be presented as one
          continuous space just because it renders. */}
      {!report.unified && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 max-w-xl">
          <div className="flex items-start gap-2 rounded-xl border border-amber-600/60 bg-amber-950/90 px-3.5 py-2.5 shadow-lg backdrop-blur">
            <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
            <div className="text-[11px] leading-relaxed text-amber-100">
              <b className="font-black">These clips did not merge into one space.</b>{" "}
              {report.componentCount > 1
                ? `The reconstruction split into ${report.componentCount} disconnected groups, so what you see is only the largest one.`
                : `Only ${report.clipsRegistered} of ${report.clipsTotal} clips could be placed.`}{" "}
              Re-record with more overlap between clips.
            </div>
          </div>
        </div>
      )}

      {/* Controls help — small and unobtrusive, per the brief. */}
      {mode === "first-person" && (
        <div className="absolute bottom-3 left-3 z-20 rounded-lg bg-black/55 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-200 backdrop-blur pointer-events-none">
          {coarse ? (
            <>
              <div>Left side — Drag to walk</div>
              <div>Right side — Drag to look</div>
              <div>Push further — Run</div>
            </>
          ) : (
            <>
              <div>W A S D — Move</div>
              <div>Mouse — Look</div>
              <div>Shift — Move faster</div>
              <div>Esc — Release mouse</div>
            </>
          )}
        </div>
      )}

      {/* The thumbstick. It rests in the bottom-left corner and jumps to wherever
          the thumb actually lands — a control that only appears once you have
          already guessed where it is teaches nobody. Coordinates are canvas
          relative, because this div is positioned against the canvas, not the
          page. */}
      {mode === "first-person" && coarse && (
        <div
          className="absolute z-20 pointer-events-none transition-opacity duration-200"
          style={{
            left: touchNav?.stick ? touchNav.stick.originX : 96,
            bottom: touchNav?.stick ? undefined : 96,
            top: touchNav?.stick ? touchNav.stick.originY : undefined,
            width: 0, height: 0,
            opacity: touchNav?.stick ? 1 : 0.45,
          }}
        >
          <div
            className="absolute rounded-full border-2 border-white/40 bg-white/5"
            style={{
              width: STICK_RANGE * 2, height: STICK_RANGE * 2,
              left: -STICK_RANGE, top: -STICK_RANGE,
            }}
          />
          <div
            className="absolute rounded-full bg-white/75 shadow-lg"
            style={{
              width: 46, height: 46,
              left: (touchNav?.stick?.dx ?? 0) - 23,
              top: (touchNav?.stick?.dy ?? 0) - 23,
            }}
          />
        </div>
      )}

      {touchNav && touchNav.boost > 1.05 && mode === "first-person" && (
        <div className="absolute top-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 font-mono text-[11px] text-sky-200 backdrop-blur pointer-events-none">
          Running
        </div>
      )}

      {/* Start prompt. On a mouse this waits for pointer lock, which needs a
          user gesture; on touch there is no lock to wait for, so it clears as
          soon as a finger steers — otherwise it would never go away. */}
      {mode === "first-person" && !error && (coarse ? !touchStarted : !locked) && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <div className="rounded-2xl border border-white/15 bg-black/65 px-6 py-4 text-center backdrop-blur">
            <Move3d className="mx-auto mb-2 h-6 w-6 text-sky-300" />
            <div className="text-sm font-black text-white">
              {coarse ? "Drag to walk through" : "Click to walk through"}
            </div>
            <div className="mt-1 text-[11px] text-slate-300">
              You start {describeStart(scene)}.{" "}
              {coarse
                ? "Drag on the left to move, on the right to look around."
                : "Walk toward the room and around the furniture."}
            </div>
          </div>
        </div>
      )}

      {/* Top-right toolbar */}
      <div className="absolute top-3 right-3 z-20 flex items-center gap-1.5">
        <ToolbarButton
          active={mode === "first-person"}
          onClick={() => setViewerMode("first-person")}
          title="First-person walking"
        >
          <Eye className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          active={mode === "orbit"}
          onClick={() => setViewerMode("orbit")}
          title="Orbit / inspect the whole scene"
        >
          <Compass className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton active={showPaths} onClick={togglePaths} title="Show where each clip walked">
          <Route className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton onClick={reset} title="Back to the start position">
          <RotateCcw className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton active={showInfo} onClick={() => setShowInfo((v) => !v)} title="Reconstruction details">
          <Info className="h-4 w-4" />
        </ToolbarButton>
        {onToggleFullscreen && (
          <ToolbarButton
            onClick={onToggleFullscreen}
            title={isFullscreen ? "Exit full screen" : "Full screen"}
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </ToolbarButton>
        )}
        {onClose && (
          <ToolbarButton onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </ToolbarButton>
        )}
      </div>

      {/* Render quality sliders */}
      <div className="absolute bottom-3 right-3 z-20 flex flex-col gap-2 rounded-xl bg-black/55 px-3 py-2.5 backdrop-blur">
        <Slider
          icon={<Maximize2 className="h-3 w-3" />}
          label="Point size"
          value={pointSize}
          min={0.35}
          max={3}
          step={0.05}
          onChange={changePointSize}
        />
        <Slider
          icon={<Gauge className="h-3 w-3" />}
          label="Depth shading"
          value={edl}
          min={0}
          max={1.5}
          step={0.05}
          onChange={changeEdl}
        />
        {stats && (
          <div className="pt-0.5 font-mono text-[10px] text-slate-400">
            {Math.round(stats.fps)} fps · {(scene.pointCount / 1e6).toFixed(2)}M pts
          </div>
        )}
      </div>

      {/* Details panel */}
      {showInfo && (
        <div className="absolute top-14 right-3 z-20 w-72 rounded-xl border border-white/10 bg-black/80 p-3.5 text-[11px] text-slate-200 backdrop-blur">
          <div className="mb-2 text-xs font-black text-white">{scene.label}</div>
          <Row label="Clips placed" value={`${report.clipsRegistered} / ${report.clipsTotal}`} />
          <Row label="Frames placed" value={`${report.framesRegistered} / ${report.framesUsed}`} />
          <Row label="Model pieces" value={String(report.componentCount)} />
          <Row label="Sparse points" value={report.sparsePoints.toLocaleString()} />
          <Row label="Dense points" value={report.densePoints.toLocaleString()} />
          <Row label="Reprojection error" value={`${report.reprojectionRmsePx} px`} />
          <Row label="Focal length" value={`${report.focalPx} px`} />
          <Row label="Scale from" value={scene.transform.scaleSource} />
          <Row label="Up axis from" value={scene.transform.gravitySource} />
          <Row label="Start from" value={scene.navigation.startSource} />
          <Row label="GPU" value={report.gpu} />
          <div className="mt-2 border-t border-white/10 pt-2">
            <div className="mb-1 font-bold text-slate-300">Capture paths</div>
            {scene.clips.map((clip) => (
              <div key={clip.id} className="flex items-center gap-2 py-0.5">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: clip.color }}
                />
                <span className="flex-1 truncate">{clip.label}</span>
                <span className="font-mono text-slate-400">
                  {clip.registeredFrames}/{clip.totalFrames}
                </span>
              </div>
            ))}
          </div>
          {scene.transform.scaleSource === "camera-height" && (
            <div className="mt-2 border-t border-white/10 pt-2 text-[10px] leading-relaxed text-slate-400">
              Scale is inferred from an assumed camera height, not measured. Distances are
              approximate.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function describeStart(scene: SceneData): string {
  const source = scene.navigation.startSource;
  if (source.includes("video-c") || source.includes("hall")) return "at the far end of the hallway";
  if (source.includes("video-d")) return "at the hallway end of the capture";
  return "at the furthest point of the capture";
}

function ToolbarButton({
  children, onClick, title, active = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`flex h-8 w-8 items-center justify-center rounded-lg border backdrop-blur transition-colors ${
        active
          ? "border-sky-400/60 bg-sky-500/25 text-sky-200"
          : "border-white/10 bg-black/55 text-slate-300 hover:bg-black/75 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function Slider({
  icon, label, value, min, max, step, onChange,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[10px] text-slate-300">
      <span className="text-slate-400">{icon}</span>
      <span className="w-16 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1 w-24 cursor-pointer accent-sky-400"
        aria-label={label}
      />
    </label>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-slate-400">{label}</span>
      <span className="font-mono text-slate-100">{value}</span>
    </div>
  );
}
