// lib/estate/autoRead.ts — "read new drawings automatically", with a cap.
//
// Lives on the read library (knowledge_libraries.ai_features.autoRead). The
// Admin or document controller who switches it on is the sponsor: new sheets
// are read by the drawing reader on THEIR model, under their spend cap, and
// never more than `monthlyPages` pages a month. Past the cap new sheets are
// still indexed from their text layer and wait in "Read all drawings with AI".

export interface AutoRead {
  on: boolean;
  sponsor: string | null;
  sponsorName: string | null;
  monthlyPages: number;
  /** "YYYY-MM" the `used` count belongs to. */
  month: string;
  used: number;
}

export const DEFAULT_MONTHLY_PAGES = 200;

const monthOf = (now: Date) => now.toISOString().slice(0, 7);

export function readAutoRead(features: Record<string, unknown> | null | undefined, now = new Date()): AutoRead {
  const raw = ((features ?? {}) as Record<string, unknown>).autoRead as Partial<AutoRead> | undefined;
  const month = monthOf(now);
  const cap = Number(raw?.monthlyPages);
  return {
    on: raw?.on === true && !!raw?.sponsor,
    sponsor: typeof raw?.sponsor === "string" ? raw.sponsor : null,
    sponsorName: typeof raw?.sponsorName === "string" ? raw.sponsorName : null,
    monthlyPages: Number.isFinite(cap) && cap > 0 ? Math.min(Math.round(cap), 100_000) : DEFAULT_MONTHLY_PAGES,
    month,
    // A new month starts the count again.
    used: raw?.month === month ? Math.max(0, Number(raw?.used) || 0) : 0,
  };
}

export function pagesLeft(a: AutoRead): number {
  return a.on ? Math.max(0, a.monthlyPages - a.used) : 0;
}

/** ai_features with `pages` more used this month. */
export function withPagesUsed(features: Record<string, unknown> | null | undefined, pages: number, now = new Date()): Record<string, unknown> {
  const a = readAutoRead(features, now);
  return { ...(features ?? {}), autoRead: { ...a, used: a.used + Math.max(0, pages) } };
}
