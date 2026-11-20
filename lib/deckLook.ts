// deckLook - the colors and fonts the review slides and report are set in.
//
// Without a template: the workspace's own three colors, the same roles as
// on screen. The deep color carries the table heads, the main color the
// headings and labels, the accent one small mark that draws the eye.
// With a template: the template's own colors and fonts.
//
// Status colors (missed, met, no target) keep their meaning everywhere and
// are not taken from the brand.

import { accentFor, contrast, deepFor, mix, signalScale } from "@/lib/brandColors";
import type { SlideTemplateRef } from "@/lib/slideTemplate";

export interface DeckLook {
  /** Slide background. */
  bg: string;
  /** Body text. */
  ink: string;
  /** Slide titles. */
  heading: string;
  /** Small labels above titles, and lines said above a table. */
  kicker: string;
  /** Table heads, and their text. */
  head: string; headText: string;
  /** Every other group of rows. */
  band: string;
  /** Thin rules. */
  line: string;
  /** Quieter text, and footnotes. */
  soft: string; foot: string;
  /** The one small mark per slide that draws the eye. */
  accent: string;
  font: string; titleFont: string;
}

const h = (x: string) => x.replace("#", "").toUpperCase();

/** The workspace's colors as slide colors. */
export function lookFromPalette(p: { primary: string; secondary: string; deep?: string }): DeckLook {
  const sc = signalScale(p.primary);
  const acc = accentFor(p.primary, p.secondary);
  return {
    bg: "FFFFFF", ink: "1F2733", heading: h(sc[900]), kicker: h(sc[700]),
    head: h(deepFor(p.deep ?? p.primary, "light")), headText: "FFFFFF",
    band: h(sc[50]), line: h(sc[200]), soft: "4F5B6B", foot: "677283",
    accent: h(acc.fill), font: "Arial", titleFont: "Arial",
  };
}

/** A template's colors and fonts as slide colors. */
export function lookFromTemplate(t: Pick<SlideTemplateRef, "colors" | "fonts">): DeckLook {
  const main = `#${t.colors.main}`;
  const readable = contrast(main, "#ffffff") >= 4.5;
  const dark = readable ? main : mix(main, "#000000", 0.45);
  return {
    bg: "FFFFFF", ink: "1F2733", heading: h(dark), kicker: h(dark),
    head: h(dark), headText: "FFFFFF",
    band: h(mix(main, "#ffffff", 0.92)), line: h(mix(main, "#ffffff", 0.7)), soft: "4F5B6B", foot: "677283",
    accent: t.colors.accent.toUpperCase(), font: t.fonts.body, titleFont: t.fonts.title,
  };
}
