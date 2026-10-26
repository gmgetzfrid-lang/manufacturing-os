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
  /** When the work under this chip is actually active ON THIS DAY, as
   *  instants clipped to the day: for a leaf its own span; for a group
   *  chip the envelope of its steps that fall on the day. Drives both
   *  the chip's clock and the tile's order, so a 4-day exchanger whose
   *  only step today runs 14:00–18:00 sorts and reads as 14:00, not as
   *  "continuing since Monday". */
  todayStart?: number;
  todayEnd?: number;
  /** True when nothing under a group chip is scheduled on this day (a
   *  gap day inside its span). */
  idleToday?: boolean;
  /** Which crew does the work under this chip on this day: day, night,
   *  round the clock, or a mix that includes night. Night work sorts after
   *  the day's work, so a box reads day shift first, then night shift. */
  crew?: DayCrew;
}

export type DayCrew = "day" | "night" | "both" | "mixed";

/** The steps under a chip that have work on this day (a leaf: itself). */
export function stepsOnDay<T extends PlaceableTask>(ms: T, steps: T[], dayStart: number, dayEnd: number): T[] {
  const list = steps.length ? steps : [ms];
  return list.filter((st) => {
    const s0 = startMsOf(st), f0 = finishMsOf(st);
    if (!Number.isFinite(s0) || !Number.isFinite(f0)) return false;
    if (s0 < dayEnd && f0 > dayStart) return true;
    return s0 === f0 && s0 >= dayStart && s0 < dayEnd;
  });
}

/** One crew for a chip on a day, from its steps': all night → night;
 *  all day → day; all through both shifts → both; day work alongside
 *  night work → mixed. */
export function crewOf(crews: Iterable<"day" | "night" | "both">): DayCrew {
  const set = new Set(crews);
  if (set.size === 0) return "day";
  if (set.size === 1) return [...set][0];
  return set.has("night") || set.has("both") ? "mixed" : "day";
}

/** Which shift a step's work falls in on one day: when it is scheduled
 *  that day, against the day shift's hours, for the crews that can work
 *  then. A round-the-clock crew's 18:00–22:00 step is night work; its
 *  all-day step is both; a day crew's step is day work. */
export function stepShiftOnDay(
  start: number, finish: number, crew: "day" | "night" | "both",
  dayStart: number, dayEnd: number, dayShift: { start: number; end: number },
): "day" | "night" | "both" {
  if (crew !== "both") return crew;
  const s = Math.max(start, dayStart), f = Math.min(finish, dayEnd);
  // A moment, not a stretch (a milestone): the shift it falls in.
  if (!(f > s)) return s >= dayShift.start && s < dayShift.end ? "day" : "night";
  const inDay = Math.max(0, Math.min(f, dayShift.end) - Math.max(s, dayShift.start));
  const inNight = (f - s) - inDay;
  return inDay > 0 && inNight > 0 ? "both" : inNight > 0 ? "night" : "day";
}

/** The active window of a chip on one day. `steps` are the leaf rows a
 *  group chip stands in for (empty for a leaf chip). */
export function activeWindowOnDay(
  ms: PlaceableTask,
  steps: PlaceableTask[],
  dayStart: number,
  dayEnd: number,
): { start: number; end: number; idle: boolean } {
  const clip = (s: number, f: number) => ({ s: Math.max(s, dayStart), f: Math.min(Math.max(f, s), dayEnd) });
  if (steps.length === 0) {
    const { s, f } = clip(startMsOf(ms), finishMsOf(ms));
    return { start: s, end: f, idle: false };
  }
  let start = Infinity, end = -Infinity;
  for (const st of steps) {
    const s0 = startMsOf(st), f0 = finishMsOf(st);
    if (!Number.isFinite(s0) || !Number.isFinite(f0)) continue;
    if (s0 >= dayEnd || f0 <= dayStart) {
      // A step that starts or ends exactly at a boundary still counts on
      // the day it touches when it is a zero-length milestone.
      if (!(s0 === f0 && s0 >= dayStart && s0 < dayEnd)) continue;
    }
    const { s, f } = clip(s0, f0);
    start = Math.min(start, s); end = Math.max(end, f);
  }
  if (!Number.isFinite(start)) return { start: dayStart, end: dayEnd, idle: true };
  return { start, end, idle: false };
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

/** Time-of-day order for the chips inside one day tile: the day crew's
 *  work, then the night crew's; each by when the work is active on THAT
 *  day (todayStart/todayEnd when known), so a carry-over that is busy from
 *  00:00 leads and a 14:00 step sorts after a 6:00 one whatever day their
 *  parent began. Idle gap-days sink to the bottom. */
export function compareDayPlacements(a: DayPlacement, b: DayPlacement): number {
  if (!!a.idleToday !== !!b.idleToday) return a.idleToday ? 1 : -1;
  // The day's work first, then the night crew's — never night work in the
  // middle of the day shift's list.
  const an = a.crew === "night" ? 1 : 0, bn = b.crew === "night" ? 1 : 0;
  if (an !== bn) return an - bn;
  if (a.todayStart != null && b.todayStart != null) {
    const s0 = cmpNum(a.todayStart, b.todayStart);
    if (s0) return s0;
    const f0 = cmpNum(a.todayEnd ?? NaN, b.todayEnd ?? NaN);
    if (f0) return f0;
  } else {
    // Carry-overs (already running at 00:00) lead the day.
    const aCarry = a.dayIndex > 0, bCarry = b.dayIndex > 0;
    if (aCarry !== bCarry) return aCarry ? -1 : 1;
  }
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
