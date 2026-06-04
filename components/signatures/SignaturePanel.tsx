"use client";

// SignaturePanel — shows the e-signatures captured against a resource and a
// button to capture a new one. Self-fetching; refreshes when a signature is
// recorded anywhere (via the global `signature-recorded` event).

import React from "react";
import { ShieldCheck, PenLine, CheckCircle2, XCircle, Eye } from "lucide-react";
import { listSignatures, type ESignature } from "@/lib/eSignatures";
import { requestSignature } from "@/components/signatures/SignatureCaptureHost";

const INTENT_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  Approved: CheckCircle2, Reviewed: Eye, Acknowledged: CheckCircle2, Witnessed: Eye, Rejected: XCircle,
};

export default function SignaturePanel({
  resourceType, resourceId, resourceLabel, canSign = true, className = "",
}: {
  resourceType: string;
  resourceId: string;
  resourceLabel?: string;
  canSign?: boolean;
  className?: string;
}) {
  const [sigs, setSigs] = React.useState<ESignature[] | null>(null);

  const load = React.useCallback(async () => {
    try { setSigs(await listSignatures(resourceType, resourceId)); } catch { setSigs([]); }
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

  return (
    <div className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] ${className}`}>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)]">
        <ShieldCheck className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-black text-[var(--color-text)] flex-1">Signatures {sigs && sigs.length > 0 && <span className="text-[var(--color-text-muted)] font-bold">({sigs.length})</span>}</span>
        {canSign && (
          <button
            onClick={() => requestSignature({ resourceType, resourceId, resourceLabel })}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--color-accent)] text-white text-xs font-bold hover:bg-[var(--color-accent-hover)]"
          >
            <PenLine className="w-3.5 h-3.5" /> Sign
          </button>
        )}
      </div>
      <div className="p-3">
        {!sigs ? (
          <div className="text-xs text-[var(--color-text-muted)] italic py-2 text-center">Loading…</div>
        ) : sigs.length === 0 ? (
          <div className="text-xs text-[var(--color-text-muted)] italic py-3 text-center">No signatures yet.</div>
        ) : (
          <ul className="space-y-2">
            {sigs.map((s) => {
              const Icon = INTENT_ICON[s.intent] ?? CheckCircle2;
              const tone = s.intent === "Rejected" ? "text-rose-600" : "text-emerald-600";
              return (
                <li key={s.id} className="flex items-start gap-2.5">
                  <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${tone}`} />
                  <div className="min-w-0">
                    <div className="text-sm text-[var(--color-text)]">
                      <span className="font-bold">{s.intent}</span> by <span className="font-bold" style={{ fontFamily: "cursive" }}>{s.signerName}</span>
                      {s.signerRole && <span className="text-[var(--color-text-muted)]"> · {s.signerRole}</span>}
                    </div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">{new Date(s.signedAt).toLocaleString()}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
