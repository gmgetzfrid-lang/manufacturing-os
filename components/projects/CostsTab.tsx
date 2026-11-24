"use client";

// CostsTab — the COST COMMAND CENTER on the project page.
//
// One screen, the whole money story, readable by a rookie. Split into
// sub-tabs (Overview · Contractors · Budget · Quotes · Invoices · Change
// orders) so each job is one screen, and each sub-tab opens with one answer
// line: its one key number big ("62% of the $1,250,000 AFE is committed"),
// the one main action beside it, everything else smaller and below
// (cost/Answer). Nothing invoiced says "No invoices in yet", never a green
// "left". Adding anything is a short row; the rest is edited on the line.
// A project with no budget opens on Budget, where dropping the AFE /
// estimate builds the model; the watermarked EXAMPLE charts are one tap
// away until real numbers exist. Writes: org controllers and the PROJECT
// OWNER (RLS, 20261013); everyone on the project reads the same picture.

import { activeOnly } from "@/lib/activeMilestones";
import { Card } from "@/components/ui/PageHero";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { SubTabs } from "@/components/projects/SubTabs";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";
import {
  Plus, X, Loader2, Check, ChevronRight, AlertTriangle, Ban, FileCheck2, FileUp, Hourglass, Pencil, RotateCcw, CircleAlert
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
import ContractorsPanel from "@/components/projects/cost/ContractorsPanel";
import { OPEN_COSTS_EVENT, takePendingCosts, type CostsViewAsked } from "@/lib/costsNav";
import { sayError } from "@/components/projects/sayError";
import { InlineAddRow } from "@/components/ui/InlineAddRow";
import { MoreDetails } from "@/components/ui/MoreDetails";
import { AnswerLine, SpendBar, answerButton, money, share } from "@/components/projects/cost/Answer";

type CostView = "overview" | "contractors" | "budget" | "quotes" | "invoices" | "changes";

interface BudgetBasis { afeNumber: string | null; chargeAccount: string | null; authorized: number | null; docId: string | null }

const ENTRY_TYPES: Array<{ v: CostEntryType; label: string; hint: string }> = [
  { v: "commitment", label: "Quote / PO", hint: "Awarded quote, PO or contract value: money promised. Type it here when the quote was a phone call or email." },
  { v: "actual", label: "Actual", hint: "Invoice or timesheet: money really spent" },
  { v: "adjustment", label: "Adjustment", hint: "Signed correction (can be negative to credit back)" },
];

export default function CostsTab({ orgId, projectId, canManage, uid, userEmail, onDataChanged, phases = [], phase = null, tz = "America/Los_Angeles" }: {
  orgId: string; projectId: string; canManage: boolean; uid: string; userEmail?: string | null;
  /** The plant's time zone (shift windows for the contractors' days). */
  tz?: string;
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
  // A view asked for from elsewhere (a contractor's page from the shift meeting).
  const [asked, setAsked] = useState<CostsViewAsked | null>(() => takePendingCosts());
  const [view, setView] = useState<CostView | null>(() => asked?.view ?? null);
  useEffect(() => {
    const on = (e: Event) => { const a = (e as CustomEvent<CostsViewAsked>).detail; if (!a) return; takePendingCosts(); setAsked({ ...a }); setView(a.view); };
    window.addEventListener(OPEN_COSTS_EVENT, on);
    return () => window.removeEventListener(OPEN_COSTS_EVENT, on);
  }, []);
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
      setErr(sayError(e));
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

  // The Overview's answer: how much of the AFE (or, without one, the
  // budget) is committed and how much is spent. Spent is what is invoiced;
  // nothing invoiced says so, never as money to spare (next-update 1).
  const auth = basis?.authorized != null && basis.authorized > 0 ? basis.authorized : null;
  const base = auth ?? rollup.budget;
  const baseName = auth != null ? "AFE" : "budget";
  const committed = Math.max(0, rollup.committed);
  const invoiced = outlook.invoiced;
  const hasRealData = rollup.budget > 0 || entries.some((e) => e.status !== "void");
  const linesGap = auth != null ? auth - rollup.budget : null;
  const closedLines = accounts.length - openAccounts.length;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  if (loading) return <SkeletonRows rows={6} cols={3} what="costs" />;

  // The Overview's one main action: what the money is waiting on.
  const overviewAction = base <= 0
    ? <button type="button" onClick={() => setView("budget")} className={answerButton}>Build the budget</button>
    : invoiceOpen > 0
      ? <button type="button" onClick={() => setView("invoices")} className={answerButton}>Check {plural(invoiceOpen, "invoice")}</button>
      : committed <= 0
        ? <button type="button" onClick={() => setView("quotes")} className={answerButton}>Add quotes</button>
        : <button type="button" onClick={() => setView("invoices")} className={answerButton}>Add invoices</button>;
  const phaseLeft = phaseMoney ? phaseMoney.s.budget - phaseMoney.s.spent : 0;

  return (
    <div className="space-y-4">
      {preview && <FilePreviewModal file={preview} onClose={() => setPreview(null)} />}
      {/* ── Sub-tabs: one job per screen; what just happened, under them ── */}
      <div>
      {/* The costs' parts as underline tabs; a count is plain figures, a dot
          marks invoices waiting to be checked. */}
      <SubTabs label="Costs" value={view ?? "overview"} className="border-b border-[var(--color-border)]"
        onChange={(id) => { if (id === "contractors") setAsked(null); setView(id); }}
        items={[
          { id: "overview" as const, label: "Overview" },
          { id: "contractors" as const, label: "Contractors" },
          { id: "budget" as const, label: "Budget", count: accounts.length },
          { id: "quotes" as const, label: "Quotes", count: quoteCount },
          { id: "invoices" as const, label: "Invoices", count: invoiceOpen, dot: invoiceOpen > 0 ? "warn" as const : undefined, title: invoiceOpen ? `${invoiceOpen} to check` : undefined },
          { id: "changes" as const, label: "Change orders" },
        ]} />
      {err && (
        <div className="mt-3 flex items-start gap-2">
          <ErrorNote compact className="flex-1" title={err} next="" />
          <button onClick={() => setErr(null)} aria-label="Dismiss" className="shrink-0 w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 -mt-1 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>
      )}
      {notice && (
        <div role="status" className="mt-2 flex items-center gap-2 text-body font-medium text-[var(--color-text)]">
          <Check className="w-4 h-4 shrink-0 text-[var(--state-released-text)]" /> <span className="min-w-0 flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss" className="ui-hit shrink-0 p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
      </div>

      {view === "overview" && (<>
      {/* ── The answer: how much of the AFE is committed and spent, the
             bar of it, then the four figures small and the AFE line ── */}
      <Card>
        {base > 0 ? (
          <AnswerLine value={committed > 0 ? share(committed, base) : undefined} tone={committed > base + 0.5 ? "bad" : undefined} action={overviewAction}>
            {committed > 0
              ? <>of the {money(base, cur)} {baseName} is committed ({money(committed, cur)}).</>
              : <>Nothing committed yet against the {money(base, cur)} {baseName}.</>}{" "}
            {invoiced > 0
              ? <>{money(invoiced, cur)} spent, {share(invoiced, base)}.</>
              : <span className="text-[var(--color-text-muted)]">No invoices in yet.</span>}
          </AnswerLine>
        ) : (
          <AnswerLine action={overviewAction}>
            {committed > 0 || invoiced > 0
              ? <>{money(committed, cur)} committed and {invoiced > 0 ? `${money(invoiced, cur)} spent` : "no invoices in yet"}, with no budget set.</>
              : "No budget yet. It is built from the AFE, estimate or budget sheet."}
          </AnswerLine>
        )}
        {base > 0 && (
          <div className="mt-3">
            <SpendBar name={`The ${baseName}`} budget={base} committed={committed} spent={invoiced} cur={cur} labels={false} thick />
          </div>
        )}
        {hasRealData && (
          <div className="mt-4 pt-3 border-t border-[var(--color-border)]">
            <MoneyRow items={[
              ["Budget", fmtMoney(rollup.budget, cur), undefined, closedLines ? `${plural(closedLines, "closed line")} left out` : undefined],
              ["Quoted (awarded)", fmtMoney(rollup.committed, cur), undefined, rollup.budget > 0 ? `${Math.round(outlook.quotedCoverage * 100)}% of the budget has a quote` : undefined],
              ["Cost to date (est.)", fmtMoney(outlook.estimatedToDate, cur), undefined, `${invoiced > 0 ? `${fmtMoney(invoiced, cur)} invoiced` : "No invoices in yet"}${outlook.unbilled >= 1 ? ` · ${fmtMoney(outlook.unbilled, cur)} not billed yet` : ""}`],
              ["Forecast at finish", fmtMoney(outlook.forecast, cur), rollup.budget > 0 && outlook.variance >= 1 ? "bad" : undefined,
                rollup.budget <= 0 ? undefined : outlook.quoted <= 0 ? "the budget, until quotes are awarded" : Math.abs(outlook.variance) < 1 ? "on budget" : `${fmtMoney(Math.abs(outlook.variance), cur)} ${outlook.variance > 0 ? "over" : "under"} budget`],
            ]} />
          </div>
        )}
        {basis && (basis.afeNumber || basis.authorized != null) && (
          <BasisLine basis={basis} budget={rollup.budget} spent={outlook.estimatedToDate} cur={cur} onOpen={basisDoc?.fileUrl ? () => setPreview(fileOfDoc(basisDoc)) : undefined} />
        )}
      </Card>

      {/* ── The phase picked: its share of the money ── */}
      {phaseMoney && (
        <Card label={<>{phaseMoney.phase.name} · {phaseMoney.phase.share}% of the {basis?.authorized != null ? "AFE" : "budget"} <HelpTooltip>Lines kept for {phaseMoney.phase.name} count whole; every other line counts its {phaseMoney.phase.share}% share. Spending counts where it was booked, else by its date. The answer above is the whole project.</HelpTooltip></>}>
          <MoneyRow items={[["Phase budget", fmtMoney(phaseMoney.s.budget, cur)], ["Committed", fmtMoney(phaseMoney.s.committed, cur)], ["Spent", fmtMoney(phaseMoney.s.spent, cur)],
            phaseMoney.s.spent <= 0 ? ["Left", "No invoices in yet", "muted"]
              : [phaseLeft >= 0 ? "Left" : "Over", fmtMoney(Math.abs(phaseLeft), cur), phaseLeft >= 0 ? undefined : "bad"]]} />
        </Card>
      )}

      {/* ── Each budget line against its own budget ── */}
      {phaseMoney && phaseMoney.s.lines.length > 0 && <LinesChart rows={phaseMoney.s.lines} cur={cur} />}
      {rollup.budget > 0 && !phaseMoney && (
        <LinesChart rows={rollup.accounts.map((r) => ({ name: r.account.name, budget: r.account.budget, committed: r.committed, spent: r.spent }))} cur={cur} />
      )}

      {rollup.budget > 0 && (
        <OutlookCard outlook={outlook} rollup={rollup} cur={cur} authorized={basis?.authorized ?? null}
          onQuotes={() => setView("quotes")} />
      )}

      {mixedCurrency && (
        <p className="px-1 text-body font-medium text-[var(--state-held-text)]">
          Accounts use mixed currencies ({rollup.currencies.join(", ")}). The totals above add raw numbers. Keep one currency per project.
        </p>
      )}

      {/* ── The picture: S-curve and crew curve. Before real numbers
             exist, the watermarked example is one tap away, folded. ── */}
      {hasRealData ? (
        <CostCharts rollup={rollup} entries={entries}
          scheduleStart={schedSpan.start} scheduleEnd={schedSpan.end}
          awardedLaborHours={awardedLaborHours} />
      ) : (
        <ExampleFold>
          <CostCharts rollup={rollup} entries={entries}
            scheduleStart={schedSpan.start} scheduleEnd={schedSpan.end}
            awardedLaborHours={awardedLaborHours} />
        </ExampleFold>
      )}

      {/* ── Plain-language glossary, folded ── */}
      <CostGlossary />
      </>)}

      {/* ── Inbound quotes → AI read → bid tabulation → award ── */}
      {(view === "quotes" || view === "invoices") && (
        <QuotesPanel orgId={orgId} projectId={projectId} canManage={canManage} actor={actor}
          section={view} parties={parties} entries={entries}
          accounts={accounts} docs={docs} onChanged={() => void refresh()} setErr={setErr} />
      )}

      {/* ── Each contractor: what it should send and what it sent ── */}
      {view === "contractors" && (
        <ContractorsPanel key={asked?.company ?? "list"} orgId={orgId} projectId={projectId} canManage={canManage} actor={actor} tz={tz} phases={phases} phase={phase}
          parties={parties} accounts={accounts} entries={entries} docs={docs} initial={asked?.company ?? null}
          onPartiesChanged={() => void refresh()} onQuotes={() => setView("quotes")}
          onAddCompany={canManage ? () => { setView("budget"); setShowParties(true); } : undefined} />
      )}

      {/* ── Change orders — never a silent budget edit ── */}
      {view === "changes" && (
        <ChangeOrdersPanel orgId={orgId} projectId={projectId} canManage={canManage} actor={actor}
          accounts={accounts} parties={parties} onMoneyMoved={() => void refresh()} setErr={setErr} />
      )}

      {view === "budget" && (<>
      {/* ── The answer (what the lines add up to against the AFE), the
             AFE drop or the read to check, and the AFE itself ── */}
      <Card pad={false}>
        <div className="px-4 sm:px-5 pt-4 pb-3">
          <AnswerLine value={accounts.length ? money(rollup.budget, cur) : undefined}
            tone={linesGap != null && linesGap < -0.5 ? "bad" : undefined}
            action={canManage && !importing && accounts.length > 0 ? (
              <button type="button" onClick={() => setShowDrop((v) => !v)} aria-expanded={showDrop} className={answerButton}>
                <FileUp className="w-4 h-4" /> Read a revised AFE or budget sheet
              </button>
            ) : undefined}
            sub={accounts.length > 0 && ((linesGap != null && Math.abs(linesGap) >= 1) || closedLines > 0) ? (
              <>
                {linesGap != null && Math.abs(linesGap) >= 1 && (linesGap < 0
                  ? <span className="font-medium text-[var(--state-overdue-text)]">{money(-linesGap, cur)} more than the AFE authorizes.</span>
                  : <span>{money(linesGap, cur)} of the AFE is not on a line yet.</span>)}
                {closedLines > 0 && <span>{linesGap != null && Math.abs(linesGap) >= 1 ? " " : ""}{plural(closedLines, "closed line")} kept for the record, out of the total.</span>}
              </>
            ) : undefined}>
            {accounts.length > 0
              ? <>in {plural(openAccounts.length, "budget line")}{auth != null ? <>, {share(rollup.budget, auth)} of the {money(auth, cur)} AFE</> : null}.</>
              : "No budget lines yet."}
            {" "}<HelpTooltip>
              <b>AFE</b> (what&apos;s authorized), then <b>budget lines</b> (how it&apos;s split, by contractor or scope), then <b>quotes and POs</b> (awarded, committed), then <b>invoices</b> (spent). Each can be changed; every change is kept with why.
            </HelpTooltip>
          </AnswerLine>
        </div>
        {importing ? (
          <BudgetImportSheet orgId={orgId} projectId={projectId} actor={actor} result={importing}
            accounts={accounts} parties={parties}
            onApplied={(summary) => { setImporting(null); setShowDrop(false); setNotice(summary); void refresh(); }}
            onClose={() => setImporting(null)} />
        ) : canManage && (accounts.length === 0 || showDrop) ? (
          <div className="px-4 sm:px-5 pb-4">
            <BudgetDocDrop orgId={orgId} projectId={projectId} onRead={setImporting}
              label={accounts.length === 0 ? "Drop the AFE, estimate or budget sheet to build the budget" : undefined} />
          </div>
        ) : null}
        <div className="border-t border-[var(--color-border)]">
          <AfeCard orgId={orgId} projectId={projectId} afe={basis} cur={cur} canManage={canManage} actor={actor}
            fileOf={(id) => fileOfDoc(id ? docs.find((d) => d.id === id) : null)}
            onSaved={(msg) => { setNotice(msg); void refresh(); }} />
        </div>
      </Card>

      {/* ── Budget lines: the table, each line opening to its entries ── */}
      <BudgetTable orgId={orgId} projectId={projectId} accounts={accounts} numbers={lineNumbers} entries={entries} parties={parties}
        phases={phases} phase={phase} canManage={canManage} actor={actor} cur={cur}
        onChanged={() => void refresh()} setErr={setErr} setNotice={setNotice}
        renderDetail={(account) => {
          const r = allRollup.accounts.find((x) => x.account.id === account.id);
          if (!r) return null;
          const canEdit = canManage && account.status !== "closed";
          return (
            <div className="bg-[var(--color-surface-2)]/30">
              {canEdit && editingLine === account.id && (
                <div className="px-4 pt-3">
                  <LineEditor orgId={orgId} projectId={projectId} account={account} parties={parties} actor={actor}
                    onCancel={() => setEditingLine(null)}
                    onSaved={(msg) => { setEditingLine(null); setNotice(msg); void refresh(); }} />
                </div>
              )}
              <AccountDetail
                orgId={orgId} projectId={projectId} actor={actor}
                rollup={r} entries={entriesByAccount.get(account.id) ?? []} parties={parties} milestones={milestones}
                history={budgetHistory.get(account.id) ?? []} onNotice={setNotice}
                canManage={canManage} busy={busy} setBusy={setBusy}
                onChanged={() => void refresh()} setErr={setErr}
                editAction={canEdit && editingLine !== account.id ? (
                  <button type="button" onClick={() => setEditingLine(account.id)} className="inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                    <Pencil className="w-3.5 h-3.5" /> Change the budget with a reason
                  </button>
                ) : undefined}
              />
            </div>
          );
        }} />

      {/* ── The project's companies, folded with a count ── */}
      <Card pad={false} className="overflow-hidden">
        <button onClick={() => setShowParties((v) => !v)} aria-expanded={showParties} className="w-full px-4 sm:px-5 py-3.5 flex items-center gap-2 text-left hover:bg-[var(--color-surface-2)]/40 transition-colors">
          <span className="text-body font-medium text-[var(--color-text)]">Contractors &amp; vendors <span className="font-normal text-[var(--color-text-muted)] tabular-nums">{parties.length}</span></span>
          <span className="flex-1" />
          <ChevronRight className={`w-4 h-4 text-[var(--color-text-faint)] ui-chevron${(showParties) ? " rotate-90" : ""}`} />
        </button>
        {showParties && (
          <PartiesPanel orgId={orgId} projectId={projectId} actor={actor} parties={parties} canManage={canManage} onChanged={() => void refresh()} />
        )}
      </Card>

      </>)}
    </div>
  );
}

/** The example picture (watermarked stand-in numbers), folded until there
 *  are real numbers: there to look at, never in the way. */
function ExampleFold({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="inline-flex items-center gap-1.5 min-h-10 pointer-coarse:min-h-11 -ml-1 px-1 rounded-md text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
        <ChevronRight aria-hidden className={`w-4 h-4 text-[var(--color-text-muted)] ui-chevron${open ? " rotate-90" : ""}`} />
        What this page draws on a running job <span className="font-normal text-[var(--color-text-muted)]">· example</span>
      </button>
      {open && <div className="mt-2">{children}</div>}
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
    <Card label={<>Where this job lands <HelpTooltip>From awarded quotes and schedule progress, no invoices needed.</HelpTooltip></>}>
      <ul className="text-body text-[var(--color-text)] space-y-1.5">
        <li>
          {o.quoted > 0
            ? <>Awarded quotes plus the budget for unquoted lines put the finish at <b className="tabular-nums">{fmtMoney(o.forecast, cur)}</b>
                {Math.abs(o.variance) >= 1
                  ? <>: <b className={o.variance > 0 ? "text-[var(--state-overdue-text)]" : "text-[var(--state-released-text)]"}>{fmtMoney(Math.abs(o.variance), cur)} {o.variance > 0 ? "over" : "under"} budget</b></>
                  : ": on budget"}
                {vsAuth != null && vsAuth > 0.5 && <>, <b className="text-[var(--state-overdue-text)]">{fmtMoney(vsAuth, cur)} over the authorization</b> (a supplement may be needed)</>}.</>
            : <>No quotes awarded yet, so the forecast is just the budget. <button onClick={onQuotes} className="text-[var(--color-accent-text)] hover:underline">Award quotes</button> and this becomes a real forecast.</>}
        </li>
        {over.map(({ r, ol }) => (
          <li key={r.account.id} className="text-[var(--color-text-muted)]">
            <AlertTriangle className="w-3 h-3 inline -mt-0.5 text-[var(--state-overdue-text)]" /> {r.account.name}: quoted {fmtMoney(ol!.forecast, cur)} against {fmtMoney(r.account.budget, cur)} budgeted.
          </li>
        ))}
        {o.projectPct != null ? (
          <li>
            The schedule is <b>{o.projectPct}% complete</b>, so about <b className="tabular-nums">{fmtMoney(o.estimatedToDate, cur)}</b> of work has been done.
            {" "}{o.invoiced > 0 ? <>{fmtMoney(o.invoiced, cur)} has been invoiced</> : "No invoices are in yet"}
            {o.unbilled >= 1 ? <>. About <b className="tabular-nums">{fmtMoney(o.unbilled, cur)}</b> is done but not billed yet (your accrual).</> : "."}
          </li>
        ) : (
          <li className="text-[var(--color-text-muted)]">
            <Hourglass className="w-3 h-3 inline -mt-0.5" /> Add the schedule (or update task % complete) and this also estimates cost to date and the not-yet-billed accrual.
          </li>
        )}
        {o.quoted > 0 && unquoted > 0 && (
          <li className="text-caption text-[var(--color-text-muted)]">
            {unquoted} budget line{unquoted === 1 ? " has" : "s have"} no awarded quote, so {unquoted === 1 ? "it's" : "they're"} forecast at budget.
          </li>
        )}
      </ul>
    </Card>
  );
}


/** "AFE 25008 · $1,250,000 authorized" with how the plan and the work
 *  done (estimated from quotes and progress) sit against it. */
function BasisLine({ basis, budget, spent, cur, onOpen }: {
  basis: BudgetBasis; budget: number; spent: number; cur: string; onOpen?: () => void;
}) {
  const auth = basis.authorized;
  const gap = auth != null ? auth - budget : null;
  return (
    <div className="mt-3 pt-3 border-t border-[var(--color-border)] flex items-center gap-x-3 gap-y-1 flex-wrap text-caption text-[var(--color-text-muted)]">
      <FileCheck2 className="w-4 h-4 text-[var(--color-text-muted)]" />
      {basis.afeNumber && <span className="font-medium text-[var(--color-text)]">{basis.afeNumber}</span>}
      {auth != null && <span><span className="font-medium tabular-nums text-[var(--color-text)]">{fmtMoney(auth, cur)}</span> authorized</span>}
      {auth != null && gap != null && Math.abs(gap) >= 1 && (
        <span className={gap < 0 ? "font-medium text-[var(--state-overdue-text)]" : ""}>
          budget lines {gap < 0 ? "exceed" : "leave"} {fmtMoney(Math.abs(gap), cur)} {gap < 0 ? "over the authorization" : "unallocated"}
        </span>
      )}
      {auth != null && auth > 0 && (
        <span className={spent > auth ? "font-medium text-[var(--state-overdue-text)]" : ""}>
          about {Math.round((spent / auth) * 100)}% of it in work done (est.)
        </span>
      )}
      {onOpen && <button onClick={onOpen} className="ml-auto inline-flex items-center min-h-10 pointer-coarse:min-h-11 hover:underline text-[var(--color-accent-text)]">View the document</button>}
    </div>
  );
}

// ── pieces ──────────────────────────────────────────────────────────────

/** A few figures in one row, small under the answer: the name, the figure,
 *  what backs it under. No tiles: one line the eye runs along. "muted" is
 *  a figure that isn't in yet ("No invoices in yet"), never good news. */
function MoneyRow({ items }: { items: Array<[label: string, value: string, tone?: "bad" | "good" | "muted", sub?: string]> }) {
  return (
    <dl className="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3">
      {items.map(([k, v, tone, sub]) => (
        <div key={k} className="min-w-0">
          <dt className="text-caption text-[var(--color-text-muted)]">{k}</dt>
          <dd className={`text-body tabular-nums truncate ${tone === "muted" ? "text-[var(--color-text-muted)]" : `font-medium ${tone === "bad" ? "text-[var(--state-overdue-text)]" : tone === "good" ? "text-[var(--state-released-text)]" : "text-[var(--color-text)]"}`}`}>{v}</dd>
          {sub && <dd className="text-caption text-[var(--color-text-muted)]">{sub}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** One budget line opened: its money on one line (and the button to change
 *  its budget), its entries with the row to post one under their header,
 *  its budget changes, and its schedule pin folded. */
function AccountDetail({ orgId, projectId, actor, rollup: r, entries, parties, milestones, history, onNotice, canManage, busy, setBusy, onChanged, setErr, editAction }: {
  orgId: string; projectId: string; actor: { uid: string; email: string | null };
  rollup: import("@/lib/costs").AccountRollup;
  entries: CostEntry[]; parties: CostParty[]; milestones: Array<{ id: string; name: string; pct: number }>;
  history: BudgetChange[]; onNotice: (m: string) => void;
  canManage: boolean; busy: string | null; setBusy: (v: string | null) => void;
  onChanged: () => void; setErr: (m: string | null) => void;
  /** "Change the budget with a reason", beside the line's money. */
  editAction?: React.ReactNode;
}) {
  const a = r.account;
  const [pinDraft, setPinDraft] = useState(a.wbsMilestoneId ?? "");
  const [revising, setRevising] = useState<string | null>(null);
  const cur = a.currency ?? "USD";
  // What still counts first; voided entries recede to the bottom.
  const listed = [...entries].sort((x, y) => Number(x.status === "void") - Number(y.status === "void"));
  const savePin = async (v: string) => {
    setPinDraft(v);
    setBusy(a.id);
    const res = await saveAccount({ orgId, projectId, id: a.id, patch: { wbsMilestoneId: v || null }, actor });
    setBusy(null);
    if (!res.ok) setErr(res.error ?? "Couldn't pin the milestone."); else onChanged();
  };

  return (
    <div className="px-4 pb-4 pt-3 space-y-4 border-t border-dashed border-[var(--color-border)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-body text-[var(--color-text-muted)]">
          Committed <b className="font-medium tabular-nums text-[var(--color-text)]">{fmtMoney(r.committed, cur)}</b>
          {" · "}Actual <b className="font-medium tabular-nums text-[var(--color-text)]">{r.actual !== 0 ? fmtMoney(r.actual, cur) : "No invoices in yet"}</b>
          {r.adjustments !== 0 ? <>{" · "}Adjustments <b className="font-medium tabular-nums text-[var(--color-text)]">{fmtMoney(r.adjustments, cur)}</b></> : null}
        </span>
        {editAction && <span className="ml-auto">{editAction}</span>}
      </div>

      <div className="space-y-2">
        <div className="flex items-baseline gap-2">
          <h4 className="text-body font-medium text-[var(--color-text)]">Entries</h4>
          <span className="text-body tabular-nums text-[var(--color-text-muted)]">{entries.length}</span>
        </div>
        {canManage && <EntryForm orgId={orgId} projectId={projectId} accountId={a.id} defaultParty={a.partyId} parties={parties} actor={actor} onDone={onChanged} />}
        {entries.length === 0 ? (
          <p className="text-body text-[var(--color-text-muted)]">No entries yet. Enter the awarded quote or PO (Quote / PO), then invoices as actuals.</p>
        ) : (
          <ul className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden bg-[var(--color-surface)]">
            {listed.map((e) => (
              <li key={e.id} className={`px-3 py-2 flex flex-wrap items-center gap-2 text-body ${e.status === "void" ? "opacity-50" : ""}`}>
                <span className={`shrink-0 text-caption font-semibold px-1.5 py-0.5 rounded border ${
                  e.entryType === "adjustment" ? "text-[var(--state-held-text)] border-[var(--state-held)]"
                  : "text-[var(--color-text)] border-[var(--color-border-strong)] bg-[var(--color-surface-2)]"}`}>
                  {e.entryType}
                </span>
                <span className={`font-medium tabular-nums ${e.status === "void" ? "line-through" : ""} text-[var(--color-text)]`}>{fmtMoney(e.amount, cur)}</span>
                <span className="min-w-0 flex-1 truncate text-[var(--color-text-muted)]">
                  {e.entryDate ? new Date(e.entryDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "-"}
                  {e.reference ? ` · ${e.reference}` : ""}
                  {e.description ? ` · ${e.description}` : ""}
                  {e.createdByName ? ` · ${e.createdByName}` : ""}
                </span>
                {e.status === "void" && <span className="text-caption font-medium text-[var(--color-text-faint)]">VOID</span>}
                {canManage && e.status !== "void" && revising !== e.id && (
                  <button onClick={() => setRevising(e.id)} title="A revised quote, PO or invoice: the old amount stays on the record, struck through"
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1 pointer-coarse:min-h-11 rounded text-caption font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                    Change amount
                  </button>
                )}
                {canManage && e.status !== "void" && (
                  <button
                    onClick={async () => {
                      if (!(await appConfirm({ title: `Void this ${e.entryType} of ${fmtMoney(e.amount, cur)}?`, message: "It stays on the record, struck through, and leaves every total.", tone: "danger", confirmLabel: `Void ${e.entryType}` }))) return;
                      setBusy(e.id);
                      const res = await voidEntry({ orgId, entryId: e.id, actor });
                      setBusy(null);
                      if (!res.ok) setErr(res.error ?? "Couldn't void the entry."); else onChanged();
                    }}
                    disabled={busy === e.id}
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1 pointer-coarse:min-h-11 rounded text-caption font-medium text-[var(--color-text-faint)] hover:text-[var(--state-overdue-text)] hover:bg-[color-mix(in_srgb,var(--state-overdue)_10%,transparent)] transition-colors"
                    title="Void (financial records are never deleted)"
                  >
                    <Ban className="w-3 h-3" /> Void
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

      <BudgetHistory changes={history} cur={cur} />

      {canManage && (
        <MoreDetails label="Pin to a schedule task" filled={a.wbsMilestoneId ? 1 : 0} total={1}>
          <div className="max-w-md">
            <div className="flex items-center gap-1 mb-1">
              <label htmlFor={`pin-${a.id}`} className="text-body font-medium text-[var(--color-text-muted)]">Schedule task for earned value</label>
              <HelpTooltip placement="top">Earned value = this line&apos;s budget × the pinned task&apos;s % complete. Not pinned, the line follows the whole schedule&apos;s % complete.</HelpTooltip>
            </div>
            <select id={`pin-${a.id}`} value={pinDraft} onChange={(e) => void savePin(e.target.value)}
              className="h-10 pointer-coarse:h-11 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-body">
              <option value="">Not pinned</option>
              {milestones.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.pct}%)</option>)}
            </select>
          </div>
        </MoreDetails>
      )}
    </div>
  );
}

/** Post an entry on a budget line: the kind, the amount and the date (today
 *  to start); the company (the line's own to start), the PO or invoice
 *  number and a description are folded under More details. */
function EntryForm({ orgId, projectId, accountId, defaultParty, parties, actor, onDone }: {
  orgId: string; projectId: string; accountId: string; parties: CostParty[];
  /** The company the line is budgeted for: picked to start with. */
  defaultParty?: string | null;
  actor: { uid: string; email: string | null };
  onDone: () => void;
}) {
  const [type, setType] = useState<CostEntryType>("actual");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [party, setParty] = useState(defaultParty ?? "");
  const [ref, setRef] = useState("");
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickParties = parties.filter((p) => p.status !== "inactive" || p.id === party);
  const lbl = "block mb-1 text-body font-medium text-[var(--color-text-muted)]";
  const fld = "h-10 pointer-coarse:h-11 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-body text-[var(--color-text)]";

  const submit = async () => {
    const n = parseMoney(amount);
    if (n == null || n === 0) { setError("Type the amount as a number, not 0 (minus for a credit)."); return; }
    setSaving(true); setError(null);
    const res = await addEntry({
      orgId, projectId, costAccountId: accountId,
      entryType: type, amount: n, entryDate: date,
      partyId: party || null, reference: ref || null, description: desc || null,
      actor,
    });
    setSaving(false);
    if (!res.ok) { setError(res.error ?? "Couldn't post the entry."); return; }
    setAmount(""); setRef(""); setDesc("");
    onDone();
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label="Post an entry" className="space-y-1">
      <div className="flex items-end gap-2 flex-wrap">
        <div>
          <span className="flex items-center gap-1 mb-1 text-body font-medium text-[var(--color-text-muted)]">
            Kind
            <HelpTooltip placement="top">{ENTRY_TYPES.map((t) => <span key={t.v} className="block"><b>{t.label}</b>: {t.hint}{t.hint.endsWith(".") ? "" : "."}</span>)}</HelpTooltip>
          </span>
          <div role="radiogroup" aria-label="Kind of entry" className="inline-flex items-center h-10 pointer-coarse:h-auto rounded-lg border border-[var(--color-border-strong)] p-0.5 gap-0.5">
            {ENTRY_TYPES.map((t) => (
              <button key={t.v} type="button" role="radio" aria-checked={type === t.v} onClick={() => setType(t.v)} title={t.hint}
                className={`h-full pointer-coarse:h-11 px-2.5 rounded-md text-body font-medium transition-colors ${type === t.v ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-text)] ring-1 ring-inset ring-[var(--color-accent-text)]/30" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"}`}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <label className="block">
          <span className={lbl}>Amount</span>
          <input value={amount} onChange={(e) => { setAmount(e.target.value); if (error) setError(null); }} inputMode="decimal" enterKeyHint="done"
            aria-invalid={!!error} className={`${fld} w-32 font-display tabular-nums`} />
        </label>
        <label className="block">
          <span className={lbl}>Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className={`${fld} [color-scheme:light] dark:[color-scheme:dark]`} />
        </label>
        <button type="submit" disabled={saving}
          className="h-10 pointer-coarse:h-11 inline-flex items-center gap-1.5 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {saving ? "Posting" : "Post"}
        </button>
      </div>
      <p role={error ? "alert" : undefined} className="min-h-5 text-body font-medium text-[var(--state-overdue-text)]">
        {error && <span className="inline-flex items-start gap-1.5"><CircleAlert aria-hidden className="w-4 h-4 shrink-0 mt-0.5" />{error}</span>}
      </p>
      <MoreDetails filled={(party ? 1 : 0) + (ref.trim() ? 1 : 0) + (desc.trim() ? 1 : 0)} total={pickParties.length > 0 ? 3 : 2} defaultOpen={false}>
        <div className="flex items-end gap-2 flex-wrap">
          {pickParties.length > 0 && (
            <label className="block">
              <span className={lbl}>Contractor or vendor</span>
              <select value={party} onChange={(e) => setParty(e.target.value)} className={`${fld} max-w-[16rem]`}>
                <option value="">None</option>
                {pickParties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}
          <label className="block">
            <span className={lbl}>PO or invoice number</span>
            <input value={ref} onChange={(e) => setRef(e.target.value)} className={`${fld} w-40 font-display tabular-nums`} />
          </label>
          <label className="block flex-1 min-w-[12rem]">
            <span className={lbl}>Description</span>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} className={`${fld} w-full`} />
          </label>
        </div>
      </MoreDetails>
    </form>
  );
}

/** The project's companies: a row to add one the way you would in a
 *  spreadsheet (name, trade, contract value; added as a contractor, kind
 *  and contact changed with Edit), then the list. */
function PartiesPanel({ orgId, projectId, actor, parties, canManage, onChanged }: {
  orgId: string; projectId: string; actor: { uid: string; email: string | null };
  parties: CostParty[]; canManage: boolean; onChanged: () => void;
}) {
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

  // One company; a message back when what was typed can't be added.
  const add = async (name: string, trade: string, contract: string): Promise<string | undefined> => {
    if (!name.trim()) return "Type the company's name to add it.";
    const cv = contract.trim() ? parseMoney(contract) : null;
    if (contract.trim() && (cv == null || cv < 0)) return `${name.trim()}: type the contract value as a number.`;
    const res = await saveParty({
      orgId, projectId,
      patch: { name: name.trim(), kind: "contractor", trade: trade.trim() || null, contractValue: cv },
      actor,
    });
    if (!res.ok) throw new Error(res.error ?? `${name.trim()} wasn't added. Try again.`);
    return undefined;
  };

  return (
    <div className="px-4 pb-4 space-y-2 border-t border-[var(--color-border)]">
      {canManage && (
        <div className="pt-3">
          <InlineAddRow what="company" addLabel="Add"
            fields={[
              { key: "name", label: "Company name", required: true },
              { key: "trade", label: "Trade", placeholder: "Trade (piping, E&I…)", width: "w-full sm:w-44" },
              { key: "contract", label: "Contract value", type: "number", width: "w-full sm:w-36" },
            ]}
            onAdd={async (v) => {
              const msg = await add(v.name, v.trade, v.contract);
              if (msg) return msg;
              onChanged();
            }}
            onPasteRows={async (rows) => {
              let added = 0;
              try {
                for (const [name = "", trade = "", contract = ""] of rows) {
                  const msg = await add(name, trade, contract);
                  if (msg) return added ? `${added} added, then: ${msg}` : msg;
                  added++;
                }
              } finally { if (added) onChanged(); }
            }} />
        </div>
      )}
      {error && <p role="alert" className="text-body font-medium text-[var(--state-overdue-text)] flex items-start gap-1.5"><CircleAlert aria-hidden className="w-4 h-4 shrink-0 mt-0.5" /><span>{error}</span></p>}
      {parties.length > 0 && (
        <ul className={`${canManage ? "" : "pt-3 "}grid grid-cols-1 sm:grid-cols-2 gap-2`}>
          {parties.map((p) => editing === p.id ? (
            <li key={p.id} className="sm:col-span-2">
              <PartyEditor orgId={orgId} projectId={projectId} actor={actor} party={p}
                onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />
            </li>
          ) : (
            <li key={p.id} className={`rounded-xl border border-[var(--color-border)] px-3 py-2 ${p.status === "inactive" ? "opacity-60" : ""}`}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 truncate text-body font-medium text-[var(--color-text)]">{p.name}</span>
                {p.kind && <span className="text-body text-[var(--color-text-muted)]">{p.kind}</span>}
                {p.status === "inactive" && <span className="text-caption font-medium text-[var(--color-text-faint)]">inactive</span>}
                {canManage && (
                  <span className="ml-auto flex items-center gap-1 shrink-0">
                    <button onClick={() => setEditing(p.id)} title="Change the name, kind, trade or contact"
                      className="inline-flex items-center gap-1 px-1.5 py-1 pointer-coarse:min-h-11 rounded text-caption font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                      <Pencil className="w-3 h-3" /> Edit
                    </button>
                    <button onClick={() => void setStatus(p, p.status === "inactive" ? "active" : "inactive")} disabled={busyId === p.id}
                      title={p.status === "inactive" ? "Put them back on the job's pick lists" : "Off the job: they stay on everything already recorded, but aren't offered for new entries"}
                      className="inline-flex items-center gap-1 px-1.5 py-1 pointer-coarse:min-h-11 rounded text-caption font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
                      {busyId === p.id ? <Loader2 className="w-3 h-3 animate-spin" /> : p.status === "inactive" ? <RotateCcw className="w-3 h-3" /> : <Ban className="w-3 h-3" />}
                      {p.status === "inactive" ? "Reactivate" : "Deactivate"}
                    </button>
                  </span>
                )}
              </div>
              <div className="text-caption text-[var(--color-text-muted)] mt-0.5">
                {[p.trade, p.contractValue != null ? `contract ${fmtMoney(p.contractValue)}` : null, p.contactName, p.contactEmail].filter(Boolean).join(" · ") || "-"}
              </div>
            </li>
          ))}
        </ul>
      )}
      {!canManage && parties.length === 0 && <p className="pt-3 text-body text-[var(--color-text-muted)]">No companies on this project yet.</p>}
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
  const field = "h-8 pointer-coarse:h-11 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-caption";
  const label = "text-body font-medium text-[var(--color-text-muted)]";

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
    <div className="rounded-xl border border-[var(--color-accent-ring)]/50 bg-[var(--color-surface-2)] p-3 space-y-2">
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
          <input value={contract} onChange={(e) => setContract(e.target.value)} inputMode="decimal" className={`mt-0.5 ${field} font-display tabular-nums`} /></label>
        <span className="hidden sm:block" />
        <label className="block"><span className={label}>Contact name</span>
          <input value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Who you call" className={`mt-0.5 ${field}`} /></label>
        <label className="block sm:col-span-2"><span className={label}>Contact email</span>
          <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} type="email" inputMode="email" placeholder="name@company.com" className={`mt-0.5 ${field}`} /></label>
      </div>
      <div className="flex items-center gap-2">
        {error && <span role="alert" className="text-caption font-medium text-[var(--state-overdue-text)] flex items-start gap-1.5"><CircleAlert aria-hidden className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{error}</span></span>}
        <span className="ml-auto flex items-center gap-2">
          <button onClick={onCancel} className="inline-flex items-center justify-center gap-1.5 h-8 pointer-coarse:h-11 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">Cancel</button>
          <button onClick={() => void save()} disabled={saving} className="h-8 pointer-coarse:h-11 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-caption font-medium hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} {saving ? "Saving" : "Save"}
          </button>
        </span>
      </div>
    </div>
  );
}
