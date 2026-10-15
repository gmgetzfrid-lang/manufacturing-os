// lib/thor/query.ts — "the newest prefrac drawings" → a THOR search.
//
// Deterministic, no AI: the words people use for order ("newest", "oldest
// first"), for kinds of document ("drawings", "inspection reports", "PDFs"),
// for units ("the crude unit"), for dates ("before 2020", "last year") and
// for sizes ("over 10 MB") become filters and a sort; equipment tags (V-3,
// X-14A) are pulled out so the server can resolve them inside the unit asked
// about; everything else is a word the file's name, folder chain or linked
// equipment must contain. Every decision comes back as a chip the person can
// see and remove.

import { tokens, matchKey } from "./tokens";

export type ThorSort = "relevance" | "newest" | "oldest" | "largest" | "smallest" | "name";

export interface ThorUnit { code: string; folder: string }

export interface ThorKind {
  key: string;
  label: string;
  /** Matches by extension OR by the indexer's folder role. */
  exts?: string[];
  roles?: string[];
}

/** Document kinds, as people say them. Order matters: first match wins. */
export const THOR_KINDS: ThorKind[] = [
  { key: "drawings", label: "Drawings", exts: ["dwg", "dxf", "dgn"], roles: ["drawings", "p_and_id"] },
  { key: "pid", label: "P&IDs", roles: ["p_and_id"] },
  { key: "inspections", label: "Inspection records", roles: ["inspection"] },
  { key: "datasheets", label: "Datasheets", roles: ["datasheets"] },
  { key: "calculations", label: "Calculations", roles: ["calculations"] },
  { key: "codes", label: "Code documents", roles: ["code_documents"] },
];

/** Quick file-type groups: a hard extension filter. */
export const THOR_TYPES: Array<{ key: string; label: string; exts: string[] }> = [
  { key: "pdf", label: "PDF", exts: ["pdf"] },
  { key: "cad", label: "CAD", exts: ["dwg", "dxf", "dgn"] },
  { key: "excel", label: "Excel", exts: ["xls", "xlsx", "xlsm", "csv"] },
  { key: "word", label: "Word", exts: ["doc", "docx", "rtf"] },
  { key: "photo", label: "Photos", exts: ["jpg", "jpeg", "png", "heic", "tif", "tiff", "bmp", "gif"] },
  { key: "email", label: "Email", exts: ["msg", "eml"] },
  { key: "slides", label: "PowerPoint", exts: ["ppt", "pptx"] },
  { key: "video", label: "Video", exts: ["mp4", "mov", "avi", "wmv"] },
];

const KIND_WORDS: Array<[RegExp, string]> = [
  [/^(p&ids?|pids?|p&id's)$/, "pid"],
  [/^(drawings?|dwgs?|autocad|cad|blueprints?|prints?)$/, "drawings"],
  [/^(inspections?|inspection)$/, "inspections"],
  [/^(datasheets?|data-sheets?)$/, "datasheets"],
  [/^(calcs?|calculations?)$/, "calculations"],
];
const TYPE_WORDS: Array<[RegExp, string]> = [
  [/^pdfs?$/, "pdf"],
  [/^(excel|spreadsheets?|xlsx?|xlsm|workbooks?)$/, "excel"],
  [/^(word|docx?)$/, "word"],
  [/^(photos?|pictures?|pics|images?|jpe?gs?)$/, "photo"],
  [/^(emails?|msgs?|e-mails?)$/, "email"],
  [/^(powerpoints?|pptx?|slides?)$/, "slides"],
  [/^(videos?|movies?|mp4s?)$/, "video"],
];

const STOP = new Set([
  "a", "an", "the", "i", "me", "my", "we", "our", "want", "need", "all", "any", "every", "file", "files",
  "document", "documents", "docs", "on", "in", "for", "of", "from", "to", "ordered", "order", "sorted",
  "sort", "by", "show", "find", "with", "and", "or", "list", "give", "get", "please", "about", "related",
  "at", "what", "where", "are", "is", "that", "this", "those", "these", "there", "first", "last", "unit",
  "units", "area", "equipment", "can", "you", "it", "its", "have", "has", "do", "does", "thor", "nas",
  "report", "reports", "records", "record", "folder", "folders", "which",
]);
const NEWEST = new Set(["newest", "latest", "recent", "newer", "current"]);
const OLDEST = new Set(["oldest", "earliest", "older", "original"]);
// "V-3", "X14A", "PSV-003", "H-401": letters then a number, one tag.
const TAG = /^([a-z]{1,4})-?(\d{1,4}[a-z]?)$/;
const NOT_TAG_PREFIX = new Set(["rev", "r", "sht", "sh", "wo", "afe", "pg", "page", "no", "q", "fy", "id"]);

export interface ThorChip {
  kind: "word" | "tag" | "unit" | "type" | "kind" | "date" | "size" | "sort";
  label: string;
  /** Removing a chip removes exactly this. */
  key: string;
}

export interface ThorQuery {
  raw: string;
  terms: string[];
  /** Equipment tag match keys ("v3"). */
  tags: string[];
  units: string[];
  kinds: string[];
  types: string[];
  after?: string;
  before?: string;
  minSize?: number;
  maxSize?: number;
  sort?: ThorSort;
  chips: ThorChip[];
}

const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1024, k: 1024, mb: 1024 ** 2, m: 1024 ** 2, gb: 1024 ** 3, g: 1024 ** 3 };
const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

/** "1,586", or "10,000+" when the server stopped counting. */
export function countLabel(total: number, capped?: boolean): string {
  return `${total.toLocaleString()}${capped ? "+" : ""}`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

/** Words that name each unit folder: "2000 - CRUDE UNIT" → [crude]. */
export function unitWords(folder: string): string[] {
  return tokens(folder.replace(/^\d{4}\s*-\s*/, "").replace(/\(.*?\)/g, ""))
    .filter((w) => !/^\d+$/.test(w) && !["unit", "no", "the", "and", "s", "w"].includes(w) && w.length > 1);
}

/** A unit's display name: "2000 - CRUDE UNIT" → "Crude Unit". */
export function unitName(folder: string | null | undefined): string {
  if (!folder) return "";
  const name = folder.replace(/^\d{4}\s*-\s*/, "");
  return name.length <= 5 ? name : name.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function parseThorQuery(raw: string, units: ThorUnit[], now: Date = new Date()): ThorQuery {
  const q: ThorQuery = { raw, terms: [], tags: [], units: [], kinds: [], types: [], chips: [] };
  let text = ` ${raw.toLowerCase()} `;

  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    text = text.replace(re, (...args) => { fn(args as unknown as RegExpMatchArray); return " "; });
  };
  const year = (y: string) => Number(y);

  // ── Order
  take(/\b(oldest|earliest)\s+(?:to|through|-)\s+(newest|latest|most recent)\b/g, () => { q.sort = "oldest"; });
  take(/\b(newest|latest|most recent)\s+(?:to|through|-)\s+(oldest|earliest|newest|latest)\b/g, () => { q.sort = "newest"; });
  take(/\b(oldest|earliest)\s+first\b/g, () => { q.sort = "oldest"; });
  take(/\b(newest|latest|most recent)\s+first\b/g, () => { q.sort = "newest"; });
  take(/\bmost recent\b/g, () => { q.sort ??= "newest"; });
  take(/\b(largest|biggest)\s*(first)?\b/g, () => { q.sort = "largest"; });
  take(/\b(smallest)\s*(first)?\b/g, () => { q.sort = "smallest"; });
  take(/\b(alphabetical(ly)?|a\s*-?\s*z|by name)\b/g, () => { q.sort = "name"; });

  // ── Dates (filesystem modified date)
  take(/\bbetween\s+((?:19|20)\d\d)\s+(?:and|to|-)\s+((?:19|20)\d\d)\b/g, (m) => {
    q.after = `${Math.min(year(m[1]), year(m[2]))}-01-01`; q.before = `${Math.max(year(m[1]), year(m[2])) + 1}-01-01`;
  });
  take(/\b(?:before|prior to|older than|until|up to)\s+((?:19|20)\d\d)(?:-(\d\d)(?:-(\d\d))?)?\b/g, (m) => {
    q.before = m[2] ? `${m[1]}-${m[2]}-${m[3] ?? "01"}` : `${m[1]}-01-01`;
  });
  take(/\b(?:after|since|newer than|from)\s+((?:19|20)\d\d)(?:-(\d\d)(?:-(\d\d))?)?\b/g, (m) => {
    q.after = m[2] ? `${m[1]}-${m[2]}-${m[3] ?? "01"}` : `${Number(m[1]) + (/\bafter\b/.test(m[0]) ? 1 : 0)}-01-01`;
  });
  take(/\b(?:modified|changed|dated|saved)\s+in\s+((?:19|20)\d\d)\b/g, (m) => {
    q.after = `${m[1]}-01-01`; q.before = `${year(m[1]) + 1}-01-01`;
  });
  // "last year" is the calendar year; "past year" is the last twelve months.
  take(/\bthis year\b/g, () => { q.after = `${now.getFullYear()}-01-01`; });
  take(/\blast year\b/g, () => { q.after = `${now.getFullYear() - 1}-01-01`; q.before = `${now.getFullYear()}-01-01`; });
  take(/\b(?:in the |within the )?(?:last|past)\s+(\d+)\s+(day|week|month|year)s?\b/g, (m) => {
    const d = new Date(now);
    const n = Number(m[1]);
    if (m[2] === "day") d.setDate(d.getDate() - n);
    else if (m[2] === "week") d.setDate(d.getDate() - 7 * n);
    else if (m[2] === "month") d.setMonth(d.getMonth() - n);
    else d.setFullYear(d.getFullYear() - n);
    q.after = fmtDate(d);
  });
  take(/\b(?:in the |within the )?(?:last|past)\s+(day|week|month|year)\b/g, (m) => {
    const d = new Date(now);
    if (m[1] === "day") d.setDate(d.getDate() - 1);
    else if (m[1] === "week") d.setDate(d.getDate() - 7);
    else if (m[1] === "month") d.setMonth(d.getMonth() - 1);
    else d.setFullYear(d.getFullYear() - 1);
    q.after = fmtDate(d);
  });

  // ── Sizes
  const size = (n: string, u: string) => Math.round(Number(n) * (SIZE_UNITS[u.toLowerCase()] ?? 1));
  take(/\b(?:over|above|larger than|bigger than|more than|greater than|>)\s*(\d+(?:\.\d+)?)\s*(kb|mb|gb|k|m|g|b)\b/g, (m) => { q.minSize = size(m[1], m[2]); });
  take(/\b(?:under|below|smaller than|less than|<)\s*(\d+(?:\.\d+)?)\s*(kb|mb|gb|k|m|g|b)\b/g, (m) => { q.maxSize = size(m[1], m[2]); });

  // ── Units: the unit whose distinctive words are all present, most words first.
  const ranked = units.map((u) => ({ u, words: unitWords(u.folder) })).filter((x) => x.words.length).sort((a, b) => b.words.length - a.words.length);
  for (const { u, words } of ranked) {
    const res = words.map((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
    if (res.every((re) => re.test(text))) {
      if (!q.units.includes(u.code)) q.units.push(u.code);
      for (const re of res) text = text.replace(re, " ");
    }
  }
  take(/\bunit\s+(\d{4})\b|\b(\d{4})\s+unit\b/g, (m) => { const c = m[1] ?? m[2]; if (!q.units.includes(c)) q.units.push(c); });

  // ── Word by word: order words, kinds, types, tags, the rest.
  for (const w0 of text.split(/\s+/).filter(Boolean)) {
    const w = w0.replace(/^[^a-z0-9&]+|[^a-z0-9&]+$/g, "");
    if (!w) continue;
    if (NEWEST.has(w)) { q.sort ??= "newest"; continue; }
    if (OLDEST.has(w)) { q.sort ??= "oldest"; continue; }
    const kind = KIND_WORDS.find(([re]) => re.test(w))?.[1];
    if (kind) { if (!q.kinds.includes(kind)) q.kinds.push(kind); continue; }
    const type = TYPE_WORDS.find(([re]) => re.test(w))?.[1];
    if (type) { if (!q.types.includes(type)) q.types.push(type); continue; }
    if (STOP.has(w)) continue;
    const tag = w.match(TAG);
    if (tag && !NOT_TAG_PREFIX.has(tag[1])) {
      const key = matchKey(tag[1] + tag[2]);
      if (!q.tags.includes(key)) q.tags.push(key);
      continue;
    }
    // Anything else: index tokens. A hyphenated word ("2002-D-2001") is
    // matched by its parts; a plural by its stem (prefix match covers both).
    const parts = tokens(w);
    const use = parts.length > 1 && w.includes("-") ? parts.slice(1) : parts;
    for (let t of use) {
      if (STOP.has(t)) continue;
      if (t.length > 4 && t.endsWith("s") && !t.endsWith("ss") && !/\d/.test(t)) t = t.slice(0, -1);
      if (!q.terms.includes(t)) q.terms.push(t);
    }
  }

  // ── Chips
  for (const t of q.terms) q.chips.push({ kind: "word", label: t, key: `word:${t}` });
  for (const t of q.tags) q.chips.push({ kind: "tag", label: t.toUpperCase().replace(/^([A-Z]+)(\d)/, "$1-$2"), key: `tag:${t}` });
  for (const c of q.units) {
    const u = units.find((x) => x.code === c);
    q.chips.push({ kind: "unit", label: u ? unitName(u.folder) : `Unit ${c}`, key: `unit:${c}` });
  }
  for (const k of q.kinds) q.chips.push({ kind: "kind", label: THOR_KINDS.find((x) => x.key === k)?.label ?? k, key: `kind:${k}` });
  for (const t of q.types) q.chips.push({ kind: "type", label: THOR_TYPES.find((x) => x.key === t)?.label ?? t, key: `type:${t}` });
  if (q.after) q.chips.push({ kind: "date", label: `after ${q.after}`, key: "after" });
  if (q.before) q.chips.push({ kind: "date", label: `before ${q.before}`, key: "before" });
  if (q.minSize != null) q.chips.push({ kind: "size", label: `over ${formatBytes(q.minSize)}`, key: "minSize" });
  if (q.maxSize != null) q.chips.push({ kind: "size", label: `under ${formatBytes(q.maxSize)}`, key: "maxSize" });
  if (q.sort && q.sort !== "relevance") q.chips.push({ kind: "sort", label: SORT_LABEL[q.sort], key: "sort" });
  return q;
}

export const SORT_LABEL: Record<ThorSort, string> = {
  relevance: "Best match", newest: "Newest first", oldest: "Oldest first",
  largest: "Largest first", smallest: "Smallest first", name: "Name A–Z",
};

/** Remove the thing a chip stands for. */
export function withoutChip(q: ThorQuery, key: string): ThorQuery {
  const [k, v] = key.split(":");
  const next: ThorQuery = { ...q, chips: q.chips.filter((c) => c.key !== key) };
  if (k === "word") next.terms = q.terms.filter((t) => t !== v);
  else if (k === "tag") next.tags = q.tags.filter((t) => t !== v);
  else if (k === "unit") next.units = q.units.filter((t) => t !== v);
  else if (k === "kind") next.kinds = q.kinds.filter((t) => t !== v);
  else if (k === "type") next.types = q.types.filter((t) => t !== v);
  else if (k === "after") next.after = undefined;
  else if (k === "before") next.before = undefined;
  else if (k === "minSize") next.minSize = undefined;
  else if (k === "maxSize") next.maxSize = undefined;
  else if (k === "sort") next.sort = undefined;
  return next;
}
