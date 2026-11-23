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

// ── The pair and the accent ──────────────────────────────────────
// Two main colors set the mood and cover the big areas: the DEEP shade of
// the brand (side menu) and the brand at full strength (the header band,
// plus links, tabs, the current menu item, progress). The ACCENT is the
// surprise, kept small so it draws the eye: the one main button per screen.

/** The deep shade of the brand: a big, quiet, dark area. */
export function deepFor(hex: string, mode: "light" | "dark" = "light"): string {
  const sc = signalScale(hex);
  const [, c, h] = toOklch(sc[600]);
  return fromOklch(mode === "dark" ? 0.19 : 0.245, Math.min(0.085, c * 0.45), h);
}

export interface AccentColor { fill: string; hover: string; fg: string; text: string }

/** True when the accent is its own color: it has color and stands apart
 *  from the brand by hue. Otherwise the accent is the brand's opposite. */
export function accentUsesOwn(primary: string, secondary?: string | null): secondary is string {
  if (!secondary || !isHex(secondary) || !isColorful(secondary)) return false;
  return hueGap(toOklch(secondary)[2], toOklch(signalScale(primary)[600])[2]) >= 50;
}

/** The accent: the logo's second color when it stands apart from the
 *  brand, otherwise the brand's opposite on the color wheel. Tuned to be
 *  bright enough to pop and still carry its text (white, or graphite on
 *  light colors like gold). */
export function accentFor(primary: string, secondary?: string | null): AccentColor {
  const sc = signalScale(primary);
  const h0 = toOklch(sc[600])[2];
  let h: number;
  let c: number;
  if (accentUsesOwn(primary, secondary)) {
    [, c, h] = toOklch(secondary);
  } else {
    h = (h0 + 165) % 360;
    c = 0.19;
  }
  c = Math.min(0.2, Math.max(0.15, c));
  const yellow = h >= 75 && h < 112;
  const L = yellow ? 0.8 : h >= 112 && h < 200 ? 0.6 : 0.66;
  const fill = fromOklch(L, c, h);
  const hover = fromOklch(L - 0.06, c, h);
  const fg = contrast(fill, "#ffffff") >= 3 ? "#ffffff" : "#1f2733";
  // The accent as text on white (rarely used): dark enough to read.
  let tl = Math.min(L, 0.5), text = fromOklch(tl, c, h);
  while (contrast(text, "#ffffff") < 4.5 && tl > 0.25) { tl -= 0.02; text = fromOklch(tl, c, h); }
  return { fill, hover, fg, text };
}

// ── Three colors from a logo ─────────────────────────────────────
// A logo gives a few colors; the app offers ways to place them on the
// three roles: the side menu (deep), the header band and links (main),
// and the one main button (accent). Each suggestion holds the colors as
// picked; the app still sets every lightness, as above.

/** The colors for the three roles, as picked (the app tunes them). */
export interface Triplet { deep: string; main: string; accent: string }

/** What the app paints for a triplet: side menu, header band, main button. */
export function paintTriplet(t: Triplet): Triplet {
  return { deep: deepFor(t.deep), main: signalScale(t.main)[600], accent: accentFor(t.main, t.accent).fill };
}

function labGap(x: string, y: string): number {
  const [l1, c1, h1] = toOklch(x), [l2, c2, h2] = toOklch(y);
  const r = Math.PI / 180;
  return Math.hypot(l1 - l2, c1 * Math.cos(h1 * r) - c2 * Math.cos(h2 * r), c1 * Math.sin(h1 * r) - c2 * Math.sin(h2 * r));
}

/** How far apart two triplets look once painted (0 means the same). */
export function tripletGap(a: Triplet, b: Triplet): number {
  const pa = paintTriplet(a), pb = paintTriplet(b);
  return labGap(pa.deep, pb.deep) + labGap(pa.main, pb.main) + labGap(pa.accent, pb.accent);
}

const isYellowHue = (h: number) => h >= 75 && h < 112;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Ways to use a logo's colors (most prominent first), best first. Logo
 *  colors go on all three roles where they fit; the side menu can also be
 *  the main color's own deep shade, and the button the main's opposite.
 *  Each is scored for readability (white text on the band and the side
 *  menu), for a button that stands apart from the main color, and for
 *  staying true to the logo. Near-duplicates (once painted) are dropped.
 *  A logo with only black, white or grey gives none. */
export function logoTriplets(colors: string[]): Triplet[] {
  const usable: string[] = [];
  for (const c of colors) if (isHex(c) && isColorful(c) && !usable.some((u) => labGap(u, c) < 0.03)) usable.push(c.toLowerCase());
  const logo = usable.slice(0, 6);
  if (!logo.length) return [];
  const prom = (i: number) => 1 - i / logo.length;
  const scored: { t: Triplet; score: number }[] = [];

  const add = (mi: number, deepHex: string, di: number, accentHex: string, ai: number, bonus = 0) => {
    const main = logo[mi];
    const t: Triplet = { deep: deepHex, main, accent: accentHex };
    const p = paintTriplet(t);
    // Readability first: white text on the band, the side menu and (or
    // graphite on) the button.
    const acc = accentFor(main, accentHex);
    if (contrast(p.main, "#ffffff") < 4.5 || contrast(p.deep, "#ffffff") < 7 || contrast(acc.fill, acc.fg) < 3) return;
    const [mL, , mH0] = toOklch(main);
    const [m6L, , mH] = toOklch(p.main);
    let s = 0;
    // Main: the logo's most prominent color, kept close to how it looks.
    s += 1.2 * prom(mi) - 1.5 * Math.abs(mL - m6L);
    if (isYellowHue(mH0)) s -= 1.5; // yellow turns brown on a white-text band
    // Side menu: a dark logo color, in the main color's family.
    const [dL, , dH] = toOklch(deepHex);
    s += 0.8 * clamp01((0.7 - dL) / 0.45) + 0.5 * (1 - Math.min(hueGap(dH, mH), 90) / 90);
    if (di !== mi) s += 0.3 * prom(di);
    if (isYellowHue(dH)) s -= 1;
    // Button: stands apart from the main color by hue; the logo's own
    // color beats a made-up one.
    const aH = toOklch(p.accent)[2];
    s += Math.min(hueGap(aH, mH), 150) / 150;
    if (ai >= 0) s += 0.6;
    if (hueGap(aH, toOklch(p.deep)[2]) < 30) s -= 0.3;
    // Using more of the logo reads as more on brand.
    s += 0.25 * (new Set([mi, di, ai].filter((i) => i >= 0)).size - 1);
    scored.push({ t, score: s + bonus });
  };

  logo.forEach((main, mi) => {
    const mH = toOklch(signalScale(main)[600])[2];
    const deeps = logo.map((hex, i) => ({ hex, i }));
    for (const d of deeps) {
      for (let ai = 0; ai < logo.length; ai++) {
        if (ai === mi || ai === d.i || hueGap(toOklch(logo[ai])[2], mH) < 50) continue;
        add(mi, d.hex, d.i, logo[ai], ai);
      }
      add(mi, d.hex, d.i, accentFor(main, main).fill, -1); // the main's opposite
    }
  });

  const pick = (list: { t: Triplet; score: number }[]) => {
    const out: Triplet[] = [];
    for (const { t } of [...list].sort((a, b) => b.score - a.score)) {
      if (out.length >= 8) break;
      if (!out.some((o) => tripletGap(o, t) < 0.06)) out.push(t);
    }
    return out;
  };
  let out = pick(scored);
  // Few colors (one, or all the same family): more buttons around the
  // opposite of the best main color, so there is still a choice.
  if (out.length < 4) {
    const best = out[0];
    const mi = logo.indexOf(best.main);
    const h0 = toOklch(signalScale(best.main)[600])[2];
    [135, 195, 120, 240, 90, 270].forEach((off, k) => {
      const seed = fromOklch(0.66, 0.19, (h0 + off) % 360);
      add(mi, best.deep, logo.indexOf(best.deep), accentFor(best.main, seed).fill, -1, -0.01 * (k + 1) - 5);
    });
    out = pick(scored);
  }
  return out;
}

/** Greys with a breath of the brand hue (about 4%), so the page feels like
 *  one family without reading as blue (or green, or red). `borderControl`
 *  is the resting edge of a field: 3:1 against the page and the sheet, so a
 *  field can be found (WCAG 1.4.11). */
export function tintedNeutrals(hex: string, mode: "light" | "dark") {
  const sc = signalScale(hex);
  const h = toOklch(sc[600])[2];
  if (mode === "dark") {
    return {
      canvas: fromOklch(0.2, 0.01, h), surface: fromOklch(0.235, 0.012, h), surface2: fromOklch(0.27, 0.014, h),
      border: fromOklch(0.31, 0.014, h), borderStrong: fromOklch(0.38, 0.016, h), borderControl: fromOklch(0.58, 0.018, h),
    };
  }
  return {
    canvas: fromOklch(0.968, 0.008, h), surface: "#ffffff", surface2: fromOklch(0.975, 0.009, h),
    border: fromOklch(0.915, 0.009, h), borderStrong: fromOklch(0.86, 0.012, h), borderControl: fromOklch(0.64, 0.016, h),
  };
}
