"""Render synthetic "phone footage" so the pipeline can be tested without a room.

READ THIS BEFORE TRUSTING ANY RESULT IT PRODUCES.

This script exists for exactly one reason: to prove that the *code path* works —
that frames extract, that COLMAP solves poses, that five separate clips fuse into
one model, that the scene converts, and that the browser renders it. It does that
by building a virtual living room and hallway, flying five camera paths through
it that follow the same shot list the capture README prescribes, and encoding
them to H.264 exactly like a phone would.

What this DOES prove:
  · the pipeline runs end to end and produces a coherent, walkable scene
  · the multi-clip fusion logic actually fuses
  · the viewer renders and navigates the output

What this does NOT prove:
  · that YOUR phone footage will reconstruct. Real capture adds rolling shutter,
    electronic stabilisation, real motion blur, auto-exposure swings, textureless
    painted walls, and reflections. Synthetic frames have none of those, and
    every one of them is a genuine failure mode.

The renderer is a small textured rasteriser with a real z-buffer. Surfaces carry
high-frequency procedural texture because a feature-based reconstructor needs
something to match; blank walls would fail here for reasons that have nothing to
do with the pipeline being tested.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

RNG = np.random.default_rng(20260823)


def find_ffmpeg() -> str:
    """A usable ffmpeg path.

    Prefers a system install, and otherwise falls back to the static binary that
    ships inside the `imageio-ffmpeg` wheel — which is why this script needs no
    `apt install` / `brew install` step.
    """
    system = shutil.which("ffmpeg")
    if system:
        return system
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:  # pragma: no cover - only on a broken install
        raise SystemExit(
            "No ffmpeg available. Install the requirements:\n"
            "  pip install numpy opencv-python-headless imageio-ffmpeg"
        ) from exc


# ── Procedural textures ─────────────────────────────────────────────────────

def _noise(h: int, w: int, octaves: int = 5, seed: int = 0) -> np.ndarray:
    """Fractal value noise in [0,1] — cheap stand-in for real surface detail."""
    rng = np.random.default_rng(seed)
    out = np.zeros((h, w), np.float32)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        size = max(2, int(2 ** (o + 2)))
        base = rng.random((min(size, h), min(size, w))).astype(np.float32)
        layer = cv2.resize(base, (w, h), interpolation=cv2.INTER_CUBIC)
        out += layer * amp
        total += amp
        amp *= 0.55
    out /= max(total, 1e-6)
    return np.clip(out, 0, 1)


def tex_wood(h=512, w=512, seed=1) -> np.ndarray:
    """Plank flooring: strong directional grain plus plank seams."""
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    grain = _noise(h, w, 6, seed) * 0.5 + _noise(h, w, 3, seed + 99) * 0.5
    stripes = np.sin((x / w) * np.pi * 2 * 6 + grain * 9.0) * 0.12
    plank = ((y / h * 8).astype(int) % 2) * 0.05
    v = np.clip(0.52 + stripes + plank + (grain - 0.5) * 0.30, 0.12, 0.95)
    img = np.stack([v * 0.42, v * 0.62, v * 0.86], axis=2)  # BGR, warm brown
    seam = (np.abs(((y / h * 8) % 1.0) - 0.5) > 0.47)
    img[seam] *= 0.55
    return (img * 255).astype(np.uint8)


def tex_wall(h=512, w=512, seed=2, tint=(0.86, 0.87, 0.83)) -> np.ndarray:
    """Painted wall: mostly flat, faint plaster texture, occasional scuff.

    Deliberately LOW contrast — this is the surface that makes real indoor
    photogrammetry hard, and the test should not be easier than reality.
    """
    n = _noise(h, w, 5, seed)
    fine = _noise(h, w, 7, seed + 7)
    v = 0.80 + (n - 0.5) * 0.10 + (fine - 0.5) * 0.06
    img = np.stack([v * tint[0], v * tint[1], v * tint[2]], axis=2)
    for _ in range(RNG.integers(3, 7)):
        cx, cy = RNG.integers(0, w), RNG.integers(0, h)
        r = int(RNG.integers(12, 46))
        cv2.circle(img, (int(cx), int(cy)), r, (0.72, 0.73, 0.70), -1, cv2.LINE_AA)
    return (np.clip(img, 0, 1) * 255).astype(np.uint8)


def tex_fabric(h=512, w=512, seed=3, base=(0.38, 0.44, 0.52)) -> np.ndarray:
    """Upholstery: woven weave + slub. Gives the couch matchable detail."""
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    weave = (np.sin(x * 1.4) * np.sin(y * 1.4)) * 0.06
    slub = _noise(h, w, 6, seed) * 0.22
    v = 0.72 + weave + (slub - 0.11)
    img = np.stack([v * base[0], v * base[1], v * base[2]], axis=2)
    return (np.clip(img, 0, 1) * 255).astype(np.uint8)


def tex_art(h=512, w=512, seed=4) -> np.ndarray:
    """A framed picture — a strong, unique landmark for loop closure."""
    img = np.full((h, w, 3), 0.93, np.float32)
    cv2.rectangle(img, (16, 16), (w - 16, h - 16), (0.18, 0.16, 0.14), 14)
    rng = np.random.default_rng(seed)
    for _ in range(26):
        p1 = (int(rng.integers(50, w - 50)), int(rng.integers(50, h - 50)))
        p2 = (int(rng.integers(50, w - 50)), int(rng.integers(50, h - 50)))
        col = tuple(float(c) for c in rng.random(3) * 0.8 + 0.1)
        cv2.line(img, p1, p2, col, int(rng.integers(3, 14)), cv2.LINE_AA)
    for _ in range(12):
        c = (int(rng.integers(60, w - 60)), int(rng.integers(60, h - 60)))
        col = tuple(float(v) for v in rng.random(3) * 0.9)
        cv2.circle(img, c, int(rng.integers(10, 44)), col, -1, cv2.LINE_AA)
    return (np.clip(img, 0, 1) * 255).astype(np.uint8)


def tex_door(h=512, w=512, seed=5) -> np.ndarray:
    img = np.stack([_noise(h, w, 4, seed) * 0.12 + 0.62] * 3, axis=2)
    img[:, :, 0] *= 0.78
    img[:, :, 1] *= 0.86
    cv2.rectangle(img, (int(w * .16), int(h * .10)), (int(w * .84), int(h * .44)), (0.42, 0.48, 0.58), 9)
    cv2.rectangle(img, (int(w * .16), int(h * .54)), (int(w * .84), int(h * .90)), (0.42, 0.48, 0.58), 9)
    cv2.circle(img, (int(w * .90), int(h * .52)), 13, (0.55, 0.62, 0.70), -1, cv2.LINE_AA)
    return (np.clip(img, 0, 1) * 255).astype(np.uint8)


# ── Geometry ────────────────────────────────────────────────────────────────

@dataclass
class Quad:
    """A textured parallelogram: P(s,t) = origin + s*u + t*v, s,t ∈ [0,1]."""
    origin: np.ndarray
    u: np.ndarray
    v: np.ndarray
    texture: np.ndarray
    shade: float = 1.0


def _q(o, u, v, tex, shade=1.0) -> Quad:
    return Quad(np.array(o, float), np.array(u, float), np.array(v, float), tex, shade)


def build_room() -> list[Quad]:
    """A living room (6 x 7 m) opening onto a hallway (1.6 x 6 m).

    Y is up. The hallway runs off along -Z so that "walk down the hallway and
    into the living room" is a real, connected traversal.
    """
    quads: list[Quad] = []
    H = 2.6                      # ceiling height
    floor = tex_wood(512, 512, 11)

    # ── Living room shell (x: -3..3, z: 0..7) ───────────────────────────────
    quads.append(_q([-3, 0, 0], [6, 0, 0], [0, 0, 7], floor, 1.0))
    quads.append(_q([-3, H, 0], [6, 0, 0], [0, 0, 7], tex_wall(512, 512, 12, (0.95, 0.96, 0.95)), 0.86))
    quads.append(_q([-3, 0, 7], [6, 0, 0], [0, H, 0], tex_wall(512, 512, 13), 0.94))   # far wall
    quads.append(_q([-3, 0, 0], [0, 0, 7], [0, H, 0], tex_wall(512, 512, 14), 0.88))   # left wall
    quads.append(_q([3, 0, 0], [0, 0, 7], [0, H, 0], tex_wall(512, 512, 15), 0.90))    # right wall

    # Near wall, split around the hallway opening at x ∈ [-0.8, 0.8]
    quads.append(_q([-3, 0, 0], [2.2, 0, 0], [0, H, 0], tex_wall(512, 512, 16), 0.82))
    quads.append(_q([0.8, 0, 0], [2.2, 0, 0], [0, H, 0], tex_wall(512, 512, 17), 0.82))
    quads.append(_q([-0.8, 2.1, 0], [1.6, 0, 0], [0, 0.5, 0], tex_wall(512, 512, 18), 0.80))

    # ── Hallway (x: -0.8..0.8, z: -6..0) ────────────────────────────────────
    quads.append(_q([-0.8, 0, -6], [1.6, 0, 0], [0, 0, 6], tex_wood(512, 512, 19), 0.80))
    quads.append(_q([-0.8, H, -6], [1.6, 0, 0], [0, 0, 6], tex_wall(512, 512, 20, (0.93, 0.94, 0.93)), 0.72))
    quads.append(_q([-0.8, 0, -6], [0, 0, 6], [0, H, 0], tex_wall(512, 512, 21), 0.76))
    quads.append(_q([0.8, 0, -6], [0, 0, 6], [0, H, 0], tex_wall(512, 512, 22), 0.78))
    quads.append(_q([-0.8, 0, -6], [1.6, 0, 0], [0, H, 0], tex_door(512, 512, 23), 0.74))  # end door

    # Hallway landmarks — unique art gives loop closure something to latch onto.
    quads.append(_q([-0.79, 1.1, -4.4], [0, 0, 0.9], [0, 0.65, 0], tex_art(384, 384, 24), 0.95))
    quads.append(_q([0.79, 1.15, -2.6], [0, 0, -0.8], [0, 0.6, 0], tex_art(384, 384, 25), 0.95))

    # ── The couch: the primary recognisable object, at x≈0, z≈4.6 ───────────
    fab = tex_fabric(512, 512, 31)
    fab_dark = tex_fabric(512, 512, 32, (0.30, 0.35, 0.42))
    cx, cz, cw, cd, ch = 0.2, 4.6, 2.1, 0.95, 0.45
    quads.append(_q([cx - cw / 2, ch, cz - cd / 2], [cw, 0, 0], [0, 0, cd], fab, 1.0))          # seat
    quads.append(_q([cx - cw / 2, 0, cz - cd / 2], [cw, 0, 0], [0, ch, 0], fab_dark, 0.88))     # front
    quads.append(_q([cx - cw / 2, 0, cz + cd / 2], [cw, 0, 0], [0, ch, 0], fab_dark, 0.80))     # back skirt
    quads.append(_q([cx - cw / 2, ch, cz + cd / 2], [cw, 0, 0], [0, 0.55, 0], fab, 0.92))       # backrest
    quads.append(_q([cx - cw / 2, ch, cz + cd / 2 - 0.02], [cw, 0, 0], [0, 0.55, 0], fab, 0.86))
    quads.append(_q([cx - cw / 2, 0, cz - cd / 2], [0, 0, cd], [0, ch + 0.55, 0], fab_dark, 0.84))  # left arm
    quads.append(_q([cx + cw / 2, 0, cz - cd / 2], [0, 0, cd], [0, ch + 0.55, 0], fab_dark, 0.90))  # right arm

    # Cushion seams — small parallax detail that multi-view stereo can resolve.
    for i in range(3):
        sx = cx - cw / 2 + 0.12 + i * (cw - 0.24) / 3
        quads.append(_q([sx, ch + 0.005, cz - cd / 2 + 0.08],
                        [0.02, 0, 0], [0, 0, cd - 0.16], fab_dark, 0.7))

    # ── Coffee table, rug, lamp, sideboard ──────────────────────────────────
    wood2 = tex_wood(384, 384, 41)
    quads.append(_q([-0.7, 0.42, 3.0], [1.5, 0, 0], [0, 0, 0.75], wood2, 1.0))
    quads.append(_q([-0.7, 0.32, 3.0], [1.5, 0, 0], [0, 0.10, 0], wood2, 0.8))
    quads.append(_q([-0.7, 0.32, 3.75], [1.5, 0, 0], [0, 0.10, 0], wood2, 0.75))

    rug = tex_fabric(512, 512, 42, (0.55, 0.42, 0.38))
    quads.append(_q([-1.6, 0.004, 2.4], [3.2, 0, 0], [0, 0, 2.4], rug, 1.0))

    quads.append(_q([2.2, 0, 5.6], [0.6, 0, 0], [0, 1.15, 0], tex_wood(256, 256, 43), 0.9))
    quads.append(_q([2.2, 1.15, 5.6], [0.6, 0, 0], [0, 0, 0.5], tex_wood(256, 256, 44), 1.0))
    quads.append(_q([2.25, 1.15, 5.65], [0.5, 0, 0], [0, 0.45, 0], tex_fabric(256, 256, 45, (0.75, 0.78, 0.70)), 1.05))

    quads.append(_q([-2.9, 0, 5.2], [0, 0, 1.6], [0, 0.85, 0], tex_wood(384, 384, 46), 0.88))
    quads.append(_q([-2.9, 0.85, 5.2], [0.45, 0, 0], [0, 0, 1.6], tex_wood(384, 384, 47), 1.0))

    # Baseboards. Real rooms have them, and the strong horizontal line where
    # wall meets floor is one of the more reliable features indoors.
    base_tex = tex_wood(256, 256, 60)
    for o, u in (
        ([-3, 0, 6.99], [6, 0, 0]), ([-2.99, 0, 0], [0, 0, 7]), ([2.99, 0, 0], [0, 0, 7]),
        ([-3, 0, 0.01], [2.2, 0, 0]), ([0.8, 0, 0.01], [2.2, 0, 0]),
        ([-0.79, 0, -6], [0, 0, 6]), ([0.79, 0, -6], [0, 0, 6]),
    ):
        quads.append(_q(o, u, [0, 0.11, 0], base_tex, 0.72))

    # Wall art in the living room — more unique landmarks.
    quads.append(_q([-0.9, 1.35, 6.98], [1.5, 0, 0], [0, 1.0, 0], tex_art(448, 448, 48), 1.0))
    quads.append(_q([2.98, 1.3, 2.2], [0, 0, 1.1], [0, 0.8, 0], tex_art(384, 384, 49), 0.96))
    quads.append(_q([-2.98, 1.4, 1.4], [0, 0, 1.0], [0, 0.75, 0], tex_art(384, 384, 50), 0.96))

    return quads


# ── Rasteriser ──────────────────────────────────────────────────────────────

class Renderer:
    def __init__(self, quads: list[Quad], width: int, height: int, fov_deg: float = 62.0):
        self.quads = quads
        self.w, self.h = width, height
        f = (width / 2) / np.tan(np.radians(fov_deg) / 2)
        self.K = np.array([[f, 0, width / 2], [0, f, height / 2], [0, 0, 1]], float)
        self._px = None

    def _pixel_rays(self) -> np.ndarray:
        if self._px is None:
            ys, xs = np.mgrid[0:self.h, 0:self.w].astype(np.float32)
            self._px = np.stack([xs, ys, np.ones_like(xs)], axis=2)
        return self._px

    def render(self, R: np.ndarray, t: np.ndarray) -> np.ndarray:
        """R,t are world→camera. Returns a BGR uint8 image."""
        color = np.zeros((self.h, self.w, 3), np.float32)
        depth = np.full((self.h, self.w), np.inf, np.float32)

        for quad in self.quads:
            # Homography (s,t,1) → pixel, straight from the plane parameterisation.
            M = self.K @ np.stack([R @ quad.u, R @ quad.v, R @ quad.origin + t], axis=1)
            if abs(np.linalg.det(M)) < 1e-12:
                continue

            # Skip quads entirely behind the camera.
            corners = np.array([
                quad.origin, quad.origin + quad.u,
                quad.origin + quad.u + quad.v, quad.origin + quad.v,
            ])
            cam_pts = corners @ R.T + t
            if np.all(cam_pts[:, 2] < 0.05):
                continue

            th, tw = quad.texture.shape[:2]
            H = M @ np.diag([1.0 / (tw - 1), 1.0 / (th - 1), 1.0])
            try:
                warped = cv2.warpPerspective(
                    quad.texture, H, (self.w, self.h),
                    flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT,
                )
                mask = cv2.warpPerspective(
                    np.full((th, tw), 255, np.uint8), H, (self.w, self.h),
                    flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT,
                )
            except cv2.error:
                continue
            if not mask.any():
                continue

            # Per-pixel depth: invert the homography to recover (s,t), then
            # evaluate the plane point in camera space. Exact, no interpolation.
            Minv = np.linalg.inv(M)
            px = self._pixel_rays()
            st = px @ Minv.T
            wz = st[:, :, 2]
            with np.errstate(divide="ignore", invalid="ignore"):
                s = st[:, :, 0] / wz
                u = st[:, :, 1] / wz
            valid = mask.astype(bool) & np.isfinite(s) & np.isfinite(u)
            if not valid.any():
                continue

            base_c = R @ quad.origin + t
            uc, vc = R @ quad.u, R @ quad.v
            with np.errstate(invalid="ignore"):
                z = base_c[2] + s * uc[2] + u * vc[2]
                valid &= (z > 0.05)
            if not valid.any():
                continue

            closer = valid & (z < depth)
            if not closer.any():
                continue
            depth[closer] = z[closer]
            shaded = warped.astype(np.float32) * quad.shade
            color[closer] = shaded[closer]

        # Vignette + a soft ambient falloff so the image is not flat-lit.
        yy, xx = np.mgrid[0:self.h, 0:self.w].astype(np.float32)
        r = np.sqrt(((xx - self.w / 2) / (self.w / 2)) ** 2 + ((yy - self.h / 2) / (self.h / 2)) ** 2)
        color *= (1.0 - 0.16 * np.clip(r, 0, 1.4) ** 2)[:, :, None]
        return np.clip(color, 0, 255).astype(np.uint8)


# ── Camera paths (the shot list from capture/README.md) ─────────────────────

def _look_at(eye: np.ndarray, target: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    fwd = target - eye
    fwd = fwd / (np.linalg.norm(fwd) + 1e-9)
    world_up = np.array([0.0, 1.0, 0.0])
    right = np.cross(world_up, fwd)
    nr = np.linalg.norm(right)
    right = right / nr if nr > 1e-6 else np.array([1.0, 0.0, 0.0])
    down = np.cross(right, fwd)
    R = np.stack([right, down, fwd], axis=0)   # world → camera (x right, y down, z fwd)
    t = -R @ eye
    return R, t


def _smooth(points: list[list[float]], n: int) -> np.ndarray:
    """Resample a polyline to n points with a light smoothing pass."""
    p = np.array(points, float)
    seg = np.linalg.norm(np.diff(p, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    want = np.linspace(0, cum[-1], n)
    out = np.stack([np.interp(want, cum, p[:, i]) for i in range(p.shape[1])], axis=1)
    k = max(3, n // 24) | 1
    pad = np.pad(out, ((k // 2, k // 2), (0, 0)), mode="edge")
    kernel = np.ones(k) / k
    return np.stack([np.convolve(pad[:, i], kernel, mode="valid") for i in range(out.shape[1])], axis=1)


COUCH = np.array([0.2, 0.75, 4.6])

SHOTS: dict[str, dict] = {
    "video-a": {
        "label": "Living room walkthrough, approach and orbit the couch",
        "eye": [[0.0, 1.55, 1.2], [0.0, 1.55, 2.4], [-0.6, 1.52, 3.2], [-1.5, 1.5, 3.9],
                [-1.5, 1.5, 5.0], [-0.4, 1.53, 5.7], [1.0, 1.55, 5.6], [1.8, 1.5, 4.8],
                [1.7, 1.5, 3.6], [0.8, 1.52, 3.0]],
        "look": "couch", "seconds": 26,
    },
    "video-b": {
        "label": "Opposite side of the couch",
        "eye": [[2.3, 1.5, 2.0], [2.3, 1.5, 3.4], [2.0, 1.52, 4.6], [1.2, 1.55, 5.9],
                [-0.2, 1.5, 6.2], [-1.6, 1.5, 5.9], [-2.2, 1.52, 4.6], [-2.1, 1.5, 3.2]],
        "look": "couch", "seconds": 24,
    },
    "video-c": {
        "label": "Hallway into the living room, on to the couch",
        "eye": [[0.0, 1.58, -5.4], [0.0, 1.56, -4.0], [0.1, 1.55, -2.6], [-0.1, 1.57, -1.2],
                [0.0, 1.55, 0.4], [0.0, 1.55, 1.8], [0.1, 1.54, 2.9], [0.2, 1.53, 3.6]],
        "look": "forward", "seconds": 26,
    },
    "video-d": {
        "label": "Living room back down the hallway",
        "eye": [[0.4, 1.54, 3.8], [0.2, 1.55, 2.6], [0.0, 1.56, 1.2], [0.0, 1.55, -0.4],
                [-0.1, 1.57, -1.8], [0.1, 1.56, -3.2], [0.0, 1.55, -4.8]],
        "look": "forward", "seconds": 24,
    },
    # The app tells people to walk the same route twice so the clips have
    # something to fuse on. These two are that advice, rendered: the same
    # hallway-to-room traverse from either side of the corridor.
    "video-f": {
        "label": "Hallway into the room, left of centre",
        "eye": [[-0.55, 1.60, -5.2], [-0.5, 1.58, -3.8], [-0.45, 1.57, -2.4], [-0.5, 1.59, -1.0],
                [-0.4, 1.57, 0.6], [-0.35, 1.56, 2.0], [-0.3, 1.55, 3.1], [-0.2, 1.54, 3.8]],
        "look": "forward", "seconds": 24,
    },
    "video-g": {
        "label": "The same traverse, right of centre and a little lower",
        "eye": [[0.55, 1.42, -5.2], [0.5, 1.40, -3.8], [0.45, 1.41, -2.4], [0.5, 1.39, -1.0],
                [0.4, 1.41, 0.6], [0.35, 1.40, 2.0], [0.3, 1.42, 3.1], [0.2, 1.41, 3.8]],
        "look": "forward", "seconds": 24,
    },
    "video-e": {
        "label": "Couch detail pass at a lower height",
        "eye": [[-1.2, 1.15, 3.4], [-0.9, 1.10, 4.2], [-0.5, 1.05, 5.0], [0.4, 1.08, 5.3],
                [1.3, 1.12, 5.0], [1.5, 1.18, 4.1], [1.1, 1.20, 3.4], [0.2, 1.15, 3.1]],
        "look": "couch", "seconds": 22,
    },
}


def render_clip(name: str, shot: dict, renderer: Renderer, out: Path,
                fps: int, jitter: float) -> Path:
    n = int(shot["seconds"] * fps)
    eyes = _smooth(shot["eye"], n)
    rng = np.random.default_rng(abs(hash(name)) % (2 ** 31))

    frames_dir = out / f".frames-{name}"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True, exist_ok=True)

    # Handheld wobble: low-frequency sway, not white noise.
    def wobble(scale: float) -> np.ndarray:
        raw = rng.standard_normal((n, 3))
        k = max(3, fps // 2) | 1
        pad = np.pad(raw, ((k // 2, k // 2), (0, 0)), mode="edge")
        ker = np.ones(k) / k
        return np.stack([np.convolve(pad[:, i], ker, mode="valid") for i in range(3)], axis=1) * scale

    eye_wobble = wobble(jitter * 0.02)
    aim_wobble = wobble(jitter * 0.10)

    for i in range(n):
        eye = eyes[i] + eye_wobble[i]
        if shot["look"] == "couch":
            target = COUCH + aim_wobble[i] * 0.5
        else:
            ahead = eyes[min(i + max(2, fps // 3), n - 1)]
            direction = ahead - eyes[i]
            if np.linalg.norm(direction) < 1e-3:
                direction = np.array([0.0, 0.0, 1.0])
            target = eye + direction / np.linalg.norm(direction) * 3.0
            target[1] = 1.35
        target = target + aim_wobble[i] * 0.25

        R, t = _look_at(eye, target)
        img = renderer.render(R, t)

        # Sensor realism: mild grain, and occasional light motion blur so the
        # blur-rejection stage has genuine work to do.
        img = img.astype(np.float32)
        img += rng.standard_normal(img.shape) * 2.6
        if rng.random() < 0.07:
            k = int(rng.choice([3, 5]))
            img = cv2.GaussianBlur(img, (k, k), 0)
        img = np.clip(img, 0, 255).astype(np.uint8)
        cv2.imwrite(str(frames_dir / f"{i:05d}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 92])

        if (i + 1) % 60 == 0:
            print(f"    {name}: {i + 1}/{n} frames")

    dest = out / f"{name}.mp4"
    ffmpeg = find_ffmpeg()
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-framerate", str(fps), "-i", str(frames_dir / "%05d.jpg"),
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", str(dest),
    ], check=True)
    shutil.rmtree(frames_dir, ignore_errors=True)
    print(f"  ✓ {dest.name}  ({dest.stat().st_size / 1e6:.1f} MB, {n} frames)")
    return dest


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "input")
    ap.add_argument("--width", type=int, default=960)
    ap.add_argument("--height", type=int, default=540)
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--jitter", type=float, default=1.0, help="handheld wobble multiplier")
    ap.add_argument("--only", nargs="*", default=None, help="render only these clip ids")
    ap.add_argument("--scale", type=float, default=1.0, help="shorten every clip by this factor")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    print("Building the virtual room…")
    quads = build_room()
    print(f"  {len(quads)} textured surfaces")
    renderer = Renderer(quads, args.width, args.height)

    shots = SHOTS if not args.only else {k: v for k, v in SHOTS.items() if k in args.only}
    print(f"Rendering {len(shots)} clip(s) at {args.width}x{args.height} @ {args.fps}fps")
    for name, shot in shots.items():
        s = dict(shot)
        s["seconds"] = max(4, shot["seconds"] * args.scale)
        print(f"  {name}: {shot['label']}")
        render_clip(name, s, renderer, args.out, args.fps, args.jitter)

    print(f"\nSynthetic capture written to {args.out}")
    print("Load the clips in the app's Create 3D environment panel to run them.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
