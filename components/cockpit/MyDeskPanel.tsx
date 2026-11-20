"use client";

// MyDeskPanel — "what am I sitting on right now?" in one glance.
//
//   * Everything I have checked out (with its clock and a one-click release)
//   * Downloaded copies of mine that have since gone stale (re-pull links)
//   * Branches I opened that still need reconciling
//
// The holder is the one person best placed to manage their own locks — give
// them the whole picture in the place they start their day. Renders nothing
// when the desk is clean.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { KeyRound, FileDown, GitBranch, Check, Loader2, Clock } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { listMyStaleCopies, type StaleCopy } from "@/lib/staleCopies";

interface MyCheckout {
  sessionId: string;
  documentId: string;
  libraryId: string | null;
  docLabel: string;
  purpose: string | null;
  startedAt: string;
  autoExpiresAt: string | null;
  expectedReleaseAt: string | null;
}

interface MyBranch {
  id: string;
  documentId: string;
  docLabel: string;
  libraryId: string | null;
  createdAt: string;
}

interface MyDeskPanelProps {
  orgId: string;
  uid: string;
  userEmail?: string | null;
}

export default function MyDeskPanel({ orgId, uid, userEmail }: MyDeskPanelProps) {
  const [checkouts, setCheckouts] = useState<MyCheckout[]>([]);
  const [staleCopies, setStaleCopies] = useState<StaleCopy[]>([]);
  const [branches, setBranches] = useState<MyBranch[]>([]);
  const [releasingId, setReleasingId] = useState<string | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  // Never a blank gap while it loads; nothing at all once it's known empty.
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    // 1. My active checkouts.
    try {
      const { data: sessions } = await supabase
        .from("checkout_sessions")
        .select("id, document_id, library_id, purpose, started_at, auto_expires_at, expected_release_at")
        .eq("org_id", orgId)
        .eq("user_id", uid)
        .eq("status", "active")
        .order("started_at", { ascending: true });
      const rows = (sessions as Array<Record<string, unknown>>) ?? [];
      const docIds = [...new Set(rows.map((r) => String(r.document_id)))];
      const labelById = new Map<string, string>();
      if (docIds.length > 0) {
        const { data: docs } = await supabase
          .from("documents")
          .select("id, document_number, title, name")
          .in("id", docIds);
        for (const d of (docs as Array<Record<string, unknown>>) ?? []) {
          labelById.set(String(d.id), String(d.document_number || d.title || d.name || "Document"));
        }
      }
      setCheckouts(rows.map((r) => ({
        sessionId: String(r.id),
        documentId: String(r.document_id),
        libraryId: (r.library_id as string | null) ?? null,
        docLabel: labelById.get(String(r.document_id)) ?? "Document",
        purpose: (r.purpose as string | null) ?? null,
        startedAt: String(r.started_at),
        autoExpiresAt: (r.auto_expires_at as string | null) ?? null,
        expectedReleaseAt: (r.expected_release_at as string | null) ?? null,
      })));
    } catch { /* quiet */ }

    // 2. My stale copies.
    try { setStaleCopies(await listMyStaleCopies(uid, orgId)); } catch (e) { console.warn("[desk] stale copies read failed", e); }

    // 3. My unresolved branches.
    try {
      const { data: rows } = await supabase
        .from("revision_branches")
        .select("id, document_id, created_at")
        .eq("org_id", orgId)
        .eq("created_by", uid)
        .is("resolved_at", null);
      const branchRows = (rows as Array<Record<string, unknown>>) ?? [];
      const docIds = [...new Set(branchRows.map((r) => String(r.document_id)))];
      const labelById = new Map<string, { label: string; libraryId: string | null }>();
      if (docIds.length > 0) {
        const { data: docs } = await supabase
          .from("documents")
          .select("id, document_number, title, name, library_id")
          .in("id", docIds);
        for (const d of (docs as Array<Record<string, unknown>>) ?? []) {
          labelById.set(String(d.id), {
            label: String(d.document_number || d.title || d.name || "Document"),
            libraryId: (d.library_id as string | null) ?? null,
          });
        }
      }
      setBranches(branchRows.map((r) => ({
        id: String(r.id),
        documentId: String(r.document_id),
        docLabel: labelById.get(String(r.document_id))?.label ?? "Document",
        libraryId: labelById.get(String(r.document_id))?.libraryId ?? null,
        createdAt: String(r.created_at),
      })));
    } catch { /* pre-migration env */ }
    setLoading(false);
  }, [orgId, uid]);

  useEffect(() => { void load(); }, [load]);

  const release = async (c: MyCheckout) => {
    setReleasingId(c.sessionId);
    setReleaseError(null);
    try {
      const { finishMySession } = await import("@/lib/checkoutEpisodes");
      await finishMySession({
        orgId,
        documentId: c.documentId,
        userId: uid,
        userName: userEmail?.split("@")[0] || "User",
        sessionStatus: "checked_in",
        releasedReason: "Released from My Desk",
        // The button says "no changes" — record it on the register.
        outcome: { outcome: "all_clear", note: null, ref: null },
      });
      const { endMyIntents } = await import("@/lib/intents");
      void endMyIntents({ documentId: c.documentId, userId: uid, sources: ["checkout"] });
      await load();
    } catch (e) {
      console.error("Release from desk failed", e);
      setReleaseError(`${c.docLabel} wasn't released: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setReleasingId(null);
    }
  };

  const total = checkouts.length + staleCopies.length + branches.length;
  if (loading && total === 0) {
    return <p className="flex items-center gap-1.5 px-1 text-[13px] text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading your desk…</p>;
  }
  if (total === 0) return null;

  const clock = (c: MyCheckout): { text: string; hot: boolean } => {
    const now = Date.now();
    const hard = c.autoExpiresAt ? Date.parse(c.autoExpiresAt) : null;
    const soft = c.expectedReleaseAt ? Date.parse(c.expectedReleaseAt) : null;
    if (hard) {
      const hrs = Math.round((hard - now) / 3600000);
      if (hrs <= 0) return { text: "auto-releasing", hot: true };
      return { text: hrs < 48 ? `${hrs}h left` : `${Math.round(hrs / 24)}d left`, hot: hrs <= 4 };
    }
    if (soft && soft < now) return { text: "past due-back date", hot: true };
    const days = Math.floor((now - Date.parse(c.startedAt)) / 86400000);
    return { text: days === 0 ? "since today" : `${days}d held`, hot: days >= 7 };
  };

  const docHref = (libraryId: string | null, docId: string) =>
    libraryId ? `/documents/${libraryId}?doc=${docId}` : "/documents";

  return (
    <section className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] overflow-hidden">
      <div className="px-4 sm:px-5 pt-4 pb-2 flex items-center gap-2">
        <h2 className="inline-flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
          <KeyRound className="w-3.5 h-3.5" aria-hidden /> My desk
        </h2>
        <span className="text-[12px] font-bold text-[var(--color-text-muted)] ml-auto">{total} item{total === 1 ? "" : "s"}</span>
      </div>

      <div className="px-2 sm:px-3 pb-3 space-y-3 divide-y divide-[var(--color-border)] [&>*+*]:pt-3">
        {releaseError && <p role="alert" className="border-l-2 border-red-500 pl-2 text-[11px] font-semibold text-red-700 dark:text-red-400">{releaseError}</p>}
        {checkouts.length > 0 && (
          <div className="space-y-1">
            <div className="px-2 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Checked out to me</div>
            {checkouts.map((c) => {
              const k = clock(c);
              return (
                <div key={c.sessionId} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)] group">
                  <Link href={docHref(c.libraryId, c.documentId)} className="flex-1 min-w-0">
                    <span className="text-[13.5px] font-semibold text-[var(--color-text)] truncate block">{c.docLabel}</span>
                    <span className="text-[12px] text-[var(--color-text-muted)] flex items-center gap-1">
                      <Clock className="w-2.5 h-2.5" />
                      <span className={k.hot ? "text-amber-700 dark:text-amber-400 font-bold" : ""}>{k.text}</span>
                      {c.purpose && <> · {c.purpose}</>}
                    </span>
                  </Link>
                  <button
                    onClick={() => void release(c)}
                    disabled={releasingId === c.sessionId}
                    title="Release: no changes"
                    className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 sm:py-1 rounded-md text-[12px] font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border-strong)] opacity-100 sm:opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-[var(--color-surface-2)] transition-all disabled:opacity-50"
                  >
                    {releasingId === c.sessionId ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                    Release
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {staleCopies.length > 0 && (
          <div className="space-y-1">
            <div className="px-2 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">My copies that went stale</div>
            {staleCopies.slice(0, 5).map((s) => (
              <Link key={s.documentId} href={docHref(s.libraryId, s.documentId)} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)] group">
                <FileDown className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                <span className="text-[13.5px] text-[var(--color-text)] truncate flex-1">{s.docLabel}</span>
                <span className="text-[12px] font-bold text-amber-700 dark:text-amber-400 shrink-0">
                  you have Rev {s.downloadedRev ?? "?"} → now Rev {s.currentRev ?? "?"}
                </span>
              </Link>
            ))}
            {staleCopies.length > 5 && (
              <div className="text-[12px] text-[var(--color-text-muted)] px-2">and {staleCopies.length - 5} more</div>
            )}
          </div>
        )}

        {branches.length > 0 && (
          <div className="space-y-1">
            <div className="px-2 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">My branches awaiting reconciliation</div>
            {branches.map((b) => (
              <Link key={b.id} href={docHref(b.libraryId, b.documentId)} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)] group">
                <GitBranch className="w-3 h-3 text-[var(--color-text-muted)] shrink-0" />
                <span className="text-[13.5px] text-[var(--color-text)] truncate flex-1">{b.docLabel}</span>
                <span className="text-[12px] text-[var(--color-text-muted)] shrink-0">
                  since {new Date(b.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
