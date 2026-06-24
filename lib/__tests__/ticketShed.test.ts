import { describe, it, expect } from "vitest";
import {
  selectTicketShedCandidates,
  isTicketEligible,
  ticketAttachmentBytes,
  type TicketShedRow,
} from "@/lib/ticketShed";

const NOW = new Date("2026-06-23T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400 * 1000).toISOString();

function ticket(id: string, status: string, ageDays: number, opts: Partial<TicketShedRow> = {}): TicketShedRow {
  return {
    id,
    ticket_id: id.toUpperCase(),
    title: `Ticket ${id}`,
    status,
    last_modified: daysAgo(ageDays),
    created_at: daysAgo(ageDays + 5),
    archived_at: null,
    attachments: [],
    ...opts,
  };
}

describe("ticketAttachmentBytes", () => {
  it("sums numeric and string sizes, ignores junk", () => {
    expect(ticketAttachmentBytes([{ size: 1000 }, { size: "2000" }, { size: null }, { size: "x" }])).toBe(3000);
    expect(ticketAttachmentBytes(null)).toBe(0);
    expect(ticketAttachmentBytes(undefined)).toBe(0);
  });
});

describe("isTicketEligible", () => {
  const cutoff = new Date(NOW.getTime() - 365 * 86400 * 1000);
  it("accepts a terminal ticket quiet past the cutoff", () => {
    expect(isTicketEligible(ticket("a", "CLOSED", 400), cutoff)).toBe(true);
    expect(isTicketEligible(ticket("b", "CANCELED", 400), cutoff)).toBe(true);
  });
  it("is case-insensitive on status", () => {
    expect(isTicketEligible(ticket("a", "closed", 400), cutoff)).toBe(true);
  });
  it("rejects open/in-flight tickets regardless of age", () => {
    expect(isTicketEligible(ticket("a", "DRAFTING", 999), cutoff)).toBe(false);
    expect(isTicketEligible(ticket("b", "PENDING_REVIEW", 999), cutoff)).toBe(false);
    expect(isTicketEligible(ticket("c", "NEW", 999), cutoff)).toBe(false);
  });
  it("rejects terminal tickets that are still recent", () => {
    expect(isTicketEligible(ticket("a", "CLOSED", 30), cutoff)).toBe(false);
  });
  it("rejects already-archived tickets", () => {
    expect(isTicketEligible(ticket("a", "CLOSED", 400, { archived_at: daysAgo(1) }), cutoff)).toBe(false);
  });
  it("measures quiet-since off closed_at, not a later last_modified", () => {
    // Closed 400 days ago but commented on yesterday: still eligible (the comment
    // must not reset the clock).
    expect(isTicketEligible(
      ticket("a", "CLOSED", 1, { closed_at: daysAgo(400) }), cutoff,
    )).toBe(true);
    // Closed recently but last_modified is old (e.g. backfilled): NOT eligible —
    // closed_at wins.
    expect(isTicketEligible(
      ticket("b", "CLOSED", 800, { closed_at: daysAgo(30) }), cutoff,
    )).toBe(false);
  });
});

describe("selectTicketShedCandidates", () => {
  it("selects only terminal+aged tickets, oldest first", () => {
    const rows = [
      ticket("recent", "CLOSED", 30),
      ticket("old1", "CLOSED", 500),
      ticket("open", "DRAFTING", 800),
      ticket("old2", "CANCELED", 400),
    ];
    const sel = selectTicketShedCandidates(rows, { olderThanDays: 365, now: NOW });
    expect(sel.selected.map((r) => r.id)).toEqual(["old1", "old2"]); // 500d before 400d
    expect(sel.totalCount).toBe(2);
  });

  it("sums reclaimable attachment bytes across selected tickets", () => {
    const rows = [
      ticket("a", "CLOSED", 400, { attachments: [{ url: "k1", size: 1000 }, { url: "k2", size: 500 }] }),
      ticket("b", "CLOSED", 410, { attachments: [{ url: "k3", size: 2000 }] }),
    ];
    const sel = selectTicketShedCandidates(rows, { olderThanDays: 365, now: NOW });
    expect(sel.totalBytes).toBe(3500);
  });

  it("respects a byte target and reports the remainder as skipped", () => {
    const rows = [
      ticket("a", "CLOSED", 500, { attachments: [{ url: "k", size: 600 }] }),
      ticket("b", "CLOSED", 450, { attachments: [{ url: "k", size: 600 }] }),
      ticket("c", "CLOSED", 400, { attachments: [{ url: "k", size: 600 }] }),
    ];
    const sel = selectTicketShedCandidates(rows, { olderThanDays: 365, now: NOW, targetBytes: 1000 });
    expect(sel.selected.map((r) => r.id)).toEqual(["a", "b"]); // oldest first, stop at 1200>=1000
    expect(sel.skipped).toBe(1);
  });

  it("still selects attachment-less terminal tickets (Postgres-row win)", () => {
    const rows = [ticket("a", "CLOSED", 500, { attachments: [] })];
    const sel = selectTicketShedCandidates(rows, { olderThanDays: 365, now: NOW });
    expect(sel.totalCount).toBe(1);
    expect(sel.totalBytes).toBe(0);
  });
});
