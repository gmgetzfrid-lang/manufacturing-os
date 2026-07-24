"use client";

// /verify-hold/[holdId] — behind the QR on a printed HOLD card.
//
// A physical red tag hangs on equipment; weeks later nobody remembers if
// the hold was released. Scan → one unmissable answer: red HOLD ACTIVE or
// green RELEASED (take the tag down). Same design language as /verify.

import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { OctagonAlert, CheckCircle2, Loader2, ShieldQuestion, RefreshCw } from "lucide-react";

interface HoldStatus {
  active: boolean;
  reason: string | null;
  notes: string | null;
  openedByName: string | null;
  openedAt: string | null;
  releasedAt: string | null;
  releasedByName: string | null;
  releasedReason: string | null;
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
      setError((e as Error).message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [params.holdId]);

  useEffect(() => { void check(); }, [check]);

  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";

  return (
    <div className={`min-h-screen flex flex-col items-center justify-center p-6 transition-colors duration-500 ${
      loading || error ? "bg-slate-900" : result?.active ? "bg-red-600" : "bg-emerald-600"
    }`}>
      <div className="w-full max-w-sm text-center">
        {loading ? (
          <div className="text-white/90">
            <Loader2 className="w-14 h-14 mx-auto animate-spin mb-4" />
            <div className="text-sm font-bold tracking-widest uppercase">Checking hold…</div>
          </div>
        ) : error ? (
          <div className="text-white/90">
            <ShieldQuestion className="w-16 h-16 mx-auto mb-4 opacity-80" />
            <h1 className="text-2xl font-black mb-2">Can&apos;t verify this tag</h1>
            <p className="text-sm opacity-80">{error}</p>
            <p className="text-xs opacity-60 mt-4">
              Treat the hold as ACTIVE until Document Control confirms otherwise.
            </p>
            <button onClick={() => void check()} className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/15 hover:bg-white/25 text-sm font-bold">
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
            <h1 className="text-3xl font-black text-white leading-tight mb-1">
              {result.active ? "HOLD ACTIVE" : "RELEASED"}
            </h1>
            <p className="text-white/90 text-sm font-bold mb-6">
              {result.active
                ? "Do not advance this document or the work it covers."
                : "This hold has been released — this tag can come down."}
            </p>

            <div className="bg-white/95 rounded-2xl shadow-2xl p-5 text-left space-y-3">
              {result.docLabel && (
                <div>
                  <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Document</div>
                  <div className="text-sm font-bold text-slate-900">
                    {result.docLabel}{result.docRev ? ` · Rev ${result.docRev}` : ""}
                  </div>
                </div>
              )}
              <div className="pt-2 border-t border-slate-100">
                <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Reason</div>
                <div className={`text-sm font-bold ${result.active ? "text-red-600" : "text-slate-700"}`}>{result.reason ?? "—"}</div>
                {result.notes && <div className="text-xs text-slate-500 mt-1">{result.notes}</div>}
              </div>
              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-100 text-xs">
                <div>
                  <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Placed</div>
                  <div className="text-slate-700">{fmt(result.openedAt)}</div>
                  {result.openedByName && <div className="text-[10px] text-slate-400">{result.openedByName}</div>}
                </div>
                {!result.active && (
                  <div>
                    <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Released</div>
                    <div className="text-emerald-700 font-bold">{fmt(result.releasedAt)}</div>
                    {result.releasedByName && <div className="text-[10px] text-slate-400">{result.releasedByName}</div>}
                  </div>
                )}
              </div>
              {!result.active && result.releasedReason && (
                <div className="text-xs text-slate-600 pt-2 border-t border-slate-100">&ldquo;{result.releasedReason}&rdquo;</div>
              )}
            </div>

            <div className="mt-5 text-[10px] text-white/60">
              Checked {new Date(result.checkedAt).toLocaleString()} · Refinery OS document control
            </div>
            <button onClick={() => void check()} className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/15 hover:bg-white/25 text-white text-xs font-bold">
              <RefreshCw className="w-3 h-3" /> Re-check
            </button>
          </>
        )}
      </div>
    </div>
  );
}
