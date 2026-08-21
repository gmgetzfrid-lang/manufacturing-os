// lib/bidTab.ts — BID TABULATION, pure.
//
// Vendors send quotes as PDFs; AI extraction (lib/quoteParse + the cost-docs
// route) turns each into a ParsedQuote. This module turns a pile of
// ParsedQuotes into the comparison a rookie can read and a boss can act on:
//
//   * normalized totals + labor economics (hours offered, blended $/hr,
//     headcount) — "who's offering the best deal for manpower to cost",
//   * scope-coverage flags — WHY the low bid is low (exclusions surfaced,
//     scope items the others priced that this bid didn't),
//   * a weighted best-value score whose math is always shown, never a
//     black box. Weights are inputs; price alone is never the verdict.
//
// Pure and unit-tested — no DB, no React. UI renders what this returns.

export interface QuoteLineItem {
  description: string;
  qty?: number | null;
  unit?: string | null;
  unitRate?: number | null;
  total?: number | null;
  craft?: string | null;       // pipefitter, electrician, scaffolder…
  hours?: number | null;       // labor hours this line represents
  headcount?: number | null;   // crew size, when stated
}

export interface ParsedQuote {
  id: string;                  // cost_documents.id
  vendorName: string;
  companyId?: string | null;   // Known Companies registry link, when matched
  total: number;
  currency?: string | null;
  validUntil?: string | null;
  lineItems: QuoteLineItem[];
  exclusions: string[];        // scope the vendor explicitly did NOT price
  notes?: string | null;
}

export interface BidEconomics {
  quoteId: string;
  vendorName: string;
  companyId: string | null;
  total: number;
  laborHours: number;          // Σ line hours (0 = not stated)
  blendedRate: number | null;  // labor $ / labor hours, null when hours unknown
  peakHeadcount: number | null;
  laborTotal: number;          // Σ totals of lines that carry hours
  exclusionCount: number;
  /** Scope items other bidders priced that THIS bid neither priced nor
   *  excluded explicitly — the silent-gap flag. */
  missingScope: string[];
  /** $ per labor hour across the WHOLE price — the manpower-to-cost number.
   *  Lower = more labor for the money. Null when hours unknown. */
  dollarsPerHour: number | null;
}

export interface BestValueWeights {
  price: number;               // default 0.5
  manpower: number;            // labor hours per dollar — default 0.3
  coverage: number;            // fewer gaps/exclusions — default 0.2
}

export const DEFAULT_WEIGHTS: BestValueWeights = { price: 0.5, manpower: 0.3, coverage: 0.2 };

export interface BidScore {
  quoteId: string;
  score: number;               // 0..100
  parts: { price: number; manpower: number; coverage: number }; // each 0..100, pre-weight
  best: boolean;
}

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Loose scope matching: one bid "priced" a scope item if any of its line
 *  descriptions or exclusions shares the item's normalized head words. */
function mentions(quote: ParsedQuote, item: string): boolean {
  const key = norm(item).split(" ").filter((w) => w.length > 3).slice(0, 3);
  if (key.length === 0) return true; // too generic to judge — never flag
  const hay = [
    ...quote.lineItems.map((l) => norm(l.description)),
    ...quote.exclusions.map(norm),
  ];
  // Two-thirds word overlap counts as a mention — "Insulation reinstatement"
  // in the exclusions must match the scope line "Insulation reinstatement
  // complete"; demanding every word would re-flag honestly-excluded scope.
  const need = Math.ceil((key.length * 2) / 3);
  return hay.some((h) => key.filter((w) => h.includes(w)).length >= need);
}

/** Economics per bid, computed against the whole field (for missing-scope). */
export function computeBidEconomics(quotes: ParsedQuote[]): BidEconomics[] {
  // The union of substantive scope lines across all bids — the yardstick a
  // single bid gets measured against.
  const scopeUnion: string[] = [];
  const seen = new Set<string>();
  for (const q of quotes) {
    for (const l of q.lineItems) {
      const k = norm(l.description);
      if (k.length > 8 && !seen.has(k)) { seen.add(k); scopeUnion.push(l.description); }
    }
  }

  return quotes.map((q) => {
    let hours = 0;
    let laborTotal = 0;
    let peak: number | null = null;
    for (const l of q.lineItems) {
      if (l.hours && l.hours > 0) {
        hours += l.hours;
        laborTotal += l.total ?? (l.unitRate && l.qty ? l.unitRate * l.qty : 0);
      }
      if (l.headcount && l.headcount > 0) peak = Math.max(peak ?? 0, l.headcount);
    }
    const missingScope = scopeUnion.filter(
      (item) => !q.lineItems.some((l) => norm(l.description) === norm(item)) && !mentions(q, item),
    );
    return {
      quoteId: q.id,
      vendorName: q.vendorName,
      companyId: q.companyId ?? null,
      total: q.total,
      laborHours: hours,
      blendedRate: hours > 0 && laborTotal > 0 ? laborTotal / hours : null,
      peakHeadcount: peak,
      laborTotal,
      exclusionCount: q.exclusions.length,
      missingScope,
      dollarsPerHour: hours > 0 ? q.total / hours : null,
    };
  });
}

/**
 * Weighted best value, math shown. Each part scores 0..100 relative to the
 * field (best bid = 100). A bid with unknown labor hours takes the field's
 * WORST manpower part — undisclosed manpower never beats disclosed manpower.
 */
export function scoreBids(
  econ: BidEconomics[],
  weights: BestValueWeights = DEFAULT_WEIGHTS,
): BidScore[] {
  if (econ.length === 0) return [];
  const wSum = weights.price + weights.manpower + weights.coverage || 1;

  const minTotal = Math.min(...econ.map((e) => e.total).filter((t) => t > 0));
  const knownDph = econ.map((e) => e.dollarsPerHour).filter((d): d is number => d != null && d > 0);
  const minDph = knownDph.length ? Math.min(...knownDph) : null;
  const maxGaps = Math.max(...econ.map((e) => e.missingScope.length + e.exclusionCount), 1);

  const scored = econ.map((e) => {
    const price = e.total > 0 && minTotal > 0 ? (minTotal / e.total) * 100 : 0;
    const manpower = e.dollarsPerHour != null && minDph != null
      ? (minDph / e.dollarsPerHour) * 100
      : 0; // undisclosed hours = floor, by design
    const gaps = e.missingScope.length + e.exclusionCount;
    const coverage = (1 - gaps / maxGaps) * 100;
    const score =
      (price * weights.price + manpower * weights.manpower + coverage * weights.coverage) / wSum;
    return {
      quoteId: e.quoteId,
      score: Math.round(score * 10) / 10,
      parts: {
        price: Math.round(price),
        manpower: Math.round(manpower),
        coverage: Math.round(coverage),
      },
      best: false,
    };
  });
  const top = Math.max(...scored.map((s) => s.score));
  for (const s of scored) s.best = s.score === top && top > 0;
  return scored;
}

/** Validate an AI-extracted quote payload into a safe ParsedQuote. Throws a
 *  plain message on a shape the review screen can't render. */
export function validateParsedQuote(raw: unknown, id: string): ParsedQuote {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") throw new Error("The quote extraction returned nothing readable.");
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const total = num(r.total);
  if (total == null || total < 0) throw new Error("Couldn't read a total price from the quote.");
  const items = Array.isArray(r.lineItems) ? r.lineItems : [];
  return {
    id,
    vendorName: str(r.vendorName) ?? "Unknown vendor",
    total,
    currency: str(r.currency),
    validUntil: str(r.validUntil),
    notes: str(r.notes),
    exclusions: Array.isArray(r.exclusions)
      ? r.exclusions.map((e) => str(e)).filter((e): e is string => !!e)
      : [],
    lineItems: items
      .map((l) => {
        const li = l as Record<string, unknown>;
        const description = str(li.description);
        if (!description) return null;
        return {
          description,
          qty: num(li.qty),
          unit: str(li.unit),
          unitRate: num(li.unitRate),
          total: num(li.total),
          craft: str(li.craft),
          hours: num(li.hours),
          headcount: num(li.headcount),
        } as QuoteLineItem;
      })
      .filter((l): l is QuoteLineItem => l !== null),
  };
}
