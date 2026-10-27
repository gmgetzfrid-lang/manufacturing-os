// safetyTalk — the turnover's safety topic, the way it's given at the
// meeting: one topic, picked from what the shift is doing; one line on why
// today; and four or five short things to say out loud — lessons written
// in blood, each from a real incident report (lib/safetyLessons), plus,
// when crews work the same equipment at once, the rules for working
// around each other. Read in a minute. Not a repeat of the schedule.

import { HAZARD_KINDS, lessonFor, sourceLabel, type HazardKind, type RankedHazard, type SafetyLesson } from "@/lib/safetyMoment";
import { SAFETY_LESSONS } from "@/lib/safetyLessons";

export interface TalkPoint { say: string; source?: { url: string; title: string } }
export interface SafetyTalk {
  /** Stable across a shift: the kind, plus "+crews" when crews overlap. */
  key: string;
  title: string;
  /** Why this topic today, in a line. */
  today: string;
  points: TalkPoint[];
}

const OSHA_SIGNS = { url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.145", title: "OSHA 1910.145: Accident prevention signs and tags" };
const OSHA_SWING = { url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.1424", title: "OSHA 1926.1424: Work area control" };

/** Working around other crews: barricades, tags, loads, talking. */
export const CREWS_POINTS: TalkPoint[] = [
  { say: "Red danger tape: nobody crosses without talking to the person on the tag. Yellow caution tape: go in carefully, and know why it's there.", source: OSHA_SIGNS },
  { say: "Barricade all the way around, with a tag: who owns it, what's going on, and how to reach them.", source: OSHA_SIGNS },
  { say: "Look up before you cross into any area — loads, people on scaffold, things that can drop." },
  { say: "Never walk under a suspended load. Hear the horn — stop and look.", source: OSHA_SWING },
  { say: "Before you start, tell the crew next to you what you're doing and what can hurt them." },
  { say: "Water jets, lifts and line breaks reach past the tape. Not sure? Ask before you cross." },
  { say: "Done for the day? Take your tape down or update the tag. Dead barricades teach people to ignore tape." },
];

// The "other crews" lines that fit a kind of work best (CREWS_POINTS indexes).
const CREWS_FOR: Partial<Record<HazardKind, number[]>> = {
  hydroblast: [5, 0], line_break: [4, 5], lifting: [3, 2], bundle_pull: [3, 2], confined_space: [4, 1],
  inert: [4, 0], hot_work: [4, 1], pressure_test: [5, 0], radiography: [0, 4], heights: [2, 1], electrical: [1, 4],
};

// What the crew is doing, in a few words, for the "today" line.
const DOING: Record<HazardKind, string> = {
  confined_space: "entering", inert: "working nitrogen at", hydroblast: "blasting", line_break: "breaking into",
  lifting: "lifting at", bundle_pull: "pulling bundles at", startup: "starting up", hot_work: "doing hot work at",
  heights: "working at height at", pressure_test: "pressure testing", electrical: "doing electrical work at",
  catalyst: "handling catalyst at", chemical: "chemical cleaning", heater: "working the heater at",
  radiography: "shooting X-rays at", excavation: "digging at", machining: "machining",
};

const shiftOrdinal = (shiftStart: number) => Math.floor(shiftStart / 43_200_000);
// A different few each shift, round the list — the same on every screen.
function rotate<T>(list: T[], shiftStart: number, n: number, salt: number): T[] {
  if (!list.length) return [];
  const start = (shiftOrdinal(shiftStart) * n + salt) % list.length;
  return Array.from({ length: Math.min(n, list.length) }, (_, i) => list[(start + i) % list.length]);
}
const saltOf = (s: string) => [...s].reduce((a, ch) => a + ch.charCodeAt(0), 0);
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The kind's lessons as things to say. Kinds with none use the veteran checks. */
function kindPoints(kind: HazardKind, shiftStart: number, n: number, lessons: SafetyLesson[]): TalkPoint[] {
  const ls = lessons.filter((l) => l.kind === kind);
  if (ls.length) {
    // This shift's "don't miss" lesson leads; then others in turn.
    const lead = lessonFor(kind, shiftStart, lessons);
    const rest = rotate(ls.filter((l) => l !== lead), shiftStart, n, saltOf(kind));
    return [lead, ...rest].filter((l): l is SafetyLesson => !!l).slice(0, n).map((l) => ({ say: l.say, source: l.source }));
  }
  return rotate(HAZARD_KINDS[kind].checks.map((c) => (typeof c === "string" ? c : c.t)), shiftStart, n, saltOf(kind)).map((say) => ({ say }));
}

/** The topics to choose from, best first: each ranked kind of work (with
 *  "around other crews" when crews overlap on it), then barricades and
 *  other crews on their own. */
export function safetyTalks(hazards: RankedHazard[], shift: { start: number; kind?: "day" | "night" }, lessons: SafetyLesson[] = SAFETY_LESSONS): SafetyTalk[] {
  const shiftStart = shift.start;
  const when = shift.kind === "night" ? "tonight" : "today";
  const out: SafetyTalk[] = [];
  const allAlongside = new Set<string>();
  for (const h of hazards) {
    const eqs = [...new Set(h.jobs.map((j) => j.equipment).filter((x): x is string => !!x))];
    const crews = [...new Set(h.jobs.map((j) => j.who?.trim()).filter((x): x is string => !!x))];
    const who = crews.length === 1 ? crews[0] : "Crews";
    const where = andList(eqs.slice(0, 3)) + (eqs.length > 3 ? ` and ${eqs.length - 3} more` : "");
    const withOthers = h.alongside.length > 0;
    for (const a of h.alongside) allAlongside.add(a);
    out.push({
      key: withOthers ? `${h.kind}+crews` : h.kind,
      title: withOthers ? `${h.label} next to other crews` : h.label,
      today: `${who} ${DOING[h.kind]} ${where} ${when}${withOthers ? `, with ${andList(h.alongside.slice(0, 3))} working the same equipment` : ""}.`,
      // Crews overlapping: two rules for working around each other, then the job's own lessons.
      points: withOthers
        ? [...(CREWS_FOR[h.kind]?.map((i) => CREWS_POINTS[i]) ?? rotate(CREWS_POINTS, shiftStart, 2, saltOf(h.kind))), ...kindPoints(h.kind, shiftStart, 3, lessons)]
        : kindPoints(h.kind, shiftStart, 4, lessons),
    });
  }
  if (allAlongside.size > 0 || hazards.length >= 2) {
    out.push({
      key: "crews",
      title: "Barricades and working around other crews",
      today: allAlongside.size > 0 ? `Several crews are on the same equipment at the same time ${when}.` : `Several crews are doing high-risk work in the unit ${when}.`,
      points: rotate(CREWS_POINTS, shiftStart, 5, 7),
    });
  }
  return out;
}

/** The topic's sources, once each, by site ("osha.gov"). */
export function talkSources(t: SafetyTalk): Array<{ url: string; label: string; title: string }> {
  const seen = new Map<string, { url: string; label: string; title: string }>();
  for (const p of t.points) if (p.source && !seen.has(p.source.url)) seen.set(p.source.url, { ...p.source, label: sourceLabel(p.source) });
  // One link per site: two OSHA pages read as "osha.gov" twice otherwise.
  return [...new Map([...seen.values()].map((x) => [x.label, x])).values()];
}

/** The topic picked at the meeting, else the best one. */
export const pickTalk = (talks: SafetyTalk[], key?: string | null) => talks.find((t) => t.key === key) ?? talks[0];
