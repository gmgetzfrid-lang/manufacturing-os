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
  printEquipmentLabels, printHoldCard, printTicketTraveler,
  HOLD_CARD_TEXT_WIDTH, HOLD_NOTE_LINES, TRAVELER_NOTE_LINES,
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
  it("one sticker: 'P‐101', 'Motor 5 kΩ', 'Bay Δ2' — downloads, draws the plain forms, the QR targets the tag on record, no note", async () => {
    const { drawn, downloads, qrTargets } = await capture(() => printEquipmentLabels([{ tag: "P‐101", description: "Motor 5 kΩ", location: "Bay Δ2" }]));
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toBe("QR_Label_P_101.pdf");
    expect(qrTargets).toEqual(["https://app.example.com/assets/P%E2%80%90101"]);
    const texts = drawn.map((d) => d.text);
    expect(texts.slice(0, 3)).toEqual(["P-101", "Motor 5 k?", "Bay Delta2"]);
    expect(texts.some((t) => t.startsWith("Printed in plain"))).toBe(false);
    allPrintable(drawn);
  });

  it("a bulk sheet with one such tag among plain ones: every label drawn, the plain ones as typed", async () => {
    const { drawn, downloads } = await capture(() => printEquipmentLabels([
      { tag: "TT-300", description: "Transmitter – ‘skid’ A" },
      { tag: "TT‐301", description: "Ω probe", location: "Unit 2" },
      { tag: "TT-302", location: "Unit 3" },
    ]));
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toMatch(/^QR_Labels_3_tags_\d{4}-\d{2}-\d{2}\.pdf$/);
    const texts = drawn.map((d) => d.text);
    for (const t of ["TT-300", "Transmitter – ‘skid’ A", "TT-301", "? probe", "Unit 2", "TT-302", "Unit 3"]) expect(texts).toContain(t);
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

describe("PHYS-16 — source pins: no generator draws caller text past the mapper", () => {
  it("fit() and drawText() never take a field of the caller's input directly", () => {
    const bridge = src("lib/physicalBridge.ts");
    expect(bridge).not.toMatch(/fit\((?:input|asset)\./);
    expect(bridge).not.toMatch(/drawText\((?:input|asset)\./);
    // one mapper, shared by every generator and the cover
    expect(bridge.match(/textMapper\(\)/g)?.length).toBe(5); // definition + four generators
    expect(bridge).toContain("const out = stampText(text);");
  });
});
