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
import { CheckCircle2, XCircle, Loader2, ShieldQuestion, OctagonAlert, RefreshCw } from "lucide-react";

type Verdict =
  | "current" | "not_yet_effective" | "held"
  | "superseded" | "void" | "archived" | "draft" | "superseded_version";

interface VerifyResult {
  docNumber: string | null;
  title: string | null;
  printedRev: string | null;
  printedAt: string | null;
  currentRev: string | null;
  currentIssuedAt: string | null;
  effectiveDate: string | null;
  notYetEffective: boolean;
  onHold?: boolean;
  docStatus: string | null;
  verdict?: Verdict;
  isCurrent: boolean;
  checkedAt: string;
}

/** Map the verdict to its full-screen presentation. Falls back to the legacy
 *  isCurrent/notYetEffective booleans if an older API build omits `verdict`. */
function present(r: VerifyResult): {
  bg: string; icon: "ok" | "stop" | "x" | "q"; headline: string; blurb: string; ok: boolean;
} {
  const v: Verdict =
    r.verdict ?? (r.notYetEffective ? "not_yet_effective" : r.isCurrent ? "current" : "superseded_version");
  const currentRev = r.currentRev ?? "?";
  const printedRev = r.printedRev ?? "?";
  switch (v) {
    case "current":
      return { bg: "bg-emerald-600", icon: "ok", ok: true, headline: "CURRENT",
        blurb: "This print matches the current revision." };
    case "not_yet_effective":
      return { bg: "bg-amber-500", icon: "q", ok: false, headline: "NOT YET IN EFFECT",
        blurb: `This is the latest revision, but it comes into force ${r.effectiveDate ? new Date(r.effectiveDate).toLocaleDateString() : "later"} — until then, keep working to the prior in-force revision.` };
    case "held":
      return { bg: "bg-red-700", icon: "stop", ok: false, headline: "ON HOLD — STOP WORK",
        blurb: "This document is under an active hold. Do not perform any work from it. Contact Document Control." };
    case "void":
      return { bg: "bg-red-600", icon: "x", ok: false, headline: "VOID — DO NOT USE",
        blurb: "This document has been voided. It is not a valid drawing. Destroy this print." };
    case "archived":
      return { bg: "bg-red-600", icon: "x", ok: false, headline: "ARCHIVED — DO NOT USE",
        blurb: "This document has been archived and is no longer maintained." };
    case "superseded":
      return { bg: "bg-red-600", icon: "x", ok: false, headline: "SUPERSEDED — DO NOT USE",
        blurb: "This document has been superseded. Get the current revision from Document Control." };
    case "draft":
      return { bg: "bg-red-600", icon: "x", ok: false, headline: "DRAFT — NOT ISSUED",
        blurb: "This is an unissued draft, not a controlled revision. Do not use for construction." };
    case "superseded_version":
    default:
      return { bg: "bg-red-600", icon: "x", ok: false, headline: "DO NOT USE",
        blurb: `This print is Rev ${printedRev} — the current revision is Rev ${currentRev}.` };
  }
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
    iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";

  const view = result ? present(result) : null;

  return (
    <div className={`min-h-dvh flex flex-col items-center justify-center p-6 transition-colors duration-500 ${
      loading || error ? "bg-slate-900" : view ? view.bg : "bg-slate-900"
    }`}>
      <div className="w-full max-w-sm text-center">
        {loading ? (
          <div className="text-white/90">
            <Loader2 className="w-14 h-14 mx-auto animate-spin mb-4" />
            <div className="text-sm font-bold tracking-widest uppercase">Checking revision…</div>
          </div>
        ) : error ? (
          <div className="text-white/90">
            <ShieldQuestion className="w-16 h-16 mx-auto mb-4 opacity-80" />
            <h1 className="text-2xl font-black mb-2">Can&apos;t verify this code</h1>
            <p className="text-sm opacity-80">{error}</p>
            <p className="text-xs opacity-60 mt-4">
              If this QR came from a printed drawing, contact Document Control before using the print.
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
            {/* THE VERDICT — readable at arm's length in a plant. */}
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
            </p>

            {/* The facts card */}
            <div className="bg-white/95 rounded-2xl shadow-2xl p-5 text-left space-y-3">
              <div>
                <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Document</div>
                <div className="text-sm font-bold text-slate-900">{result.docNumber ?? "—"}</div>
                {result.title && <div className="text-xs text-slate-500 mt-0.5">{result.title}</div>}
              </div>
              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-100">
                <div>
                  <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">This print</div>
                  <div className={`text-lg font-black ${view.ok ? "text-emerald-600" : "text-red-600"}`}>
                    Rev {result.printedRev ?? "?"}
                  </div>
                  <div className="text-[10px] text-slate-400">issued {fmt(result.printedAt)}</div>
                </div>
                <div>
                  <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Current</div>
                  <div className="text-lg font-black text-slate-900">Rev {result.currentRev ?? "?"}</div>
                  <div className="text-[10px] text-slate-400">issued {fmt(result.currentIssuedAt)}</div>
                </div>
              </div>
              {!view.ok && (
                <div className="pt-2 border-t border-slate-100 text-xs text-slate-600 leading-relaxed">
                  Get the current revision from Document Control before performing any work
                  from this drawing. Mark this print &ldquo;SUPERSEDED&rdquo; or destroy it.
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
