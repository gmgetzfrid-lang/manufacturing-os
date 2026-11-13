"use client";

// CostsTab — the COST COMMAND CENTER on the project page.
//
// One screen, the whole money story, readable by a rookie: budget vs
// committed vs spent tiles (jargon translated in place), the S-curve and a
// forecast sentence, inbound quotes read by AI and tabulated side by side,
// change orders with reason codes, and the account/entry machinery
// underneath. Split into sub-tabs (Overview · Budget · Quotes · Invoices ·
// Change orders) so each job is one screen, and a project with no budget
// opens on Budget, where dropping the AFE / estimate builds the model. Before the project has any numbers, the charts render with
// watermarked EXAMPLE data — you see what you're building toward, not a
// blank pane. Writes: org controllers and the PROJECT OWNER (RLS,
// 20261013); everyone on the project reads the same picture.

import { activeOnly } from "@/lib/activeMilestones";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Plus, X, Loader2, Check, ChevronDown, ChevronRight,
  Landmark, HardHat, Scale, TrendingUp, TrendingDown, AlertTriangle, Ban,
  LayoutDashboard, ScanSearch, Receipt, GitPullRequestArrow, FileCheck2, FileUp, Gauge, Hourglass,
  Pencil, RotateCcw,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  CostAccount, CostEntry, CostParty, CostEntryType,
  listAccounts, listEntries, listParties, saveAccount, addEntry, voidEntry, saveParty,
  computeCostRollup, computeCostOutlook, milestonePctIndex, fmtMoney,
  type CostOutlook,
} from "@/lib/costs";
import { overallPercent } from "@/lib/scheduleProgress";
import type { MilestoneStatus } from "@/types/schema";
import { listCostDocs, parsedQuoteFrom, type CostDocument } from "@/lib/costDocs";
import CostCharts, { CostGlossary } from "@/components/projects/cost/CostCharts";
import QuotesPanel from "@/components/projects/cost/QuotesPanel";
import ChangeOrdersPanel from "@/components/projects/cost/ChangeOrdersPanel";
import { BudgetDocDrop, BudgetImportSheet } from "@/components/projects/cost/BudgetImport";
import type { BudgetReadResult } from "@/lib/budgetImport";
import { appConfirm } from "@/components/providers/DialogProvider";
import { AfeCard, LineEditor, BudgetHistory, EntryRevise } from "@/components/projects/cost/CostEdits";
import { FilePreviewModal, fileOfDoc, type PreviewFile } from "@/components/projects/cost/FilePreview";
import { loadBudgetHistory, parseMoney, type BudgetChange } from "@/lib/costRevisions";
import BudgetTable, { LinesChart } from "@/components/projects/cost/BudgetTable";
import { phaseStats } from "@/lib/phaseReport";
import type { ProjectPhase } from "@/lib/projectPhases";

type CostView = "overview" | "budget" | "quotes" | "invoices" | "changes";

interface BudgetBasis { afeNumber: string | null; chargeAccount: string | null; authorized: number | null; docId: string | null }

const ENTRY_TYPES: Array<{ v: CostEntryType; label: string; hint: string }> = [
  { v: "commitment", label: "Quote / PO", hint: "Awarded quote, PO or contract value - money promised. Type it here when the quote was a phone call or email." },
  { v: "actual", label: "Actual", hint: "Invoice / timesheet - money really spent" },
  { v: "adjustment", label: "Adjustment", hint: "Signed correction (can be negative to credit back)" },
];

export default function CostsTab({ orgId, projectId, canManage, uid, userEmail, onDataChanged, phases = [], phase = null }: {
  orgId: string; projectId: string; canManage: boolean; uid: string; userEmail?: string | null;
  /** Fires after each data reload so the page's coach/health re-gathers. */
  onDataChanged?: () => void;
  /** The project's phases and the one picked: each line's phase, and the
   *  phase's share of the money (lib/phaseReport). */
  phases?: ProjectPhase[];
  phase?: string | null;
}) {
  const [accounts, setAccounts] = useState<CostAccount[]>([]);
  const [entries, setEntries] = useState<CostEntry[]>([]);
  const [parties, setParties] = useState<CostParty[]>([]);
  const [docs, setDocs] = useState<CostDocument[]>([]);
  const [milestones, setMilestones] = useState<Array<{ id: string; name: string; pct: number }>>([]);
  // Whole-schedule % complete — the progress an unpinned budget line uses.
  const [projectPct, setProjectPct] = useState<number | null>(null);
  const [schedSpan, setSchedSpan] = useState<{ start: string | null; end: string | null }>({ start: null, end: null });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showParties, setShowParties] = useState(false);
  const [view, setView] = useState<CostView | null>(null);
  const [basis, setBasis] = useState<BudgetBasis | null>(null);
  const [importing, setImporting] = useState<BudgetReadResult | null>(null);
  const [showDrop, setShowDrop] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // A document open in the preview window.
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  // A budget line being edited, and each line's budget changes.
  const [editingLine, setEditingLine] = useState<string | null>(null);
  const [budgetHistory, setBudgetHistory] = useState<Map<string, BudgetChange[]>>(new Map());

  const actor = useMemo(() => ({ uid, email: userEmail ?? null }), [uid, userEmail]);

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const [a, e, p, d, { data: ms }] = await Promise.all([
        listAccounts(orgId, projectId),
        listEntries(orgId, projectId),
        listParties(orgId, projectId),
        listCostDocs(orgId, projectId).catch(() => [] as CostDocument[]), // pre-migration tolerance
        // Jobs cancelled off the schedule don't count toward % complete.
        activeOnly((a) => {
          const q = supabase.from("milestones").select("id, name, percent_complete, status, planned_at, parent_id, weight, duration_hours").eq("project_id", projectId);
          return (a ? q.is("cancelled_at", null) : q).order("planned_at");
        }),
      ]);
      setAccounts(a);
      // First open: a project with no budget lands where the budget gets built.
      setView((v) => v ?? (a.length === 0 ? "budget" : "overview"));
      setEntries(e);
      setParties(p);
      setDocs(d);
      const rows = ((ms ?? []) as Array<{
        id: string; name: string; percent_complete: number | null; status: string; planned_at: string | null;
        parent_id: string | null; weight: number | null; duration_hours: number | null;
      }>);
      setProjectPct(rows.length > 0 ? overallPercent(rows.map((m) => ({
        id: m.id, parentId: m.parent_id, status: m.status as MilestoneStatus,
        percentComplete: m.percent_complete, weight: m.weight, durationHours: m.duration_hours,
      }))) : null);
      const idx = milestonePctIndex(rows.map((m) => ({ id: m.id, percentComplete: m.percent_complete, status: m.status })));
      setMilestones(rows.map((m) => ({ id: m.id, name: m.name, pct: idx.get(m.id) ?? 0 })));
      const dates = rows.map((m) => m.planned_at).filter((v): v is string => !!v).sort();
      setSchedSpan(dates.length >= 2
        ? { start: dates[0].slice(0, 10), end: dates[dates.length - 1].slice(0, 10) }
        : { start: null, end: null });
      // Budget basis (20261020) — absent columns just mean no header line.
      const { data: pb, error: pbErr } = await supabase.from("projects")
        .select("afe_number, charge_account, authorized_amount, budget_doc_id").eq("id", projectId).maybeSingle();
      setBasis(!pbErr && pb ? {
        afeNumber: (pb.afe_number as string | null) ?? null,
        chargeAccount: (pb.charge_account as string | null) ?? null,
        authorized: pb.authorized_amount == null ? null : Number(pb.authorized_amount),
        docId: (pb.budget_doc_id as string | null) ?? null,
      } : null);
      setBudgetHistory(await loadBudgetHistory(projectId));
    } catch (e) {
      setErr((e as Error).message);
    } finally { setLoading(false); }
    onDataChanged?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, projectId]);
  useEffect(() => { void refresh(); }, [refresh]);

  // Crew curve input: the awarded quote's stated labor hours.
  const awardedLaborHours = useMemo(() => {
    const awarded = docs.find((d) => d.kind === "quote" && d.status === "awarded");
    if (!awarded) return null;
    const q = parsedQuoteFrom(awarded);
    const hours = q?.lineItems.reduce((s, l) => s + (l.hours ?? 0), 0) ?? 0;
    return hours > 0 ? hours : null;
  }, [docs]);

  const pctIndex = useMemo(() => new Map(milestones.map((m) => [m.id, m.pct])), [milestones]);
  // Closed lines are kept for the record, out of every total.
  const openAccounts = useMemo(() => accounts.filter((a) => a.status !== "closed"), [accounts]);
  const rollup = useMemo(() => computeCostRollup(openAccounts, entries, pctIndex), [openAccounts, entries, pctIndex]);
  // Each line's numbers, closed ones too (the budget table shows them).
  const allRollup = useMemo(() => computeCostRollup(accounts, entries, pctIndex), [accounts, entries, pctIndex]);
  const lineNumbers = useMemo(() => new Map(allRollup.accounts.map((r) => [r.account.id, { committed: r.committed, spent: r.spent }])), [allRollup]);
  // The phase picked: its share of the money, line by line.
  const phaseMoney = useMemo(() => {
    const p = phase ? phases.find((x) => x.id === phase) ?? null : null;
    if (!p) return null;
    const s = phaseStats({ milestones: [], phases, phase: p, log: null, tz: "UTC", now: Date.now(), total: basis?.authorized ?? null,
      lines: openAccounts.map((a) => ({ id: a.id, name: a.name, cost_type: a.costType, budget: a.budget, phase_id: a.phaseId ?? null, status: a.status })),
      entries: entries.map((e) => ({ cost_account_id: e.costAccountId ?? "", entry_type: e.entryType, amount: e.amount, entry_date: e.entryDate, status: e.status, phase_id: e.phaseId ?? null })) });
    return { phase: p, s };
  }, [phase, phases, openAccounts, entries, basis]);
  const cur = rollup.currencies[0] ?? "USD";
  const mixedCurrency = rollup.currencies.length > 1;
  const outlook = useMemo(() => computeCostOutlook(rollup, pctIndex, projectPct), [rollup, pctIndex, projectPct]);
  // The bar shows ESTIMATED cost to date (quotes × progress) — invoices lag
  // the work by weeks, so "spent" alone would read near-zero all job.
  const burnPct = rollup.budget > 0 ? Math.min(100, (outlook.estimatedToDate / rollup.budget) * 100) : 0;
  const commitPct = rollup.budget > 0 ? Math.min(100, (rollup.committed / rollup.budget) * 100) : 0;
  const entriesByAccount = useMemo(() => {
    const m = new Map<string, CostEntry[]>();
    for (const e of entries) {
      if (!e.costAccountId) continue;
      const arr = m.get(e.costAccountId) ?? [];
      arr.push(e);
      m.set(e.costAccountId, arr);
    }
    return m;
  }, [entries]);

  const quoteCount = docs.filter((d) => d.kind === "quote" && d.status !== "void").length;
  const invoiceOpen = docs.filter((d) => (d.kind === "invoice" || d.kind === "po") && (d.status === "draft" || d.status === "parsed")).length;
  const basisDoc = basis?.docId ? docs.find((d) => d.id === basis.docId) ?? null : null;


  if (loading) return <div className="py-12 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-accent)]" /></div>;

  return (
    <div className="space-y-4">
      {preview && <FilePreviewModal file={preview} onClose={() => setPreview(null)} />}
      {err && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/50 bg-rose-500/[0.08] px-3 py-2.5 text-xs font-bold text-rose-700 dark:text-rose-300">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {err}
          <button onClick={() => setErr(null)} className="ml-auto text-rose-400 hover:text-rose-600"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {notice && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/[0.07] px-3 py-2.5 text-xs font-bold text-emerald-800 dark:text-emerald-300">
          <Check className="w-4 h-4 shrink-0" /> {notice}
          <button onClick={() => setNotice(null)} className="ml-auto text-emerald-500 hover:text-emerald-700"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* ── Sub-tabs: one job per screen ── */}
      <div className="flex items-center gap-1 overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1">
        <SubTab active={view === "overview"} onClick={() => setView("overview")} icon={<LayoutDashboard className="w-3.5 h-3.5" />} label="Overview" />
        <SubTab active={view === "budget"} onClick={() => setView("budget")} icon={<Landmark className="w-3.5 h-3.5" />} label="Budget" count={accounts.length} />
        <SubTab active={view === "quotes"} onClick={() => setView("quotes")} icon={<ScanSearch className="w-3.5 h-3.5" />} label="Quotes" count={quoteCount} />
        <SubTab active={view === "invoices"} onClick={() => setView("invoices")} icon={<Receipt className="w-3.5 h-3.5" />} label="Invoices" count={invoiceOpen} attention={invoiceOpen > 0} />
        <SubTab active={view === "changes"} onClick={() => setView("changes")} icon={<GitPullRequestArrow className="w-3.5 h-3.5" />} label="Change orders" />
      </div>

      {view === "overview" && (<>
      {phaseMoney && (
        <div className="rounded-2xl border-2 border-[var(--color-accent)]/40 bg-[var(--color-surface)] px-4 py-3">
          <div className="text-[12px] font-semibold text-[var(--color-text-muted)]">{phaseMoney.phase.name} · {phaseMoney.phase.share}% of the {basis?.authorized != null ? "AFE" : "budget"}</div>
          <div className="mt-1 grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[["Phase budget", phaseMoney.s.budget], ["Committed", phaseMoney.s.committed], ["Spent", phaseMoney.s.spent], [phaseMoney.s.budget - phaseMoney.s.spent >= 0 ? "Left" : "Over", Math.abs(phaseMoney.s.budget - phaseMoney.s.spent)]].map(([k, v]) => (
              <div key={String(k)}><div className="text-[11px] text-[var(--color-text-muted)]">{k}</div><div className={`text-lg font-black tabular-nums ${k === "Over" ? "text-rose-700 dark:text-rose-400" : "text-[var(--color-text)]"}`}>{fmtMoney(Number(v), cur)}</div></div>
            ))}
          </div>
          <div className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">Lines kept for {phaseMoney.phase.name} count whole; every other line counts its {phaseMoney.phase.share}% share. Spending counts where it was booked, else by its date. The totals below are the whole project.</div>
        </div>
      )}
      {phaseMoney && phaseMoney.s.lines.length > 0 && <LinesChart rows={phaseMoney.s.lines} cur={cur} />}
      {/* ── Stat strip ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={<Landmark className="w-4 h-4" />} label="Budget" value={fmtMoney(rollup.budget, cur)} tone="accent" />
        <StatCard icon={<Scale className="w-4 h-4" />} label="Quoted (awarded)" value={fmtMoney(rollup.committed, cur)}
          sub={rollup.budget > 0 ? `${Math.round(outlook.quotedCoverage * 100)}% of the budget has a quote` : undefined} tone="sky" />
        <StatCard icon={<HardHat className="w-4 h-4" />} label="Cost to date (est.)" value={fmtMoney(outlook.estimatedToDate, cur)}
          sub={`${fmtMoney(outlook.invoiced, cur)} invoiced${outlook.unbilled >= 1 ? ` · ${fmtMoney(outlook.unbilled, cur)} not billed yet` : ""}`}
          tone="violet" />
        <StatCard
          icon={outlook.variance > 0 ? <TrendingDown className="w-4 h-4" /> : <TrendingUp className="w-4 h-4" />}
          label="Forecast at finish" value={fmtMoney(outlook.forecast, cur)}
          tone={outlook.variance > 0 ? "rose" : "emerald"}
          sub={rollup.budget <= 0 ? undefined
            : Math.abs(outlook.variance) < 1 ? "on budget"
            : `${fmtMoney(Math.abs(outlook.variance), cur)} ${outlook.variance > 0 ? "over" : "under"} budget`}
        />
      </div>

      {basis && (basis.afeNumber || basis.authorized != null) && (
        <BasisLine basis={basis} budget={rollup.budget} spent={outlook.estimatedToDate} cur={cur} onOpen={basisDoc?.fileUrl ? () => setPreview(fileOfDoc(basisDoc)) : undefined} />
      )}

      {/* ── Burn bar: spent (solid) + committed (hatched ghost) vs budget ── */}
      {rollup.budget > 0 && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
          <div className="flex items-center justify-between text-[10px] font-bold text-[var(--color-text-muted)] mb-1.5">
            <span>Budget burn (estimated from quotes × schedule progress)</span>
            <span className="tabular-nums">{fmtMoney(outlook.estimatedToDate, cur)} est. to date · {fmtMoney(rollup.committed, cur)} quoted · {fmtMoney(rollup.budget, cur)} budget</span>
          </div>
          <div className="relative h-2.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
            <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-accent)]/25 transition-all duration-700" style={{ width: `${commitPct}%` }} />
            <div className={`absolute inset-y-0 left-0 rounded-full transition-all duration-700 ${burnPct >= 100 ? "bg-rose-500" : "bg-[image:var(--brand-gradient)]"}`} style={{ width: `${burnPct}%` }} />
          </div>
        </div>
      )}

      {rollup.budget > 0 && (
        <OutlookCard outlook={outlook} rollup={rollup} cur={cur} authorized={basis?.authorized ?? null}
          onQuotes={() => setView("quotes")} />
      )}

      {rollup.budget > 0 && !phaseMoney && (
        <LinesChart rows={rollup.accounts.map((r) => ({ name: r.account.name, budget: r.account.budget, committed: r.committed, spent: r.spent }))} cur={cur} />
      )}

      {mixedCurrency && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-[11px] font-bold text-amber-800 dark:text-amber-300">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          Accounts use mixed currencies ({rollup.currencies.join(", ")}) - the totals above sum raw numbers. Keep one currency per project for honest rollups.
        </div>
      )}

      {/* ── The picture: S-curve, forecast sentence, crew curve (or the
             watermarked EXAMPLE preview until real numbers exist) ── */}
      <CostCharts rollup={rollup} entries={entries}
        scheduleStart={schedSpan.start} scheduleEnd={schedSpan.end}
        awardedLaborHours={awardedLaborHours} />

      {/* ── Plain-language glossary — visible, not a hover Easter egg ── */}
      <CostGlossary />
      </>)}

      {/* ── Inbound quotes → AI read → bid tabulation → award ── */}
      {(view === "quotes" || view === "invoices") && (
        <QuotesPanel orgId={orgId} projectId={projectId} canManage={canManage} actor={actor}
          section={view} parties={parties} entries={entries}
          accounts={accounts} docs={docs} onChanged={() => void refresh()} setErr={setErr} />
      )}

      {/* ── Change orders — never a silent budget edit ── */}
      {view === "changes" && (
        <ChangeOrdersPanel orgId={orgId} projectId={projectId} canManage={canManage} actor={actor}
          accounts={accounts} parties={parties} onMoneyMoved={() => void refresh()} setErr={setErr} />
      )}

      {view === "budget" && (<>
      {/* ── Budget basis + build-from-document ── */}
      <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
          <FileCheck2 className="w-4 h-4 text-[var(--color-accent)]" />
          <span className="text-sm font-bold text-[var(--color-text)]">Budget basis</span>
          {canManage && !importing && accounts.length > 0 && (
            <button onClick={() => setShowDrop((v) => !v)}
              className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
              <FileUp className="w-3 h-3" /> Read a revised AFE or budget sheet
            </button>
          )}
        </div>
        {/* How the money is tracked, in one line. */}
        <div className="px-4 pt-2.5 text-[11.5px] text-[var(--color-text-muted)]">
          <b className="text-[var(--color-text)]">AFE</b> (what&apos;s authorized) → <b className="text-[var(--color-text)]">Budget lines</b> (how it&apos;s split, by contractor or scope) → <b className="text-[var(--color-text)]">Quotes / POs</b> (awarded, committed) → <b className="text-[var(--color-text)]">Invoices</b> (spent). Each can be changed; every change is kept with why.
        </div>
        <AfeCard orgId={orgId} projectId={projectId} afe={basis} linesTotal={rollup.budget} cur={cur} canManage={canManage} actor={actor}
          fileOf={(id) => fileOfDoc(id ? docs.find((d) => d.id === id) : null)}
          onSaved={(msg) => { setNotice(msg); void refresh(); }} />
        {importing ? (
          <BudgetImportSheet orgId={orgId} projectId={projectId} actor={actor} result={importing}
            accounts={accounts} parties={parties}
            onApplied={(summary) => { setImporting(null); setShowDrop(false); setNotice(summary); void refresh(); }}
            onClose={() => setImporting(null)} />
        ) : canManage && (accounts.length === 0 || showDrop) ? (
          <div className="p-4">
            <BudgetDocDrop orgId={orgId} projectId={projectId} onRead={setImporting}
              label={accounts.length === 0 ? "Drop the AFE, estimate, or budget sheet - the cost model builds itself" : undefined} />
          </div>
        ) : null}
      </div>

      {/* ── Budget lines: the table, each line opening to its entries ── */}
      <BudgetTable orgId={orgId} projectId={projectId} accounts={accounts} numbers={lineNumbers} entries={entries} parties={parties}
        phases={phases} phase={phase} canManage={canManage} actor={actor} cur={cur}
        onChanged={() => void refresh()} setErr={setErr} setNotice={setNotice}
        renderDetail={(account) => {
          const r = allRollup.accounts.find((x) => x.account.id === account.id);
          if (!r) return null;
          return (
            <div className="bg-[var(--color-surface-2)]/30">
              {canManage && account.status !== "closed" && (
                <div className="px-4 pt-3">
                  {editingLine === account.id ? (
                    <LineEditor orgId={orgId} projectId={projectId} account={account} parties={parties} actor={actor}
                      onCancel={() => setEditingLine(null)}
                      onSaved={(msg) => { setEditingLine(null); setNotice(msg); void refresh(); }} />
                  ) : (
                    <button onClick={() => setEditingLine(account.id)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[11.5px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">Change the budget with a reason</button>
                  )}
                </div>
              )}
              <AccountDetail
                orgId={orgId} projectId={projectId} actor={actor}
                rollup={r} entries={entriesByAccount.get(account.id) ?? []} parties={parties} milestones={milestones}
                history={budgetHistory.get(account.id) ?? []} onNotice={setNotice}
                canManage={canManage} busy={busy} setBusy={setBusy}
                onChanged={() => void refresh()} setErr={setErr}
              />
            </div>
          );
        }} />

      {/* ── Parties ── */}
      <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
        <button onClick={() => setShowParties((v) => !v)} className="w-full px-4 py-3 flex items-center gap-2 text-left hover:bg-[var(--color-surface-2)]/40 transition-colors">
          {showParties ? <ChevronDown className="w-4 h-4 text-[var(--color-text-faint)]" /> : <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)]" />}
          <HardHat className="w-4 h-4 text-[var(--color-accent)]" />
          <span className="text-sm font-bold text-[var(--color-text)]">Contractors &amp; vendors</span>
          <span className="text-[10px] font-mono text-[var(--color-text-muted)]">{parties.length}</span>
        </button>
        {showParties && (
          <PartiesPanel orgId={orgId} projectId={projectId} actor={actor} parties={parties} canManage={canManage} onChanged={() => void refresh()} />
        )}
      </div>

      </>)}
    </div>
  );
}

/** The plain-language "where you'll land" read — works from day one of the
 *  job, before a single invoice exists. */
export function OutlookCard({ outlook: o, rollup, cur, authorized, onQuotes }: {
  outlook: CostOutlook; rollup: import("@/lib/costs").ProjectCostRollup; cur: string;
  authorized: number | null; onQuotes: () => void;
}) {
  const over = rollup.accounts
    .map((r) => ({ r, ol: o.accounts.find((a) => a.accountId === r.account.id) }))
    .filter((x) => x.ol && x.ol.basis === "quote" && x.ol.forecast > x.r.account.budget + 0.5)
    .sort((a, b) => (b.ol!.forecast - b.r.account.budget) - (a.ol!.forecast - a.r.account.budget))
    .slice(0, 3);
  const unquoted = o.accounts.filter((a) => a.basis === "budget").length;
  const vsAuth = authorized != null ? o.forecast - authorized : null;
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 space-y-2">
      <div className="flex items-center gap-2">
        <Gauge className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Where this job lands</span>
        <span className="text-[10px] text-[var(--color-text-muted)]">from awarded quotes and schedule progress - no invoices needed</span>
      </div>
      <ul className="text-xs text-[var(--color-text)] space-y-1">
        <li>
          {o.quoted > 0
            ? <>Awarded quotes plus the budget for unquoted lines put the finish at <b className="tabular-nums">{fmtMoney(o.forecast, cur)}</b>
                {Math.abs(o.variance) >= 1
                  ? <> - <b className={o.variance > 0 ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300"}>{fmtMoney(Math.abs(o.variance), cur)} {o.variance > 0 ? "over" : "under"} budget</b></>
                  : " - on budget"}
                {vsAuth != null && vsAuth > 0.5 && <>, <b className="text-rose-700 dark:text-rose-300">{fmtMoney(vsAuth, cur)} over the authorization</b> (a supplement may be needed)</>}.</>
            : <>No quotes awarded yet, so the forecast is just the budget. <button onClick={onQuotes} className="font-bold text-[var(--color-accent)] hover:underline">Award quotes</button> and this becomes a real forecast.</>}
        </li>
        {over.map(({ r, ol }) => (
          <li key={r.account.id} className="text-[var(--color-text-muted)]">
            <AlertTriangle className="w-3 h-3 inline -mt-0.5 text-rose-500" /> {r.account.name}: quoted {fmtMoney(ol!.forecast, cur)} against {fmtMoney(r.account.budget, cur)} budgeted.
          </li>
        ))}
        {o.projectPct != null ? (
          <li>
            The schedule is <b>{o.projectPct}% complete</b>, so about <b className="tabular-nums">{fmtMoney(o.estimatedToDate, cur)}</b> of work has been done.
            {" "}{fmtMoney(o.invoiced, cur)} has been invoiced
            {o.unbilled >= 1 ? <> - about <b className="tabular-nums">{fmtMoney(o.unbilled, cur)}</b> is done but not billed yet (your accrual).</> : "."}
          </li>
        ) : (
          <li className="text-[var(--color-text-muted)]">
            <Hourglass className="w-3 h-3 inline -mt-0.5" /> Add the schedule (or update task % complete) and this also estimates cost to date and the not-yet-billed accrual.
          </li>
        )}
        {o.quoted > 0 && unquoted > 0 && (
          <li className="text-[10px] text-[var(--color-text-muted)]">
            {unquoted} budget line{unquoted === 1 ? " has" : "s have"} no awarded quote - {unquoted === 1 ? "it's" : "they're"} forecast at budget.
          </li>
        )}
      </ul>
    </div>
  );
}

function SubTab({ active, onClick, icon, label, count, attention }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count?: number; attention?: boolean;
}) {
  return (
    <button onClick={onClick}
      className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
        active ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
      {icon} {label}
      {count != null && count > 0 && (
        <span className={`text-[10px] font-black tabular-nums px-1.5 rounded-full ${
          active ? "bg-white/20" : attention ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-[var(--color-surface-2)]"}`}>{count}</span>
      )}
    </button>
  );
}

/** "AFE 25008 · $1,250,000 authorized" with how the plan and the spend
 *  sit against it. */
function BasisLine({ basis, budget, spent, cur, onOpen }: {
  basis: BudgetBasis; budget: number; spent: number; cur: string; onOpen?: () => void;
}) {
  const auth = basis.authorized;
  const gap = auth != null ? auth - budget : null;
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 flex items-center gap-x-3 gap-y-1 flex-wrap text-[11px] text-[var(--color-text-muted)]">
      <FileCheck2 className="w-4 h-4 text-[var(--color-accent)]" />
      {basis.afeNumber && <span className="font-black text-[var(--color-text)]">{basis.afeNumber}</span>}
      {auth != null && <span><span className="font-black tabular-nums text-[var(--color-text)]">{fmtMoney(auth, cur)}</span> authorized</span>}
      {auth != null && gap != null && Math.abs(gap) >= 1 && (
        <span className={gap < 0 ? "font-bold text-rose-700 dark:text-rose-300" : ""}>
          budget lines {gap < 0 ? "exceed" : "leave"} {fmtMoney(Math.abs(gap), cur)} {gap < 0 ? "over the authorization" : "unallocated"}
        </span>
      )}
      {auth != null && auth > 0 && (
        <span className={spent > auth ? "font-bold text-rose-700 dark:text-rose-300" : ""}>
          {Math.round((spent / auth) * 100)}% of authorization spent
        </span>
      )}
      {onOpen && <button onClick={onOpen} className="ml-auto font-bold text-[var(--color-accent)] hover:underline">view document</button>}
    </div>
  );
}

// ── pieces ──────────────────────────────────────────────────────────────

function StatCard({ icon, label, value, sub, tone }: {
  icon: React.ReactNode; label: string; value: string; sub?: string;
  tone: "accent" | "sky" | "violet" | "emerald" | "rose";
}) {
  const tones: Record<string, string> = {
    accent: "text-[var(--color-accent)] bg-[var(--color-accent-soft)]",
    sky: "text-sky-600 bg-sky-500/10",
    violet: "text-violet-600 bg-violet-500/10",
    emerald: "text-emerald-600 bg-emerald-500/10",
    rose: "text-rose-600 bg-rose-500/10",
  };
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5 shadow-sm">
      <div className="flex items-center gap-2">
        <span className={`p-1.5 rounded-lg ${tones[tone]}`}>{icon}</span>
        <span className="text-[12px] font-semibold text-[var(--color-text-muted)]">{label}</span>
      </div>
      <div className="mt-2 text-lg font-black tabular-nums text-[var(--color-text)] truncate">{value}</div>
      {sub && <div className="text-[10px] font-bold text-[var(--color-text-muted)] mt-0.5">{sub}</div>}
    </div>
  );
}

function AccountDetail({ orgId, projectId, actor, rollup: r, entries, parties, milestones, history, onNotice, canManage, busy, setBusy, onChanged, setErr }: {
  orgId: string; projectId: string; actor: { uid: string; email: string | null };
  rollup: import("@/lib/costs").AccountRollup;
  entries: CostEntry[]; parties: CostParty[]; milestones: Array<{ id: string; name: string; pct: number }>;
  history: BudgetChange[]; onNotice: (m: string) => void;
  canManage: boolean; busy: string | null; setBusy: (v: string | null) => void;
  onChanged: () => void; setErr: (m: string | null) => void;
}) {
  const a = r.account;
  const [pinDraft, setPinDraft] = useState(a.wbsMilestoneId ?? "");
  const [revising, setRevising] = useState<string | null>(null);
  const cur = a.currency ?? "USD";
  const savePin = async (v: string) => {
    setPinDraft(v);
    setBusy(a.id);
    const res = await saveAccount({ orgId, projectId, id: a.id, patch: { wbsMilestoneId: v || null }, actor });
    setBusy(null);
    if (!res.ok) setErr(res.error ?? "Couldn't pin the milestone."); else onChanged();
  };

  return (
    <div className="px-4 pb-4 pt-1 space-y-3 border-t border-dashed border-[var(--color-border)]">
      {canManage && (
        <div className="flex items-end gap-3 flex-wrap pt-2">
          <label className="block">
            <span className="text-[9px] font-black uppercase tracking-wider text-[var(--color-text-muted)]" title="Earned value = budget × the pinned task's % complete">Pin to schedule task (for EV)</span>
            <select value={pinDraft} onChange={(e) => void savePin(e.target.value)}
              className="mt-0.5 h-8 w-64 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs">
              <option value="">Not pinned</option>
              {milestones.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.pct}%)</option>)}
            </select>
          </label>
          <div className="text-[10px] text-[var(--color-text-muted)] pb-1.5">
            Committed {fmtMoney(r.committed, cur)} · Actual {fmtMoney(r.actual, cur)}{r.adjustments !== 0 ? ` · Adjustments ${fmtMoney(r.adjustments, cur)}` : ""}
          </div>
        </div>
      )}

      <BudgetHistory changes={history} cur={cur} />

      {canManage && <EntryForm orgId={orgId} projectId={projectId} accountId={a.id} parties={parties} actor={actor} onDone={onChanged} setErr={setErr} />}

      {entries.length === 0 ? (
        <div className="text-[11px] italic text-[var(--color-text-faint)]">No entries yet - enter the awarded quote or PO (Quote / PO), then invoices as actuals.</div>
      ) : (
        <ul className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden">
          {entries.map((e) => (
            <li key={e.id} className={`px-3 py-2 flex flex-wrap items-center gap-2 text-xs ${e.status === "void" ? "opacity-50" : ""}`}>
              <span className={`shrink-0 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                e.entryType === "commitment" ? "text-sky-700 dark:text-sky-300 border-sky-500/40 bg-sky-500/10"
                : e.entryType === "actual" ? "text-violet-700 dark:text-violet-300 border-violet-500/40 bg-violet-500/10"
                : "text-amber-700 dark:text-amber-300 border-amber-500/40 bg-amber-500/10"}`}>
                {e.entryType}
              </span>
              <span className={`font-black tabular-nums ${e.status === "void" ? "line-through" : ""} text-[var(--color-text)]`}>{fmtMoney(e.amount, cur)}</span>
              <span className="text-[var(--color-text-muted)] truncate">
                {e.entryDate ? new Date(e.entryDate).toLocaleDateString() : "-"}
                {e.reference ? ` · ${e.reference}` : ""}
                {e.description ? ` · ${e.description}` : ""}
                {e.createdByName ? ` · ${e.createdByName}` : ""}
              </span>
              {e.status === "void" && <span className="text-[9px] font-black text-[var(--color-text-faint)]">VOID</span>}
              {canManage && e.status !== "void" && (
                <button
                  onClick={async () => {
                    if (!(await appConfirm({ message: `Void this ${e.entryType} of ${fmtMoney(e.amount, cur)}? It stays on the record (struck through) and leaves every total.`, tone: "danger" }))) return;
                    setBusy(e.id);
                    const res = await voidEntry({ orgId, entryId: e.id, actor });
                    setBusy(null);
                    if (!res.ok) setErr(res.error ?? "Couldn't void the entry."); else onChanged();
                  }}
                  disabled={busy === e.id}
                  className="ml-auto shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-faint)] hover:text-rose-600 hover:bg-rose-500/10 transition-colors"
                  title="Void (financial records are never deleted)"
                >
                  <Ban className="w-3 h-3" /> Void
                </button>
              )}
              {canManage && e.status !== "void" && revising !== e.id && (
                <button onClick={() => setRevising(e.id)} title="A revised quote, PO or invoice: the old amount stays on the record, struck through"
                  className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                  Change amount
                </button>
              )}
              {revising === e.id && (
                <EntryRevise orgId={orgId} projectId={projectId} entry={e} cur={cur} actor={actor}
                  onCancel={() => setRevising(null)}
                  onDone={(msg) => { setRevising(null); onNotice(msg); onChanged(); }} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EntryForm({ orgId, projectId, accountId, parties, actor, onDone, setErr }: {
  orgId: string; projectId: string; accountId: string; parties: CostParty[];
  actor: { uid: string; email: string | null };
  onDone: () => void; setErr: (m: string | null) => void;
}) {
  const [type, setType] = useState<CostEntryType>("actual");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [party, setParty] = useState("");
  const [ref, setRef] = useState("");
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n === 0) { setErr("Enter a non-zero amount."); return; }
    setSaving(true);
    const res = await addEntry({
      orgId, projectId, costAccountId: accountId,
      entryType: type, amount: n, entryDate: date,
      partyId: party || null, reference: ref || null, description: desc || null,
      actor,
    });
    setSaving(false);
    if (!res.ok) { setErr(res.error ?? "Couldn't post the entry."); return; }
    setAmount(""); setRef(""); setDesc("");
    onDone();
  };

  return (
    <div className="rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)]/40 p-2.5 flex items-end gap-2 flex-wrap">
      <div className="inline-flex items-center rounded-lg border border-[var(--color-border)] p-0.5 gap-0.5">
        {ENTRY_TYPES.map((t) => (
          <button key={t.v} onClick={() => setType(t.v)} title={t.hint}
            className={`px-2 py-1 rounded-md text-[10px] font-black transition-colors ${type === t.v ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"}`}>
            {t.label}
          </button>
        ))}
      </div>
      <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" inputMode="decimal"
        className="h-8 w-28 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs font-mono tabular-nums" />
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
        className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs [color-scheme:light] dark:[color-scheme:dark]" />
      {parties.length > 0 && (
        <select value={party} onChange={(e) => setParty(e.target.value)} className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs">
          <option value="">Party…</option>
          {parties.filter((p) => p.status !== "inactive").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
      <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="PO / invoice #"
        className="h-8 w-32 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs font-mono" />
      <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description"
        className="h-8 flex-1 min-w-32 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
      <button onClick={() => void submit()} disabled={saving}
        className="h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50 transition-colors">
        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Post
      </button>
    </div>
  );
}

function PartiesPanel({ orgId, projectId, actor, parties, canManage, onChanged }: {
  orgId: string; projectId: string; actor: { uid: string; email: string | null };
  parties: CostParty[]; canManage: boolean; onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("contractor");
  const [trade, setTrade] = useState("");
  const [contract, setContract] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A company being edited, and one being switched on or off the job.
  const [editing, setEditing] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Never deleted: their quotes, invoices and entries still point at them.
  const setStatus = async (p: CostParty, status: "active" | "inactive") => {
    if (status === "inactive" && !(await appConfirm({
      title: `Deactivate ${p.name}?`,
      message: "They stay on everything already recorded (quotes, invoices, change orders), but aren't offered for new entries. Reactivate any time.",
      confirmLabel: "Deactivate",
    }))) return;
    setBusyId(p.id); setError(null);
    const res = await saveParty({ orgId, projectId, id: p.id, patch: { status }, actor });
    setBusyId(null);
    if (!res.ok) { setError(res.error ?? "Couldn't change it."); return; }
    onChanged();
  };

  const add = async () => {
    if (!name.trim()) { setError("Name is required."); return; }
    setSaving(true); setError(null);
    const res = await saveParty({
      orgId, projectId,
      patch: {
        name: name.trim(), kind, trade: trade || null,
        contractValue: contract ? Number(contract) : null,
      },
      actor,
    });
    setSaving(false);
    if (!res.ok) { setError(res.error ?? "Couldn't add the party."); return; }
    setName(""); setTrade(""); setContract("");
    onChanged();
  };

  return (
    <div className="px-4 pb-4 space-y-2 border-t border-[var(--color-border)]">
      {parties.length > 0 && (
        <ul className="pt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
          {parties.map((p) => editing === p.id ? (
            <li key={p.id} className="sm:col-span-2">
              <PartyEditor orgId={orgId} projectId={projectId} actor={actor} party={p}
                onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />
            </li>
          ) : (
            <li key={p.id} className={`rounded-xl border border-[var(--color-border)] px-3 py-2 ${p.status === "inactive" ? "opacity-60" : ""}`}>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-[var(--color-text)] truncate">{p.name}</span>
                {p.kind && <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{p.kind}</span>}
                {p.status === "inactive" && <span className="text-[9px] font-bold text-[var(--color-text-faint)]">inactive</span>}
                {canManage && (
                  <span className="ml-auto flex items-center gap-1 shrink-0">
                    <button onClick={() => setEditing(p.id)} title="Change the name, kind, trade or contact"
                      className="inline-flex items-center gap-1 px-1.5 py-1 rounded text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                      <Pencil className="w-3 h-3" /> Edit
                    </button>
                    <button onClick={() => void setStatus(p, p.status === "inactive" ? "active" : "inactive")} disabled={busyId === p.id}
                      title={p.status === "inactive" ? "Put them back on the job's pick lists" : "Off the job: they stay on everything already recorded, but aren't offered for new entries"}
                      className="inline-flex items-center gap-1 px-1.5 py-1 rounded text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
                      {busyId === p.id ? <Loader2 className="w-3 h-3 animate-spin" /> : p.status === "inactive" ? <RotateCcw className="w-3 h-3" /> : <Ban className="w-3 h-3" />}
                      {p.status === "inactive" ? "Reactivate" : "Deactivate"}
                    </button>
                  </span>
                )}
              </div>
              <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                {[p.trade, p.contractValue != null ? `contract ${fmtMoney(p.contractValue)}` : null, p.contactName, p.contactEmail].filter(Boolean).join(" · ") || "-"}
              </div>
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <div className="pt-1 flex items-end gap-2 flex-wrap">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Company name" className="h-8 flex-1 min-w-40 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs">
            <option value="contractor">contractor</option>
            <option value="vendor">vendor</option>
            <option value="internal">internal</option>
          </select>
          <input value={trade} onChange={(e) => setTrade(e.target.value)} placeholder="Trade (piping, E&I…)" className="h-8 w-36 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
          <input value={contract} onChange={(e) => setContract(e.target.value)} placeholder="Contract value" inputMode="decimal" className="h-8 w-32 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs font-mono tabular-nums" />
          <button onClick={() => void add()} disabled={saving} className="h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Add
          </button>
          {error && <span className="text-[11px] font-bold text-rose-700">{error}</span>}
        </div>
      )}
    </div>
  );
}

/** One company's details, changed in place. */
function PartyEditor({ orgId, projectId, actor, party, onCancel, onSaved }: {
  orgId: string; projectId: string; actor: { uid: string; email: string | null };
  party: CostParty; onCancel: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(party.name);
  const [kind, setKind] = useState(party.kind ?? "contractor");
  const [trade, setTrade] = useState(party.trade ?? "");
  const [contract, setContract] = useState(party.contractValue != null ? String(party.contractValue) : "");
  const [contactName, setContactName] = useState(party.contactName ?? "");
  const [contactEmail, setContactEmail] = useState(party.contactEmail ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = "h-8 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs";
  const label = "text-[9px] font-black uppercase tracking-wider text-[var(--color-text-muted)]";

  const save = async () => {
    if (!name.trim()) { setError("Name is required."); return; }
    const cv = contract.trim() ? parseMoney(contract) : null;
    if (contract.trim() && (cv == null || cv < 0)) { setError("Contract value should be a number."); return; }
    setSaving(true); setError(null);
    const res = await saveParty({
      orgId, projectId, id: party.id,
      patch: {
        name: name.trim(), kind, trade: trade || null, contractValue: cv,
        contactName: contactName || null, contactEmail: contactEmail || null,
      },
      actor,
    });
    setSaving(false);
    if (!res.ok) { setError(res.error ?? "Couldn't save."); return; }
    onSaved();
  };

  return (
    <div className="rounded-xl border border-[var(--color-accent-ring)]/50 bg-[var(--color-accent-soft)]/30 p-3 space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <label className="block sm:col-span-2"><span className={label}>Company name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={`mt-0.5 ${field}`} /></label>
        <label className="block"><span className={label}>Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={`mt-0.5 ${field}`}>
            <option value="contractor">contractor</option>
            <option value="vendor">vendor</option>
            <option value="rental">rental</option>
            <option value="internal">internal</option>
          </select></label>
        <label className="block"><span className={label}>Trade</span>
          <input value={trade} onChange={(e) => setTrade(e.target.value)} placeholder="Piping, E&I…" className={`mt-0.5 ${field}`} /></label>
        <label className="block"><span className={label}>Contract value</span>
          <input value={contract} onChange={(e) => setContract(e.target.value)} inputMode="decimal" className={`mt-0.5 ${field} font-mono tabular-nums`} /></label>
        <span className="hidden sm:block" />
        <label className="block"><span className={label}>Contact name</span>
          <input value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Who you call" className={`mt-0.5 ${field}`} /></label>
        <label className="block sm:col-span-2"><span className={label}>Contact email</span>
          <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} type="email" inputMode="email" placeholder="name@company.com" className={`mt-0.5 ${field}`} /></label>
      </div>
      <div className="flex items-center gap-2">
        {error && <span className="text-[11px] font-bold text-rose-700">{error}</span>}
        <span className="ml-auto flex items-center gap-2">
          <button onClick={onCancel} className="px-2 py-1.5 text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>
          <button onClick={() => void save()} disabled={saving} className="h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Save
          </button>
        </span>
      </div>
    </div>
  );
}
