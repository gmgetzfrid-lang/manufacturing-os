// GPU brute-force descriptor matching.
//
// This is the stage that decides whether browser-local reconstruction is
// practical at all. Matching ~400 frames needs several thousand image pairs, and
// OpenCV's CPU matcher costs roughly 200 ms per pair at 2400 features — over
// fifteen minutes of pure matching. The same work on the GPU is a popcount over
// a few million descriptor pairs, which is exactly what graphics hardware is
// good at.
//
// One thread per query descriptor, scanning the train set through workgroup-
// shared tiles, tracking the best and second-best Hamming distance so the
// caller can apply Lowe's ratio test.

import { createStorageBuffer, getGpuContext, readBuffer } from "./device";

/** ORB descriptors are 32 bytes = 8 u32 words. */
const WORDS = 8;
const WORKGROUP = 64;
const TILE = 64;

const SHADER = /* wgsl */ `
struct Params {
  queryCount : u32,
  trainCount : u32,
  _pad0      : u32,
  _pad1      : u32,
};

@group(0) @binding(0) var<storage, read>       queryDesc  : array<u32>;
@group(0) @binding(1) var<storage, read>       trainDesc  : array<u32>;
@group(0) @binding(2) var<storage, read_write> bestIdx    : array<u32>;
@group(0) @binding(3) var<storage, read_write> bestDist   : array<u32>;
@group(0) @binding(4) var<uniform>             params     : Params;

// A tile of train descriptors staged in workgroup memory so the inner loop
// reads from fast local storage instead of hammering global memory.
var<workgroup> tile : array<u32, ${TILE * WORDS}u>;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(local_invocation_id)  lid : vec3<u32>) {
  let q = gid.x;
  let inRange = q < params.queryCount;

  var d0 : array<u32, ${WORDS}u>;
  if (inRange) {
    let base = q * ${WORDS}u;
    for (var w = 0u; w < ${WORDS}u; w = w + 1u) {
      d0[w] = queryDesc[base + w];
    }
  }

  var best  : u32 = 0xffffffffu;
  var second: u32 = 0xffffffffu;
  var bestJ : u32 = 0xffffffffu;

  var tileStart : u32 = 0u;
  loop {
    if (tileStart >= params.trainCount) { break; }

    // Cooperatively stage this tile. Every invocation in the workgroup must
    // reach both barriers, so this runs whether or not the thread is inRange.
    let remaining = params.trainCount - tileStart;
    let count = min(${TILE}u, remaining);
    var slot = lid.x;
    loop {
      if (slot >= count) { break; }
      let src = (tileStart + slot) * ${WORDS}u;
      let dst = slot * ${WORDS}u;
      for (var w = 0u; w < ${WORDS}u; w = w + 1u) {
        tile[dst + w] = trainDesc[src + w];
      }
      slot = slot + ${WORKGROUP}u;
    }
    workgroupBarrier();

    if (inRange) {
      for (var j = 0u; j < count; j = j + 1u) {
        let base = j * ${WORDS}u;
        var dist : u32 = 0u;
        for (var w = 0u; w < ${WORDS}u; w = w + 1u) {
          dist = dist + countOneBits(d0[w] ^ tile[base + w]);
        }
        if (dist < best) {
          second = best;
          best = dist;
          bestJ = tileStart + j;
        } else if (dist < second) {
          second = dist;
        }
      }
    }
    workgroupBarrier();
    tileStart = tileStart + ${TILE}u;
  }

  if (inRange) {
    bestIdx[q]      = bestJ;
    bestDist[q * 2u]      = best;
    bestDist[q * 2u + 1u] = second;
  }
}
`;

interface MatcherPipeline {
  device: GPUDevice;
  pipeline: GPUComputePipeline;
}

let pipelinePromise: Promise<MatcherPipeline> | null = null;

async function getPipeline(): Promise<MatcherPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { device } = await getGpuContext();
      const shaderModule = device.createShaderModule({ code: SHADER, label: "hamming-matcher" });
      const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module: shaderModule, entryPoint: "main" },
        label: "hamming-matcher",
      });
      return { device, pipeline };
    })();
  }
  return pipelinePromise;
}

export interface DescriptorSet {
  /** `count` rows of 32 bytes. */
  data: Uint8Array;
  count: number;
}

export interface RawMatchResult {
  /** For each query descriptor, the index of its nearest train descriptor. */
  index: Uint32Array;
  /** Interleaved [best, secondBest] Hamming distance per query. */
  distance: Uint32Array;
}

/** Descriptors arrive as bytes; the shader wants u32 words. */
function toWords(set: DescriptorSet): Uint32Array {
  const words = new Uint32Array(set.count * WORDS);
  const bytes = set.data;
  for (let i = 0; i < set.count; i++) {
    for (let w = 0; w < WORDS; w++) {
      const b = i * 32 + w * 4;
      words[i * WORDS + w] =
        bytes[b] | (bytes[b + 1] << 8) | (bytes[b + 2] << 16) | (bytes[b + 3] << 24);
    }
  }
  return words;
}

/** Nearest and second-nearest train descriptor for every query descriptor. */
export async function matchDescriptorsGpu(
  query: DescriptorSet,
  train: DescriptorSet,
): Promise<RawMatchResult> {
  if (query.count === 0 || train.count === 0) {
    return { index: new Uint32Array(0), distance: new Uint32Array(0) };
  }
  const { device, pipeline } = await getPipeline();

  const qBuf = createStorageBuffer(device, toWords(query));
  const tBuf = createStorageBuffer(device, toWords(train));
  const idxBuf = device.createBuffer({
    size: query.count * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const distBuf = device.createBuffer({
    size: query.count * 8,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const params = new Uint32Array([query.count, train.count, 0, 0]);
  const paramBuf = device.createBuffer({
    size: params.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(paramBuf, 0, params);

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: qBuf } },
      { binding: 1, resource: { buffer: tBuf } },
      { binding: 2, resource: { buffer: idxBuf } },
      { binding: 3, resource: { buffer: distBuf } },
      { binding: 4, resource: { buffer: paramBuf } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(query.count / WORKGROUP));
  pass.end();
  device.queue.submit([encoder.finish()]);

  const [idxRaw, distRaw] = await Promise.all([
    readBuffer(device, idxBuf, query.count * 4),
    readBuffer(device, distBuf, query.count * 8),
  ]);

  qBuf.destroy();
  tBuf.destroy();
  idxBuf.destroy();
  distBuf.destroy();
  paramBuf.destroy();

  return { index: new Uint32Array(idxRaw), distance: new Uint32Array(distRaw) };
}

export interface MatchPair {
  queryIndex: number;
  trainIndex: number;
  distance: number;
  /**
   * Distance to the runner-up, which the ratio test already computes and used
   * to throw away. How far the winner beat the field discriminates where raw
   * distance cannot: repeated structure produces confident-looking matches with
   * small distances, and it is the narrow margin that gives them away.
   */
  second: number;
}

/**
 * Symmetric matching with Lowe's ratio test.
 *
 * Two filters, both necessary. The ratio test drops matches whose nearest and
 * second-nearest neighbours are similarly close — those are ambiguous, which
 * indoors usually means a repeated texture like a row of blinds. The mutual
 * check then keeps only pairs that pick each other, which removes most of what
 * survives the first filter by luck.
 */
export async function matchMutual(
  a: DescriptorSet,
  b: DescriptorSet,
  options: { ratio?: number; maxDistance?: number } = {},
): Promise<MatchPair[]> {
  const ratio = options.ratio ?? 0.78;
  const maxDistance = options.maxDistance ?? 96;

  const [ab, ba] = await Promise.all([
    matchDescriptorsGpu(a, b),
    matchDescriptorsGpu(b, a),
  ]);

  const out: MatchPair[] = [];
  for (let i = 0; i < a.count; i++) {
    const j = ab.index[i];
    if (j === 0xffffffff || j >= b.count) continue;
    const best = ab.distance[i * 2];
    const second = ab.distance[i * 2 + 1];
    if (best > maxDistance) continue;
    // A second-best of "infinity" means there was only one candidate; accept it.
    if (second !== 0xffffffff && best > ratio * second) continue;
    if (ba.index[j] !== i) continue;
    out.push({ queryIndex: i, trainIndex: j, distance: best, second });
  }
  return out;
}

/** CPU fallback, used when the GPU pipeline cannot be created. */
export function matchMutualCpu(
  a: DescriptorSet,
  b: DescriptorSet,
  options: { ratio?: number; maxDistance?: number } = {},
): MatchPair[] {
  const ratio = options.ratio ?? 0.78;
  const maxDistance = options.maxDistance ?? 96;
  const aw = toWords(a);
  const bw = toWords(b);

  const popcount = (x: number): number => {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  };

  const nearest = (
    src: Uint32Array, srcCount: number, dst: Uint32Array, dstCount: number,
  ) => {
    const idx = new Int32Array(srcCount).fill(-1);
    const d1 = new Int32Array(srcCount).fill(0x7fffffff);
    const d2 = new Int32Array(srcCount).fill(0x7fffffff);
    for (let i = 0; i < srcCount; i++) {
      const base = i * WORDS;
      for (let j = 0; j < dstCount; j++) {
        const jb = j * WORDS;
        let dist = 0;
        for (let w = 0; w < WORDS; w++) dist += popcount(src[base + w] ^ dst[jb + w]);
        if (dist < d1[i]) { d2[i] = d1[i]; d1[i] = dist; idx[i] = j; }
        else if (dist < d2[i]) d2[i] = dist;
      }
    }
    return { idx, d1, d2 };
  };

  const ab = nearest(aw, a.count, bw, b.count);
  const ba = nearest(bw, b.count, aw, a.count);

  const out: MatchPair[] = [];
  for (let i = 0; i < a.count; i++) {
    const j = ab.idx[i];
    if (j < 0) continue;
    if (ab.d1[i] > maxDistance) continue;
    if (ab.d2[i] !== 0x7fffffff && ab.d1[i] > ratio * ab.d2[i]) continue;
    if (ba.idx[j] !== i) continue;
    out.push({
      queryIndex: i, trainIndex: j, distance: ab.d1[i], second: ab.d2[i],
    });
  }
  return out;
}
