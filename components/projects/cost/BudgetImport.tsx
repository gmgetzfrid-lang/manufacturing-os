"use client";

// BudgetImport — "here's my AFE, build my cost model."
//
// BudgetDocDrop is the door: drop any budget document (scanned AFE, photo,
// estimate spreadsheet, Word cost sheet) and the AI reads it on the
// member's own key. BudgetImportSheet is the review: every line editable
// before anything is created, suppliers matched against the project's
// companies, the lines reconciled against the authorized amount AND the
// approved budget the request draws on. Apply creates the companies and
// budget lines (linked, so invoices route themselves later) and keeps the
// paper on the project. Lines that already exist are left alone — an
// existing budget changes only through a change order.

import React, { useMemo, useRef, useState } from "react";
import {
  FileUp, Loader2, Sparkles, X, Check, AlertTriangle, CheckCircle2, Plus, Trash2, Building2,
} from "lucide-react";
import { fmtMoney, type Actor, type CostAccount, type CostParty } from "@/lib/costs";
import {
  COST_TYPES, BUDGET_DOC_ACCEPT, reconcileBudget, planBudgetApply, matchParty,
  type BudgetLine, type ParsedBudgetDoc, type CostType,
} from "@/lib/budgetDoc";
import { readBudgetDoc, applyBudgetToProject, type BudgetReadResult } from "@/lib/budgetImport";
import { listCompanies } from "@/lib/companies";

export function BudgetDocDrop({ orgId, projectId, onRead, compact, label }: {
  orgId: string; projectId?: string | null;
  onRead: (r: BudgetReadResult) => void;
  compact?: boolean;
  label?: string;
}) {
  const [reading, setReading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const read = async (file: File | undefined) => {
    if (!file) return;
    setReading(file.name); setError(null);
    try {
      onRead(await readBudgetDoc({ orgId, projectId, file }));
    } catch (e) {
      setError((e as Error).message);
    } finally { setReading(null); }
  };

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void read(e.dataTransfer.files?.[0]); }}
        onClick={() => !reading && input.current?.click()}
        role="button" tabIndex={0}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !reading) input.current?.click(); }}
        className={`rounded-xl border-2 border-dashed transition-colors cursor-pointer flex items-center gap-3 ${compact ? "px-3 py-2.5" : "px-4 py-5"} ${
          over ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]/60" : "border-[var(--color-border-strong)] hover:border-[var(--color-accent-ring)] bg-[var(--color-surface-2)]/30"}`}
      >
        <span className="p-2 rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)] shrink-0">
          {reading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileUp className="w-4 h-4" />}
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-black text-[var(--color-text)]">
            {reading ? `Reading ${reading}…` : label ?? "Drop your AFE, estimate, or budget sheet"}
          </span>
          <span className="block text-[10px] text-[var(--color-text-muted)]">
            {reading
              ? "The AI is reading the pages - usually 20–60 seconds. Nothing is saved until you review it."
              : "PDF (scanned is fine), photo, Excel/CSV, Word, or text - any company's form. Read on your own AI key; you review before anything is created."}
          </span>
        </span>
        <input ref={input} type="file" accept={BUDGET_DOC_ACCEPT} className="hidden"
          onChange={(e) => { void read(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      {error && (
        <div className="mt-2 flex items-start gap-2 text-[11px] font-bold text-rose-700 dark:text-rose-300">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
        </div>
      )}
    </div>
  );
}

type EditLine = BudgetLine & { key: string; include: boolean };

export function BudgetImportSheet({ orgId, projectId, actor, result, accounts, parties, onApplied, onClose }: {
  orgId: string; projectId: string; actor: Actor;
  result: BudgetReadResult;
  accounts: CostAccount[]; parties: CostParty[];
  onApplied: (summary: string) => void;
  onClose: () => void;
}) {
  const p = result.parsed;
  const cur = p.currency ?? "USD";
  const [lines, setLines] = useState<EditLine[]>(() =>
    p.lines.map((l, i) => ({ ...l, key: `l${i}`, include: true })));
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const included = useMemo(() => lines.filter((l) => l.include && l.name.trim()), [lines]);
  const recon = useMemo(() => reconcileBudget({ ...p, lines: included }), [p, included]);
  const plan = useMemo(() => planBudgetApply(included, accounts, parties), [included, accounts, parties]);
  const skipped = useMemo(() => new Set(plan.accountsSkipped.map((s) => s.name.toLowerCase())), [plan]);

  const patch = (key: string, v: Partial<EditLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...v } : l)));

  const apply = async () => {
    setApplying(true); setError(null);
    try {
      const registry = await listCompanies(orgId).catch(() => []);
      const parsed: ParsedBudgetDoc = { ...p, lines: included.map(({ key: _k, include: _i, ...l }) => l) };
      const res = await applyBudgetToProject({ orgId, projectId, parsed, source: result.source, registry, actor });
      if (!res.ok) { setError(res.error ?? "Couldn't apply the budget."); return; }
      onApplied([
        `${res.accountsCreated} budget line${res.accountsCreated === 1 ? "" : "s"}`,
        res.partiesCreated ? `${res.partiesCreated} compan${res.partiesCreated === 1 ? "y" : "ies"}` : null,
      ].filter(Boolean).join(" and ") + " created"
        + (res.skipped.length ? ` · ${res.skipped.length} already existed (left as is)` : "")
        + (res.error ? ` · note: ${res.error}` : ""));
    } catch (e) {
      setError((e as Error).message);
    } finally { setApplying(false); }
  };

  return (
    <div className="border-b border-[var(--color-border)] bg-[var(--color-accent-soft)]/25">
      <div className="px-4 pt-3 pb-2 flex items-start gap-3">
        <span className="p-1.5 rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]"><Sparkles className="w-4 h-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-black text-[var(--color-text)]">
            {[p.docType, p.docNumber].filter(Boolean).join(" ") || "Budget document"}{p.title ? ` - ${p.title}` : ""}
          </div>
          <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5 flex flex-wrap gap-x-3">
            <span>{result.source.fileName}</span>
            {p.chargeAccount && <span>Account <span className="font-mono">{p.chargeAccount}</span></span>}
            {p.docDate && <span>Dated {p.docDate}</span>}
            {p.preparedBy && <span>Prepared by {p.preparedBy}</span>}
            {p.approvals.length > 0 && (
              <span>Approved: {p.approvals.map((a) => `${a.role}${a.date ? ` (${a.date})` : ""}`).join(", ")}</span>
            )}
          </div>
        </div>
        <button onClick={onClose} disabled={applying} className="p-1 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>
      </div>

      {/* Reconciliation — the three numbers that have to agree */}
      <div className="px-4 pb-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Fact label="Authorized" value={recon.authorized != null ? fmtMoney(recon.authorized, cur) : "-"} />
        <Fact label={`Lines (${included.length})`} value={fmtMoney(recon.linesTotal, cur)}
          tone={recon.balanced ? "ok" : "warn"}
          sub={recon.unallocated != null && !recon.balanced
            ? `${fmtMoney(Math.abs(recon.unallocated), cur)} ${recon.unallocated > 0 ? "not in any line" : "more than authorized"}`
            : recon.authorized != null ? "match the authorized total" : undefined} />
        <Fact label="Against approved budget"
          value={recon.budgeted != null ? fmtMoney(recon.budgeted, cur) : "-"}
          tone={recon.overBudgetBy != null && recon.overBudgetBy > 0 ? "warn" : undefined}
          sub={recon.overBudgetBy != null && recon.overBudgetBy !== 0
            ? `${fmtMoney(Math.abs(recon.overBudgetBy), cur)} ${recon.overBudgetBy > 0 ? "over" : "under"} budget`
            : p.budgetReferences.length === 0 ? "no budget item cited" : "on budget"} />
      </div>
      {result.blankPages.length > 0 && <BlankPagesNote pages={result.blankPages} />}
      {p.varianceNote && (
        <div className="mx-4 mb-2 text-[11px] text-[var(--color-text-muted)] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
          <span className="font-bold text-[var(--color-text)]">Variance: </span>{p.varianceNote}
        </div>
      )}

      {/* Lines */}
      <div className="px-4 pb-2 overflow-x-auto">
        <table className="w-full text-xs min-w-[640px]">
          <thead>
            <tr className="text-left text-[9px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
              <th className="py-1.5 w-6" />
              <th className="py-1.5">Budget line</th>
              <th className="py-1.5">Type</th>
              <th className="py-1.5">Company</th>
              <th className="py-1.5 text-right">Amount</th>
              <th className="py-1.5 w-6" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {lines.map((l) => {
              const exists = l.include && skipped.has(l.name.trim().toLowerCase());
              const known = l.supplier ? matchParty(l.supplier, parties) : null;
              return (
                <tr key={l.key} className={l.include ? "" : "opacity-45"}>
                  <td className="py-1.5">
                    <input type="checkbox" checked={l.include} onChange={(e) => patch(l.key, { include: e.target.checked })}
                      className="accent-[var(--color-accent)]" title="Include this line" />
                  </td>
                  <td className="py-1.5 pr-2">
                    <input value={l.name} onChange={(e) => patch(l.key, { name: e.target.value })}
                      className="w-full h-7 rounded-md border border-transparent hover:border-[var(--color-border)] focus:border-[var(--color-border-strong)] bg-transparent px-1.5 text-xs font-bold text-[var(--color-text)]" />
                    {(exists || l.note) && (
                      <div className="px-1.5 text-[10px] text-[var(--color-text-muted)]">
                        {exists && <span className="font-bold text-amber-700 dark:text-amber-300">Already a budget line - left as is. </span>}
                        {l.note}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    <select value={l.costType} onChange={(e) => patch(l.key, { costType: e.target.value as CostType })}
                      className="h-7 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1 text-[11px]">
                      {COST_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </td>
                  <td className="py-1.5 pr-2">
                    <div className="flex items-center gap-1">
                      <input value={l.supplier ?? ""} onChange={(e) => patch(l.key, { supplier: e.target.value.trim() ? e.target.value : null })}
                        placeholder="-" className="w-36 h-7 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[11px]" />
                      {l.supplier && !exists && (
                        <span title={known ? `Matches ${known.name} on this project` : "New company - will be added"}
                          className={`text-[9px] font-black uppercase ${known ? "text-emerald-600" : "text-[var(--color-text-faint)]"}`}>
                          {known ? <Check className="w-3 h-3" /> : "new"}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-1.5 text-right">
                    <input value={l.amount ?? ""} inputMode="decimal"
                      onChange={(e) => { const n = Number(e.target.value.replace(/[^0-9.]/g, "")); patch(l.key, { amount: e.target.value.trim() && Number.isFinite(n) ? n : null }); }}
                      className="w-28 h-7 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[11px] text-right font-mono tabular-nums" />
                  </td>
                  <td className="py-1.5 pl-1">
                    <button onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      className="p-1 text-[var(--color-text-faint)] hover:text-rose-600" title="Remove line"><Trash2 className="w-3 h-3" /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button onClick={() => setLines((ls) => [...ls, { key: `n${Date.now()}`, include: true, name: "", amount: null, supplier: null, costType: "other", note: null }])}
          className="mt-1 inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-accent)]"><Plus className="w-3 h-3" /> Add line</button>
      </div>

      <div className="px-4 py-2.5 border-t border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-[var(--color-text-muted)] inline-flex items-center gap-1">
          <Building2 className="w-3 h-3" />
          Creates {plan.accountsToCreate.length} budget line{plan.accountsToCreate.length === 1 ? "" : "s"}
          {plan.partiesToCreate.length > 0 ? ` and ${plan.partiesToCreate.length} compan${plan.partiesToCreate.length === 1 ? "y" : "ies"} (${plan.partiesToCreate.join(", ")})` : ""}.
          {" "}No money is posted - quotes and invoices do that.
        </span>
        {error && <span className="text-[11px] font-bold text-rose-700 dark:text-rose-300">{error}</span>}
        <span className="ml-auto flex items-center gap-2">
          <button onClick={onClose} disabled={applying} className="text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1">Cancel</button>
          <button onClick={() => void apply()} disabled={applying || (plan.accountsToCreate.length === 0 && recon.authorized == null)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Build cost model
          </button>
        </span>
      </div>
    </div>
  );
}

function Fact({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "warn" }) {
  const ring = tone === "warn" ? "border-amber-500/50 bg-amber-500/[0.06]" : tone === "ok" ? "border-emerald-500/40 bg-emerald-500/[0.05]" : "border-[var(--color-border)] bg-[var(--color-surface)]";
  return (
    <div className={`rounded-xl border px-3 py-2 ${ring}`}>
      <div className="text-[9px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">{label}</div>
      <div className="text-sm font-black tabular-nums text-[var(--color-text)]">{value}</div>
      {sub && <div className={`text-[10px] font-bold ${tone === "warn" ? "text-amber-700 dark:text-amber-300" : "text-[var(--color-text-muted)]"}`}>{sub}</div>}
    </div>
  );
}

export function BlankPagesNote({ pages }: { pages: number[] }) {
  return (
    <div className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-500/[0.07] px-3 py-2 text-[11px] font-bold text-amber-800 dark:text-amber-300">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>
        Page{pages.length === 1 ? "" : "s"} {pages.join(", ")} came through blank - usually a scanner compression the reader can&apos;t decode yet.
        Anything only on {pages.length === 1 ? "that page" : "those pages"} was not read; check it against the paper.
      </span>
    </div>
  );
}
