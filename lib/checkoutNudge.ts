// lib/checkoutNudge.ts
//
// The /checkouts "Nudge to coordinate" heads-up (notifications Round G, N9 —
// OS-6). Until N9 the only guard against a repeat was the overlap card's own
// React state: a refresh, collapsing the panel or navigating away erased it,
// and the same people could be poked again and again.
//
// Now the cooldown is derived from what was sent, not from the page: a nudge
// is a checkout_conflict row carrying metadata.nudge, about the document the
// person holds in the overlap (resource 'document'), written by the sender.
// One nudge per (sender, recipient, document) per CHECKOUT_NUDGE_COOLDOWN_HOURS
// (24 h — the integrator's ruling under the user's delegation, 2026-10-07):
//   · the card shows "Heads-up sent" from that read, after a refresh and on
//     any device (nudgeState);
//   · the writer refuses a second nudge inside the window with a sentence
//     that says who was nudged and when the next one is possible
//     (sendCheckoutNudge) — never merely a hidden button.
// The read is notifications_i_sent() (lib/sentNotices.ts, 20261191). Before
// that migration is pasted it is unavailable and the page keeps today's path:
// the card's own state, and the write goes out.
//
// The write itself is today's: in-app only (notifyMany), the same title and
// body, from the signed-in member (DEC-86 §2: the actor is the session's uid).
// What changed on the row: it names the recipient's document as its resource
// (it named the bare "checkout" type before) and carries { nudge, overlap }.
// The database's caps (20261160) remain the backstop for a writer that skips
// this module.

import { notifyMany } from "@/lib/inAppNotifications";
import { readNoticesISent } from "@/lib/sentNotices";

export const CHECKOUT_NUDGE_COOLDOWN_HOURS = 24;
const COOLDOWN_MS = CHECKOUT_NUDGE_COOLDOWN_HOURS * 3_600_000;

/** One person to nudge, and the document they hold in the overlap. */
export interface NudgeTarget {
  userId: string;
  documentId: string;
  name?: string | null;
}

export const nudgeKey = (t: { userId: string; documentId: string }) => `${t.userId}:${t.documentId}`;

/** The targets of an overlap: everyone in it but the sender, each once,
 *  paired with the first document (by id) they hold in it. */
export function nudgeTargets(
  involved: ReadonlyArray<{ userId: string; documentId?: string | null; userName?: string | null }>,
  senderUid: string | null | undefined,
): NudgeTarget[] {
  const byUser = new Map<string, NudgeTarget>();
  for (const c of involved) {
    if (!c.userId || c.userId === senderUid || !c.documentId) continue;
    const prev = byUser.get(c.userId);
    if (!prev || c.documentId < prev.documentId) byUser.set(c.userId, { userId: c.userId, documentId: c.documentId, name: c.userName ?? prev?.name ?? null });
  }
  return [...byUser.values()];
}

/** When each (recipient, document) was last nudged by the signed-in member
 *  inside the cooldown — `known: false` when it cannot be read (before
 *  20261191, or a failed read). */
export async function recentNudges(orgId: string, now: number = Date.now()): Promise<{ known: boolean; sentAt: Map<string, number> }> {
  const read = await readNoticesISent({
    orgId, kind: "checkout_conflict", since: new Date(now - COOLDOWN_MS).toISOString(),
    resourceType: "document", metadata: { nudge: true },
  });
  const sentAt = new Map<string, number>();
  if (!read.available) return { known: false, sentAt };
  for (const r of read.rows) {
    if (!r.resourceId || now - r.at > COOLDOWN_MS) continue;
    const k = nudgeKey({ userId: r.userId, documentId: r.resourceId });
    sentAt.set(k, Math.max(sentAt.get(k) ?? 0, r.at));
  }
  return { known: true, sentAt };
}

/** Whether every target was nudged inside the cooldown (the card's "Heads-up
 *  sent"), and the earliest moment a new nudge is possible. Pure. */
export function nudgeState(targets: readonly NudgeTarget[], sentAt: ReadonlyMap<string, number>): { allSent: boolean; nextAt: number | null } {
  if (targets.length === 0) return { allSent: false, nextAt: null };
  let next: number | null = null;
  for (const t of targets) {
    const at = sentAt.get(nudgeKey(t));
    if (at === undefined) return { allSent: false, nextAt: null };
    const free = at + COOLDOWN_MS;
    next = next === null ? free : Math.min(next, free);
  }
  return { allSent: true, nextAt: next };
}

export interface NudgeOutcome {
  /** How many people were nudged now. */
  sent: number;
  /** Who was left out because they were nudged inside the cooldown. */
  skipped: NudgeTarget[];
  /** The writer's refusal, when nobody was left to nudge. */
  refused?: string;
}

/** Send the heads-up to everyone in the overlap who was not nudged by this
 *  member about their document in the last 24 hours; refuse — with the
 *  reason — when nobody is left. Never throws on the read; a write that
 *  fails is reported by notifyMany's log, as before. */
export async function sendCheckoutNudge(input: {
  orgId: string;
  actorUserId: string;
  actorName: string;
  overlapKey: string;
  what: string;
  names: string;
  targets: NudgeTarget[];
  now?: number;
}): Promise<NudgeOutcome> {
  const now = input.now ?? Date.now();
  const { known, sentAt } = await recentNudges(input.orgId, now);
  const due = known ? input.targets.filter((t) => !sentAt.has(nudgeKey(t))) : input.targets;
  const skipped = known ? input.targets.filter((t) => sentAt.has(nudgeKey(t))) : [];
  if (due.length === 0) {
    const { nextAt } = nudgeState(input.targets, sentAt);
    const who = skipped.map((t) => t.name || "them").join(", ");
    const when = nextAt !== null ? new Date(nextAt).toLocaleString() : null;
    return {
      sent: 0,
      skipped,
      refused: `You already nudged ${who} about this in the last ${CHECKOUT_NUDGE_COOLDOWN_HOURS} hours` +
        (when ? ` — you can nudge again after ${when}.` : "."),
    };
  }
  // One request per document the recipients hold (each row names its own
  // document); usually one person per document.
  const byDoc = new Map<string, string[]>();
  for (const t of due) (byDoc.get(t.documentId) ?? byDoc.set(t.documentId, []).get(t.documentId)!).push(t.userId);
  for (const [documentId, userIds] of byDoc) {
    await notifyMany({
      orgId: input.orgId,
      userIds,
      actorUserId: input.actorUserId,
      kind: "checkout_conflict",
      title: "Coordinate — overlapping checkout",
      body: `${input.actorName} flagged that you're both working on ${input.what} (${input.names}). Sync up before issuing so changes don't collide.`,
      link: "/checkouts",
      resourceType: "document",
      resourceId: documentId,
      metadata: { nudge: true, overlap: input.overlapKey },
    });
  }
  return { sent: due.length, skipped };
}
