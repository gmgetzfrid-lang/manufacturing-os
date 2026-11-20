"use client";

// /verify/[docId]?v=[versionId] — the page behind the QR code stamped on
// every uncontrolled copy. A contractor scans a paper print in the field
// and gets ONE unmissable answer: is this paper still current?
//
// Design rules: mobile-first (it's a phone screen at arm's length in a
// plant), zero login, one giant verdict, details second. Green means work,
// red means stop and get the current revision.

import React, { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { CheckCircle2, XCircle, Loader2, ShieldQuestion, RefreshCw } from "lucide-react";

interface VerifyResult {
  docNumber: string | null;
  title: string | null;
  printedRev: string | null;
  printedAt: string | null;
  currentRev: string | null;
  currentIssuedAt: string | null;
  effectiveDate: string | null;
  notYetEffective: boolean;
  docStatus: string | null;
  isCurrent: boolean;
  checkedAt: string;
}

export default function VerifyPage() {
  const params = useParams<{ docId: string }>();
  const search = useSearchParams();
  const versionId = search.get("v");

  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const check = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ doc: params.docId });
      if (versionId) qs.set("v", versionId);
      const res = await fetch(`/api/verify?${qs.toString()}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || "Could not verify this code");
      }
      setResult((await res.json()) as VerifyResult);
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [params.docId, versionId]);

  useEffect(() => { void check(); }, [check]);

  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "-";

  return (
    <div className={`min-h-dvh flex flex-col items-center justify-center p-6 transition-colors duration-500 ${
      loading || error ? "bg-[var(--color-ink)]" : result?.notYetEffective ? "bg-amber-500" : result?.isCurrent ? "bg-emerald-600" : "bg-red-600"
    }`}>
      <div className="w-full max-w-sm text-center">
        {loading ? (
          <div className="text-white/90">
            <Loader2 className="w-14 h-14 mx-auto animate-spin mb-4" />
            <div className="text-[13px] font-semibold ">Checking revision…</div>
          </div>
        ) : error ? (
          <div className="text-white/90">
            <ShieldQuestion className="w-16 h-16 mx-auto mb-4 opacity-80" />
            <h1 className="text-[34px] leading-[1.05] tracking-[-0.02em] font-black mb-3">Can&apos;t verify this code</h1>
            <p className="text-[14px] opacity-80">{error}</p>
            <p className="text-[13px] opacity-70 mt-4">
              If this QR came from a printed drawing, contact Document Control before using the print.
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
            {/* THE VERDICT — readable at arm's length in a plant. */}
            {result.notYetEffective ? (
              <ShieldQuestion className="w-24 h-24 mx-auto text-white mb-4 animate-in zoom-in duration-300" strokeWidth={2.5} />
            ) : result.isCurrent ? (
              <CheckCircle2 className="w-24 h-24 mx-auto text-white mb-4 animate-in zoom-in duration-300" strokeWidth={2.5} />
            ) : (
              <XCircle className="w-24 h-24 mx-auto text-white mb-4 animate-in zoom-in duration-300" strokeWidth={2.5} />
            )}
            <h1 className="text-[40px] font-black text-white leading-[1.03] tracking-[-0.03em] mb-3">
              {result.notYetEffective ? "NOT YET IN EFFECT" : result.isCurrent ? "CURRENT" : "DO NOT USE"}
            </h1>
            <p className="text-white/90 text-[15px] font-semibold mb-6">
              {result.notYetEffective
                ? `This is the latest revision, but it comes into force ${result.effectiveDate ? new Date(result.effectiveDate).toLocaleDateString() : "later"} - until then, keep working to the prior in-force revision.`
                : result.isCurrent
                ? "This print matches the current revision."
                : result.docStatus === "Superseded" || result.docStatus === "Archived"
                  ? `This document has been ${result.docStatus?.toLowerCase()}.`
                  : `This print is Rev ${result.printedRev ?? "?"} - the current revision is Rev ${result.currentRev ?? "?"}.`}
            </p>

            {/* The facts card */}
            <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl p-5 text-left space-y-3">
              <div>
                <div className="text-[13px] font-semibold text-[var(--color-text-muted)]">Document</div>
                <div className="text-[15px] font-bold text-[var(--color-text)]">{result.docNumber ?? "-"}</div>
                {result.title && <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5">{result.title}</div>}
              </div>
              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-[var(--color-border)]">
                <div>
                  <div className="text-[13px] font-semibold text-[var(--color-text-muted)]">This print</div>
                  <div className={`text-[15px] font-black ${result.isCurrent ? "text-emerald-600" : "text-red-600"}`}>
                    Rev {result.printedRev ?? "?"}
                  </div>
                  <div className="text-[12px] text-[var(--color-text-muted)]">issued {fmt(result.printedAt)}</div>
                </div>
                <div>
                  <div className="text-[13px] font-semibold text-[var(--color-text-muted)]">Current</div>
                  <div className="text-[15px] font-black text-[var(--color-text)]">Rev {result.currentRev ?? "?"}</div>
                  <div className="text-[12px] text-[var(--color-text-muted)]">issued {fmt(result.currentIssuedAt)}</div>
                </div>
              </div>
              {!result.isCurrent && (
                <div className="pt-2 border-t border-[var(--color-border)] text-[13px] text-[var(--color-text)] leading-relaxed">
                  Get the current revision from Document Control before performing any work
                  from this drawing. Mark this print &ldquo;SUPERSEDED&rdquo; or destroy it.
                </div>
              )}
            </div>

            <div className="mt-5 text-[12px] text-white/70">
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
