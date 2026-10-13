// public-surfaces Round G, PS-P8 PHYSICAL BRIDGE TEXT (PHYS-16): the
// regression harness for the physical bridge's own printed artifacts —
// lib/physicalBridge.ts printEquipmentLabels (the QR sticker and the bulk
// sheet), printHoldCard (the red tag) and printTicketTraveler (the drafting
// traveler).
//
// What each generator DRAWS for text in characters its fonts (WinAnsi
// Helvetica and Helvetica-Bold) print as typed — plain ASCII, Latin-1, and
// cp1252's dashes, curly quotes, bullet, ellipsis, euro and trademark signs —
// captured draw call by draw call (text, position, size, font, colour), the
// page count, the download's file name and the downloaded PDF's bytes.
//
// `psP8BridgePlain.golden.json` was recorded by this harness with
// lib/physicalBridge.ts at its 6503ea7 content (before the fix), and
// lib/__tests__/psP8BridgeText.test.ts compares today's artifacts against it:
// a plain-text label, hold card or traveler is byte-identical.
// (Re-record only on purpose: PS_P8_WRITE_BRIDGE_GOLDEN=1 npx vitest run psP8BridgeText.)

import { createHash } from "node:crypto";
import { vi } from "vitest";
import { PDFDocument, PDFPage } from "pdf-lib";
import {
  printEquipmentLabels, printHoldCard, printTicketTraveler,
  type LabelAsset, type HoldCardInput, type TravelerInput,
} from "@/lib/physicalBridge";

const HOLD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TICKET = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

export type BridgeCase =
  | { name: string; kind: "labels"; input: LabelAsset[] }
  | { name: string; kind: "hold"; input: HoldCardInput }
  | { name: string; kind: "traveler"; input: TravelerInput };

/** Each artifact the app prints, with text the fonts print as typed. */
export const BRIDGE_PLAIN_CASES: BridgeCase[] = [
  {
    name: "label: one sticker, every field",
    kind: "labels",
    input: [{ tag: "P-101A", description: "Feed pump, west header", location: "Unit 3 · Bay 2" }],
  },
  {
    name: "label: one sticker, a long tag, description and location cut with an ellipsis; Latin-1 and cp1252",
    kind: "labels",
    input: [{
      tag: "FV-2201-WEST-HEADER-ISOLATION",
      description: "Válvula de aislamiento — cabezal oeste, “GA” • 50 ‰ trim, € spare",
      location: "Área 3 – rack Ø 12 in … level ™",
    }],
  },
  {
    name: "label: one sticker, tag only (no description, no location)",
    kind: "labels",
    input: [{ tag: "E-7", description: null, location: null }],
  },
  {
    name: "labels: a bulk sheet of 12 (two pages), mixed fields",
    kind: "labels",
    input: Array.from({ length: 12 }, (_, i) => ({
      tag: `TT-${300 + i}`,
      description: i % 3 === 0 ? null : `Temperature transmitter ${i} – ‘skid’ ${String.fromCharCode(65 + i)}`,
      location: i % 4 === 1 ? null : `Unit ${1 + (i % 3)}`,
    })),
  },
  {
    name: "hold card: every field",
    kind: "hold",
    input: {
      holdId: HOLD, docLabel: "P-101", docRev: "B", reason: "Engineering review",
      notes: "Awaiting stress calc on the west header tie-in.", openedByName: "Jane Doe",
      openedAt: "2026-10-01T12:00:00Z",
    },
  },
  {
    name: "hold card: no revision, no notes, no name (Document Control)",
    kind: "hold",
    input: { holdId: HOLD, docLabel: "PID-0001", docRev: null, reason: "Quality", openedAt: "2026-10-01T12:00:00Z" },
  },
  {
    name: "hold card: long label, reason and notes cut with an ellipsis; Latin-1 and cp1252",
    kind: "hold",
    input: {
      holdId: HOLD,
      docLabel: "PID-UNIT3-WEST-HEADER-TIE-IN-SPOOL-REPLACEMENT-HOT-TAP-0001",
      docRev: "12B–IFC",
      reason: `Safety — “do not use” pending HAZOP; ${"the relief valve set point is under review; ".repeat(3)}`,
      notes: `${"Café line: see ‘notes’ … € 12,000 • 50 ‰ ™; ".repeat(4)}end.`,
      openedByName: "José Núñez",
      openedAt: "2026-10-01T12:00:00Z",
    },
  },
  {
    name: "traveler: every field",
    kind: "traveler",
    input: {
      ticketRowId: TICKET, ticketNumber: "KE-DDRT-26-0001", title: "Re-route cooling water to E-201",
      status: "in_review", requesterName: "Jane Doe", drafterName: "Sam Lee",
      createdAt: "2026-09-30T08:00:00Z", deliverableRev: "1A",
    },
  },
  {
    name: "traveler: no number, people, date or revision",
    kind: "traveler",
    input: { ticketRowId: TICKET, ticketNumber: null, title: "New request", status: "new" },
  },
  {
    name: "traveler: a long title and names cut with an ellipsis; Latin-1 and cp1252",
    kind: "traveler",
    input: {
      ticketRowId: TICKET, ticketNumber: "KE–DDRT–26–0099",
      title: `Turnaround 2026 — crude unit “west header” tie-ins, hot taps and spool replacements, phase two`,
      status: "waiting_on_requester_feedback",
      requesterName: "Zoë O’Brien", drafterName: `${"Ånne Ørsted-".repeat(8)}end`,
      createdAt: "2026-09-30T08:00:00Z", deliverableRev: "2 • IFC € ™",
    },
  },
];

type Call = { op: string; args: unknown[] };

function plain(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const ctor = (v as { constructor?: { name?: string } }).constructor?.name ?? "";
  if (/Font$/.test(ctor)) return `<font ${(v as { name?: string }).name ?? ""}>`;
  if (/Image$/.test(ctor)) return "<image>";
  if (Array.isArray(v)) return v.map(plain);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = plain((v as Record<string, unknown>)[k]);
  return out;
}

/** Run one generator: every draw call, the downloaded file's name, its page
 *  count and its bytes' digest. The browser's anchor and object URL are
 *  stubbed to capture the download; the document's creation and
 *  modification dates are pinned before saving (pdf-lib stamps "now" into
 *  them), so the bytes are comparable, and the clock is pinned to
 *  2026-10-13 for the bulk sheet's file name. The caller pins
 *  Date.prototype.toLocaleDateString and the public origin. */
export async function bridgeCase(c: BridgeCase): Promise<{ calls: Call[]; filename: string; pages: number; sha256: string }> {
  const calls: Call[] = [];
  const proto = PDFPage.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const spies = (["drawText", "drawRectangle", "drawImage"] as const).map((op) => {
    const orig = proto[op];
    return vi.spyOn(proto, op).mockImplementation(function (this: PDFPage, ...a: unknown[]) {
      calls.push({ op, args: a.map(plain) });
      return orig.apply(this, a);
    });
  });
  const docProto = PDFDocument.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const origSave = docProto.save;
  const saveSpy = vi.spyOn(docProto, "save").mockImplementation(function (this: PDFDocument, ...a: unknown[]) {
    this.setCreationDate(new Date(0));
    this.setModificationDate(new Date(0));
    return origSave.apply(this, a);
  });
  const blobs: Blob[] = [];
  const names: string[] = [];
  const urlSpies = [
    vi.spyOn(URL, "createObjectURL").mockImplementation((b) => { blobs.push(b as Blob); return "blob:bridge"; }),
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {}),
  ];
  vi.stubGlobal("document", {
    createElement: () => ({ click: () => {}, set href(_: string) {}, set download(n: string) { names.push(n); } }),
    body: { appendChild: () => {}, removeChild: () => {} },
  });
  // The bulk sheet's file name carries today's date: pin the clock (Date
  // only — the QR encoder's timers stay real).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
  try {
    if (c.kind === "labels") await printEquipmentLabels(c.input);
    else if (c.kind === "hold") await printHoldCard(c.input);
    else await printTicketTraveler(c.input);
    if (blobs.length !== 1 || names.length !== 1) throw new Error(`expected one download, saw ${blobs.length}`);
    const bytes = new Uint8Array(await blobs[0].arrayBuffer());
    const pages = (await PDFDocument.load(bytes)).getPageCount();
    return { calls, filename: names[0], pages, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    for (const s of [...spies, saveSpy, ...urlSpies]) s.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
}
