"use client";

// Small shared pieces for drafting requests: the stage in plain words, who
// it waits on, human dates, and the quiet status tag the list and the
// request page both draw.

import React from "react";
import type { Ticket, TicketStatus } from "@/types/schema";

export type Tone = "bad" | "warn" | "good" | "none";

const DOT: Record<Tone, string> = {
  bad: "bg-[var(--state-overdue)]",
  warn: "bg-[var(--state-held)]",
  good: "bg-[var(--state-released)]",
  none: "bg-[var(--color-text-faint)]",
};

/** A small, quiet state tag: an 8px dot and the word. */
export function StatusTag({ tone = "none", children, className = "" }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text)] whitespace-nowrap ${className}`}>
      <span aria-hidden className={`w-2 h-2 rounded-full shrink-0 ${DOT[tone]}`} />
      {children}
    </span>
  );
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

/** Color only where it means something: sent back is waiting on a fix,
 *  closed is done; every other stage is normal work. */
export function stageTone(status: TicketStatus | string): Tone {
  if (status === "REVISION_REQ") return "warn";
  if (status === "CLOSED") return "good";
  return "none";
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
