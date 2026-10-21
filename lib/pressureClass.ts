// lib/pressureClass.ts — the ASME B16.5 pressure class a question is about.
//
// "150 class", "Class 150", "150#", "#150", "150 lb", "150 pound", "CL150",
// "ANSI 150" all mean Class 150 — and none of them means Class 1500. Search
// treats numbers as words, so the class is pulled out once and handled
// explicitly: searched as an exact phrase, and named to the answer so a
// Class 1500 spec is never offered for a Class 150 line.

const CLASSES = ["150", "300", "400", "600", "900", "1500", "2500"];

export function pressureClassOf(text: string): string | null {
  const t = ` ${text.toLowerCase()} `;
  for (const n of CLASSES) {
    const patterns = [
      new RegExp(`(?:class|cl\\.?|ansi|asme|rating)\\s*#?\\s*${n}(?![0-9])`),
      new RegExp(`(?<![0-9.])${n}\\s*(?:#|lbs?\\b|pound|class\\b|rating\\b|rated\\b)`),
      new RegExp(`#\\s*${n}(?![0-9])`),
    ];
    if (patterns.some((re) => re.test(t))) return n;
  }
  return null;
}

/** The note the answer model gets when the question names a class. */
export function pressureClassNote(rating: string | null): string {
  if (!rating) return "";
  return `\n\nPRESSURE CLASS: the question is about ASME Class ${rating} (also written ${rating}#, ${rating} lb, ` +
    `CL${rating}). Passages for a different class (e.g. Class ${rating === "150" ? "1500" : "150"}) do NOT answer it — ` +
    "never offer them as the answer; say they are a different class. A piping class / spec code carries a " +
    `rating: the answer is the spec(s) whose rating is Class ${rating} and whose service fits the fluid.`;
}
