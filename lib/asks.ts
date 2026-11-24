// lib/asks.ts - what the app wants from someone, carried in the link.
//
// A notification, an Inbox row or Home's "Open the first one" takes the
// person to the thing that needs them. The link carries `ask=<what>` (and,
// from a notification, `n=<its id>`), so the screen they land on can say,
// at the top, exactly what is wanted, why, by when, and give the button.
// Without an ask the screen looks as it always did.
//
// Pure: no reads, no writes. The landing screens decide what is still
// pending (a review already recorded says so instead of asking again).

/** Every kind of thing a landing can ask for. */
export type Ask =
  | "review"     // periodic review due: still current, or needs changes
  | "ack"        // read and acknowledge a controlled revision
  | "dist"       // confirm you have the revision that was sent to you
  | "signoff"    // review and sign off a draft before it publishes
  | "publish"    // every reviewer signed: publish the approved revision
  | "chase"      // someone owes a sign-off or acknowledgment: follow up
  | "markup"     // someone asked for your markups
  | "checkout"   // a checkout of yours needs checking in or extending
  | "hold"       // a hold stops work on this document
  | "recert"     // a library's access needs recertifying
  | "turn"       // a drafting request is waiting on you
  | "late"       // a project step is past its date
  | "due";       // a project step is due this week

const ASKS: ReadonlySet<string> = new Set<Ask>([
  "review", "ack", "dist", "signoff", "publish", "chase", "markup", "checkout",
  "hold", "recert", "turn", "late", "due",
]);

/** An `ask` read from an address, or null when it isn't one of ours. */
export function readAsk(value: string | null | undefined): Ask | null {
  return value && ASKS.has(value) ? (value as Ask) : null;
}

/** What a notification of this kind asks of the person it went to, or null
 *  for news that asks nothing. `metadata.ackRequest` marks a distribution
 *  confirmation ("I have this revision"), which shares kinds with others. */
export function askForNotification(kind: string, metadata?: Record<string, unknown> | null): Ask | null {
  if (metadata && metadata.ackRequest === true && (kind === "ack_requested" || kind === "doc_superseded")) return "dist";
  switch (kind) {
    case "review_due":
    case "owner_behind":
      return "review";
    case "ack_requested":
      return "ack";
    case "review_requested":
    case "review_invalidated":
    case "review_alternate_activated":
      return "signoff";
    case "review_complete":
      return "publish";
    case "review_overdue":
    case "ack_overdue":
      return "chase";
    case "markup_request":
      return "markup";
    case "checkout_conflict":
    case "checkout_released":
    case "overlap_advisory":
    case "revision_published_over_checkout":
      return "checkout";
    case "hold_opened":
      return "hold";
    case "access_recert_due":
      return "recert";
    case "request_pending_approval":
    case "ticket_assigned":
      return "turn";
    default:
      return null;
  }
}

/** The link with `ask` (and the notification id) added, keeping whatever it
 *  already carries. Unchanged when there is nothing to ask, or the link
 *  isn't an in-app address. */
export function withAsk(link: string, ask: Ask | null | undefined, notificationId?: string | null): string {
  if (!ask || !link.startsWith("/")) return link;
  const hashAt = link.indexOf("#");
  const hash = hashAt >= 0 ? link.slice(hashAt) : "";
  const noHash = hashAt >= 0 ? link.slice(0, hashAt) : link;
  const qAt = noHash.indexOf("?");
  const path = qAt >= 0 ? noHash.slice(0, qAt) : noHash;
  const sp = new URLSearchParams(qAt >= 0 ? noHash.slice(qAt + 1) : "");
  sp.set("ask", ask);
  if (notificationId) sp.set("n", notificationId); else sp.delete("n");
  return `${path}?${sp.toString()}${hash}`;
}

/** The address with the ask taken off (when the person moves on to
 *  something else, or the thing is done). */
export function withoutAsk(search: string): string {
  const sp = new URLSearchParams(search.replace(/^\?/, ""));
  sp.delete("ask"); sp.delete("n");
  return sp.toString();
}

/** Whole days from today (local) to a YYYY-MM-DD or ISO date: negative when
 *  it is past. Null without a date. */
export function daysFromToday(date: string | null | undefined, now = new Date()): number | null {
  if (!date) return null;
  const d = new Date(`${date.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

/** "Nov 12" this year, "Nov 12, 2025" otherwise. */
export function plainDate(date: string | null | undefined, now = new Date()): string {
  if (!date) return "";
  const d = date.length <= 10 ? new Date(`${date}T00:00:00`) : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** "Due Nov 12 (in 5 days)", "Due today", "Overdue since Nov 12 (12 days)". */
export function dueWords(date: string | null | undefined, now = new Date()): { text: string; late: boolean; soon: boolean } | null {
  const days = daysFromToday(date, now);
  if (days == null) return null;
  const on = plainDate(date, now);
  if (days < 0) return { text: `Overdue since ${on} (${-days} day${days === -1 ? "" : "s"})`, late: true, soon: false };
  if (days === 0) return { text: `Due today, ${on}`, late: false, soon: true };
  if (days === 1) return { text: `Due tomorrow, ${on}`, late: false, soon: true };
  return { text: `Due ${on} (in ${days} days)`, late: false, soon: days <= 7 };
}
