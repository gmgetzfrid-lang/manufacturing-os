// A company letterhead for printed reports: read from a Word file (header,
// footer, logo, margins — page 1's own header when it has one), from a
// picture of the page (the blank part found), checked when it's read back,
// and drawn with every piece of text escaped.

import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { letterheadFromDocx, cleanLetterhead, layerHtml, blankArea, paperFor, letterheadLayersHtml, letterheadDocument, parseXml, LETTER, A4 } from "@/lib/letterhead";
import { watchLines } from "@/lib/turnoverPlan";
import type { ShiftReport, ShiftRow } from "@/lib/shiftReport";

const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"`;
// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const logo = (cx: number, cy: number) => `<w:r><w:drawing><wp:anchor behindDoc="1"><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
const line = (t: string) => `<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Lato"/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const bar = `<w:p><w:r><w:drawing><wp:anchor><wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>9601200</wp:posOffset></wp:positionV><wp:extent cx="7772400" cy="91440"/><a:graphic><a:graphicData><wps:wsp><wps:spPr><a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="1f3864"/></a:solidFill></wps:spPr></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>`;
const rels = (img: boolean) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${img ? `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/>` : ""}</Relationships>`;

async function docx(o: { titlePg?: boolean; footer?: boolean } = {}) {
  const z = new JSZip();
  z.file("word/document.xml", `<?xml version="1.0"?><w:document ${W}><w:body><w:p/><w:sectPr>
    <w:headerReference w:type="default" r:id="rH1"/>${o.titlePg ? `<w:headerReference w:type="first" r:id="rH2"/>` : ""}${o.footer ? `<w:footerReference w:type="default" r:id="rF1"/>` : ""}
    <w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="2462" w:right="1440" w:bottom="1152" w:left="1440" w:header="720" w:footer="720"/>${o.titlePg ? "<w:titlePg/>" : ""}</w:sectPr></w:body></w:document>`);
  z.file("word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rH1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
    <Relationship Id="rH2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header2.xml"/>
    <Relationship Id="rF1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`);
  // Pages after the first: the logo alone. Page 1: logo, address, phone.
  z.file("word/header1.xml", `<?xml version="1.0"?><w:hdr ${W}><w:p>${logo(2101215, 709295)}</w:p></w:hdr>`);
  z.file("word/header2.xml", `<?xml version="1.0"?><w:hdr ${W}><w:p><w:pPr><w:jc w:val="right"/></w:pPr>${logo(2101215, 709295)}<w:r><w:rPr><w:rFonts w:ascii="Lato"/><w:sz w:val="20"/></w:rPr><w:t>7724 E. Panama Lane</w:t></w:r></w:p>${line("Bakersfield, CA  93307")}${line("&lt;b&gt;www.example.com&lt;/b&gt;")}</w:hdr>`);
  z.file("word/footer1.xml", `<?xml version="1.0"?><w:ftr ${W}>${bar}${line("Page footer")}</w:ftr>`);
  z.file("word/_rels/header1.xml.rels", rels(true));
  z.file("word/_rels/header2.xml.rels", rels(true));
  z.file("word/_rels/footer1.xml.rels", rels(false));
  z.file("word/media/logo.png", PNG);
  return z.generateAsync({ type: "uint8array" });
}

describe("a Word letterhead", () => {
  it("takes Word's page and margins — the report goes where Word's text would", async () => {
    const lh = await letterheadFromDocx(await docx({ titlePg: true }), "Kern.docx");
    expect(lh.page).toEqual(LETTER);
    expect(lh.margins).toEqual({ top: 1.71, bottom: 0.8, left: 1, right: 1 });
  });
  it("page 1 gets its own header (logo, address); the pages after, the other (logo only)", async () => {
    const lh = await letterheadFromDocx(await docx({ titlePg: true }), "Kern.docx");
    // The logo, placed where Word puts it: at the margin, at the header's top, its own size.
    expect(lh.layer.floats).toHaveLength(1);
    expect(lh.layer.floats![0]).toMatchObject({ x: 1, y: 0.5 });
    expect(lh.layer.floats![0].w).toBeCloseTo(2.298, 2);
    expect(lh.layer.floats![0].src).toMatch(/^data:image\/png;base64,/);
    expect(lh.layer.header).toBeUndefined();
    const head = lh.first!.header!;
    expect(head.top).toBe(0.5);
    expect(head.items.map((it) => ("p" in it ? it.p.runs.map((r) => r.t ?? "").join("") : ""))).toEqual(["7724 E. Panama Lane", "Bakersfield, CA  93307", "<b>www.example.com</b>"]);
    expect("p" in head.items[0] && head.items[0].p).toMatchObject({ align: "right", runs: [{ t: "7724 E. Panama Lane", font: "Lato", pt: 10 }] });
  });
  it("one header for every page when page 1 has no header of its own", async () => {
    const lh = await letterheadFromDocx(await docx(), "Plain.docx");
    expect(lh.first).toBeUndefined();
    expect(letterheadLayersHtml(lh).first).toBe("");
  });
  it("footers and coloured bars: the bar placed on the page, the report kept above it", async () => {
    const lh = await letterheadFromDocx(await docx({ footer: true }), "Bar.docx");
    const fill = lh.layer.floats!.find((f) => f.fill);
    expect(fill).toMatchObject({ x: 0, y: 10.5, fill: "1F3864" });
    expect(lh.layer.footer!.bottom).toBe(0.5);
    // Past the bar (it ends 0.4" up from the bottom … 0.5" + 0.15 clear).
    expect(lh.margins.bottom).toBeGreaterThanOrEqual(0.8);
  });
  it("text is escaped when drawn — a letterhead can't put markup on the page", async () => {
    const lh = cleanLetterhead(await letterheadFromDocx(await docx({ titlePg: true }), "Kern.docx"))!;
    const html = layerHtml(lh.first!, lh.page);
    expect(html).toContain("&lt;b&gt;www.example.com&lt;/b&gt;");
    expect(html).not.toContain("<b>www");
  });
  it("not a Word file: says so", async () => {
    const z = new JSZip(); z.file("x.txt", "hi");
    await expect(letterheadFromDocx(await z.generateAsync({ type: "uint8array" }), "x.docx")).rejects.toThrow(/isn't a Word file/);
  });
});

describe("a saved letterhead is checked when it's read back", () => {
  const ok = { v: 1, name: "L", kind: "pdf", page: LETTER, margins: { top: 1.5, bottom: 0.8, left: 0.9, right: 0.9 }, layer: { image: "data:image/jpeg;base64,AAAA" } };
  it("a good one passes", () => expect(cleanLetterhead(ok)).toMatchObject({ kind: "pdf", pages: "all" }));
  it("pictures must be pictures — no scripts, no links", () => {
    expect(cleanLetterhead({ ...ok, layer: { image: "javascript:alert(1)" } })!.layer.image).toBeUndefined();
    const f = cleanLetterhead({ ...ok, layer: { floats: [{ x: 0, y: 0, w: 1, h: 1, src: "https://evil.example/x.png" }, { x: 0, y: 0, w: 1, h: 1, src: "data:image/svg+xml;base64,AAAA" }] } });
    expect(f!.layer.floats).toBeUndefined();
  });
  it("fonts and colours plain; margins inside the page", () => {
    const c = cleanLetterhead({ ...ok, margins: { top: 99, bottom: -3, left: 1, right: 1 }, layer: { header: { x: 1, w: 6.5, top: 0.5, items: [{ p: { runs: [{ t: "x", font: "Lato'};<script>", color: "red;background:url(x)" }] } }] } } })!;
    expect(c.margins.top).toBe(5.5);
    expect(c.margins.bottom).toBe(0);
    const run = "p" in c.layer.header!.items[0] ? c.layer.header!.items[0].p.runs[0] : null;
    expect(run).toEqual({ t: "x" });
  });
  it("not a letterhead: null", () => {
    expect(cleanLetterhead(null)).toBeNull();
    expect(cleanLetterhead({ v: 2 })).toBeNull();
    expect(cleanLetterhead({ ...ok, page: { w: 0, h: 0 } })).toBeNull();
  });
});

describe("a picture of the page", () => {
  // 85 × 110 px page (10 px to the inch): a dark header band, a footer band.
  const page = (bands: Array<[number, number]>, faint: Array<[number, number]> = []) => {
    const W = 85, H = 110, px = new Uint8ClampedArray(W * H * 4).fill(255);
    const paint = ([a, b]: [number, number], g: number) => { for (let y = a; y < b; y++) for (let x = 5; x < 80; x++) { const i = (y * W + x) * 4; px[i] = px[i + 1] = px[i + 2] = g; } };
    bands.forEach((b) => paint(b, 20));
    faint.forEach((b) => paint(b, 235));
    return { px, W, H };
  };
  it("the report goes below the header and above the footer", () => {
    const { px, W, H } = page([[5, 14], [102, 106]]);
    const m = blankArea(px, W, H, LETTER);
    expect(m.top).toBeCloseTo(1.4 + 0.2, 1);
    expect(m.bottom).toBeCloseTo(0.8 + 0.2, 1);
  });
  it("a faint watermark in the middle doesn't count", () => {
    const { px, W, H } = page([[5, 14]], [[40, 70]]);
    expect(blankArea(px, W, H, LETTER).top).toBeCloseTo(1.6, 1);
  });
  it("letter or A4 by its shape", () => {
    expect(paperFor(1275, 1650)).toEqual(LETTER);
    expect(paperFor(1240, 1754)).toEqual(A4);
  });
});

describe("the printed page", () => {
  it("the letterhead behind every page, the report inside the margins on every page", () => {
    const lh = cleanLetterhead({ v: 1, name: "L", kind: "pdf", page: LETTER, margins: { top: 1.5, bottom: 0.8, left: 0.9, right: 0.9 }, layer: { image: "data:image/jpeg;base64,AAAA" } })!;
    const doc = letterheadDocument(lh, "Report <1>", "<p>Body</p>");
    expect(doc).toContain("@page{size:8.5in 11in;margin:0}");
    expect(doc).toContain(".lh-frame>thead>tr>td{height:1.5in");
    expect(doc).toContain("padding:0 0.9in 0 0.9in");
    expect(doc).toContain("<title>Report &lt;1&gt;</title>");
    expect(doc).toContain('<div class="lh-layer"><img src="data:image/jpeg;base64,AAAA"');
  });
  it("page 1 only: no repeating letterhead", () => {
    const lh = cleanLetterhead({ v: 1, name: "L", kind: "pdf", pages: "first", page: LETTER, margins: { top: 1.5, bottom: 0.8, left: 0.9, right: 0.9 }, layer: { image: "data:image/jpeg;base64,AAAA" } })!;
    const l = letterheadLayersHtml(lh);
    expect(l.every).toBe("");
    expect(l.first).toContain("data:image/jpeg");
  });
  it("reads Word's XML: entities, nesting, self-closing tags", () => {
    const x = parseXml(`<?xml version="1.0"?><a x="1 &amp; 2"><b/><c>Tom &amp; Jerry &#8212; ok</c></a>`);
    expect(x.kids[0].attrs.x).toBe("1 & 2");
    expect(x.kids[0].kids.map((k) => k.name)).toEqual(["b", "c"]);
    expect(x.kids[0].kids[1].text).toBe("Tom & Jerry — ok");
  });
});

describe("what to watch on the next shift", () => {
  const row = (id: string, name: string, parentName: string, o: Partial<ShiftRow> = {}) =>
    ({ leaf: { id, name }, parentName, waitingOn: [], carryOver: false, critical: false, ...o } as unknown as ShiftRow);
  const report = { overall: { drivers: { ahead: [], behind: [{ id: "om", hours: 20.3 }, { id: "h17", hours: 4 }, { id: "h12", hours: 4 }] } } } as unknown as ShiftReport;
  const rows = [
    row("h17", "Hydroblast 10K Tubes and Shell", "E-17 - Exchanger No. 1", { carryOver: true, waitingOn: [{ id: "pb", name: "Pull Bundle" }] }),
    row("h12", "Hydroblast 10K Tubes and Shell", "E-12 - Exchanger No. 2", { carryOver: true, waitingOn: [{ id: "ins", name: "Complete 100% Tube and Shell Inspection" }] }),
    row("om", "Open Internal Manways", "V-7 - Transmix Fractionator", { critical: true }),
    row("ct", "Clean Tower (Orbijet Internals)", "V-7 - Transmix Fractionator", { critical: true, waitingOn: [{ id: "om", name: "Open Internal Manways" }] }),
  ];
  const num = (id: string | null | undefined) => ({ h17: 1, h12: 2, om: 3, ct: 4 } as Record<string, number>)[id ?? ""];
  it("badly behind (and what waits on it), carried over (and what it waits on), how much is critical", () => {
    expect(watchLines(rows, report, { hrs: (h) => `${h} h` }, num)).toEqual([
      { tone: "rose", strong: "V-7 Open Internal Manways is 20.3 h behind", rest: " — Clean Tower (Orbijet Internals) can't start until it's done, and it's on the critical path." },
      { tone: "amber", strong: "2 carried over from earlier shifts", rest: " — both wait on steps not on this list (Pull Bundle, Complete 100% Tube and Shell Inspection)." },
      { tone: "slate", strong: "2 of 4 steps are critical", rest: " — #3, #4." },
    ]);
  });
  it("a quiet list: nothing to watch", () => {
    expect(watchLines([row("a", "Inspect", "E-1 - Cooler")], { overall: { drivers: { ahead: [], behind: [] } } } as unknown as ShiftReport, { hrs: (h) => `${h} h` }, () => 1)).toEqual([]);
  });
});
