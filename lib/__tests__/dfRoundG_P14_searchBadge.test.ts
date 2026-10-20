// drafting-flow Round G, DF-P14 review fix pass 2 — UI-7 / GAP-108
// acceptance 4: the request hit's badge in the command palette (⌘K,
// components/navigation/GlobalCommandPalette.tsx) and on /search reads
// ticketStatusLabel(status), never the stored identifier. Other kinds' badges
// (documents, projects, transmittals) are not ticket statuses and are unchanged.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  tickets: [] as Array<Record<string, unknown>>,
  transmittals: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/search", () => ({
  lookupTag: vi.fn(async () => []),
  searchDocuments: vi.fn(async () => []),
  searchAssets: vi.fn(async () => []),
  searchTickets: vi.fn(async () => h.tickets),
}));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    const hnd: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
          const data = table === "transmittals" ? h.transmittals : [];
          return (resolve: (v: unknown) => void) => resolve({ data, error: null });
        }
        return () => new Proxy({}, hnd);
      },
    };
    return new Proxy({}, hnd);
  };
  return { supabase: { from: (t: string) => chain(t) } };
});

import { globalSearch } from "@/lib/globalSearch";

const RAW = /\b(PENDING_ASSIGNMENT|PENDING_ENG_TEAM|DRAFTING|REVISION_REQ|PENDING_REVIEW|PENDING_FINAL_APPROVAL|PENDING_IFC|FINAL_DRAFT|CLOSED|CANCELED)\b/;

beforeEach(() => { h.tickets = []; h.transmittals = []; });

describe("UI-7 — a request hit's badge is the status a person reads", () => {
  it("each request's badge is ticketStatusLabel(status); no status, no badge", async () => {
    h.tickets = [
      { id: "t1", ticket_id: "REQ-1", title: "Pump iso", status: "PENDING_REVIEW", requester_name: "Rita" },
      { id: "t2", ticket_id: "REQ-2", title: "Pump skid", status: "FINAL_DRAFT", requester_name: null },
      { id: "t3", ticket_id: "REQ-3", title: "Pump base", status: "ON_HOLD_FOR_VENDOR" },
      { id: "t4", ticket_id: "REQ-4", title: "Pump spare", status: null },
    ];
    const hits = (await globalSearch({ orgId: "o1", query: "pump" })).filter((x) => x.kind === "ticket");
    expect(hits.map((x) => [x.id, x.badge])).toEqual([
      ["t1", "In review"],
      ["t2", "Issued — awaiting acknowledgement"],
      ["t3", "On hold for vendor"],
      ["t4", undefined],
    ]);
    for (const x of hits) expect(x.badge ?? "").not.toMatch(RAW);
  });
  it("a transmittal's badge is its own status, unchanged (not a ticket status)", async () => {
    h.transmittals = [{ id: "x1", number: "TR-0001", subject: "Pump drawings", recipient_name: null, status: "issued" }];
    const hits = (await globalSearch({ orgId: "o1", query: "pump" })).filter((x) => x.kind === "transmittal");
    expect(hits.map((x) => x.badge)).toEqual(["issued"]);
  });
});
