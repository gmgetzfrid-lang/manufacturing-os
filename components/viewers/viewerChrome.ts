// The charcoal frame every drawing viewer shares. The drawing is the subject;
// the chrome around it is quiet: one big title (which drawing), small tools,
// one orange action. Opened over a page, the page behind is dimmed and shows
// at the edges so you know where you'll land when you close it.
//
// Use inside an element with `surface-charcoal` (vPanel has it), so the text
// tokens read light on dark.

/** The dimmed page behind a viewer. */
export const vDim =
  "absolute inset-0 bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] animate-in fade-in duration-200";

/** The viewer itself: charcoal, raised over the dimmed page (full screen on a phone). */
export const vPanel =
  "surface-charcoal ui-float absolute inset-0 sm:top-3 sm:inset-x-3 sm:bottom-0 sm:rounded-t-xl overflow-hidden flex flex-col animate-in fade-in duration-200 motion-reduce:animate-none";

/** Small line over the title: revision, status. */
export const vKicker =
  "truncate text-body text-[var(--color-text-muted)]";

/** The drawing's name: the one big thing in the chrome. */
export const vTitle =
  "font-display truncate text-[24px] sm:text-[26px] leading-[1.1] font-semibold tabular-nums text-[var(--color-text)]";

/** A quiet icon button on the charcoal. */
export const vIcon =
  "w-10 h-10 pointer-coarse:w-11 pointer-coarse:h-11 shrink-0 rounded-lg grid place-items-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-ink-2)] disabled:opacity-30 disabled:pointer-events-none transition-colors";

/** A tool button: quiet, or a white pill when it's the chosen one (never
 *  orange: orange is only for the one action). Whatever the size, it is
 *  44 px on a touch screen. */
export function vTool(on: boolean, size = "w-10 h-10") {
  return `${size} pointer-coarse:w-11 pointer-coarse:h-11 shrink-0 rounded-lg grid place-items-center transition-colors ${on
    ? "bg-[var(--color-ink-fg)] text-[var(--color-ink)]"
    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-ink-2)]"}`;
}

/** A quiet text button on the charcoal. */
export const vQuiet =
  "inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3 shrink-0 rounded-lg bg-[var(--color-ink-2)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-ink-line)] disabled:opacity-40 disabled:pointer-events-none transition-colors";

/** A pill holding a small set of controls (page arrows, zoom). */
export const vGroup =
  "flex items-center h-10 pointer-coarse:h-11 shrink-0 rounded-lg bg-[var(--color-ink-2)] text-body font-medium tabular-nums text-[var(--color-text)]";

/** The one orange action, sized for the chrome. */
export const vPrimary =
  "inline-flex items-center justify-center gap-2 h-10 pointer-coarse:h-11 px-4 shrink-0 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-reading font-medium hover:bg-[var(--color-accent-hover)] disabled:opacity-50 transition-colors";

/** The way out (X), top right. */
export const vClose =
  "w-10 h-10 pointer-coarse:w-11 pointer-coarse:h-11 shrink-0 rounded-lg grid place-items-center bg-[var(--color-ink-2)] text-[var(--color-text)] hover:bg-[var(--color-ink-line)] disabled:opacity-50 transition-colors";

/** A thin line in the chrome that says something about this drawing. */
export const vNote =
  "shrink-0 px-4 sm:px-5 py-1.5 flex items-center gap-2 text-body border-b border-[var(--color-border)]";
