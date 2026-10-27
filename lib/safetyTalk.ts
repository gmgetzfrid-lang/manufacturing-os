// safetyTalk — the turnover's safety topics, the way they're given at the
// meeting: three, side by side. The first is the job as a whole (a
// turnaround next to live units, read from the project and its schedule);
// the other two are the riskiest work on the shift being planned. Each is a
// title, a line on why now, and three short things to say out loud —
// lessons written in blood, each from a real incident report
// (lib/safetyLessons). Read in a few minutes. Not a repeat of the schedule.

import { HAZARD_KINDS, rankHazards, sourceLabel, type HazardJobInput, type HazardKind, type RankedHazard, type SafetyLesson } from "@/lib/safetyMoment";
import { previousShift, type ShiftTimes, type ShiftWindow } from "@/lib/shiftReport";
import { stepBandDays } from "@/lib/shiftBands";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import type { Milestone } from "@/types/schema";
import { SAFETY_LESSONS } from "@/lib/safetyLessons";
import { dayDiff } from "@/lib/scheduleTz";

export interface TalkPoint { say: string; source?: { url: string; title: string } }
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

const CSB_STARTUP = { url: "https://www.csb.gov/assets/1/17/csb_start_shut_02.pdf", title: "CSB Safety Digest: Incidents during startups and shutdowns" };
const CSB_BP = { url: "https://www.csb.gov/bp-america-texas-city-refinery-explosion/", title: "CSB: BP America Texas City Refinery Explosion" };
const CSB_TOSCO = { url: "https://www.csb.gov/assets/1/20/Tosco_Digest.pdf", title: "CSB Digest: Tosco Avon refinery fire" };
const CSB_WILLIAMS = { url: "https://www.csb.gov/csb-releases-final-case-study-into-2013-explosion-and-fire-at-williams-olefins-plant-in-geismar-louisiana/?F_All=y", title: "CSB: Williams Olefins Geismar final case study" };
const CSB_TESORO = { url: "https://www.csb.gov/tesoro-refinery-fatal-explosion-and-fire/", title: "CSB: Tesoro Anacortes refinery explosion and fire" };
const OSHA_EAP = { url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.38", title: "OSHA 1910.38: Emergency action plans" };
const OSHA_H2S = { url: "https://www.osha.gov/hydrogen-sulfide", title: "OSHA: Hydrogen sulfide" };
const OSHA_CSE = { url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.146", title: "OSHA 1910.146: Permit-required confined spaces" };
const OSHA_LOTO = { url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.147", title: "OSHA 1910.147: Control of hazardous energy (lockout/tagout)" };
const OSHA_HOT = { url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.252", title: "OSHA 1910.252: Welding, cutting and brazing — fire prevention" };
const OSHA_FALL = { url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.502", title: "OSHA 1926.502: Fall protection systems" };
const OSHA_ELEC = { url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.333", title: "OSHA 1910.333: Electrical safe work practices" };
const OSHA_DIG = { url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.651", title: "OSHA 1926.651: Excavations" };

/** The controls a supervisor says first for each kind of work, in site
 *  language: `always` leads every time; the others come round in turn. */
export const CORE: Record<HazardKind, { always: TalkPoint; more: TalkPoint[] }> = {
  confined_space: {
    always: { say: "Hole watch at the manway the whole entry, in constant contact with every entrant. Air monitored the whole time — on alarm, everyone evacuates.", source: OSHA_CSE },
    more: [
      { say: "Entry permit posted at the manway for this shift. Sign in and out on the log every time — the hole watch must know who's inside.", source: OSHA_CSE },
      { say: "Rescue plan set before anyone enters. Never go in after someone without air and a rescue team — would-be rescuers die too.", source: OSHA_CSE },
      { say: "Every line into the vessel blinded or disconnected — not just a closed valve. Verify it before entry.", source: OSHA_CSE },
      { say: "Ventilation runs the whole entry, and the air is re-tested after every break. Blower stops? Everyone evacuates until it's tested again.", source: OSHA_CSE },
      { say: "Know your way out before you go in. Trays and internals can block the manway — keep the exit path clear." },
    ],
  },
  inert: {
    always: { say: "Inert entry is supplied air only, with a dedicated hole watch and standby rescue at the manway. Nobody enters on a monitor alone.", source: OSHA_CSE },
    more: [
      { say: "Post and barricade every open manway: danger, nitrogen, no entry." },
      { say: "Watch the air supply as closely as the entrant. Lose air: the entrant comes out on the escape bottle, now." },
      { say: "Constant communication with the entrant — radio or voice line checked before entry. No answer: start the rescue, don't go in." },
      { say: "Route purge vents high and away from where people work. Know where the nitrogen goes after it leaves." },
    ],
  },
  hydroblast: {
    always: { say: "Blast zone barricaded with red danger tape. Nobody inside but the blast crew, and only with the gunner's okay." },
    more: [
      { say: "Gunner and pump operator agree hand signals before starting and keep eye contact. Any doubt: release the dump." },
      { say: "Full blast PPE every time: face shield, rain suit, metatarsal boots. No exceptions, even for a quick shot." },
      { say: "Bleed it to zero before touching a fitting, hose or tip. Never tighten anything under pressure." },
    ],
  },
  line_break: {
    always: { say: "Line-break permit and LOTO verified with the operator before the first bolt. See the isolation — don't assume it.", source: OSHA_LOTO },
    more: [
      { say: "Break away from your body. Loosen the far-side bolts first so anything trapped sprays away from you." },
      { say: "PPE for what was in the line: face shield, gloves, chemical suit if it calls for one." },
      { say: "Catch pan in place and your escape route clear before you crack it." },
      { say: "Loosen, don't remove: keep two bolts in until the joint has drained and proved empty." },
      { say: "Tag every blind you install and log it on the blind list. A blind nobody logged is the one left in at start-up." },
    ],
  },
  lifting: {
    always: { say: "Lift plan reviewed with everyone at the pre-lift meeting. One signal person, and everyone knows who it is.", source: OSHA_SWING },
    more: [
      { say: "Swing radius barricaded, with a spotter where people could walk into it.", source: OSHA_SWING },
      { say: "Stop the lift if the wind picks up or the load won't sit right. Anyone can call all-stop." },
    ],
  },
  bundle_pull: {
    always: { say: "Everyone out of the line of fire while pulling — a parted cable or sling whips. Spotter on the bundle the whole way out." },
    more: [
      { say: "Bundle puller inspected and rigged to the plan before the first pull. Pull zone barricaded." },
      { say: "Once it's out, block and crib it before anyone works near it. Bundles roll." },
    ],
  },
  startup: {
    always: { say: "Only people with a start-up job stay in the unit. Everyone else clears out until it's lined out.", source: CSB_BP },
    more: [
      { say: "Blind list walked in the field before feed goes in. Every blind seen and signed off." },
      { say: "Report every leak the moment you see it. Don't wait for turnover." },
    ],
  },
  hot_work: {
    always: { say: "Hot work permit and gas test before the first spark — and monitor continuously while you work.", source: OSHA_HOT },
    more: [
      { say: "Fire watch for the whole job and 30 minutes after, extinguisher in hand, watching where the sparks land.", source: OSHA_HOT },
      { say: "Drains and sewers within 35 feet sealed — vapor in a sewer finds the spark.", source: OSHA_HOT },
      { say: "Move or cover anything that can burn — hoses, wood, rags, insulation. Fire blankets under the work.", source: OSHA_HOT },
      { say: "Gas monitor alarms? Stop hot work, evacuate, report it — and get a new gas test before restarting." },
      { say: "Bottles upright, chained and capped when not in use. Flashback arrestors on both hoses, and hoses checked for leaks." },
    ],
  },
  heights: {
    always: { say: "100% tie-off whenever you're exposed to a fall, anchored overhead. Inspect harness and lanyard before you go up.", source: OSHA_FALL },
    more: [
      { say: "Check the scaffold tag before you climb: green to use, red stay off. Never modify it — call the scaffold crew." },
      { say: "Tools tethered and the area below barricaded. A dropped wrench kills." },
      { say: "Ladders: three points of contact, tied off at the top, nothing in your hands while you climb." },
      { say: "Man-lift basket gate shut, and tie off to the basket anchor — never the rail.", source: OSHA_FALL },
      { say: "Wind or rain picks up? Stop work at height and come down. Slick steel and gusts take people off." },
    ],
  },
  pressure_test: {
    always: { say: "Area barricaded and cleared before pressurizing. Nobody stands in line with blinds, flanges, caps or plugs." },
    more: [
      { say: "Pressure up in stages and hold at each one. Check joints from a safe distance, never leaning over them." },
      { say: "Test rig's own gauge and relief, sized for the test. Never exceed the pressure on the permit." },
      { say: "One person runs the pump and the valves. Nobody else opens, closes or bleeds anything during the test." },
      { say: "Test with what the permit says — water unless it says otherwise. Never switch to air or nitrogen to finish faster." },
      { say: "Done testing? Open the vents before you drain, so it doesn't pull a vacuum, and drain to a safe place." },
    ],
  },
  electrical: {
    always: { say: "Lock it out, then test before touch — live-dead-live with a meter. No test, no touch.", source: OSHA_ELEC },
    more: [
      { say: "Only qualified electricians inside the arc-flash boundary, in the PPE the label calls for.", source: OSHA_ELEC },
      { say: "Keep water and wet work away from open panels. Cover them or stop." },
      { say: "Your own lock and tag on every isolation point. Nobody works under someone else's lock.", source: OSHA_LOTO },
      { say: "Temporary cords and lights on GFCI, inspected, and kept out of water and walkways." },
      { say: "Before you drill or cut into a wall, slab or cable tray, find out what's in it. Locate before you penetrate." },
    ],
  },
  catalyst: {
    always: { say: "Spent catalyst can ignite in air. Keep it blanketed or wet, and follow the SDS for this catalyst." },
    more: [
      { say: "Entry into a reactor bed is inert entry: supplied air, hole watch and standby rescue at the manway.", source: OSHA_CSE },
      { say: "Respirators for everyone near the dump chute — dust carries to the people below." },
      { say: "Vacuum truck pulling catalyst: hoses grounded and bonded, and nobody in line with a hose under suction." },
      { say: "Spent catalyst can come out hot. Check its temperature before you handle it, and keep bins away from anything that burns." },
      { say: "Seal and label every bin as it fills. The label tells the next crew what's inside." },
      { say: "Reactor top crowded during loading? Keep the manway and the escape path clear — rescue needs room to work." },
    ],
  },
  chemical: {
    always: { say: "Know what's in the system and read the SDS before you open it. Eyewash and safety shower tested before you start." },
    more: [
      { say: "Chemical PPE matched to the chemical: goggles, face shield, gloves and suit — not your everyday gloves." },
      { say: "Check hoses and connections before the pump starts. A popped hose sprays chemical — stay out of the line of fire." },
      { say: "Splashed? Eyewash or shower for 15 minutes, then report it. Don't wait to see if it burns." },
      { say: "Walk the cleaning circuit before the pump starts — every valve, blind and drain where the procedure says." },
      { say: "Barricade the chemical area and post what's in use. Only the cleaning crew inside, in their PPE." },
    ],
  },
  heater: {
    always: { say: "Fuel isolated and blinded at the burners before anyone enters the firebox. Verify it — don't trust a closed valve.", source: OSHA_LOTO },
    more: [
      { say: "Firebox fully purged before any light-off. No shortcuts on the purge time." },
      { say: "Refractory dust is silica. Respirators inside the firebox." },
      { say: "Lock out the draft fans before anyone enters. A fan that starts moves the air and the heat onto you.", source: OSHA_LOTO },
      { say: "A firebox is a confined space: gas tested, ventilated and cooled, with a hole watch at the door.", source: OSHA_CSE },
      { say: "Refractory holds heat for days. Check the temperature before entry, and take cooling breaks inside." },
      { say: "Light-off is operations only. Clear the area, and stay out of line with the sight doors when burners light." },
    ],
  },
  radiography: {
    always: { say: "The radiography barricade is a radiation boundary. Nobody crosses it until the RT crew clears the area." },
    more: [
      { say: "Hear the RT warning? Walk away from the barricade and stay out until the all-clear." },
      { say: "The boundary covers every level — scaffold above the shot is inside it." },
      { say: "Radiation signs and lights up on the boundary before the first shot — and down when the crew's done." },
      { say: "Never pick up or move anything near a camera or guide tube. Call the RT crew." },
    ],
  },
  excavation: {
    always: { say: "Dig permit and line locates before the first shovel. Hand dig or hydro-vac near marked lines.", source: OSHA_DIG },
    more: [
      { say: "Spoil and equipment at least two feet back from the edge. Walls inspected every shift.", source: OSHA_DIG },
      { say: "Gas test before entering a trench — heavy vapors collect at the bottom.", source: OSHA_DIG },
      { say: "Five feet deep or more: shoring, sloping or a trench box before anyone goes in.", source: OSHA_DIG },
      { say: "Ladder within 25 feet of everyone in a trench four feet or deeper.", source: OSHA_DIG },
      { say: "Barricade the open hole and light it at night. Nobody walks the edge to look in." },
      { say: "Exposed lines supported and protected. Never use a pipe or cable as a step or a handhold." },
    ],
  },
  machining: {
    always: { say: "Machine bolted down and guarded before it spins. Hands, gloves and sleeves clear of the cutter." },
    more: [
      { say: "Face shield over safety glasses — chips fly hot and sharp. Cover open nozzles so chips don't fall in." },
      { say: "Isolation stays in place. A flange being machined is still an open line." },
      { say: "Lock out the machine before changing a cutter or clearing chips. Never reach in while it's turning." },
      { say: "Barricade the work area — chips and the swing of the machine reach past the flange." },
      { say: "Rig the machine onto the flange — don't carry it. Field machines are heavier than they look." },
      { say: "Cords and air hoses routed away from the cutter and the walkway. Check them before every start." },
      { say: "Keep cutting fluid off the grating. A slip next to a turning cutter is how hands get caught." },
      { say: "Clean the flange face and gas test before setup. Residue left on it can burn when the cutter heats up." },
      { say: "Hearing protection on — the machine is loud, and so is the unit around you." },
      { say: "Two on setup: one runs the machine, one watches the cutter with a hand near the stop." },
    ],
  },
};

// What the crew is doing, in a few words, for the "today" line.
const DOING: Record<HazardKind, string> = {
  confined_space: "entering", inert: "working nitrogen at", hydroblast: "blasting", line_break: "breaking into",
  lifting: "lifting at", bundle_pull: "pulling bundles at", startup: "starting up", hot_work: "doing hot work at",
  heights: "working at height at", pressure_test: "pressure testing", electrical: "doing electrical work at",
  catalyst: "handling catalyst at", chemical: "chemical cleaning", heater: "working the heater at",
  radiography: "shooting X-rays at", excavation: "digging at", machining: "machining",
};

// ── No repeats ──────────────────────────────────────────────────────
// Every line has its place in a five-shift cycle and is said only on its
// shifts — so whatever the work, nothing comes round again within four
// shifts (the core control of a risk aside: that's said every time).
// Tied to the shift and its date: the same on every screen, nothing to set.
// Days count round the cycle and a night sits three on from its day, so
// day shifts alone, nights alone, or both in turn all keep the gap.
const CYCLE = 5;
export type Line = TalkPoint & { r: number; if?: RegExp; lesson?: boolean };
const mod = (a: number, n: number) => ((a % n) + n) % n;
/** Lines spread round the cycle — those that always fit first, so every
 *  shift has one; then those for particular equipment. */
function cycle(always: Array<TalkPoint & { lesson?: boolean }>, specific: Array<TalkPoint & { if: RegExp; lesson?: boolean }> = []): Line[] {
  return [...always, ...specific].map((p, i) => ({ ...p, r: i % CYCLE }));
}
/** The shift's line from a cycle: one whose turn it is, that fits the
 *  steps (a PSV lesson only where there's a PSV) and isn't said already
 *  tonight. Real incidents first (one about this equipment before a
 *  general one), then `prefer`, then equipment-specific checks. */
function lineFor(lines: Line[], ord: number, salt: number, steps: string[], used: Set<string>, prefer?: (p: Line) => boolean): TalkPoint | undefined {
  const r = mod(ord + salt, CYCLE);
  const said = [...used];
  const fit = lines.filter((p) => p.r === r && !said.some((u) => near(u, p.say, 0.5)) && (!p.if || steps.some((x) => p.if!.test(x))));
  if (!fit.length) return undefined;
  const rank = (p: Line) => (p.lesson ? (p.if ? 0 : 1) : prefer?.(p) ? 2 : p.if ? 3 : 4);
  const best = Math.min(...fit.map(rank));
  const top = fit.filter((p) => rank(p) === best);
  const p = top[mod(Math.floor(ord / CYCLE), top.length)];
  return p.source ? { say: p.say, source: p.source } : { say: p.say };
}

/** The shift's place in the cycle: its plant day, a night three on. */
function cycleOrdinal(shift: { start: number; kind?: "day" | "night"; dayKey?: string }): number {
  const night = shift.kind === "night";
  const day = shift.dayKey ? Math.round(Date.parse(`${shift.dayKey}T00:00:00Z`) / 86_400_000) : Math.floor((shift.start - (night ? 43_200_000 : 0)) / 86_400_000);
  return day + (night ? 3 : 0);
}

// Two lines that say the same thing in other words: most of the shorter's
// words are in the longer ("Refractory dust is silica" twice over).
const STOP = new Set("a an the and or of to in on at for it its is be by with before after every each any your you no not don't never just only all from as into out up off this that what who how than then can when one if are was has have their them they there".split(" "));
const wordsOf = (s: string) => new Set(s.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' ]/g, " ").split(/\s+/)
  .filter((w) => w && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, "")));
function near(a: string, b: string, at: number): boolean {
  if (a === b) return true;
  const A = wordsOf(a), B = wordsOf(b);
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.max(1, Math.min(A.size, B.size)) >= at;
}

const saltOf = (s: string) => [...s].reduce((a, ch) => a + ch.charCodeAt(0), 0);
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

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
  /** The unit the project is on ("Transmix-1"), from its name. */
  unit?: string;
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
// "Shutdown-required inspection" is work that needs the unit down, not the unit coming down.
const SHUTDOWN_RE = /\bshut[\s-]*down\b(?![\s-]*req)|\bde-?inventor|\bsteam(ing)?[\s-]*out\b|\bdecon(tamination)?\b|\bpump[\s-]*out\b|\bgas[\s-]*free\b/i;

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
    unit: unitOf(p?.names[0]) ?? undefined,
  };
}


/** Working in an operating plant: true of any job, said in turn. */
const PLANT_POINTS: TalkPoint[] = [
  { say: "Operators own the unit. Check in with them before you start, and tell them when you stop or anything changes." },
  { say: "Never open, close or bump a valve that isn't yours. Ask the operator." },
  { say: "Know the alarm and your muster point. When it sounds, stop work and evacuate — don't finish the bolt.", source: OSHA_EAP },
  { say: "Check the windsock when you start the job. If you evacuate, go crosswind first, then upwind to the muster point clear of the release.", source: OSHA_H2S },
];

// The job's place in the turnaround, said a different way each shift: a
// long job or a run of behind doesn't hear the same line every turnover.
// r: its place in the four-shift cycle (see lineFor).
const FATIGUE = (day: number): TalkPoint[] => [
  { say: `Day ${day} of long shifts: tired people miss things. At Texas City, an operator had worked 29 straight 12-hour days.`, source: CSB_BP },
  { say: "Twelve-hour shifts stack up. Watch your partner for fatigue, and call a break when you see it." },
  { say: "Tired crews skip checks. Double-check isolations and permits — that's where tired mistakes happen." },
  { say: "Fatigue hits hardest in the small hours and after a meal. Rotate the hard jobs, and speak up if you're fading." },
];
const BEHIND: TalkPoint[] = [
  { say: "We're behind. That's never a reason to skip a step. Nobody gets hurt to make up hours." },
  { say: "Pressure to catch up is when steps get skipped. Use your stop-work authority — no job is that urgent." },
  { say: "Behind schedule? Slow down at the risky parts. A shortcut that goes wrong costs days, not hours." },
  { say: "Rushing shows up in housekeeping first. Keep walkways clear and tools put away, even when we're behind." },
];
const NEW_FACES: TalkPoint[] = [
  { say: "New faces this week. Show them the exits, the alarm and the muster point before their first job.", source: OSHA_EAP },
  { say: "New to the unit? Ask. Nobody here minds a question — everybody minds a guess." },
];

/** The lines about this shift's place in the job, each on its own shifts. */
function situationLines(f: ProjectFacts): Line[] {
  const out: Line[] = [];
  if (f.day != null && f.day >= 7) FATIGUE(f.day).forEach((p, i) => out.push({ ...p, r: i }));
  if (f.behind) BEHIND.forEach((p, i) => out.push({ ...p, r: i }));
  if (f.day != null && f.day <= 2) NEW_FACES.forEach((p, i) => out.push({ ...p, r: i * 2 }));
  return out;
}

// ── The brief: three topics, side by side ───────────────────────────
// 1. The job as a whole — a turnaround next to live units, read from the
//    project and its schedule, a different theme each shift.
// 2–3. The two riskiest kinds of work on the shift being planned.
// Each: a title, one line on why, three things to say out loud.

export interface SafetyTopic {
  key: string;
  kind: "general" | "risk";
  /** Above the title: "Turnaround · Transmix-1" / "Top risk tonight". */
  kicker: string;
  title: string;
  /** Why this topic now, in a line. */
  why: string;
  points: TalkPoint[];
  hazard?: HazardKind;
}

const OSHA_PSM = { url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.119", title: "OSHA 1910.119: Process safety management (safe work practices, contractors)" };

/** What a turnaround's general topic is about — one per shift, in turn. */
export const TA_THEMES: Array<{ key: string; title: string; points: TalkPoint[] }> = [
  { key: "simops", title: "Live units & SIMOPS", points: [
    { say: "Released means signed. Don't touch equipment until the operator signs it over on the permit and the JHA.", source: OSHA_PSM },
    { say: "Treat every line you didn't open yourself as live. At Tosco, a crew opened piping on a tower still running. Four died.", source: CSB_TOSCO },
    { say: "Know who's above, below and beside you. Talk to the crew next to you before you start." },
  ] },
  { key: "release", title: "Released equipment & sign-offs", points: [
    { say: "Walk it down with the operator. Blinds, bleeders, locks — see them, don't assume them.", source: OSHA_PSM },
    { say: "The JHA covers the job you were released for. Scope changes? Stop, redo the JHA, get a new sign-off." },
    { say: "Out-of-service can still get heat or pressure from the live side. At Williams Olefins, an idle reboiler blew. Two died.", source: CSB_WILLIAMS },
  ] },
  { key: "handoff", title: "Shift change & handoffs", points: [
    { say: "Hand over every open break, blank and barricade by name. Don't leave it for the next crew to find." },
    { say: "Don't pick up what the last crew left until you've walked it. Ask what's open and what's live." },
    { say: "Update your tags before you leave: who owns it, what's open, how to reach them.", source: OSHA_SIGNS },
  ] },
  { key: "gas", title: "Gas, wind & the unit next door", points: [
    { say: "H2S monitor on and at your collar, even in the shut-down unit. The units next door are still running.", source: OSHA_H2S },
    PLANT_POINTS[3],
    { say: "Monitor alarms or you smell gas? Stop work, evacuate to your muster point, then report it. Never go back for tools.", source: OSHA_EAP },
  ] },
  { key: "operators", title: "Operators own the unit", points: [
    PLANT_POINTS[0],
    PLANT_POINTS[1],
    { say: "Unit alarm sounds? Stop work, make the job safe, and evacuate to your muster point. Account for your whole crew there.", source: OSHA_EAP },
  ] },
];
/** Not a turnaround: the themes that fit any job in a running plant. */
/** A quiet shift's extra topic: the toolbox talks every crew needs, one
 *  per shift in the cycle — never one of the job's own themes, so a quiet
 *  night doesn't repeat what the shifts around it said. */
export const QUIET_THEMES: Array<{ key: string; title: string; points: TalkPoint[] }> = [
  { key: "linefire", title: "Line of fire", points: [
    { say: "Before you pull, push or cut, ask: if it slips, breaks or lets go, where does it go? Don't be there." },
    { say: "Stand clear of anything under tension or pressure — slings, hoses, springs, come-alongs. If it lets go, it whips." },
    { say: "Never put yourself between moving equipment and anything fixed. Vehicles, loads and swinging gates pin people." },
  ] },
  { key: "hands", title: "Hands & pinch points", points: [
    { say: "Know where your hands are before every move. Pinch points are where the work closes in on itself." },
    { say: "Use a tool, not your fingers, to line up bolt holes or guide a load." },
    { say: "Wear the gloves the job calls for — and take them off near anything that spins." },
  ] },
  { key: "dropped", title: "Dropped objects", points: [
    { say: "Working above others? Tether your tools, and keep loose parts in a bag or bucket — never on the grating." },
    { say: "Walking below work at height? Go around the barricade, not under it." },
    { say: "Check what's above you before you set up — scaffold, open grating, a crew overhead." },
  ] },
  { key: "housekeeping", title: "Housekeeping", points: [
    { say: "Hoses and cords run overhead or along the edge — never across a stair, ladder or walkway." },
    { say: "Clean as you go: scrap, rags and bolts off the grating before the shift ends." },
    { say: "Clean up or cover a spill the moment it happens, and report it. Oil on grating is a fall waiting." },
  ] },
  { key: "stopwork", title: "Stop work & speak up", points: [
    { say: "Anyone can stop a job they think is unsafe — and nobody gets in trouble for it." },
    { say: "Near miss? Report it today. The one nobody reports is the one that hurts someone next week." },
    { say: "See something, say something — even to another crew. Most people are glad you did." },
  ] },
];

export const PLANT_THEMES = [TA_THEMES[4], TA_THEMES[0], TA_THEMES[2], TA_THEMES[1], { key: "gas", title: "Gas, wind & your way out", points: [
  { say: "H2S monitor on and at your collar the whole job. The unit around you is running.", source: OSHA_H2S },
  TA_THEMES[3].points[1],
  TA_THEMES[3].points[2],
] }];

export const PHASES: Record<"shutdown" | "startup", { key: string; title: string; always: TalkPoint; lines: Line[] }> = {
  startup: { key: "startup", title: "Start-up: hydrocarbons coming back",
    always: { say: "If you're not part of start-up, you're out of the unit. At Texas City, 15 died, many in trailers near a unit being restarted.", source: CSB_BP },
    lines: cycle([
      { say: "Watch equipment as it goes back in service. At Anacortes, an exchanger bank being started up after cleaning blew apart. Seven died.", source: CSB_TESORO },
      { say: "Every flange you opened is a leak point as it heats up. Know which ones are yours, and watch them." },
      { say: "Leaks show up as lines heat up. Report any drip, wisp or smell to the operator — don't tighten bolts on a live line." },
      { say: "Hydrocarbons are back in lines that were open all week. From here on, treat every line as live." },
      { say: "Clear out what you're done with — tools, tape, hoses, scaffold. Leftovers block the operators and the escape routes." },
      { say: "Know the start-up plan for your area: when feed comes in, and when your crew has to be out." },
      { say: "Steam and hot oil are coming back. Don't touch a line or valve you haven't checked." },
      { say: "Know your muster point and the wind before feed comes in. If the alarm sounds, evacuate crosswind, then upwind.", source: OSHA_EAP },
      { say: "First hours of start-up: no hot work, no line breaks, no new jobs in the unit without operations' okay." },
      { say: "Equipment back in service can start or move on its own. Stay clear of anything that's been handed back." },
    ]) },
  shutdown: { key: "shutdown", title: "Shutdown: units coming down",
    always: { say: "Units are most dangerous going down and coming up. If it's not your job, stay clear of what the operators are working on.", source: CSB_STARTUP },
    lines: cycle([
      { say: "Steam-outs and purges vent at bleeders and drains. Know where they discharge, and stay clear." },
      { say: "Purging and steam-out change by the hour. Check with the operator before you start, and again when anything changes." },
      { say: "Lines are hot during steam-out. Don't touch a line or valve until you know its temperature." },
      { say: "Operators have their hands full bringing it down. Stay out of their way and wait for your release." },
      { say: "Watch for anything not normal — flaring, venting, alarms, a smell. Stop and tell the operator." },
      { say: "Pumps, drains and samples are the operators' job while it comes down. Don't touch them, even to help." },
      { say: "Know your muster point and the wind before the first equipment is opened. If the alarm sounds, evacuate crosswind, then upwind.", source: OSHA_EAP },
      { say: "Keep walkways and ladders clear. Hoses, tools and scaffold staged for the job stay out of the operators' way." },
      { say: "More trucks and people in the unit than usual — vacuum trucks, cranes, crews staging. Use the walkways and watch for backing vehicles." },
      { say: "Sampling and draining under way: liquids can come out hot, sour or both. Stay clear of open drains and sample points." },
    ]) },
};

const MONTHS = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?|spring|summer|fall|autumn|winter)\b/gi;
/** The unit a project is on, from its name: "October 2026 Transmix-1
 *  Turnaround" → "Transmix-1". Null when nothing's left to go on. */
export function unitOf(projectName: string | null | undefined): string | null {
  if (!projectName) return null;
  const u = projectName.replace(MONTHS, " ").replace(/\b(19|20)\d{2}\b/g, " ").replace(TA_RE, " ").replace(TA_CODE, " ")
    .replace(/[|,()]/g, " ").replace(/\s[-–—]\s/g, " ").replace(/\s+/g, " ").trim();
  return u.length >= 2 && u.length <= 30 ? u : null;
}

/** The three topics for a shift: the job as a whole, then its two riskiest
 *  kinds of work. A quiet shift gets a toolbox topic in place of a risk;
 *  with no risky work at all, the job's topic and that one. */
export function safetyBrief(hazards: RankedHazard[], shift: { start: number; kind?: "day" | "night"; dayKey?: string }, opts: {
  project?: ProjectFacts; lessons?: SafetyLesson[];
  /** The risk cards shown the shifts before this one, the latest first (riskHistory). */
  recentRisks?: HazardKind[][];
} = {}): SafetyTopic[] {
  const { lessons = SAFETY_LESSONS, recentRisks = [] } = opts;
  const facts = opts.project ?? { turnaround: false, night: shift.kind === "night" };
  const when = shift.kind === "night" ? "tonight" : "today";
  const ord = cycleOrdinal(shift);
  // Nothing said twice tonight.
  const used = new Set<string>();
  const take = (p: TalkPoint | undefined) => { if (p) used.add(p.say); return p; };
  const top = pickRisks(hazards, recentRisks);

  // 1. The job as a whole. Start-up or shutdown work on the shift leads
  // (unless start-up is already one of the risks); otherwise a turnaround
  // theme in turn — a different one each shift, round the list.
  const phase = facts.phase && !(facts.phase === "startup" && top.some((x) => x.h.kind === "startup")) ? PHASES[facts.phase] : null;
  const themes = facts.turnaround ? TA_THEMES : PLANT_THEMES;
  const theme = themes[mod(ord, themes.length)];
  const unit = facts.unit ? ` · ${facts.unit}` : "";
  const kicker = facts.turnaround ? `Turnaround${unit}` : `The job${unit}`;
  const dayPart = facts.day != null && facts.days != null
    ? (facts.day <= facts.days ? `Day ${facts.day} of ${facts.days}` : `Day ${facts.day} — past the planned ${facts.days}`) : "";
  // One line on where the job stands (tired, behind, new faces) in place
  // of the topic's last line, on its shifts.
  const situational = lineFor(situationLines(facts), ord, 0, [], used);
  // Start-up / shutdown: its standing line, then two of its others in turn.
  const phasePoints = (ph: (typeof PHASES)[keyof typeof PHASES]) => {
    const out = [take(ph.always), take(lineFor(ph.lines, ord, 0, [], used))];
    out.push(take(situational ?? lineFor(ph.lines, ord, 0, [], used)));
    return out.filter((p): p is TalkPoint => !!p);
  };
  const general: SafetyTopic = phase ? {
    key: `general:${phase.key}`, kind: "general", kicker, title: phase.title,
    why: [dayPart, `the unit ${phase.key === "startup" ? "starting up" : "coming down"} around the work ${when}`].filter(Boolean).join(" — ").replace(/^./, (c) => c.toUpperCase()) + ".",
    points: phasePoints(phase),
  } : {
    key: `general:${theme.key}`, kind: "general", kicker, title: theme.title,
    why: [dayPart, facts.turnaround ? `live units and other crews all around the work ${when}` : `operators running the plant around the work ${when}`]
      .filter(Boolean).join(" — ").replace(/^./, (c) => c.toUpperCase()) + ".",
    points: [theme.points[0], theme.points[1], situational ?? theme.points[2]].map((p) => take(p)!),
  };

  // 2–3. The riskiest work on the shift.
  const risks: SafetyTopic[] = top.map(({ h, run }, i) => {
    const eqs = [...new Set(h.jobs.map((j) => j.equipment).filter((x): x is string => !!x))];
    const crews = [...new Set(h.jobs.map((j) => j.who?.trim()).filter((x): x is string => !!x))];
    const who = crews.length === 1 ? crews[0] : crews.length ? andList(crews.slice(0, 2)) : "Crews";
    const where = andList(eqs.slice(0, 3)) + (eqs.length > 3 ? ` + ${eqs.length - 3} more` : "");
    // The other crews — never one already doing this work.
    const others = h.alongside.filter((a) => !crews.some((c) => c.toLowerCase() === a.trim().toLowerCase()));
    const withOthers = others.length > 0;
    const steps = h.jobs.map((j) => `${j.parentName ?? j.equipment ?? ""} ${j.name}`);
    const { gems, controls } = riskLines(h.kind, lessons);
    const salt = saltOf(h.kind);
    const best = new Set((CREWS_FOR[h.kind] ?? []).map((k) => CREWS_POINTS[k].say));
    // The control always said first; a lesson from a real incident; then a
    // second control — or, with other crews on it, the line for them.
    const lesson = take(lineFor(gems, ord, salt, steps, used) ?? lineFor(controls, ord, salt, steps, used));
    const third = take((withOthers ? lineFor(CREW_LINES, ord, 0, steps, used, (p) => best.has(p.say)) : undefined) ?? lineFor(controls, ord, salt, steps, used));
    return {
      key: h.kind, kind: "risk" as const, hazard: h.kind,
      kicker: `Top risk ${when}${top.length > 1 ? ` · ${i + 1}` : ""}${run >= 2 ? ` · ${ordinal(run + 1)} shift running` : ""}`,
      title: h.label,
      why: `${who} ${DOING[h.kind]} ${where} ${when}${withOthers ? ` — next to ${andList(others.slice(0, 2))}` : ""}.`,
      points: [take(CORE[h.kind].always), lesson, third].filter((p): p is TalkPoint => !!p),
    };
  });

  // A quiet shift: a toolbox topic fills the row, from its own cycle.
  const quiet = QUIET_THEMES[mod(ord, QUIET_THEMES.length)];
  const extra: SafetyTopic[] = risks.length < 2 ? [{
    key: `general:${quiet.key}`, kind: "general", kicker, title: quiet.title,
    why: `Quiet ${shift.kind === "night" ? "night" : "day"} on the schedule — a good one to talk through.`,
    points: quiet.points.map((p) => take(p)!),
  }] : [];
  return [general, ...risks, ...extra];
}

/** How many kinds of work the brief ranks before picking its two — room
 *  for the next one when a kind steps aside. */
export const RISKS_RANKED = 4;
// "Clearly the top risk": a full severity step ahead of the next one.
const CLEAR_LEAD = 10;
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
/** How many shifts in a row, up to this one, a kind was a risk card. */
const runOf = (kind: HazardKind, recent: HazardKind[][]) => { let n = 0; for (const r of recent) { if (!r.includes(kind)) break; n++; } return n; };

/** The two risk cards: the shift's two riskiest kinds of work — but one
 *  that was a card the last two shifts steps aside for the next, unless
 *  it's still clearly on top (a full severity step ahead), when it stays
 *  and says how long it's run. */
function pickRisks(hazards: RankedHazard[], recent: HazardKind[][]): Array<{ h: RankedHazard; run: number }> {
  const pool = [...hazards];
  const out: Array<{ h: RankedHazard; run: number }> = [];
  while (out.length < 2 && pool.length) {
    const head = pool[0];
    const fresh = pool.find((h) => runOf(h.kind, recent) < 2);
    const pick = runOf(head.kind, recent) >= 2 && fresh && head.score - fresh.score < CLEAR_LEAD ? fresh : head;
    out.push({ h: pick, run: runOf(pick.kind, recent) });
    pool.splice(pool.indexOf(pick), 1);
  }
  return out;
}

// The lines for crews working around other crews: one cycle for every kind
// of work, so a line said over one kind isn't said over another next shift.
export const CREW_LINES = cycle(CREWS_POINTS);

/** A kind of work's two cycles: lessons from real incidents (padded with
 *  veteran checks so every shift has one), and further controls. */
export function riskLines(kind: HazardKind, lessons: SafetyLesson[]): { gems: Line[]; controls: Line[] } {
  const ls = lessons.filter((l) => l.kind === kind);
  const checks = HAZARD_KINDS[kind].checks;
  const always = ls.filter((l) => !l.if).map((l) => ({ say: l.say, source: l.source, lesson: true }));
  // A veteran check that says what a control or a lesson already says is left out.
  const known = [CORE[kind].always, ...CORE[kind].more, ...ls].map((x) => x.say);
  const fresh = (say: string) => !known.some((k) => near(k, say, 0.4));
  const plain = checks.filter((c): c is string => typeof c === "string" && fresh(c)).map((say) => ({ say }));
  // Lessons first, filled out to a full cycle with checks, then controls.
  const rest = [...plain, ...CORE[kind].more];
  const pad = Math.max(0, CYCLE - always.length);
  return {
    gems: cycle([...always, ...rest.slice(0, pad)], [
      ...ls.filter((l) => l.if).map((l) => ({ say: l.say, source: l.source, if: l.if!, lesson: true })),
      ...checks.filter((c): c is { t: string; if: RegExp } => typeof c !== "string" && fresh(c.t)).map((c) => ({ say: c.t, if: c.if })),
    ]),
    controls: cycle(rest.slice(pad)),
  };
}

/** The risk cards shown the shifts before `next`, the latest first (shifts
 *  with no work, so no brief, left out). Each shift's work comes from the
 *  schedule, ranked and picked the same way as tonight's — played forward
 *  from the start of the job (at most `back` shifts), so a shift's cards
 *  are the same whichever shift you look from. */
export function riskHistory(milestones: Milestone[], next: ShiftWindow, tz: string, times: ShiftTimes, back = 60): HazardKind[][] {
  const parents = new Set(milestones.map((m) => m.parentId).filter(Boolean) as string[]);
  const byId = new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m]));
  const leaves = milestones.filter((m) => m.id && !parents.has(m.id) && m.plannedAt);
  if (!leaves.length) return [];
  const first = leaves.reduce((a, m) => Math.min(a, startMsOf(m)), Infinity);
  const bands = new Map(leaves.map((m) => [m.id!, stepBandDays(m, tz, times)]));
  const wins: ShiftWindow[] = [];
  for (let w = previousShift(next, tz, times), i = 0; i < back && w.end > first; w = previousShift(w, tz, times), i++) wins.unshift(w);
  const shown: HazardKind[][] = [];
  for (const w of wins) {
    const jobs: HazardJobInput[] = leaves.filter((m) => bands.get(m.id!)![w.kind].has(w.dayKey)).map((m) => {
      const a = Math.max(startMsOf(m), w.start), b = Math.min(finishMsOf(m), w.end);
      return { id: m.id!, name: m.name, parentName: m.parentId ? byId.get(m.parentId)?.name ?? null : null, parentId: m.parentId ?? null,
        hours: Math.max(0.5, (b - a) / 3_600_000), when: "", start: a, end: Math.max(a, b), who: m.responsibleParty?.trim() || null };
    });
    // No work, no brief that shift: it doesn't break a run.
    if (jobs.length) shown.unshift(pickRisks(rankHazards(jobs, { shift: w, max: RISKS_RANKED }), shown).map((x) => x.h.kind));
  }
  return shown;
}

/** A point as the eye reads it: the first sentence (the thing to do), and
 *  the rest (why, or the incident behind it). */
export function splitLead(say: string): [string, string] {
  const m = say.match(/^(.+?[.!?])\s+(.*)$/);
  return m ? [m[1], m[2]] : [say, ""];
}

/** A topic's sources, once each, by site ("osha.gov"). */
export function talkSources(t: { points: TalkPoint[] }): Array<{ url: string; label: string; title: string }> {
  const seen = new Map<string, { url: string; label: string; title: string }>();
  for (const p of t.points) if (p.source && !seen.has(p.source.url)) seen.set(p.source.url, { ...p.source, label: sourceLabel(p.source) });
  // One link per site: two OSHA pages read as "osha.gov" twice otherwise.
  return [...new Map([...seen.values()].map((x) => [x.label, x])).values()];
}
