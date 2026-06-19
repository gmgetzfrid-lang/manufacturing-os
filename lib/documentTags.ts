// lib/documentTags.ts
//
// Column-agnostic "tag" extraction + search for documents.
//
// A library's columns are user-defined: someone might make a built-in
// `type: "tags"` column, an "Assets" `select`, an "Inspector" `user` field, a
// free-text "Equipment" column, etc. Rather than hard-coding the single
// `type: "tags"` case, these helpers derive displayable tag chips and a flat
// search index from WHATEVER columns a library defines — so the equipment-tag
// ribbon and the book viewer's tag search work for every library, whatever the
// column is named or typed.

export interface TagColumnDef {
  key: string;
  label: string;
  type?: string;
  pillGroupLabel?: string;
  isPill?: boolean;
}

export interface TagGroup {
  key: string;
  label: string;
  tags: string[];
}

// Which columns become visible equipment CHIPS in the ribbon. We're deliberate
// here: a P&ID with no equipment tags must show NO pill, so single-value
// attribute columns (discipline, sheet type, a "Rev" select, …) are NOT chips
// even though they're stringy. A column is a tag column when it's:
//   - multi-valued (built-in `tags`/`multi`), or
//   - explicitly flagged as a pill (isPill / pillGroupLabel), or
//   - named like equipment (key/label mentions tag/asset/equip) — so a
//     user-made "Assets" select still works, whatever its type.
// (Search stays broad over ALL columns — see buildTagSearchIndex.)
function isTagColumn(col: TagColumnDef): boolean {
  if (col.type === "tags" || col.type === "multi") return true;
  if (col.isPill || col.pillGroupLabel) return true;
  return /tag|asset|equip/i.test(`${col.key} ${col.label}`);
}

export function prettifyKey(k: string): string {
  return k.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Split a raw metadata value into individual tag strings. Multi-value columns
 *  (and arrays) split on commas; single-value columns stay whole. */
export function valuesForColumn(raw: unknown, type?: string): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  if (typeof raw === "boolean") return raw ? ["Yes"] : [];
  if (typeof raw === "number") return Number.isFinite(raw) ? [String(raw)] : [];
  const s = String(raw).trim();
  if (!s) return [];
  if (type === "tags" || type === "multi") return s.split(",").map((x) => x.trim()).filter(Boolean);
  return [s];
}

/** Tag groups to render as chips. Driven by the library's columns when
 *  available (any stringy column, not just `type:"tags"`), with a safe
 *  heuristic fallback (any array-of-strings metadata value). */
export function collectTagGroups(
  metadata: Record<string, unknown> | null | undefined,
  columns?: TagColumnDef[] | null,
): TagGroup[] {
  if (!metadata) return [];
  const groups: TagGroup[] = [];

  if (columns && columns.length > 0) {
    for (const col of columns) {
      if (!isTagColumn(col)) continue;
      const tags = valuesForColumn(metadata[col.key], col.type);
      if (tags.length > 0) {
        groups.push({ key: col.key, label: col.pillGroupLabel || col.label || prettifyKey(col.key), tags });
      }
    }
    // Columns are authoritative: if none of the tag columns held a value, this
    // sheet genuinely has no tags — return empty (no spurious pill). We do NOT
    // fall through to the array heuristic here.
    return groups;
  }

  // No column defs at all: heuristic — any array-of-strings value is a tag group.
  for (const [key, value] of Object.entries(metadata)) {
    if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")) {
      const tags = (value as string[]).map((v) => v.trim()).filter(Boolean);
      if (tags.length > 0) groups.push({ key, label: prettifyKey(key), tags });
    }
  }
  return groups;
}

/** Flat, lowercased haystack of EVERY column value (all types) plus any extra
 *  strings (e.g. doc number / title) — the searchable text for tag search. */
export function buildTagSearchIndex(
  metadata: Record<string, unknown> | null | undefined,
  columns?: TagColumnDef[] | null,
  extra?: Array<string | null | undefined>,
): string {
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (v == null) return;
    if (Array.isArray(v)) { for (const x of v) if (x != null) parts.push(String(x)); }
    else parts.push(String(v));
  };
  if (columns?.length) for (const col of columns) push(metadata?.[col.key]);
  if (metadata) for (const v of Object.values(metadata)) push(v);
  if (extra) for (const e of extra) if (e) parts.push(e);
  return parts.join("\n").toLowerCase();
}

/** Does a prebuilt search index contain the query? Case-insensitive substring. */
export function indexMatches(index: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q.length > 0 && index.includes(q);
}

// ─── Typo-tolerant tag matching (for the book viewer's tag autocomplete) ──────
//
// People type "P-34" as "p34", "P 34", or fat-finger "l34". We normalize away
// case + separators so "P-34" === "p34", then tolerate a small edit distance so
// a near-miss still surfaces the right tag — but only when it's genuinely close,
// so a query that matches nothing stays "no match".

/** Lowercase + strip everything but [a-z0-9], so "P-34"/"p 34" → "p34". */
export function normalizeTag(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Levenshtein distance with an early-exit ceiling (returns max+1 once exceeded).
function boundedLevenshtein(a: string, b: string, max: number): number {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[lb];
}

export interface RankedTag { tag: string; score: number; }

/** Rank candidate tags against a query, best (lowest score) first. Tiers:
 *  exact(0) → prefix(1) → substring(2) → fuzzy within edit distance(3+d).
 *  Allowed distance scales with query length, so short queries stay strict. */
export function rankTags(query: string, tags: Iterable<string>, limit = 8): RankedTag[] {
  const q = normalizeTag(query);
  if (!q) return [];
  const maxDist = q.length <= 3 ? 1 : q.length <= 6 ? 2 : 3;
  const out: RankedTag[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    const n = normalizeTag(tag);
    if (!n) continue;
    let score: number;
    if (n === q) score = 0;
    else if (n.startsWith(q)) score = 1;
    else if (n.includes(q)) score = 2;
    else {
      const d = boundedLevenshtein(q, n, maxDist);
      if (d > maxDist) continue;
      score = 3 + d;
    }
    out.push({ tag, score });
  }
  out.sort((a, b) => a.score - b.score || a.tag.length - b.tag.length || a.tag.localeCompare(b.tag));
  return out.slice(0, limit);
}
