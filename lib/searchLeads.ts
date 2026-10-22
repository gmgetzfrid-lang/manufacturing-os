// lib/searchLeads.ts — related terms as LEADS: where to look, never what's true.
//
// "Sour" and "wet H2S", "H2S" and "NACE" are related in most refinery
// standards — but how they relate (the same thing? one a subset of the
// other? only under a condition?) is something each company's documents
// decide. So related terms are used to WIDEN what gets searched and looked
// at, and anything found only through a related term is labelled as such.
// An answer may tie two terms together only when a passage does.
//
// This list is deliberately small and industry-generic. A library's own
// leads come from its text (terms that appear together, definitions that
// name each other) as the library is mapped.

const LEADS: Record<string, string[]> = {
  sour: ["h2s", "wet h2s", "sulfidic", "nace", "mr0103", "mr0175"],
  h2s: ["sour", "wet h2s", "sulfidic", "nace"],
  sulfidic: ["sulfur", "sour", "h2s"],
  caustic: ["naoh", "alkaline"],
  amine: ["mea", "dea", "mdea", "rich amine", "lean amine"],
  hydrogen: ["h2", "high temperature hydrogen", "htha"],
  hf: ["hydrofluoric"],
  chloride: ["chlorides", "hcl"],
  steam: ["condensate", "boiler feedwater", "bfw"],
  cryogenic: ["low temperature", "impact test", "mdmt"],
  vessel: ["equipment", "nozzle", "drum"],
  vessels: ["equipment", "nozzle", "drum"],
  nozzle: ["equipment", "vessel"],
  nozzles: ["equipment", "vessel"],
  equipment: ["nozzle", "vessel"],
  tank: ["equipment", "nozzle"],
  exchanger: ["equipment", "nozzle"],
  pump: ["equipment", "nozzle"],
};

/** The lowercase words of a question worth matching (not the filler). */
export function questionWords(question: string, stop: Set<string>): string[] {
  return [...new Set(question.toLowerCase().match(/[a-z0-9]{2,}/g)?.filter((w) => !stop.has(w) && !/^\d+$/.test(w)) ?? [])];
}

/** Related terms for the asker's own words — leads only. */
export function leadsFor(words: string[]): string[] {
  const own = new Set(words);
  return [...new Set(words.flatMap((w) => LEADS[w] ?? []))].filter((t) => !own.has(t));
}
