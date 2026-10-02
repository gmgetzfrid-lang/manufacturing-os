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
//   - "Dismiss for now" sticks for THIS overlap — the document and the set of
//     people in it — across a remount and a reload (hooks/useDismissed). A
//     new person joining the overlap is a new overlap, and it shows again.
//   - "Heads-up sent" survives a remount. It is derived from the
//     notification rows this person can read: an overlap_advisory about the
//     document from someone in the overlap within OVERLAP_HEADSUP_WINDOW_DAYS
//     means a heads-up already went round. A heads-up this person sent is not
//     readable back (the rows are the recipients' — notifications_own_select),
//     so their own send is remembered for this overlap on the same substrate
//     as a dismissal, and the button does not offer to send it twice.

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
        // from someone in this overlap, recently. Best-effort — a failed
        // read leaves the button offered, as before.
        const since = new Date(Date.now() - OVERLAP_HEADSUP_WINDOW_DAYS * 86_400_000).toISOString();
        const { data: advisories, error: advErr } = await supabase
          .from("notifications")
          .select("resource_id, actor_user_id, actor_name")
          .eq("user_id", currentUserId)
          .eq("kind", "overlap_advisory")
          .eq("resource_type", "document")
          .in("resource_id", ids)
          .gte("created_at", since);
        if (!alive || advErr) return;
        const got = new Map<string, string>();
        for (const o of mine) {
          const people = new Set(o.intents.map((i) => i.userId));
          const hit = ((advisories ?? []) as Array<{ resource_id: string | null; actor_user_id: string | null; actor_name: string | null }>)
            .find((a) => a.resource_id === o.documentId && !!a.actor_user_id && people.has(a.actor_user_id));
          if (hit) got.set(overlapKey(o.documentId, o.intents), hit.actor_name || "someone");
        }
        setReceived(got);
      } catch { /* advisory is best-effort */ }
    })();
    return () => { alive = false; };
  }, [orgId, currentUserId, onlyMine]);

  const visible = rows.filter((r) => !dismissed.has(overlapKey(r.documentId, r.intents)));
  if (visible.length === 0) return null;

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
      sent.add(overlapKey(row.documentId, row.intents));
    } catch { /* best-effort */ }
  };

  return (
    <div className="space-y-2 mb-3">
      {visible.map((row) => {
        const key = overlapKey(row.documentId, row.intents);
        const receivedFrom = received.get(key) ?? null;
        const headsUpSent = sent.has(key) || receivedFrom !== null;
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
                onClick={() => dismissed.add(key)}
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
