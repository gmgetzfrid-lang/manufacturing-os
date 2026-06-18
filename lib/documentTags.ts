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
}

export interface TagGroup {
  key: string;
  label: string;
  tags: string[];
}

// Column types we surface as visible chips. Numeric/date/boolean columns are
// still searchable (see buildTagSearchIndex) but aren't shown as chips — they'd
// be noise in the ribbon. Everything stringy — the built-in tags/multi plus
// user-made select/text/user/link columns — shows.
const CHIP_TYPES = new Set(["tags", "multi", "select", "user", "text", "link"]);

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
      if (col.type && !CHIP_TYPES.has(col.type)) continue;
      const tags = valuesForColumn(metadata[col.key], col.type);
      if (tags.length > 0) {
        groups.push({ key: col.key, label: col.pillGroupLabel || col.label || prettifyKey(col.key), tags });
      }
    }
    if (groups.length > 0) return groups;
  }

  // Fallback (no columns, or columns surfaced nothing): any array-of-strings
  // value is a tag group.
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
