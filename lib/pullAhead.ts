// pullAhead — finding work the next shift could do early.
//
// The look-ahead list comes from the shift report (goals.lookAhead, its
// readiness read from the same predecessors as every other list). This
// narrows it the way the picker does: a search across the whole remaining
// schedule (work order, equipment, step, who), or — with no search — the
// next few days, ready work only. A search always shows what it finds,
// ready or not, with why it isn't.

import type { LookAheadItem } from "@/lib/shiftReport";
import { discoveryText } from "@/lib/discovery";

export interface LookAheadFilter {
  query: string;
  readyOnly: boolean;
  criticalOnly: boolean;
  /** Without a search: planned to start before this. */
  until: number;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** What a step is searched by. */
export function searchText(x: LookAheadItem): string {
  const m = x.row.leaf;
  return norm([m.name, ...x.row.path, m.workOrderRef ?? "", m.responsibleParty ?? "", m.location ?? "", m.wbs ?? "", discoveryText(m)].join(" "));
}

export function filterLookAhead(items: LookAheadItem[], f: LookAheadFilter): LookAheadItem[] {
  const tokens = norm(f.query).split(/\s+/).filter(Boolean);
  if (tokens.length) {
    // Every word must match — "e-17 blinds", "4410023".
    return items.filter((x) => { const t = searchText(x); return tokens.every((k) => t.includes(k)); })
      .filter((x) => !f.criticalOnly || x.row.critical);
  }
  return items.filter((x) => x.row.crewStart < f.until
    && (!f.readyOnly || x.readiness === "ready" || x.readiness === "after-tonight")
    && (!f.criticalOnly || x.row.critical));
}

/** Another crew's scope: the step names someone other than the crew doing
 *  the extra work — coordinate before touching it. Null when it's theirs
 *  or nobody is named. */
export function scopeOf(x: { row: { leaf: { responsibleParty?: string | null } } }, crew: string | null | undefined): string | null {
  const who = x.row.leaf.responsibleParty?.trim();
  // No crew named for the work: whose scope it isn't can't be said.
  if (!who || !crew?.trim()) return null;
  return who.toLowerCase() === crew.trim().toLowerCase() ? null : who;
}
