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

export type SetupItemId = "type" | "equipment" | "timezone" | "shifts" | "night" | "critical" | "baseline" | "print";

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
}): SetupItem[] {
  return [
    { id: "type", label: "Project type", required: false, extra: true, done: !!s.typeSet,
      why: "Turnaround, outage, capital project… the word the reports and safety topics say for this project." },
    ...(s.equipmentSet !== undefined ? [{ id: "equipment" as const, label: "Unit & equipment", required: false, done: s.equipmentSet === true, checking: s.equipmentSet === null,
      why: "The unit, and the equipment each work order is on - so the project shows on the Intelligence graph and what's learned on that equipment reaches the next job on it." }] : []),
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
