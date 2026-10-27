// safetyTalk — the turnover's safety topic, the way it's given at the
// meeting: one topic, picked from what the shift is doing; one line on why
// today; and five short things to say out loud. Two are about the work
// itself — lessons written in blood, each from a real incident report
// (lib/safetyLessons). The rest are about the job around it: a turnaround
// next to live units, the operators who own them, start-up or shutdown,
// the day of the job, running behind, nights — read from the project and
// its schedule. Read in a minute. Not a repeat of the schedule.

import { HAZARD_KINDS, checksFor, lessonFor, sourceLabel, type HazardKind, type RankedHazard, type SafetyLesson } from "@/lib/safetyMoment";
import { SAFETY_LESSONS } from "@/lib/safetyLessons";
import { dayDiff } from "@/lib/scheduleTz";

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

/** The kind's lessons as things to say — those that fit the shift's steps
 *  (a PSV lesson only where there's a PSV). Short of lessons, the veteran
 *  checks that fit. */
function kindPoints(kind: HazardKind, shiftStart: number, n: number, lessons: SafetyLesson[], steps: string[]): TalkPoint[] {
  const ls = lessons.filter((l) => l.kind === kind && (!l.if || steps.some((x) => l.if!.test(x))));
  // This shift's "don't miss" lesson leads; then others in turn.
  const lead = lessonFor(kind, shiftStart, ls);
  const picked = [lead, ...rotate(ls.filter((l) => l !== lead), shiftStart, n, saltOf(kind))]
    .filter((l): l is SafetyLesson => !!l).slice(0, n).map((l): TalkPoint => ({ say: l.say, source: l.source }));
  return [...picked, ...checksFor(kind, shiftStart, n - picked.length, steps).map((say) => ({ say }))];
}

// ── The job around the work ─────────────────────────────────────────

/** What the project and its schedule say, for the lines that aren't about
 *  the work itself. */
export interface ProjectFacts {
  /** A turnaround, shutdown or outage: live units all around the work. */
  turnaround: boolean;
  /** The day of the job the shift falls on, and the planned number. */
  day?: number;
  days?: number;
  behind?: boolean;
  night?: boolean;
  /** The shift's work takes the unit down or brings it back. */
  phase?: "shutdown" | "startup";
}

/** The project as the report knows it, before the shift is picked. */
export interface ProjectBase {
  /** The project's name and the schedule's group names ("Unit 2 Turnaround", "Shutdown"). */
  names: string[];
  start: number | null;
  finish: number | null;
  tz: string;
  behind?: boolean;
}

const TA_RE = /\bturn[\s-]*arounds?\b|\bshut[\s-]*downs?\b|\boutages?\b/i;
const TA_CODE = /\b(TA|TAR|T\/A|S\/D)\b/; // capitals only: "ta" is a word
const SHUTDOWN_RE = /\bshut[\s-]*down\b|\bde-?inventor|\bsteam(ing)?[\s-]*out\b|\bdecon(tamination)?\b|\bpump[\s-]*out\b|\bgas[\s-]*free\b/i;

/** The facts for one shift: the day of the job it falls on, and whether
 *  its own steps take the unit down or bring it back. */
export function projectFacts(p: ProjectBase | undefined, shift: { start: number; kind?: "day" | "night" }, steps: string[]): ProjectFacts {
  const days = p?.start != null && p.finish != null ? Math.max(1, dayDiff(p.start, p.finish, p.tz) + 1) : undefined;
  const day = p?.start != null && days ? dayDiff(p.start, shift.start, p.tz) + 1 : undefined;
  return {
    turnaround: !!p?.names.some((n) => TA_RE.test(n) || TA_CODE.test(n)),
    day: day != null && day >= 1 ? day : undefined,
    days,
    behind: p?.behind,
    night: shift.kind === "night",
    phase: steps.some((n) => HAZARD_KINDS.startup.re.test(n)) ? "startup" : steps.some((n) => SHUTDOWN_RE.test(n)) ? "shutdown" : undefined,
  };
}

const CSB_STARTUP = { url: "https://www.csb.gov/assets/1/17/csb_start_shut_02.pdf", title: "CSB Safety Digest: Incidents during startups and shutdowns" };
const CSB_BP = { url: "https://www.csb.gov/bp-america-texas-city-refinery-explosion/", title: "CSB: BP America Texas City Refinery Explosion" };
const CSB_TOSCO = { url: "https://www.csb.gov/assets/1/20/Tosco_Digest.pdf", title: "CSB Digest: Tosco Avon refinery fire" };
const CSB_WILLIAMS = { url: "https://www.csb.gov/csb-releases-final-case-study-into-2013-explosion-and-fire-at-williams-olefins-plant-in-geismar-louisiana/?F_All=y", title: "CSB: Williams Olefins Geismar final case study" };
const CSB_TESORO = { url: "https://www.csb.gov/tesoro-refinery-fatal-explosion-and-fire/", title: "CSB: Tesoro Anacortes refinery explosion and fire" };
const OSHA_EAP = { url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.38", title: "OSHA 1910.38: Emergency action plans" };
const OSHA_H2S = { url: "https://www.osha.gov/hydrogen-sulfide", title: "OSHA: Hydrogen sulfide" };

/** Working in an operating plant: true of any job, said in turn. */
const PLANT_POINTS: TalkPoint[] = [
  { say: "Operators own the unit. Check in with them before you start, and tell them when you stop or anything changes." },
  { say: "Never open, close or bump a valve that isn't yours. Ask the operator." },
  { say: "Know the alarm and your muster point. If it sounds, stop and go. Don't finish the bolt.", source: OSHA_EAP },
  { say: "Look at the windsock when you get to the job. Something leaks: get out crosswind, then upwind.", source: OSHA_H2S },
];
/** A turnaround: the unit is down, the ones around it aren't. */
const TURNAROUND_POINTS: TalkPoint[] = [
  { say: "The units around us are running. At Tosco, a crew opened piping on a tower still in service. Four died. Treat every line as live.", source: CSB_TOSCO },
  PLANT_POINTS[0],
  { say: "Out-of-service equipment can still get heat or pressure from the live side. At Williams Olefins, an idle reboiler blew. Two died.", source: CSB_WILLIAMS },
  { say: "Keep your gas monitor on and at your collar, even in the shut-down unit. The unit next door isn't shut down.", source: OSHA_H2S },
  PLANT_POINTS[1],
  { say: "If the unit next door alarms, stop and go. Don't finish the bolt. Know your muster point.", source: OSHA_EAP },
  PLANT_POINTS[3],
];
const PHASE_POINTS: Record<"shutdown" | "startup", TalkPoint[]> = {
  shutdown: [
    { say: "Units are most dangerous going down and coming up. If it's not your job, stay clear of what the operators are working on.", source: CSB_STARTUP },
    { say: "Drained and steamed doesn't mean empty. Oil and gas hide in low spots and dead legs." },
  ],
  startup: [
    { say: "If you're not part of start-up, you're out of the unit. At Texas City, 15 died, many in trailers near a unit being restarted.", source: CSB_BP },
    { say: "Watch equipment as it goes back in service. At Anacortes, an exchanger blew while crews switched exchanger banks. Seven died.", source: CSB_TESORO },
  ],
};

/** The lines about this shift's place in the job, most telling first. */
function situationPoints(f: ProjectFacts, kind?: HazardKind): TalkPoint[] {
  const out: TalkPoint[] = [];
  // Start-up work is its own topic: no second start-up line under it.
  if (f.phase && kind !== "startup") out.push(...PHASE_POINTS[f.phase]);
  if (f.day != null && f.day >= 7) out.push({ say: `Day ${f.day} of long shifts: tired people miss things. At Texas City, an operator had worked 29 straight 12-hour days.`, source: CSB_BP });
  if (f.behind) out.push({ say: "We're behind. That's never a reason to skip a step. Nobody gets hurt to make up hours." });
  if (f.day != null && f.day <= 2) out.push({ say: "New faces this week. Show them the exits, the alarm and the muster point before their first job.", source: OSHA_EAP });
  if (f.night) out.push({ say: "Night: carry a light and watch your feet. Pulled grating, open manways and hoses are hard to see." });
  return out;
}

/** n lines about the job around the work: one on where the job stands
 *  (start-up and shutdown first; the others in turn), the rest on working
 *  in a running plant — next to live units in a turnaround. */
function projectPoints(f: ProjectFacts, shiftStart: number, n: number, salt: number, kind?: HazardKind): TalkPoint[] {
  if (n <= 0) return [];
  const sit = situationPoints(f, kind);
  const one = f.phase && kind !== "startup" ? sit.slice(0, 1) : rotate(sit, shiftStart, 1, salt);
  const base = rotate((f.turnaround ? TURNAROUND_POINTS : PLANT_POINTS).filter((p) => !one.includes(p)), shiftStart, n - one.length, salt);
  return [...one, ...base];
}

/** The topics to choose from, best first: the riskiest work, then the job
 *  around it (a turnaround next to live units), then each other kind of
 *  work, then barricades and other crews. */
export function safetyTalks(hazards: RankedHazard[], shift: { start: number; kind?: "day" | "night" }, opts: { project?: ProjectFacts; lessons?: SafetyLesson[] } = {}): SafetyTalk[] {
  const { lessons = SAFETY_LESSONS } = opts;
  const facts = opts.project ?? { turnaround: false, night: shift.kind === "night" };
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
    // Two lines on the work; one on the crews around it when they share
    // the equipment; the rest on the job around it.
    const work = kindPoints(h.kind, shiftStart, 2, lessons, h.jobs.map((j) => `${j.parentName ?? j.equipment ?? ""} ${j.name}`));
    const crewLine = withOthers ? [CREWS_POINTS[CREWS_FOR[h.kind]?.[0] ?? rotate([0, 1, 4, 5], shiftStart, 1, saltOf(h.kind))[0]]] : [];
    out.push({
      key: withOthers ? `${h.kind}+crews` : h.kind,
      title: withOthers ? `${h.label} next to other crews` : h.label,
      today: `${who} ${DOING[h.kind]} ${where} ${when}${withOthers ? `, with ${andList(h.alongside.slice(0, 3))} working the same equipment` : ""}.`,
      points: [...work, ...crewLine, ...projectPoints(facts, shiftStart, 5 - work.length - crewLine.length, saltOf(h.kind), h.kind)],
    });
  }
  // The job itself, as a topic of its own — second, under the riskiest work.
  // "Day 2 of 5 of the turnaround." / "Day 7 of the turnaround, past the planned 5 days."
  const dayLine = (of: string) => facts.day == null || facts.days == null ? ""
    : facts.day <= facts.days ? `Day ${facts.day} of ${facts.days} of ${of}. `
      : `Day ${facts.day} of ${of}, past the planned ${facts.days} day${facts.days === 1 ? "" : "s"}. `;
  const sit = situationPoints(facts);
  const job: SafetyTalk = facts.turnaround
    ? {
      key: "turnaround", title: "Turnaround: working next to live units",
      today: `${dayLine("the turnaround")}Live lines and running units are all around the work.`,
      // Live units and the operators always; then where the job stands; then others in turn.
      points: [TURNAROUND_POINTS[0], TURNAROUND_POINTS[1], ...sit.slice(0, 2), ...rotate(TURNAROUND_POINTS.slice(2), shiftStart, 3 - Math.min(2, sit.length), 3)],
    }
    : {
      key: "plant", title: "Working around a running plant",
      today: `${dayLine("the job")}Operators own the unit the work is in.`,
      points: [...sit.slice(0, 2), ...PLANT_POINTS].slice(0, 5),
    };
  out.splice(Math.min(1, out.length), 0, job);
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
