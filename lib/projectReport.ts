// lib/projectReport.ts — the PROJECT REPORT (boss brief) and what the
// records say as lessons for the close-out review.
//
// One click, one printable page that answers the boss's four questions:
// what is this, where's the money, where's the schedule, is the quality
// program clean. Every number comes from rows the platform already holds —
// the report is a view, never a second bookkeeping system. The same facts
// (cost, change orders by reason, late work, rejected turnover, missing
// evidence) are suggested as lessons in the close-out's Lessons & findings
// review, where a person edits, keeps or drops each.

import { activeOnly } from "@/lib/activeMilestones";
import { supabase } from "@/lib/supabase";
import { listAccounts, listEntries, computeCostRollup, milestonePctIndex, fmtMoney } from "@/lib/costs";
import { listChangeOrders, summarizeChangeOrders, CO_REASON_LABEL, type CoReason } from "@/lib/changeOrders";
import { listTurnoverItems, computeTurnoverProgress } from "@/lib/turnover";
import { listChecklists, listChecklistItems, computeChecklistProgress } from "@/lib/checklists";
import { computeForecast } from "@/lib/costSeries";
import { openPrintWindow } from "@/lib/evidencePack";
import { lessonsLearnedLines, type RecordLesson } from "@/lib/findings";

const FINDING_KIND: Record<string, string> = { problem: "Problem", lesson: "Lesson", material: "Material", missed_scope: "Missed scope" };

async function safe<T>(p: PromiseLike<T>, fallback: T): Promise<T> {
  try { return await p; } catch { return fallback; }
}

interface ReportData {
  project: Record<string, unknown>;
  rollup: ReturnType<typeof computeCostRollup>;
  forecastSentence: string | null;
  cos: ReturnType<typeof summarizeChangeOrders>;
  milestones: Array<{ name: string; planned_at: string | null; status: string }>;
  overdue: number;
  turnover: ReturnType<typeof computeTurnoverProgress>;
  checklistLines: Array<{ title: string; kind: string; satisfied: number; applicable: number; needsEvidence: number; complete: boolean }>;
  punchOpen: number;
  parties: Array<{ name: string; kind: string | null; trade: string | null }>;
  /** Kept at the close-out's Lessons & findings review. */
  findings: Array<{ kind: string; body: string; next_time: string | null; asset_tag: string | null; applies_to: string; topic: string; status: string; source: string; source_ref: string | null }>;
}

async function gatherReportData(orgId: string, projectId: string): Promise<ReportData> {
  const [projRow, accounts, entries, coList, msRows, turnoverItems, checklists, punchRows, partyRows, findingRows] = await Promise.all([
    safe(supabase.from("projects").select("*").eq("id", projectId).maybeSingle().then((r) => r.data), null),
    safe(listAccounts(orgId, projectId), []),
    safe(listEntries(orgId, projectId), []),
    safe(listChangeOrders(projectId), []),
    safe(activeOnly((a) => {
      const q = supabase.from("milestones").select("name, planned_at, status, percent_complete, source").eq("project_id", projectId);
      return (a ? q.is("cancelled_at", null) : q).order("planned_at").limit(500);
    })
      .then((r) => (r.error ? [] : ((r.data ?? []) as Array<Record<string, unknown>>))), []),
    safe(listTurnoverItems(orgId, projectId), []),
    safe(listChecklists(orgId, projectId), []),
    safe(supabase.from("punch_items").select("status").eq("project_id", projectId).limit(500)
      .then((r) => (r.error ? [] : ((r.data ?? []) as Array<{ status: string }>))), []),
    safe(supabase.from("project_parties").select("name, kind, trade").eq("project_id", projectId).limit(100)
      .then((r) => (r.error ? [] : ((r.data ?? []) as Array<{ name: string; kind: string | null; trade: string | null }>))), []),
    // Before 20261115_project_findings.sql: none.
    safe(supabase.from("project_findings").select("kind, body, next_time, asset_tag, applies_to, topic, status, source, source_ref").eq("project_id", projectId).neq("status", "open").order("found_at").limit(500)
      .then((r) => (r.error ? [] : ((r.data ?? []) as ReportData["findings"]))), []),
  ]);
  const project = (projRow ?? {}) as Record<string, unknown>;

  const live = msRows.filter((m) => (m.source as string | null) == null || m.source === "manual" || m.source === "app");
  const pctIdx = milestonePctIndex(live.map((m, i) => ({
    id: String(i), percentComplete: (m.percent_complete as number | null) ?? null, status: String(m.status ?? "planned"),
  })));
  void pctIdx; // EV pinning uses milestone ids; report uses account-level rollup below
  const rollup = computeCostRollup(accounts, entries, new Map());

  const dates = live.map((m) => (m.planned_at ? String(m.planned_at).slice(0, 10) : null)).filter((v): v is string => !!v).sort();
  const forecast = computeForecast({
    budget: rollup.budget, spent: rollup.spent, cpi: rollup.cpi,
    scheduleStart: dates[0] ?? null, scheduleEnd: dates[dates.length - 1] ?? null,
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
    cos: summarizeChangeOrders(coList),
    milestones: live.map((m) => ({
      name: String(m.name ?? ""), planned_at: (m.planned_at as string | null) ?? null, status: String(m.status ?? "planned"),
    })),
    overdue: live.filter((m) => {
      const t = m.planned_at ? Date.parse(String(m.planned_at)) : NaN;
      return Number.isFinite(t) && t < now && String(m.status) !== "completed";
    }).length,
    turnover: computeTurnoverProgress(turnoverItems),
    checklistLines,
    punchOpen: punchRows.filter((p) => p.status === "open").length,
    parties: partyRows,
    findings: findingRows,
  };
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderReportHtml(d: ReportData): string {
  const p = d.project;
  const cur = d.rollup.currencies[0] ?? "USD";
  const money = (n: number) => fmtMoney(n, cur);
  const goals = Array.isArray(p.goals) ? (p.goals as string[]) : [];
  const today = new Date().toLocaleDateString();

  const row = (label: string, value: string) =>
    `<tr><td class="k">${esc(label)}</td><td>${value}</td></tr>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Project report - ${esc(p.name)}</title>
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
<div class="sub">Project report · generated ${esc(today)} · owner ${esc(p.owner_user_name ?? "-")}${p.moc_reference ? ` · MOC ${esc(p.moc_reference)}` : ""}</div>
${p.purpose ? `<p><b>Purpose:</b> ${esc(p.purpose)}</p>` : ""}
${goals.length ? `<p><b>Goals:</b></p><ul>${goals.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : ""}
${p.success_criteria ? `<p><b>Success criteria:</b> ${esc(p.success_criteria)}</p>` : ""}

<h2>Money</h2>
<table>
${row("Budget", `<span class="num">${esc(money(d.rollup.budget))}</span>`)}
${row("Committed (promised)", `<span class="num">${esc(money(d.rollup.committed))}</span>`)}
${row("Spent (real money out)", `<span class="num">${esc(money(d.rollup.spent))}</span>`)}
${row("Remaining", `<span class="num ${d.rollup.remaining < 0 ? "flag" : "ok"}">${esc(money(d.rollup.remaining))}</span>`)}
${d.rollup.cpi != null ? row("Cost performance (CPI)", `<span class="num">${d.rollup.cpi.toFixed(2)}</span> - ${d.rollup.cpi >= 1 ? "getting more work per dollar than planned" : "spending faster than earning"}`) : ""}
${d.forecastSentence ? row("Forecast", esc(d.forecastSentence)) : ""}
${d.cos.approvedCount > 0 ? row("Change orders", `<span class="num">${d.cos.approvedCount} approved · ${esc(money(d.cos.approvedAmount))}</span> - ${d.cos.byReason.map((r) => `${esc(CO_REASON_LABEL[r.reason])}: ${esc(money(r.amount))}`).join("; ")}`) : ""}
${d.cos.open > 0 ? row("Awaiting decision", `<span class="flag">${d.cos.open} change order${d.cos.open === 1 ? "" : "s"} open</span>`) : ""}
</table>

<h2>Schedule</h2>
${d.milestones.length === 0 ? `<p class="muted">No schedule loaded.</p>` : `
<p>${d.milestones.filter((m) => m.status === "completed").length}/${d.milestones.length} milestones complete${d.overdue > 0 ? ` · <span class="flag">${d.overdue} overdue</span>` : ` · <span class="ok">nothing overdue</span>`}</p>
<table>${d.milestones.slice(0, 25).map((m) => row(
  m.planned_at ? new Date(m.planned_at).toLocaleDateString() : "-",
  `${esc(m.name)} <span class="muted">- ${esc(m.status.replace("_", " "))}</span>`,
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
${row("Punch list", d.punchOpen === 0 ? `<span class="ok">Clear</span>` : `<span class="flag">${d.punchOpen} open</span>`)}
</table>

${d.parties.length ? `<h2>Companies on the job</h2><ul>${d.parties.map((x) =>
  `<li>${esc(x.name)}${x.kind ? ` <span class="muted">(${esc(x.kind)}${x.trade ? `, ${esc(x.trade)}` : ""})</span>` : ""}</li>`).join("")}</ul>` : ""}

${(() => {
  // Kept findings; and the old Lessons learned text, less the lines the
  // close-out review has already kept or dropped.
  const kept = d.findings.filter((f) => f.status === "kept");
  const reviewed = new Set(d.findings.filter((f) => f.source === "lessons_learned").map((f) => f.source_ref));
  const old = lessonsLearnedLines(p.lessons_learned as string | null).filter((l) => !reviewed.has(l.ref));
  return (kept.length ? `<h2>Lessons &amp; findings</h2><ul>${kept.map((f) =>
    `<li><b>${esc(FINDING_KIND[f.kind] ?? "Finding")}</b>${f.asset_tag ? ` · ${esc(f.asset_tag)}` : ""} · ${esc(f.body)}${f.next_time ? ` <span class="muted">Next time: ${esc(f.next_time)}</span>` : ""}</li>`).join("")}</ul>` : "")
    + (old.length ? `<h2>Lessons learned</h2><ul>${old.map((l) => `<li>${esc(l.text)}</li>`).join("")}</ul>` : "");
})()}
<p class="muted" style="margin-top:28px">Every figure above is drawn live from the platform's records - cost entries, change orders, milestones, checklist evidence, and turnover reviews.</p>
<script>window.print()</script>
</body></html>`;
}

/** One click → the printable boss brief in a new window. */
export async function openProjectReport(orgId: string, projectId: string): Promise<void> {
  const data = await gatherReportData(orgId, projectId);
  openPrintWindow(renderReportHtml(data));
}

// ── Lessons learned ──────────────────────────────────────────────────────

/** The same facts as lessons for the close-out review (Lessons & findings):
 *  one each, with what to do next time. Status lines (punch items still
 *  open, turnover outstanding) and "a clean job" are left out: they aren't
 *  lessons. */
export async function recordLessons(orgId: string, projectId: string): Promise<RecordLesson[]> {
  const d = await gatherReportData(orgId, projectId);
  const cur = d.rollup.currencies[0] ?? "USD";
  const money = (n: number) => fmtMoney(n, cur);
  const out: RecordLesson[] = [];
  if (d.rollup.budget > 0) {
    const over = d.rollup.remaining < 0;
    out.push({
      ref: "cost", kind: over ? "problem" : "lesson", topic: "Other",
      text: `Finished ${money(Math.abs(d.rollup.remaining))} ${over ? "over" : "under"} the ${money(d.rollup.budget)} budget${d.rollup.cpi != null ? ` (CPI ${d.rollup.cpi.toFixed(2)})` : ""}`,
      nextTime: over ? "Check which accounts ran over and budget them closer next time" : "",
    });
  }
  const NEXT: Record<CoReason, string> = {
    scope_gap: "Tighten the RFQ scope description and the bid-tab gap check",
    field_condition: "More up-front inspection on similar jobs",
    owner_request: "Lock scope earlier or budget an allowance",
    design_error: "Review the design check that let it through",
    other: "Review each one",
  };
  for (const r of d.cos.byReason) {
    out.push({ ref: `co:${r.reason}`, kind: "problem", topic: r.reason === "field_condition" ? "Planning" : r.reason === "design_error" ? "Planning" : "Contractors",
      text: `${r.count} change order${r.count === 1 ? "" : "s"} for ${money(r.amount)}: ${CO_REASON_LABEL[r.reason].toLowerCase()}`, nextTime: NEXT[r.reason] });
  }
  if (d.overdue > 0) out.push({ ref: "overdue", kind: "problem", topic: "Scheduling", text: `${d.overdue} milestone${d.overdue === 1 ? "" : "s"} finished (or sat) past the planned date`, nextTime: "Check which activities slipped and why before planning the next one" });
  if (d.turnover.rejected > 0) out.push({ ref: "quality", kind: "problem", topic: "Contractors", text: `${d.turnover.rejected} turnover item${d.turnover.rejected === 1 ? "" : "s"} rejected on first submission`, nextTime: "Feed the rejection reasons back to the contractor's record" });
  const gaps = d.checklistLines.reduce((s, c) => s + c.needsEvidence, 0);
  if (gaps > 0) out.push({ ref: "evidence", kind: "problem", topic: "Other", text: `${gaps} checklist item${gaps === 1 ? "" : "s"} closed without the evidence held in the system`, nextTime: "Capture those documents during the job so the proof is automatic" });
  return out;
}

