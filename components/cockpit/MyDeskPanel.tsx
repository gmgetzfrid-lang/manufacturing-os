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
import { Check, Loader2, Clock } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { sharedLoad, lastLoaded } from "@/lib/warmLoads";
import { listMyStaleCopies, type StaleCopy } from "@/lib/staleCopies";
import { friendlyError } from "@/lib/friendlyError";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { StatusTag, rowBtn, sheet, SectionHead } from "./ui";

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

/** What is on my desk: my checkouts, my stale copies, my open branches. */
export interface DeskLoad { checkouts: MyCheckout[]; staleCopies: StaleCopy[]; branches: MyBranch[] }
export const deskKey = (orgId: string, uid: string) => `desk:${orgId}|${uid}`;

/** Read the desk. The three parts don't need each other: they're read
 *  together, each with its own document names after it. */
export async function loadDesk(orgId: string, uid: string): Promise<DeskLoad> {
  // 1. My active checkouts.
  const checkoutsP = (async (): Promise<MyCheckout[] | null> => {
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
      return rows.map((r) => ({
        sessionId: String(r.id),
        documentId: String(r.document_id),
        libraryId: (r.library_id as string | null) ?? null,
        docLabel: labelById.get(String(r.document_id)) ?? "Document",
        purpose: (r.purpose as string | null) ?? null,
        startedAt: String(r.started_at),
        autoExpiresAt: (r.auto_expires_at as string | null) ?? null,
        expectedReleaseAt: (r.expected_release_at as string | null) ?? null,
      }));
    } catch { return null; /* quiet */ }
  })();

  // 2. My stale copies.
  const staleP = listMyStaleCopies(uid, orgId).catch((e: unknown) => { console.warn("[desk] stale copies read failed", e); return null; });

  // 3. My unresolved branches.
  const branchesP = (async (): Promise<MyBranch[] | null> => {
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
      return branchRows.map((r) => ({
        id: String(r.id),
        documentId: String(r.document_id),
        docLabel: labelById.get(String(r.document_id))?.label ?? "Document",
        libraryId: labelById.get(String(r.document_id))?.libraryId ?? null,
        createdAt: String(r.created_at),
      }));
    } catch { return null; /* pre-migration env */ }
  })();

  const [checkouts, staleCopies, branches] = await Promise.all([checkoutsP, staleP, branchesP]);
  // A part that couldn't be read is left out, as before.
  return { checkouts: checkouts ?? [], staleCopies: staleCopies ?? [], branches: branches ?? [] };
}

export default function MyDeskPanel({ orgId, uid, userEmail }: MyDeskPanelProps) {
  const key = deskKey(orgId, uid);
  // This panel's answer; until it comes, the one last read (the Inbox
  // opened again shows it at once) or the one the Inbox started with it.
  const [got, setGot] = useState<{ key: string; v: DeskLoad } | null>(null);
  const [releasingId, setReleasingId] = useState<string | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const desk = (got && got.key === key ? got.v : lastLoaded<DeskLoad>(key)) ?? null;
  const checkouts = desk?.checkouts ?? [];
  const staleCopies = desk?.staleCopies ?? [];
  const branches = desk?.branches ?? [];
  // Never a blank gap while it loads; nothing at all once it's known empty.
  const loading = !desk;

  const load = useCallback(async (fresh = false) => {
    const v = await sharedLoad(key, () => loadDesk(orgId, uid), fresh ? { fresh: true } : { maxAgeMs: 1500 });
    setGot({ key, v });
  }, [key, orgId, uid]);

  useEffect(() => { void load().catch(() => undefined); }, [load]);

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
      await load(true);
    } catch (e) {
      console.error("Release from desk failed", e);
      setReleaseError(`${c.docLabel} wasn't released. ${friendlyError(e)}`);
    } finally {
      setReleasingId(null);
    }
  };

  const total = checkouts.length + staleCopies.length + branches.length;
  if (loading && total === 0) {
    return <section aria-label="Checked out to you"><SectionHead title="Checked out to you" /><SkeletonRows rows={2} cols={2} what="what you have checked out" /></section>;
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

  const band = "px-4 h-10 flex items-center gap-2 bg-[var(--color-surface-2)] text-body font-medium text-[var(--color-text)] border-t border-[var(--color-border)] first:border-t-0";
  const count = (n: number) => <span className="font-normal tabular-nums text-[var(--color-text-muted)]">{n}</span>;

  return (
    <section aria-label="Checked out to you">
      <SectionHead title="Checked out to you" count={total} />
      {releaseError && <p role="alert" className="mb-2 text-body font-medium text-[var(--state-overdue-text)]">{releaseError}</p>}
      <div className={sheet}>
        {checkouts.length > 0 && (
          <>
            <h3 className={band}>Your checkouts {count(checkouts.length)}</h3>
            <ul className="divide-y divide-[var(--color-border)]">
              {checkouts.map((c) => {
                const k = clock(c);
                return (
                  <li key={c.sessionId} className="relative flex items-center gap-3 px-4 py-2.5">
                    {k.hot && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-held)]" />}
                    <Link href={docHref(c.libraryId, c.documentId)} className="min-w-0 flex-1">
                      <span className="ui-id block text-reading truncate hover:text-[var(--color-accent-text)]">{c.docLabel}</span>
                      {c.purpose && <span className="block text-body text-[var(--color-text-muted)] truncate">{c.purpose}</span>}
                    </Link>
                    <span className="shrink-0 text-body tabular-nums">
                      {k.hot ? <StatusTag tone="held"><Clock className="w-3.5 h-3.5" aria-hidden />{k.text}</StatusTag> : <span className="text-[var(--color-text-muted)]">{k.text}</span>}
                    </span>
                    <button
                      type="button"
                      onClick={() => void release(c)}
                      disabled={releasingId === c.sessionId}
                      title="Release it with no changes"
                      className={rowBtn}
                    >
                      {releasingId === c.sessionId ? <Loader2 className="w-3.5 h-3.5 motion-safe:animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                      {releasingId === c.sessionId ? "Releasing" : "Release"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {staleCopies.length > 0 && (
          <>
            <h3 className={band}>Your copies that are out of date {count(staleCopies.length)}</h3>
            <ul className="divide-y divide-[var(--color-border)]">
              {staleCopies.slice(0, 5).map((s) => (
                <li key={s.documentId}>
                  <Link href={docHref(s.libraryId, s.documentId)} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-surface-2)]">
                    <span className="ui-id min-w-0 flex-1 text-reading truncate">{s.docLabel}</span>
                    <StatusTag tone="held">You have Rev {s.downloadedRev ?? "?"}, now Rev {s.currentRev ?? "?"}</StatusTag>
                  </Link>
                </li>
              ))}
              {staleCopies.length > 5 && (
                <li className="px-4 py-2.5 text-body text-[var(--color-text-muted)]">and {staleCopies.length - 5} more</li>
              )}
            </ul>
          </>
        )}

        {branches.length > 0 && (
          <>
            <h3 className={band}>Your branches to reconcile {count(branches.length)}</h3>
            <ul className="divide-y divide-[var(--color-border)]">
              {branches.map((b) => (
                <li key={b.id}>
                  <Link href={docHref(b.libraryId, b.documentId)} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-surface-2)]">
                    <span className="ui-id min-w-0 flex-1 text-reading truncate">{b.docLabel}</span>
                    <span className="shrink-0 text-body text-[var(--color-text-muted)]">
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
