// lib/knowledgeKeyless.ts — intelligence Round G (I-22): what the app says
// about pages AI vision did not read. Pure (no client, no server imports), so
// the ask route, the library page and the meaning-index panel share one
// wording and the rules are testable on their own.
//
//   * ING-13 / ING-6 (DEC-58 as ruled under DEC-90 A18): keyless completion
//     is text-only WITH a marker. A page an ingest batch with no AI key
//     commits from its text layer, where a batch with a key would read it
//     with AI vision, is counted on the row
//     (knowledge_documents.vision_keyless_pages, 20261186). The library page
//     says "N pages indexed from their text layer only (no AI key)".
//   * ING-6 criterion (a): the ask route's DRAWING FACTS state how many pages
//     AI vision could not read — the pages waiting on (or accepted without)
//     an AI vision read (vision_failed_pages) and the pages indexed without a
//     key (vision_keyless_pages).
//   * GOV-5 residual: when the embed drain stopped a run because the next
//     batch's worst case did not fit what is left of the payer's cap (no
//     hold — I-18 fix pass 3), the meaning-index panel says "Waiting for AI
//     budget headroom — retried each run" from what the drain recorded on
//     the library's build marker (headroomWaitAt), with the figures in the
//     third person ("the payer's $10.00 monthly AI cap has …") — every
//     library member sees that panel, not only the payer.
//
// Every reader tolerates a database without 20261186: a missing column is no
// count, exactly what each surface said before.

/** The column 20261186 adds to knowledge_documents. */
export const KEYLESS_PAGES_COLUMN = "vision_keyless_pages";

/** A stored count as a non-negative integer (anything else — absent, null,
 *  junk — is 0: nothing recorded). */
export function keylessCount(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The library page's marker, or null when there is nothing to say. */
export function keylessTextOnlyLabel(pages: number): string | null {
  const n = keylessCount(pages);
  if (n === 0) return null;
  return `${n} page${n === 1 ? "" : "s"} indexed from ${n === 1 ? "its" : "their"} text layer only (no AI key)`;
}

/** The count a document row shows: only where the current index stands
 *  behind it (pages indexed), and never more pages than were indexed — the
 *  same rule the row's other counters follow. */
export function keylessPagesShown(count: unknown, pagesIndexed: number): number {
  const n = keylessCount(count);
  if (!(pagesIndexed > 0) || n === 0 || n > pagesIndexed) return 0;
  return n;
}

/** A page list as stored (vision_failed_pages): distinct positive integers. */
const pageCount = (v: unknown): number =>
  Array.isArray(v) ? new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0)).size : 0;

export interface VisionUnreadSummary {
  /** Pages waiting on an AI vision read, or accepted without one. */
  failedPages: number;
  /** Pages indexed from their text layer only because no AI key was available. */
  keylessPages: number;
  /** Sheets carrying either. */
  sheets: number;
}

/** The pages AI vision could not read, over the sheets the facts count. */
export function summarizeVisionUnread(
  rows: Iterable<{ vision_failed_pages?: unknown; vision_keyless_pages?: unknown }>,
): VisionUnreadSummary {
  let failedPages = 0, keylessPages = 0, sheets = 0;
  for (const r of rows) {
    const f = pageCount(r.vision_failed_pages);
    const k = keylessCount(r.vision_keyless_pages);
    failedPages += f;
    keylessPages += k;
    if (f + k > 0) sheets++;
  }
  return { failedPages, keylessPages, sheets };
}

/** The DRAWING FACTS line (plain facts, document data), or "" when every
 *  page was read — the facts are then exactly as before. `unknown`: the
 *  counts could not be read this time (said, never taken as none). */
export function visionUnreadFactsLine(s: VisionUnreadSummary | "unknown", sheetsTotal: number): string {
  if (s === "unknown") {
    return "- Pages AI vision could not read: unknown — the count could not be read this time, so some sheets' tags " +
      "and text may be missing.\n";
  }
  const total = s.failedPages + s.keylessPages;
  if (total === 0) return "";
  const parts: string[] = [];
  if (s.failedPages > 0) {
    parts.push(`${s.failedPages} ${s.failedPages === 1 ? "is" : "are"} waiting for an AI vision read or ${s.failedPages === 1 ? "was" : "were"} accepted unread`);
  }
  if (s.keylessPages > 0) {
    parts.push(`${s.keylessPages} ${s.keylessPages === 1 ? "was" : "were"} indexed from ${s.keylessPages === 1 ? "its" : "their"} text layer only because no AI key was available`);
  }
  return `- Pages AI vision could not read: ${total} (on ${s.sheets} of ${sheetsTotal} sheets) — ${parts.join("; ")}. ` +
    "The tags and text on those pages may be missing.\n";
}

/** The sentence the drawing rules add when pages were not read by AI vision:
 *  a count over those sheets is a floor, and a "next free" number may be in
 *  use on one of them. */
export const VISION_UNREAD_RULE =
  "Some pages were not read by AI vision (the facts say how many and why): their tags and text may be missing, " +
  "so a count that covers those sheets is a floor, not a total, and a next free number may already be in use " +
  "on one of them — say so when you give either.";

/** The sentence the drawing rules add instead when the unread-page count
 *  itself could not be read ("unknown" in the facts): the app does not know
 *  that any page went unread, so the rule says only that it could not check. */
export const VISION_UNREAD_UNKNOWN_RULE =
  "Whether every page was read by AI vision could not be checked this time: treat a count that covers these " +
  "sheets as a floor, not a total, and a next free number as possibly already in use — say so when you give either.";

/** What the embed status's `background` carries beyond lib/knowledge.ts's
 *  type when the drain recorded a headroom wait (present only then). */
export interface BackgroundHeadroom {
  headroomWaitAt?: string | null;
  headroomNote?: string | null;
}

/** A dollar figure for the headroom note: cents from a cent up (as the
 *  reservation's own sentence prints them), four places under a cent so a
 *  tiny batch never reads "$0.00". */
function headroomUsd(n: number): string {
  if (!(n > 0)) return "$0.00";
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  const fine = n.toFixed(4);
  return Number(fine) > 0 ? `$${fine}` : "under $0.0001";
}

/** GOV-5 residual: what the embed drain records as `headroomNote` when a
 *  run stopped because the next batch's worst case did not fit what is left
 *  of the payer's cap — built from the refusal's figures
 *  (GovernedCallError.details: spentUsd, capUsd, reservedUsd), in the THIRD
 *  person. The reservation's own sentence says "your … monthly AI cap": it
 *  is written to the payer, and the panel that shows the note is read by
 *  every member of the library. Undefined when the figures are not all
 *  there (the panel then says the bare line). */
export function headroomWaitNote(details: unknown): string | undefined {
  const d = (details ?? {}) as { spentUsd?: unknown; capUsd?: unknown; reservedUsd?: unknown };
  const spent = d.spentUsd, cap = d.capUsd, worst = d.reservedUsd;
  if (typeof spent !== "number" || typeof cap !== "number" || typeof worst !== "number") return undefined;
  if (![spent, cap, worst].every(Number.isFinite) || !(cap > 0)) return undefined;
  return `the payer's ${headroomUsd(cap)} monthly AI cap has ${headroomUsd(Math.max(0, cap - spent))} left, ` +
    `and the next batch could cost up to ${headroomUsd(worst)}.`;
}

/** GOV-5 residual: the meaning-index panel's line for a background build
 *  whose last run stopped because the next batch did not fit what is left
 *  of the payer's monthly AI cap (not reached — so nothing is held), or null.
 *  Said only while passages remain and no dated hold is in force (a hold has
 *  its own line). */
export function headroomWaitLine(
  bg: { headroomWaitAt?: string | null; blockedUntil?: string | null } | null | undefined,
  remaining: number,
  nowMs: number,
): string | null {
  if (!bg?.headroomWaitAt || !(remaining > 0)) return null;
  const holdUntil = bg.blockedUntil ? Date.parse(bg.blockedUntil) : NaN;
  if (Number.isFinite(holdUntil) && holdUntil > nowMs) return null;
  return "Waiting for AI budget headroom — retried each run";
}
