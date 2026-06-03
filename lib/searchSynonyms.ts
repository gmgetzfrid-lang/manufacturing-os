// lib/searchSynonyms.ts
//
// Refinery / process-plant search synonym expansion.
//
// The architecture deliberately ships NO Postgres synonym dictionary (sites
// have their own vocabulary and a generic one causes silent drift). But with
// zero synonym handling, common shorthand fails: searching "HE" misses
// "exchanger", "vsl" misses "vessel", "P&ID" misses "PID". That makes recall
// feel broken out of the box.
//
// This is a SAFE middle ground: a small, well-known equipment-abbreviation map
// applied at QUERY time only. We expand each search token to an OR-group of its
// synonyms and hand Postgres a tsquery — no schema change, no trigger, nothing
// persisted. Sites that want different vocabulary can edit this one file.
//
// The map is intentionally conservative (industry-standard abbreviations, not
// guesses) so it never surprises a controller with irrelevant hits.

/** Bidirectional synonym groups. Every term in a group expands to the whole
 *  group. Keep terms lowercase and single-token where possible. */
const SYNONYM_GROUPS: string[][] = [
  ["exchanger", "he", "hx", "hex"],
  ["vessel", "vsl", "vess"],
  ["column", "col", "tower", "twr"],
  ["pump", "pmp"],
  ["compressor", "compr", "comp", "k"],
  ["drum", "drm"],
  ["tank", "tk"],
  ["valve", "vlv"],
  ["instrument", "instr", "inst"],
  ["pid", "p&id", "pandid"],
  ["pfd", "processflowdiagram"],
  ["isometric", "iso", "isom"],
  ["datasheet", "ds", "data sheet"],
  ["specification", "spec"],
  ["drawing", "dwg", "dgwn"],
  ["electrical", "elec", "elc"],
  ["mechanical", "mech"],
  ["piping", "pipe", "pip"],
  ["structural", "struct", "str"],
  ["foundation", "fdn", "found"],
  ["heater", "htr", "furnace", "fired heater"],
  ["motor", "mtr"],
  ["analyzer", "analyser", "az"],
  ["transmitter", "xmtr", "tx"],
];

// Build a lookup from each term → the full set of its group members.
const SYNONYM_INDEX: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const group of SYNONYM_GROUPS) {
    for (const term of group) {
      m.set(term.toLowerCase(), group.map((t) => t.toLowerCase()));
    }
  }
  return m;
})();

/** Strip characters that are tsquery operators / unsafe so a raw token can be
 *  embedded in a tsquery without breaking its syntax. Keeps alphanumerics. */
function sanitizeToken(token: string): string {
  return token.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}

/**
 * Expand a free-text search query into a Postgres tsquery string with OR'd
 * synonyms, AND'ing the tokens together (matching the previous plainto
 * behavior of "all words must match").
 *
 * Returns null when there's nothing searchable after sanitizing — the caller
 * should then fall back to its plain-text path (or skip the filter).
 *
 * Examples:
 *   "E-204 exchanger" → "e204 & ( exchanger | he | hx | hex )"
 *   "vsl"             → "( vessel | vsl | vess )"
 *   "%%%"             → null
 */
export function expandQueryToTsquery(raw: string): string | null {
  const tokens = raw
    .split(/\s+/)
    .map(sanitizeToken)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  const groups = tokens.map((tok) => {
    const syns = SYNONYM_INDEX.get(tok);
    if (syns && syns.length > 1) {
      const sanitized = Array.from(new Set([tok, ...syns].map(sanitizeToken).filter(Boolean)));
      return `( ${sanitized.join(" | ")} )`;
    }
    return tok;
  });

  return groups.join(" & ");
}
