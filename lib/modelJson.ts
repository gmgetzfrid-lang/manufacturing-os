// lib/modelJson.ts — tolerant parsing for model output that should be JSON.
//
// Used by AI routes whose replies can arrive fence-wrapped, prefixed with
// prose, or TRUNCATED mid-array by a token cap. The salvage strategy keeps
// every complete row of a truncated reply instead of failing wholesale.

/** Parse model output that SHOULD be JSON but may be fence-wrapped, prefixed
 *  with prose, or truncated mid-array by the token cap. Strategy: strip
 *  fences, cut to the outermost braces, try as-is; on failure, walk BACKWARD
 *  from the end dropping partial trailing content and closing whatever
 *  brackets remain open (string-aware), so every COMPLETE row survives a
 *  truncation instead of the whole import failing. Returns null only when
 *  nothing parseable exists at all. */
export function parseModelJson(raw: string): unknown | null {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const start = s.indexOf("{");
  if (start < 0) return null;
  s = s.slice(start);
  const tryParse = (t: string): unknown | null => { try { return JSON.parse(t); } catch { return null; } };

  const direct = tryParse(s);
  if (direct !== null) return direct;

  // Bracket-stack completion: scan string-aware, then close open scopes.
  const complete = (t: string): string | null => {
    const stack: string[] = [];
    let inStr = false;
    let esc = false;
    for (const ch of t) {
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") stack.push("}");
      else if (ch === "[") stack.push("]");
      else if (ch === "}" || ch === "]") {
        if (stack[stack.length - 1] !== ch) return null; // mismatched — hopeless here
        stack.pop();
      }
    }
    if (inStr) return null;
    return t + stack.reverse().join("");
  };

  // Walk back to successive "safe" cut points (just after a } or ] or before
  // a trailing partial element) and try completing from there.
  for (let cut = s.length; cut > 2; ) {
    const idx = Math.max(s.lastIndexOf("}", cut - 1), s.lastIndexOf("]", cut - 1));
    if (idx <= 0) break;
    const candidate = s.slice(0, idx + 1).replace(/,\s*$/, "");
    const completed = complete(candidate);
    if (completed) {
      const parsed = tryParse(completed);
      if (parsed !== null) return parsed;
    }
    cut = idx;
  }
  return null;
}
