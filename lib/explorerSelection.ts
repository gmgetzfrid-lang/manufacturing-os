// lib/explorerSelection.ts
//
// Windows-Explorer selection semantics as a pure state machine. The library
// page (and any future file surface) feeds it the ORDERED visible item ids
// plus the gesture; it returns the next selection. Keeping it pure means the
// exact click/keyboard contract — the thing muscle memory depends on — is
// pinned by unit tests instead of living implicitly inside a 3,800-line page.
//
// The contract (matching Windows File Explorer):
//   click            → select just that item; it becomes the anchor + focus
//   ctrl+click       → toggle that item; it becomes the anchor + focus
//   shift+click      → select the contiguous range anchor→item (replaces)
//   ctrl+shift+click → ADD the range anchor→item to the selection
//   arrow            → move focus, select just the focused item, reset anchor
//   shift+arrow      → extend the range anchor→focus (replaces)
//   ctrl+arrow       → move focus only; selection untouched (space toggles)
//   ctrl+space       → toggle the focused item without moving
//   Home/End         → jump to first/last (same modifier rules as arrows)
//   ctrl+A           → select everything
//   Escape           → clear
//   type-ahead       → jump focus/selection to the next item whose label
//                      starts with the typed buffer (wraps around)

export interface ExplorerSelection {
  /** Selected item ids. */
  ids: ReadonlySet<string>;
  /** Range anchor — where shift-ranges grow from. */
  anchorId: string | null;
  /** Keyboard focus — the item arrows move from. */
  focusId: string | null;
}

export interface SelectionMods {
  ctrl?: boolean;
  shift?: boolean;
}

export function emptySelection(): ExplorerSelection {
  return { ids: new Set(), anchorId: null, focusId: null };
}

function rangeBetween(order: readonly string[], a: string, b: string): string[] {
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  // An endpoint that vanished from view (filter change, doc moved) degrades
  // to a single-item range instead of throwing or selecting everything.
  if (ia === -1 && ib === -1) return [];
  if (ia === -1) return [b];
  if (ib === -1) return [a];
  const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
  return order.slice(lo, hi + 1);
}

/** Mouse click on an item. */
export function clickItem(
  state: ExplorerSelection,
  order: readonly string[],
  id: string,
  mods: SelectionMods = {},
): ExplorerSelection {
  if (mods.shift) {
    const anchor = state.anchorId && order.includes(state.anchorId) ? state.anchorId : id;
    const range = rangeBetween(order, anchor, id);
    const ids = mods.ctrl ? new Set([...state.ids, ...range]) : new Set(range);
    // The anchor deliberately stays put so a follow-up shift+click re-pivots
    // around the same origin — exactly how Explorer behaves.
    return { ids, anchorId: anchor, focusId: id };
  }
  if (mods.ctrl) {
    const ids = new Set(state.ids);
    if (ids.has(id)) ids.delete(id); else ids.add(id);
    return { ids, anchorId: id, focusId: id };
  }
  return { ids: new Set([id]), anchorId: id, focusId: id };
}

/** Right-click: a selected item keeps the selection (the menu acts on all of
 *  it); an unselected item becomes the sole selection first. */
export function contextClickItem(
  state: ExplorerSelection,
  order: readonly string[],
  id: string,
): ExplorerSelection {
  if (state.ids.has(id)) return { ...state, focusId: id };
  return clickItem(state, order, id, {});
}

export type MoveKey = "up" | "down" | "home" | "end" | "pageUp" | "pageDown";

function targetIndex(order: readonly string[], from: number, key: MoveKey, pageSize: number): number {
  switch (key) {
    case "up": return Math.max(0, from - 1);
    case "down": return Math.min(order.length - 1, from + 1);
    case "home": return 0;
    case "end": return order.length - 1;
    case "pageUp": return Math.max(0, from - pageSize);
    case "pageDown": return Math.min(order.length - 1, from + pageSize);
  }
}

/** Keyboard navigation (arrows / Home / End / PageUp / PageDown). */
export function moveFocus(
  state: ExplorerSelection,
  order: readonly string[],
  key: MoveKey,
  mods: SelectionMods = {},
  pageSize = 10,
): ExplorerSelection {
  if (order.length === 0) return state;
  const fromIdx = state.focusId ? order.indexOf(state.focusId) : -1;
  // No focus yet: land on the first (or last, for "up"/"end") item.
  const idx = fromIdx === -1
    ? (key === "up" || key === "end" ? order.length - 1 : 0)
    : targetIndex(order, fromIdx, key, pageSize);
  const id = order[idx];
  if (mods.ctrl && !mods.shift) {
    // Focus travels alone; selection stays. (Space then toggles.)
    return { ...state, focusId: id };
  }
  if (mods.shift) {
    const anchor = state.anchorId && order.includes(state.anchorId) ? state.anchorId : (state.focusId ?? id);
    return { ids: new Set(rangeBetween(order, anchor, id)), anchorId: anchor, focusId: id };
  }
  return { ids: new Set([id]), anchorId: id, focusId: id };
}

/** Ctrl+Space — toggle the focused item in place. */
export function toggleFocused(state: ExplorerSelection): ExplorerSelection {
  if (!state.focusId) return state;
  const ids = new Set(state.ids);
  if (ids.has(state.focusId)) ids.delete(state.focusId); else ids.add(state.focusId);
  return { ...state, ids, anchorId: state.focusId };
}

export function selectAll(order: readonly string[]): ExplorerSelection {
  return {
    ids: new Set(order),
    anchorId: order[0] ?? null,
    focusId: order[order.length - 1] ?? null,
  };
}

/** Drop ids that are no longer visible (filter/sort/move changed the list).
 *  Returns the same object when nothing changed so React state stays stable. */
export function pruneSelection(
  state: ExplorerSelection,
  order: readonly string[],
): ExplorerSelection {
  const visible = new Set(order);
  let dirty = false;
  const ids = new Set<string>();
  for (const id of state.ids) {
    if (visible.has(id)) ids.add(id); else dirty = true;
  }
  const anchorId = state.anchorId && visible.has(state.anchorId) ? state.anchorId : null;
  const focusId = state.focusId && visible.has(state.focusId) ? state.focusId : null;
  if (!dirty && anchorId === state.anchorId && focusId === state.focusId) return state;
  return { ids, anchorId, focusId };
}

// ── Type-ahead ──────────────────────────────────────────────────────────
// Explorer's "type the first letters of a name" jump. The caller owns the
// timing (reset the buffer after ~700ms of silence); this is just the match.

export interface TypeAheadItem { id: string; label: string }

export function typeAheadTarget(
  items: readonly TypeAheadItem[],
  buffer: string,
  fromId: string | null,
): string | null {
  const needle = buffer.trim().toLowerCase();
  if (!needle) return null;
  const start = fromId ? items.findIndex((i) => i.id === fromId) : -1;
  const n = items.length;
  // Repeatedly typing one letter cycles through items starting with it, so
  // a single-char buffer searches AFTER the current focus; longer buffers
  // (still spelling one name) search FROM the focus, wrapping either way.
  const offset = needle.length === 1 ? 1 : 0;
  for (let step = 0; step < n; step++) {
    const item = items[(start + offset + step + n) % n];
    if (item.label.toLowerCase().startsWith(needle)) return item.id;
  }
  return null;
}
