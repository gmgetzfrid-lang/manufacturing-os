// reviewTemplateDeck - the post-event review slides laid onto the
// company's own PowerPoint template (lib/slideTemplate).
//
// The same slides as always (lib/reviewFiles deckSlides), placed on the
// layouts the app picked: the cover on the cover layout, and the tables
// and text on the content layout, in the room it leaves. Sizes follow the
// template's slide size, so a wide 20 inch template reads the same as a
// standard one.

import { charWOf, fitTablePt, PIC_SIDE, PIC_STRIP, picPlace, TONE_HEX, type DeckFit, type SlidePicture, type SlideItem, type SlidePane, type SlideSpan, type SlideSpec, type SlideTag } from "@/lib/reviewFiles";
import { bodyBoxes, EMU, fitPt, layoutFor, lineCount, pictureBox, SlideDraft, templateFonts, titleBox, writeDeck, type Cell, type LayoutInfo, type LayoutRole, type Para, type Rect, type TemplateInfo } from "@/lib/slideTemplate";
import type { DeckLook } from "@/lib/deckLook";

export interface TemplateDeckOpts {
  info: TemplateInfo;
  data: ArrayBuffer | Uint8Array;
  look: DeckLook;
  pick?: Partial<Record<LayoutRole, string>>;
  title: string;
  /** For the screen: written unpacked, and `slideOf` filled with each
   *  slide's place in `specs` (null: a slide of its own, like what the review measures). */
  forScreen?: boolean;
  slideOf?: Array<number | null>;
}

/** The room for a content slide's body on a layout: its body box (or the
 *  slide under the title), lined up with the title's words (not the edge
 *  of its box), and below the slide's label when the label can't sit above
 *  the title. EMU. */
function contentRoom(info: TemplateInfo, l: LayoutInfo): { room: Rect; labelAbove: boolean } {
  const k = info.slide.w / (13.333 * EMU);
  let room = l.room ?? { x: info.slide.w * 0.06, y: info.slide.h * 0.2, w: info.slide.w * 0.88, h: info.slide.h * 0.72 };
  const tb = titleBox(l);
  if (!tb?.rect) return { room: { ...room, y: room.y + 1.15 * EMU * k, h: room.h - 1.15 * EMU * k }, labelAbove: false };
  if (Math.abs(room.x - tb.rect.x) < 0.3 * EMU * k) room = { ...room, x: room.x + 91440, w: room.w - 182880 };
  const labelAbove = tb.rect.y >= 0.42 * EMU * k;
  if (!labelAbove) room = { ...room, y: room.y + 0.38 * EMU * k, h: room.h - 0.38 * EMU * k };
  return { room, labelAbove };
}

export async function deckOnTemplate(specs: SlideSpec[], o: TemplateDeckOpts): Promise<Uint8Array> {
  const { info, look } = o;
  const k = info.slide.w / (13.333 * EMU);
  const IN = (inches: number) => inches * EMU * k;
  const PT = (design: number) => Math.round(design * k * 2) / 2;
  const content = layoutFor(info, "content", o.pick) ?? layoutFor(info, "cover", o.pick) ?? info.layouts[0];
  const cover = layoutFor(info, "cover", o.pick) ?? content;
  // Every slide carries content: no agenda slide and no part openers.
  const slides: SlideDraft[] = [];
  const font = look.font;
  const run = (text: string, pt: number, more: { b?: boolean; color?: string } = {}) => ({ text, pt, font, color: more.color ?? look.ink, b: more.b });

  const roomOf = (l: LayoutInfo): Rect => l.room ?? { x: info.slide.w * 0.06, y: info.slide.h * 0.2, w: info.slide.w * 0.88, h: info.slide.h * 0.72 };

  // One title size for every slide after the cover: the size the longest
  // of them fits its title box at.
  const ctb = titleBox(content);
  const measuresTitle = (sp: SlideSpec) => (sp.body.k === "cover" ? sp.body.tableTitle ?? "What this review measures" : sp.title);
  const contentTitles = specs.filter((sp) => sp.body.k !== "cover" || sp.body.table).map(measuresTitle);
  const titlePt = ctb?.rect && contentTitles.length
    ? Math.min(...contentTitles.map((t) => fitPt(t, ctb.rect!, Math.min(ctb.pt ?? PT(25), PT(25)), PT(14), 0.6, 1.25)))
    : PT(contentTitles.some((t) => t.length > 70) ? 21 : 25);

  /** The title in the layout's title box (or drawn, when it has none),
   *  the label above it, and the room left for the body. */
  const head = (d: SlideDraft, kicker: string, title: string): Rect => {
    const { room, labelAbove } = contentRoom(info, d.layout);
    const tb = titleBox(d.layout);
    const label = [{ runs: [run(kicker, PT(11), { b: true, color: look.kicker })] }];
    if (tb?.rect) {
      d.fill(tb, [{ runs: [{ text: title, pt: titlePt }] }]);
      if (kicker && labelAbove) d.text({ x: tb.rect.x + 91440, y: tb.rect.y - IN(0.36), w: tb.rect.w - 182880, h: IN(0.3) }, label, { anchor: "b", name: "Label" });
      else if (kicker) d.text({ x: room.x, y: room.y - IN(0.38), w: room.w, h: IN(0.3) }, label, { name: "Label" });
    } else {
      const top = room.y - IN(1.15);
      d.text({ x: room.x, y: top, w: room.w, h: IN(1.05) }, [...(kicker ? [{ ...label[0], after: 4 }] : []), { runs: [{ ...run(title, titlePt, { b: true, color: look.heading }), font: look.titleFont }] }], { name: "Title" });
    }
    return room;
  };

  const foot = (d: SlideDraft, room: Rect, text?: string): Rect => {
    if (!text) return room;
    const h = IN(0.36);
    d.text({ x: room.x, y: room.y + room.h - h, w: room.w, h }, [{ runs: [run(text, PT(10), { color: look.foot })] }], { anchor: "b", name: "Note" });
    return { ...room, h: room.h - h - IN(0.08) };
  };

  /** A table in the room, sized to fill it at the largest type that fits. */
  const table = (d: SlideDraft, R: Rect, t: { head: string[]; rows: string[][]; widths: number[] }, size?: number, tags?: Array<SlideTag | null>, span?: SlideSpan, source?: number): number => {
    const total = t.widths.reduce((a, c) => a + c, 0);
    const fs = size ?? fitTablePt(t.head, t.rows, t.widths, R.w / EMU / k, R.h / EMU / k, tags, span, charWOf(look.font));
    const pt = PT(fs), small = PT(Math.max(9, fs - 2));
    const cols = t.widths.map((c) => (c / total) * R.w);
    const pad = { x: 6 * k * 12700, y: 4 * k * 12700 };
    let band = -1;
    const bands = t.rows.map((_, ri) => (!span || (span.rows[ri] ?? 1) > 0 ? ++band : band));
    const rows: Cell[][] = [t.head.map((h) => ({ paras: [{ runs: [run(h, small, { b: true, color: look.headText })] }], fill: look.head }))];
    // Each row's least height: one line. PowerPoint grows a row to its words.
    const oneLine = (p: number) => pad.y * 2 + p * 1.2 / 72 * EMU;
    const heights = [oneLine(small)];
    t.rows.forEach((row, ri) => {
      const fill = bands[ri] % 2 ? look.band : look.bg;
      const under = !!span && (span.rows[ri] ?? 1) === 0;
      rows.push(t.head.map((_, i) => {
        const down = span && i < span.cols ? span.rows[ri] ?? 1 : 1;
        if (down === 0) return { paras: [], fill, merged: true };
        const rule = under && span && i >= span.cols ? { color: look.line, pt: 0.75 } : undefined;
        const [lead, ...more] = (row[i] ?? "").split("\n");
        const tag = i === 0 ? tags?.[ri] : null;
        let paras: Para[];
        if (i === 0 && (more.length || tag)) {
          // What it is in bold with its verdict beside it, then the fact under it.
          paras = [{ runs: [run(lead, pt, { b: true }), ...(tag ? [run(`  ${tag.text}`, small, { b: true, color: TONE_HEX[tag.tone].fg })] : [])] }, ...(more.length ? [{ runs: [run(more.join(" "), pt)] }] : [])];
        } else if (more.length) {
          const all = [lead, ...more];
          paras = all.map((x, j) => ({ runs: [run(x, i === source && j === all.length - 1 ? small : pt, { color: i === source && j === all.length - 1 ? look.soft : look.ink })], after: j < all.length - 1 ? 4 * k : 0 }));
        } else paras = [{ runs: [run(row[i] ?? "", pt, { b: i === 0 })] }];

        return { paras, fill, rowSpan: down > 1 ? down : undefined, ruleTop: rule };
      }));
      heights.push(oneLine(pt));
    });
    const used = heights.reduce((a, c) => a + c, 0);
    d.table({ x: R.x, y: R.y, w: R.w, h: used }, cols, rows, heights, pad);
    return used;
  };

  /** Pictures down the right of the room, each with what it shows under it;
   *  returns the room left for the table. */
  const side = (d: SlideDraft, R: Rect, pics: SlidePicture[] | undefined, spec: SlideSpec, fit: DeckFit): Rect => {
    const where = pics?.length ? picPlace(spec, fit) : null;
    if (!pics?.length || !where) return R;
    const n = Math.min(2, pics.length), cap = IN(0.3);
    if (where === "below") {
      const h = IN(PIC_STRIP), w = h * 4 / 3, y = R.y + R.h - h - cap;
      pics.slice(0, n).forEach((pic, i) => {
        const x = R.x + i * (w + IN(0.3));
        d.picture({ x, y, w, h }, pic);
        if (pic.caption) d.text({ x, y: y + h + IN(0.04), w, h: cap - IN(0.04) }, [{ runs: [run(pic.caption, PT(9), { color: look.soft })] }], { name: "Caption" });
      });
      return { ...R, h: y - R.y - IN(0.15) };
    }
    const gap = IN(0.25), tw = R.w * (1 - PIC_SIDE) - gap, x = R.x + tw + gap, w = R.w - tw - gap;
    const h = Math.min(w * 0.75, (R.h - (n - 1) * IN(0.2)) / n - cap);
    pics.slice(0, 2).forEach((pic, i) => {
      const y = R.y + i * (h + cap + IN(0.2));
      d.picture({ x, y, w, h }, pic);
      if (pic.caption) d.text({ x, y: y + h + IN(0.04), w, h: cap - IN(0.04) }, [{ runs: [run(pic.caption, PT(9), { color: look.soft })] }], { name: "Caption" });
    });
    return { ...R, w: tw };
  };

  const bullets = (items: SlideItem[], pt: number): Para[] => items.map((it) => {
    const x = typeof it === "string" ? { text: it } : it;
    return { runs: [run(x.text, pt, { b: !!x.bold })], bullet: !x.bold, level: x.sub ? 1 : 0, before: x.bold ? 6 * k : 0, after: 5 * k };
  });
  const pane = (d: SlideDraft, p: SlidePane, R: Rect) => {
    let y = R.y;
    if (p.title) { d.text({ x: R.x, y, w: R.w, h: IN(0.3) }, [{ runs: [run(p.title, PT(11), { b: true, color: look.kicker })] }], { name: "Label" }); y += IN(0.36); }
    const items = p.items ?? [];
    const chars = items.reduce((n, it) => n + (typeof it === "string" ? it : it.text).length, 0);
    const size = PT(chars > 620 ? 12 : chars > 420 ? 13 : !p.title ? 18 : 15);
    if (items.length) {
      const lines = items.reduce((n, it) => n + lineCount(typeof it === "string" ? it : it.text, R.w / EMU, size), 0);
      const h = p.table ? Math.min(R.h * 0.5, lines * size * 1.32 / 72 * EMU + items.length * IN(0.09)) : R.y + R.h - y;
      d.text({ x: R.x, y, w: R.w, h }, bullets(items, size), { name: "Points" });
      y += h + IN(0.1);
    }
    if (p.table) {
      if (p.table.title) { d.text({ x: R.x, y, w: R.w, h: IN(0.3) }, [{ runs: [run(p.table.title, PT(11), { b: true, color: look.kicker })] }], { name: "Label" }); y += IN(0.34); }
      table(d, { x: R.x, y, w: R.w, h: R.y + R.h - y }, p.table, 11);
    }
  };

  for (const [si, spec] of specs.entries()) {
    const b = spec.body;
    if (b.k === "cover") {
      // The cover: the title and what it covers on the cover layout.
      const d = new SlideDraft(cover);
      const tb = titleBox(cover);
      if (tb?.rect) {
        const pt = fitPt(spec.title, tb.rect, Math.min(tb.pt ?? 54, PT(36)), PT(18), 0.6, 1.25);
        d.fill(tb, [{ runs: [{ text: spec.title, pt }] }]);
        if (tb.rect.y >= IN(0.5)) d.text({ x: tb.rect.x + 91440, y: tb.rect.y - IN(0.42), w: tb.rect.w - 182880, h: IN(0.34) }, [{ runs: [run(spec.kicker, PT(14), { b: true, color: look.kicker })] }], { anchor: "b", name: "Label" });
      }
      const lines = [b.sub, b.meta].filter(Boolean);
      const body = bodyBoxes(cover)[0];
      if (lines.length && body?.rect) {
        const pt = fitPt(lines.join("\n"), body.rect, Math.min(body.pt ?? 24, PT(18)), PT(10), 0.5, 1.3);
        d.fill(body, lines.map((t, i) => ({ runs: [{ text: t, pt: i ? Math.max(PT(10), pt * 0.85) : pt }], after: i ? 0 : 4 * k })));
      } else if (lines.length) {
        const r = tb?.rect ? { x: tb.rect.x + 91440, y: tb.rect.y + tb.rect.h + IN(0.1), w: tb.rect.w, h: IN(0.9) } : roomOf(cover);
        d.text(r, lines.map((t, i) => ({ runs: [run(t, PT(i ? 13 : 16), { color: look.soft })], after: 4 * k })), { name: "Subtitle" });
      }
      if (!tb?.rect) head(d, spec.kicker, spec.title);
      // The cover's picture goes in the layout's own picture box.
      const pb = pictureBox(cover), pic = spec.pics?.[0];
      if (pb && pic) d.fillPicture(pb, pic);
      d.notes = spec.notes;
      slides.push(d); o.slideOf?.push(si);
      // What the review measures, on a slide of its own.
      if (b.table) {
        const m = new SlideDraft(content);
        const room = head(m, spec.kicker, b.tableTitle ?? "What this review measures");
        table(m, room, b.table, undefined);
        slides.push(m); o.slideOf?.push(null);
      }
      continue;
    }
    const d = new SlideDraft(content);
    let room = head(d, spec.kicker, spec.title);
    d.notes = spec.notes;
    if (b.k === "asks") {
      room = foot(d, room, b.foot);
      if (!b.items.length) d.text({ x: room.x, y: room.y, w: room.w, h: IN(0.7) }, [{ runs: [run(spec.notes, PT(20))] }], { name: "Text" });
      const big = b.items.length <= 4;
      const rowH = Math.min(IN(1.25), room.h / Math.max(1, b.items.length));
      b.items.forEach((it, i) => {
        const y = room.y + i * rowH;
        d.text({ x: room.x, y, w: IN(0.6), h: IN(0.6) }, [{ runs: [run(String(it.n), PT(big ? 26 : 22), { b: true, color: look.kicker })] }], { name: "Number" });
        d.text({ x: room.x + IN(0.65), y, w: room.w - IN(0.65), h: rowH - IN(0.05) }, [{ runs: [run(it.ask, PT(big ? 20 : 17), { b: true })] }, { runs: [run(it.because, PT(big ? 15 : 13), { color: look.soft })] }], { name: "Action" });
      });
    } else if (b.k === "table") {
      const fit: DeckFit = { w: room.w / EMU / k, h: room.h / EMU / k, footInside: true, charW: charWOf(look.font) };
      room = foot(d, room, b.foot);
      // The line above the table and the counts run the full width.
      let y = room.y;
      if (b.lead) { d.text({ x: room.x, y, w: room.w, h: IN(0.42) }, [{ runs: [run(b.lead, PT(16), { b: true, color: look.kicker })] }], { anchor: "ctr", name: "Lead" }); y += IN(0.48); }
      if (b.tally?.length) {
        d.text({ x: room.x, y, w: room.w, h: IN(0.45) }, [{ runs: b.tally.flatMap((t, i) => [run(`${i ? "     " : ""}${t.n} `, PT(20), { b: true, color: TONE_HEX[t.tone].fg }), run(t.label, PT(13), { color: look.soft })]) }], { anchor: "ctr", name: "Tally" });
        y += IN(0.55);
      }
      // Pictures level with the table: down its right, or in a strip under it.
      const tableBox = side(d, { x: room.x, y, w: room.w, h: room.y + room.h - y }, spec.pics, spec, fit);
      table(d, tableBox, b, undefined, b.tags, b.span, b.source);
    } else if (b.k === "split") {
      room = foot(d, room, b.foot);
      const lw = room.w * (b.ratio ?? 0.5) - IN(0.15);
      pane(d, b.left, { x: room.x, y: room.y, w: lw, h: room.h });
      if (b.right.title || b.right.items?.length || b.right.table) pane(d, b.right, { x: room.x + lw + IN(0.3), y: room.y, w: room.w - lw - IN(0.3), h: room.h });
    }
    slides.push(d); o.slideOf?.push(si);
  }
  return writeDeck(o.data, info, slides, o.title, { forScreen: o.forScreen });
}

/** The room under a content slide's title on this template, in inches at
 *  the standard slide size (what picPlace measures against). */
export function templateArea(info: TemplateInfo, pick?: Partial<Record<LayoutRole, string>>): DeckFit {
  const l = layoutFor(info, "content", pick) ?? layoutFor(info, "cover", pick) ?? info.layouts[0];
  const k = info.slide.w / (13.333 * EMU);
  const { room } = contentRoom(info, l);
  return { w: room.w / EMU / k, h: room.h / EMU / k, footInside: true, charW: charWOf(templateFonts(l).body) };
}
/** Whether the template's cover has a spot for a picture. */
export const coverHasPicture = (info: TemplateInfo, pick?: Partial<Record<LayoutRole, string>>) => { const c = layoutFor(info, "cover", pick); return !!(c && pictureBox(c)); };

/** A short deck that shows each kind of slide on the layout picked for it,
 *  for checking a template before a real review goes on it. */
export function testSlides(info: TemplateInfo, pick?: Partial<Record<LayoutRole, string>>): SlideSpec[] {
  const nameOf = (role: LayoutRole) => layoutFor(info, role, pick)?.name ?? "Not used";
  const parts = ["A table", "A list of actions"];
  const part = (n: number) => ({ n, of: parts.length, name: parts[n - 1] });
  return [
    { kicker: "Test deck", title: "Your template, laid out by the app", notes: "Each kind of slide the app writes, on the layout picked for it.",
      body: { k: "cover", sub: "Each kind of slide the app writes, on the layout picked for it.", meta: "Change a pick in Branding, then make this deck again.", agenda: parts, tableTitle: "Which layout each slide goes on",
        table: { head: ["Slide", "Layout", "What goes on it"], widths: [1.6, 2.2, 4.2], rows: [
          ["Cover", nameOf("cover"), "The title, what it covers, who wrote it and when"],
          ["Tables and text", nameOf("content"), "A label, the title, then tables and lists in the room left"],
        ] } } },
    { kicker: "1 · A table", part: part(1), title: "A table fills the room the layout leaves", notes: "Type sizes fit the room, never under 9 pt.",
      body: { k: "table", lead: "A line said above the table, in the template's main color.", tally: [{ n: 3, label: "met", tone: "good" }, { n: 1, label: "missed", tone: "bad" }, { n: 1, label: "no target set", tone: "warn" }],
        head: ["Measure", "Target", "Actual", "Result"], widths: [1.6, 2.4, 3.4, 1.6],
        rows: [["Duration\nThe event", "Finish Wed 3:00 PM", "Finish Fri 1:00 PM", "46 h late"], ["Planned work\nThe event", "8 activities", "8 done", "All done"], ["Added work\nPlanning", "Not set", "18 h found work", "35% more work"], ["Safety", "0 recordables", "0 recordables", "Met"], ["Quality\nExecution", "0 failed tests", "0 failed tests", "Met"]],
        tags: [{ text: "Missed", tone: "bad" }, { text: "Met", tone: "good" }, { text: "No target set", tone: "warn" }, null, null],
        foot: "A note under the table, set small." } },
    { kicker: "2 · A list of actions", part: part(2), title: "3 actions for the next event", notes: "Numbered actions, each with why.",
      body: { k: "asks", items: [
        { n: 1, ask: "Name each day's hand-offs at the shift meeting", because: "Jobs waited a shift for the next crew to get to them." },
        { n: 2, ask: "Schedule gas testing before every vessel entry", because: "A vessel was held 6 h for gas-freeing with none in the plan." },
        { n: 3, ask: "Write the reason on every job that sits", because: "Most jobs that sat a shift had no reason written." },
      ] } },
  ];
}
