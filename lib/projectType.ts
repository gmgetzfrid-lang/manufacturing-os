// projectType - what kind of project this is (Setup › Project type): the
// word the app says wherever it talks about the project as a whole
// ("turnaround finish unchanged", the safety topic's "Turnaround ·
// Transmix-1", "plan more time for it next turnaround"), and its short
// form ("TA"). Kept with the project's shift times. Never set: read from
// the project's name ("October 2026 Transmix-1 Turnaround"), else
// "Project".

export interface ProjectType {
  /** "Turnaround", "Capital project", or the project's own word. */
  word: string;
  /** "TA", "S/D", or the project's own short form. */
  short: string;
}

/** The kinds offered, each with its usual short form. */
export const PROJECT_TYPES: ProjectType[] = [
  { word: "Turnaround", short: "TA" },
  { word: "Outage", short: "Outage" },
  { word: "Shutdown", short: "S/D" },
  { word: "Capital project", short: "Project" },
  { word: "Maintenance", short: "Maintenance" },
  { word: "Construction", short: "Construction" },
];

export const DEFAULT_PROJECT_TYPE: ProjectType = { word: "Project", short: "Project" };

const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** A saved type, tidied (nothing usable: null). */
export function cleanProjectType(x: unknown): ProjectType | null {
  if (!x || typeof x !== "object") return null;
  const o = x as { word?: unknown; short?: unknown };
  const word = clean(o.word, 40);
  if (!word) return null;
  return { word, short: clean(o.short, 16) || word };
}

// "TA" and "S/D" only in capitals: "ta" is a word.
const GUESS: Array<{ re: RegExp[]; t: ProjectType }> = [
  { re: [/\bturn[\s-]*arounds?\b/i, /\b(TA|TAR|T\/A)\b/], t: PROJECT_TYPES[0] },
  { re: [/\boutages?\b/i], t: PROJECT_TYPES[1] },
  { re: [/\bshut[\s-]*downs?\b/i, /\bS\/D\b/], t: PROJECT_TYPES[2] },
  { re: [/\bcapital\b/i], t: PROJECT_TYPES[3] },
  { re: [/\bconstruction\b/i], t: PROJECT_TYPES[5] },
  { re: [/\bmaintenance\b/i], t: PROJECT_TYPES[4] },
];

/** The project's type: the one set in Setup, else read from its name,
 *  else from its schedule's group names ("TA Execution", "DEC OUTAGE";
 *  only a turnaround, outage or shutdown: a "Maintenance" phase is part of
 *  a turnaround, not the kind of project). */
export function projectTypeOf(saved: unknown, name?: string | null, groups: string[] = []): ProjectType {
  const set = cleanProjectType(saved);
  if (set) return set;
  const n = name ?? "";
  const byName = GUESS.find((g) => g.re.some((r) => r.test(n)));
  if (byName) return byName.t;
  const byGroup = GUESS.slice(0, 3).find((g) => groups.some((x) => g.re.some((r) => r.test(x))));
  return byGroup?.t ?? DEFAULT_PROJECT_TYPE;
}

/** Read from the name and groups, nothing found: a plain project. */
export const isDefaultType = (t: ProjectType) => t === DEFAULT_PROJECT_TYPE;

/** Was it set in Setup (not read from the name)? */
export const projectTypeSet = (saved: unknown) => cleanProjectType(saved) != null;

/** The word inside a sentence: "turnaround", "capital project"; a word
 *  in capitals ("LRU") stays as it is. */
export function typeWord(t: ProjectType): string {
  return /^[A-Z][a-z]/.test(t.word) ? t.word[0].toLowerCase() + t.word.slice(1) : t.word;
}

/** Live units and other crews all around the work: a turnaround, outage
 *  or shutdown (the safety topics for that), not a project beside a
 *  running plant. */
export function unitsDown(t: ProjectType): boolean {
  return /turn[\s-]*around|outage|shut[\s-]*down/i.test(t.word) || /^(TA|TAR|T\/A|S\/D)$/.test(t.short.trim()) || /^(TA|TAR|T\/A|S\/D)$/.test(t.word.trim());
}
