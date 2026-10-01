// lib/projectReport.ts — the PROJECT REPORT (boss brief) and the
// lessons-learned draft.
//
// One click, one printable page that answers the boss's four questions:
// what is this, where's the money, where's the schedule, is the quality
// program clean. Every number comes from rows the platform already holds —
// the report is a view, never a second bookkeeping system. The
// lessons-learned draft is auto-written from the project's exhaust (change
// orders by reason, schedule slips, rejected turnover, punch history) so
// closeout starts from facts, and a human edits it into the record.
//
// A read that FAILS is named (`readFailures`, labelled as the health
// snapshot labels it) and its part of the page says so — a refused cost
// read never prints as a $0 ledger, a refused schedule read never as "No
// schedule loaded".

import { supabase } from "@/lib/supabase";
import { listAccounts, listEntries, computeCostRollup, milestonePctIndex, fmtMoney } from "@/lib/costs";
import {
  listChangeOrders, summarizeChangeOrders, approvedChangesByAccount, CO_REASON_LABEL, type CoReason,
} from "@/lib/changeOrders";
import { listTurnoverItems, computeTurnoverProgress } from "@/lib/turnover";
import { listChecklists, listChecklistItems, computeChecklistProgress } from "@/lib/checklists";
import { computeForecast, scheduleSpanFromMilestones } from "@/lib/costSeries";
import { openPrintWindow } from "@/lib/evidencePack";
import { liveMilestones, isImportedMilestone, isOverdueMilestone, PROJECT_MILESTONE_READ_LIMIT } from "@/lib/milestoneLiveness";
import { SNAPSHOT_READS as R } from "@/lib/projectHealth";
import { MISSING_TABLE_CODES } from "@/lib/projectSnapshot";

async function safe<T>(p: PromiseLike<T>, fallback: T): Promise<T> {
  try { return await p; } catch { return fallback; }
}

/** The reads the Money section is computed from. If any of them fails, the
 *  section prints that it could not be read — never a zero ledger, and
 *  never a budget that silently dropped its approved change orders. */
export const REPORT_COST_READS: readonly string[] = [R.costAccounts, R.costEntries, R.changeOrders];

/** The completion audit row's read label. */
export const REPORT_CLOSEOUT_READ = "completion record";

/** "a", "a and b", "a, b and c". */
function listJoin(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

export interface ReportGateLine { text: string; ok: boolean | null }

/** What was open when the project was completed — the gate snapshot the
 *  override audit row carries (projects-tab SAF-14). Rendered as recorded;
 *  the live figures above it are today's rows. */
export interface ReportCloseout {
  at: string | null;
  reason: string | null;
  gates: ReportGateLine[];
}

export interface ReportData {
  project: Record<string, unknown>;
  rollup: ReturnType<typeof computeCostRollup>;
  forecastSentence: string | null;
  /** COST-1: which part of the budget a CPI-based forecast covers — the
   *  note the Costs tab prints beside the same sentence. */
  forecastScopeNote: string | null;
  cos: ReturnType<typeof summarizeChangeOrders>;
  milestones: Array<{ name: string; planned_at: string | null; status: string; imported: boolean }>;
  /** How many milestone rows the project has. Larger than
   *  `milestones.length` only when the schedule exceeds
   *  PROJECT_MILESTONE_READ_LIMIT — the report then says "first N of M". */
  milestoneTotal: number;
  overdue: number;
  turnover: ReturnType<typeof computeTurnoverProgress>;
  checklistLines: Array<{ title: string; kind: string; satisfied: number; applicable: number; needsEvidence: number; complete: boolean }>;
  punchOpen: number;
  parties: Array<{ name: string; kind: string | null; trade: string | null }>;
  closeout: ReportCloseout | null;
  /** Reads that failed, by label (SNAPSHOT_READS' labels, plus
   *  REPORT_CLOSEOUT_READ). The figures they would feed are zeros standing
   *  in for "unknown"; the renderer and the draft say so instead of printing
   *  them. The checklist and turnover readers (lib/checklists.ts,
   *  lib/turnover.ts) still return [] on a refused read, so their failures
   *  cannot be named here yet. */
  readFailures: string[];
}

/**
 * Read a recorded gate snapshot tolerantly. The override audit row's
 * `details` carries it under `gates` (an array of `{ text, ok }` lines, or a
 * keyed object of booleans / `{ ok, text }` entries); anything else is
 * rendered as text so a recorded fact is never dropped on the floor.
 */
export function parseGateSnapshot(details: unknown): ReportGateLine[] | null {
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  const raw = d.gates ?? d.gateSnapshot ?? d.closeoutGates ?? d.closeout_gates;
  if (raw == null) return null;
  const line = (key: string | null, v: unknown): ReportGateLine | null => {
    if (typeof v === "boolean") return { text: key ?? String(v), ok: v };
    if (typeof v === "string" || typeof v === "number") return { text: key ? `${key}: ${v}` : String(v), ok: null };
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const text = [o.text, o.label, o.name].find((x) => typeof x === "string") as string | undefined;
      const okRaw = [o.ok, o.passed, o.pass].find((x) => typeof x === "boolean") as boolean | undefined;
      const detail = [o.detail, o.count, o.value].find((x) => typeof x === "string" || typeof x === "number");
      const base = text ?? key ?? "";
      if (!base && detail == null) return null;
      return { text: detail != null && text !== undefined ? `${base} — ${detail}` : base || String(detail), ok: okRaw ?? null };
    }
    return null;
  };
  const out: ReportGateLine[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) { const l = line(null, v); if (l) out.push(l); }
  } else if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) { const l = line(k, v); if (l) out.push(l); }
  } else {
    const l = line(null, raw); if (l) out.push(l);
  }
  return out;
}

export async function gatherReportData(orgId: string, projectId: string): Promise<ReportData> {
  const readFailures: string[] = [];
  const fail = (label: string) => { if (!readFailures.includes(label)) readFailures.push(label); };
  /** For a table migration 20261013 creates (`since20261013`), "relation
   *  does not exist" is the known pre-migration state, not a failed read:
   *  no row can exist, so the empty fallback is the truth (as the snapshot
   *  names it in notMigrated rather than readFailures). */
  const notYetCreated = (e: unknown, since20261013: boolean) => {
    const code = (e as { code?: string | null } | null)?.code;
    return since20261013 && !!code && MISSING_TABLE_CODES.has(code);
  };
  /** A list function that THROWS on a failed read (REL-2): the throw names
   *  the read and yields the fallback, which the renderer then does not
   *  print as a figure. */
  const named = async <T>(label: string, p: PromiseLike<T>, fallback: T, since20261013 = false): Promise<T> => {
    try { return await p; } catch (e) { if (!notYetCreated(e, since20261013)) fail(label); return fallback; }
  };
  /** A direct PostgREST read: a returned or thrown error names the read. */
  const direct = async <T>(
    label: string, q: PromiseLike<{ data: unknown; error: { code?: string | null } | null }>, fallback: T, since20261013 = false,
  ): Promise<T> => {
    try {
      const r = await q;
      if (r.error) { if (!notYetCreated(r.error, since20261013)) fail(label); return fallback; }
      return ((r.data ?? fallback) as T);
    } catch { fail(label); return fallback; }
  };
  const [projRow, accounts, entries, coList, msRows, turnoverItems, checklists, punchRows, partyRows, closeoutRows] = await Promise.all([
    safe(supabase.from("projects").select("*").eq("id", projectId).maybeSingle().then((r) => r.data), null),
    named(R.costAccounts, listAccounts(orgId, projectId), []),
    named(R.costEntries, listEntries(orgId, projectId), []),
    // The change orders as the Costs tab reads them: listChangeOrders
    // carries each approved CO's linked-entry status, so the approved
    // changes below count only money that is on the ledger.
    named(R.changeOrders, listChangeOrders(projectId), [], true),
    // The same first rows by planned date the snapshot and the Costs tab
    // read (PROJECT_MILESTONE_READ_LIMIT), so the EV index — and the CPI —
    // agree; the exact count discloses a larger schedule.
    named(R.milestones, supabase.from("milestones").select("id, name, planned_at, planned_start_at, status, percent_complete, source", { count: "exact" })
      .eq("project_id", projectId).order("planned_at").order("id").limit(PROJECT_MILESTONE_READ_LIMIT)
      .then((r) => {
        if (r.error) throw new Error(r.error.message);
        return { rows: (r.data ?? []) as Array<Record<string, unknown>>, total: r.count ?? (r.data ?? []).length };
      }),
      { rows: [] as Array<Record<string, unknown>>, total: 0 }),
    safe(listTurnoverItems(orgId, projectId), []),
    safe(listChecklists(orgId, projectId), []),
    direct<Array<{ status: string }>>(R.punch,
      supabase.from("punch_items").select("status").eq("project_id", projectId).limit(500), [], true),
    direct<Array<{ name: string; kind: string | null; trade: string | null }>>(R.parties,
      supabase.from("project_parties").select("name, kind, trade").eq("project_id", projectId).limit(100), []),
    // The completion override's audit row — newest first; its details carry
    // the gate snapshot once lib/projects.ts records one (SAF-14).
    direct<Array<{ timestamp: string | null; details: unknown }>>(REPORT_CLOSEOUT_READ,
      supabase.from("audit_logs").select("timestamp, details")
        .eq("resource_type", "project").eq("resource_id", projectId).eq("action", "PROJECT_COMPLETED")
        .order("timestamp", { ascending: false }).limit(1), []),
  ]);
  const project = (projRow ?? {}) as Record<string, unknown>;

  // Every stored milestone counts — imported rows are commitments
  // (lib/milestoneLiveness). The EV index is keyed by the real milestone
  // id so pinned accounts resolve, and the on-ledger approved change orders
  // revise the budget EV is earned against — exactly the Costs tab's inputs
  // (CostsTab.tsx: computeCostRollup(…, approvedChangesByAccount(cos))).
  const live = liveMilestones(msRows.rows as Array<Record<string, unknown> & { source?: string | null }>);
  const pctIdx = milestonePctIndex(live.map((m) => ({
    id: String(m.id), percentComplete: (m.percent_complete as number | null) ?? null, status: String(m.status ?? "planned"),
  })));
  const rollup = computeCostRollup(accounts, entries, pctIdx, approvedChangesByAccount(coList));

  // The forecast takes the Costs tab's inputs too (CostCharts.tsx): the
  // REVISED budget and the pinned subset CPI was measured on (COST-1), over
  // the Costs tab's span — earliest task START to latest finish (MON-2) —
  // so the run-rate forecast on paper divides by the same elapsed share.
  const span = scheduleSpanFromMilestones(live.map((m) => ({
    planned_at: (m.planned_at as string | null) ?? null, planned_start_at: (m.planned_start_at as string | null) ?? null,
  })));
  const forecast = computeForecast({
    budget: rollup.revisedBudget, spent: rollup.spent, cpi: rollup.cpi,
    pinnedBudget: rollup.pinnedBudget, pinnedSpent: rollup.pinnedSpent,
    scheduleStart: span.start, scheduleEnd: span.end,
    today: new Date().toISOString().slice(0, 10),
    fmt: (n) => fmtMoney(n, rollup.currencies[0] ?? "USD"),
  });

  const now = Date.now();
  const checklistLines: ReportData["checklistLines"] = [];
  for (const c of checklists.filter((c) => c.status !== "void").slice(0, 10)) {
    const items = await safe(listChecklistItems(c.id), []);
    const p = computeChecklistProgress(items);
    checklistLines.push({
      title: c.title, kind: c.kind,
      satisfied: p.satisfied, applicable: p.applicable, needsEvidence: p.needsEvidence,
      complete: c.status === "complete",
    });
  }

  return {
    project,
    rollup,
    forecastSentence: forecast.sentence,
    forecastScopeNote: forecast.scopeNote,
    cos: summarizeChangeOrders(coList),
    milestones: live.map((m) => ({
      name: String(m.name ?? ""), planned_at: (m.planned_at as string | null) ?? null, status: String(m.status ?? "planned"),
      imported: isImportedMilestone(m),
    })),
    milestoneTotal: Math.max(msRows.total, live.length),
    overdue: live.filter((m) => isOverdueMilestone(m as { planned_at?: string | null; status?: string | null }, now)).length,
    turnover: computeTurnoverProgress(turnoverItems),
    checklistLines,
    punchOpen: punchRows.filter((p) => p.status === "open").length,
    parties: partyRows,
    closeout: (() => {
      const row = closeoutRows[0];
      if (!row) return null;
      const details = (row.details && typeof row.details === "object") ? row.details as Record<string, unknown> : {};
      return {
        at: row.timestamp ?? null,
        reason: typeof details.reason === "string" ? details.reason : null,
        gates: parseGateSnapshot(details) ?? [],
      };
    })(),
    readFailures,
  };
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderReportHtml(d: ReportData): string {
  const p = d.project;
  const cur = d.rollup.currencies[0] ?? "USD";
  const money = (n: number) => fmtMoney(n, cur);
  const goals = Array.isArray(p.goals) ? (p.goals as string[]) : [];
  const today = new Date().toLocaleDateString();

  const row = (label: string, value: string) =>
    `<tr><td class="k">${esc(label)}</td><td>${value}</td></tr>`;
  const truncated = d.milestoneTotal > d.milestones.length;
  const firstOf = `first ${d.milestones.length} of ${d.milestoneTotal} by planned date`;
  const failed = new Set(d.readFailures);
  const couldNotRead = `<span class="muted">Could not read</span>`;
  const r = d.rollup;
  const signed = (n: number) => `${n > 0 ? "+" : "−"} ${esc(money(Math.abs(n)))}`;

  // Money: every figure, or — if the ledger could not be read — one line
  // saying so. Never a $0 ledger standing in for a refused read.
  const costFailed = d.readFailures.filter((x) => REPORT_COST_READS.includes(x));
  const pinned = r.accounts.some((a) => !!a.account.wbsMilestoneId);
  const moneyRows = costFailed.length > 0
    ? row("Cost ledger", `<span class="flag">Could not read ${esc(listJoin(costFailed))}</span> — the money figures are left out, not printed as zero.`)
    : [
      row("Budget", `<span class="num">${esc(money(r.revisedBudget))}</span>${r.approvedChanges !== 0 ? ` <span class="muted">— ${esc(money(r.budget))} baseline ${signed(r.approvedChanges)} approved change orders</span>` : ""}`),
      row("Committed (promised)", `<span class="num">${esc(money(r.committed))}</span>`),
      row("Spent (real money out)", `<span class="num">${esc(money(r.spent))}</span>`),
      row("Budget less spent", `<span class="num ${r.remainingActualsOnly < 0 ? "flag" : "ok"}">${esc(money(r.remainingActualsOnly))}</span> <span class="muted">— open commitments are not deducted</span>`),
      row("Available (uncommitted)", `<span class="num ${r.remaining < 0 ? "flag" : "ok"}">${esc(money(r.remaining))}</span> <span class="muted">— budget less spent less ${esc(money(r.openCommitments))} of open commitments not yet invoiced, as on the Costs tab</span>`),
      r.cpi != null
        ? row("Cost performance (CPI)", `<span class="num">${r.cpi.toFixed(2)}</span> — ${r.cpi >= 1 ? "getting more work per dollar than planned" : "spending faster than earning"}${truncated ? ` <span class="muted">— earned value from the ${firstOf} schedule activities, as on the Costs tab</span>` : ""}`)
        : pinned && failed.has(R.milestones)
          ? row("Cost performance (CPI)", `${couldNotRead} <span class="muted">— the schedule its earned value comes from could not be read</span>`)
          : "",
      d.forecastSentence ? row("Forecast", `${esc(d.forecastSentence)}${d.forecastScopeNote ? ` <span class="muted">${esc(d.forecastScopeNote)}</span>` : ""}`) : "",
      d.cos.approvedCount > 0 ? row("Change orders", `<span class="num">${d.cos.approvedCount} approved · ${esc(money(d.cos.approvedAmount))}</span> — ${d.cos.byReason.map((x) => `${esc(CO_REASON_LABEL[x.reason])}: ${esc(money(x.amount))}`).join("; ")}`) : "",
      d.cos.open > 0 ? row("Awaiting decision", `<span class="flag">${d.cos.open} change order${d.cos.open === 1 ? "" : "s"} open</span>`) : "",
    ].join("\n");

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Project report — ${esc(p.name)}</title>
<style>
  body { font: 12px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #111827; margin: 32px auto; max-width: 820px; padding: 0 24px; }
  h1 { font-size: 20px; margin: 0 0 2px; } h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #6b7280; margin: 22px 0 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
  .sub { color: #6b7280; margin-bottom: 4px; }
  table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 3px 10px 3px 0; vertical-align: top; }
  td.k { color: #6b7280; width: 180px; white-space: nowrap; }
  .num { font-variant-numeric: tabular-nums; }
  .flag { color: #b91c1c; font-weight: 700; } .ok { color: #047857; font-weight: 700; }
  .muted { color: #9ca3af; } .badge { display: inline-block; border: 1px solid #d1d5db; border-radius: 4px; padding: 0 5px; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; margin-left: 6px; }
  ul { margin: 4px 0; padding-left: 18px; }
  @media print { body { margin: 0 auto; } }
</style></head><body>
<h1>${esc(p.name)}<span class="badge">${esc(p.status ?? "")}</span></h1>
<div class="sub">Project report · generated ${esc(today)} · owner ${esc(p.owner_user_name ?? "—")}${p.moc_reference ? ` · MOC ${esc(p.moc_reference)}` : ""}</div>
${p.purpose ? `<p><b>Purpose:</b> ${esc(p.purpose)}</p>` : ""}
${goals.length ? `<p><b>Goals:</b></p><ul>${goals.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : ""}
${p.success_criteria ? `<p><b>Success criteria:</b> ${esc(p.success_criteria)}</p>` : ""}

<h2>Money</h2>
<table>
${moneyRows}
</table>

<h2>Schedule</h2>
${failed.has(R.milestones) ? `<p><span class="flag">Could not read the schedule</span> — it is left out, not shown as empty.</p>` : d.milestones.length === 0 ? `<p class="muted">No schedule loaded.</p>` : `
<p>${d.milestones.filter((m) => m.status === "completed").length}/${d.milestones.length} tasks complete${truncated ? ` <span class="muted">(${firstOf} — every figure in this section counts those)</span>` : ""}${d.overdue > 0 ? ` · <span class="flag">${d.overdue} overdue</span>` : ` · <span class="ok">nothing overdue</span>`}${d.milestones.some((m) => m.imported) ? ` · <span class="muted">${d.milestones.filter((m) => m.imported).length} imported from the schedule file</span>` : ""}</p>
<table>${d.milestones.slice(0, 25).map((m) => row(
  m.planned_at ? new Date(m.planned_at).toLocaleDateString() : "—",
  `${esc(m.name)} <span class="muted">— ${esc(m.status.replace("_", " "))}</span>`,
)).join("")}</table>
${d.milestones.length > 25 ? `<p class="muted">…and ${d.milestones.length - 25} more.</p>` : ""}`}

<h2>Quality &amp; closeout</h2>
<table>
${d.checklistLines.length ? d.checklistLines.map((c) => row(
  `${esc(c.title)}`,
  c.complete ? `<span class="ok">Complete</span>`
    : `<span class="num">${c.satisfied}/${c.applicable}</span> satisfied${c.needsEvidence > 0 ? ` · <span class="flag">${c.needsEvidence} need evidence</span>` : ""}`,
)).join("") : row("Checklists", `<span class="muted">None yet</span>`)}
${row("Turnover package", d.turnover.required === 0 ? `<span class="muted">No requirements set</span>`
  : `<span class="num">${d.turnover.accepted}/${d.turnover.required}</span> accepted${d.turnover.outstanding.length > 0 ? ` · outstanding: ${esc(d.turnover.outstanding.slice(0, 6).join(", "))}${d.turnover.outstanding.length > 6 ? "…" : ""}` : ""}`)}
${row("Punch list", failed.has(R.punch) ? couldNotRead : d.punchOpen === 0 ? `<span class="ok">Clear</span>` : `<span class="flag">${d.punchOpen} open</span>`)}
</table>
${d.closeout ? `
<h2>Closeout</h2>
<p>Completed ${d.closeout.at ? esc(new Date(d.closeout.at).toLocaleDateString()) : "—"}${d.closeout.reason ? ` · <i>${esc(d.closeout.reason)}</i>` : ""}</p>
${d.closeout.gates.length > 0 ? `<p class="muted">Gate state recorded at completion (what was open then — the figures above are today's rows):</p>
<table>${d.closeout.gates.map((g) => row(
  g.ok == null ? "recorded" : g.ok ? "clear" : "open",
  `<span class="${g.ok == null ? "muted" : g.ok ? "ok" : "flag"}">${esc(g.text)}</span>`,
)).join("")}</table>` : `<p class="muted">No gate snapshot was recorded with this completion — the quality figures above are today's rows, not closeout day's.</p>`}` : ""}

${failed.has(R.parties) ? `<h2>Contractors on the job</h2><p>${couldNotRead}</p>` : d.parties.length ? `<h2>Contractors on the job</h2><ul>${d.parties.map((x) =>
  `<li>${esc(x.name)}${x.kind ? ` <span class="muted">(${esc(x.kind)}${x.trade ? `, ${esc(x.trade)}` : ""})</span>` : ""}</li>`).join("")}</ul>` : ""}

${p.lessons_learned ? `<h2>Lessons learned</h2><p>${esc(p.lessons_learned).replace(/\n/g, "<br>")}</p>` : ""}
<p class="muted" style="margin-top:28px">Every figure above is drawn live from the platform's records — cost entries, change orders, schedule tasks, checklist evidence, and turnover reviews.${d.readFailures.length > 0 ? ` Not read this time: ${esc(listJoin(d.readFailures))} — left out above, never printed as zero or empty.` : ""}</p>
<script>window.print()</script>
</body></html>`;
}

/** One click → the printable boss brief in a new window. */
export async function openProjectReport(orgId: string, projectId: string): Promise<void> {
  const data = await gatherReportData(orgId, projectId);
  openPrintWindow(renderReportHtml(data));
}

// ── Lessons learned ──────────────────────────────────────────────────────

/** Draft lessons learned from the project's exhaust — facts first, for a
 *  human to edit. Returns plain text ready for the projects.lessons_learned
 *  column. */
export async function draftLessonsLearned(orgId: string, projectId: string): Promise<string> {
  const d = await gatherReportData(orgId, projectId);
  const cur = d.rollup.currencies[0] ?? "USD";
  const money = (n: number) => fmtMoney(n, cur);
  const lines: string[] = [];
  const truncated = d.milestoneTotal > d.milestones.length;
  const firstOf = `the first ${d.milestones.length} of ${d.milestoneTotal} tasks by planned date`;
  const failed = new Set(d.readFailures);
  const costFailed = d.readFailures.filter((x) => REPORT_COST_READS.includes(x));
  const r = d.rollup;

  if (costFailed.length > 0) {
    lines.push(`COST: Could not read ${listJoin(costFailed)} when this draft was written — the cost outcome is left out; fill it in by hand.`);
  } else if (r.revisedBudget > 0) {
    // "Finished under/over" is budget less SPENT (actuals + adjustments),
    // against the revised budget the Costs tab shows. Open commitments are
    // money promised but not yet invoiced — named, not deducted.
    const left = r.remainingActualsOnly;
    const changes = r.approvedChanges !== 0
      ? ` (${money(r.budget)} baseline ${r.approvedChanges > 0 ? "+" : "−"} ${money(Math.abs(r.approvedChanges))} approved change orders)`
      : "";
    const cpi = r.cpi != null ? ` (CPI ${r.cpi.toFixed(2)}${truncated ? `; earned value from ${firstOf}` : ""})` : "";
    const open = r.openCommitments > 0 ? ` ${money(r.openCommitments)} of open commitments was not yet invoiced when this was drafted.` : "";
    lines.push(`COST: Finished ${money(Math.abs(left))} ${left >= 0 ? "under" : "over"} the ${money(r.revisedBudget)} budget${changes} on actual spend${cpi}.${open}`);
  }
  for (const r of d.cos.byReason) {
    const why: Record<CoReason, string> = {
      scope_gap: "the bid missed scope — tighten the RFQ scope description and the bid-tab gap check next time",
      field_condition: "conditions found during work — consider more up-front inspection on similar jobs",
      owner_request: "we asked for more after award — lock scope earlier or budget an allowance",
      design_error: "our drawings/scope were wrong — review the design check that let it through",
      other: "review individually",
    };
    lines.push(`CHANGE ORDERS (${CO_REASON_LABEL[r.reason]}): ${r.count} for ${money(r.amount)} — ${why[r.reason]}.`);
  }
  const scheduleScope = truncated ? ` (counted over ${firstOf})` : "";
  if (failed.has(R.milestones)) {
    lines.push("SCHEDULE: Could not read the schedule when this draft was written — check for slipped tasks by hand.");
  } else if (d.overdue > 0) {
    lines.push(`SCHEDULE: ${d.overdue} task${d.overdue === 1 ? "" : "s"} finished (or sat) past their planned date${scheduleScope} — check which tasks slipped and why.`);
  } else if (d.milestones.length > 0) {
    lines.push(`SCHEDULE: No overdue tasks at report time${scheduleScope}.`);
  }
  if (d.turnover.rejected > 0) {
    lines.push(`QUALITY: ${d.turnover.rejected} turnover item${d.turnover.rejected === 1 ? "" : "s"} rejected on first submission — feed the rejection reasons back to the contractor's record.`);
  }
  if (d.turnover.outstanding.length > 0) {
    lines.push(`CLOSEOUT: Turnover still outstanding at draft time: ${d.turnover.outstanding.join(", ")}.`);
  }
  const evidenceGaps = d.checklistLines.reduce((s, c) => s + c.needsEvidence, 0);
  if (evidenceGaps > 0) {
    lines.push(`EVIDENCE: ${evidenceGaps} checklist item${evidenceGaps === 1 ? "" : "s"} closed without system-held evidence — capture those documents next job so proof is automatic.`);
  }
  if (d.punchOpen > 0) {
    lines.push(`PUNCH: ${d.punchOpen} item${d.punchOpen === 1 ? "" : "s"} still open.`);
  }
  // Every other read that failed is named, so the "clean job" line below
  // can never be written over something the draft could not see.
  const otherFailed = d.readFailures.filter((x) => !REPORT_COST_READS.includes(x) && x !== R.milestones);
  if (otherFailed.length > 0) {
    lines.push(`NOT READ: ${listJoin(otherFailed)} could not be read when this draft was written — check ${otherFailed.length === 1 ? "it" : "them"} by hand.`);
  }
  if (lines.length === 0) {
    lines.push("Clean job on the record: budget held, schedule held, quality program closed out. Note anything the numbers can't see (crew, coordination, vendor performance) by hand.");
  }
  return lines.join("\n\n");
}

export async function saveLessonsLearned(input: {
  orgId: string; projectId: string; text: string; actorId: string; actorEmail?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase.from("projects")
    .update({ lessons_learned: input.text.trim() || null })
    .eq("id", input.projectId);
  if (error) return { ok: false, error: error.message };
  await supabase.from("audit_logs").insert({
    action: "PROJECT_LESSONS_SAVED", resource_type: "project", resource_id: input.projectId,
    org_id: input.orgId, user_id: input.actorId, user_email: input.actorEmail ?? null,
    details: { length: input.text.length },
  }).then(() => undefined, () => undefined);
  return { ok: true };
}
