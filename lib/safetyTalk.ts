// safetyTalk — the turnover's safety topics, the way they're given at the
// meeting: three, side by side. The first is the job as a whole (a
// turnaround next to live units, read from the project and its schedule);
// the other two are the riskiest work on the shift being planned. Each is a
// title, a line on why now, and three short things to say out loud —
// lessons written in blood, each from a real incident report
// (lib/safetyLessons). Read in a few minutes. Not a repeat of the schedule.

import { HAZARD_KINDS, checksFor, lessonFor, sourceLabel, type HazardKind, type RankedHazard, type SafetyLesson } from "@/lib/safetyMoment";
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
    ],
  },
  inert: {
    always: { say: "Inert entry is supplied air only, with a dedicated hole watch and standby rescue at the manway. Nobody enters on a monitor alone.", source: OSHA_CSE },
    more: [
      { say: "Post and barricade every open manway: danger, nitrogen, no entry. Nobody puts their head into the opening." },
      { say: "Watch the air supply as closely as the entrant. Lose air: the entrant comes out on the escape bottle, now." },
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
      { say: "Know what was last in the line and wear the PPE for it: face shield, gloves, chemical suit if it calls for one." },
      { say: "Catch pan in place and your escape route clear before you crack it." },
    ],
  },
  lifting: {
    always: { say: "Lift plan reviewed with everyone at the pre-lift meeting. One signal person, and everyone knows who it is.", source: OSHA_SWING },
    more: [
      { say: "Swing radius barricaded. Nobody walks under a suspended load — ever.", source: OSHA_SWING },
      { say: "Tag lines guide the load; hands stay off it. Stop the lift if the wind picks up or the load won't sit right." },
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
      { say: "Drains and sewers within 35 feet sealed. Sparks and slag travel farther than you think.", source: OSHA_HOT },
    ],
  },
  heights: {
    always: { say: "100% tie-off whenever you're exposed to a fall, anchored overhead. Inspect harness and lanyard before you go up.", source: OSHA_FALL },
    more: [
      { say: "Check the scaffold tag before you climb: green to use, red stay off. Never modify it — call the scaffold crew." },
      { say: "Tools tethered and the area below barricaded. A dropped wrench kills." },
    ],
  },
  pressure_test: {
    always: { say: "Area barricaded and cleared before pressurizing. Nobody stands in line with blinds, flanges, caps or plugs." },
    more: [
      { say: "Pressure up in stages and hold at each one. A leak: depressure first, then fix it." },
      { say: "Test rig's own gauge and relief, sized for the test. Never exceed the pressure on the permit." },
    ],
  },
  electrical: {
    always: { say: "Lock it out, then test before touch — live-dead-live with a meter. No test, no touch.", source: OSHA_ELEC },
    more: [
      { say: "Only qualified electricians inside the arc-flash boundary, in the PPE the label calls for.", source: OSHA_ELEC },
      { say: "Keep water and wet work away from open panels. Cover them or stop." },
    ],
  },
  catalyst: {
    always: { say: "Spent catalyst can ignite in air. Keep it blanketed or wet, and follow the SDS for this catalyst." },
    more: [
      { say: "Entry into a reactor bed is inert entry: supplied air, hole watch and standby rescue at the manway.", source: OSHA_CSE },
      { say: "Respirators for everyone near the dump chute — dust carries to the people below." },
    ],
  },
  chemical: {
    always: { say: "Know what's in the system and read the SDS before you open it. Eyewash and safety shower tested before you start." },
    more: [
      { say: "Chemical PPE matched to the chemical: goggles, face shield, gloves and suit — not your everyday gloves." },
      { say: "H2S monitor on. Disturbed sludge releases H2S even in a cleaned vessel.", source: OSHA_H2S },
    ],
  },
  heater: {
    always: { say: "Fuel isolated and blinded at the burners before anyone enters the firebox. Verify it — don't trust a closed valve.", source: OSHA_LOTO },
    more: [
      { say: "Firebox fully purged before any light-off. No shortcuts on the purge time." },
      { say: "Refractory dust is silica. Respirators inside the firebox." },
    ],
  },
  radiography: {
    always: { say: "The radiography barricade is a radiation boundary. Nobody crosses it until the RT crew clears the area." },
    more: [
      { say: "Know tonight's shoot times for your area and plan around them. Listen for the warning before each shot." },
      { say: "The boundary covers every level — scaffold above the shot is inside it." },
    ],
  },
  excavation: {
    always: { say: "Dig permit and line locates before the first shovel. Hand dig or hydro-vac near marked lines.", source: OSHA_DIG },
    more: [
      { say: "Spoil and equipment at least two feet back from the edge. Walls inspected every shift.", source: OSHA_DIG },
      { say: "Gas test before entering a trench — heavy vapors collect at the bottom.", source: OSHA_DIG },
    ],
  },
  machining: {
    always: { say: "Machine bolted down and guarded before it spins. Hands, gloves and sleeves clear of the cutter." },
    more: [
      { say: "Face shield over safety glasses — chips fly hot and sharp. Cover open nozzles so chips don't fall in." },
      { say: "Isolation stays in place. A flange being machined is still an open line." },
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
const TA_THEMES: Array<{ key: string; title: string; points: TalkPoint[] }> = [
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
const PHASE_THEMES: Record<"shutdown" | "startup", { key: string; title: string; points: TalkPoint[] }> = {
  startup: { key: "startup", title: "Start-up: hydrocarbons coming back", points: [
    PHASE_POINTS.startup[0],
    PHASE_POINTS.startup[1],
    { say: "Every flange you touched gets watched as it heats up. Walk the blind list in the field." },
  ] },
  shutdown: { key: "shutdown", title: "Shutdown: units coming down", points: [
    PHASE_POINTS.shutdown[0],
    PHASE_POINTS.shutdown[1],
    TA_THEMES[0].points[0],
  ] },
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
 *  kinds of work. A quiet shift gets more of the job's own topics. */
export function safetyBrief(hazards: RankedHazard[], shift: { start: number; kind?: "day" | "night" }, opts: { project?: ProjectFacts; lessons?: SafetyLesson[] } = {}): SafetyTopic[] {
  const { lessons = SAFETY_LESSONS } = opts;
  const facts = opts.project ?? { turnaround: false, night: shift.kind === "night" };
  const when = shift.kind === "night" ? "tonight" : "today";
  const top = hazards.slice(0, 2);

  // 1. The job as a whole. Start-up or shutdown work on the shift leads
  // (unless start-up is already one of the risks); otherwise a turnaround
  // theme in turn, so the same words don't come round every shift.
  const ord = shiftOrdinal(shift.start);
  const phase = facts.phase && !(facts.phase === "startup" && top.some((h) => h.kind === "startup")) ? PHASE_THEMES[facts.phase] : null;
  const themes = facts.turnaround ? TA_THEMES : [TA_THEMES[3], TA_THEMES[0], TA_THEMES[2]];
  const theme = phase ?? themes[ord % themes.length];
  const unit = facts.unit ? ` · ${facts.unit}` : "";
  const dayPart = facts.day != null && facts.days != null
    ? (facts.day <= facts.days ? `Day ${facts.day} of ${facts.days}` : `Day ${facts.day} — past the planned ${facts.days}`) : "";
  // One line on where the job stands, in place of the last theme line when it matters.
  const sit = situationPoints({ ...facts, phase: undefined }).filter((p) => !/^Night:/.test(p.say) || !phase);
  const situational = sit.find((p) => /^Day \d+ of long shifts|^We're behind|^New faces/.test(p.say));
  const general: SafetyTopic = {
    key: `general:${theme.key}`, kind: "general",
    kicker: facts.turnaround ? `Turnaround${unit}` : `The job${unit}`,
    title: theme.title,
    why: [dayPart, facts.turnaround ? `live units and other crews all around the work ${when}` : `operators running the plant around the work ${when}`]
      .filter(Boolean).join(" — ").replace(/^./, (c) => c.toUpperCase()) + ".",
    points: situational ? [theme.points[0], theme.points[1], situational] : theme.points.slice(0, 3),
  };

  // 2–3. The riskiest work on the shift.
  const risks: SafetyTopic[] = top.map((h, i) => {
    const eqs = [...new Set(h.jobs.map((j) => j.equipment).filter((x): x is string => !!x))];
    const crews = [...new Set(h.jobs.map((j) => j.who?.trim()).filter((x): x is string => !!x))];
    const who = crews.length === 1 ? crews[0] : crews.length ? andList(crews.slice(0, 2)) : "Crews";
    const where = andList(eqs.slice(0, 3)) + (eqs.length > 3 ? ` + ${eqs.length - 3} more` : "");
    // The other crews — never one already doing this work.
    const others = h.alongside.filter((a) => !crews.some((c) => c.toLowerCase() === a.trim().toLowerCase()));
    const withOthers = others.length > 0;
    const steps = h.jobs.map((j) => `${j.parentName ?? j.equipment ?? ""} ${j.name}`);
    const crewLine = withOthers ? [CREWS_POINTS[CREWS_FOR[h.kind]?.[0] ?? rotate([0, 1, 4, 5], shift.start, 1, saltOf(h.kind))[0]]] : [];
    return {
      key: h.kind, kind: "risk" as const, hazard: h.kind,
      kicker: `Top risk ${when}${top.length > 1 ? ` · ${i + 1}` : ""}`,
      title: h.label,
      why: `${who} ${DOING[h.kind]} ${where} ${when}${withOthers ? ` — next to ${andList(others.slice(0, 2))}` : ""}.`,
      points: riskPoints(h.kind, shift.start, lessons, steps, crewLine[0]),
    };
  });

  // A quiet shift: the job's other topics fill the row.
  const fill = (facts.turnaround ? TA_THEMES : themes).filter((t) => t.key !== theme.key);
  const extra: SafetyTopic[] = rotate(fill, shift.start, Math.max(0, 2 - risks.length), 3).map((t) => ({
    key: `general:${t.key}`, kind: "general", kicker: facts.turnaround ? `Turnaround${unit}` : `The job${unit}`,
    title: t.title, why: `Quiet ${shift.kind === "night" ? "night" : "day"} on the schedule — a good one to talk through.`, points: t.points.slice(0, 3),
  }));
  return [general, ...risks, ...extra];
}

/** A risk's three points: the control that's always said first; a lesson
 *  from a real incident (one that fits these steps); then a second control
 *  in turn — or, when other crews share the equipment, the line for them. */
function riskPoints(kind: HazardKind, shiftStart: number, lessons: SafetyLesson[], steps: string[], crewLine?: TalkPoint): TalkPoint[] {
  const core = CORE[kind];
  const [lesson] = kindPoints(kind, shiftStart, 1, lessons, steps);
  const second = crewLine ?? rotate(core.more, shiftStart, 1, saltOf(kind))[0];
  const pts = [core.always, lesson ?? rotate(core.more, shiftStart, 2, saltOf(kind))[1], second].filter((p): p is TalkPoint => !!p);
  return pts.filter((p, i) => pts.findIndex((q) => q.say === p.say) === i).slice(0, 3);
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
