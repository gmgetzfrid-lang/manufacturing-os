// Central configuration for browser-local 3D reconstruction.
//
// Everything that bounds how much work the user's machine is asked to do lives
// here, in one file, so limits can be tuned without hunting through workers.
// The defaults target a mid-range 2024+ laptop with a discrete or decent
// integrated GPU; the app measures the actual machine at run time (see
// capabilities.ts) and scales several of these down when it must.

export interface ReconConfig {
  /** Ingest limits — refuse work the browser cannot finish rather than crash. */
  limits: {
    maxClips: number;
    minClips: number;
    maxSecondsPerClip: number;
    maxBytesPerClip: number;
    maxTotalBytes: number;
    /** Hard ceiling on frames fed to reconstruction across all clips. */
    maxTotalFrames: number;
  };

  /** Frame sampling — oversample, then keep the sharpest, least redundant. */
  frames: {
    /** Frames per second pulled out of the video. */
    sampleFps: number;
    /** Frames per second kept after sharpness + redundancy filtering. */
    targetFps: number;
    maxFramesPerClip: number;
    /** Long edge, in pixels, that frames are resized to for reconstruction. */
    workingLongEdge: number;
    /** Long edge kept for colour sampling during densification. */
    colorLongEdge: number;
    /** Drop a frame scoring below this fraction of its clip's median sharpness. */
    blurFloorRatio: number;
    /** Drop a frame whose median feature displacement is below this (px). */
    minMotionPx: number;
  };

  /** Feature detection and matching. */
  features: {
    maxPerFrame: number;
    /** ORB pyramid settings. */
    scaleFactor: number;
    levels: number;
    fastThreshold: number;
    /** Lowe ratio for descriptor matching. */
    matchRatio: number;
    /** Frames ahead of each frame matched inside a clip. */
    sequentialWindow: number;
    /** Extra loop-closure candidates per frame, found by global descriptor. */
    loopCandidates: number;
    /** Minimum inlier matches for a pair to be trusted. */
    minPairInliers: number;
  };

  /** Structure from motion. */
  sfm: {
    /** RANSAC threshold in pixels for essential matrix / PnP. */
    ransacThresholdPx: number;
    ransacConfidence: number;
    /** Minimum angle (degrees) between rays for a point to be triangulated. */
    minTriangulationAngleDeg: number;
    maxReprojectionErrorPx: number;
    /** Run a local bundle adjustment every N newly registered frames. */
    localBaEvery: number;
    localBaWindow: number;
    localBaIterations: number;
    globalBaIterations: number;
    /** Minimum 2D-3D correspondences to register a frame by PnP. */
    minPnpInliers: number;
  };

  /** Densification. */
  dense: {
    enabled: boolean;
    /** Source views paired with each reference view. */
    neighbors: number;
    /** Reference views actually densified (evenly sampled across the capture). */
    maxReferenceViews: number;
    /** Long edge used for the depth sweep. */
    longEdge: number;
    /** Plane-sweep depth samples. */
    depthSamples: number;
    /** Half-window (px) of the matching patch. */
    patchRadius: number;
    /** Reject a depth whose best cost exceeds this. */
    maxCost: number;
    /** Require this many views to agree before a point survives fusion. */
    minConsistentViews: number;
    /**
     * How far a depth is allowed to be trusted, expressed as the depth error a
     * one-pixel matching slip would cause, measured in fusion voxels. Stereo
     * error grows with the square of depth, so without a limit the far field
     * turns into a cone of noise fanning out from each camera.
     */
    depthUncertaintyVoxels: number;
    /** Fusion voxel size as a fraction of scene extent. */
    voxelFraction: number;
    maxPoints: number;
  };

  /** Viewer defaults. */
  viewer: {
    eyeHeightM: number;
    walkSpeedMs: number;
    runMultiplier: number;
    /** Assumed height the phone was held at, used to recover metric scale. */
    assumedCameraHeightM: number;
  };
}

export const DEFAULT_RECON_CONFIG: ReconConfig = {
  limits: {
    maxClips: 10,
    minClips: 1,
    maxSecondsPerClip: 150,
    maxBytesPerClip: 400 * 1024 * 1024,
    maxTotalBytes: 2 * 1024 * 1024 * 1024,
    maxTotalFrames: 320,
  },
  frames: {
    sampleFps: 6,
    targetFps: 2,
    maxFramesPerClip: 70,
    workingLongEdge: 960,
    colorLongEdge: 960,
    blurFloorRatio: 0.35,
    minMotionPx: 5,
  },
  features: {
    maxPerFrame: 2400,
    scaleFactor: 1.2,
    levels: 8,
    fastThreshold: 18,
    matchRatio: 0.78,
    sequentialWindow: 6,
    loopCandidates: 6,
    minPairInliers: 28,
  },
  sfm: {
    ransacThresholdPx: 2.0,
    ransacConfidence: 0.9999,
    minTriangulationAngleDeg: 1.2,
    maxReprojectionErrorPx: 5.0,
    localBaEvery: 6,
    localBaWindow: 12,
    localBaIterations: 8,
    globalBaIterations: 22,
    minPnpInliers: 20,
  },
  dense: {
    enabled: true,
    neighbors: 4,
    maxReferenceViews: 160,
    longEdge: 480,
    depthSamples: 96,
    patchRadius: 3,
    maxCost: 0.42,
    minConsistentViews: 2,
    depthUncertaintyVoxels: 2,
    voxelFraction: 0.005,
    maxPoints: 2_400_000,
  },
  viewer: {
    eyeHeightM: 1.65,
    walkSpeedMs: 1.9,
    runMultiplier: 3.0,
    assumedCameraHeightM: 1.55,
  },
};

/** Quality presets the UI exposes. Lower presets exist so a weak machine can
 *  still complete a real reconstruction rather than failing outright. */
export type QualityPreset = "draft" | "balanced" | "high";

export function applyPreset(base: ReconConfig, preset: QualityPreset): ReconConfig {
  const cfg: ReconConfig = structuredClone(base);
  if (preset === "draft") {
    cfg.frames.targetFps = 1.2;
    cfg.frames.maxFramesPerClip = 45;
    cfg.frames.workingLongEdge = 720;
    cfg.features.maxPerFrame = 1500;
    cfg.dense.maxReferenceViews = 70;
    cfg.dense.longEdge = 360;
    cfg.dense.depthSamples = 64;
    cfg.dense.maxPoints = 900_000;
    cfg.sfm.globalBaIterations = 12;
  } else if (preset === "high") {
    cfg.frames.targetFps = 2.6;
    cfg.frames.maxFramesPerClip = 110;
    cfg.frames.workingLongEdge = 1280;
    cfg.features.maxPerFrame = 3500;
    cfg.dense.maxReferenceViews = 260;
    cfg.dense.longEdge = 640;
    cfg.dense.depthSamples = 128;
    cfg.dense.maxPoints = 3_500_000;
  }
  return cfg;
}

/**
 * Scale the workload to the machine actually running it. Called once after
 * capability detection so a 4GB integrated GPU is not handed a preset built
 * for a discrete card.
 */
export function fitToMachine(
  cfg: ReconConfig,
  machine: {
    maxStorageBufferBytes: number;
    deviceMemoryGb: number | null;
    cores: number;
    /** Touch-first device. Phones cannot report memory, so this stands in. */
    mobile?: boolean;
  },
): ReconConfig {
  const out: ReconConfig = structuredClone(cfg);

  // navigator.deviceMemory does not exist on iOS Safari or Firefox, so a phone
  // reports null and used to sail past every memory guard below with
  // workstation limits. Treat unknown-memory-on-a-touch-device as the smallest
  // tier rather than the largest.
  const memoryGb = machine.deviceMemoryGb ?? (machine.mobile ? 3 : null);

  // The plane sweep never materialises a cost volume — the winner is kept in
  // registers as the shader walks the planes — so depthSamples costs TIME, not
  // memory, and must not be traded away for a memory budget it does not spend.
  //
  // What is actually allocated per sweep, from planeSweep.ts: the packed
  // reference plane (pixels bytes), MAX_SOURCES packed source planes
  // (4 x pixels bytes), and the depth and cost outputs (4 x pixels bytes each).
  // The largest single binding is therefore 4 x pixels, and it is resolution
  // that has to fit the adapter's limit.
  const budget = machine.maxStorageBufferBytes * 0.25;
  const BYTES_PER_PIXEL = 4;
  const ASPECT = 0.5625;
  const maxLongEdge = Math.floor(Math.sqrt(budget / (BYTES_PER_PIXEL * ASPECT)));
  out.dense.longEdge = Math.max(320, Math.min(out.dense.longEdge, maxLongEdge));

  if (memoryGb !== null && memoryGb <= 4) {
    out.frames.maxFramesPerClip = Math.min(out.frames.maxFramesPerClip, 80);
    out.limits.maxTotalFrames = Math.min(out.limits.maxTotalFrames, 180);
    out.dense.maxPoints = Math.min(out.dense.maxPoints, 1_200_000);
    out.dense.maxReferenceViews = Math.min(out.dense.maxReferenceViews, 90);
  } else if (memoryGb !== null && memoryGb <= 8) {
    out.limits.maxTotalFrames = Math.min(out.limits.maxTotalFrames, 260);
    out.dense.maxPoints = Math.min(out.dense.maxPoints, 1_800_000);
  }

  if (machine.cores <= 4) {
    out.features.maxPerFrame = Math.min(out.features.maxPerFrame, 1800);
  }

  // A phone GPU sweeping depth at desktop resolution thermally throttles long
  // before it finishes, and the result has to be drawn on the same device.
  if (machine.mobile) {
    out.dense.longEdge = Math.min(out.dense.longEdge, 640);
    out.dense.maxReferenceViews = Math.min(out.dense.maxReferenceViews, 60);
    out.dense.maxPoints = Math.min(out.dense.maxPoints, 900_000);
    out.frames.workingLongEdge = Math.min(out.frames.workingLongEdge, 1280);
  }
  return out;
}

/** Human-readable summary of what the job is about to attempt. */
export function describeWorkload(cfg: ReconConfig, clips: number, totalSeconds: number): {
  estimatedFrames: number;
  matchPairs: number;
  note: string;
} {
  const perClip = Math.min(
    cfg.frames.maxFramesPerClip,
    Math.round((totalSeconds / Math.max(1, clips)) * cfg.frames.targetFps),
  );
  const estimatedFrames = Math.min(cfg.limits.maxTotalFrames, perClip * clips);
  // Sequential window inside each clip, plus loop candidates across all clips.
  const matchPairs =
    estimatedFrames * cfg.features.sequentialWindow +
    estimatedFrames * cfg.features.loopCandidates;
  return {
    estimatedFrames,
    matchPairs,
    note:
      `${estimatedFrames} frames · ~${matchPairs.toLocaleString()} image pairs to match · ` +
      `${cfg.dense.enabled ? `${Math.min(cfg.dense.maxReferenceViews, estimatedFrames)} depth maps` : "no densification"}`,
  };
}
