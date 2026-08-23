/// <reference lib="webworker" />
//
// The reconstruction worker. Everything expensive happens here so the page
// stays responsive enough to show progress and let the user cancel.
//
// Memory discipline is the main structural constraint. Five clips at a few
// hundred frames is well over a gigabyte of pixels, so frames are never all
// held at once: decoding runs as a sliding window that keeps only the sharpest
// frame of each group, writes its pixels straight to the Origin Private File
// System, and retains just the compact feature record in RAM. Densification
// later streams those frames back one at a time.

import { DEFAULT_RECON_CONFIG, applyPreset, type QualityPreset, type ReconConfig } from "../config";
import {
  PointFuser, depthRangeFor, depthToPoints, pickNeighbours, sweepView,
  type DenseView,
} from "../dense/planeSweep";
import { getGpuContext } from "../gpu/device";
import { loadOpenCv, type OpenCv } from "../opencv";
import { buildScene, type PointCloud } from "../scene";
import { extractFeatures, medianDisplacement, sharpness } from "../sfm/features";
import { reconstruct, type FrameMeta } from "../sfm/reconstruct";
import { FrameStore, clearStaleFrames } from "../store";
import {
  CLIP_ROLE_LABELS, type ClipStats, type FrameFeatures, type ReconReport,
  type ReconWarning, type StageId, type WorkerResponse,
} from "../types";
import { decodeVideo, probeVideo } from "../video/decode";
import { cameraCentre } from "../dense/planeSweep";

/**
 * Share of a clip's frames that must be placed before the clip counts as part
 * of the scene. Below this the footage is present in name only — usually a
 * low-texture or too-fast pass that the matcher could not follow.
 */
const MIN_CLIP_REGISTRATION = 0.5;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let cancelled = false;
const abort = new AbortController();

function post(msg: WorkerResponse) {
  ctx.postMessage(msg);
}

function progress(stage: StageId, value: number, detail: string) {
  post({ type: "progress", payload: { stage, progress: Math.max(0, Math.min(1, value)), detail } });
}

function log(level: "info" | "warn" | "error", message: string) {
  post({ type: "log", level, message });
}

const warnings: ReconWarning[] = [];
function warn(code: string, message: string, severity: ReconWarning["severity"] = "warning") {
  warnings.push({ code, message, severity });
  log(severity === "error" ? "error" : "warn", message);
}

interface KeptFrame {
  meta: FrameMeta;
  features: FrameFeatures;
  timestampS: number;
  grayBytes: number;
  rgbBytes: number;
  colorWidth: number;
  colorHeight: number;
  sharpness: number;
}

async function run(
  clipInputs: Array<{ id: string; name: string; file: File }>,
  quality: QualityPreset,
  overrides: Partial<ReconConfig> | null,
) {
  const started = performance.now();
  const stageMs: Partial<Record<StageId, number>> = {};
  const jobId = `job-${Date.now().toString(36)}`;
  const store = new FrameStore(jobId);
  await clearStaleFrames(jobId);

  let cfg = applyPreset(DEFAULT_RECON_CONFIG, quality);
  if (overrides) cfg = { ...cfg, ...overrides } as ReconConfig;

  // ── GPU + OpenCV ────────────────────────────────────────────────────────
  let gpuLabel = "unknown";
  let gpuFallback = false;
  try {
    const gpu = await getGpuContext();
    gpuLabel = gpu.label;
    gpuFallback = gpu.isFallback;
    if (gpu.isFallback) {
      warn(
        "software-gpu",
        "Your browser is using a software GPU renderer, so this will be much slower than " +
        "on real graphics hardware.",
        "info",
      );
    }
  } catch (err) {
    throw new Error(
      err instanceof Error ? err.message : "WebGPU is required for local 3D reconstruction.",
    );
  }

  progress("decode", 0.01, "Loading vision library");
  let cv: OpenCv;
  try {
    cv = await loadOpenCv(undefined, (m) => log("info", m));
  } catch (err) {
    throw new Error(
      `Could not load the computer-vision library: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  log("info", `Vision library ready (${Math.round(performance.now() - started)}ms)`);

  // ── Stage 1: decode + select + features ─────────────────────────────────
  let t0 = performance.now();
  const kept: KeptFrame[] = [];
  const clipStats: ClipStats[] = [];
  const windowSize = Math.max(1, Math.round(cfg.frames.sampleFps / Math.max(0.1, cfg.frames.targetFps)));
  let globalIndex = 0;

  for (let clipIndex = 0; clipIndex < clipInputs.length; clipIndex++) {
    if (cancelled) throw new Error("Cancelled");
    const clip = clipInputs[clipIndex];

    progress("decode", clipIndex / clipInputs.length, `Reading ${clip.name}`);
    const info = await probeVideo(clip.file);
    log("info", `${clip.name}: ${info.width}x${info.height} ${info.codec} ${info.durationS.toFixed(1)}s rot=${info.rotationDeg}`);
    if (info.durationS > cfg.limits.maxSecondsPerClip) {
      warn(
        "clip-too-long",
        `${clip.name} is ${Math.round(info.durationS)}s. Only the first ` +
        `${cfg.limits.maxSecondsPerClip}s will be used.`,
      );
    }

    const stats: ClipStats = {
      id: clip.id,
      name: clip.name,
      label: CLIP_ROLE_LABELS[clip.id] ?? clip.name,
      color: "",
      decodedFrames: 0,
      keptFrames: 0,
      registeredFrames: 0,
      droppedBlurry: 0,
      droppedStatic: 0,
      durationS: info.durationS,
      width: info.width,
      height: info.height,
    };

    // Sliding window: hold at most `windowSize` decoded frames, keep the
    // sharpest, discard the rest immediately.
    let window: Array<{
      gray: Uint8Array; rgb: Uint8Array; width: number; height: number;
      colorWidth: number; colorHeight: number; timestampS: number; sharp: number;
    }> = [];
    let previous: FrameFeatures | null = null;
    let orderInClip = 0;
    const sharpnessValues: number[] = [];
    const clipKept: KeptFrame[] = [];

    const flushWindow = async () => {
      if (window.length === 0) return;
      let best = window[0];
      for (const f of window) if (f.sharp > best.sharp) best = f;
      const dropped = window.length - 1;
      stats.droppedBlurry += dropped;
      window = [];

      if (globalIndex >= cfg.limits.maxTotalFrames) return;
      if (clipKept.length >= cfg.frames.maxFramesPerClip) return;

      const features = extractFeatures(
        cv, globalIndex, best.gray, best.width, best.height,
        {
          maxFeatures: cfg.features.maxPerFrame,
          scaleFactor: cfg.features.scaleFactor,
          levels: cfg.features.levels,
          fastThreshold: cfg.features.fastThreshold,
        },
      );

      // Motion gate: a frame where the camera barely moved adds matching cost
      // and no parallax.
      if (previous) {
        const moved = medianDisplacement(previous, features);
        if (Number.isFinite(moved) && moved < cfg.frames.minMotionPx) {
          stats.droppedStatic++;
          return;
        }
      }

      await store.write(globalIndex, best.gray, best.rgb);
      const record: KeptFrame = {
        meta: {
          index: globalIndex,
          clipId: clip.id,
          clipIndex,
          orderInClip: orderInClip++,
          width: best.width,
          height: best.height,
        },
        features,
        timestampS: best.timestampS,
        grayBytes: best.gray.byteLength,
        rgbBytes: best.rgb.byteLength,
        colorWidth: best.colorWidth,
        colorHeight: best.colorHeight,
        sharpness: best.sharp,
      };
      clipKept.push(record);
      sharpnessValues.push(best.sharp);
      previous = features;
      globalIndex++;
    };

    await decodeVideo(
      { id: clip.id, name: clip.name, file: clip.file, sizeBytes: clip.file.size },
      {
        sampleFps: cfg.frames.sampleFps,
        workingLongEdge: cfg.frames.workingLongEdge,
        colorLongEdge: cfg.frames.colorLongEdge,
        maxFrames: cfg.frames.maxFramesPerClip * windowSize,
        signal: abort.signal,
        onFrame: (frame) => {
          stats.decodedFrames++;
          window.push({
            gray: frame.gray, rgb: frame.rgb,
            width: frame.width, height: frame.height,
            colorWidth: frame.colorWidth, colorHeight: frame.colorHeight,
            timestampS: frame.timestampS,
            sharp: sharpness(frame.gray, frame.width, frame.height),
          });
          if (window.length >= windowSize) {
            // decodeVideo's onFrame is synchronous, so queue the async flush.
            pending = pending.then(flushWindow);
          }
        },
        onProgress: (done, expected) => {
          const clipFraction = (clipIndex + Math.min(1, done / Math.max(1, expected))) / clipInputs.length;
          progress("decode", clipFraction, `${clip.name}: ${done} frames`);
        },
      },
    );
    await pending;
    await flushWindow();
    await pending;
    log("info", `${clip.name}: decode loop finished, ${clipKept.length} frames kept`);

    // Blur floor, applied once the clip's own median is known.
    if (sharpnessValues.length > 6) {
      const sorted = [...sharpnessValues].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const floor = median * cfg.frames.blurFloorRatio;
      const survivors = clipKept.filter((f) => f.sharpness >= floor);
      stats.droppedBlurry += clipKept.length - survivors.length;
      clipKept.length = 0;
      clipKept.push(...survivors);
    }

    stats.keptFrames = clipKept.length;
    kept.push(...clipKept);
    clipStats.push(stats);
    log("info", `${clip.name}: ${stats.decodedFrames} decoded → ${stats.keptFrames} kept`);

    if (stats.keptFrames < 8) {
      warn(
        "few-frames",
        `${clip.name} produced only ${stats.keptFrames} usable frames. It may be too short, ` +
        `too blurry, or filmed from a standing position without moving.`,
      );
    }
  }

  stageMs.decode = Math.round(performance.now() - t0);
  post({ type: "stage-complete", stage: "decode", ms: stageMs.decode });
  post({ type: "clip-stats", stats: clipStats });

  if (kept.length < 8) {
    throw new Error(
      `Only ${kept.length} usable frames were extracted from ${clipInputs.length} clip(s). ` +
      `Record longer clips, walk more slowly, and make sure the room is well lit.`,
    );
  }
  progress("features", 1, `${kept.length} frames ready`);
  post({ type: "stage-complete", stage: "features", ms: 0 });

  // ── Stage 2: SfM ────────────────────────────────────────────────────────
  t0 = performance.now();
  const frameMetas = kept.map((k) => k.meta);
  const featureList = kept.map((k) => k.features);

  // Colour for sparse points comes from the frame that first observed them.
  const colorCache = new Map<number, { rgb: Uint8Array; w: number; h: number }>();
  const byIndex = new Map<number, KeptFrame>();
  for (const k of kept) byIndex.set(k.meta.index, k);

  const sampleColor = (frameIndex: number, x: number, y: number): [number, number, number] => {
    const entry = colorCache.get(frameIndex);
    if (!entry) return [170, 170, 170];
    const k = byIndex.get(frameIndex);
    if (!k) return [170, 170, 170];
    const px = Math.max(0, Math.min(entry.w - 1, Math.round((x / k.meta.width) * entry.w)));
    const py = Math.max(0, Math.min(entry.h - 1, Math.round((y / k.meta.height) * entry.h)));
    const i = (py * entry.w + px) * 3;
    return [entry.rgb[i], entry.rgb[i + 1], entry.rgb[i + 2]];
  };

  // Pre-load a bounded number of colour planes so sparse points get real colour
  // without pulling every frame back into memory.
  const colorBudget = Math.min(kept.length, 60);
  for (let i = 0; i < colorBudget; i++) {
    const k = kept[Math.floor((i * kept.length) / colorBudget)];
    if (colorCache.has(k.meta.index)) continue;
    const rgb = await store.readRgb(k.meta.index, k.grayBytes, k.rgbBytes);
    colorCache.set(k.meta.index, { rgb, w: k.colorWidth, h: k.colorHeight });
  }

  const sfm = await reconstruct(frameMetas, featureList, sampleColor, {
    config: cfg,
    signal: abort.signal,
    onProgress: (p, detail) => progress("sfm", p, detail),
  });

  stageMs.sfm = Math.round(performance.now() - t0);
  post({ type: "stage-complete", stage: "sfm", ms: stageMs.sfm });
  colorCache.clear();

  for (const stat of clipStats) {
    stat.registeredFrames = sfm.registeredFrames.filter(
      (f) => byIndex.get(f)?.meta.clipId === stat.id,
    ).length;
  }

  // A clip that contributed a couple of frames out of forty is not in the
  // scene in any sense the user would recognise, so it does not count towards
  // "all your videos merged" — that headline has to mean what it says.
  const clipsWithFrames = clipStats.filter(
    (c) => c.keptFrames > 0 && c.registeredFrames / c.keptFrames >= MIN_CLIP_REGISTRATION,
  );
  const unified = sfm.components.length === 1 && clipsWithFrames.length === clipStats.length;

  if (sfm.components.length > 1) {
    warn(
      "split-model",
      `The clips did not merge into one space: ${sfm.components.length} separate groups were ` +
      `reconstructed. Re-record so each clip clearly overlaps another — walk the same route ` +
      `twice, and make sure the hallway clip continues well into the room.`,
      "error",
    );
  }
  for (const stat of clipStats) {
    if (stat.keptFrames > 0 && stat.registeredFrames === 0) {
      warn(
        "clip-unregistered",
        `${stat.name} could not be connected to the rest of the capture — none of its frames ` +
        `were placed. It probably does not share enough visible detail with the other clips.`,
        "error",
      );
    } else if (
      stat.keptFrames > 0 && stat.registeredFrames / stat.keptFrames < MIN_CLIP_REGISTRATION
    ) {
      warn(
        "clip-partial",
        `${stat.name}: only ${stat.registeredFrames} of ${stat.keptFrames} frames were placed.`,
      );
    }
  }

  // ── Stage 3: densify ────────────────────────────────────────────────────
  t0 = performance.now();
  let densePoints: PointCloud = { xyz: new Float32Array(0), rgb: new Uint8Array(0), count: 0 };

  if (cfg.dense.enabled && sfm.registeredFrames.length >= 4) {
    const sparseXyz = sfm.points.map((p) => p.xyz);
    const centres = sfm.registeredFrames.map((f) => cameraCentre(sfm.poses.get(f)!));
    let extent = 1;
    if (centres.length > 1) {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (const c of centres) {
        for (let a = 0; a < 3; a++) {
          if (c[a] < lo[a]) lo[a] = c[a];
          if (c[a] > hi[a]) hi[a] = c[a];
        }
      }
      extent = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
    }

    // Evenly sample reference views across the capture so coverage is uniform.
    const candidates = sfm.registeredFrames;
    const wanted = Math.min(cfg.dense.maxReferenceViews, candidates.length);
    const refIndices: number[] = [];
    for (let i = 0; i < wanted; i++) {
      refIndices.push(candidates[Math.floor((i * candidates.length) / wanted)]);
    }

    const denseLongEdge = cfg.dense.longEdge;
    const first = byIndex.get(candidates[0])!;
    const denseScale = Math.min(1, denseLongEdge / Math.max(first.meta.width, first.meta.height));
    const dw = Math.max(8, Math.round(first.meta.width * denseScale));
    const dh = Math.max(8, Math.round(first.meta.height * denseScale));

    // Downscale a stored frame to the densification resolution.
    const loadDenseView = async (frameIndex: number): Promise<DenseView | null> => {
      const k = byIndex.get(frameIndex);
      const pose = sfm.poses.get(frameIndex);
      if (!k || !pose) return null;
      const gray = await store.readGray(frameIndex, k.grayBytes);
      const rgb = await store.readRgb(frameIndex, k.grayBytes, k.rgbBytes);

      const outGray = new Uint8Array(dw * dh);
      const outRgb = new Uint8Array(dw * dh * 3);
      for (let y = 0; y < dh; y++) {
        const sy = Math.min(k.meta.height - 1, Math.floor((y / dh) * k.meta.height));
        const cy = Math.min(k.colorHeight - 1, Math.floor((y / dh) * k.colorHeight));
        for (let x = 0; x < dw; x++) {
          const sx = Math.min(k.meta.width - 1, Math.floor((x / dw) * k.meta.width));
          const cx = Math.min(k.colorWidth - 1, Math.floor((x / dw) * k.colorWidth));
          outGray[y * dw + x] = gray[sy * k.meta.width + sx];
          const si = (cy * k.colorWidth + cx) * 3;
          const di = (y * dw + x) * 3;
          outRgb[di] = rgb[si];
          outRgb[di + 1] = rgb[si + 1];
          outRgb[di + 2] = rgb[si + 2];
        }
      }
      return { frameIndex, pose, gray: outGray, width: dw, height: dh, rgb: outRgb };
    };

    const voxel = Math.max(1e-5, extent * cfg.dense.voxelFraction);
    let origin: [number, number, number] = [0, 0, 0];
    if (sparseXyz.length) {
      origin = [
        Math.min(...sparseXyz.map((p) => p[0])) - extent,
        Math.min(...sparseXyz.map((p) => p[1])) - extent,
        Math.min(...sparseXyz.map((p) => p[2])) - extent,
      ];
    }
    const fuser = new PointFuser(voxel, origin);

    const denseOptions = {
      focal: sfm.focal,
      principal: sfm.principal,
      referenceWidth: first.meta.width,
      referenceHeight: first.meta.height,
      depthSamples: cfg.dense.depthSamples,
      patchRadius: cfg.dense.patchRadius,
      maxCost: cfg.dense.maxCost,
      neighbours: cfg.dense.neighbors,
    };

    // Cache a rolling set of neighbour views to avoid re-reading OPFS constantly.
    const viewCache = new Map<number, DenseView>();
    const getView = async (frameIndex: number): Promise<DenseView | null> => {
      const hit = viewCache.get(frameIndex);
      if (hit) return hit;
      const v = await loadDenseView(frameIndex);
      if (!v) return null;
      if (viewCache.size > 14) {
        const oldest = viewCache.keys().next().value;
        if (oldest !== undefined) viewCache.delete(oldest);
      }
      viewCache.set(frameIndex, v);
      return v;
    };

    const allViews: DenseView[] = [];
    for (const f of candidates) {
      const pose = sfm.poses.get(f);
      if (pose) {
        // Lightweight stand-in for neighbour selection; pixels are loaded lazily.
        allViews.push({ frameIndex: f, pose, gray: new Uint8Array(0), width: dw, height: dh, rgb: new Uint8Array(0) });
      }
    }

    let sweptOk = 0;
    for (let i = 0; i < refIndices.length; i++) {
      if (cancelled) throw new Error("Cancelled");
      const refIndex = refIndices[i];
      const ref = await getView(refIndex);
      if (!ref) continue;

      const range = depthRangeFor(ref.pose, sparseXyz);
      if (!range) continue;

      const neighbourStubs = pickNeighbours(ref, allViews, cfg.dense.neighbors, extent);
      const sources: DenseView[] = [];
      for (const stub of neighbourStubs) {
        const v = await getView(stub.frameIndex);
        if (v) sources.push(v);
      }
      if (sources.length === 0) continue;

      // Trim the far plane to where this view's stereo is still trustworthy.
      // A one-pixel matching slip at depth z moves the point by about
      // z²/(f·B); past the point where that exceeds a few fusion voxels the
      // depths are noise, and keeping them just fans a cone out of the camera.
      const refCentre = cameraCentre(ref.pose);
      const baselines = sources
        .map((src) => {
          const c = cameraCentre(src.pose);
          return Math.hypot(c[0] - refCentre[0], c[1] - refCentre[1], c[2] - refCentre[2]);
        })
        .sort((a, b) => a - b);
      const baseline = baselines[Math.floor(baselines.length / 2)];
      if (baseline > 1e-6) {
        const focalAtSweep = sfm.focal * (denseOptions.referenceWidth > 0
          ? Math.min(cfg.dense.longEdge / Math.max(denseOptions.referenceWidth, denseOptions.referenceHeight), 1)
          : 1);
        const trusted = Math.sqrt(
          voxel * cfg.dense.depthUncertaintyVoxels * focalAtSweep * baseline,
        );
        range.max = Math.min(range.max, Math.max(range.min * 1.5, trusted));
      }

      try {
        const sweep = await sweepView(ref, sources, range, denseOptions);
        const pts = depthToPoints(ref, sweep, denseOptions, 1);
        fuser.add(pts, refIndex);
        sweptOk++;
      } catch (err) {
        if (sweptOk === 0 && i > 3) {
          warn(
            "dense-failed",
            `Densification failed on the GPU (${err instanceof Error ? err.message : String(err)}). ` +
            `The scene will show only the sparse reconstruction.`,
          );
          break;
        }
      }

      progress(
        "dense", (i + 1) / refIndices.length,
        `${i + 1}/${refIndices.length} depth maps · ${fuser.size.toLocaleString()} points`,
      );
    }

    densePoints = fuser.result(cfg.dense.minConsistentViews);
    log("info", `Dense reconstruction: ${densePoints.count.toLocaleString()} points from ${sweptOk} views`);
  }

  stageMs.dense = Math.round(performance.now() - t0);
  post({ type: "stage-complete", stage: "dense", ms: stageMs.dense });

  // ── Stage 4: build the scene ────────────────────────────────────────────
  t0 = performance.now();
  progress("scene", 0.2, "Assembling scene");

  let points: PointCloud = densePoints;
  if (points.count < 5000) {
    // Fall back to the sparse cloud rather than shipping an empty viewer.
    const xyz = new Float32Array(sfm.points.length * 3);
    const rgb = new Uint8Array(sfm.points.length * 3);
    sfm.points.forEach((p, i) => {
      xyz[i * 3] = p.xyz[0]; xyz[i * 3 + 1] = p.xyz[1]; xyz[i * 3 + 2] = p.xyz[2];
      rgb[i * 3] = p.rgb[0]; rgb[i * 3 + 1] = p.rgb[1]; rgb[i * 3 + 2] = p.rgb[2];
    });
    points = { xyz, rgb, count: sfm.points.length };
    if (cfg.dense.enabled) {
      warn(
        "sparse-only",
        "Densification produced too few points, so the viewer is showing the sparse " +
        "reconstruction. It will look like a cloud of dots rather than surfaces.",
      );
    }
  }

  if (points.count > cfg.dense.maxPoints) {
    const stride = points.count / cfg.dense.maxPoints;
    const n = cfg.dense.maxPoints;
    const xyz = new Float32Array(n * 3);
    const rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      const src = Math.floor(i * stride);
      xyz[i * 3] = points.xyz[src * 3];
      xyz[i * 3 + 1] = points.xyz[src * 3 + 1];
      xyz[i * 3 + 2] = points.xyz[src * 3 + 2];
      rgb[i * 3] = points.rgb[src * 3];
      rgb[i * 3 + 1] = points.rgb[src * 3 + 1];
      rgb[i * 3 + 2] = points.rgb[src * 3 + 2];
    }
    points = { xyz, rgb, count: n };
  }

  const report: ReconReport = {
    unified,
    clipsRegistered: clipsWithFrames.length,
    clipsTotal: clipStats.length,
    componentCount: sfm.components.length,
    framesDecoded: clipStats.reduce((a, c) => a + c.decodedFrames, 0),
    framesUsed: kept.length,
    framesRegistered: sfm.registeredFrames.length,
    sparsePoints: sfm.points.length,
    densePoints: densePoints.count,
    reprojectionRmsePx: +sfm.rmsePx.toFixed(3),
    focalPx: Math.round(sfm.focal),
    crossClipPairs: sfm.crossClipPairs,
    elapsedMs: Math.round(performance.now() - started),
    stageMs,
    warnings,
    gpu: gpuLabel + (gpuFallback ? " (software)" : ""),
    quality,
  };

  const frameClip = new Map<number, string>();
  const frameOrder = new Map<number, number>();
  for (const k of kept) {
    frameClip.set(k.meta.index, k.meta.clipId);
    frameOrder.set(k.meta.index, k.meta.orderInClip);
  }

  const scene = buildScene({
    id: `scene-${Date.now().toString(36)}`,
    label: clipInputs.length === 1 ? clipInputs[0].name : `${clipInputs.length}-clip capture`,
    poses: sfm.poses,
    frameClip,
    frameOrder,
    clips: clipStats.map((c) => ({ id: c.id, label: c.label, keptFrames: c.keptFrames })),
    points,
    config: cfg,
    report,
  });

  stageMs.scene = Math.round(performance.now() - t0);
  scene.report.stageMs = stageMs;
  scene.report.elapsedMs = Math.round(performance.now() - started);
  post({ type: "stage-complete", stage: "scene", ms: stageMs.scene });
  progress("scene", 1, "Done");

  await store.clear();
  post({ type: "done", scene });
}

// `onFrame` from the decoder is synchronous, so async work it triggers is
// chained here and awaited at the end of each clip.
let pending: Promise<void> = Promise.resolve();

ctx.onmessage = (event: MessageEvent) => {
  const data = event.data as {
    type: string;
    clips?: Array<{ id: string; name: string; file: File }>;
    quality?: QualityPreset;
    overrides?: Partial<ReconConfig> | null;
  };

  if (data.type === "cancel") {
    cancelled = true;
    abort.abort();
    return;
  }

  if (data.type === "start" && data.clips) {
    run(data.clips, data.quality ?? "balanced", data.overrides ?? null).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      post({
        type: "failed",
        error: message,
        hint: hintFor(message),
        warnings,
      });
    });
  }
};

/** Turn a failure into something the user can act on. */
function hintFor(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("cancel")) return "";
  if (m.includes("webgpu") || m.includes("adapter")) {
    return "Use a recent desktop Chrome or Edge. On Linux, WebGPU may need enabling in chrome://flags.";
  }
  if (m.includes("decode") || m.includes("codec") || m.includes("hevc")) {
    return "If these are iPhone clips, set Camera → Formats → Most Compatible and re-record, " +
      "or convert them to H.264 MP4 first.";
  }
  if (m.includes("parallax") || m.includes("rotat")) {
    return "Walk through the space rather than panning from one spot — reconstruction needs the " +
      "camera to move sideways, not just turn.";
  }
  if (m.includes("overlap") || m.includes("track") || m.includes("verified")) {
    return "Re-record with more overlap: each clip should revisit areas the others already covered, " +
      "and you should walk slowly enough that consecutive frames look similar.";
  }
  if (m.includes("memory") || m.includes("allocation")) {
    return "Try the Draft quality preset, or split the capture into two smaller connected zones " +
      "and process each separately.";
  }
  return "Try the Draft quality preset, or re-record with slower movement and more overlap.";
}

export {};
