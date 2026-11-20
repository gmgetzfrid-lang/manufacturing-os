// What needs you, as rows: the same feed as the bell and the sidebar badge
// (useTicketNotifications), shaped for a table. Each row says what it is,
// what to do, and when: the due date when the item carries one (a periodic
// review's "was due 2026-08-06"), else how long it has waited. Late rows
// sort first; nothing here is invented, every field is read off the item.

import type { AttentionItem } from "@/hooks/useTicketNotifications";
import { humanizeDates } from "./ui";

export interface NeedsRow {
  key: string;
  /** A request, drawing or document number, when the item has one. */
  ref: string | null;
  name: string;
  /** What to do, in the item's own words. */
  todo: string;
  /** The due date (YYYY-MM-DD) when the item states one. */
  due: string | null;
  /** When it arrived or last changed. */
  since: string | null;
  overdue: boolean;
  /** Due within 7 days and not late. */
  dueSoon: boolean;
  /** Waits on your decision or action. */
  yourTurn: boolean;
  link: string;
  notificationId?: string;
  kind: string;
}

/** Kinds that only ever say something is late. */
const LATE_KINDS = new Set(["review_overdue", "ack_overdue", "owner_behind", "task_overdue_digest"]);

/** Short names for what a notification asks of you, where its title is a
 *  label rather than a task ("Review overdue: 5602-D 1000"). */
const KIND_TODO: Record<string, string> = {
  review_due: "Periodic review",
  review_requested: "Review and sign off",
  review_invalidated: "Review again",
  ack_requested: "Read and acknowledge",
  markup_request: "Markups asked for",
  access_recert_due: "Recertify access",
  request_pending_approval: "Approve or assign",
  deletion_requested: "Deletion asked for",
  equipment_request: "Equipment asked for",
};

/** Kinds whose title is "<what happened>: <document>", so the document is
 *  the item and the first part says what to do. Other titles ("Drawings: 3
 *  documents revised") stay whole. */
const LABELLED_KINDS = new Set([
  "review_due", "review_overdue", "review_requested", "review_invalidated", "review_signed", "review_complete",
  "ack_overdue", "owner_behind", "access_recert_due", "owner_assigned",
]);

/** "KE-DDRT-26-0003 do stuff" → ["KE-DDRT-26-0003", "do stuff"]. */
function splitRef(title: string): [string | null, string] {
  const m = /^([A-Z0-9]+(?:-[A-Z0-9]+)+)\s+(.*)$/.exec(title.trim());
  return m ? [m[1], m[2] || ""] : [null, title];
}

const DAY = 86_400_000;

function localDay(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function needsRow(it: AttentionItem, now = Date.now()): NeedsRow {
  const today = localDay(now);
  const weekOut = localDay(now + 7 * DAY);
  let ref: string | null = null;
  let name = it.title;
  let todo = it.subtitle || "";
  if (it.source === "ticket") {
    [ref, name] = splitRef(it.title);
    if (!name) { name = ref ?? it.title; ref = null; }
  } else {
    // "Review overdue: 5602-D 1000" → item 5602-D 1000, the label is the task.
    const m = LABELLED_KINDS.has(it.kind) ? /^([^:]{3,48}):\s+(.+)$/.exec(it.title) : null;
    if (m) { name = m[2]; todo = KIND_TODO[it.kind] ?? m[1]; }
    else if (KIND_TODO[it.kind]) todo = KIND_TODO[it.kind];
  }
  const dueM = /\bdue(?: for review)?(?: on)? (\d{4}-\d{2}-\d{2})/i.exec(it.subtitle || "");
  const due = dueM ? dueM[1] : null;
  const overdue = LATE_KINDS.has(it.kind) || /\boverdue\b/i.test(it.title) || (!!due && due < today);
  const dueSoon = !overdue && !!due && due <= weekOut;
  return {
    key: it.key, ref, name: name.trim() || it.title,
    todo: humanizeDates(todo || (it.actionRequired ? "Your turn" : "New activity")),
    due, since: it.when || null, overdue, dueSoon, yourTurn: it.actionRequired,
    link: it.link, notificationId: it.notificationId, kind: String(it.kind),
  };
}

/** Late first (oldest due first), then due soon, then your turn, then the
 *  rest; newest first inside each. */
export function sortNeeds(rows: NeedsRow[]): NeedsRow[] {
  const rank = (r: NeedsRow) => (r.overdue ? 0 : r.dueSoon ? 1 : r.yourTurn ? 2 : 3);
  return [...rows].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d) return d;
    if ((a.overdue || a.dueSoon) && a.due && b.due && a.due !== b.due) return a.due.localeCompare(b.due);
    return (b.since ?? "").localeCompare(a.since ?? "");
  });
}

export function buildNeeds(items: AttentionItem[], now = Date.now()): NeedsRow[] {
  return sortNeeds(items.map((i) => needsRow(i, now)));
}

/** The counts that back up "N things need you". */
export function needsFacts(rows: NeedsRow[]): { overdue: number; yourTurn: number; dueSoon: number; news: number } {
  let overdue = 0, yourTurn = 0, dueSoon = 0, news = 0;
  for (const r of rows) {
    if (r.overdue) overdue++;
    if (r.dueSoon) dueSoon++;
    if (r.yourTurn) yourTurn++; else news++;
  }
  return { overdue, yourTurn, dueSoon, news };
}
