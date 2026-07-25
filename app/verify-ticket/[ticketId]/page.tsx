"use client";

// /verify-ticket/[ticketId]?r=[rev] — the page behind the QR stamped on
// drafting-portal deliverables. The scenario it exists for: a PM hands a
// deliverable to a contractor, a revision later happens on the ticket, and
// nobody forwards the new file. The contractor scans the paper and finds
// out in one glance.
//
// Same design rules as /verify: mobile-first, zero login, one giant
// verdict, details second. Green = latest issue. Amber = heads-up (a
// revision is being worked right now, or this paper was a review draft).
// Red = a newer revision has been issued — stop.

import React, { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { CheckCircle2, XCircle, AlertTriangle, Loader2, ShieldQuestion, RefreshCw } from "lucide-react";

interface VerifyTicketResult {
  ticketNumber: string | null;
  title: string | null;
  unit: string | null;
  printedRev: string | null;
  currentRev: string | null;
  latestIssuedRev: string | null;
  inReview: boolean;
  ticketStatus: string | null;
  lastActivityAt: string | null;
  verdict: "current" | "revision_in_progress" | "superseded" | "draft_copy" | "unknown";
  checkedAt: string;
}

const VERDICT_UI: Record<VerifyTicketResult["verdict"], {
  bg: string; headline: string; sub: (r: VerifyTicketResult) => string; icon: "check" | "warn" | "stop";
}> = {
  current: {
    bg: "bg-emerald-600", icon: "check", headline: "LATEST ISSUE",
    sub: () => "This copy is the latest issued revision of this deliverable.",
  },
  revision_in_progress: {
    bg: "bg-amber-500", icon: "warn", headline: "REVISION UNDERWAY",
    sub: (r) => `This copy (Rev ${r.printedRev}) is the latest issue, but Rev ${r.currentRev} is in drafting/review right now. Confirm with the requester before starting new work.`,
  },
  superseded: {
    bg: "bg-red-600", icon: "stop", headline: "DO NOT USE",
    sub: (r) => `This copy is Rev ${r.printedRev} — Rev ${r.latestIssuedRev} has since been issued. Get the current deliverable before use.`,
  },
  draft_copy: {
    bg: "bg-amber-500", icon: "warn", headline: "REVIEW DRAFT",
    sub: (r) => {
      const sameCycle = r.printedRev && r.latestIssuedRev && parseInt(r.printedRev, 10) === parseInt(r.latestIssuedRev, 10);
      return sameCycle
        ? `Rev ${r.printedRev} was a review draft — Rev ${r.latestIssuedRev} has since been ISSUED from it. Use the issued copy, not this draft.`
        : `Rev ${r.printedRev ?? "?"} is a review draft, not an issued deliverable. Only issued revisions (Rev ${r.latestIssuedRev ?? "1"}, without a letter) are approved for use.`;
    },
  },
  unknown: {
    bg: "bg-slate-700", icon: "warn", headline: "CANNOT CONFIRM",
    sub: () => "This ticket has no revision record for this copy. Confirm with the requester before use.",
  },
};

export default function VerifyTicketPage() {
  const params = useParams<{ ticketId: string }>();
  const search = useSearchParams();
  const rev = search.get("r");

  const [result, setResult] = useState<VerifyTicketResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const check = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ t: params.ticketId });
      if (rev) qs.set("r", rev);
      const res = await fetch(`/api/verify-ticket?${qs.toString()}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || "Could not verify this code");
      }
      setResult((await res.json()) as VerifyTicketResult);
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [params.ticketId, rev]);

  useEffect(() => { void check(); }, [check]);

  const ui = result ? VERDICT_UI[result.verdict] : null;
  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";

  return (
    <div className={`min-h-screen flex flex-col items-center justify-center p-6 transition-colors duration-500 ${
      loading || error || !ui ? "bg-slate-900" : ui.bg
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
              If this QR came from an issued deliverable, contact the requester before using the copy.
            </p>
            <button
              onClick={() => void check()}
              className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/15 hover:bg-white/25 text-sm font-bold"
            >
              <RefreshCw className="w-4 h-4" /> Try again
            </button>
          </div>
        ) : result && ui && (
          <>
            {/* THE VERDICT — readable at arm's length in a plant. */}
            {ui.icon === "check" ? (
              <CheckCircle2 className="w-24 h-24 mx-auto text-white mb-4 animate-in zoom-in duration-300" strokeWidth={2.5} />
            ) : ui.icon === "stop" ? (
              <XCircle className="w-24 h-24 mx-auto text-white mb-4 animate-in zoom-in duration-300" strokeWidth={2.5} />
            ) : (
              <AlertTriangle className="w-24 h-24 mx-auto text-white mb-4 animate-in zoom-in duration-300" strokeWidth={2.5} />
            )}
            <h1 className="text-3xl font-black text-white leading-tight mb-1">{ui.headline}</h1>
            <p className="text-white/90 text-sm font-bold mb-6">{ui.sub(result)}</p>

            {/* The facts card */}
            <div className="bg-white/95 rounded-2xl shadow-2xl p-5 text-left space-y-3">
              <div>
                <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Drafting ticket</div>
                <div className="text-sm font-bold text-slate-900">{result.ticketNumber ?? "—"}</div>
                {result.title && <div className="text-xs text-slate-500 mt-0.5">{result.title}</div>}
                {result.unit && <div className="text-[10px] text-slate-400 mt-0.5">Unit {result.unit}</div>}
              </div>
              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-100">
                <div>
                  <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">This copy</div>
                  <div className={`text-lg font-black ${result.verdict === "current" ? "text-emerald-600" : result.verdict === "superseded" ? "text-red-600" : "text-amber-600"}`}>
                    Rev {result.printedRev ?? "?"}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                    {result.inReview ? "In review now" : "Latest issue"}
                  </div>
                  <div className="text-lg font-black text-slate-900">Rev {result.currentRev ?? "?"}</div>
                  <div className="text-[10px] text-slate-400">activity {fmt(result.lastActivityAt)}</div>
                </div>
              </div>
              {result.verdict !== "current" && (
                <div className="pt-2 border-t border-slate-100 text-xs text-slate-600 leading-relaxed">
                  {result.verdict === "superseded"
                    ? "Get the current issued deliverable from the ticket requester before performing any work from this copy. Mark it “SUPERSEDED” or destroy it."
                    : "Check with the ticket requester or project manager before relying on this copy."}
                </div>
              )}
            </div>

            <div className="mt-5 text-[10px] text-white/60">
              Checked {new Date(result.checkedAt).toLocaleString()} · Refinery OS drafting portal
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
