// scheduleSetup — what the schedule needs set before its reports can be
// trusted. Required items are shouted about until they're done; the
// recommended ones are offered in the same wizard.
//
//   Time zone     "now" vs the plan — plan-by-now, behind, which shift
//   Shift times   the day / night split, the turnover meeting time
//   Night shifts  which jobs run days and nights (the rest is day work)
//   Critical path where it comes from (the file can mark everything)
//   Baseline      the plan progress is measured against
//   Printed reports  the company letterhead reports print on (optional —
//                 never counted as something to do)
//   Project type  turnaround, outage, capital project…: the word the
//                 reports say for the project (optional, read from the
//                 project's name until set)
//   Unit & equipment  the unit, and the equipment each work order is on:
//                 the project on the Intelligence graph, findings tied to
//                 equipment for the next job
//   Manpower      each crew's company, bids, rates and staffing plans
//   Roles         who runs the event: each role and the person named to it

export type SetupItemId = "type" | "equipment" | "timezone" | "shifts" | "night" | "critical" | "baseline" | "manpower" | "roles" | "print";

export interface SetupItem {
  id: SetupItemId;
  label: string;
  required: boolean;
  done: boolean;
  /** What goes wrong while it isn't set — one line. */
  why: string;
  /** Still being read — neither shouted about nor shown as set. */
  checking?: boolean;
  /** Nice to have: never counted as "to do". */
  extra?: boolean;
}

export function setupChecklist(s: {
  timezoneSet: boolean;
  /** null = still loading. */
  shiftTimesSaved: boolean | null;
  criticalChosen: boolean;
  hasBaseline: boolean;
  /** Night crews decided: named jobs, or "follow the file". null = still loading. */
  nightDecided?: boolean | null;
  /** A letterhead saved for printed reports. */
  letterheadSet?: boolean;
  /** The project type saved (not read from the name). */
  typeSet?: boolean;
  /** The unit picked and every work order's equipment confirmed. null =
   *  still loading; undefined = not asked (left off the list). */
  equipmentSet?: boolean | null;
  /** Some company's bid manpower set. null = still loading. */
  manpowerSet?: boolean | null;
  /** The event's roles saved, each required one with a person. null = still loading. */
  rolesSet?: boolean | null;
}): SetupItem[] {
  return [
    { id: "type", label: "Project type", required: false, extra: true, done: !!s.typeSet,
      why: "Turnaround, outage, capital project… the word the reports and safety topics say for this project." },
    ...(s.equipmentSet !== undefined ? [{ id: "equipment" as const, label: "Units & equipment", required: false, done: s.equipmentSet === true, checking: s.equipmentSet === null,
      why: "The units the project is on, and each work order's equipment, unit and equipment type - read from your equipment numbers - so every view filters by unit and type, the project shows on the Intelligence graph, and what's learned on that equipment reaches the next job on it." }] : []),
    { id: "timezone", label: "Plant time zone", required: true, done: s.timezoneSet,
      why: "Without it the schedule runs on UTC - plan-by-now, behind / on plan and the current shift are hours off." },
    { id: "shifts", label: "Shift change times", required: true, done: s.shiftTimesSaved === true, checking: s.shiftTimesSaved == null,
      why: "Every day / night split, the shift report and the turnover meeting time hang on these." },
    // Required: a schedule file puts work in night hours that nights may not
    // staff — the turnover would hand day work to nights. One choice settles
    // it ("follow the file" is a choice too).
    { id: "night", label: "Night shifts", required: true, done: s.nightDecided === true, checking: s.nightDecided === null,
      why: "Until it's set, every step the file put in night hours is handed to nights - even on jobs that only work days." },
    { id: "critical", label: "Critical path source", required: false, done: s.criticalChosen,
      why: "Schedule files often mark nearly everything critical - choose where it comes from." },
    { id: "baseline", label: "Baseline", required: false, done: s.hasBaseline,
      why: "Without one, moving work later quietly erases the slip - progress is measured against today's plan." },
    { id: "manpower", label: "Manpower & staffing", required: false, extra: true, done: s.manpowerSet === true, checking: s.manpowerSet === null,
      why: "Each crew's company, each company's bid hands per shift and rate, and its staffing plan: the meeting's head counts are held to them, and labor cost runs from them." },
    { id: "roles", label: "Roles & responsibilities", required: false, extra: true, done: s.rolesSet === true, checking: s.rolesSet === null,
      why: "Who runs the event: each role, what it is responsible for, and the person named to it. The post-event review's Organization line reads it." },
    { id: "print", label: "Printed reports", required: false, extra: true, done: !!s.letterheadSet,
      why: "Optional - upload your company letterhead (Word or PDF) and printed reports come out on it." },
  ];
}

/** Required items still open — the banner names them. */
export const missingRequired = (items: SetupItem[]) => items.filter((i) => i.required && !i.done && !i.checking);

/** Items still to do — the Setup button's count (optional extras aside). */
export const toDo = (items: SetupItem[]) => items.filter((i) => !i.done && !i.checking && !i.extra);

/** Opens Schedule setup at a step from anywhere on the page (the calendar's
 *  "Night shifts"): window.dispatchEvent(new CustomEvent(OPEN_SETUP_EVENT, { detail: "night" })). */
export const OPEN_SETUP_EVENT = "schedule-setup:open";

// A step asked for from a tab that doesn't show Setup (Close-out, the
// header): it opens when the schedule tab mounts.
let pendingSetup: SetupItemId | "first" | null = null;
/** Open Setup at a step (none: the first one missing), from anywhere. */
export function requestSetup(step?: SetupItemId): void {
  pendingSetup = step ?? "first";
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(OPEN_SETUP_EVENT, { detail: step }));
}
/** The step asked for before Setup was on the page, once. */
export function takePendingSetup(): SetupItemId | "first" | null {
  const s = pendingSetup;
  pendingSetup = null;
  return s;
}
