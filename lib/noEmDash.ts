// The app never shows an em dash. Its own wording is written without one
// (lib/__tests__/noEmDash.test.ts keeps it that way); text that comes from
// elsewhere (a model's answer, what someone types) goes through this.

/** Every em dash, written or as an HTML entity, as a plain hyphen. */
export function noEmDash(s: string): string {
  return s.replace(/&mdash;/g, "-").replace(/—/g, "-");
}

/** The same, through every string in a saved record (arrays and objects too). */
export function noEmDashDeep<T>(v: T): T {
  if (typeof v === "string") return noEmDash(v) as T;
  if (Array.isArray(v)) return v.map(noEmDashDeep) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, noEmDashDeep(x)])) as T;
  return v;
}
