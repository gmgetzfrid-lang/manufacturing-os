// drafting-flow Round G, DF-P23 TRANSITION RECORD AND RECONCILE — the
// intelligence GAP-312 follow-up (DEC-90 ruling (4) for DF-P23) and WIRE-7
// criterion 1 (ruling (3)), the app half and the migration's shape:
//
//   * POST /api/tickets/equipment: the race the read-then-write check cannot
//     close is closed by 20261265's unique index — the losing insert (23505)
//     is recorded not applied (reason already_listed) and answered as the
//     sequential case is; a respelling of one entry replaces it in one
//     transaction (replace_ticket_equipment), and before the paste
//     (PGRST202) takes today's add-then-remove. The route's already_listed
//     check is unchanged (REGRESSION).
//   * the create route's parse lists one tag once by the same key, saying so.
//   * 20261265 is DEC-30 shaped: prerequisites, a counts-only inventory
//     before BEGIN, one final SELECT; its functions are new (no earlier body
//     to re-create); the duplicate refusal precedes the index.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import type { MemoryState } from "./helpers/memoryDb";

const h = vi.hoisted(() => ({
  admin: null as unknown as MemoryState,
  user: { id: "u-req", email: "req@plant.io" } as { id: string; email: string } | null,
  policy: { ok: true, policy: undefined, version: null } as Record<string, unknown>,
}));

vi.mock("@/lib/supabaseAdmin", async () => {
  const mem = await import("./helpers/memoryDb");
  h.admin = mem.freshState();
  const sb = mem.makeSupabase(h.admin) as Record<string, unknown>;
  sb.auth = { getUser: async () => (h.user ? { data: { user: h.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) };
  return { supabaseAdmin: sb };
});
vi.mock("@/lib/capabilityPolicy", async (orig) => ({
  ...(await orig<typeof import("@/lib/capabilityPolicy")>()),
  loadCapabilityPolicyStrict: vi.fn(async () => h.policy),
}));

import { POST, REPLACE_EQUIPMENT_RPC } from "@/app/api/tickets/equipment/route";
import { resetState } from "./helpers/memoryDb";
import { parseTicketCreateBody } from "@/lib/ticketCreate";
import { tagKey } from "@/lib/codebook";
import { equipmentListingKey, equipmentTagListed } from "@/lib/ticketEquipment";

type Row = Record<string, unknown>;
const ORG = "o-1";
const T = "11111111-1111-4111-8111-111111111111";
const ROW = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const req = (body: unknown) => POST(new NextRequest("https://app.plant.io/api/tickets/equipment", {
  method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const seed = () => {
  resetState(h.admin);
  h.user = { id: "u-req", email: "req@plant.io" };
  h.admin.tables.tickets = [{
    id: T, org_id: ORG, status: "DRAFTING", archived_at: null, request_type: "ISO", unit: null,
    requester_id: "u-req", assigned_drafter_id: "u-drf", assigned_engineer_id: null, watchers: [],
  }];
  h.admin.tables.org_members = [{ org_id: ORG, uid: "u-req", role: "Viewer", roles: [], email: "req@plant.io", status: "active" }];
  h.admin.tables.assets = [];
  h.admin.tables.ticket_equipment = [];
};
const equipment = () => (h.admin.tables.ticket_equipment ?? []) as Row[];
const audits = () => (h.admin.tables.audit_logs ?? []) as Row[];
/** 20261265's replace, in memory: the old row out, the new row in — both or neither. */
const installReplace = () => {
  h.admin.rpc = {
    [REPLACE_EQUIPMENT_RPC]: (a) => {
      const rows = equipment();
      const at = rows.findIndex((r) => r.id === a.p_row_id && r.ticket_id === a.p_ticket_id && r.org_id === a.p_org_id);
      if (at < 0) return { data: null, error: { code: "P0002", message: "replace_ticket_equipment: that entry is not on this request" } };
      const id = "eq-new";
      h.admin.tables.ticket_equipment = [...rows.slice(0, at), ...rows.slice(at + 1), { id, org_id: a.p_org_id, ticket_id: a.p_ticket_id, tag: a.p_tag, asset_id: a.p_asset_id, created_by: a.p_created_by }];
      return { data: id, error: null };
    },
  };
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  seed();
});

describe("GAP-312 follow-up — the race the check cannot close (20261265's index)", () => {
  it("an add whose insert meets the index (23505: a concurrent add listed the tag) is answered 'already listed', recorded not applied", async () => {
    h.admin.tableWriteError = { ticket_equipment: { code: "23505", message: 'duplicate key value violates unique constraint "ticket_equipment_ticket_tag_key_uniq"' } };
    const res = await req({ ticketId: T, action: "add", tag: "E-22" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, unchanged: true, message: "E-22 is already listed on this request." });
    const attempt = audits().find((a) => a.action === "TICKET_EQUIPMENT_ADDED")!;
    const follow = audits().find((a) => a.action === "TICKET_EQUIPMENT_ADDED_NOT_APPLIED")!;
    expect(follow.details).toMatchObject({ attempt: attempt.id, tag: "E-22", reason: "already_listed" });
  });
  it("a correction that meets the index (another entry now holds the tag) is a 409 already_listed, recorded not applied, the old entry kept", async () => {
    h.admin.tables.ticket_equipment = [{ id: ROW, org_id: ORG, ticket_id: T, tag: "P-1O1", asset_id: null, created_by: "u-req" }];
    h.admin.tableWriteError = { ticket_equipment: { code: "23505", message: "duplicate key" } };
    const res = await req({ ticketId: T, action: "correct", rowId: ROW, tag: "E-22" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "already_listed" });
    expect(equipment()).toEqual([expect.objectContaining({ id: ROW, tag: "P-1O1" })]);
    expect(audits().find((a) => a.action === "TICKET_EQUIPMENT_CORRECTED_NOT_APPLIED")?.details).toMatchObject({ reason: "already_listed" });
  });
  it("REGRESSION: the sequential check is unchanged — a listed tag ('p 101' is 'P-101') writes nothing, not even an audit row", async () => {
    expect((await req({ ticketId: T, action: "add", tag: "P-101" })).status).toBe(200);
    const n = audits().length;
    expect(await (await req({ ticketId: T, action: "add", tag: "p 101" })).json()).toMatchObject({ unchanged: true });
    expect(equipment()).toHaveLength(1);
    expect(audits()).toHaveLength(n);
  });
});

describe("GAP-312 follow-up — a respelling of the same tag", () => {
  it("after 20261265: replaced in ONE call (the index would refuse an add beside the old row) — the old entry gone, the new one listed, one audit row", async () => {
    installReplace();
    h.admin.tables.ticket_equipment = [{ id: ROW, org_id: ORG, ticket_id: T, tag: "e22", asset_id: null, created_by: "u-req" }];
    const res = await req({ ticketId: T, action: "correct", rowId: ROW, tag: "E-22" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: "eq-new", tag: "E-22" });
    expect(equipment()).toEqual([expect.objectContaining({ id: "eq-new", tag: "E-22" })]);
    expect(h.admin.writes.filter((w) => w.table === "ticket_equipment")).toEqual([]);
    expect(audits().map((a) => a.action)).toEqual(["TICKET_EQUIPMENT_CORRECTED"]);
    const call = h.admin.calls.find((c) => c.table === `rpc:${REPLACE_EQUIPMENT_RPC}`)!;
    expect(call.args[0]).toMatchObject({ p_row_id: ROW, p_ticket_id: T, p_org_id: ORG, p_tag: "E-22", p_asset_id: null, p_created_by: "u-req" });
  });
  it("before 20261265 (PGRST202; 20261251's trigger refuses the in-place respelling): today's add-then-remove, exactly as before", async () => {
    h.admin.tables.ticket_equipment = [{ id: ROW, org_id: ORG, ticket_id: T, tag: "e22", asset_id: null, created_by: "u-req" }];
    h.admin.methodWriteError = { ticket_equipment: { update: { code: "P0001", message: "ticket_equipment: a recorded tag is not rewritten (only its asset clears, when the asset is deleted)" } } };
    const res = await req({ ticketId: T, action: "correct", rowId: ROW, tag: "E-22" });
    expect(res.status).toBe(200);
    expect(equipment()).toEqual([expect.objectContaining({ tag: "E-22" })]);
    expect(equipment()[0].id).not.toBe(ROW);
    // the refused in-place attempt changed nothing; then the add and the removal, as before
    expect(h.admin.writes.filter((w) => w.table === "ticket_equipment").map((w) => [w.method, w.matched])).toEqual([["update", 0], ["insert", 1], ["delete", 1]]);
    expect(audits().map((a) => a.action)).toEqual(["TICKET_EQUIPMENT_CORRECTED"]);
  });
  it("DF-P23 merge-time fix pass: PGRST202 right after the paste (schema cache not reloaded) — a same-key respelling rewrites that row's tag in place: 200, the row updated, never 409", async () => {
    h.admin.tables.ticket_equipment = [{ id: ROW, org_id: ORG, ticket_id: T, tag: "e22", asset_id: null, created_by: "u-drf" }];
    // the index is there: an add beside the old row would be refused
    h.admin.methodWriteError = { ticket_equipment: { insert: { code: "23505", message: 'duplicate key value violates unique constraint "ticket_equipment_ticket_tag_key_uniq"' } } };
    const res = await req({ ticketId: T, action: "correct", rowId: ROW, tag: "E-22" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: ROW, tag: "E-22", resolution: "not_found" });
    expect(equipment()).toEqual([expect.objectContaining({ id: ROW, tag: "E-22", asset_id: null, created_by: "u-drf" })]);
    const writes = h.admin.writes.filter((w) => w.table === "ticket_equipment");
    expect(writes.map((w) => [w.method, w.matched])).toEqual([["update", 1]]);
    // one UPDATE by row id, as read (the tag it had), in this request and workspace
    expect(writes[0].payload).toEqual({ tag: "E-22", asset_id: null });
    expect(writes[0].filters).toEqual([["id", ROW], ["ticket_id", T], ["org_id", ORG], ["tag", "e22"]]);
    expect(h.admin.calls.some((c) => c.table === `rpc:${REPLACE_EQUIPMENT_RPC}`)).toBe(true);
    expect(audits().map((a) => a.action)).toEqual(["TICKET_EQUIPMENT_CORRECTED"]);
    expect(audits()[0].details).toMatchObject({ tag: "E-22", replaces: { rowId: ROW, tag: "e22" } });
  });
  it("DF-P23 merge-time fix pass: PGRST202 with a DIFFERENT-key correction — unchanged: no in-place write, add then remove (and the index's 23505 is still the 409)", async () => {
    h.admin.tables.ticket_equipment = [{ id: ROW, org_id: ORG, ticket_id: T, tag: "P-1O1", asset_id: null, created_by: "u-req" }];
    expect((await req({ ticketId: T, action: "correct", rowId: ROW, tag: "P-101" })).status).toBe(200);
    expect(h.admin.writes.filter((w) => w.table === "ticket_equipment").map((w) => w.method)).toEqual(["insert", "delete"]);
    expect(equipment()).toEqual([expect.objectContaining({ tag: "P-101" })]);
    seed();
    h.admin.tables.ticket_equipment = [{ id: ROW, org_id: ORG, ticket_id: T, tag: "P-1O1", asset_id: null, created_by: "u-req" }];
    h.admin.methodWriteError = { ticket_equipment: { insert: { code: "23505", message: "duplicate key" } } };
    const res = await req({ ticketId: T, action: "correct", rowId: ROW, tag: "E-22" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "already_listed" });
    expect(h.admin.writes.filter((w) => w.table === "ticket_equipment").map((w) => w.method)).toEqual(["insert"]);
    expect(equipment()).toEqual([expect.objectContaining({ id: ROW, tag: "P-1O1" })]);
  });
  it("a refused replace changes nothing: 500, recorded not applied, the old entry stays", async () => {
    h.admin.rpc = { [REPLACE_EQUIPMENT_RPC]: () => ({ data: null, error: { code: "57014", message: "timeout" } }) };
    h.admin.tables.ticket_equipment = [{ id: ROW, org_id: ORG, ticket_id: T, tag: "e22", asset_id: null, created_by: "u-req" }];
    const res = await req({ ticketId: T, action: "correct", rowId: ROW, tag: "E-22" });
    expect(res.status).toBe(500);
    expect(equipment()).toEqual([expect.objectContaining({ id: ROW, tag: "e22" })]);
    expect(audits().find((a) => a.action === "TICKET_EQUIPMENT_CORRECTED_NOT_APPLIED")?.details).toMatchObject({ reason: "write_failed" });
  });
  it("DF-P23 fix pass (review, major): a case-only correction of a non-Latin tag ('насос' → 'Насос') is a respelling — replaced in one call, never refused as listed twice", async () => {
    installReplace();
    h.admin.tables.ticket_equipment = [{ id: ROW, org_id: ORG, ticket_id: T, tag: "насос", asset_id: null, created_by: "u-req" }];
    const res = await req({ ticketId: T, action: "correct", rowId: ROW, tag: "Насос" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: "eq-new", tag: "Насос" });
    expect(equipment()).toEqual([expect.objectContaining({ id: "eq-new", tag: "Насос" })]);
    expect(h.admin.calls.some((c) => c.table === `rpc:${REPLACE_EQUIPMENT_RPC}`)).toBe(true);
    expect(audits().map((a) => a.action)).toEqual(["TICKET_EQUIPMENT_CORRECTED"]);
  });
  it("DF-P23 fix pass: a correction whose add the index refuses (the database lowercased a letter the browser did not) is tried once as a respelling, and lands", async () => {
    installReplace();
    h.admin.tables.ticket_equipment = [{ id: ROW, org_id: ORG, ticket_id: T, tag: "P-1O1", asset_id: null, created_by: "u-req" }];
    h.admin.tableWriteError = { ticket_equipment: { code: "23505", message: "duplicate key" } };
    const res = await req({ ticketId: T, action: "correct", rowId: ROW, tag: "P-101" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: "eq-new", tag: "P-101" });
    expect(equipment()).toEqual([expect.objectContaining({ id: "eq-new", tag: "P-101" })]);
    expect(audits().some((a) => a.action === "TICKET_EQUIPMENT_CORRECTED_NOT_APPLIED")).toBe(false);
  });
  it("DF-P23 fix pass: that retry refused too (23505 — another entry holds the tag) is the 409 already_listed, nothing changed; an entry removed meanwhile (P0002) is a 409 entry_gone", async () => {
    h.admin.rpc = { [REPLACE_EQUIPMENT_RPC]: () => ({ data: null, error: { code: "23505", message: "duplicate key" } }) };
    h.admin.tables.ticket_equipment = [{ id: ROW, org_id: ORG, ticket_id: T, tag: "P-1O1", asset_id: null, created_by: "u-req" }];
    h.admin.tableWriteError = { ticket_equipment: { code: "23505", message: "duplicate key" } };
    const res = await req({ ticketId: T, action: "correct", rowId: ROW, tag: "E-22" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "already_listed" });
    expect(equipment()).toEqual([expect.objectContaining({ id: ROW, tag: "P-1O1" })]);
    expect(audits().filter((a) => a.action === "TICKET_EQUIPMENT_CORRECTED_NOT_APPLIED")).toHaveLength(1);
    seed();
    h.admin.rpc = { [REPLACE_EQUIPMENT_RPC]: () => ({ data: null, error: { code: "P0002", message: "replace_ticket_equipment: that entry is not on this request" } }) };
    h.admin.tables.ticket_equipment = [{ id: ROW, org_id: ORG, ticket_id: T, tag: "e22", asset_id: null, created_by: "u-req" }];
    const gone = await req({ ticketId: T, action: "correct", rowId: ROW, tag: "E-22" });
    expect(gone.status).toBe(409);
    expect(await gone.json()).toMatchObject({ code: "entry_gone", applied: false });
    expect(audits().find((a) => a.action === "TICKET_EQUIPMENT_CORRECTED_NOT_APPLIED")?.details).toMatchObject({ reason: "entry_gone" });
  });
  it("a correction to a DIFFERENT tag still adds then removes (no call), as before", async () => {
    installReplace();
    h.admin.tables.ticket_equipment = [{ id: ROW, org_id: ORG, ticket_id: T, tag: "P-1O1", asset_id: null, created_by: "u-req" }];
    expect((await req({ ticketId: T, action: "correct", rowId: ROW, tag: "P-101" })).status).toBe(200);
    expect(h.admin.calls.some((c) => c.table === `rpc:${REPLACE_EQUIPMENT_RPC}`)).toBe(false);
    expect(equipment()).toEqual([expect.objectContaining({ tag: "P-101" })]);
  });
});

describe("GAP-312 follow-up — the create route lists one tag once, by the same key", () => {
  const body = (tags: string[]) => ({
    orgId: "0a000000-0000-4000-8000-000000000001", title: "T", description: "D", requestType: "ISO", origin: { kind: "portal" },
    equipment: tags.map((tag) => ({ tag, assetId: null })),
  });
  it("'E-22' and 'E22' are one tag: the first spelling kept, the answer says so", () => {
    const out = parseTicketCreateBody(body(["E-22", "E22", "P-101"]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.input.equipment?.map((e) => e.tag)).toEqual(["E-22", "P-101"]);
    expect(out.warnings.join(" ")).toMatch(/"E22" names the same equipment as "E-22"/);
  });
  it("REGRESSION: a repeat differing only in case is dropped silently, as before; distinct tags all kept", () => {
    const out = parseTicketCreateBody(body(["e-22", "E-22", "P-101", "Насос", "Клапан"]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.input.equipment?.map((e) => e.tag)).toEqual(["e-22", "P-101", "Насос", "Клапан"]);
    expect(out.warnings.join(" ")).not.toMatch(/same equipment/);
  });
});

describe("GAP-312 follow-up (DF-P23 fix pass, review minor) — the listing key keeps a non-Latin tag's letters", () => {
  const body = (tags: string[]) => ({
    orgId: "0a000000-0000-4000-8000-000000000001", title: "T", description: "D", requestType: "ISO", origin: { kind: "portal" },
    equipment: tags.map((tag) => ({ tag, assetId: null })),
  });
  it("ASCII: exactly tagKey (else the trimmed lowercase tag) — every tag the registry's grammar reads keys as before", () => {
    for (const t of ["E-22", "E22", " e 22 ", "P-101A", "NORTH-FURNACE", "the north furnace", "a.b/c", "Tank 7 (east)", "---", "  -- "]) {
      expect(equipmentListingKey(t), t).toBe(tagKey(t) || t.trim().toLowerCase());
    }
  });
  it("pasted dashes and spaces are dropped as tagKey drops them; letters of other scripts are kept; lowercasing is context-free", () => {
    expect(equipmentListingKey("E–22")).toBe("e22");
    expect(equipmentListingKey("E\u00a022")).toBe("e22");
    expect(equipmentListingKey("E\u221222")).toBe("e22");
    expect(equipmentListingKey("Насос-1")).toBe("насос1");
    expect(equipmentListingKey("Компрессор-1")).toBe("компрессор1");
    expect(equipmentListingKey("насос")).toBe(equipmentListingKey("Насос"));
    expect(new Set(["ΟΔΟΣ", "οδος", "οδοσ"].map(equipmentListingKey)).size).toBe(1);
    expect(equipmentListingKey("İ-1")).toBe(equipmentListingKey("I-1"));
  });
  it("the create route keeps 'Насос-1' and 'Компрессор-1' both (tagKey alone read both as '1'); a repeat of one spelled in another case is still listed once", () => {
    const out = parseTicketCreateBody(body(["Насос-1", "Компрессор-1", "НАСОС-1", "ΟΔΟΣ", "οδος"]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.input.equipment?.map((e) => e.tag)).toEqual(["Насос-1", "Компрессор-1", "ΟΔΟΣ"]);
    expect(out.warnings.join(" ")).not.toMatch(/"Компрессор-1" names the same/);
  });
  it("the route's check: 'Компрессор-1' is not 'Насос-1'; 'Насос' is 'насос'", () => {
    expect(equipmentTagListed([{ id: "x", tag: "Насос-1" }], "Компрессор-1")).toBeNull();
    expect(equipmentTagListed([{ id: "x", tag: "насос" }], "Насос")).not.toBeNull();
  });
});

// ── 20261265's shape ────────────────────────────────────────────────────────
const DIR = join(process.cwd(), "supabase", "migrations");
const F = "20261265_df_roundG_transition_record.sql";
const SQL = readFileSync(join(DIR, F), "utf8");
const FILES = readdirSync(DIR).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const code = (s: string) => s.replace(/--[^\n]*/g, "");

describe("20261265 — DEC-30 one paste", () => {
  it("prerequisites, then a counts-only TEMP inventory, BEFORE the one transaction; one final SELECT (check, ok, n)", () => {
    const c = code(SQL);
    const pre = c.indexOf("20261265 needs 20261251");
    const temp = c.indexOf("CREATE TEMP TABLE df_round_g_265_before");
    const begin = c.indexOf("\nBEGIN;");
    const commit = c.indexOf("\nCOMMIT;");
    expect(pre).toBeGreaterThan(-1);
    expect(pre).toBeLessThan(temp);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect(c.match(/\nBEGIN;/g)).toHaveLength(1);
    expect(c.match(/\nCOMMIT;/g)).toHaveLength(1);
    const tail = c.slice(commit).replace(/'(?:[^']|'')*'/g, "''");
    expect(tail.match(/^SELECT "check", ok, n FROM \(/m)).not.toBeNull();
    expect(tail).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/);
    // counts only: the inventory selects COUNT / SUM, never a row
    const inv = c.slice(temp, begin);
    expect(inv).not.toMatch(/SELECT\s+\*/);
    expect(inv.match(/COUNT\(/g)!.length).toBeGreaterThanOrEqual(6);
  });
  it("the duplicate refusal precedes the index, under one lock, and deletes nothing", () => {
    const c = code(SQL);
    const lock = c.indexOf("LOCK TABLE ticket_equipment IN SHARE ROW EXCLUSIVE MODE;");
    const refuse = c.indexOf("RAISE EXCEPTION '20261265 REFUSED:");
    const index = c.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS ticket_equipment_ticket_tag_key_uniq");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(refuse);
    expect(refuse).toBeLessThan(index);
    expect(c).not.toMatch(/DELETE FROM ticket_equipment\s+WHERE(?![^;]*p_row_id)/);
    expect(c).toMatch(/SET LOCAL lock_timeout = '10s';/);
  });
  it("DF-P23 merge-time fix pass: ticket_equipment_integrity is re-created as 20261251 wrote it, with ONE change — a tag respelled within its key passes", () => {
    const body = (src: string) => {
      const at = src.indexOf("CREATE OR REPLACE FUNCTION ticket_equipment_integrity()");
      expect(at, "defined").toBeGreaterThan(-1);
      return src.slice(at, src.indexOf("\n$$;", at));
    };
    const base = body(code(readFileSync(join(DIR, "20261251_df_roundG_ticket_equipment.sql"), "utf8")));
    const now = body(code(SQL));
    expect(now).toBe(base.replace(
      "OR NEW.ticket_id IS DISTINCT FROM OLD.ticket_id OR NEW.tag IS DISTINCT FROM OLD.tag",
      "OR NEW.ticket_id IS DISTINCT FROM OLD.ticket_id\n       OR (NEW.tag IS DISTINCT FROM OLD.tag AND ticket_equipment_tag_key(NEW.tag) IS DISTINCT FROM ticket_equipment_tag_key(OLD.tag))",
    ));
    expect(now).not.toBe(base);
    // after the key function and the index; the trigger itself is not re-created
    const c = code(SQL);
    expect(c.indexOf("CREATE OR REPLACE FUNCTION ticket_equipment_integrity()")).toBeGreaterThan(c.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS ticket_equipment_ticket_tag_key_uniq"));
    expect(c).not.toMatch(/CREATE TRIGGER trg_ticket_equipment_integrity/);
    expect(c).toMatch(/REVOKE ALL ON FUNCTION ticket_equipment_integrity\(\) FROM PUBLIC, anon, authenticated, service_role;/);
  });
  it("WIRE-7 (DF-P23 merge-time fix pass): the derive trigger also runs on an archived-flag change and on a NULL code with a unit set — one lookup on the codebook's unique key", () => {
    const c = code(SQL);
    const fn = c.slice(c.indexOf("CREATE OR REPLACE FUNCTION ticket_unit_code_derive()"), c.indexOf("DROP TRIGGER IF EXISTS trg_ticket_unit_code"));
    expect(fn).toContain("AND (NEW.archived_at IS NULL) = (OLD.archived_at IS NULL)");
    expect(fn).toContain("AND NOT (NEW.unit_code IS NULL AND NEW.unit IS NOT NULL) THEN");
    expect(fn).toContain("WHERE ce.org_id = NEW.org_id AND ce.kind = 'unit' AND ce.code = NEW.unit");
    expect(code(readFileSync(join(DIR, "20260928_site_codebook.sql"), "utf8"))).toMatch(/UNIQUE \(org_id, kind, code\)/);
  });
  it("its new functions are new — no earlier migration defines them (ticket_equipment_integrity, above, is the one re-created)", () => {
    for (const fn of ["ticket_equipment_tag_key", "replace_ticket_equipment", "ticket_unit_code_derive"]) {
      const re = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+(public\\.)?${fn}\\s*\\(`);
      const earlier = FILES.filter((f) => f < F && re.test(code(readFileSync(join(DIR, f), "utf8"))));
      expect(earlier, fn).toEqual([]);
      expect(re.test(code(SQL)), fn).toBe(true);
    }
  });
  it("DRLS-16: no SECURITY DEFINER; every function pins search_path; the replace is the service role's only; the trigger function no client's", () => {
    const c = code(SQL);
    expect(c).not.toMatch(/SECURITY DEFINER/);
    expect(c.match(/SET search_path = public/g)!.length).toBe(4);
    expect(c).toMatch(/REVOKE ALL ON FUNCTION replace_ticket_equipment\(UUID, UUID, UUID, TEXT, UUID, UUID\) FROM PUBLIC, anon, authenticated;/);
    expect(c).toMatch(/GRANT EXECUTE ON FUNCTION replace_ticket_equipment\(UUID, UUID, UUID, TEXT, UUID, UUID\) TO service_role;/);
    expect(c).toMatch(/REVOKE ALL ON FUNCTION ticket_unit_code_derive\(\) FROM PUBLIC, anon, authenticated, service_role;/);
  });
  it("the SQL key is the route's (equipmentListingKey): the inventory and the function spell the same expression, and a JS transcription of it agrees on the awkward cases", () => {
    const strip = "'[^\\u0080-\\U0010ffffa-z0-9]|[\\u00a0\\u00ad\\u2000-\\u200b\\u2010-\\u2015\\u2212\\u202f\\u3000\\ufeff]'";
    const keyOf = (col: string) => `regexp_replace(translate(lower(translate(COALESCE(${col}, ''), chr(304), 'i')), chr(962), chr(963)), ${strip}, '', 'g')`;
    expect(SQL).toContain(keyOf("p_tag"));
    expect(SQL.split(keyOf("tag")).length - 1).toBe(2);
    // the SQL, transcribed (the database's lower() taken as the browser's)
    const sqlKey = (t: string) => {
      const k = t.replace(/\u0130/g, "i").toLowerCase().replace(/\u03c2/g, "\u03c3")
        .replace(/[^\u0080-\uffffa-z0-9]|[\u00a0\u00ad\u2000-\u200b\u2010-\u2015\u2212\u202f\u3000\ufeff]/g, "");
      return k === "" ? t.replace(/^\s+|\s+$/g, "").toLowerCase() : k;
    };
    const inputs = ["E-22", "E22", "e 22", "E–22", " P-101A ", "p101a", "Насос", " насос ", "Насос-1", "Компрессор-1", "ΟΔΟΣ", "οδος", "İ1", "I1", "---", "a.b/c", "😀1"];
    for (const t of inputs) expect(sqlKey(t), t).toBe(equipmentListingKey(t));
    for (const [a, b] of [["E-22", "E22"], ["e 22", "E–22"], [" P-101A ", "p101a"], ["Насос", " насос "]] as const) {
      expect(equipmentTagListed([{ id: "x", tag: a }], b)).not.toBeNull();
    }
    for (const [a, b] of [["P-101", "P-101A"], ["Насос", "Клапан"], ["E-22", "E-23"], ["Насос-1", "Компрессор-1"]] as const) {
      expect(equipmentTagListed([{ id: "x", tag: a }], b)).toBeNull();
    }
    expect(sqlKey("E-22")).toBe(tagKey("E-22"));
  });
  it("WIRE-7: unit_code is derived (never an app write): no app file writes tickets.unit_code", () => {
    const roots = ["app", "lib", "components", "hooks"];
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(join(process.cwd(), d), { withFileTypes: true })) {
        const p = `${d}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== "__tests__" && e.name !== "node_modules") walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(e.name)) continue;
        if (/unit_code\s*:/.test(readFileSync(join(process.cwd(), p), "utf8")) && /from\("tickets"\)/.test(readFileSync(join(process.cwd(), p), "utf8"))) {
          const s = readFileSync(join(process.cwd(), p), "utf8");
          // a tickets write carrying unit_code
          if (/from\("tickets"\)[\s\S]{0,200}\.(insert|update|upsert)\([^)]*unit_code/.test(s)) offenders.push(p);
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});
