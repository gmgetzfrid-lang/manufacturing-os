// lib/scheduleLinks.ts
//
// The canonical task-dependency model — the part that makes this a real
// scheduling tool instead of a single-relationship toy.
//
// Microsoft Project and Primavera P6 both support four relationship types
// between two tasks, each with a lead/lag in days:
//
//   FS  Finish-to-Start  — successor can't START until predecessor FINISHES
//                          (the default; "do A, then B").
//   SS  Start-to-Start   — successor can't START until predecessor STARTS
//                          ("start the inspection once excavation begins").
//   FF  Finish-to-Finish — successor can't FINISH until predecessor FINISHES
//                          ("paint can't be done until plastering is done").
//   SF  Start-to-Finish  — successor can't FINISH until predecessor STARTS
//                          (rare; used for just-in-time handoffs).
//
//   lag (days): positive = a gap AFTER the relationship is satisfied
//               ("FS+2" = start 2 days after the predecessor finishes);
//               negative = a lead / overlap ("SS-1" = start a day into it).
//
// History: the schema started with `depends_on string[]` (FS-only, no lag).
// Rather than break every imported schedule, this module treats a bare
// predecessor id as FS+0 and carries the richer model in `dependency_links`.
// `normalizeLinks()` reads BOTH and returns one canonical shape, so the rest
// of the codebase (reflow, CPM, the Gantt arrows, the editor) only ever sees
// `DependencyLink[]`.

export type LinkType = "FS" | "SS" | "FF" | "SF";

export const LINK_TYPES: LinkType[] = ["FS", "SS", "FF", "SF"];

/** One typed dependency edge: "this task depends on `predId`". */
export interface DependencyLink {
  /** Milestone id of the PREDECESSOR. */
  predId: string;
  /** Relationship type. Defaults to FS when omitted by legacy data. */
  type: LinkType;
  /** Lead/lag in days. Positive = gap, negative = overlap. */
  lagDays: number;
}

export const LINK_TYPE_LABEL: Record<LinkType, string> = {
  FS: "Finish → Start",
  SS: "Start → Start",
  FF: "Finish → Finish",
  SF: "Start → Finish",
};

export const LINK_TYPE_HINT: Record<LinkType, string> = {
  FS: "Can't start until the predecessor finishes (the usual one).",
  SS: "Can't start until the predecessor starts.",
  FF: "Can't finish until the predecessor finishes.",
  SF: "Can't finish until the predecessor starts (rare).",
};

const DAY_MS = 86_400_000;

function isLinkType(x: unknown): x is LinkType {
  return x === "FS" || x === "SS" || x === "FF" || x === "SF";
}

/**
 * Read the legacy `depends_on` array AND the richer `dependency_links` column
 * into one canonical `DependencyLink[]`. The richer column wins when it
 * carries anything; otherwise every legacy predecessor id becomes an FS+0
 * link, so old schedules keep working untouched. Deduped by predId
 * (last writer wins), self-links dropped.
 */
export function normalizeLinks(
  dependsOn?: readonly string[] | null,
  dependencyLinks?: unknown,
  selfId?: string,
): DependencyLink[] {
  const out: DependencyLink[] = [];
  const seen = new Set<string>();
  const push = (predId: string, type: LinkType, lagDays: number) => {
    if (!predId || predId === selfId) return;
    if (seen.has(predId)) {
      // Last writer wins — replace the earlier entry for this predecessor.
      const i = out.findIndex((l) => l.predId === predId);
      if (i >= 0) out[i] = { predId, type, lagDays };
      return;
    }
    seen.add(predId);
    out.push({ predId, type, lagDays });
  };

  // Prefer the rich column when it has valid entries.
  if (Array.isArray(dependencyLinks) && dependencyLinks.length > 0) {
    for (const raw of dependencyLinks) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const predId = typeof r.predId === "string" ? r.predId
        : typeof r.pred_id === "string" ? r.pred_id : "";
      if (!predId) continue;
      const type = isLinkType(r.type) ? r.type : "FS";
      const lagRaw = r.lagDays ?? r.lag_days ?? 0;
      const lagDays = Number.isFinite(Number(lagRaw)) ? Math.trunc(Number(lagRaw)) : 0;
      push(predId, type, lagDays);
    }
    if (out.length > 0) return out;
  }

  // Fall back to the FS-only legacy array.
  for (const predId of dependsOn ?? []) {
    if (typeof predId === "string") push(predId, "FS", 0);
  }
  return out;
}

/**
 * Serialize canonical links for persistence — BOTH the rich column and the
 * legacy array, so old readers (and the FS-only arrow fallback) keep working
 * while new readers get type + lag. The legacy array is just the predecessor
 * ids in order.
 */
export function serializeLinks(links: readonly DependencyLink[]): {
  dependencyLinks: DependencyLink[];
  dependsOn: string[];
} {
  const clean = links
    .filter((l) => l.predId)
    .map((l) => ({ predId: l.predId, type: isLinkType(l.type) ? l.type : "FS", lagDays: Math.trunc(l.lagDays || 0) }));
  return { dependencyLinks: clean, dependsOn: clean.map((l) => l.predId) };
}

/** Short MS-Project-style code: "FS", "FS+2", "SS-1", "FF". */
export function linkCode(link: Pick<DependencyLink, "type" | "lagDays">): string {
  const lag = Math.trunc(link.lagDays || 0);
  if (lag === 0) return link.type;
  return `${link.type}${lag > 0 ? `+${lag}` : `${lag}`}`;
}

/**
 * The earliest instant (ms) a successor may START so a single link is
 * satisfied, given the predecessor's current start/finish and the
 * successor's own span (so finish-anchored types keep their duration).
 *
 * Day conventions (whole inclusive days; a task finishing "on" a day occupies
 * it, so an FS successor starts the NEXT day at lag 0 — this matches the
 * existing, tested reflow behavior):
 *   FS: predFinish + (1 + lag) days
 *   SS: predStart  + lag days
 *   FF: predFinish + lag days, measured at the successor's FINISH
 *   SF: predStart  + lag days, measured at the successor's FINISH
 */
export function requiredStartMs(
  link: Pick<DependencyLink, "type" | "lagDays">,
  predStartMs: number,
  predFinishMs: number,
  succStartMs: number,
  succFinishMs: number,
): number {
  const lag = Math.trunc(link.lagDays || 0) * DAY_MS;
  const succSpan = Math.max(0, succFinishMs - succStartMs);
  switch (link.type) {
    case "SS": return predStartMs + lag;
    case "FF": return predFinishMs + lag - succSpan;
    case "SF": return predStartMs + lag - succSpan;
    case "FS":
    default:   return predFinishMs + DAY_MS + lag;
  }
}
