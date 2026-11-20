"use client";

// MyDeskPanel: "what am I sitting on right now?" in one ruled table.
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
import { FileDown, GitBranch, Check, Loader2, Clock, FileLock } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { listMyStaleCopies, type StaleCopy } from "@/lib/staleCopies";
import { StatusTag, rowBtn } from "./ui";

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
    return <p className="flex items-center gap-1.5 text-[14px] text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading what you have checked out…</p>;
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

  const band = "px-4 h-10 flex items-center gap-2 bg-[var(--color-surface-2)] text-[14px] font-semibold text-[var(--color-text)] border-t border-[var(--color-border-strong)] first:border-t-0";
  const count = (n: number) => <span className="ui-count is-solid">{n}</span>;
  const tile = (icon: React.ReactNode) => <span aria-hidden className="ui-icon-tile is-sm !bg-[var(--color-surface)]">{icon}</span>;

  return (
    <section aria-label="Checked out to you">
      <div className="flex items-center gap-2 mb-2.5 min-h-9">
        <span aria-hidden className="ui-icon-tile is-sm is-solid"><FileLock className="w-4 h-4" /></span>
        <h2 className="font-display text-[19px] leading-tight font-semibold text-[var(--color-text)]">Checked out to you</h2>
        <span className="ui-count is-solid">{total}</span>
      </div>
      {releaseError && <p role="alert" className="mb-2 border-l-[3px] border-[var(--state-overdue)] pl-2.5 text-[14px] font-semibold text-[var(--state-overdue)]">{releaseError}</p>}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
        {checkouts.length > 0 && (
          <>
            <h3 className={band}>{tile(<FileLock className="w-4 h-4" />)}Your checkouts {count(checkouts.length)}</h3>
            <ul className="divide-y divide-[var(--color-border)]">
              {checkouts.map((c) => {
                const k = clock(c);
                return (
                  <li key={c.sessionId} className="relative flex items-center gap-3 px-4 py-2.5">
                    {k.hot && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-held)]" />}
                    <Link href={docHref(c.libraryId, c.documentId)} className="min-w-0 flex-1">
                      <span className="ui-id block text-[15px] truncate hover:text-[var(--color-accent-text)]">{c.docLabel}</span>
                      {c.purpose && <span className="block text-[13px] text-[var(--color-text-muted)] truncate">{c.purpose}</span>}
                    </Link>
                    <span className="shrink-0 text-[14px] tabular-nums">
                      {k.hot ? <StatusTag tone="held"><Clock className="w-3.5 h-3.5" aria-hidden />{k.text}</StatusTag> : <span className="text-[var(--color-text-muted)]">{k.text}</span>}
                    </span>
                    <button
                      type="button"
                      onClick={() => void release(c)}
                      disabled={releasingId === c.sessionId}
                      title="Release it with no changes"
                      className={rowBtn}
                    >
                      {releasingId === c.sessionId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                      Release
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {staleCopies.length > 0 && (
          <>
            <h3 className={band}>{tile(<FileDown className="w-4 h-4" />)}Your copies that are out of date {count(staleCopies.length)}</h3>
            <ul className="divide-y divide-[var(--color-border)]">
              {staleCopies.slice(0, 5).map((s) => (
                <li key={s.documentId}>
                  <Link href={docHref(s.libraryId, s.documentId)} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-surface-2)]">
                    <span className="ui-id min-w-0 flex-1 text-[15px] truncate">{s.docLabel}</span>
                    <StatusTag tone="held">You have Rev {s.downloadedRev ?? "?"}, now Rev {s.currentRev ?? "?"}</StatusTag>
                  </Link>
                </li>
              ))}
              {staleCopies.length > 5 && (
                <li className="px-4 py-2.5 text-[13px] text-[var(--color-text-muted)]">and {staleCopies.length - 5} more</li>
              )}
            </ul>
          </>
        )}

        {branches.length > 0 && (
          <>
            <h3 className={band}>{tile(<GitBranch className="w-4 h-4" />)}Your branches to reconcile {count(branches.length)}</h3>
            <ul className="divide-y divide-[var(--color-border)]">
              {branches.map((b) => (
                <li key={b.id}>
                  <Link href={docHref(b.libraryId, b.documentId)} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-surface-2)]">
                    <span className="ui-id min-w-0 flex-1 text-[15px] truncate">{b.docLabel}</span>
                    <span className="shrink-0 text-[13px] text-[var(--color-text-muted)]">
                      Since {new Date(b.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
