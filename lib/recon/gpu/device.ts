// One WebGPU device, shared by the matcher and the densifier.
//
// Requesting an adapter per stage is a good way to end up with two devices, two
// sets of buffers, and a tab that runs out of GPU memory half-way through. This
// module owns the device and hands it out.

export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  /** Largest single storage buffer binding — sizes every batching decision. */
  maxStorageBytes: number;
  maxBufferBytes: number;
  isFallback: boolean;
  label: string;
}

let contextPromise: Promise<GpuContext> | null = null;

export class GpuUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GpuUnavailableError";
  }
}

export async function getGpuContext(): Promise<GpuContext> {
  if (contextPromise) return contextPromise;

  contextPromise = (async () => {
    if (typeof navigator === "undefined" || !navigator.gpu) {
      throw new GpuUnavailableError(
        "WebGPU is required for local 3D reconstruction. Please use a modern desktop " +
        "version of Chrome, Edge, or another browser with WebGPU support.",
      );
    }

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
      throw new GpuUnavailableError(
        "No WebGPU adapter was available. On Linux you may need to enable WebGPU in " +
        "chrome://flags, and on laptops make sure the browser can reach the GPU.",
      );
    }

    // Ask for the largest buffers the adapter will give us — reconstruction is
    // buffer-bound, and the defaults (128 MB) are conservative.
    const wanted: Record<string, number> = {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
      maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
      maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
    };

    let device: GPUDevice;
    try {
      device = await adapter.requestDevice({ requiredLimits: wanted });
    } catch {
      // Some drivers reject the exact adapter limits; fall back to defaults
      // rather than failing the whole run.
      device = await adapter.requestDevice();
    }

    device.lost.then((info) => {
      // A lost device invalidates every cached pipeline, so drop the context and
      // let the next call rebuild it.
      console.warn("[recon] WebGPU device lost:", info.message);
      contextPromise = null;
    });

    const info = adapter.info;
    const label = [info?.vendor, info?.architecture, info?.description]
      .filter(Boolean).join(" ") || "WebGPU adapter";
    const isFallback = /swiftshader|lavapipe|llvmpipe|software|warp/i.test(label);

    return {
      adapter,
      device,
      maxStorageBytes: device.limits.maxStorageBufferBindingSize,
      maxBufferBytes: device.limits.maxBufferSize,
      isFallback,
      label,
    };
  })();

  try {
    return await contextPromise;
  } catch (err) {
    contextPromise = null;
    throw err;
  }
}

/** Create a storage buffer already filled with `data`. */
export function createStorageBuffer(
  device: GPUDevice, data: ArrayBufferView, extraUsage: GPUBufferUsageFlags = 0,
): GPUBuffer {
  const buffer = device.createBuffer({
    size: Math.max(4, Math.ceil(data.byteLength / 4) * 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | extraUsage,
  });
  device.queue.writeBuffer(buffer, 0, data as unknown as BufferSource);
  return buffer;
}

/** Copy a GPU buffer back to the CPU. */
export async function readBuffer(
  device: GPUDevice, source: GPUBuffer, byteLength: number,
): Promise<ArrayBuffer> {
  const staging = device.createBuffer({
    size: byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, staging, 0, byteLength);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const copy = staging.getMappedRange().slice(0);
  staging.unmap();
  staging.destroy();
  return copy;
}
