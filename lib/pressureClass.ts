// lib/pressureClass.ts — the ASME B16.5 pressure classes a question is about.
//
// "150 class", "Class 150", "150#", "#150", "150 lb", "150 pound", "CL150",
// "ANSI 150" all mean Class 150 — and none of them means Class 1500. Search
// treats numbers as words, so classes are pulled out explicitly: searched as
// exact phrases, and named to the answer so a Class 1500 spec is never
// offered for a Class 150 line.
//
// A question can name more than one: "can I use 300 class flanges in a 150
// class line to bolt to a vessel nozzle" is about a Class 300 component in a
// Class 150 line — both classes are the subject, and the rows of the line
// class that carry Class 300 parts (and their notes) are the answer.

const CLASSES = ["150", "300", "400", "600", "900", "1500", "2500"];

const patternsFor = (n: string) => [
  new RegExp(`(?:class|cl\\.?|ansi|asme|rating)\\s*#?\\s*${n}(?![0-9])`, "g"),
  new RegExp(`(?<![0-9.])${n}\\s*(?:#|lbs?\\b|pound|class\\b|rating\\b|rated\\b)`, "g"),
  new RegExp(`#\\s*${n}(?![0-9])`, "g"),
];

/** Every class the text names, in the order it names them. */
export function pressureClassesOf(text: string): string[] {
  const t = ` ${text.toLowerCase()} `;
  const found: Array<{ n: string; at: number }> = [];
  for (const n of CLASSES) {
    let at = Infinity;
    for (const re of patternsFor(n)) for (const m of t.matchAll(re)) at = Math.min(at, m.index ?? Infinity);
    if (at < Infinity) found.push({ n, at });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.n);
}

/** The class of the LINE when a question names several: the one written
 *  next to "line", "piping", "system", "spec" or "service". Else the first. */
export function lineClassOf(text: string): string | null {
  const all = pressureClassesOf(text);
  if (all.length <= 1) return all[0] ?? null;
  const t = text.toLowerCase();
  for (const n of all) {
    if (new RegExp(`(?<![0-9])${n}\\s*(?:#|lbs?|pound)?\\s*(?:class|rated|rating)?\\s*(?:piping|pipe|line|system|spec|service|header)\\b`).test(t)) return n;
    if (new RegExp(`(?:line|piping|system|spec)\\s+(?:class|rating)?\\s*#?\\s*${n}(?![0-9])`).test(t)) return n;
  }
  return all[0];
}

/** The class a question is about (the line's, when it names several). */
export function pressureClassOf(text: string): string | null {
  return lineClassOf(text);
}

/** The note the answer model gets about the classes the question names. */
export function pressureClassNote(rating: string | null, all: string[] = rating ? [rating] : []): string {
  const classes = all.length > 0 ? all : rating ? [rating] : [];
  if (classes.length === 0) return "";
  const written = (n: string) => `Class ${n} (also written ${n}#, ${n} lb, CL${n})`;
  if (classes.length === 1) {
    const n = classes[0];
    return `\n\nPRESSURE CLASS: the question is about ASME ${written(n)}. ` +
      `Passages for a different class (e.g. Class ${n === "150" ? "1500" : "150"}) do NOT answer it - ` +
      "never offer them as the answer; say they are a different class. A piping class / spec code carries a " +
      `rating: the answer is the spec(s) whose rating is Class ${n} and whose service fits the fluid.`;
  }
  const line = rating ?? classes[0];
  const others = classes.filter((c) => c !== line);
  return `\n\nPRESSURE CLASSES: the question names more than one - ${classes.map(written).join(" and ")}. ` +
    `It reads as ${others.map((c) => `Class ${c}`).join("/")} components in a Class ${line} line. Passages for ` +
    "EITHER class are the subject; a class the question doesn't name (e.g. 1500) is not. A line class's " +
    "component tables list parts BY RATING, and a row can carry a different rating than the line - with " +
    "numbered notes saying when that row is used (e.g. against equipment nozzles, control valves). Such a " +
    "row and its note ARE the rule for this question: quote the row, its rating, and the note's text.";
}

/** How often each pressure class is written in a text, in any notation,
 *  most frequent first — "what classes is this page written for". */
export function classMentions(text: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const n of CLASSES) {
    const re = new RegExp(`(?:class|cl\\.?|ansi|asme)\\s*#?\\s*${n}(?![0-9])|(?<![0-9.])${n}\\s*(?:#|lbs?\\b|pound|class\\b)|#\\s*${n}(?![0-9])`, "gi");
    const k = (text.match(re) ?? []).length;
    if (k > 0) out.push([n, k]);
  }
  return out.sort((a, b) => b[1] - a[1]);
}
