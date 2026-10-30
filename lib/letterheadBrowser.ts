// letterheadBrowser — reading an uploaded letterhead in the browser: a
// Word file's header and footer (pictures shrunk to print size), or a
// picture of the page from a PDF or an image, with the blank part found.

import { A4, LETTER, blankArea, letterheadFromDocx, paperFor, type LhItem, type LhLayer, type Letterhead } from "@/lib/letterhead";

/** Kept with the project's settings: past this it's too big to share. */
const MAX_BYTES = 1_500_000;
/** Print resolution for pictures of the page. */
const DPI = 150;

const loadImage = (src: string) => new Promise<HTMLImageElement>((ok, fail) => {
  const im = new Image();
  im.onload = () => ok(im);
  im.onerror = () => fail(new Error("That picture couldn't be read."));
  im.src = src;
});
const fileUrl = (f: Blob) => new Promise<string>((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result));
  r.onerror = () => fail(new Error("The file couldn't be read."));
  r.readAsDataURL(f);
});

/** A picture no bigger than it prints (300 dpi at its size on the page). */
async function shrink(src: string, wIn: number): Promise<string> {
  try {
    const im = await loadImage(src);
    const max = Math.round(wIn * 300);
    if (im.naturalWidth <= max * 1.1) return src;
    const c = document.createElement("canvas");
    c.width = max;
    c.height = Math.max(1, Math.round(im.naturalHeight * (max / im.naturalWidth)));
    const ctx = c.getContext("2d");
    if (!ctx) return src;
    ctx.drawImage(im, 0, 0, c.width, c.height);
    const png = c.toDataURL("image/png");
    return png.length < src.length ? png : src;
  } catch { return src; }
}

async function shrinkItems(items: LhItem[]): Promise<void> {
  for (const it of items) {
    if ("p" in it) { for (const r of it.p.runs) if (r.img) r.img.src = await shrink(r.img.src, r.img.w); }
    else for (const row of it.table.rows) for (const cell of row.cells) await shrinkItems(cell.items);
  }
}
async function shrinkLayer(l: LhLayer | undefined): Promise<void> {
  if (!l) return;
  for (const f of l.floats ?? []) { if (f.src) f.src = await shrink(f.src, f.w); if (f.items) await shrinkItems(f.items); }
  if (l.header) await shrinkItems(l.header.items);
  if (l.footer) await shrinkItems(l.footer.items);
}

/** A picture of the page → a letterhead: the picture on every page, the
 *  report in its blank part. */
function fromCanvas(c: HTMLCanvasElement, page: { w: number; h: number }, name: string, kind: "pdf" | "image"): Letterhead {
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser can't read the page.");
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  const margins = blankArea(data, c.width, c.height, page);
  let image = c.toDataURL("image/jpeg", 0.88);
  if (image.length > MAX_BYTES) image = c.toDataURL("image/jpeg", 0.7);
  return { v: 1, name, kind, page, margins, layer: { image }, pages: "all" };
}

async function fromPdf(file: File): Promise<Letterhead> {
  const { pdfjs } = await import("react-pdf");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const { PDFJS_VERBOSITY } = await import("@/lib/pdfjsConfig");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), verbosity: PDFJS_VERBOSITY }).promise;
  try {
    const p1 = await doc.getPage(1);
    const base = p1.getViewport({ scale: 1 });
    const page = { w: Math.round((base.width / 72) * 100) / 100, h: Math.round((base.height / 72) * 100) / 100 };
    const vp = p1.getViewport({ scale: DPI / 72 });
    const c = document.createElement("canvas");
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("This browser can't draw the PDF.");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
    await p1.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
    // A PDF page close to letter or A4 prints on that paper.
    const near = (a: { w: number; h: number }) => Math.abs(a.w - page.w) < 0.15 && Math.abs(a.h - page.h) < 0.15;
    return fromCanvas(c, near(LETTER) ? LETTER : near(A4) ? A4 : page, file.name, "pdf");
  } finally { void doc.destroy(); }
}

async function fromImage(file: File): Promise<Letterhead> {
  const im = await loadImage(await fileUrl(file));
  const page = paperFor(im.naturalWidth, im.naturalHeight);
  const c = document.createElement("canvas");
  const scale = Math.min(1, (page.w * DPI) / im.naturalWidth);
  c.width = Math.round(im.naturalWidth * scale); c.height = Math.round(im.naturalHeight * scale);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser can't read the picture.");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(im, 0, 0, c.width, c.height);
  return fromCanvas(c, page, file.name, "image");
}

/** Read an uploaded letterhead: Word (.docx), PDF, or a picture. */
export async function readLetterheadFile(file: File): Promise<Letterhead> {
  const name = file.name.toLowerCase();
  let lh: Letterhead;
  if (name.endsWith(".docx")) {
    lh = await letterheadFromDocx(await file.arrayBuffer(), file.name);
    await shrinkLayer(lh.layer);
    await shrinkLayer(lh.first);
    const empty = (l?: LhLayer) => !l || (!l.header && !l.footer && !(l.floats ?? []).length);
    if (empty(lh.layer) && empty(lh.first)) throw new Error("That Word file has no header or footer - put the letterhead in the header (Insert › Header), or upload it as a PDF.");
  } else if (name.endsWith(".doc")) {
    throw new Error("That's an old Word file (.doc). Open it in Word and Save As .docx - or save it as a PDF.");
  } else if (name.endsWith(".pdf") || file.type === "application/pdf") {
    lh = await fromPdf(file);
  } else if (/\.(png|jpe?g|webp)$/.test(name) || /^image\//.test(file.type)) {
    lh = await fromImage(file);
  } else {
    throw new Error("Upload the letterhead as a Word file (.docx), a PDF, or a picture (PNG or JPG).");
  }
  if (JSON.stringify(lh).length > MAX_BYTES * 1.4) throw new Error("That letterhead is too big to share - try a PDF of just the one page, or a smaller picture.");
  return lh;
}
