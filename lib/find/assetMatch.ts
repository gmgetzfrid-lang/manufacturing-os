// lib/find/assetMatch.ts — which piece of equipment does a code name?
//
// People add and drop the unit prefix ("10-V-101" and "V-101" are the same
// vessel), type the site code instead of the tag ("2030.22"), leave the
// train letter off ("P-101" for P-101A/B), or miss a character. The registry
// holds one spelling. This matcher meets the person where they are and says
// which allowance it used, so every hit can show its reason.
//
// Pure: build the index once from the registry, ask it as often as needed.

import { canonicalForm, splitCanonical } from "@/lib/fileFinder/tagForms";
import { isClose } from "@/lib/fileFinder/fuzzy";

export interface MatchableAsset { id: string; tag: string; code?: string | null; unit_code?: string | null }
export type AssetMatchTier = "exact" | "prefix" | "code" | "suffix" | "close";
export interface AssetMatch<A> { asset: A; via: string; tier: AssetMatchTier }

/** A canonical form with any leading unit code removed: "10V101" → "V101".
 *  Known unit codes first; failing that, a short run of leading digits in
 *  front of the letters is read as a unit someone prefixed. */
export function bareTag(canon: string, unitCodes: string[]): { bare: string; unit: string | null } {
  for (const u of unitCodes) {
    const uc = canonicalForm(u);
    if (uc && canon.length > uc.length && canon.startsWith(uc) && /^[A-Z]/.test(canon.slice(uc.length))) return { bare: canon.slice(uc.length), unit: uc };
  }
  const m = canon.match(/^(\d{1,3})([A-Z].*)$/);
  if (m) return { bare: m[2], unit: m[1] };
  return { bare: canon, unit: null };
}

export interface AssetIndex<A extends MatchableAsset> {
  /** Every asset a canonical form could mean, best allowance first. */
  find(canon: string): AssetMatch<A>[];
  /** The single best answer, or null. */
  best(canon: string): AssetMatch<A> | null;
  byId(id: string): A | undefined;
}

export function buildAssetIndex<A extends MatchableAsset>(assets: A[], unitCodes: string[] = []): AssetIndex<A> {
  const exact = new Map<string, A[]>();
  const bare = new Map<string, A[]>();
  const code = new Map<string, A[]>();
  const noSuffix = new Map<string, A[]>();
  const byId = new Map<string, A>();
  const push = (m: Map<string, A[]>, k: string, a: A) => { if (!k) return; const l = m.get(k) ?? []; l.push(a); m.set(k, l); };
  for (const a of assets) {
    byId.set(a.id, a);
    const c = canonicalForm(a.tag);
    push(exact, c, a);
    const b = bareTag(c, unitCodes).bare;
    push(bare, b, a);
    if (a.code) push(code, canonicalForm(a.code), a);
    const parts = splitCanonical(b);
    if (parts) push(noSuffix, parts.prefix + parts.digits, a);
  }
  const uniq = (l: A[]) => [...new Map(l.map((a) => [a.id, a])).values()];

  const find = (raw: string): AssetMatch<A>[] => {
    const canon = canonicalForm(raw);
    if (!canon) return [];
    const out: AssetMatch<A>[] = [];
    const seen = new Set<string>();
    const take = (l: A[] | undefined, via: string, tier: AssetMatchTier) => {
      for (const a of uniq(l ?? [])) { if (seen.has(a.id)) continue; seen.add(a.id); out.push({ asset: a, via, tier }); }
    };
    take(exact.get(canon), "typed", "exact");
    if (out.length) return out;
    const q = bareTag(canon, unitCodes);
    // The same tag with the unit prefix added or dropped on either side.
    take(bare.get(q.bare), q.unit ? `ignoring the unit prefix ${q.unit}` : "the registry carries a unit prefix", "prefix");
    if (out.length) return out;
    take(code.get(canon), "by site code", "code");
    if (out.length) return out;
    // The train letter left off: P-101 names P-101A and P-101B.
    const parts = splitCanonical(q.bare);
    if (parts && !parts.suffix) take(noSuffix.get(parts.prefix + parts.digits), "same number, train letter left off", "suffix");
    if (out.length) return out;
    // One or two characters off, on the bare forms.
    let bestD = Infinity; let bestA: A | null = null;
    for (const [b, l] of bare) {
      const cl = isClose(q.bare, b);
      if (cl.close && cl.edits < bestD) { bestD = cl.edits; bestA = l[0]; }
    }
    if (bestA) out.push({ asset: bestA, via: `close to ${raw} (${bestD} off)`, tier: "close" });
    return out;
  };
  return { find, best: (c) => find(c)[0] ?? null, byId: (id) => byId.get(id) };
}
