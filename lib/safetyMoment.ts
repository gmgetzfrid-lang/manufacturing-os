// lib/safetyMoment.ts — the turnover's safety moment.
//
// Instead of "safety moment — anyone?", the next shift's three riskiest
// kinds of work, each with a hit list — the essentials the crew must have
// covered (permit, gas test, attendant …) — and one "don't miss" lesson
// drawn from a real incident: not its story, its lesson — what to look
// out for, and what prevents it.
//
//   1. rankHazards — read the next shift's steps, sort them into kinds of
//      work (hydroblasting, vessel entry, line breaks, lifts …) by their
//      names, and rank the kinds by how badly they can hurt someone, then
//      by how much of it is on the shift. Never two of the same family.
//   2. Each kind's hit list, and one "don't miss" lesson from the built-in
//      library — a different one each shift (lessonFor).
//
// Pure: no database, no network, no AI — the hit lists and the lessons
// (lib/safetyLessons) are built in, each lesson with the page it came from.

import { SAFETY_LESSONS } from "@/lib/safetyLessons";

export type HazardKind =
  | "confined_space" | "inert" | "hydroblast" | "line_break" | "lifting" | "bundle_pull"
  | "startup" | "hot_work" | "heights" | "pressure_test" | "electrical" | "catalyst"
  | "chemical" | "heater" | "radiography" | "excavation" | "machining";

interface KindDef {
  label: string;
  /** How badly it can go: 5 = kills people. Ranks first. */
  severity: number;
  /** Kinds in one family are "the same thing" — one per moment. */
  family: string;
  /** Matched against the step's name and its equipment / group names. */
  re: RegExp;
  /** What a veteran checks that a new hand wouldn't think to — not the
   *  permit-and-PPE basics everyone already says. Two show per shift, in
   *  turn; one with `if` shows only when a step's name fits it. */
  checks: Array<string | { t: string; if: RegExp }>;
}

export const HAZARD_KINDS: Record<HazardKind, KindDef> = {
  confined_space: {
    label: "Vessel entry", severity: 5, family: "entry",
    re: /\bconfined\b|\bvessel entry\b|\bentry\b|\benter\b|internal (manway|inspection)s?|\binternals\b|\btrays?\b|\bdowncomers?\b|\bdemister\b|\bpacking\b|\bhole ?watch\b/i,
    checks: [
      "Gas test top, middle and bottom — H2S comes off sludge when it's disturbed, after the test.",
      "Rescue sized for this manway: can the team get a packaged person out of it?",
      "The attendant's only job is the entrant — no fetching tools, no second opening.",
      "Every air mover traced to its source: a utility station can be nitrogen.",
    ],
  },
  inert: {
    label: "Nitrogen / inert", severity: 5, family: "entry",
    re: /\bnitrogen\b|\bn2\b|\binert(ed|ing)?\b|\bpurg(e|ed|ing)\b/i,
    checks: [
      "Nitrogen gives no warning — one or two breaths at the opening can drop you.",
      "Purge leaves through the top manway onto the platform: monitor the platform too.",
      "On supplied air, someone watches the air source, not just the entrant.",
      "Nobody's head crosses the plane of a purged opening — not to look, not to reach.",
    ],
  },
  hydroblast: {
    label: "Hydroblasting", severity: 5, family: "hydroblast",
    re: /hydro[\s-]*blast|water[\s-]*blast|hydro[\s-]*jet|water[\s-]*jet|high[\s-]pressure water|\blancing\b|\bhpwj\b/i,
    checks: [
      "Dump tested by tonight's operator at working pressure — not at idle, not by the last crew.",
      "Reaction force rises with pressure and flow: high-flow tips need a lance holder, not a stronger hand.",
      { t: "Flex lance in tubes: back-out preventer on, and the lance sized to the tube ID.", if: /tube|bundle/i },
      { t: "Blast zone covers the whole exchanger end and the far tubesheet — nobody at the other end.", if: /tube|bundle|shell|exchanger/i },
    ],
  },
  line_break: {
    label: "Line break", severity: 5, family: "line_break",
    re: /\bblinds?\b|line[\s-]*break|break(ing)? containment|\bunbolt|\bflanges?\b|\bspools?\b|\bpsv\b|\bprv\b|relief valve|remove (the )?(meter|valve|spool|components?|heads?|channel|cover)|\bopen (the )?(line|manways?)\b|\bmanways?\b|\bswap\b.*\bvalve\b|\bdrain(ing)? and vent|\bpull\b.*\bplugs?\b|\bplugs? (pull|removal)/i,
    checks: [
      "Crack the far side a quarter turn and wait: a line that keeps weeping has a passing valve.",
      "Know what was last in the line — dead legs and low points hold product after draining.",
      "Bolts that won't turn: no torch or hammer until the line is proven empty and gas-free.",
      { t: "Air-condenser header plugs are each a pressure boundary — treat every plug as a break.", if: /\bplugs?\b/i },
    ],
  },
  lifting: {
    label: "Crane lift", severity: 5, family: "lifting",
    re: /\bcrane\b|\blifts?\b|\bpicks?\b|\brigging\b|\brig\b|\bhoist|\bfly[\s-]*out\b|\btransport (the )?(exchanger|bundle|vessel)|\bset (the )?(exchanger|vessel|drum)\b|\bheavy haul\b/i,
    checks: [
      "Fouled equipment weighs more than the nameplate — add deposits and liquid left in the shell.",
      "Lift from designed points only; a nozzle or a pipe is not a lifting lug.",
      "Pinch points kill more riggers than drops: nobody between the load and steel.",
      "The load has to be free before it's lifted — the crane never pulls anything loose.",
    ],
  },
  bundle_pull: {
    label: "Bundle pull", severity: 4, family: "lifting",
    re: /\b(pull|extract|install|insert|re-?install|set)( the)? (tube )?bundles?\b|\bbundle (pull|extract|puller)|\bre-?bundle\b/i,
    checks: [
      "Pull force climbing is a stop signal — soak, jack the tubesheet or re-plan; never 'a bit more'.",
      "Once the bundle clears the shell its balance point moves — re-check the extractor as it comes.",
      "Exposed deposits can heat as they dry (iron sulfide): keep them wet until blasting.",
      "Weight with fouling: a plugged bundle can be well over its dry weight.",
    ],
  },
  startup: {
    label: "Start-up", severity: 5, family: "startup",
    re: /\bstart[\s-]*up\b|\bcommission|\breturn to service\b|\bintroduc(e|ing) (feed|hydrocarbon)|\bpressure up\b|\blight (off|the) (heater|burners?)\b|\bbring (it )?(on ?line|online)\b/i,
    checks: [
      "Walk the blind list in the field — the forgotten blind is in a rack nobody looks at.",
      "Low-point drains and bleeders opened during maintenance: closed and plugged before feed.",
      "Pressure up in steps and walk each step — a torqued flange can still leak hot.",
      "Temporary strainers, hoses and gauges from maintenance: out, or on the list.",
    ],
  },
  hot_work: {
    label: "Hot work", severity: 4, family: "hot_work",
    re: /\bweld|\bhot work\b|\btorch\b|\bcutting\b|\bgrind|\bpwht\b|\bstress reliev|\bpreheat\b|\bburning\b/i,
    checks: [
      "Gas test at the work point and down-drain — vapor travels along trenches to the spark.",
      "Drains and sewers within 35 ft sealed, not just covered with a mat.",
      "Fire watch looks below and behind walls — slag travels where nobody's watching.",
      "Re-test after every break: an opened line nearby changes the air.",
    ],
  },
  heights: {
    label: "Work at height", severity: 4, family: "heights",
    re: /\bscaffold|\bheights?\b|\belevated\b|\bman ?lift\b|\baerial lift\b|\bladders?\b|\broof\b|\btop of (the )?(tower|column|tank)/i,
    checks: [
      "Anchor above the shoulder — a low anchor doubles the fall.",
      "Suspended-worker rescue within minutes: who, with what, from where.",
      "Open grating and removed handrail around manways: barricaded at every level.",
      "Scaffold modified since it was tagged? Then it isn't tagged.",
    ],
  },
  pressure_test: {
    label: "Pressure test", severity: 4, family: "pressure_test",
    re: /hydro[\s-]*(static[\s-]*)?test|\bpressure test|\bleak test|\bpneumatic test|\btightness test|\bservice test|\b(ts|tubesheet|shell|tube[\s-]*side) hydro\b/i,
    checks: [
      "Air left in a hydro makes it act like a pneumatic test — vent the high points first.",
      "Pneumatic tests store far more energy: boundary by distance, not by tape.",
      "Nobody tightens a flange while it's under test pressure.",
      "Test gauge and relief sized for the test, not the operating pressure.",
    ],
  },
  electrical: {
    label: "Electrical", severity: 4, family: "electrical",
    re: /\benergi[sz]|\belectrical\b|\bmcc\b|\bswitchgear\b|\bbreakers?\b|\bterminat|\bmegger|\b(480|4160) ?v\b|\bmotor (pull|swap|change)/i,
    checks: [
      "Try-start after lockout, then return the switch to off.",
      "VFDs and capacitors hold charge after isolation — wait the time, then test.",
      "Arc-flash boundary at the cubicle being racked, not only the one being worked.",
      "Water work nearby (blasting, washdown) and open panels don't mix — cover or stop.",
    ],
  },
  catalyst: {
    label: "Catalyst handling", severity: 4, family: "entry",
    re: /\bcatalyst\b|\bcat (load|unload|dump)|\breactor (load|unload)/i,
    checks: [
      "Spent catalyst can be pyrophoric — keep it blanketed or wet until passivated.",
      "Entry into a bed is inert entry: supplied air and a standby rescue team.",
      "Know this catalyst's SDS before the first opening — some release toxic metals.",
      "Dust at the dump chute travels — the people below need respirators too.",
    ],
  },
  chemical: {
    label: "Chemical / sour", severity: 4, family: "chemical",
    re: /\bchemical clean|\bcaustic\b|\bacid\b|\bneutrali[sz]|\bdegas|\bdecon|\bsteam[\s-]*out\b|\bh2s\b|\bpyrophoric\b|\biron sulfide\b/i,
    checks: [
      "Disturbed sludge releases H2S even in a gas-free vessel — monitor where the scraping is.",
      "Iron sulfide scale: keep it wet; dry scale glows and ignites.",
      "Acid and caustic residues react — know what the last cleaning left behind.",
      "Steam-out condensate is hot and sour — where does it drain?",
    ],
  },
  heater: {
    label: "Fired heater", severity: 3, family: "heater",
    re: /\bfire[\s-]*eyes?\b|\bburners?\b|\bfirebox\b|\bfired heater\b|\bpilot light\b/i,
    checks: [
      "Fuel isolation proven at the burner, not the header — a passing valve fills a firebox overnight.",
      "Firebox purged before any light-off — no shortcut on the purge time.",
      "Burner management bypassed for the work? Logged, and back in before light-off.",
      "Refractory dust is silica — respirators inside the firebox.",
    ],
  },
  radiography: {
    label: "Radiography", severity: 3, family: "radiography",
    re: /\bx-?ray\b|\bradiograph|\brt shot\b|\bgamma\b/i,
    checks: [
      "Shots shut the area for other crews — agree the times at this meeting, not on the radio.",
      "Survey meter on every time the source moves.",
      "Barrier covers every level — a scaffold above the shot is inside it.",
      "Night shots: barricade lights on; tape alone disappears in the dark.",
    ],
  },
  excavation: {
    label: "Excavation", severity: 4, family: "excavation",
    re: /\bexcavat|\btrench|\bdig(ging)?\b|\bhydro[\s-]*vac/i,
    checks: [
      "Line markings can be off by feet — hydro-vac within the tolerance zone.",
      "Equipment, spoil and vibration collapse walls — keep them back from the edge.",
      "Trenches collect heavy vapors — gas test before entry, every time.",
      "Water in the trench changes the soil — re-inspect after rain or washdown.",
    ],
  },
  machining: {
    label: "Field machining", severity: 3, family: "machining",
    re: /\bmachin(e|ing)\b|\bflange fac(e|ing)\b|\bon[\s-]*site machin|\blapping\b|\bface (the )?flanges?\b/i,
    checks: [
      "Rotating cutter: no gloves near it, sleeves tight, stop button within reach.",
      "Machine bolted to the flange and checked before it spins — not hand-held.",
      "Chips are sharp and hot; cover open nozzles so they don't fall in.",
      "Isolations stay on — a flange being faced is still a break in the line.",
    ],
  },
};

/** One step on the next shift, as the ranking needs it. */
export interface HazardJobInput {
  id: string;
  name: string;
  /** The equipment / group it sits under ("E-17 - Transmix Feed …"). */
  parentName: string | null;
  /** The equipment's id — steps on the same equipment can meet. */
  parentId?: string | null;
  /** Further ancestors' names (area, phase), outermost first. */
  crumbs?: string[];
  who?: string | null;
  /** Work-hours of it on this shift. */
  hours: number;
  critical?: boolean;
  /** When on the shift, as shown on the report ("18:00–22:00"). */
  when: string;
  /** Its hours on the shift (ms), to see what overlaps and what follows. */
  start?: number;
  end?: number;
  /** How far along it is (0–100). */
  percent?: number;
  /** Carried over: was due before this shift and isn't done. */
  late?: boolean;
  /** Its latest comment. */
  note?: string | null;
}

export interface HazardJob {
  id: string;
  /** Short equipment tag ("E-17") or name. */
  equipment: string | null;
  /** The equipment's full name ("V-7 - Fractionator"), to match lessons on. */
  parentName?: string | null;
  name: string;
  who: string | null;
  when: string;
}

export interface RankedHazard {
  kind: HazardKind;
  label: string;
  severity: number;
  hours: number;
  jobs: HazardJob[];
  score: number;
  /** Why it made the list, in a few words each ("can kill", "2 crews on E-17 at once"). */
  why: string[];
  /** What's specific to this shift's steps — crews meeting on the same
   *  equipment, a hand-off, a note, a job picked up mid-way. Most telling first. */
  tonight: string[];
  /** Other crews working the same equipment at the same time. */
  alongside: string[];
}

const tagAtStart = (s: string): string | null => {
  const m = /^([A-Z0-9][A-Z0-9./-]{0,14})\s+[-–—]\s+/i.exec(s.trim());
  return m && /\d/.test(m[1]) ? m[1] : null;
};

/** "E-17 - Transmix Feed/Trans. Diesel Exchanger No. 1" → "E-17". Under a
 *  group with no tag ("PSVs"), the step's own tag ("PSV-021 - …") is the
 *  better name; failing both, the group's name. */
export function equipmentTag(parentName: string | null | undefined, stepName?: string): string | null {
  const p = (parentName ?? "").trim();
  return (p && tagAtStart(p)) || (stepName && tagAtStart(stepName)) || p || null;
}

/** The kinds of work a step is. The step's own name decides; its group
 *  names count only when the step names nothing ("E-12" under "Crane
 *  lifts"). A step can be more than one kind (a pull is a lift too). */
export function classifyStep(name: string, groups: Array<string | null | undefined> = []): HazardKind[] {
  const own = (Object.keys(HAZARD_KINDS) as HazardKind[]).filter((k) => HAZARD_KINDS[k].re.test(name));
  if (own.length) return dropShadowed(own);
  const ctx = groups.filter(Boolean).join(" · ");
  return ctx ? dropShadowed((Object.keys(HAZARD_KINDS) as HazardKind[]).filter((k) => HAZARD_KINDS[k].re.test(ctx))) : [];
}

// A bundle pull's lift is the pull itself; a hydroblast "test" isn't a
// pressure test; an entry's manway is the way in, not a line break.
function dropShadowed(kinds: HazardKind[]): HazardKind[] {
  const has = (k: HazardKind) => kinds.includes(k);
  return kinds.filter((k) =>
    !(k === "lifting" && has("bundle_pull")) &&
    !(k === "pressure_test" && has("hydroblast")) &&
    !(k === "line_break" && has("confined_space")));
}

export interface RankOptions {
  max?: number;
  /** The shift being planned — for the 02:00–05:00 low on nights. */
  shift?: { start: number; end: number; kind: "day" | "night" };
  /** Clock time for a moment ("22:00"), for the lines that name one. */
  T?: (ms: number) => string;
}

const SEVERITY_WORDS: Record<number, string> = { 5: "can kill", 4: "can maim", 3: "can injure" };

// Two jobs on the same equipment at the same time: what one does to the
// other. Ordered by the hazard; "*" is any other work.
type Meet = (x: { eq: string; other: string; otherStep: string; crew: string; time: string }) => string;
const MEET: Partial<Record<HazardKind, Partial<Record<HazardKind | "*", Meet>>>> = {
  hydroblast: {
    line_break: (x) => `Blasting and an open break on ${x.eq} at once: spray in a line that should be drained hides a passing valve, and the pump drowns out a hiss. Finish the break first, or keep it out of the spray.`,
    confined_space: (x) => `Someone inside ${x.eq} while it's blasted: the hole watch can't hear over the pump and the mist fouls the gas monitor. Nobody inside while the pump runs.`,
    electrical: (x) => `Blasting near open electrical on ${x.eq}: water and open panels — cover them or stop the electrical work while the pump runs.`,
    "*": (x) => `${x.other} on ${x.eq} (${x.otherStep}) while ${x.crew} blasts it: the blast zone is the whole exchanger end and the far tubesheet. ${x.other} stays clear until the pump is down and locked — not just the gun released.`,
  },
  lifting: { "*": (x) => `${x.other} working ${x.eq} while the load moves: the swing and drop zone is theirs too. Stop their work for the lift — tape around it isn't enough.` },
  bundle_pull: {
    hydroblast: (x) => `${x.eq} bundle pull and blasting together: the pull path and the blast pad overlap. One job at a time in that space.`,
    "*": (x) => `${x.other} on ${x.eq} (${x.otherStep}) during the pull: the extractor and the bundle path are a load zone. Stop their work while it moves.`,
  },
  line_break: {
    hot_work: (x) => `Hot work and an open line on ${x.eq} together: vapor from the opening drifts to the spark. Gas monitor at the break and at the arc, the whole time.`,
    confined_space: (x) => `A line broken into ${x.eq} while people are inside: whatever the line held now has a path in. No breaks on lines into the vessel while it's occupied.`,
    "*": (x) => `${x.other} working ${x.eq} while ${x.crew} breaks into it: they're in the release path if the line isn't empty. Clear them for the first crack.`,
  },
  hot_work: { line_break: (x) => `Hot work and an open line on ${x.eq} together: vapor from the opening drifts to the spark. Gas monitor at the break and at the arc, the whole time.` },
  confined_space: { "*": (x) => `${x.other} working outside ${x.eq} while people are inside: their engines, air movers, purges and welding fumes end up in the vessel. Agree what runs near the manway.` },
  inert: { "*": (x) => `${x.other} near ${x.eq} while it's on nitrogen: the purge vents through the openings onto the platform they're on. O2 monitors on them too.` },
  pressure_test: { "*": (x) => `${x.other} on ${x.eq} during the pressure test: everyone not testing is outside the boundary while it's pressured.` },
  radiography: { "*": (x) => `Radiography on ${x.eq} stops ${x.other}'s work during shots — agree the shot times at this meeting.` },
  startup: { line_break: (x) => `Start-up on ${x.eq} while a break is still open: reconcile the blind and open-flange list before anything moves.` },
};
// One job hands the equipment to the next on the shift.
const HANDOFF: Partial<Record<HazardKind, Partial<Record<HazardKind | "*", Meet>>>> = {
  hydroblast: { "*": (x) => `${x.eq} goes from blasting to ${x.otherStep} at ${x.time}: pump down and locked, hoses bled and pulled back before ${x.other} steps in — the gun being off isn't enough.` },
  bundle_pull: { hydroblast: (x) => `${x.eq} bundle goes from the extractor to blasting at ${x.time}: deposits drying in air can heat (iron sulfide) — keep it wet until the blast starts.` },
  line_break: { confined_space: (x) => `${x.eq} is blinded, then entered at ${x.time}: entry starts after the blind list is walked with the operator — not because the blinding step shows done.` },
};
const fallbackMeet: Meet = (x) => `${x.crew} and ${x.other} on ${x.eq} at the same time: one permit owner for the area, and each crew knows what the other's job can do to them.`;
const fallbackHandoff: Meet = (x) => `${x.eq} changes hands at ${x.time} (${x.crew} → ${x.other}): walk it down together — the next crew inherits whatever's left open, rigged or pressured.`;

// A note that changes the job.
const NOTE_FLAGS: Array<{ re: RegExp; why: string; line: (eq: string, step: string, note: string) => string }> = [
  { re: /seiz|stuck|froze|won'?t (turn|move|budge|come)|galled/i, why: "stuck parts", line: (eq, step, n) => `“${n}” on ${eq} ${step}: stuck parts are where people reach for a torch, sledge, cheater bar or more pull — a cold job turns into hot work or a stored-energy release. Re-plan; don't force it.` },
  { re: /leak|passing|weep|drip/i, why: "a leak noted", line: (eq, step, n) => `“${n}” on ${eq}: a passing or leaking isolation means the line isn't empty. Re-isolate before anyone breaks into it.` },
  { re: /plug|fouled|blocked|choked/i, why: "plugging noted", line: (eq, step, n) => `“${n}” on ${eq}: a plug can hold pressure behind it and make a gauge read zero. Prove it's clear before opening further.` },
  { re: /smell|odou?r|h2s|fumes?/i, why: "an odor noted", line: (eq, step, n) => `“${n}” on ${eq}: treat it as a live atmosphere — gas test before work restarts.` },
];
// A job picked up part-way: what's half-done.
const MIDJOB: Partial<Record<HazardKind, (eq: string, step: string, p: number) => string>> = {
  bundle_pull: (eq, _s, p) => `${eq} bundle is ${p}% out: a bundle part-way out of its shell is a cantilevered load. Confirm how it's supported and re-check the extractor rigging before anyone pulls again.`,
  line_break: (eq, step, p) => `${eq} ${step} is ${p}% done — some bolts out, some in. Walk which openings are open before restarting; that state isn't on the permit.`,
  confined_space: (eq) => `${eq} entry picks up mid-job: new gas test and new attendant sign-in — the last crew's test doesn't carry over.`,
  hydroblast: (eq, _s, p) => `${eq} blasting picks up at ${p}%: tonight's operator re-tests the dump before the first shot.`,
  lifting: (eq) => `${eq} lift picks up mid-way: re-check the rigging and the ground under the outriggers before taking load again.`,
};

/** The next shift's riskiest kinds of work, most dangerous first, never
 *  two of one family — each with why it's here and what's specific to
 *  this shift's steps. */
export function rankHazards(jobs: HazardJobInput[], opts: RankOptions = {}): RankedHazard[] {
  const max = opts.max ?? 3;
  const T = opts.T ?? ((ms: number) => new Date(ms).toISOString().slice(11, 16));
  const kindsOf = new Map<string, HazardKind[]>();
  // The step's own name, else its work order's — never a phase or area
  // name ("Startup" as a phase doesn't make calibrating a meter a start-up).
  for (const j of jobs) kindsOf.set(j.id, classifyStep(j.name, [j.parentName]));
  const eqOf = (j: HazardJobInput) => equipmentTag(j.parentName, j.name) ?? j.name;
  // The step's name without its own tag repeated ("PSV-021 - E-13 …" under PSV-021).
  const stepOf = (j: HazardJobInput) => {
    const tag = eqOf(j);
    const own = j.name.startsWith(tag) ? j.name.slice(tag.length).replace(/^\s*[-–—:]\s*/, "") || j.name : j.name;
    // The scope note in brackets is for the planner, not the meeting.
    const n = own.replace(/\s*\(.*$/, "").trim() || own;
    return n.length > 60 ? `${n.slice(0, 57).trimEnd()}…` : n;
  };
  const crewOf = (j: HazardJobInput) => j.who?.trim() || "another crew";
  const sameEq = (a: HazardJobInput, b: HazardJobInput) => !!a.parentId && a.parentId === b.parentId && a.id !== b.id;
  const overlaps = (a: HazardJobInput, b: HazardJobInput) =>
    a.start == null || b.start == null || a.end == null || b.end == null ? false : a.start < b.end && b.start < a.end;
  const lowStart = opts.shift?.kind === "night" ? opts.shift.start + 8 * 3600_000 : null;
  const inLow = (j: HazardJobInput) => lowStart != null && j.start != null && j.end != null && j.start < lowStart + 3 * 3600_000 && j.end > lowStart;

  const byKind = new Map<HazardKind, { hours: number; jobs: HazardJob[]; inputs: HazardJobInput[]; critical: boolean }>();
  for (const j of jobs) {
    for (const k of kindsOf.get(j.id) ?? []) {
      const e = byKind.get(k) ?? { hours: 0, jobs: [], inputs: [], critical: false };
      e.hours += Math.max(0, j.hours || 0);
      e.critical ||= !!j.critical;
      if (!e.jobs.some((x) => x.id === j.id)) {
        e.jobs.push({ id: j.id, equipment: equipmentTag(j.parentName, j.name), parentName: j.parentName, name: j.name, who: j.who ?? null, when: j.when });
        e.inputs.push(j);
      }
      byKind.set(k, e);
    }
  }

  const ranked: RankedHazard[] = [];
  const pairsOf = new Map<RankedHazard, Array<string | undefined>>();
  const whyPairsOf = new Map<RankedHazard, Map<string, string[]>>();
  for (const [k, e] of byKind) {
    const def = HAZARD_KINDS[k];
    const why: string[] = [SEVERITY_WORDS[def.severity] ?? "injury risk"];
    // Each line keeps the pair of steps it's about, so a clash shows once.
    const lines: Array<{ text: string; weight: number; pair?: string }> = [];
    const whyRank: Array<{ text: string; rank: number }> = [];
    let bonus = 0;
    // Other crews on the same equipment: at the same time, or straight after.
    const met = new Set<string>();
    const handed = new Set<string>();
    const alongside = new Set<string>();
    // Which reasons come from a clash between two steps (told once).
    const whyPairs = new Map<string, string[]>();
    for (const j of e.inputs) {
      for (const o of jobs) {
        if (!sameEq(j, o) || met.has(`${j.id}|${o.id}`)) continue;
        const oKind = (kindsOf.get(o.id) ?? [])[0];
        const x = { eq: eqOf(j), other: crewOf(o), otherStep: stepOf(o), crew: crewOf(j), time: o.start != null ? T(o.start) : o.when };
        const differentCrew = (o.who ?? "") !== (j.who ?? "");
        // The same crew on two jobs only counts when the pairing itself is
        // the danger (start-up with a break still open).
        const specific = oKind ? MEET[k]?.[oKind] : undefined;
        if (overlaps(j, o) && (differentCrew || (specific && oKind !== k))) {
          const f = specific ?? MEET[k]?.["*"] ?? fallbackMeet;
          const pair = [j.id, o.id].sort().join("|");
          lines.push({ text: f(x), weight: 5, pair });
          if (differentCrew && o.who?.trim()) alongside.add(o.who.trim());
          const w = differentCrew ? `2 crews on ${x.eq} at once` : `2 jobs on ${x.eq} at once`;
          whyRank.push({ text: w, rank: 1 });
          whyPairs.set(w, [...(whyPairs.get(w) ?? []), pair]);
          bonus += 6; met.add(`${j.id}|${o.id}`); met.add(`${o.id}|${j.id}`);
        } else if (differentCrew && j.end != null && o.start != null && o.start >= j.end - 60_000 && o.start - j.end <= 3600_000) {
          // A crew handing the equipment to another crew (not to itself).
          const f = (oKind && HANDOFF[k]?.[oKind]) ?? HANDOFF[k]?.["*"] ?? fallbackHandoff;
          lines.push({ text: f(x), weight: 3, pair: [j.id, o.id].sort().join("|") });
          const w = `${x.eq} changes hands at ${x.time}`;
          if (!handed.has(x.eq)) { whyRank.push({ text: w, rank: 3 }); whyPairs.set(w, [[j.id, o.id].sort().join("|")]); }
          handed.add(x.eq);
          bonus += 3; met.add(`${j.id}|${o.id}`);
        }
      }
      // Its note.
      const n = j.note?.trim();
      const flag = n ? NOTE_FLAGS.find((f) => f.re.test(n)) : undefined;
      if (flag && n) { lines.push({ text: flag.line(eqOf(j), stepOf(j), n), weight: 4 }); whyRank.push({ text: flag.why, rank: 2 }); bonus += 2; }
      // Picked up part-way.
      if (j.percent != null && j.percent > 0 && j.percent < 100) {
        const m = MIDJOB[k];
        lines.push({ text: m ? m(eqOf(j), stepOf(j), j.percent) : `${eqOf(j)} ${stepOf(j)} picks up at ${j.percent}%: walk it with the crew that left it — what's open, rigged or half-done.`, weight: 3 });
        whyRank.push({ text: `picked up at ${j.percent}%`, rank: 2 });
        bonus += 2;
      }
      if (j.late) {
        lines.push({ text: `${eqOf(j)} ${stepOf(j)} is carried over and late: late jobs are where steps get skipped. If it's waiting on a permit or a gas test, it waits.`, weight: 2 });
        whyRank.push({ text: "carried over, late", rank: 3 });
        bonus += 2;
      }
      if (inLow(j)) {
        const low = `${T(lowStart!)}–${T(lowStart! + 3 * 3600_000)}`;
        lines.push({ text: `${eqOf(j)} ${stepOf(j)} runs ${j.when}, into the ${low} low of a night shift: do the critical move — the first crack, the lift, the first entry — before it or right after a break.`, weight: 1 });
        whyRank.push({ text: `runs into the ${low} low`, rank: 3 });
        bonus += 1;
      }
    }
    const crews = new Set(e.inputs.map((j) => j.who?.trim()).filter(Boolean));
    if (e.critical) whyRank.push({ text: "critical path", rank: 2 });
    if (crews.size > 1) whyRank.push({ text: `${crews.size} crews`, rank: 4 });
    if (e.hours >= 4) whyRank.push({ text: `${Math.round(e.hours)} h of it`, rank: 4 });
    // "2 crews on E-12" says it; "2 jobs on E-12" adds nothing beside it.
    for (const w of [...whyRank]) if (w.text.startsWith("2 jobs on ") && whyRank.some((v) => v.text === w.text.replace("2 jobs", "2 crews"))) whyRank.splice(whyRank.indexOf(w), 1);
    // The strongest reasons, a few words each — four at most.
    for (const w of [...new Map(whyRank.sort((a, b) => a.rank - b.rank).map((w) => [w.text, w])).values()]) if (why.length < 4) why.push(w.text);
    // Severity decides; how much of it there is, and what's going on around it, break ties.
    const exposure = Math.min(6, e.hours / 2) + Math.min(3, e.jobs.length) + (e.critical ? 1 : 0);
    const kept = [...new Map(lines.sort((a, b) => b.weight - a.weight).map((l) => [l.text, l])).values()];
    ranked.push({
      kind: k, label: def.label, severity: def.severity, hours: Math.round(e.hours * 10) / 10, jobs: e.jobs,
      score: def.severity * 10 + exposure + Math.min(bonus, 12), why, tonight: kept.map((l) => l.text), alongside: [...alongside],
    });
    pairsOf.set(ranked[ranked.length - 1], kept.map((l) => l.pair));
    whyPairsOf.set(ranked[ranked.length - 1], whyPairs);
  }
  ranked.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  const families = new Set<string>();
  const out: RankedHazard[] = [];
  // A clash between two steps is told once — under the higher-ranked topic.
  const told = new Set<string>();
  for (const h of ranked) {
    const fam = HAZARD_KINDS[h.kind].family;
    if (families.has(fam)) continue;
    families.add(fam);
    const pairs = pairsOf.get(h) ?? [];
    const tonight = h.tonight.filter((_, i) => !pairs[i] || !told.has(pairs[i]!));
    // A reason whose clash was told under a topic above goes with it.
    const wp = whyPairsOf.get(h) ?? new Map<string, string[]>();
    const why = h.why.filter((w) => !(wp.get(w)?.every((p) => told.has(p))));
    for (const p of pairs) if (p) told.add(p);
    out.push({ ...h, why, tonight });
    if (out.length >= max) break;
  }
  return out;
}

/** This shift's two veteran checks for a kind of work — a different pair
 *  each shift, round the list; a check about a particular thing (plugs,
 *  tubes) only when one of the steps is about it. */
export function checksFor(kind: HazardKind, shiftStart: number, n = 2, stepNames?: string[]): string[] {
  const fits = (c: string | { t: string; if: RegExp }) => typeof c === "string" || !stepNames || stepNames.some((x) => c.if.test(x));
  const list = HAZARD_KINDS[kind].checks.filter(fits).map((c) => (typeof c === "string" ? c : c.t));
  if (!list.length) return [];
  const start = (shiftOrdinal(shiftStart) * n) % list.length;
  return Array.from({ length: Math.min(n, list.length) }, (_, i) => list[(start + i) % list.length]);
}

/** One line under a hazard's title: where and when, and who. */
export function hazardContext(h: RankedHazard): string {
  const parts = h.jobs.slice(0, 3).map((j) => [j.equipment, j.when].filter(Boolean).join(" "));
  const more = h.jobs.length > 3 ? ` +${h.jobs.length - 3} more` : "";
  const who = [...new Set(h.jobs.map((j) => j.who).filter(Boolean))];
  return [parts.join(", ") + more, who.length === 1 ? who[0] : null].filter(Boolean).join(" · ");
}

// ─── The lessons ─────────────────────────────────────────────────────

/** One "don't miss" lesson: what to look out for, what prevents it, and
 *  the incident page it was drawn from. */
export interface SafetyLesson {
  kind: HazardKind;
  watch: string;
  prevent: string;
  /** The lesson as one line someone can say out loud at the meeting. */
  say: string;
  /** Only for steps on this kind of equipment (a PSV, trays, a man-lift). */
  if?: RegExp;
  source: { url: string; title: string };
}

/** A shift's number, counting 12-hour shifts — the same on every screen. */
const shiftOrdinal = (shiftStart: number) => Math.floor(shiftStart / 43_200_000);

/** This shift's lesson for a kind of work: a different one each shift,
 *  round the kind's list, so a job running all week doesn't repeat. Kinds
 *  start at different points so two jobs don't move in step. */
export function lessonFor(kind: HazardKind, shiftStart: number, lessons: SafetyLesson[] = SAFETY_LESSONS): SafetyLesson | null {
  const list = lessons.filter((l) => l.kind === kind);
  if (!list.length) return null;
  const offset = [...kind].reduce((a, ch) => a + ch.charCodeAt(0), 0);
  return list[(shiftOrdinal(shiftStart) + offset) % list.length];
}

/** A source's short name for the link: the site ("csb.gov"). */
export function sourceLabel(s: { url: string; title?: string | null }): string {
  try { return new URL(s.url).hostname.replace(/^www\./i, ""); } catch { return s.title ?? "source"; }
}
