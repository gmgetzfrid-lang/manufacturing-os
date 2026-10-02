"use client";

// StaleCheckoutBanner — pinned warning at the top of /projects + /checkouts
// when the current user has checkouts that have passed their expected
// release date (or, for ad-hoc, their 24h cap).
//
// Each row gets a one-click Release button so users can clean up without
// digging into individual docs.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlarmClock, Loader2, X, FileText } from "lucide-react";
import { listStaleCheckoutsForUser } from "@/lib/projects";
import { finishMySession } from "@/lib/checkoutEpisodes";
import { logCheckoutEvent } from "@/lib/audit";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { userFacingCaughtError } from "@/lib/userFacingError";
import type { CheckoutSession } from "@/types/schema";

interface StaleCheckoutBannerProps {
  userId?: string;
}

type StaleRow = CheckoutSession & {
  docNumber?: string;
  docTitle?: string;
};

const DISMISS_KEY = "mfg-os.staleCheckouts.dismissedUntil";

export default function StaleCheckoutBanner({ userId }: StaleCheckoutBannerProps) {
  // DCK-9: the release goes through the same check-in as every other
  // surface, so the register and the audit row need the actor's name/role.
  const { userEmail, activeRole } = useRole();
  const [rows, setRows] = useState<StaleRow[]>([]);
  // Dismiss persists for the day (localStorage) — component-local state made
  // the banner reappear on every navigation, which teaches people to ignore it.
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try { setDismissed(Number(localStorage.getItem(DISMISS_KEY) ?? 0) > Date.now()); } catch { /* noop */ }
  }, []);
  const dismissForToday = () => {
    setDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, String(Date.now() + 20 * 3600_000)); } catch { /* noop */ }
  };
  const [releasingId, setReleasingId] = useState<string | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      const stale = await listStaleCheckoutsForUser(userId);
      if (stale.length === 0) { setRows([]); return; }
      // Hydrate doc titles for friendly display
      const docIds = Array.from(new Set(stale.map((s) => s.documentId)));
      const { data } = await supabase
        .from("documents")
        .select("id, document_number, title, name")
        .in("id", docIds);
      const map = new Map<string, { docNumber?: string; docTitle?: string }>();
      (data as Array<{ id: string; document_number?: string; title?: string; name?: string }> || [])
        .forEach((d) => map.set(d.id, { docNumber: d.document_number, docTitle: d.title || d.name }));
      setRows(stale.map((s) => ({
        ...s,
        docNumber: map.get(s.documentId)?.docNumber,
        docTitle: map.get(s.documentId)?.docTitle,
      })));
    } catch (e) {
      console.error("StaleCheckoutBanner refresh failed", e);
    }
  }, [userId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const release = async (row: StaleRow) => {
    if (!row.id || !userId) return;
    setReleasingId(row.id); setReleaseError(null);
    try {
      if (!row.orgId) throw new Error("This checkout has no workspace on record.");
      const userName = userEmail?.split("@")[0] || "User";
      // DCK-9: a release from the banner is a CHECK-IN like any other — it
      // goes through finishMySession (ends my session rows on the document,
      // settles the lock/episode: clear, transfer, or rebuild) with an
      // explicit register outcome, and writes the CHECK_IN audit row every
      // renderer already understands. The old direct UPDATE left the
      // register line blank and wrote CHECKOUT_RELEASED, which nothing
      // counted as a lock event.
      await finishMySession({
        orgId: row.orgId,
        documentId: row.documentId,
        userId,
        userName,
        episodeId: row.episodeId ?? null,
        sessionStatus: "checked_in",
        releasedReason: "Released from the stale-checkout banner (no changes)",
        outcome: { outcome: "all_clear", note: null, ref: null },
      });
      await logCheckoutEvent({
        orgId: row.orgId,
        fileId: row.documentId,
        userId,
        userEmail: userEmail || "unknown",
        userRole: activeRole || "unknown",
        type: "CHECK_IN",
        details: { via: "stale_checkout_banner", outcome: "all_clear", sessionId: row.id, docNumber: row.docNumber ?? null },
      });
      await refresh();
    } catch (e) {
      // REL-3: lib/checkoutEpisodes (Document Control's) hands back the
      // driver's text; the Projects screen translates it here.
      setReleaseError(`Couldn't release ${row.docNumber || "the checkout"}: ${userFacingCaughtError(e, { context: "StaleCheckoutBanner release" })}`);
    } finally { setReleasingId(null); }
  };

  if (dismissed || rows.length === 0) return null;

  return (
    <div className="mb-4 bg-amber-50 border border-amber-200 rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-amber-200 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-amber-800">
          <AlarmClock className="w-4 h-4" />
          <span className="text-sm font-bold">
            You have {rows.length} stale checkout{rows.length === 1 ? "" : "s"} past the expected release date
          </span>
        </div>
        <button onClick={dismissForToday} className="p-1 rounded-md text-amber-600 dark:text-amber-400 hover:text-amber-900 dark:hover:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-500/15 transition-colors" title="Dismiss for today">
          <X className="w-4 h-4" />
        </button>
      </div>
      {releaseError && (
        <div role="alert" className="px-4 py-2 text-[11px] font-bold text-rose-700 dark:text-rose-300 bg-rose-500/[0.08] border-b border-rose-500/50">{releaseError}</div>
      )}
      <div className="divide-y divide-amber-100">
        {rows.map((r) => (
          <div key={r.id} className="px-4 py-2.5 flex items-center gap-3">
            <FileText className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-bold text-amber-900 truncate">
                <span className="font-mono">{r.docNumber || "—"}</span>
                {r.docTitle && <span className="ml-2 text-amber-800 font-medium">{r.docTitle}</span>}
              </div>
              <div className="text-[10px] text-amber-700">
                Started {formatRelative(r.startedAt)} · expected release {formatRelative(r.expectedReleaseAt)}
              </div>
            </div>
            <Link
              href={r.libraryId ? `/documents/${r.libraryId}?doc=${r.documentId}` : "#"}
              className="text-[10px] font-bold text-amber-900 underline hover:text-amber-700 transition-colors"
            >
              Open
            </Link>
            <button
              onClick={() => void release(r)}
              disabled={releasingId === r.id}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-700 hover:bg-amber-800 text-white text-[10px] font-bold disabled:opacity-50 transition-colors"
            >
              {releasingId === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              Release
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatRelative(ts: unknown): string {
  if (!ts) return "—";
  try {
    const d = new Date(ts as string);
    const diff = d.getTime() - Date.now();
    const future = diff > 0;
    const abs = Math.abs(diff);
    const min = Math.floor(abs / 60000);
    if (min < 1) return future ? "any moment" : "just now";
    if (min < 60) return future ? `in ${min}m` : `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return future ? `in ${hr}h` : `${hr}h ago`;
    const days = Math.floor(hr / 24);
    return future ? `in ${days}d` : `${days}d ago`;
  } catch { return "—"; }
}
