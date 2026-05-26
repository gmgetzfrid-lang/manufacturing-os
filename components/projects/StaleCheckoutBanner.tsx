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
import { supabase } from "@/lib/supabase";
import type { CheckoutSession } from "@/types/schema";

interface StaleCheckoutBannerProps {
  userId?: string;
}

type StaleRow = CheckoutSession & {
  docNumber?: string;
  docTitle?: string;
};

export default function StaleCheckoutBanner({ userId }: StaleCheckoutBannerProps) {
  const [rows, setRows] = useState<StaleRow[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [releasingId, setReleasingId] = useState<string | null>(null);

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
    setReleasingId(row.id);
    try {
      const now = new Date().toISOString();
      await supabase.from("checkout_sessions").update({
        status: "checked_in",
        ended_at: now,
        released_at: now,
        released_by: userId,
        released_reason: "User released from stale-checkout banner",
      }).eq("id", row.id);
      // Clear the documents-table pointer if this user holds the lock
      await supabase.from("documents").update({
        checked_out_by: null,
        checked_out_by_name: null,
        checked_out_at: null,
        checkout_note: null,
        current_lock_id: null,
      }).eq("id", row.documentId).eq("checked_out_by", userId);
      await refresh();
    } catch (e) {
      console.error("Failed to release stale checkout", e);
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
        <button onClick={() => setDismissed(true)} className="p-1 rounded-md text-amber-600 hover:text-amber-900 hover:bg-amber-100" title="Dismiss for this session">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="divide-y divide-amber-100">
        {rows.map((r) => (
          <div key={r.id} className="px-4 py-2.5 flex items-center gap-3">
            <FileText className="w-3.5 h-3.5 text-amber-600 shrink-0" />
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
              className="text-[10px] font-bold text-amber-900 underline hover:text-amber-700"
            >
              Open
            </Link>
            <button
              onClick={() => void release(r)}
              disabled={releasingId === r.id}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-700 hover:bg-amber-800 text-white text-[10px] font-bold disabled:opacity-50"
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

function formatRelative(ts: any): string {
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
