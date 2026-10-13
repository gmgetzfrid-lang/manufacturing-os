// calendarPlacement — the pure rules behind the Execution calendar
// (ScheduleCalendarTileView): WHICH tasks get a chip on a day tile and
// in WHAT ORDER they stack inside the tile.
//
// Placement
//   A calendar tile is a day-specific agenda, so broad containers never
//   get a chip: the project root ("Turnaround 10.25") or a phase that
//   holds sub-groups technically "covers" every day of the job, but it
//   isn't specific to any of them and would just repeat down the month
//   with a Day x/n badge. Only two kinds of rows are placed:
//     • a leaf task (no children), and
//     • a bottom-level group — a parent whose children are ALL leaves —
//       which stands in for its steps as one chip in Tasks mode.
//   A leaf whose parent is a container (not a bottom group) is placed
//   on its own, so a step that hangs directly off the root still shows.
//   Sub-tasks mode places every leaf exactly once; a leaf is never
//   placed twice because both its parent and grandparent qualified.
//
// Ordering
//   Within a tile, chips run in time-of-day order: a task that started
//   on an earlier day (a carry-over) is already underway at 00:00 so it
//   leads, then everything that starts today by its start time, with
//   finish, WBS and name as deterministic tie-breaks. NaN dates never
//   poison the sort.

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

/** The rows that get a chip on the grid. See the header comment. */
export function placeableTasks<T extends PlaceableTask>(
  milestones: T[],
  childrenByParent: Map<string, T[]>,
  showSubtasks: boolean,
): T[] {
  const byId = new Map<string, T>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);
  const kidsOf = (m: T): T[] => (m.id ? childrenByParent.get(m.id) ?? [] : []);
  const isLeaf = (m: T) => kidsOf(m).length === 0;
  // A bottom group: has children and every one of them is a leaf.
  const isBottomGroup = (m: T) => { const k = kidsOf(m); return k.length > 0 && k.every(isLeaf); };

  const out: T[] = [];
  const seen = new Set<string>();
  const push = (m: T) => {
    if (!m.plannedAt) return;
    if (m.id) { if (seen.has(m.id)) return; seen.add(m.id); }
    out.push(m);
  };

  for (const m of milestones) {
    if (isLeaf(m)) {
      const parent = m.parentId ? byId.get(m.parentId) : undefined;
      // In Tasks mode a leaf under a bottom group is represented by that
      // group's chip; everywhere else the leaf stands on its own.
      if (!showSubtasks && parent && isBottomGroup(parent)) continue;
      push(m);
    } else if (isBottomGroup(m) && !showSubtasks) {
      push(m);
    }
    // Containers (any non-leaf child) are never placed.
  }
  return out;
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
