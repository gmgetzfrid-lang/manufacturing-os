// reviewTemplateDeck - the post-event review slides laid onto the
// company's own PowerPoint template (lib/slideTemplate).
//
// The same slides as always (lib/reviewFiles deckSlides), placed on the
// layouts the app picked: the cover on the cover layout, the agenda on the
// agenda layout, each part opened on the section layout, and the tables
// and text on the content layout, in the room it leaves. Sizes follow the
// template's slide size, so a wide 20 inch template reads the same as a
// standard one.

import { fitTablePt, TONE_HEX, type SlideItem, type SlidePane, type SlideSpan, type SlideSpec, type SlideTag } from "@/lib/reviewFiles";
import { bodyBoxes, EMU, fitPt, layoutFor, lineCount, SlideDraft, titleBox, writeDeck, type Cell, type LayoutInfo, type LayoutRole, type Para, type Rect, type TemplateInfo } from "@/lib/slideTemplate";
import type { DeckLook } from "@/lib/deckLook";

export interface TemplateDeckOpts {
  info: TemplateInfo;
  data: ArrayBuffer | Uint8Array;
  look: DeckLook;
  pick?: Partial<Record<LayoutRole, string>>;
  title: string;
  /** For the screen: written unpacked, and `slideOf` filled with each
   *  slide's place in `specs` (null: an agenda or a part's opening slide). */
  forScreen?: boolean;
  slideOf?: Array<number | null>;
}

export async function deckOnTemplate(specs: SlideSpec[], o: TemplateDeckOpts): Promise<Uint8Array> {
  const { info, look } = o;
  const k = info.slide.w / (13.333 * EMU);
  const IN = (inches: number) => inches * EMU * k;
  const PT = (design: number) => Math.round(design * k * 2) / 2;
  const content = layoutFor(info, "content", o.pick) ?? layoutFor(info, "cover", o.pick) ?? info.layouts[0];
  const cover = layoutFor(info, "cover", o.pick) ?? content;
  const agenda = layoutFor(info, "agenda", o.pick);
  const section = layoutFor(info, "section", o.pick);
  const slides: SlideDraft[] = [];
  const font = look.font;
  const run = (text: string, pt: number, more: { b?: boolean; color?: string } = {}) => ({ text, pt, font, color: more.color ?? look.ink, b: more.b });

  const roomOf = (l: LayoutInfo): Rect => l.room ?? { x: info.slide.w * 0.06, y: info.slide.h * 0.2, w: info.slide.w * 0.88, h: info.slide.h * 0.72 };

  /** The title in the layout's title box (or drawn, when it has none),
   *  the label above it, and the room left for the body. */
  const head = (d: SlideDraft, kicker: string, title: string, maxPt: number): Rect => {
    let room = { ...roomOf(d.layout) };
    const tb = titleBox(d.layout);
    if (tb?.rect) {
      const pt = fitPt(title, tb.rect, Math.min(tb.pt ?? maxPt, maxPt), PT(14), 0.6, 1.25);
      d.fill(tb, [{ runs: [{ text: title, pt }] }]);
      if (kicker) {
        const above = tb.rect.y;
        if (above >= IN(0.42)) d.text({ x: tb.rect.x + 91440, y: tb.rect.y - IN(0.36), w: tb.rect.w - 182880, h: IN(0.3) }, [{ runs: [run(kicker, PT(11), { b: true, color: look.kicker })] }], { anchor: "b", name: "Label" });
        else { d.text({ x: room.x, y: room.y, w: room.w, h: IN(0.3) }, [{ runs: [run(kicker, PT(11), { b: true, color: look.kicker })] }], { name: "Label" }); room = { ...room, y: room.y + IN(0.38), h: room.h - IN(0.38) }; }
      }
    } else {
      const lines = [kicker ? { runs: [run(kicker, PT(11), { b: true, color: look.kicker })], after: 4 } : null, { runs: [{ ...run(title, PT(title.length > 70 ? 21 : 25), { b: true, color: look.heading }), font: look.titleFont }] }].filter(Boolean) as Para[];
      d.text({ x: room.x, y: room.y, w: room.w, h: IN(1.05) }, lines, { name: "Title" });
      room = { ...room, y: room.y + IN(1.15), h: room.h - IN(1.15) };
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
    const fs = size ?? fitTablePt(t.head, t.rows, t.widths, R.w / EMU / k, R.h / EMU / k, tags, span);
    const pt = PT(fs), small = PT(Math.max(9, fs - 2));
    const cols = t.widths.map((c) => (c / total) * R.w);
    const pad = { x: 6 * k * 12700, y: 4 * k * 12700 };
    let band = -1;
    const bands = t.rows.map((_, ri) => (!span || (span.rows[ri] ?? 1) > 0 ? ++band : band));
    const cellLines = (text: string, ci: number, p: number) => lineCount(text, Math.max(0.3, (cols[ci] - 2 * pad.x) / EMU), p, 0.5);
    const rows: Cell[][] = [t.head.map((h) => ({ paras: [{ runs: [run(h, small, { b: true, color: look.headText })] }], fill: look.head }))];
    const heights = [pad.y * 2 + Math.max(...t.head.map((h, ci) => cellLines(h, ci, small))) * small * 1.2 / 72 * EMU];
    t.rows.forEach((row, ri) => {
      const fill = bands[ri] % 2 ? look.band : look.bg;
      const under = !!span && (span.rows[ri] ?? 1) === 0;
      let tall = 0;
      rows.push(t.head.map((_, i) => {
        const down = span && i < span.cols ? span.rows[ri] ?? 1 : 1;
        if (down === 0) return { paras: [], fill, merged: true };
        const rule = under && span && i >= span.cols ? { color: look.line, pt: 0.75 } : undefined;
        const [lead, ...more] = (row[i] ?? "").split("\n");
        const tag = i === 0 ? tags?.[ri] : null;
        let paras: Para[];
        if (i === 0 && (more.length || tag)) {
          paras = [{ runs: [run(lead, pt, { b: true })] }, ...(more.length ? [{ runs: [run(more.join(" "), pt)] }] : []), ...(tag ? [{ runs: [run(tag.text, small, { b: true, color: TONE_HEX[tag.tone].fg })] }] : [])];
        } else if (more.length) {
          const all = [lead, ...more];
          paras = all.map((x, j) => ({ runs: [run(x, i === source && j === all.length - 1 ? small : pt, { color: i === source && j === all.length - 1 ? look.soft : look.ink })], after: j < all.length - 1 ? 4 * k : 0 }));
        } else paras = [{ runs: [run(row[i] ?? "", pt, { b: i === 0 })] }];
        if (down <= 1) tall = Math.max(tall, cellLines(row[i] ?? "", i, pt) * pt * 1.2 / 72 * EMU + (tag ? small * 1.2 / 72 * EMU : 0));
        return { paras, fill, rowSpan: down > 1 ? down : undefined, ruleTop: rule };
      }));
      heights.push(pad.y * 2 + tall);
    });
    const used = heights.reduce((a, c) => a + c, 0);
    d.table({ x: R.x, y: R.y, w: R.w, h: used }, cols, rows, heights, pad);
    return used;
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

  let partNo = 0;
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
      if (!tb?.rect) head(d, spec.kicker, spec.title, PT(36));
      d.notes = spec.notes;
      slides.push(d); o.slideOf?.push(si);
      // The agenda: the parts, in order.
      if (agenda && b.agenda.length) {
        const a = new SlideDraft(agenda);
        const at = titleBox(agenda);
        if (at) a.fill(at, [{ runs: [{ text: "Agenda", pt: Math.min(at.pt ?? 40, PT(32)) }] }]);
        const ab = bodyBoxes(agenda)[0];
        if (ab?.rect) {
          const pt = fitPt(b.agenda.join("\n"), ab.rect, Math.min(ab.pt ?? 24, PT(20)), PT(12), 0.5, 1.5);
          a.fill(ab, b.agenda.map((t) => ({ runs: [{ text: t, pt }], keepBullets: true, after: 8 * k })));
        } else {
          const r = roomOf(agenda);
          a.text(r, b.agenda.map((t, i) => ({ runs: [run(`${i + 1}.  ${t}`, PT(18))], after: 10 * k })), { name: "Agenda" });
        }
        slides.push(a); o.slideOf?.push(null);
      }
      // What the review measures, on a slide of its own.
      if (b.table) {
        const m = new SlideDraft(content);
        const room = head(m, spec.kicker, b.tableTitle ?? "What this review measures", PT(25));
        table(m, room, b.table, undefined);
        slides.push(m); o.slideOf?.push(null);
      }
      continue;
    }
    // A new part opens on the section layout.
    if (spec.part && spec.part.n !== partNo) {
      partNo = spec.part.n;
      if (section) {
        const s = new SlideDraft(section);
        const st = titleBox(section);
        if (st?.rect) s.fill(st, [{ runs: [{ text: spec.part.name, pt: fitPt(spec.part.name, st.rect, Math.min(st.pt ?? 44, PT(32)), PT(16), 0.6, 1.25) }] }]);
        else head(s, "", spec.part.name, PT(32));
        // "Part 1 of 3" in the layout's smallest box (a label, not a subtitle).
        const sb = bodyBoxes(section).at(-1);
        const label = `Part ${spec.part.n} of ${spec.part.of}`;
        if (sb?.rect) s.fill(sb, [{ runs: [{ text: label, pt: fitPt(label, sb.rect, Math.min(sb.pt ?? 20, PT(16)), PT(10)) }] }]);
        slides.push(s); o.slideOf?.push(null);
      }
    }
    const d = new SlideDraft(content);
    let room = head(d, spec.kicker, spec.title, PT(spec.title.length > 70 ? 21 : 25));
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
      room = foot(d, room, b.foot);
      let y = room.y;
      if (b.lead) { d.text({ x: room.x, y, w: room.w, h: IN(0.42) }, [{ runs: [run(b.lead, PT(16), { b: true, color: look.kicker })] }], { anchor: "ctr", name: "Lead" }); y += IN(0.48); }
      if (b.tally?.length) {
        d.text({ x: room.x, y, w: room.w, h: IN(0.45) }, [{ runs: b.tally.flatMap((t, i) => [run(`${i ? "     " : ""}${t.n} `, PT(20), { b: true, color: TONE_HEX[t.tone].fg }), run(t.label, PT(13), { color: look.soft })]) }], { anchor: "ctr", name: "Tally" });
        y += IN(0.55);
      }
      table(d, { x: room.x, y, w: room.w, h: room.y + room.h - y }, b, undefined, b.tags, b.span, b.source);
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
          ["Agenda", nameOf("agenda"), "The parts of the meeting, in order"],
          ["Start of each part", nameOf("section"), "The part's name and its number"],
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
