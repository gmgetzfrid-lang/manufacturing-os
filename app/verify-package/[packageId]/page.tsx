"use client";

// /verify-package/[packageId] — the page behind the QR on a printed
// work-package cover sheet. "SCAN BEFORE STARTING WORK" now lands here:
// public, no login, one verdict — is every sheet in this printed pack still
// the current revision? Green = work. Red = at least one sheet changed since
// printing; the list shows exactly which ones.

import { friendlyError } from "@/lib/friendlyError";
import React, { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, XCircle, Loader2, ShieldQuestion, RefreshCw } from "lucide-react";
import { PublicSignature } from "@/components/marketing/PublicChrome";

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
  sheetCount: number;
  staleCount: number;
  allFresh: boolean;
  sheets: SheetRow[];
  checkedAt: string;
}

export default function VerifyPackagePage() {
  const params = useParams<{ packageId: string }>();
  const [result, setResult] = useState<VerifyPackageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const check = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/verify-package?p=${encodeURIComponent(params.packageId)}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || "Could not verify this code");
      }
      setResult((await res.json()) as VerifyPackageResult);
    } catch (e) {
      setError(friendlyError(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [params.packageId]);

  useEffect(() => { void check(); }, [check]);

  return (
    <div className={`min-h-dvh flex flex-col items-center justify-center p-6 transition-colors duration-500 ${
      loading || error ? "bg-[var(--color-ink)]" : result?.allFresh ? "bg-[color-mix(in_srgb,var(--state-released)_78%,black)]" : "bg-[color-mix(in_srgb,var(--state-overdue)_78%,black)]"
    }`}>
      <div className="w-full max-w-sm text-center py-8">
        {loading ? (
          <div className="text-[var(--color-ink-fg)]/90">
            <Loader2 className="w-14 h-14 mx-auto animate-spin mb-4" />
            <div className="text-body font-medium ">Checking pack…</div>
          </div>
        ) : error ? (
          <div className="text-[var(--color-ink-fg)]/90">
            <ShieldQuestion className="w-16 h-16 mx-auto mb-4 opacity-80" />
            <h1 className="text-[34px] leading-[1.05] tracking-[-0.02em] font-bold mb-3">Can&apos;t verify this code</h1>
            <p className="text-reading opacity-90">{error}</p>
            <p className="text-body opacity-70 mt-4">
              If this QR came from a printed pack, contact Document Control before working from it.
            </p>
            <button
              onClick={() => void check()}
              className="mt-6 inline-flex items-center gap-2 h-11 px-4 rounded-lg bg-[var(--color-ink-fg)]/15 hover:bg-[var(--color-ink-fg)]/25 text-reading font-medium"
            >
              <RefreshCw className="w-4 h-4" /> Try again
            </button>
          </div>
        ) : result && (
          <>
            {result.allFresh ? (
              <CheckCircle2 className="w-24 h-24 mx-auto text-[var(--color-ink-fg)] mb-4 animate-in zoom-in duration-300" strokeWidth={2.5} />
            ) : (
              <XCircle className="w-24 h-24 mx-auto text-[var(--color-ink-fg)] mb-4 animate-in zoom-in duration-300" strokeWidth={2.5} />
            )}
            <h1 className="text-[40px] font-bold text-[var(--color-ink-fg)] leading-[1.03] tracking-[-0.03em] mb-3">
              {result.allFresh ? "Pack is current" : "Pack is out of date"}
            </h1>
            <p className="text-[var(--color-ink-fg)]/90 text-reading font-medium mb-6">
              {result.allFresh
                ? "Every sheet in this pack is still the current revision."
                : `${result.staleCount} of ${result.sheetCount} sheet${result.sheetCount === 1 ? "" : "s"} changed since this pack was printed. Get the new sheets before starting work.`}
              {result.closed ? " (This package has been closed.)" : ""}
            </p>

            <div className="bg-[var(--color-surface)] rounded-xl ui-float p-5 text-left space-y-3">
              <div>
                <div className="text-body font-medium text-[var(--color-text-muted)]">Work package</div>
                <div className="text-reading font-medium text-[var(--color-text)]">{result.name}</div>
              </div>
              <div className="pt-2 border-t border-[var(--color-border)] max-h-72 overflow-y-auto space-y-1.5">
                {result.sheets.map((s, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 text-caption">
                    <span className="truncate text-[var(--color-text)]">{s.label}</span>
                    <span className={`shrink-0 font-medium ${s.fresh ? "text-[var(--state-released-text)]" : "text-[var(--state-overdue-text)]"}`}>
                      {s.retired
                        ? "Retired"
                        : s.fresh
                          ? `Rev ${s.printedRev ?? "?"} ✓`
                          : `Rev ${s.printedRev ?? "?"} → ${s.currentRev ?? "?"}`}
                    </span>
                  </div>
                ))}
                {result.sheets.length === 0 && (
                  <div className="text-body text-[var(--color-text-muted)]">This package has no sheets.</div>
                )}
              </div>
              {!result.allFresh && (
                <div className="pt-2 border-t border-[var(--color-border)] text-body text-[var(--color-text)] leading-relaxed">
                  Do not work from the outdated sheets. Ask the package owner or Document Control
                  for a re-printed pack. The out-of-date sheets are marked above.
                </div>
              )}
            </div>

            <div className="mt-5 text-caption text-[var(--color-ink-fg)]/90">
              Checked {new Date(result.checkedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} by document control.
            </div>
            <button
              onClick={() => void check()}
              className="mt-3 inline-flex items-center gap-1.5 h-11 px-4 rounded-lg bg-[var(--color-ink-fg)]/15 hover:bg-[var(--color-ink-fg)]/25 text-[var(--color-ink-fg)] text-reading font-medium"
            >
              <RefreshCw className="w-4 h-4" /> Check again
            </button>
          </>
        )}
      </div>
      <PublicSignature />
    </div>
  );
}
