"use client";

// EditOverlapBanner — the advisory rung of the signal ladder.
//
// Shows when TWO OR MORE people hold live EDIT intents on the same document
// (from checkouts, downloads-while-checked-out, or drafting tickets) — the
// collision flagged BEFORE either person uploads, from data the system
// captures automatically. Views never trigger this; only edit×edit.
//
// Deliberately quiet: an amber banner on the coordination surfaces for the
// people involved, plus a manual one-click "send a heads-up" (in-app only,
// never email). No modal, no interruption — per the interruption budget.
//
// What it remembers (TAX-8, notifications Round G N7):
//   - An overlap is the document, the set of people in it, and when it
//     formed: the moment its last person joined (each person's earliest live
//     edit intent; the latest of those — `overlapFormedAt`). Anything this
//     banner remembers about an overlap counts only if it happened after the
//     overlap formed. A new person joining is a new overlap; so is the same
//     people overlapping again after it dissolved — but only once the lapsed
//     intent rows are gone (the daily maintenance cron prunes expired rows).
//     Until then a re-declared intent reuses its row: lib/intents'
//     recordIntent upserts on (document_id, user_id, kind, source) and keeps
//     created_at, so the overlap re-forms with its old formed time, and a
//     dismissal or "Heads-up sent" from before still covers it.
//   - "Dismiss for now" sticks for THIS overlap across a remount and a reload
//     (hooks/useDismissed, stamped with the overlap it dismissed).
//   - "Heads-up sent" survives a remount. It is derived from the
//     notification rows this person can read: an overlap_advisory about the
//     document, from someone in the overlap, sent after the overlap formed
//     and within OVERLAP_HEADSUP_WINDOW_DAYS, means a heads-up already went
//     round to everyone in it now. One sent before the newest person joined
//     never reached them, so the button is offered again. A heads-up this
//     person sent is not readable back (the rows are the recipients' —
//     notifications_own_select), so their own send is remembered on the same
//     substrate as a dismissal, stamped the same way, under the same rule.
//   - A mark is stamped with the overlap's own formed time (`overlapMarkAt`),
//     a server timestamp — never the browser's clock. "Formed" comes from
//     document_intents.created_at; comparing it with a Date.now() stamp
//     lost every dismissal and send made on a PC whose clock runs behind.

import React, { useEffect, useState } from "react";
import { Users, X, BellRing } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { listOrgEditOverlaps, type DocumentIntent } from "@/lib/intents";
import { notifyMany } from "@/lib/inAppNotifications";
import { useDismissedSet } from "@/hooks/useDismissed";

/** How far back a received heads-up still counts as "sent" for an overlap. */
export const OVERLAP_HEADSUP_WINDOW_DAYS = 14;

/** One overlap: the document and the people in it (sorted). */
export function overlapKey(documentId: string, intents: Array<{ userId: string }>): string {
  return `${documentId}:${[...new Set(intents.map((i) => i.userId))].sort().join(",")}`;
}

/**
 * When the overlap formed (epoch ms): the moment its last person joined —
 * each person's earliest live edit intent, the latest of those. A date that
 * cannot be read counts as "not yet", so nothing remembered can claim it.
 */
export function overlapFormedAt(intents: Array<{ userId: string; createdAt?: string | null }>): number {
  const joined = new Map<string, number>();
  for (const i of intents) {
    const t = Date.parse(i.createdAt ?? "");
    const at = Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
    joined.set(i.userId, Math.min(joined.get(i.userId) ?? Number.POSITIVE_INFINITY, at));
  }
  let formed = Number.NEGATIVE_INFINITY;
  for (const at of joined.values()) formed = Math.max(formed, at);
  return formed;
}

/** A remembered mark for one overlap: `<overlapKey>@<epoch ms>`. */
export function overlapMark(key: string, at: number): string {
  return `${key}@${at}`;
}

/**
 * The stamp for a mark made now on an overlap that formed at `formed`: the
 * formed time itself, so the comparison with `overlapFormedAt` is always
 * server clock against server clock. The same people overlapping again later
 * form later, so an old mark never covers the new overlap. (An overlap whose
 * formed time cannot be read is never covered by any mark; the stamp then
 * falls back to now and changes nothing.)
 */
export function overlapMarkAt(formed: number, now: number = Date.now()): number {
  return Number.isFinite(formed) ? formed : now;
}

/** The latest moment `key` was marked among `values` (-Infinity: never). */
export function latestOverlapMark(values: readonly string[], key: string): number {
  const prefix = `${key}@`;
  let latest = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (!v.startsWith(prefix)) continue;
    const at = Number(v.slice(prefix.length));
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  return latest;
}

interface OverlapRow {
  documentId: string;
  libraryId: string | null;
  documentLabel: string;
  intents: DocumentIntent[];
}

interface EditOverlapBannerProps {
  orgId: string;
  currentUserId: string;
  currentUserName?: string | null;
  /** Show only overlaps the current user is part of (default true — the
   *  library surfaces). The /checkouts coordination page passes false to
   *  see the whole org. */
  onlyMine?: boolean;
}

export default function EditOverlapBanner({
  orgId, currentUserId, currentUserName, onlyMine = true,
}: EditOverlapBannerProps) {
  const [rows, setRows] = useState<OverlapRow[]>([]);
  const scope = currentUserId && orgId ? `${currentUserId}:${orgId}` : null;
  // Both sets hold `overlapMark` entries: the overlap and when.
  const dismissed = useDismissedSet("overlap-banner", scope);
  // This person's own sends (unreadable back from the rows — see header).
  const sent = useDismissedSet("overlap-headsup-sent", scope);
  // Heads-ups this person RECEIVED about a document, by overlap key → sender.
  const [received, setReceived] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!orgId || !currentUserId) return;
    let alive = true;
    (async () => {
      try {
        const overlaps = await listOrgEditOverlaps(orgId);
        const mine = onlyMine
          ? overlaps.filter((o) => o.intents.some((i) => i.userId === currentUserId))
          : overlaps;
        if (mine.length === 0) { if (alive) setRows([]); return; }

        // Resolve document labels in one query.
        const ids = mine.map((o) => o.documentId);
        const { data } = await supabase
          .from("documents")
          .select("id, document_number, title, name")
          .in("id", ids);
        const labelById = new Map<string, string>();
        for (const r of (data as Array<{ id: string; document_number: string | null; title: string | null; name: string | null }>) ?? []) {
          labelById.set(r.id, r.document_number || r.title || r.name || "Document");
        }
        if (!alive) return;
        setRows(mine.map((o) => ({
          documentId: o.documentId,
          libraryId: o.libraryId,
          documentLabel: labelById.get(o.documentId) ?? "Document",
          intents: o.intents,
        })));

        // "Heads-up sent", from the rows: an advisory about the document
        // from someone in this overlap, sent after the overlap formed (so it
        // reached everyone in it now), recently. Best-effort — a failed read
        // leaves the button offered, as before.
        const since = new Date(Date.now() - OVERLAP_HEADSUP_WINDOW_DAYS * 86_400_000).toISOString();
        const { data: advisories, error: advErr } = await supabase
          .from("notifications")
          .select("resource_id, actor_user_id, actor_name, created_at")
          .eq("user_id", currentUserId)
          .eq("kind", "overlap_advisory")
          .eq("resource_type", "document")
          .in("resource_id", ids)
          .gte("created_at", since);
        if (!alive || advErr) return;
        const got = new Map<string, string>();
        for (const o of mine) {
          const people = new Set(o.intents.map((i) => i.userId));
          const formed = overlapFormedAt(o.intents);
          const hit = ((advisories ?? []) as Array<{ resource_id: string | null; actor_user_id: string | null; actor_name: string | null; created_at?: string | null }>)
            .find((a) => a.resource_id === o.documentId && !!a.actor_user_id && people.has(a.actor_user_id)
              && Date.parse(a.created_at ?? "") >= formed);
          if (hit) got.set(overlapKey(o.documentId, o.intents), hit.actor_name || "someone");
        }
        setReceived(got);
      } catch { /* advisory is best-effort */ }
    })();
    return () => { alive = false; };
  }, [orgId, currentUserId, onlyMine]);

  // Until the stored marks are read (hydration), show nothing rather than
  // flash a banner the person dismissed.
  const isDismissed = (r: OverlapRow) =>
    !dismissed.ready || latestOverlapMark(dismissed.values, overlapKey(r.documentId, r.intents)) >= overlapFormedAt(r.intents);
  const visible = rows.filter((r) => !isDismissed(r));
  if (visible.length === 0) return null;

  /** Replace this overlap's earlier marks with one for the overlap as it
   *  stands — stamped with its formed time, not this browser's clock. */
  const markNow = (set: typeof sent, row: OverlapRow) => {
    const key = overlapKey(row.documentId, row.intents);
    const at = overlapMarkAt(overlapFormedAt(row.intents));
    set.update((ids) => [...ids.filter((v) => !v.startsWith(`${key}@`)), overlapMark(key, at)]);
  };

  const sendHeadsUp = async (row: OverlapRow) => {
    const userIds = [...new Set(row.intents.map((i) => i.userId))];
    const names = [...new Set(row.intents.map((i) => i.userName).filter(Boolean))] as string[];
    try {
      await notifyMany({
        orgId,
        userIds,
        actorUserId: currentUserId,
        actorName: currentUserName ?? undefined,
        kind: "overlap_advisory",
        title: `Heads-up: parallel work on ${row.documentLabel}`,
        body: `${names.join(", ")} all have active edit work on this document. Coordinate before publishing — the second upload will hit a conflict if the bases diverge.`,
        link: row.libraryId ? `/documents/${row.libraryId}?doc=${row.documentId}` : undefined,
        resourceType: "document",
        resourceId: row.documentId,
      });
      markNow(sent, row);
    } catch { /* best-effort */ }
  };

  return (
    <div className="space-y-2 mb-3">
      {visible.map((row) => {
        const key = overlapKey(row.documentId, row.intents);
        const receivedFrom = received.get(key) ?? null;
        const headsUpSent = latestOverlapMark(sent.values, key) >= overlapFormedAt(row.intents) || receivedFrom !== null;
        const others = row.intents.filter((i) => i.userId !== currentUserId);
        const otherNames = [...new Set(others.map((i) => i.userName || "someone"))];
        const sourcesByUser = others.map((i) =>
          `${i.userName || "someone"} (${i.source === "ticket" ? "drafting ticket" : i.source})`);
        return (
          <div
            key={row.documentId}
            className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl border border-amber-300 bg-amber-50 text-amber-900"
          >
            <Users className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
            <div className="flex-1 min-w-0 text-xs leading-relaxed">
              <b>{row.documentLabel}:</b>{" "}
              {onlyMine ? (
                <>you and <b>{otherNames.join(", ")}</b> both have active edit work on this document</>
              ) : (
                <><b>{[...new Set(row.intents.map((i) => i.userName || "someone"))].join(", ")}</b> all have active edit work on this document</>
              )}
              {" "}({sourcesByUser.join("; ")}). Coordinate now — publishing from diverged bases will stop with a conflict.
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {headsUpSent ? (
                <span
                  className="text-[10px] font-bold text-emerald-700"
                  title={receivedFrom ? `${receivedFrom} sent a heads-up about this document` : "You sent a heads-up about this document"}
                >
                  Heads-up sent ✓
                </span>
              ) : (
                <button
                  onClick={() => void sendHeadsUp(row)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold border border-amber-400 hover:bg-amber-100"
                  title="Send an in-app heads-up to everyone involved"
                >
                  <BellRing className="w-3 h-3" /> Send heads-up
                </button>
              )}
              <button
                onClick={() => markNow(dismissed, row)}
                className="p-1 rounded-md hover:bg-amber-100"
                title="Dismiss for now"
                aria-label="Dismiss"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
