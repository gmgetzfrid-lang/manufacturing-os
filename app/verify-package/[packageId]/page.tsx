"use client";

// /verify-package/[packageId] — the page behind the QR on a printed
// work-package cover sheet. "SCAN BEFORE STARTING WORK" now lands here:
// public, no login, one verdict — may I work from this printed pack? Green
// only for a recorded print whose every sheet is still the current, issued,
// hold-free revision of an open package, with every sheet of the package in
// it. Red = a sheet changed, was withdrawn or is held, or a sheet the
// package holds (and that could be printed) is not in the pack; amber = not
// yet in effect, or the package holds sheets that cannot be printed now
// (listed with why); grey = the code cannot confirm the printing, the
// package is closed, or it has no sheets. The verdict and the per-sheet
// labels come from lib/verifyPresent.ts.

import React, { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { CheckCircle2, XCircle, Loader2, ShieldQuestion, OctagonAlert, RefreshCw } from "lucide-react";
import { notPrintableText, presentPackVerdict, sheetLabel, type PackVerifyResult } from "@/lib/verifyPresent";

export default function VerifyPackagePage() {
  const params = useParams<{ packageId: string }>();
  const search = useSearchParams();
  const printId = search.get("print");
  const [result, setResult] = useState<PackVerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const check = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Forward the print id from the QR so verification compares against the
      // recorded print snapshot, not the live pins (PKG-2).
      const qs = new URLSearchParams({ p: params.packageId });
      if (printId) qs.set("print", printId);
      const res = await fetch(`/api/verify-package?${qs.toString()}`, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || "Could not verify this code");
      }
      setResult((await res.json()) as PackVerifyResult);
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [params.packageId, printId]);

  useEffect(() => { void check(); }, [check]);

  const view = result ? presentPackVerdict(result) : null;

  return (
    <div className={`min-h-dvh flex flex-col items-center justify-center p-6 transition-colors duration-500 ${
      loading || error || !view ? "bg-slate-900" : view.bg
    }`}>
      <div className="w-full max-w-sm text-center py-8">
        {loading ? (
          <div className="text-white/90">
            <Loader2 className="w-14 h-14 mx-auto animate-spin mb-4" />
            <div className="text-sm font-bold tracking-widest uppercase">Checking pack…</div>
          </div>
        ) : error ? (
          <div className="text-white/90">
            <ShieldQuestion className="w-16 h-16 mx-auto mb-4 opacity-80" />
            <h1 className="text-2xl font-black mb-2">Can&apos;t verify this code</h1>
            <p className="text-sm opacity-80">{error}</p>
            <p className="text-xs opacity-60 mt-4">
              If this QR came from a printed pack, contact Document Control before working from it.
            </p>
            <button
              onClick={() => void check()}
              className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/15 hover:bg-white/25 text-sm font-bold"
            >
              <RefreshCw className="w-4 h-4" /> Try again
            </button>
          </div>
        ) : result && view && (
          <>
            {view.icon === "ok" ? (
              <CheckCircle2 className="w-24 h-24 mx-auto text-white mb-4 animate-in zoom-in duration-300" strokeWidth={2.5} />
            ) : view.icon === "stop" ? (
              <OctagonAlert className="w-24 h-24 mx-auto text-white mb-4 animate-in zoom-in duration-300" strokeWidth={2.5} />
            ) : view.icon === "q" ? (
              <ShieldQuestion className="w-24 h-24 mx-auto text-white mb-4 animate-in zoom-in duration-300" strokeWidth={2.5} />
            ) : (
              <XCircle className="w-24 h-24 mx-auto text-white mb-4 animate-in zoom-in duration-300" strokeWidth={2.5} />
            )}
            <h1 className="text-3xl font-black text-white leading-tight mb-1">
              {view.headline}
            </h1>
            <p className="text-white/90 text-sm font-bold mb-6">
              {view.blurb}
              {result.printedAt ? ` Printed ${new Date(result.printedAt).toLocaleDateString()}.` : ""}
            </p>

            <div className="bg-white/95 rounded-2xl shadow-2xl p-5 text-left space-y-3">
              <div>
                <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Work package</div>
                <div className="text-sm font-bold text-slate-900">{result.name}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {result.closed ? "Closed" : result.packageStatus ? `Status: ${result.packageStatus}` : ""}
                </div>
              </div>
              <div className="pt-2 border-t border-slate-100 max-h-72 overflow-y-auto space-y-1.5">
                {result.sheets.map((s, i) => {
                  const l = sheetLabel(s);
                  return (
                    <div key={i} className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate text-slate-700">{s.label}</span>
                      <span className={`shrink-0 font-black ${l.ok ? "text-emerald-600" : "text-red-600"}`}>{l.text}</span>
                    </div>
                  );
                })}
                {result.sheets.length === 0 && (
                  <div className="text-xs text-slate-500">This package has no sheets.</div>
                )}
              </div>
              {(result.notInPack?.length ?? 0) > 0 && (
                <div className="pt-2 border-t border-slate-100 text-xs text-red-700 leading-relaxed">
                  <div className="font-black">In the package but NOT in this pack:</div>
                  {result.notInPack!.map((a, i) => <div key={i} className="truncate">{a.label}</div>)}
                </div>
              )}
              {(result.notPrintable?.length ?? 0) > 0 && (
                <div className="pt-2 border-t border-slate-100 text-xs text-amber-800 leading-relaxed">
                  <div className="font-black">In the package, not in this pack — cannot be printed now:</div>
                  {result.notPrintable!.map((a, i) => (
                    <div key={i} className="flex items-center justify-between gap-2">
                      <span className="truncate">{a.label}</span>
                      <span className="shrink-0 font-black uppercase">{notPrintableText(a.reason)}</span>
                    </div>
                  ))}
                </div>
              )}
              {view.advice && (
                <div className="pt-2 border-t border-slate-100 text-xs text-slate-600 leading-relaxed">
                  {view.advice}
                </div>
              )}
            </div>

            <div className="mt-5 text-[10px] text-white/60">
              Checked {new Date(result.checkedAt).toLocaleString()} · Refinery OS document control
            </div>
            <button
              onClick={() => void check()}
              className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/15 hover:bg-white/25 text-white text-xs font-bold"
            >
              <RefreshCw className="w-3 h-3" /> Re-check
            </button>
          </>
        )}
      </div>
    </div>
  );
}
