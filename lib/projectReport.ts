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

import { supabase } from "@/lib/supabase";
import { listAccounts, listEntries, computeCostRollup, milestonePctIndex, fmtMoney } from "@/lib/costs";
import { listChangeOrders, summarizeChangeOrders, CO_REASON_LABEL, type CoReason } from "@/lib/changeOrders";
import { listTurnoverItems, computeTurnoverProgress } from "@/lib/turnover";
import { listChecklists, listChecklistItems, computeChecklistProgress } from "@/lib/checklists";
import { computeForecast, scheduleSpanFromMilestones } from "@/lib/costSeries";
import { openPrintWindow } from "@/lib/evidencePack";
import { liveMilestones, isImportedMilestone, isOverdueMilestone, PROJECT_MILESTONE_READ_LIMIT } from "@/lib/milestoneLiveness";

async function safe<T>(p: PromiseLike<T>, fallback: T): Promise<T> {
  try { return await p; } catch { return fallback; }
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
  const [projRow, accounts, entries, coList, msRows, turnoverItems, checklists, punchRows, partyRows, closeoutRows] = await Promise.all([
    safe(supabase.from("projects").select("*").eq("id", projectId).maybeSingle().then((r) => r.data), null),
    safe(listAccounts(orgId, projectId), []),
    safe(listEntries(orgId, projectId), []),
    safe(listChangeOrders(projectId), []),
    // The same first rows by planned date the snapshot reads and the Costs
    // tab's capped read returns (PROJECT_MILESTONE_READ_LIMIT), so the EV
    // index — and the CPI — agree; the exact count discloses a larger one.
    safe(supabase.from("milestones").select("id, name, planned_at, planned_start_at, status, percent_complete, source", { count: "exact" })
      .eq("project_id", projectId).order("planned_at").order("id").limit(PROJECT_MILESTONE_READ_LIMIT)
      .then((r) => (r.error
        ? { rows: [] as Array<Record<string, unknown>>, total: 0 }
        : { rows: (r.data ?? []) as Array<Record<string, unknown>>, total: r.count ?? (r.data ?? []).length })),
      { rows: [] as Array<Record<string, unknown>>, total: 0 }),
    safe(listTurnoverItems(orgId, projectId), []),
    safe(listChecklists(orgId, projectId), []),
    safe(supabase.from("punch_items").select("status").eq("project_id", projectId).limit(500)
      .then((r) => (r.error ? [] : ((r.data ?? []) as Array<{ status: string }>))), []),
    safe(supabase.from("project_parties").select("name, kind, trade").eq("project_id", projectId).limit(100)
      .then((r) => (r.error ? [] : ((r.data ?? []) as Array<{ name: string; kind: string | null; trade: string | null }>))), []),
    // The completion override's audit row — newest first; its details carry
    // the gate snapshot once lib/projects.ts records one (SAF-14).
    safe(supabase.from("audit_logs").select("timestamp, details")
      .eq("resource_type", "project").eq("resource_id", projectId).eq("action", "PROJECT_COMPLETED")
      .order("timestamp", { ascending: false }).limit(1)
      .then((r) => (r.error ? [] : ((r.data ?? []) as Array<{ timestamp: string | null; details: unknown }>))), []),
  ]);
  const project = (projRow ?? {}) as Record<string, unknown>;

  // Every stored milestone counts — imported rows are commitments
  // (lib/milestoneLiveness). The EV index is keyed by the real milestone
  // id so pinned accounts resolve, exactly as the Costs tab computes it.
  const live = liveMilestones(msRows.rows as Array<Record<string, unknown> & { source?: string | null }>);
  const pctIdx = milestonePctIndex(live.map((m) => ({
    id: String(m.id), percentComplete: (m.percent_complete as number | null) ?? null, status: String(m.status ?? "planned"),
  })));
  const rollup = computeCostRollup(accounts, entries, pctIdx);

  // MON-2: the Costs tab's span — earliest task START to latest finish
  // (planned_at is the finish) — so the run-rate forecast on paper divides
  // by the same elapsed share as the screen's.
  const span = scheduleSpanFromMilestones(live.map((m) => ({
    planned_at: (m.planned_at as string | null) ?? null, planned_start_at: (m.planned_start_at as string | null) ?? null,
  })));
  const forecast = computeForecast({
    budget: rollup.budget, spent: rollup.spent, cpi: rollup.cpi,
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
${row("Budget", `<span class="num">${esc(money(d.rollup.budget))}</span>`)}
${row("Committed (promised)", `<span class="num">${esc(money(d.rollup.committed))}</span>`)}
${row("Spent (real money out)", `<span class="num">${esc(money(d.rollup.spent))}</span>`)}
${row("Budget less spent", `<span class="num ${d.rollup.remaining < 0 ? "flag" : "ok"}">${esc(money(d.rollup.remaining))}</span> <span class="muted">— open commitments are not deducted</span>`)}
${d.rollup.cpi != null ? row("Cost performance (CPI)", `<span class="num">${d.rollup.cpi.toFixed(2)}</span> — ${d.rollup.cpi >= 1 ? "getting more work per dollar than planned" : "spending faster than earning"}${truncated ? ` <span class="muted">— earned value from the ${firstOf} schedule activities, as on the Costs tab</span>` : ""}`) : ""}
${d.forecastSentence ? row("Forecast", esc(d.forecastSentence)) : ""}
${d.cos.approvedCount > 0 ? row("Change orders", `<span class="num">${d.cos.approvedCount} approved · ${esc(money(d.cos.approvedAmount))}</span> — ${d.cos.byReason.map((r) => `${esc(CO_REASON_LABEL[r.reason])}: ${esc(money(r.amount))}`).join("; ")}`) : ""}
${d.cos.open > 0 ? row("Awaiting decision", `<span class="flag">${d.cos.open} change order${d.cos.open === 1 ? "" : "s"} open</span>`) : ""}
</table>

<h2>Schedule</h2>
${d.milestones.length === 0 ? `<p class="muted">No schedule loaded.</p>` : `
<p>${d.milestones.filter((m) => m.status === "completed").length}/${d.milestones.length} milestones complete${truncated ? ` <span class="muted">(${firstOf} — every figure in this section counts those)</span>` : ""}${d.overdue > 0 ? ` · <span class="flag">${d.overdue} overdue</span>` : ` · <span class="ok">nothing overdue</span>`}${d.milestones.some((m) => m.imported) ? ` · <span class="muted">${d.milestones.filter((m) => m.imported).length} imported from the schedule file</span>` : ""}</p>
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
${row("Punch list", d.punchOpen === 0 ? `<span class="ok">Clear</span>` : `<span class="flag">${d.punchOpen} open</span>`)}
</table>
${d.closeout ? `
<h2>Closeout</h2>
<p>Completed ${d.closeout.at ? esc(new Date(d.closeout.at).toLocaleDateString()) : "—"}${d.closeout.reason ? ` · <i>${esc(d.closeout.reason)}</i>` : ""}</p>
${d.closeout.gates.length > 0 ? `<p class="muted">Gate state recorded at completion (what was open then — the figures above are today's rows):</p>
<table>${d.closeout.gates.map((g) => row(
  g.ok == null ? "recorded" : g.ok ? "clear" : "open",
  `<span class="${g.ok == null ? "muted" : g.ok ? "ok" : "flag"}">${esc(g.text)}</span>`,
)).join("")}</table>` : `<p class="muted">No gate snapshot was recorded with this completion — the quality figures above are today's rows, not closeout day's.</p>`}` : ""}

${d.parties.length ? `<h2>Companies on the job</h2><ul>${d.parties.map((x) =>
  `<li>${esc(x.name)}${x.kind ? ` <span class="muted">(${esc(x.kind)}${x.trade ? `, ${esc(x.trade)}` : ""})</span>` : ""}</li>`).join("")}</ul>` : ""}

${p.lessons_learned ? `<h2>Lessons learned</h2><p>${esc(p.lessons_learned).replace(/\n/g, "<br>")}</p>` : ""}
<p class="muted" style="margin-top:28px">Every figure above is drawn live from the platform's records — cost entries, change orders, milestones, checklist evidence, and turnover reviews.</p>
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
  const firstOf = `the first ${d.milestones.length} of ${d.milestoneTotal} activities by planned date`;

  if (d.rollup.budget > 0) {
    const overUnder = d.rollup.remaining >= 0 ? "under" : "over";
    lines.push(`COST: Finished ${money(Math.abs(d.rollup.remaining))} ${overUnder} the ${money(d.rollup.budget)} budget${d.rollup.cpi != null ? ` (CPI ${d.rollup.cpi.toFixed(2)}${truncated ? `; earned value from ${firstOf}` : ""})` : ""}.`);
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
  if (d.overdue > 0) {
    lines.push(`SCHEDULE: ${d.overdue} milestone${d.overdue === 1 ? "" : "s"} finished (or sat) past their planned date${scheduleScope} — check which activities slipped and why.`);
  } else if (d.milestones.length > 0) {
    lines.push(`SCHEDULE: No overdue milestones at report time${scheduleScope}.`);
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
