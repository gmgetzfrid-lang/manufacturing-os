// What can this machine actually do?
//
// Browser-local reconstruction lives or dies on the hardware in front of the
// user, so the app measures rather than assumes — and reports honestly. Nothing
// here estimates a processing time: the spec is explicit that we do not claim
// timings we have not measured, so the UI shows workload size instead and only
// reports real elapsed time afterwards.

export interface GpuInfo {
  available: boolean;
  vendor: string | null;
  architecture: string | null;
  device: string | null;
  description: string | null;
  /** True when the adapter is a software rasteriser (correct but very slow). */
  isFallback: boolean;
  limits: {
    maxBufferSize: number;
    maxStorageBufferBindingSize: number;
    maxComputeWorkgroupStorageSize: number;
    maxComputeInvocationsPerWorkgroup: number;
    maxTextureDimension2D: number;
  } | null;
  features: string[];
}

export interface MachineReport {
  gpu: GpuInfo;
  cores: number;
  /** navigator.deviceMemory is coarse (and absent on Firefox/Safari). */
  deviceMemoryGb: number | null;
  jsHeapLimitMb: number | null;
  storageQuotaMb: number | null;
  storageUsedMb: number | null;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  webCodecs: boolean;
  offscreenCanvas: boolean;
  opfs: boolean;
  webgl2: boolean;
  userAgent: string;
}

export interface CodecSupport {
  h264: boolean;
  hevc: boolean;
  vp9: boolean;
  av1: boolean;
}

let cached: MachineReport | null = null;

export async function detectMachine(force = false): Promise<MachineReport> {
  if (cached && !force) return cached;

  const gpu = await detectGpu();

  let storageQuotaMb: number | null = null;
  let storageUsedMb: number | null = null;
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      storageQuotaMb = est.quota ? Math.round(est.quota / 1048576) : null;
      storageUsedMb = est.usage ? Math.round(est.usage / 1048576) : null;
    }
  } catch {
    /* Storage estimation is advisory; its absence never blocks a run. */
  }

  // performance.memory is a non-standard Chrome extension — useful when there,
  // absent everywhere else, and never load-bearing.
  const perfMemory = (performance as unknown as {
    memory?: { jsHeapSizeLimit: number };
  }).memory;

  let webgl2 = false;
  try {
    const c = document.createElement("canvas");
    webgl2 = !!c.getContext("webgl2");
  } catch {
    webgl2 = false;
  }

  cached = {
    gpu,
    cores: navigator.hardwareConcurrency || 4,
    deviceMemoryGb:
      (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null,
    jsHeapLimitMb: perfMemory ? Math.round(perfMemory.jsHeapSizeLimit / 1048576) : null,
    storageQuotaMb,
    storageUsedMb,
    crossOriginIsolated: typeof crossOriginIsolated !== "undefined" && crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    webCodecs: typeof VideoDecoder !== "undefined",
    offscreenCanvas: typeof OffscreenCanvas !== "undefined",
    opfs: !!navigator.storage?.getDirectory,
    webgl2,
    userAgent: navigator.userAgent,
  };
  return cached;
}

async function detectGpu(): Promise<GpuInfo> {
  const empty: GpuInfo = {
    available: false, vendor: null, architecture: null, device: null,
    description: null, isFallback: false, limits: null, features: [],
  };
  if (typeof navigator === "undefined" || !navigator.gpu) return empty;

  try {
    // Ask for high performance so laptops pick the discrete GPU when present.
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return empty;

    const info = adapter.info ?? null;
    const architecture = info?.architecture ?? null;
    const vendor = info?.vendor ?? null;
    // Dawn reports SwiftShader (its software backend) through the architecture
    // field. It works, but it is orders of magnitude slower than real silicon,
    // so the UI must warn rather than silently take an hour.
    const isFallback =
      /swiftshader|lavapipe|llvmpipe|software|warp/i.test(
        `${architecture ?? ""} ${vendor ?? ""} ${info?.description ?? ""}`,
      );

    return {
      available: true,
      vendor,
      architecture,
      device: info?.device ?? null,
      description: info?.description ?? null,
      isFallback,
      limits: {
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
        maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
        maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
      },
      features: Array.from(adapter.features as unknown as Set<string>),
    };
  } catch {
    return empty;
  }
}

/** Which video codecs this browser can decode with WebCodecs. */
export async function detectCodecs(): Promise<CodecSupport> {
  const probe = async (codec: string): Promise<boolean> => {
    if (typeof VideoDecoder === "undefined") return false;
    try {
      const r = await VideoDecoder.isConfigSupported({
        codec, codedWidth: 1280, codedHeight: 720,
      });
      return !!r.supported;
    } catch {
      return false;
    }
  };
  const [h264, hevc, vp9, av1] = await Promise.all([
    probe("avc1.640028"),
    probe("hvc1.1.6.L93.B0"),
    probe("vp09.00.10.08"),
    probe("av01.0.04M.08"),
  ]);
  return { h264, hevc, vp9, av1 };
}

export type BlockingReason =
  | "no-webgpu"
  | "no-webcodecs"
  | "no-offscreen-canvas"
  | "no-opfs";

export interface Readiness {
  ready: boolean;
  blockers: BlockingReason[];
  warnings: string[];
}

/** Is this browser able to run a reconstruction at all, and what should we say? */
export function assessReadiness(m: MachineReport, codecs: CodecSupport | null): Readiness {
  const blockers: BlockingReason[] = [];
  const warnings: string[] = [];

  if (!m.gpu.available) blockers.push("no-webgpu");
  if (!m.webCodecs) blockers.push("no-webcodecs");
  if (!m.offscreenCanvas) blockers.push("no-offscreen-canvas");
  if (!m.opfs) blockers.push("no-opfs");

  if (m.gpu.isFallback) {
    warnings.push(
      "Your browser is using a software GPU renderer. Reconstruction will run, " +
      "but it may take many times longer than on real graphics hardware.",
    );
  }
  if (m.gpu.limits && m.gpu.limits.maxStorageBufferBindingSize < 256 * 1024 * 1024) {
    warnings.push(
      "This GPU exposes a small storage-buffer limit, so densification will run " +
      "at reduced resolution.",
    );
  }
  if (m.cores <= 4) {
    warnings.push("Four or fewer CPU cores detected — feature matching will be slower.");
  }
  if (m.deviceMemoryGb !== null && m.deviceMemoryGb <= 4) {
    warnings.push("Limited system memory detected — frame counts will be reduced automatically.");
  }
  if (codecs && !codecs.h264) {
    warnings.push(
      "This browser cannot decode H.264. Most phone video is H.264, so you may need " +
      "Chrome or Edge rather than a codec-limited Chromium build.",
    );
  }
  if (codecs && !codecs.hevc) {
    warnings.push(
      "HEVC/H.265 decoding is unavailable. iPhones record HEVC by default — either " +
      "set Camera → Formats → Most Compatible, or convert the clips to H.264 first.",
    );
  }
  if (!m.crossOriginIsolated) {
    warnings.push(
      "The page is not cross-origin isolated, so multi-threaded WASM is unavailable " +
      "and feature extraction runs single-threaded.",
    );
  }

  return { ready: blockers.length === 0, blockers, warnings };
}

export function explainBlocker(reason: BlockingReason): { title: string; detail: string } {
  switch (reason) {
    case "no-webgpu":
      return {
        title: "WebGPU is required for local 3D reconstruction",
        detail:
          "Please use a modern desktop version of Chrome, Edge, or another browser with " +
          "WebGPU support. On Linux you may need to enable WebGPU in chrome://flags.",
      };
    case "no-webcodecs":
      return {
        title: "This browser cannot decode video locally",
        detail:
          "Reconstruction needs the WebCodecs API to turn your clips into frames without " +
          "uploading them. Chrome and Edge on desktop support it.",
      };
    case "no-offscreen-canvas":
      return {
        title: "OffscreenCanvas is unavailable",
        detail:
          "Frames are processed on background threads, which needs OffscreenCanvas. " +
          "Use a current desktop Chrome or Edge.",
      };
    case "no-opfs":
      return {
        title: "Local file storage is unavailable",
        detail:
          "Intermediate data is written to the browser's private file system so large " +
          "captures do not have to fit in memory. This browser does not provide it.",
      };
  }
}

export function formatGpuName(gpu: GpuInfo): string {
  if (!gpu.available) return "No WebGPU adapter";
  const parts = [gpu.vendor, gpu.architecture].filter(Boolean);
  const name = gpu.description || parts.join(" ") || "Unknown adapter";
  return gpu.isFallback ? `${name} (software renderer)` : name;
}
