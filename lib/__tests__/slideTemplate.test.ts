import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { EMU, fitPt, leanTemplate, lineCount, readTemplate, roomOf, templateColors, templateFonts, layoutFor } from "@/lib/slideTemplate";
import { deckOnTemplate, testSlides } from "@/lib/reviewTemplateDeck";
import { lookFromPalette, lookFromTemplate } from "@/lib/deckLook";
import { contrast } from "@/lib/brandColors";

// A company template made the way PowerPoint files are: a master with a
// cover, a section and a content layout, sample slides with notes, and a
// macro part that must never be carried over.
async function companyTemplate(): Promise<Uint8Array> {
  const Pptx = (await import("pptxgenjs")).default;
  const p = new Pptx();
  p.layout = "LAYOUT_WIDE";
  p.defineSlideMaster({ title: "Title", objects: [{ placeholder: { options: { name: "title", type: "title", x: 1, y: 2, w: 8, h: 1.2 }, text: "" } }, { rect: { x: 0, y: 6.8, w: 13.33, h: 0.7, fill: { color: "0B1F6B" } } }] });
  p.defineSlideMaster({ title: "Section Header", objects: [{ placeholder: { options: { name: "title", type: "title", x: 6, y: 3, w: 6, h: 1.2 }, text: "" } }, { placeholder: { options: { name: "sub", type: "body", x: 6, y: 4.3, w: 6, h: 0.6 }, text: "" } }] });
  p.defineSlideMaster({ title: "Title and Content", objects: [{ placeholder: { options: { name: "title", type: "title", x: 0.6, y: 0.4, w: 12, h: 0.9 }, text: "" } }, { placeholder: { options: { name: "body", type: "body", x: 0.6, y: 1.5, w: 12, h: 5 }, text: "" } }, { rect: { x: 12, y: 1.5, w: 1, h: 1, fill: { color: "D4A017" } } }] });
  p.addSlide({ masterName: "Title" }).addText("Sample cover", { placeholder: "title" });
  const s2 = p.addSlide({ masterName: "Title and Content" });
  s2.addText("Sample content", { placeholder: "title" });
  s2.addNotes("Sample notes");
  const zip = await JSZip.loadAsync((await p.write({ outputType: "nodebuffer" })) as Buffer);
  // A section list and a macro: both are dropped on upload.
  let pres = await zip.file("ppt/presentation.xml")!.async("string");
  pres = pres.replace("</p:presentation>", '<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><p14:section name="A" id="{00000000-0000-0000-0000-000000000001}"><p14:sldIdLst><p14:sldId id="256"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst></p:presentation>');
  zip.file("ppt/presentation.xml", pres);
  zip.file("ppt/vbaProject.bin", "MACRO");
  const rels = await zip.file("ppt/_rels/presentation.xml.rels")!.async("string");
  zip.file("ppt/_rels/presentation.xml.rels", rels.replace("</Relationships>", '<Relationship Id="rIdVba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>'));
  return zip.generateAsync({ type: "uint8array" });
}

describe("a company slide template", () => {
  it("keeps the layouts and drops the sample slides, notes, sections and macros", async () => {
    const { data, info } = await leanTemplate(await companyTemplate());
    const z = await JSZip.loadAsync(data);
    const names = Object.keys(z.files);
    expect(names.some((n) => n.startsWith("ppt/slides/"))).toBe(false);
    expect(names.some((n) => n.startsWith("ppt/notesSlides/"))).toBe(false);
    expect(names).not.toContain("ppt/vbaProject.bin");
    expect(names.filter((n) => /slideLayouts\/slideLayout\d+\.xml$/.test(n)).length).toBe(info.layouts.length);
    const pres = await z.file("ppt/presentation.xml")!.async("string");
    expect(pres).not.toMatch(/sldIdLst|sectionLst/);
    const types = await z.file("[Content_Types].xml")!.async("string");
    expect(types).not.toMatch(/slides\/slide|notesSlide|vbaProject/);
    expect(await z.file("ppt/_rels/presentation.xml.rels")!.async("string")).not.toMatch(/vbaProject|slides\/slide/);
  });

  it("picks a layout for each kind of slide by its name and its room", async () => {
    const { info } = await leanTemplate(await companyTemplate());
    const name = (role: "cover" | "section" | "content") => layoutFor(info, role)?.name;
    expect(name("cover")).toBe("Title");
    expect(name("section")).toBe("Section Header");
    expect(name("content")).toBe("Title and Content");
    expect(info.roles.agenda).toBeUndefined();
    // The room for tables is the content layout's body box, clear of its marks.
    const room = layoutFor(info, "content")!.room!;
    expect(room.y / EMU).toBeCloseTo(1.5, 1);
    // The gold mark in its top right corner is kept clear.
    expect((room.x + room.w) / EMU).toBeLessThanOrEqual(12);
    // An admin's pick wins; "none" leaves a kind out.
    expect(layoutFor(info, "content", { content: layoutFor(info, "cover")!.file })?.name).toBe("Title");
    expect(layoutFor(info, "section", { section: "none" })).toBeNull();
  });

  it("writes a deck onto the layouts: every slide on a real layout, listed, typed, with its notes", async () => {
    const { data, info } = await leanTemplate(await companyTemplate());
    const l = layoutFor(info, "content")!;
    const out = await deckOnTemplate(testSlides(info), { info, data, look: lookFromTemplate({ colors: templateColors(l), fonts: templateFonts(l) }), title: "Test deck" });
    const z = await JSZip.loadAsync(out);
    const slides = Object.keys(z.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    // Cover, the measures table, two part openers, the table, the actions.
    expect(slides.length).toBe(6);
    const pres = await z.file("ppt/presentation.xml")!.async("string");
    expect(pres.match(/<p:sldId /g)?.length).toBe(6);
    const presRels = await z.file("ppt/_rels/presentation.xml.rels")!.async("string");
    const types = await z.file("[Content_Types].xml")!.async("string");
    for (let i = 1; i <= 6; i++) {
      const rels = await z.file(`ppt/slides/_rels/slide${i}.xml.rels`)!.async("string");
      const layout = rels.match(/slideLayouts\/(slideLayout\d+\.xml)/)![1];
      expect(z.file(`ppt/slideLayouts/${layout}`)).toBeTruthy();
      expect(presRels).toContain(`Target="slides/slide${i}.xml"`);
      expect(types).toContain(`/ppt/slides/slide${i}.xml`);
    }
    const cover = await z.file("ppt/slides/slide1.xml")!.async("string");
    expect(cover).toContain("Your template, laid out by the app");
    expect(cover).toMatch(/<p:ph type="title"/);
    expect(await z.file("ppt/notesSlides/notesSlide1.xml")!.async("string")).toContain("Each kind of slide");
    // The table is drawn in the template's main color.
    const table = await z.file("ppt/slides/slide4.xml")!.async("string");
    expect(table).toContain("<a:tbl>");
    expect(table).toMatch(/<p:ph type="title"/);
    expect(table).toContain(`<a:srgbClr val="${templateColors(l).main}"/>`);
    // Each part opens on the section layout with its number.
    expect(await z.file("ppt/slides/slide5.xml")!.async("string")).toContain("Part 2 of 2");
  });

  it("takes a .potx template and writes a presentation", async () => {
    const z = await JSZip.loadAsync(await companyTemplate());
    const types = await z.file("[Content_Types].xml")!.async("string");
    const potx = types.replace(/presentationml\.presentation\.main\+xml/, "presentationml.template.main+xml");
    expect(potx).toContain("template.main");
    z.file("[Content_Types].xml", potx);
    const { data } = await leanTemplate(await z.generateAsync({ type: "uint8array" }));
    const lean = await (await JSZip.loadAsync(data)).file("[Content_Types].xml")!.async("string");
    expect(lean).toContain("presentationml.presentation.main+xml");
    expect(lean).not.toContain("template.main");
  });

  it("refuses a file that isn't PowerPoint", async () => {
    await expect(leanTemplate(new TextEncoder().encode("not a zip"))).rejects.toThrow(/PowerPoint/);
    const z = new JSZip(); z.file("word/document.xml", "<w:document/>");
    await expect(leanTemplate(await z.generateAsync({ type: "uint8array" }))).rejects.toThrow(/PowerPoint/);
  });

  it("reads a template it stored before", async () => {
    const { data, info } = await leanTemplate(await companyTemplate());
    const again = await readTemplate(await JSZip.loadAsync(data));
    expect(again.roles).toEqual(info.roles);
  });
});

describe("fitting words", () => {
  it("counts lines by words and shrinks a title until it fits its box", () => {
    expect(lineCount("short", 5, 20)).toBe(1);
    expect(lineCount("a much longer line of words that will not fit on one line", 2, 20)).toBeGreaterThan(2);
    const box = { x: 0, y: 0, w: 6 * EMU, h: 1 * EMU };
    const pt = fitPt("Contractors cost 28 of the 46 h, Execution 16 h, Planning 2 h.", box, 74, 14, 0.6, 1.25);
    expect(pt).toBeLessThan(40);
    expect(lineCount("Contractors cost 28 of the 46 h, Execution 16 h, Planning 2 h.", 5.8, pt, 0.6) * pt * 1.25 / 72).toBeLessThanOrEqual(0.9);
  });
});

describe("slide colors", () => {
  it("the workspace's colors: a deep table head under white text, the accent kept for the small mark", () => {
    const l = lookFromPalette({ primary: "#0b1f6b", secondary: "#d4a017" });
    expect(contrast(`#${l.head}`, "#ffffff")).toBeGreaterThan(7);
    expect(contrast(`#${l.heading}`, "#ffffff")).toBeGreaterThan(7);
    expect(l.accent).not.toBe(l.head);
  });
  it("a template's colors: its readable main color carries heads and titles", () => {
    const c = templateColors({ theme: { dk1: "000000", lt1: "FFFFFF", dk2: "000000", accent1: "000A71", accent2: "60A8E6", accent3: "FFBD59", accent4: "138D77" } } as never);
    expect(c.main).toBe("000A71");
    expect(["FFBD59", "138D77"]).toContain(c.accent);
    const l = lookFromTemplate({ colors: c, fonts: { title: "League Spartan", body: "Lato" } });
    expect(l.head).toBe("000A71");
    expect(l.font).toBe("Lato");
    // A light main color is darkened until white text reads on it.
    const light = lookFromTemplate({ colors: { main: "60A8E6", accent: "FFBD59", swatches: [] }, fonts: { title: "A", body: "B" } });
    expect(contrast(`#${light.head}`, "#ffffff")).toBeGreaterThan(4.5);
  });
});

void roomOf;

describe("the slides on screen are the file's slides", () => {
  it("draws each slide of the deck: the layout's artwork, the filled titles, the tables", async () => {
    const { renderDeck } = await import("@/lib/slideRender");
    const { data, info } = await leanTemplate(await companyTemplate());
    const l = layoutFor(info, "content")!;
    const out = await deckOnTemplate(testSlides(info), { info, data, look: lookFromTemplate({ colors: templateColors(l), fonts: templateFonts(l) }), title: "Test deck", forScreen: true, slideOf: [] });
    const view = await renderDeck(out, (part) => `blob:${part}`);
    expect(view.slides.length).toBe(6);
    expect(view.w).toBeCloseTo(1280, 0);
    expect(view.slides[0]).toContain("Your template, laid out by the app");
    // The content layout's gold mark is drawn on every content slide.
    expect(view.slides[3]).toContain("rgba(212,160,23,1.000)");
    expect(view.slides[3]).toContain("<table");
    expect(view.slides[3]).toMatch(/<tr data-row="0"/);
    // Text is escaped, never markup.
    expect(view.slides.join("")).not.toMatch(/<script/i);
  });

  it("escapes what the slides say", async () => {
    const { renderDeck } = await import("@/lib/slideRender");
    const { data, info } = await leanTemplate(await companyTemplate());
    const specs = testSlides(info);
    specs[0] = { ...specs[0], title: "<img src=x onerror=alert(1)> & co" };
    const out = await deckOnTemplate(specs, { info, data, look: lookFromPalette({ primary: "#0b1f6b", secondary: "#d4a017" }), title: "t", forScreen: true });
    const view = await renderDeck(out, (part) => `blob:${part}`);
    expect(view.slides[0]).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; co");
    expect(view.slides[0]).not.toContain("<img src=x");
  });
});
