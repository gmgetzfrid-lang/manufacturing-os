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
// creates it, so a live database may lack it). DEC-90 ruling (3): re-mint was
// not chosen — next_ticket_number (20260724) admits only an active member by
// auth.uid() and the restore writes as the service role, so re-minting would
// need a second allocation path; and a request's number is printed on labels,
// transmittals and archives, so rewriting it on restore re-identifies a
// regulated record. Ruling (4): every restore that works today restores the
// same rows (pinned below, both worlds).
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
  applyRestoreChunk, planRestore, runChunkedRestore, restoreRefusalLabel, TICKET_NUMBER_IN_USE,
  type RestorePost, type RestoreEnvelopeLike,
} from "@/lib/dataRestore";

const ORG = "org-1";
const OTHER = "other-org";
const NUMBER_KEY: string[][] = [["id"], ["org_id", "ticket_id"]];
const IN_USE = TICKET_NUMBER_IN_USE;

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
    beforeEach(() => { if (withKey) db.keys.tickets = NUMBER_KEY; });

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

    it("two backup requests sharing one number in ONE chunk: the first lands, the second is refused, named", async () => {
      const r = await chunk("tickets", [ticket("t-b-1", "KE-DDRT-26-0007"), ticket("t-b-2", "KE-DDRT-26-0007"), ticket("t-b-3", "KE-DDRT-26-0008")]);
      expect(r.status).toBe(200);
      expect(ticketsHere().map((t) => t.id).sort()).toEqual(["t-b-1", "t-b-3"]);
      expect(r.body.refused).toEqual([{
        id: "t-b-2", code: IN_USE,
        message: expect.stringMatching(/^request number "KE-DDRT-26-0007" is carried by another request of this restore \(t-b-1\), restored first — not restored/),
      }]);
      expect(numbersIssuedTwice()).toEqual([]);
    });

    it("…and across chunks: a later chunk's request whose number an earlier chunk restored is refused", async () => {
      await chunk("tickets", [ticket("t-b-1", "KE-DDRT-26-0007")]);
      const r = await chunk("tickets", [ticket("t-b-2", "KE-DDRT-26-0007")]);
      expect(r.body.refused).toEqual([expect.objectContaining({ id: "t-b-2", code: IN_USE })]);
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

  it("the restore page names the refusal", () => {
    expect(restoreRefusalLabel("ticket_number_in_use")).toMatch(/^a request whose number this workspace already uses for another request — not restored/);
  });
});
