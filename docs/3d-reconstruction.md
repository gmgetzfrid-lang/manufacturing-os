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
                             (up to 5 seeds tried; a seed that scores well can
                              still yield a model nothing grows from)
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

### Gaussian-splatting options, audited

Splatting is the representation that would make a scene look photographic
rather than like a cloud of discs, so the candidates were checked properly. The
trap in this area is real: the original INRIA 3D Gaussian Splatting
implementation is under a **non-commercial research licence**, and many
public repos either vendor it, hand-port its kernels, or carry no licence at
all. A permissive LICENSE at the top level does not settle the question.

| Project | Licence | Trains, or only views | Usable here |
| --- | --- | --- | --- |
| **Brush** (`ArthurBrussee/brush`) | **Apache-2.0**, all 23 crates | **Trains**, and has a `brush-js` WASM target | **Yes** — the one viable trainer |
| `gsplat.js` (Hugging Face) | MIT | Views only — no optimiser | Viewer only |
| `WebSplatter` | permissive | Views only | Viewer only |
| `WebDGS` | **none at all** | Trains, browser-native WebGPU + WGSL | **No** |
| `splat-local` | MIT wrapper | Wraps Brush + COLMAP as native binaries | Not in a browser |
| `colmap-openmvs-app` | MIT wrapper over **AGPL-3.0 OpenMVS** | Neither — runs COLMAP in Docker | No |
| `SegmentAnythingin3D`, `3d_gaussian_sam` | non-commercial | Segmentation, not reconstruction | No |

**WebDGS deserves a note**, because it is technically the closest fit and it is
still unusable. It is a genuine from-scratch browser-native WebGPU splat
*trainer* in TypeScript and WGSL — no Rust, no WASM, no Python — which is
exactly the shape this app wants. But it carries **no licence file in any
commit**, which under default copyright means all rights reserved: public
visibility on GitHub grants nothing. An issue asking for a licence is open and
unanswered. It also hand-ports covariance code from INRIA's rasteriser. Neither
problem is ours to fix, so it cannot be used — though it does prove the
approach is feasible in a browser without a Rust toolchain.

**Brush is the one that works**, and the encouraging part is what it needs as
input: camera poses and a sparse cloud in COLMAP format, which is structurally
what this pipeline's SfM already produces. Adopting it is a serialisation job
plus a Rust-to-WASM build step, not new geometry. It is not an `npm install` —
there is no published package, so it has to be built from source with
`wasm-pack`, and it wants the WebGPU `subgroups` feature.

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
hallway and flies seven camera paths through it following the same shot list the
app's capture guide prescribes.

Two of those paths (`video-f`, `video-g`) exist specifically to test multi-clip
fusion: they walk the same hallway-to-room route from either side of the
corridor, which is exactly the "walk the same route twice" advice the capture
guide gives. Clips that traverse the same space in *opposite* directions — as
`video-c` and `video-d` do — look at opposite walls and share almost nothing to
match on, which is a property of the capture, not a pipeline failure.

```bash
pip install numpy opencv-python-headless imageio-ffmpeg
python tools/test-footage/make_test_capture.py --out ./clips
# One shot at a time, e.g. just the overlapping pair:
python tools/test-footage/make_test_capture.py --out ./clips --only video-f video-g
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

Run `npx vitest run lib/recon lib/walkthrough`.

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
| Scene export file round-trip, incl. non-ASCII labels | byte-identical payload |
| Export rejects a foreign file and a future version | rejected, not misread |
| Point-spacing estimator against known 5/10/20 cm grids | within 2× at every scale |
| Octahedral normal round-trip over the whole sphere | worst case < 2° |
| Plane-fit normals against exactly rendered planes | < 1.5°, including a 75° grazing floor |
| Flying pixels at a depth cliff | removed; > 90% of a clean plane kept |
| Fusion drops voxels whose views disagree on colour | dropped, and not resurrected by the fallback |
| Oriented splat footprint orientation | elongates across the normal, mirrored version fails |
| fitToMachine on a phone with unreportable memory | scaled down, not handed desktop limits |
| vercel.json ignore command, run against real branch names | master builds, others skip |

Verified in a real browser (Chromium + WebGPU):

- WebGPU Hamming matcher is **bit-exact** against the CPU reference (301/301
  matches, zero distance mismatches).
- Plane-sweep MVS against a textured plane at known depth: **100% pixel
  coverage, 1.6% mean depth error**.

### A real end-to-end run

Two clips through the actual worker, in a browser, start to finish — decode,
features, SfM, WebGPU densification, scene assembly. The clips are `video-f`
and `video-g`: the same hallway-to-room route walked from either side of the
corridor, which is the overlap the capture guide asks for.

| Stage | Time |
| --- | --- |
| Decode (2 clips, 288 frames sampled, 73 kept) | 16.0 s |
| Structure from Motion (73 frames) | 141 s |
| Densification (22 depth maps) | 551 s |
| Scene assembly | 0.27 s |
| **Total** | **709 s** |

What came out:

| | |
| --- | --- |
| Frames registered | **73 of 73** — every frame of both clips |
| Clips merged | **2 of 2, one connected component** |
| Cross-clip verified pairs | **78** |
| Reprojection RMSE | **0.84 px** |
| Sparse / dense points | 5,248 / 83,322 |
| Recovered focal length | 945 px (rendered at 960 px wide) |
| Scene extent | 18.4 × 5.9 × 8.3 m |

Gravity came from the camera track, metric scale from the assumed camera
height, and the spawn point landed at the hallway end of the capture.

### The viewer, on that scene

The same scene loaded into `WalkthroughViewer` in a browser, driven by
synthesised `keydown`/`keyup` events so the real movement code runs rather than
the camera being teleported:

| Check | Result |
| --- | --- |
| 83,318 points decoded and rendered | mounted, drew every frame |
| W / A / S / D | moved 1.0–2.2 m per press, in the right direction each time |
| Floor lock | eye height held at 1.65 m through every move |
| Sample spacing measured from the cloud | 9.5 cm, used to size splats |

The reconstruction reads as what it is from the orbit view: a corridor with a
flat floor plane and walls, with both camera paths lying along it — which is
what "the two clips fused" looks like.

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

1. **Point cloud, not Gaussian splats.** This is the honest ceiling on how good
   it can look. From outside, the cloud reads as surfaces; from inside, close
   up, it is still overlapping discs rather than a photograph, and no amount of
   tuning changes that — it is the representation, not the parameters.
   [Brush](https://github.com/ArthurBrussee/brush) (Apache-2.0) is the audited
   way out; see the licence table in §2 for why it is the only candidate that
   survives scrutiny, and what adopting it costs.
2. **Textureless surfaces reconstruct poorly, and this is the dominant failure
   mode.** Plain painted walls give ORB nothing to match and ZNCC no signal.
   Measured on the synthetic capture: the clip that dollies down a textured
   hallway registers 36 of 36 frames, while the one that orbits a flat, plain
   couch registers 4 of 44 — same code, same settings, same room. Expect holes
   on blank walls, and expect a pass that fills the frame with one untextured
   object to contribute almost nothing. Industrial areas are usually far busier
   than a living room, which should work in your favour.
3. **Point spacing is around 3 cm at the default preset**, down from 10.5 cm.
   Fusion voxels are still sized as a fraction of the scene, so a longer capture
   gets coarser samples. Close up you can still make out individual splats — it
   is a point cloud, not a mesh. The `high` preset sweeps at a larger resolution
   and uses more reference views, at a correspondingly larger time cost.
4. **Some stereo mismatches still survive.** Fusion now requires contributing
   views to agree on colour as well as position, which removes the saturated
   confetti a purely geometric test let through, and a plane fit per depth map
   removes samples floating between foreground and background. What remains is
   a mismatch that is both geometrically and photometrically consistent — rarer,
   and much harder to distinguish from a real surface.
5. **Scale is assumed, not measured.** Metric scale comes from assuming the
   phone was held ~1.55 m above the floor. Walking feels right; distances are
   approximate. The viewer labels this (`scaleSource: camera-height`).
6. **Bundle adjustment uses a dense Cholesky** on the reduced camera system.
   Fine to a few hundred cameras, which is why the frame cap exists; it would
   need a sparse or iterative solver to go much beyond that.
7. **Collision is a floor constraint and a bounding box**, deliberately. No
   physics, no stairs, no climbing — out of scope per the brief.
8. **Reconstruction needs WebGPU and WebCodecs**, which in practice means
   Chrome or Edge, or a recent iOS. The viewer is plain WebGL and works far more
   widely, so a scene built on a desktop can be walked on a phone that could not
   have built it. Where reconstruction is unavailable the app says what is true
   of that device rather than telling someone holding a phone to install
   desktop Chrome.
9. **HEVC may not decode at all** (§3) — a platform limit, not a bug.
10. **Rolling shutter and electronic stabilisation are not modelled.** Both warp
   phone video in ways a pinhole camera model cannot express, and both degrade
   accuracy. Walking slowly is the mitigation.
11. **The synthetic test footage is not proof of real-world success** (§4).

### If reconstruction fails

The app reports the real failure and a specific remedy rather than a spinner.
The two failures that matter:

- **"The clips did not merge into one space."** The reconstruction split into
  disconnected groups. Almost always insufficient overlap between clips. The
  viewer shows a banner and renders only the largest group — it never presents a
  split reconstruction as a continuous room.
- **"No image pair had enough parallax."** The camera rotated instead of
  translating. Walk through the space; do not pan from one spot.

---

## 8. Using it on a phone

The viewer works on touch devices. Reconstruction may not — see limitation 8.

| Gesture | Action |
| --- | --- |
| Drag, left half of the canvas | Walk. The thumbstick jumps to where your thumb lands, and rests in the bottom-left corner so it can be found before it is used. |
| Push the stick past its ring | Run |
| Drag, right half | Look |
| Pinch (orbit mode) | Zoom |

Pointer lock and WASD are desktop-only concepts, so on a coarse pointer the
viewer swaps to touch handling and the on-screen legend changes with it. Both
gestures are tracked by `pointerId`, so walking and looking work at the same
time — which is also why pinch cannot mean "run" in first person: two fingers
already mean something there.

**Reconstructing on the phone itself is the hard part, not viewing.** A phone
that can run it gets a reduced workload — fewer frames, a smaller depth sweep,
fewer reference views and a lower point cap — because a phone GPU thermally
throttles long before a long sweep finishes, and the result has to be drawn on
the same device. The viewer applies its own budget on top, thinning by stride
rather than truncating, so a scene built on a workstation still opens.

If a phone drops the WebGL context — which iOS does routinely on backgrounding
— the viewer says the graphics are paused and resumes when the context returns,
rather than showing a permanently black canvas.
