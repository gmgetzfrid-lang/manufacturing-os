"use client";

// ExaminationScopePanel — drafting-flow Round G, DF-P24 EXAMINATION SCOPE
// DATA AND ISSUE GATE (GAP-102 acceptances 4 and 1), on the request page.
//
// Shown ONLY when the workspace configured examination data (Admin →
// Request forms → Examination data, with at least one list to pick from);
// otherwise it renders nothing and reads nothing (today's page, pinned).
// It lists the data this request carries and what its work class and/or
// library requires:
//   * the drafter or the engineer already in the flow (or the assignment
//     queue) picks each value from the workspace's list — never typed free —
//     through /api/tickets/examination-scope, which decides who may;
//   * what an issue would be refused for is said here before anyone tries
//     ("Needed before this request can issue"), so the person prompted is
//     someone already working on it; a request filed before a requirement
//     was set says what is missing as a warning only — it can still issue;
//   * someone who can issue the request now may record why it issues without
//     the missing data (a waiver: a required reason, audited, for this
//     revision and the data missing now), or withdraw it.

import React, { useCallback, useEffect, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { policyAllows, type CapabilityPolicy } from "@/lib/capabilityPolicy";
import { ticketResource } from "@/lib/workflow";
import type { OrgDraftingSettings, Ticket } from "@/types/schema";
import {
  parseExaminationScopeConfig, examinationScopeConfigured, examinationScopeStatus, parseScopeValues, parseScopeWaiver,
  waiverCovers, scopeEditorBasis, isMissingScopeTable, SCOPE_CLOSED_STATUSES, EXAMINATION_SCOPE_MIGRATION, EXAMINATION_WAIVER_REASON_MAX,
  type ExaminationScopeValues, type ExaminationScopeWaiver,
} from "@/lib/examinationScope";

type Load =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ok"; values: ExaminationScopeValues; waiver: ExaminationScopeWaiver | null };

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` };
}

export default function ExaminationScopePanel({
  ticket, draftingCfg, uid, role, roles, capPolicy, issuing,
}: {
  ticket: Ticket;
  draftingCfg: OrgDraftingSettings | null;
  uid: string | null | undefined;
  role: string | null | undefined;
  roles: readonly string[];
  capPolicy: CapabilityPolicy | null | undefined;
  /** The page's engine offers this viewer an issuing approval or a roster
   *  sign-off now (the route decides; this only shows the waiver control). */
  issuing: boolean;
}) {
  const config = parseExaminationScopeConfig(draftingCfg);
  const configured = examinationScopeConfigured(config);
  const ticketId = ticket.id ?? "";
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [waiverOpen, setWaiverOpen] = useState(false);
  const [reason, setReason] = useState("");

  const read = useCallback(async (alive: () => boolean) => {
    const { data, error } = await supabase.from("ticket_examination_scopes").select("field_values, waiver").eq("ticket_id", ticketId).maybeSingle();
    if (!alive()) return;
    if (error) { setLoad(isMissingScopeTable(error) ? { kind: "missing" } : { kind: "error", message: error.message || "unreadable" }); return; }
    const row = data as { field_values?: unknown; waiver?: unknown } | null;
    setLoad({ kind: "ok", values: parseScopeValues(row?.field_values), waiver: parseScopeWaiver(row?.waiver) });
  }, [ticketId]);

  useEffect(() => {
    if (!configured || !ticketId) return;
    let alive = true;
    void read(() => alive);
    return () => { alive = false; };
  }, [configured, ticketId, ticket.lastModified, read]);

  if (!configured || !ticketId) return null;

  const closed = SCOPE_CLOSED_STATUSES.has(String(ticket.status ?? ""));
  const queue = policyAllows(capPolicy ?? undefined, "ticket.assign", role ?? null, [...roles], uid ?? null, ticketResource(ticket));
  const canEdit = !closed && !!scopeEditorBasis(ticket, uid, queue);
  const values = load.kind === "ok" ? load.values : {};
  const waiver = load.kind === "ok" ? load.waiver : null;
  const status = examinationScopeStatus(config, ticket, values, draftingCfg);
  const waived = waiverCovers(waiver, status.blocking, ticket.deliverableRev);
  const requiredKeys = new Set(status.required.map((r) => r.key));
  const shown = [...config.fields.filter((f) => requiredKeys.has(f.key)), ...config.fields.filter((f) => !requiredKeys.has(f.key) && f.options.length > 0)];

  const post = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/tickets/examination-scope", { method: "POST", headers: await authHeaders(), body: JSON.stringify({ ticketId, ...body }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage({ tone: "error", text: typeof j?.error === "string" ? j.error : "Not saved — try again." }); return false; }
      setMessage({ tone: "ok", text: ok });
      await read(() => true);
      return true;
    } catch (e) {
      setMessage({ tone: "error", text: (e as Error)?.message || "Not saved — try again." });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const changes = Object.fromEntries(Object.entries(draft).filter(([k, v]) => (values[k]?.value ?? "") !== v).map(([k, v]) => [k, v || null]));

  return (
    <section data-testid="examination-scope-panel" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <h2 className="text-sm font-bold text-[var(--color-text)] flex items-center mb-2"><ClipboardCheck className="w-4 h-4 mr-2 text-orange-500" />Examination data</h2>
      {load.kind === "loading" && <p className="text-xs text-[var(--color-text-muted)]">Reading…</p>}
      {load.kind === "missing" && <p data-testid="examination-scope-not-migrated" className="text-xs text-[var(--color-text-muted)]">Examination data can&apos;t be recorded yet (database update {EXAMINATION_SCOPE_MIGRATION} is not applied) — nothing is required of this request until it is.</p>}
      {load.kind === "error" && <p className="text-xs text-red-700">This request&apos;s examination data could not be read ({load.message}).</p>}
      {load.kind === "ok" && (
        <>
          {status.blocking.length > 0 && !waived && (
            <p data-testid="examination-scope-blocking" className="text-xs text-red-700 mb-2">
              Needed before this request can issue: {status.blocking.map((b) => b.label).join(", ")}. {canEdit ? "Pick each below." : "The drafter or the engineer records it here."}
            </p>
          )}
          {status.blocking.length > 0 && waived && waiver && (
            <p data-testid="examination-scope-waived" className="text-xs text-amber-800 mb-2">
              Issues without {status.blocking.map((b) => b.label).join(", ")} — recorded by {waiver.byName || "someone who can issue it"}{waiver.at ? ` on ${new Date(waiver.at).toLocaleString()}` : ""}: “{waiver.reason}”
            </p>
          )}
          {status.warnOnly.length > 0 && (
            <p data-testid="examination-scope-warning" className="text-xs text-amber-800 mb-2">
              Not recorded: {status.warnOnly.map((w) => w.label).join(", ")} — this workspace requires {status.warnOnly.length === 1 ? "it" : "them"} now, but this request was filed before the requirement was set, so it can still issue.
            </p>
          )}
          <table className="w-full text-xs">
            <tbody>
              {shown.map((f) => {
                const req = status.required.find((r) => r.key === f.key);
                const v = values[f.key];
                const label = v ? (f.options.find((o) => o.value === v.value)?.label ?? v.value) : null;
                return (
                  <tr key={f.key} data-testid="examination-scope-row" className="border-t border-[var(--color-border)]">
                    <td className="py-1.5 pr-2 font-medium text-[var(--color-text)]">
                      {f.label}
                      {req && <span className="ml-1 text-[10px] uppercase text-[var(--color-text-muted)]">{req.enforced ? "required" : "required (after filing)"}</span>}
                    </td>
                    <td className="py-1.5 pr-2 text-[var(--color-text)]">
                      {label ?? <span className="text-[var(--color-text-faint)]">not recorded</span>}
                      {v && req?.valueRetired && <span className="ml-1 text-[10px] text-amber-700">(no longer in the list — kept as recorded)</span>}
                      {v && (v.byName || v.at) && <span className="ml-1 text-[10px] text-[var(--color-text-faint)]">{v.byName ?? ""}{v.at ? ` · ${new Date(v.at).toLocaleDateString()}` : ""}</span>}
                    </td>
                    {canEdit && (
                      <td className="py-1.5">
                        <select aria-label={f.label} className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-xs"
                          value={draft[f.key] ?? v?.value ?? ""} disabled={busy}
                          onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}>
                          <option value="">—</option>
                          {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {canEdit && Object.keys(changes).length > 0 && (
            <button type="button" disabled={busy} className="mt-2 rounded bg-blue-600 px-3 py-1 text-xs font-bold text-white disabled:opacity-50"
              onClick={async () => { if (await post({ values: changes }, "Examination data recorded.")) setDraft({}); }}>Record</button>
          )}
          {issuing && !closed && status.blocking.length > 0 && !waived && (
            <div className="mt-3">
              {!waiverOpen ? (
                <button type="button" className="text-xs font-bold text-amber-800 hover:underline" onClick={() => setWaiverOpen(true)}>Issue without it — record why</button>
              ) : (
                <div className="space-y-1">
                  <textarea aria-label="Why this request issues without the missing examination data" maxLength={EXAMINATION_WAIVER_REASON_MAX}
                    className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-xs" value={reason} onChange={(e) => setReason(e.target.value)}
                    placeholder="Required — recorded on the request and in the audit trail" />
                  <button type="button" disabled={busy || !reason.trim()} className="rounded bg-amber-700 px-3 py-1 text-xs font-bold text-white disabled:opacity-50"
                    onClick={async () => { if (await post({ waiver: { reason } }, "Recorded — this revision may issue without it.")) { setWaiverOpen(false); setReason(""); } }}>Record why</button>
                </div>
              )}
            </div>
          )}
          {issuing && !closed && waiver && (
            <button type="button" disabled={busy} className="mt-2 text-xs text-[var(--color-text-muted)] hover:underline"
              onClick={() => void post({ waiver: null }, "Withdrawn.")}>Withdraw the recorded reason</button>
          )}
        </>
      )}
      {message && <p role="status" className={`mt-2 text-xs ${message.tone === "ok" ? "text-green-700" : "text-red-700"}`}>{message.text}</p>}
    </section>
  );
}
