"use client";

// StaleCheckoutBanner — pinned warning at the top of /projects + /checkouts
// when the current user has checkouts that have passed their expected
// release date (or, for ad-hoc, their 24h cap).
//
// Each row gets a one-click Release button so users can clean up without
// digging into individual docs.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, X } from "lucide-react";
import { listStaleCheckoutsForUser } from "@/lib/projects";
import { reconcileDocumentCheckoutState } from "@/lib/checkoutEpisodes";
import { supabase } from "@/lib/supabase";
import type { CheckoutSession } from "@/types/schema";
import { sayError } from "@/components/projects/sayError";

interface StaleCheckoutBannerProps {
  userId?: string;
}

type StaleRow = CheckoutSession & {
  docNumber?: string;
  docTitle?: string;
};

const DISMISS_KEY = "mfg-os.staleCheckouts.dismissedUntil";

export default function StaleCheckoutBanner({ userId }: StaleCheckoutBannerProps) {
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
      const now = new Date().toISOString();
      const { error } = await supabase.from("checkout_sessions").update({
        status: "checked_in",
        ended_at: now,
        released_at: now,
        released_by: userId,
        released_reason: "User released from stale-checkout banner",
      }).eq("id", row.id);
      if (error) throw error;
      await supabase.from("audit_logs").insert({
        action: "CHECKOUT_RELEASED",
        resource_type: "document", resource_id: row.documentId,
        org_id: row.orgId, user_id: userId, user_email: null,
        details: { via: "stale_checkout_banner", sessionId: row.id, docNumber: row.docNumber ?? null },
      }).then(() => undefined, () => undefined);
      // Settle the document from its remaining active sessions: clears the
      // lock + closes the episode if I was the last one out, transfers the
      // lock if collaborators remain, rebuilds the collaborator list.
      await reconcileDocumentCheckoutState(row.documentId, {
        orgId: row.orgId,
        actorUserId: userId,
        closeReason: "checked_in",
      });
      await refresh();
    } catch (e) {
      setReleaseError(`Couldn't release ${row.docNumber || "the checkout"}: ${sayError(e)}`);
    } finally { setReleasingId(null); }
  };

  if (dismissed || rows.length === 0) return null;

  // A quiet row in the page, marked at its edge in the waiting colour: what
  // it is on one line, then each checkout with Open and Release.
  const n = rows.length;
  return (
    <section aria-label="Checkouts held too long" className="relative rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-held)]" />
      <div className="flex items-center gap-3 pl-4 sm:pl-5 pr-2 py-2.5">
        <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-body font-medium bg-[color-mix(in_srgb,var(--state-held)_14%,transparent)] text-[var(--state-held-text)]">
          Held too long
        </span>
        <p className="min-w-0 flex-1 text-reading text-[var(--color-text)]">
          {n === 1 ? "1 of your checkouts is" : `${n} of your checkouts are`} past the release date
        </p>
        <button onClick={dismissForToday} aria-label="Hide for today" title="Hide for today"
          className="ui-hit shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>
      {releaseError && (
        <p role="alert" className="pl-4 sm:pl-5 pr-4 pb-2 text-body font-medium text-[var(--state-overdue-text)]">{releaseError}</p>
      )}
      <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
        {rows.map((r) => (
          <li key={r.id} className="pl-4 sm:pl-5 pr-3 py-2.5 flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-1.5">
            <div className="min-w-0 flex-1 basis-full sm:basis-auto">
              <div className="text-reading text-[var(--color-text)] truncate">
                <span className="font-display font-semibold tabular-nums">{r.docNumber || "-"}</span>
                {r.docTitle && r.docTitle !== r.docNumber && <span className="ml-2 text-[var(--color-text-muted)]">{r.docTitle}</span>}
              </div>
            </div>
            <div className="shrink-0 text-body text-[var(--color-text-muted)] whitespace-nowrap">
              Checked out {formatRelative(r.startedAt)}
            </div>
            <div className="shrink-0 text-body font-medium text-[var(--state-held-text)] whitespace-nowrap">
              Was due {formatRelative(dueOf(r))}
            </div>
            <div className="ml-auto shrink-0 flex items-center gap-2">
              {r.libraryId && (
                <Link href={`/documents/${r.libraryId}?doc=${r.documentId}`} className="text-body text-[var(--color-accent-text)] hover:underline">
                  Open
                </Link>
              )}
              <button
                onClick={() => void release(r)}
                disabled={releasingId === r.id}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] text-body font-medium hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors"
              >
                {releasingId === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                Release
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The release date it's past: the expected one, else the ad-hoc cap. */
function dueOf(r: StaleRow): unknown {
  const past = (t: unknown) => !!t && Date.parse(String(t)) < Date.now();
  return past(r.expectedReleaseAt) ? r.expectedReleaseAt : past(r.autoExpiresAt) ? r.autoExpiresAt : r.expectedReleaseAt ?? r.autoExpiresAt;
}

function formatRelative(ts: unknown): string {
  if (!ts) return "-";
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
  } catch { return "-"; }
}
