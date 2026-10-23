// lib/scheduleLinks.ts — how one task waits on another.
//
// Finish-to-start is the usual link ("hydro after the retube is done"), but
// real schedules also use start-to-start ("blast once painting has
// started"), finish-to-finish ("inspection finishes with the repairs") and
// lags ("+12 h for the coating to cure"). A task's links are kept per
// predecessor; a predecessor without one is plain finish-to-start, no lag.

export type LinkType = "FS" | "SS" | "FF" | "SF";
export interface LinkSpec { type: LinkType; lagHours: number }
/** Predecessor id → its link. */
export type LinkMap = Record<string, LinkSpec>;

export const LINK_LABEL: Record<LinkType, string> = {
  FS: "starts after it finishes",
  SS: "starts after it starts",
  FF: "finishes after it finishes",
  SF: "finishes after it starts",
};

export const PLAIN: LinkSpec = { type: "FS", lagHours: 0 };

export function linkOf(links: LinkMap | null | undefined, predId: string): LinkSpec {
  const l = links?.[predId];
  if (!l || !["FS", "SS", "FF", "SF"].includes(l.type)) return PLAIN;
  return { type: l.type, lagHours: Number.isFinite(l.lagHours) ? l.lagHours : 0 };
}

/** The earliest a successor may START under one link. `predEnd` is when
 *  the predecessor's work is really over (the end of its last day for a
 *  date-only task); `succLen` the successor's own length, kept as it moves. */
export function earliestStart(link: LinkSpec, pred: { start: number; end: number }, succLen: number): number {
  const lag = link.lagHours * 3_600_000;
  switch (link.type) {
    case "SS": return pred.start + lag;
    case "FF": return pred.end + lag - succLen;
    case "SF": return pred.start + lag - succLen;
    default: return pred.end + lag;
  }
}

/** Does this link stop the successor from STARTING while the predecessor
 *  is in this state? FS waits for done; SS for started; FF / SF only
 *  constrain its finish, so it can start. */
export function blocksStart(link: LinkSpec, pred: { done: boolean; started: boolean }): boolean {
  if (link.type === "FS") return !pred.done;
  if (link.type === "SS") return !pred.started;
  return false;
}

/** "SS +12h" — short form for lists; "" for a plain finish-to-start link. */
export function linkShort(l: LinkSpec): string {
  if (l.type === "FS" && !l.lagHours) return "";
  const lag = l.lagHours ? ` ${l.lagHours > 0 ? "+" : "−"}${Math.abs(l.lagHours)}h` : "";
  return `${l.type}${lag}`;
}

/** Read "2SS+1d", "5FF-4h", "3" (MS Project / CSV predecessor text) into
 *  the predecessor's id and its link. Days count as 24 h unless `dayHours`
 *  says how many working hours a day is. */
export function parseLinkToken(tok: string, dayHours = 24): { id: string; link: LinkSpec } | null {
  const m = tok.trim().match(/^(\d+)\s*(FS|SS|FF|SF)?\s*(?:([+-])\s*(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|w|wk|wks|week|weeks)?)?$/i);
  if (!m) return null;
  const type = (m[2]?.toUpperCase() as LinkType | undefined) ?? "FS";
  let lag = 0;
  if (m[3] && m[4]) {
    const n = Number(m[4]);
    const unit = (m[5] ?? "d").toLowerCase();
    const hours = unit.startsWith("h") ? n : unit.startsWith("w") ? n * dayHours * 7 : n * dayHours;
    lag = m[3] === "-" ? -hours : hours;
  }
  return { id: m[1], link: { type, lagHours: lag } };
}
