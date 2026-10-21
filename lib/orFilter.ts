// lib/orFilter.ts — "any of these columns contains the typed text", safe for
// PostgREST's .or() syntax.
//
// Inside .or() a comma, a dot, a colon or a parenthesis is syntax: searching
// "EP 5-3-10 (A)" or "Smith, J" unquoted is a 400. PostgREST's rule is to
// double-quote such values, escaping " and \ inside with a backslash.

export function orIlike(columns: string[], term: string): string {
  const quoted = `"%${term.replace(/[\\"]/g, (m) => `\\${m}`)}%"`;
  return columns.map((c) => `${c}.ilike.${quoted}`).join(",");
}
