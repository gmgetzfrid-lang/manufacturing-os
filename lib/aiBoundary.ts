// lib/aiBoundary.ts — the single answer to "may the AI read this?"
//
// The rule was correct but scattered: a status check here, an ai_excluded
// lookup there, an archived check in a third place, each written inline in a
// loop. That's how a boundary erodes — someone adds a path, copies two of the
// three conditions, and a superseded drawing quietly becomes citable.
//
// So the rule lives here, pure and tested, and every door calls it.
//
// The four reasons a controlled document is NOT AI-readable:
//
//   * held back      — a controller set ai_excluded on this one file
//   * out of scope   — it isn't in any linked knowledge source
//   * not current    — Superseded, Void, or Archived
//   * no file        — no current version to read
//
// Each is reported by name, because "the AI can't see it" with no reason is
// a support ticket, and a controller who can't tell "excluded" from "not in
// a source" can't fix either one.

export type AiBlockReason = "held_back" | "out_of_scope" | "not_current" | "no_file";

/** Statuses that must never reach the model: the drawing is no longer the
 *  one in force, and citing it is worse than finding nothing. */
export const NOT_CURRENT_STATUSES: ReadonlySet<string> = new Set(["Superseded", "Void", "Archived"]);

export interface BoundaryDoc {
  id: string;
  status?: string | null;
  archivedAt?: string | null;
  currentVersionId?: string | null;
  aiExcluded?: boolean;
}

export interface BoundaryVerdict {
  readable: boolean;
  reason: AiBlockReason | null;
}

/**
 * May the AI read this document?
 *
 * `inSource` is the caller's answer to "is this document inside a linked
 * knowledge source" — a containment question this module can't answer without
 * the source graph. Pass `true` when you've already scoped the query to a
 * source's contents.
 *
 * Reasons are checked most-specific first: a held-back document reports
 * held_back even if it's also superseded, because that's the decision a human
 * made and the one they'll look for.
 */
export function aiReadability(doc: BoundaryDoc, inSource: boolean): BoundaryVerdict {
  if (doc.aiExcluded) return { readable: false, reason: "held_back" };
  if (!inSource) return { readable: false, reason: "out_of_scope" };
  if (doc.archivedAt || NOT_CURRENT_STATUSES.has(doc.status ?? "")) {
    return { readable: false, reason: "not_current" };
  }
  if (!doc.currentVersionId) return { readable: false, reason: "no_file" };
  return { readable: true, reason: null };
}

/** Plain language for a chip or a tooltip. */
export function explainBlock(reason: AiBlockReason): string {
  switch (reason) {
    case "held_back":
      return "Held back from AI by a controller — not mirrored, not indexed, not citable.";
    case "out_of_scope":
      return "Not inside any library or folder linked as a knowledge source, so AI features never see it.";
    case "not_current":
      return "Superseded, void, or archived — the AI only reads documents currently in force.";
    case "no_file":
      return "No current version file to read.";
  }
}

/** Filter a batch to what the AI may read. `inSource` defaults to true for
 *  callers that already scoped their query to a linked source's contents. */
export function readableByAi<T extends BoundaryDoc>(
  docs: readonly T[],
  aiExcludedIds: ReadonlySet<string>,
  inSource: (doc: T) => boolean = () => true,
): T[] {
  return docs.filter((d) =>
    aiReadability({ ...d, aiExcluded: d.aiExcluded || aiExcludedIds.has(d.id) }, inSource(d)).readable,
  );
}
