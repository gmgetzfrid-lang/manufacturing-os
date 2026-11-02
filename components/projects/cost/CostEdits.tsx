"use client";

// Changing the money after it was entered: the AFE (a supplement, a
// correction, a new document), a budget line (its budget, contractor, name,
// type), an awarded quote / PO or an invoice amount. Every change keeps
// what it was and why (lib/costRevisions).

import React, { useEffect, useState } from "react";
import { Check, FileUp, History, Loader2, Pencil, X } from "lucide-react";
import { fmtMoney, saveParty, type CostAccount, type CostEntry, type CostParty, type Actor } from "@/lib/costs";
import {
  saveAfe, loadAfeHistory, reviseAccount, reviseEntry, parseMoney, COST_CONTROLS_SQL,
  type Afe, type AfeRevision, type BudgetChange,
} from "@/lib/costRevisions";

const field = "h-9 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-[13px] text-[var(--color-text)]";
const label = "block text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1";
const primary = "inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[12.5px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50";
const quiet = "inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[12px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50";

const dateOf = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");

// ─── The AFE ───────────────────────────────────────────────────────

/** The AFE at the top of Budget: what's authorized, how much of it the
 *  budget lines use, Edit (a supplement, a correction, a new document) and
 *  every change so far. */
export function AfeCard({ orgId, projectId, afe, linesTotal, cur, canManage, actor, onOpenDoc, onSaved }: {
  orgId: string; projectId: string; afe: Afe | null; linesTotal: number; cur: string; canManage: boolean; actor: Actor;
  onOpenDoc?: () => void; onSaved: (msg: string) => void;
}) {
  const a: Afe = afe ?? { afeNumber: null, chargeAccount: null, authorized: null, docId: null };
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState<AfeRevision[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => { let alive = true; void loadAfeHistory(projectId).then((h) => { if (alive) setHistory(h.history); }); return () => { alive = false; }; }, [projectId, tick]);
  const left = a.authorized != null ? a.authorized - linesTotal : null;
  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <div>
          <div className={label}>AFE</div>
          <div className="text-[15px] font-black text-[var(--color-text)]">{a.afeNumber || <span className="text-[var(--color-text-faint)] font-bold">No number</span>}</div>
        </div>
        <div>
          <div className={label}>Authorized</div>
          <div className="text-[15px] font-black tabular-nums text-[var(--color-text)]">{a.authorized != null ? fmtMoney(a.authorized, cur) : <span className="text-[var(--color-text-faint)] font-bold">Not set</span>}</div>
        </div>
        {a.chargeAccount && (
          <div>
            <div className={label}>Charge account</div>
            <div className="text-[13px] font-mono text-[var(--color-text)]">{a.chargeAccount}</div>
          </div>
        )}
        <div>
          <div className={label}>Budget lines</div>
          <div className="text-[13px] tabular-nums text-[var(--color-text)]">
            <b>{fmtMoney(linesTotal, cur)}</b>
            {left != null && Math.abs(left) >= 1 && <span className={left < 0 ? " text-rose-700 dark:text-rose-300 font-bold" : " text-[var(--color-text-muted)]"}>{left < 0 ? ` · ${fmtMoney(-left, cur)} more than authorized` : ` · ${fmtMoney(left, cur)} not on a line yet`}</span>}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {onOpenDoc && <button type="button" onClick={onOpenDoc} className={quiet}>View document</button>}
          {canManage && !editing && <button type="button" onClick={() => setEditing(true)} className={quiet}><Pencil className="w-3.5 h-3.5" /> Edit AFE</button>}
        </div>
      </div>
      {editing && (
        <AfeEditor orgId={orgId} projectId={projectId} afe={a} actor={actor} cur={cur}
          onCancel={() => setEditing(false)}
          onSaved={(msg) => { setEditing(false); setTick((t) => t + 1); onSaved(msg); }} />
      )}
      {history && history.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowHistory((v) => !v)} className="inline-flex items-center gap-1 text-[11.5px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            <History className="w-3.5 h-3.5" /> {showHistory ? "Hide" : "Show"} AFE changes · {history.filter((h) => h.at).length}
          </button>
          {showHistory && (
            <ol className="mt-1.5 rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] text-[12px]">
              {history.map((h, i) => (
                <li key={i} className="px-3 py-1.5 flex flex-wrap gap-x-2">
                  <span className="text-[var(--color-text-muted)] w-24 shrink-0">{h.at ? dateOf(h.at) : "Original"}</span>
                  <span className="font-bold tabular-nums text-[var(--color-text)]">{h.authorized != null ? fmtMoney(h.authorized, cur) : "-"}</span>
                  {h.afeNumber && <span className="font-mono text-[var(--color-text-muted)]">{h.afeNumber}</span>}
                  {h.note && <span className="text-[var(--color-text)]">· {h.note}</span>}
                  {h.by && <span className="text-[var(--color-text-faint)]">· {h.by}</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function AfeEditor({ orgId, projectId, afe, actor, cur, onCancel, onSaved }: {
  orgId: string; projectId: string; afe: Afe; actor: Actor; cur: string; onCancel: () => void; onSaved: (msg: string) => void;
}) {
  const [num, setNum] = useState(afe.afeNumber ?? "");
  const [acct, setAcct] = useState(afe.chargeAccount ?? "");
  const [amt, setAmt] = useState(afe.authorized != null ? String(afe.authorized) : "");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const n = parseMoney(amt);
  const changed = (num.trim() || null) !== afe.afeNumber || (acct.trim() || null) !== afe.chargeAccount || n !== afe.authorized || !!file;
  const save = async () => {
    if (amt.trim() && n == null) { setErr("Enter the authorized amount as a number, e.g. 1250000."); return; }
    setBusy(true); setErr(null);
    const res = await saveAfe({ orgId, projectId, before: afe, next: { afeNumber: num, chargeAccount: acct, authorized: n }, note, file, actor });
    setBusy(false);
    if (!res.ok) { setErr(res.error ?? "Not saved."); return; }
    const delta = n != null && afe.authorized != null && n !== afe.authorized ? ` (${n > afe.authorized ? "+" : "-"}${fmtMoney(Math.abs(n - afe.authorized), cur)})` : "";
    onSaved(`AFE saved${delta}.${res.historyKept ? "" : ` The change history needs the database update (${COST_CONTROLS_SQL}).`}`);
  };
  return (
    <div className="rounded-xl border border-[var(--color-accent)] bg-[var(--color-surface)] p-3 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div><label className={label} htmlFor="afe-num">AFE number</label><input id="afe-num" value={num} onChange={(e) => setNum(e.target.value)} className={`${field} font-mono`} placeholder="25008" /></div>
        <div><label className={label} htmlFor="afe-amt">Authorized amount ({cur})</label><input id="afe-amt" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" className={`${field} font-mono tabular-nums`} placeholder="1250000" /></div>
        <div><label className={label} htmlFor="afe-acct">Charge account</label><input id="afe-acct" value={acct} onChange={(e) => setAcct(e.target.value)} className={`${field} font-mono`} /></div>
      </div>
      <div>
        <label className={label} htmlFor="afe-note">What changed</label>
        <input id="afe-note" value={note} onChange={(e) => setNote(e.target.value)} className={field} placeholder="e.g. Supplement 1 approved for the V-7 downcomer cleaning" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className={`${quiet} cursor-pointer`}>
          <FileUp className="w-3.5 h-3.5" /> {file ? file.name : "Replace the AFE document"}
          <input type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        {file && <button type="button" onClick={() => setFile(null)} className="text-[11.5px] text-[var(--color-text-muted)] underline">Keep the current one</button>}
        <span className="text-[11px] text-[var(--color-text-faint)]">The old document stays on file.</span>
      </div>
      {err && <div className="text-[12px] text-rose-700 dark:text-rose-300">{err}</div>}
      <div className="flex gap-2">
        <button type="button" onClick={() => void save()} disabled={busy || !changed} className={primary}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save AFE</button>
        <button type="button" onClick={onCancel} disabled={busy} className="text-[12px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2">Cancel</button>
      </div>
    </div>
  );
}

// ─── A budget line ─────────────────────────────────────────────────

const COST_TYPES = ["labor", "material", "equipment", "subcontract", "other"] as const;

export function LineEditor({ orgId, projectId, account, parties, actor, onCancel, onSaved }: {
  orgId: string; projectId: string; account: CostAccount; parties: CostParty[]; actor: Actor;
  onCancel: () => void; onSaved: (msg: string) => void;
}) {
  const cur = account.currency ?? "USD";
  const [name, setName] = useState(account.name);
  const [party, setParty] = useState(account.partyId ?? "");
  // A contractor not on the project yet: typed here, added on save.
  const [newParty, setNewParty] = useState("");
  const [type, setType] = useState(account.costType ?? "other");
  const [budget, setBudget] = useState(String(account.budget));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const b = parseMoney(budget);
  const save = async () => {
    if (!name.trim()) { setErr("Name the budget line."); return; }
    if (b == null || b < 0) { setErr("Enter the budget as a number, e.g. 85000."); return; }
    if (party === "__new__" && !newParty.trim()) { setErr("Type the contractor's name."); return; }
    setBusy(true); setErr(null);
    let partyId: string | null = party && party !== "__new__" ? party : null;
    if (party === "__new__") {
      const made = await saveParty({ orgId, projectId, patch: { name: newParty.trim(), kind: "contractor" }, actor });
      if (!made.ok || !made.id) { setBusy(false); setErr(made.error ?? "The contractor wasn't added."); return; }
      partyId = made.id;
    }
    const patch: Partial<Pick<CostAccount, "name" | "partyId" | "costType" | "budget">> = {};
    if (name.trim() !== account.name) patch.name = name.trim();
    if (partyId !== account.partyId) patch.partyId = partyId;
    if (type !== (account.costType ?? "other")) patch.costType = type;
    if (b !== account.budget) patch.budget = b;
    if (!Object.keys(patch).length) { setBusy(false); onCancel(); return; }
    const res = await reviseAccount({ orgId, projectId, account, patch, note, actor });
    setBusy(false);
    if (!res.ok) { setErr(res.error ?? "Not saved."); return; }
    onSaved(patch.budget !== undefined
      ? `${name.trim()}: budget ${fmtMoney(account.budget, cur)} → ${fmtMoney(b, cur)}.${res.historyKept ? "" : ` The change history needs the database update (${COST_CONTROLS_SQL}).`}`
      : `${name.trim()} saved.`);
  };
  return (
    <div className="rounded-xl border border-[var(--color-accent)] bg-[var(--color-surface)] p-3 space-y-3" onClick={(e) => e.stopPropagation()}>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="lg:col-span-2"><label className={label} htmlFor={`ln-${account.id}`}>Budget line</label><input id={`ln-${account.id}`} value={name} onChange={(e) => setName(e.target.value)} className={field} /></div>
        <div><label className={label} htmlFor={`lb-${account.id}`}>Budget ({cur})</label><input id={`lb-${account.id}`} value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" className={`${field} font-mono tabular-nums`} /></div>
        <div>
          <label className={label} htmlFor={`lt-${account.id}`}>Type</label>
          <select id={`lt-${account.id}`} value={type} onChange={(e) => setType(e.target.value)} className={field}>
            {COST_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="lg:col-span-2">
          <label className={label} htmlFor={`lp-${account.id}`}>Contractor / vendor</label>
          <select id={`lp-${account.id}`} value={party} onChange={(e) => setParty(e.target.value)} className={field}>
            <option value="">None</option>
            {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="__new__">+ Add a contractor…</option>
          </select>
          {party === "__new__" && <input value={newParty} onChange={(e) => setNewParty(e.target.value)} placeholder="Contractor name, e.g. Schultz" aria-label="New contractor name" className={`${field} mt-1.5`} autoFocus />}
        </div>
        <div className="lg:col-span-2">
          <label className={label} htmlFor={`lw-${account.id}`}>Why (kept with a budget change)</label>
          <input id={`lw-${account.id}`} value={note} onChange={(e) => setNote(e.target.value)} className={field} placeholder="e.g. Revised quote after the scope walk" />
        </div>
      </div>
      {err && <div className="text-[12px] text-rose-700 dark:text-rose-300">{err}</div>}
      <div className="flex gap-2">
        <button type="button" onClick={() => void save()} disabled={busy} className={primary}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save line</button>
        <button type="button" onClick={onCancel} disabled={busy} className="text-[12px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2">Cancel</button>
      </div>
    </div>
  );
}

/** A line's budget changes, oldest first. */
export function BudgetHistory({ changes, cur }: { changes: BudgetChange[]; cur: string }) {
  if (!changes.length) return null;
  return (
    <div className="text-[11.5px]">
      <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-0.5">Budget changes</div>
      <ol className="space-y-0.5">
        {changes.map((c, i) => (
          <li key={i} className="text-[var(--color-text)]">
            <span className="text-[var(--color-text-muted)]">{dateOf(c.at)}</span> · {fmtMoney(c.from, cur)} → <b>{fmtMoney(c.to, cur)}</b>{c.note ? ` · ${c.note}` : ""}{c.by ? <span className="text-[var(--color-text-faint)]"> · {c.by}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ─── A quote / PO / invoice amount ─────────────────────────────────

export function EntryRevise({ orgId, projectId, entry, cur, actor, onDone, onCancel }: {
  orgId: string; projectId: string; entry: CostEntry; cur: string; actor: Actor; onDone: (msg: string) => void; onCancel: () => void;
}) {
  const [amt, setAmt] = useState(String(entry.amount));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    const n = parseMoney(amt);
    if (n == null) { setErr("Enter the new amount as a number."); return; }
    setBusy(true); setErr(null);
    const res = await reviseEntry({ orgId, projectId, entry, amount: n, note, currency: cur, actor });
    setBusy(false);
    if (!res.ok) { setErr(res.error ?? "Not saved."); return; }
    onDone(`${fmtMoney(entry.amount, cur)} → ${fmtMoney(n, cur)}. The old amount stays on the record, struck through.`);
  };
  return (
    <div className="w-full mt-1.5 flex flex-wrap items-end gap-2 rounded-lg border border-[var(--color-accent)] bg-[var(--color-surface)] p-2">
      <div><label className={label} htmlFor={`ea-${entry.id}`}>New amount ({cur})</label><input id={`ea-${entry.id}`} value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" className={`${field} w-36 font-mono tabular-nums`} /></div>
      <div className="flex-1 min-w-[12rem]"><label className={label} htmlFor={`ew-${entry.id}`}>Why</label><input id={`ew-${entry.id}`} value={note} onChange={(e) => setNote(e.target.value)} className={field} placeholder="e.g. Revised quote 11/02" /></div>
      <button type="button" onClick={() => void save()} disabled={busy} className={primary}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save</button>
      <button type="button" onClick={onCancel} disabled={busy} aria-label="Cancel" className="p-2 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>
      {err && <div className="w-full text-[12px] text-rose-700 dark:text-rose-300">{err}</div>}
    </div>
  );
}
