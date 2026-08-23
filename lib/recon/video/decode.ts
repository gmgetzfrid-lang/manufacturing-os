// Turning a user-selected video file into frames, entirely on the user's machine.
//
// Nothing here uploads anything. The file is demuxed with mp4box.js (BSD-3) and
// decoded by the browser's own hardware video decoder through WebCodecs, which
// is the only way to get at frames quickly without shipping an ffmpeg build to
// the client.
//
// Two details that bite in practice and are handled here:
//   · phone video carries a rotation matrix in the container, not in the pixels,
//     so portrait clips decode sideways unless the matrix is applied;
//   · VideoFrames hold GPU memory and must be closed, or a 90-second clip will
//     exhaust the decoder's pool part-way through.

import * as MP4BoxNamespace from "mp4box";

import type { ClipInput } from "../types";

export interface DecodedFrame {
  timestampS: number;
  /** Greyscale at working resolution. */
  gray: Uint8Array;
  width: number;
  height: number;
  /** RGB at colour resolution (may match working resolution). */
  rgb: Uint8Array;
  colorWidth: number;
  colorHeight: number;
}

export interface DecodeOptions {
  /** Frames per second to pull out of the clip. */
  sampleFps: number;
  /** Long edge of the greyscale working image. */
  workingLongEdge: number;
  /** Long edge of the colour image. */
  colorLongEdge: number;
  maxFrames: number;
  signal?: AbortSignal;
  onProgress?: (done: number, expected: number) => void;
  /** Called for each decoded frame so the caller can stream rather than buffer. */
  onFrame: (frame: DecodedFrame) => void;
}

export interface VideoInfo {
  codec: string;
  width: number;
  height: number;
  durationS: number;
  frameCount: number;
  rotationDeg: number;
  timescale: number;
}

interface Mp4BoxModule {
  createFile(): Mp4File;
  MP4BoxBuffer?: { fromArrayBuffer(buf: ArrayBuffer, start: number): ArrayBuffer };
  DataStream: new (buf?: ArrayBuffer, off?: number, endian?: boolean) => {
    buffer: ArrayBuffer;
    endianness: boolean;
  };
  Endianness: { BIG_ENDIAN: boolean; LITTLE_ENDIAN: boolean };
}

interface Mp4Track {
  id: number;
  codec: string;
  track_width: number;
  track_height: number;
  nb_samples: number;
  timescale: number;
  duration: number;
  matrix?: Int32Array | number[];
}

interface Mp4Sample {
  cts: number;
  dts: number;
  duration: number;
  timescale: number;
  is_sync: boolean;
  data: Uint8Array;
}

interface Mp4File {
  onReady: (info: { videoTracks: Mp4Track[]; tracks: Mp4Track[] }) => void;
  onError: (e: unknown) => void;
  onSamples: (id: number, user: unknown, samples: Mp4Sample[]) => void;
  appendBuffer(buf: ArrayBuffer): void;
  flush(): void;
  start(): void;
  stop(): void;
  setExtractionOptions(id: number, user: unknown, opts: { nbSamples: number }): void;
  getTrackById(id: number): {
    mdia: { minf: { stbl: { stsd: { entries: Array<Record<string, unknown>> } } } };
  };
}

// Statically imported so the worker can be bundled as a classic script, which
// is what lets it use importScripts for the OpenCV build.
async function loadMp4Box(): Promise<Mp4BoxModule> {
  return MP4BoxNamespace as unknown as Mp4BoxModule;
}

/** Read the container's display matrix and turn it into a rotation in degrees. */
function rotationFromMatrix(matrix?: Int32Array | number[]): number {
  if (!matrix || matrix.length < 9) return 0;
  // ISOBMFF stores a 3x3 matrix with 16.16 fixed point in the first two rows.
  const a = matrix[0] / 65536;
  const b = matrix[1] / 65536;
  const angle = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  return ((angle % 360) + 360) % 360;
}

/** Demux with mp4box and report what the file contains. */
export async function probeVideo(file: File): Promise<VideoInfo> {
  const MP4Box = await loadMp4Box();
  const mp4 = MP4Box.createFile();
  const raw = await file.arrayBuffer();
  const buf = MP4Box.MP4BoxBuffer
    ? MP4Box.MP4BoxBuffer.fromArrayBuffer(raw, 0)
    : Object.assign(raw, { fileStart: 0 });

  const info = await new Promise<{ videoTracks: Mp4Track[] }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Could not read this video's structure (mp4/mov expected).")),
      20000,
    );
    mp4.onReady = (i) => { clearTimeout(timer); resolve(i); };
    mp4.onError = (e) => { clearTimeout(timer); reject(new Error(String(e))); };
    mp4.appendBuffer(buf as ArrayBuffer);
    mp4.flush();
  });

  const track = info.videoTracks?.[0];
  if (!track) throw new Error("No video track found in this file.");

  return {
    codec: track.codec,
    width: track.track_width,
    height: track.track_height,
    durationS: track.duration / track.timescale,
    frameCount: track.nb_samples,
    rotationDeg: rotationFromMatrix(track.matrix),
    timescale: track.timescale,
  };
}

/** Extract the codec-private description (avcC / hvcC) WebCodecs needs. */
function extractDescription(MP4Box: Mp4BoxModule, mp4: Mp4File, trackId: number): Uint8Array | undefined {
  const trak = mp4.getTrackById(trackId);
  const entries = trak?.mdia?.minf?.stbl?.stsd?.entries ?? [];
  for (const entry of entries) {
    const box = (entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C) as
      | { write(s: { buffer: ArrayBuffer }): void }
      | undefined;
    if (!box) continue;
    const stream = new MP4Box.DataStream(undefined, 0, MP4Box.Endianness.BIG_ENDIAN);
    box.write(stream as unknown as { buffer: ArrayBuffer });
    // Strip the 8-byte box header; WebCodecs wants the payload only.
    return new Uint8Array(stream.buffer, 8);
  }
  return undefined;
}

/**
 * Decode `file`, handing every sampled frame to `onFrame`.
 *
 * Frames are pulled at `sampleFps` rather than every frame: video is heavily
 * redundant and the reconstruction only needs enough overlap to match.
 */
export async function decodeVideo(
  clip: ClipInput,
  options: DecodeOptions,
): Promise<{ info: VideoInfo; decoded: number }> {
  if (typeof VideoDecoder === "undefined") {
    throw new Error(
      "This browser has no WebCodecs video decoder. Use a recent desktop Chrome or Edge.",
    );
  }

  const MP4Box = await loadMp4Box();
  const mp4 = MP4Box.createFile();
  const raw = await clip.file.arrayBuffer();
  const buf = MP4Box.MP4BoxBuffer
    ? MP4Box.MP4BoxBuffer.fromArrayBuffer(raw, 0)
    : Object.assign(raw, { fileStart: 0 });

  // Demux in ONE pass. mp4box only delivers samples if extraction is configured
  // from inside onReady, before flush() — configuring it after the buffer has
  // already been appended and flushed produces no onSamples callback at all, and
  // the wait then sits on its timeout with nothing to show for it.
  const demuxed = await new Promise<{ track: Mp4Track; samples: Mp4Sample[] }>((resolve, reject) => {
    const collected: Mp4Sample[] = [];
    let found: Mp4Track | null = null;
    const timer = setTimeout(
      () => reject(new Error(`${clip.name}: timed out reading the video container.`)),
      60000,
    );
    const done = () => {
      clearTimeout(timer);
      try { mp4.stop(); } catch { /* already stopped */ }
      resolve({ track: found as Mp4Track, samples: collected });
    };

    mp4.onError = (e) => { clearTimeout(timer); reject(new Error(String(e))); };
    mp4.onReady = (i) => {
      found = i.videoTracks?.[0] ?? null;
      if (!found) {
        clearTimeout(timer);
        reject(new Error(`${clip.name}: no video track found.`));
        return;
      }
      mp4.setExtractionOptions(found.id, null, { nbSamples: Math.max(1, found.nb_samples) });
      mp4.start();
    };
    mp4.onSamples = (_id, _user, batch) => {
      collected.push(...batch);
      if (found && collected.length >= found.nb_samples) done();
    };

    mp4.appendBuffer(buf as ArrayBuffer);
    mp4.flush();
    // A fully-appended file delivers everything synchronously above; if the
    // sample count never quite reaches nb_samples, take what arrived.
    if (found && collected.length > 0) done();
  });

  const track = demuxed.track;
  const samples = demuxed.samples;
  if (!track) throw new Error(`${clip.name}: no video track found.`);

  const rotationDeg = rotationFromMatrix(track.matrix);
  const videoInfo: VideoInfo = {
    codec: track.codec,
    width: track.track_width,
    height: track.track_height,
    durationS: track.duration / track.timescale,
    frameCount: track.nb_samples,
    rotationDeg,
    timescale: track.timescale,
  };

  const support = await VideoDecoder.isConfigSupported({
    codec: track.codec,
    codedWidth: track.track_width,
    codedHeight: track.track_height,
  });
  if (!support.supported) {
    throw new Error(
      `${clip.name}: this browser cannot decode ${track.codec}. ` +
      `iPhone HEVC often needs Chrome/Edge, or set Camera → Formats → Most Compatible.`,
    );
  }

  // Rotation swaps the output dimensions.
  const swap = rotationDeg === 90 || rotationDeg === 270;
  const srcW = swap ? track.track_height : track.track_width;
  const srcH = swap ? track.track_width : track.track_height;

  const workScale = Math.min(1, options.workingLongEdge / Math.max(srcW, srcH));
  const workW = Math.max(2, Math.round(srcW * workScale));
  const workH = Math.max(2, Math.round(srcH * workScale));
  const colorScale = Math.min(1, options.colorLongEdge / Math.max(srcW, srcH));
  const colorW = Math.max(2, Math.round(srcW * colorScale));
  const colorH = Math.max(2, Math.round(srcH * colorScale));

  const workCanvas = new OffscreenCanvas(workW, workH);
  const workCtx = workCanvas.getContext("2d", { willReadFrequently: true });
  const colorCanvas = new OffscreenCanvas(colorW, colorH);
  const colorCtx = colorCanvas.getContext("2d", { willReadFrequently: true });
  if (!workCtx || !colorCtx) throw new Error("Could not create a 2D drawing context.");

  const drawRotated = (
    ctx: OffscreenCanvasRenderingContext2D,
    frame: VideoFrame,
    w: number,
    h: number,
  ) => {
    ctx.save();
    switch (rotationDeg) {
      case 90: ctx.translate(w, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(frame, 0, 0, h, w); break;
      case 180: ctx.translate(w, h); ctx.rotate(Math.PI); ctx.drawImage(frame, 0, 0, w, h); break;
      case 270: ctx.translate(0, h); ctx.rotate(-Math.PI / 2); ctx.drawImage(frame, 0, 0, h, w); break;
      default: ctx.drawImage(frame, 0, 0, w, h);
    }
    ctx.restore();
  };

  const interval = 1 / Math.max(0.1, options.sampleFps);
  let nextWanted = 0;
  let kept = 0;
  const expected = Math.min(options.maxFrames, Math.ceil(videoInfo.durationS * options.sampleFps));

  const handleFrame = (frame: VideoFrame) => {
    try {
      const ts = (frame.timestamp ?? 0) / 1e6;
      // Keep one frame per sampling interval; everything else is dropped
      // immediately so the decoder's frame pool never fills up.
      if (ts + 1e-6 < nextWanted || kept >= options.maxFrames) return;
      nextWanted = ts + interval;

      drawRotated(workCtx, frame, workW, workH);
      const wData = workCtx.getImageData(0, 0, workW, workH).data;
      const gray = new Uint8Array(workW * workH);
      for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
        // Rec. 601 luma, the standard weighting for perceptual greyscale.
        gray[i] = (wData[p] * 77 + wData[p + 1] * 150 + wData[p + 2] * 29) >> 8;
      }

      let rgb: Uint8Array;
      if (colorW === workW && colorH === workH) {
        rgb = new Uint8Array(workW * workH * 3);
        for (let i = 0, p = 0; i < workW * workH; i++, p += 4) {
          rgb[i * 3] = wData[p];
          rgb[i * 3 + 1] = wData[p + 1];
          rgb[i * 3 + 2] = wData[p + 2];
        }
      } else {
        drawRotated(colorCtx, frame, colorW, colorH);
        const cData = colorCtx.getImageData(0, 0, colorW, colorH).data;
        rgb = new Uint8Array(colorW * colorH * 3);
        for (let i = 0, p = 0; i < colorW * colorH; i++, p += 4) {
          rgb[i * 3] = cData[p];
          rgb[i * 3 + 1] = cData[p + 1];
          rgb[i * 3 + 2] = cData[p + 2];
        }
      }

      kept++;
      options.onFrame({
        timestampS: ts,
        gray, width: workW, height: workH,
        rgb, colorWidth: colorW, colorHeight: colorH,
      });
      options.onProgress?.(kept, expected);
    } finally {
      frame.close();
    }
  };

  let decodeError: Error | null = null;
  const decoder = new VideoDecoder({
    output: handleFrame,
    error: (e) => { decodeError = e instanceof Error ? e : new Error(String(e)); },
  });

  decoder.configure({
    codec: track.codec,
    codedWidth: track.track_width,
    codedHeight: track.track_height,
    description: extractDescription(MP4Box, mp4, track.id),
    // Let the browser drop non-essential work; we sample sparsely anyway.
    optimizeForLatency: false,
  });

  if (samples.length === 0) throw new Error(`${clip.name}: no video samples could be read.`);

  for (const sample of samples) {
    if (options.signal?.aborted) break;
    if (decodeError) break;
    if (kept >= options.maxFrames) break;

    decoder.decode(
      new EncodedVideoChunk({
        type: sample.is_sync ? "key" : "delta",
        timestamp: (sample.cts * 1e6) / sample.timescale,
        duration: (sample.duration * 1e6) / sample.timescale,
        data: sample.data,
      }),
    );

    // Back-pressure: without this the queue grows until the tab is killed.
    if (decoder.decodeQueueSize > 24) {
      await new Promise<void>((resolve) => {
        const check = () => (decoder.decodeQueueSize <= 8 ? resolve() : setTimeout(check, 4));
        check();
      });
    }
  }

  try {
    await decoder.flush();
  } catch {
    // A flush error after we stopped feeding on purpose is expected.
  }
  decoder.close();

  if (decodeError && kept === 0) throw decodeError;
  return { info: videoInfo, decoded: kept };
}
