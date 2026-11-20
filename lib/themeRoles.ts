// lib/themeRoles.ts
//
// A workspace's colors in three roles, the way the color video lays it out:
//   base    covers a big area: the side menu (charcoal, midnight, or white)
//   main    covers a big area: the band every page's answer sits on
//   action  the third color, kept small so it stands out: only on what you
//           tap (the one main button per screen, links)
// The pair (base + main) sets the mood; the action color is the surprise.
//
// Palettes chosen in the picker, built from a logo, or saved by an older
// version of the app all come through rolesOf(), which also makes sure the
// result stays readable (white text on the band, a clear action color).

export interface PaletteLike {
  id?: string;
  name?: string;
  /** The main color (page band). Older palettes used it as the button color. */
  primary: string;
  secondary?: string;
  /** Side menu color. */
  base?: string;
  /** The action color (buttons, links). Present on palettes saved by this version. */
  accent?: string;
}

export interface ThemeRoles { base: string; main: string; action: string }

export const DEFAULT_ROLES: ThemeRoles = { base: "#11141a", main: "#1c3fbd", action: "#ea580c" };
const OLD_DEFAULT_PRIMARY = "#ea580c";

// ── color math ───────────────────────────────────────────────────
export const isHex = (s: unknown): s is string => typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);
function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b);
  return toHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}
export function luminance(hex: string): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = rgb(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function hsl(hex: string): [number, number, number] {
  const [r0, g0, b0] = rgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r0, g0, b0), min = Math.min(r0, g0, b0);
  const l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r0) h = ((g0 - b0) / d) % 6; else if (max === g0) h = (b0 - r0) / d + 2; else h = (r0 - g0) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, s, l];
}
function fromHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return toHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}
function hueGap(a: string, b: string): number {
  const d = Math.abs(hsl(a)[0] - hsl(b)[0]);
  return Math.min(d, 360 - d);
}
/** Text color that reads on a fill: white or ink. */
export function onColor(fill: string): string {
  return contrast(fill, "#ffffff") >= contrast(fill, "#0b1220") ? "#ffffff" : "#0b1220";
}
/** Text on a button filled with the action color: white, as in the
 *  reference (white on tangerine), unless the fill is too light for it
 *  (yellow, lime), then ink. */
export function buttonText(fill: string): string {
  return contrast(fill, "#ffffff") >= 3 ? "#ffffff" : "#0b1220";
}
/** A color across the wheel from `hex`, strong enough to be a button. */
export function complement(hex: string): string {
  const [h] = hsl(hex);
  return fromHsl((h + 165) % 360, 0.85, 0.48);
}
/** Darken until white text reads on it (4.5:1). */
function readableUnderWhite(hex: string): string {
  let c = hex;
  for (let i = 0; i < 12 && contrast(c, "#ffffff") < 4.5; i++) c = mix(c, "#000000", 0.1);
  return c;
}

// ── roles ───────────────────────────────────────────────────────
/** The three roles for any palette, made readable. */
export function rolesOf(p: PaletteLike | null | undefined): ThemeRoles {
  if (!p || !isHex(p.primary)) return DEFAULT_ROLES;
  let base: string, main: string, action: string;
  if (isHex(p.accent)) {
    base = isHex(p.base) ? p.base : DEFAULT_ROLES.base;
    main = p.primary;
    action = p.accent;
  } else if (p.id === "industrial" || p.primary.toLowerCase() === OLD_DEFAULT_PRIMARY) {
    // Saved by an older version with the old default (orange buttons).
    return DEFAULT_ROLES;
  } else {
    // Older palette: its main color becomes the band; its second color is
    // the action color when it stands apart, otherwise its opposite.
    base = DEFAULT_ROLES.base;
    main = p.primary;
    action = isHex(p.secondary) && hueGap(p.secondary, p.primary) >= 60 ? p.secondary : complement(p.primary);
  }
  main = readableUnderWhite(main);
  // The action color must stand apart from the band, or it's no surprise.
  if (hueGap(action, main) < 40 && Math.abs(luminance(action) - luminance(main)) < 0.15) action = complement(main);
  return { base, main, action };
}

/** The action color as text (links, small labels): darkened on light pages,
 *  lightened on dark ones, until it reads (4.5:1). Yellow buttons stay
 *  yellow; yellow links turn a readable gold. */
export function actionText(mode: "light" | "dark", action: string): string {
  const bg = mode === "dark" ? "#111827" : "#f4f3f0";
  const toward = mode === "dark" ? "#ffffff" : "#000000";
  let c = action;
  for (let i = 0; i < 14 && contrast(c, bg) < 4.5; i++) c = mix(c, toward, 0.1);
  return c;
}

/** The band in dark mode: a shade deeper. */
export function bandFor(mode: "light" | "dark", main: string): string {
  return mode === "dark" ? mix(main, "#000000", 0.25) : main;
}

/** Colors for the side menu from its base color (dark or light). */
export function sideTokens(base: string) {
  const dark = luminance(base) < 0.35;
  return dark
    ? { bg: base, surface: mix(base, "#ffffff", 0.07), text: "#f3f4f6", muted: mix("#ffffff", base, 0.35), faint: mix("#ffffff", base, 0.55), border: mix(base, "#ffffff", 0.1), borderStrong: mix(base, "#ffffff", 0.18) }
    : { bg: base, surface: mix(base, "#000000", 0.05), text: "#0b1220", muted: "#4b5563", faint: "#6b7280", border: mix(base, "#000000", 0.09), borderStrong: mix(base, "#000000", 0.16) };
}

/** Three roles suggested from a logo's colors (most prominent first). */
export function rolesFromLogo(colors: string[]): ThemeRoles | null {
  const cs = colors.filter(isHex);
  if (!cs.length) return null;
  const main = cs[0];
  // The action color: the logo color furthest round the wheel from the main
  // one, if the logo has one; otherwise the main color's opposite.
  const far = cs.slice(1).sort((a, b) => hueGap(b, main) - hueGap(a, main))[0];
  const action = far && hueGap(far, main) >= 60 ? far : complement(main);
  // The base: a deep shade of the main color, so the pair belongs together.
  const base = mix(main, "#05070b", 0.86);
  return rolesOf({ primary: main, accent: action, base });
}
