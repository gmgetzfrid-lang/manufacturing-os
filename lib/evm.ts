// lib/evm.ts
//
// Earned Value Management — the core math of project controls.
//
// This is the cost-AND-schedule engine that lib/milestones.ts deliberately
// left out ("we don't have cost, so SPI is the only index"). Here we close
// that gap: given a budget and an actual cost, we compute the full standard
// metric set a project controls professional reads — the same numbers ISO
// 21502 / ANSI-EIA-748 (the EVMS standard) and ASME project controls expect:
//
//   PV  Planned Value   (BCWS) — budgeted cost of work SCHEDULED
//   EV  Earned Value    (BCWP) — budgeted cost of work PERFORMED
//   AC  Actual Cost     (ACWP) — what the performed work actually cost
//   BAC Budget At Completion   — the total approved budget
//
//   SV  = EV − PV        Schedule Variance     (>0 ahead of schedule)
//   CV  = EV − AC        Cost Variance         (>0 under budget)
//   SPI = EV / PV        Schedule Perf. Index  (≥1 on/ahead)
//   CPI = EV / AC        Cost Perf. Index      (≥1 on/under budget)
//
//   EAC  Estimate At Completion (three industry methods — see below)
//   ETC  Estimate To Complete   = EAC − AC
//   VAC  Variance At Completion = BAC − EAC   (>0 forecast under budget)
//   TCPI To-Complete Perf. Index — the efficiency you must now hit
//
// Everything here is PURE and dependency-light (one type import + one helper
// import), so it is unit-tested in isolation exactly like lib/scheduleProgress
// and lib/criticalPath. No I/O. The persistence + Supabase wiring lives in
// lib/projectControls.ts; the schedule-derivation below takes a plain milestone
// array and a plain cost model so it stays testable.

import type { Milestone } from "@/types/schema";
import { leafPercent } from "@/lib/scheduleProgress";

// ─── Raw inputs ──────────────────────────────────────────────────

/** The four numbers every earned-value computation reduces to. */
export interface EvmInputs {
  /** Budget At Completion — total approved budget. */
  bac: number;
  /** Planned Value (BCWS) — budgeted cost of work scheduled to date. */
  pv: number;
  /** Earned Value (BCWP) — budgeted cost of work actually performed. */
  ev: number;
  /** Actual Cost (ACWP) — what the performed work actually cost.
   *  Null when no actuals have been logged yet: cost indices (CPI, CV,
   *  EAC, TCPI) are then undefined and reported as such rather than faked. */
  ac: number | null;
}

/** A traffic-light verdict for an index or variance. */
export type EvmHealth = "ahead" | "on_track" | "watch" | "critical" | "unknown";

export interface EvmResult extends EvmInputs {
  // ── Variances (absolute, in currency) ──
  /** Schedule Variance = EV − PV. >0 ahead, <0 behind. */
  sv: number;
  /** Cost Variance = EV − AC. >0 under budget, <0 over. Null without AC. */
  cv: number | null;
  /** Variance At Completion = BAC − EAC. >0 forecast under budget. */
  vac: number | null;

  // ── Performance indices (dimensionless, 1.0 = on plan) ──
  /** Schedule Performance Index = EV / PV. Null when PV = 0. */
  spi: number | null;
  /** Cost Performance Index = EV / AC. Null when AC missing or 0. */
  cpi: number | null;

  // ── Forecasts ──
  /** EAC = BAC / CPI — assumes current cost efficiency holds (the
   *  default, most-cited method). Null without CPI. */
  eacCpi: number | null;
  /** EAC = AC + (BAC − EV) — assumes the overrun was a one-off and the
   *  rest of the work runs at budget. Null without AC. */
  eacBudgetRate: number | null;
  /** EAC = AC + (BAC − EV) / (CPI × SPI) — remaining work is dragged by
   *  BOTH cost and schedule performance. The most conservative. */
  eacComposite: number | null;
  /** Estimate To Complete = EAC − AC, using the headline EAC. */
  etc: number | null;

  // ── To-complete efficiency ──
  /** TCPI to finish on the original BAC = (BAC − EV) / (BAC − AC). */
  tcpiBac: number | null;
  /** TCPI to finish at the forecast EAC = (BAC − EV) / (EAC − AC). */
  tcpiEac: number | null;

  // ── Progress ratios (0..1) ──
  /** EV / BAC — physical % complete. */
  percentComplete: number;
  /** AC / BAC — % of budget spent. */
  percentSpent: number | null;
  /** PV / BAC — % of work that should be done by now. */
  percentScheduled: number;

  // ── Verdicts ──
  scheduleHealth: EvmHealth;
  costHealth: EvmHealth;
  /** True when SPI or CPI has dropped below 1.00 — the "alert management
   *  instantly" trigger for the real-time variance engine. */
  alert: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const safeDiv = (a: number, b: number): number | null =>
  b === 0 || !Number.isFinite(b) ? null : a / b;

/**
 * Classify a performance index against the 1.0 line. Variances feed in as a
 * ratio too (caller passes 1 + variance/base). Thresholds match how a
 * controls manager reads a project: ≥1.05 ahead, ≥1.00 on track, ≥0.90 a
 * watch item, below that critical.
 */
export function healthOfIndex(index: number | null): EvmHealth {
  if (index == null || !Number.isFinite(index)) return "unknown";
  if (index >= 1.05) return "ahead";
  if (index >= 1.0) return "on_track";
  if (index >= 0.9) return "watch";
  return "critical";
}

/**
 * The whole point of the module: turn {BAC, PV, EV, AC} into every derived
 * earned-value metric. Defensive against divide-by-zero (returns null rather
 * than Infinity/NaN) so the UI can honestly render "—" for an undefined index.
 */
export function computeEvm(input: EvmInputs): EvmResult {
  const bac = Number.isFinite(input.bac) ? input.bac : 0;
  const pv = Number.isFinite(input.pv) ? input.pv : 0;
  const ev = Number.isFinite(input.ev) ? input.ev : 0;
  const ac = input.ac != null && Number.isFinite(input.ac) ? input.ac : null;

  const sv = ev - pv;
  const cv = ac == null ? null : ev - ac;
  const spi = safeDiv(ev, pv);
  const cpi = ac == null ? null : safeDiv(ev, ac);

  // Forecasts.
  const eacCpi = cpi == null || cpi === 0 ? null : bac / cpi;
  const eacBudgetRate = ac == null ? null : ac + (bac - ev);
  const eacComposite =
    ac == null || cpi == null || spi == null || cpi * spi === 0
      ? null
      : ac + (bac - ev) / (cpi * spi);
  // Headline EAC: prefer the CPI method (the standard default), fall back to
  // the budget-rate method, so ETC/VAC still populate the moment AC exists.
  const eacHeadline = eacCpi ?? eacBudgetRate;
  const etc = eacHeadline == null || ac == null ? null : eacHeadline - ac;
  const vac = eacHeadline == null ? null : bac - eacHeadline;

  const tcpiBac = ac == null ? null : safeDiv(bac - ev, bac - ac);
  const tcpiEac =
    ac == null || eacHeadline == null ? null : safeDiv(bac - ev, eacHeadline - ac);

  const percentComplete = bac > 0 ? ev / bac : 0;
  const percentSpent = ac == null ? null : bac > 0 ? ac / bac : 0;
  const percentScheduled = bac > 0 ? pv / bac : 0;

  const scheduleHealth = healthOfIndex(spi);
  const costHealth = ac == null ? "unknown" : healthOfIndex(cpi);
  const alert =
    (spi != null && spi < 1.0) || (cpi != null && cpi < 1.0);

  return {
    bac: round2(bac),
    pv: round2(pv),
    ev: round2(ev),
    ac: ac == null ? null : round2(ac),
    sv: round2(sv),
    cv: cv == null ? null : round2(cv),
    vac: vac == null ? null : round2(vac),
    spi: spi == null ? null : round2(spi),
    cpi: cpi == null ? null : round2(cpi),
    eacCpi: eacCpi == null ? null : round2(eacCpi),
    eacBudgetRate: eacBudgetRate == null ? null : round2(eacBudgetRate),
    eacComposite: eacComposite == null ? null : round2(eacComposite),
    etc: etc == null ? null : round2(etc),
    tcpiBac: tcpiBac == null ? null : round2(tcpiBac),
    tcpiEac: tcpiEac == null ? null : round2(tcpiEac),
    percentComplete: round2(percentComplete),
    percentSpent: percentSpent == null ? null : round2(percentSpent),
    percentScheduled: round2(percentScheduled),
    scheduleHealth,
    costHealth,
    alert,
  };
}

// ─── Cost model + schedule derivation ────────────────────────────
//
// The live project EVM is derived from the schedule the team already
// maintains (lib/milestones.ts) plus a small cost model. We deliberately
// reuse the schedule's work-hours as the unit of value — exactly as the
// existing SPI rollup does — and convert to currency with a blended labor
// rate, so no per-task cost entry is required to get going. A budget
// override and an actual-cost-to-date figure let a controls manager refine
// the picture as real numbers come in.

export interface CostModel {
  /** Blended all-in labor rate, currency per work-hour. Converts the
   *  schedule's hours into PV/EV/BAC. */
  blendedRate: number;
  /** Manual Budget At Completion override. When null, BAC is derived from
   *  Σ(work-hours) × blendedRate. */
  budgetOverride?: number | null;
  /** Actual cost incurred to date (ACWP). Null until logged — keeps cost
   *  indices honestly undefined rather than zero. */
  actualCost?: number | null;
  /** ISO 4217 code, display only. */
  currency?: string;
}

export interface ScheduleEvm {
  inputs: EvmInputs;
  result: EvmResult;
  /** Leaf tasks that carry work-hours (and so contribute to cost). */
  costedLeaves: number;
  /** Leaf tasks with no hours — excluded from the cost rollup. Surfaced so
   *  the dashboard can tell the user the picture is partial. */
  uncostedLeaves: number;
  totalHours: number;
  earnedHours: number;
  scheduledHours: number;
  blendedRate: number;
  currency: string;
  /** True when AC was supplied — i.e. cost indices are real. */
  hasActualCost: boolean;
}

const hoursOf = (m: Milestone) =>
  typeof m.durationHours === "number" && m.durationHours > 0 ? m.durationHours : 0;
const startMs = (m: Milestone) =>
  Date.parse((m.plannedStartAt as string | undefined) ?? (m.plannedAt as string));
const finishMs = (m: Milestone) => Date.parse(m.plannedAt as string);

/**
 * Fraction of a task that SHOULD be done by `now`, time-phased linearly
 * between its planned start and finish (0 before it starts, 1 once its
 * finish has passed). This is what makes PV a real S-curve point rather than
 * the cruder "full weight the instant planned_at passes" step the legacy SPI
 * widget uses.
 */
export function scheduledFraction(m: Milestone, now: number): number {
  const s = startMs(m);
  const f = finishMs(m);
  if (!Number.isFinite(f)) return 0;
  if (now >= f) return 1;
  if (!Number.isFinite(s) || s >= f) return now >= f ? 1 : 0; // milestone / zero-duration
  if (now <= s) return 0;
  return (now - s) / (f - s);
}

/**
 * Derive {BAC, PV, EV, AC} from the schedule + a cost model, then run the
 * full EVM. Work-hours are the unit of value (matching the existing rollup);
 * blended rate converts to currency. Leaf tasks only — summary rows are
 * envelopes of their children and would double-count.
 */
export function deriveEvmFromSchedule(
  milestones: Milestone[],
  model: CostModel,
  opts?: { now?: Date },
): ScheduleEvm {
  const now = (opts?.now ?? new Date()).getTime();
  const rate = Number.isFinite(model.blendedRate) && model.blendedRate > 0 ? model.blendedRate : 0;
  const currency = model.currency || "USD";

  const parentIds = new Set<string>();
  for (const m of milestones) if (m.parentId) parentIds.add(m.parentId);
  const isLeaf = (m: Milestone) => !(m.id && parentIds.has(m.id));

  let totalHours = 0;
  let earnedHours = 0;
  let scheduledHours = 0;
  let costedLeaves = 0;
  let uncostedLeaves = 0;

  for (const m of milestones) {
    if (!isLeaf(m)) continue;
    const h = hoursOf(m);
    if (h <= 0) {
      uncostedLeaves++;
      continue;
    }
    costedLeaves++;
    totalHours += h;
    earnedHours += h * (leafPercent(m) / 100);
    scheduledHours += h * scheduledFraction(m, now);
  }

  const derivedBac = totalHours * rate;
  const bac =
    model.budgetOverride != null && Number.isFinite(model.budgetOverride) && model.budgetOverride > 0
      ? model.budgetOverride
      : derivedBac;
  // PV/EV are the BAC spread across the work BY HOURS — earned hours give EV,
  // schedule-phased hours give PV. Deriving from the hour-fractions (rather
  // than hours × rate) keeps the schedule indices correct even when BAC is a
  // manual override and no blended rate is set: the rate only matters for
  // turning hours into the derived BAC. When rate > 0 and no override, this is
  // algebraically identical to scheduledHours × rate.
  const earnedFraction = totalHours > 0 ? earnedHours / totalHours : 0;
  const scheduledFractionAll = totalHours > 0 ? scheduledHours / totalHours : 0;
  const pv = bac * scheduledFractionAll;
  const ev = bac * earnedFraction;
  const ac = model.actualCost != null && Number.isFinite(model.actualCost) ? model.actualCost : null;

  const inputs: EvmInputs = { bac, pv, ev, ac };
  return {
    inputs,
    result: computeEvm(inputs),
    costedLeaves,
    uncostedLeaves,
    totalHours: round2(totalHours),
    earnedHours: round2(earnedHours),
    scheduledHours: round2(scheduledHours),
    blendedRate: rate,
    currency,
    hasActualCost: ac != null,
  };
}

// ─── Change-order sandbox ────────────────────────────────────────
//
// "Simulate the cost and schedule impact of a proposed change before it gets
// injected into the live baseline." A change order adds (or removes) scope:
// more budgeted work (Δhours → ΔBAC and ΔPV/ΔEV as it's planned/done) and a
// schedule push (Δdays). We model the BEFORE and AFTER EVM so a manager sees
// the delta without touching the real schedule.

export interface ChangeOrder {
  /** Added budgeted work, in currency. Negative = de-scope / credit. */
  addedBudget: number;
  /** Of the added budget, how much is already performed (earned) — usually
   *  0 for a brand-new change, but a retro change order may book some. */
  addedEarned?: number;
  /** Actual cost already incurred against this change. */
  addedActualCost?: number;
  /** Of the added budget, how much is already scheduled-to-date (PV). */
  addedPlanned?: number;
  /** Calendar days the change pushes (or pulls, if negative) the finish. */
  scheduleDays?: number;
}

export interface ChangeOrderImpact {
  before: EvmResult;
  after: EvmResult;
  deltaBac: number;
  deltaEac: number | null;
  /** Days added to the finish — passed straight through for the UI to apply
   *  to the projected end date. */
  scheduleDays: number;
}

/**
 * Project the EVM picture if a change order were approved. Pure — does not
 * mutate the schedule; the dashboard applies `scheduleDays` to the forecast
 * finish for display.
 */
export function simulateChangeOrder(base: EvmInputs, change: ChangeOrder): ChangeOrderImpact {
  const before = computeEvm(base);
  const after = computeEvm({
    bac: base.bac + change.addedBudget,
    pv: base.pv + (change.addedPlanned ?? 0),
    ev: base.ev + (change.addedEarned ?? 0),
    ac:
      base.ac == null && !change.addedActualCost
        ? null
        : (base.ac ?? 0) + (change.addedActualCost ?? 0),
  });
  return {
    before,
    after,
    deltaBac: round2(change.addedBudget),
    deltaEac:
      before.eacCpi != null && after.eacCpi != null
        ? round2(after.eacCpi - before.eacCpi)
        : after.eacBudgetRate != null && before.eacBudgetRate != null
        ? round2(after.eacBudgetRate - before.eacBudgetRate)
        : null,
    scheduleDays: change.scheduleDays ?? 0,
  };
}

// ─── Input parsing + formatting ──────────────────────────────────

/**
 * Parse a currency/number input field. Empty or non-numeric ⇒ null, but a
 * legitimately-entered 0 is PRESERVED (0 means "zero", not "unset"). Shared by
 * the EVM calculator and the cost-model editor so the two can't diverge on
 * whether a typed 0 is kept or dropped.
 */
export function parseAmount(s: string): number | null {
  if (s == null || s.trim() === "") return null;
  const n = Number(s.replace(/[, $]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Compact currency for dashboard tiles ($1.2M, $840K, $1,250). */
export function formatMoney(n: number | null | undefined, currency = "USD"): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  let body: string;
  if (abs >= 1_000_000) body = `${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  else if (abs >= 10_000) body = `${(abs / 1_000).toFixed(0)}K`;
  else body = abs.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const sym = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  return `${sign}${sym}${body}`;
}

/** Full-precision currency for tooltips / the report ($1,234,567). */
export function formatMoneyFull(n: number | null | undefined, currency = "USD"): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sym = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  return `${n < 0 ? "-" : ""}${sym}${Math.abs(Math.round(n)).toLocaleString()}`;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$", CAD: "$", AUD: "$", EUR: "€", GBP: "£", JPY: "¥", MXN: "$", INR: "₹",
};
