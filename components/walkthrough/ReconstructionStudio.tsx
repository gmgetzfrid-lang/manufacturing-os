"use client";

// CREATE 3D ENVIRONMENT — the whole user-facing flow.
//
// Select clips → check the machine can do it → reconstruct locally → walk
// through the result. Everything runs on the user's own computer; the UI says
// so plainly, because "we processed your home video" is exactly the kind of
// claim people are right to be suspicious of.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Boxes, CheckCircle2, ChevronRight, Cpu, Film, HardDrive,
  Loader2, MonitorPlay, Play, Save, ShieldCheck, Trash2, Upload, X, XCircle, Zap,
} from "lucide-react";

import {
  DEFAULT_RECON_CONFIG, applyPreset, describeWorkload, type QualityPreset,
} from "@/lib/recon/config";
import {
  assessReadiness, detectCodecs, detectMachine, explainBlocker, formatGpuName,
  type CodecSupport, type MachineReport, type Readiness,
} from "@/lib/recon/capabilities";
import {
  ReconstructionJob, formatBytes, formatDuration, initialJobState,
  overallProgress, type JobState,
} from "@/lib/recon/jobRunner";
import { saveScene } from "@/lib/recon/store";
import type { SceneData } from "@/lib/recon/types";
import CaptureGuide from "./CaptureGuide";

const ACCEPT = "video/mp4,video/quicktime,video/x-m4v,.mp4,.mov,.m4v";

interface SelectedClip {
  id: string;
  name: string;
  file: File;
  sizeBytes: number;
}

export default function ReconstructionStudio({
  areaLabel,
  scenePrefix = "",
  onSceneReady,
  onClose,
}: {
  areaLabel?: string;
  /** Saved scenes are namespaced with this so each area keeps its own. */
  scenePrefix?: string;
  onSceneReady?: (scene: SceneData, points: ArrayBuffer) => void;
  onClose?: () => void;
}) {
  const [machine, setMachine] = useState<MachineReport | null>(null);
  const [codecs, setCodecs] = useState<CodecSupport | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [clips, setClips] = useState<SelectedClip[]>([]);
  const [quality, setQuality] = useState<QualityPreset>("balanced");
  const [job, setJob] = useState<JobState>(initialJobState);
  const [saved, setSaved] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [now, setNow] = useState(0);

  const runnerRef = useRef<ReconstructionJob | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const m = await detectMachine();
      const c = await detectCodecs();
      if (!alive) return;
      setMachine(m);
      setCodecs(c);
      setReadiness(assessReadiness(m, c));
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    runnerRef.current = new ReconstructionJob({ onState: setJob });
    return () => {
      runnerRef.current?.dispose();
      runnerRef.current = null;
    };
  }, []);

  // Live elapsed time while running. Seeded from the effect rather than during
  // render, because Date.now() is impure.
  useEffect(() => {
    if (job.status !== "running") return;
    // Ticks rather than a synchronous seed: reading the clock during the effect
    // body would cascade a render.
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [job.status]);

  const cfg = useMemo(() => applyPreset(DEFAULT_RECON_CONFIG, quality), [quality]);

  const totalBytes = clips.reduce((a, c) => a + c.sizeBytes, 0);
  const limits = cfg.limits;

  const validation = useMemo(() => {
    const problems: string[] = [];
    if (clips.length > limits.maxClips) {
      problems.push(
        `${clips.length} clips selected — the limit is ${limits.maxClips}. ` +
        `Split the space into smaller connected zones and process each separately.`,
      );
    }
    if (totalBytes > limits.maxTotalBytes) {
      problems.push(
        `${formatBytes(totalBytes)} total is larger than this browser can process ` +
        `locally (${formatBytes(limits.maxTotalBytes)}). Divide the environment into ` +
        `smaller connected zones and process each zone separately.`,
      );
    }
    for (const c of clips) {
      if (c.sizeBytes > limits.maxBytesPerClip) {
        problems.push(`${c.name} is ${formatBytes(c.sizeBytes)}, over the ${formatBytes(limits.maxBytesPerClip)} per-clip limit.`);
      }
    }
    return problems;
  }, [clips, limits, totalBytes]);

  const workload = useMemo(
    () => describeWorkload(cfg, Math.max(1, clips.length), clips.length * 90),
    [cfg, clips.length],
  );

  const addFiles = useCallback((files: FileList | null) => {
    if (!files) return;
    const next: SelectedClip[] = [];
    for (const file of Array.from(files)) {
      const base = file.name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
      next.push({ id: base || `clip-${next.length}`, name: file.name, file, sizeBytes: file.size });
    }
    setClips((prev) => {
      const seen = new Set(prev.map((c) => `${c.name}:${c.sizeBytes}`));
      const merged = [...prev];
      for (const c of next) {
        if (seen.has(`${c.name}:${c.sizeBytes}`)) continue;
        merged.push(c);
      }
      return merged;
    });
  }, []);

  const start = useCallback(() => {
    if (!runnerRef.current || clips.length === 0) return;
    setSaved(false);
    runnerRef.current.start(
      clips.map((c) => ({ id: c.id, name: c.name, file: c.file })),
      quality,
    );
  }, [clips, quality]);

  const cancel = useCallback(() => runnerRef.current?.cancel(), []);

  const save = useCallback(async () => {
    if (!job.scene) return;
    const id = `${scenePrefix}${job.scene.id}`;
    // The manifest is stored without its payload; points live in their own file.
    const manifest = { ...job.scene, id, points: undefined };
    await saveScene(id, manifest, job.scene.points);
    setSaved(true);
  }, [job.scene, scenePrefix]);

  const enter = useCallback(() => {
    if (job.scene) onSceneReady?.(job.scene, job.scene.points);
  }, [job.scene, onSceneReady]);

  const blocked = readiness && !readiness.ready;
  const running = job.status === "running";

  return (
    <div className="space-y-4">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-black text-[var(--color-text)]">
            <Boxes className="h-5 w-5 text-sky-600" />
            Create 3D environment
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
            Turn several overlapping phone videos of {areaLabel ? <b>{areaLabel}</b> : "an area"} into
            one walkable 3D scene.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowGuide((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
          >
            <Film className="h-3.5 w-3.5" /> How to record
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Privacy statement — required by the brief and true of the design. */}
      <div className="flex items-start gap-2.5 rounded-xl border border-emerald-300 bg-emerald-50/70 px-3.5 py-2.5 dark:border-emerald-900 dark:bg-emerald-950/30">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div className="text-xs leading-relaxed text-emerald-900 dark:text-emerald-200">
          <b className="font-black">Processing happens on your computer.</b> Your videos are not
          sent to a GPU processing server, or anywhere else — they are decoded and reconstructed
          by this browser using your own GPU.
        </div>
      </div>

      {showGuide && <CaptureGuide onClose={() => setShowGuide(false)} />}

      {/* ── Machine report ─────────────────────────────────────────────── */}
      <MachinePanel machine={machine} codecs={codecs} readiness={readiness} />

      {blocked && readiness && (
        <div className="space-y-2">
          {readiness.blockers.map((b) => {
            const { title, detail } = explainBlocker(b);
            return (
              <div key={b} className="flex items-start gap-2.5 rounded-xl border border-red-300 bg-red-50 px-3.5 py-3 dark:border-red-900 dark:bg-red-950/40">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                <div>
                  <div className="text-sm font-black text-red-800 dark:text-red-200">{title}</div>
                  <div className="mt-0.5 text-xs text-red-700 dark:text-red-300">{detail}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Clip selection ─────────────────────────────────────────────── */}
      {!running && job.status !== "done" && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm font-black text-[var(--color-text)]">Add video clips</div>
            <div className="text-xs text-[var(--color-text-muted)]">
              {clips.length === 0
                ? `${limits.minClips}–${limits.maxClips} clips · roughly 1–2 minutes each`
                : `${clips.length} clip${clips.length === 1 ? "" : "s"} · ${formatBytes(totalBytes)}`}
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
          />

          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
            className="rounded-xl border-2 border-dashed border-[var(--color-border)] px-4 py-6 text-center"
          >
            <Upload className="mx-auto mb-2 h-6 w-6 text-[var(--color-text-faint)]" />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!!blocked}
              className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-black text-white shadow hover:bg-sky-500 disabled:opacity-40"
            >
              Select videos
            </button>
            <div className="mt-2 text-xs text-[var(--color-text-muted)]">
              or drop them here · MP4 or MOV
            </div>
          </div>

          {clips.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {clips.map((clip, i) => (
                <li
                  key={`${clip.name}-${i}`}
                  className="flex items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2"
                >
                  <Film className="h-3.5 w-3.5 shrink-0 text-sky-600" />
                  <span className="flex-1 truncate text-xs font-bold text-[var(--color-text)]">
                    {clip.name}
                  </span>
                  <span className="font-mono text-[11px] text-[var(--color-text-muted)]">
                    {formatBytes(clip.sizeBytes)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setClips((prev) => prev.filter((_, j) => j !== i))}
                    className="text-[var(--color-text-faint)] hover:text-red-600"
                    aria-label={`Remove ${clip.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {validation.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {validation.map((problem) => (
                <div key={problem} className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{problem}</span>
                </div>
              ))}
            </div>
          )}

          {/* Quality */}
          <div className="mt-4 flex items-center gap-3 flex-wrap">
            <span className="text-xs font-black uppercase tracking-wide text-[var(--color-text-faint)]">
              Quality
            </span>
            <div className="inline-flex gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-1">
              {(["draft", "balanced", "high"] as QualityPreset[]).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setQuality(preset)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold capitalize transition-colors ${
                    quality === preset
                      ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm"
                      : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  }`}
                >
                  {preset}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-[var(--color-text-muted)]">{workload.note}</span>
          </div>

          <button
            type="button"
            onClick={start}
            disabled={clips.length === 0 || validation.length > 0 || !!blocked}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-black text-white shadow-lg shadow-emerald-900/20 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Play className="h-4 w-4" /> Start reconstruction
          </button>
          {clips.length > 0 && (
            <p className="mt-2 text-center text-[11px] text-[var(--color-text-muted)]">
              Processing time depends on your hardware and is not estimated here — the elapsed
              time is reported when it finishes.
            </p>
          )}
        </div>
      )}

      {/* ── Progress ───────────────────────────────────────────────────── */}
      {running && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div className="mb-1 flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-sky-600" />
            <span className="text-sm font-black text-[var(--color-text)]">Processing locally</span>
            <span className="ml-auto font-mono text-xs text-[var(--color-text-muted)]">
              {formatDuration(Math.max(0, now - (job.startedAt ?? now)))}
            </span>
          </div>
          <p className="mb-3 text-xs text-[var(--color-text-muted)]">
            Your computer is processing the videos. Do not close this window.
          </p>

          <div className="mb-3 h-2 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
            <div
              className="h-full rounded-full bg-sky-500 transition-[width] duration-300"
              style={{ width: `${Math.round(overallProgress(job) * 100)}%` }}
            />
          </div>

          <div className="space-y-2">
            {job.stages.map((stage) => (
              <div key={stage.id} className="flex items-center gap-2.5">
                <span className="w-40 shrink-0 text-xs font-bold text-[var(--color-text)]">
                  {stage.label}
                </span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
                  <div
                    className={`h-full rounded-full transition-[width] duration-300 ${
                      stage.progress >= 1 ? "bg-emerald-500" : "bg-sky-500"
                    }`}
                    style={{ width: `${Math.round(stage.progress * 100)}%` }}
                  />
                </div>
                <span className="w-10 shrink-0 text-right font-mono text-[10px] text-[var(--color-text-muted)]">
                  {Math.round(stage.progress * 100)}%
                </span>
              </div>
            ))}
          </div>

          {job.currentStage && (
            <div className="mt-2 truncate font-mono text-[11px] text-[var(--color-text-muted)]">
              {job.stages.find((s) => s.id === job.currentStage)?.detail}
            </div>
          )}

          <button
            type="button"
            onClick={cancel}
            className="mt-3 rounded-xl border border-[var(--color-border)] px-3 py-2 text-xs font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"
          >
            Cancel
          </button>
        </div>
      )}

      {/* ── Failure ────────────────────────────────────────────────────── */}
      {(job.status === "failed" || job.status === "cancelled") && (
        <div className="rounded-2xl border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
          <div className="flex items-start gap-2.5">
            <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
            <div className="flex-1">
              <div className="text-sm font-black text-red-800 dark:text-red-200">
                {job.status === "cancelled" ? "Reconstruction cancelled" : "Reconstruction failed"}
              </div>
              {job.error && (
                <div className="mt-1 text-xs leading-relaxed text-red-700 dark:text-red-300">
                  {job.error}
                </div>
              )}
              {job.hint && (
                <div className="mt-2 rounded-lg bg-red-100 px-2.5 py-2 text-xs text-red-800 dark:bg-red-900/40 dark:text-red-200">
                  {job.hint}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setJob(initialJobState())}
            className="mt-3 rounded-xl bg-red-600 px-3 py-2 text-xs font-black text-white hover:bg-red-500"
          >
            Try again
          </button>
        </div>
      )}

      {/* ── Success ────────────────────────────────────────────────────── */}
      {job.status === "done" && job.scene && (
        <ResultPanel
          scene={job.scene}
          job={job}
          saved={saved}
          onSave={save}
          onEnter={enter}
          onRestart={() => { setJob(initialJobState()); setClips([]); }}
        />
      )}

      {/* Warnings appear whether or not the run succeeded. */}
      {job.warnings.length > 0 && job.status !== "running" && (
        <div className="space-y-1.5">
          {job.warnings.map((w, i) => (
            <div
              key={`${w.code}-${i}`}
              className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
                w.severity === "error"
                  ? "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200"
                  : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
              }`}
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{w.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function MachinePanel({
  machine, codecs, readiness,
}: {
  machine: MachineReport | null;
  codecs: CodecSupport | null;
  readiness: Readiness | null;
}) {
  if (!machine) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3 text-xs text-[var(--color-text-muted)]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking what this computer can do…
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-black text-[var(--color-text)]">
        <Cpu className="h-4 w-4 text-violet-600" /> This computer
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
        <Stat
          icon={<Zap className="h-3 w-3" />}
          label="WebGPU"
          value={machine.gpu.available ? formatGpuName(machine.gpu) : "Not available"}
          ok={machine.gpu.available && !machine.gpu.isFallback}
          bad={!machine.gpu.available}
        />
        <Stat icon={<Cpu className="h-3 w-3" />} label="CPU threads" value={String(machine.cores)} />
        <Stat
          icon={<HardDrive className="h-3 w-3" />}
          label="Memory"
          value={machine.deviceMemoryGb ? `${machine.deviceMemoryGb} GB+` : "unreported"}
        />
        <Stat
          icon={<MonitorPlay className="h-3 w-3" />}
          label="Video decoding"
          value={
            codecs
              ? [codecs.h264 && "H.264", codecs.hevc && "HEVC", codecs.vp9 && "VP9", codecs.av1 && "AV1"]
                  .filter(Boolean).join(" · ") || "none"
              : "checking…"
          }
          ok={!!codecs?.h264}
          bad={!!codecs && !codecs.h264 && !codecs.hevc}
        />
        <Stat
          icon={<HardDrive className="h-3 w-3" />}
          label="Local storage"
          value={machine.storageQuotaMb ? `${(machine.storageQuotaMb / 1024).toFixed(1)} GB free` : "unreported"}
        />
        <Stat
          icon={<Zap className="h-3 w-3" />}
          label="GPU buffer limit"
          value={
            machine.gpu.limits
              ? `${Math.round(machine.gpu.limits.maxStorageBufferBindingSize / 1048576)} MB`
              : "—"
          }
        />
      </div>

      {readiness && readiness.warnings.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {readiness.warnings.map((w) => (
            <div key={w} className="flex items-start gap-2 text-[11px] text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({
  icon, label, value, ok, bad,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  ok?: boolean;
  bad?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-faint)]">
        {icon} {label}
      </div>
      <div
        className={`truncate text-xs font-bold ${
          bad ? "text-red-600" : ok ? "text-emerald-600" : "text-[var(--color-text)]"
        }`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function ResultPanel({
  scene, job, saved, onSave, onEnter, onRestart,
}: {
  scene: SceneData;
  job: JobState;
  saved: boolean;
  onSave: () => void;
  onEnter: () => void;
  onRestart: () => void;
}) {
  const r = scene.report;
  return (
    <div className="rounded-2xl border border-emerald-300 bg-emerald-50/60 p-4 dark:border-emerald-900 dark:bg-emerald-950/25">
      <div className="mb-3 flex items-center gap-2">
        {r.unified ? (
          <CheckCircle2 className="h-5 w-5 text-emerald-600" />
        ) : (
          <AlertTriangle className="h-5 w-5 text-amber-600" />
        )}
        <span className="text-sm font-black text-[var(--color-text)]">
          {r.unified ? "Reconstruction complete" : "Reconstruction finished with problems"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
        <Metric label="Videos processed" value={`${r.clipsRegistered} / ${r.clipsTotal}`} />
        <Metric label="Frames processed" value={String(r.framesUsed)} />
        <Metric label="Frames placed" value={String(r.framesRegistered)} />
        <Metric label="Processing time" value={formatDuration(r.elapsedMs)} />
        <Metric label="Points" value={scene.pointCount.toLocaleString()} />
        <Metric label="Output size" value={formatBytes(scene.points.byteLength)} />
        <Metric label="Reprojection error" value={`${r.reprojectionRmsePx} px`} />
        <Metric label="One connected space" value={r.unified ? "yes" : `no — ${r.componentCount} pieces`} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onEnter}
          className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-black text-white shadow hover:bg-emerald-500"
        >
          <ChevronRight className="h-4 w-4" /> Enter 3D environment
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saved}
          className="inline-flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-sm font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
        >
          <Save className="h-4 w-4" /> {saved ? "Saved to this browser" : "Save environment"}
        </button>
        <button
          type="button"
          onClick={onRestart}
          className="rounded-xl px-3 py-2.5 text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          Start another
        </button>
      </div>

      {job.clipStats.length > 0 && (
        <div className="mt-3 border-t border-emerald-200 pt-3 dark:border-emerald-900">
          <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-faint)]">
            Per clip
          </div>
          <div className="space-y-1">
            {job.clipStats.map((c) => (
              <div key={c.id} className="flex items-center gap-2 text-[11px]">
                <span className="flex-1 truncate font-bold text-[var(--color-text)]">{c.name}</span>
                <span className="font-mono text-[var(--color-text-muted)]">
                  {c.decodedFrames} decoded → {c.keptFrames} used → {c.registeredFrames} placed
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-faint)]">
        {label}
      </div>
      <div className="font-mono text-sm font-bold text-[var(--color-text)]">{value}</div>
    </div>
  );
}
