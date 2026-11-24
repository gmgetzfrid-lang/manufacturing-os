"use client";

// RequestAsk: "Needed from you" at the top of a drafting request when the
// person came because it waits on them (?ask=turn from a notification, the
// Inbox or Home). It says the step in words, who asked and by when, and
// puts the step's own button there (the same one the header carries).

import React from "react";
import { NeededFromYou } from "@/components/ui/NeededFromYou";
import { Button } from "@/components/ui/Button";
import { fmtDay, waitingOn } from "@/components/requests/RequestBits";
import type { Ticket } from "@/types/schema";

function toIso(v: unknown): string | null {
  if (!v) return null;
  const m = v as { toDate?: () => Date; seconds?: number };
  const d = v instanceof Date ? v : typeof m.toDate === "function" ? m.toDate() : typeof m.seconds === "number" ? new Date(m.seconds * 1000) : new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** What the step asks of the person, in one line. */
export function stepAsk(t: Ticket): string {
  const id = t.ticketId || "this request";
  switch (t.status) {
    case "NEW":
    case "PENDING_ASSIGNMENT": return `Assign a drafter to ${id} so drafting can start.`;
    case "PENDING_ENG_INITIAL":
    case "PENDING_ENG_TEAM": return `Check the scope of ${id}: send it on to drafting, or send it back with questions.`;
    case "DRAFTING": return `Draft ${id} and send the draft for review.`;
    case "REVISION_REQ": return `Make the changes asked for on ${id} and send the draft back for review.`;
    case "PENDING_REVIEW": return `Review the draft of ${id}: approve it, or ask for a revision.`;
    case "PENDING_FINAL_APPROVAL": return `Sign off the drawings for ${id} before they are issued.`;
    case "PENDING_IFC": return `Issue ${id} for construction: upload the IFC package.`;
    case "FINAL_DRAFT": return `Check the issued drawings for ${id} and close the request.`;
    default: return `${id} is waiting on you.`;
  }
}

/** Why it's this person's: the hat they wear on this request. */
function yourPart(t: Ticket, uid: string | null): string {
  if (t.assignedDrafterId && t.assignedDrafterId === uid) return "You're the drafter on it.";
  if (t.requesterId === uid) return "You asked for it.";
  if (t.assignedEngineerId && t.assignedEngineerId === uid) return "You're the engineer reviewer on it.";
  if (t.status === "PENDING_ASSIGNMENT") return "Assigning drafters is part of your role.";
  return "This step is part of your role.";
}

export default function RequestAsk({ ticket, uid, onYou, stateWords, main, others = [], busy, dueIso, pastDue }: {
  ticket: Ticket;
  uid: string | null;
  /** The request is waiting on this person now. */
  onYou: boolean;
  /** Where it is, in words ("Draft out for review."). */
  stateWords: string;
  /** The step's main button. */
  main: { label: string; run: () => void } | null;
  /** Up to two other steps, quiet. */
  others?: Array<{ label: string; run: () => void }>;
  busy?: boolean;
  dueIso?: string | null;
  pastDue?: boolean;
}) {
  if (!onYou) {
    const who = waitingOn(ticket);
    return (
      <NeededFromYou done what={<>{ticket.ticketId || "This request"} isn&apos;t waiting on you now. {stateWords}{who && ticket.status !== "CLOSED" && ticket.status !== "CANCELED" ? ` It's with ${who}.` : ""}</>} />
    );
  }
  const asked = toIso(ticket.createdAt);
  const due = dueIso ? (() => {
    const d = new Date(dueIso);
    const days = Math.round((new Date(d.toDateString()).getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);
    return pastDue || days < 0
      ? { text: `Overdue since ${fmtDay(d)} (${Math.max(1, -days)} day${-days === 1 ? "" : "s"})`, late: true }
      : { text: days === 0 ? `Due today, ${fmtDay(d)}` : `Due ${fmtDay(d)} (in ${days} day${days === 1 ? "" : "s"})`, soon: days <= 7 };
  })() : { text: "No due date set on the request." };
  return (
    <NeededFromYou
      what={stepAsk(ticket)}
      why={<>{ticket.requesterName ? `${ticket.requesterName} asked for it` : "Requested"}{asked ? ` on ${fmtDay(asked)}` : ""}. {yourPart(ticket, uid)} {stateWords}</>}
      when={due}
      note={!main ? <>The button for this step isn&apos;t available to your role here. Ask a supervisor.</> : null}
    >
      {main && <Button loading={busy} onClick={main.run}>{main.label}</Button>}
      {others.map((o) => <Button key={o.label} variant="secondary" disabled={busy} onClick={o.run}>{o.label}</Button>)}
    </NeededFromYou>
  );
}
