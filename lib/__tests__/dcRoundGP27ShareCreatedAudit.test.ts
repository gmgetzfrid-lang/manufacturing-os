// document-control Round G — P27 SHARE REMAINDERS: intelligence DACL-4
// criterion 3, the direct-insert SHARE_LINK_CREATED audit row.
//
//   * lib/documentShares.ts createShareLink asks the database, just BEFORE its
//     insert, whether it records the mint (document_share_creation_recorded_
//     by_database, 20261227): true → the door writes NO row of its own (one
//     row per share, never two); missing / false / failed → it writes the row
//     exactly as before (two rows, never none, on a failed probe).
//   * 20261227 — the DEC-30 one-paste shape (prerequisite refusal, counts-only
//     inventory before BEGIN, ONE final SELECT check/ok/n, ordered), DRLS-16,
//     nothing re-created: every function and trigger it creates is new to the
//     sequence (the folder is scanned at test time), and the record's details
//     keys are the door's own (pinned to lib/documentShares.ts).
//   * The runtime cases (one row per share however it is created, none for a
//     refused mint or the service role, the refusal without 20261080, the
//     re-paste) run on PostgreSQL 16 in lib/__tests__/rls/dcP27ShareRemainders.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  probe: { data: null as unknown, error: null as null | { code?: string; message: string } } as { data: unknown; error: null | { code?: string; message: string } } | "throw",
  insertError: null as null | { code?: string; message: string },
  order: [] as string[],
  audits: [] as Row[],
  inserts: [] as Row[],
}));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    let op: "select" | "insert" = "select";
    let payload: Row = {};
    const c: Row = {};
    const h: ProxyHandler<Row> = {
      get(_t, prop: string) {
        if (prop === "then") return (res: (v: unknown) => void) => res({ data: table === "document_holds" ? [] : null, error: null });
        return (...args: unknown[]) => {
          if (prop === "insert") { op = "insert"; payload = args[0] as Row; }
          if (prop === "maybeSingle" || prop === "single") {
            if (op === "insert") {
              state.order.push("insert");
              state.inserts.push(payload);
              return Promise.resolve(state.insertError ? { data: null, error: state.insertError } : { data: { id: "share-1", ...payload }, error: null });
            }
            if (table === "documents") return Promise.resolve({ data: { status: "Issued", archived_at: null, acl_index: null }, error: null });
            return Promise.resolve({ data: null, error: null });
          }
          return new Proxy(c, h);
        };
      },
    };
    return new Proxy(c, h);
  };
  return {
    supabase: {
      from: (t: string) => chain(t),
      rpc: async (fn: string) => {
        state.order.push(`rpc:${fn}`);
        if (fn !== "document_share_creation_recorded_by_database") return { data: false, error: null };
        if (state.probe === "throw") throw new Error("network down");
        return state.probe;
      },
      auth: { getSession: async () => ({ data: { session: null } }) },
    },
  };
});
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async (e: Row) => { state.order.push("audit"); state.audits.push(e); return { error: null }; }) }));

import { createShareLink, isShareCreationRecordedByDatabase, SHARE_MINT_REFUSED } from "@/lib/documentShares";

const input = { orgId: "orgA", documentId: "docA", createdBy: "u1", createdByName: "u", expiresInDays: 7, note: "for the vendor" };

beforeEach(() => {
  state.probe = { data: null, error: null };
  state.insertError = null;
  state.order = [];
  state.audits = [];
  state.inserts = [];
});

describe("DACL-4 c3 — the door writes no second row once the database records the mint", () => {
  it("probe true (20261227 pasted): one insert, NO app-written SHARE_LINK_CREATED, no warning — and the probe is asked BEFORE the insert", async () => {
    state.probe = { data: true, error: null };
    const made = await createShareLink(input);
    expect(made.id).toBe("share-1");
    expect(made.auditWarning).toBeNull();
    expect(state.inserts).toHaveLength(1);
    expect(state.audits).toEqual([]);
    expect(state.order.indexOf("rpc:document_share_creation_recorded_by_database")).toBeLessThan(state.order.indexOf("insert"));
  });

  it("REGRESSION — before the paste (PGRST202 / 42883), on false, on any error or a throw: the door writes its row exactly as before (two rows, never none, on a failed probe)", async () => {
    const worlds: Array<typeof state.probe> = [
      { data: null, error: { code: "PGRST202", message: "Could not find the function public.document_share_creation_recorded_by_database without parameters in the schema cache" } },
      { data: null, error: { code: "42883", message: "function document_share_creation_recorded_by_database() does not exist" } },
      { data: false, error: null },
      { data: null, error: { code: "PGRST000", message: "upstream timeout" } },
      "throw",
    ];
    for (const w of worlds) {
      state.probe = w; state.audits = []; state.inserts = [];
      const made = await createShareLink(input);
      expect(made.auditWarning, JSON.stringify(w)).toBeNull();
      expect(state.inserts).toHaveLength(1);
      expect(state.audits, JSON.stringify(w)).toEqual([expect.objectContaining({
        action: "SHARE_LINK_CREATED", resourceId: "docA", resourceType: "document", orgId: "orgA", userId: "u1",
        details: { shareId: "share-1", expiresAt: expect.any(String), note: "for the vendor" },
      })]);
    }
  });

  it("a refused mint writes nothing, whichever world (the record goes with the share)", async () => {
    for (const p of [{ data: true, error: null }, { data: false, error: null }] as const) {
      state.probe = p; state.audits = [];
      state.insertError = { code: "42501", message: 'new row violates row-level security policy for table "document_shares"' };
      await expect(createShareLink(input)).rejects.toThrow(SHARE_MINT_REFUSED);
      expect(state.audits).toEqual([]);
    }
  });

  it("isShareCreationRecordedByDatabase answers true only for a literal true", async () => {
    for (const [p, want] of [
      [{ data: true, error: null }, true], [{ data: "true", error: null }, false], [{ data: null, error: null }, false],
      [{ data: true, error: { message: "x" } }, false], ["throw", false],
    ] as const) {
      state.probe = p as typeof state.probe;
      expect(await isShareCreationRecordedByDatabase(), JSON.stringify(p)).toBe(want);
    }
  });
});

// ── 20261227's shape ────────────────────────────────────────────────────────
const MIG_DIR = join(process.cwd(), "supabase", "migrations");
const FILE = "20261227_dc_roundG_share_created_audit.sql";
const sql = readFileSync(join(MIG_DIR, FILE), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
const code = stripComments(sql);

describe("20261227 — DEC-30 one paste, DRLS-16, nothing re-created", () => {
  it("prerequisite refusal → counts-only inventory (TEMP, before BEGIN) → ONE BEGIN/COMMIT → ONE ordered final SELECT (check, ok, n)", () => {
    const pre = code.indexOf("20261227 needs 20261080");
    const temp = code.indexOf("CREATE TEMP TABLE dc_round_g_227_before");
    const begin = code.indexOf("\nBEGIN;");
    const commit = code.indexOf("\nCOMMIT;");
    expect(pre).toBeGreaterThan(0);
    expect(temp).toBeGreaterThan(pre);
    expect(begin).toBeGreaterThan(temp);
    expect(commit).toBeGreaterThan(begin);
    expect(code.match(/\nBEGIN;/g)).toHaveLength(1);
    expect(code.match(/\nCOMMIT;/g)).toHaveLength(1);
    // the prerequisite asks for 20261080's own artifacts
    expect(code).toMatch(/to_regprocedure\('public\.document_share_refusal\(uuid,uuid\)'\) IS NULL/);
    expect(code).toMatch(/with_check LIKE '%document_share_refusal\(%'/);
    // the inventory is aggregate counts only — never a row
    const inv = code.slice(temp, begin);
    expect(inv.match(/COUNT\(\*\)::text/g)?.length).toBe(5);
    expect(inv).not.toMatch(/SELECT\s+(s|a)\.\*/);
    // after COMMIT: one statement, the ordered result set in the fixed shape
    const tail = code.slice(commit + "\nCOMMIT;".length).trim();
    // (a `;` inside a probe's LIKE pattern is not a statement end: count line ends)
    expect(tail.split("\n").filter((l) => /;\s*$/.test(l))).toEqual(["ORDER BY sec, ord;"]);
    expect(tail).toMatch(/^SELECT "check", ok, n FROM \(/);
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,[\s\S]*NULL::text AS n/);
    expect(tail).toMatch(/\) AS result\s+ORDER BY sec, ord;$/);
    expect(tail).toMatch(/SELECT 2, ord, inventory, NULL, n FROM dc_round_g_227_before/);
  });

  it("DRLS-16: the trigger function is SECURITY DEFINER with search_path pinned and EXECUTE revoked from PUBLIC, anon and authenticated; the probe is invoker, pinned, for authenticated and service_role only", () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION record_document_share_created\(\)\s*\nRETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION record_document_share_created\(\) FROM PUBLIC, anon, authenticated;/);
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION document_share_creation_recorded_by_database\(\)\s*\nRETURNS boolean LANGUAGE sql STABLE SET search_path = public AS \$\$/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION document_share_creation_recorded_by_database\(\) FROM PUBLIC, anon;\s*\nGRANT EXECUTE ON FUNCTION document_share_creation_recorded_by_database\(\) TO authenticated, service_role;/);
    expect(code).toMatch(/CREATE TRIGGER trg_document_share_created_audit\s*\nAFTER INSERT ON document_shares\s*\nFOR EACH ROW EXECUTE FUNCTION record_document_share_created\(\);/);
  });

  it("re-creates nothing: every function and trigger it defines is new to the sequence (scanned at test time), and it touches no policy, no guard and no row", () => {
    const earlier = readdirSync(MIG_DIR).filter((f) => /^\d{8}.*\.sql$/.test(f) && f < FILE);
    const defined = [...code.matchAll(/CREATE (?:OR REPLACE )?(?:FUNCTION|TRIGGER)\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]);
    expect(defined.sort()).toEqual(["document_share_creation_recorded_by_database", "record_document_share_created", "trg_document_share_created_audit"]);
    for (const f of earlier) {
      const body = stripComments(readFileSync(join(MIG_DIR, f), "utf8"));
      for (const name of defined) expect(body.includes(name), `${f} already names ${name}`).toBe(false);
    }
    expect(code).not.toMatch(/CREATE POLICY|DROP POLICY|ALTER POLICY/);
    expect(code).not.toMatch(/document_shares_anchor_immutable|document_share_refusal\(uuid, uuid\)\s*RETURNS/);
    expect(code.slice(code.indexOf("\nBEGIN;"), code.indexOf("\nCOMMIT;"))).not.toMatch(/\b(UPDATE|DELETE FROM|INSERT INTO document_shares)\b/);
  });

  it("the record is the door's: SHARE_LINK_CREATED on the document, the caller as actor, details keys = createShareLink's (shareId, expiresAt, note) + recordedBy — only for a signed-in caller", () => {
    const fn = code.slice(code.indexOf("CREATE OR REPLACE FUNCTION record_document_share_created()"), code.indexOf("REVOKE ALL ON FUNCTION record_document_share_created()"));
    expect(fn).toMatch(/v_actor uuid := auth\.uid\(\);/);
    expect(fn).toMatch(/IF v_actor IS NULL THEN\s*\n\s*RETURN NULL;\s*\n\s*END IF;/);
    expect(fn).toMatch(/INSERT INTO audit_logs \(action, resource_id, resource_type, org_id, user_id, details\)\s*\n\s*VALUES \('SHARE_LINK_CREATED', NEW\.document_id::text, 'document', NEW\.org_id, v_actor,/);
    const built = fn.slice(fn.indexOf("jsonb_build_object("), fn.indexOf("));"));
    const sqlKeys = [...built.matchAll(/'([a-zA-Z]+)', (?:NEW\.|')/g)].map((m) => m[1]);
    // the door's own keys, read from lib/documentShares.ts's audit call
    const door = readFileSync(join(process.cwd(), "lib", "documentShares.ts"), "utf8");
    const call = door.slice(door.indexOf('action: "SHARE_LINK_CREATED"'), door.indexOf('action: "SHARE_LINK_CREATED"') + 400);
    const doorKeys = [...(call.match(/details: \{([^}]*)\}/)?.[1] ?? "").matchAll(/([a-zA-Z]+):/g)].map((m) => m[1]);
    expect(doorKeys).toEqual(["shareId", "expiresAt", "note"]);
    expect(sqlKeys).toEqual([...doorKeys, "recordedBy"]);
    expect(call).toMatch(/resourceId: input\.documentId,\s*\n\s*resourceType: "document",/);
  });
});
