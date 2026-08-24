"use client";

// /verify-package/[packageId] — the page behind the QR on a printed
// work-package cover sheet. "SCAN BEFORE STARTING WORK" now lands here:
// public, no login, one verdict — is every sheet in this printed pack still
// the current revision? Green = work. Red = at least one sheet changed since
// printing; the list shows exactly which ones.

import React, { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { CheckCircle2, XCircle, Loader2, ShieldQuestion, RefreshCw } from "lucide-react";

interface SheetRow {
  label: string;
  printedRev: string | null;
  currentRev: string | null;
  fresh: boolean;
  retired: boolean;
}

interface VerifyPackageResult {
  name: string;
  packageStatus: string | null;
  closed: boolean;
  printedAt?: string | null;
  snapshotMissing?: boolean;
  sheetCount: number;
  staleCount: number;
  allFresh: boolean;
  sheets: SheetRow[];
  checkedAt: string;
}

export default function VerifyPackagePage() {
  const params = useParams<{ packageId: string }>();
  const search = useSearchParams();
  const printId = search.get("print");
  const [result, setResult] = useState<VerifyPackageResult | null>(null);
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
      const res = await fetch(`/api/verify-package?${qs.toString()}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || "Could not verify this code");
      }
      setResult((await res.json()) as VerifyPackageResult);
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [params.packageId, printId]);

  useEffect(() => { void check(); }, [check]);

  return (
    <div className={`min-h-dvh flex flex-col items-center justify-center p-6 transition-colors duration-500 ${
      loading || error ? "bg-slate-900" : result?.allFresh ? "bg-emerald-600" : "bg-red-600"
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
        ) : result && (
          <>
            {result.snapshotMissing ? (
              <ShieldQuestion className="w-24 h-24 mx-auto text-white mb-4 animate-in zoom-in duration-300" strokeWidth={2.5} />
            ) : result.allFresh ? (
              <CheckCircle2 className="w-24 h-24 mx-auto text-white mb-4 animate-in zoom-in duration-300" strokeWidth={2.5} />
            ) : (
              <XCircle className="w-24 h-24 mx-auto text-white mb-4 animate-in zoom-in duration-300" strokeWidth={2.5} />
            )}
            <h1 className="text-3xl font-black text-white leading-tight mb-1">
              {result.snapshotMissing ? "CAN'T VERIFY THIS PACK" : result.allFresh ? "PACK IS CURRENT" : "PACK IS STALE"}
            </h1>
            <p className="text-white/90 text-sm font-bold mb-6">
              {result.snapshotMissing
                ? "The print record for this pack could not be found — do not assume it is current. Contact Document Control."
                : result.allFresh
                ? "Every sheet in this pack is still the current revision."
                : `${result.staleCount} of ${result.sheetCount} sheet${result.sheetCount === 1 ? "" : "s"} changed since this pack was printed — get the new sheets before starting work.`}
              {result.printedAt ? ` Printed ${new Date(result.printedAt).toLocaleDateString()}.` : ""}
              {result.closed ? " (This package has been closed.)" : ""}
            </p>

            <div className="bg-white/95 rounded-2xl shadow-2xl p-5 text-left space-y-3">
              <div>
                <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Work package</div>
                <div className="text-sm font-bold text-slate-900">{result.name}</div>
              </div>
              <div className="pt-2 border-t border-slate-100 max-h-72 overflow-y-auto space-y-1.5">
                {result.sheets.map((s, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate text-slate-700">{s.label}</span>
                    <span className={`shrink-0 font-black ${s.fresh ? "text-emerald-600" : "text-red-600"}`}>
                      {s.retired
                        ? "RETIRED"
                        : s.fresh
                          ? `Rev ${s.printedRev ?? "?"} ✓`
                          : `Rev ${s.printedRev ?? "?"} → ${s.currentRev ?? "?"}`}
                    </span>
                  </div>
                ))}
                {result.sheets.length === 0 && (
                  <div className="text-xs text-slate-500">This package has no sheets.</div>
                )}
              </div>
              {!result.allFresh && (
                <div className="pt-2 border-t border-slate-100 text-xs text-slate-600 leading-relaxed">
                  Do not work from the outdated sheets. Ask the package owner or Document Control
                  for a re-printed pack — the stale sheets are marked above.
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
