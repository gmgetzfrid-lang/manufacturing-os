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
// Honesty rules (projects Round G, DEC-44 — BID-3/BID-4/BID-6/BID-7/BID-8
// and COST-5):
//   * A DECLARED exclusion never lowers a score — the RFQ letter promises
//     it, and a scorer that punishes disclosure teaches vendors to hide
//     scope. Exclusions are shown as facts beside the price.
//   * "Silent gap" detection is word matching on free text: it cannot tell
//     a rewording from an omission, so it is a PROMPT ("not obviously
//     covered — check") and never enters the score.
//   * With neither in the score, the coverage part is NOT SCORED (null)
//     until a per-RFQ scope checklist exists; the composite is price +
//     manpower with the weights renormalised.
//   * Labour hours are vendor-stated and AI-extracted. Among bids that
//     state them they move the composite by at most
//     MANPOWER_MAX_COMPOSITE_SWING points; a bid that states none takes
//     the floor (the letter asks for hours — silence is non-compliance).
//   * A best-value badge needs at least two scored bids and a unique top;
//     a tie is a tie. A mixed-currency field is not scored at all.
//   * A human-typed total (price-only bid) enters the price normalisation
//     and shows "not scored" for the parts it cannot have — never a 0.
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
  /** True when the total was typed by a human because the file had no
   *  readable line detail (BID-8): it competes on price only. */
  priceOnly?: boolean;
  /** Where `total` came from (BID-1 / GAP-407): the extraction, or a
   *  human correction. When "human", `extractedTotal` keeps the model's
   *  original number visible — a correction never hides what was read. */
  totalSource?: "extracted" | "human";
  extractedTotal?: number | null;
}

export interface BidEconomics {
  quoteId: string;
  vendorName: string;
  companyId: string | null;
  total: number;
  /** ISO-4217 code as stored on the row; null = not printed / unknown. */
  currency: string | null;
  priceOnly: boolean;
  totalSource: "extracted" | "human";
  extractedTotal: number | null;
  laborHours: number;          // Σ line hours (0 = not stated)
  blendedRate: number | null;  // labor $ / labor hours, null when hours unknown
  peakHeadcount: number | null;
  laborTotal: number;          // Σ totals of lines that carry hours
  exclusionCount: number;
  /** Scope items other bidders priced that THIS bid neither obviously
   *  priced nor excluded — "not obviously covered — check the PDF". A
   *  PROMPT for the reviewer, never an accusation and never in the score
   *  (BID-4): word matching cannot tell a rewording from an omission. */
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

/** Hours are vendor-stated: among bids that state them, the manpower
 *  part may move the composite by at most this many points (COST-5). */
export const MANPOWER_MAX_COMPOSITE_SWING = 5;

export interface BidScore {
  quoteId: string;
  /** 0..100, or null when this bid is not scored — see `unscored`. */
  score: number | null;
  /** Each 0..100 pre-weight; null = not scored for this bid ("not
   *  scored", never a 0). Coverage is null for every bid until a per-RFQ
   *  scope checklist exists (DEC-44). */
  parts: { price: number | null; manpower: number | null; coverage: number | null };
  best: boolean;
  /** Shares the top score with another bid — rendered as a tie, no badge. */
  tied: boolean;
  unscored: null | "price-only" | "mixed-currency";
}

/** The weights that actually enter the composite while coverage is not
 *  scored — price and manpower, renormalised to sum to 1. */
export function effectiveWeights(weights: BestValueWeights = DEFAULT_WEIGHTS): { price: number; manpower: number } {
  const wSum = weights.price + weights.manpower || 1;
  return { price: weights.price / wSum, manpower: weights.manpower / wSum };
}

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// Filler that carries no scope meaning — never a matching token.
const STOP = new Set(["and", "the", "of", "at", "to", "per", "for", "in", "on", "with", "all", "new", "as", "by", "or"]);

/** Content tokens of a scope line: normalised words minus filler and bare
 *  numbers. Craft abbreviations (NDE, RT, UT, PMI…) are short but real,
 *  so 2-letter tokens are kept. */
function scopeTokens(s: string): Set<string> {
  return new Set(norm(s).split(" ").filter((w) => w.length >= 2 && !STOP.has(w) && !/^\d+$/.test(w)));
}

/** Two tokens name the same thing when equal or when one is a 4+-letter
 *  prefix of the other — "repipe"/"repiping", "spool"/"spools",
 *  "demo"/"demolition", "insulation"/"insulated". Whole tokens only:
 *  "under" never counts as a mention of "nde". */
const sameToken = (a: string, b: string) =>
  a === b || (a.length >= 4 && b.startsWith(a)) || (b.length >= 4 && a.startsWith(b));

/** Token-set similarity: shared tokens over the SMALLER set. An exclusion
 *  "Insulation reinstatement" against the scope line "Insulation
 *  reinstatement complete" is 2/2 = 1.0. */
export function scopeSimilarity(a: string, b: string): number {
  const A = [...scopeTokens(a)], B = [...scopeTokens(b)];
  if (A.length === 0 || B.length === 0) return 0;
  const shared = A.filter((x) => B.some((y) => sameToken(x, y))).length;
  return shared / Math.min(A.length, B.length);
}

/** The bar a bid's own wording must clear to be treated as covering a
 *  scope item another bidder priced: at least this similarity AND at least
 *  two shared content tokens (one shared word — "existing", "piping" — is
 *  not evidence of anything). Anything below is a CHECK prompt, not a gap. */
export const SCOPE_MATCH_THRESHOLD = 0.5;

/** Does this bid's own text (line items or declared exclusions) plausibly
 *  cover a scope item? Generic items (no content tokens) are never flagged. */
function mentions(quote: ParsedQuote, item: string): boolean {
  const itemTokens = scopeTokens(item);
  if (itemTokens.size === 0) return true; // too generic to judge — never flag
  const hay = [...quote.lineItems.map((l) => l.description), ...quote.exclusions];
  return hay.some((h) => {
    const sim = scopeSimilarity(h, item);
    if (sim < SCOPE_MATCH_THRESHOLD) return false;
    const H = [...scopeTokens(h)];
    const shared = [...itemTokens].filter((x) => H.some((y) => sameToken(x, y))).length;
    // A one-token item (an abbreviation like "NDE") is matched by that token.
    return shared >= Math.min(2, itemTokens.size);
  });
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
    // A price-only bid has NO readable line detail — its scope is unknown
    // to the system, not undisclosed by the vendor — so nothing is
    // prompted against it.
    const missingScope = q.priceOnly ? [] : scopeUnion.filter(
      (item) => !q.lineItems.some((l) => norm(l.description) === norm(item)) && !mentions(q, item),
    );
    return {
      quoteId: q.id,
      vendorName: q.vendorName,
      companyId: q.companyId ?? null,
      total: q.total,
      currency: isoCurrency(q.currency),
      priceOnly: !!q.priceOnly,
      totalSource: q.totalSource ?? "extracted",
      extractedTotal: q.extractedTotal ?? null,
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
 * Weighted best value, math shown. Price and manpower each score 0..100
 * relative to the field (best bid = 100). A bid with unknown labor hours
 * takes the field's WORST manpower part — undisclosed manpower never beats
 * disclosed manpower — while among bids that state hours the (vendor-
 * stated) number moves the composite by at most
 * MANPOWER_MAX_COMPOSITE_SWING points. Coverage is not scored (DEC-44).
 * A mixed-currency field is refused: every score is null.
 */
export function scoreBids(
  econ: BidEconomics[],
  weights: BestValueWeights = DEFAULT_WEIGHTS,
): BidScore[] {
  if (econ.length === 0) return [];
  const unscoredAll = (why: BidScore["unscored"]): BidScore[] => econ.map((e) => ({
    quoteId: e.quoteId, score: null, parts: { price: null, manpower: null, coverage: null },
    best: false, tied: false, unscored: why,
  }));
  if (fieldCurrency(econ).mixed) return unscoredAll("mixed-currency");

  const wSum = weights.price + weights.manpower || 1;
  // Composite points per manpower point; the floor keeps the swing bounded.
  const manpowerShare = weights.manpower / wSum;
  const floor = manpowerShare > 0 ? Math.max(0, 100 - MANPOWER_MAX_COMPOSITE_SWING / manpowerShare) : 100;

  // Every bid — typed totals included — enters the price normalisation.
  const positive = econ.map((e) => e.total).filter((t) => t > 0);
  const minTotal = positive.length ? Math.min(...positive) : 0;
  const knownDph = econ
    .filter((e) => !e.priceOnly)
    .map((e) => e.dollarsPerHour)
    .filter((d): d is number => d != null && d > 0);
  const minDph = knownDph.length ? Math.min(...knownDph) : null;

  const scored: BidScore[] = econ.map((e) => {
    // The > 0 guard matters: a zero-dollar "bid" would otherwise divide to
    // Infinity and crown itself best value.
    const price = e.total > 0 && minTotal > 0 ? (minTotal / e.total) * 100 : 0;
    if (e.priceOnly) {
      return {
        quoteId: e.quoteId, score: null,
        parts: { price: Math.round(price), manpower: null, coverage: null },
        best: false, tied: false, unscored: "price-only",
      };
    }
    const manpower = e.dollarsPerHour != null && e.dollarsPerHour > 0 && minDph != null
      ? floor + (minDph / e.dollarsPerHour) * (100 - floor)
      : 0; // undisclosed hours = floor, by design
    const score = (price * weights.price + manpower * weights.manpower) / wSum;
    return {
      quoteId: e.quoteId,
      score: Math.round(score * 10) / 10,
      parts: { price: Math.round(price), manpower: Math.round(manpower), coverage: null },
      best: false, tied: false, unscored: null,
    };
  });

  // A badge needs a field (two or more scored bids) and a unique top.
  const ranked = scored.filter((s): s is BidScore & { score: number } => s.score != null);
  if (ranked.length >= 2) {
    const top = Math.max(...ranked.map((s) => s.score));
    const atTop = ranked.filter((s) => s.score === top);
    if (atTop.length === 1 && top > 0) atTop[0].best = true;
    else if (atTop.length > 1) for (const s of atTop) s.tied = true;
  }
  return scored;
}

// ── Currency (COST-8 tabulation limb / BID-7) ─────────────────────────────

/** Active ISO-4217 alphabetic codes. A model's free-text currency is only
 *  ever stored when it is one of these; anything else is null (unknown). */
export const ISO_4217 = new Set([
  "AED","AFN","ALL","AMD","ANG","AOA","ARS","AUD","AWG","AZN","BAM","BBD","BDT","BGN","BHD","BIF","BMD","BND","BOB","BRL","BSD","BTN","BWP","BYN","BZD",
  "CAD","CDF","CHF","CLP","CNY","COP","CRC","CUP","CVE","CZK","DJF","DKK","DOP","DZD","EGP","ERN","ETB","EUR","FJD","FKP","GBP","GEL","GHS","GIP","GMD",
  "GNF","GTQ","GYD","HKD","HNL","HTG","HUF","IDR","ILS","INR","IQD","IRR","ISK","JMD","JOD","JPY","KES","KGS","KHR","KMF","KPW","KRW","KWD","KYD","KZT",
  "LAK","LBP","LKR","LRD","LSL","LYD","MAD","MDL","MGA","MKD","MMK","MNT","MOP","MRU","MUR","MVR","MWK","MXN","MYR","MZN","NAD","NGN","NIO","NOK","NPR",
  "NZD","OMR","PAB","PEN","PGK","PHP","PKR","PLN","PYG","QAR","RON","RSD","RUB","RWF","SAR","SBD","SCR","SDG","SEK","SGD","SHP","SLE","SOS","SRD","SSP",
  "STN","SVC","SYP","SZL","THB","TJS","TMT","TND","TOP","TRY","TTD","TWD","TZS","UAH","UGX","USD","UYU","UZS","VES","VND","VUV","WST","XAF","XCD","XOF",
  "XPF","YER","ZAR","ZMW","ZWG","ZWL",
]);

/** A known ISO-4217 code (upper-cased, trimmed) or null — never free text. */
export function isoCurrency(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return ISO_4217.has(code) ? code : null;
}

/** The field's currency. Bids whose currency is unknown (null) are taken
 *  to be in the field's currency; two or more DISTINCT known currencies
 *  make the field mixed — not commensurate, not scored. */
export function fieldCurrency(econ: Array<{ currency: string | null }>): { currency: string | null; currencies: string[]; mixed: boolean } {
  const currencies = [...new Set(econ.map((e) => e.currency).filter((c): c is string => !!c))];
  return { currency: currencies.length === 1 ? currencies[0] : null, currencies, mixed: currencies.length > 1 };
}

// ── One authoritative total (BID-1 / GAP-407) ─────────────────────────────

/** Overlay the row's human-visible total onto the extraction so display,
 *  score and award all use ONE number. The model's original stays on the
 *  quote as `extractedTotal` — a correction never hides what was read. */
export function withHumanTotal(q: ParsedQuote, rowTotal: number | null | undefined): ParsedQuote {
  if (rowTotal == null || !(rowTotal > 0) || rowTotal === q.total) return { ...q, totalSource: q.totalSource ?? "extracted" };
  return { ...q, total: rowTotal, totalSource: "human", extractedTotal: q.extractedTotal ?? q.total };
}

/** A bid whose only readable number is a human-typed total (BID-8). */
export function priceOnlyQuote(input: { id: string; vendorName: string; total: number; currency?: string | null }): ParsedQuote {
  return {
    id: input.id, vendorName: input.vendorName, total: input.total, currency: input.currency ?? null,
    validUntil: null, notes: null, lineItems: [], exclusions: [], priceOnly: true, totalSource: "human", extractedTotal: null,
  };
}

/** Has the vendor's stated validity date passed? Unknown dates never
 *  count as expired. */
export function quoteExpired(validUntil: string | null | undefined, now: number = Date.now()): boolean {
  if (!validUntil) return false;
  const t = Date.parse(`${validUntil}T23:59:59`);
  return Number.isFinite(t) && t < now;
}

// ── RFQ group key (BID-10, client half) ───────────────────────────────────

/** Case-folded, whitespace-collapsed grouping key. The typed casing is
 *  kept for display; only the KEY decides who tabulates against whom. */
export function rfqGroupKey(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Snap a typed group name onto an existing group's spelling when only
 *  case or whitespace differs, so "Unit 300 repipe" never forms a second
 *  bid field beside "Unit 300 Repipe". */
export function snapRfqGroup(typed: string, existing: string[]): string {
  const t = typed.replace(/\s+/g, " ").trim();
  if (!t) return "";
  const key = rfqGroupKey(t);
  return existing.find((g) => rfqGroupKey(g) === key) ?? t;
}

/** Merge groups whose labels differ only by case/whitespace into one bid
 *  field, keeping the first-seen spelling as the label. */
export function mergeQuoteGroups<T>(groups: Array<{ group: string; docs: T[] }>): Array<{ group: string; docs: T[] }> {
  const by = new Map<string, { group: string; docs: T[] }>();
  for (const g of groups) {
    const k = rfqGroupKey(g.group);
    const cur = by.get(k);
    if (cur) cur.docs.push(...g.docs); else by.set(k, { group: g.group, docs: [...g.docs] });
  }
  return [...by.values()];
}

// ── Registry matching (BID-12 / COST-3 dw2) ───────────────────────────────

const LEGAL_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "co", "corp", "corporation", "company", "gmbh", "plc",
  "lp", "llp", "pty", "sa", "ag", "bv", "nv", "srl", "sarl", "pte", "pllc", "pc",
]);

/** Normalise a company name for matching: case, punctuation, whitespace
 *  and trailing legal suffixes ("Gulf Mechanical, Inc." → "gulf
 *  mechanical"). Exact equality on this form is the ONLY automatic match;
 *  nothing fuzzier binds a bidder to a registry row on its own. */
export function normalizeCompanyName(s: string): string {
  const tokens = s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  if (tokens.length > 1 && tokens[0] === "the") tokens.shift();
  return tokens.join(" ");
}

/** The registry row a vendor name resolves to by normalised equality, or
 *  null when none or more than one matches (ambiguity never auto-binds). */
export function matchCompanyByName<T extends { name: string }>(vendorName: string | null | undefined, companies: T[]): T | null {
  if (!vendorName) return null;
  const key = normalizeCompanyName(vendorName);
  if (!key) return null;
  const hits = companies.filter((c) => normalizeCompanyName(c.name) === key);
  return hits.length === 1 ? hits[0] : null;
}

// ── Read extent (COST-13) ─────────────────────────────────────────────────

/** How much of a document the model actually saw. Unknown extent is
 *  reported as unknown — a NULL pages_total never reads as "complete". */
export function readExtent(pagesRead: number | null | undefined, pagesTotal: number | null | undefined): {
  truncated: boolean; known: boolean; label: string;
} {
  if (pagesTotal == null || pagesRead == null) return { truncated: false, known: false, label: "read extent unknown" };
  if (pagesRead < pagesTotal) return { truncated: true, known: true, label: `read pages 1–${pagesRead} of ${pagesTotal}` };
  return { truncated: false, known: true, label: `all ${pagesTotal} page${pagesTotal === 1 ? "" : "s"} read` };
}

/** Validate an AI-extracted quote payload into a safe ParsedQuote. Throws a
 *  plain message on a shape the review screen can't render. */
export function validateParsedQuote(raw: unknown, id: string): ParsedQuote {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") throw new Error("The quote extraction returned nothing readable.");
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const total = num(r.total);
  if (total == null || total <= 0) throw new Error("Couldn't read a total price from the quote.");
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
