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
  budget: number;
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
  turnoverRequired: number;
  turnoverAccepted: number;
  punchOpen: number;
  // Delegation
  intakeLinkCount: number;
  membersCount: number;
}

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

  // Cost health: CPI-centered when available, else budget-vs-spent sanity.
  if (s.cpi != null && s.cpi > 0) {
    parts.push({
      label: "Cost", score: clamp(s.cpi * 100, 0, 120) > 100 ? 100 : clamp(s.cpi * 100),
      detail: s.cpi >= 1 ? `CPI ${s.cpi.toFixed(2)} — getting more done per dollar than planned` : `CPI ${s.cpi.toFixed(2)} — spending faster than earning`,
    });
  } else if (s.budget > 0) {
    const burned = s.spent / s.budget;
    parts.push({
      label: "Cost", score: burned <= 1 ? 100 - clamp((burned - 0.85) * 400, 0, 40) : clamp(100 - (burned - 1) * 200),
      detail: `${Math.round(burned * 100)}% of budget spent`,
    });
  } else {
    parts.push({ label: "Cost", score: null, detail: "No budget set yet" });
  }

  // Schedule health.
  if (s.milestoneCount > 0) {
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

  // Controls discipline: change orders relative to budget.
  if (s.budget > 0 && (s.approvedCoAmount > 0 || s.openChangeOrders > 0)) {
    const growth = s.approvedCoAmount / s.budget;
    parts.push({
      label: "Change control",
      score: clamp(100 - growth * 400 - s.openChangeOrders * 5),
      detail: `${Math.round(growth * 100)}% budget growth via change orders · ${s.openChangeOrders} open`,
    });
  } else {
    parts.push({ label: "Change control", score: s.budget > 0 ? 100 : null, detail: s.budget > 0 ? "No change orders" : "Needs a budget first" });
  }

  // Quality & closeout readiness.
  if (s.checklistCount > 0 || s.turnoverRequired > 0) {
    const clDone = s.checklistOpenItems + s.checklistNeedsEvidence === 0;
    const toRatio = s.turnoverRequired > 0 ? s.turnoverAccepted / s.turnoverRequired : 1;
    parts.push({
      label: "Quality",
      score: clamp((clDone ? 60 : Math.max(0, 60 - (s.checklistNeedsEvidence + s.checklistOpenItems) * 4)) + toRatio * 40 - s.punchOpen * 2),
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

/** The "what do I feed you" ruleset. Returns items sorted most-valuable
 *  first. Every rule states its payoff — no nagging without a reason. */
export function buildCoachItems(s: ProjectStateSnapshot, projectId: string): CoachItem[] {
  const base = `/projects/${projectId}`;
  const items: CoachItem[] = [];
  const add = (i: CoachItem) => items.push(i);

  if (s.budget <= 0) add({
    id: "budget", kind: "cost", weight: 100,
    title: "Add a budget (2 min)",
    payoff: "Unlocks the burn bar, the S-curve, and the finish-cost forecast.",
    href: `${base}?tab=costs`,
  });
  if (s.milestoneCount === 0) add({
    id: "schedule", kind: "schedule", weight: 95,
    title: "Add a schedule — import a file or type a few milestones",
    payoff: "Unlocks the execution board, overdue alerts, and schedule health (SPI).",
    href: `${base}?tab=schedule`,
  });
  if (s.pendingCostDocs > 0) add({
    id: "confirm-docs", kind: "cost", weight: 92,
    title: `Review ${s.pendingCostDocs} read document${s.pendingCostDocs === 1 ? "" : "s"} waiting for your confirmation`,
    payoff: "Confirmed quotes join the bid comparison; confirmed invoices post as spend.",
    href: `${base}?tab=costs`,
  });
  if (s.quoteCount > 0 && s.unawardedRfqGroups > 0) add({
    id: "award", kind: "cost", weight: 88,
    title: "Pick a winner in the bid comparison",
    payoff: "The award posts the contract to your budget automatically.",
    href: `${base}?tab=costs`,
  });
  if (s.budget > 0 && s.accountCount > 0 && s.accountsPinned === 0 && s.milestoneCount > 0) add({
    id: "pin-ev", kind: "cost", weight: 80,
    title: "Pin budget lines to schedule tasks",
    payoff: "Unlocks Cost health (CPI) — earned value against real progress.",
    href: `${base}?tab=costs`,
  });
  if (s.milestoneCount > 0 && !s.hasBaseline) add({
    id: "baseline", kind: "schedule", weight: 72,
    title: "Set a schedule baseline",
    payoff: "Drift becomes visible — you'll see slips against the original plan.",
    href: `${base}?tab=schedule`,
  });
  if (!s.hasSow) add({
    id: "sow", kind: "setup", weight: 64,
    title: "Attach a Summary of Work",
    payoff: "Feeds RFQs, checklist assessments, and the project report.",
    href: `${base}?tab=quality`,
  });
  if (!s.hasPurpose || !s.hasGoals) add({
    id: "purpose", kind: "setup", weight: 58,
    title: "Write the purpose & goals (from the wizard's skipped step)",
    payoff: "Everyone who opens the project knows why it exists.",
    href: base,
  });
  if (s.checklistCount === 0) add({
    id: "checklist", kind: "quality", weight: 55,
    title: "Upload a PSSR / QA-QC checklist",
    payoff: "The system reads it, works out what applies to THIS job, and tracks the gaps for you.",
    href: `${base}?tab=quality`,
  });
  if (s.checklistNeedsEvidence > 0) add({
    id: "evidence", kind: "quality", weight: 76,
    title: `Provide evidence for ${s.checklistNeedsEvidence} checklist item${s.checklistNeedsEvidence === 1 ? "" : "s"}`,
    payoff: "Each one auto-greens the moment its document lands.",
    href: `${base}?tab=quality`,
  });
  if (s.turnoverRequired > 0 && s.turnoverAccepted < s.turnoverRequired) add({
    id: "turnover", kind: "quality", weight: 68,
    title: `Chase the turnover package — ${s.turnoverRequired - s.turnoverAccepted} item${s.turnoverRequired - s.turnoverAccepted === 1 ? "" : "s"} outstanding`,
    payoff: "Closeout is gated on acceptance; contractors are scored on it.",
    href: `${base}?tab=quality`,
  });
  if (s.partyCount === 0 && s.budget > 0) add({
    id: "parties", kind: "delegation", weight: 50,
    title: "Add the companies working this job",
    payoff: "Spending gets attributed, and their performance record starts building.",
    href: `${base}?tab=costs`,
  });
  if (s.intakeLinkCount === 0 && s.partyCount > 0) add({
    id: "links", kind: "delegation", weight: 46,
    title: "Send contractors their upload links",
    payoff: "Their documents and quotes land here and process themselves.",
    href: `${base}?tab=intake`,
  });
  if (s.membersCount <= 1) add({
    id: "members", kind: "delegation", weight: 40,
    title: "Add teammates",
    payoff: "Watchers see progress without asking you for updates.",
    href: `${base}?tab=members`,
  });

  return items.sort((a, b) => b.weight - a.weight);
}
