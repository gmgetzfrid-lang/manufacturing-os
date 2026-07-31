// lib/drawingLocate.ts — "where on this sheet is V-3?"
//
// Text-layer drawings answer this for free at ingest (the PDF knows exactly
// where every string sits). SHX AutoCAD exports and scans don't: their tags
// are line-work, read back by vision as a transcript with no coordinates.
// For those, the model looks at the rendered page and points.
//
// Deliberately approximate. The model is good at "upper-left quadrant, about
// a third of the way down" and bad at pixel precision, so the UI draws a
// generous ring and says "approximate" rather than pretending to a box.
// Pointing an engineer at the right corner of an E-size sheet is the whole
// win; the last inch is theirs.
//
// The parsing lives here, apart from the network call, so the fragile part
// (models wrap JSON in prose, use 0-100 or 0-1000 scales, echo tags with
// different spacing) is covered by tests.

export interface TagPosition {
  tag: string;
  /** 0..1 from the left edge. */
  nx: number;
  /** 0..1 from the TOP edge. */
  ny: number;
}

export const LOCATE_SYSTEM =
  "You are looking at one sheet of an engineering drawing (a P&ID, isometric, or similar).\n\n" +
  "For each tag you are given, find where that tag's LABEL is printed on the sheet and report its " +
  "position as fractions of the page: x from the left edge, y from the TOP edge, each between 0 " +
  "and 1.\n\n" +
  "Return STRICT JSON only — an object mapping each tag to [x, y]:\n" +
  '{"V-3": [0.42, 0.18], "P-101A": [0.77, 0.63]}\n\n' +
  "Rules:\n" +
  "- Omit any tag you cannot actually see. A guess is worse than an absence — it sends someone " +
  "hunting the wrong corner of a very large sheet.\n" +
  "- If a tag appears more than once, give the position of the EQUIPMENT symbol's label, not a " +
  "mention in a note or the title block.\n" +
  "- No markdown, no code fence, no commentary.";

/** Ask for these tags, in the model's words. */
export function buildLocateUser(tags: string[], documentName: string, page: number): string {
  return (
    `Sheet: "${documentName}", page ${page}.\n` +
    `Locate these tags: ${tags.join(", ")}`
  );
}

/** Normalize a coordinate that might be 0..1, 0..100, or 0..1000. Models
 *  drift between scales run to run, and a 0.42 silently read as 42% of the
 *  way across is the same answer — but a raw 42 dropped in unscaled would
 *  put the marker 42 pages off the right edge. */
function toFraction(v: number): number | null {
  if (!Number.isFinite(v) || v < 0) return null;
  const f = v <= 1 ? v : v <= 100 ? v / 100 : v <= 1000 ? v / 1000 : null;
  return f === null || f > 1 ? null : f;
}

const canonical = (tag: string): string =>
  tag.toUpperCase().replace(/[\s–]+/g, "-").replace(/-+/g, "-").trim();

/** Parse the model's reply into positions, keeping ONLY tags that were
 *  asked for — a model that invents a tag must not plant a marker for it. */
export function parseLocateResponse(text: string, requested: string[]): TagPosition[] {
  const wanted = new Map(requested.map((t) => [canonical(t), t]));
  const body = text.trim();
  const json = body.startsWith("{") ? body : (body.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!json) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: TagPosition[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(parsed)) {
    const original = wanted.get(canonical(key));
    if (!original || seen.has(original)) continue;
    let x: unknown, y: unknown;
    if (Array.isArray(value)) { [x, y] = value; }
    else if (value && typeof value === "object") {
      const o = value as Record<string, unknown>;
      x = o.x ?? o.nx; y = o.y ?? o.ny;
    } else continue;
    const nx = typeof x === "number" ? toFraction(x) : null;
    const ny = typeof y === "number" ? toFraction(y) : null;
    if (nx === null || ny === null) continue;
    seen.add(original);
    out.push({ tag: original, nx, ny });
  }
  return out;
}
