"use client";

// /verify-hold/[holdId] — behind the QR on a printed HOLD card.
//
// A physical red tag hangs on equipment; weeks later nobody remembers if
// the hold was released. Scan → one unmissable answer: red HOLD ACTIVE or
// green RELEASED (take the tag down). Same design language as /verify.

import { friendlyError } from "@/lib/friendlyError";
import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { OctagonAlert, CheckCircle2, Loader2, ShieldQuestion, RefreshCw } from "lucide-react";

interface HoldStatus {
  active: boolean;
  reason: string | null;
  openedAt: string | null;
  releasedAt: string | null;
  docLabel: string | null;
  docRev: string | null;
  checkedAt: string;
}

export default function VerifyHoldPage() {
  const params = useParams<{ holdId: string }>();
  const [result, setResult] = useState<HoldStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const check = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/verify-hold?id=${encodeURIComponent(params.holdId)}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || "Could not verify this code");
      }
      setResult((await res.json()) as HoldStatus);
    } catch (e) {
      setError(friendlyError(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [params.holdId]);

  useEffect(() => { void check(); }, [check]);

  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "-";

  return (
    <div className={`min-h-dvh flex flex-col items-center justify-center p-6 transition-colors duration-500 ${
      loading || error ? "bg-[var(--color-ink)]" : result?.active ? "bg-[var(--state-overdue)]" : "bg-[var(--state-released)]"
    }`}>
      <div className="w-full max-w-sm text-center">
        {loading ? (
          <div className="text-white/90">
            <Loader2 className="w-14 h-14 mx-auto animate-spin mb-4" />
            <div className="text-[13px] font-semibold ">Checking hold…</div>
          </div>
        ) : error ? (
          <div className="text-white/90">
            <ShieldQuestion className="w-16 h-16 mx-auto mb-4 opacity-80" />
            <h1 className="text-[34px] leading-[1.05] tracking-[-0.02em] font-bold mb-3">Can&apos;t verify this tag</h1>
            <p className="text-[15px] opacity-90">{error}</p>
            <p className="text-[13px] opacity-70 mt-4">
              Treat the hold as active until Document Control confirms otherwise.
            </p>
            <button onClick={() => void check()} className="mt-6 inline-flex items-center gap-2 h-11 px-4 rounded-lg bg-white/15 hover:bg-white/25 text-[15px] font-semibold">
              <RefreshCw className="w-4 h-4" /> Try again
            </button>
          </div>
        ) : result && (
          <>
            {result.active ? (
              <OctagonAlert className="w-24 h-24 mx-auto text-white mb-4 animate-in zoom-in duration-300" strokeWidth={2.5} />
            ) : (
              <CheckCircle2 className="w-24 h-24 mx-auto text-white mb-4 animate-in zoom-in duration-300" strokeWidth={2.5} />
            )}
            <h1 className="text-[40px] font-bold text-white leading-[1.03] tracking-[-0.03em] mb-3">
              {result.active ? "Hold active" : "Released"}
            </h1>
            <p className="text-white/90 text-[15px] font-semibold mb-6">
              {result.active
                ? "Do not advance this document or the work it covers."
                : "This hold was released. The tag can come down."}
            </p>

            <div className="bg-[var(--color-surface)] rounded-xl ui-float p-5 text-left space-y-3">
              {result.docLabel && (
                <div>
                  <div className="text-[13px] font-semibold text-[var(--color-text-muted)]">Document</div>
                  <div className="text-[15px] font-semibold text-[var(--color-text)]">
                    {result.docLabel}{result.docRev ? ` · Rev ${result.docRev}` : ""}
                  </div>
                </div>
              )}
              <div className="pt-2 border-t border-[var(--color-border)]">
                <div className="text-[13px] font-semibold text-[var(--color-text-muted)]">Reason</div>
                <div className={`text-[14px] font-semibold ${result.active ? "text-[var(--state-overdue-text)]" : "text-[var(--color-text)]"}`}>{result.reason ?? "-"}</div>
              </div>
              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-[var(--color-border)] text-xs">
                <div>
                  <div className="text-[13px] font-semibold text-[var(--color-text-muted)]">Placed</div>
                  <div className="text-[var(--color-text)]">{fmt(result.openedAt)}</div>
                </div>
                {!result.active && (
                  <div>
                    <div className="text-[13px] font-semibold text-[var(--color-text-muted)]">Released</div>
                    <div className="text-[var(--state-released-text)] font-semibold">{fmt(result.releasedAt)}</div>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-5 text-[12px] text-white/70">
              Checked {new Date(result.checkedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} by document control.
            </div>
            <button onClick={() => void check()} className="mt-3 inline-flex items-center gap-1.5 h-11 px-4 rounded-lg bg-white/15 hover:bg-white/25 text-white text-[15px] font-semibold">
              <RefreshCw className="w-4 h-4" /> Check again
            </button>
          </>
        )}
      </div>
    </div>
  );
}
