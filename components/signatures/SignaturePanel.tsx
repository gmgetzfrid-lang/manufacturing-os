"use client";

// SignaturePanel: the e-signatures on a resource, as a section. A heading,
// then one ruled list of signers on a white sheet: name, role, a quiet
// status pill (what they signed: approved, reviewed, rejected…) and when.
// People still expected to sign are listed as waiting. The Sign button is
// the filled main button only when it is your turn; otherwise it is a
// plain secondary button. Self-fetching; refreshes when a signature is
// recorded anywhere (the global `signature-recorded` event).

import React from "react";
import { PenLine } from "lucide-react";
import { listSignatures, type ESignature } from "@/lib/eSignatures";
import { requestSignature } from "@/components/signatures/SignatureCaptureHost";
import { useRole } from "@/components/providers/RoleContext";
import { heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import { shortDateTime } from "@/components/admin/kit";
import { StatusTag, type DocTone } from "@/components/documents/StatusTag";

/** Someone expected to sign. Matched to a signature by user id, else by name. */
export interface ExpectedSigner { uid?: string | null; name: string; role?: string | null }

const INTENT_TONE: Record<string, DocTone> = {
  Approved: "good", Reviewed: "good", Acknowledged: "good", Witnessed: "good", Rejected: "bad",
};

interface Row { key: string; name: string; role: string | null; sig: ESignature | null; you: boolean }

export default function SignaturePanel({
  resourceType, resourceId, resourceLabel, canSign = true, yourTurn, signers, className = "",
}: {
  resourceType: string;
  resourceId: string;
  resourceLabel?: string;
  canSign?: boolean;
  /** It's this person's turn to sign: the Sign button becomes the filled
   *  main button. Worked out from `signers` when left out. */
  yourTurn?: boolean;
  /** People expected to sign; those who haven't yet show as waiting. */
  signers?: ExpectedSigner[];
  className?: string;
}) {
  const { uid } = useRole();
  const [sigs, setSigs] = React.useState<ESignature[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async () => {
    try { setSigs(await listSignatures(resourceType, resourceId)); setFailed(false); } catch { setFailed(true); setSigs([]); }
  }, [resourceType, resourceId]);

  React.useEffect(() => { void load(); }, [load]);

  React.useEffect(() => {
    const onRecorded = (e: Event) => {
      const d = (e as CustomEvent<{ resourceType: string; resourceId: string }>).detail;
      if (d?.resourceType === resourceType && d?.resourceId === resourceId) void load();
    };
    window.addEventListener("signature-recorded", onRecorded as EventListener);
    return () => window.removeEventListener("signature-recorded", onRecorded as EventListener);
  }, [resourceType, resourceId, load]);

  // Expected signers first (each with their latest signature, if any), then
  // everyone else who signed, newest first.
  const rows: Row[] = React.useMemo(() => {
    const list = sigs ?? [];
    const used = new Set<string>();
    const same = (a?: string | null, b?: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
    const expected: Row[] = (signers ?? []).map((p, i) => {
      const sig = list.find((s) => !used.has(s.id) && (p.uid ? s.signerUserId === p.uid : same(s.signerName, p.name))) ?? null;
      if (sig) used.add(sig.id);
      return { key: `e${i}`, name: p.name, role: p.role ?? sig?.signerRole ?? null, sig, you: !!uid && (p.uid ? p.uid === uid : sig?.signerUserId === uid) };
    });
    const others: Row[] = list.filter((s) => !used.has(s.id)).map((s) => ({ key: s.id, name: s.signerName, role: s.signerRole ?? null, sig: s, you: !!uid && s.signerUserId === uid }));
    return [...expected, ...others];
  }, [sigs, signers, uid]);

  const myTurn = yourTurn ?? rows.some((r) => r.you && !r.sig && (signers?.length ?? 0) > 0);
  const signedCount = rows.filter((r) => r.sig).length;
  const waitingCount = rows.length - signedCount;

  return (
    <section className={`min-w-0 ${className}`} aria-labelledby={`sig-${resourceId}`}>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2 mb-2.5 min-h-8">
        <h2 id={`sig-${resourceId}`} className="font-display text-section leading-tight font-semibold text-[var(--color-text)]">Signatures</h2>
        {sigs && rows.length > 0 && (
          <span className="text-body text-[var(--color-text-muted)] tabular-nums">
            {signedCount} signed{waitingCount > 0 ? `, ${waitingCount} waiting` : ""}
          </span>
        )}
        <div className="flex-1" />
        {canSign && (
          <button
            type="button"
            onClick={() => requestSignature({ resourceType, resourceId, resourceLabel })}
            className={myTurn ? heroPrimary : heroQuiet}
          >
            <PenLine className="w-4 h-4" /> Sign
          </button>
        )}
      </div>

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
        {!sigs ? (
          <p aria-busy="true" className="px-4 py-4 text-body text-[var(--color-text-muted)]">Loading signatures…</p>
        ) : failed ? (
          <p role="alert" className="px-4 py-4 text-body text-[var(--state-overdue-text)]">
            <span className="font-medium">Couldn&apos;t load the signatures.</span>{" "}
            <button type="button" onClick={() => void load()} className="text-[var(--color-accent-text)] hover:underline underline-offset-2">Try again</button>
          </p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-4 text-body text-[var(--color-text-muted)]">
            No signatures yet.{canSign ? " Sign records your name, role and the time." : ""}
          </p>
        ) : (
          <table className="w-full text-body">
            <thead className="bg-[var(--color-surface-2)] text-body text-[var(--color-text-muted)] text-left max-sm:hidden">
              <tr>
                <th className="font-medium px-4 h-10">Signer</th>
                <th className="font-medium px-4">Role</th>
                <th className="font-medium px-4">Status</th>
                <th className="font-medium px-4 text-right">Signed</th>
              </tr>
            </thead>
            {/* A few signers are split by space; a long list keeps its row lines (B3). */}
            <tbody className={rows.length > 8 ? "divide-y divide-[var(--color-border)]" : ""}>
              {rows.map((r) => {
                const when = r.sig ? shortDateTime(r.sig.signedAt) : "";
                const tag = r.sig
                  ? <StatusTag tone={INTENT_TONE[r.sig.intent] ?? "good"}>{r.sig.intent}</StatusTag>
                  : <StatusTag tone="warn">Waiting</StatusTag>;
                return (
                  <tr key={r.key} title={r.sig?.statement}>
                    <td className="px-4 py-3 min-w-0">
                      <div className="flex items-center gap-3">
                        <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text)]">
                          {r.name}{r.you && <span className="font-normal text-[var(--color-text-muted)]"> (you)</span>}
                        </span>
                        <span className="sm:hidden shrink-0">{tag}</span>
                      </div>
                      <div className="sm:hidden text-body text-[var(--color-text-muted)]">
                        {[r.role, when || "Not signed yet"].filter(Boolean).join(", ")}
                      </div>
                    </td>
                    <td className="px-4 py-3 max-sm:hidden text-[var(--color-text-muted)] whitespace-nowrap">{r.role || "-"}</td>
                    <td className="px-4 py-3 max-sm:hidden">{tag}</td>
                    <td className="px-4 py-3 max-sm:hidden text-right whitespace-nowrap tabular-nums text-[var(--color-text-muted)]">{when || "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
