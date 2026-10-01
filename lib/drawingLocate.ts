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
// win; the last inch is theirs. A cached vision point stays an ESTIMATE
// (pos_source 'vision'): the viewer marks it approximate, a rev-up or a
// rebuild clears it, and a viewer can reject it (PR-10).
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
  "- If a tag appears more than once, give the position of the DRAWN EQUIPMENT SYMBOL's label in " +
  "the drawing area — NEVER a mention in the equipment summary row along the top of the sheet, a " +
  "table, a note, the legend, or the title block. The summary row lists every vessel with its " +
  "duty; pointing there instead of at the drawn vessel sends a line-tracer to a spot with no " +
  "pipes at all.\n" +
  "- Off-page connector boxes (a number in a small box or pennant at the sheet edge) count as " +
  "locatable tags — give the box's position.\n" +
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

/** Feedback for a second locate attempt after a close-up of the first
 *  position did NOT show the tag — the classic symptom of pointing at the
 *  equipment summary row, a table or a note instead of the drawn vessel.
 *  The locate route runs this round when a close-up refutes a coarse point
 *  (DWG-13 / PR-10), and never caches a point no round confirmed. */
export function buildRelocateUser(
  tags: string[], documentName: string, page: number,
  wrong: Record<string, [number, number]>,
): string {
  const wrongList = Object.entries(wrong)
    .map(([t, [x, y]]) => `${t} at [${x.toFixed(2)}, ${y.toFixed(2)}]`).join("; ");
  return (
    `Sheet: ${documentName}, page ${page}. Locate: ${tags.join(", ")}.\n` +
    `A previous attempt placed ${wrongList} — but a close-up of that spot does NOT show ` +
    "the tag, so that was almost certainly the equipment summary row, a table, or a note. " +
    "Find where each item is actually DRAWN in the diagram — the vessel/exchanger symbol " +
    "with pipes connecting to it — and give THAT position. If you cannot see it, omit it."
  );
}

// ── Text-layer marks on rotated / offset pages (DWG-3) ─────────────────────
//
// Ingest stores a text-layer tag's position (pos_source 'text') as
//   nx = x / W',  ny = 1 − y / H'
// where (x, y) is the text item's point in UNROTATED PDF user space and
// W'×H' is the page's ROTATED viewport at scale 1 (pdf.js applies /Rotate,
// and /UserUnit, to the viewport — not to text coordinates), then clamps both
// to 0..1. That is right only on an unrotated page whose CropBox starts at
// the origin with /UserUnit 1. On a /Rotate 180 sheet every mark lands in the
// opposite corner; on 90/270 the axes are swapped as well.
//
// The viewer recovers (x, y) from the stored values and maps it through the
// SAME transform pdf.js uses to draw the page (PageViewport at scale 1 —
// mirrored here so it is testable against pdf.js itself). Two limits, both
// handled by refusing rather than guessing:
//   * a value ingest pinned to an edge (0 or 1) on a page that is not plain
//     was out of range before the clamp — its real position is lost, so the
//     mark is not drawn (null);
//   * a mapped position outside the page is not drawn either.
// A plain page (rotation 0, origin 0, unit 1) maps to itself exactly, so
// every mark that was right stays right.
//
// Contract: this applies to pos_source 'text' ONLY — the encoding above. If
// ingest is ever changed to store viewport fractions directly
// (convertToViewportPoint), it must write a different pos_source, or this
// would rotate an already-rotated point.

export interface PageGeometry {
  /** /Rotate, degrees (multiples of 90). */
  rotate: number;
  /** The page's view box (CropBox) in user space: [x0, y0, x1, y1]. */
  view: readonly [number, number, number, number] | readonly number[];
  /** /UserUnit (pdf.js scales the viewport by it). */
  userUnit?: number;
}

/** pdf.js PageViewport's transform at scale 1 (pdf.mjs, class PageViewport). */
function viewportTransform(g: PageGeometry): { t: [number, number, number, number, number, number]; width: number; height: number } {
  const [x0, y0, x1, y1] = g.view as number[];
  const scale = g.userUnit && g.userUnit > 0 ? g.userUnit : 1;
  const centerX = (x1 + x0) / 2;
  const centerY = (y1 + y0) / 2;
  let rotation = g.rotate % 360;
  if (rotation < 0) rotation += 360;
  const [A, B, C, D] =
    rotation === 180 ? [-1, 0, 0, 1]
    : rotation === 90 ? [0, 1, 1, 0]
    : rotation === 270 ? [0, -1, -1, 0]
    : [1, 0, 0, -1];
  let offX: number, offY: number, width: number, height: number;
  if (A === 0) {
    offX = Math.abs(centerY - y0) * scale;
    offY = Math.abs(centerX - x0) * scale;
    width = (y1 - y0) * scale;
    height = (x1 - x0) * scale;
  } else {
    offX = Math.abs(centerX - x0) * scale;
    offY = Math.abs(centerY - y0) * scale;
    width = (x1 - x0) * scale;
    height = (y1 - y0) * scale;
  }
  return {
    t: [A * scale, B * scale, C * scale, D * scale,
      offX - A * scale * centerX - C * scale * centerY,
      offY - B * scale * centerX - D * scale * centerY],
    width, height,
  };
}

/** Where a stored text-layer mark belongs on the page as drawn, as 0..1
 *  from the left and from the TOP — or null when that cannot be known. */
export function textMarkPosition(nx: number, ny: number, g: PageGeometry): { nx: number; ny: number } | null {
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  const [x0, y0] = g.view as number[];
  const unit = g.userUnit && g.userUnit > 0 ? g.userUnit : 1;
  const rotation = ((g.rotate % 360) + 360) % 360;
  const plain = rotation === 0 && x0 === 0 && y0 === 0 && unit === 1;
  if (plain) return { nx, ny };
  // Pinned to an edge by ingest's clamp: the true value is gone.
  if (nx <= 0 || nx >= 1 || ny <= 0 || ny >= 1) return null;
  const { t, width, height } = viewportTransform(g);
  if (!(width > 0 && height > 0)) return null;
  // The user-space point ingest saw (its divisor WAS this viewport's size).
  const x = nx * width;
  const y = (1 - ny) * height;
  const px = t[0] * x + t[2] * y + t[4];
  const py = t[1] * x + t[3] * y + t[5];
  const fx = px / width;
  const fy = py / height;
  return fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 ? { nx: fx, ny: fy } : null;
}
