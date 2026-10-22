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
//     queue; second fix pass: its requester while the request is still with
//     the drafter) picks each value from the workspace's list — never typed
//     free — through /api/tickets/examination-scope, which decides who may;
//     merge-time fix pass: each field offers exactly what lib/
//     examinationScope.ts scopeFieldRight allows this viewer (the requester
//     fills an empty field or changes their own; in review only the
//     engineer of record changes a value; after issue a missing field may
//     be completed — "completed after issue" — and nothing is changed or
//     cleared);
//   * what an issue would be refused for is said here before anyone tries
//     ("Needed before this request can issue"), so the person prompted is
//     someone already working on it; a request filed before a requirement
//     was set says what is missing as a warning only — it can still issue;
//   * someone who can issue the request now may record why it issues without
//     the missing data (a waiver: a required reason, audited, for this
//     revision and the data missing now), or withdraw it — merge-time fix
//     pass: the control shows only when the route's GET says this viewer may
//     (the workflow route's own authority check, lib/workflowAuthority.ts),
//     asked only where the page already offers them an issuing act.

import React, { useCallback, useEffect, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { policyAllows, type CapabilityPolicy } from "@/lib/capabilityPolicy";
import { ticketResource } from "@/lib/workflow";
import type { OrgDraftingSettings, Ticket } from "@/types/schema";
import {
  parseExaminationScopeConfig, examinationScopeConfigured, examinationScopeStatus, parseScopeValues, parseScopeWaiver,
  waiverCovers, scopeFieldRight, scopePhase, isMissingScopeTable, SCOPE_CLOSED_STATUSES, SCOPE_ISSUED_STATUSES, EXAMINATION_SCOPE_MIGRATION, EXAMINATION_WAIVER_REASON_MAX,
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
   *  sign-off now — only then is the route asked whether they may record a
   *  waiver (its answer decides whether the control shows). */
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
  /** The route's answer: may this viewer record (or withdraw) a waiver now? */
  const [mayWaive, setMayWaive] = useState(false);

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

  // Merge-time fix pass (item 7): the waiver control shows only to someone
  // the shared authority check allows — asked of the route (it runs the
  // workflow route's own check), only where the page already offers this
  // viewer an issuing act on an open, unissued request with data to waive.
  const terminal = SCOPE_CLOSED_STATUSES.has(String(ticket.status ?? "")) || SCOPE_ISSUED_STATUSES.has(String(ticket.status ?? ""));
  const loadedScope = load.kind === "ok" ? load : null;
  const blockingNow = loadedScope ? examinationScopeStatus(config, ticket, loadedScope.values, draftingCfg).blocking.length > 0 : false;
  const askWaiver = configured && !!ticketId && issuing && !terminal && (blockingNow || !!loadedScope?.waiver);
  useEffect(() => {
    if (!askWaiver) { setMayWaive(false); return; }
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/tickets/examination-scope?ticketId=${encodeURIComponent(ticketId)}`, { headers: await authHeaders() });
        const j = await res.json().catch(() => ({}));
        if (alive) setMayWaive(res.ok && j?.mayWaive === true);
      } catch {
        if (alive) setMayWaive(false);
      }
    })();
    return () => { alive = false; };
  }, [askWaiver, ticketId, ticket.lastModified, ticket.deliverableRev]);

  if (!configured || !ticketId) return null;

  // Second fix pass: an issued request's data is its issued record — shown,
  // never changed here (the route refuses it too).
  const closed = terminal;
  const issued = SCOPE_ISSUED_STATUSES.has(String(ticket.status ?? ""));
  const inReview = scopePhase(ticket.status) === "in_review";
  const queue = policyAllows(capPolicy ?? undefined, "ticket.assign", role ?? null, [...roles], uid ?? null, ticketResource(ticket));
  const values = load.kind === "ok" ? load.values : {};
  // What this viewer may do to each field (the route decides the same way).
  const rightOf = (key: string) => scopeFieldRight(ticket, uid, queue, values[key] ?? null);
  const editable = (key: string) => { const r = rightOf(key); return values[key] ? r.change : r.fill; };
  const waiver = load.kind === "ok" ? load.waiver : null;
  const status = examinationScopeStatus(config, ticket, values, draftingCfg);
  const waived = waiverCovers(waiver, status.blocking, ticket.deliverableRev);
  const requiredKeys = new Set(status.required.map((r) => r.key));
  const shown = [...config.fields.filter((f) => requiredKeys.has(f.key)), ...config.fields.filter((f) => !requiredKeys.has(f.key) && f.options.length > 0)];
  const canEdit = shown.some((f) => editable(f.key));

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
          {issued && (
            <p data-testid="examination-scope-issued" className="text-xs text-[var(--color-text-muted)] mb-2">Issued with the data below — it is part of the issued record and is not changed or cleared (unless the request is sent back). Data still missing may be completed: it is recorded as completed after issue.</p>
          )}
          {inReview && (
            <p data-testid="examination-scope-in-review" className="text-xs text-[var(--color-text-muted)] mb-2">In review — only the engineer of record changes this data now; each change goes on the request&apos;s history.</p>
          )}
          {status.blocking.length > 0 && !waived && !issued && (
            <p data-testid="examination-scope-blocking" className="text-xs text-red-700 mb-2">
              Needed before this request can issue: {status.blocking.map((b) => b.label).join(", ")}. {canEdit ? "Pick each below." : inReview ? "Its engineer of record records it here (or it can be sent back for revision)." : "The drafter or the engineer records it here."}
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
                      {v?.afterIssue && <span data-testid="examination-scope-after-issue" className="ml-1 text-[10px] text-amber-700">(completed after issue)</span>}
                      {v && (v.byName || v.at) && <span className="ml-1 text-[10px] text-[var(--color-text-faint)]">{v.byName ?? ""}{v.at ? ` · ${new Date(v.at).toLocaleDateString()}` : ""}</span>}
                    </td>
                    {canEdit && (
                      <td className="py-1.5">
                        {editable(f.key) && (
                          <select aria-label={f.label} className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-xs"
                            value={draft[f.key] ?? v?.value ?? ""} disabled={busy}
                            onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}>
                            {(!v || rightOf(f.key).change) && <option value="">—</option>}
                            {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        )}
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
          {mayWaive && !closed && status.blocking.length > 0 && !waived && (
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
          {mayWaive && !closed && waiver && (
            <button type="button" disabled={busy} className="mt-2 text-xs text-[var(--color-text-muted)] hover:underline"
              onClick={() => void post({ waiver: null }, "Withdrawn.")}>Withdraw the recorded reason</button>
          )}
        </>
      )}
      {message && <p role="status" className={`mt-2 text-xs ${message.tone === "ok" ? "text-green-700" : "text-red-700"}`}>{message.text}</p>}
    </section>
  );
}
