// /api/storage/delete authorization (SURF-2; intelligence DACL-2 criterion 1).
//
// Deleting stored bytes must require controller authority, a safe key, and a
// clear hold AND retention status, and must be audited. These tests pin each
// Done-when criterion; several FAIL against the pre-SURF-2 route (which
// deleted for any active member, with no key check, no hold check, and no
// audit row).
//
// The stand-in is FILTER-AWARE: it applies `.eq` / `.is` / `.in` / `.limit`
// to in-memory rows, so a read answers only the rows its filters admit. The
// first version answered every document_versions read with the row whatever
// the filter, which is why it could not see that the route resolved a key by
// `file_url` alone — a revision's native source (`source_file_key`) matched
// nothing, skipped the hold checks and was destroyed with a 200 (DACL-2).
//
// Retention is judged on the document's EFFECTIVE policy (document → folder →
// library, P9's pure resolver) as well as its materialized retention_until /
// disposition_state: those columns are written best-effort, so a row never
// clocked under an in-force policy, or left with a stale earlier date after
// the policy was extended, must still be refused.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com" } as { id: string; email?: string } | null,
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  /** A table whose every read errors. */
  errors: {} as Record<string, { message: string }>,
  /** "table|column": a read of `table` filtered by `.eq(column, …)` errors —
   *  one of the two key lookups fails while the other succeeds. */
  failEq: new Set<string>(),
  /** Every `.eq` filter applied, as "table|column=value". */
  eqs: [] as string[],
  /** Every `.or(...)` call — the key lookups must never build one. */
  ors: [] as string[],
  r2sends: 0,
  audits: [] as Array<Record<string, unknown>>,
}));

function chain(table: string) {
  const preds: Array<(r: Row) => boolean> = [];
  const eqCols: string[] = [];
  let cap: number | null = null;
  let inserted: Row | null = null;
  const failed = () =>
    state.errors[table] ?? (eqCols.some((col) => state.failEq.has(`${table}|${col}`)) ? { message: "statement timeout" } : null);
  const result = () => {
    const err = failed();
    if (err) return { data: null, error: err };
    if (inserted) return { data: [{ id: "audit-1" }], error: null };
    let out = (state.rows[table] ?? []).filter((r) => preds.every((p) => p(r)));
    if (cap !== null) out = out.slice(0, cap);
    return { data: out, error: null };
  };
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (res: (v: unknown) => void) => res(result());
      return (...args: unknown[]) => {
        switch (prop) {
          case "eq": {
            const [col, val] = args as [string, unknown];
            eqCols.push(col);
            state.eqs.push(`${table}|${col}=${String(val)}`);
            preds.push((r) => r[col] === val);
            break;
          }
          case "is": {
            const [col, val] = args as [string, unknown];
            preds.push((r) => (val === null ? r[col] == null : r[col] === val));
            break;
          }
          case "in": {
            const [col, vals] = args as [string, unknown[]];
            preds.push((r) => vals.includes(r[col]));
            break;
          }
          case "limit": cap = args[0] as number; break;
          case "or": state.ors.push(`${table}|${String(args[0])}`); break;
          case "insert":
            if (table === "audit_logs") state.audits.push(args[0] as Row);
            inserted = args[0] as Row;
            break;
          case "maybeSingle": case "single": {
            const out = result();
            return Promise.resolve(out.error ? out : { data: (out.data as Row[])[0] ?? null, error: null });
          }
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: {
      getUser: vi.fn(async () =>
        state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }),
    },
    from: (t: string) => chain(t),
  },
}));

vi.mock("@/lib/r2", () => ({
  r2: { send: vi.fn(async () => { state.r2sends += 1; }) },
  R2_BUCKET: "test-bucket",
}));

import { DELETE } from "@/app/api/storage/delete/route";

const ORG = "12345678-1234-1234-1234-123456789abc";
const KEY = `orgs/${ORG}/libraries/l1/P-101.pdf`;
/** One revision's two keys: the rendered file and the native source
 *  (lib/revisions.ts writes the source under the same library prefix and
 *  records it as document_versions.source_file_key). */
const RENDERED = `orgs/${ORG}/libraries/l1/P-101__revC__1.pdf`;
const SOURCE = `orgs/${ORG}/libraries/l1/P-101__revC__source__1.dwg`;

function del(path: string): Promise<Response> {
  return DELETE(new NextRequest("https://app/api/storage/delete", {
    method: "DELETE",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ path }),
  }));
}

function member(role: string, roles: string[] = []) {
  state.rows.org_members = [{ org_id: ORG, uid: "u1", role, roles, status: "active" }];
}

/** doc1 with one revision (v1) whose rendered file and native source are
 *  RENDERED and SOURCE; `doc` overrides the document's hold / retention
 *  columns, `holds` seeds document_holds. */
function revision(doc: Row = {}, holds: Row[] = []) {
  state.rows.document_versions = [{ id: "v1", record_id: "doc1", file_url: RENDERED, source_file_key: SOURCE }];
  state.rows.documents = [{ id: "doc1", legal_hold: false, retention_until: null, disposition_state: null, ...doc }];
  state.rows.document_holds = holds;
}

/** An ISO date `days` from today. */
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
/** An ISO timestamp `days` from now (a document's created_at / updated_at). */
const ts = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
/** `basis` plus `years`, as a date — the retention date a policy clocks to. */
const plusYears = (basis: string, years: number) => {
  const d = new Date(basis);
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
};

beforeEach(() => {
  state.user = { id: "u1", email: "u1@example.com" };
  state.rows = {};
  state.errors = {};
  state.failEq = new Set();
  state.eqs = [];
  state.ors = [];
  state.r2sends = 0;
  state.audits = [];
});

describe("DELETE /api/storage/delete (SURF-2)", () => {
  it("refuses a Viewer — controller authority required (Done-when 1)", async () => {
    member("Viewer");
    const res = await del(KEY);
    expect(res.status).toBe(403);
    expect(state.r2sends).toBe(0);
  });

  it("refuses a traversal key before any prefix reasoning (Done-when 2)", async () => {
    member("Admin");
    const res = await del(`orgs/${ORG}/../../orgs/other/x.pdf`);
    expect(res.status).toBe(400);
    expect(state.r2sends).toBe(0);
  });

  it("refuses a non-org-prefixed key outright", async () => {
    member("Admin");
    const res = await del("stray.bin");
    expect(res.status).toBe(403);
    expect(state.r2sends).toBe(0);
  });

  it("refuses deletion of a legally-held document's bytes, fail-closed (Done-when 3)", async () => {
    member("DocCtrl");
    revision({ legal_hold: true });
    const res = await del(RENDERED);
    expect(res.status).toBe(423);
    expect(state.r2sends).toBe(0);
  });

  it("refuses when an active hold exists", async () => {
    member("DocCtrl");
    revision({}, [{ id: "h1", document_id: "doc1", released_at: null }]);
    const res = await del(RENDERED);
    expect(res.status).toBe(423);
    expect(state.r2sends).toBe(0);
  });

  it("a RELEASED hold does not refuse (the hold read is scoped to released_at IS NULL)", async () => {
    member("DocCtrl");
    revision({}, [{ id: "h1", document_id: "doc1", released_at: "2026-09-01T00:00:00Z" }]);
    const res = await del(RENDERED);
    expect(res.status).toBe(200);
    expect(state.r2sends).toBe(1);
  });

  it("refuses when hold status cannot be verified — fail closed", async () => {
    member("Admin");
    state.errors.document_versions = { message: "db down" };
    const res = await del(KEY);
    expect(res.status).toBe(503);
    expect(state.r2sends).toBe(0);
  });

  it("deletes and writes an audit row for a controller on a clear document (Done-when 4)", async () => {
    member("Admin");
    revision();
    const res = await del(RENDERED);
    expect(res.status).toBe(200);
    expect(state.r2sends).toBe(1);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0].action).toBe("STORAGE_OBJECT_DELETE");
    expect(state.audits[0].org_id).toBe(ORG);
    expect(state.audits[0].resource_id).toBe("doc1");
  });

  it("admits a ['Manager','DocCtrl'] member — additive role read, not headline-only", async () => {
    member("Manager", ["Manager", "DocCtrl"]);
    // key not tied to a document (no document_versions row names it)
    const res = await del(KEY);
    expect(res.status).toBe(200);
    expect(state.r2sends).toBe(1);
  });

  it("refuses the delete when the audit row cannot be written — custody before destruction", async () => {
    // The custody record is written BEFORE r2 destruction and the route fails
    // closed on it: bytes destroyed with no audit row is the unrecoverable
    // ordering. (postgrest resolves failures into { error } — the route must
    // CHECK it, not rely on a catch.)
    member("Admin");
    state.errors.audit_logs = { message: "insert failed" };
    const res = await del(KEY);
    expect(res.status).toBe(503);
    expect(state.r2sends).toBe(0); // nothing was destroyed
  });
});

describe("DACL-2 criterion 1 (a): the key resolves against BOTH file_url and source_file_key", () => {
  for (const hold of ["legal_hold", "document_holds"] as const) {
    it(`a document held by ${hold}: its native source file is refused 423 like its rendered file, nothing deleted, no custody row`, async () => {
      member("Requester", ["Requester", "DocCtrl"]);
      if (hold === "legal_hold") revision({ legal_hold: true });
      else revision({}, [{ id: "h1", document_id: "doc1", released_at: null }]);
      for (const key of [RENDERED, SOURCE]) {
        state.r2sends = 0;
        state.audits = [];
        const res = await del(key);
        expect(res.status, key).toBe(423);
        expect(state.r2sends, key).toBe(0);
        expect(state.audits, key).toHaveLength(0);
      }
    });
  }

  it("both columns are looked up by exact equality — never a PostgREST .or() string", async () => {
    member("Admin");
    revision();
    await del(SOURCE);
    expect(state.eqs).toContain(`document_versions|file_url=${SOURCE}`);
    expect(state.eqs).toContain(`document_versions|source_file_key=${SOURCE}`);
    expect(state.ors).toEqual([]);
  });

  it("a key with a comma and parentheses (which assertSafeStorageKey admits) still resolves to its held document", async () => {
    member("Admin");
    const odd = `orgs/${ORG}/libraries/l1/P-101 (rev C),source.dwg`;
    state.rows.document_versions = [{ id: "v1", record_id: "doc1", file_url: RENDERED, source_file_key: odd }];
    state.rows.documents = [{ id: "doc1", legal_hold: true }];
    state.rows.document_holds = [];
    const res = await del(odd);
    expect(res.status).toBe(423);
    expect(state.r2sends).toBe(0);
    expect(state.ors).toEqual([]);
  });

  it("the source_file_key lookup erroring refuses 503 — fail closed, nothing deleted, no custody row", async () => {
    member("Admin");
    revision();
    state.failEq.add("document_versions|source_file_key");
    const res = await del(KEY); // file_url lookup is clean and matches nothing
    expect(res.status).toBe(503);
    expect(state.r2sends).toBe(0);
    expect(state.audits).toHaveLength(0);
  });

  it("the file_url lookup erroring refuses 503 even when the source lookup would clear the key", async () => {
    member("Admin");
    revision();
    state.failEq.add("document_versions|file_url");
    const res = await del(SOURCE);
    expect(res.status).toBe(503);
    expect(state.r2sends).toBe(0);
  });

  it("a documents read error for a source key refuses 503", async () => {
    member("Admin");
    revision();
    state.errors.documents = { message: "db down" };
    const res = await del(SOURCE);
    expect(res.status).toBe(503);
    expect(state.r2sends).toBe(0);
  });

  it("a document_holds read error for a source key refuses 503", async () => {
    member("Admin");
    revision();
    state.errors.document_holds = { message: "db down" };
    const res = await del(SOURCE);
    expect(res.status).toBe(503);
    expect(state.r2sends).toBe(0);
  });

  it("every document naming the key is checked, not just the first match", async () => {
    member("Admin");
    // The key is the rendered file of a clear document's revision AND the
    // native source of a held document's revision.
    state.rows.document_versions = [
      { id: "vA", record_id: "docA", file_url: KEY, source_file_key: null },
      { id: "vB", record_id: "docB", file_url: RENDERED, source_file_key: KEY },
    ];
    state.rows.documents = [
      { id: "docA", legal_hold: false },
      { id: "docB", legal_hold: true },
    ];
    state.rows.document_holds = [];
    expect((await del(KEY)).status).toBe(423);
    // Same column: two documents' revisions name one key; the held one second.
    state.rows.document_versions = [
      { id: "vA", record_id: "docA", file_url: KEY, source_file_key: null },
      { id: "vB", record_id: "docB", file_url: KEY, source_file_key: null },
    ];
    expect((await del(KEY)).status).toBe(423);
    expect(state.r2sends).toBe(0);
  });

  it("a clear document's native source is deleted, and the custody row now names its document and revision", async () => {
    member("Admin");
    revision();
    const res = await del(SOURCE);
    expect(res.status).toBe(200);
    expect(state.r2sends).toBe(1);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0].resource_id).toBe("doc1");
    expect(state.audits[0].details).toMatchObject({ path: SOURCE, documentId: "doc1", versionId: "v1" });
  });
});

describe("DACL-2 criterion 1 (b): a document inside its retention period is refused", () => {
  for (const [label, key] of [["rendered file", RENDERED], ["native source", SOURCE]] as const) {
    it(`retention_until in the future: the ${label} is refused 423, nothing deleted, no custody row`, async () => {
      member("Admin");
      const until = iso(365);
      revision({ retention_until: until, disposition_state: "active" });
      const res = await del(key);
      expect(res.status).toBe(423);
      expect(((await res.json()) as { error: string }).error).toContain(until);
      expect(state.r2sends).toBe(0);
      expect(state.audits).toHaveLength(0);
    });
  }

  it("a retention period that has run (not yet flagged by the scan) does not refuse", async () => {
    member("Admin");
    revision({ retention_until: iso(-10), disposition_state: "active" });
    const res = await del(SOURCE);
    expect(res.status).toBe(200);
    expect(state.r2sends).toBe(1);
  });

  for (const disposition of ["eligible", "disposed"] as const) {
    it(`a record ${disposition} for disposition does not refuse`, async () => {
      member("Admin");
      revision({ retention_until: iso(-10), disposition_state: disposition });
      const res = await del(RENDERED);
      expect(res.status).toBe(200);
      expect(state.r2sends).toBe(1);
    });
  }

  it("an unreadable retention date refuses — fail closed, as the shared verdict reads it as in force", async () => {
    member("Admin");
    revision({ retention_until: "not-a-date", disposition_state: "active" });
    const res = await del(SOURCE);
    expect(res.status).toBe(423);
    expect(state.r2sends).toBe(0);
  });

  it("a legal hold still answers as a hold when the document is also inside retention", async () => {
    member("Admin");
    revision({ legal_hold: true, retention_until: iso(365), disposition_state: "active" });
    const res = await del(SOURCE);
    expect(res.status).toBe(423);
    expect(((await res.json()) as { error: string }).error).toMatch(/legal hold/);
  });

  it("the route reads retention through the ONE shared verdict and P9's ONE resolver, and never imports the browser client", async () => {
    const policy = await import("@/lib/retentionPolicy");
    const retention = await import("@/lib/retention");
    // The register and the pill import it from lib/retention; the route from
    // the pure module. Same function object — not a parallel reading.
    expect(retention.retentionStatusFor).toBe(policy.retentionStatusFor);
    expect(retention.resolveEffectiveRetentionPolicy).toBe(policy.resolveEffectiveRetentionPolicy);
    expect(retention.computeRetentionUntil).toBe(policy.computeRetentionUntil);
    const src = readFileSync(resolve(__dirname, "../../app/api/storage/delete/route.ts"), "utf8");
    expect(src).toMatch(
      /import \{\s*retentionStatusFor, resolveEffectiveRetentionPolicy, computeRetentionUntil, retentionBasisISO,\s*\} from "@\/lib\/retentionPolicy";/,
    );
    // No second copy of the date arithmetic or the inheritance rule.
    expect(src).not.toMatch(/setFullYear/);
    expect(src).not.toMatch(/from "@\/lib\/supabase"/);
    expect(src).not.toMatch(/from "@\/lib\/retention"/);
  });
});

describe("DACL-2 criterion 1 (b): the EFFECTIVE retention — a row never clocked, or stale, is judged by its policy", () => {
  const TEN_YEARS = { enabled: true, years: 10, basis: "created", action: "destroy" } as const;
  /** doc1 in library l1 (and folder c1 when `folder` is given), with the
   *  given library / folder policies; `doc` overrides document columns. */
  function inLibrary(doc: Row, libPolicy: Row | null, folder?: { policy: Row | null }) {
    revision({ library_id: "l1", collection_id: folder ? "c1" : null, created_at: ts(-30), updated_at: ts(-30), ...doc });
    state.rows.libraries = [{ id: "l1", retention_policy: libPolicy }];
    state.rows.collections = folder ? [{ id: "c1", retention_policy: folder.policy }] : [];
  }

  for (const [label, key] of [["rendered file", RENDERED], ["native source", SOURCE]] as const) {
    it(`an UNCLOCKED row (retention_until / disposition_state NULL) under an in-force library policy: the ${label} is refused 423, nothing deleted, no custody row`, async () => {
      member("Admin");
      const created = ts(-30);
      inLibrary({ created_at: created, retention_until: null, disposition_state: null }, TEN_YEARS);
      const res = await del(key);
      expect(res.status).toBe(423);
      expect(((await res.json()) as { error: string }).error).toContain(plusYears(created, 10));
      expect(state.r2sends).toBe(0);
      expect(state.audits).toHaveLength(0);
    });
  }

  it("a STALE row (a retention_until already run) under an extended policy is refused 423, naming the policy's later date", async () => {
    member("Admin");
    const created = ts(-730);
    inLibrary({ created_at: created, retention_until: iso(-10), disposition_state: "active" }, TEN_YEARS);
    const res = await del(SOURCE);
    expect(res.status).toBe(423);
    expect(((await res.json()) as { error: string }).error).toContain(plusYears(created, 10));
    expect(state.r2sends).toBe(0);
    expect(state.audits).toHaveLength(0);
  });

  it("a row the scan flagged 'eligible' before the policy was extended is refused 423 too", async () => {
    member("Admin");
    inLibrary({ created_at: ts(-730), retention_until: iso(-10), disposition_state: "eligible" }, TEN_YEARS);
    expect((await del(RENDERED)).status).toBe(423);
    expect(state.r2sends).toBe(0);
  });

  it("a folder policy in force refuses when the library has none", async () => {
    member("Admin");
    inLibrary({}, null, { policy: { enabled: true, years: 7 } });
    expect((await del(SOURCE)).status).toBe(423);
    expect(state.r2sends).toBe(0);
  });

  it("a defined-but-disabled folder policy stops inheritance (P9's rule): the library's policy does not refuse", async () => {
    member("Admin");
    // control: the same document with no folder policy is refused by the library's
    inLibrary({}, TEN_YEARS, { policy: null });
    expect((await del(SOURCE)).status).toBe(423);
    inLibrary({}, TEN_YEARS, { policy: { enabled: false } });
    const res = await del(SOURCE);
    expect(res.status).toBe(200);
    expect(state.r2sends).toBe(1);
  });

  it("the document's own policy wins: a run-out document policy clears it under a ten-year library policy, an in-force one refuses under none", async () => {
    member("Admin");
    inLibrary({ created_at: ts(-730), retention_policy: { enabled: true, years: 1 } }, TEN_YEARS);
    expect((await del(SOURCE)).status).toBe(200);
    inLibrary({ created_at: ts(-30), retention_policy: { enabled: true, years: 1 } }, null);
    expect((await del(SOURCE)).status).toBe(423);
    expect(state.r2sends).toBe(1);
  });

  it("an effective retention that has run does not refuse", async () => {
    member("Admin");
    inLibrary({ created_at: ts(-11 * 366), retention_until: null, disposition_state: null }, TEN_YEARS);
    const res = await del(SOURCE);
    expect(res.status).toBe(200);
    expect(state.r2sends).toBe(1);
  });

  it("a policy in force whose date cannot be computed (no readable basis date) refuses — fail closed; a policy with no length does not", async () => {
    member("Admin");
    for (const created of [null, "not-a-date"]) {
      inLibrary({ created_at: created, updated_at: null }, TEN_YEARS);
      expect((await del(SOURCE)).status, String(created)).toBe(423);
    }
    expect(state.r2sends).toBe(0);
    // control: an enabled policy with no years is "no retention" (describeRetentionPolicy)
    inLibrary({ created_at: null, updated_at: null }, { enabled: true });
    expect((await del(SOURCE)).status).toBe(200);
  });

  it("a DISPOSED record is not refused under an in-force policy — disposition was the explicit controller action", async () => {
    member("Admin");
    inLibrary({ retention_until: iso(3000), disposition_state: "disposed" }, TEN_YEARS);
    const res = await del(RENDERED);
    expect(res.status).toBe(200);
    expect(state.r2sends).toBe(1);
  });

  for (const table of ["libraries", "collections"] as const) {
    it(`a ${table} retention_policy read error refuses 503 — fail closed, nothing deleted, no custody row`, async () => {
      member("Admin");
      inLibrary({}, null, { policy: null });
      state.errors[table] = { message: "statement timeout" };
      const res = await del(SOURCE);
      expect(res.status).toBe(503);
      expect(state.r2sends).toBe(0);
      expect(state.audits).toHaveLength(0);
    });
  }

  it("the policies are read by the document's own folder and library ids", async () => {
    member("Admin");
    inLibrary({}, null, { policy: null });
    await del(SOURCE);
    expect(state.eqs).toContain("collections|id=c1");
    expect(state.eqs).toContain("libraries|id=l1");
  });
});
