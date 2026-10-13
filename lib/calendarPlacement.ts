// calendarPlacement — the pure rules behind the Execution calendar
// (ScheduleCalendarTileView): WHICH rows appear on a day tile, HOW each
// one is represented, and in WHAT ORDER they stack inside the tile.
//
// Integrity first: every task that covers a day appears on that day.
// What changes is the representation:
//
//   • CHIPS — the work itself. A leaf task, or in Tasks mode a bottom-
//     level group (a parent whose children are ALL leaves) standing in
//     for its steps as one chip. Chips stack in time-of-day order.
//   • BANDS — the groups above that work. The project root, a phase, a
//     unit: any parent that isn't a chip. A band is a thin strip at the
//     top of the tile with a Day x/n badge, so the root ("Turnaround
//     10.25") is present on every day it covers without repeating as a
//     full chip. A band is SOLID on a day where work under it is placed
//     and MUTED on a day it merely carries over with nothing scheduled
//     beneath it.
//
// Sub-tasks mode turns every leaf into a chip (exactly once) and every
// parent, bottom groups included, into a band.
//
// Ordering of chips within a tile: a task that started on an earlier
// day (a carry-over) is already underway at 00:00 so it leads, then
// everything that starts today by its start time, with finish, WBS and
// name as deterministic tie-breaks. NaN dates never poison the sort.
// Bands order root-first (shallowest), then by start.

export interface PlaceableTask {
  id?: string;
  parentId?: string | null;
  name: string;
  wbs?: string | null;
  plannedStartAt?: Date | number | string | null;
  plannedAt: Date | number | string | null;
}

export interface DayPlacement<T extends PlaceableTask = PlaceableTask> {
  ms: T;
  /** 0 = the task starts on this tile; n = its (n+1)th day. */
  dayIndex: number;
  spanDays: number;
}

export interface BandPlacement<T extends PlaceableTask = PlaceableTask> extends DayPlacement<T> {
  /** Outline depth: 0 = top level. Bands render root-first. */
  depth: number;
  /** True when at least one chip placed on this day sits under this group. */
  hasWorkToday: boolean;
}

export function startMsOf(m: PlaceableTask): number {
  return toMs(m.plannedStartAt ?? m.plannedAt);
}

export function finishMsOf(m: PlaceableTask): number {
  return toMs(m.plannedAt);
}

function toMs(v: Date | number | string | null | undefined): number {
  if (v == null) return NaN;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return Date.parse(v);
}

/** Split the schedule into chips (the work) and bands (the groups above
 *  it). Every row with a planned date lands in exactly one of the two. */
export function splitPlacements<T extends PlaceableTask>(
  milestones: T[],
  childrenByParent: Map<string, T[]>,
  showSubtasks: boolean,
): { chips: T[]; bands: T[] } {
  const byId = new Map<string, T>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);
  const kidsOf = (m: T): T[] => (m.id ? childrenByParent.get(m.id) ?? [] : []);
  const isLeaf = (m: T) => kidsOf(m).length === 0;
  // A bottom group: has children and every one of them is a leaf.
  const isBottomGroup = (m: T) => { const k = kidsOf(m); return k.length > 0 && k.every(isLeaf); };

  const chips: T[] = [];
  const bands: T[] = [];
  const seen = new Set<string>();
  const push = (list: T[], m: T) => {
    if (!m.plannedAt) return;
    if (m.id) { if (seen.has(m.id)) return; seen.add(m.id); }
    list.push(m);
  };

  for (const m of milestones) {
    if (isLeaf(m)) {
      const parent = m.parentId ? byId.get(m.parentId) : undefined;
      // In Tasks mode a leaf under a bottom group is represented by that
      // group's chip; everywhere else the leaf stands on its own.
      if (!showSubtasks && parent && isBottomGroup(parent)) continue;
      push(chips, m);
    } else if (isBottomGroup(m) && !showSubtasks) {
      push(chips, m);
    } else {
      push(bands, m);
    }
  }
  return { chips, bands };
}

/** The rows that get a chip on the grid (see splitPlacements). */
export function placeableTasks<T extends PlaceableTask>(
  milestones: T[],
  childrenByParent: Map<string, T[]>,
  showSubtasks: boolean,
): T[] {
  return splitPlacements(milestones, childrenByParent, showSubtasks).chips;
}

/** Time-of-day order for the chips inside one day tile. */
export function compareDayPlacements(a: DayPlacement, b: DayPlacement): number {
  // Carry-overs (already running at 00:00) lead the day.
  const aCarry = a.dayIndex > 0, bCarry = b.dayIndex > 0;
  if (aCarry !== bCarry) return aCarry ? -1 : 1;
  const s = cmpNum(startMsOf(a.ms), startMsOf(b.ms));
  if (s) return s;
  const f = cmpNum(finishMsOf(a.ms), finishMsOf(b.ms));
  if (f) return f;
  const w = wbsCompare(a.ms.wbs, b.ms.wbs);
  if (w) return w;
  return (a.ms.name || "").localeCompare(b.ms.name || "");
}

/** Root-first order for the bands at the top of a tile. */
export function compareBandPlacements(a: BandPlacement, b: BandPlacement): number {
  if (a.depth !== b.depth) return a.depth - b.depth;
  const s = cmpNum(startMsOf(a.ms), startMsOf(b.ms));
  if (s) return s;
  const w = wbsCompare(a.ms.wbs, b.ms.wbs);
  if (w) return w;
  return (a.ms.name || "").localeCompare(b.ms.name || "");
}

/** Numeric compare that treats NaN as "after everything" and stable. */
function cmpNum(x: number, y: number): number {
  const xn = Number.isNaN(x), yn = Number.isNaN(y);
  if (xn && yn) return 0;
  if (xn) return 1;
  if (yn) return -1;
  return x - y;
}

export function wbsCompare(a?: string | null, b?: string | null): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const pa = a.split("."), pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i]), y = Number(pb[i]);
    const xn = Number.isFinite(x), yn = Number.isFinite(y);
    if (xn && yn) { if (x !== y) return x - y; }
    else { const c = (pa[i] ?? "").localeCompare(pb[i] ?? ""); if (c) return c; }
  }
  return 0;
}
