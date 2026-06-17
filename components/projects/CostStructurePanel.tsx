"use client";

// CostStructurePanel — the multi-contractor Cost Breakdown Structure.
//
// This is the answer to "one rate doesn't scale": budgets live on Control
// Accounts (party × WBS phase × cost type), funded by ingested quotes/POs and
// drawn down by invoices, with EVM rolled up PER CONTRACTOR and per cost type.
// Add contractors, add accounts (or seed them from a document), edit budgets;
// the rollup recomputes live. Self-contained: loads its own data and reports
// the project rollup up to the cockpit via onRollup.

import React, { useCallback, useEffect, useState } from "react";
import {
  Building2, Plus, Loader2, Trash2, Sparkles, TrendingUp, TrendingDown, Layers, Users,
} from "lucide-react";
import { Field, Input, Select } from "@/components/ui/Field";
import { appConfirm, appAlert } from "@/components/providers/DialogProvider";
import Spinner from "@/components/ui/Spinner";
import { formatMoney, healthOfIndex, type EvmHealth } from "@/lib/evm";
import {
  listParties, createParty, deleteParty,
  listAccounts, createAccount, updateAccount, deleteAccount,
  listEntries, computeCostRollup, buildScheduleProgressMap, COST_TYPE_LABEL,
  type CostRollup,
} from "@/lib/costControls";
import CostDocumentIngestModal from "@/components/projects/CostDocumentIngestModal";
import type {
  Project, Milestone, ProjectParty, CostAccount, CostType, PartyKind,
} from "@/types/schema";

const COST_TYPES: CostType[] = ["labor", "material", "equipment", "subcontract", "odc"];
const PARTY_KINDS: PartyKind[] = ["contractor", "subcontractor", "department", "vendor", "internal"];

const HEALTH_TEXT: Record<EvmHealth, string> = {
  ahead: "text-emerald-700", on_track: "text-emerald-700", watch: "text-amber-700",
  critical: "text-rose-700", unknown: "text-[var(--color-text-muted)]",
};

interface Props {
  project: Project;
  milestones: Milestone[];
  currency: string;
  canEdit: boolean;
  userId: string;
  userEmail?: string;
  userRole?: string;
  /** Reports the project cost rollup up so the cockpit headline can use it. */
  onRollup?: (rollup: CostRollup) => void;
  /** Overall schedule progress (0..1) for accounts with no WBS link. */
  overallPercent?: number;
  overallScheduled?: number;
}

export default function CostStructurePanel({
  project, milestones, currency, canEdit, userId, userEmail,
  onRollup, overallPercent, overallScheduled,
}: Props) {
  const [parties, setParties] = useState<ProjectParty[]>([]);
  const [accounts, setAccounts] = useState<CostAccount[]>([]);
  const [rollup, setRollup] = useState<CostRollup | null>(null);
  const [loading, setLoading] = useState(true);
  const [addingParty, setAddingParty] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);
  const [ingestOpen, setIngestOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [p, a, e] = await Promise.all([
        listParties(project.id!), listAccounts(project.id!), listEntries(project.id!),
      ]);
      setParties(p); setAccounts(a);
      const partyNames = new Map(p.map((x) => [x.id!, x.name]));
      const roll = computeCostRollup(a, e, {
        progressByMilestone: buildScheduleProgressMap(milestones),
        overallPercent, overallScheduled, partyNames, currency,
      });
      setRollup(roll);
      onRollup?.(roll);
    } catch (e) {
      await appAlert({ message: (e as Error).message, tone: "danger" });
    } finally { setLoading(false); }
  }, [project.id, milestones, overallPercent, overallScheduled, currency, onRollup]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (loading) return <div className="flex items-center justify-center py-10"><Spinner /></div>;

  const hasStructure = accounts.length > 0 || parties.length > 0;

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] bg-slate-50/60 flex items-center gap-2 flex-wrap">
        <Building2 className="w-4 h-4 text-[var(--color-accent)]" />
        <div className="font-bold text-sm text-[var(--color-text)]">Cost structure</div>
        <span className="text-[10px] text-[var(--color-text-muted)]">contractors · control accounts · budget / committed / actual</span>
        {canEdit && (
          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={() => setIngestOpen(true)}
              className="inline-flex items-center gap-1 text-[11px] font-bold text-white bg-[image:var(--brand-gradient)] hover:brightness-110 px-2.5 py-1.5 rounded-lg shadow-sm transition-[filter]">
              <Sparkles className="w-3.5 h-3.5" /> Ingest document
            </button>
            <button onClick={() => setAddingParty((v) => !v)}
              className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-text)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] border border-[var(--color-border)] px-2.5 py-1.5 rounded-lg">
              <Users className="w-3.5 h-3.5" /> Contractor
            </button>
            <button onClick={() => setAddingAccount((v) => !v)} disabled={parties.length === 0 && accounts.length === 0 && false}
              className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-2.5 py-1.5 rounded-lg">
              <Plus className="w-3.5 h-3.5" /> Cost account
            </button>
          </div>
        )}
      </div>

      {/* Empty state */}
      {!hasStructure && !addingParty && !addingAccount && (
        <div className="p-8 text-center">
          <Layers className="w-9 h-9 mx-auto text-slate-300 mb-2" />
          <p className="text-sm font-bold text-[var(--color-text)]">Build a Cost Breakdown Structure</p>
          <p className="text-sm text-[var(--color-text-muted)] mt-1 max-w-lg mx-auto">
            Add the contractors and departments on this job, then a budget (control account) per scope and cost type — or just
            <b> ingest a quote</b> and the app proposes the structure for you. EVM then rolls up per contractor.
          </p>
          {canEdit && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <button onClick={() => setIngestOpen(true)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-[image:var(--brand-gradient)] hover:brightness-110">
                <Sparkles className="w-3.5 h-3.5" /> Ingest a quote / invoice
              </button>
              <button onClick={() => setAddingParty(true)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
                <Users className="w-3.5 h-3.5" /> Add a contractor
              </button>
            </div>
          )}
        </div>
      )}

      {/* Add forms */}
      {addingParty && canEdit && (
        <AddPartyForm orgId={project.orgId} projectId={project.id!} userId={userId}
          onCancel={() => setAddingParty(false)} onAdded={() => { setAddingParty(false); void refresh(); }} />
      )}
      {addingAccount && canEdit && (
        <AddAccountForm orgId={project.orgId} projectId={project.id!} userId={userId} currency={currency}
          parties={parties} milestones={milestones}
          onCancel={() => setAddingAccount(false)} onAdded={() => { setAddingAccount(false); void refresh(); }} />
      )}

      {/* Project cost summary */}
      {rollup && rollup.hasAccounts && (
        <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 border-b border-[var(--color-border)]">
          <Tile label="Budget (BAC)" value={formatMoney(rollup.totalBudget, currency)} />
          <Tile label="Committed" value={formatMoney(rollup.totalCommitted, currency)} sub={`${formatMoney(rollup.uncommitted, currency)} open`} />
          <Tile label="Actual" value={formatMoney(rollup.totalActual, currency)} />
          <Tile label="Earned (EV)" value={formatMoney(rollup.totalEv, currency)} />
          <Tile label="CPI" value={rollup.result.cpi != null ? rollup.result.cpi.toFixed(2) : "—"} tone={healthOfIndex(rollup.result.cpi)} />
          <Tile label="SPI" value={rollup.result.spi != null ? rollup.result.spi.toFixed(2) : "—"} tone={healthOfIndex(rollup.result.spi)} />
        </div>
      )}

      {/* By contractor (OBS) */}
      {rollup && rollup.byParty.length > 0 && (
        <div className="px-4 py-3 border-b border-[var(--color-border)]">
          <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-2">By contractor</div>
          <div className="space-y-1.5">
            {rollup.byParty.map((g) => (
              <div key={g.key} className="flex items-center gap-3 text-xs">
                <div className="w-40 truncate font-bold text-[var(--color-text)]">{g.label}</div>
                <div className="flex-1 grid grid-cols-4 gap-2 text-[var(--color-text-muted)]">
                  <span>BAC {formatMoney(g.budget, currency)}</span>
                  <span>Cmt {formatMoney(g.committed, currency)}</span>
                  <span>AC {formatMoney(g.actual, currency)}</span>
                  <span className={HEALTH_TEXT[healthOfIndex(g.result.cpi)]}>
                    CPI {g.result.cpi != null ? g.result.cpi.toFixed(2) : "—"}
                    {g.result.cpi != null && (g.result.cpi >= 1 ? <TrendingUp className="w-3 h-3 inline ml-0.5" /> : <TrendingDown className="w-3 h-3 inline ml-0.5" />)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Control accounts */}
      {accounts.length > 0 && (
        <div className="divide-y divide-[var(--color-border)]">
          <div className="grid grid-cols-[1fr_120px_90px_110px_90px_90px_28px] gap-2 px-4 py-2 bg-[var(--color-surface-2)] text-[9px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">
            <span>Account</span><span>Contractor</span><span>Type</span><span className="text-right">Budget</span><span className="text-right">Committed</span><span className="text-right">Actual</span><span />
          </div>
          {(rollup?.byAccount ?? []).map((ar) => {
            const a = ar.account;
            const partyName = parties.find((p) => p.id === a.partyId)?.name ?? "—";
            return (
              <div key={a.id} className="grid grid-cols-[1fr_120px_90px_110px_90px_90px_28px] gap-2 px-4 py-2 items-center text-xs">
                <div className="min-w-0">
                  <div className="font-bold text-[var(--color-text)] truncate">{a.name}</div>
                  {a.code && <div className="text-[10px] text-[var(--color-text-faint)] font-mono">{a.code}</div>}
                </div>
                <div className="truncate text-[var(--color-text-muted)]">{partyName}</div>
                <div className="text-[var(--color-text-muted)]">{COST_TYPE_LABEL[a.costType]}</div>
                <BudgetCell account={a} canEdit={canEdit} userId={userId} onSaved={() => void refresh()} currency={currency} />
                <div className="text-right font-mono text-[var(--color-text-muted)]">{formatMoney(ar.committed, currency)}</div>
                <div className="text-right font-mono text-[var(--color-text-muted)]">{formatMoney(ar.actual, currency)}</div>
                {canEdit ? (
                  <button onClick={async () => {
                    if (!(await appConfirm({ message: `Delete cost account "${a.name}"? Its ledger entries are removed too.`, tone: "danger", confirmLabel: "Delete" }))) return;
                    try { await deleteAccount(a.id!); void refresh(); } catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
                  }} className="p-1 rounded text-[var(--color-text-faint)] hover:text-rose-600 hover:bg-rose-50"><Trash2 className="w-3.5 h-3.5" /></button>
                ) : <span />}
              </div>
            );
          })}
        </div>
      )}

      {/* Contractors with no accounts yet */}
      {parties.length > 0 && (
        <div className="px-4 py-3 border-t border-[var(--color-border)]">
          <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-2">Contractors &amp; vendors</div>
          <div className="flex flex-wrap gap-1.5">
            {parties.map((p) => (
              <span key={p.id} className="group inline-flex items-center gap-1.5 text-xs bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-full pl-2.5 pr-1.5 py-1">
                <span className="font-bold text-[var(--color-text)]">{p.name}</span>
                <span className="text-[10px] text-[var(--color-text-muted)]">{p.kind}{p.contractValue ? ` · ${formatMoney(p.contractValue, currency)}` : ""}</span>
                {canEdit && (
                  <button onClick={async () => {
                    if (!(await appConfirm({ message: `Remove ${p.name}? Cost accounts keep their data but unlink from this contractor.`, tone: "danger", confirmLabel: "Remove" }))) return;
                    try { await deleteParty(p.id!); void refresh(); } catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
                  }} className="opacity-0 group-hover:opacity-100 p-0.5 rounded-full text-[var(--color-text-faint)] hover:text-rose-600"><Trash2 className="w-3 h-3" /></button>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {ingestOpen && (
        <CostDocumentIngestModal
          orgId={project.orgId} projectId={project.id!} parties={parties} accounts={accounts}
          currency={currency} userId={userId} userEmail={userEmail}
          onClose={() => setIngestOpen(false)} onPosted={() => { setIngestOpen(false); void refresh(); }}
        />
      )}
    </div>
  );
}

// ─── Inline editors ──────────────────────────────────────────────

function BudgetCell({ account, canEdit, userId, onSaved, currency }: { account: CostAccount; canEdit: boolean; userId: string; onSaved: () => void; currency: string }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(account.budget ?? 0));
  if (!canEdit) return <div className="text-right font-mono font-bold text-[var(--color-text)]">{formatMoney(account.budget, currency)}</div>;
  if (!editing) return (
    <button onClick={() => { setVal(String(account.budget ?? 0)); setEditing(true); }} className="text-right font-mono font-bold text-[var(--color-text)] hover:text-[var(--color-accent)] w-full">
      {formatMoney(account.budget, currency)}
    </button>
  );
  const save = async () => {
    const next = Number(val.replace(/[,$]/g, "")) || 0;
    setEditing(false);
    if (next === account.budget) return;
    try { await updateAccount(account.id!, { budget: next }, userId); onSaved(); } catch { /* surfaced elsewhere */ }
  };
  return (
    <input autoFocus inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} onBlur={save}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      className="text-right font-mono text-xs px-1.5 py-1 rounded border border-[var(--color-accent-ring)] bg-[var(--color-surface)] w-full" />
  );
}

function AddPartyForm({ orgId, projectId, userId, onCancel, onAdded }: { orgId: string; projectId: string; userId: string; onCancel: () => void; onAdded: () => void }) {
  const [name, setName] = useState(""); const [kind, setKind] = useState<PartyKind>("contractor");
  const [trade, setTrade] = useState(""); const [contractValue, setContractValue] = useState(""); const [rate, setRate] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await createParty({
        orgId, projectId, name, kind, trade: trade || null,
        contractValue: contractValue ? Number(contractValue.replace(/[,$]/g, "")) : null,
        defaultRate: rate ? Number(rate.replace(/[,$]/g, "")) : null,
        status: "active", actorUserId: userId,
      });
      onAdded();
    } catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
    finally { setBusy(false); }
  };
  return (
    <div className="px-4 py-3 bg-[var(--color-accent-soft)]/40 border-b border-[var(--color-border)] grid grid-cols-2 md:grid-cols-5 gap-2 items-end">
      <Field label="Contractor / vendor"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Mechanical" autoFocus /></Field>
      <Field label="Kind"><Select value={kind} onChange={(e) => setKind(e.target.value as PartyKind)}>{PARTY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</Select></Field>
      <Field label="Trade"><Input value={trade} onChange={(e) => setTrade(e.target.value)} placeholder="Mechanical" /></Field>
      <Field label="Contract value"><Input value={contractValue} onChange={(e) => setContractValue(e.target.value)} placeholder="optional" className="font-mono" /></Field>
      <div className="flex items-center gap-1.5">
        <Field label="Rate $/h" className="flex-1"><Input value={rate} onChange={(e) => setRate(e.target.value)} placeholder="opt" className="font-mono" /></Field>
        <button onClick={submit} disabled={busy || !name.trim()} className="h-9 px-3 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Add"}</button>
        <button onClick={onCancel} className="h-9 px-2 rounded-lg text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">✕</button>
      </div>
    </div>
  );
}

function AddAccountForm({ orgId, projectId, userId, currency, parties, milestones, onCancel, onAdded }: {
  orgId: string; projectId: string; userId: string; currency: string; parties: ProjectParty[]; milestones: Milestone[]; onCancel: () => void; onAdded: () => void;
}) {
  const [name, setName] = useState(""); const [partyId, setPartyId] = useState(""); const [wbs, setWbs] = useState("");
  const [costType, setCostType] = useState<CostType>("labor"); const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  // WBS link options: prefer phases (summary rows), else any milestone.
  const summaries = milestones.filter((m) => m.isSummary || milestones.some((c) => c.parentId === m.id));
  const phases = summaries.length > 0 ? summaries : milestones;
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await createAccount({
        orgId, projectId, name, code: null, partyId: partyId || null, wbsMilestoneId: wbs || null,
        costType, budget: budget ? Number(budget.replace(/[,$]/g, "")) : 0, currency, status: "open", actorUserId: userId,
      });
      onAdded();
    } catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
    finally { setBusy(false); }
  };
  return (
    <div className="px-4 py-3 bg-[var(--color-accent-soft)]/40 border-b border-[var(--color-border)] grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
      <Field label="Account name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mechanical Labor" autoFocus /></Field>
      <Field label="Contractor"><Select value={partyId} onChange={(e) => setPartyId(e.target.value)}><option value="">—</option>{parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
      <Field label="WBS phase"><Select value={wbs} onChange={(e) => setWbs(e.target.value)}><option value="">—</option>{phases.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
      <Field label="Cost type"><Select value={costType} onChange={(e) => setCostType(e.target.value as CostType)}>{COST_TYPES.map((c) => <option key={c} value={c}>{COST_TYPE_LABEL[c]}</option>)}</Select></Field>
      <Field label="Budget (BAC)"><Input value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="0" className="font-mono" /></Field>
      <div className="flex items-center gap-1.5">
        <button onClick={submit} disabled={busy || !name.trim()} className="h-9 px-3 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Add"}</button>
        <button onClick={onCancel} className="h-9 px-2 rounded-lg text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">✕</button>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: EvmHealth }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] p-2.5">
      <div className="text-[9px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">{label}</div>
      <div className={`text-lg font-black mt-0.5 ${tone ? HEALTH_TEXT[tone] : "text-[var(--color-text)]"}`}>{value}</div>
      {sub && <div className="text-[10px] text-[var(--color-text-faint)]">{sub}</div>}
    </div>
  );
}
