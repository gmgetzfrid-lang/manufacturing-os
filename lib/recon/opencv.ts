// Loading OpenCV.js inside a worker.
//
// OpenCV supplies the pieces that are genuinely hard to reimplement well — the
// ORB/AKAZE detectors and solvePnPRansac — while the two-view geometry and
// bundle adjustment live in lib/recon/math because the JavaScript build does
// not expose findEssentialMat, recoverPose or triangulatePoints at all.
//
// The build is served from /public (see scripts/copy-opencv.mjs) rather than
// bundled: it is ~10 MB, and a route chunk should not carry that.

export interface OpenCvKeyPoint {
  pt: { x: number; y: number };
  size: number;
  angle: number;
  response: number;
  octave: number;
  class_id: number;
}

export interface OpenCvMat {
  rows: number;
  cols: number;
  data: Uint8Array;
  data32F: Float32Array;
  data64F: Float64Array;
  delete(): void;
  type(): number;
  isDeleted?(): boolean;
}

export interface OpenCvVector<T> {
  size(): number;
  get(i: number): T;
  push_back(v: T): void;
  delete(): void;
}

/** Only the surface this project actually uses. */
export interface OpenCv {
  Mat: new (rows?: number, cols?: number, type?: number) => OpenCvMat;
  matFromArray(rows: number, cols: number, type: number, data: number[] | Float64Array): OpenCvMat;
  ORB: new (
    nfeatures?: number, scaleFactor?: number, nlevels?: number, edgeThreshold?: number,
    firstLevel?: number, WTA_K?: number, scoreType?: number, patchSize?: number,
    fastThreshold?: number,
  ) => {
    detectAndCompute(
      image: OpenCvMat, mask: OpenCvMat,
      keypoints: OpenCvVector<OpenCvKeyPoint>, descriptors: OpenCvMat,
    ): void;
    delete(): void;
  };
  AKAZE?: new () => {
    detectAndCompute(
      image: OpenCvMat, mask: OpenCvMat,
      keypoints: OpenCvVector<OpenCvKeyPoint>, descriptors: OpenCvMat,
    ): void;
    delete(): void;
  };
  KeyPointVector: new () => OpenCvVector<OpenCvKeyPoint>;
  Point2fVector: new () => OpenCvVector<{ x: number; y: number }>;
  Point3fVector: new () => OpenCvVector<{ x: number; y: number; z: number }>;
  solvePnPRansac(
    objectPoints: OpenCvMat, imagePoints: OpenCvMat, cameraMatrix: OpenCvMat,
    distCoeffs: OpenCvMat, rvec: OpenCvMat, tvec: OpenCvMat,
    useExtrinsicGuess?: boolean, iterationsCount?: number, reprojectionError?: number,
    confidence?: number, inliers?: OpenCvMat, flags?: number,
  ): boolean;
  solvePnPRefineLM(
    objectPoints: OpenCvMat, imagePoints: OpenCvMat, cameraMatrix: OpenCvMat,
    distCoeffs: OpenCvMat, rvec: OpenCvMat, tvec: OpenCvMat,
  ): void;
  Rodrigues(src: OpenCvMat, dst: OpenCvMat): void;
  Laplacian(src: OpenCvMat, dst: OpenCvMat, ddepth: number): void;
  meanStdDev(src: OpenCvMat, mean: OpenCvMat, stddev: OpenCvMat): void;
  CV_8U: number;
  CV_8UC1: number;
  CV_32F: number;
  CV_32FC1: number;
  CV_32FC2: number;
  CV_32FC3: number;
  CV_64F: number;
  CV_64FC1: number;
  CV_64FC2: number;
  CV_64FC3: number;
  SOLVEPNP_ITERATIVE: number;
  SOLVEPNP_EPNP: number;
  SOLVEPNP_SQPNP?: number;
  ORB_HARRIS_SCORE: number;
  getBuildInformation(): string;
}

declare global {
  var cv: unknown;
}

let loadPromise: Promise<OpenCv> | null = null;

/** Path the copy script writes to. Overridable for tests. */
export const OPENCV_URL = "/vendor/opencv/opencv.js";

export type OpenCvLogger = (message: string) => void;

/** Poll the global `cv` until the WASM bindings appear. */
function waitForRuntime(onLog: OpenCvLogger, timeoutMs = 120000): Promise<void> {
  const scope = globalThis as unknown as { cv?: Partial<OpenCv> & { onRuntimeInitialized?: () => void } };
  const ready = () => !!(scope.cv?.Mat && scope.cv?.ORB);

  if (ready()) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let ticks = 0;
    onLog("opencv: waiting for the WASM runtime");
    const poll = setInterval(() => {
      ticks++;
      if (ready()) {
        clearInterval(poll);
        resolve();
        return;
      }
      if (ticks % 100 === 0) onLog(`opencv: still initialising (${(ticks * 50) / 1000}s)`);
      if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error("OpenCV.js did not finish initialising in time."));
      }
    }, 50);
  });
}

export async function loadOpenCv(
  url: string = OPENCV_URL,
  onLog: OpenCvLogger = () => {},
): Promise<OpenCv> {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const scope = globalThis as unknown as {
      cv?: unknown;
      importScripts?: (...urls: string[]) => void;
    };

    // Two ways in. importScripts is *defined* in a module worker but throws
    // when called ("Module scripts don't support importScripts()"), so the
    // presence check is not enough — try it and fall through on failure.
    let loaded = false;
    if (scope.importScripts) {
      const t0 = Date.now();
      try {
        scope.importScripts(url);
        loaded = true;
        onLog(`opencv: importScripts ok in ${Date.now() - t0}ms`);
      } catch (err) {
        loaded = false;
        onLog(`opencv: importScripts unavailable (${String(err).slice(0, 80)})`);
      }
    }

    if (!loaded) {
      // Module worker: fetch the UMD bundle and evaluate it in its own scope.
      // Deliberately not a bundled import — that would put 10 MB of WASM into
      // the route chunk.
      let source: string;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        source = await res.text();
      } catch (err) {
        throw new Error(
          `Could not fetch OpenCV.js from ${url}. Run \`npm run dev\` so it is copied into ` +
          `public/vendor/opencv. Original error: ${String(err)}`,
        );
      }
      try {
        onLog(`opencv: evaluating ${Math.round(source.length / 1048576)}MB bundle`);
        // The bundle assigns a local `cv`; hand it back rather than relying on
        // it reaching globalThis, which it will not do under strict mode.
        const factory = new Function(`${source}\n;return typeof cv !== "undefined" ? cv : undefined;`);
        scope.cv = factory();
      } catch (err) {
        throw new Error(`OpenCV.js failed to evaluate: ${String(err)}`);
      }
    }

    if (!scope.cv) throw new Error("OpenCV.js loaded but did not define `cv`.");

    // Waiting for the WASM runtime is fiddlier than the docs suggest. The object
    // exposes a `then`, so it looks awaitable — but that is emscripten's
    // one-shot thenable, not a Promise (its `.then()` returns something with no
    // `.catch`), and awaiting it never resolves inside a worker.
    //
    // So poll instead, and re-read the global each tick rather than holding a
    // reference: emscripten may hand back a different object than the one the
    // module first published. A single interval with its own deadline keeps the
    // whole wait to one timer.
    await waitForRuntime(onLog);
    const cv = scope.cv as OpenCv & { then?: unknown };

    // Emscripten leaves a `then` on the Module, which makes the whole object
    // THENABLE. Any promise that tries to resolve with it therefore calls
    // `cv.then(resolve, reject)` and waits for a callback that fires only once,
    // during init — so `return cv` from an async function, or `await cv`, hangs
    // forever with no error. Removing the property is the standard defusal and
    // has to happen before this value crosses any promise boundary.
    if (typeof cv.then === "function") {
      delete cv.then;
      onLog("opencv: removed the module's thenable trap");
    }

    onLog("opencv: runtime ready");
    if (!cv.ORB || !cv.solvePnPRansac) {
      throw new Error(
        "This OpenCV.js build is missing ORB or solvePnPRansac — reconstruction cannot run. " +
        "Expected @techstark/opencv-js 4.12.x.",
      );
    }
    return cv;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null;
    throw err;
  }
}

/** Run `fn`, deleting every registered Mat afterwards even if it throws.
 *  OpenCV.js objects live in WASM memory and are not garbage collected. */
export function withScope<T>(fn: (track: <M extends { delete(): void }>(m: M) => M) => T): T {
  const owned: Array<{ delete(): void }> = [];
  const track = <M extends { delete(): void }>(m: M): M => {
    owned.push(m);
    return m;
  };
  try {
    return fn(track);
  } finally {
    for (let i = owned.length - 1; i >= 0; i--) {
      try { owned[i].delete(); } catch { /* already released */ }
    }
  }
}
