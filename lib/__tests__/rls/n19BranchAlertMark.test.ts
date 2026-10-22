// notifications Round G, N19 NOTICE RECORD REMAINDERS — 20261260 asserted at
// RUNTIME on the replayed PostgreSQL 16 (each statement as PostgREST sends it:
// role `authenticated` with the member's claims, or `service_role` with none).
//
//   NEDGE-24 limb 2: resolving a branch retires every OTHER recipient's
//               unread branch_open row about it with the mark
//               (metadata.superseded_at / superseded_by 'branch_resolved'),
//               never read_at; the caller's own row is left to the app (the
//               reconcile pass), because 20261161's rail refuses a
//               recipient's session any change but read_at on their own row
//               — a definer runs in that session.
//   Regression: what the bell counts (unread AND unmarked) for every other
//               recipient drops exactly as it did when the row was stamped
//               read; a row already read, a row about another branch and a
//               row already marked are untouched; an unresolved branch, a
//               non-member and no session answer 0 and change nothing.
//   NEDGE-24 limb 1: the service role's mark on a pool member's row passes
//               the rail (as the access-request decide path writes it).
//   The file re-pastes cleanly (DEC-30 one paste) with every probe true.

import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, seedOrg, selectAs, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const SERVICE = { role: "service_role" as const };
const F260 = "20261260_notif_roundG_branch_alert_mark.sql";

function paste(f: string): { probes: string[]; inventory: string[] } {
  const { conn } = mosDb();
  const r = runPsql(conn!, db, conn!.superuser, { file: join(process.cwd(), "supabase", "migrations", f), stopOnError: true });
  expect(r.ok, `${f}: ${r.error ?? r.stderr ?? ""}`).toBe(true);
  const rows = r.stdout.split("\n").filter((l) => /\|[tf]?\|[^|]*$/.test(l));
  return { probes: rows.filter((l) => /\|[tf]\|$/.test(l)), inventory: rows.filter((l) => /\|\|.+$/.test(l)) };
}

describe.skipIf(skip !== null)("N19 — a resolved branch's alerts are retired with a mark, never a read (runtime)", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  const branch = randomUUID();
  const open = randomUUID();       // an unresolved branch in the same org
  const other = randomUUID();      // another resolved branch
  const ids: Record<string, string> = {};
  const one = (sql: string) => admin(db, sql).trim();
  const bell = (who: SeededMember) =>
    selectAs(db, who.caller, `SELECT count(*) FROM notifications WHERE user_id = '${who.uid}' AND kind = 'branch_open' AND read_at IS NULL AND metadata ->> 'superseded_at' IS NULL;`)[0];

  beforeAll(() => {
    const s = seedOrg(db, { resolver: { role: "DocCtrl" }, pool: { role: "DocCtrl" }, brancher: { role: "Engineer" }, outsider: { role: "Viewer" } });
    orgId = s.orgId;
    m = s.m;
    const row = (key: string, user: SeededMember, b: string, extra = "") => {
      ids[key] = randomUUID();
      return `INSERT INTO notifications (id, org_id, user_id, kind, title, metadata${extra ? ", read_at" : ""}) VALUES ('${ids[key]}', '${orgId}', '${user.uid}', 'branch_open', 'Branch opened', jsonb_build_object('branchId', '${b}', 'keep', 'me')${extra ? `, ${extra}` : ""});`;
    };
    admin(db, [
      "SET session_replication_role = replica;",
      `INSERT INTO revision_branches (id, org_id, document_id, branch_version_id, reason, created_by, resolved_at, resolution) VALUES
         ('${branch}', '${orgId}', '${randomUUID()}', '${randomUUID()}', 'stale base', '${m.brancher.uid}', now(), 'merged'),
         ('${open}',   '${orgId}', '${randomUUID()}', '${randomUUID()}', 'stale base', '${m.brancher.uid}', NULL, NULL),
         ('${other}',  '${orgId}', '${randomUUID()}', '${randomUUID()}', 'stale base', '${m.brancher.uid}', now(), 'withdrawn');`,
      row("resolverOwn", m.resolver, branch),
      row("pool", m.pool, branch),
      row("brancher", m.brancher, branch),
      row("poolRead", m.pool, branch, "now() - interval '1 day'"),
      row("poolOpenBranch", m.pool, open),
      row("poolOtherBranch", m.pool, other),
      `INSERT INTO notifications (id, org_id, user_id, kind, title, metadata) VALUES ('${(ids.access = randomUUID())}', '${orgId}', '${m.pool.uid}', 'access_request_pending', 'Someone asked to join', '{"requestEmail":"x@y.z"}'::jsonb);`,
      "RESET session_replication_role;",
    ].join("\n"));
  });

  it("re-pastes cleanly (DEC-30 one paste); every probe answers true; the inventory rows carry counts", () => {
    const { probes, inventory } = paste(F260);
    expect(probes.length).toBe(4);
    expect(probes.filter((l) => l.endsWith("|f|"))).toEqual([]);
    expect(inventory.length).toBe(6); // five BEFORE counts + one AFTER count
    for (const l of inventory) expect(l).toMatch(/\|\|\d+$/);
  });

  it("no session, a non-member, or an unresolved branch: answers 0 and changes nothing", () => {
    expect(one(`SELECT clear_resolved_branch_alerts('${branch}')`)).toBe("0"); // superuser: no auth.uid()
    const stranger = seedOrg(db, { x: { role: "Admin" } }).m.x;
    expect(selectAs(db, stranger.caller, `SELECT clear_resolved_branch_alerts('${branch}');`)[0]).toBe("0");
    expect(selectAs(db, m.resolver.caller, `SELECT clear_resolved_branch_alerts('${open}');`)[0]).toBe("0");
    expect(one(`SELECT count(*) FROM notifications WHERE org_id = '${orgId}' AND metadata ? 'superseded_at'`)).toBe("0");
  });

  it("REGRESSION + NEDGE-24 limb 2: every other recipient's alert leaves the bell — retired with the mark, read_at untouched", () => {
    expect(bell(m.pool)).toBe("3");      // this branch's row, the open branch's and the other branch's
    expect(bell(m.brancher)).toBe("1");
    expect(selectAs(db, m.resolver.caller, `SELECT clear_resolved_branch_alerts('${branch}');`)[0]).toBe("2");
    expect(bell(m.pool)).toBe("2");      // only this branch's alert leaves; the others are not about it
    expect(bell(m.brancher)).toBe("0");
    for (const k of ["pool", "brancher"]) {
      const [readAt, by, keep, at] = one(`SELECT coalesce(read_at::text, 'NULL') || '|' || (metadata ->> 'superseded_by') || '|' || (metadata ->> 'keep') || '|' || (metadata ->> 'superseded_at') FROM notifications WHERE id = '${ids[k]}'`).split("|");
      expect(readAt).toBe("NULL");
      expect(by).toBe("branch_resolved");
      expect(keep).toBe("me");                                   // every other metadata key kept
      expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // the app's ISO form
      expect(Number.isFinite(Date.parse(at))).toBe(true);
    }
  });

  it("untouched: the resolver's own row (the app's), a row already read, another branch's row, the open branch's row", () => {
    expect(one(`SELECT count(*) FROM notifications WHERE id IN ('${ids.resolverOwn}', '${ids.poolRead}', '${ids.poolOpenBranch}', '${ids.poolOtherBranch}') AND metadata ? 'superseded_at'`)).toBe("0");
    expect(one(`SELECT read_at IS NULL FROM notifications WHERE id = '${ids.resolverOwn}'`)).toBe("t");
    expect(bell(m.resolver)).toBe("1");
  });

  it("why the caller's own row is the app's: 20261161's rail refuses a recipient's session a metadata change on their own row", () => {
    const r = asCaller(db, m.resolver.caller, `UPDATE notifications SET metadata = metadata || '{"superseded_at":"2026-10-22T00:00:00.000Z"}'::jsonb WHERE id = '${ids.resolverOwn}'`);
    expect(r).toMatchObject({ ok: false, code: "42501" });
    // …and the server's reconcile pass (the service role) may mark it
    expect(asCaller(db, SERVICE, `UPDATE notifications SET metadata = metadata || '{"superseded_at":"2026-10-22T00:00:00.000Z"}'::jsonb WHERE id = '${ids.resolverOwn}' AND read_at IS NULL`)).toEqual({ ok: true, rows: 1 });
    expect(bell(m.resolver)).toBe("0");
  });

  it("a second resolve call retires nothing more (each row is marked once)", () => {
    expect(selectAs(db, m.pool.caller, `SELECT clear_resolved_branch_alerts('${branch}');`)[0]).toBe("0");
  });

  it("NEDGE-24 limb 1: the service role marks a pool member's access_request_pending row (the decide path) — the rail lets it through; read_at stays NULL", () => {
    expect(asCaller(db, SERVICE, `UPDATE notifications SET metadata = metadata || '{"superseded_at":"2026-10-22T00:00:00.000Z","superseded_by":"access_request_decided"}'::jsonb WHERE id = '${ids.access}' AND read_at IS NULL AND metadata ->> 'superseded_at' IS NULL`)).toEqual({ ok: true, rows: 1 });
    expect(one(`SELECT (read_at IS NULL)::text || '|' || (metadata ->> 'requestEmail') FROM notifications WHERE id = '${ids.access}'`)).toBe("true|x@y.z");
  });
});
