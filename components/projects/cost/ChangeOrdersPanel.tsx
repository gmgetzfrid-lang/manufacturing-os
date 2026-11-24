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
  GitPullRequestArrow, Plus, Loader2, Check, X as XIcon, Pencil, Ban, CircleAlert, ChevronRight
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
import { useDraft } from "@/hooks/useDraft";
import { sayError } from "@/components/projects/sayError";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { MoreDetails } from "@/components/ui/MoreDetails";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { AnswerLine, money } from "@/components/projects/cost/Answer";

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
  const [showDecided, setShowDecided] = useState(false);
  const [readErr, setReadErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setCos(await listChangeOrders(projectId)); setReadErr(null); }
    // Pre-migration the table is absent: say they couldn't be read, not "none".
    catch (e) { setCos([]); setReadErr(sayError(e, "Couldn't read the change orders.")); }
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
        title: `Approve ${co.coNumber} for ${fmtMoney(co.amount)}?`,
        message: `This posts the money to "${postsTo}" right away.`,
        confirmLabel: `Approve ${co.coNumber}`,
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
      setErr(sayError(e));
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
      setErr(sayError(e));
    } finally { setBusy(null); }
  };

  const open = (cos ?? []).filter((c) => c.status === "proposed");
  const decided = (cos ?? []).filter((c) => c.status !== "proposed");
  const openSum = open.reduce((t, c) => t + c.amount, 0);
  const empty = cos !== null && !readErr && cos.length === 0;
  // Decided ones recede, folded with a count, while some wait on a decision.
  const decidedOpen = showDecided || open.length === 0;
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

  const proposeButton = canManage ? (
    <button onClick={() => setShowForm((v) => !v)} aria-expanded={showForm}
      className={`inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg text-body font-medium transition-colors ${showForm ? "border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] text-[var(--color-text)]" : "bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"}`}>
      <Plus className="w-4 h-4" /> Propose change
    </button>
  ) : undefined;
  const coRow = (co: ChangeOrder) => editing === co.id && co.status === "proposed" ? (
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
  );

  return (
    <div className="space-y-4">
      {/* ── The answer: what waits on a decision, or what's been approved ── */}
      {cos !== null && !readErr && (
        empty ? (
          <AnswerLine action={proposeButton}>No change orders. When scope grows or shrinks, propose it here with a reason.</AnswerLine>
        ) : open.length > 0 ? (
          <AnswerLine value={open.length} action={proposeButton}
            sub={summary.approvedCount > 0 ? `${plural(summary.approvedCount, "approved change order")}, ${money(summary.approvedAmount)} total change.` : undefined}>
            change order{open.length === 1 ? "" : "s"} waiting on a decision, {openSum < 0 ? `a ${money(Math.abs(openSum))} credit` : money(openSum)}.
          </AnswerLine>
        ) : summary.approvedCount > 0 ? (
          <AnswerLine value={money(summary.approvedAmount)} action={proposeButton}>
            total change in {plural(summary.approvedCount, "approved change order")}. Nothing waiting on a decision.
          </AnswerLine>
        ) : (
          <AnswerLine action={proposeButton}>Nothing waiting on a decision. {plural(decided.length, "change order")} decided, none approved.</AnswerLine>
        )
      )}

      {!(empty && !showForm) && (
    <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)]">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <GitPullRequestArrow className="w-4 h-4 text-[var(--color-text-muted)]" />
        <span className="text-body font-medium text-[var(--color-text)]">Change orders</span>
        {cos && cos.length > 0 && <span className="text-body tabular-nums text-[var(--color-text-muted)]">{cos.length}</span>}
        <HelpTooltip>Reason codes score both sides: scope gaps land on the contractor&apos;s record, design errors and owner requests on ours. Approving posts the money to its budget line; nothing changes the budget silently.</HelpTooltip>
      </div>

      {showForm && canManage && (
        <ProposeForm orgId={orgId} projectId={projectId} actor={actor} accounts={accounts} parties={parties}
          onDone={() => { setShowForm(false); void refresh(); }} onCancel={() => setShowForm(false)} />
      )}

      {notice && (
        <div role="status" className="mx-4 my-2 border-l-2 border-[var(--state-held)] pl-3 flex items-center gap-2 text-caption font-medium text-[var(--state-held-text)]">
          <span className="min-w-0 flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="ui-hit ml-auto p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)]" aria-label="Dismiss"><XIcon className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {cos === null ? (
        <SkeletonRows rows={3} cols={2} what="change orders" sheet={false} />
      ) : readErr ? (
        <div role="alert" className="mx-4 my-3 border-l-2 border-[var(--state-overdue)] pl-3 text-caption text-[var(--state-overdue-text)] flex flex-wrap items-center gap-x-3">
          <span>Couldn&apos;t load change orders: {readErr}</span>
          <button onClick={() => void refresh()} className="text-[var(--color-accent-text)] hover:underline">Try again</button>
        </div>
      ) : cos.length === 0 ? null : (
        <>
          <ul className="divide-y divide-[var(--color-border)]">
            {open.map(coRow)}
            {decided.length > 0 && open.length > 0 && (
              <li>
                <button type="button" onClick={() => setShowDecided((v) => !v)} aria-expanded={decidedOpen}
                  className="w-full px-4 py-2.5 min-h-11 flex items-center gap-2 text-left text-body hover:bg-[var(--color-surface-2)]/40">
                  <ChevronRight aria-hidden className={`w-4 h-4 text-[var(--color-text-muted)] ui-chevron${decidedOpen ? " rotate-90" : ""}`} />
                  <span className="font-medium text-[var(--color-text)]">Decided</span>
                  <span className="tabular-nums text-[var(--color-text-muted)]">{decided.length}</span>
                </button>
              </li>
            )}
            {decidedOpen && decided.map(coRow)}
          </ul>
          {summary.byReason.length > 0 && (
            <div className="px-4 py-3 border-t border-[var(--color-border)]">
              <div className="text-body font-medium text-[var(--color-text-muted)] mb-2">
                Approved changes by reason: who owns the growth
              </div>
              <Donut
                segments={summary.byReason.map((r) => ({ label: CO_REASON_LABEL[r.reason], value: Math.abs(r.amount) }))}
                fmt={(n) => fmtMoney(n)} size={84}
                centerLabel={`${summary.approvedCount} CO${summary.approvedCount === 1 ? "" : "s"}`} />
            </div>
          )}
        </>
      )}
    </div>
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
    <li className={`px-4 py-2.5 text-body ${!isOpen && co.status !== "approved" ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-display tabular-nums text-caption font-semibold text-[var(--color-text-muted)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded">{co.coNumber}</span>
        <span className="font-medium text-[var(--color-text)]">{co.title}</span>
        <span className={`font-medium tabular-nums ${co.amount < 0 ? "text-[var(--state-released-text)]" : "text-[var(--color-text)]"}`}>
          {co.amount < 0 ? `credit ${fmtMoney(Math.abs(co.amount))}` : fmtMoney(co.amount)}
        </span>
        <span className="text-body font-medium px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-muted)]"
          title="Reason codes score both sides: scope gaps land on the contractor's record, design errors and owner requests on ours.">
          {CO_REASON_LABEL[co.reasonCode]}
        </span>
        <span className={`inline-flex items-center gap-1.5 text-body ${co.status === "approved" || co.status === "proposed" ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
          <span aria-hidden className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: co.status === "approved" ? "var(--state-released)" : co.status === "proposed" ? "var(--state-held)" : "var(--color-border-strong)" }} />
          {co.status === "proposed" ? "Waiting on a decision" : co.status.charAt(0).toUpperCase() + co.status.slice(1)}
        </span>
        {isOpen && canManage && (
          <span className="ml-auto inline-flex items-center gap-1.5">
            {!co.costAccountId && (
              <select value={accountPick} onChange={(e) => setAccountPick(e.target.value)} aria-label="Budget line it posts to"
                className="h-6 pointer-coarse:h-11 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1 text-caption max-w-40"
                title="Approval posts money. Pick where it lands.">
                <option value="">Posts to budget line…</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.code ? `${a.code} ` : ""}{a.name}</option>)}
              </select>
            )}
            <button onClick={() => void decide(co, "approved", accountPick || undefined)} disabled={busy}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} {busy ? "Approving" : "Approve"}
            </button>
            <button onClick={() => void decide(co, "rejected")} disabled={busy}
              className="inline-flex items-center gap-1 px-2 py-0.5 pointer-coarse:min-h-11 rounded-lg border border-[var(--state-overdue)] text-[var(--state-overdue-text)] text-caption font-medium hover:bg-[color-mix(in_srgb,var(--state-overdue)_10%,transparent)] disabled:opacity-50 transition-colors">
              <XIcon className="w-3 h-3" /> Reject
            </button>
            <button onClick={onEdit} disabled={busy} title="Change the title, amount, reason or where it posts"
              className="inline-flex items-center gap-1 px-2 py-0.5 pointer-coarse:min-h-11 rounded-lg border border-[var(--color-border-strong)] text-[var(--color-text-muted)] text-caption font-medium hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">
              <Pencil className="w-3 h-3" /> Edit
            </button>
            <button onClick={() => void decide(co, "void")} disabled={busy} title="Take the proposal back. It stays on the record as void."
              className="inline-flex items-center gap-1 px-2 py-0.5 pointer-coarse:min-h-11 rounded-lg text-[var(--color-text-faint)] text-caption font-medium hover:text-[var(--state-overdue-text)] hover:bg-[color-mix(in_srgb,var(--state-overdue)_10%,transparent)] disabled:opacity-50 transition-colors">
              <Ban className="w-3 h-3" /> Withdraw
            </button>
          </span>
        )}
        {co.status === "approved" && canManage && (
          <button onClick={onVoidApproved} disabled={busy} title="Approved in error: its money comes off the budget line and the CO shows as void"
            className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 pointer-coarse:min-h-11 rounded-lg text-[var(--color-text-faint)] text-caption font-medium hover:text-[var(--state-overdue-text)] hover:bg-[color-mix(in_srgb,var(--state-overdue)_10%,transparent)] disabled:opacity-50 transition-colors">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />} {busy ? "Voiding" : "Void"}
          </button>
        )}
      </div>
      <div className="mt-1 text-caption text-[var(--color-text-muted)]">
        {[
          partyName, accountLabel,
          co.description,
          co.createdByName ? `proposed by ${co.createdByName}` : null,
          co.decidedByName ? `${co.status} by ${co.decidedByName}${co.decidedAt ? ` on ${new Date(co.decidedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}` : null,
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
  // A new change order being written comes back after a reload.
  const typed = useMemo(() => ({ title, amount, desc }), [title, amount, desc]);
  const draft = useDraft<{ title: string; amount: string; desc: string }>(editing ? null : `change-order:${projectId}`, typed,
    (v) => { setTitle(v.title ?? ""); setAmount(v.amount ?? ""); setDesc(v.desc ?? ""); },
    (v) => !v.title?.trim() && !v.amount?.trim() && !v.desc?.trim());
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
      draft.clear();
      onDone();
    } catch (e) {
      setError(sayError(e));
    } finally { setSaving(false); }
  };

  const unitId = React.useId();
  const lbl = "block mb-1 text-body font-medium text-[var(--color-text-muted)]";
  const fld = "h-10 pointer-coarse:h-11 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-body text-[var(--color-text)]";
  // Asked for up front: what changed, how much, why. Where it posts, who
  // it's with and the detail are folded (where it posts is asked again at
  // approval when it's still blank).
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label={editing ? `Change ${editing.coNumber}` : "Propose a change order"}
      className="px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.5fr)] gap-2">
        <label className="block min-w-0">
          <span className={lbl}>What changed</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus enterKeyHint="next" className={fld} />
        </label>
        <label className="block min-w-0">
          <span className={lbl}>Amount</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" enterKeyHint="next" aria-describedby={unitId}
            className={`${fld} font-display tabular-nums`} />
          <span id={unitId} className="block mt-0.5 text-caption text-[var(--color-text-muted)]">Minus for a credit back</span>
        </label>
        <label className="block min-w-0">
          <span className={lbl}>Reason</span>
          <select value={reason} onChange={(e) => setReason(e.target.value as CoReason)} className={fld}>
            {(Object.keys(CO_REASON_LABEL) as CoReason[]).map((r) => (
              <option key={r} value={r}>{CO_REASON_LABEL[r]}</option>
            ))}
          </select>
        </label>
      </div>
      <MoreDetails filled={(accountId ? 1 : 0) + (partyId ? 1 : 0) + (desc.trim() ? 1 : 0)} total={3}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="block min-w-0">
            <span className={lbl}>Budget line it posts to</span>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={fld}>
              <option value="">Not picked (needed to approve)</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.code ? `${a.code} ` : ""}{a.name}</option>)}
            </select>
          </label>
          <label className="block min-w-0">
            <span className={lbl}>Contractor or vendor</span>
            <select value={partyId} onChange={(e) => setPartyId(e.target.value)} className={fld}>
              <option value="">None</option>
              {pickParties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="block min-w-0 sm:col-span-2">
            <span className={lbl}>Detail (goes on the record)</span>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} className={fld} />
          </label>
        </div>
      </MoreDetails>
      <div className="flex items-center gap-2">
        {error && <span role="alert" className="text-caption font-medium text-[var(--state-overdue-text)] flex items-start gap-1.5"><CircleAlert aria-hidden className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{error}</span></span>}
        <span className="ml-auto flex items-center gap-2">
          <button type="button" onClick={onCancel} className="inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">Cancel</button>
          <button type="submit" disabled={saving}
            className={`inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg text-body font-medium disabled:opacity-50 ${editing
              ? "border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
              : "bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"}`}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {saving ? (editing ? "Saving" : "Proposing") : editing ? `Save ${editing.coNumber}` : "Propose"}
          </button>
        </span>
      </div>
    </form>
  );
}
