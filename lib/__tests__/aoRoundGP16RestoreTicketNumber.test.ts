// lib/__tests__/aoRoundGP16RestoreTicketNumber.test.ts
//
// admin-and-org Round G, package P16 RESTORE TICKET NUMBER KEY — drafting-flow
// EDGE-5 done-when 1's remainder (assigned at the DF-P11 merge, DEC-31).
//
// A restored request never lands beside a live request under the same human
// number (tickets.ticket_id) in the same workspace — whether or not the
// database carries a unique key on tickets (org_id, ticket_id)
// (supabase/schema.sql declares one inline; no migration before 20261244
// creates it, so a live database may lack it). The implementation first
// refused such a row (TICKET_NUMBER_IN_USE); P16 fix pass 3 (the review,
// DEC-90 ruling (3)'s decision rule: re-mint once the counter path is safe
// and tested) restores it under a FRESH number instead, the holder kept as it
// is, so ruling (4) — every restore that works today restores the same rows —
// holds in both worlds (pinned below); TICKET_NUMBER_IN_USE is left for a
// fresh number that cannot be taken now. P16 fix
// pass: a row whose number an earlier row of the same request carries is
// judged AFTER the write, so a first carrier the database refuses no longer
// takes the second down with it; and the number read is cut by URL budget,
// with a number carrying `"` or `\` read by its own eq filter. P16 fix pass 2
// (the review): a backup that ITSELF carries one number on two requests (a
// database without the key) no longer loses the second — it is restored under
// a fresh number taken from ticket_number_counters as the service role (a
// guarded compare-and-set), the number it was issued kept in
// metadata.restore_renumbered and in the chunk's `cleared` notes
// (TICKET_RENUMBERED, RESTORE_CHUNK audit row). P16 fix pass 3 (the review):
// the request's history gets a "Renumbered on restore" entry; the fresh
// number is issued in the year of the number it replaces; the page's driver
// sends a request whose number an earlier one carries last and raises the
// backup's ticket counters to its highest number, so a fresh number never
// repeats one still to come; the chunk and the driver report each
// renumbering (renumbered: old → new); a renumbered request's files keep
// their storage keys under the old number's folder (drafting-flow EDGE-19).
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
  applyRestoreChunk, planRestore, runChunkedRestore, restoreRefusalLabel, ticketsInRestoreOrder,
  raiseTicketCountersToBackupNumbers, restoreNumberYear, renumberedOf,
  TICKET_NUMBER_IN_USE, TICKET_RENUMBERED,
  type RestorePost, type RestoreEnvelopeLike,
} from "@/lib/dataRestore";

const ORG = "org-1";
const OTHER = "other-org";
const NUMBER_KEY: string[][] = [["id"], ["org_id", "ticket_id"]];
const IN_USE = TICKET_NUMBER_IN_USE;
const RENUMBERED = TICKET_RENUMBERED;
/** The year a fresh number is issued in: the year of the number it replaces
 *  (P16 fix pass 3) — every fixture number below carries "-26-". */
const YEAR = 2026;
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
  describe(`EDGE-5 — a colliding request number is never held twice: the backup request is renumbered, ${world}`, () => {
    beforeEach(() => {
      if (withKey) db.keys.tickets = NUMBER_KEY;
      db.keys.ticket_number_counters = [["org_id", "year"]];
    });

    it("the plant-merge case (P16 fix pass 3): a backup request whose number a live request here holds lands under a FRESH number — never beside it, never refused; the live request is kept as it is; the number it was issued is on the row, in its history, in the chunk's notes and its audit row", async () => {
      db.rows.tickets = [ticket("t-live-1", "KE-DDRT-26-0001", ORG, { title: "Plant A's request" })];
      const sent: Row[] = [];
      db.writeError = (table, op, rows) => { if (table === "tickets") sent.push(...rows); return null; };
      const created = { action: "Created", user: "b@x.io", date: "2026-02-01T00:00:00Z" };
      const r = await chunk("tickets", [ticket("t-b-1", "KE-DDRT-26-0001", "backup-org", { history: [created] }), ticket("t-b-2", "KE-DDRT-26-0401")]);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, inserted: 2 });
      expect(r.body.refused).toBeUndefined();
      expect(ticketsHere().map((t) => [t.id, t.ticket_id])).toEqual([["t-live-1", "KE-DDRT-26-0001"], ["t-b-2", "KE-DDRT-26-0401"], ["t-b-1", `DDRT-${YY}-0001`]]);
      expect(numbersIssuedTwice()).toEqual([]);
      // the live request is kept exactly as it is
      expect(ticketsHere().find((t) => t.id === "t-live-1")).toEqual(ticket("t-live-1", "KE-DDRT-26-0001", ORG, { title: "Plant A's request" }));
      const b1 = ticketsHere().find((t) => t.id === "t-b-1")!;
      expect(b1.metadata).toEqual({ restore_renumbered: { from: "KE-DDRT-26-0001", to: `DDRT-${YY}-0001`, number_held_by: "t-live-1", at: expect.any(String) } });
      // DEC-90 ruling (3): the restored request's HISTORY records its original number (the request page's timeline)
      expect(b1.history).toEqual([created, {
        action: "Renumbered on restore", user: "restore", date: (b1.metadata as { restore_renumbered: { at: string } }).restore_renumbered.at,
        details: `Issued as "KE-DDRT-26-0001"; request t-live-1 of this workspace carries that number, so this request was restored as "DDRT-${YY}-0001".`,
      }]);
      expect(r.body.cleared).toEqual([{
        id: "t-b-1", code: RENUMBERED,
        message: expect.stringMatching(new RegExp(`^ticket_id "KE-DDRT-26-0001" → "DDRT-${YY}-0001": request t-live-1 of this workspace carries "KE-DDRT-26-0001", so this request was restored under a fresh number rather than beside it or not at all`)),
        renumbered: { from: "KE-DDRT-26-0001", to: `DDRT-${YY}-0001`, numberHeldBy: "t-live-1" },
      }]);
      // the renumbering is in the chunk's audit row, old and new
      const trail = rowsOf("audit_logs").filter((a) => a.action === "RESTORE_CHUNK");
      expect(JSON.stringify(trail[0].details)).toContain(`ticket_id \\"KE-DDRT-26-0001\\" → \\"DDRT-${YY}-0001\\"`);
      // the write never sent the backup request under the live request's number
      expect(sent.some((x) => x.id === "t-b-1" && x.ticket_id === "KE-DDRT-26-0001")).toBe(false);
      expect(IN_USE).toBe("ticket_number_in_use");
    });

    it("…called directly, the chunk reports each renumbering, old → new (renumbered), only for a request it wrote", async () => {
      db.rows.tickets = [ticket("t-live-1", "KE-DDRT-26-0001", ORG)];
      const r = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", rows: [ticket("t-b-1", "KE-DDRT-26-0001"), ticket("t-b-2", "KE-DDRT-26-0002")], idRemap: { orgId: { "backup-org": ORG }, uid: {} } });
      expect(r).toMatchObject({ ok: true, inserted: 2, renumbered: [{ id: "t-b-1", from: "KE-DDRT-26-0001", to: `DDRT-${YY}-0001`, numberHeldBy: "t-live-1" }] });
      expect(renumberedOf(r.cleared)).toEqual(r.renumbered);
      // a request the database refuses after it was renumbered is not reported renumbered
      db.rows.tickets = [ticket("t-live-1", "KE-DDRT-26-0001", ORG)];
      db.rows.ticket_number_counters = [];
      db.writeError = (table, op, rows) => (table === "tickets" && op === "upsert" && rows.some((x) => x.id === "t-b-1") ? { code: "23514", message: "refused by a check" } : null);
      const refusedOne = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", rows: [ticket("t-b-1", "KE-DDRT-26-0001")], idRemap: { orgId: { "backup-org": ORG }, uid: {} } });
      expect(refusedOne).toMatchObject({ ok: true, inserted: 0, renumbered: [], cleared: [], refused: [expect.objectContaining({ id: "t-b-1", code: "23514" })] });
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
        message: expect.stringMatching(new RegExp(`^ticket_id "KE-DDRT-26-0007" → "DDRT-${YY}-0001": request t-b-1 of this backup \\(restored first\\) carries "KE-DDRT-26-0007" \\(the workspace the backup was taken from held the number twice\\)`)),
        renumbered: { from: "KE-DDRT-26-0007", to: `DDRT-${YY}-0001`, numberHeldBy: "t-b-1" },
      }]);
      expect(ticketsHere().find((t) => t.id === "t-b-2")!.history).toEqual([expect.objectContaining({
        action: "Renumbered on restore", user: "restore",
        details: `Issued as "KE-DDRT-26-0007"; request t-b-1 of this backup (restored first) carries that number, so this request was restored as "DDRT-${YY}-0001".`,
      })]);
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
      expect(r.refused).toEqual([{ id: "t-b-2", code: IN_USE, message: expect.stringMatching(/^request number "KE-DDRT-26-0007" is already carried in this workspace by request t-b-1 — this request was to be restored under a fresh number, but none could be taken now \(8 numbers were tried.*Run the restore again: a re-run renumbers it$/) }]);
      expect(r.renumbered).toEqual([]);
      expect(ticketsHere().map((t) => t.id)).toEqual(["t-b-1"]);
      expect(counterHere()).toMatchObject({ next_seq: 5 });
    });

    it("…a counter that cannot be read stops the chunk with what was written counted — never a number on a guess", async () => {
      db.readError.ticket_number_counters = "permission denied";
      const r = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", rows: [ticket("t-b-1", "KE-DDRT-26-0007"), ticket("t-b-2", "KE-DDRT-26-0007")], idRemap: { orgId: { "backup-org": ORG }, uid: {} } });
      expect(r).toMatchObject({ ok: false, status: 500, inserted: 1, error: expect.stringMatching(/^Could not give request t-b-2 a fresh number \(request t-b-1 already carries "KE-DDRT-26-0007"\): the request number counter could not be read: permission denied/) });
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
      expect(r.body.cleared).toEqual([expect.objectContaining({ id: "t-b-3", code: RENUMBERED, message: expect.stringContaining("request t-b-2 of this backup (restored first) carries") })]);
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

    it("…and across requests sent separately (P16 fix pass 3): a later request's row whose number an earlier one restored is renumbered at once — no re-run needed, never refused", async () => {
      await chunk("tickets", [ticket("t-b-1", "KE-DDRT-26-0007")]);
      const r = await chunk("tickets", [ticket("t-b-2", "KE-DDRT-26-0007")]);
      expect(r.body).toMatchObject({ ok: true, inserted: 1, cleared: [expect.objectContaining({ id: "t-b-2", code: RENUMBERED, renumbered: { from: "KE-DDRT-26-0007", to: `DDRT-${YY}-0001`, numberHeldBy: "t-b-1" } })] });
      expect(r.body.refused).toBeUndefined();
      expect(numbersIssuedTwice()).toEqual([]);
      // and the page's re-run adds nothing and takes no second number
      const env: RestoreEnvelopeLike = { manifest: { orgId: "backup-org" }, tables: { tickets: [ticket("t-b-1", "KE-DDRT-26-0007"), ticket("t-b-2", "KE-DDRT-26-0007")] } };
      const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
      expect(run).toMatchObject({ stoppedAt: null, totalRefused: 0, totalInserted: 0, totalExisting: 2 });
      expect(counterHere()).toMatchObject({ next_seq: 1 });
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
      expect(r.body.refused).toBeUndefined();
      expect((r.body.cleared as Array<{ id: string; code: string }>).filter((x) => x.code === RENUMBERED).map((x) => x.id)).toEqual(["t-b-1", "t-b-2", "t-b-3"]);
      expect(ticketsHere().map((t) => t.id).sort()).toEqual(["t-b-1", "t-b-2", "t-b-3", "t-b-4", "t-live-a", "t-live-b", "t-live-c"]);
      expect(numbersIssuedTwice()).toEqual([]);
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
      expect(r.refused).toEqual([]);
      expect(r.renumbered.map((x) => x.id).sort()).toEqual(["t-b-c", "t-b-q", "t-b-s"]);
      expect(r.renumbered.map((x) => x.from).sort()).toEqual([comma, quoted, slashed].sort());
      expect(ticketsHere().filter((t) => String(t.id).startsWith("t-b-")).map((t) => t.id).sort()).toEqual(["t-b-c", "t-b-ok", "t-b-q", "t-b-s"]);
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
      expect(r.refused).toEqual([]);
      expect(r.renumbered).toEqual([expect.objectContaining({ id: "t-b-149", from: long(149) })]);
      expect(inLists.length).toBeGreaterThan(5);
      for (const list of inLists) expect(list.reduce<number>((sum, v) => sum + encodeURIComponent(String(v)).length + 3, 0)).toBeLessThanOrEqual(6000);
      expect(new Set(inLists.flat().filter((v) => String(v).startsWith("KE-"))).size).toBe(150);
    });

    it("a check that cannot read the live numbers fails the chunk closed — nothing is written on a guess", async () => {
      db.readError.tickets = "permission denied";
      const r = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", rows: [ticket("t-b-1", "KE-DDRT-26-0001")], idRemap: { orgId: { "backup-org": ORG }, uid: {} } });
      expect(r).toMatchObject({ ok: false, status: 500, inserted: 0, error: expect.stringMatching(/^Could not check the request numbers this workspace already holds: permission denied/) });
      expect(db.attempts.filter((a) => a.table === "tickets")).toEqual([]);
    });

    it("through the page's driver (P16 fix pass 3): the run does not stop, nothing is refused, the renumbering is reported old → new, and the comments of the renumbered request land with it", async () => {
      db.rows.tickets = [ticket("t-live-1", "KE-DDRT-26-0001", ORG)];
      const env: RestoreEnvelopeLike = {
        manifest: { orgId: "backup-org" },
        tables: {
          tickets: [ticket("t-b-1", "KE-DDRT-26-0001"), ticket("t-b-2", "KE-DDRT-26-0402")],
          ticket_comments: [{ id: "c-1", org_id: "backup-org", ticket_id: "t-b-1", body: "on the renumbered one" }, { id: "c-2", org_id: "backup-org", ticket_id: "t-b-2", body: "kept" }],
        },
      };
      const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
      expect(run).toMatchObject({ stoppedAt: null, totalRefused: 0 });
      const t = run.tables.find((x) => x.name === "tickets")!;
      expect(t).toMatchObject({ inserted: 2, refused: [], renumbered: [{ id: "t-b-1", from: "KE-DDRT-26-0001", to: `DDRT-${YY}-0001`, numberHeldBy: "t-live-1" }] });
      expect(t.cleared).toEqual([expect.objectContaining({ id: "t-b-1", code: RENUMBERED })]);
      expect(run.tables.find((x) => x.name === "ticket_comments")).toMatchObject({ inserted: 2, refused: [] });
      expect(rowsOf("ticket_comments").map((c) => c.id)).toEqual(["c-1", "c-2"]);
      expect(numbersIssuedTwice()).toEqual([]);
    });

    it("a renumbered request's files keep their storage keys, under the old number's folder — recorded on the row, in its history and in the note (drafting-flow EDGE-19 owns the prefix checks that then treat them as outside the request)", async () => {
      const files = [
        { id: "att-final", name: "final.pdf", url: "orgs/backup-org/tickets/KE-DDRT-26-0007/final.pdf", kind: "final" },
        { id: "att-src", name: "source.dwg", url: "orgs/backup-org/tickets/KE-DDRT-26-0007/source.dwg", kind: "source" },
      ];
      const r = await chunk("tickets", [
        ticket("t-b-1", "KE-DDRT-26-0007", "backup-org", { attachments: [{ id: "att-a", name: "a.pdf", url: "orgs/backup-org/tickets/KE-DDRT-26-0007/a.pdf" }] }),
        ticket("t-b-2", "KE-DDRT-26-0007", "backup-org", { attachments: files }),
      ]);
      expect(r.body).toMatchObject({ ok: true, inserted: 2 });
      const b2 = ticketsHere().find((t) => t.id === "t-b-2")!;
      expect(b2.ticket_id).toBe(`DDRT-${YY}-0001`);
      // the keys are the backup's, moved to this workspace only (remapOrgPath) — not to the new number's folder
      expect((b2.attachments as Array<{ url: string }>).map((a) => a.url)).toEqual([
        `orgs/${ORG}/tickets/KE-DDRT-26-0007/final.pdf`, `orgs/${ORG}/tickets/KE-DDRT-26-0007/source.dwg`,
      ]);
      expect((b2.metadata as { restore_renumbered: Record<string, unknown> }).restore_renumbered).toMatchObject({ from: "KE-DDRT-26-0007", files_kept_under: `orgs/${ORG}/tickets/KE-DDRT-26-0007/` });
      expect((b2.history as Array<{ details: string }>)[0].details).toMatch(/ Its files stay where the backup had them, in the "KE-DDRT-26-0007" folder\.$/);
      expect((r.body.cleared as Array<{ message: string }>)[0].message).toMatch(new RegExp(`; its files stay in the "KE-DDRT-26-0007" folder \\(orgs/${ORG}/tickets/KE-DDRT-26-0007/\\)$`));
      // the first carrier, which keeps its number, is untouched
      expect(ticketsHere().find((t) => t.id === "t-b-1")!.metadata).toBeUndefined();
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
      expect(run.tables.find((x) => x.name === "tickets")).toMatchObject({ inserted: 3, refused: [], cleared: [expect.objectContaining({ id: "t-1b", code: RENUMBERED })], renumbered: [{ id: "t-1b", from: "KE-DDRT-26-0001", to: `DDRT-${YY}-0001`, numberHeldBy: "t-1" }] });
      expect(run.tables.find((x) => x.name === "ticket_comments")).toMatchObject({ inserted: 2, refused: [] });
      expect(rowsOf("ticket_comments").map((c) => c.id)).toEqual(["c-1", "c-1b"]);
      expect(numbersIssuedTwice()).toEqual([]);
    });
  }

  it("…and when the two requests sharing a number sit more than a chunk apart in the backup, the driver sends the second after every other request — it is renumbered, nothing refused", async () => {
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
    expect(posted.at(-1)!.at(-1)).toBe("t-dup");
    expect(posted.every((rows) => rows.length <= 500)).toBe(true);
    expect(ticketsHere().find((t) => t.id === "t-dup")!.ticket_id).toBe(`DDRT-${YY}-0001`);
    expect(numbersIssuedTwice()).toEqual([]);
  });

  for (const withKey of [false, true]) {
    it(`a backup whose counter LAGS its own numbers (${withKey ? "with" : "without"} the number key; P16 fix pass 3, the review): the counter is raised to the highest number the backup carries before any request is written, so the duplicate's fresh number repeats no request still to come`, async () => {
      db.keys.ticket_number_counters = [["org_id", "year"]];
      if (withKey) db.keys.tickets = NUMBER_KEY;
      // numbers DDRT-26-0001 … 0600 (the workspace's own format), the counter at 2, and 0001 carried twice
      const tickets = Array.from({ length: 600 }, (_, i) => ticket(`t-${String(i).padStart(3, "0")}`, `DDRT-26-${String(i + 1).padStart(4, "0")}`));
      tickets.splice(1, 0, ticket("t-dup", "DDRT-26-0001"));
      const env: RestoreEnvelopeLike = { manifest: { orgId: "backup-org" }, tables: { ticket_number_counters: [{ org_id: "backup-org", year: 2026, next_seq: 2 }], tickets } };
      const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
      expect(run).toMatchObject({ stoppedAt: null, totalRefused: 0, totalInserted: 602 });
      expect(run.tables.find((x) => x.name === "tickets")!.renumbered).toEqual([{ id: "t-dup", from: "DDRT-26-0001", to: "DDRT-26-0601", numberHeldBy: "t-000" }]);
      expect(ticketsHere().filter((t) => t.id !== "t-dup").every((t) => /^DDRT-26-0\d{3}$/.test(String(t.ticket_id)) && Number(String(t.ticket_id).slice(-4)) <= 600)).toBe(true);
      expect(counterHere()).toMatchObject({ next_seq: 601 });
      expect(numbersIssuedTwice()).toEqual([]);
    });

    it(`…and the plant-merge case with a lagging counter (${withKey ? "with" : "without"} the number key): a backup request whose number a live request holds is renumbered past every number the backup carries; every other request keeps its number`, async () => {
      db.keys.ticket_number_counters = [["org_id", "year"]];
      if (withKey) db.keys.tickets = NUMBER_KEY;
      db.rows.ticket_number_counters = [{ org_id: ORG, year: 2026, next_seq: 1 }];
      db.rows.tickets = [ticket("t-live", "DDRT-26-0001", ORG)];
      const tickets = Array.from({ length: 600 }, (_, i) => ticket(`t-${String(i).padStart(3, "0")}`, `DDRT-26-${String(i + 1).padStart(4, "0")}`));
      const env: RestoreEnvelopeLike = { manifest: { orgId: "backup-org" }, tables: { ticket_number_counters: [{ org_id: "backup-org", year: 2026, next_seq: 1 }], tickets } };
      const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
      expect(run).toMatchObject({ stoppedAt: null, totalRefused: 0, totalAdvanced: 1 });
      expect(run.tables.find((x) => x.name === "tickets")).toMatchObject({ inserted: 600, renumbered: [{ id: "t-000", from: "DDRT-26-0001", to: "DDRT-26-0601", numberHeldBy: "t-live" }] });
      expect(ticketsHere().find((t) => t.id === "t-live")!.ticket_id).toBe("DDRT-26-0001");
      expect(counterHere()).toMatchObject({ next_seq: 601 });
      expect(numbersIssuedTwice()).toEqual([]);
    });

    it(`the plant-merge case through the driver (${withKey ? "with" : "without"} the number key; P16 fix pass 3): the backup request and all its children land — ${withKey ? "125ca3b refused it 23505 and its comments with it" : "125ca3b landed it under the live request's number"}; now under a fresh number, recorded`, async () => {
      db.keys.ticket_number_counters = [["org_id", "year"]];
      if (withKey) db.keys.tickets = NUMBER_KEY;
      db.rows.tickets = [ticket("t-live", "KE-DDRT-26-0001", ORG)];
      const env: RestoreEnvelopeLike = {
        manifest: { orgId: "backup-org" },
        tables: { tickets: [ticket("t-1", "KE-DDRT-26-0001"), ticket("t-2", "KE-DDRT-26-0002")], ticket_comments: [{ id: "c-1", org_id: "backup-org", ticket_id: "t-1", body: "a" }] },
      };
      const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
      expect(run).toMatchObject({ stoppedAt: null, totalRefused: 0, totalInserted: 3 });
      expect(ticketsHere().map((t) => [t.id, t.ticket_id])).toEqual([["t-live", "KE-DDRT-26-0001"], ["t-2", "KE-DDRT-26-0002"], ["t-1", `DDRT-${YY}-0001`]]);
      expect(rowsOf("ticket_comments").map((c) => c.id)).toEqual(["c-1"]);
      expect(numbersIssuedTwice()).toEqual([]);
    });
  }

  it("the fresh number is issued in the YEAR OF THE NUMBER IT REPLACES (P16 fix pass 3, the review) — that year's counter; a number carrying no year takes the server's UTC year, as /api/tickets/create gives a body with no local year", async () => {
    db.keys.ticket_number_counters = [["org_id", "year"]];
    db.rows.ticket_number_counters = [{ org_id: ORG, year: 2024, next_seq: 9 }];
    const r = await chunk("tickets", [ticket("t-a", "KE-DDRT-24-0007"), ticket("t-b", "KE-DDRT-24-0007"), ticket("t-c", "LEGACY7"), ticket("t-d", "LEGACY7")]);
    expect(r.body).toMatchObject({ ok: true, inserted: 4 });
    const utc = new Date().getUTCFullYear();
    expect(ticketsHere().find((t) => t.id === "t-b")!.ticket_id).toBe("DDRT-24-0010");
    expect(ticketsHere().find((t) => t.id === "t-d")!.ticket_id).toBe(`DDRT-${String(utc).slice(-2)}-0001`);
    expect(rowsOf("ticket_number_counters").map((c) => [c.year, c.next_seq]).sort()).toEqual([[2024, 10], [utc, 1]].sort());
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

  it("the restore page names the renumbering, and the refusal left for a fresh number that cannot be taken now", () => {
    expect(restoreRefusalLabel("ticket_number_in_use")).toMatch(/^a request whose number another request here already carries, and for which no fresh number could be taken now — not restored/);
    expect(RENUMBERED).toBe("ticket_renumbered");
    expect(restoreRefusalLabel(RENUMBERED)).toMatch(/^a request whose number another request here already carries \(a request of this workspace, or another request of the same backup restored first\) — restored under a fresh number, never beside it; the number it was issued is kept in its metadata \(restore_renumbered\), in its history/);
  });
});

describe("EDGE-5 (P16 fix pass 3) — the driver's order and counters, and the year a fresh number takes (pure)", () => {
  const r = (id: string, n: string | null): Row => ({ id, ...(n === null ? {} : { ticket_id: n }) });

  it("ticketsInRestoreOrder moves every request whose number an earlier one carries to the end, the order otherwise kept; a backup with no number twice is unchanged", () => {
    expect(ticketsInRestoreOrder([r("a", "1"), r("b", "2"), r("c", null), r("d", "1"), r("e", "3"), r("f", "2"), r("g", "1")]).map((x) => x.id)).toEqual(["a", "b", "c", "e", "d", "f", "g"]);
    const plain = [r("a", "1"), r("b", null), r("c", "2")];
    expect(ticketsInRestoreOrder(plain)).toEqual(plain);
  });

  it("raiseTicketCountersToBackupNumbers raises (never lowers) each year's counter to the highest sequence the backup's requests carry for that year, adds no row, and leaves other rows as they are", () => {
    const counters = [{ org_id: "b", year: 2026, next_seq: 2 }, { org_id: "b", year: 2025, next_seq: 90 }, { org_id: "b", year: 2024, next_seq: 1 }];
    const tickets = [r("a", "KE-DDRT-26-0041"), r("b", "AC-DDRT-26-0007"), r("c", "KE-DDRT-25-0012"), r("d", "LEGACY"), r("e", null), r("f", "DDRT-23-0500")];
    expect(raiseTicketCountersToBackupNumbers(counters, tickets)).toEqual([{ org_id: "b", year: 2026, next_seq: 41 }, { org_id: "b", year: 2025, next_seq: 90 }, { org_id: "b", year: 2024, next_seq: 1 }]);
    expect(raiseTicketCountersToBackupNumbers(counters, [])).toEqual(counters);
  });

  it("restoreNumberYear reads the year a number was issued in; one that carries none (or one past every calendar year now) is the server's UTC year", () => {
    const now = Date.UTC(2026, 9, 21, 12);
    expect(restoreNumberYear("KE-DDRT-26-0007", now)).toBe(2026);
    expect(restoreNumberYear("DDRT-19-0001", now)).toBe(2019);
    expect(restoreNumberYear("KE-DDRT-27-0001", now)).toBe(2026);
    expect(restoreNumberYear("KE-DDRT-27-0001", Date.UTC(2026, 11, 31, 20))).toBe(2027);
    expect(restoreNumberYear("LEGACY7", now)).toBe(2026);
    expect(restoreNumberYear("KE-DDRT-2026-0001", now)).toBe(2026);
    expect(restoreNumberYear("KE-DDRT-26-A1", now)).toBe(2026);
    // on 31 December at 20:00 in UTC-5 the server's clock reads the next year — the replaced number's year is kept
    const newYearUtc = Date.UTC(2027, 0, 1, 1);
    expect(restoreNumberYear("KE-DDRT-26-0007", newYearUtc)).toBe(2026);
  });

  it("renumberedOf reads the old → new pair from TICKET_RENUMBERED notes only", () => {
    expect(renumberedOf([
      { id: "x", code: "owner_team_outside_workspace", message: "m" },
      { id: "t", code: RENUMBERED, message: "m", renumbered: { from: "A", to: "B", numberHeldBy: "h" } },
      { id: "u", code: RENUMBERED, message: "m" },
    ])).toEqual([{ id: "t", from: "A", to: "B", numberHeldBy: "h" }]);
  });
});
