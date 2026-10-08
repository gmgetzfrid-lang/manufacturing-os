// public-surfaces Round G — PS-P7 STAMP TEXT ENCODING, review fix (PHYS-15 /
// PHYS-16): the work-package COVER.
//
// PS-P7 made every sheet's stamp print a number such as "P‐101" (U+2010,
// pasted from Word) or a revision "Δ1". On b154823 such a sheet's stamp threw
// inside lib/docPack.ts's per-sheet try: the sheet was LEFT OUT and named,
// and the rest of the work package printed. With the stamp fixed, the sheet
// rode on into /packages' buildCoverAfter, which first records the print
// snapshot (recordPackagePrint) and then draws the cover
// (lib/physicalBridge.ts buildPackageCover) with the standard fonts — which
// threw "WinAnsi cannot encode …". So the whole print failed, nothing
// downloaded, and a print snapshot was left recorded for paper that never
// existed. The cover now draws its data through the stamp's helper
// (stampText), and says what it replaced.
//
//   * REGRESSION: a cover in characters its fonts print as typed is drawn
//     exactly as on b154823 — every draw call, the page count and the saved
//     bytes (psP7CoverPlain.golden.json, recorded by psP7CoverPlainHarness.ts
//     with lib/physicalBridge.ts at its b154823 content).
//   * the cover draws "P‐101" as "P-101" and "Δ1" as "Delta1", never throws,
//     and carries the note "Printed in plain characters: …".
//   * the /packages flow end to end (real pdf-lib, the real stamper, the
//     real cover and the real snapshot writer): a package with one such
//     sheet among plain ones PRINTS — every sheet in the pack, the cover on
//     top, the download triggered — and its snapshot records, on that
//     sheet's entry only, what its stamp printed in another form.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, PDFPage, StandardFonts } from "pdf-lib";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  inserts: [] as Array<{ table: string; payload: unknown }>,
}));

// The pack's reads (documents, holds, versions, acknowledgments) answer from
// `state.tables`; an insert is captured, and the print snapshot's
// `.select("id").single()` answers with its id.
vi.mock("@/lib/supabase", () => {
  function chain(table: string) {
    let inserted = false;
    let single = false;
    const c: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, p: string) {
        if (p === "then") {
          return (resolve: (v: unknown) => void) => resolve(
            inserted
              ? { data: single ? { id: "print-1" } : null, error: null }
              : { data: state.tables[table] ?? [], error: null },
          );
        }
        return (...args: unknown[]) => {
          if (p === "insert") { inserted = true; state.inserts.push({ table, payload: args[0] }); }
          if (p === "single" || p === "maybeSingle") single = true;
          return new Proxy(c, h);
        };
      },
    };
    return new Proxy(c, h);
  }
  return {
    supabase: {
      from: (t: string) => chain(t),
      auth: { getUser: async () => ({ data: { user: { id: "u1" } } }), getSession: async () => ({ data: { session: null } }) },
    },
  };
});
vi.mock("@/lib/intents", () => ({ recordIntent: vi.fn(async () => {}) }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => {}) }));
vi.mock("@/lib/publicOrigin", async (orig) => ({
  ...(await orig<typeof import("@/lib/publicOrigin")>()),
  publicOrigin: () => "https://app.example.com",
}));

import { buildPackageCover, coverContentsChunks, coverNoteLines, COVER_NOTE_LINES } from "@/lib/physicalBridge";
import { stampFontPrints } from "@/lib/stamping";
import { buildAndDownloadDocPack } from "@/lib/docPack";
import { recordPackagePrint, coverEntryLabels, printSnapshotSheets } from "@/lib/workPackages";
import { COVER_PLAIN_CASES, coverCase } from "./psP7CoverPlainHarness";

const GOLDEN = join(process.cwd(), "lib/__tests__/psP7CoverPlain.golden.json");
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const PKG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Drawn = { text: string; x: number; y: number; size: number; font: string; color: unknown };

/** Every drawText call (and its page, by order of first use) while `fn` runs. */
async function captureText<T>(fn: () => Promise<T>): Promise<{ out: T; drawn: Drawn[]; pages: number }> {
  const drawn: Drawn[] = [];
  const pages: PDFPage[] = [];
  const proto = PDFPage.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const orig = proto.drawText;
  const spy = vi.spyOn(proto, "drawText").mockImplementation(function (this: PDFPage, ...a: unknown[]) {
    if (!pages.includes(this)) pages.push(this);
    const o = a[1] as { x: number; y: number; size: number; font: { name: string }; color: unknown };
    drawn.push({ text: String(a[0]), x: o.x, y: o.y, size: o.size, font: o.font.name, color: o.color });
    return orig.apply(this, a);
  });
  try {
    const out = await fn();
    return { out, drawn, pages: pages.length };
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => {
  vi.spyOn(Date.prototype, "toLocaleDateString").mockReturnValue("10/7/2026");
  state.tables = {};
  state.inserts = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── REGRESSION FIRST ─────────────────────────────────────────────────────
describe("REGRESSION — a cover in characters its fonts print as typed is drawn exactly as on b154823", () => {
  it("every plain-text cover: the same draw calls, page count and saved bytes", async () => {
    const now: Record<string, Awaited<ReturnType<typeof coverCase>>> = {};
    for (const c of COVER_PLAIN_CASES) now[c.name] = await coverCase(c.input);
    if (process.env.PS_P7_WRITE_COVER_GOLDEN === "1") writeFileSync(GOLDEN, `${JSON.stringify(now, null, 1)}\n`);
    const before = JSON.parse(readFileSync(GOLDEN, "utf8")) as typeof now;
    expect(Object.keys(now)).toEqual(Object.keys(before));
    for (const name of Object.keys(before)) {
      expect({ name, calls: now[name].calls }).toEqual({ name, calls: before[name].calls });
      expect({ name, pages: now[name].pages, sha256: now[name].sha256 }).toEqual({ name, pages: before[name].pages, sha256: before[name].sha256 });
    }
  }, 60_000);

  it("the golden covers a continuation page, a three-page cover, truncation and the characters the fonts print beyond ASCII", () => {
    const before = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, { pages: number }>;
    expect(Object.values(before).map((c) => c.pages)).toEqual([1, 2, 3, 1]);
    const all = JSON.stringify(COVER_PLAIN_CASES.map((c) => c.input));
    for (const ch of ["–", "—", "“", "”", "‘", "’", "é", "ú", "ë", "\u00a0", "€", "…", "•", "™", "‰", "Å", "Ø"]) expect(all, ch).toContain(ch);
  });

  it("a cover with nothing replaced carries no note", async () => {
    const { drawn } = await captureText(() => buildPackageCover(COVER_PLAIN_CASES[0].input));
    expect(drawn.some((d) => d.text.startsWith("Printed in plain characters"))).toBe(false);
  });
});

// ─── The defect, and the fix ──────────────────────────────────────────────
describe("PHYS-15 / PHYS-16 — the cover draws a number or revision its fonts cannot print as typed", () => {
  it("the precondition: the cover's fonts refuse U+2010 and Δ — what made buildPackageCover throw", async () => {
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    expect(() => regular.widthOfTextAtSize("1.  P‐101 · p. 2", 10)).toThrow(/WinAnsi cannot encode "‐" \(0x2010\)/);
    expect(() => bold.widthOfTextAtSize("Rev Δ1", 10)).toThrow(/WinAnsi cannot encode "Δ" \(0x0394\)/);
  });

  it("'P‐101' at 'Δ1' among plain sheets: the cover resolves, draws 'P-101' and 'Rev Delta1', the plain rows as typed, and the note under the by-line", async () => {
    const { out: cover, drawn } = await captureText(() => buildPackageCover({
      packageId: PKG, printId: "print-1",
      name: "Unit 3 tie‐ins",
      description: "West header — “GA” scope",
      ownerName: "Łukasz",
      printedByName: "jane",
      docs: [
        { label: "P-100 · p. 2", rev: "B" },
        { label: "P‐101 · p. 3", rev: "Δ1" },
        { label: "P-102 · p. 4", rev: null },
      ],
    }));
    expect(cover.getPageCount()).toBe(1);
    const texts = drawn.map((d) => d.text);
    expect(texts).toContain("Unit 3 tie-ins");
    expect(texts).toContain("West header — “GA” scope"); // printable: as typed
    expect(texts).toContain("Owner: ?ukasz   ·   Printed 10/7/2026 by jane");
    expect(texts).toContain("1.  P-100 · p. 2");
    expect(texts).toContain("2.  P-101 · p. 3");
    expect(texts).toContain("3.  P-102 · p. 4");
    expect(texts.filter((t) => t.startsWith("Rev "))).toEqual(["Rev B", "Rev Delta1", "Rev —"]);
    // the note: once, every replacement in the order met (name, by-line, rows)
    const note = drawn.filter((d) => d.text.startsWith("Printed in plain characters"));
    expect(note).toHaveLength(1);
    expect(note[0]).toMatchObject({
      text: 'Printed in plain characters: U+2010 as "-", U+0141 as "?", U+0394 as "Delta".',
      x: 52, y: 628, size: 8, font: "Helvetica",
    });
    // between the by-line (y 640) and the contents header (y 600), drawn before it
    const header = drawn.findIndex((d) => d.text.startsWith("CONTENTS"));
    expect(drawn.findIndex((d) => d.text.startsWith("Printed in plain"))).toBeLessThan(header);
    expect(drawn[header].y).toBe(600);
    // nothing the cover draws is a character its fonts cannot print
    for (const d of drawn) for (const ch of d.text) expect(stampFontPrints(ch.codePointAt(0) ?? 0), `${d.text} :: ${ch}`).toBe(true);
    await cover.save();
  });

  it("a continuation page's header carries the package name in its plain form, and every sheet stays listed", async () => {
    const docs = Array.from({ length: 30 }, (_, i) => ({ label: `P‐${100 + i} · p. ${3 + i}`, rev: i === 29 ? "Δ2" : "A" }));
    const { out: cover, drawn, pages } = await captureText(() => buildPackageCover({ packageId: PKG, printId: null, name: "TA−2026", docs }));
    expect(cover.getPageCount()).toBe(2);
    expect(pages).toBe(2);
    expect(drawn.map((d) => d.text)).toContain("WORK PACKAGE — TA-2026");
    for (let i = 0; i < 30; i++) expect(drawn.map((d) => d.text)).toContain(`${i + 1}.  P-${100 + i} · p. ${3 + i}`);
    expect(drawn.filter((d) => d.text === "Rev Delta2")).toHaveLength(1);
    expect(drawn.filter((d) => d.text.startsWith("Printed in plain"))).toEqual([
      expect.objectContaining({ text: 'Printed in plain characters: U+2212 as "-", U+2010 as "-", U+0394 as "Delta".' }),
    ]);
  });

  it("the longest note (twelve named, then 'and N more') takes two lines above the contents header, each within the text width", async () => {
    // fourteen parenthesised numbers: a compatibility form each, "(10)" … "(3)"
    const many = "⑽⑾⑿⒀⒁⒂⒃⒄⒅⒆⒇⑴⑵⑶";
    const { drawn } = await captureText(() => buildPackageCover({
      packageId: PKG, printId: null, name: "Pack", docs: [{ label: `P-1 ${many}`, rev: "1" }],
    }));
    const noteLines = drawn.filter((d) => d.size === 8 && d.x === 52 && d.y > 600 && d.y < 640);
    expect(noteLines.map((d) => d.y)).toEqual([628, 619]);
    expect(noteLines[0].text.startsWith('Printed in plain characters: U+247D as "(10)"')).toBe(true);
    expect(noteLines[1].text.endsWith('U+2474 as "(1)" and 2 more.')).toBe(true);
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    for (const l of noteLines) expect(regular.widthOfTextAtSize(l.text, 8)).toBeLessThanOrEqual(520);
    expect(drawn.map((d) => d.text)).toContain("1.  P-1 (10)(11)(12)(13)(14)(15)(16)(17)(18)(19)(20)(1)(2)(3)");
  });

  it("coverNoteLines: a short note is one line as given; one that would run past two lines is cut to two, the last ending in an ellipsis", async () => {
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    expect(coverNoteLines('Printed in plain characters: U+2010 as "-".', regular)).toEqual(['Printed in plain characters: U+2010 as "-".']);
    const long = `Printed in plain characters: ${Array.from({ length: 40 }, (_, i) => `U+${(0x2474 + i).toString(16).toUpperCase()} as "(${i})"`).join(", ")}.`;
    const lines = coverNoteLines(long, regular);
    expect(lines).toHaveLength(COVER_NOTE_LINES);
    expect(lines[1].endsWith("…")).toBe(true);
    for (const l of lines) expect(regular.widthOfTextAtSize(l, 8)).toBeLessThanOrEqual(520);
  });
});

// ─── /packages, end to end ────────────────────────────────────────────────
describe("PHYS-15 REGRESSION — a /packages print with one such sheet among plain ones prints (on b154823: that sheet left out and named, the rest printed)", () => {
  async function onePagePdf(): Promise<ArrayBuffer> {
    const d = await PDFDocument.create({ updateMetadata: false });
    d.addPage([612, 792]);
    const b = await d.save();
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }

  it("every sheet stamps, the cover is built, the pack downloads — and the snapshot records the replacement on that sheet only", async () => {
    const docs = [
      { id: "d0", document_number: "P-100", rev: "B", status: "Issued", current_version_id: "v0", library_id: "l1" },
      { id: "d1", document_number: "P‐101", rev: "Δ1", status: "Issued", current_version_id: "v1", library_id: "l1" },
      { id: "d2", document_number: "P-102", rev: "C", status: "Issued", current_version_id: "v2", library_id: "l1" },
    ];
    state.tables.documents = docs;
    state.tables.document_versions = docs.map((d) => ({ id: d.current_version_id, file_url: `https://files/${d.id}.pdf` }));
    const pdf = await onePagePdf();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => pdf.slice(0) })));
    const blobs: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((b) => { blobs.push(b as Blob); return "blob:pack"; });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clicks: string[] = [];
    const revById = new Map(docs.map((d) => [d.id, d.rev]));
    const events: string[] = [];

    const result = await buildAndDownloadDocPack({
      orgId: "org1", packLabel: "Unit 3 tie-ins", documentIds: docs.map((d) => d.id), userId: "u1", userEmail: "jane@example.com",
      // As app/(protected)/packages/page.tsx builds it: the snapshot first,
      // then the cover from the same included sheets.
      buildCoverAfter: async (included, builderSkipped) => {
        // the browser's anchor exists only from here (so the stamp's page
        // analysis, which needs a DOM, falls back to convention as in node)
        vi.stubGlobal("document", {
          createElement: () => ({ click: () => { clicks.push("download"); }, set href(_: string) {}, set download(_: string) {} }),
          body: { appendChild: () => {}, removeChild: () => {} },
        });
        events.push("snapshot");
        const printId = await recordPackagePrint({
          orgId: "org1", packageId: PKG, printedBy: "u1", printedByName: "jane",
          sheets: included.map((s) => ({
            documentId: s.documentId,
            versionId: s.versionId,
            revLabel: revById.get(s.documentId) ?? null,
            label: s.label,
            ...(s.stampMapped ? { stampMapped: s.stampMapped } : {}),
          })),
          leftOut: builderSkipped.flatMap((s) => (s.documentId && s.code ? [{ documentId: s.documentId, label: s.label, code: s.code, reason: s.reason }] : [])),
        });
        events.push("cover");
        const labels = coverEntryLabels(included, coverContentsChunks(included.length).length);
        return buildPackageCover({
          packageId: PKG, printId, name: "Unit 3 tie-ins", description: null, ownerName: "Jane", printedByName: "jane",
          docs: included.map((s, i) => ({ label: labels[i], rev: revById.get(s.documentId) ?? null })),
        });
      },
    });

    expect(result.included).toBe(3);
    expect(result.skipped).toEqual([]);
    expect(events).toEqual(["snapshot", "cover"]);
    expect(clicks).toEqual(["download"]);
    // the downloaded pack: one cover page on top of the three sheets
    expect(blobs).toHaveLength(1);
    const merged = await PDFDocument.load(new Uint8Array(await blobs[0].arrayBuffer()));
    expect(merged.getPageCount()).toBe(4);

    // the snapshot: all three printed; the record keeps the number and
    // revision ON RECORD, and the one sheet whose stamp replaced characters
    // says what its paper shows instead
    const snap = state.inserts.find((i) => i.table === "work_package_prints");
    const sheets = (snap?.payload as { sheets: Array<Record<string, unknown>> }).sheets;
    expect(sheets).toHaveLength(3);
    expect(sheets[1]).toEqual({
      documentId: "d1", versionId: "v1", revLabel: "Δ1", label: "P‐101", printed: true,
      stampMapped: [
        { char: "‐", codePoint: "U+2010", printedAs: "-" },
        { char: "Δ", codePoint: "U+0394", printedAs: "Delta" },
      ],
    });
    // REGRESSION: a plain sheet's entry has exactly the keys it had
    expect(sheets[0]).toEqual({ documentId: "d0", versionId: "v0", revLabel: "B", label: "P-100", printed: true });
    expect(sheets[2]).toEqual({ documentId: "d2", versionId: "v2", revLabel: "C", label: "P-102", printed: true });
    // and the distribution record names all three
    const audits = state.inserts.find((i) => i.table === "download_audits");
    expect((audits?.payload as unknown[]).length).toBe(3);
  }, 60_000);

  it("the page passes each sheet's stampMapped into its snapshot entry, and draws the cover from the same sheets (source pin)", () => {
    const page = src("app/(protected)/packages/page.tsx");
    expect(page).toMatch(/label: s\.label,\s*\n(?:\s*\/\/[^\n]*\n)*\s*\.\.\.\(s\.stampMapped \? \{ stampMapped: s\.stampMapped \} : \{\}\),/);
    expect(page).toContain("return buildPackageCover({");
    expect(page).toContain("label: labels[i],");
    expect(page).toContain("rev: packableById.get(s.documentId)?.rev ?? null,");
    // the snapshot keeps the key as given (the verify door reads only its own keys)
    expect(printSnapshotSheets([{ documentId: "a", versionId: "v", revLabel: "Δ1", label: "A", stampMapped: [{ char: "Δ", codePoint: "U+0394", printedAs: "Delta" }] }])).toEqual([
      { documentId: "a", versionId: "v", revLabel: "Δ1", label: "A", printed: true, stampMapped: [{ char: "Δ", codePoint: "U+0394", printedAs: "Delta" }] },
    ]);
    const door = src("app/api/verify-package/route.ts");
    expect(door).not.toContain("stampMapped");
  });

  it("the pack keeps a sheet's replacements only when there were any (lib/docPack.ts)", () => {
    const pack = src("lib/docPack.ts");
    expect(pack).toContain("const stamp = await applyStampToPdfDoc(single, {");
    expect(pack).toContain("...(stampMapped.length > 0 ? { stampMapped } : {})");
  });
});
