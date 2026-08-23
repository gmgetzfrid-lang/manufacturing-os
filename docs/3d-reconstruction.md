# Phone video → walkable 3D, in the browser

A proof of concept that answers one question:

> Can a user's own computer turn several overlapping smartphone videos into one
> convincing, browser-walkable 3D environment?

It lives inside an operating area: **Operating areas → pick an area → 3D
walkthrough**. Select clips, press *Start reconstruction*, and the browser
decodes, reconstructs and renders them. Nothing is uploaded and there is no
reconstruction server.

---

## 1. What actually happens

```
phone clips (.mp4 / .mov)
        │
        ▼  WebCodecs + mp4box            ── decode, in a Web Worker
   sampled frames                           6 fps, downscaled, rotation applied
        │
        ▼  sharpest-of-window, motion gate
   keeper frames  ────────────────────────► written to OPFS (never held in RAM)
        │
        ▼  OpenCV.js ORB
   keypoints + 32-byte descriptors
        │
        ▼  WebGPU brute-force Hamming matching
   candidate pairs: sequential (within a clip)
                  + retrieval  (ACROSS clips) ◄── this is what fuses the videos
        │
        ▼  RANSAC essential matrix
   verified pairs → union-find → feature tracks
        │
        ▼  incremental SfM: seed pair → PnP → triangulate → local BA
        ▼  global bundle adjustment (poses + points + shared focal)
   camera poses + sparse cloud
        │
        ▼  WebGPU plane-sweep multi-view stereo
   dense coloured point cloud
        │
        ▼  gravity / scale / floor / start pose derived from the reconstruction
   scene  ──────────────────────────────────► OPFS
        │
        ▼  three.js: perspective splats + eye-dome lighting
   first-person walkthrough
```

### Where the code is

| Path | Role |
| --- | --- |
| `lib/recon/config.ts` | **Every tunable and limit, in one file.** |
| `lib/recon/capabilities.ts` | WebGPU / codec / memory detection and the honest "can this machine do it" verdict |
| `lib/recon/video/decode.ts` | mp4box demux + WebCodecs decode, rotation, frame sampling |
| `lib/recon/sfm/features.ts` | ORB extraction, blur metric, global descriptor for cross-clip retrieval |
| `lib/recon/gpu/matcher.ts` | WebGPU Hamming matcher (WGSL) + CPU fallback |
| `lib/recon/math/*` | Essential matrix, triangulation, PnP, bundle adjustment — all unit-tested |
| `lib/recon/sfm/reconstruct.ts` | The incremental SfM driver |
| `lib/recon/dense/planeSweep.ts` | WebGPU plane-sweep MVS (WGSL) + voxel fusion |
| `lib/recon/scene.ts` | Gravity, metric scale, floor, start pose, quantised payload |
| `lib/recon/workers/recon.worker.ts` | Orchestrates all of the above off the main thread |
| `lib/walkthrough/viewer.ts` | three.js first-person renderer |
| `components/walkthrough/*` | The UI |

---

## 2. Technology chosen, and why

**Decoding — WebCodecs + mp4box.js.** The only way to get frames out of a
user's file at speed without shipping an ffmpeg build to the client. mp4box
demuxes; the browser's own hardware decoder does the work.

**Features — OpenCV.js (ORB).** Writing a competitive feature detector is real
work with no upside, so this uses the standard one.

Note the version pin: **4.12.x, not 5.x**. OpenCV 5 renamed the modules and
dropped AKAZE/KAZE/BRISK from the JavaScript binding whitelist. It is staged
into `public/vendor/opencv/` by `scripts/copy-opencv.mjs` rather than bundled —
it is ~10 MB and only needed once a reconstruction actually starts.

**Geometry — implemented here, in `lib/recon/math/`.** Not a preference: the
OpenCV.js binding whitelist omits `findEssentialMat`, `recoverPose`,
`triangulatePoints` and `findFundamentalMat` entirely, so two-view
initialisation is simply not available from it. What is here is the classical
textbook material (Hartley & Zisserman), and every routine is checked against
synthetic ground truth — see §6.

**Matching — WebGPU.** This is the decision that makes the whole thing
practical. OpenCV's CPU matcher costs roughly 200 ms per image pair at 2400
features; a few hundred frames need several thousand pairs, which is over
fifteen minutes of pure matching. Hamming distance over binary descriptors is
a popcount, which is exactly what a GPU is for. The WGSL kernel was verified
bit-exact against the CPU implementation before being trusted.

**Densification — WebGPU plane-sweep MVS.** Sparse points are geometrically
correct but read as television static. Plane sweep gives per-pixel depth, and
the cost volume is never materialised — each thread sweeps depths in registers
and keeps only the winner — so it fits in a browser's GPU budget. The matching
cost is ZNCC because phone cameras change exposure constantly while panning.

**Rendering — three.js.** Perspective-correct point sizing plus eye-dome
lighting, a screen-space pass that darkens depth discontinuities. EDL is what
gives a point cloud visible silhouettes and makes furniture legible as shape
rather than speckle.

### Licences

| Dependency | Licence | Commercial SaaS |
| --- | --- | --- |
| `@techstark/opencv-js` (OpenCV) | Apache-2.0 | Yes |
| `mp4box` | BSD-3-Clause | Yes |
| `three` | MIT | Yes |
| `esbuild` (build only) | MIT | Yes |
| `@webgpu/types` (types only) | BSD-3-Clause | Yes |

No GPL/AGPL, and nothing under a non-commercial research licence. Two things
were **rejected on licence grounds** during selection:

- **AlvaAR** — genuine WebAssembly SLAM, but GPL-3.0. Shipping JS to a browser
  is distribution, so it is disqualifying here.
- **DUSt3R / MASt3R and most feed-forward pose models** — CC-BY-NC. Not usable
  in a paid product. (`MapAnything` and `Depth-Anything-3 small/base` are
  Apache-2.0 and would be usable, but no public ONNX export of their *pose*
  head exists yet — see §7.)

---

## 3. Requirements

- **WebGPU** — required. Desktop Chrome or Edge. The app detects this and
  refuses with an explanation rather than failing halfway.
- **WebCodecs** with a decoder for your clips' codec. H.264 is near-universal.
  **HEVC is a real cliff**: Chromium ships no software H.265 decoder, so it
  only works where the OS provides one. iPhone users should set
  *Settings → Camera → Formats → Most Compatible* before recording. There is no
  client-side workaround — every WASM H.265 decoder is ffmpeg-derived and
  GPL/LGPL-encumbered.
- **OPFS** (Origin Private File System) for intermediate frame storage.
- A discrete or recent integrated GPU. A software renderer works and is
  detected, but is many times slower; the UI says so.

Cross-origin isolation (COOP/COEP) is **not** required — nothing here uses
SharedArrayBuffer or threaded WASM, so those headers are deliberately not set
and no other part of the app is affected.

---

## 4. Running it

```bash
npm install
npm run dev          # stages opencv.js + bundles the worker, then starts Next
```

Then: **Operating areas → an area → 3D walkthrough → Create 3D environment**.

While editing worker code, `npm run worker:watch` rebuilds
`public/workers/recon.worker.js` on change. (The worker is pre-bundled with
esbuild rather than referenced through `new URL(...)` because Turbopack does not
compile that form — it emits the raw `.ts`, which the browser cannot parse.)

### Limits

All in `lib/recon/config.ts`. Defaults: up to 10 clips, ~150 s each, 400 MB per
clip, 2 GB total, 320 frames overall. Three quality presets scale frame counts,
resolution and depth samples. `fitToMachine()` scales them down further based on
the detected GPU buffer limit, reported memory and core count.

If a capture is too large the app says so and tells the user to split the space
into smaller connected zones — it does not silently truncate.

### Test footage without filming

`tools/test-footage/make_test_capture.py` renders a synthetic living room and
hallway and flies five camera paths through it following the same shot list the
app's capture guide prescribes.

```bash
pip install numpy opencv-python-headless imageio-ffmpeg
python tools/test-footage/make_test_capture.py --out ./clips
```

**Read the caveat in that file's docstring.** Synthetic frames have no rolling
shutter, no stabilisation warp, no real motion blur and no auto-exposure swing.
It exercises the code path; it does not prove your phone's footage will work.

---

## 5. Storage and performance

- Frames go to OPFS during decode and are streamed back one at a time for
  densification. Peak JS heap stays in the low hundreds of MB regardless of clip
  length — that is what makes long captures survivable.
- A finished scene is 10 bytes per point (3 × int16 position, RGB, 1 pad), so a
  2 M point scene is ~20 MB, and it needs **zero parsing** in the viewer: the
  buffer is copied straight into a typed array.
- Scenes are saved in OPFS, namespaced per operating area.

**No processing-time estimate is shown before a run.** It depends entirely on
the machine, and the brief is explicit about not claiming timings we have not
measured. Actual elapsed time is reported when the run finishes.

---

## 6. What has been verified, and how

Run `npx vitest run lib/recon`.

| Check | Result |
| --- | --- |
| Symmetric eigendecomposition, 3×3 SVD, Rodrigues round-trip, Cholesky | exact to 6–9 dp |
| Essential matrix on noiseless data | epipolar residual < 1e-8 |
| Pose from essential, with 25% outliers | rotation error < 1°, translation direction < 2.5° |
| Degenerate pure-rotation pair | correctly rejected by triangulation angle |
| Triangulation | exact; multi-view beats two-view under noise |
| PnP with 40% outliers | rotation < 1°, translation to 0.1 |
| Bundle adjustment from a perturbed start | converges to **0.15 px RMSE** |
| Bundle adjustment with unknown focal | focal moves toward truth, fit improves |
| **Three separate clips → ONE connected model** | **1 component, all clips present, scale consistent to <12% across all camera pairs** |
| **Two genuinely disjoint clips** | **correctly reported as NOT fused** |

Verified in a real browser (Chromium + WebGPU):

- WebGPU Hamming matcher is **bit-exact** against the CPU reference (301/301
  matches, zero distance mismatches).
- Plane-sweep MVS against a textured plane at known depth: **100% pixel
  coverage, 1.6% mean depth error**.

### A real end-to-end run

Two clips through the actual worker, in a browser, start to finish — decode,
features, SfM, WebGPU densification, scene assembly:

| Stage | Time |
| --- | --- |
| Decode (2 clips, 156 frames sampled, 32 kept) | 6.6 s |
| Structure from Motion (32 frames) | 13.8 s |
| Densification (17 depth maps) | 696 s |
| Scene assembly | 0.07 s |
| **Total** | **718 s** |

Output: a 27.7k-point scene with gravity recovered from the camera track,
metric scale from the assumed camera height, and the spawn point correctly
placed at the first frame of the hallway clip.

**Read those timings in context.** This machine has no GPU — WebGPU is running
on SwiftShader, a software rasteriser — so densification, which is almost
entirely GPU work, dominates the total and would be very much faster on real
hardware. The CPU-bound stages (decode, SfM) are representative. Nothing here
is an estimate for your machine; the app measures and reports the real elapsed
time for each run.

---

## 7. Known limitations

**Honest ones, not hedges.**

0. **This has not been tested on real phone footage.** Everything verified above
   used either synthetic ground truth or rendered test clips. The code path is
   proven end to end; the *capture* is not. Rolling shutter, electronic
   stabilisation, real motion blur, auto-exposure and blank painted walls are
   all real failure modes that rendered frames do not have. Treat the first run
   on your own video as the actual experiment.

1. **Point cloud, not Gaussian splats.** Splats look markedly better. Training
   them in-browser is possible — [Brush](https://github.com/ArthurBrussee/brush)
   (Apache-2.0) is a real WASM+WebGPU 3DGS trainer — but it has no published npm
   artifact, must be built from Rust with `wasm-pack`, requires the WebGPU
   `subgroups` feature, and **has no SfM of its own**: it consumes COLMAP-format
   poses. It is the natural next step precisely because this pipeline already
   produces what it needs.
2. **Textureless surfaces reconstruct poorly.** Plain painted walls give ORB
   nothing to match and give ZNCC no signal. Expect holes on blank walls; the
   floor, furniture and anything patterned will be much denser.
3. **Scale is assumed, not measured.** Metric scale comes from assuming the
   phone was held ~1.55 m above the floor. Walking feels right; distances are
   approximate. The viewer labels this (`scaleSource: camera-height`).
4. **Bundle adjustment uses a dense Cholesky** on the reduced camera system.
   Fine to a few hundred cameras, which is why the frame cap exists; it would
   need a sparse or iterative solver to go much beyond that.
5. **Collision is a floor constraint and a bounding box**, deliberately. No
   physics, no stairs, no climbing — out of scope per the brief.
6. **Chrome/Edge desktop only**, because of WebGPU and WebCodecs.
7. **HEVC may not decode at all** (§3) — a platform limit, not a bug.
8. **Rolling shutter and electronic stabilisation are not modelled.** Both warp
   phone video in ways a pinhole camera model cannot express, and both degrade
   accuracy. Walking slowly is the mitigation.
9. **The synthetic test footage is not proof of real-world success** (§4).

### If reconstruction fails

The app reports the real failure and a specific remedy rather than a spinner.
The two failures that matter:

- **"The clips did not merge into one space."** The reconstruction split into
  disconnected groups. Almost always insufficient overlap between clips. The
  viewer shows a banner and renders only the largest group — it never presents a
  split reconstruction as a continuous room.
- **"No image pair had enough parallax."** The camera rotated instead of
  translating. Walk through the space; do not pan from one spot.
