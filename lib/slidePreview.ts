// slidePreview - a deck on the company template, drawn for the screen.
//
// The same file the download writes (lib/reviewTemplateDeck), drawn slide
// by slide (lib/slideRender), with the template's pictures and fonts.

import { renderDeck, loadDeckFonts, type DeckView } from "@/lib/slideRender";
import { deckOnTemplate, testSlides, type TemplateDeckOpts } from "@/lib/reviewTemplateDeck";
import type { SlideSpec } from "@/lib/reviewFiles";
import type { LayoutRole, TemplateInfo } from "@/lib/slideTemplate";
import type { DeckLook } from "@/lib/deckLook";

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", bmp: "image/bmp", webp: "image/webp", emf: "image/emf", wmf: "image/wmf" };
// One picture URL per picture in the template, kept for the visit.
const urls = new Map<string, string>();
const mediaUrl = (key: string) => (part: string, bytes: Uint8Array) => {
  const k = `${key}:${part}`;
  let u = urls.get(k);
  if (!u) { u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: TYPES[part.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream" })); urls.set(k, u); }
  return u;
};

export interface ScreenDeck extends DeckView {
  /** Each slide's place in the specs it was made from (null: agenda, a part's opening). */
  slideOf: Array<number | null>;
}

/** The slides as they will download, drawn for the screen. `key` names the
 *  template (its stored path) so its pictures are read once. */
export async function screenDeck(key: string, specs: SlideSpec[], o: Omit<TemplateDeckOpts, "forScreen" | "slideOf">): Promise<ScreenDeck> {
  const slideOf: Array<number | null> = [];
  const bytes = await deckOnTemplate(specs, { ...o, forScreen: true, slideOf });
  const view = await renderDeck(bytes, mediaUrl(key));
  loadDeckFonts(view.fonts);
  return { ...view, slideOf };
}

/** The test deck (each kind of slide on its layout), for Branding and setup. */
export function screenTestDeck(key: string, info: TemplateInfo, data: Uint8Array, look: DeckLook, pick?: Partial<Record<LayoutRole, string>>): Promise<ScreenDeck> {
  return screenDeck(key, testSlides(info, pick), { info, data, look, pick, title: "Test deck" });
}
