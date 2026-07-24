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

import React, { useEffect, useState } from "react";
import { Users, X, BellRing } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { listOrgEditOverlaps, type DocumentIntent } from "@/lib/intents";
import { notifyMany } from "@/lib/inAppNotifications";

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
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [nudged, setNudged] = useState<Set<string>>(new Set());

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
      } catch { /* advisory is best-effort */ }
    })();
    return () => { alive = false; };
  }, [orgId, currentUserId, onlyMine]);

  const visible = rows.filter((r) => !dismissed.has(r.documentId));
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
      setNudged((prev) => new Set(prev).add(row.documentId));
    } catch { /* best-effort */ }
  };

  return (
    <div className="space-y-2 mb-3">
      {visible.map((row) => {
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
              {nudged.has(row.documentId) ? (
                <span className="text-[10px] font-bold text-emerald-700">Heads-up sent ✓</span>
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
                onClick={() => setDismissed((prev) => new Set(prev).add(row.documentId))}
                className="p-1 rounded-md hover:bg-amber-100"
                title="Dismiss for now"
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
