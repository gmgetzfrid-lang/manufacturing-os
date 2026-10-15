// lib/thor/tokens.ts — the one normaliser THOR search runs on.
//
// The importer (scripts/thor_import.py) builds each file's search vector with
// these exact rules; a query is broken up the same way so the two always
// meet. Postgres's own parser mangles paths ("unit/10", "2026-06-10.xlsx"),
// so the vector is built from these tokens directly. Keep the two in step —
// lib/__tests__/thorTokens.test.ts pins the shared cases.

const SPLIT = /[^a-z0-9.-]+/;
// A dot survives only between two digits (2010.03); anywhere else it
// separates (file.name.pdf, Rev.3).
const LONE_DOT = /(?<![0-9])\.|\.(?![0-9])/g;

const strip = (t: string) => t.replace(/^\.+|\.+$/g, "");

/** Index tokens: "V-3 PREFRAC.pdf" → v3, v, 3, prefrac, pdf. */
export function tokens(text: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const t = strip(raw);
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  };
  for (const raw of (text ?? "").toLowerCase().replace(LONE_DOT, " ").split(SPLIT)) {
    const parts = raw.split("-").filter((p) => strip(p));
    // V-3 → v3 (and v, 3): tags are written V-3, V3 and V 3.
    if (parts.length > 1) add(parts.join(""));
    for (const p of parts) add(p);
  }
  return out;
}

/** Compact alias key, same as the importer's: "V-3" → "v3", "2010.03" stays. */
export function matchKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.]/g, "");
}
