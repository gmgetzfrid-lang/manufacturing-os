// lib/projectHealth.ts — the project's one health score and its COACH, pure.
//
// Two jobs:
//
//   1. computeProjectHealth — the boss-brief headline: one 0..100 composite
//      from cost, schedule, quality, and controls signals, with each part
//      visible (the score always shows its work).
//
//   2. buildCoachItems — "WHAT DO I FEED YOU": a ruleset that inspects the
//      project's state and returns the next most valuable inputs, each with
//      the payoff stated ("Add a budget (2 min) — unlocks burn + forecast")
//      and a deep link. This is the wizard continued for the life of the
//      project: skipped steps come back here, and new gaps surface here.
//
// Pure — the page gathers state, this module reasons about it.

export interface ProjectStateSnapshot {
  // Wizard/meta
  hasPurpose: boolean;
  hasGoals: boolean;
  hasSow: boolean;
  jobKind: string | null;
  // Cost
  /** The BASELINE budget (sum of cost_accounts.budget). Change-order growth
   *  is measured against it. */
  budget: number;
  /** COST-4: the baseline plus the approved change orders whose money is on
   *  the ledger (`changeOrderOnLedger`) — the figure the Costs tab shows as
   *  Budget, and the one burn is measured against. Absent → `budget`. */
  revisedBudget?: number;
  committed: number;
  spent: number;
  cpi: number | null;
  accountCount: number;
  accountsPinned: number;      // pinned to schedule tasks (enables EV/CPI)
  partyCount: number;
  quoteCount: number;
  unawardedRfqGroups: number;  // bid tabs with quotes but no award
  pendingCostDocs: number;     // uploaded, parsed, awaiting confirmation
  // Change orders
  openChangeOrders: number;
  /** Approved change orders whose money is on the ledger
   *  (`changeOrderOnLedger`: approved AND the linked entry posted) — the
   *  same rule as the revised budget and the CO panel's total. */
  approvedCoAmount: number;
  // Schedule
  milestoneCount: number;
  overdueMilestones: number;
  spi: number | null;
  hasBaseline: boolean;
  // Quality & closeout
  checklistCount: number;
  checklistOpenItems: number;
  checklistNeedsEvidence: number;
  /** QUAL-15: non-void checklists not yet signed off (status not
   *  `complete`) — open at closeout whatever their items' colours. */
  checklistsAwaitingSignoff?: number;
  /** QUAL-15: checklists `complete` with no signature on record (once
   *  20261136's `completed_signature_id` exists; 0 before it). */
  checklistsCompletedUnsigned?: number;
  /** QUAL-15: voided checklists — they leave every count above, so each is
   *  named at closeout with who voided it (the CHECKLIST_STATUS audit row;
   *  null = none on record; `voidedByUnreadable` = that read failed). */
  checklistsVoided?: Array<{ id: string; title: string; voidedBy: string | null; voidedByUnreadable?: boolean }>;
  turnoverRequired: number;
  turnoverAccepted: number;
  punchOpen: number;
  // Delegation
  intakeLinkCount: number;
  membersCount: number;
  /** Reads the gather could NOT make (a refused or failed query), named by
   *  their SNAPSHOT_READS label. Their counts above are zeros standing in
   *  for "unknown": computeProjectHealth scores every part that depends on
   *  one as null, and buildCoachItems drops every suggestion that would be
   *  raised by the zero — the coach names them instead of presenting the
   *  zeros as the truth. */
  readFailures?: string[];
  /** What the database has not been migrated for (20261013): a SNAPSHOT_READS
   *  label for a table that does not exist yet, PROJECT_FIELDS_NOT_MIGRATED
   *  for the projects columns, or RFQ_GROUPS_NOT_MIGRATED. A known state,
   *  named as such, not a failed read — the parts and suggestions that need
   *  it are left out the same way. */
  notMigrated?: string[];
}

/** The gather's read labels (lib/projectSnapshot names a failed or
 *  not-migrated read by these) — the key from a read to the health parts
 *  and coach items it feeds. */
export const SNAPSHOT_READS = {
  project: "project",
  costAccounts: "cost accounts",
  costEntries: "cost entries",
  costDocuments: "cost documents",
  parties: "companies on the job",
  changeOrders: "change orders",
  milestones: "milestones",
  checklists: "checklists",
  checklistItems: "checklist items",
  turnover: "turnover items",
  punch: "punch items",
  intakeLinks: "intake links",
  members: "members",
} as const;

/** The notMigrated entry for the four projects columns migration 20261013
 *  added (purpose, goals, job_kind, sow_document_id) — before it, none of
 *  them can be read, so every suggestion about them is left out. */
export const PROJECT_FIELDS_NOT_MIGRATED = "purpose, goals, job size and Summary of Work";

/** The notMigrated entry for cost_documents.rfq_group (20261013). Before it
 *  every quote tabulates alone ("Ungrouped — <vendor>"), so the count of
 *  unawarded bid groups is a count of unawarded quotes — the award
 *  suggestion is left out rather than raised from it. */
export const RFQ_GROUPS_NOT_MIGRATED = "RFQ groups";

const R = SNAPSHOT_READS;

/** Which of `reads` the snapshot could not read, and which the database
 *  has not been migrated for. */
function gapsIn(s: ProjectStateSnapshot, reads: string[]): { failed: string[]; notMigrated: string[] } {
  const failed = reads.filter((r) => (s.readFailures ?? []).includes(r));
  const notMigrated = reads.filter((r) => !failed.includes(r) && (s.notMigrated ?? []).includes(r));
  return { failed, notMigrated };
}

/** A part that depends on a read the snapshot does not have scores null
 *  (excluded from the composite) and says why — never a zero scored as
 *  the truth. */
function unknownPart(label: string, s: ProjectStateSnapshot, reads: string[]): HealthPart | null {
  const g = gapsIn(s, reads);
  if (g.failed.length > 0) return { label, score: null, detail: `Could not read ${g.failed.join(", ")}` };
  if (g.notMigrated.length > 0) return { label, score: null, detail: `Needs migration 20261013 (${g.notMigrated.join(", ")})` };
  return null;
}

/**
 * How strict the closeout gates are — the ONE statement the coach, the
 * closeout dialog and the report all describe. The gates are checks with
 * an override, not walls: the owner can complete anyway, and the open
 * items simply stay open. Nothing in transitionProjectStatus refuses a
 * completion over an open gate, so no copy may say "gated" or "blocked".
 * Nor may it say the open items are "recorded on the closeout": today the
 * completion's audit row carries only the reason (lib/projects.ts), and the
 * report says "No gate snapshot was recorded". That wording is J8's to
 * switch on when PC-2 / SAF-14 records the gate snapshot.
 */
export const CLOSEOUT_GATE_POLICY = {
  blocking: false,
  /** One sentence for any surface that mentions the gates. */
  summary: "Closeout gates are checks with an override, not blocks — you can complete anyway; open items stay open on the record.",
  /** The dialog's line under the gate list. */
  overrideNote: "You can complete anyway — the open items stay on the record and in the report.",
} as const;

export interface HealthPart { label: string; score: number | null; detail: string }

export interface ProjectHealth {
  score: number | null;        // null = not enough data to say anything honest
  trend: "steady";             // reserved — trend needs history rows (future)
  parts: HealthPart[];
}

const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));

/** One number the boss can trust because every part is inspectable. Parts
 *  with no data score null and are EXCLUDED (never counted as perfect or
 *  as failing) — the composite averages only what's known. */
export function computeProjectHealth(s: ProjectStateSnapshot): ProjectHealth {
  const parts: HealthPart[] = [];

  // Each part first checks the reads it depends on: a refused read's zeros
  // are not scored (a refused checklist_items read is not "Checklists
  // clear"). Cost needs the milestones read too once an account is pinned —
  // earned value comes from those tasks' progress. Approved change orders
  // revise the budget that burn and earned value are measured against
  // (COST-4), so a FAILED change-orders read leaves Cost unknown too; "not
  // migrated" does not — before 20261013 no change order can exist.
  const costUnknown = unknownPart("Cost", s,
    [R.costAccounts, R.costEntries, ...(s.accountsPinned > 0 ? [R.milestones] : [])])
    ?? ((s.readFailures ?? []).includes(R.changeOrders)
      ? { label: "Cost", score: null, detail: `Could not read ${R.changeOrders}` }
      : null);
  // The budget the Costs tab shows: baseline + on-ledger approved changes.
  const budgetNow = s.revisedBudget ?? s.budget;

  // Cost health: CPI-centered when available, else budget-vs-spent sanity.
  if (costUnknown) {
    parts.push(costUnknown);
  } else if (s.cpi != null && s.cpi > 0) {
    parts.push({
      label: "Cost", score: clamp(s.cpi * 100, 0, 120) > 100 ? 100 : clamp(s.cpi * 100),
      detail: s.cpi >= 1 ? `CPI ${s.cpi.toFixed(2)} — getting more done per dollar than planned` : `CPI ${s.cpi.toFixed(2)} — spending faster than earning`,
    });
  } else if (budgetNow > 0) {
    const burned = s.spent / budgetNow;
    // Continuous across the 100% line: the under-budget curve bottoms out at
    // 60 as burn approaches 100%, and the over-budget curve continues DOWN
    // from there — going over must never score higher than staying under.
    parts.push({
      label: "Cost", score: burned <= 1 ? 100 - clamp((burned - 0.85) * 400, 0, 40) : clamp(60 - (burned - 1) * 200),
      detail: `${Math.round(burned * 100)}% of budget spent${burned > 1 ? " — over budget" : ""}${s.committed > 0 ? ` · ${Math.round((s.committed / budgetNow) * 100)}% committed` : ""}`,
    });
  } else {
    parts.push({ label: "Cost", score: null, detail: "No budget set yet" });
  }

  // Schedule health.
  const scheduleUnknown = unknownPart("Schedule", s, [R.milestones]);
  if (scheduleUnknown) {
    parts.push(scheduleUnknown);
  } else if (s.milestoneCount > 0) {
    const spiScore = s.spi != null ? clamp(s.spi * 100) : null;
    const overduePenalty = clamp((s.overdueMilestones / Math.max(s.milestoneCount, 1)) * 200, 0, 60);
    parts.push({
      label: "Schedule",
      score: spiScore != null ? clamp(spiScore - overduePenalty * 0.3) : clamp(100 - overduePenalty),
      detail: s.overdueMilestones > 0
        ? `${s.overdueMilestones} task${s.overdueMilestones === 1 ? "" : "s"} overdue${s.spi != null ? ` · SPI ${s.spi.toFixed(2)}` : ""}`
        : s.spi != null ? `SPI ${s.spi.toFixed(2)}` : "On the board, nothing overdue",
    });
  } else {
    parts.push({ label: "Schedule", score: null, detail: "No schedule yet" });
  }

  // Controls discipline: change-order growth over the BASELINE budget (the
  // original figure, not the revised one the Cost part burns against —
  // measuring growth against a budget the growth already raised would
  // understate it; COST-4).
  const controlUnknown = unknownPart("Change control", s, [R.costAccounts, R.changeOrders]);
  if (controlUnknown) {
    parts.push(controlUnknown);
  } else if (s.budget > 0 && (s.approvedCoAmount > 0 || s.openChangeOrders > 0)) {
    const growth = s.approvedCoAmount / s.budget;
    parts.push({
      label: "Change control",
      score: clamp(100 - growth * 400 - s.openChangeOrders * 5),
      detail: `${Math.round(growth * 100)}% growth over the baseline budget via approved change orders · ${s.openChangeOrders} open`,
    });
  } else {
    parts.push({ label: "Change control", score: s.budget > 0 ? 100 : null, detail: s.budget > 0 ? "No change orders" : "Needs a budget first" });
  }

  // Quality & closeout readiness. Only signals that EXIST contribute — a
  // project with turnover requirements but no checklist doesn't collect a
  // vacuous "checklists clear" credit (and vice versa).
  const qualityUnknown = unknownPart("Quality", s, [R.checklists, R.checklistItems, R.turnover, R.punch]);
  if (qualityUnknown) {
    parts.push(qualityUnknown);
  } else if (s.checklistCount > 0 || s.turnoverRequired > 0) {
    const qparts: number[] = [];
    if (s.checklistCount > 0) {
      const unresolved = s.checklistOpenItems + s.checklistNeedsEvidence;
      qparts.push(unresolved === 0 ? 100 : Math.max(0, 100 - unresolved * 7));
    }
    if (s.turnoverRequired > 0) {
      qparts.push((s.turnoverAccepted / s.turnoverRequired) * 100);
    }
    const base = qparts.reduce((a, b) => a + b, 0) / qparts.length;
    parts.push({
      label: "Quality",
      score: clamp(base - s.punchOpen * 2),
      detail: [
        s.checklistNeedsEvidence > 0 ? `${s.checklistNeedsEvidence} checklist item${s.checklistNeedsEvidence === 1 ? "" : "s"} need evidence` : null,
        s.turnoverRequired > 0 ? `turnover ${s.turnoverAccepted}/${s.turnoverRequired} accepted` : null,
        s.punchOpen > 0 ? `${s.punchOpen} punch open` : null,
      ].filter(Boolean).join(" · ") || "Checklists clear",
    });
  } else {
    parts.push({ label: "Quality", score: null, detail: "No checklists or turnover requirements yet" });
  }

  const known = parts.filter((p) => p.score != null) as Array<HealthPart & { score: number }>;
  return {
    score: known.length ? Math.round(known.reduce((a, p) => a + p.score, 0) / known.length) : null,
    trend: "steady",
    parts,
  };
}

// ── The coach ─────────────────────────────────────────────────────────────

export interface CoachItem {
  id: string;
  title: string;               // imperative, with time cost when tiny
  payoff: string;              // what it unlocks — the reason to bother
  href: string;                // deep link to the exact spot
  weight: number;              // ordering: higher = more valuable next
  kind: "setup" | "cost" | "schedule" | "quality" | "delegation";
}

/** Where the project-details editor is, and who has it: the header's
 *  Edit button renders only for the owner and Admin / DocCtrl
 *  (page.tsx `canManage`), so the item says so instead of naming a control
 *  most members cannot see. */
const EDIT_PROJECT_WHO = "The Edit button shows for the project owner, admins and document control — anyone else, ask the owner.";

/** The "what do I feed you" ruleset. Returns items sorted most-valuable
 *  first. Every rule states its payoff — no nagging without a reason.
 *  A rule that fires on an ABSENCE (no budget, no schedule, no SOW …) is
 *  dropped when the read behind it failed or is not migrated: a zero that
 *  stands in for "unknown" never raises a suggestion. */
export function buildCoachItems(s: ProjectStateSnapshot, projectId: string): CoachItem[] {
  const base = `/projects/${projectId}`;
  const items: CoachItem[] = [];
  const add = (i: CoachItem) => items.push(i);
  const gap = new Set([...(s.readFailures ?? []), ...(s.notMigrated ?? [])]);
  const known = (...reads: string[]) => reads.every((r) => !gap.has(r));
  const projectKnown = known(R.project, PROJECT_FIELDS_NOT_MIGRATED);
  // The budget the Costs tab shows (baseline + on-ledger approved changes).
  const budgetNow = s.revisedBudget ?? s.budget;

  if (known(R.costAccounts) && budgetNow <= 0) add({
    id: "budget", kind: "cost", weight: 100,
    title: "Add a budget (2 min)",
    payoff: "Unlocks the burn bar, the S-curve, and the finish-cost forecast.",
    href: `${base}?tab=costs`,
  });
  if (known(R.milestones) && s.milestoneCount === 0) add({
    id: "schedule", kind: "schedule", weight: 95,
    title: "Add a schedule — import a file or type a few milestones",
    payoff: "Unlocks the execution board, overdue alerts, and schedule health (SPI).",
    href: `${base}?tab=schedule`,
  });
  if (s.pendingCostDocs > 0) add({
    id: "confirm-docs", kind: "cost", weight: 92,
    title: `${s.pendingCostDocs} read document${s.pendingCostDocs === 1 ? "" : "s"} waiting on you`,
    payoff: "Read quotes are already in the bid comparison — award the winner; read invoices post as spend when you post them as actual.",
    href: `${base}?tab=costs`,
  });
  if (known(RFQ_GROUPS_NOT_MIGRATED) && s.quoteCount > 0 && s.unawardedRfqGroups > 0) add({
    id: "award", kind: "cost", weight: 88,
    title: "Pick a winner in the bid comparison",
    payoff: "The award posts the contract to your budget automatically.",
    href: `${base}?tab=costs`,
  });
  if (known(R.costAccounts, R.milestones) && budgetNow > 0 && s.accountCount > 0 && s.accountsPinned === 0 && s.milestoneCount > 0) add({
    id: "pin-ev", kind: "cost", weight: 80,
    title: "Pin budget lines to schedule tasks",
    payoff: "Unlocks Cost health (CPI) — earned value against real progress.",
    href: `${base}?tab=costs`,
  });
  if (known(R.milestones) && s.milestoneCount > 0 && !s.hasBaseline) add({
    id: "baseline", kind: "schedule", weight: 72,
    title: "Set a schedule baseline",
    payoff: "Drift becomes visible — you'll see slips against the original plan.",
    href: `${base}?tab=schedule`,
  });
  if (projectKnown && !s.hasSow) add({
    id: "sow", kind: "setup", weight: 64,
    title: "Attach a Summary of Work (Edit button in the header)",
    payoff: `Feeds RFQs, checklist assessments, and the project report. ${EDIT_PROJECT_WHO}`,
    href: base,
  });
  if (projectKnown && (!s.hasPurpose || !s.hasGoals)) add({
    id: "purpose", kind: "setup", weight: 58,
    title: "Write the purpose & goals (Edit button in the header)",
    payoff: `Everyone who opens the project knows why it exists. ${EDIT_PROJECT_WHO}`,
    href: base,
  });
  if (known(R.checklists) && s.checklistCount === 0) add({
    id: "checklist", kind: "quality", weight: 55,
    title: "Upload a PSSR / QA-QC checklist",
    payoff: "The system reads it, works out what applies to THIS job, and tracks the gaps for you.",
    href: `${base}?tab=quality`,
  });
  if (s.checklistNeedsEvidence > 0) add({
    id: "evidence", kind: "quality", weight: 76,
    title: `Provide evidence for ${s.checklistNeedsEvidence} checklist item${s.checklistNeedsEvidence === 1 ? "" : "s"}`,
    payoff: "Nothing runs on its own — run \"Check evidence we already hold\" on the Quality tab; items with a matching document on file turn green with the citation attached.",
    href: `${base}?tab=quality`,
  });
  if (s.turnoverRequired > 0 && s.turnoverAccepted < s.turnoverRequired) add({
    id: "turnover", kind: "quality", weight: 68,
    title: `Chase the turnover package — ${s.turnoverRequired - s.turnoverAccepted} item${s.turnoverRequired - s.turnoverAccepted === 1 ? "" : "s"} outstanding`,
    payoff: CLOSEOUT_GATE_POLICY.summary,
    href: `${base}?tab=quality`,
  });
  if (known(R.parties, R.costAccounts) && s.partyCount === 0 && budgetNow > 0) add({
    id: "parties", kind: "delegation", weight: 50,
    title: "Add the companies working this job",
    payoff: "Spending gets attributed, and their performance record starts building.",
    href: `${base}?tab=costs`,
  });
  if (known(R.intakeLinks, R.parties) && s.intakeLinkCount === 0 && s.partyCount > 0) add({
    id: "links", kind: "delegation", weight: 46,
    title: "Send contractors their upload links",
    payoff: "Documents land on the Intake tab for review; quotes land on the Costs tab as drafts — run the AI read there to tabulate them.",
    href: `${base}?tab=intake`,
  });
  if (known(R.members) && s.membersCount <= 1) add({
    id: "members", kind: "delegation", weight: 40,
    title: "Add teammates",
    payoff: "Watchers see progress without asking you for updates.",
    href: `${base}?tab=members`,
  });

  return items.sort((a, b) => b.weight - a.weight);
}
