"use client";

// Small shared pieces for drafting requests: the stage in plain words, who
// it waits on, what changed last, human dates, and the quiet status (a dot
// and a word) the list and the request page both draw.

import React from "react";
import type { Ticket, TicketStatus } from "@/types/schema";

export type Tone = "bad" | "warn" | "good" | "brand" | "none";

const PILL: Record<Tone, string> = {
  bad: "is-bad",
  warn: "is-warn",
  good: "is-good",
  brand: "",
  none: "is-muted",
};

/** A state as a dot and a word: red late or sent back, amber waiting,
 *  green done, brand for work under way, grey for not set. The word takes
 *  the state color only for red and amber; `plain` keeps it in text color
 *  (a long list where only the dot should speak). */
export function StatusTag({ tone = "none", plain = false, children, className = "" }: { tone?: Tone; plain?: boolean; children: React.ReactNode; className?: string }) {
  return <span className={`ui-pill ${PILL[tone]} ${plain && tone !== "none" ? "!text-[var(--color-text)]" : ""} ${className}`}>{children}</span>;
}

/** The stage a request is at, in the words the team uses. */
export function stageLabel(status: TicketStatus | string): string {
  switch (status) {
    case "NEW": return "New";
    case "PENDING_ENG_INITIAL":
    case "PENDING_ENG_TEAM": return "Engineering review";
    case "PENDING_ASSIGNMENT": return "Needs a drafter";
    case "DRAFTING": return "Drafting";
    case "REVISION_REQ": return "Revision";
    case "PENDING_REVIEW": return "In review";
    case "PENDING_FINAL_APPROVAL": return "Final approval";
    case "PENDING_IFC": return "Ready to issue";
    case "FINAL_DRAFT": return "Issued";
    case "CLOSED": return "Closed";
    case "CANCELED": return "Canceled";
    default: return sentence(String(status).replace(/_/g, " "));
  }
}

/** Color by what the stage means: waiting on a review or a decision is
 *  amber, sent back for a fix is red, issued or closed is green, canceled
 *  is grey; drafting and new requests are work under way (brand). */
export function stageTone(status: TicketStatus | string): Tone {
  switch (status) {
    case "REVISION_REQ": return "bad";
    case "PENDING_ENG_INITIAL":
    case "PENDING_ENG_TEAM":
    case "PENDING_ASSIGNMENT":
    case "PENDING_REVIEW":
    case "PENDING_FINAL_APPROVAL": return "warn";
    case "PENDING_IFC":
    case "FINAL_DRAFT":
    case "CLOSED": return "good";
    case "CANCELED": return "none";
    default: return "brand";
  }
}

/** Who the request sits with now, by the workflow's own rules. */
export function waitingOn(t: Ticket): string | null {
  switch (t.status) {
    case "NEW":
    case "PENDING_ASSIGNMENT": return "Supervisor";
    case "PENDING_ENG_INITIAL": return "Engineering";
    case "PENDING_ENG_TEAM": return t.assignedEngineerName || "Engineering";
    case "DRAFTING":
    case "REVISION_REQ":
    case "PENDING_IFC": return t.assignedDrafterName || "Drafter";
    case "PENDING_REVIEW":
    case "FINAL_DRAFT": return t.requesterName || "Requester";
    case "PENDING_FINAL_APPROVAL": return t.assignedEngineerName || "Engineer";
    default: return null;
  }
}

export const isOpen = (t: Pick<Ticket, "status">) => t.status !== "CLOSED" && t.status !== "CANCELED";

const asDate = (v: unknown): Date | null => {
  if (!v) return null;
  if (v instanceof Date) return v;
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === "function") return maybe.toDate();
  if (typeof maybe.seconds === "number") return new Date(maybe.seconds * 1000);
  const d = new Date(v as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "Aug 6" (or "Aug 6, 2025" outside this year). */
export function fmtDay(v: unknown): string {
  const d = asDate(v);
  if (!d) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** "Aug 6, 3:57 PM". */
export function fmtWhen(v: unknown): string {
  const d = asDate(v);
  if (!d) return "";
  return `${fmtDay(d)}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/** How long ago, in words a person says: "Just now", "12 min ago",
 *  "3 h ago", "Yesterday", then the day ("Nov 14"). */
export function relTime(v: unknown, now: number = Date.now()): string {
  const d = asDate(v);
  if (!d) return "";
  const ms = now - d.getTime();
  if (ms < 0) return fmtDay(d);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const y = new Date(now); y.setHours(0, 0, 0, 0); y.setDate(y.getDate() - 1);
  if (d.getTime() >= y.getTime()) return "Yesterday";
  return fmtDay(d);
}

/** Who someone is, short: "hparra@kernenergy.com" → "hparra". */
export function shortName(user: string | null | undefined): string {
  return (user || "").split("@")[0] || "Someone";
}

/** One history line in plain past-tense words. Old rows used codes
 *  ("REVISION_REQUESTED") and labels ("Assign Drafter"); both read as
 *  people talk. */
export function historyWords(action: string, details?: string | null): string {
  const a = (action || "").replace(/\s*[\u2013\u2014]\s*/g, ", ").replace(/_/g, " ").trim();
  const d = (details || "").trim();
  const rev = /rev(?:ision)?\s+([\w.-]+)\s*$/i.exec(a)?.[1];
  if (/^created$/i.test(a)) return "Requested";
  if (/^source linked/i.test(a)) return "Linked the source document";
  if (/assign/i.test(a) && /^assigned to /i.test(d)) return d.replace(/\s*\[reason:.*$/i, "");
  if (/^file uploaded/i.test(a)) {
    const m = /^uploaded (\w+) file: (.+)$/i.exec(d);
    return m ? `Added ${m[1].toLowerCase() === "draft" ? "a draft" : m[1].toLowerCase() === "final" ? "the issued file" : `a ${m[1].toLowerCase()} file`}, ${m[2]}` : "Added a file";
  }
  if (/submitted for review|send draft for review/i.test(a)) return rev ? `Sent Rev ${rev} for review` : "Sent the draft for review";
  if (/^issue/i.test(a)) return rev ? `Issued Rev ${rev}` : "Issued";
  if (/minor correction/i.test(a)) return rev ? `Approved with a small fix, Rev ${rev}` : "Approved with a small fix";
  if (/approve/i.test(a)) return rev ? `Approved, Rev ${rev}` : "Approved";
  if (/revision/i.test(a)) return "Sent back for a revision";
  if (/clarify|return to requester|send back/i.test(a)) return "Sent back with questions";
  if (/final engineer approval|engineer for final/i.test(a)) return "Sent to an engineer for sign-off";
  if (/engineer to review|eng review/i.test(a)) return "Sent to engineering review";
  if (/issue/i.test(a)) return rev ? `Issued Rev ${rev}` : "Issued";
  if (/pick it up|self assign/i.test(a)) return "Picked it up";
  if (/save progress/i.test(a)) return "Saved progress";
  if (/reopen/i.test(a)) return "Reopened";
  if (/reject/i.test(a)) return "Rejected and reopened";
  if (/close/i.test(a)) return "Closed";
  if (/redline/i.test(a)) return "Redlines received";
  return sentence(a);
}

/** What changed last on a request (its history or a comment, whichever
 *  is newer): what, who and when, for a list row. */
export function lastChange(t: Pick<Ticket, "history" | "comments" | "lastModified">): { what: string; who: string | null; at: unknown } | null {
  const h = (t.history ?? [])[(t.history?.length ?? 0) - 1];
  const c = (t.comments ?? [])[(t.comments?.length ?? 0) - 1];
  const hAt = asDate(h?.date)?.getTime() ?? -1;
  const cAt = asDate(c?.date)?.getTime() ?? -1;
  if (c && cAt > hAt) return { what: c.type === "Revision" || c.type === "Rejection" ? "Asked for a revision" : "Commented", who: shortName(c.user), at: c.date };
  if (h) return { what: historyWords(h.action, h.details), who: h.user ? shortName(h.user) : null, at: h.date };
  return t.lastModified ? { what: "Updated", who: null, at: t.lastModified } : null;
}

const KEEP = new Set(["IFC", "RFI", "MOC", "ISO", "SLA", "PDF", "CSV"]);
/** "ISSUE FINAL IFC PACKAGE" → "Issue final IFC package". */
export function sentence(s: string): string {
  const out = s.split(/(\s+|[()/&])/).map((w) => (KEEP.has(w.toUpperCase()) ? w.toUpperCase() : w.toLowerCase())).join("");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** True on a phone-width screen (under 640px), so a header can show fewer facts. */
export function useNarrow(): boolean {
  return React.useSyncExternalStore(
    (cb) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mq = window.matchMedia("(max-width: 639px)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(max-width: 639px)").matches,
    () => false,
  );
}
