// lib/projectVocabulary.ts — one word per concept on the Projects surface
// (projects-tab UX-15). The surface used seven words for "this no longer
// counts", five for the company, six for the schedule row, and "party" (a
// schema word) on screen. The settled words:
//
//   * the company on a project — CONTRACTOR, whatever its kind (contractor,
//     vendor, rental house, internal crew — one kind list everywhere);
//     a company that priced an RFQ group is a BIDDER on the bid tab; the
//     org-wide list is the KNOWN COMPANIES registry;
//   * the schedule row — TASK; a task under another is a SUB-TASK; a task
//     that rolls its sub-tasks up is a PHASE; a task with no duration is a
//     MILESTONE (a diamond, never a bar);
//   * "no longer counts" — one word per record, each with its own meaning:
//     VOID (money: a cost entry or a quote; and a punch item that was not a
//     real snag), NOT SELECTED (a bid in a group awarded to another bidder),
//     NOT APPLICABLE / N/A (a checklist item this job does not need), WAIVED
//     (a turnover deliverable the job goes without, signed).
//
// Pure — no imports — so the pickers, the glossary, the legends and the
// tests read the same words.

/** The kinds of company, in the one order every picker lists them. */
export const COMPANY_KINDS = ["contractor", "vendor", "rental", "internal"] as const;
export type CompanyKindWord = (typeof COMPANY_KINDS)[number];
export const COMPANY_KIND_LABEL: Record<CompanyKindWord, string> = {
  contractor: "Contractor",
  vendor: "Vendor",
  rental: "Rental / equipment",
  internal: "Internal crew",
};

export interface VocabularyTerm { term: string; plain: string }

export const CONTRACTOR_TERM: VocabularyTerm = {
  term: "Contractor",
  plain: "Any company working on or supplying this project — its kind says which: contractor, vendor, rental or internal crew. Link it to its Known Companies record and its awards, change orders, accepted turnover and punch items reach that company's scorecard.",
};

export const BIDDER_TERM: VocabularyTerm = {
  term: "Bidder",
  plain: "A company that priced an RFQ group. Linked to its Known Companies record, a barred company is flagged before the award.",
};

/** "This no longer counts", on the Costs tab — and where the other words live. */
export const VOID_TERM: VocabularyTerm = {
  term: "Void",
  plain: "Struck out but kept for the record: a voided cost entry or quote counts toward no total, and the reason and who voided it stay in the history. Money is never deleted. (On the Quality tab a checklist item that does not apply to this job is Not applicable, and a turnover deliverable the job goes without is Waived — each with a person's reason.)",
};

export const NOT_SELECTED_TERM: VocabularyTerm = {
  term: "Not selected",
  plain: "A bid in an RFQ group that was awarded to another bidder. It stays on the tab for the record.",
};

/** The schedule's words — the Execution legend says the same. */
export const SCHEDULE_TERMS: VocabularyTerm[] = [
  { term: "Task", plain: "One row of the schedule, with planned dates, a status and a % complete." },
  { term: "Sub-task", plain: "A task inside another task." },
  { term: "Phase", plain: "A task that holds sub-tasks — its dates, status and % roll up from them." },
  { term: "Milestone", plain: "A task with no duration — a single date the schedule marks (a diamond, never a bar)." },
];

/** The Quality tab's turnover words, said beside the list. */
export const TURNOVER_STATUS_MEANING: Record<"accepted" | "waived" | "rejected", string> = {
  accepted: "reviewed and on file",
  waived: "the job goes without it — a signed decision, counted apart from accepted",
  rejected: "sent back for a resubmission",
};
