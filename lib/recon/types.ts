// Types shared between the reconstruction workers and the UI.
//
// Everything that crosses a postMessage boundary is defined here so the worker
// and the main thread cannot drift apart.

import type { Pose } from "./math/twoView";

export type StageId = "decode" | "features" | "sfm" | "dense" | "scene";

export const STAGE_LABELS: Record<StageId, string> = {
  decode: "Reading video",
  features: "Finding features",
  sfm: "Camera reconstruction",
  dense: "Scene reconstruction",
  scene: "Generating 3D scene",
};

export interface StageProgress {
  stage: StageId;
  /** 0..1 within this stage. */
  progress: number;
  detail: string;
}

export interface ClipInput {
  id: string;
  name: string;
  /** Object handed to the worker; a File is structured-cloneable. */
  file: File;
  sizeBytes: number;
  durationS?: number;
  width?: number;
  height?: number;
}

export interface ClipStats {
  id: string;
  name: string;
  label: string;
  color: string;
  decodedFrames: number;
  keptFrames: number;
  registeredFrames: number;
  droppedBlurry: number;
  droppedStatic: number;
  durationS: number;
  width: number;
  height: number;
}

/** A frame that survived selection and is fed to reconstruction. */
export interface WorkingFrame {
  /** Global index across all clips. */
  index: number;
  clipId: string;
  clipIndex: number;
  /** Frame order inside its own clip. */
  orderInClip: number;
  timestampS: number;
  width: number;
  height: number;
  /** Greyscale working image. */
  gray: Uint8Array;
  /** RGB at colour resolution, used for point colours. */
  rgb: Uint8Array;
  colorWidth: number;
  colorHeight: number;
  sharpness: number;
}

export interface FrameFeatures {
  frameIndex: number;
  count: number;
  /** x, y pairs in pixels. */
  keypoints: Float32Array;
  /** Packed binary descriptors, `count` rows of `descriptorBytes`. */
  descriptors: Uint8Array;
  descriptorBytes: number;
  /** Coarse global descriptor used to propose loop-closure candidates. */
  globalDescriptor: Float32Array;
}

export interface PairMatches {
  a: number;
  b: number;
  /** Indices into each frame's keypoint list. */
  indicesA: Uint32Array;
  indicesB: Uint32Array;
  /** How the pair was proposed — useful for diagnosing clip fusion. */
  source: "sequential" | "loop";
  crossClip: boolean;
}

export interface VerifiedPair extends PairMatches {
  inlierCount: number;
  medianTriangulationAngleDeg: number;
}

export interface ReconPoint {
  xyz: [number, number, number];
  rgb: [number, number, number];
  /** frameIndex -> keypoint index. */
  observations: Map<number, number>;
}

export interface SfmResult {
  /** Pose per registered frame index; undefined where registration failed. */
  poses: Map<number, Pose>;
  points: Array<{ xyz: [number, number, number]; rgb: [number, number, number]; views: number[] }>;
  focal: number;
  principal: [number, number];
  registeredFrames: number[];
  rmsePx: number;
  /** Frames that could not be registered at all. */
  failedFrames: number[];
  /** Connected components over the pose graph; >1 means the clips did NOT fuse. */
  components: number[][];
  /** Geometrically verified pairs whose two frames came from different clips. */
  crossClipPairs: number;
  /** Human-readable account of where pairs were won and lost during matching. */
  diagnostics: string;
}

export interface ReconWarning {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
}

export interface ReconReport {
  unified: boolean;
  clipsRegistered: number;
  clipsTotal: number;
  componentCount: number;
  framesDecoded: number;
  framesUsed: number;
  framesRegistered: number;
  sparsePoints: number;
  densePoints: number;
  reprojectionRmsePx: number;
  focalPx: number;
  crossClipPairs: number;
  elapsedMs: number;
  stageMs: Partial<Record<StageId, number>>;
  warnings: ReconWarning[];
  gpu: string;
  quality: string;
}

/** Payload the viewer consumes. Mirrors what gets written to OPFS. */
/** Bytes per encoded point: 3 x int16 position, RGB, octahedral normal, pad. */
export const POINT_STRIDE = 12;

export interface SceneData {
  /** 3 added per-point normals and widened the stride from 10 bytes to 12. */
  format: 2 | 3;
  id: string;
  label: string;
  generated: string;
  /** Interleaved 10-byte records; see scene.ts for the layout. */
  points: ArrayBuffer;
  pointCount: number;
  quantization: {
    min: [number, number, number];
    span: [number, number, number];
  };
  navigation: {
    eyeHeightM: number;
    floorY: number;
    start: { position: [number, number, number]; yaw: number; pitch: number };
    startSource: string;
    bounds: { min: [number, number, number]; max: [number, number, number] };
  };
  transform: {
    metresPerUnit: number;
    scaleSource: string;
    gravitySource: string;
  };
  clips: Array<{
    id: string;
    label: string;
    color: string;
    registeredFrames: number;
    totalFrames: number;
    /** Flattened camera centres, post-transform. */
    path: number[];
  }>;
  report: ReconReport;
}

// ── Worker protocol ─────────────────────────────────────────────────────────

export type WorkerRequest =
  | {
      type: "start";
      clips: Array<{ id: string; name: string; file: File }>;
      config: unknown;
      quality: string;
    }
  | { type: "cancel" };

export type WorkerResponse =
  | { type: "progress"; payload: StageProgress }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "stage-complete"; stage: StageId; ms: number }
  | { type: "clip-stats"; stats: ClipStats[] }
  | { type: "done"; scene: SceneData }
  | { type: "failed"; error: string; hint: string; warnings: ReconWarning[] };

export const CLIP_COLORS = [
  "#f97316", "#38bdf8", "#a78bfa", "#4ade80",
  "#fbbf24", "#f472b6", "#2dd4bf", "#fb7185",
];

export const CLIP_ROLE_LABELS: Record<string, string> = {
  "video-a": "A · Living-room walkthrough",
  "video-b": "B · Opposite side of the couch",
  "video-c": "C · Hallway → living room",
  "video-d": "D · Living room → hallway",
  "video-e": "E · Couch detail pass",
};
