// lib/rowWindow.ts
//
// Windowed rendering for fixed-height row lists (PT PERF-5). The execution
// board rendered every row twice — an outline row and a bar — into a
// 70vh scroller that shows about fifteen: ~8,000–15,000 DOM nodes for a
// 400-row schedule, and all of them re-rendered on every drag frame. The
// board now renders only the rows in (or just around) the viewport; the
// rest are a spacer of the same height, so the scroll range, the row
// positions and the absolutely-positioned bars are unchanged.
//
// No dependency: the rows are a fixed height, so the window is arithmetic.
// Pure + tested.

export interface RowWindow {
  /** First row index to render (inclusive). */
  start: number;
  /** One past the last row index to render (exclusive). */
  end: number;
}

/**
 * The rows to render for a scroller.
 *
 *   scrollTop       the scroller's scrollTop (px)
 *   viewportHeight  its clientHeight (px); 0 before the first measure
 *   rowHeight       fixed row height (px)
 *   headerHeight    sticky content above row 0 inside the scroller (px)
 *   count           number of rows
 *   overscan        rows rendered beyond each edge, so a fast scroll or a
 *                   keyboard step never shows a gap (default 8)
 *   initialRows     rows rendered before the first measure (default 40)
 */
export function rowWindow(p: {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  headerHeight?: number;
  count: number;
  overscan?: number;
  initialRows?: number;
}): RowWindow {
  const count = Math.max(0, Math.floor(p.count));
  if (count === 0 || !(p.rowHeight > 0)) return { start: 0, end: 0 };
  const overscan = Math.max(0, Math.floor(p.overscan ?? 8));
  if (!(p.viewportHeight > 0)) return { start: 0, end: Math.min(count, Math.max(1, p.initialRows ?? 40)) };
  const top = Math.max(0, p.scrollTop - (p.headerHeight ?? 0));
  const first = Math.floor(top / p.rowHeight);
  const last = Math.ceil((top + p.viewportHeight) / p.rowHeight);
  const start = Math.min(count, Math.max(0, first - overscan));
  const end = Math.min(count, Math.max(start, last + overscan));
  return { start, end };
}

/** The scrollTop that brings row `index` fully into view, or null when it
 *  already is — the windowed replacement for element.scrollIntoView, which
 *  cannot reach a row that is not rendered. */
export function scrollTopToReveal(p: {
  index: number;
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  headerHeight?: number;
}): number | null {
  const header = p.headerHeight ?? 0;
  const rowTop = header + p.index * p.rowHeight;
  const rowBottom = rowTop + p.rowHeight;
  const visibleTop = p.scrollTop + header; // the sticky header covers the top band
  const visibleBottom = p.scrollTop + p.viewportHeight;
  if (rowTop < visibleTop) return Math.max(0, rowTop - header);
  if (rowBottom > visibleBottom) return Math.max(0, rowBottom - p.viewportHeight);
  return null;
}
