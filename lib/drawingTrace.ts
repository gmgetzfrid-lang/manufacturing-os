// lib/drawingTrace.ts — "run a highlighter along this pipe."
//
// Pointing (drawingLocate) answers WHERE a tag is. Tracing answers HOW the
// process gets from one tag to the next: the model follows the drawn line
// with its eyes and reports waypoints, which the viewer strokes over the
// sheet like a yellow highlighter — the drawing equivalent of the passage
// highlight that text documents get for free from their text layer.
//
// Deliberately approximate, exactly like locate: the stroke is drawn WIDE
// and translucent so a waypoint that's off by a few millimeters still lies
// over the right line-work, and the UI labels every trace as AI-read. The
// engineer confirms against the actual line number; the highlighter's job
// is to collapse "hunt an E-size sheet" into "look here".
//
// Parsing lives here, apart from the network call, so the fragile part
// (models wrap JSON in prose, drift between 0..1 / 0..100 scales, emit
// duplicate or collinear points) is covered by tests.

export interface TracePoint {
  /** 0..1 from the left edge. */
  nx: number;
  /** 0..1 from the TOP edge. */
  ny: number;
}

export interface TraceResult {
  found: boolean;
  points: TracePoint[];
  /** The model's own caveat ("crosses to sheet 2 at connector 03"). */
  note: string | null;
}

/** More than this and the reply stops being waypoints and becomes a bad
 *  raster; fewer than 2 and there is no line to draw. */
export const TRACE_MAX_POINTS = 40;

export const TRACE_SYSTEM =
  "You are looking at one sheet of a P&ID (piping and instrumentation diagram) or similar " +
  "engineering drawing.\n\n" +
  "Your job: visually FOLLOW ONE PIPE LINE across the sheet, from a starting equipment tag to an " +
  "ending equipment tag, and report the path so it can be drawn over the drawing like a " +
  "highlighter stroke.\n\n" +
  "Report the path as waypoints IN ORDER along the line. Each waypoint is [x, y] as fractions of " +
  "the page: x from the left edge, y from the TOP edge, each between 0 and 1.\n\n" +
  "Place a waypoint at: the connection on the starting equipment, EVERY corner or elbow where the " +
  "line changes direction, every junction where the traced line turns, and the connection on the " +
  "ending equipment. A long straight run needs no intermediate points.\n\n" +
  "P&ID reading rules that keep you on the right line:\n" +
  "- Pipes are drawn orthogonally — runs are horizontal or vertical, so consecutive waypoints " +
  "should usually share an x or a y.\n" +
  "- A line CROSSING another (with or without a small hop/break) is NOT a junction — keep going " +
  "straight.\n" +
  "- Line-number labels printed along the run confirm you are still on the same line; if the " +
  "label changes, you turned onto a different line.\n" +
  "- Follow the MAIN process line between the two tags, through any valves and fittings in the " +
  "run.\n\n" +
  "Return STRICT JSON only:\n" +
  '{"found": true, "points": [[0.12, 0.80], [0.12, 0.55], [0.34, 0.55]], "note": ""}\n' +
  'If you cannot confidently follow the line end to end, return {"found": false, "note": "why"} — ' +
  "a wrong trace sends someone isolating the wrong pipe, which is worse than no trace.\n" +
  `Rules: 2 to ${TRACE_MAX_POINTS} points. Use "note" for real caveats only (e.g. the line leaves ` +
  'the sheet at an off-page connector). No markdown, no code fence, no commentary.';

/** Ask for one trace, in the model's words. */
export function buildTraceUser(input: {
  fromTag: string; toTag: string; lineNumber?: string | null;
  documentName: string; page: number;
}): string {
  const { fromTag, toTag, lineNumber, documentName, page } = input;
  return (
    `Sheet: "${documentName}", page ${page}.\n` +
    `Trace the pipe from ${fromTag} to ${toTag}.` +
    (lineNumber ? ` The line number to follow is ${lineNumber}.` : "")
  );
}

/** Normalize a coordinate that might be 0..1, 0..100, or 0..1000 — models
 *  drift between scales run to run (same tolerance as drawingLocate). */
function toFraction(v: number): number | null {
  if (!Number.isFinite(v) || v < 0) return null;
  const f = v <= 1 ? v : v <= 100 ? v / 100 : v <= 1000 ? v / 1000 : null;
  return f === null || f > 1 ? null : f;
}

/** Parse the model's reply into an ordered waypoint path. Invalid entries
 *  are dropped rather than failing the whole trace; consecutive duplicates
 *  collapse (models repeat corners); anything past the cap is truncated. */
export function parseTraceResponse(text: string): TraceResult {
  const none = (note: string | null = null): TraceResult => ({ found: false, points: [], note });
  const body = text.trim();
  const json = body.startsWith("{") ? body : (body.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!json) return none();
  let parsed: { found?: unknown; points?: unknown; note?: unknown };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    return none();
  }
  const note = typeof parsed.note === "string" && parsed.note.trim()
    ? parsed.note.trim().slice(0, 400)
    : null;
  if (parsed.found === false) return none(note);
  if (!Array.isArray(parsed.points)) return none(note);

  const points: TracePoint[] = [];
  for (const entry of parsed.points) {
    let x: unknown, y: unknown;
    if (Array.isArray(entry)) { [x, y] = entry; }
    else if (entry && typeof entry === "object") {
      const o = entry as Record<string, unknown>;
      x = o.x ?? o.nx; y = o.y ?? o.ny;
    } else continue;
    const nx = typeof x === "number" ? toFraction(x) : null;
    const ny = typeof y === "number" ? toFraction(y) : null;
    if (nx === null || ny === null) continue;
    const prev = points[points.length - 1];
    // Collapse points the stroke couldn't visually distinguish anyway.
    if (prev && Math.abs(prev.nx - nx) < 0.004 && Math.abs(prev.ny - ny) < 0.004) continue;
    points.push({ nx, ny });
    if (points.length >= TRACE_MAX_POINTS) break;
  }
  if (points.length < 2) return none(note);
  return { found: true, points, note };
}
