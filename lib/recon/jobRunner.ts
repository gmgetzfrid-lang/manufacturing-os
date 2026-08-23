// Main-thread side of the reconstruction: owns the worker, tracks progress,
// and turns worker messages into React-friendly state.
//
// Nothing here does heavy work — that is the entire point. The UI must stay
// responsive enough to show progress and let the user cancel.

import type { QualityPreset } from "./config";
import type {
  ClipStats, ReconWarning, SceneData, StageId, StageProgress, WorkerResponse,
} from "./types";
import { STAGE_LABELS } from "./types";

export interface JobState {
  status: "idle" | "running" | "done" | "failed" | "cancelled";
  stages: Array<{ id: StageId; label: string; progress: number; detail: string; ms?: number }>;
  currentStage: StageId | null;
  clipStats: ClipStats[];
  logs: Array<{ level: "info" | "warn" | "error"; message: string; at: number }>;
  scene: SceneData | null;
  error: string | null;
  hint: string | null;
  warnings: ReconWarning[];
  startedAt: number | null;
  elapsedMs: number;
}

export const STAGE_ORDER: StageId[] = ["decode", "features", "sfm", "dense", "scene"];

export function initialJobState(): JobState {
  return {
    status: "idle",
    stages: STAGE_ORDER.map((id) => ({
      id, label: STAGE_LABELS[id], progress: 0, detail: "",
    })),
    currentStage: null,
    clipStats: [],
    logs: [],
    scene: null,
    error: null,
    hint: null,
    warnings: [],
    startedAt: null,
    elapsedMs: 0,
  };
}

/** Built by scripts/build-recon-worker.mjs, staged into public/. */
export const WORKER_URL = "/workers/recon.worker.js";

export interface JobCallbacks {
  onState: (update: (prev: JobState) => JobState) => void;
}

export class ReconstructionJob {
  private worker: Worker | null = null;
  private readonly callbacks: JobCallbacks;

  constructor(callbacks: JobCallbacks) {
    this.callbacks = callbacks;
  }

  start(
    clips: Array<{ id: string; name: string; file: File }>,
    quality: QualityPreset,
  ) {
    this.cancel();

    this.callbacks.onState(() => ({
      ...initialJobState(),
      status: "running",
      startedAt: Date.now(),
    }));

    // Pre-bundled into /public by scripts/build-recon-worker.mjs rather than
    // referenced with `new URL(...)`: Turbopack does not compile that form and
    // emits the raw .ts, which the browser cannot parse. It is bundled as a
    // CLASSIC worker so importScripts is available for the OpenCV build.
    const worker = new Worker(WORKER_URL);
    this.worker = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      switch (msg.type) {
        case "progress":
          this.callbacks.onState((prev) => applyProgress(prev, msg.payload));
          break;

        case "stage-complete":
          this.callbacks.onState((prev) => ({
            ...prev,
            stages: prev.stages.map((s) =>
              s.id === msg.stage ? { ...s, progress: 1, ms: msg.ms } : s,
            ),
          }));
          break;

        case "clip-stats":
          this.callbacks.onState((prev) => ({ ...prev, clipStats: msg.stats }));
          break;

        case "log":
          this.callbacks.onState((prev) => ({
            ...prev,
            logs: [...prev.logs.slice(-80), { level: msg.level, message: msg.message, at: Date.now() }],
          }));
          break;

        case "done":
          this.callbacks.onState((prev) => ({
            ...prev,
            status: "done",
            scene: msg.scene,
            warnings: msg.scene.report.warnings,
            elapsedMs: msg.scene.report.elapsedMs,
            currentStage: null,
            stages: prev.stages.map((s) => ({ ...s, progress: 1 })),
          }));
          this.terminate();
          break;

        case "failed":
          this.callbacks.onState((prev) => ({
            ...prev,
            status: msg.error.toLowerCase().includes("cancel") ? "cancelled" : "failed",
            error: msg.error,
            hint: msg.hint,
            warnings: msg.warnings,
            currentStage: null,
          }));
          this.terminate();
          break;
      }
    };

    worker.onerror = (event) => {
      this.callbacks.onState((prev) => ({
        ...prev,
        status: "failed",
        error: event.message || "The reconstruction worker crashed.",
        hint:
          "This usually means the browser ran out of memory. Try the Draft preset, or split " +
          "the capture into two smaller connected zones.",
      }));
      this.terminate();
    };

    worker.postMessage({ type: "start", clips, quality });
  }

  cancel() {
    if (!this.worker) return;
    try {
      this.worker.postMessage({ type: "cancel" });
    } catch {
      // Worker already gone.
    }
    this.terminate();
    this.callbacks.onState((prev) =>
      prev.status === "running" ? { ...prev, status: "cancelled", currentStage: null } : prev,
    );
  }

  private terminate() {
    if (!this.worker) return;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.worker = null;
  }

  dispose() {
    this.terminate();
  }
}

function applyProgress(prev: JobState, payload: StageProgress): JobState {
  const currentIndex = STAGE_ORDER.indexOf(payload.stage);
  return {
    ...prev,
    currentStage: payload.stage,
    stages: prev.stages.map((s, i) => {
      if (s.id === payload.stage) {
        return { ...s, progress: payload.progress, detail: payload.detail };
      }
      // Stages before the current one are implicitly finished.
      if (i < currentIndex && s.progress < 1) return { ...s, progress: 1 };
      return s;
    }),
  };
}

/** Overall progress across all stages, weighted by how long each really takes. */
const STAGE_WEIGHT: Record<StageId, number> = {
  decode: 0.18,
  features: 0.02,
  sfm: 0.42,
  dense: 0.33,
  scene: 0.05,
};

export function overallProgress(state: JobState): number {
  let total = 0;
  for (const stage of state.stages) {
    total += STAGE_WEIGHT[stage.id] * stage.progress;
  }
  return Math.max(0, Math.min(1, total));
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}
