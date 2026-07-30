"use client";

// CostsTab — cost control on the project page. Budget vs committed vs
// spent per account, rolled to a project stat strip; accounts optionally
// pin to a schedule milestone so earned value (and CPI — the partner the
// SPI dashboard never had) is measured, not guessed. Entries are the money
// trail: commitments (POs/contracts), actuals (invoices/timesheets), and
// signed adjustments. Nothing deletes — entries void with a strikethrough.
//
// Writes are Admin/DocCtrl only (RLS-enforced); everyone on the project
// reads the same picture.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  CircleDollarSign, Plus, X, Loader2, Check, ChevronDown, ChevronRight,
  Landmark, HardHat, Scale, TrendingUp, TrendingDown, AlertTriangle, Ban,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  CostAccount, CostEntry, CostParty, CostEntryType,
  listAccounts, listEntries, listParties, saveAccount, addEntry, voidEntry, saveParty,
  computeCostRollup, milestonePctIndex, fmtMoney,
} from "@/lib/costs";
import { appConfirm } from "@/components/providers/DialogProvider";

const COST_TYPES = ["labor", "material", "equipment", "subcontract", "other"] as const;
const ENTRY_TYPES: Array<{ v: CostEntryType; label: string; hint: string }> = [
  { v: "commitment", label: "Commitment", hint: "PO / contract value awarded — money promised" },
  { v: "actual", label: "Actual", hint: "Invoice / timesheet — money really spent" },
  { v: "adjustment", label: "Adjustment", hint: "Signed correction (can be negative to credit back)" },
];

export default function CostsTab({ orgId, projectId, canManage, uid, userEmail }: {
  orgId: string; projectId: string; canManage: boolean; uid: string; userEmail?: string | null;
}) {
  const [accounts, setAccounts] = useState<CostAccount[]>([]);
  const [entries, setEntries] = useState<CostEntry[]>([]);
  const [parties, setParties] = useState<CostParty[]>([]);
  const [milestones, setMilestones] = useState<Array<{ id: string; name: string; pct: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [openAccount, setOpenAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [showParties, setShowParties] = useState(false);

  const actor = useMemo(() => ({ uid, email: userEmail ?? null }), [uid, userEmail]);

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const [a, e, p, { data: ms }] = await Promise.all([
        listAccounts(orgId, projectId),
        listEntries(orgId, projectId),
        listParties(orgId, projectId),
        supabase.from("milestones").select("id, name, percent_complete, status")
          .eq("project_id", projectId).order("planned_at"),
      ]);
      setAccounts(a);
      setEntries(e);
      setParties(p);
      const rows = ((ms ?? []) as Array<{ id: string; name: string; percent_complete: number | null; status: string }>);
      const idx = milestonePctIndex(rows.map((m) => ({ id: m.id, percentComplete: m.percent_complete, status: m.status })));
      setMilestones(rows.map((m) => ({ id: m.id, name: m.name, pct: idx.get(m.id) ?? 0 })));
    } catch (e) {
      setErr((e as Error).message);
    } finally { setLoading(false); }
  }, [orgId, projectId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const pctIndex = useMemo(() => new Map(milestones.map((m) => [m.id, m.pct])), [milestones]);
  const rollup = useMemo(() => computeCostRollup(accounts, entries, pctIndex), [accounts, entries, pctIndex]);
  const cur = rollup.currencies[0] ?? "USD";
  const mixedCurrency = rollup.currencies.length > 1;
  const burnPct = rollup.budget > 0 ? Math.min(100, (rollup.spent / rollup.budget) * 100) : 0;
  const commitPct = rollup.budget > 0 ? Math.min(100, (rollup.committed / rollup.budget) * 100) : 0;
  const partyName = useMemo(() => new Map(parties.map((p) => [p.id, p.name])), [parties]);
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

  if (loading) return <div className="py-12 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-accent)]" /></div>;

  return (
    <div className="space-y-4">
      {err && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/50 bg-rose-500/[0.08] px-3 py-2.5 text-xs font-bold text-rose-700 dark:text-rose-300">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {err}
          <button onClick={() => setErr(null)} className="ml-auto text-rose-400 hover:text-rose-600"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* ── Stat strip ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={<Landmark className="w-4 h-4" />} label="Budget" value={fmtMoney(rollup.budget, cur)} tone="accent" />
        <StatCard icon={<Scale className="w-4 h-4" />} label="Committed" value={fmtMoney(rollup.committed, cur)}
          sub={rollup.budget > 0 ? `${Math.round(commitPct)}% of budget` : undefined} tone="sky" />
        <StatCard icon={<HardHat className="w-4 h-4" />} label="Spent" value={fmtMoney(rollup.spent, cur)}
          sub={rollup.budget > 0 ? `${Math.round(burnPct)}% burned` : undefined} tone="violet" />
        <StatCard
          icon={rollup.remaining < 0 ? <TrendingDown className="w-4 h-4" /> : <TrendingUp className="w-4 h-4" />}
          label="Remaining" value={fmtMoney(rollup.remaining, cur)}
          tone={rollup.remaining < 0 ? "rose" : "emerald"}
          sub={rollup.cpi != null ? `CPI ${rollup.cpi.toFixed(2)} ${rollup.cpi >= 1 ? "— under-running" : "— over-running"}` : undefined}
        />
      </div>

      {/* ── Burn bar: spent (solid) + committed (hatched ghost) vs budget ── */}
      {rollup.budget > 0 && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
          <div className="flex items-center justify-between text-[10px] font-bold text-[var(--color-text-muted)] mb-1.5">
            <span>Budget burn</span>
            <span className="tabular-nums">{fmtMoney(rollup.spent, cur)} spent · {fmtMoney(rollup.committed, cur)} committed · {fmtMoney(rollup.budget, cur)} budget</span>
          </div>
          <div className="relative h-2.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
            <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-accent)]/25 transition-all duration-700" style={{ width: `${commitPct}%` }} />
            <div className={`absolute inset-y-0 left-0 rounded-full transition-all duration-700 ${burnPct >= 100 ? "bg-rose-500" : "bg-[image:var(--brand-gradient)]"}`} style={{ width: `${burnPct}%` }} />
          </div>
        </div>
      )}

      {mixedCurrency && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-[11px] font-bold text-amber-800 dark:text-amber-300">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          Accounts use mixed currencies ({rollup.currencies.join(", ")}) — the totals above sum raw numbers. Keep one currency per project for honest rollups.
        </div>
      )}

      {/* ── Accounts ── */}
      <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
          <CircleDollarSign className="w-4 h-4 text-[var(--color-accent)]" />
          <span className="text-sm font-bold text-[var(--color-text)]">Cost accounts</span>
          <span className="text-[10px] font-mono text-[var(--color-text-muted)]">{accounts.length}</span>
          {canManage && (
            <button onClick={() => setShowNewAccount((v) => !v)} className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] transition-colors">
              <Plus className="w-3 h-3" /> New account
            </button>
          )}
        </div>

        {showNewAccount && canManage && (
          <AccountForm
            orgId={orgId} projectId={projectId} actor={actor}
            parties={parties} milestones={milestones}
            onDone={() => { setShowNewAccount(false); void refresh(); }}
            onCancel={() => setShowNewAccount(false)}
          />
        )}

        {rollup.accounts.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <CircleDollarSign className="w-8 h-8 mx-auto text-[var(--color-text-faint)] mb-2" />
            <div className="text-sm font-bold text-[var(--color-text)]">No cost accounts yet</div>
            <div className="text-xs text-[var(--color-text-muted)] mt-1 max-w-md mx-auto">
              An account is a budget line — &ldquo;Piping subcontract&rdquo;, &ldquo;Scaffolding&rdquo;, &ldquo;Engineering hours&rdquo;. Post commitments and actuals against it and the burn tracks itself.
              {canManage ? " Create the first one above." : " Document Control sets these up."}
            </div>
          </div>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {rollup.accounts.map((r) => {
              const isOpen = openAccount === r.account.id;
              const rowPct = r.account.budget > 0 ? Math.min(100, (r.spent / r.account.budget) * 100) : 0;
              const accEntries = entriesByAccount.get(r.account.id) ?? [];
              return (
                <div key={r.account.id} className={r.overBudget ? "bg-rose-500/[0.04]" : undefined}>
                  <button onClick={() => setOpenAccount(isOpen ? null : r.account.id)} className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-[var(--color-surface-2)]/40 transition-colors">
                    {isOpen ? <ChevronDown className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" /> : <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {r.account.code && <span className="font-mono text-[10px] text-[var(--color-text-faint)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded">{r.account.code}</span>}
                        <span className="text-sm font-bold text-[var(--color-text)] truncate">{r.account.name}</span>
                        {r.account.costType && <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{r.account.costType}</span>}
                        {r.account.partyId && partyName.get(r.account.partyId) && (
                          <span className="text-[10px] text-[var(--color-text-muted)]">· {partyName.get(r.account.partyId)}</span>
                        )}
                        {r.overBudget && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-black uppercase tracking-wider text-rose-700 dark:text-rose-300 bg-rose-500/10 border border-rose-500/40 px-1.5 py-0.5 rounded">
                            <AlertTriangle className="w-2.5 h-2.5" /> over budget
                          </span>
                        )}
                        {r.earnedValue !== null && (
                          <span className="text-[9px] font-bold text-[var(--color-text-muted)]" title="Earned value from the pinned schedule task">EV {fmtMoney(r.earnedValue, r.account.currency ?? cur)}</span>
                        )}
                      </div>
                      <div className="mt-1.5 relative h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden max-w-md">
                        <div className={`absolute inset-y-0 left-0 rounded-full transition-all duration-500 ${r.overBudget ? "bg-rose-500" : "bg-[var(--color-accent)]"}`} style={{ width: `${rowPct}%` }} />
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-black tabular-nums text-[var(--color-text)]">{fmtMoney(r.spent, r.account.currency ?? cur)}</div>
                      <div className="text-[10px] tabular-nums text-[var(--color-text-muted)]">of {fmtMoney(r.account.budget, r.account.currency ?? cur)}</div>
                    </div>
                  </button>

                  {isOpen && (
                    <AccountDetail
                      orgId={orgId} projectId={projectId} actor={actor}
                      rollup={r} entries={accEntries} parties={parties} milestones={milestones}
                      canManage={canManage} busy={busy} setBusy={setBusy}
                      onChanged={() => void refresh()} setErr={setErr}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

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
        <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">{label}</span>
      </div>
      <div className="mt-2 text-lg font-black tabular-nums text-[var(--color-text)] truncate">{value}</div>
      {sub && <div className="text-[10px] font-bold text-[var(--color-text-muted)] mt-0.5">{sub}</div>}
    </div>
  );
}

function AccountDetail({ orgId, projectId, actor, rollup: r, entries, parties, milestones, canManage, busy, setBusy, onChanged, setErr }: {
  orgId: string; projectId: string; actor: { uid: string; email: string | null };
  rollup: import("@/lib/costs").AccountRollup;
  entries: CostEntry[]; parties: CostParty[]; milestones: Array<{ id: string; name: string; pct: number }>;
  canManage: boolean; busy: string | null; setBusy: (v: string | null) => void;
  onChanged: () => void; setErr: (m: string | null) => void;
}) {
  const a = r.account;
  const [budgetDraft, setBudgetDraft] = useState(String(a.budget));
  const [pinDraft, setPinDraft] = useState(a.wbsMilestoneId ?? "");
  const cur = a.currency ?? "USD";

  const saveBudget = async () => {
    const n = Number(budgetDraft);
    if (!Number.isFinite(n) || n < 0) { setErr("Budget must be a non-negative number."); return; }
    if (n === a.budget) return;
    setBusy(a.id);
    const res = await saveAccount({ orgId, projectId, id: a.id, patch: { budget: n }, actor });
    setBusy(null);
    if (!res.ok) setErr(res.error ?? "Couldn't save the budget."); else onChanged();
  };
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
            <span className="text-[9px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Budget ({cur})</span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <input value={budgetDraft} onChange={(e) => setBudgetDraft(e.target.value)} onBlur={() => void saveBudget()}
                className="h-8 w-32 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs font-mono tabular-nums" />
            </div>
          </label>
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

      {canManage && <EntryForm orgId={orgId} projectId={projectId} accountId={a.id} parties={parties} actor={actor} onDone={onChanged} setErr={setErr} />}

      {entries.length === 0 ? (
        <div className="text-[11px] italic text-[var(--color-text-faint)]">No entries yet — post the PO as a commitment, then invoices as actuals.</div>
      ) : (
        <ul className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden">
          {entries.map((e) => (
            <li key={e.id} className={`px-3 py-2 flex items-center gap-2 text-xs ${e.status === "void" ? "opacity-50" : ""}`}>
              <span className={`shrink-0 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                e.entryType === "commitment" ? "text-sky-700 dark:text-sky-300 border-sky-500/40 bg-sky-500/10"
                : e.entryType === "actual" ? "text-violet-700 dark:text-violet-300 border-violet-500/40 bg-violet-500/10"
                : "text-amber-700 dark:text-amber-300 border-amber-500/40 bg-amber-500/10"}`}>
                {e.entryType}
              </span>
              <span className={`font-black tabular-nums ${e.status === "void" ? "line-through" : ""} text-[var(--color-text)]`}>{fmtMoney(e.amount, cur)}</span>
              <span className="text-[var(--color-text-muted)] truncate">
                {e.entryDate ? new Date(e.entryDate).toLocaleDateString() : "—"}
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
          {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
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

function AccountForm({ orgId, projectId, actor, parties, milestones, onDone, onCancel }: {
  orgId: string; projectId: string; actor: { uid: string; email: string | null };
  parties: CostParty[]; milestones: Array<{ id: string; name: string; pct: number }>;
  onDone: () => void; onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("subcontract");
  const [budget, setBudget] = useState("");
  const [party, setParty] = useState("");
  const [pin, setPin] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) { setError("Account name is required."); return; }
    const b = budget ? Number(budget) : 0;
    if (!Number.isFinite(b) || b < 0) { setError("Budget must be a non-negative number."); return; }
    setSaving(true); setError(null);
    const res = await saveAccount({
      orgId, projectId,
      patch: { code: code || null, name, costType: type, budget: b, partyId: party || null, wbsMilestoneId: pin || null, currency: "USD" },
      actor,
    });
    setSaving(false);
    if (!res.ok) { setError(res.error ?? "Couldn't create the account."); return; }
    onDone();
  };

  return (
    <div className="px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-accent-soft)]/40 space-y-2">
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code (e.g. 01-200)" className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs font-mono" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Account name (required)" autoFocus className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs md:col-span-2" />
        <select value={type} onChange={(e) => setType(e.target.value)} className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs">
          {COST_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="Budget (USD)" inputMode="decimal" className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs font-mono tabular-nums" />
        <select value={party} onChange={(e) => setParty(e.target.value)} className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs">
          <option value="">Party…</option>
          {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <select value={pin} onChange={(e) => setPin(e.target.value)} className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" title="Earned value = budget × the pinned task's % complete">
          <option value="">Pin to schedule task (optional, enables EV/CPI)…</option>
          {milestones.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.pct}%)</option>)}
        </select>
        {error && <span className="text-[11px] font-bold text-rose-700">{error}</span>}
        <span className="ml-auto flex items-center gap-2">
          <button onClick={onCancel} className="text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1">Cancel</button>
          <button onClick={() => void submit()} disabled={saving} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Create
          </button>
        </span>
      </div>
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
          {parties.map((p) => (
            <li key={p.id} className="rounded-xl border border-[var(--color-border)] px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-[var(--color-text)] truncate">{p.name}</span>
                {p.kind && <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{p.kind}</span>}
                {p.status === "inactive" && <span className="text-[9px] font-bold text-[var(--color-text-faint)]">inactive</span>}
              </div>
              <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                {[p.trade, p.contractValue != null ? `contract ${fmtMoney(p.contractValue)}` : null].filter(Boolean).join(" · ") || "—"}
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
