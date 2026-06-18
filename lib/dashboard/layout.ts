// lib/dashboard/layout.ts
//
// Pure geometry for the dashboard's free-form 12-column grid.
//
// Every widget carries an explicit (x, y) origin plus a (w, h) span, so the user
// can drop it anywhere. These helpers keep a layout legal and tidy with VERTICAL
// COMPACTION (the react-grid-layout `compactType: "vertical"` model): after any
// move / resize / removal, widgets float straight up to fill empty rows so there
// are never holes, while never overlapping. No framework — just the slice we
// need, fully unit-tested.

export interface LayoutItem {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Do two items overlap? An item never collides with itself. */
export function collides(a: LayoutItem, b: LayoutItem): boolean {
  if (a.id === b.id) return false;
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function overlapsAny(placed: LayoutItem[], probe: LayoutItem): boolean {
  for (const p of placed) {
    if (p.x < probe.x + probe.w && p.x + p.w > probe.x && p.y < probe.y + probe.h && p.y + p.h > probe.y) {
      return true;
    }
  }
  return false;
}

/** First placed item that overlaps `target`, if any (geometry only — ignores id). */
export function getFirstCollision(items: LayoutItem[], target: LayoutItem): LayoutItem | undefined {
  for (const it of items) {
    if (it === target) continue;
    if (it.x < target.x + target.w && it.x + it.w > target.x && it.y < target.y + target.h && it.y + it.h > target.y) {
      return it;
    }
  }
  return undefined;
}

/** Lowest occupied row (max y + h). 0 for an empty layout. */
export function bottomRow(items: LayoutItem[]): number {
  let max = 0;
  for (const it of items) max = Math.max(max, it.y + it.h);
  return max;
}

function clampSpan(w: number, cols: number): number {
  if (!Number.isFinite(w)) return 1;
  return Math.max(1, Math.min(cols, Math.round(w)));
}

/**
 * Top-compact a layout: pull every widget up as far as it will go without
 * overlapping, removing all vertical holes. Widgets keep their column (x).
 *
 * `movingId` (the widget under the cursor during a drag/resize) wins ties so it
 * claims the row the user is pointing at and the others settle around it. The
 * returned array preserves the INPUT order (stable React keys); only x/y change.
 */
export function compactVertical<T extends LayoutItem>(items: T[], cols: number, movingId?: string): T[] {
  const sorted = items
    .map((it) => ({ ...it }))
    .sort((a, b) =>
      a.y - b.y ||
      (a.id === movingId ? -1 : b.id === movingId ? 1 : 0) ||
      a.x - b.x,
    );

  const placed: T[] = [];
  for (const it of sorted) {
    it.x = Math.max(0, Math.min(it.x, cols - it.w));
    let y = Math.max(0, it.y);
    // Float up while the row above is clear...
    while (y > 0 && !overlapsAny(placed, { ...it, y: y - 1 })) y--;
    // ...then nudge down off anything we still overlap at this row.
    while (overlapsAny(placed, { ...it, y })) y++;
    it.y = y;
    placed.push(it);
  }

  // Re-emit in the caller's original order so React keys / diffs stay stable.
  const byId = new Map(placed.map((p) => [p.id, p]));
  return items.map((it) => byId.get(it.id)!);
}

/**
 * Move `id` to (x, y) — clamped to the grid — then top-compact. Widgets the
 * moved one lands on are shoved to the correct SIDE first (above it when you
 * drag down, below it when you drag up) so dragging past a neighbour swaps them
 * instead of the moved tile just floating back. Returns a new array; inputs
 * are untouched.
 */
export function moveElement<T extends LayoutItem>(layout: T[], id: string, x: number, y: number, cols: number): T[] {
  const items = layout.map((it) => ({ ...it }));
  const moving = items.find((it) => it.id === id);
  if (!moving) return layout;
  const newX = Math.max(0, Math.min(Math.round(x), cols - moving.w));
  const newY = Math.max(0, Math.round(y));
  const movingDown = newY > moving.y;
  moving.x = newX;
  moving.y = newY;
  for (const c of items) {
    if (c.id === moving.id || !collides(c, moving)) continue;
    c.y = movingDown ? Math.max(0, moving.y - c.h) : moving.y + moving.h;
  }
  return compactVertical(items, cols);
}

/**
 * Resize `id` to (w, h) — clamped to the grid and nudged left if it would spill
 * past the right edge — then top-compact.
 */
export function resizeElement<T extends LayoutItem>(layout: T[], id: string, w: number, h: number, cols: number): T[] {
  const items = layout.map((it) => ({ ...it }));
  const target = items.find((it) => it.id === id);
  if (!target) return layout;
  target.w = clampSpan(w, cols);
  target.h = Math.max(1, Math.round(h));
  if (target.x + target.w > cols) target.x = cols - target.w;
  return compactVertical(items, cols, id);
}

/** Highest free (x, y) slot a w×h widget fits into, scanning row-major. */
export function firstFreeSlot(items: LayoutItem[], w: number, h: number, cols: number): { x: number; y: number } {
  const ww = clampSpan(w, cols);
  const hh = Math.max(1, Math.round(h));
  for (let y = 0; ; y++) {
    for (let x = 0; x + ww <= cols; x++) {
      if (!overlapsAny(items, { id: "__probe__", x, y, w: ww, h: hh })) return { x, y };
    }
  }
}

/**
 * Assign (x, y) to an ordered list via first-fit packing — used to convert a
 * legacy array-ordered layout (and to build defaults) into explicit, already
 * top-compacted coordinates. Item order defines priority.
 */
export function packLayout<T extends { id: string; w: number; h: number }>(
  items: T[],
  cols: number,
): (T & { x: number; y: number })[] {
  const placed: (T & LayoutItem)[] = [];
  for (const it of items) {
    const w = clampSpan(it.w, cols);
    const h = Math.max(1, Math.round(it.h));
    const { x, y } = firstFreeSlot(placed, w, h, cols);
    placed.push({ ...it, x, y, w, h });
  }
  return placed;
}
