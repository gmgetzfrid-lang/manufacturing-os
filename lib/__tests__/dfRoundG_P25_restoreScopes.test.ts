// drafting-flow Round G, DF-P25 — the DF-P24 follow-up (DEC-90 ruling (7)
// for DF-P25): ticket_examination_scopes is exported AND now restored after
// tickets, with the waiver cleared (a person's recorded decision in the
// source workspace, which a restore cannot re-make) and every uid in it
// (updated_by, each value's `by`) remapped like any user reference. The
// table is out of IMMUTABLE_TABLES; every other table restores as before.

import { describe, it, expect, beforeEach } from "vitest";
import { db, from, type Row } from "./helpers/restoreMemoryDb";
import {
  applyRestoreChunk, landRestoredRow, remapRow, isImmutableTable, IMMUTABLE_TABLES, RESTORE_SERVICE_ROLE_WAIVERS,
  RESTORE_TABLE_ORDER, RESTORE_PARENT_RULES, conflictTargetFor, restoreTableRefusal,
} from "@/lib/dataRestore";
import { ORG_SCOPED_TABLES } from "@/lib/exportTables";

const ORG = "org-target";
const sb = { from } as never;
const remap = { orgId: { "backup-org": ORG }, uid: { "old-eng": "new-eng", "old-adm": "new-adm" } };
const scopeRow = (ticket: string, waiver: unknown = null): Row => ({
  ticket_id: ticket, org_id: "backup-org",
  field_values: { gov: { value: "b31-3", by: "old-eng", at: "2026-10-01T00:00:00Z" } },
  waiver, updated_at: "2026-10-01T00:00:00Z", updated_by: "old-eng",
});
const WAIVER = { reason: "vendor data pending", by: "old-adm", at: "2026-10-02T00:00:00Z", fields: ["gov"], rev: "1" };

beforeEach(() => {
  db.rows = {
    orgs: [{ id: ORG, name: "Acme" }],
    tickets: [{ id: "t-1", org_id: ORG }, { id: "t-2", org_id: ORG }],
    users: [{ id: "new-eng" }, { id: "new-adm" }],
  };
  db.keys = { ticket_examination_scopes: [["ticket_id"]] };
  db.readError = {};
  db.writes = [];
  db.attempts = [];
  db.countless = false;
  db.fks = {};
  db.maxRows = 1000;
  db.generated = {};
  db.authUsers = null;
  db.missingColumns = {};
  db.writeError = null;
});

describe("DF-P25 (ruling 7) — the restore imports ticket_examination_scopes", () => {
  it("is no longer append-only / never-imported; it is a service-role table restored after tickets, keyed by its request", () => {
    expect(isImmutableTable("ticket_examination_scopes")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(IMMUTABLE_TABLES, "ticket_examination_scopes")).toBe(false);
    expect(RESTORE_SERVICE_ROLE_WAIVERS.ticket_examination_scopes).toMatch(/WAIVER is cleared on restore/);
    expect(restoreTableRefusal("ticket_examination_scopes")).toBeNull();
    const order = RESTORE_TABLE_ORDER as readonly string[];
    expect(order.indexOf("ticket_examination_scopes")).toBeGreaterThan(order.indexOf("tickets"));
    expect(conflictTargetFor("ticket_examination_scopes")).toBe("ticket_id");
    expect(RESTORE_PARENT_RULES.ticket_examination_scopes).toBeTruthy();
    expect(ORG_SCOPED_TABLES as readonly string[]).toContain("ticket_examination_scopes");
  });

  it("the row transform clears the waiver and nothing else; the uids are remapped (updated_by, each value's `by`)", () => {
    const landed = landRestoredRow("ticket_examination_scopes", remapRow(scopeRow("t-1", WAIVER), remap, "ticket_examination_scopes"));
    expect(landed.waiver).toBeNull();
    expect(landed.updated_by).toBe("new-eng");
    expect(landed.org_id).toBe(ORG);
    expect(landed.field_values).toEqual({ gov: { value: "b31-3", by: "new-eng", at: "2026-10-01T00:00:00Z" } });
    // a row with no waiver is handed back as it is (same object)
    const plain = remapRow(scopeRow("t-1"), remap, "ticket_examination_scopes");
    expect(landRestoredRow("ticket_examination_scopes", plain)).toBe(plain);
  });

  it("REGRESSION: no other table's row is touched by the transform (a `waiver` column elsewhere is kept)", () => {
    const other = { id: "x", waiver: { reason: "kept" } };
    expect(landRestoredRow("ticket_equipment", other)).toBe(other);
    expect(landRestoredRow("tickets", other)).toBe(other);
  });

  it("a chunk lands in this workspace with the waiver cleared; a re-run writes nothing new", async () => {
    const rows = [scopeRow("t-1", WAIVER), scopeRow("t-2")];
    const r = await applyRestoreChunk(sb, { orgId: ORG, table: "ticket_examination_scopes", idRemap: remap, rows });
    expect(r.ok).toBe(true);
    expect(r.refused).toEqual([]);
    expect(r.inserted).toBe(2);
    const landed = (db.rows.ticket_examination_scopes ?? []) as Row[];
    expect(landed.map((x) => [x.ticket_id, x.org_id, x.waiver, x.updated_by]).sort()).toEqual([
      ["t-1", ORG, null, "new-eng"], ["t-2", ORG, null, "new-eng"],
    ]);
    const again = await applyRestoreChunk(sb, { orgId: ORG, table: "ticket_examination_scopes", idRemap: remap, rows });
    expect(again).toMatchObject({ ok: true, inserted: 0, existing: 2 });
  });

  it("a row whose request is not in this workspace is not written", async () => {
    const r = await applyRestoreChunk(sb, { orgId: ORG, table: "ticket_examination_scopes", idRemap: remap, rows: [scopeRow("t-elsewhere")] });
    expect(r.inserted).toBe(0);
    expect(((db.rows.ticket_examination_scopes ?? []) as Row[]).length).toBe(0);
  });
});
