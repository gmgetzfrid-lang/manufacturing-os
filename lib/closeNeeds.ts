// closeNeeds - what the post-event review measures that a person has to
// put in, each with where it stands and the one place to put it in. The
// review's close-out checklist: set up the project, name the roles, load
// the bids, rates and staffing plans, count heads and answer the incident
// line at each shift meeting, set the targets, post the spend, keep the
// materials register, clear the steps to close.

export type NeedGo =
  | { kind: "setup"; step: "type" | "roles" | "manpower" }
  | { kind: "tab"; tab: "today" | "costs" | "materials" }
  | { kind: "score" }
  | { kind: "steps" };

export interface Need {
  id: string;
  /** What to put in. */
  title: string;
  /** The review category it feeds. */
  category: string;
  done: boolean;
  /** Where it stands now, from the records. */
  status: string;
  /** Where to put it in, and the button's words. */
  go: NeedGo;
  button: string;
}

export interface NeedsInput {
  /** The project type set, or read from the name (not the plain "Project"). */
  typeKnown: boolean;
  typeWord: string;
  roles: { recorded: boolean; required: number; filled: number } | null;
  /** Companies on the schedule; those with a bid; those with a rate. */
  companies: string[];
  bids: string[];
  rates: string[];
  /** Companies with a staffing plan read in. */
  staffing: string[];
  headCounts: { shiftsCounted: number; shiftsWorked: number };
  /** Shifts whose report answers the incident line. */
  incidentsAnswered: number | null;
  /** The score lines a person sets a target on, and whether each has one. */
  targets: Array<{ name: string; set: boolean }>;
  costs: { budget: number | null; spent: number } | null;
  /** Lines on the materials register (null: none). */
  materials: number | null;
  /** Steps to close still open (PSSR, turnover documents, punch, change orders); null: not known here. */
  stepsLeft: number | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
/** Most of the shifts (4 in 5): enough for the review to measure from. */
const most = (n: number, of: number) => of > 0 && n / of >= 0.8;

export function closeNeeds(x: NeedsInput): Need[] {
  const out: Need[] = [];
  const hc = x.headCounts;
  out.push({
    id: "type", title: "Project type", category: "The event", done: x.typeKnown,
    status: x.typeKnown ? `${x.typeWord[0].toUpperCase()}${x.typeWord.slice(1)}. Lessons go to every ${x.typeWord}.` : "Not set. Lessons can't be matched to the next event of this kind.",
    go: { kind: "setup", step: "type" }, button: "Setup › Project type",
  });
  const r = x.roles;
  out.push({
    id: "roles", title: "Roles and who fills each", category: "Organization", done: !!r && r.recorded && r.filled === r.required,
    status: !r || !r.recorded ? "Not filled in." : r.filled === r.required ? `All ${r.required} roles named.` : `${r.filled} of ${r.required} roles named.`,
    go: { kind: "setup", step: "roles" }, button: "Setup › Roles",
  });
  const cos = x.companies.filter((c) => !/kern|\(KE\)/i.test(c));
  const noBid = cos.filter((c) => !x.bids.includes(c));
  out.push({
    id: "bids", title: "Each contractor's bid hands and rate", category: "Contractors · Costs", done: cos.length > 0 && noBid.length === 0 && x.rates.length > 0,
    status: !cos.length ? "No contractor crews on the schedule." : noBid.length === cos.length ? "No bid entered." : noBid.length ? `No bid for ${noBid.join(", ")}.` : x.rates.length ? `Bids for all ${plural(cos.length, "contractor")}; ${plural(x.rates.length, "rate")} entered.` : "Bids entered; no rate, so labor cost can't be shown.",
    go: { kind: "setup", step: "manpower" }, button: "Setup › Manpower",
  });
  out.push({
    id: "staffing", title: "Staffing plans", category: "Contractors", done: x.staffing.length > 0,
    status: x.staffing.length ? `Read in for ${x.staffing.join(", ")}.` : "None read in. Each shift's head count has no plan to hold it to.",
    go: { kind: "setup", step: "manpower" }, button: "Setup › Manpower",
  });
  out.push({
    id: "heads", title: "Head count at each shift meeting", category: "Contractors · Costs", done: most(hc.shiftsCounted, hc.shiftsWorked),
    status: hc.shiftsWorked ? `${hc.shiftsCounted} of ${plural(hc.shiftsWorked, "shift")} worked.` : "No shifts worked yet.",
    go: { kind: "tab", tab: "today" }, button: "Shift › Meeting",
  });
  if (x.incidentsAnswered != null) out.push({
    id: "incidents", title: "Incident line on each shift report", category: "Safety", done: most(x.incidentsAnswered, hc.shiftsWorked),
    status: hc.shiftsWorked ? `Answered on ${x.incidentsAnswered} of ${plural(hc.shiftsWorked, "shift")}.` : "No shifts worked yet.",
    go: { kind: "tab", tab: "today" }, button: "Shift › Report",
  });
  const t = x.targets, tSet = t.filter((y) => y.set);
  out.push({
    id: "targets", title: `Targets for ${t.map((y) => y.name.toLowerCase()).join(", ")}`, category: "Planning · Safety · Execution", done: tSet.length === t.length,
    status: tSet.length === t.length ? "All set." : tSet.length ? `${tSet.map((y) => y.name).join(", ")} set; ${t.filter((y) => !y.set).map((y) => y.name.toLowerCase()).join(", ")} not set.` : "None set.",
    go: { kind: "score" }, button: "Set them on the score",
  });
  const c = x.costs;
  out.push({
    id: "costs", title: "Budget and spend posted", category: "Costs", done: !!c && !!c.budget && c.spent > 0,
    status: !c || !c.budget ? "No budget entered." : c.spent > 0 ? `${money(c.spent)} spent of ${money(c.budget)}.` : `${money(c.budget)} budget; no spend posted.`,
    go: { kind: "tab", tab: "costs" }, button: "Costs",
  });
  out.push({
    id: "materials", title: "Materials register", category: "Logistics", done: (x.materials ?? 0) > 0,
    status: x.materials ? `${plural(x.materials, "line")}.` : "Empty. Parts each job needed can't be held against what was ordered.",
    go: { kind: "tab", tab: "materials" }, button: "Materials",
  });
  if (x.stepsLeft != null) out.push({
    id: "steps", title: "Steps to close: PSSR, turnover documents, punch list, change orders", category: "Execution", done: x.stepsLeft === 0,
    status: x.stepsLeft === 0 ? "All clear." : `${plural(x.stepsLeft, "step")} left.`,
    go: { kind: "steps" }, button: "Steps to close",
  });
  return out;
}
