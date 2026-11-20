"use client";

// Small shared pieces for drafting requests: the stage in plain words, who
// it waits on, human dates, and the quiet status tag the list and the
// request page both draw.

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

/** A state as a soft colored pill: red late or blocked, amber waiting,
 *  green done, brand for work under way, grey for not set. */
export function StatusTag({ tone = "none", children, className = "" }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return <span className={`ui-pill ${PILL[tone]} ${className}`}>{children}</span>;
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
