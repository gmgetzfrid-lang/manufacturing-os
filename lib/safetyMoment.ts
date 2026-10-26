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
  | "chemical" | "heater" | "radiography" | "excavation";

interface KindDef {
  label: string;
  /** How badly it can go: 5 = kills people. Ranks first. */
  severity: number;
  /** Kinds in one family are "the same thing" — one per moment. */
  family: string;
  /** Matched against the step's name and its equipment / group names. */
  re: RegExp;
  /** The essentials every crew on this work must have covered — the
   *  supervisor's hit list, before anything specific. */
  hitList: string[];
}

export const HAZARD_KINDS: Record<HazardKind, KindDef> = {
  confined_space: {
    label: "Vessel entry", severity: 5, family: "entry",
    re: /\bconfined\b|\bvessel entry\b|\bentry\b|\benter\b|internal (manway|inspection)s?|\binternals\b|\btrays?\b|\bdowncomers?\b|\bdemister\b|\bpacking\b|\bhole ?watch\b/i,
    hitList: ["Entry permit signed and posted at the manway", "Blinds and isolations verified before entry", "Gas test before entry; monitor worn inside", "Attendant at the manway the whole time", "Rescue plan and gear staged at the manway"],
  },
  inert: {
    label: "Nitrogen / inert", severity: 5, family: "entry",
    re: /\bnitrogen\b|\bn2\b|\binert(ed|ing)?\b|\bpurg(e|ed|ing)\b/i,
    hitList: ["Treat purged equipment as no-breathe air", "Open manways on purged equipment barricaded and tagged", "Supplied air only for inert entry", "Never lean or reach into an opening", "Rescue on supplied air only — nobody rushes in"],
  },
  hydroblast: {
    label: "Hydroblasting", severity: 5, family: "hydroblast",
    re: /hydro[\s-]*blast|water[\s-]*blast|hydro[\s-]*jet|water[\s-]*jet|high[\s-]pressure water|\blancing\b|\bhpwj\b/i,
    hitList: ["Dump control tested before every start", "Hoses, fittings and nozzles rated for the pressure", "Whip checks on every hose connection", "Area barricaded, spray path clear of people", "Medical alert card on every blaster"],
  },
  line_break: {
    label: "Line break", severity: 5, family: "line_break",
    re: /\bblinds?\b|line[\s-]*break|break(ing)? containment|\bunbolt|\bflanges?\b|\bspools?\b|\bpsv\b|\bprv\b|relief valve|remove (the )?(meter|valve|spool|components?|heads?|channel|cover)|\bopen (the )?(line|manways?)\b|\bmanways?\b|\bswap\b.*\bvalve\b|\bdrain(ing)? and vent/i,
    hitList: ["Isolations walked down against the permit", "Drained, depressured and checked at the bleeder", "Know what was in the line and its PPE", "Loosen far-side bolts first, body out of line", "Gas monitor at the break; spill kit ready"],
  },
  lifting: {
    label: "Crane lift", severity: 5, family: "lifting",
    re: /\bcrane\b|\blifts?\b|\bpicks?\b|\brigging\b|\brig\b|\bhoist|\bfly[\s-]*out\b|\btransport (the )?(exchanger|bundle|vessel)|\bset (the )?(exchanger|vessel|drum)\b|\bheavy haul\b/i,
    hitList: ["Lift plan and load weight confirmed", "Ground and outrigger pads checked", "Rigging inspected; tag lines on the load", "Swing radius barricaded — nobody under the load", "One signal person; radios checked"],
  },
  bundle_pull: {
    label: "Bundle pull", severity: 4, family: "lifting",
    re: /\b(pull|extract|install|insert|re-?install|set)( the)? (tube )?bundles?\b|\bbundle (pull|extract|puller)|\bre-?bundle\b/i,
    hitList: ["Bundle weight confirmed — fouling adds weight", "Extractor inspected and rated for the bundle", "Pull path barricaded", "Keep deposits wet once the shell is open", "Tag lines on the bundle"],
  },
  startup: {
    label: "Start-up", severity: 5, family: "startup",
    re: /\bstart[\s-]*up\b|\bcommission|\breturn to service\b|\bintroduc(e|ing) (feed|hydrocarbon)|\bpressure up\b|\blight (off|the) (heater|burners?)\b|\bbring (it )?(on ?line|online)\b/i,
    hitList: ["Every blind pulled and checked off the list", "Manways and flanges closed and torqued", "Walk the lines before feed goes in", "Leak check at each pressure step", "Non-essential people out of the unit"],
  },
  hot_work: {
    label: "Hot work", severity: 4, family: "hot_work",
    re: /\bweld|\bhot work\b|\btorch\b|\bcutting\b|\bgrind|\bpwht\b|\bstress reliev|\bpreheat\b|\bburning\b/i,
    hitList: ["Hot work permit with gas test", "Drains and sewers covered nearby", "Combustibles moved or covered", "Fire watch during and 30 min after", "Re-test gas after every break"],
  },
  heights: {
    label: "Work at height", severity: 4, family: "heights",
    re: /\bscaffold|\bheights?\b|\belevated\b|\bman ?lift\b|\baerial lift\b|\bladders?\b|\broof\b|\btop of (the )?(tower|column|tank)/i,
    hitList: ["Scaffold tag green and current", "100% tie-off above 6 ft", "Tools tethered; area below barricaded", "Ladders tied off, 3 ft above the landing", "Rescue plan for a suspended worker"],
  },
  pressure_test: {
    label: "Pressure test", severity: 4, family: "pressure_test",
    re: /hydro[\s-]*(static[\s-]*)?test|\bpressure test|\bleak test|\bpneumatic test|\btightness test|\bservice test/i,
    hitList: ["Test pressure and procedure confirmed", "Gauge range and relief set for the test", "Test boundary barricaded", "Vent high points before pressuring", "No tightening while under pressure"],
  },
  electrical: {
    label: "Electrical", severity: 4, family: "electrical",
    re: /\benergi[sz]|\belectrical\b|\bmcc\b|\bswitchgear\b|\bbreakers?\b|\bterminat|\bmegger|\b(480|4160) ?v\b|\bmotor (pull|swap|change)/i,
    hitList: ["Locked out, tagged, and start tried", "Test before touch, every conductor", "Arc-flash boundary and PPE for the gear", "Qualified electricians only", "Open panels barricaded"],
  },
  catalyst: {
    label: "Catalyst handling", severity: 4, family: "entry",
    re: /\bcatalyst\b|\bcat (load|unload|dump)|\breactor (load|unload)/i,
    hitList: ["SDS hazards briefed — pyrophoric, toxic dust", "Nitrogen blanket means supplied air entry", "Dust control and respirators", "Atmosphere monitored at the work point", "Rescue plan on supplied air"],
  },
  chemical: {
    label: "Chemical / sour", severity: 4, family: "chemical",
    re: /\bchemical clean|\bcaustic\b|\bacid\b|\bneutrali[sz]|\bdegas|\bdecon|\bsteam[\s-]*out\b|\bh2s\b|\bpyrophoric\b|\biron sulfide\b/i,
    hitList: ["Know the chemical and its SDS", "H2S monitor on everyone", "Keep iron sulfide deposits wet", "Eyewash and shower checked nearby", "Work upwind; escape route known"],
  },
  heater: {
    label: "Fired heater", severity: 3, family: "heater",
    re: /\bfire[\s-]*eyes?\b|\bburners?\b|\bfirebox\b|\bfired heater\b|\bpilot light\b/i,
    hitList: ["Fuel gas isolated and locked out", "Any bypass authorized and logged", "Firebox purged before any light-off", "Gas test at the burner front", "Hot surfaces and refractory dust"],
  },
  radiography: {
    label: "Radiography", severity: 3, family: "radiography",
    re: /\bx-?ray\b|\bradiograph|\brt shot\b|\bgamma\b/i,
    hitList: ["Shot times announced; area cleared", "Boundary roped and signed", "Survey meter in use", "Nobody crosses the rope"],
  },
  excavation: {
    label: "Excavation", severity: 4, family: "excavation",
    re: /\bexcavat|\btrench|\bdig(ging)?\b|\bhydro[\s-]*vac/i,
    hitList: ["Buried lines located and marked", "Hydro-vac near lines — no blades", "Shored or sloped deeper than 5 ft", "Spoil 2 ft back from the edge", "Gas test in the trench"],
  },
};

/** One step on the next shift, as the ranking needs it. */
export interface HazardJobInput {
  id: string;
  name: string;
  /** The equipment / group it sits under ("E-17 - Transmix Feed …"). */
  parentName: string | null;
  /** Further ancestors' names (area, phase), outermost first. */
  crumbs?: string[];
  who?: string | null;
  /** Work-hours of it on this shift. */
  hours: number;
  critical?: boolean;
  /** When on the shift, as shown on the report ("18:00–22:00"). */
  when: string;
}

export interface HazardJob {
  id: string;
  /** Short equipment tag ("E-17") or name. */
  equipment: string | null;
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

/** The next shift's riskiest kinds of work, most dangerous first, never
 *  two of one family. */
export function rankHazards(jobs: HazardJobInput[], opts: { max?: number } = {}): RankedHazard[] {
  const max = opts.max ?? 3;
  const byKind = new Map<HazardKind, { hours: number; jobs: HazardJob[]; critical: boolean }>();
  for (const j of jobs) {
    const groups = [j.parentName, ...(j.crumbs ?? []).slice(-1)];
    for (const k of classifyStep(j.name, groups)) {
      const e = byKind.get(k) ?? { hours: 0, jobs: [], critical: false };
      e.hours += Math.max(0, j.hours || 0);
      e.critical ||= !!j.critical;
      if (!e.jobs.some((x) => x.id === j.id)) {
        e.jobs.push({ id: j.id, equipment: equipmentTag(j.parentName, j.name), name: j.name, who: j.who ?? null, when: j.when });
      }
      byKind.set(k, e);
    }
  }
  const ranked: RankedHazard[] = [];
  for (const [k, e] of byKind) {
    const def = HAZARD_KINDS[k];
    // Severity decides; how much of it there is breaks ties.
    const exposure = Math.min(6, e.hours / 2) + Math.min(3, e.jobs.length) + (e.critical ? 1 : 0);
    ranked.push({ kind: k, label: def.label, severity: def.severity, hours: Math.round(e.hours * 10) / 10, jobs: e.jobs, score: def.severity * 10 + exposure });
  }
  ranked.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  const families = new Set<string>();
  const out: RankedHazard[] = [];
  for (const h of ranked) {
    const fam = HAZARD_KINDS[h.kind].family;
    if (families.has(fam)) continue;
    families.add(fam);
    out.push(h);
    if (out.length >= max) break;
  }
  return out;
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
