// Densification: sparse points are correct but unrecognisable; this is what
// makes the result look like a room.
//
// Structure from Motion leaves a few thousand isolated 3D points — enough to
// prove the geometry is right, nowhere near enough to see a couch. Plane-sweep
// multi-view stereo fills that in: for every pixel of a reference frame, try a
// range of candidate depths, project each candidate into a handful of
// neighbouring frames, and keep the depth whose image patches agree best.
//
// It runs as one WebGPU compute pass per reference view. The cost volume is
// never materialised — each thread sweeps depths in registers and keeps only
// the winner — which is what makes this fit in a browser's GPU memory budget.
//
// Matching cost is zero-mean normalised cross-correlation, chosen because phone
// cameras change exposure constantly as they pan; plain SAD would call a
// correctly-matched patch a mismatch the moment auto-exposure moved.

import { createStorageBuffer, getGpuContext, readBuffer } from "../gpu/device";
import { mat3MulVec, mat3Transpose } from "../math/linalg";
import type { Pose } from "../math/twoView";

export interface DenseView {
  frameIndex: number;
  pose: Pose;
  /** Greyscale image at `width` x `height`. */
  gray: Uint8Array;
  width: number;
  height: number;
  /** RGB at the same resolution as `gray`. */
  rgb: Uint8Array;
}

export interface DenseOptions {
  focal: number;
  principal: [number, number];
  /** Image dimensions the focal/principal refer to. */
  referenceWidth: number;
  referenceHeight: number;
  depthSamples: number;
  patchRadius: number;
  maxCost: number;
  neighbours: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface DensePoint {
  xyz: [number, number, number];
  rgb: [number, number, number];
}

const WORKGROUP_X = 8;
const WORKGROUP_Y = 8;
const MAX_SOURCES = 4;

const SHADER = /* wgsl */ `
struct Params {
  width        : u32,
  height       : u32,
  sourceCount  : u32,
  depthSamples : u32,
  fx           : f32,
  fy           : f32,
  cx           : f32,
  cy           : f32,
  invDepthMin  : f32,
  invDepthMax  : f32,
  patchRadius  : i32,
  maxCost      : f32,
};

// Per source view: 3x4 [R | t] relative to the reference camera, row-major,
// padded to 16 floats for alignment.
struct SourceXform {
  m : array<vec4<f32>, 3>,
};

@group(0) @binding(0) var<storage, read>       refImage : array<u32>;
@group(0) @binding(1) var<storage, read>       srcImage : array<u32>;
@group(0) @binding(2) var<storage, read_write> depthOut : array<f32>;
@group(0) @binding(3) var<storage, read_write> costOut  : array<f32>;
@group(0) @binding(4) var<uniform>             params   : Params;
@group(0) @binding(5) var<uniform>             xforms   : array<SourceXform, ${MAX_SOURCES}>;

// Images are packed 4 greyscale bytes per u32 to keep the buffers small.
// The reference image and the stack of source images live in separate storage
// buffers, so they get separate accessors — one shared helper that tried to
// address both would silently read the wrong plane.

fn sampleRef(x : i32, y : i32, w : i32, h : i32) -> f32 {
  let sx = clamp(x, 0, w - 1);
  let sy = clamp(y, 0, h - 1);
  let idx = u32(sy * w + sx);
  let word = refImage[idx / 4u];
  return f32((word >> ((idx % 4u) * 8u)) & 0xffu) / 255.0;
}

fn sampleSrc(plane : u32, stride : u32, x : i32, y : i32, w : i32, h : i32) -> f32 {
  let sx = clamp(x, 0, w - 1);
  let sy = clamp(y, 0, h - 1);
  let idx = u32(sy * w + sx);
  let word = srcImage[plane * stride + idx / 4u];
  return f32((word >> ((idx % 4u) * 8u)) & 0xffu) / 255.0;
}

fn bilinearSrc(plane : u32, stride : u32, x : f32, y : f32, w : i32, h : i32) -> f32 {
  let x0 = i32(floor(x));
  let y0 = i32(floor(y));
  let fx = x - f32(x0);
  let fy = y - f32(y0);
  let a = sampleSrc(plane, stride, x0,     y0,     w, h);
  let b = sampleSrc(plane, stride, x0 + 1, y0,     w, h);
  let c = sampleSrc(plane, stride, x0,     y0 + 1, w, h);
  let d = sampleSrc(plane, stride, x0 + 1, y0 + 1, w, h);
  return mix(mix(a, b, fx), mix(c, d, fx), fy);
}

@compute @workgroup_size(${WORKGROUP_X}, ${WORKGROUP_Y})
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let w = i32(params.width);
  let h = i32(params.height);
  let px = i32(gid.x);
  let py = i32(gid.y);
  if (px >= w || py >= h) { return; }

  let outIdx = u32(py * w + px);
  depthOut[outIdx] = 0.0;
  costOut[outIdx]  = 1e9;

  if (params.sourceCount == 0u) { return; }

  // Viewing ray through this pixel in reference-camera coordinates.
  let ray = vec3<f32>(
    (f32(px) - params.cx) / params.fx,
    (f32(py) - params.cy) / params.fy,
    1.0,
  );

  let r = params.patchRadius;
  let patchCount = f32((2 * r + 1) * (2 * r + 1));

  // Reference patch statistics, computed once for all depths.
  var refMean : f32 = 0.0;
  for (var dy = -r; dy <= r; dy = dy + 1) {
    for (var dx = -r; dx <= r; dx = dx + 1) {
      refMean = refMean + sampleRef(px + dx, py + dy, w, h);
    }
  }
  refMean = refMean / patchCount;

  var refVar : f32 = 0.0;
  for (var dy = -r; dy <= r; dy = dy + 1) {
    for (var dx = -r; dx <= r; dx = dx + 1) {
      let v = sampleRef(px + dx, py + dy, w, h) - refMean;
      refVar = refVar + v * v;
    }
  }
  // A flat reference patch cannot be matched by any correlation measure.
  if (refVar < 1e-4) { return; }
  let refStd = sqrt(refVar);

  let planeStride = u32(w * h + 3) / 4u;

  var bestCost  : f32 = 1e9;
  var bestDepth : f32 = 0.0;

  for (var d = 0u; d < params.depthSamples; d = d + 1u) {
    // Sample uniformly in INVERSE depth: that spaces candidates evenly in
    // disparity, which is where the information actually is.
    let t = f32(d) / f32(max(1u, params.depthSamples - 1u));
    let invDepth = mix(params.invDepthMin, params.invDepthMax, t);
    if (invDepth <= 0.0) { continue; }
    let depth = 1.0 / invDepth;
    let X = ray * depth;

    var costSum : f32 = 0.0;
    var used    : u32 = 0u;

    for (var s = 0u; s < params.sourceCount; s = s + 1u) {
      let m = xforms[s].m;
      let Xs = vec3<f32>(
        m[0].x * X.x + m[0].y * X.y + m[0].z * X.z + m[0].w,
        m[1].x * X.x + m[1].y * X.y + m[1].z * X.z + m[1].w,
        m[2].x * X.x + m[2].y * X.y + m[2].z * X.z + m[2].w,
      );
      if (Xs.z <= 1e-4) { continue; }

      let su = params.fx * Xs.x / Xs.z + params.cx;
      let sv = params.fy * Xs.y / Xs.z + params.cy;
      // Reject if the patch would fall outside the source image.
      if (su < f32(r) || sv < f32(r) ||
          su >= f32(w - r - 1) || sv >= f32(h - r - 1)) { continue; }

      var srcMean : f32 = 0.0;
      for (var dy = -r; dy <= r; dy = dy + 1) {
        for (var dx = -r; dx <= r; dx = dx + 1) {
          srcMean = srcMean + bilinearSrc(s, planeStride, su + f32(dx), sv + f32(dy), w, h);
        }
      }
      srcMean = srcMean / patchCount;

      var num : f32 = 0.0;
      var srcVar : f32 = 0.0;
      for (var dy = -r; dy <= r; dy = dy + 1) {
        for (var dx = -r; dx <= r; dx = dx + 1) {
          let sv2 = bilinearSrc(s, planeStride, su + f32(dx), sv + f32(dy), w, h) - srcMean;
          let rv  = sampleRef(px + dx, py + dy, w, h) - refMean;
          num = num + rv * sv2;
          srcVar = srcVar + sv2 * sv2;
        }
      }
      if (srcVar < 1e-6) { continue; }

      // ZNCC in [-1, 1]; convert to a cost in [0, 1].
      let ncc = num / (refStd * sqrt(srcVar));
      costSum = costSum + (1.0 - clamp(ncc, -1.0, 1.0)) * 0.5;
      used = used + 1u;
    }

    if (used == 0u) { continue; }
    let cost = costSum / f32(used);
    if (cost < bestCost) {
      bestCost = cost;
      bestDepth = depth;
    }
  }

  if (bestCost <= params.maxCost) {
    depthOut[outIdx] = bestDepth;
    costOut[outIdx]  = bestCost;
  }
}
`;

let pipelinePromise: Promise<{ device: GPUDevice; pipeline: GPUComputePipeline }> | null = null;

async function getPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { device } = await getGpuContext();
      const shaderModule = device.createShaderModule({ code: SHADER, label: "plane-sweep" });
      const info = await shaderModule.getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === "error");
      if (errors.length) {
        throw new Error(
          `Densification shader failed to compile: ` +
          errors.map((e) => `${e.lineNum}:${e.linePos} ${e.message}`).join("; "),
        );
      }
      const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module: shaderModule, entryPoint: "main" },
        label: "plane-sweep",
      });
      return { device, pipeline };
    })();
  }
  return pipelinePromise;
}

/** Pack a greyscale plane into u32 words, 4 pixels per word. */
function packGray(gray: Uint8Array, pixels: number): Uint32Array {
  const words = new Uint32Array(Math.ceil(pixels / 4));
  for (let i = 0; i < pixels; i++) {
    words[i >> 2] |= gray[i] << ((i & 3) * 8);
  }
  return words;
}

/** Camera centre in world coordinates. */
export function cameraCentre(pose: Pose): [number, number, number] {
  const c = mat3MulVec(mat3Transpose(pose.R), [-pose.t[0], -pose.t[1], -pose.t[2]]);
  return [c[0], c[1], c[2]];
}

/** Relative transform taking reference-camera coordinates into source-camera. */
function relativeTransform(ref: Pose, src: Pose): Float32Array {
  // X_src = R_src·X_world + t_src, and X_world = R_refᵀ·(X_ref − t_ref)
  const Rrt = mat3Transpose(ref.R);
  const R = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += src.R[i * 3 + k] * Rrt[k * 3 + j];
      R[i * 3 + j] = s;
    }
  }
  const Rt = mat3MulVec(R, ref.t);
  const t = [src.t[0] - Rt[0], src.t[1] - Rt[1], src.t[2] - Rt[2]];

  // Row-major 3x4, each row padded to vec4.
  return new Float32Array([
    R[0], R[1], R[2], t[0],
    R[3], R[4], R[5], t[1],
    R[6], R[7], R[8], t[2],
  ]);
}

/** Depth range for a reference view, from the sparse points it can see. */
export function depthRangeFor(
  ref: Pose, points: Array<[number, number, number]>,
): { min: number; max: number } | null {
  const depths: number[] = [];
  for (const X of points) {
    const c = mat3MulVec(ref.R, X);
    const z = c[2] + ref.t[2];
    if (z > 1e-4) depths.push(z);
  }
  if (depths.length < 8) return null;
  depths.sort((a, b) => a - b);
  const lo = depths[Math.floor(depths.length * 0.02)];
  const hi = depths[Math.floor(depths.length * 0.98)];
  if (!(hi > lo)) return null;
  // Pad the range so surfaces slightly nearer or further than any sparse point
  // are still reachable.
  return { min: Math.max(1e-3, lo * 0.7), max: hi * 1.4 };
}

export interface SweepResult {
  depth: Float32Array;
  cost: Float32Array;
  width: number;
  height: number;
}

/** Run the sweep for one reference view against its neighbours. */
export async function sweepView(
  reference: DenseView,
  sources: DenseView[],
  depthRange: { min: number; max: number },
  options: DenseOptions,
): Promise<SweepResult> {
  const { device, pipeline } = await getPipeline();
  const w = reference.width;
  const h = reference.height;
  const pixels = w * h;
  const used = sources.slice(0, MAX_SOURCES);

  const refWords = packGray(reference.gray, pixels);
  const planeStride = Math.ceil(pixels / 4);
  const srcWords = new Uint32Array(planeStride * Math.max(1, used.length));
  used.forEach((s, i) => srcWords.set(packGray(s.gray, pixels), i * planeStride));

  // Intrinsics were solved at the SfM working resolution; rescale them to
  // whatever resolution densification is running at.
  const scaleX = w / options.referenceWidth;
  const scaleY = h / options.referenceHeight;

  const params = new ArrayBuffer(48);
  const pu = new Uint32Array(params);
  const pf = new Float32Array(params);
  const pi = new Int32Array(params);
  pu[0] = w;
  pu[1] = h;
  pu[2] = used.length;
  pu[3] = options.depthSamples;
  pf[4] = options.focal * scaleX;
  pf[5] = options.focal * scaleY;
  pf[6] = options.principal[0] * scaleX;
  pf[7] = options.principal[1] * scaleY;
  pf[8] = 1 / depthRange.max;
  pf[9] = 1 / depthRange.min;
  pi[10] = options.patchRadius;
  pf[11] = options.maxCost;

  const xformData = new Float32Array(MAX_SOURCES * 12);
  used.forEach((s, i) => xformData.set(relativeTransform(reference.pose, s.pose), i * 12));

  const refBuf = createStorageBuffer(device, refWords);
  const srcBuf = createStorageBuffer(device, srcWords);
  const depthBuf = device.createBuffer({
    size: pixels * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const costBuf = device.createBuffer({
    size: pixels * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const paramBuf = device.createBuffer({
    size: params.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(paramBuf, 0, params);
  const xformBuf = device.createBuffer({
    size: xformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(xformBuf, 0, xformData);

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: refBuf } },
      { binding: 1, resource: { buffer: srcBuf } },
      { binding: 2, resource: { buffer: depthBuf } },
      { binding: 3, resource: { buffer: costBuf } },
      { binding: 4, resource: { buffer: paramBuf } },
      { binding: 5, resource: { buffer: xformBuf } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(w / WORKGROUP_X), Math.ceil(h / WORKGROUP_Y));
  pass.end();
  device.queue.submit([encoder.finish()]);

  const [depthRaw, costRaw] = await Promise.all([
    readBuffer(device, depthBuf, pixels * 4),
    readBuffer(device, costBuf, pixels * 4),
  ]);

  refBuf.destroy();
  srcBuf.destroy();
  depthBuf.destroy();
  costBuf.destroy();
  paramBuf.destroy();
  xformBuf.destroy();

  return {
    depth: new Float32Array(depthRaw),
    cost: new Float32Array(costRaw),
    width: w,
    height: h,
  };
}

/** Turn a depth map into world-space coloured points. */
export function depthToPoints(
  view: DenseView,
  sweep: SweepResult,
  options: DenseOptions,
  stride = 1,
): DensePoint[] {
  const out: DensePoint[] = [];
  const scaleX = sweep.width / options.referenceWidth;
  const scaleY = sweep.height / options.referenceHeight;
  const fx = options.focal * scaleX;
  const fy = options.focal * scaleY;
  const cx = options.principal[0] * scaleX;
  const cy = options.principal[1] * scaleY;

  const Rt = mat3Transpose(view.pose.R);

  for (let y = 0; y < sweep.height; y += stride) {
    for (let x = 0; x < sweep.width; x += stride) {
      const i = y * sweep.width + x;
      const depth = sweep.depth[i];
      if (!(depth > 0) || !Number.isFinite(depth)) continue;

      const cam = [((x - cx) / fx) * depth, ((y - cy) / fy) * depth, depth];
      // world = Rᵀ · (cam − t)
      const shifted = [cam[0] - view.pose.t[0], cam[1] - view.pose.t[1], cam[2] - view.pose.t[2]];
      const world = mat3MulVec(Rt, shifted);

      out.push({
        xyz: [world[0], world[1], world[2]],
        rgb: [view.rgb[i * 3], view.rgb[i * 3 + 1], view.rgb[i * 3 + 2]],
      });
    }
  }
  return out;
}

/**
 * Voxel-grid fusion with a multi-view agreement test.
 *
 * A voxel hit by only one reference view is almost always a stereo artefact —
 * the depth that happened to correlate best in a textureless region. Requiring
 * agreement between independent views removes most of that noise, at the cost
 * of thinning surfaces only one camera ever saw.
 *
 * Voxel size is the tuning that decides whether that test means anything. Set
 * it finer than the stereo noise and two views never land in the same cell, so
 * almost everything is discarded as inconsistent; set it too coarse and real
 * detail is averaged away. It wants to be a few centimetres for a room.
 */
export class PointFuser {
  private buckets = new Map<number, {
    x: number; y: number; z: number;
    r: number; g: number; b: number;
    n: number; views: Set<number>;
  }>();

  constructor(
    private readonly voxel: number,
    private readonly origin: [number, number, number],
  ) {}

  add(points: DensePoint[], viewIndex: number): void {
    for (const p of points) {
      const gx = Math.floor((p.xyz[0] - this.origin[0]) / this.voxel);
      const gy = Math.floor((p.xyz[1] - this.origin[1]) / this.voxel);
      const gz = Math.floor((p.xyz[2] - this.origin[2]) / this.voxel);
      // 21 bits per axis keeps the key inside a safe integer.
      if (gx < 0 || gy < 0 || gz < 0 || gx > 2097151 || gy > 2097151 || gz > 2097151) continue;
      const key = gx * 4398046511104 + gy * 2097152 + gz;

      const cell = this.buckets.get(key);
      if (cell) {
        cell.x += p.xyz[0]; cell.y += p.xyz[1]; cell.z += p.xyz[2];
        cell.r += p.rgb[0]; cell.g += p.rgb[1]; cell.b += p.rgb[2];
        cell.n++;
        cell.views.add(viewIndex);
      } else {
        this.buckets.set(key, {
          x: p.xyz[0], y: p.xyz[1], z: p.xyz[2],
          r: p.rgb[0], g: p.rgb[1], b: p.rgb[2],
          n: 1, views: new Set([viewIndex]),
        });
      }
    }
  }

  get size(): number {
    return this.buckets.size;
  }

  result(minViews: number): { xyz: Float32Array; rgb: Uint8Array; count: number } {
    let kept: Array<{ x: number; y: number; z: number; r: number; g: number; b: number; n: number }> = [];
    for (const cell of this.buckets.values()) {
      if (cell.views.size >= minViews) kept.push(cell);
    }
    // If the consistency test was too strict for this capture, fall back rather
    // than handing the viewer an empty scene.
    if (kept.length < 20000 && minViews > 1) {
      kept = [...this.buckets.values()];
    }

    const xyz = new Float32Array(kept.length * 3);
    const rgb = new Uint8Array(kept.length * 3);
    kept.forEach((c, i) => {
      xyz[i * 3] = c.x / c.n;
      xyz[i * 3 + 1] = c.y / c.n;
      xyz[i * 3 + 2] = c.z / c.n;
      rgb[i * 3] = Math.min(255, Math.round(c.r / c.n));
      rgb[i * 3 + 1] = Math.min(255, Math.round(c.g / c.n));
      rgb[i * 3 + 2] = Math.min(255, Math.round(c.b / c.n));
    });
    return { xyz, rgb, count: kept.length };
  }
}

/** Choose which frames to densify against a reference — enough baseline to
 *  triangulate, enough overlap to still see the same surfaces. */
export function pickNeighbours(
  reference: DenseView, candidates: DenseView[], count: number, sceneExtent: number,
): DenseView[] {
  const refCentre = cameraCentre(reference.pose);
  const refForward = mat3MulVec(mat3Transpose(reference.pose.R), [0, 0, 1]);
  const ideal = 0.05 * sceneExtent;

  const scored: Array<{ view: DenseView; score: number }> = [];
  for (const cand of candidates) {
    if (cand.frameIndex === reference.frameIndex) continue;
    const c = cameraCentre(cand.pose);
    const baseline = Math.hypot(c[0] - refCentre[0], c[1] - refCentre[1], c[2] - refCentre[2]);
    if (baseline < 1e-6) continue;

    const fwd = mat3MulVec(mat3Transpose(cand.pose.R), [0, 0, 1]);
    const cos = refForward[0] * fwd[0] + refForward[1] * fwd[1] + refForward[2] * fwd[2];
    // Cameras pointing more than ~65 degrees apart share too little to match.
    if (cos < 0.42) continue;

    const ratio = baseline / ideal;
    const baselineScore = 1 / (1 + Math.abs(Math.log(Math.max(ratio, 1e-3))));
    scored.push({ view: cand, score: baselineScore * cos });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.min(count, MAX_SOURCES)).map((s) => s.view);
}
