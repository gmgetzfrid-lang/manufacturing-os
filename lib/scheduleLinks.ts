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

/** Read "2SS+1d", "5FF-4h", "1FS+30m", "2FS+1ed", "4SS+50%", "3" (MS
 *  Project / CSV predecessor text) into the predecessor's id and its link.
 *  Units: m / h / d / w / mo, with or without MS Project's "e" (elapsed);
 *  days count as `dayHours` (24 unless told). A lag the schedule can't
 *  express here (a % of the predecessor) or text it can't read still keeps
 *  the predecessor — finish-to-start, `approx` set so the import can say
 *  so. Null only when there's no predecessor id at all. */
export function parseLinkToken(tok: string, dayHours = 24): { id: string; link: LinkSpec; approx?: boolean } | null {
  const t = tok.trim();
  const m = t.match(/^(\d+)\s*(FS|SS|FF|SF)?\s*(?:([+-])\s*(\d+(?:\.\d+)?)\s*(e?(?:mo|mons?|months?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)|%)?)?$/i);
  if (!m) {
    const id = t.match(/^\d+/)?.[0];
    return id ? { id, link: { type: "FS", lagHours: 0 }, approx: true } : null;
  }
  const type = (m[2]?.toUpperCase() as LinkType | undefined) ?? "FS";
  let lag = 0, approx = false;
  if (m[3] && m[4]) {
    const n = Number(m[4]);
    const unit = (m[5] ?? "d").toLowerCase().replace(/^e(?=[a-z])/, "");
    let hours: number;
    if (unit === "%") { hours = 0; approx = true; }
    else if (/^mo/.test(unit)) hours = n * dayHours * 30;
    else if (/^m/.test(unit)) hours = n / 60;
    else if (/^h/.test(unit)) hours = n;
    else if (/^w/.test(unit)) hours = n * dayHours * 7;
    else hours = n * dayHours;
    lag = m[3] === "-" ? -hours : hours;
  }
  return { id: m[1], link: { type, lagHours: Math.round(lag * 100) / 100 }, ...(approx ? { approx } : {}) };
}
