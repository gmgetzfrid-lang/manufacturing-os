// Controls that sit on the dark page band (search, filters, small
// toggles). Same tokens as PageHero's heroQuiet, so every admin page's band
// reads the same. Ink and paper only: the orange stays on the one action.

/** A search box on the band (leave room on the left for an icon). */
export const bandInput =
  "w-full h-11 pl-10 pr-3 rounded-xl border border-[var(--color-ink-line)] bg-[var(--color-ink-2)] text-white text-[15px] placeholder:text-[var(--color-ink-muted)] outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)]";

/** The icon inside a band search box. */
export const bandInputIcon =
  "absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-ink-muted)] pointer-events-none";

/** A select on the band. */
export const bandSelect =
  "h-11 px-3 rounded-xl border border-[var(--color-ink-line)] bg-[var(--color-ink-2)] text-[var(--color-ink-fg)] text-[13px] font-semibold outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)] [&_option]:bg-[var(--color-surface)] [&_option]:text-[var(--color-text)]";

/** A row of toggles on the band (wrapper). */
export const bandSeg =
  "inline-flex items-center gap-1 p-1 rounded-xl border border-[var(--color-ink-line)] bg-[var(--color-ink-2)] max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/** One toggle in a band row (matches ViewTabs' dark tabs). */
export function bandSegItem(on: boolean): string {
  return `shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-semibold transition-colors ${
    on ? "bg-[var(--color-ink-line)] text-white" : "text-[var(--color-ink-muted)] hover:text-white"
  }`;
}

/** Plural helper: plural(3, "drawing") → "3 drawings". */
export function plural(n: number, one: string, many?: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : (many ?? `${one}s`)}`;
}
