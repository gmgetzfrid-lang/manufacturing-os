// Controls in a page's header (search, filters, small toggles), so every
// page's header reads the same. White and grey on the page; the accent
// stays on the one main action. Focus is the app-wide ring (globals.css),
// so the edge never changes shade on focus.

/** A search box under the header (leave room on the left for an icon).
 *  16 px text on a phone, 44 px tall on touch screens. */
export const bandInput =
  "w-full h-10 pointer-coarse:h-11 pl-10 pr-3 rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] text-[var(--color-text)] text-reading placeholder:text-[var(--color-text-faint)] transition-colors";

/** The icon inside a header search box. */
export const bandInputIcon =
  "absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)] pointer-events-none";

/** A select in the header row. */
export const bandSelect =
  "h-10 pointer-coarse:h-11 px-3 rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] text-[var(--color-text)] text-body max-sm:text-reading font-medium [&_option]:bg-[var(--color-surface)] [&_option]:text-[var(--color-text)]";

/** A row of toggles in the header (wrapper). */
export const bandSeg =
  "inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/** One toggle in a header row. The one you're on is a white raised
 *  segment with text color. */
export function bandSegItem(on: boolean): string {
  return `shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-8 pointer-coarse:h-10 px-3 rounded-md text-body font-semibold transition-colors ${
    on ? "bg-[var(--color-surface)] text-[var(--color-text)] ring-1 ring-[var(--color-border-strong)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
  }`;
}

/** Plural helper: plural(3, "drawing") → "3 drawings". */
export function plural(n: number, one: string, many?: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : (many ?? `${one}s`)}`;
}
