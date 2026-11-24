"use client";

// BudgetTable: the budget lines as a table you fully control: change any
// cell where it is (name, type, contractor, phase, budget), add a line the
// way you would in a spreadsheet (under the header; Enter adds it, rows
// pasted from Excel are added all at once), pick lines and set their phase, close or delete them
// together, group them with subtotals, and from a line's menu move its
// spending to another line, close it or delete it (with Undo). A line
// with spending booked on it is closed rather than deleted, so no money
// record is ever lost. Each line still opens to its entries and history.
// Under 640 px the table is a list of cards (design rule T3): the code and
// where the line stands on top, its name in bold, then budget, committed
// and spent; over budget is said in red, in words.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Loader2, Undo2, Search, ListTree, ArrowRightLeft, Archive, RotateCcw, Trash2 } from "lucide-react";
import type { Actor, CostAccount, CostEntry, CostParty } from "@/lib/costs";
import { saveAccount } from "@/lib/costs";
import { reviseAccount } from "@/lib/costRevisions";
import { canDeleteLine, deleteLine, restoreLine, setLinesClosed, setLinesPhase, moveSpend, groupLines, openStatusOf, type GroupBy } from "@/lib/costLines";
import { phaseAmount, type ProjectPhase } from "@/lib/projectPhases";
import { appConfirm } from "@/components/providers/DialogProvider";
import { fmtMoney as fmtMoneyCents } from "@/lib/costs";
import { sayError } from "@/components/projects/sayError";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { InlineAddRow } from "@/components/ui/InlineAddRow";
import { SpendBar } from "@/components/projects/cost/Answer";
import MoreMenu, { type MoreItem } from "@/components/ui/MoreMenu";
import { useNarrow } from "@/components/requests/RequestBits";

/** Whole dollars unless there are cents ("$0", "$8,000", "$1,250.50"). */
function fmtMoney(n: number, cur = "USD"): string {
  const cents = Math.round(n * 100) % 100 !== 0;
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur, minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }).format(n); }
  catch { return fmtMoneyCents(n, cur); }
}

const TYPES = ["labor", "material", "equipment", "subcontract", "other"] as const;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface LineNumbers { committed: number; spent: number }

export default function BudgetTable({ orgId, projectId, accounts, numbers, entries, parties, phases, phase, canManage, actor, cur, onChanged, setErr, setNotice, renderDetail }: {
  orgId: string; projectId: string;
  accounts: CostAccount[]; numbers: Map<string, LineNumbers>; entries: CostEntry[]; parties: CostParty[];
  phases: ProjectPhase[]; phase: string | null;
  canManage: boolean; actor: Actor; cur: string;
  onChanged: () => void; setErr: (m: string | null) => void; setNotice: (m: string | null) => void;
  renderDetail: (account: CostAccount) => React.ReactNode;
}) {
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [q, setQ] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  // A phone: the lines as cards, not a table to scroll sideways.
  const narrow = useNarrow();
  const [moving, setMoving] = useState<{ from: CostAccount; to: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{ row: Record<string, unknown>; name: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);

  const partyName = useMemo(() => new Map(parties.map((p) => [p.id, p.name])), [parties]);
  const phaseName = (id: string | null | undefined) => (id ? phases.find((p) => p.id === id)?.name ?? "Split" : "Split");
  const closedCount = accounts.filter((a) => a.status === "closed").length;
  const openStatus = openStatusOf(accounts);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return accounts
      .filter((a) => (showClosed || a.status !== "closed") && (!needle || `${a.code ?? ""} ${a.name} ${a.costType ?? ""} ${partyName.get(a.partyId ?? "") ?? ""}`.toLowerCase().includes(needle)))
      .map((a) => ({ account: a, committed: numbers.get(a.id)?.committed ?? 0, spent: numbers.get(a.id)?.spent ?? 0 }));
  }, [accounts, numbers, q, showClosed, partyName]);
  const groups = useMemo(() => groupLines(rows, groupBy, (r) =>
    groupBy === "type" ? cap(r.account.costType ?? "No type") : groupBy === "contractor" ? (partyName.get(r.account.partyId ?? "") ?? "No contractor") : phaseName(r.account.phaseId)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [rows, groupBy, partyName, phases]);
  const totals = rows.filter((r) => r.account.status !== "closed").reduce((t, r) => ({ budget: t.budget + r.account.budget, committed: t.committed + r.committed, spent: t.spent + r.spent }), { budget: 0, committed: 0, spent: 0 });

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, ok?: string) => {
    setBusy(true); setErr(null);
    try { const r = await fn(); if (!r.ok) { setErr(r.error ?? "Not saved."); return false; } if (ok) setNotice(ok); onChanged(); return true; }
    catch (e) { setErr(sayError(e, "Not saved.")); return false; }
    finally { setBusy(false); }
  };
  const savePatch = (a: CostAccount, patch: Parameters<typeof saveAccount>[0]["patch"]) => run(() => saveAccount({ orgId, projectId, id: a.id, patch, actor }));
  const saveBudget = (a: CostAccount, budget: number) => run(() => reviseAccount({ orgId, projectId, account: a, patch: { budget }, note: "Changed in the budget table", actor }));

  const remove = async (list: CostAccount[]) => {
    const ok = list.filter((a) => canDeleteLine(a.id, entries));
    const kept = list.filter((a) => !canDeleteLine(a.id, entries));
    if (!ok.length) { setErr(`${kept.map((a) => a.name).join(", ")}: spending is booked on ${kept.length === 1 ? "it" : "them"}. Move it to another line (the line's menu), then close the line: the record stays, out of the totals.`); return; }
    if (!(await appConfirm({ title: ok.length === 1 ? `Delete the budget line "${ok[0].name}"?` : `Delete ${ok.length} budget lines?`, message: ok.length === 1 ? `${fmtMoney(ok[0].budget, cur)} budget. Undo is offered for 10 seconds.` : `${fmtMoney(ok.reduce((s, a) => s + a.budget, 0), cur)} budget in all.${kept.length ? ` ${kept.length} with spending booked stay; close those instead.` : ""}`, tone: "danger", confirmLabel: ok.length === 1 ? "Delete line" : `Delete ${ok.length} lines` }))) return;
    setBusy(true); setErr(null);
    try {
      let last: { row: Record<string, unknown>; name: string } | null = null, done = 0, failed: string | null = null;
      for (const a of ok) {
        const r = await deleteLine({ orgId, lineId: a.id, actor });
        if (!r.ok) { failed = r.error ?? "Not deleted."; break; }
        last = { row: r.row!, name: a.name }; done++;
      }
      setSel(new Set());
      if (last && done === 1) {
        setUndo(last);
        if (undoTimer.current) clearTimeout(undoTimer.current);
        undoTimer.current = setTimeout(() => setUndo(null), 10_000);
      } else if (done > 1) setNotice(`${done} budget lines deleted.`);
      // Reload only when something changed (a reload clears the message).
      if (done) onChanged();
      if (failed) setErr(done ? `${done} deleted, then: ${failed}` : failed);
    } finally { setBusy(false); }
  };
  const undoDelete = async () => {
    if (!undo) return;
    const u = undo; setUndo(null);
    await run(() => restoreLine({ orgId, row: u.row, actor }), `${u.name} is back.`);
  };
  const close = (list: CostAccount[], closed: boolean) => run(() => setLinesClosed({ orgId, ids: list.map((a) => a.id), closed, openStatus, actor }),
    closed ? `${list.length === 1 ? list[0].name : `${list.length} lines`} closed: kept for the record, out of the totals.` : `${list.length === 1 ? list[0].name : `${list.length} lines`} open again.`).then((ok) => { if (ok) setSel(new Set()); });
  const setPhase = (list: CostAccount[], phaseId: string | null) => run(() => setLinesPhase({ orgId, ids: list.map((a) => a.id), phaseId, actor }),
    `${list.length === 1 ? list[0].name : `${list.length} lines`}: ${phaseId ? `${phaseName(phaseId)} only` : "split by the phases"}.`).then((ok) => { if (ok) setSel(new Set()); });
  // A line's actions, in its ⋯ menu (the table's last column, a card's foot).
  const lineMenu = (a: CostAccount): MoreItem[] => {
    const closed = a.status === "closed";
    return [
      { icon: <ListTree className="w-4 h-4" />, label: "Entries, history and full edit", onClick: () => setOpen(a.id) },
      ...(!closed ? [{ icon: <ArrowRightLeft className="w-4 h-4" />, label: "Move its spending to another line…", onClick: () => setMoving({ from: a, to: "" }) }] : []),
      closed
        ? { icon: <RotateCcw className="w-4 h-4" />, label: "Open again", onClick: () => void close([a], false) }
        : { icon: <Archive className="w-4 h-4" />, label: "Close (kept, out of the totals)", onClick: () => void close([a], true) },
      { icon: <Trash2 className="w-4 h-4" />, label: canDeleteLine(a.id, entries) ? "Delete line" : "Delete line (has spending: close it)", tone: "bad", line: true, onClick: () => void remove([a]) },
    ];
  };
  const moreBtn = "ui-press inline-flex items-center justify-center w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]";
  const pick = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // A new line: its name, budget and type (subcontract unless typed). The
  // contractor and phase are set on the line itself.
  const lineOf = (name: string, budgetText: string, typeText: string): { name: string; budget: number; type: string } | string => {
    const budget = Number(budgetText.replace(/[$,\s]/g, "") || 0);
    if (!name.trim()) return "Type the budget line's name to add it.";
    if (!Number.isFinite(budget) || budget < 0) return `${name.trim()}: type the budget as a number, 0 or more.`;
    const t = typeText.trim().toLowerCase();
    const type = !t ? "subcontract" : TYPES.find((x) => x === t || x.startsWith(t));
    if (!type) return `${name.trim()}: type one of ${TYPES.map(cap).join(", ")}.`;
    return { name: name.trim(), budget, type };
  };
  const addLine = async (l: { name: string; budget: number; type: string }) => {
    const r = await saveAccount({ orgId, projectId, patch: { name: l.name, costType: l.type, budget: l.budget, currency: cur }, actor });
    if (!r.ok) throw new Error(r.error ?? `${l.name} wasn't added. Try again.`);
  };
  const addRow = (
    <InlineAddRow what="budget line" addLabel="Add line"
      fields={[
        { key: "name", label: "Budget line", placeholder: "New budget line", required: true },
        { key: "budget", label: `Budget (${cur})`, type: "number", width: "w-full sm:w-36" },
        { key: "type", label: "Type", placeholder: "Type: subcontract", list: TYPES.map(cap), width: "w-full sm:w-40" },
      ]}
      onAdd={async (v) => {
        const l = lineOf(v.name, v.budget, v.type);
        if (typeof l === "string") return l;
        await addLine(l);
        onChanged();
      }}
      onPasteRows={async (pasted) => {
        let added = 0;
        try {
          for (const [name = "", budget = "", type = ""] of pasted) {
            const l = lineOf(name, budget, type);
            if (typeof l === "string") return added ? `${added} added, then: ${l}` : l;
            await addLine(l); added++;
          }
        } finally { if (added) onChanged(); }
      }} />
  );

  const pickedAccounts = accounts.filter((a) => sel.has(a.id));
  const allShown = rows.length > 0 && rows.every((r) => sel.has(r.account.id));
  const th = "px-2 py-2 text-left text-body font-medium text-[var(--color-text-muted)] whitespace-nowrap";
  const td = "px-2 py-1.5 align-middle";
  const sharePhase = phase ? phases.find((p) => p.id === phase) ?? null : null;

  // No lines yet: only the row to type them in (the Budget sub-tab above
  // says there are none and offers the AFE drop).
  if (accounts.length === 0) {
    if (!canManage) return null;
    return (
      <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] px-4 sm:px-5 pt-3 pb-1">
        <h3 className="text-body font-medium text-[var(--color-text)] mb-2">Or type the lines in</h3>
        {addRow}
      </div>
    );
  }

  return (
    <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <span className="text-body font-medium text-[var(--color-text)]">Budget lines</span>
        <span className="text-body text-[var(--color-text-muted)]">{accounts.length - closedCount} open{closedCount ? ` · ${closedCount} closed` : ""}</span>
        <span className="relative ml-auto">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-faint)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a line" aria-label="Find a line" className="h-8 pointer-coarse:h-11 w-40 pl-7 pr-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-caption" />
        </span>
        <label className="inline-flex items-center gap-1.5 text-caption font-medium text-[var(--color-text)]">Group
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} aria-label="Group by" className="h-8 pointer-coarse:h-11 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-caption">
            <option value="none">None</option><option value="type">Type</option><option value="contractor">Contractor</option>{phases.length > 0 && <option value="phase">Phase</option>}
          </select>
        </label>
        {closedCount > 0 && (
          <label className="inline-flex items-center gap-1.5 text-caption font-medium text-[var(--color-text)] cursor-pointer select-none">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} className="w-4 h-4 accent-[var(--color-text)]" /> Closed
          </label>
        )}
      </div>

      {canManage && <div className="px-4 pt-3 pb-1 border-b border-[var(--color-border)]">{addRow}</div>}

      {canManage && sel.size > 0 && (
        <div className="px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center gap-2 flex-wrap text-caption">
          <b>{sel.size} picked</b>
          {phases.length > 0 && (
            <select value="" onChange={(e) => { if (e.target.value) void setPhase(pickedAccounts, e.target.value === "split" ? null : e.target.value); }} aria-label="Set phase" className="h-8 pointer-coarse:h-11 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 font-medium">
              <option value="">Set phase…</option><option value="split">Split by the phases</option>{phases.map((p) => <option key={p.id} value={p.id}>{p.name} only</option>)}
            </select>
          )}
          <button type="button" disabled={busy} onClick={() => void close(pickedAccounts.filter((a) => a.status !== "closed"), true)} className="h-8 pointer-coarse:h-11 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] font-medium">Close</button>
          <button type="button" disabled={busy} onClick={() => void remove(pickedAccounts)} className="h-8 pointer-coarse:h-11 px-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] font-medium text-[var(--state-overdue-text)]">Delete</button>
          <button type="button" onClick={() => setSel(new Set())} className="inline-flex items-center justify-center gap-1.5 h-8 pointer-coarse:h-11 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">Clear</button>
        </div>
      )}

      {undo && (
        <div role="status" className="px-4 py-2 border-b border-[var(--color-border)] flex items-center gap-2 text-caption font-medium text-[var(--color-text)]">
          {undo.name} deleted.
          <button type="button" onClick={() => void undoDelete()} className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]"><Undo2 className="w-3.5 h-3.5" /> Undo</button>
        </div>
      )}

      {moving && (
        <div className="px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center gap-2 flex-wrap text-caption">
          <span>Move the spending on <b>{moving.from.name}</b> to</span>
          <select value={moving.to} onChange={(e) => setMoving({ ...moving, to: e.target.value })} aria-label="Move to" className="h-8 pointer-coarse:h-11 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 font-medium">
            <option value="">Pick a line…</option>
            {accounts.filter((a) => a.id !== moving.from.id && a.status !== "closed").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button type="button" disabled={!moving.to || busy} onClick={() => { const to = accounts.find((a) => a.id === moving.to); if (!to) return; void run(async () => { const r = await moveSpend({ orgId, projectId, fromId: moving.from.id, toId: to.id, toName: to.name, actor }); return { ok: r.ok, error: r.error }; }, `Spending on ${moving.from.name} moved to ${to.name}. Close ${moving.from.name} if it's no longer needed.`).then((ok) => { if (ok) setMoving(null); }); }}
            className="h-8 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-medium disabled:opacity-50">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Move"}</button>
          <button type="button" onClick={() => setMoving(null)} className="inline-flex items-center justify-center gap-1.5 h-8 pointer-coarse:h-11 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">Cancel</button>
        </div>
      )}

      {narrow ? (
        <LineCards groups={groups} groupBy={groupBy} rows={rows} totals={totals} cur={cur} canManage={canManage} sel={sel} onPick={pick}
          open={open} onOpen={(id) => setOpen(open === id ? null : id)} partyName={partyName} phaseName={phases.length > 0 ? phaseName : null}
          menu={lineMenu} moreBtn={moreBtn} renderDetail={renderDetail} query={q} onClearQuery={() => setQ("")} />
      ) : (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-caption min-w-[860px]">
          <thead className="bg-[var(--color-surface-2)]">
            <tr>
              {canManage && <th className={`${th} w-8`}><input type="checkbox" aria-label="Pick every line shown" checked={allShown} onChange={() => setSel(allShown ? new Set() : new Set(rows.map((r) => r.account.id)))} className="w-4 h-4 accent-[var(--color-text)]" /></th>}
              <th className={th}>Line</th><th className={th}>Type</th><th className={th}>Contractor</th>
              {phases.length > 0 && <th className={th}>Phase</th>}
              <th className={`${th} text-right`}>Budget</th>
              {sharePhase && <th className={`${th} text-right`}>{sharePhase.name}</th>}
              <th className={`${th} text-right`}>Committed</th><th className={`${th} text-right`}>Spent</th><th className={`${th} text-right`}>Left</th>
              <th className={`${th} w-36`}>Spent of budget</th><th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <React.Fragment key={g.key}>
                {groupBy !== "none" && (
                  <tr className="bg-[var(--color-surface-2)]/60 border-t border-[var(--color-border)]">
                    <td colSpan={canManage ? 4 + (phases.length ? 1 : 0) : 3 + (phases.length ? 1 : 0)} className={`${td} font-medium text-[var(--color-text)]`}>{g.label} <span className="font-medium text-[var(--color-text-muted)]">· {g.rows.length} line{g.rows.length === 1 ? "" : "s"}</span></td>
                    <td className={`${td} text-right font-medium tabular-nums`}>{fmtMoney(g.budget, cur)}</td>
                    {sharePhase && <td />}
                    <td className={`${td} text-right tabular-nums`}>{fmtMoney(g.committed, cur)}</td><td className={`${td} text-right tabular-nums`}>{fmtMoney(g.spent, cur)}</td>
                    <td className={`${td} text-right tabular-nums`}>{g.spent === 0 ? <NoInvoices /> : fmtMoney(g.budget - g.spent, cur)}</td><td colSpan={2} />
                  </tr>
                )}
                {g.rows.map(({ account: a, committed, spent }) => {
                  const closed = a.status === "closed";
                  const left = a.budget - spent;
                  const used = a.budget > 0 ? Math.min(100, (spent / a.budget) * 100) : 0;
                  const share = sharePhase ? (a.phaseId ? (a.phaseId === sharePhase.id ? a.budget : 0) : phaseAmount(a.budget, sharePhase.share)) : 0;
                  return (
                    <React.Fragment key={a.id}>
                      <tr className={`border-t border-[var(--color-border)] ${closed ? "opacity-55" : ""}`}>
                        {canManage && <td className={td}><input type="checkbox" aria-label={`Pick ${a.name}`} checked={sel.has(a.id)} onChange={() => pick(a.id)} className="w-4 h-4 accent-[var(--color-text)]" /></td>}
                        <td className={`${td} min-w-[200px]`}>
                          <div className="flex items-center gap-1">
                            <button type="button" onClick={() => setOpen(open === a.id ? null : a.id)} aria-label={`${open === a.id ? "Close" : "Open"} ${a.name}'s entries`} className="ui-hit shrink-0 text-[var(--color-text-faint)]"><ChevronRight className={`w-4 h-4 ui-chevron${(open === a.id) ? " rotate-90" : ""}`} /></button>
                            {a.code && <span className="font-display tabular-nums text-caption text-[var(--color-text-faint)]">{a.code}</span>}
                            <Cell value={a.name} disabled={!canManage || closed} aria={`${a.name} name`} onSave={(v) => (v.trim() && v.trim() !== a.name ? savePatch(a, { name: v.trim() }) : undefined)} className="font-medium" />
                            {closed && <span className="text-body font-medium text-[var(--color-text-muted)]">closed</span>}
                          </div>
                        </td>
                        <td className={td}>
                          <select value={a.costType ?? ""} disabled={!canManage || closed} onChange={(e) => void savePatch(a, { costType: e.target.value || null })} aria-label={`${a.name} type`} className="h-8 pointer-coarse:h-11 rounded-md border border-transparent hover:border-[var(--color-border-strong)] bg-transparent px-1 text-caption disabled:hover:border-transparent">
                            <option value="">-</option>{TYPES.map((t) => <option key={t} value={t}>{cap(t)}</option>)}
                          </select>
                        </td>
                        <td className={td}>
                          <select value={a.partyId ?? ""} disabled={!canManage || closed} onChange={(e) => void savePatch(a, { partyId: e.target.value || null })} aria-label={`${a.name} contractor`} className="h-8 pointer-coarse:h-11 max-w-[160px] rounded-md border border-transparent hover:border-[var(--color-border-strong)] bg-transparent px-1 text-caption disabled:hover:border-transparent">
                            <option value="">-</option>{parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        </td>
                        {phases.length > 0 && (
                          <td className={td}>
                            <select value={a.phaseId ?? ""} disabled={!canManage || closed} onChange={(e) => void setPhase([a], e.target.value || null)} aria-label={`${a.name} phase`} className="h-8 pointer-coarse:h-11 rounded-md border border-transparent hover:border-[var(--color-border-strong)] bg-transparent px-1 text-caption disabled:hover:border-transparent">
                              <option value="">Split {phases.map((p) => Math.round(p.share)).join("/")}</option>{phases.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                          </td>
                        )}
                        <td className={`${td} text-right`}>
                          <Cell value={String(a.budget)} display={fmtMoney(a.budget, cur)} numeric disabled={!canManage || closed} aria={`${a.name} budget`} className="font-medium tabular-nums"
                            onSave={(v) => { const n = Number(v.replace(/[$,\s]/g, "")); return Number.isFinite(n) && n >= 0 && n !== a.budget ? saveBudget(a, n) : undefined; }} />
                        </td>
                        {sharePhase && <td className={`${td} text-right tabular-nums text-[var(--color-text-muted)]`}>{fmtMoney(share, cur)}</td>}
                        <td className={`${td} text-right tabular-nums`}>{fmtMoney(committed, cur)}</td>
                        <td className={`${td} text-right tabular-nums ${spent > a.budget && a.budget > 0 ? "text-[var(--state-overdue-text)] font-medium" : ""}`}>{fmtMoney(spent, cur)}</td>
                        <td className={`${td} text-right tabular-nums ${left < 0 ? "text-[var(--state-overdue-text)] font-medium" : ""}`}>{spent === 0 ? <NoInvoices /> : fmtMoney(left, cur)}</td>
                        <td className={td}>
                          <div className="flex items-center gap-2" title={`${Math.round(used)}% of the line's budget spent`}>
                            <div className="flex-1 h-2.5 rounded-[3px] bg-[var(--viz-track)] border border-[var(--color-border-strong)] overflow-hidden"><div className={`h-full ${spent > a.budget && a.budget > 0 ? "bg-[var(--state-overdue)]" : "bg-[var(--color-main)]"}`} style={{ width: `${used}%` }} /></div>
                            <span className="w-10 text-right tabular-nums text-caption text-[var(--color-text-muted)]">{a.budget > 0 ? `${Math.round((spent / a.budget) * 100)}%` : "-"}</span>
                          </div>
                        </td>
                        <td className={td}>
                          {canManage && <MoreMenu iconOnly label={`More for ${a.name}`} triggerClass={moreBtn} items={lineMenu(a)} />}
                        </td>
                      </tr>
                      {open === a.id && (
                        <tr><td colSpan={99} className="p-0 border-t border-[var(--color-border)]">{renderDetail(a)}</td></tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={99} className="px-4 py-6 text-center text-body text-[var(--color-text-muted)]">{q ? "No line matches." : "Every line is closed. Tick Closed to see them."}{q ? <> <button type="button" onClick={() => setQ("")} className="text-[var(--color-accent-text)] hover:underline">Clear</button></> : null}</td></tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-[var(--color-text)]/70 font-medium">
                <td colSpan={canManage ? 4 + (phases.length ? 1 : 0) : 3 + (phases.length ? 1 : 0)} className={td}>Total (open lines)</td>
                <td className={`${td} text-right tabular-nums`}>{fmtMoney(totals.budget, cur)}</td>
                {sharePhase && <td className={`${td} text-right tabular-nums`}>{fmtMoney(rows.filter((r) => r.account.status !== "closed").reduce((s, r) => s + (r.account.phaseId ? (r.account.phaseId === sharePhase.id ? r.account.budget : 0) : phaseAmount(r.account.budget, sharePhase.share)), 0), cur)}</td>}
                <td className={`${td} text-right tabular-nums`}>{fmtMoney(totals.committed, cur)}</td><td className={`${td} text-right tabular-nums`}>{fmtMoney(totals.spent, cur)}</td>
                <td className={`${td} text-right tabular-nums`}>{totals.spent === 0 ? <NoInvoices /> : fmtMoney(totals.budget - totals.spent, cur)}</td><td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      )}
    </div>
  );
}

/** In a "Left" cell when nothing is invoiced: the budget is not money to
 *  spare until invoices say so (next-update 1). */
function NoInvoices() {
  return <span className="text-caption font-normal text-[var(--color-text-muted)] whitespace-nowrap">No invoices in yet</span>;
}

type LineRow = { account: CostAccount; committed: number; spent: number };

/** Where a line stands, as a dot and words (rule S1): over budget is red
 *  and says so; nothing invoiced says that, never "within budget". */
function lineStanding(a: CostAccount, committed: number, spent: number): { dot: string; words: string; bad?: boolean } {
  if (a.status === "closed") return { dot: "var(--color-border-strong)", words: "Closed" };
  if (a.budget > 0 && spent > a.budget) return { dot: "var(--state-overdue)", words: "Over budget", bad: true };
  if (a.budget > 0 && committed > a.budget) return { dot: "var(--state-held)", words: "Committed over budget" };
  if (spent <= 0) return { dot: "var(--color-text-faint)", words: "No invoices in yet" };
  return { dot: "var(--color-text-faint)", words: "Within budget" };
}

/** The budget lines on a phone (rule T3): one card each, the code and where
 *  it stands on top, the name in bold (it opens the line's entries), then
 *  budget, committed and spent; type, contractor and phase small at the
 *  foot beside its ⋯ menu. Groups and the open-lines total as in the table. */
function LineCards({ groups, groupBy, rows, totals, cur, canManage, sel, onPick, open, onOpen, partyName, phaseName, menu, moreBtn, renderDetail, query, onClearQuery }: {
  groups: Array<{ key: string; label: string; rows: LineRow[]; budget: number; committed: number; spent: number }>;
  groupBy: GroupBy; rows: LineRow[]; totals: { budget: number; committed: number; spent: number }; cur: string;
  canManage: boolean; sel: Set<string>; onPick: (id: string) => void;
  open: string | null; onOpen: (id: string) => void;
  partyName: Map<string, string>; phaseName: ((id: string | null | undefined) => string) | null;
  menu: (a: CostAccount) => MoreItem[]; moreBtn: string;
  renderDetail: (account: CostAccount) => React.ReactNode;
  query: string; onClearQuery: () => void;
}) {
  const figure = "text-right font-medium tabular-nums text-[var(--color-text)]";
  return (
    <ul aria-label="Budget lines" className="divide-y divide-[var(--color-border)]">
      {groups.map((g) => (
        <React.Fragment key={g.key}>
          {groupBy !== "none" && (
            <li className="px-4 py-2 flex items-baseline gap-2 bg-[var(--color-surface-2)]/60 text-body">
              <span className="min-w-0 truncate font-medium text-[var(--color-text)]">{g.label}</span>
              <span className="shrink-0 text-[var(--color-text-muted)]">{g.rows.length} line{g.rows.length === 1 ? "" : "s"}</span>
              <span className="ml-auto shrink-0 font-medium tabular-nums text-[var(--color-text)]">{fmtMoney(g.budget, cur)}</span>
            </li>
          )}
          {g.rows.map(({ account: a, committed, spent }) => {
            const st = lineStanding(a, committed, spent);
            const over = a.budget > 0 && spent > a.budget;
            const isOpen = open === a.id;
            const foot = [a.costType ? cap(a.costType) : null, a.partyId ? partyName.get(a.partyId) ?? null : null, phaseName ? (a.phaseId ? phaseName(a.phaseId) : "Split by phase") : null].filter(Boolean).join(" · ");
            return (
              <li key={a.id}>
                <div className={`px-4 pt-3 pb-2 ${a.status === "closed" ? "opacity-60" : ""}`}>
                  <div className="flex items-center gap-2 min-h-6">
                    {canManage && (
                      <label className="-ml-1 inline-flex items-center justify-center w-6 h-6 pointer-coarse:w-11 pointer-coarse:h-11 pointer-coarse:-my-2.5 cursor-pointer">
                        <input type="checkbox" aria-label={`Pick ${a.name}`} checked={sel.has(a.id)} onChange={() => onPick(a.id)} className="w-4 h-4 accent-[var(--color-text)]" />
                      </label>
                    )}
                    {a.code && <span className="font-display tabular-nums text-body text-[var(--color-text-muted)]">{a.code}</span>}
                    <span className={`ml-auto inline-flex items-center gap-1.5 text-body ${st.bad ? "font-medium text-[var(--state-overdue-text)]" : "text-[var(--color-text)]"}`}>
                      <span aria-hidden className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: st.dot }} />{st.words}
                    </span>
                  </div>
                  <button type="button" onClick={() => onOpen(a.id)} aria-expanded={isOpen}
                    className="mt-0.5 -ml-1 pl-1 w-full min-h-11 flex items-center gap-1.5 text-left rounded-md hover:bg-[var(--color-surface-2)]">
                    <span className="min-w-0 flex-1 text-reading font-semibold leading-snug text-[var(--color-text)] break-words">{a.name}</span>
                    <ChevronRight aria-hidden className={`w-4 h-4 shrink-0 text-[var(--color-text-muted)] ui-chevron${isOpen ? " rotate-90" : ""}`} />
                  </button>
                  <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body">
                    <dt className="text-[var(--color-text-muted)]">Budget</dt>
                    <dd className={figure}>{a.budget > 0 ? fmtMoney(a.budget, cur) : "No budget"}</dd>
                    <dt className="text-[var(--color-text-muted)]">Committed</dt>
                    <dd className={figure}>{fmtMoney(committed, cur)}</dd>
                    <dt className="text-[var(--color-text-muted)]">Spent</dt>
                    <dd className={over ? "text-right font-medium tabular-nums text-[var(--state-overdue-text)]" : figure}>
                      {spent === 0 ? <NoInvoices /> : over ? `${fmtMoney(spent, cur)}, ${fmtMoney(spent - a.budget, cur)} over` : `${fmtMoney(spent, cur)}${a.budget > 0 ? `, ${Math.round((spent / a.budget) * 100)}%` : ""}`}
                    </dd>
                  </dl>
                  <div className="mt-1 flex items-center gap-2 min-h-8">
                    <span className="min-w-0 flex-1 truncate text-body text-[var(--color-text-muted)]">{foot}</span>
                    {canManage && <MoreMenu iconOnly label={`More for ${a.name}`} triggerClass={moreBtn} items={menu(a)} />}
                  </div>
                </div>
                {isOpen && <div className="border-t border-[var(--color-border)]">{renderDetail(a)}</div>}
              </li>
            );
          })}
        </React.Fragment>
      ))}
      {rows.length === 0 && (
        <li className="px-4 py-6 text-center text-body text-[var(--color-text-muted)]">
          {query ? "No line matches." : "Every line is closed. Tick Closed to see them."}
          {query ? <> <button type="button" onClick={onClearQuery} className="text-[var(--color-accent-text)] hover:underline">Clear</button></> : null}
        </li>
      )}
      {rows.length > 0 && (
        <li className="px-4 py-3 border-t-2 !border-t-[var(--color-text)]/70">
          <div className="text-body font-medium text-[var(--color-text)]">Total, open lines</div>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body">
            <dt className="text-[var(--color-text-muted)]">Budget</dt><dd className={figure}>{fmtMoney(totals.budget, cur)}</dd>
            <dt className="text-[var(--color-text-muted)]">Committed</dt><dd className={figure}>{fmtMoney(totals.committed, cur)}</dd>
            <dt className="text-[var(--color-text-muted)]">Spent</dt>
            <dd className={totals.spent > totals.budget && totals.budget > 0 ? "text-right font-medium tabular-nums text-[var(--state-overdue-text)]" : figure}>{totals.spent === 0 ? <NoInvoices /> : fmtMoney(totals.spent, cur)}</dd>
          </dl>
        </li>
      )}
    </ul>
  );
}

/** A cell edited where it is: tap, type, Enter or leave it to save; Esc to cancel. */
function Cell({ value, display, onSave, disabled, numeric, aria, className = "" }: { value: string; display?: string; onSave: (v: string) => Promise<boolean> | undefined; disabled?: boolean; numeric?: boolean; aria: string; className?: string }) {
  const [edit, setEdit] = useState<string | null>(null);
  if (disabled || edit == null) {
    return <button type="button" disabled={disabled} onClick={() => setEdit(value)} aria-label={`Change ${aria}`} className={`min-w-0 truncate rounded px-1 py-0.5 text-left ${disabled ? "" : "hover:bg-[var(--color-surface-2)] cursor-text"} ${className}`}>{display ?? value}</button>;
  }
  const done = (save: boolean) => { const v = edit; setEdit(null); if (save) void onSave(v); };
  return (
    <input autoFocus value={edit} inputMode={numeric ? "decimal" : undefined} aria-label={aria} onChange={(e) => setEdit(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); }} onBlur={() => done(true)}
      className={`h-8 pointer-coarse:h-11 ${numeric ? "w-28 text-right" : "w-full"} rounded-md border border-[var(--color-main)] bg-[var(--color-surface)] px-1.5 ${className}`} />
  );
}

/** How many lines the chart shows before "Show all". */
const LINES_SHOWN = 14;

/** Each budget line against its own budget, biggest first: the track is
 *  that line's whole budget, filled with committed (gray) and spent
 *  (solid), the line's size as its number and the words on the row. The
 *  Overview and Close-out both draw it (docs/next-update.md 5). */
export function LinesChart({ rows, cur, bare }: { rows: Array<{ name: string; budget: number; committed: number; spent: number }>; cur: string;
  /** Inside another card: no card of its own. */
  bare?: boolean }) {
  const [all, setAll] = useState(false);
  const lines = rows.filter((r) => r.budget || r.committed || r.spent).sort((a, b) => b.budget - a.budget);
  if (!lines.length) return null;
  const shown = all ? lines : lines.slice(0, LINES_SHOWN);
  const noneSpent = lines.every((r) => r.spent <= 0);
  return (
    <div className={bare ? "" : "rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] px-4 sm:px-5 py-4"}>
      <div className="flex items-center gap-x-2 gap-y-1 mb-3 flex-wrap">
        <h3 className="text-body font-medium text-[var(--color-text)]">Each budget line</h3>
        <HelpTooltip>Each bar is that line&apos;s own budget, end to end. The solid part is what is spent (invoices posted); the gray part is what is committed (awarded quotes and POs). Biggest line first.</HelpTooltip>
        <span className="text-body text-[var(--color-text-muted)]">{lines.length} line{lines.length === 1 ? "" : "s"}, biggest first{noneSpent ? " · No invoices in yet" : ""}</span>
      </div>
      <ul className="space-y-3">
        {shown.map((r, i) => (
          <li key={`${r.name}-${i}`} className="min-w-0">
            <div className="flex items-baseline gap-3 mb-1">
              <span className="min-w-0 flex-1 truncate text-body font-medium text-[var(--color-text)]" title={r.name}>{r.name}</span>
              <span className="shrink-0 font-display tabular-nums text-body font-medium text-[var(--color-text)]">{r.budget > 0 ? fmtMoney(r.budget, cur) : "No budget"}</span>
            </div>
            <SpendBar name={r.name} budget={r.budget} committed={r.committed} spent={r.spent} cur={cur} />
          </li>
        ))}
      </ul>
      {lines.length > LINES_SHOWN && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-3 inline-flex items-center min-h-10 pointer-coarse:min-h-11 text-body font-medium text-[var(--color-accent-text)] hover:underline">
          {all ? `Show the biggest ${LINES_SHOWN}` : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}
