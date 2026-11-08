"use client";

// BudgetTable - the budget lines as a table you fully control: change any
// cell where it is (name, type, contractor, phase, budget), add a line on
// the last row, pick lines and set their phase, close or delete them
// together, group them with subtotals, and from a line's menu move its
// spending to another line, close it or delete it (with Undo). A line
// with spending booked on it is closed rather than deleted, so no money
// record is ever lost. Each line still opens to its entries and history.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, MoreHorizontal, ChevronDown, ChevronRight, Loader2, Undo2, Search } from "lucide-react";
import type { Actor, CostAccount, CostEntry, CostParty } from "@/lib/costs";
import { saveAccount } from "@/lib/costs";
import { reviseAccount } from "@/lib/costRevisions";
import { canDeleteLine, deleteLine, restoreLine, setLinesClosed, setLinesPhase, moveSpend, groupLines, openStatusOf, type GroupBy } from "@/lib/costLines";
import { phaseAmount, type ProjectPhase } from "@/lib/projectPhases";
import { appConfirm } from "@/components/providers/DialogProvider";
import { fmtMoney as fmtMoneyCents } from "@/lib/costs";

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
  const [menu, setMenu] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ from: CostAccount; to: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{ row: Record<string, unknown>; name: string } | null>(null);
  const [draft, setDraft] = useState({ name: "", type: "subcontract", budget: "" });
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
    finally { setBusy(false); }
  };
  const savePatch = (a: CostAccount, patch: Parameters<typeof saveAccount>[0]["patch"]) => run(() => saveAccount({ orgId, projectId, id: a.id, patch, actor }));
  const saveBudget = (a: CostAccount, budget: number) => run(() => reviseAccount({ orgId, projectId, account: a, patch: { budget }, note: "Changed in the budget table", actor }));

  const remove = async (list: CostAccount[]) => {
    const ok = list.filter((a) => canDeleteLine(a.id, entries));
    const kept = list.filter((a) => !canDeleteLine(a.id, entries));
    if (!ok.length) { setErr(`${kept.map((a) => a.name).join(", ")}: spending is booked on ${kept.length === 1 ? "it" : "them"}. Move it to another line (the line's menu), then close the line: the record stays, out of the totals.`); return; }
    if (!(await appConfirm({ message: ok.length === 1 ? `Delete the budget line "${ok[0].name}" (${fmtMoney(ok[0].budget, cur)})? Undo is offered for 10 seconds.` : `Delete ${ok.length} budget lines (${fmtMoney(ok.reduce((s, a) => s + a.budget, 0), cur)})?${kept.length ? ` ${kept.length} with spending booked stay; close those instead.` : ""}`, tone: "danger", confirmLabel: "Delete" }))) return;
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
  const add = async () => {
    const budget = Number(draft.budget.replace(/[$,\s]/g, "") || 0);
    if (!draft.name.trim()) { setErr("Give the line a name."); return; }
    if (!Number.isFinite(budget) || budget < 0) { setErr("The budget must be a number, 0 or more."); return; }
    const ok = await run(() => saveAccount({ orgId, projectId, patch: { name: draft.name.trim(), costType: draft.type, budget, currency: cur }, actor }), `${draft.name.trim()} added.`);
    if (ok) setDraft({ name: "", type: draft.type, budget: "" });
  };

  const pickedAccounts = accounts.filter((a) => sel.has(a.id));
  const allShown = rows.length > 0 && rows.every((r) => sel.has(r.account.id));
  const th = "px-2 py-2 text-left text-[10.5px] font-black uppercase tracking-wider text-[var(--color-text-muted)] whitespace-nowrap";
  const td = "px-2 py-1.5 align-middle";
  const sharePhase = phase ? phases.find((p) => p.id === phase) ?? null : null;

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <span className="text-sm font-bold text-[var(--color-text)]">Budget lines</span>
        <span className="text-[11px] text-[var(--color-text-muted)]">{accounts.length - closedCount} open{closedCount ? ` · ${closedCount} closed` : ""}</span>
        <span className="relative ml-auto">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-faint)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a line" aria-label="Find a line" className="h-8 w-40 pl-7 pr-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[12.5px]" />
        </span>
        <label className="inline-flex items-center gap-1.5 text-[12px] font-bold text-[var(--color-text)]">Group
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} aria-label="Group by" className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px]">
            <option value="none">None</option><option value="type">Type</option><option value="contractor">Contractor</option>{phases.length > 0 && <option value="phase">Phase</option>}
          </select>
        </label>
        {closedCount > 0 && (
          <label className="inline-flex items-center gap-1.5 text-[12px] font-bold text-[var(--color-text)] cursor-pointer select-none">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} className="w-4 h-4 accent-[var(--color-accent)]" /> Closed
          </label>
        )}
      </div>

      {canManage && sel.size > 0 && (
        <div className="px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-accent-soft)]/40 flex items-center gap-2 flex-wrap text-[12.5px]">
          <b>{sel.size} picked</b>
          {phases.length > 0 && (
            <select value="" onChange={(e) => { if (e.target.value) void setPhase(pickedAccounts, e.target.value === "split" ? null : e.target.value); }} aria-label="Set phase" className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 font-bold">
              <option value="">Set phase…</option><option value="split">Split by the phases</option>{phases.map((p) => <option key={p.id} value={p.id}>{p.name} only</option>)}
            </select>
          )}
          <button type="button" disabled={busy} onClick={() => void close(pickedAccounts.filter((a) => a.status !== "closed"), true)} className="h-8 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] font-bold">Close</button>
          <button type="button" disabled={busy} onClick={() => void remove(pickedAccounts)} className="h-8 px-3 rounded-lg border border-rose-300 bg-[var(--color-surface)] font-bold text-rose-700 dark:text-rose-400">Delete</button>
          <button type="button" onClick={() => setSel(new Set())} className="h-8 px-2 font-bold text-[var(--color-text-muted)]">Clear</button>
        </div>
      )}

      {undo && (
        <div role="status" className="px-4 py-2 border-b border-[var(--color-border)] bg-amber-50 dark:bg-amber-950/30 flex items-center gap-2 text-[12.5px] font-bold text-amber-900 dark:text-amber-200">
          {undo.name} deleted.
          <button type="button" onClick={() => void undoDelete()} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-amber-400 bg-white/70 dark:bg-black/20"><Undo2 className="w-3.5 h-3.5" /> Undo</button>
        </div>
      )}

      {moving && (
        <div className="px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center gap-2 flex-wrap text-[12.5px]">
          <span>Move the spending on <b>{moving.from.name}</b> to</span>
          <select value={moving.to} onChange={(e) => setMoving({ ...moving, to: e.target.value })} aria-label="Move to" className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 font-bold">
            <option value="">Pick a line…</option>
            {accounts.filter((a) => a.id !== moving.from.id && a.status !== "closed").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button type="button" disabled={!moving.to || busy} onClick={() => { const to = accounts.find((a) => a.id === moving.to); if (!to) return; void run(async () => { const r = await moveSpend({ orgId, projectId, fromId: moving.from.id, toId: to.id, toName: to.name, actor }); return { ok: r.ok, error: r.error }; }, `Spending on ${moving.from.name} moved to ${to.name}. Close ${moving.from.name} if it's no longer needed.`).then((ok) => { if (ok) setMoving(null); }); }}
            className="h-8 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-black disabled:opacity-50">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Move"}</button>
          <button type="button" onClick={() => setMoving(null)} className="h-8 px-2 font-bold text-[var(--color-text-muted)]">Cancel</button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12.5px] min-w-[860px]">
          <thead className="bg-[var(--color-surface-2)]">
            <tr>
              {canManage && <th className={`${th} w-8`}><input type="checkbox" aria-label="Pick every line shown" checked={allShown} onChange={() => setSel(allShown ? new Set() : new Set(rows.map((r) => r.account.id)))} className="w-4 h-4 accent-[var(--color-accent)]" /></th>}
              <th className={th}>Line</th><th className={th}>Type</th><th className={th}>Contractor</th>
              {phases.length > 0 && <th className={th}>Phase</th>}
              <th className={`${th} text-right`}>Budget</th>
              {sharePhase && <th className={`${th} text-right`}>{sharePhase.name}</th>}
              <th className={`${th} text-right`}>Committed</th><th className={`${th} text-right`}>Spent</th><th className={`${th} text-right`}>Left</th>
              <th className={`${th} w-28`}>Used</th><th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <React.Fragment key={g.key}>
                {groupBy !== "none" && (
                  <tr className="bg-[var(--color-surface-2)]/60 border-t border-[var(--color-border)]">
                    <td colSpan={canManage ? 4 + (phases.length ? 1 : 0) : 3 + (phases.length ? 1 : 0)} className={`${td} font-black text-[var(--color-text)]`}>{g.label} <span className="font-semibold text-[var(--color-text-muted)]">· {g.rows.length} line{g.rows.length === 1 ? "" : "s"}</span></td>
                    <td className={`${td} text-right font-black tabular-nums`}>{fmtMoney(g.budget, cur)}</td>
                    {sharePhase && <td />}
                    <td className={`${td} text-right tabular-nums`}>{fmtMoney(g.committed, cur)}</td><td className={`${td} text-right tabular-nums`}>{fmtMoney(g.spent, cur)}</td>
                    <td className={`${td} text-right tabular-nums`}>{fmtMoney(g.budget - g.spent, cur)}</td><td colSpan={2} />
                  </tr>
                )}
                {g.rows.map(({ account: a, committed, spent }) => {
                  const closed = a.status === "closed";
                  const left = a.budget - spent;
                  const used = a.budget > 0 ? Math.min(100, (spent / a.budget) * 100) : 0;
                  const share = sharePhase ? (a.phaseId ? (a.phaseId === sharePhase.id ? a.budget : 0) : phaseAmount(a.budget, sharePhase.share)) : 0;
                  return (
                    <React.Fragment key={a.id}>
                      <tr className={`border-t border-[var(--color-border)] ${closed ? "opacity-55" : ""} ${spent > a.budget && a.budget > 0 ? "bg-rose-500/[0.04]" : ""}`}>
                        {canManage && <td className={td}><input type="checkbox" aria-label={`Pick ${a.name}`} checked={sel.has(a.id)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; })} className="w-4 h-4 accent-[var(--color-accent)]" /></td>}
                        <td className={`${td} min-w-[200px]`}>
                          <div className="flex items-center gap-1">
                            <button type="button" onClick={() => setOpen(open === a.id ? null : a.id)} aria-label={`${open === a.id ? "Close" : "Open"} ${a.name}'s entries`} className="shrink-0 text-[var(--color-text-faint)]">{open === a.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</button>
                            {a.code && <span className="font-mono text-[10px] text-[var(--color-text-faint)]">{a.code}</span>}
                            <Cell value={a.name} disabled={!canManage || closed} aria={`${a.name} name`} onSave={(v) => (v.trim() && v.trim() !== a.name ? savePatch(a, { name: v.trim() }) : undefined)} className="font-bold" />
                            {closed && <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">closed</span>}
                          </div>
                        </td>
                        <td className={td}>
                          <select value={a.costType ?? ""} disabled={!canManage || closed} onChange={(e) => void savePatch(a, { costType: e.target.value || null })} aria-label={`${a.name} type`} className="h-8 rounded-md border border-transparent hover:border-[var(--color-border-strong)] bg-transparent px-1 text-[12.5px] disabled:hover:border-transparent">
                            <option value="">-</option>{TYPES.map((t) => <option key={t} value={t}>{cap(t)}</option>)}
                          </select>
                        </td>
                        <td className={td}>
                          <select value={a.partyId ?? ""} disabled={!canManage || closed} onChange={(e) => void savePatch(a, { partyId: e.target.value || null })} aria-label={`${a.name} contractor`} className="h-8 max-w-[160px] rounded-md border border-transparent hover:border-[var(--color-border-strong)] bg-transparent px-1 text-[12.5px] disabled:hover:border-transparent">
                            <option value="">-</option>{parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        </td>
                        {phases.length > 0 && (
                          <td className={td}>
                            <select value={a.phaseId ?? ""} disabled={!canManage || closed} onChange={(e) => void setPhase([a], e.target.value || null)} aria-label={`${a.name} phase`} className="h-8 rounded-md border border-transparent hover:border-[var(--color-border-strong)] bg-transparent px-1 text-[12.5px] disabled:hover:border-transparent">
                              <option value="">Split {phases.map((p) => Math.round(p.share)).join("/")}</option>{phases.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                          </td>
                        )}
                        <td className={`${td} text-right`}>
                          <Cell value={String(a.budget)} display={fmtMoney(a.budget, cur)} numeric disabled={!canManage || closed} aria={`${a.name} budget`} className="font-bold tabular-nums"
                            onSave={(v) => { const n = Number(v.replace(/[$,\s]/g, "")); return Number.isFinite(n) && n >= 0 && n !== a.budget ? saveBudget(a, n) : undefined; }} />
                        </td>
                        {sharePhase && <td className={`${td} text-right tabular-nums text-[var(--color-text-muted)]`}>{fmtMoney(share, cur)}</td>}
                        <td className={`${td} text-right tabular-nums`}>{fmtMoney(committed, cur)}</td>
                        <td className={`${td} text-right tabular-nums ${spent > a.budget && a.budget > 0 ? "text-rose-700 dark:text-rose-400 font-bold" : ""}`}>{fmtMoney(spent, cur)}</td>
                        <td className={`${td} text-right tabular-nums ${left < 0 ? "text-rose-700 dark:text-rose-400 font-bold" : ""}`}>{fmtMoney(left, cur)}</td>
                        <td className={td}><div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden"><div className={`h-full rounded-full ${spent > a.budget && a.budget > 0 ? "bg-rose-500" : "bg-[var(--color-accent)]"}`} style={{ width: `${used}%` }} /></div></td>
                        <td className={`${td} relative`}>
                          {canManage && (
                            <button type="button" onClick={() => setMenu(menu === a.id ? null : a.id)} aria-label={`${a.name} actions`} className="w-8 h-8 rounded-lg hover:bg-[var(--color-surface-2)] flex items-center justify-center"><MoreHorizontal className="w-4 h-4" /></button>
                          )}
                          {menu === a.id && (
                            <div role="menu" className="absolute right-2 top-9 z-20 w-56 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl p-1 text-[12.5px]" onMouseLeave={() => setMenu(null)}>
                              <MenuItem onClick={() => { setOpen(a.id); setMenu(null); }}>Entries, history and full edit</MenuItem>
                              {!closed && <MenuItem onClick={() => { setMoving({ from: a, to: "" }); setMenu(null); }}>Move its spending to another line…</MenuItem>}
                              <MenuItem onClick={() => { setMenu(null); void close([a], !closed); }}>{closed ? "Open again" : "Close (kept, out of the totals)"}</MenuItem>
                              <MenuItem danger onClick={() => { setMenu(null); void remove([a]); }}>{canDeleteLine(a.id, entries) ? "Delete line" : "Delete line (has spending: close it)"}</MenuItem>
                            </div>
                          )}
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
              <tr><td colSpan={99} className="px-4 py-8 text-center text-[var(--color-text-muted)]">{accounts.length ? "No line matches." : "No budget lines yet. Add the first one below, or drop the AFE above to build them."}</td></tr>
            )}
            {canManage && (
              <tr className="border-t border-[var(--color-border)] bg-[var(--color-surface-2)]/40">
                <td className={td} />
                <td className={td}><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} placeholder="+ Add a line: name" aria-label="New line name" className="h-8 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2" /></td>
                <td className={td}><select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} aria-label="New line type" className="h-8 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1">{TYPES.map((t) => <option key={t} value={t}>{cap(t)}</option>)}</select></td>
                <td className={td} />{phases.length > 0 && <td className={td} />}
                <td className={td}><input value={draft.budget} onChange={(e) => setDraft({ ...draft, budget: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} inputMode="decimal" placeholder="$0" aria-label="New line budget" className="h-8 w-28 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-right" /></td>
                <td colSpan={99} className={td}><button type="button" disabled={busy || !draft.name.trim()} onClick={() => void add()} className="inline-flex items-center gap-1 h-8 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-black disabled:opacity-50"><Plus className="w-4 h-4" /> Add</button></td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-[var(--color-text)]/70 font-black">
                <td colSpan={canManage ? 4 + (phases.length ? 1 : 0) : 3 + (phases.length ? 1 : 0)} className={td}>Total (open lines)</td>
                <td className={`${td} text-right tabular-nums`}>{fmtMoney(totals.budget, cur)}</td>
                {sharePhase && <td className={`${td} text-right tabular-nums`}>{fmtMoney(rows.filter((r) => r.account.status !== "closed").reduce((s, r) => s + (r.account.phaseId ? (r.account.phaseId === sharePhase.id ? r.account.budget : 0) : phaseAmount(r.account.budget, sharePhase.share)), 0), cur)}</td>}
                <td className={`${td} text-right tabular-nums`}>{fmtMoney(totals.committed, cur)}</td><td className={`${td} text-right tabular-nums`}>{fmtMoney(totals.spent, cur)}</td>
                <td className={`${td} text-right tabular-nums`}>{fmtMoney(totals.budget - totals.spent, cur)}</td><td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return <button type="button" role="menuitem" onClick={onClick} className={`w-full text-left px-2.5 py-2 rounded-lg hover:bg-[var(--color-surface-2)] font-semibold ${danger ? "text-rose-700 dark:text-rose-400" : "text-[var(--color-text)]"}`}>{children}</button>;
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
      className={`h-8 ${numeric ? "w-28 text-right" : "w-full"} rounded-md border border-[var(--color-accent)] bg-[var(--color-surface)] px-1.5 ${className}`} />
  );
}

/** Each line: budget, committed and spent, side by side (the Overview). */
export function LinesChart({ rows, cur }: { rows: Array<{ name: string; budget: number; committed: number; spent: number }>; cur: string }) {
  const shown = rows.filter((r) => r.budget || r.committed || r.spent).sort((a, b) => b.budget - a.budget).slice(0, 14);
  if (!shown.length) return null;
  const max = Math.max(...shown.map((r) => Math.max(r.budget, r.committed, r.spent)), 1);
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <span className="text-sm font-bold text-[var(--color-text)]">Each budget line</span>
        <span className="flex items-center gap-3 text-[11px] text-[var(--color-text-muted)]">
          <span className="inline-flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-slate-300 dark:bg-slate-600" /> Budget</span>
          <span className="inline-flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-sky-400" /> Committed</span>
          <span className="inline-flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-[var(--color-accent)]" /> Spent</span>
        </span>
      </div>
      <div className="space-y-2">
        {shown.map((r) => (
          <div key={r.name} className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_auto] gap-2 items-center text-[12px]">
            <span className="truncate text-[var(--color-text)]" title={r.name}>{r.name}</span>
            <div className="space-y-0.5">
              <div className="h-2 rounded-sm bg-slate-300 dark:bg-slate-600" style={{ width: `${(r.budget / max) * 100}%` }} />
              <div className="h-1.5 rounded-sm bg-sky-400" style={{ width: `${(r.committed / max) * 100}%` }} />
              <div className={`h-2 rounded-sm ${r.spent > r.budget && r.budget > 0 ? "bg-rose-500" : "bg-[var(--color-accent)]"}`} style={{ width: `${(r.spent / max) * 100}%` }} />
            </div>
            <span className={`tabular-nums text-right ${r.spent > r.budget && r.budget > 0 ? "text-rose-700 dark:text-rose-400 font-bold" : "text-[var(--color-text-muted)]"}`}>{fmtMoney(r.spent, cur)} / {fmtMoney(r.budget, cur)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
