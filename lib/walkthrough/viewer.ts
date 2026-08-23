// The walkable viewer.
//
// A reconstruction arrives as a few million coloured points. Rendered naively
// that reads as television static; the two things that turn it into a room are
// perspective-correct point sizing (so points grow as you approach a surface and
// close the gaps between them) and eye-dome lighting, a screen-space pass that
// darkens depth discontinuities. EDL is what gives a point cloud visible
// silhouettes and makes furniture legible as shape rather than speckle.
//
// Navigation is deliberately simple, per the brief: pointer-lock mouse look,
// WASD, shift to hurry, and enough constraint that the camera cannot fall
// through the floor or fly out of the room. No physics, no stairs, no climbing.

import * as THREE from "three";

import type { SceneData } from "../recon/types";

export interface ViewerOptions {
  container: HTMLElement;
  scene: SceneData;
  points: ArrayBuffer;
  onModeChange?: (mode: ViewMode) => void;
  onPointerLockChange?: (locked: boolean) => void;
  onStats?: (stats: ViewerStats) => void;
  /** Fires while a finger is steering, so the UI can draw the thumbstick. */
  onTouchNav?: (state: TouchNavState) => void;
}

export type ViewMode = "first-person" | "orbit";

export interface ViewerStats {
  fps: number;
  position: [number, number, number];
  pointCount: number;
}

// three.js only injects its output colour-space conversion into its own
// materials. These are hand-written shaders, so the encode has to be explicit —
// without it the whole cloud renders about 2.5x too dark.
const SRGB_ENCODE = /* glsl */ `
vec3 linearToSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, step(c, vec3(0.0031308)));
}
`;

const POINT_VERTEX = /* glsl */ `
uniform float uPointScale;
uniform float uSizeMultiplier;
attribute vec3 color;
attribute vec3 splatNormal;
varying vec3 vColor;
varying float vDepth;
varying vec2 vMinorDir;
varying float vSquash;
varying float vShade;

void main() {
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
  // World-constant splat size: points grow on approach and shrink with
  // distance, which is what closes the gaps between samples on a nearby wall.
  gl_PointSize = clamp(uPointScale * uSizeMultiplier / max(vDepth, 0.05), 1.0, 22.0);

  if (dot(splatNormal, splatNormal) > 0.25) {
    // A disc lying on the surface projects to an ellipse: the semi-axis across
    // the normal's screen direction keeps its length, the one along it shrinks
    // by |n . viewDir|. Carrying that to the fragment shader is what makes a
    // splat lie ON the wall instead of facing the camera like a dot.
    vec3 nView = normalize(normalMatrix * splatNormal);
    vec3 viewDir = normalize(-mv.xyz);
    vSquash = clamp(abs(dot(nView, viewDir)), 0.3, 1.0);
    vec2 mn = nView.xy;
    float mlen = length(mn);
    vMinorDir = mlen > 1e-4 ? mn / mlen : vec2(1.0, 0.0);

    // Hemisphere term: up-facing surfaces catch the sky, down-facing ones do
    // not. Without it a floor and a wall are the same flat colour, which is
    // much of why an untextured cloud reads as indistinguishable mush.
    vec3 nWorld = normalize(mat3(modelMatrix) * splatNormal);
    vShade = mix(0.62, 1.18, nWorld.y * 0.5 + 0.5);
  } else {
    vSquash = 1.0;
    vMinorDir = vec2(1.0, 0.0);
    vShade = 1.0;
  }
}
`;

const POINT_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vDepth;
varying vec2 vMinorDir;
varying float vSquash;
varying float vShade;
uniform float uOpacity;
uniform float uEncode;
uniform float uShadeAmount;

${SRGB_ENCODE}

void main() {
  // Rotate into the splat's own frame, then stretch the axis along the normal
  // so a plain unit-circle test carves out the projected ellipse.
  //
  // gl_PointCoord runs y DOWN from the top-left; vMinorDir comes from view
  // space, where y runs UP. Flipping y here puts both in the same frame —
  // without it the ellipse is mirrored on every surface whose normal has a
  // diagonal screen direction, tilting splats the wrong way across the scene.
  vec2 offset = vec2(gl_PointCoord.x - 0.5, 0.5 - gl_PointCoord.y) * 2.0;
  vec2 e = vec2(
    dot(offset, vMinorDir),
    dot(offset, vec2(-vMinorDir.y, vMinorDir.x))
  );
  e.x /= vSquash;
  if (dot(e, e) > 1.0) discard;

  vec3 shaded = vColor * mix(1.0, vShade, uShadeAmount);
  // Straight to the canvas: encode here. Into the EDL buffer: stay linear so
  // the shading multiply there happens in the right space.
  vec3 rgb = uEncode > 0.5 ? linearToSrgb(shaded) : shaded;
  gl_FragColor = vec4(rgb, uOpacity);
}
`;

// Eye-dome lighting: compare each pixel's depth against its neighbours and
// darken it in proportion to how much it stands in front of them.
const EDL_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform float uStrength;
uniform float uRadius;
uniform float uNear;
uniform float uFar;
varying vec2 vUv;

${SRGB_ENCODE}

float linearDepth(vec2 uv) {
  float z = texture2D(uDepth, uv).x;
  if (z >= 1.0) return -1.0;
  float ndc = z * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
}

void main() {
  vec4 color = texture2D(uColor, vUv);
  float centre = linearDepth(vUv);
  if (centre < 0.0) {
    gl_FragColor = vec4(linearToSrgb(color.rgb), color.a);
    return;
  }

  vec2 texel = uRadius / uResolution;
  float sum = 0.0;
  float count = 0.0;
  // Eight neighbours; more samples buy very little at this radius.
  vec2 dirs[8];
  dirs[0] = vec2( 1.0,  0.0); dirs[1] = vec2(-1.0,  0.0);
  dirs[2] = vec2( 0.0,  1.0); dirs[3] = vec2( 0.0, -1.0);
  dirs[4] = vec2( 0.7,  0.7); dirs[5] = vec2(-0.7,  0.7);
  dirs[6] = vec2( 0.7, -0.7); dirs[7] = vec2(-0.7, -0.7);

  for (int i = 0; i < 8; i++) {
    float n = linearDepth(vUv + dirs[i] * texel);
    if (n < 0.0) continue;
    sum += max(0.0, log2(centre) - log2(n));
    count += 1.0;
  }
  if (count < 1.0) {
    gl_FragColor = vec4(linearToSrgb(color.rgb), color.a);
    return;
  }

  // sum/count is a mean log2 depth ratio against the neighbours. A 10% step is
  // ordinary within a room and must stay legible; only a real silhouette edge
  // should go dark, and never to pure black.
  float shade = max(0.25, exp(-uStrength * 2.2 * (sum / count)));
  gl_FragColor = vec4(linearToSrgb(color.rgb * shade), color.a);
}
`;

const EDL_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

/**
 * Estimate the spacing between neighbouring samples without a spatial index.
 *
 * Points sit on surfaces, so cell occupancy — not volume — is the useful
 * signal: with C occupied cells of side h the sampled area is about C·h², and
 * N points spread over it sit about h·sqrt(C/N) apart. The grid starts fine and
 * coarsens until cells actually hold several points, since a grid finer than
 * the true spacing just reports its own cell size back.
 */
export function measureSpacing(
  positions: Float32Array,
  count: number,
  bounds: SceneData["navigation"]["bounds"],
): number {
  if (count < 32) return 0.05;
  const diagonal = Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
  if (!(diagonal > 0)) return 0.05;

  // A large cloud is sampled; the ratio it measures is the same either way.
  const stride = Math.max(1, Math.floor(count / 120_000));
  const sampled = Math.floor((count + stride - 1) / stride);

  const cells = new Set<number>();
  for (let attempt = 0; attempt < 6; attempt++) {
    const h = (diagonal / 256) * 2 ** attempt;
    cells.clear();
    for (let i = 0; i < count; i += stride) {
      const gx = Math.floor((positions[i * 3] - bounds.min[0]) / h);
      const gy = Math.floor((positions[i * 3 + 1] - bounds.min[1]) / h);
      const gz = Math.floor((positions[i * 3 + 2] - bounds.min[2]) / h);
      // 21 bits per axis keeps the key inside a double's exact integer range.
      cells.add((gx & 0x1fffff) * 4398046511104 + (gy & 0x1fffff) * 2097152 + (gz & 0x1fffff));
    }
    const occupancy = cells.size / sampled;
    if (occupancy < 0.7 || attempt === 5) {
      return Math.max(1e-4, h * Math.sqrt(occupancy));
    }
  }
  return 0.05;
}

export interface TouchNavState {
  stick: { originX: number; originY: number; dx: number; dy: number; range: number } | null;
  looking: boolean;
  boost: number;
}

/** Inverse of the encoder in scene.ts: two bytes back to a unit vector. */
function decodeOctahedral(nu: number, nv: number): [number, number, number] {
  let x = (nu / 255) * 2 - 1;
  let y = (nv / 255) * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const sx = x >= 0 ? 1 : -1;
    const sy = y >= 0 ? 1 : -1;
    const nx = (1 - Math.abs(y)) * sx;
    const ny = (1 - Math.abs(x)) * sy;
    x = nx; y = ny;
  }
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

interface KeyState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  fast: boolean;
}

export class WalkthroughViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private points: THREE.Points;
  private pathGroup = new THREE.Group();

  private target: THREE.WebGLRenderTarget | null = null;
  private edlScene = new THREE.Scene();
  private edlCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private edlMaterial: THREE.ShaderMaterial | null = null;

  private keys: KeyState = {
    forward: false, back: false, left: false, right: false,
    up: false, down: false, fast: false,
  };
  private yaw = 0;
  private pitch = 0;
  private velocity = new THREE.Vector3();
  private clock = new THREE.Clock();
  private raf = 0;
  private disposed = false;

  private mode: ViewMode = "first-person";
  private orbitDistance = 8;
  private orbitTarget = new THREE.Vector3();

  // Touch navigation. A phone has no pointer lock and no keyboard, so the same
  // two jobs the mouse and WASD do are split by where a finger lands: the left
  // half of the canvas is a thumbstick, the right half looks around. Tracking
  // by pointerId is what lets both happen at once.
  private touchLook: { id: number; x: number; y: number } | null = null;
  private touchStick: {
    id: number;
    /** Where the thumb landed, in client space — the frame the deltas use. */
    cx: number; cy: number;
    /** The same point relative to the canvas, which is what the UI draws in. */
    ox: number; oy: number;
    dx: number; dy: number;
  } | null = null;
  private pinch: { a: number; b: number; distance: number } | null = null;
  /** Analog move from a thumbstick, in the range -1..1. Strafe, then forward. */
  private analogMove = { x: 0, y: 0 };
  private analogBoost = 1;

  private frameTimes: number[] = [];
  private lastStatsAt = 0;

  readonly sceneData: SceneData;
  private options: ViewerOptions;

  // Tunables the UI can drive.
  private pointSizeMultiplier = 1.0;
  /** Median-ish distance between neighbouring samples, in metres. */
  private pointSpacing = 0.05;
  private edlStrength = 0.55;
  private walkSpeed: number;
  private showPaths = false;
  private floorLocked = true;

  constructor(options: ViewerOptions) {
    this.options = options;
    this.sceneData = options.scene;
    this.walkSpeed = 1.9;

    const { container } = options;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height);
    this.renderer.setClearColor(0x0b0f14, 1);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.renderer.domElement.tabIndex = 0;

    const bounds = options.scene.navigation.bounds;
    const diagonal = Math.hypot(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    );
    this.camera = new THREE.PerspectiveCamera(
      70, width / height, 0.02, Math.max(120, diagonal * 4),
    );

    this.points = this.buildPoints(options.points, options.scene);
    this.scene.add(this.points);

    this.buildPaths(options.scene);
    this.scene.add(this.pathGroup);
    this.pathGroup.visible = this.showPaths;

    this.setupEdl(width, height);
    this.resetView();

    this.attachEvents();
    this.clock.start();
    this.animate();
  }

  // ── Construction ────────────────────────────────────────────────────────

  private buildPoints(buffer: ArrayBuffer, data: SceneData): THREE.Points {
    const count = data.pointCount;
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const [minX, minY, minZ] = data.quantization.min;
    const [spanX, spanY, spanZ] = data.quantization.span;
    const sx = spanX / 65535;
    const sy = spanY / 65535;
    const sz = spanZ / 65535;

    // Format 2 packed 10 bytes per point with a pad byte; format 3 spends 12
    // and puts an octahedral normal in the last two. Scenes saved by an older
    // build are still in the browser's storage, so the stride is taken from the
    // payload rather than assumed.
    const stride = data.format >= 3 ? 12 : buffer.byteLength / Math.max(1, count) >= 12 ? 12 : 10;
    const hasNormals = stride >= 12;

    for (let i = 0; i < count; i++) {
      const b = i * stride;
      positions[i * 3] = (view.getInt16(b, true) + 32768) * sx + minX;
      positions[i * 3 + 1] = (view.getInt16(b + 2, true) + 32768) * sy + minY;
      positions[i * 3 + 2] = (view.getInt16(b + 4, true) + 32768) * sz + minZ;
      // sRGB-ish gamma so the cloud does not look washed out.
      colors[i * 3] = (bytes[b + 6] / 255) ** 2.2;
      colors[i * 3 + 1] = (bytes[b + 7] / 255) ** 2.2;
      colors[i * 3 + 2] = (bytes[b + 8] / 255) ** 2.2;

      if (hasNormals) {
        const nu = bytes[b + 9];
        const nv = bytes[b + 10];
        // 128,128 is the sentinel the encoder writes when it had no normal.
        if (nu !== 128 || nv !== 128) {
          const n = decodeOctahedral(nu, nv);
          normals[i * 3] = n[0];
          normals[i * 3 + 1] = n[1];
          normals[i * 3 + 2] = n[2];
        }
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("splatNormal", new THREE.BufferAttribute(normals, 3));
    geometry.computeBoundingSphere();

    this.pointSpacing = measureSpacing(positions, count, data.navigation.bounds);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uPointScale: { value: 1 },
        uSizeMultiplier: { value: this.pointSizeMultiplier },
        uOpacity: { value: 1 },
        uShadeAmount: { value: 1 },
        // The EDL pass does the encode when it is in play; see SRGB_ENCODE.
        uEncode: { value: 0 },
      },
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      // Opaque. The ellipse test discards outside the splat, so there is
      // nothing to blend, and blending was order-dependent — nearer splats
      // drawn after farther ones showed through them.
      transparent: false,
      depthWrite: true,
      depthTest: true,
    });

    return new THREE.Points(geometry, material);
  }

  private buildPaths(data: SceneData) {
    // Drawing where each clip walked is the clearest visual proof that separate
    // videos ended up in one coordinate frame.
    for (const clip of data.clips) {
      if (clip.path.length < 6) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(clip.path, 3));
      const material = new THREE.LineBasicMaterial({
        color: new THREE.Color(clip.color),
        transparent: true,
        opacity: 0.85,
      });
      this.pathGroup.add(new THREE.Line(geometry, material));
    }
  }

  private setupEdl(width: number, height: number) {
    const pixelRatio = this.renderer.getPixelRatio();
    const w = Math.max(1, Math.floor(width * pixelRatio));
    const h = Math.max(1, Math.floor(height * pixelRatio));

    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.type = THREE.UnsignedIntType;

    this.target = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture,
      depthBuffer: true,
    });

    this.edlMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: this.target.texture },
        uDepth: { value: depthTexture },
        uResolution: { value: new THREE.Vector2(w, h) },
        uStrength: { value: this.edlStrength },
        uRadius: { value: 1.4 },
        uNear: { value: this.camera.near },
        uFar: { value: this.camera.far },
      },
      vertexShader: EDL_VERTEX,
      fragmentShader: EDL_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.edlMaterial);
    quad.frustumCulled = false;
    this.edlScene.add(quad);
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  resetView() {
    const nav = this.sceneData.navigation;
    this.camera.position.set(
      nav.start.position[0],
      Math.max(nav.floorY + nav.eyeHeightM, nav.start.position[1]),
      nav.start.position[2],
    );
    this.yaw = nav.start.yaw;
    this.pitch = nav.start.pitch;
    this.velocity.set(0, 0, 0);
    this.applyLook();

    const b = nav.bounds;
    this.orbitTarget.set(
      (b.min[0] + b.max[0]) / 2,
      (b.min[1] + b.max[1]) / 2,
      (b.min[2] + b.max[2]) / 2,
    );
    this.orbitDistance = Math.hypot(
      b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2],
    ) * 0.6;
  }

  private applyLook() {
    const limit = Math.PI / 2 - 0.02;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
    const dir = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    this.camera.lookAt(this.camera.position.clone().add(dir));
  }

  setMode(mode: ViewMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === "first-person") {
      this.resetView();
      this.options.onModeChange?.(mode);
    } else {
      document.exitPointerLock?.();
      this.options.onModeChange?.(mode);
    }
  }

  getMode(): ViewMode {
    return this.mode;
  }

  setPointSize(multiplier: number) {
    this.pointSizeMultiplier = multiplier;
    const mat = this.points.material as THREE.ShaderMaterial;
    mat.uniforms.uSizeMultiplier.value = multiplier;
  }

  setEdlStrength(strength: number) {
    this.edlStrength = strength;
    if (this.edlMaterial) this.edlMaterial.uniforms.uStrength.value = strength;
  }

  setWalkSpeed(speed: number) {
    this.walkSpeed = speed;
  }

  setShowPaths(show: boolean) {
    this.showPaths = show;
    this.pathGroup.visible = show;
  }

  setFloorLocked(locked: boolean) {
    this.floorLocked = locked;
  }

  requestPointerLock() {
    this.renderer.domElement.requestPointerLock?.();
  }

  // ── Events ──────────────────────────────────────────────────────────────

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.setKey(e.code, true)) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (this.setKey(e.code, false)) e.preventDefault();
  };

  private setKey(code: string, pressed: boolean): boolean {
    switch (code) {
      case "KeyW": case "ArrowUp": this.keys.forward = pressed; return true;
      case "KeyS": case "ArrowDown": this.keys.back = pressed; return true;
      case "KeyA": case "ArrowLeft": this.keys.left = pressed; return true;
      case "KeyD": case "ArrowRight": this.keys.right = pressed; return true;
      case "Space": this.keys.up = pressed; return true;
      case "KeyC": this.keys.down = pressed; return true;
      case "ShiftLeft": case "ShiftRight": this.keys.fast = pressed; return true;
      default: return false;
    }
  }

  private onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== this.renderer.domElement) return;
    const sensitivity = 0.0022;
    // Screen-right should turn the view right: with +Z forward that means
    // subtracting from yaw.
    this.yaw -= e.movementX * sensitivity;
    this.pitch -= e.movementY * sensitivity;
    this.applyLook();
  };

  private onPointerLockChange = () => {
    const locked = document.pointerLockElement === this.renderer.domElement;
    if (!locked) {
      this.keys = {
        forward: false, back: false, left: false, right: false,
        up: false, down: false, fast: false,
      };
    }
    this.options.onPointerLockChange?.(locked);
  };

  private onCanvasClick = (e: MouseEvent) => {
    // A touch already steers directly, and requestPointerLock does not exist on
    // mobile — asking for it there leaves the "click to walk" prompt up forever.
    if (e.detail === 0 || this.pointerIsCoarse()) return;
    if (this.mode === "first-person") this.requestPointerLock();
  };

  /** True on touch-first devices, where pointer lock and a keyboard are absent. */
  pointerIsCoarse(): boolean {
    return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  }

  private orbitDragging = false;
  private lastPointer = { x: 0, y: 0 };

  /** Radius in px a thumbstick drag needs to reach full speed. */
  static readonly STICK_RANGE = 64;

  private onPointerDown = (e: PointerEvent) => {
    // A mouse keeps the pointer-lock path; only direct input steers by touch.
    if (e.pointerType === "mouse" && this.mode !== "orbit") return;

    if (this.mode === "orbit") {
      if (e.pointerType !== "mouse") { this.trackPinch(e, "down"); }
      this.orbitDragging = true;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.renderer.domElement.setPointerCapture(e.pointerId);
      return;
    }

    // First-person, touch or pen.
    const rect = this.renderer.domElement.getBoundingClientRect();
    const onStickSide = e.clientX - rect.left < rect.width * 0.5;
    this.trackPinch(e, "down");

    if (onStickSide && !this.touchStick) {
      this.touchStick = {
        id: e.pointerId,
        cx: e.clientX, cy: e.clientY,
        ox: e.clientX - rect.left, oy: e.clientY - rect.top,
        dx: 0, dy: 0,
      };
    } else if (!this.touchLook) {
      this.touchLook = { id: e.pointerId, x: e.clientX, y: e.clientY };
    }
    this.renderer.domElement.setPointerCapture?.(e.pointerId);
    this.options.onTouchNav?.(this.touchNavState());
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.mode === "orbit") {
      if (this.pinch && this.trackPinch(e, "move")) return;
      if (!this.orbitDragging) return;
      const dx = e.clientX - this.lastPointer.x;
      const dy = e.clientY - this.lastPointer.y;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.yaw -= dx * 0.006;
      this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch - dy * 0.006));
      return;
    }

    if (this.touchStick && e.pointerId === this.touchStick.id) {
      const range = WalkthroughViewer.STICK_RANGE;
      const dx = e.clientX - this.touchStick.cx;
      const dy = e.clientY - this.touchStick.cy;
      const length = Math.hypot(dx, dy);
      // Past the ring the stick pegs at full speed rather than the thumb
      // running off the edge of a small screen; pushing well past it runs.
      // Pinch cannot do this job in first person — walking and looking are
      // already two fingers, so a two-finger gesture is ambiguous there.
      const scale = length > range ? range / length : 1;
      this.touchStick.dx = dx * scale;
      this.touchStick.dy = dy * scale;
      this.analogMove.x = this.touchStick.dx / range;
      this.analogMove.y = -this.touchStick.dy / range;
      this.analogBoost = length > range * 1.6 ? 2.5 : 1;
      this.options.onTouchNav?.(this.touchNavState());
      return;
    }

    if (this.touchLook && e.pointerId === this.touchLook.id) {
      const sensitivity = 0.0045;
      this.yaw -= (e.clientX - this.touchLook.x) * sensitivity;
      this.pitch -= (e.clientY - this.touchLook.y) * sensitivity;
      this.touchLook.x = e.clientX;
      this.touchLook.y = e.clientY;
      this.applyLook();
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    this.trackPinch(e, "up");
    this.orbitDragging = false;
    if (this.touchStick?.id === e.pointerId) {
      this.touchStick = null;
      this.analogMove.x = 0;
      this.analogMove.y = 0;
      this.analogBoost = 1;
    }
    if (this.touchLook?.id === e.pointerId) this.touchLook = null;
    this.renderer.domElement.releasePointerCapture?.(e.pointerId);
    this.options.onTouchNav?.(this.touchNavState());
  };

  /**
   * Two fingers pinch to zoom, in orbit only. Returns true when the gesture
   * consumed the move, so a pinch does not also spin the camera.
   */
  private trackPinch(e: PointerEvent, kind: "down" | "move" | "up"): boolean {
    if (e.pointerType === "mouse") return false;
    const active = this.activeTouches;
    if (kind === "down") {
      active.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (active.size === 2) {
        const [a, b] = [...active.keys()];
        const pa = active.get(a)!, pb = active.get(b)!;
        this.pinch = { a, b, distance: Math.max(1, Math.hypot(pa.x - pb.x, pa.y - pb.y)) };
      }
      return false;
    }
    if (kind === "up") {
      active.delete(e.pointerId);
      if (this.pinch && (e.pointerId === this.pinch.a || e.pointerId === this.pinch.b)) {
        this.pinch = null;
        this.analogBoost = 1;
      }
      return false;
    }

    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!this.pinch) return false;
    const pa = active.get(this.pinch.a), pb = active.get(this.pinch.b);
    if (!pa || !pb) return false;
    const distance = Math.max(1, Math.hypot(pa.x - pb.x, pa.y - pb.y));
    const ratio = distance / this.pinch.distance;
    this.pinch.distance = distance;
    if (this.mode === "orbit") {
      this.orbitDistance = Math.max(0.6, this.orbitDistance / ratio);
    }
    return this.mode === "orbit";
  }

  private activeTouches = new Map<number, { x: number; y: number }>();

  /** What the UI needs to draw the on-screen stick. */
  private touchNavState(): TouchNavState {
    return {
      stick: this.touchStick
        ? { originX: this.touchStick.ox, originY: this.touchStick.oy,
            dx: this.touchStick.dx, dy: this.touchStick.dy,
            range: WalkthroughViewer.STICK_RANGE }
        : null,
      looking: this.touchLook !== null,
      boost: this.analogBoost,
    };
  }

  private onWheel = (e: WheelEvent) => {
    if (this.mode !== "orbit") return;
    e.preventDefault();
    this.orbitDistance = Math.max(0.6, this.orbitDistance * (1 + Math.sign(e.deltaY) * 0.12));
  };

  private onResize = () => {
    const { container } = this.options;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    const pr = this.renderer.getPixelRatio();
    const w = Math.max(1, Math.floor(width * pr));
    const h = Math.max(1, Math.floor(height * pr));
    this.target?.setSize(w, h);
    if (this.edlMaterial) this.edlMaterial.uniforms.uResolution.value.set(w, h);
  };

  private resizeObserver: ResizeObserver | null = null;

  private attachEvents() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    this.renderer.domElement.addEventListener("click", this.onCanvasClick);
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.addEventListener("pointercancel", this.onPointerUp);
    this.renderer.domElement.addEventListener("wheel", this.onWheel, { passive: false });

    // Without these a drag scrolls the page or triggers pull-to-refresh instead
    // of steering, which is most of what "I couldn't move" feels like.
    this.renderer.domElement.style.touchAction = "none";
    this.renderer.domElement.style.overscrollBehavior = "contain";
    this.renderer.domElement.style.userSelect = "none";

    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(this.options.container);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────

  private step(dt: number) {
    const nav = this.sceneData.navigation;

    if (this.mode === "orbit") {
      const x = this.orbitTarget.x + this.orbitDistance * Math.sin(this.yaw) * Math.cos(this.pitch);
      const y = this.orbitTarget.y + this.orbitDistance * Math.sin(this.pitch);
      const z = this.orbitTarget.z + this.orbitDistance * Math.cos(this.yaw) * Math.cos(this.pitch);
      this.camera.position.set(x, y, z);
      this.camera.lookAt(this.orbitTarget);
      return;
    }

    const speed = this.walkSpeed * (this.keys.fast ? 3.0 : 1.0) * this.analogBoost;
    const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const right = new THREE.Vector3(forward.z, 0, -forward.x);

    const wish = new THREE.Vector3();
    if (this.keys.forward) wish.add(forward);
    if (this.keys.back) wish.sub(forward);
    if (this.keys.right) wish.add(right);
    if (this.keys.left) wish.sub(right);
    // Keys are all-or-nothing; a thumbstick is not, so it scales the wish
    // vector by how far the thumb has moved instead of normalising it away.
    const analog = Math.hypot(this.analogMove.x, this.analogMove.y);
    if (analog > 0.06) {
      wish.addScaledVector(forward, this.analogMove.y);
      wish.addScaledVector(right, this.analogMove.x);
      const throttle = Math.min(1, analog);
      if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed * throttle);
    } else if (wish.lengthSq() > 0) {
      wish.normalize().multiplyScalar(speed);
    }

    // Critically-damped-ish smoothing so movement starts and stops softly
    // instead of snapping, which reads as much less jarring in a point cloud.
    const blend = 1 - Math.exp(-dt * 12);
    this.velocity.x += (wish.x - this.velocity.x) * blend;
    this.velocity.z += (wish.z - this.velocity.z) * blend;

    this.camera.position.x += this.velocity.x * dt;
    this.camera.position.z += this.velocity.z * dt;

    // Vertical: either pinned to eye height above the floor, or free-fly.
    if (this.floorLocked) {
      const targetY = nav.floorY + nav.eyeHeightM;
      this.camera.position.y += (targetY - this.camera.position.y) * (1 - Math.exp(-dt * 8));
    } else {
      const vertical = (this.keys.up ? 1 : 0) - (this.keys.down ? 1 : 0);
      this.camera.position.y += vertical * speed * dt;
    }

    // Keep the camera inside the reconstructed volume. This is the whole of the
    // "collision" system, on purpose — the brief asks for a floor constraint,
    // not game physics.
    const b = nav.bounds;
    this.camera.position.x = Math.max(b.min[0], Math.min(b.max[0], this.camera.position.x));
    this.camera.position.z = Math.max(b.min[2], Math.min(b.max[2], this.camera.position.z));
    this.camera.position.y = Math.max(
      nav.floorY + 0.15, Math.min(b.max[1] + 1.0, this.camera.position.y),
    );

    this.applyLook();
  }

  private animate = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.animate);

    // Guard against a long tab stall teleporting the camera, but keep the cap
    // loose enough that a slow machine still walks at the right speed.
    const dt = Math.min(0.25, this.clock.getDelta());
    this.step(dt);

    // Point size is expressed in world units, so it depends on viewport height
    // and vertical field of view.
    const mat = this.points.material as THREE.ShaderMaterial;
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    const pr = this.renderer.getPixelRatio();
    // gl_PointSize is a pixel diameter, so this is the focal length in pixels
    // times the splat's world diameter. Sizing that diameter slightly above the
    // measured sample spacing is what makes a wall read as a surface instead of
    // a spray of dots — a fixed constant only ever suits one scene.
    const focalPx = (size.y * pr) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    mat.uniforms.uPointScale.value = focalPx * this.pointSpacing * 1.3;

    // Without the EDL pass the points go straight to the canvas, so they have
    // to do their own sRGB encode.
    mat.uniforms.uEncode.value = this.target && this.edlMaterial ? 0 : 1;

    if (this.target && this.edlMaterial) {
      this.edlMaterial.uniforms.uNear.value = this.camera.near;
      this.edlMaterial.uniforms.uFar.value = this.camera.far;
      this.renderer.setRenderTarget(this.target);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.edlScene, this.edlCamera);
    } else {
      this.renderer.render(this.scene, this.camera);
    }

    // FPS over a short rolling window.
    const now = performance.now();
    this.frameTimes.push(now);
    while (this.frameTimes.length > 60) this.frameTimes.shift();
    if (now - this.lastStatsAt > 400 && this.frameTimes.length > 4) {
      this.lastStatsAt = now;
      const span = (this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0]) / 1000;
      this.options.onStats?.({
        fps: span > 0 ? (this.frameTimes.length - 1) / span : 0,
        position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
        pointCount: this.sceneData.pointCount,
      });
    }
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    this.renderer.domElement.removeEventListener("click", this.onCanvasClick);
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.removeEventListener("pointercancel", this.onPointerUp);
    this.renderer.domElement.removeEventListener("wheel", this.onWheel);
    this.resizeObserver?.disconnect();

    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    for (const child of this.pathGroup.children) {
      const line = child as THREE.Line;
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.target?.dispose();
    this.edlMaterial?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
