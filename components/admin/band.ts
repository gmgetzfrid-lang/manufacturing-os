// Controls in a page's header (search, filters, small toggles), so every
// page's header reads the same. Grey and white; the signal color stays on
// the one main action.

/** A search box on the band (leave room on the left for an icon). */
export const bandInput =
  "w-full h-10 pl-10 pr-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] text-[15px] placeholder:text-[var(--color-text-faint)] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40";

/** The icon inside a band search box. */
export const bandInputIcon =
  "absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)] pointer-events-none";

/** A select on the band. */
export const bandSelect =
  "h-10 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] text-[14px] font-semibold outline-none focus:border-[var(--color-accent)] [&_option]:bg-[var(--color-surface)] [&_option]:text-[var(--color-text)]";

/** A row of toggles on the band (wrapper). */
export const bandSeg =
  "inline-flex items-center gap-0.5 p-0.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/** One toggle in a header row. The one you're on is a white raised
 *  segment with graphite text. */
export function bandSegItem(on: boolean): string {
  return `shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-8 px-3 rounded text-[14px] font-semibold transition-colors ${
    on ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-[0_1px_2px_rgb(31_39_51/0.15)] ring-1 ring-[var(--color-border-strong)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
  }`;
}

/** Plural helper: plural(3, "drawing") → "3 drawings". */
export function plural(n: number, one: string, many?: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : (many ?? `${one}s`)}`;
}
