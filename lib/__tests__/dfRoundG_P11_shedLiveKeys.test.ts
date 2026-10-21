// drafting-flow AUTHZ-5 done-when 2 (DF-P11 fix pass 3): the reclaim's
// "does another LIVE ticket still name this key?" check looks at EVERY live
// ticket naming the key, never a capped sample. A sample of 50 made only of
// tickets being freed hid the one live ticket that still named the key, and
// its file was deleted.

import { describe, it, expect } from "vitest";
import { keysOnOtherLiveTickets, KEY_TICKET_PAGE, KEY_TICKET_MAX_PAGES } from "@/lib/ticketShed";

type Row = { id: string; org_id: string; attachments: Array<{ url: string }>; archived_at: string | null };

/** A stand-in that honours the filters, the id order, gt and limit. */
function fakeDb(rows: Row[], opts: { error?: boolean } = {}) {
  const calls: Array<{ gt: string | null; limit: number | null }> = [];
  const from = () => {
    const f = { org: null as string | null, key: null as string | null, live: false, gt: null as string | null, limit: null as number | null, asc: false };
    const b = {
      select: () => b,
      eq: (c: string, v: string) => { if (c === "org_id") f.org = v; return b; },
      contains: (_c: string, v: string) => { f.key = (JSON.parse(v) as Array<{ url: string }>)[0].url; return b; },
      is: (c: string, v: unknown) => { if (c === "archived_at" && v === null) f.live = true; return b; },
      gt: (_c: string, v: string) => { f.gt = v; return b; },
      order: (_c: string, o: { ascending: boolean }) => { f.asc = o.ascending; return b; },
      limit: (n: number) => { f.limit = n; return b; },
      then: (ok: (v: unknown) => void) => {
        calls.push({ gt: f.gt, limit: f.limit });
        if (opts.error) return ok({ data: null, error: { message: "down" } });
        let out = rows.filter((r) => r.org_id === f.org && (!f.live || r.archived_at === null)
          && r.attachments.some((a) => a.url === f.key));
        if (f.asc) out = [...out].sort((a, b2) => a.id.localeCompare(b2.id));
        if (f.gt) out = out.filter((r) => r.id > f.gt!);
        if (f.limit != null) out = out.slice(0, f.limit);
        return ok({ data: out.map((r) => ({ id: r.id })), error: null });
      },
    };
    return b;
  };
  return { sb: { from } as never, calls };
}

const ORG = "11111111-1111-4111-8111-111111111111";
const KEY = `orgs/${ORG}/tickets/KE-1/1_copied.pdf`;
const pad = (n: number) => `t${String(n).padStart(5, "0")}`;

describe("AUTHZ-5 dw2 — every live ticket naming a key is looked at (fix pass 3)", () => {
  it("60 tickets being freed and ONE further live ticket name the key: the key is kept (the old 50-row sample missed it)", async () => {
    const freed = Array.from({ length: 60 }, (_, i) => pad(i));
    const rows: Row[] = [
      ...freed.map((id) => ({ id, org_id: ORG, attachments: [{ url: KEY }], archived_at: null })),
      { id: pad(99), org_id: ORG, attachments: [{ url: KEY }], archived_at: null },
    ];
    const { sb } = fakeDb(rows);
    expect([...(await keysOnOtherLiveTickets(sb, ORG, [KEY], new Set(freed)))]).toEqual([KEY]);
  });

  it("the live ticket on a later page is found by keyset paging", async () => {
    const freed = Array.from({ length: KEY_TICKET_PAGE * 2 + 5 }, (_, i) => pad(i));
    const rows: Row[] = [
      ...freed.map((id) => ({ id, org_id: ORG, attachments: [{ url: KEY }], archived_at: null })),
      { id: pad(KEY_TICKET_PAGE * 2 + 50), org_id: ORG, attachments: [{ url: KEY }], archived_at: null },
    ];
    const { sb, calls } = fakeDb(rows);
    expect((await keysOnOtherLiveTickets(sb, ORG, [KEY], new Set(freed))).has(KEY)).toBe(true);
    expect(calls.length).toBe(3);
    expect(calls[0]).toEqual({ gt: null, limit: KEY_TICKET_PAGE });
    expect(calls[1].gt).toBe(pad(KEY_TICKET_PAGE - 1));
  });

  it("only the tickets being freed (and archived ones) name it: the key may go", async () => {
    const freed = Array.from({ length: 60 }, (_, i) => pad(i));
    const rows: Row[] = [
      ...freed.map((id) => ({ id, org_id: ORG, attachments: [{ url: KEY }], archived_at: null })),
      { id: pad(99), org_id: ORG, attachments: [{ url: KEY }], archived_at: "2026-01-01T00:00:00Z" },
      { id: pad(98), org_id: "other", attachments: [{ url: KEY }], archived_at: null },
    ];
    const { sb } = fakeDb(rows);
    expect((await keysOnOtherLiveTickets(sb, ORG, [KEY], new Set(freed))).size).toBe(0);
  });

  it("a read error throws (nothing is deleted)", async () => {
    const { sb } = fakeDb([], { error: true });
    await expect(keysOnOtherLiveTickets(sb, ORG, [KEY], new Set())).rejects.toThrow(/refusing to delete/);
  });

  it("past the page bound it throws instead of guessing (fail closed)", async () => {
    const n = KEY_TICKET_PAGE * KEY_TICKET_MAX_PAGES;
    const freed = Array.from({ length: n }, (_, i) => pad(i));
    const rows: Row[] = freed.map((id) => ({ id, org_id: ORG, attachments: [{ url: KEY }], archived_at: null }));
    const { sb } = fakeDb(rows);
    await expect(keysOnOtherLiveTickets(sb, ORG, [KEY], new Set(freed))).rejects.toThrow(/could not be verified; refusing to delete/);
  });
});
