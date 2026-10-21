"use client";

// components/documents/UnsignedApprovalPanel.tsx — drafting-flow EVID-4
// done-when 3, on the Control Register (/register). Ruled by the integrator
// at the DF-P11 merge, 2026-10-21 (DEC-90).
//
// Read-only: the count of CURRENT revisions whose review roster is not
// complete (lib/versionApproval.ts listCurrentRevisionsWithoutSignedApproval —
// no sign-off, or only some of the required slots signed), and the list
// behind it. A read that fails is said ("not known"), never shown as "none".
// The reads run under the viewer's RLS, so the list covers the documents the
// viewer can see.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { ShieldAlert, ShieldCheck, AlertTriangle } from "lucide-react";
import {
  listCurrentRevisionsWithoutSignedApproval, APPROVAL_CLAIM_LABEL, type UnsignedCurrentRevision,
} from "@/lib/versionApproval";

export type UnsignedApprovalState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; rows: UnsignedCurrentRevision[] };

/** The panel's one-line headline. Pure. A failed read is "not known". */
export function unsignedApprovalHeadline(state: UnsignedApprovalState): string {
  if (state.status === "loading") return "Checking current revisions for a signed review sign-off…";
  if (state.status === "error") {
    return `Current revisions without a signed review sign-off: not known — ${state.message} This does not mean there are none; refresh to try again.`;
  }
  const n = state.rows.length;
  if (n === 0) return "Every current revision you can see has a complete signed review sign-off.";
  return `${n} current revision${n === 1 ? " has" : "s have"} no complete signed review sign-off — released on the publisher's word, not a second person's signed check.`;
}

/** What a row's roster says. Pure. */
export function unsignedRosterLine(r: Pick<UnsignedCurrentRevision, "satisfied" | "required">): string {
  if (r.required === 0) return "No review roster";
  return `Partially signed — ${r.satisfied} of ${r.required}`;
}

export function UnsignedApprovalView({ state }: { state: UnsignedApprovalState }) {
  const tone = state.status === "error"
    ? "border-amber-200 bg-amber-50 text-amber-800"
    : state.status === "ok" && state.rows.length > 0
      ? "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)]"
      : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)]";
  const Icon = state.status === "error" ? AlertTriangle : state.status === "ok" && state.rows.length === 0 ? ShieldCheck : ShieldAlert;
  const headline = (
    <span className="inline-flex items-start gap-2" data-testid="unsigned-approval-headline">
      <Icon className="w-4 h-4 shrink-0 mt-0.5" /> <span>{unsignedApprovalHeadline(state)}</span>
    </span>
  );
  return (
    <div className={`mb-4 rounded-xl border p-3 text-xs ${tone}`} data-testid="unsigned-approval-panel" data-state={state.status}>
      {state.status === "ok" && state.rows.length > 0 ? (
        <details>
          <summary className="cursor-pointer font-bold">{headline}</summary>
          <div className="mt-2 max-h-80 overflow-auto">
            <table className="w-full text-xs" data-testid="unsigned-approval-list">
              <thead>
                <tr className="text-[10.5px] uppercase tracking-wider text-[var(--color-text-muted)]">
                  <th className="text-left font-black px-2 py-1">Document</th>
                  <th className="text-left font-black px-2 py-1">Rev</th>
                  <th className="text-left font-black px-2 py-1">Released by</th>
                  <th className="text-left font-black px-2 py-1">Review roster</th>
                  <th className="text-left font-black px-2 py-1">{APPROVAL_CLAIM_LABEL} (unverified)</th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map((r) => (
                  <tr key={r.versionId} className="border-t border-[var(--color-border)]">
                    <td className="px-2 py-1">
                      {r.libraryId
                        ? <Link href={`/documents/${r.libraryId}?doc=${r.documentId}`} className="font-bold hover:text-[var(--color-accent)]">{r.documentNumber || r.documentId}</Link>
                        : <span className="font-bold">{r.documentNumber || r.documentId}</span>}
                    </td>
                    <td className="px-2 py-1">{r.revisionLabel || "—"}</td>
                    <td className="px-2 py-1">{r.publishedByName || "—"}</td>
                    <td className="px-2 py-1">{unsignedRosterLine(r)}</td>
                    <td className="px-2 py-1 italic">{r.claim ? `“${r.claim}”` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : headline}
    </div>
  );
}

export default function UnsignedApprovalPanel({ orgId, refreshKey }: { orgId: string | null; refreshKey?: number }) {
  // The answer is kept with the read it answers: a new workspace or a
  // Refresh shows "checking" until its own read lands (never a stale count).
  const readKey = `${orgId ?? ""}:${refreshKey ?? 0}`;
  const [result, setResult] = useState<{ key: string; state: UnsignedApprovalState } | null>(null);
  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    listCurrentRevisionsWithoutSignedApproval(orgId)
      .then((rows) => { if (alive) setResult({ key: readKey, state: { status: "ok", rows } }); })
      .catch((e: unknown) => {
        if (alive) setResult({ key: readKey, state: { status: "error", message: (e instanceof Error && e.message) || "The revisions could not be read." } });
      });
    return () => { alive = false; };
  }, [orgId, readKey]);
  const state: UnsignedApprovalState = result && result.key === readKey ? result.state : { status: "loading" };
  return <UnsignedApprovalView state={state} />;
}
