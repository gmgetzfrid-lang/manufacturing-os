// noteFiles - a day's notes from a file, for Update by note: what someone
// typed out all shift (text, Word, Excel, PDF) read here in the browser, and
// pictures (a photo of a notebook page, a scanned PDF page) handed back as
// images for the AI to copy out word for word. Either way the words land in
// the note box first, where they can be read and fixed before anything is
// matched to a step.
//
// Browser-only (canvas, pdf.js).

export interface NoteFile {
  name: string;
  /** The words, as typed in the file. */
  text: string;
  /** Pages to be copied out (photos, scanned PDF pages), as JPEG. */
  images: Array<{ base64: string; mediaType: "image/jpeg" }>;
}

const MAX_PAGES = 15;
const MAX_IMAGES = 8;
const TEXT_EXT = /\.(txt|text|md|log|csv|tsv|rtf)$/i;

/** A picture, made small enough to send (long side 1600 px), as JPEG. */
async function jpegOf(source: CanvasImageSource, w: number, h: number): Promise<string> {
  const k = Math.min(1, 1600 / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("This browser can't read pictures.");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85).split(",")[1] ?? "";
}

async function imageFile(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error("That picture couldn't be opened. iPhone HEIC photos: share them as JPEG, or take a screenshot.")); img.src = url; });
    return await jpegOf(img, img.naturalWidth, img.naturalHeight);
  } finally { URL.revokeObjectURL(url); }
}

/** Word: the body's paragraphs, tabs and line breaks kept. */
async function docxText(file: File): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) throw new Error("That Word file has no text in it.");
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Excel: every sheet, one line per row, cells split by " | ". */
async function sheetText(file: File): Promise<string> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  return wb.SheetNames.map((n) => {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[n], { FS: " | ", blankrows: false }).split("\n").map((l) => l.replace(/(\s*\|\s*)+$/, "").trim()).filter(Boolean).join("\n");
    return wb.SheetNames.length > 1 ? `${n}\n${csv}` : csv;
  }).join("\n\n").trim();
}

/** PDF: each page's words; a page with none (a scan) as a picture. */
async function pdfText(file: File): Promise<{ text: string; images: string[] }> {
  const { pdfjs } = await import("react-pdf");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const { PDFJS_VERBOSITY } = await import("@/lib/pdfjsConfig");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), verbosity: PDFJS_VERBOSITY }).promise;
  const texts: string[] = [], images: string[] = [];
  try {
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES); i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      // Lines by their height on the page.
      let line = "", lastY: number | null = null;
      const lines: string[] = [];
      for (const it of tc.items as Array<{ str?: string; transform?: number[] }>) {
        const y = it.transform?.[5] ?? null;
        if (lastY != null && y != null && Math.abs(y - lastY) > 2) { lines.push(line.trim()); line = ""; }
        line += `${it.str ?? ""} `;
        lastY = y;
      }
      if (line.trim()) lines.push(line.trim());
      const words = lines.filter(Boolean).join("\n");
      if (words.replace(/\s/g, "").length >= 40) { texts.push(words); continue; }
      if (images.length >= MAX_IMAGES) continue;
      const vp = page.getViewport({ scale: 2 });
      const c = document.createElement("canvas");
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext("2d");
      if (!ctx) continue;
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
      images.push(await jpegOf(c, c.width, c.height));
    }
  } finally { void doc.destroy(); }
  return { text: texts.join("\n\n"), images };
}

/** Read one file into words, and pictures still to be copied out. */
export async function readNoteFile(file: File): Promise<NoteFile> {
  const name = file.name || "file";
  const jpeg = (b: string) => ({ base64: b, mediaType: "image/jpeg" as const });
  if (file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(name)) return { name, text: "", images: [jpeg(await imageFile(file))] };
  if (/\.docx$/i.test(name)) return { name, text: await docxText(file), images: [] };
  if (/\.(xlsx|xlsm|xls)$/i.test(name)) return { name, text: await sheetText(file), images: [] };
  if (/\.pdf$/i.test(name) || file.type === "application/pdf") { const r = await pdfText(file); return { name, text: r.text, images: r.images.map(jpeg) }; }
  if (TEXT_EXT.test(name) || file.type.startsWith("text/")) {
    const t = await file.text();
    // Rich text: the words, not the codes.
    return { name, text: /\.rtf$/i.test(name) ? t.replace(/\\[a-z]+-?\d* ?|[{}]/g, "").trim() : t.trim(), images: [] };
  }
  if (/\.doc$/i.test(name)) throw new Error(`${name}: old Word (.doc) can't be read here. Save it as .docx or PDF and add it again.`);
  throw new Error(`${name}: that kind of file can't be read. Use a text file, Word (.docx), Excel, PDF or a photo.`);
}
