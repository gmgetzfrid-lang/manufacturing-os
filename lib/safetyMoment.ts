// lib/safetyMoment.ts — the turnover's safety moment.
//
// Instead of "safety moment — anyone?", the next shift's three riskiest
// kinds of work, each with a hit list — the essentials the crew must have
// covered (permit, gas test, attendant …) — and one or two "don't miss"
// lessons drawn from real incidents found on the web that turn: not their
// stories, their lessons — what to look out for, and what prevents it.
//
//   1. rankHazards — read the next shift's steps, sort them into kinds of
//      work (hydroblasting, vessel entry, line breaks, lifts …) by their
//      names, and rank the kinds by how badly they can hurt someone, then
//      by how much of it is on the shift. Never two of the same family.
//      A note from the supervisor ("one crane pick at 08:00") counts too.
//   2. The model searches for incidents and writes the lessons
//      (safetyMomentPrompt), and every lesson must cite a page the search
//      actually returned (parseSafetyMoment drops any that don't) — a
//      lesson nobody can trace is worse than none.
//
// Pure: no database, no network. The route and the report use it.

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
  /** What the search should look for. */
  search: string;
  /** The essentials every crew on this work must have covered — the
   *  supervisor's hit list, before anything specific. */
  hitList: string[];
}

export const HAZARD_KINDS: Record<HazardKind, KindDef> = {
  confined_space: {
    label: "Vessel entry", severity: 5, family: "entry",
    re: /\bconfined\b|\bvessel entry\b|\bentry\b|\benter\b|internal (manway|inspection)s?|\binternals\b|\btrays?\b|\bdowncomers?\b|\bdemister\b|\bpacking\b|\bhole ?watch\b/i,
    search: "confined space entry incidents inside towers, drums and vessels",
    hitList: ["Entry permit signed and posted at the manway", "Blinds and isolations verified before entry", "Gas test before entry; monitor worn inside", "Attendant at the manway the whole time", "Rescue plan and gear staged at the manway"],
  },
  inert: {
    label: "Nitrogen / inert", severity: 5, family: "entry",
    re: /\bnitrogen\b|\bn2\b|\binert(ed|ing)?\b|\bpurg(e|ed|ing)\b/i,
    search: "nitrogen asphyxiation and inert atmosphere incidents at manways and vessels",
    hitList: ["Treat purged equipment as no-breathe air", "Open manways on purged equipment barricaded and tagged", "Supplied air only for inert entry", "Never lean or reach into an opening", "Rescue on supplied air only — nobody rushes in"],
  },
  hydroblast: {
    label: "Hydroblasting", severity: 5, family: "hydroblast",
    re: /hydro[\s-]*blast|water[\s-]*blast|hydro[\s-]*jet|water[\s-]*jet|high[\s-]pressure water|\blancing\b|\bhpwj\b/i,
    search: "high-pressure water jetting / hydroblasting injuries and fatalities",
    hitList: ["Dump control tested before every start", "Hoses, fittings and nozzles rated for the pressure", "Whip checks on every hose connection", "Area barricaded, spray path clear of people", "Medical alert card on every blaster"],
  },
  line_break: {
    label: "Line break", severity: 5, family: "line_break",
    re: /\bblinds?\b|line[\s-]*break|break(ing)? containment|\bunbolt|\bflanges?\b|\bspools?\b|\bpsv\b|\bprv\b|relief valve|remove (the )?(meter|valve|spool|components?|heads?|channel|cover)|\bopen (the )?(line|manways?)\b|\bmanways?\b|\bswap\b.*\bvalve\b|\bdrain(ing)? and vent/i,
    search: "line opening / breaking containment incidents, trapped pressure and hydrocarbon releases during maintenance",
    hitList: ["Isolations walked down against the permit", "Drained, depressured and checked at the bleeder", "Know what was in the line and its PPE", "Loosen far-side bolts first, body out of line", "Gas monitor at the break; spill kit ready"],
  },
  lifting: {
    label: "Crane lift", severity: 5, family: "lifting",
    re: /\bcrane\b|\blifts?\b|\bpicks?\b|\brigging\b|\brig\b|\bhoist|\bfly[\s-]*out\b|\btransport (the )?(exchanger|bundle|vessel)|\bset (the )?(exchanger|vessel|drum)\b|\bheavy haul\b/i,
    search: "crane and rigging incidents during refinery turnarounds",
    hitList: ["Lift plan and load weight confirmed", "Ground and outrigger pads checked", "Rigging inspected; tag lines on the load", "Swing radius barricaded — nobody under the load", "One signal person; radios checked"],
  },
  bundle_pull: {
    label: "Bundle pull", severity: 4, family: "lifting",
    re: /\b(pull|extract|install|insert|re-?install|set)( the)? (tube )?bundles?\b|\bbundle (pull|extract|puller)|\bre-?bundle\b/i,
    search: "heat exchanger tube bundle extraction incidents (bundle extractor, rigging, iron sulfide on opening)",
    hitList: ["Bundle weight confirmed — fouling adds weight", "Extractor inspected and rated for the bundle", "Pull path barricaded", "Keep deposits wet once the shell is open", "Tag lines on the bundle"],
  },
  startup: {
    label: "Start-up", severity: 5, family: "startup",
    re: /\bstart[\s-]*up\b|\bcommission|\breturn to service\b|\bintroduc(e|ing) (feed|hydrocarbon)|\bpressure up\b|\blight (off|the) (heater|burners?)\b|\bbring (it )?(on ?line|online)\b/i,
    search: "refinery unit start-up incidents after turnaround",
    hitList: ["Every blind pulled and checked off the list", "Manways and flanges closed and torqued", "Walk the lines before feed goes in", "Leak check at each pressure step", "Non-essential people out of the unit"],
  },
  hot_work: {
    label: "Hot work", severity: 4, family: "hot_work",
    re: /\bweld|\bhot work\b|\btorch\b|\bcutting\b|\bgrind|\bpwht\b|\bstress reliev|\bpreheat\b|\bburning\b/i,
    search: "hot work fires and explosions at refineries and tank farms",
    hitList: ["Hot work permit with gas test", "Drains and sewers covered nearby", "Combustibles moved or covered", "Fire watch during and 30 min after", "Re-test gas after every break"],
  },
  heights: {
    label: "Work at height", severity: 4, family: "heights",
    re: /\bscaffold|\bheights?\b|\belevated\b|\bman ?lift\b|\baerial lift\b|\bladders?\b|\broof\b|\btop of (the )?(tower|column|tank)/i,
    search: "falls from height and scaffold incidents in refineries",
    hitList: ["Scaffold tag green and current", "100% tie-off above 6 ft", "Tools tethered; area below barricaded", "Ladders tied off, 3 ft above the landing", "Rescue plan for a suspended worker"],
  },
  pressure_test: {
    label: "Pressure test", severity: 4, family: "pressure_test",
    re: /hydro[\s-]*(static[\s-]*)?test|\bpressure test|\bleak test|\bpneumatic test|\btightness test|\bservice test/i,
    search: "hydrotest and pneumatic pressure test failures injuring workers",
    hitList: ["Test pressure and procedure confirmed", "Gauge range and relief set for the test", "Test boundary barricaded", "Vent high points before pressuring", "No tightening while under pressure"],
  },
  electrical: {
    label: "Electrical", severity: 4, family: "electrical",
    re: /\benergi[sz]|\belectrical\b|\bmcc\b|\bswitchgear\b|\bbreakers?\b|\bterminat|\bmegger|\b(480|4160) ?v\b|\bmotor (pull|swap|change)/i,
    search: "arc flash and electrical incidents during plant maintenance",
    hitList: ["Locked out, tagged, and start tried", "Test before touch, every conductor", "Arc-flash boundary and PPE for the gear", "Qualified electricians only", "Open panels barricaded"],
  },
  catalyst: {
    label: "Catalyst handling", severity: 4, family: "entry",
    re: /\bcatalyst\b|\bcat (load|unload|dump)|\breactor (load|unload)/i,
    search: "catalyst change-out incidents",
    hitList: ["SDS hazards briefed — pyrophoric, toxic dust", "Nitrogen blanket means supplied air entry", "Dust control and respirators", "Atmosphere monitored at the work point", "Rescue plan on supplied air"],
  },
  chemical: {
    label: "Chemical / sour", severity: 4, family: "chemical",
    re: /\bchemical clean|\bcaustic\b|\bacid\b|\bneutrali[sz]|\bdegas|\bdecon|\bsteam[\s-]*out\b|\bh2s\b|\bpyrophoric\b|\biron sulfide\b/i,
    search: "H2S, pyrophoric iron sulfide and chemical exposure incidents during turnaround cleaning",
    hitList: ["Know the chemical and its SDS", "H2S monitor on everyone", "Keep iron sulfide deposits wet", "Eyewash and shower checked nearby", "Work upwind; escape route known"],
  },
  heater: {
    label: "Fired heater", severity: 3, family: "heater",
    re: /\bfire[\s-]*eyes?\b|\bburners?\b|\bfirebox\b|\bfired heater\b|\bpilot light\b/i,
    search: "fired heater and burner management incidents (light-off, flame scanner, fuel isolation)",
    hitList: ["Fuel gas isolated and locked out", "Any bypass authorized and logged", "Firebox purged before any light-off", "Gas test at the burner front", "Hot surfaces and refractory dust"],
  },
  radiography: {
    label: "Radiography", severity: 3, family: "radiography",
    re: /\bx-?ray\b|\bradiograph|\brt shot\b|\bgamma\b/i,
    search: "industrial radiography exposure incidents at plants",
    hitList: ["Shot times announced; area cleared", "Boundary roped and signed", "Survey meter in use", "Nobody crosses the rope"],
  },
  excavation: {
    label: "Excavation", severity: 4, family: "excavation",
    re: /\bexcavat|\btrench|\bdig(ging)?\b|\bhydro[\s-]*vac/i,
    search: "excavation and trench incidents near buried lines at plants",
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
  /** From the supervisor's note, not the schedule. */
  fromNote: boolean;
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
 *  two of one family. `note` is the supervisor's own line: a kind named
 *  there counts even when the schedule doesn't show it, and ranks up. */
export function rankHazards(jobs: HazardJobInput[], opts: { note?: string | null; max?: number } = {}): RankedHazard[] {
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
  const noted = new Set(opts.note ? classifyStep(opts.note) : []);
  const ranked: RankedHazard[] = [];
  for (const k of new Set<HazardKind>([...byKind.keys(), ...noted])) {
    const def = HAZARD_KINDS[k];
    const e = byKind.get(k);
    // Severity decides; how much of it there is breaks ties. The
    // supervisor naming it lifts it above anything of equal severity.
    const exposure = e ? Math.min(6, e.hours / 2) + Math.min(3, e.jobs.length) + (e.critical ? 1 : 0) : 0;
    const score = def.severity * 10 + exposure + (noted.has(k) ? 12 : 0);
    ranked.push({ kind: k, label: def.label, severity: def.severity, hours: Math.round((e?.hours ?? 0) * 10) / 10, jobs: e?.jobs ?? [], fromNote: !e, score });
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
  if (h.fromNote) return "From your note";
  const parts = h.jobs.slice(0, 3).map((j) => [j.equipment, j.when].filter(Boolean).join(" "));
  const more = h.jobs.length > 3 ? ` +${h.jobs.length - 3} more` : "";
  const who = [...new Set(h.jobs.map((j) => j.who).filter(Boolean))];
  return [parts.join(", ") + more, who.length === 1 ? who[0] : null].filter(Boolean).join(" · ");
}

// ─── The lessons ─────────────────────────────────────────────────────

export interface SafetyGem {
  /** What to look out for on this job — the condition, present tense. */
  what: string;
  /** What prevents it, in a few words. */
  do: string;
  source: { url: string; title: string | null };
}

export interface SafetyMomentItem {
  kind: HazardKind;
  title: string;
  context: string;
  /** The essentials, tailored to this job (absent on early moments:
   *  the kind's standard list stands in). */
  hitList?: string[];
  gems: SafetyGem[];
}

/** An item's hit list: as built, else the kind's standard one. */
export const hitListOf = (it: { kind: HazardKind; hitList?: string[] }): string[] =>
  it.hitList?.length ? it.hitList : HAZARD_KINDS[it.kind].hitList;

export interface SafetyMoment {
  v: 1;
  items: SafetyMomentItem[];
  note: string | null;
  builtAt: string;
  builtByName: string | null;
}

export const SAFETY_SYSTEM = [
  "You prepare the safety moment for a refinery turnaround's shift-turnover meeting. The crews have 20 years of generic safety talks behind them and tune them out. Your job is the lesson they have not heard: hyper-specific to the work they are about to do.",
  "",
  "The supervisor uses this as the agenda for each job: first the hit list — the essentials, boom boom boom — then the one or two things people miss.",
  "",
  "For EACH kind of work you are given:",
  "1. hitList: exactly 5 essentials for THIS job, at most 8 words each, plain craft words (permits, isolations, gas tests, attendants, barricades, rated equipment, rescue). Start from the standard list given and tailor it to the job details (pressure, equipment, time of shift, the note) — keep what applies, sharpen it, swap in what this job needs more. No sources needed for these.",
  "2. gems: use web search to find real incidents and investigations that match that work as closely as possible. Read them for their LESSONS — what would have prevented it, what the crew should have seen coming — then write 2 gems: the non-obvious things the hit list doesn't already say.",
  "",
  "A gem is a takeaway, NOT a story. The supervisor delivers it in ten seconds; nobody tells what happened to whom.",
  "- watch: at most 20 words, present tense. What to look out for on this job — the condition or warning sign that leads to it.",
  "- prevent: at most 14 words, imperative. What prevents it — a check or action the crew does on THIS job tonight.",
  "- Never retell the incident: no company, place, date, year, victim or \"a worker was…\". The incident is only the evidence; its page goes in source.",
  "- source: the exact URL of a search result you got in this conversation whose lessons back the gem. Never a URL you did not receive from search. If you cannot source a gem, leave it out.",
  "",
  "Example of the form (hydroblasting):",
  '  watch: "A dump pedal that is taped, wedged or sticking keeps the gun live after the lancer lets go."',
  '  prevent: "Test the dump at every start. Standby watches the lancer, nothing else."',
  "",
  "Quality bar — leave out anything an experienced hand could say without the incident:",
  "- Not allowed: wear PPE, stay focused, communicate, watch for pinch points, three points of contact, housekeeping, take your time, follow the procedure, be aware of surroundings, line of fire (unless naming the specific mechanism).",
  "- Wanted: the non-obvious failure mode — the thing that looked fine, the shortcut that killed someone, the condition that changes at night or after hours of work, the detail people forget.",
  "- The two gems for one kind of work must be different failure modes.",
  "- Tailor to the job details given (equipment type, step wording, pressures, crew, time of shift) and to the supervisor's note.",
  "- Prefer refinery, petrochemical, oil & gas and turnaround sources: CSB, OSHA, IOGP, BSEE, CCPS, UK HSE, NIOSH, regulators, industry associations. Recent first, but a classic case that fits exactly beats a recent one that doesn't.",
  "- Plain words a craftsman uses. No preamble.",
  "",
  "title: 2–4 words naming the work as the crew would (\"Hydroblasting 10K\", \"Inside V-7\", \"PSV-021 swap\").",
  "",
  'Return STRICT JSON only, nothing else: {"hazards":[{"kind":"<kind as given>","title":"…","hitList":["…","…","…","…","…"],"gems":[{"watch":"…","prevent":"…","source":"https://…"}]}]}',
].join("\n");

export function safetyMomentPrompt(input: {
  projectName?: string | null;
  shiftLabel: string;
  hazards: RankedHazard[];
  note?: string | null;
  avoidUrls?: string[];
}): string {
  const lines: string[] = [];
  lines.push(`Job: ${input.projectName || "refinery turnaround"}`);
  lines.push(`Shift: ${input.shiftLabel}`);
  if (input.note?.trim()) lines.push(`Supervisor's note: ${input.note.trim()}`);
  lines.push("", "Kinds of work on this shift (riskiest first):");
  for (const h of input.hazards) {
    lines.push(`- kind "${h.kind}" — ${h.label}. Search focus: ${HAZARD_KINDS[h.kind].search}.`);
    lines.push(`    Standard hit list: ${HAZARD_KINDS[h.kind].hitList.join(" / ")}`);
    if (h.fromNote) lines.push("    (named in the supervisor's note, not on the schedule)");
    for (const j of h.jobs.slice(0, 5)) {
      lines.push(`    · ${[j.equipment, j.name].filter(Boolean).join(": ")}${j.when ? ` — ${j.when}` : ""}${j.who ? ` — ${j.who}` : ""}`);
    }
  }
  const avoid = (input.avoidUrls ?? []).slice(0, 40);
  if (avoid.length) {
    lines.push("", "These sources were used in recent safety moments — find different ones:");
    for (const u of avoid) lines.push(`- ${u}`);
  }
  return lines.join("\n");
}

/** Compare URLs the way a person would: no fragment, no trailing slash,
 *  no "www.", http = https. */
export function normalizeUrl(u: string): string {
  try {
    const x = new URL(u.trim());
    x.hash = "";
    const host = x.hostname.replace(/^www\./i, "").toLowerCase();
    const path = x.pathname.replace(/\/+$/, "");
    return `${host}${path}${x.search}`;
  } catch { return u.trim().replace(/\/+$/, "").toLowerCase(); }
}

const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** A gem that names a year is telling the story, not the lesson. */
const STORY = /\b(19|20)\d{2}\b/;

/** Read the model's answer into the moment's items, in the ranked order.
 *  A gem whose source is not one the search returned is dropped, and so is
 *  one that retells the incident; at most two gems per kind. Throws when
 *  the answer isn't JSON at all. */
export function parseSafetyMoment(
  text: string,
  hazards: RankedHazard[],
  searched: Array<{ url: string; title: string | null }>,
): { items: SafetyMomentItem[]; dropped: number } {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error("The answer wasn't in the expected form. Try again.");
  let raw: { hazards?: Array<{ kind?: string; title?: string; hitList?: unknown; gems?: Array<{ watch?: string; prevent?: string; what?: string; do?: string; source?: string }> }> };
  try { raw = JSON.parse(m[0]); } catch { throw new Error("The answer wasn't in the expected form. Try again."); }
  const found = new Map<string, { url: string; title: string | null }>();
  for (const s of searched) if (s.url) found.set(normalizeUrl(s.url), s);
  let dropped = 0;
  const items = hazards.map((h): SafetyMomentItem => {
    const r = (raw.hazards ?? []).find((x) => x?.kind === h.kind);
    const gems: SafetyGem[] = [];
    for (const g of r?.gems ?? []) {
      const what = clip(g?.watch ?? g?.what, 200), act = clip(g?.prevent ?? g?.do, 140);
      const hit = g?.source ? found.get(normalizeUrl(g.source)) : undefined;
      if (!what || !act || !hit || STORY.test(`${what} ${act}`)) { dropped++; continue; }
      if (gems.length >= 2) continue;
      gems.push({ what, do: act, source: { url: hit.url, title: hit.title } });
    }
    // The tailored hit list, when it came back whole; else the standard one.
    const hits = (Array.isArray(r?.hitList) ? r.hitList : []).map((x) => clip(x, 70)).filter((x) => x && !STORY.test(x)).slice(0, 6);
    const hitList = hits.length >= 3 ? hits : HAZARD_KINDS[h.kind].hitList;
    return { kind: h.kind, title: clip(r?.title, 40) || h.label, context: hazardContext(h), hitList, gems };
  });
  return { items, dropped };
}

/** A source's short name for the line under a column: the site, as a
 *  person would say it ("csb.gov"). */
export function sourceLabel(s: { url: string; title: string | null }): string {
  try { return new URL(s.url).hostname.replace(/^www\./i, ""); } catch { return s.title ?? "source"; }
}
