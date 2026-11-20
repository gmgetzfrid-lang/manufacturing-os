// lib/brandColors.ts
//
// The app decides where color goes, the workspace decides which color.
//
// Like a plant control screen, everything is calm grey; color is used only
// where it means something:
//   signal  the workspace's brand color: what you can do (buttons, links,
//           the current tab and menu item, focus)
//   status  red / amber / green: late, waiting, done (fixed, never brand)
//
// A logo or a picked color only supplies the hue. The app sets the
// lightness and strength (OKLCH), so any logo gives a button color that
// reads with white text, a link color that reads on white, and a soft tint
// for "you are here". Grey, black, and near-white logo colors are skipped;
// yellow is moved toward amber so it can carry white text.

export type Rgb = [number, number, number];

export const isHex = (s: unknown): s is string => typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]: Rgb): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
const toLin = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const fromLin = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** OKLCH: lightness 0..1, chroma 0..~0.37, hue in degrees. */
export function toOklch(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map(toLin) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(A, B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return [L, C, H];
}

function oklchToLinear(L: number, C: number, H: number): Rgb {
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLCH to hex, lowering chroma until the color fits on screen. */
export function fromOklch(L: number, C: number, H: number): string {
  let c = C;
  for (let i = 0; i < 40; i++) {
    const lin = oklchToLinear(L, c, H);
    if (lin.every((v) => v >= -0.0005 && v <= 1.0005)) return rgbToHex(lin.map((v) => fromLin(Math.min(1, Math.max(0, v)))) as Rgb);
    c *= 0.93;
  }
  return rgbToHex(oklchToLinear(L, 0, H).map((v) => fromLin(Math.min(1, Math.max(0, v)))) as Rgb);
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(toLin) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a), y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** The default signal color when nothing is set: process blue. */
export const DEFAULT_SIGNAL = "#1f5bd6";

const hueGap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

/** Usable as a brand color: has real color (not grey, black or white). */
export function isColorful(hex: string): boolean {
  const [L, C] = toOklch(hex);
  return C >= 0.045 && L > 0.18 && L < 0.97;
}

/** The hue and strength the app will use for a color. Yellow-green to
 *  yellow (which can't carry white text) is moved toward amber. */
function signalHue(hex: string): { h: number; c: number } {
  const [, C, H] = toOklch(hex);
  let h = H;
  if (h >= 75 && h < 112) h = 62; // yellow → amber
  return { h, c: Math.min(0.21, Math.max(0.17, C * 1.2)) };
}

export interface SignalScale {
  /** "You are here" tint: menu item, selected rows. */
  50: string; 100: string; 200: string; 300: string; 400: string;
  500: string;
  /** Buttons (white text). */
  600: string;
  /** Hover; links on white. */
  700: string; 800: string; 900: string;
}

/** A full scale from one color, with steps the app controls. */
export function signalScale(hex: string): SignalScale {
  const src = isHex(hex) && isColorful(hex) ? hex : DEFAULT_SIGNAL;
  const { h, c } = signalHue(src);
  const step = (L: number, k: number) => fromOklch(L, c * k, h);
  // Button: as light as possible while white text still reads (4.5:1).
  let L600 = 0.54;
  let b600 = step(L600, 1);
  while (contrast(b600, "#ffffff") < 4.6 && L600 > 0.3) { L600 -= 0.01; b600 = step(L600, 1); }
  let L700 = Math.min(L600 - 0.07, 0.5);
  let b700 = step(L700, 1);
  while (contrast(b700, "#ffffff") < 6 && L700 > 0.25) { L700 -= 0.01; b700 = step(L700, 1); }
  return {
    50: step(0.975, 0.14), 100: step(0.95, 0.28), 200: step(0.9, 0.45), 300: step(0.82, 0.7), 400: step(0.72, 0.9),
    500: step(0.64, 1), 600: b600, 700: b700, 800: step(L700 - 0.07, 0.85), 900: step(L700 - 0.14, 0.7),
  };
}

/** From a logo's colors (most prominent first): the best brand color, and
 *  a second hue for charts if the logo has one. */
export function signalFromLogo(colors: string[]): { signal: string; second: string | null; usable: string[] } | null {
  const usable = colors.filter(isHex).filter(isColorful);
  if (!usable.length) return null;
  // Prefer the most prominent color that can carry white text without
  // changing its hue (not yellow).
  const notYellow = usable.filter((c) => { const h = toOklch(c)[2]; return !(h >= 75 && h < 112); });
  const signal = (notYellow[0] ?? usable[0]);
  const h0 = toOklch(signal)[2];
  const second = usable.filter((c) => c !== signal).sort((a, b) => hueGap(toOklch(b)[2], h0) - hueGap(toOklch(a)[2], h0))[0] ?? null;
  return { signal, second: second && hueGap(toOklch(second)[2], h0) >= 40 ? second : null, usable };
}

/** A logo color as a chart color: same hue, a steady lightness. */
export function chartColor(hex: string): string {
  const { h, c } = signalHue(hex);
  return fromOklch(0.62, c, h);
}
