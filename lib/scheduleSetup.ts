// scheduleSetup — what the schedule needs set before its reports can be
// trusted. Required items are shouted about until they're done; the
// recommended ones are offered in the same wizard.
//
//   Time zone     "now" vs the plan — plan-by-now, behind, which shift
//   Shift times   the day / night split, the turnover meeting time
//   Night crews   which jobs have hands on nights (the rest is day work)
//   Critical path where it comes from (the file can mark everything)
//   Baseline      the plan progress is measured against

export type SetupItemId = "timezone" | "shifts" | "night" | "critical" | "baseline";

export interface SetupItem {
  id: SetupItemId;
  label: string;
  required: boolean;
  done: boolean;
  /** What goes wrong while it isn't set — one line. */
  why: string;
  /** Still being read — neither shouted about nor shown as set. */
  checking?: boolean;
}

export function setupChecklist(s: {
  timezoneSet: boolean;
  /** null = still loading. */
  shiftTimesSaved: boolean | null;
  criticalChosen: boolean;
  hasBaseline: boolean;
  /** Night crews decided: named jobs, or "follow the file". */
  nightDecided?: boolean;
}): SetupItem[] {
  return [
    { id: "timezone", label: "Plant time zone", required: true, done: s.timezoneSet,
      why: "Without it the schedule runs on UTC — plan-by-now, behind / on plan and the current shift are hours off." },
    { id: "shifts", label: "Shift change times", required: true, done: s.shiftTimesSaved === true, checking: s.shiftTimesSaved == null,
      why: "Every day / night split, the shift report and the turnover meeting time hang on these." },
    // Required: a schedule file puts work in night hours that nights may not
    // staff — the turnover would hand day work to nights. One choice settles
    // it ("follow the file" is a choice too).
    { id: "night", label: "Night crews", required: true, done: !!s.nightDecided,
      why: "Until it's set, every step the file put in night hours is handed to nights — even on jobs nights don't staff." },
    { id: "critical", label: "Critical path source", required: false, done: s.criticalChosen,
      why: "Schedule files often mark nearly everything critical — choose where it comes from." },
    { id: "baseline", label: "Baseline", required: false, done: s.hasBaseline,
      why: "Without one, moving work later quietly erases the slip — progress is measured against today's plan." },
  ];
}

/** Required items still open — the banner names them. */
export const missingRequired = (items: SetupItem[]) => items.filter((i) => i.required && !i.done && !i.checking);
