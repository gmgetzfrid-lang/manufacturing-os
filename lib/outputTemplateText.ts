// lib/outputTemplateText.ts — pure, testable helpers behind output templates.
//
// The rules that decide what the generator does are here, isolated from
// file I/O and model calls so they can be pinned by tests:
//
//   - findPlaceholders: which {tags} a template document actually contains
//   - proposePlaceholders: turn raw tags into an editable spec, guessing
//     kind (data vs AI-drafted) and a human label from the tag name
//   - normalizeHeader / autoMapColumns: match spreadsheet headers to tags
//     without demanding the user rename anything
//   - missingRequirements: what the template needs that the data can't
//     supply — the "one Need card, not a failure" list
//   - renderFilename: safe, collision-free output names

export type PlaceholderKind = "data" | "ai" | "static";

export interface Placeholder {
  tag: string;                 // "scope_description"
  label: string;               // "Scope description"
  kind: PlaceholderKind;
  /** For kind 'ai': what the model should write here. */
  guidance?: string;
  /** For kind 'static': the fixed text. */
  value?: string;
  /** True when the document can't be issued without it. */
  required?: boolean;
}

/** docxtemplater-style single-brace tags: {scope_description}. Loop and
 *  section tags ({#items} {/items} {^empty}) are structural — the template
 *  author owns those, so they're reported separately, never AI-filled.
 *  XEDGE-11: raw-XML tags ({@tag}) are recognised too, so the analyze step
 *  can see them — docxtemplater splices their VALUE into the document as
 *  literal OOXML, so they are never fill points and the renderer refuses them. */
const TAG_RE = /\{([#^/@]?)\s*([A-Za-z0-9_.\-]+)\s*\}/g;

/** A raw-XML tag anywhere in template text: `{@…}` with optional spacing. */
const RAW_TAG_RE = /\{\s*@/;

export interface FoundTags {
  /** Plain fill points the generator populates. */
  fields: string[];
  /** Loop/section names ({#rows}…{/rows}) — repeating blocks. */
  loops: string[];
  /** Raw-XML tags ({@name}) — UNSAFE: they inject markup, never text. */
  raw: string[];
}

export function findPlaceholders(templateText: string): FoundTags {
  const fields = new Set<string>();
  const loops = new Set<string>();
  const raw = new Set<string>();
  for (const m of templateText.matchAll(TAG_RE)) {
    const marker = m[1];
    const name = m[2];
    if (!name || /^\d+$/.test(name)) continue;
    if (marker === "@") raw.add(name);
    else if (marker === "#" || marker === "^" || marker === "/") loops.add(name);
    else fields.add(name);
  }
  // A field that is also a loop name is the loop, not a field.
  for (const l of loops) fields.delete(l);
  for (const r of raw) fields.delete(r);
  return { fields: [...fields], loops: [...loops], raw: [...raw] };
}

/** True when `text` (tags already stripped) contains a raw-XML tag. */
export function hasRawXmlTag(text: string): boolean {
  return RAW_TAG_RE.test(text);
}

/** XEDGE-11: only the template's DECLARED placeholder tags reach the
 *  renderer. A caller-invented key is dropped, never injected. Pure. */
export function pickDeclaredValues(
  values: Record<string, unknown> | null | undefined,
  placeholders: ReadonlyArray<Pick<Placeholder, "tag">>,
): Record<string, string> {
  const declared = new Set(placeholders.map((p) => p.tag));
  const out: Record<string, string> = {};
  if (!values || typeof values !== "object") return out;
  for (const [k, v] of Object.entries(values)) {
    if (!declared.has(k)) continue;
    out[k] = v == null ? "" : String(v);
  }
  return out;
}

const humanize = (tag: string): string => {
  const words = tag.replace(/[._-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
};

// Tags whose names say "this is a written passage" — those default to AI
// drafting; everything else defaults to a data column (safer: a wrong data
// mapping is visible, a hallucinated field is not).
const AI_HINTS = [
  "scope", "description", "narrative", "summary", "justification", "purpose",
  "background", "detail", "notes", "instructions", "method", "procedure",
  "requirement", "objective", "recommendation", "conclusion", "body",
];

export function proposePlaceholders(tags: string[]): Placeholder[] {
  return tags.map((tag) => {
    const lower = tag.toLowerCase();
    const isAi = AI_HINTS.some((h) => lower.includes(h));
    return {
      tag,
      label: humanize(tag),
      kind: isAi ? ("ai" as const) : ("data" as const),
      ...(isAi ? { guidance: `Write the ${humanize(tag).toLowerCase()} for this item.` } : {}),
      required: true,
    };
  }).sort((a, b) => a.tag.localeCompare(b.tag));
}

/** Loose header matching: "WO Number", "wo_number", "wo-number" all match. */
export function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Best-effort column→tag mapping. Exact normalized match first, then a
 *  containment match, so "Work Order #" finds tag "work_order". */
export function autoMapColumns(tags: string[], headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const normHeaders = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));
  for (const tag of tags) {
    const nt = normalizeHeader(tag);
    const exact = normHeaders.find((h) => h.norm === nt);
    if (exact) { map[tag] = exact.raw; continue; }
    const partial = normHeaders.find((h) => h.norm.includes(nt) || nt.includes(h.norm));
    if (partial) map[tag] = partial.raw;
  }
  return map;
}

/** Placeholders the template needs that neither the data nor a static value
 *  can supply — surfaced as ONE question, not a failed run. */
export function missingRequirements(
  placeholders: Placeholder[],
  columnMap: Record<string, string>,
  headers: string[],
): Placeholder[] {
  const have = new Set(headers.map(normalizeHeader));
  return placeholders.filter((p) => {
    if (p.kind === "static") return !p.value?.trim();
    if (p.kind === "ai") return false;            // the model writes these
    const mapped = columnMap[p.tag];
    return !(mapped && have.has(normalizeHeader(mapped)));
  });
}

const FILENAME_BAD = /[\\/:*?"<>|]+/g;

/** "SOW-{wo_number}" + row → "SOW-12345.docx", always filesystem-safe and
 *  never empty. Unresolved tags collapse rather than leaking braces. */
export function renderFilename(
  pattern: string | null | undefined,
  values: Record<string, string>,
  fallback: string,
  ext: string,
  index?: number,
): string {
  const raw = (pattern ?? "").trim() || fallback;
  let out = raw.replace(/\{\s*([A-Za-z0-9_.\-]+)\s*\}/g, (_m, tag: string) =>
    (values[tag] ?? "").toString().trim());
  out = out.replace(FILENAME_BAD, "-").replace(/\s+/g, " ").replace(/-{2,}/g, "-").trim();
  out = out.replace(/^[-\s.]+|[-\s.]+$/g, "");
  if (!out) out = index === undefined ? fallback : `${fallback}-${index + 1}`;
  return `${out.slice(0, 120)}.${ext}`;
}

/** XEDGE-2: an HTTP header value is a ByteString — a code point above 0xFF
 *  makes the runtime throw when the response is constructed, and anything
 *  above 0x7F is unreliable across clients. Fold to printable ASCII for the
 *  legacy `filename=` parameter: strip combining marks (é → e), replace every
 *  remaining non-ASCII or control character with "_", and replace the two
 *  characters that are syntax inside an RFC 6266 quoted-string — `"` ends it
 *  and `\` escapes the next character, so a trailing backslash would turn
 *  the closing quote into `\"` and leave the header unterminated. */
export function asciiFoldFilename(name: string): string {
  const folded = name.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  let out = "";
  for (const ch of folded) {
    const code = ch.codePointAt(0) ?? 0;
    out += code >= 0x20 && code <= 0x7e && ch !== '"' && ch !== "\\" ? ch : "_";
  }
  out = out.replace(/_{2,}/g, "_").trim();
  return out || "document";
}

/** RFC 5987 / 8187 `ext-value` percent-encoding of a UTF-8 string. */
function encodeRfc5987(s: string): string {
  return encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A Content-Disposition value that never leaves the ASCII range: the
 *  folded name for old clients plus the exact UTF-8 name as `filename*`
 *  (RFC 6266), which every current browser prefers. Safe for any input —
 *  em dashes, CJK, quotes and line breaks included. */
export function contentDispositionAttachment(name: string): string {
  const clean = name.replace(/[\r\n"]/g, "");
  return `attachment; filename="${asciiFoldFilename(clean)}"; filename*=UTF-8''${encodeRfc5987(clean)}`;
}

/** Ensure every name in a batch is unique (Word refuses duplicates in a
 *  zip gracelessly, and people lose files). */
export function uniqueFilenames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const key = n.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count === 0) return n;
    const dot = n.lastIndexOf(".");
    return dot === -1 ? `${n} (${count + 1})` : `${n.slice(0, dot)} (${count + 1})${n.slice(dot)}`;
  });
}

/** Cell → template string. Dates and numbers get predictable, boring
 *  formatting; nothing becomes "[object Object]" or "undefined". */
export function cellToText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.slice(0, 10);
  }
  if (typeof v === "number") {
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  }
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v).trim();
}
