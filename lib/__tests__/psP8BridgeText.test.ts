// public-surfaces Round G — PS-P8 PHYSICAL BRIDGE TEXT (PHYS-16): the
// physical bridge's own printed artifacts — the equipment QR label, the hold
// card and the drafting traveler (lib/physicalBridge.ts).
//
// Each generator embeds pdf-lib's standard Helvetica / Helvetica-Bold, whose
// WinAnsi encoding refuses any character outside it ("WinAnsi cannot encode
// …"), and drew caller text directly — most of it through `fit`, which
// measures first and so threw first. A drawing numbered "P‐101" (U+2010,
// pasted from Word) or at revision "Δ1" could not have its hold card printed:
// nothing downloaded, and the red tag the hold exists to hang was never
// made. An equipment description with "Ω", or a ticket number with U+2010,
// failed its label or traveler the same way. Each now maps its data once, up
// front, through the stamp's own helper (lib/stamping.ts stampText), as the
// work-package cover does since PS-P7.
//
//   * REGRESSION: a label, hold card or traveler in characters its fonts
//     print as typed is drawn exactly as on 6503ea7 — every draw call, the
//     download's name, the page count and the downloaded bytes
//     (psP8BridgePlain.golden.json, recorded by psP8BridgePlainHarness.ts
//     with lib/physicalBridge.ts at its 6503ea7 content).
//   * each generator, given such text, resolves, downloads, and draws only
//     characters its fonts print ("P-101", "Delta1", a visible "?").
//   * the hold card (a document's identity: its number and revision) and
//     the traveler say what they replaced ("Printed in plain characters: …").
//   * the equipment label, when anything on it was replaced, carries a "*"
//     on its tag line and LABEL_PLAIN_MARK under it, so a substituted tag
//     never looks like the exact tag (integrator ruling, 2026-10-13).
//   * every caller field of all four generators, each given a character the
//     fonts cannot print, still gives a printable PDF (the guard behind
//     done-when 1), and a source pin keeps raw caller fields out of every
//     fit( / drawText( argument.
//   * the QR target and the file name are built from the text on record,
//     never from the printed form.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, PDFPage, StandardFonts } from "pdf-lib";

// The QR encoder stays real (the regression record's bytes carry its PNG);
// each target it is handed is recorded.
const qr = vi.hoisted(() => ({ targets: [] as string[] }));
vi.mock("qrcode", async (orig) => {
  const real = await orig<typeof import("qrcode")>();
  const toDataURL = ((text: string, ...rest: unknown[]) => {
    qr.targets.push(text);
    return (real.toDataURL as (...a: unknown[]) => unknown)(text, ...rest);
  }) as typeof real.toDataURL;
  return { ...real, toDataURL, default: { ...real, toDataURL } };
});
vi.mock("@/lib/publicOrigin", async (orig) => ({
  ...(await orig<typeof import("@/lib/publicOrigin")>()),
  publicOrigin: () => "https://app.example.com",
}));

import {
  printEquipmentLabels, printHoldCard, printTicketTraveler, buildPackageCover,
  HOLD_CARD_TEXT_WIDTH, HOLD_NOTE_LINES, TRAVELER_NOTE_LINES,
  LABEL_CAPTION_LINES, LABEL_PLAIN_MARK, LABEL_PLAIN_MARK_SIZE,
  type LabelAsset, type HoldCardInput, type TravelerInput, type PackageCoverInput,
} from "@/lib/physicalBridge";
import { stampFontPrints } from "@/lib/stamping";
import { BRIDGE_PLAIN_CASES, bridgeCase } from "./psP8BridgePlainHarness";

const GOLDEN = join(process.cwd(), "lib/__tests__/psP8BridgePlain.golden.json");
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const HOLD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TICKET = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Drawn = { text: string; x: number; y: number; size: number; font: string; color: unknown };

/** Every drawText call, the downloads (name and bytes) and the QR targets
 *  (the strings handed to the encoder) while `fn` runs. */
async function capture(fn: () => Promise<void>): Promise<{ drawn: Drawn[]; downloads: Array<{ name: string; bytes: Uint8Array }>; qrTargets: string[] }> {
  const drawn: Drawn[] = [];
  const proto = PDFPage.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const orig = proto.drawText;
  const spy = vi.spyOn(proto, "drawText").mockImplementation(function (this: PDFPage, ...a: unknown[]) {
    const o = a[1] as { x: number; y: number; size: number; font: { name: string }; color: unknown };
    drawn.push({ text: String(a[0]), x: o.x, y: o.y, size: o.size, font: o.font.name, color: o.color });
    return orig.apply(this, a);
  });
  const qrTargets = qr.targets;
  qrTargets.length = 0;
  const blobs: Blob[] = [];
  const names: string[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((b) => { blobs.push(b as Blob); return "blob:bridge"; });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.stubGlobal("document", {
    createElement: () => ({ click: () => {}, set href(_: string) {}, set download(n: string) { names.push(n); } }),
    body: { appendChild: () => {}, removeChild: () => {} },
  });
  try {
    await fn();
    const downloads = await Promise.all(blobs.map(async (b, i) => ({ name: names[i], bytes: new Uint8Array(await b.arrayBuffer()) })));
    return { drawn, downloads, qrTargets };
  } finally {
    spy.mockRestore();
  }
}

function allPrintable(drawn: Drawn[]): void {
  for (const d of drawn) for (const ch of d.text) expect(stampFontPrints(ch.codePointAt(0) ?? 0), `${d.text} :: ${ch}`).toBe(true);
}

beforeEach(() => {
  vi.spyOn(Date.prototype, "toLocaleDateString").mockReturnValue("10/13/2026");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── REGRESSION FIRST ─────────────────────────────────────────────────────
describe("REGRESSION — a label, hold card or traveler in characters its fonts print as typed is drawn exactly as on 6503ea7", () => {
  it("every plain-text artifact: the same draw calls, file name, page count and downloaded bytes", async () => {
    const now: Record<string, Awaited<ReturnType<typeof bridgeCase>>> = {};
    for (const c of BRIDGE_PLAIN_CASES) now[c.name] = await bridgeCase(c);
    if (process.env.PS_P8_WRITE_BRIDGE_GOLDEN === "1") writeFileSync(GOLDEN, `${JSON.stringify(now, null, 1)}\n`);
    const before = JSON.parse(readFileSync(GOLDEN, "utf8")) as typeof now;
    expect(Object.keys(now)).toEqual(Object.keys(before));
    for (const name of Object.keys(before)) {
      expect({ name, calls: now[name].calls }).toEqual({ name, calls: before[name].calls });
      expect({ name, filename: now[name].filename, pages: now[name].pages, sha256: now[name].sha256 })
        .toEqual({ name, filename: before[name].filename, pages: before[name].pages, sha256: before[name].sha256 });
    }
  }, 60_000);

  it("the golden covers each generator, a two-page label sheet, truncation, absent fields and the characters the fonts print beyond ASCII", () => {
    const before = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, { pages: number; calls: Array<{ op: string; args: unknown[] }> }>;
    const kinds = BRIDGE_PLAIN_CASES.map((c) => c.kind);
    for (const k of ["labels", "hold", "traveler"] as const) expect(kinds.filter((x) => x === k).length).toBeGreaterThanOrEqual(3);
    expect(Object.values(before).some((c) => c.pages === 2)).toBe(true);
    // a cut with the ellipsis happens in each kind's long case
    for (const c of BRIDGE_PLAIN_CASES.filter((x) => /cut with an ellipsis/.test(x.name))) {
      expect(before[c.name].calls.some((k) => k.op === "drawText" && String(k.args[0]).endsWith("…")), c.name).toBe(true);
    }
    const all = JSON.stringify(BRIDGE_PLAIN_CASES.map((c) => c.input));
    for (const ch of ["–", "—", "“", "”", "‘", "’", "á", "é", "ú", "ë", " ", "€", "…", "•", "™", "‰", "Å", "Ø"]) expect(all, ch).toContain(ch);
    // and no note on any of them
    for (const c of Object.values(before)) {
      expect(c.calls.some((k) => k.op === "drawText" && String(k.args[0]).startsWith("Printed in plain characters"))).toBe(false);
    }
  });
});

// ─── The defect ───────────────────────────────────────────────────────────
describe("PHYS-16 — the precondition: the generators' fonts refuse U+2010, Δ and Ω", () => {
  it("what made fit() (and so each generator) throw", async () => {
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    expect(() => bold.widthOfTextAtSize("P‐101  ·  Rev B", 18)).toThrow(/WinAnsi cannot encode "‐" \(0x2010\)/);
    expect(() => bold.widthOfTextAtSize("Rev Δ1", 18)).toThrow(/WinAnsi cannot encode "Δ" \(0x0394\)/);
    expect(() => regular.widthOfTextAtSize("Motor 5 kΩ", 9)).toThrow(/WinAnsi cannot encode "Ω" \(0x03a9\)/);
  });
});

// ─── The fix ──────────────────────────────────────────────────────────────
describe("PHYS-16 — the hold card prints a document number, revision, reason or name its fonts cannot print as typed", () => {
  it("'P‐101' at 'Δ1', a reason with 'Ω', placed by 'Łukasz': the card downloads, draws the plain forms, and the note under the placed-by line", async () => {
    const { drawn, downloads, qrTargets } = await capture(() => printHoldCard({
      holdId: HOLD, docLabel: "P‐101", docRev: "Δ1", reason: "Motor 5 kΩ rewind",
      notes: "West header — “GA” tie‐in", openedByName: "Łukasz", openedAt: "2026-10-01T12:00:00Z",
    }));
    expect(downloads).toHaveLength(1);
    // the file name and the QR are built from the values on record
    expect(downloads[0].name).toBe("HOLD_P_101.pdf");
    expect(qrTargets).toEqual([`https://app.example.com/verify-hold/${HOLD}`]);
    expect((await PDFDocument.load(downloads[0].bytes)).getPageCount()).toBe(1);
    const texts = drawn.map((d) => d.text);
    expect(drawn.find((d) => d.y === 280)).toMatchObject({ text: "P-101  ·  Rev Delta1", size: 18, font: "Helvetica-Bold" });
    expect(texts).toContain("Reason: Motor 5 k? rewind");
    expect(texts).toContain("West header — “GA” tie-in"); // printable characters: as typed
    expect(texts).toContain("Placed by ?ukasz on 10/13/2026");
    const note = drawn.filter((d) => d.text.startsWith("Printed in plain characters"));
    expect(note).toEqual([expect.objectContaining({
      text: 'Printed in plain characters: U+2010 as "-", U+0394 as "Delta", U+03A9 as "?", U+0141 as "?".',
      x: 32, y: 194, size: 8, font: "Helvetica",
    })]);
    // below the placed-by line (y 208), left of the QR plate (x 452)
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    expect(32 + regular.widthOfTextAtSize(note[0].text, 8)).toBeLessThan(452);
    // the fixed captions are drawn as before
    expect(texts).toContain("HOLD — DO NOT ADVANCE");
    expect(texts).toContain("SCAN: is this hold");
    allPrintable(drawn);
  });

  it("a format character in the number is removed and named; the card still prints", async () => {
    const { drawn, downloads } = await capture(() => printHoldCard({
      holdId: HOLD, docLabel: "P-101\u200b", docRev: null, reason: "Quality", openedAt: "2026-10-01T12:00:00Z",
    }));
    expect(downloads).toHaveLength(1);
    expect(drawn.find((d) => d.y === 280)?.text).toBe("P-101");
    expect(drawn.filter((d) => d.text.startsWith("Printed in plain")).map((d) => d.text)).toEqual(["Printed in plain characters: U+200B removed."]);
  });

  it("the longest note takes at most two lines, each within the card's text column, the last cut with an ellipsis", async () => {
    const many = "⑽⑾⑿⒀⒁⒂⒃⒄⒅⒆⒇⑴⑵⑶";
    const { drawn, downloads } = await capture(() => printHoldCard({
      holdId: HOLD, docLabel: `P-1 ${many}`, docRev: "1", reason: "Quality", openedAt: "2026-10-01T12:00:00Z",
    }));
    expect(downloads).toHaveLength(1);
    const noteLines = drawn.filter((d) => d.size === 8 && d.x === 32);
    expect(noteLines.length).toBeLessThanOrEqual(HOLD_NOTE_LINES);
    expect(noteLines.map((d) => d.y)).toEqual([194, 185]);
    expect(noteLines[0].text.startsWith('Printed in plain characters: U+247D as "(10)"')).toBe(true);
    expect(noteLines[1].text.endsWith("…")).toBe(true);
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    for (const l of noteLines) expect(regular.widthOfTextAtSize(l.text, 8)).toBeLessThanOrEqual(HOLD_CARD_TEXT_WIDTH);
    // the note stays above the QR caption and the scan lines (y ≤ 50)
    for (const l of noteLines) expect(l.y).toBeGreaterThan(60);
    allPrintable(drawn);
  });
});

describe("PHYS-16 — the equipment label prints a tag, description or location its fonts cannot print as typed", () => {
  // The 3.5"×2" sticker: QR 8 → 136, text column x 144 → 244 (100 pt wide).
  const STICKER_TX = 144;
  const STICKER_MAX_W = 100;

  it("one sticker: 'P‐101', 'Motor 5 kΩ', 'Bay Δ2' — downloads, draws the plain forms, the QR targets the tag on record", async () => {
    const { drawn, downloads, qrTargets } = await capture(() => printEquipmentLabels([{ tag: "P‐101", description: "Motor 5 kΩ", location: "Bay Δ2" }]));
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toBe("QR_Label_P_101.pdf");
    expect(qrTargets).toEqual(["https://app.example.com/assets/P%E2%80%90101"]);
    const texts = drawn.map((d) => d.text);
    expect(texts.slice(0, 3)).toEqual(["P-101*", "Motor 5 k?", "Bay Delta2"]);
    // the sticker has no room for stampTextNote's line; it carries the marker instead
    expect(texts.some((t) => t.startsWith("Printed in plain"))).toBe(false);
    allPrintable(drawn);
  });

  it("the marker (integrator ruling): a '*' on the tag line and LABEL_PLAIN_MARK inside the text column, clear of the QR, the location and the caption", async () => {
    const { drawn } = await capture(() => printEquipmentLabels([{ tag: "P‐101", description: "Feed pump", location: "Bay 2" }]));
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const tagLine = drawn.find((d) => d.size === 20);
    expect(tagLine).toMatchObject({ text: "P-101*", x: STICKER_TX, y: 116, font: "Helvetica-Bold" });
    const mark = drawn.filter((d) => d.text === LABEL_PLAIN_MARK);
    expect(mark).toEqual([expect.objectContaining({ x: STICKER_TX, y: 80, size: LABEL_PLAIN_MARK_SIZE, font: "Helvetica" })]);
    expect(LABEL_PLAIN_MARK_SIZE).toBeGreaterThanOrEqual(5);
    expect(LABEL_PLAIN_MARK_SIZE).toBeLessThanOrEqual(6);
    // inside the text column: right of the QR (ends at x 136), within 100 pt
    expect(mark[0].x).toBeGreaterThanOrEqual(136);
    expect(regular.widthOfTextAtSize(LABEL_PLAIN_MARK, LABEL_PLAIN_MARK_SIZE)).toBeLessThanOrEqual(STICKER_MAX_W);
    // below the location line (y 90) and above the caption's top line (y 28, 7 pt)
    const location = drawn.find((d) => d.text === "Bay 2");
    expect(location?.y).toBe(90);
    const captionTop = drawn.find((d) => d.text === LABEL_CAPTION_LINES[0]);
    expect(mark[0].y + LABEL_PLAIN_MARK_SIZE).toBeLessThan((location?.y ?? 0) - 2);
    expect(mark[0].y).toBeGreaterThan((captionTop?.y ?? 0) + 7);
    // the caption is drawn as before
    expect(drawn.filter((d) => LABEL_CAPTION_LINES.includes(d.text)).map((d) => d.y)).toEqual([28, 19, 10]);
    allPrintable(drawn);
  });

  it("any field triggers it — a replacement in the description, a removal in the location; a plain label carries none", async () => {
    const desc = await capture(() => printEquipmentLabels([{ tag: "P-101", description: "Motor 5 kΩ" }]));
    expect(desc.drawn[0].text).toBe("P-101*");
    expect(desc.drawn.filter((d) => d.text === LABEL_PLAIN_MARK)).toHaveLength(1);
    const removed = await capture(() => printEquipmentLabels([{ tag: "P-101", location: "Bay​ 2" }]));
    expect(removed.drawn[0].text).toBe("P-101*");
    expect(removed.drawn.map((d) => d.text)).toContain("Bay 2");
    expect(removed.drawn.filter((d) => d.text === LABEL_PLAIN_MARK)).toHaveLength(1);
    const plain = await capture(() => printEquipmentLabels([{ tag: "P–101", description: "Motor “5 k” — west", location: "Bay 2" }]));
    expect(plain.drawn[0].text).toBe("P–101");
    expect(plain.drawn.some((d) => d.text === LABEL_PLAIN_MARK || d.text.endsWith("*"))).toBe(false);
  });

  it("a long substituted tag is cut so the '*' always shows, within the text column", async () => {
    const { drawn } = await capture(() => printEquipmentLabels([{ tag: "FV‐2201-WEST-HEADER-ISOLATION" }]));
    const tagLine = drawn.find((d) => d.size === 20);
    expect(tagLine?.text.endsWith("…*")).toBe(true);
    const doc = await PDFDocument.create();
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    expect(bold.widthOfTextAtSize(tagLine?.text ?? "", 20)).toBeLessThanOrEqual(STICKER_MAX_W);
    allPrintable(drawn);
  });

  it("a bulk sheet with one such tag among plain ones: every label drawn, the plain ones as typed and unmarked, the substituted one marked", async () => {
    const { drawn, downloads } = await capture(() => printEquipmentLabels([
      { tag: "TT-300", description: "Transmitter – ‘skid’ A" },
      { tag: "TT‐301", description: "Ω probe", location: "Unit 2" },
      { tag: "TT-302", location: "Unit 3" },
    ]));
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toMatch(/^QR_Labels_3_tags_\d{4}-\d{2}-\d{2}\.pdf$/);
    const texts = drawn.map((d) => d.text);
    for (const t of ["TT-300", "Transmitter – ‘skid’ A", "TT-301*", "? probe", "Unit 2", "TT-302", "Unit 3"]) expect(texts).toContain(t);
    expect(texts.filter((t) => /^TT-30\d\*?$/.test(t))).toEqual(["TT-300", "TT-301*", "TT-302"]);
    const mark = drawn.filter((d) => d.text === LABEL_PLAIN_MARK);
    expect(mark).toHaveLength(1);
    // drawn on TT-301's label, in its text column
    const tt301 = drawn.find((d) => d.text === "TT-301*");
    expect(mark[0].x).toBe(tt301?.x);
    expect(mark[0].y).toBe((tt301?.y ?? 0) - 36);
    allPrintable(drawn);
  });
});

describe("PHYS-16 — the drafting traveler prints a ticket number, title, status, revision or name its fonts cannot print as typed", () => {
  it("'KE‐0001', a title with 'Δ', revision 'Δ1', requested by 'Łukasz': downloads, draws the plain forms and the note under the scan paragraph", async () => {
    const { drawn, downloads, qrTargets } = await capture(() => printTicketTraveler({
      ticketRowId: TICKET, ticketNumber: "KE‐0001", title: "Valve Δ change — “GA”", status: "in_review",
      requesterName: "Łukasz", drafterName: "Sam Lee", createdAt: "2026-09-30T08:00:00Z", deliverableRev: "Δ1",
    }));
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toBe("Traveler_KE_0001.pdf");
    expect(qrTargets).toEqual([`https://app.example.com/verify-ticket/${TICKET}?r=${encodeURIComponent("Δ1")}`]);
    expect((await PDFDocument.load(downloads[0].bytes)).getPageCount()).toBe(1);
    const texts = drawn.map((d) => d.text);
    expect(drawn.find((d) => d.y === 710)).toMatchObject({ text: "KE-0001", size: 11 });
    expect(texts).toContain("Valve Delta change — “GA”");
    expect(texts).toContain("in review");
    expect(texts).toContain("Rev Delta1");
    expect(texts).toContain("?ukasz");
    expect(texts).toContain("Sam Lee");
    const note = drawn.filter((d) => d.text.startsWith("Printed in plain characters"));
    expect(note).toEqual([expect.objectContaining({
      text: 'Printed in plain characters: U+2010 as "-", U+0394 as "Delta", U+0141 as "?".',
      x: 52, y: 456, size: 8, font: "Helvetica",
    })]);
    allPrintable(drawn);
  });

  it("the longest note takes at most two lines within the page's text width", async () => {
    const many = "⑽⑾⑿⒀⒁⒂⒃⒄⒅⒆⒇⑴⑵⑶";
    const { drawn } = await capture(() => printTicketTraveler({ ticketRowId: TICKET, ticketNumber: null, title: `T ${many}`, status: "new" }));
    const noteLines = drawn.filter((d) => d.size === 8 && d.x === 52);
    expect(noteLines.length).toBeLessThanOrEqual(TRAVELER_NOTE_LINES);
    expect(noteLines.map((d) => d.y)).toEqual([456, 447]);
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    for (const l of noteLines) expect(regular.widthOfTextAtSize(l.text, 8)).toBeLessThanOrEqual(520);
    allPrintable(drawn);
  });
});

describe("PHYS-16 — the guard: every caller field of all four generators, given a character the fonts cannot print, gives a printable PDF", () => {
  // Each field carries its own token (x01 …) so the test can tell that the
  // field was drawn, and the same unprintable tail: a Greek capital omega, a
  // Unicode hyphen and a zero-width space. The dates come back from
  // toLocaleDateString in Arabic-Indic digits behind a right-to-left mark (a
  // locale whose digits the fonts do not print). A field reached through a
  // local, an array or a template literal is caught here whatever its syntax.
  const U = "Ω‐​";
  const f = (n: number) => `x${String(n).padStart(2, "0")}${U}`;
  const LOCAL_DATE = "‏١٣/١٠/٢٠٢٦";

  /** The keys of an exported interface, read from the source: a field added
   *  to a generator's input without a case here fails the test. */
  function interfaceKeys(name: string): string[] {
    const body = src("lib/physicalBridge.ts").match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
    return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]).sort();
  }

  async function printedPdf(drawn: Drawn[], bytes: Uint8Array): Promise<void> {
    expect(drawn.length).toBeGreaterThan(0);
    allPrintable(drawn);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(1);
  }

  beforeEach(() => {
    vi.spyOn(Date.prototype, "toLocaleDateString").mockReturnValue(LOCAL_DATE);
  });

  it("the equipment label: tag, description, location (single sticker and bulk sheet)", async () => {
    const asset: LabelAsset = { tag: f(1), description: f(2), location: f(3) };
    expect(Object.keys(asset).sort()).toEqual(interfaceKeys("LabelAsset"));
    for (const assets of [[asset], [asset, { ...asset, tag: f(4) }]]) {
      const { drawn, downloads } = await capture(() => printEquipmentLabels(assets));
      expect(downloads).toHaveLength(1);
      await printedPdf(drawn, downloads[0].bytes);
      for (const tok of ["x01", "x02", "x03"]) expect(drawn.some((d) => d.text.includes(tok)), tok).toBe(true);
      expect(drawn.filter((d) => d.text === LABEL_PLAIN_MARK)).toHaveLength(assets.length);
    }
  });

  it("the hold card: document number and revision, reason, notes, placed-by name, the opened date (and the hold id, QR only)", async () => {
    const input: HoldCardInput = {
      holdId: f(10), docLabel: f(11), docRev: f(12), reason: f(13), notes: f(14), openedByName: f(15), openedAt: "2026-10-01T12:00:00Z",
    };
    expect(Object.keys(input).sort()).toEqual(interfaceKeys("HoldCardInput"));
    const { drawn, downloads } = await capture(() => printHoldCard(input));
    expect(downloads).toHaveLength(1);
    await printedPdf(drawn, downloads[0].bytes);
    for (const tok of ["x11", "x12", "x13", "x14", "x15"]) expect(drawn.some((d) => d.text.includes(tok)), tok).toBe(true);
    expect(drawn.some((d) => d.text.includes("Placed by x15?- on ?"))).toBe(true);
    expect(drawn.some((d) => d.text.startsWith("Printed in plain characters"))).toBe(true);
  });

  it("the traveler: number, title, status, requester, drafter, opened date, deliverable revision (and the row id, QR only)", async () => {
    const input: TravelerInput = {
      ticketRowId: f(20), ticketNumber: f(21), title: f(22), status: `in_${f(23)}`,
      requesterName: f(24), drafterName: f(25), createdAt: "2026-09-30T08:00:00Z", deliverableRev: f(26),
    };
    expect(Object.keys(input).sort()).toEqual(interfaceKeys("TravelerInput"));
    const { drawn, downloads } = await capture(() => printTicketTraveler(input));
    expect(downloads).toHaveLength(1);
    await printedPdf(drawn, downloads[0].bytes);
    for (const tok of ["x21", "x22", "x23", "x24", "x25", "x26"]) expect(drawn.some((d) => d.text.includes(tok)), tok).toBe(true);
    expect(drawn.some((d) => d.x === 170 && /^\?+\/\?+\/\?+$/.test(d.text))).toBe(true); // the opened date
    expect(drawn.some((d) => d.text.startsWith("Printed in plain characters"))).toBe(true);
  });

  it("the work-package cover: name, description, owner, printer, every sheet's number and revision, the printed date (and the ids, QR only), over two pages", async () => {
    const input: PackageCoverInput = {
      packageId: f(30), printId: f(31), name: f(32), description: f(33), ownerName: f(34), printedByName: f(35),
      docs: Array.from({ length: 30 }, (_, i) => ({ label: `${f(36)}-${i}`, rev: f(37) })),
    };
    expect(Object.keys(input).sort()).toEqual(interfaceKeys("PackageCoverInput"));
    let bytes: Uint8Array = new Uint8Array();
    const { drawn } = await capture(async () => { bytes = await (await buildPackageCover(input)).save(); });
    await printedPdf(drawn, bytes);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
    for (const tok of ["x32", "x33", "x34", "x35", "x36", "x37"]) expect(drawn.some((d) => d.text.includes(tok)), tok).toBe(true);
    expect(drawn.some((d) => d.text.includes("WORK PACKAGE — x32"))).toBe(true); // the continuation header
    expect(drawn.some((d) => d.text.startsWith("Printed in plain characters"))).toBe(true);
  }, 30_000);
});

describe("PHYS-16 — source pins: no generator draws caller text past the mapper", () => {
  /** The argument text of every fit( / drawText( call in `source`, read by
   *  balanced parentheses (string literals skipped, template literals read
   *  through, so a `${input.…}` inside one is seen). */
  function drawCallArgs(source: string): string[] {
    const out: string[] = [];
    for (const m of source.matchAll(/\b(?:fit|drawText)\(/g)) {
      let depth = 1;
      let quote: string | null = null;
      let i = (m.index ?? 0) + m[0].length;
      const start = i;
      for (; i < source.length && depth > 0; i++) {
        const c = source[i];
        if (quote) {
          if (c === "\\") i++;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "(") depth++;
        else if (c === ")") depth--;
      }
      out.push(source.slice(start, i - 1));
    }
    return out;
  }
  // A raw field of the caller's input — `input.x`, `asset.x`, `assets[i]`,
  // bare or inside a template literal — anywhere in the arguments. A count
  // (`input.docs.length`) is a number, not caller text.
  const RAW_FIELD = /\b(?:input|asset|assets)\??(?:\.|\[)(?!\w*\.length\b)/;
  const rawCalls = (source: string) => drawCallArgs(source).filter((a) => RAW_FIELD.test(a));

  it("no fit() or drawText() argument holds a field of the caller's input — directly, in an expression or in a template literal", () => {
    const bridge = src("lib/physicalBridge.ts");
    expect(drawCallArgs(bridge).length).toBeGreaterThanOrEqual(30); // the scan reads every call
    expect(rawCalls(bridge)).toEqual([]);
  });

  it("the pin catches the shapes it exists for (6503ea7 drew the hold card's document line and reason as the first two)", () => {
    for (const shape of [
      "page.drawText(fit(`Reason: ${input.reason}`, bold, 13, 380), { x: 32 });",
      "page.drawText(fit(`${input.docLabel}${input.docRev ? `  ·  Rev ${input.docRev}` : \"\"}`, bold, 18, 380), {\n x: 32 });",
      "page.drawText(fit(asset.tag, bold, 20, maxW), { x: tx });",
      "page.drawText(input.ticketNumber ?? \"\", { x: 52 });",
      "p.drawText(`Tag ${asset.tag}`, { x: 1 });",
      "page.drawText(fit(cond ? input.title : \"—\", bold, 15, 400), { x: 52 });",
      "page.drawText(\"Rev: \" + input.deliverableRev, { x: 52 });",
      "page.drawText(fit(assets[0].tag, bold, 20, 100), { x: 1 });",
      "page.drawText(`(${input.docs.length} sheets) ${input.name}`, { x: 1 });",
      "page.drawText(fit(input?.notes ?? \"\", regular, 10, 380), { x: 32 });",
    ]) expect(rawCalls(shape).length, shape).toBeGreaterThan(0); // a fit( inside a drawText( is flagged at both
    expect(rawCalls("page.drawText(`(${input.docs.length} sheets)`, { x: 1 });")).toEqual([]);
    expect(rawCalls("page.drawText(fit(docLine, bold, 18, 380), { x: 32 }); const n = input.notes;")).toEqual([]);
  });

  it("one mapper, shared by every generator and the cover", () => {
    const bridge = src("lib/physicalBridge.ts");
    expect(bridge.match(/textMapper\(\)/g)?.length).toBe(5); // definition + four generators
    expect(bridge).toContain("const out = stampText(text);");
  });
});
