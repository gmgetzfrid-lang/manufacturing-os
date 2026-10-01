// intelligence Round G (I-07) — drawing intelligence, driven through the
// REAL ingest engine over real PDFs (pdf-lib → unpdf, the production text
// path) against the in-memory database (knowledgeFakeDb.ts). Only the
// service-role client, the object store and the vision provider are faked.
//
//   DWG-3  text-layer marks honour /Rotate, the CropBox origin and /UserUnit:
//          a mark ingest stored is mapped by textMarkPosition to exactly
//          where pdf.js itself draws the glyph (viewport.convertToViewportPoint)
//          for /Rotate 0, 90, 180 and 270 — and a value ingest's clamp
//          destroyed is refused, never drawn in the wrong corner
//   DWG-7  a dense TrueType P&ID page (> 2,000 characters) yields equipment
//          tags and a title-block 'self' identity — it used to yield nothing
//   DWG-2  that page's pipe line numbers mint no equipment
//   PR-11  a vision transcript whose connector carries the NO label before
//          the fenced title block declares the BORDER's number
//   DWG-4  a vision transcript's connector lines, in the prompt's form,
//          land as 'opc' rows with their destination drawing in the line

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PDFDocument, StandardFonts, degrees, PDFName, PDFNumber } from "pdf-lib";
import { resetDb, rowsOf, type Row } from "./knowledgeFakeDb";
import { makePdf, type PageSpec } from "./knowledgePdfFixtures";

const r2 = vi.hoisted(() => ({ objects: new Map<string, Uint8Array>() }));
const vision = vi.hoisted(() => ({ text: "" }));

vi.mock("@/lib/supabaseAdmin", async () => ({ supabaseAdmin: (await import("./knowledgeFakeDb")).fakeAdmin }));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "bucket",
  r2: {
    send: async (cmd: { input: { Key: string; Range?: string } }) => {
      const bytes = r2.objects.get(cmd.input.Key);
      if (!bytes) throw new Error(`NoSuchKey ${cmd.input.Key}`);
      const m = /bytes=(\d+)-(\d+)/.exec(cmd.input.Range ?? "");
      return { Body: m ? bytes.slice(Number(m[1]), Number(m[2]) + 1) : bytes };
    },
  },
}));
vi.mock("@/lib/knowledgeVision", () => ({
  transcribePageImage: vi.fn(async () => ({ text: vision.text, usage: { inputTokens: 10, outputTokens: 10 }, model: "m" })),
}));
vi.mock("unpdf", async (orig) => ({
  ...(await orig<typeof import("unpdf")>()),
  renderPageAsImage: vi.fn(async () => new Uint8Array([137, 80, 78, 71]).buffer),
}));
vi.mock("@/lib/equipmentBridgeServer", () => ({ computeForKnowledgeDoc: vi.fn(async () => undefined) }));
vi.mock("@/lib/mentionIndexer", () => ({ loadAliasDictionary: vi.fn(async () => []), indexDocumentMentions: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/usageServer", () => ({
  getMonthUsage: vi.fn(async () => ({ spentUsd: 0 })), getCapUsd: vi.fn(async () => 0), recordAskUsage: vi.fn(async () => undefined),
}));
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "") }));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (k: string) => k }));

import { ingestKnowledgeDocBatch, type VisionContext } from "@/lib/knowledgeIngest";
import { textMarkPosition } from "@/lib/drawingLocate";
import { OPC_LINE_EXAMPLE, TITLE_BLOCK_OPEN, TITLE_BLOCK_CLOSE } from "@/lib/drawingText";

const DOC = "kd-7";
const KEY = "orgs/o1/knowledge/kl-1/sheet.pdf";
const baseDoc = (over: Row = {}): Row => ({
  id: DOC, org_id: "o1", library_id: "kl-1", name: "sheet.pdf", file_key: KEY,
  status: "pending", pages_indexed: 0, page_count: null, last_section: null, created_by: "u1", created_at: "2026-10-01",
  source_id: null, source_document_id: null, source_version_id: null, source_rev: null,
  vision_pages: 0, empty_pages: 0, vision_failed_pages: [], vision_partial_accepted: false, chunk_version: null,
  vision_retry_after: null, vision_retry_tried: [], ingest_failures: 0, ingest_claimed_by: null, ingest_claimed_at: null, error: null,
  ...over,
});
const asArg = (r: Row) => r as unknown as Parameters<typeof ingestKnowledgeDocBatch>[0];
const visionCtx: VisionContext = { provider: "anthropic", model: "user-model", apiKey: "k", budgetPages: 4, onUsage: () => undefined };

async function ingest(bytes: Uint8Array, withVision = false) {
  r2.objects.set(KEY, bytes);
  resetDb({ knowledge_documents: [baseDoc()], knowledge_chunks: [], knowledge_page_entities: [], entity_mentions: [], knowledge_line_traces: [] });
  const res = await ingestKnowledgeDocBatch(asArg(baseDoc()), withVision ? visionCtx : undefined);
  expect(res.done).toBe(true);
  expect(res.busy).toBe(false);
  return rowsOf("knowledge_page_entities");
}

/** One page with tags drawn at exact user-space points, rotated / cropped /
 *  scaled as asked. */
async function sheet(opts: {
  rotate: number; crop?: [number, number, number, number]; userUnit?: number;
  glyphs: Array<[number, number, string]>;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  for (const [x, y, text] of opts.glyphs) page.drawText(text, { x, y, size: 10, font });
  page.drawText("DRAWING NO: 025-PID-0104 SHEET 1 OF 1 REV 2", { x: 300, y: 300, size: 8, font });
  page.setRotation(degrees(opts.rotate));
  if (opts.crop) page.setCropBox(...opts.crop);
  if (opts.userUnit) page.node.set(PDFName.of("UserUnit"), PDFNumber.of(opts.userUnit));
  return doc.save();
}

/** Where pdf.js itself draws a tag's text item, as 0..1 of the drawn page —
 *  the reference every stored mark must map onto. */
async function pdfjsTruth(bytes: Uint8Array, tag: string) {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const item = (content.items as Array<{ str: string; transform: number[] }>).find((i) => i.str.includes(tag))!;
  const vp = page.getViewport({ scale: 1 });
  const [px, py] = vp.convertToViewportPoint(item.transform[4], item.transform[5]);
  return {
    at: { nx: px / vp.width, ny: py / vp.height },
    geometry: { rotate: page.rotate, view: [...page.view], userUnit: page.userUnit },
  };
}

const stored = (rows: Row[], tag: string) => {
  const r = rows.find((e) => e.kind === "equipment" && e.tag === tag)!;
  expect(r, `${tag} was indexed`).toBeTruthy();
  expect(r.pos_source).toBe("text");
  return { nx: r.nx as number, ny: r.ny as number };
};

beforeEach(() => { r2.objects.clear(); vision.text = ""; });

describe("DWG-3 — a text-layer mark lands where pdf.js draws the glyph, on every rotation", () => {
  // A glyph in the LOWER-LEFT of the unrotated page; where it is drawn
  // depends on /Rotate (pdf.js rotates clockwise).
  const quadrant: Record<number, [boolean, boolean]> = {
    0: [true, false],      // [left?, top?] → lower-left
    90: [true, true],      // upper-left
    180: [false, true],    // upper-right
    270: [false, false],   // lower-right
  };

  for (const rotate of [0, 90, 180, 270]) {
    it(`/Rotate ${rotate}: the stored mark maps onto pdf.js's own point, in the right quadrant`, async () => {
      const bytes = await sheet({ rotate, glyphs: [[100, 150, "V-101 SUCTION DRUM"], [400, 200, "P-205A CHARGE PUMP"]] });
      const rows = await ingest(bytes);
      const truth = await pdfjsTruth(bytes, "V-101");
      const s = stored(rows, "V-101");
      const at = textMarkPosition(s.nx, s.ny, truth.geometry)!;
      expect(at, "placeable").toBeTruthy();
      expect(at.nx).toBeCloseTo(truth.at.nx, 6);
      expect(at.ny).toBeCloseTo(truth.at.ny, 6);
      expect([at.nx < 0.5, at.ny < 0.5]).toEqual(quadrant[rotate]);
      if (rotate !== 0) {
        // The raw stored value is wrong on a rotated page — that is the bug.
        expect(Math.abs(s.nx - truth.at.nx) + Math.abs(s.ny - truth.at.ny)).toBeGreaterThan(0.1);
      }
    });
  }

  it("a CropBox that does not start at the origin, and a /UserUnit, are both honoured", async () => {
    const cropped = await sheet({ rotate: 0, crop: [50, 50, 500, 700], glyphs: [[100, 150, "V-101 DRUM"], [400, 600, "E-204 COOLER"]] });
    let rows = await ingest(cropped);
    let truth = await pdfjsTruth(cropped, "V-101");
    let at = textMarkPosition(stored(rows, "V-101").nx, stored(rows, "V-101").ny, truth.geometry)!;
    expect(at.nx).toBeCloseTo(truth.at.nx, 6);
    expect(at.ny).toBeCloseTo(truth.at.ny, 6);

    const scaled = await sheet({ rotate: 90, userUnit: 2, glyphs: [[100, 150, "V-101 DRUM"], [400, 200, "E-204 COOLER"]] });
    rows = await ingest(scaled);
    truth = await pdfjsTruth(scaled, "V-101");
    expect(truth.geometry.userUnit).toBe(2);
    at = textMarkPosition(stored(rows, "V-101").nx, stored(rows, "V-101").ny, truth.geometry)!;
    expect(at.nx).toBeCloseTo(truth.at.nx, 6);
    expect(at.ny).toBeCloseTo(truth.at.ny, 6);
  });

  it("a mark ingest's clamp pinned to an edge on a rotated page is refused, not drawn in the wrong place", async () => {
    // Near the top of a portrait page rotated 90: y exceeds the rotated
    // viewport's height, so ingest clamped ny to 0 — the position is lost.
    const bytes = await sheet({ rotate: 90, glyphs: [[100, 700, "V-101 DRUM"], [400, 200, "E-204 COOLER"]] });
    const rows = await ingest(bytes);
    const truth = await pdfjsTruth(bytes, "V-101");
    const s = stored(rows, "V-101");
    expect(s.ny).toBe(0);
    expect(textMarkPosition(s.nx, s.ny, truth.geometry)).toBeNull();
  });
});

describe("DWG-7 / DWG-2 — a dense TrueType P&ID through the real ingest", () => {
  const densePage: PageSpec = [
    "DRAWING NO: 025-PID-0104  SHEET 1 OF 3  REV 2",
    ...Array.from({ length: 40 }, (_, i) => `V-${101 + i} SUCTION DRUM 6"-P-${1001 + i}-A1A TO E-${201 + i} VIA FV-${301 + i}`),
  ];

  it("yields equipment tags and a title-block identity past 2,000 characters — and no phantom pumps from line numbers", async () => {
    const chars = (densePage as string[]).join("\n").length;
    expect(chars).toBeGreaterThan(2000);
    const rows = await ingest(await makePdf([densePage]));
    const equipment = rows.filter((r) => r.kind === "equipment").map((r) => r.tag as string);
    expect(equipment).toContain("V-101");
    expect(equipment).toContain("E-240");
    expect(equipment).toContain("FV-340");
    // 6"-P-1001-A1A … are lines, not pumps.
    expect(equipment.filter((t) => /^P-10\d\d$/.test(t))).toEqual([]);
    expect(rows.filter((r) => r.kind === "self").map((r) => r.tag)).toEqual(expect.arrayContaining(["025-PID-0104", "025-PID-0104-SH1"]));
  });
});

describe("PR-11 / DWG-4 — the vision transcript contract through the real ingest", () => {
  it("a labelled connector before the fenced title block never becomes the identity; OPC lines land as connector rows", async () => {
    vision.text = [
      "CONT ON DWG NO. 040-B-2002 SH 1",
      OPC_LINE_EXAMPLE,
      "OPC 15: NONE — FROM DESALTER",
      'LINE 6"-P-1024-A1A',
      "V-1402 CRUDE OVERHEAD ACCUMULATOR",
      TITLE_BLOCK_OPEN,
      "DRAWING NO: 025-PID-0104",
      "SHEET: 2 OF 4",
      "REV: C",
      TITLE_BLOCK_CLOSE,
    ].join("\n");
    // A page with no text layer at all: read by AI vision.
    const rows = await ingest(await makePdf([null]), true);
    const self = rows.filter((r) => r.kind === "self").map((r) => r.tag);
    expect(self).toEqual(expect.arrayContaining(["025-PID-0104", "025-PID-0104-SH2"]));
    expect(self).not.toContain("040-B-2002");
    const opc = rows.filter((r) => r.kind === "opc");
    expect(opc.map((r) => r.tag).sort()).toEqual(["14", "15"]);
    expect(String(opc.find((r) => r.tag === "14")!.raw)).toContain("2002-D-2001 SH 4");
    const equipment = rows.filter((r) => r.kind === "equipment").map((r) => r.tag);
    expect(equipment).toContain("V-1402");
    expect(equipment).not.toContain("P-1024");
  });
});
