// lib/scheduleColors.ts
//
// One shared color system for the whole schedule, so a group/phase is
// the SAME hue everywhere — timeline, calendar, report. This is the
// "what belongs to what" signal: identity is carried by HUE (the group
// a task rolls up to), while status stays on the bar fill / dot. Two
// channels, never fighting.
//
// Classes are written out in full (not interpolated) so Tailwind's
// JIT keeps them in the build.

export interface GroupColor {
  /** Solid accent — left rails, legend swatches, chip stripes. */
  rail: string;
  /** Faint background tint for a phase row / grouped band. */
  tint: string;
  /** Slightly stronger soft bg + border for chips. */
  soft: string;
  /** Text in the hue (labels). */
  text: string;
  /** Ring for focus/critical emphasis. */
  ring: string;
  /** Bare color token for dots. */
  dot: string;
}

// A curated, high-contrast-against-white palette. Ordered so adjacent
// groups are visually distinct (not two blues in a row).
export const GROUP_PALETTE: GroupColor[] = [
  { rail: "bg-indigo-500",  tint: "bg-indigo-50/50",  soft: "bg-indigo-50 border-indigo-200",   text: "text-indigo-700",  ring: "ring-indigo-400",  dot: "bg-indigo-500" },
  { rail: "bg-teal-500",    tint: "bg-teal-50/50",    soft: "bg-teal-50 border-teal-200",       text: "text-teal-700",    ring: "ring-teal-400",    dot: "bg-teal-500" },
  { rail: "bg-amber-500",   tint: "bg-amber-50/50",   soft: "bg-amber-50 border-amber-200",     text: "text-amber-700",   ring: "ring-amber-400",   dot: "bg-amber-500" },
  { rail: "bg-fuchsia-500", tint: "bg-fuchsia-50/50", soft: "bg-fuchsia-50 border-fuchsia-200", text: "text-fuchsia-700", ring: "ring-fuchsia-400", dot: "bg-fuchsia-500" },
  { rail: "bg-sky-500",     tint: "bg-sky-50/50",     soft: "bg-sky-50 border-sky-200",         text: "text-sky-700",     ring: "ring-sky-400",     dot: "bg-sky-500" },
  { rail: "bg-lime-600",    tint: "bg-lime-50/50",    soft: "bg-lime-50 border-lime-200",       text: "text-lime-700",    ring: "ring-lime-500",    dot: "bg-lime-600" },
  { rail: "bg-rose-500",    tint: "bg-rose-50/50",    soft: "bg-rose-50 border-rose-200",       text: "text-rose-700",    ring: "ring-rose-400",    dot: "bg-rose-500" },
  { rail: "bg-violet-500",  tint: "bg-violet-50/50",  soft: "bg-violet-50 border-violet-200",   text: "text-violet-700",  ring: "ring-violet-400",  dot: "bg-violet-500" },
  { rail: "bg-cyan-500",    tint: "bg-cyan-50/50",    soft: "bg-cyan-50 border-cyan-200",       text: "text-cyan-700",    ring: "ring-cyan-400",    dot: "bg-cyan-500" },
  { rail: "bg-orange-500",  tint: "bg-orange-50/50",  soft: "bg-orange-50 border-orange-200",   text: "text-orange-700",  ring: "ring-orange-400",  dot: "bg-orange-500" },
];

// Neutral hue for the single overarching root (the project envelope) so it
// reads as "the whole thing" rather than competing with its colored phases.
export const ROOT_COLOR: GroupColor = {
  rail: "bg-slate-400", tint: "bg-slate-50/60", soft: "bg-slate-100 border-slate-300",
  text: "text-slate-700", ring: "ring-slate-400", dot: "bg-slate-400",
};

interface MinimalNode { id?: string | null; parentId?: string | null; name: string; plannedStartAt?: unknown; plannedAt: unknown }

/** Build a stable id → palette-index map keyed by each task's color GROUP,
 *  assigned in schedule order so colors are stable across renders and read
 *  left-to-right warm→cool.
 *
 *  Normally the group is a task's TOP-level ancestor. But when the whole
 *  schedule rolls up to a SINGLE root ("Overall project" with everything
 *  beneath it), that would paint every task one hue — so we anchor on the
 *  root's DIRECT CHILDREN instead (each first-level phase gets its own hue),
 *  and the root itself stays neutral. `groups` is the ordered anchor list,
 *  used to render the color key. */
export function assignGroupColors<T extends MinimalNode>(items: T[]): {
  colorOf: (m: T) => GroupColor;
  indexOfGroup: (groupId: string) => number;
  topGroupOf: (m: T) => T;
  /** Ordered list of the color-anchor tasks (one per distinct hue). */
  groups: T[];
} {
  const byId = new Map<string, T>();
  for (const m of items) if (m.id) byId.set(m.id, m);

  const topGroupOf = (m: T): T => {
    let cur = m;
    const guard = new Set<string>();
    while (cur.parentId && byId.has(cur.parentId) && cur.id && !guard.has(cur.id)) {
      guard.add(cur.id);
      cur = byId.get(cur.parentId)!;
    }
    return cur;
  };

  const startMs = (m: T) => Date.parse((m.plannedStartAt as string | undefined) ?? (m.plannedAt as string));
  const bySchedule = (a: T, b: T) => (startMs(a) - startMs(b)) || (a.name || "").localeCompare(b.name || "");

  const tops = items.filter((m) => !m.parentId || !byId.has(m.parentId)).sort(bySchedule);
  const singleRoot = tops.length === 1 ? tops[0] : null;

  // The color anchor for a task: its top group, OR — under a single root —
  // the first-level phase it belongs to (the root anchors to itself).
  const anchorOf = (m: T): T => {
    if (!singleRoot) return topGroupOf(m);
    if (m.id && m.id === singleRoot.id) return m;
    let cur = m;
    const guard = new Set<string>();
    while (cur.parentId && cur.parentId !== singleRoot.id && byId.has(cur.parentId) && cur.id && !guard.has(cur.id)) {
      guard.add(cur.id);
      cur = byId.get(cur.parentId)!;
    }
    return cur;
  };

  const anchors = (singleRoot
    ? items.filter((m) => m.parentId === singleRoot.id)
    : tops
  ).sort(bySchedule);

  const idx = new Map<string, number>();
  anchors.forEach((t, i) => { if (t.id) idx.set(t.id, i % GROUP_PALETTE.length); });

  const indexOfGroup = (groupId: string) => idx.get(groupId) ?? 0;
  const colorOf = (m: T): GroupColor => {
    const a = anchorOf(m);
    if (singleRoot && a.id && a.id === singleRoot.id) return ROOT_COLOR;
    return GROUP_PALETTE[a.id ? indexOfGroup(a.id) : 0];
  };
  return { colorOf, indexOfGroup, topGroupOf, groups: anchors };
}
