// lib/__tests__/aoRoundGP16RestoreBoundedCalls.test.ts
//
// admin-and-org Round G, package P16 RESTORE TICKET NUMBER KEY — the final
// fix pass (the review's three items), drafting-flow EDGE-5.
//
// 1. A tickets apply-table request costs a BOUNDED number of database calls
//    however many of its rows collide: the fresh numbers of a year come from
//    one compare-and-set on ticket_number_counters reserving K numbers and
//    one read checking all K, topped up by a smaller reservation; the whole
//    request may make at most RESTORE_REMINT_RESERVATIONS reservations and
//    run at most RESTORE_HELD_BACK_ROUNDS held-back rounds, and a row left
//    over is refused loudly, per row, while the rest of the table lands.
//    Every call is counted on the stub. A restore where no number collides
//    issues exactly the calls and writes the branch issued before this pass
//    (traces pinned by digest, captured at 4407b30).
// 2. (pinned in aoRoundGP16RestoreTicketNumber.test.ts: a backup with no
//    ticket_number_counters rows gets one per year its requests carry.)
// 3. A renumbered request's holder is named from the BACKUP: the page's
//    driver sends each tickets request the backup's other requests sharing a
//    number with its rows (backupNumberCarriers), so a holder an earlier
//    request wrote is "of this backup" — with why the backup carries the
//    number twice — in the history line and the note, and any other holder
//    "of this workspace".

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";

import { db, from, type Row } from "./helpers/restoreMemoryDb";

vi.mock("@/lib/serverAuth", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  return {
    authorizeOrgRole: vi.fn(async (_req: unknown, orgId: string) => ({
      userId: "admin-1", email: "admin@x.io", orgId, role: "Admin", roles: ["Admin"], admin: { from: mem.from },
    })),
  };
});

import { authorizeOrgRole } from "@/lib/serverAuth";
import { POST as applyTable } from "@/app/api/admin/restore/apply-table/route";
import { POST as beginRoute } from "@/app/api/admin/restore/begin/route";
import {
  applyRestoreChunk, planRestore, runChunkedRestore, ticketNumberCarriers, backupNumberCarriersFor, restoreRefusalLabel,
  RESTORE_REMINT_RESERVATIONS, RESTORE_HELD_BACK_ROUNDS, RESTORE_CARRIERS_BYTES,
  TICKET_NUMBER_IN_USE, TICKET_NUMBER_UNSETTLED, TICKET_RENUMBERED,
  type RestorePost, type RestoreEnvelopeLike,
} from "@/lib/dataRestore";

const ORG = "org-1";
const YEAR = 2026;
const REMAP = { orgId: { "backup-org": ORG }, uid: {} };
const pad = (i: number) => String(i).padStart(4, "0");
const ticket = (id: string, num: string | null, org = "backup-org", extra: Row = {}): Row =>
  ({ id, org_id: org, ...(num === null ? {} : { ticket_id: num }), title: `Request ${num}`, status: "CLOSED", ...extra });
const ticketsHere = () => (db.rows.tickets ?? []).filter((t) => t.org_id === ORG);
const numbersIssuedTwice = () => {
  const seen = new Map<string, number>();
  for (const t of ticketsHere()) seen.set(String(t.ticket_id), (seen.get(String(t.ticket_id)) ?? 0) + 1);
  return Array.from(seen).filter(([, n]) => n > 1).map(([k]) => k);
};
const sha = (lines: string[]) => createHash("sha256").update(lines.join("\n")).digest("hex");

/** A service-role client over the in-memory engine that records every
 *  database call it runs — the builder chain with its arguments (write
 *  payloads included), one line per executed statement or read. */
function tracing() {
  const log: string[] = [];
  const sb = { from: (t: string) => {
    const b = from(t) as Record<string, (...a: unknown[]) => unknown>;
    const parts: string[] = [t];
    const p: Record<string, unknown> = {};
    for (const [k, fn] of Object.entries(b)) {
      if (k === "then") { p.then = (res: (v: unknown) => void, rej: (e: unknown) => void) => { log.push(parts.join(".")); return fn(res, rej); }; continue; }
      p[k] = (...a: unknown[]) => { parts.push(`${k}(${JSON.stringify(a)})`); fn(...a); return p; };
    }
    return p;
  } };
  return { sb, log };
}
/** `table.op` of each logged call. */
const heads = (log: string[]) => log.map((l) => l.split("(")[0]);

const posted: Array<Record<string, unknown>> = [];
const routePost: RestorePost = async (path, body) => {
  posted.push(body as Record<string, unknown>);
  const req = new NextRequest(`https://app${path}`, {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const handler = path.startsWith("/api/admin/restore/begin") ? beginRoute : applyTable;
  const res = await handler(req);
  return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};
const planFor = (envelope: RestoreEnvelopeLike) => planRestore(envelope, { orgId: ORG, orgName: "Acme", members: [] });
/** The page's driver through the real routes, every database call traced. */
async function tracedDriverRun(env: RestoreEnvelopeLike) {
  const { sb, log } = tracing();
  const mocked = vi.mocked(authorizeOrgRole);
  const orig = mocked.getMockImplementation()!;
  mocked.mockImplementation(async (req, orgId) => ({ ...(await orig(req, orgId, [])), admin: sb } as never));
  try {
    const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
    return { run, log };
  } finally { mocked.mockImplementation(orig); }
}

beforeEach(() => {
  db.rows = { orgs: [{ id: ORG, name: "Acme" }], org_members: [] };
  db.keys = { ticket_number_counters: [["org_id", "year"]] };
  db.writeError = null; db.readError = {}; db.writes = []; db.attempts = []; db.countless = false; db.fks = {}; db.maxRows = 1000; db.generated = {}; db.authUsers = null;
  posted.length = 0;
});

describe("EDGE-5 (P16 final fix pass) — a restore where no number collides issues exactly the calls and writes it issued before (captured at 4407b30)", () => {
  it("one tickets request, called directly: one read of the live numbers, one write — nothing else", async () => {
    db.rows.tickets = [ticket("t-live-1", "AC-DDRT-26-0001", ORG), ticket("t-live-2", "AC-DDRT-26-0002", ORG)];
    const { sb, log } = tracing();
    const r = await applyRestoreChunk(sb as never, { orgId: ORG, table: "tickets", rows: [ticket("t-1", "KE-DDRT-26-0001"), ticket("t-2", "KE-DDRT-26-0002"), ticket("t-3", null)], idRemap: REMAP });
    expect(log).toEqual([
      'tickets.select(["id,ticket_id"]).eq(["org_id","org-1"]).in(["ticket_id",["KE-DDRT-26-0001","KE-DDRT-26-0002"]]).order(["id"]).range([0,999])',
      'tickets.upsert([[{"id":"t-1","org_id":"org-1","ticket_id":"KE-DDRT-26-0001","title":"Request KE-DDRT-26-0001","status":"CLOSED"},{"id":"t-2","org_id":"org-1","ticket_id":"KE-DDRT-26-0002","title":"Request KE-DDRT-26-0002","status":"CLOSED"},{"id":"t-3","org_id":"org-1","title":"Request null","status":"CLOSED"}],{"onConflict":"id","ignoreDuplicates":true,"count":"exact"}])',
    ]);
    expect(sha([JSON.stringify(r)])).toBe("3cce96d6e1e4b515d8c7b3f6b6fec4baccbc6c038d225074af3c7d09ccc35b31");
  });

  it("the page's driver, a backup with counters, requests and comments into a workspace with non-overlapping numbers: the same 16 calls, byte for byte", async () => {
    db.rows.ticket_number_counters = [{ org_id: ORG, year: YEAR, next_seq: 1 }];
    db.rows.tickets = [ticket("t-live", "AC-DDRT-26-0001", ORG)];
    const env: RestoreEnvelopeLike = { manifest: { orgId: "backup-org" }, tables: {
      ticket_number_counters: [{ org_id: "backup-org", year: YEAR, next_seq: 3 }],
      tickets: [ticket("t-1", "KE-DDRT-26-0001"), ticket("t-2", "KE-DDRT-26-0002"), ticket("t-3", "KE-DDRT-26-0003")],
      ticket_comments: [{ id: "c-1", org_id: "backup-org", ticket_id: "t-1", body: "a" }],
    } };
    const { run, log } = await tracedDriverRun(env);
    expect(heads(log)).toEqual([
      "orgs.select", "org_members.select", "audit_logs.insert",
      "ticket_number_counters.upsert", "ticket_number_counters.select", "ticket_number_counters.select", "ticket_number_counters.select", "ticket_number_counters.update", "audit_logs.insert",
      "tickets.select", "tickets.upsert", "audit_logs.insert",
      "tickets.select", "tickets.select", "ticket_comments.upsert", "audit_logs.insert",
    ]);
    expect(sha(log)).toBe("ebf9a516d83c1d7a730ad307baab9e957c24803f88ed9dab815373823c154c2e");
    expect(sha([JSON.stringify(run)])).toBe("a2235ca271b6398479ba4713ce9f870d21194d0638cddd04d76cf42ad201f391");
    // the tickets request carries the (empty) list of the backup's requests sharing a number — a request body, not a database call
    expect(posted.find((b) => b.table === "tickets")).toMatchObject({ backupNumberCarriers: [] });
  });

  it("…and a backup with NO counter rows (fix pass 5 completes them): the same 9 calls, byte for byte", async () => {
    const env: RestoreEnvelopeLike = { manifest: { orgId: "backup-org" }, tables: { tickets: [ticket("t-1", "KE-DDRT-26-0001"), ticket("t-2", "KE-DDRT-25-0009")] } };
    const { run, log } = await tracedDriverRun(env);
    expect(heads(log)).toEqual([
      "orgs.select", "org_members.select", "audit_logs.insert",
      "ticket_number_counters.upsert", "ticket_number_counters.select", "audit_logs.insert",
      "tickets.select", "tickets.upsert", "audit_logs.insert",
    ]);
    expect(sha(log)).toBe("0e42b6f6ca6e289b75696fea3c4974b6b45d8faf0664ff35cd33337a4801ce82");
    expect(sha([JSON.stringify(run)])).toBe("db24830b9cf519c66572832961673ba0946859945c8e7437ccffcfd48745a981");
  });
});

describe("EDGE-5 (P16 final fix pass) — a tickets request costs a bounded number of database calls however many rows collide", () => {
  it("500 rows that ALL collide (250 with live requests, 125 pairs carried twice in the request): 27 calls in all — two on the counter — and the per-row outcomes, calls and writes are 4407b30's exactly", async () => {
    db.rows.tickets = Array.from({ length: 500 }, (_, i) => ticket(`t-live-${pad(i)}`, `KE-DDRT-26-${pad(i + 1)}`, ORG));
    db.rows.ticket_number_counters = [{ org_id: ORG, year: YEAR, next_seq: 500 }];
    const rows = [
      ...Array.from({ length: 250 }, (_, i) => ticket(`t-b-${pad(i)}`, `KE-DDRT-26-${pad(i + 1)}`)),
      ...Array.from({ length: 125 }, (_, i) => ticket(`t-p-${pad(i)}`, `KE-DDRT-26-${pad(2000 + i)}`)),
      ...Array.from({ length: 125 }, (_, i) => ticket(`t-q-${pad(i)}`, `KE-DDRT-26-${pad(2000 + i)}`)),
    ];
    const { sb, log } = tracing();
    const r = await applyRestoreChunk(sb as never, { orgId: ORG, table: "tickets", rows, idRemap: REMAP });
    expect(r).toMatchObject({ ok: true, inserted: 500, refused: [] });
    expect(r.renumbered).toHaveLength(375);
    expect(numbersIssuedTwice()).toEqual([]);
    // the whole request: 27 calls (one renumbering per row would be 1,000+)
    expect(log).toHaveLength(27);
    const count = (h: string) => heads(log).filter((x) => x === h).length;
    expect(count("ticket_number_counters.select")).toBe(1);
    expect(count("ticket_number_counters.update")).toBe(1);
    expect(count("orgs.select")).toBe(1);
    expect(count("tickets.upsert")).toBe(2);
    // calls and per-row outcomes as at 4407b30 (the report, every note and every pair)
    expect(sha([String(log.length), ...log.map((l) => l.slice(0, 60))])).toBe("b22a61fb0790c5077d27be35338f833b41a0748c3360fb2c904c0995227c954c");
    // admin-and-org P17 final fix pass (BKP-16 review; drafting-flow EDGE-5 residual (e)): only each note's message
    // changed — a printed old number "must be read as" the new one for this request, and in this workspace still
    // identifies its holder (it never "resolves to" the new one). Every note carries the corrected sentence; with it
    // put back to 4407b30's, the per-row outcomes are 4407b30's exactly.
    const said = (n: { from: string; to: string; numberHeldBy: string }) => `printing "${n.from}" for this request must be read as "${n.to}"; in this workspace "${n.from}" still identifies request ${n.numberHeldBy}`;
    expect(r.cleared.every((n) => !!n.renumbered && n.message.includes(said(n.renumbered)))).toBe(true);
    const as4407b30 = { ...r, cleared: r.cleared.map((n) => ({ ...n, message: n.message.replace(said(n.renumbered!), `printing "${n.renumbered!.from}" for this request now resolve to "${n.renumbered!.to}"`) })) };
    expect(sha([JSON.stringify(as4407b30)])).toBe("9b2fb7a81c7b26d682fa26800e0caea35694285e3934ecacf40edb4b64a7290e");
    // what changed (item 3): the history line of a request whose holder is the backup's own says why the number is carried twice
    const q = ticketsHere().find((t) => t.id === "t-q-0000")!;
    expect((q.history as Array<{ details: string }>).at(-1)!.details).toBe(`Issued as "KE-DDRT-26-2000"; request t-p-0000 of this backup (restored first) carries that number (the workspace the backup was taken from held the number twice), so this request was restored as "${String(q.ticket_id)}".`);
  });

  it("500 colliding rows spread over five years: one reservation per year — ten counter calls — never a counter step per row", async () => {
    const years = ["22", "23", "24", "25", "26"];
    db.rows.tickets = Array.from({ length: 500 }, (_, i) => ticket(`t-live-${pad(i)}`, `KE-DDRT-${years[i % 5]}-${pad(i + 1)}`, ORG));
    const rows = Array.from({ length: 500 }, (_, i) => ticket(`t-b-${pad(i)}`, `KE-DDRT-${years[i % 5]}-${pad(i + 1)}`));
    const { sb, log } = tracing();
    const r = await applyRestoreChunk(sb as never, { orgId: ORG, table: "tickets", rows, idRemap: REMAP });
    expect(r).toMatchObject({ ok: true, inserted: 500, refused: [] });
    expect(r.renumbered).toHaveLength(500);
    // each year's counter created once (1..100), in the year of the number replaced
    expect((db.rows.ticket_number_counters ?? []).map((c) => [c.year, c.next_seq]).sort()).toEqual([[2022, 100], [2023, 100], [2024, 100], [2025, 100], [2026, 100]]);
    expect(heads(log).filter((h) => h.startsWith("ticket_number_counters."))).toHaveLength(10);
    expect(log.length).toBeLessThanOrEqual(40);
    expect(numbersIssuedTwice()).toEqual([]);
  });

  it(`a counter that keeps moving under every compare-and-set, in nine years: at most ${RESTORE_REMINT_RESERVATIONS} reservations for the whole request — every row left without a number refused loudly (${TICKET_NUMBER_IN_USE}, naming why), the rest of the table lands`, async () => {
    const years = ["18", "19", "20", "21", "22", "23", "24", "25", "26"];
    db.rows.ticket_number_counters = years.map((y) => ({ org_id: ORG, year: 2000 + Number(y), next_seq: 5 }));
    db.rows.tickets = years.map((y, i) => ticket(`t-live-${i}`, `KE-DDRT-${y}-0001`, ORG));
    const { sb: traced, log } = tracing();
    const sb = { from: (t: string) => {
      const b = traced.from(t) as Record<string, (...a: unknown[]) => unknown>;
      if (t === "ticket_number_counters") {
        // a concurrent filer wins every race: the guarded update matches no row
        const origEq = b.eq;
        b.eq = (c: unknown, v: unknown) => (c === "next_seq" ? origEq(c, -1) : origEq(c, v));
      }
      return b;
    } };
    const rows = [...years.map((y, i) => ticket(`t-b-${i}`, `KE-DDRT-${y}-0001`)), ticket("t-plain", "KE-DDRT-26-0500")];
    const r = await applyRestoreChunk(sb as never, { orgId: ORG, table: "tickets", rows, idRemap: REMAP });
    expect(r.ok).toBe(true);
    expect(r.inserted).toBe(1);
    expect(ticketsHere().filter((t) => !String(t.id).startsWith("t-live-")).map((t) => t.id)).toEqual(["t-plain"]);
    expect(r.refused).toHaveLength(9);
    expect(r.refused.every((x) => x.code === TICKET_NUMBER_IN_USE && /Run the restore again: a re-run renumbers it$/.test(x.message))).toBe(true);
    // eight years spent their eight reservations; the ninth found the request's budget spent
    expect(r.refused.filter((x) => /8 reservations on the counter were tried/.test(x.message))).toHaveLength(8);
    expect(r.refused.filter((x) => new RegExp(`this request's ${RESTORE_REMINT_RESERVATIONS} reservations on the counter were spent`).test(x.message))).toHaveLength(1);
    // a counter read and a compare-and-set per reservation: 2 × 64
    expect(heads(log).filter((h) => h.startsWith("ticket_number_counters."))).toHaveLength(2 * RESTORE_REMINT_RESERVATIONS);
    expect(r.renumbered).toEqual([]);
  });

  it(`a number carried by more rows than the held-back rounds can settle, each written carrier refused by the database: after ${RESTORE_HELD_BACK_ROUNDS} rounds the rest are refused loudly (${TICKET_NUMBER_UNSETTLED}), per row; the rest of the table lands`, async () => {
    const carriers = Array.from({ length: 20 }, (_, i) => ticket(`t-c-${pad(i)}`, "LEGACY-1"));
    // every carrier written up to the cap is refused by a check
    const doomed = new Set(carriers.slice(0, RESTORE_HELD_BACK_ROUNDS + 1).map((t) => String(t.id)));
    db.writeError = (table, op, rows) => (table === "tickets" && op === "upsert" && rows.some((x) => doomed.has(String(x.id))) ? { code: "23514", message: "refused by a check" } : null);
    const { sb, log } = tracing();
    const r = await applyRestoreChunk(sb as never, { orgId: ORG, table: "tickets", rows: [ticket("t-plain", "KE-DDRT-26-0001"), ...carriers], idRemap: REMAP });
    expect(r.ok).toBe(true);
    expect(ticketsHere().map((t) => t.id)).toEqual(["t-plain"]);
    expect(r.refused.filter((x) => x.code === "23514").map((x) => x.id)).toEqual(Array.from(doomed));
    const unsettled = r.refused.filter((x) => x.code === TICKET_NUMBER_UNSETTLED);
    expect(unsettled.map((x) => x.id)).toEqual(["t-c-0017", "t-c-0018", "t-c-0019"]);
    expect(unsettled[0].message).toMatch(new RegExp(`^request number "LEGACY-1" is carried by other rows of this restore request, and ${RESTORE_HELD_BACK_ROUNDS} rounds each wrote one of them that did not land`));
    expect(restoreRefusalLabel(TICKET_NUMBER_UNSETTLED)).toMatch(/^a request whose number other rows of the same restore request carry, each of which the database refused/);
    // bounded: the main write and its bisect, then one read and one write a round
    expect(log.length).toBeLessThanOrEqual(5 + 2 * RESTORE_HELD_BACK_ROUNDS + 2);
    expect(numbersIssuedTwice()).toEqual([]);
  });
});

describe("EDGE-5 (P16 final fix pass, the review) — a renumbered request's holder is named from the backup", () => {
  it("through the page's driver, the disaster-recovery case across requests: the holder an EARLIER request wrote is 'of this backup' — history and note — with why the backup carries the number twice", async () => {
    const tickets = Array.from({ length: 520 }, (_, i) => ticket(`t-${pad(i)}`, `KE-DDRT-26-${pad(i + 1)}`));
    tickets.push(ticket("t-dup", "KE-DDRT-26-0001"));
    const env: RestoreEnvelopeLike = { manifest: { orgId: "backup-org" }, tables: { tickets } };
    const { run } = await tracedDriverRun(env);
    expect(run).toMatchObject({ stoppedAt: null, totalRefused: 0 });
    const ticketPosts = posted.filter((b) => b.table === "tickets");
    expect(ticketPosts).toHaveLength(2);
    // the first request carries t-0000's number (the backup carries it twice), the last carries t-dup's
    expect(ticketPosts[0].backupNumberCarriers).toEqual(["t-0000", "t-dup"]);
    expect(ticketPosts[1].backupNumberCarriers).toEqual(["t-0000", "t-dup"]);
    const dup = ticketsHere().find((t) => t.id === "t-dup")!;
    expect((dup.history as Array<{ details: string }>).at(-1)!.details).toBe(
      `Issued as "KE-DDRT-26-0001"; request t-0000 of this backup (restored first) carries that number (the workspace the backup was taken from held the number twice), so this request was restored as "${String(dup.ticket_id)}".`,
    );
    const note = run.tables.find((x) => x.name === "tickets")!.cleared.find((x) => x.id === "t-dup")!;
    expect(note).toMatchObject({ code: TICKET_RENUMBERED, renumbered: { from: "KE-DDRT-26-0001", numberHeldBy: "t-0000" } });
    expect(note.message).toContain(`request t-0000 of this backup (restored first) carries "KE-DDRT-26-0001" (the workspace the backup was taken from held the number twice)`);
    expect(numbersIssuedTwice()).toEqual([]);
  });

  it("through the page's driver, the plant-merge case: a holder that is not one of the backup's requests is 'of this workspace'", async () => {
    db.rows.tickets = [ticket("t-live", "KE-DDRT-26-0001", ORG)];
    const env: RestoreEnvelopeLike = { manifest: { orgId: "backup-org" }, tables: { tickets: [ticket("t-1", "KE-DDRT-26-0001"), ticket("t-2", "KE-DDRT-26-0002")] } };
    const { run } = await tracedDriverRun(env);
    expect(run).toMatchObject({ stoppedAt: null, totalRefused: 0 });
    const t1 = ticketsHere().find((t) => t.id === "t-1")!;
    expect((t1.history as Array<{ details: string }>).at(-1)!.details).toBe(`Issued as "KE-DDRT-26-0001"; request t-live of this workspace carries that number, so this request was restored as "${String(t1.ticket_id)}".`);
    const note = run.tables.find((x) => x.name === "tickets")!.cleared.find((x) => x.id === "t-1")!;
    expect(note.message).toContain(`request t-live of this workspace carries "KE-DDRT-26-0001" (a request this workspace holds that is not one of this backup's)`);
  });

  it("called directly: a holder on the list is 'of this backup'; one not on it 'of this workspace'; with no list, named neutrally (as the single-shot /apply sends none)", async () => {
    const run = async (backupNumberCarriers?: string[]) => {
      db.rows.tickets = [ticket("t-holder", "KE-DDRT-26-0001", ORG)];
      db.rows.ticket_number_counters = [];
      const r = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", rows: [ticket("t-b", "KE-DDRT-26-0001")], idRemap: REMAP, backupNumberCarriers });
      return (ticketsHere().find((t) => t.id === "t-b")!.history as Array<{ details: string }>).at(-1)!.details + " | " + r.cleared[0].message;
    };
    expect(await run(["t-holder", "t-b"])).toMatch(/request t-holder of this backup \(restored first\) carries that number \(the workspace the backup was taken from held the number twice\)/);
    expect(await run([])).toMatch(/request t-holder of this workspace carries that number, so/);
    expect(await run()).toMatch(/request t-holder already in this workspace carries that number, so .* \(a request the workspace held before this restore, or — where the backup itself carries/);
  });

  it("apply-table passes a well-formed list and ignores a malformed or oversized one (the holder then named neutrally) — it only names the holder", async () => {
    const send = async (backupNumberCarriers: unknown) => {
      db.rows.tickets = [ticket("t-holder", "KE-DDRT-26-0001", ORG)];
      db.rows.ticket_number_counters = [];
      const res = await applyTable(new NextRequest(`https://app/api/admin/restore/apply-table?orgId=${ORG}`, {
        method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ table: "tickets", rows: [ticket("t-b", "KE-DDRT-26-0001")], idRemap: REMAP, manifest: { orgId: "backup-org" }, backupNumberCarriers }),
      }));
      const body = (await res.json()) as { inserted: number; cleared: Array<{ message: string }> };
      expect(body.inserted).toBe(1);
      return body.cleared[0].message;
    };
    expect(await send(["t-holder"])).toContain("request t-holder of this backup (restored first)");
    expect(await send([42])).toContain("request t-holder already in this workspace");
    expect(await send("t-holder")).toContain("request t-holder already in this workspace");
    expect(await send(Array.from({ length: 5001 }, (_, i) => (i === 0 ? "t-holder" : `x-${i}`)))).toContain("request t-holder already in this workspace");
  });

  it("ticketNumberCarriers keeps only numbers the backup carries more than once; backupNumberCarriersFor lists their carriers for a slice, or null past RESTORE_CARRIERS_BYTES (not sent)", () => {
    const backup = [ticket("a", "N-1"), ticket("b", "N-2"), ticket("c", "N-1"), ticket("d", null), ticket("e", "N-1"), ticket("f", "N-3")];
    const index = ticketNumberCarriers(backup);
    expect(Array.from(index)).toEqual([["N-1", ["a", "c", "e"]]]);
    expect(backupNumberCarriersFor(index, [ticket("b", "N-2"), ticket("e", "N-1")])).toEqual(["a", "c", "e"]);
    expect(backupNumberCarriersFor(index, [ticket("b", "N-2"), ticket("f", "N-3")])).toEqual([]);
    const many = ticketNumberCarriers(Array.from({ length: 4000 }, (_, i) => ticket(`00000000-0000-0000-0000-${String(i).padStart(12, "0")}`, "SAME")));
    expect(JSON.stringify(many.get("SAME")).length).toBeGreaterThan(RESTORE_CARRIERS_BYTES);
    expect(backupNumberCarriersFor(many, [ticket("z", "SAME")])).toBeNull();
  });
});
