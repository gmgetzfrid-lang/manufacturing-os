"use client";

// ChangeOrdersPanel — changes are first-class, never silent budget edits.
//
// Propose with a REASON CODE (plain-language labels — scope gap scores the
// contractor, design error scores us), decide on the record, and approval
// posts the money as a typed cost entry in the same click. The reason mix
// renders as a donut: a project bleeding scope-gap COs has a bidding
// problem; one bleeding owner requests has a scoping problem — the chart
// says which.
//
// A proposed CO can be edited or withdrawn; an approved one can be voided
// (its money comes off the line, the paper stays).

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  GitPullRequestArrow, Plus, Loader2, Check, X as XIcon, AlertTriangle, Pencil, Ban,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { fmtMoney, type CostAccount, type CostParty, type Actor } from "@/lib/costs";
import {
  type ChangeOrder, type CoReason, CO_REASON_LABEL,
  listChangeOrders, proposeChangeOrder, decideChangeOrder, summarizeChangeOrders,
  editChangeOrder, voidApprovedChangeOrder,
} from "@/lib/changeOrders";
import { Donut } from "@/components/ui/ChartKit";
import { appConfirm, appPrompt } from "@/components/providers/DialogProvider";

export default function ChangeOrdersPanel({ orgId, projectId, canManage, actor, accounts, parties, onMoneyMoved, setErr }: {
  orgId: string; projectId: string; canManage: boolean; actor: Actor;
  accounts: CostAccount[]; parties: CostParty[];
  /** Approval posts a cost entry — the parent refreshes its rollup. */
  onMoneyMoved: () => void;
  setErr: (m: string | null) => void;
}) {
  const [cos, setCos] = useState<ChangeOrder[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // The proposed CO being edited in place.
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setCos(await listChangeOrders(projectId)); }
    catch { setCos([]); } // pre-migration: table absent — panel stays quiet
  }, [projectId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const summary = useMemo(() => summarizeChangeOrders(cos ?? []), [cos]);
  const partyName = useMemo(() => new Map(parties.map((p) => [p.id, p.name])), [parties]);
  const accountName = useMemo(() => new Map(accounts.map((a) => [a.id, `${a.code ? `${a.code} ` : ""}${a.name}`])), [accounts]);

  const decide = async (co: ChangeOrder, decision: "approved" | "rejected" | "void", accountId?: string) => {
    let target = co;
    if (decision === "approved" && !co.costAccountId && !accountId) {
      setErr("Pick which budget line this change order posts to before approving."); return;
    }
    if (decision === "approved") {
      // Confirm FIRST — nothing (not even the account assignment) persists
      // on a cancelled approval.
      const postsTo = accountName.get(co.costAccountId ?? accountId ?? "") ?? "the budget line";
      if (!(await appConfirm({
        message: `Approve ${co.coNumber} for ${fmtMoney(co.amount)}? This posts the money to "${postsTo}" immediately.`,
      }))) return;
      if (!co.costAccountId && accountId) {
        const { error } = await supabase.from("change_orders").update({ cost_account_id: accountId })
          .eq("id", co.id).eq("status", "proposed");
        if (error) { setErr(error.message); return; }
        target = { ...co, costAccountId: accountId };
      }
    }
    let note: string | null = null;
    if (decision === "rejected") {
      note = await appPrompt({ title: `Reject ${co.coNumber}`, message: "Why? The reason goes on the record for the contractor and the audit trail.", placeholder: "e.g. Covered by the original scope, section 3.2" });
      if (note === null) return;
    }
    if (decision === "void") {
      // Withdrawing a proposal: it stays on the list as void, with why.
      note = await appPrompt({ title: `Withdraw ${co.coNumber}?`, message: "It stays on the record as void and never posts money. Say why (optional).", placeholder: "e.g. Folded into CO-004", confirmLabel: "Withdraw", tone: "danger" });
      if (note === null) return;
    }
    setBusy(co.id); setErr(null);
    try {
      await decideChangeOrder({ co: target, decision, note, actorId: actor.uid, actorName: actor.email?.split("@")[0] ?? null });
      await refresh();
      if (decision === "approved") onMoneyMoved();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  };

  // An approval made in error: the money comes off, the CO goes void.
  const voidApproved = async (co: ChangeOrder) => {
    const reason = await appPrompt({
      title: `Void ${co.coNumber}?`,
      message: `This takes ${co.amount < 0 ? `the ${fmtMoney(Math.abs(co.amount))} credit` : fmtMoney(co.amount)} back off "${accountName.get(co.costAccountId ?? "") ?? "its budget line"}". The entry stays on the record, struck through, and the CO shows as void with your reason.`,
      placeholder: "Why? e.g. Approved on the wrong job",
      confirmLabel: "Void it", tone: "danger",
    });
    if (reason === null) return;
    setBusy(co.id); setErr(null); setNotice(null);
    try {
      const res = await voidApprovedChangeOrder({ co, reason, actorId: actor.uid, actorName: actor.email?.split("@")[0] ?? null });
      if (res.note) setNotice(res.note);
      await refresh();
      onMoneyMoved();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  };

  const open = (cos ?? []).filter((c) => c.status === "proposed");
  const decided = (cos ?? []).filter((c) => c.status !== "proposed");

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <GitPullRequestArrow className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Change orders</span>
        {open.length > 0 && (
          <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/40">
            {open.length} awaiting decision
          </span>
        )}
        {summary.approvedCount > 0 && (
          <span className="text-[10px] text-[var(--color-text-muted)]">
            {summary.approvedCount} approved · {fmtMoney(summary.approvedAmount)} total change
          </span>
        )}
        {canManage && (
          <button onClick={() => setShowForm((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] transition-colors">
            <Plus className="w-3 h-3" /> Propose change
          </button>
        )}
      </div>

      {showForm && canManage && (
        <ProposeForm orgId={orgId} projectId={projectId} actor={actor} accounts={accounts} parties={parties}
          onDone={() => { setShowForm(false); void refresh(); }} onCancel={() => setShowForm(false)} />
      )}

      {notice && (
        <div className="px-4 py-2 border-b border-[var(--color-border)] flex items-center gap-2 text-[11px] font-bold text-amber-800 dark:text-amber-300 bg-amber-500/[0.06]">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {notice}
          <button onClick={() => setNotice(null)} className="ml-auto p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)]" aria-label="Dismiss"><XIcon className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {(cos ?? []).length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">
          No change orders. When scope grows (or shrinks), propose it here with a reason -
          the budget only ever changes on the record.
        </div>
      ) : (
        <>
          {summary.byReason.length > 0 && (
            <div className="px-4 py-3 border-b border-[var(--color-border)]">
              <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-2">
                Approved changes by reason - who owns the growth
              </div>
              <Donut
                segments={summary.byReason.map((r) => ({ label: CO_REASON_LABEL[r.reason], value: Math.abs(r.amount) }))}
                fmt={(n) => fmtMoney(n)} size={84}
                centerLabel={`${summary.approvedCount} CO${summary.approvedCount === 1 ? "" : "s"}`} />
            </div>
          )}
          <ul className="divide-y divide-[var(--color-border)]">
            {[...open, ...decided].map((co) => editing === co.id && co.status === "proposed" ? (
              <li key={co.id}>
                <ProposeForm orgId={orgId} projectId={projectId} actor={actor} accounts={accounts} parties={parties} editing={co}
                  onDone={() => { setEditing(null); void refresh(); }} onCancel={() => setEditing(null)} />
              </li>
            ) : (
              <CoRow key={co.id} co={co} canManage={canManage} busy={busy === co.id}
                partyName={co.partyId ? partyName.get(co.partyId) ?? null : null}
                accountLabel={co.costAccountId ? accountName.get(co.costAccountId) ?? null : null}
                accounts={accounts} decide={decide}
                onEdit={() => setEditing(co.id)} onVoidApproved={() => void voidApproved(co)} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function CoRow({ co, canManage, busy, partyName, accountLabel, accounts, decide, onEdit, onVoidApproved }: {
  co: ChangeOrder; canManage: boolean; busy: boolean;
  partyName: string | null; accountLabel: string | null;
  accounts: CostAccount[];
  decide: (co: ChangeOrder, decision: "approved" | "rejected" | "void", accountId?: string) => Promise<void>;
  onEdit: () => void;
  onVoidApproved: () => void;
}) {
  const [accountPick, setAccountPick] = useState(co.costAccountId ?? "");
  const isOpen = co.status === "proposed";
  return (
    <li className={`px-4 py-2.5 text-xs ${!isOpen && co.status !== "approved" ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-[10px] font-black text-[var(--color-text-muted)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded">{co.coNumber}</span>
        <span className="font-bold text-[var(--color-text)]">{co.title}</span>
        <span className={`font-black tabular-nums ${co.amount < 0 ? "text-emerald-700 dark:text-emerald-300" : "text-[var(--color-text)]"}`}>
          {co.amount < 0 ? `credit ${fmtMoney(Math.abs(co.amount))}` : fmtMoney(co.amount)}
        </span>
        <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-muted)]"
          title="Reason codes score both sides: scope gaps land on the contractor's record, design errors and owner requests on ours.">
          {CO_REASON_LABEL[co.reasonCode]}
        </span>
        <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${
          co.status === "approved" ? "border-emerald-500/40 bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-300"
          : co.status === "proposed" ? "border-amber-500/40 bg-amber-500/[0.07] text-amber-700 dark:text-amber-300"
          : "border-[var(--color-border)] text-[var(--color-text-faint)]"}`}>
          {co.status}
        </span>
        {isOpen && canManage && (
          <span className="ml-auto inline-flex items-center gap-1.5">
            {!co.costAccountId && (
              <select value={accountPick} onChange={(e) => setAccountPick(e.target.value)}
                className="h-6 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1 text-[10px] max-w-40"
                title="Approval posts money - pick where it lands.">
                <option value="">Posts to budget line…</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.code ? `${a.code} ` : ""}{a.name}</option>)}
              </select>
            )}
            <button onClick={() => void decide(co, "approved", accountPick || undefined)} disabled={busy}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-emerald-600 text-white text-[10px] font-black hover:bg-emerald-700 disabled:opacity-50 transition-colors">
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Approve
            </button>
            <button onClick={() => void decide(co, "rejected")} disabled={busy}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border border-rose-500/50 text-rose-700 dark:text-rose-300 text-[10px] font-black hover:bg-rose-500/10 disabled:opacity-50 transition-colors">
              <XIcon className="w-3 h-3" /> Reject
            </button>
            <button onClick={onEdit} disabled={busy} title="Change the title, amount, reason or where it posts"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border border-[var(--color-border-strong)] text-[var(--color-text-muted)] text-[10px] font-bold hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">
              <Pencil className="w-3 h-3" /> Edit
            </button>
            <button onClick={() => void decide(co, "void")} disabled={busy} title="Take the proposal back - it stays on the record as void"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[var(--color-text-faint)] text-[10px] font-bold hover:text-rose-600 hover:bg-rose-500/10 disabled:opacity-50 transition-colors">
              <Ban className="w-3 h-3" /> Withdraw
            </button>
          </span>
        )}
        {co.status === "approved" && canManage && (
          <button onClick={onVoidApproved} disabled={busy} title="Approved in error: its money comes off the budget line and the CO shows as void"
            className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[var(--color-text-faint)] text-[10px] font-bold hover:text-rose-600 hover:bg-rose-500/10 disabled:opacity-50 transition-colors">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />} Void
          </button>
        )}
      </div>
      <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
        {[
          partyName, accountLabel,
          co.description,
          co.createdByName ? `proposed by ${co.createdByName}` : null,
          co.decidedByName ? `${co.status} by ${co.decidedByName}${co.decidedAt ? ` on ${new Date(co.decidedAt).toLocaleDateString()}` : ""}` : null,
          co.decisionNote ? `“${co.decisionNote}”` : null,
        ].filter(Boolean).join(" · ")}
      </div>
    </li>
  );
}

function ProposeForm({ orgId, projectId, actor, accounts, parties, onDone, onCancel, editing }: {
  orgId: string; projectId: string; actor: Actor;
  accounts: CostAccount[]; parties: CostParty[];
  onDone: () => void; onCancel: () => void;
  /** A proposed CO to change, in place of a new one. */
  editing?: ChangeOrder;
}) {
  const [title, setTitle] = useState(editing?.title ?? "");
  const [amount, setAmount] = useState(editing ? String(editing.amount) : "");
  const [reason, setReason] = useState<CoReason>(editing?.reasonCode ?? "field_condition");
  const [accountId, setAccountId] = useState(editing?.costAccountId ?? "");
  const [partyId, setPartyId] = useState(editing?.partyId ?? "");
  const [desc, setDesc] = useState(editing?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Companies taken off the job aren't offered for new paper; the one
  // already on this CO stays.
  const pickParties = parties.filter((p) => p.status !== "inactive" || p.id === editing?.partyId);

  const submit = async () => {
    const n = Number(amount.replace(/[$,\s]/g, ""));
    if (!title.trim()) { setError("Give the change a title."); return; }
    if (!Number.isFinite(n) || n === 0) { setError("Enter the amount (negative = credit back)."); return; }
    setSaving(true); setError(null);
    try {
      if (editing) {
        await editChangeOrder({
          co: editing,
          patch: {
            title, description: desc || null, amount: n, reasonCode: reason,
            costAccountId: accountId || null, partyId: partyId || null,
          },
          actorId: actor.uid, actorName: actor.email?.split("@")[0] ?? null,
        });
        onDone();
        return;
      }
      await proposeChangeOrder({
        orgId, projectId,
        costAccountId: accountId || null, partyId: partyId || null,
        title, description: desc || null, amount: n, reasonCode: reason,
        actorId: actor.uid, actorName: actor.email?.split("@")[0] ?? null,
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally { setSaving(false); }
  };

  return (
    <div className="px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-accent-soft)]/40 space-y-2">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What changed? (title)" autoFocus
          className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs col-span-2" />
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount (− = credit)" inputMode="decimal"
          className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs font-mono tabular-nums" />
        <select value={reason} onChange={(e) => setReason(e.target.value as CoReason)}
          className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs">
          {(Object.keys(CO_REASON_LABEL) as CoReason[]).map((r) => (
            <option key={r} value={r}>{CO_REASON_LABEL[r]}</option>
          ))}
        </select>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}
          className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs col-span-2">
          <option value="">Budget line it posts to (required to approve)…</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.code ? `${a.code} ` : ""}{a.name}</option>)}
        </select>
        <select value={partyId} onChange={(e) => setPartyId(e.target.value)}
          className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs">
          <option value="">Contractor / vendor…</option>
          {pickParties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Detail (goes on the record)"
          className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
      </div>
      <div className="flex items-center gap-2">
        {error && <span className="inline-flex items-center gap-1 text-[11px] font-bold text-rose-700"><AlertTriangle className="w-3 h-3" />{error}</span>}
        <span className="ml-auto flex items-center gap-2">
          <button onClick={onCancel} className="text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1">Cancel</button>
          <button onClick={() => void submit()} disabled={saving}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} {editing ? `Save ${editing.coNumber}` : "Propose"}
          </button>
        </span>
      </div>
    </div>
  );
}
