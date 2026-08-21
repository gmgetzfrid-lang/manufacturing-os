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
    setStaleCopies(await listMyStaleCopies(uid, orgId));

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
  }, [orgId, uid]);

  useEffect(() => { void load(); }, [load]);

  const release = async (c: MyCheckout) => {
    setReleasingId(c.sessionId);
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
    } finally {
      setReleasingId(null);
    }
  };

  const total = checkouts.length + staleCopies.length + branches.length;
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
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
        <KeyRound className="w-4 h-4 text-blue-600" />
        <span className="text-sm font-black text-[var(--color-text)]">My desk</span>
        <span className="text-[10px] font-bold text-[var(--color-text-faint)] ml-auto">{total} item{total === 1 ? "" : "s"}</span>
      </div>

      <div className="p-3 space-y-3">
        {checkouts.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Checked out to me</div>
            {checkouts.map((c) => {
              const k = clock(c);
              return (
                <div key={c.sessionId} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)] group">
                  <Link href={docHref(c.libraryId, c.documentId)} className="flex-1 min-w-0">
                    <span className="text-xs font-bold text-[var(--color-text)] group-hover:text-blue-700 truncate block">{c.docLabel}</span>
                    <span className="text-[10px] text-[var(--color-text-faint)] flex items-center gap-1">
                      <Clock className="w-2.5 h-2.5" />
                      <span className={k.hot ? "text-amber-600 font-bold" : ""}>{k.text}</span>
                      {c.purpose && <> · {c.purpose}</>}
                    </span>
                  </Link>
                  <button
                    onClick={() => void release(c)}
                    disabled={releasingId === c.sessionId}
                    title="Release — no changes"
                    className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 sm:py-1 rounded-md text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 opacity-100 sm:opacity-0 group-hover:opacity-100 hover:bg-emerald-100 transition-all disabled:opacity-50"
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
            <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">My copies that went stale</div>
            {staleCopies.slice(0, 5).map((s) => (
              <Link key={s.documentId} href={docHref(s.libraryId, s.documentId)} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-amber-50 group">
                <FileDown className="w-3 h-3 text-amber-500 shrink-0" />
                <span className="text-xs text-[var(--color-text)] group-hover:text-amber-800 truncate flex-1">{s.docLabel}</span>
                <span className="text-[10px] font-bold text-amber-700 shrink-0">
                  you have Rev {s.downloadedRev ?? "?"} → now Rev {s.currentRev ?? "?"}
                </span>
              </Link>
            ))}
            {staleCopies.length > 5 && (
              <div className="text-[10px] text-[var(--color-text-faint)] px-2">…and {staleCopies.length - 5} more</div>
            )}
          </div>
        )}

        {branches.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">My branches awaiting reconciliation</div>
            {branches.map((b) => (
              <Link key={b.id} href={docHref(b.libraryId, b.documentId)} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-purple-50 group">
                <GitBranch className="w-3 h-3 text-purple-500 shrink-0" />
                <span className="text-xs text-[var(--color-text)] group-hover:text-purple-800 truncate flex-1">{b.docLabel}</span>
                <span className="text-[10px] text-[var(--color-text-faint)] shrink-0">
                  since {new Date(b.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
