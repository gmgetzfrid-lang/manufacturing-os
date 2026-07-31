// lib/docxRender.ts — SERVER-ONLY. Render finished documents by INJECTING
// content into the user's own template file.
//
// The whole reliability argument for this feature lives here: a .docx is a
// zip of XML that already contains the fonts, colours, table styles,
// headers, footers and logos. We never regenerate any of that — we open the
// template, fill its {placeholders}, and write the same file back out. The
// model supplies words; the template supplies every pixel of formatting, so
// output cannot drift from house style.
//
// docxtemplater handles the ugly part: Word splits a single typed
// "{scope}" across several <w:r> runs (spellcheck, tracked formatting), so
// naive string replacement misses tags at random. It normalizes runs first.
//
// Excel templates render through the same path — xlsx workbooks are also
// zipped XML and docxtemplater's raw-text mode fills them the same way.

import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";

export interface RenderError {
  /** The tag or region that failed, when the library reports one. */
  tag?: string;
  message: string;
}

export class TemplateRenderError extends Error {
  constructor(message: string, public readonly details: RenderError[]) {
    super(message);
    this.name = "TemplateRenderError";
  }
}

type DocxError = {
  message?: string;
  properties?: {
    id?: string;
    explanation?: string;
    errors?: DocxError[];
    postparsed?: unknown;
    xtag?: string;
  };
};

function flattenErrors(e: unknown): RenderError[] {
  const err = e as DocxError;
  const nested = err?.properties?.errors;
  if (Array.isArray(nested) && nested.length > 0) {
    return nested.flatMap((n) => flattenErrors(n));
  }
  return [{
    tag: err?.properties?.xtag,
    message: err?.properties?.explanation || err?.message || "Template error",
  }];
}

/** Fill a .docx/.xlsx template with values and return the rendered bytes.
 *  Unresolved tags render EMPTY rather than throwing — a missing optional
 *  field should not cost someone a 200-document batch. */
export function renderTemplate(
  templateBytes: Uint8Array | Buffer,
  data: Record<string, unknown>,
): Uint8Array {
  let zip: PizZip;
  try {
    zip = new PizZip(templateBytes);
  } catch {
    throw new TemplateRenderError(
      "That file isn't a readable Word/Excel document (it may be .doc, a PDF renamed, or corrupt).",
      [{ message: "zip open failed" }],
    );
  }

  let doc: Docxtemplater;
  try {
    doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,                       // "\n" in drafted prose = real breaks
      nullGetter: () => "",                   // blanks, never "undefined"
    });
  } catch (e) {
    throw new TemplateRenderError(
      "The template's placeholders couldn't be parsed — check for an unclosed { or a stray brace.",
      flattenErrors(e),
    );
  }

  try {
    doc.render(data);
  } catch (e) {
    const details = flattenErrors(e);
    throw new TemplateRenderError(
      `The template failed to render: ${details.map((d) => d.tag ? `{${d.tag}} — ${d.message}` : d.message).join("; ")}`,
      details,
    );
  }

  return doc.getZip().generate({ type: "uint8array", compression: "DEFLATE" }) as Uint8Array;
}

/** Read every scrap of text out of a .docx (document body, headers,
 *  footers) — used to detect placeholders in a template and to distill an
 *  example document into a style guide. */
export function extractDocxText(bytes: Uint8Array | Buffer): string {
  let zip: PizZip;
  try {
    zip = new PizZip(bytes);
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const name of Object.keys(zip.files)) {
    if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) continue;
    const xml = zip.files[name].asText();
    // Paragraph and break boundaries become newlines so structure survives;
    // everything else is stripped to plain text.
    const text = xml
      .replace(/<w:p[ >]/g, "\n<w:p ")
      .replace(/<w:br\s*\/>/g, "\n")
      .replace(/<w:tab\s*\/>/g, "\t")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n");
    if (text.trim()) parts.push(text.trim());
  }
  return parts.join("\n\n");
}

/** Same idea for .xlsx: pull shared strings + inline text so placeholders
 *  inside spreadsheet templates are discoverable. */
export function extractXlsxText(bytes: Uint8Array | Buffer): string {
  try {
    const zip = new PizZip(bytes);
    const parts: string[] = [];
    for (const name of Object.keys(zip.files)) {
      if (!/^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(name)) continue;
      const text = zip.files[name].asText()
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/\s+/g, " ");
      if (text.trim()) parts.push(text.trim());
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}
