// lib/__tests__/aoRoundGP16RestoreTicketNumber.test.ts
//
// admin-and-org Round G, package P16 RESTORE TICKET NUMBER KEY — drafting-flow
// EDGE-5 done-when 1's remainder (assigned at the DF-P11 merge, DEC-31).
//
// A restored request never lands beside a live request under the same human
// number (tickets.ticket_id) in the same workspace. The restore refuses such a
// row LOUDLY, per row, naming the number and the live request that holds it
// (TICKET_NUMBER_IN_USE), and the rest of the table lands — whether or not
// the database carries a unique key on tickets (org_id, ticket_id)
// (supabase/schema.sql declares one inline; no migration before 20261244
// creates it, so a live database may lack it). DEC-90 ruling (3): a live
// request's number is never taken by a backup request (refused loudly — with
// the key, 125ca3b already refused it 23505). Ruling (4): every restore that
// works today restores the same rows (pinned below, both worlds). P16 fix
// pass: a row whose number an earlier row of the same request carries is
// judged AFTER the write, so a first carrier the database refuses no longer
// takes the second down with it; and the number read is cut by URL budget,
// with a number carrying `"` or `\` read by its own eq filter. P16 fix pass 2
// (the review): a backup that ITSELF carries one number on two requests (a
// database without the key) no longer loses the second — it is restored under
// a fresh number taken from ticket_number_counters as the service role (a
// guarded compare-and-set), the number it was issued kept in
// metadata.restore_renumbered and in the chunk's `cleared` notes
// (TICKET_RENUMBERED, RESTORE_CHUNK audit row); the page's driver sends every
// request carrying one number in one request so this holds across chunks.
//
// The routes run for real against the in-memory engine (restoreMemoryDb):
// `db.keys.tickets` unset is the world WITHOUT the number key (only the id
// primary key); `[["id"], ["org_id", "ticket_id"]]` is the world WITH it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { db, from, type Row } from "./helpers/restoreMemoryDb";

vi.mock("@/lib/serverAuth", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  return {
    authorizeOrgRole: vi.fn(async (_req: unknown, orgId: string) => ({
      userId: "admin-1", email: "admin@x.io", orgId, role: "Admin", roles: ["Admin"], admin: { from: mem.from },
    })),
  };
});

import { POST as applyTable } from "@/app/api/admin/restore/apply-table/route";
import { POST as beginRoute } from "@/app/api/admin/restore/begin/route";
import {
  applyRestoreChunk, planRestore, runChunkedRestore, restoreRefusalLabel, restoreSlices, groupTicketsByNumber,
  TICKET_NUMBER_IN_USE, TICKET_RENUMBERED,
  type RestorePost, type RestoreEnvelopeLike,
} from "@/lib/dataRestore";

const ORG = "org-1";
const OTHER = "other-org";
const NUMBER_KEY: string[][] = [["id"], ["org_id", "ticket_id"]];
const IN_USE = TICKET_NUMBER_IN_USE;
const RENUMBERED = TICKET_RENUMBERED;
/** The year a fresh number is issued under (the current year, as a request filed now). */
const YEAR = new Date().getFullYear();
const YY = String(YEAR).slice(-2);
const counterHere = () => rowsOf("ticket_number_counters").find((c) => c.org_id === ORG && c.year === YEAR);

const post = (path: string, body: unknown) =>
  new NextRequest(`https://app${path}?orgId=${ORG}`, {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
  });
async function chunk(table: string, rows: Row[]) {
  const res = await applyTable(post("/api/admin/restore/apply-table", { table, rows, idRemap: { orgId: { "backup-org": ORG }, uid: {} }, manifest: { orgId: "backup-org" } }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const routePost: RestorePost = async (path, body) => {
  const req = new NextRequest(`https://app${path}`, {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const handler = path.startsWith("/api/admin/restore/begin") ? beginRoute : applyTable;
  const res = await handler(req);
  return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};
const planFor = (envelope: RestoreEnvelopeLike) => planRestore(envelope, { orgId: ORG, orgName: "Acme", members: [] });
const rowsOf = (t: string) => db.rows[t] ?? [];
const ticketsHere = () => rowsOf("tickets").filter((t) => t.org_id === ORG);
/** Every number held by more than one request of this workspace. */
const numbersIssuedTwice = () => {
  const seen = new Map<string, number>();
  for (const t of ticketsHere()) seen.set(String(t.ticket_id), (seen.get(String(t.ticket_id)) ?? 0) + 1);
  return Array.from(seen).filter(([, n]) => n > 1).map(([k]) => k);
};
const ticket = (id: string, num: string, org = "backup-org", extra: Row = {}): Row => ({ id, org_id: org, ticket_id: num, title: `Request ${num}`, status: "CLOSED", ...extra });

beforeEach(() => {
  db.rows = { orgs: [{ id: ORG, name: "Acme" }, { id: OTHER, name: "Other plant" }], org_members: [] };
  db.keys = {};
  db.writeError = null;
  db.readError = {};
  db.writes = [];
  db.attempts = [];
  db.countless = false;
  db.fks = {};
  db.maxRows = 1000;
  db.generated = {};
  db.authUsers = null;
});

for (const world of ["without the number key", "with the number key"] as const) {
  const withKey = world === "with the number key";
  describe(`EDGE-5 — a colliding request number is refused loudly, per row, ${world}`, () => {
    beforeEach(() => {
      if (withKey) db.keys.tickets = NUMBER_KEY;
      db.keys.ticket_number_counters = [["org_id", "year"]];
    });

    it("the plant-merge case: a backup request whose number a live request here holds is refused, named; the rest of the table lands; no number is ever held twice", async () => {
      db.rows.tickets = [ticket("t-live-1", "KE-DDRT-26-0001", ORG, { title: "Plant A's request" })];
      const r = await chunk("tickets", [ticket("t-b-1", "KE-DDRT-26-0001"), ticket("t-b-2", "KE-DDRT-26-0401")]);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ inserted: 1 });
      expect(ticketsHere().map((t) => t.id).sort()).toEqual(["t-b-2", "t-live-1"]);
      expect(numbersIssuedTwice()).toEqual([]);
      // the live request is kept exactly as it is
      expect(ticketsHere().find((t) => t.id === "t-live-1")).toMatchObject({ ticket_id: "KE-DDRT-26-0001", title: "Plant A's request" });
      expect(IN_USE).toBe("ticket_number_in_use");
      expect(r.body.refused).toEqual([{
        id: "t-b-1", code: IN_USE,
        message: expect.stringMatching(/^request number "KE-DDRT-26-0001" is already held in this workspace by request t-live-1 — not restored/),
      }]);
      // the refusal is in the chunk's audit row, with its number
      const trail = rowsOf("audit_logs").filter((a) => a.action === "RESTORE_CHUNK");
      expect(JSON.stringify(trail[0].details)).toContain("KE-DDRT-26-0001");
      // never by bisection: the write never sent the colliding row
      expect(db.attempts.filter((a) => a.table === "tickets")).toHaveLength(1);
    });

    it("the same number in ANOTHER workspace is not a collision — numbers are per workspace", async () => {
      db.rows.tickets = [ticket("t-other", "KE-DDRT-26-0001", OTHER)];
      const r = await chunk("tickets", [ticket("t-b-1", "KE-DDRT-26-0001")]);
      expect(r.body).toEqual({ ok: true, inserted: 1 });
      expect(ticketsHere().map((t) => t.id)).toEqual(["t-b-1"]);
    });

    it("a re-run of the same restore: the requests it restored are kept (existing), never refused as their own collision", async () => {
      const rows = [ticket("t-b-1", "KE-DDRT-26-0001"), ticket("t-b-2", "KE-DDRT-26-0002")];
      expect((await chunk("tickets", rows)).body).toEqual({ ok: true, inserted: 2 });
      const again = await chunk("tickets", rows);
      expect(again.body).toMatchObject({ ok: true, inserted: 0, existing: 2 });
      expect(again.body.refused).toBeUndefined();
      expect(ticketsHere()).toHaveLength(2);
    });

    it("two backup requests sharing one number in ONE chunk (P16 fix pass 2): the first lands as it is; the second lands under a FRESH number, the number it was issued recorded on the row, in the chunk's notes and its audit row — never refused, never two requests under one number", async () => {
      const r = await chunk("tickets", [ticket("t-b-1", "KE-DDRT-26-0007"), ticket("t-b-2", "KE-DDRT-26-0007"), ticket("t-b-3", "KE-DDRT-26-0008")]);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, inserted: 3 });
      expect(r.body.refused).toBeUndefined();
      expect(ticketsHere().map((t) => [t.id, t.ticket_id])).toEqual([["t-b-1", "KE-DDRT-26-0007"], ["t-b-3", "KE-DDRT-26-0008"], ["t-b-2", `DDRT-${YY}-0001`]]);
      expect(ticketsHere().find((t) => t.id === "t-b-2")!.metadata).toEqual({
        restore_renumbered: { from: "KE-DDRT-26-0007", to: `DDRT-${YY}-0001`, number_held_by: "t-b-1", at: expect.any(String) },
      });
      expect(r.body.cleared).toEqual([{
        id: "t-b-2", code: RENUMBERED,
        message: expect.stringMatching(new RegExp(`^ticket_id "KE-DDRT-26-0007" → "DDRT-${YY}-0001": request t-b-1 of this backup carries "KE-DDRT-26-0007" and was restored first`)),
      }]);
      // the number was taken from the workspace's counter (created at 1 for the year)
      expect(counterHere()).toMatchObject({ next_seq: 1 });
      // the RESTORE_CHUNK audit row carries the old and the new number
      const trail = rowsOf("audit_logs").filter((a) => a.action === "RESTORE_CHUNK");
      expect(JSON.stringify(trail[0].details)).toContain(`ticket_id \\"KE-DDRT-26-0007\\" → \\"DDRT-${YY}-0001\\"`);
      expect(numbersIssuedTwice()).toEqual([]);
    });

    it("…the fresh number uses the workspace's own prefix, record code and pad, and the counter's next number; other metadata is kept", async () => {
      db.rows.orgs[0] = { ...db.rows.orgs[0], ticket_prefix: "AC", ticket_record_code: "DDRT", ticket_number_pad: 5 };
      db.rows.ticket_number_counters = [{ org_id: ORG, year: YEAR, next_seq: 41 }, { org_id: OTHER, year: YEAR, next_seq: 900 }];
      const r = await chunk("tickets", [ticket("t-b-1", "KE-DDRT-26-0007"), ticket("t-b-2", "KE-DDRT-26-0007", "backup-org", { metadata: { source_document: { id: "doc-1" } } })]);
      expect(r.body).toMatchObject({ ok: true, inserted: 2 });
      const second = ticketsHere().find((t) => t.id === "t-b-2")!;
      expect(second.ticket_id).toBe(`AC-DDRT-${YY}-00042`);
      expect(second.metadata).toEqual({ source_document: { id: "doc-1" }, restore_renumbered: expect.objectContaining({ from: "KE-DDRT-26-0007", to: `AC-DDRT-${YY}-00042` }) });
      expect(counterHere()).toMatchObject({ next_seq: 42 });
      // another workspace's counter is untouched
      expect(rowsOf("ticket_number_counters").find((c) => c.org_id === OTHER)).toMatchObject({ next_seq: 900 });
    });

    it("…a fresh number some request already carries is skipped (a gap), never issued twice", async () => {
      db.rows.tickets = [ticket("t-live", `DDRT-${YY}-0001`, ORG)];
      const r = await chunk("tickets", [ticket("t-b-1", "KE-DDRT-26-0007"), ticket("t-b-2", "KE-DDRT-26-0007")]);
      expect(r.body).toMatchObject({ ok: true, inserted: 2 });
      expect(ticketsHere().find((t) => t.id === "t-b-2")!.ticket_id).toBe(`DDRT-${YY}-0002`);
      expect(counterHere()).toMatchObject({ next_seq: 2 });
      expect(numbersIssuedTwice()).toEqual([]);
    });

    it("…a counter that keeps moving under the compare-and-set: after the bounded attempts the request is refused (nothing of it written), the rest lands", async () => {
      db.rows.ticket_number_counters = [{ org_id: ORG, year: YEAR, next_seq: 5 }];
      const sb = { from: (t: string) => {
        const b = from(t) as Record<string, (...a: unknown[]) => unknown>;
        if (t === "ticket_number_counters") {
          // a concurrent filer wins every race: the guarded update matches no row
          const origEq = b.eq;
          b.eq = (c: unknown, v: unknown) => (c === "next_seq" ? origEq(c, -1) : origEq(c, v));
        }
        return b;
      } };
      const r = await applyRestoreChunk(sb as never, { orgId: ORG, table: "tickets", rows: [ticket("t-b-1", "KE-DDRT-26-0007"), ticket("t-b-2", "KE-DDRT-26-0007")], idRemap: { orgId: { "backup-org": ORG }, uid: {} } });
      expect(r.ok).toBe(true);
      expect(r.inserted).toBe(1);
      expect(r.refused).toEqual([{ id: "t-b-2", code: IN_USE, message: expect.stringMatching(/^request number "KE-DDRT-26-0007" is also carried by request t-b-1 of this backup, which was restored first — this request was to be restored under a fresh number, but none could be taken now \(8 numbers were tried.*Run the restore again: a re-run renumbers it$/) }]);
      expect(ticketsHere().map((t) => t.id)).toEqual(["t-b-1"]);
      expect(counterHere()).toMatchObject({ next_seq: 5 });
    });

    it("…a counter that cannot be read stops the chunk with what was written counted — never a number on a guess", async () => {
      db.readError.ticket_number_counters = "permission denied";
      const r = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", rows: [ticket("t-b-1", "KE-DDRT-26-0007"), ticket("t-b-2", "KE-DDRT-26-0007")], idRemap: { orgId: { "backup-org": ORG }, uid: {} } });
      expect(r).toMatchObject({ ok: false, status: 500, inserted: 1, error: expect.stringMatching(/^Could not give request t-b-2 a fresh number \(another request of this backup holds "KE-DDRT-26-0007"\): the request number counter could not be read: permission denied/) });
      expect(ticketsHere().map((t) => t.id)).toEqual(["t-b-1"]);
    });

    it("…numbering settings that cannot be read stop the chunk the same way", async () => {
      db.readError.orgs = "permission denied";
      const r = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", rows: [ticket("t-b-1", "KE-DDRT-26-0007"), ticket("t-b-2", "KE-DDRT-26-0007")], idRemap: { orgId: { "backup-org": ORG }, uid: {} } });
      expect(r).toMatchObject({ ok: false, status: 500, inserted: 1, error: expect.stringContaining("the workspace's numbering settings could not be read: permission denied") });
    });

    it("…a re-run adds nothing and takes no second number (both requests are kept on their ids)", async () => {
      const rows = [ticket("t-b-1", "KE-DDRT-26-0007"), ticket("t-b-2", "KE-DDRT-26-0007")];
      expect((await chunk("tickets", rows)).body).toMatchObject({ ok: true, inserted: 2 });
      const again = await chunk("tickets", rows);
      expect(again.body).toMatchObject({ ok: true, inserted: 0, existing: 2 });
      expect(again.body.refused).toBeUndefined();
      expect(again.body.cleared).toBeUndefined();
      expect(counterHere()).toMatchObject({ next_seq: 1 });
      expect(ticketsHere()).toHaveLength(2);
    });

    it("…a re-run after a run that wrote only the first: the first is kept, the second is renumbered — never refused as a live collision", async () => {
      db.rows.tickets = [ticket("t-b-1", "KE-DDRT-26-0007", ORG)];
      const r = await chunk("tickets", [ticket("t-b-1", "KE-DDRT-26-0007"), ticket("t-b-2", "KE-DDRT-26-0007")]);
      expect(r.body).toMatchObject({ ok: true, inserted: 1, existing: 1, cleared: [expect.objectContaining({ id: "t-b-2", code: RENUMBERED })] });
      expect(r.body.refused).toBeUndefined();
      expect(ticketsHere().find((t) => t.id === "t-b-2")!.ticket_id).toBe(`DDRT-${YY}-0001`);
    });

    it("…and when the database refuses the FIRST carrier, the second is written in its place — never both lost, never a message naming a request that was not restored", async () => {
      db.writeError = (table, op, rows) => (table === "tickets" && op === "upsert" && rows.some((x) => x.id === "t-b-1")
        ? { code: "23514", message: 'new row for relation "tickets" violates check constraint "tickets_status_check"' } : null);
      const r = await chunk("tickets", [ticket("t-b-1", "KE-DDRT-26-0007"), ticket("t-b-2", "KE-DDRT-26-0007"), ticket("t-b-3", "KE-DDRT-26-0008")]);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ inserted: 2 });
      expect(ticketsHere().map((t) => t.id).sort()).toEqual(["t-b-2", "t-b-3"]);
      expect(r.body.refused).toEqual([expect.objectContaining({ id: "t-b-1", code: "23514" })]);
      expect(numbersIssuedTwice()).toEqual([]);
    });

    it("…three carriers of one number, the first refused by the database: the second is written as it is, the third under a fresh number", async () => {
      db.writeError = (table, op, rows) => (table === "tickets" && op === "upsert" && rows.some((x) => x.id === "t-b-1")
        ? { code: "23514", message: "refused by a check" } : null);
      const r = await chunk("tickets", [ticket("t-b-1", "KE-DDRT-26-0007"), ticket("t-b-2", "KE-DDRT-26-0007"), ticket("t-b-3", "KE-DDRT-26-0007")]);
      expect(ticketsHere().map((t) => [t.id, t.ticket_id])).toEqual([["t-b-2", "KE-DDRT-26-0007"], ["t-b-3", `DDRT-${YY}-0001`]]);
      expect(r.body.refused).toEqual([expect.objectContaining({ id: "t-b-1", code: "23514" })]);
      expect(r.body.cleared).toEqual([expect.objectContaining({ id: "t-b-3", code: RENUMBERED, message: expect.stringContaining("request t-b-2 of this backup carries") })]);
      expect(numbersIssuedTwice()).toEqual([]);
    });

    it("…when the bisect budget runs out on the first carrier, the second is still judged after the write and lands", async () => {
      // every statement carrying t-b-1 is refused, and the budget is spent on
      // earlier rows, so t-b-1 is refused with its statement's rows
      const many = Array.from({ length: 120 }, (_, i) => ticket(`t-x-${String(i).padStart(3, "0")}`, `KE-DDRT-26-${String(1000 + i)}`));
      db.writeError = (table, op, rows) => (table === "tickets" && op === "upsert" && rows.length > 0 && rows.some((x) => x.id === "t-b-1" || String(x.id).startsWith("t-x-"))
        ? { code: "23514", message: "refused by a check" } : null);
      const r = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", rows: [...many, ticket("t-b-1", "KE-DDRT-26-0007"), ticket("t-b-2", "KE-DDRT-26-0007")], idRemap: { orgId: { "backup-org": ORG }, uid: {} } });
      expect(r.ok).toBe(true);
      expect(r.refused.find((x) => x.id === "t-b-1")).toBeTruthy();
      expect(r.refused.find((x) => x.id === "t-b-2")).toBeUndefined();
      expect(ticketsHere().map((t) => t.id)).toEqual(["t-b-2"]);
    });

    it("…a re-check that fails after the write stops the chunk with what was written counted; the held-back row is not written on a guess", async () => {
      const sb = { from: (t: string) => {
        const b = from(t) as Record<string, unknown>;
        if (t === "tickets") {
          const orig = b.then as (res: (v: unknown) => void, rej: (e: unknown) => void) => void;
          b.then = (res: (v: unknown) => void, rej: (e: unknown) => void) => {
            // every tickets read before the first write runs; the first read after it is the re-check
            if (!db.attempts.some((a) => a.table === "tickets")) return orig(res, rej);
            res({ data: null, error: { code: "XX000", message: "connection reset" } });
          };
        }
        return b;
      } };
      const r = await applyRestoreChunk(sb as never, { orgId: ORG, table: "tickets", rows: [ticket("t-b-1", "KE-DDRT-26-0007"), ticket("t-b-2", "KE-DDRT-26-0007")], idRemap: { orgId: { "backup-org": ORG }, uid: {} } });
      expect(r).toMatchObject({ ok: false, status: 500, inserted: 1, error: expect.stringMatching(/^Could not re-check the request numbers this restore has just written: connection reset/) });
      expect(ticketsHere().map((t) => t.id)).toEqual(["t-b-1"]);
    });

    it("…and across requests sent separately (not the page's driver): a later request's row whose number an earlier one restored is refused, naming the page's re-run as the remedy — and that re-run renumbers it", async () => {
      await chunk("tickets", [ticket("t-b-1", "KE-DDRT-26-0007")]);
      const r = await chunk("tickets", [ticket("t-b-2", "KE-DDRT-26-0007")]);
      expect(r.body.refused).toEqual([{
        id: "t-b-2", code: IN_USE,
        message: expect.stringContaining("If request t-b-1 came from this same backup (a restore that sent the two requests separately), run the restore again from the restore page: it sends every request carrying one number together, and the second is then restored under a fresh number"),
      }]);
      expect(numbersIssuedTwice()).toEqual([]);
      // the remedy: the page's driver sends both in one request
      const env: RestoreEnvelopeLike = { manifest: { orgId: "backup-org" }, tables: { tickets: [ticket("t-b-1", "KE-DDRT-26-0007"), ticket("t-b-2", "KE-DDRT-26-0007")] } };
      const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
      expect(run).toMatchObject({ stoppedAt: null, totalRefused: 0, totalInserted: 1, totalExisting: 1 });
      expect(ticketsHere().map((t) => t.id).sort()).toEqual(["t-b-1", "t-b-2"]);
      expect(numbersIssuedTwice()).toEqual([]);
    });

    it("a colliding request whose id another workspace already holds is counted held elsewhere, as today — never refused", async () => {
      db.rows.tickets = [ticket("t-live-1", "KE-DDRT-26-0001", ORG), ticket("t-b-1", "XX-DDRT-26-0099", OTHER)];
      const r = await chunk("tickets", [ticket("t-b-1", "KE-DDRT-26-0001")]);
      expect(r.body).toMatchObject({ ok: true, inserted: 0, heldElsewhere: 1 });
      expect(r.body.refused).toBeUndefined();
    });

    it("the live numbers are read page by page — a server row cap cannot hide a collision", async () => {
      db.maxRows = 2;
      db.rows.tickets = [
        ticket("t-live-a", "KE-DDRT-26-0001", ORG), ticket("t-live-b", "KE-DDRT-26-0002", ORG), ticket("t-live-c", "KE-DDRT-26-0003", ORG),
      ];
      const r = await chunk("tickets", [ticket("t-b-1", "KE-DDRT-26-0001"), ticket("t-b-2", "KE-DDRT-26-0002"), ticket("t-b-3", "KE-DDRT-26-0003"), ticket("t-b-4", "KE-DDRT-26-0004")]);
      expect((r.body.refused as unknown[]).map((x) => (x as { id: string }).id)).toEqual(["t-b-1", "t-b-2", "t-b-3"]);
      expect(ticketsHere().map((t) => t.id).sort()).toEqual(["t-b-4", "t-live-a", "t-live-b", "t-live-c"]);
    });

    it("a number carrying a double quote, a backslash or a comma is still checked — never sent in a malformed in-list (read with its own eq filter)", async () => {
      const quoted = 'KE-"26",0001';
      const slashed = "KE\\26\\0002";
      const comma = "KE-26,0003";
      db.rows.tickets = [ticket("t-live-q", quoted, ORG), ticket("t-live-s", slashed, ORG), ticket("t-live-c", comma, ORG)];
      const inLists: unknown[][] = [];
      const eqs: unknown[] = [];
      const sb = { from: (t: string) => {
        const b = from(t) as Record<string, (...a: unknown[]) => unknown>;
        if (t === "tickets") {
          const origIn = b.in; const origEq = b.eq;
          b.in = (c: unknown, vs: unknown) => { if (c === "ticket_id") inLists.push(vs as unknown[]); return origIn(c, vs); };
          b.eq = (c: unknown, v: unknown) => { if (c === "ticket_id") eqs.push(v); return origEq(c, v); };
        }
        return b;
      } };
      const r = await applyRestoreChunk(sb as never, { orgId: ORG, table: "tickets", rows: [ticket("t-b-q", quoted), ticket("t-b-s", slashed), ticket("t-b-c", comma), ticket("t-b-ok", "KE-26-0004")], idRemap: { orgId: { "backup-org": ORG }, uid: {} } });
      expect(r.ok).toBe(true);
      expect(r.refused.map((x) => x.id).sort()).toEqual(["t-b-c", "t-b-q", "t-b-s"]);
      expect(ticketsHere().filter((t) => String(t.id).startsWith("t-b-")).map((t) => t.id)).toEqual(["t-b-ok"]);
      expect(inLists.flat().some((v) => /["\\]/.test(String(v)))).toBe(false);
      expect(inLists.flat()).toEqual(expect.arrayContaining([comma, "KE-26-0004"]));
      expect(Array.from(new Set(eqs)).sort()).toEqual([quoted, slashed].sort());
      expect(numbersIssuedTwice()).toEqual([]);
    });

    it("the number read keeps each in-list inside the URL budget (businessKeyReadBatches), however long the numbers", async () => {
      const long = (i: number) => `KE-${"X".repeat(200)}-${String(i).padStart(4, "0")}`;
      db.rows.tickets = [ticket("t-live-last", long(149), ORG)];
      const inLists: unknown[][] = [];
      const sb = { from: (t: string) => {
        const b = from(t) as Record<string, (...a: unknown[]) => unknown>;
        if (t === "tickets") { const origIn = b.in; b.in = (c: unknown, vs: unknown) => { if (c === "ticket_id") inLists.push(vs as unknown[]); return origIn(c, vs); }; }
        return b;
      } };
      const rows = Array.from({ length: 150 }, (_, i) => ticket(`t-b-${i}`, long(i)));
      const r = await applyRestoreChunk(sb as never, { orgId: ORG, table: "tickets", rows, idRemap: { orgId: { "backup-org": ORG }, uid: {} } });
      expect(r.ok).toBe(true);
      expect(r.refused).toEqual([expect.objectContaining({ id: "t-b-149", code: IN_USE })]);
      expect(inLists.length).toBeGreaterThan(5);
      for (const list of inLists) expect(list.reduce<number>((sum, v) => sum + encodeURIComponent(String(v)).length + 3, 0)).toBeLessThanOrEqual(6000);
      expect(new Set(inLists.flat()).size).toBe(150);
    });

    it("a check that cannot read the live numbers fails the chunk closed — nothing is written on a guess", async () => {
      db.readError.tickets = "permission denied";
      const r = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", rows: [ticket("t-b-1", "KE-DDRT-26-0001")], idRemap: { orgId: { "backup-org": ORG }, uid: {} } });
      expect(r).toMatchObject({ ok: false, status: 500, inserted: 0, error: expect.stringMatching(/^Could not check the request numbers this workspace already holds: permission denied/) });
      expect(db.attempts.filter((a) => a.table === "tickets")).toEqual([]);
    });

    it("through the page's driver: the run does not stop, the refusal is reported with its id, and the comments of the refused request are refused with it while the others land", async () => {
      db.rows.tickets = [ticket("t-live-1", "KE-DDRT-26-0001", ORG)];
      const env: RestoreEnvelopeLike = {
        manifest: { orgId: "backup-org" },
        tables: {
          tickets: [ticket("t-b-1", "KE-DDRT-26-0001"), ticket("t-b-2", "KE-DDRT-26-0402")],
          ticket_comments: [{ id: "c-1", org_id: "backup-org", ticket_id: "t-b-1", body: "on the refused one" }, { id: "c-2", org_id: "backup-org", ticket_id: "t-b-2", body: "kept" }],
        },
      };
      const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
      expect(run.stoppedAt).toBeNull();
      const t = run.tables.find((x) => x.name === "tickets")!;
      expect(t).toMatchObject({ inserted: 1, refused: [expect.objectContaining({ id: "t-b-1", code: IN_USE })] });
      expect(run.tables.find((x) => x.name === "ticket_comments")).toMatchObject({ inserted: 1, refused: [expect.objectContaining({ id: "c-1", code: "parent_outside_workspace" })] });
      expect(rowsOf("ticket_comments").map((c) => c.id)).toEqual(["c-2"]);
      expect(numbersIssuedTwice()).toEqual([]);
    });
  });
}

describe("DEC-90 ruling (4) — every restore that works today restores the same rows", () => {
  const backup = (): RestoreEnvelopeLike => ({
    manifest: { orgId: "backup-org" },
    tables: {
      ticket_number_counters: [{ org_id: "backup-org", year: 2026, next_seq: 3 }],
      tickets: [ticket("t-1", "KE-DDRT-26-0001"), ticket("t-2", "KE-DDRT-26-0002"), ticket("t-3", "KE-DDRT-26-0003", "backup-org", { archived_at: "2026-05-01T00:00:00Z" })],
      ticket_comments: [{ id: "c-1", org_id: "backup-org", ticket_id: "t-1", body: "a" }, { id: "c-2", org_id: "backup-org", ticket_id: "t-2", body: "b" }],
    },
  });
  for (const withKey of [false, true]) {
    it(`into an empty workspace (${withKey ? "with" : "without"} the number key): every request and comment lands, nothing is refused, and a re-run adds nothing`, async () => {
      db.keys.ticket_number_counters = [["org_id", "year"]];
      if (withKey) db.keys.tickets = NUMBER_KEY;
      const env = backup();
      const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
      expect(run).toMatchObject({ stoppedAt: null, totalRefused: 0, totalInserted: 6 });
      expect(ticketsHere().map((t) => [t.id, t.ticket_id])).toEqual([["t-1", "KE-DDRT-26-0001"], ["t-2", "KE-DDRT-26-0002"], ["t-3", "KE-DDRT-26-0003"]]);
      expect(rowsOf("ticket_comments").map((c) => c.id)).toEqual(["c-1", "c-2"]);
      const again = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
      expect(again).toMatchObject({ stoppedAt: null, totalRefused: 0, totalInserted: 0, totalExisting: 6 });
    });
  }

  it("into a workspace whose live numbers do not overlap the backup's: every request lands beside them, and the counter is still raised past the restored numbers", async () => {
    db.keys.ticket_number_counters = [["org_id", "year"]];
    db.rows.ticket_number_counters = [{ org_id: ORG, year: 2026, next_seq: 1 }];
    db.rows.tickets = [ticket("t-live", "AC-DDRT-26-0001", ORG)];
    const env = backup();
    const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
    expect(run).toMatchObject({ stoppedAt: null, totalRefused: 0, totalAdvanced: 1 });
    expect(ticketsHere()).toHaveLength(4);
    expect(rowsOf("ticket_number_counters")[0].next_seq).toBe(3);
  });

  for (const withKey of [false, true]) {
    it(`a backup that ITSELF carries one number on two requests (${withKey ? "with" : "without"} the number key; P16 fix pass 2 — the review's disaster-recovery case): BOTH requests and all their comments land, the second request under a fresh number with the number it was issued recorded — ruling (4) holds`, async () => {
      db.keys.ticket_number_counters = [["org_id", "year"]];
      if (withKey) db.keys.tickets = NUMBER_KEY;
      const env: RestoreEnvelopeLike = {
        manifest: { orgId: "backup-org" },
        tables: {
          tickets: [ticket("t-1", "KE-DDRT-26-0001"), ticket("t-1b", "KE-DDRT-26-0001"), ticket("t-2", "KE-DDRT-26-0002")],
          ticket_comments: [{ id: "c-1", org_id: "backup-org", ticket_id: "t-1", body: "a" }, { id: "c-1b", org_id: "backup-org", ticket_id: "t-1b", body: "b" }],
        },
      };
      const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
      expect(run).toMatchObject({ stoppedAt: null, totalRefused: 0 });
      expect(ticketsHere().map((t) => [t.id, t.ticket_id])).toEqual([["t-1", "KE-DDRT-26-0001"], ["t-2", "KE-DDRT-26-0002"], ["t-1b", `DDRT-${YY}-0001`]]);
      expect(ticketsHere().find((t) => t.id === "t-1b")!.metadata).toMatchObject({ restore_renumbered: { from: "KE-DDRT-26-0001", to: `DDRT-${YY}-0001`, number_held_by: "t-1" } });
      expect(run.tables.find((x) => x.name === "tickets")).toMatchObject({ inserted: 3, refused: [], cleared: [expect.objectContaining({ id: "t-1b", code: RENUMBERED })] });
      expect(run.tables.find((x) => x.name === "ticket_comments")).toMatchObject({ inserted: 2, refused: [] });
      expect(rowsOf("ticket_comments").map((c) => c.id)).toEqual(["c-1", "c-1b"]);
      expect(numbersIssuedTwice()).toEqual([]);
    });
  }

  it("…and when the two requests sharing a number sit more than a chunk apart in the backup, the driver still sends them in one request — the second is renumbered, nothing refused", async () => {
    db.keys.ticket_number_counters = [["org_id", "year"]];
    const tickets = Array.from({ length: 620 }, (_, i) => ticket(`t-${String(i).padStart(3, "0")}`, `KE-DDRT-26-${String(i + 1).padStart(4, "0")}`));
    tickets[600] = ticket("t-dup", "KE-DDRT-26-0001");
    const env: RestoreEnvelopeLike = { manifest: { orgId: "backup-org" }, tables: { tickets } };
    const posted: string[][] = [];
    const spy: RestorePost = async (path, body) => {
      const b = body as { table?: string; rows?: Row[] };
      if (b.table === "tickets" && Array.isArray(b.rows)) posted.push(b.rows.map((r) => String(r.id)));
      return routePost(path, body);
    };
    const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: spy });
    expect(run).toMatchObject({ stoppedAt: null, totalRefused: 0, totalInserted: 620 });
    const withDup = posted.find((rows) => rows.includes("t-dup"))!;
    expect(withDup).toContain("t-000");
    expect(withDup.indexOf("t-dup")).toBe(withDup.indexOf("t-000") + 1);
    expect(posted.every((rows) => rows.length <= 500)).toBe(true);
    expect(ticketsHere().find((t) => t.id === "t-dup")!.ticket_id).toBe(`DDRT-${YY}-0001`);
    expect(numbersIssuedTwice()).toEqual([]);
  });

  it("a request row with no number is not judged by this rule (the database answers for it, as before)", async () => {
    db.writeError = (table, op, rows) => (table === "tickets" && op === "upsert" && rows.some((x) => x.ticket_id === undefined)
      ? { code: "23502", message: 'null value in column "ticket_id" violates not-null constraint' } : null);
    const r = await chunk("tickets", [{ id: "t-nonum", org_id: "backup-org", title: "x" }]);
    expect(r.body.refused).toEqual([expect.objectContaining({ id: "t-nonum", code: "23502" })]);
  });

  it("only the tickets table is judged: another table's rows are written exactly as before", async () => {
    db.rows.tickets = [ticket("t-live-1", "KE-DDRT-26-0001", ORG)];
    const r = await chunk("notes", [{ id: "n-1", org_id: "backup-org", ticket_id: "KE-DDRT-26-0001", body: "x" }]);
    expect(r.body).toEqual({ ok: true, inserted: 1 });
  });

  it("the restore page names the refusal and the renumbering", () => {
    expect(restoreRefusalLabel("ticket_number_in_use")).toMatch(/^a request whose number this workspace already uses for another request — not restored/);
    expect(RENUMBERED).toBe("ticket_renumbered");
    expect(restoreRefusalLabel(RENUMBERED)).toMatch(/^a request the backup carries under the same number as another request of the same backup — restored under a fresh number; the number it was issued is kept in its metadata \(restore_renumbered\)/);
  });
});

describe("EDGE-5 (P16 fix pass 2) — the driver keeps every request carrying one number in one request", () => {
  const r = (id: string, n: string | null): Row => ({ id, ...(n === null ? {} : { ticket_id: n }) });
  const ids = (rows: Row[][]) => rows.map((x) => x.map((y) => y.id));
  const key = (x: Row) => (typeof x.ticket_id === "string" && x.ticket_id ? x.ticket_id : null);

  it("groupTicketsByNumber brings a number's requests together after the first of them, the order otherwise kept; a backup with no number twice is unchanged", () => {
    expect(groupTicketsByNumber([r("a", "1"), r("b", "2"), r("c", null), r("d", "1"), r("e", "3"), r("f", "2")]).map((x) => x.id)).toEqual(["a", "d", "b", "f", "c", "e"]);
    const plain = [r("a", "1"), r("b", null), r("c", "2")];
    expect(groupTicketsByNumber(plain)).toEqual(plain);
  });

  it("restoreSlices with a run key never splits a run that fits; without one, or without runs, the slices are exactly as before", () => {
    const rows = [r("a", "1"), r("b", "2"), r("c", "2"), r("d", "3")];
    const body = (slice: Row[]) => ({ rows: slice });
    expect(ids(restoreSlices(rows, body, 2))).toEqual([["a", "b"], ["c", "d"]]);
    expect(ids(restoreSlices(rows, body, 2, undefined, key))).toEqual([["a"], ["b", "c"], ["d"]]);
    const distinct = [r("a", "1"), r("b", "2"), r("c", "3"), r("d", null), r("e", null)];
    expect(restoreSlices(distinct, body, 2, undefined, key)).toEqual(restoreSlices(distinct, body, 2));
    // a run longer than a slice is cut as rows are
    const long = [r("a", "9"), r("b", "9"), r("c", "9")];
    expect(ids(restoreSlices(long, body, 2, undefined, key))).toEqual([["a", "b"], ["c"]]);
  });

  it("…and the byte budget is honoured for a run (a run that fits starts a fresh slice when the current one cannot take it)", () => {
    const big = (id: string, n: string) => ({ id, ticket_id: n, pad: "x".repeat(300) });
    const rows = [big("a", "1"), big("b", "2"), big("c", "2")];
    const body = (slice: Row[]) => ({ rows: slice });
    const one = JSON.stringify(big("a", "1")).length;
    const budget = JSON.stringify(body([])).length + 2 * one + 4;
    expect(ids(restoreSlices(rows, body, 500, budget))).toEqual([["a", "b"], ["c"]]);
    expect(ids(restoreSlices(rows, body, 500, budget, key))).toEqual([["a"], ["b", "c"]]);
  });
});
