// lib/__tests__/intelRoundGChunkExport.test.ts
//
// intelligence Round G, package I-01 phase B — ILIFE-11. The export read
// knowledge_chunks `select("*")`, so every chunk's 1024-dimension embedding
// (derived from the passage text) rode every backup inline. Now the table is
// read by an explicit column list that leaves `embedding` out
// (lib/exportTables.ts EXPORT_OMITTED_COLUMNS), the manifest names the
// omission, and a restore of such a backup leaves every chunk with embedding
// NULL, in the queue embed_claim_batch claims from.
//
// What the restore does NOT do (review fix pass): bring meaning search back
// by itself. The embed drain spends only on a consent stamped on a library
// (ai_features.embedBuild); a finished build's stamp is cleared at 100%, and
// a stamp whose payer is not an active member of the restored workspace is
// released unspent. The last describe below runs the real drain over what a
// restore leaves and pins exactly that, which is what the manifest note says.
//
// Driven end to end with the real producer (lib/dataExport.ts runOrgExport)
// and the real restore (planRestore + runChunkedRestore through /begin and
// /apply-table) over the in-memory database the other round trips use. The
// stand-in answers a select list as PostgREST does — only the named columns —
// and refuses one naming a column the table does not have (42703), so the
// fallback for a database that has not taken a migration is exercised too.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { db, type Row } from "./helpers/restoreMemoryDb";

const hooks = vi.hoisted(() => ({
  /** Columns the live database does NOT have yet, per table (a migration not pasted). */
  absent: {} as Record<string, string[]>,
  /** Every data read's select list, per table, in order. */
  selects: {} as Record<string, string[]>,
  /** An error answered to a read by an explicit column list, per table. */
  listError: {} as Record<string, { code: string; message: string }>,
  /** While set, the service-role client the embed drain imports answers from
   *  this stand-in (./helpers/knowledgeFakeAdmin) instead of the memory DB. */
  drain: null as null | import("./helpers/knowledgeFakeAdmin").FakeAdminState,
}));
vi.mock("@/lib/supabaseAdmin", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/supabaseAdmin")>();
  const { makeFakeAdmin } = await import("./helpers/knowledgeFakeAdmin");
  const proxy = new Proxy({}, {
    get: (_t, p: string) => ((hooks.drain ? makeFakeAdmin(hooks.drain) : real.supabaseAdmin) as unknown as Record<string, unknown>)[p],
  });
  return { ...real, supabaseAdmin: proxy };
});
vi.mock("@/lib/serverAuth", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  return {
    authorizeOrgRole: vi.fn(async (_req: unknown, orgId: string) => ({
      userId: "admin-1", email: "admin@target.io", orgId, role: "Admin", roles: ["Admin"], admin: { from: mem.from },
    })),
  };
});
vi.mock("@supabase/supabase-js", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  const from = (table: string) => {
    const b = mem.from(table) as Record<string, unknown>;
    const select = b.select as (cols?: unknown, o?: unknown) => unknown;
    let list: string[] | null = null;
    b.select = (cols?: unknown, o?: { head?: boolean }) => {
      if (o?.head !== true && typeof cols === "string") {
        (hooks.selects[table] ??= []).push(cols);
        list = cols.trim() === "*" ? null : cols.split(",").map((c) => c.trim());
      }
      select(cols, o);
      return b;
    };
    const then = b.then as (res: (v: unknown) => void, rej: (e: unknown) => void) => void;
    b.then = (res: (v: unknown) => void, rej: (e: unknown) => void) => {
      const missing = list?.find((c) => (hooks.absent[table] ?? []).includes(c));
      if (missing) return res({ data: null, error: { code: "42703", message: `column ${table}.${missing} does not exist` } });
      if (list && hooks.listError[table]) return res({ data: null, error: hooks.listError[table] });
      return then((v) => {
        const r = v as { data: unknown };
        // PostgREST answers a select list with exactly those columns.
        if (list && Array.isArray(r.data)) {
          const cols = list;
          r.data = (r.data as Row[]).map((row) => Object.fromEntries(cols.filter((c) => c in row).map((c) => [c, row[c]])));
        }
        res(r);
      }, rej);
    };
    return b;
  };
  return { createClient: () => ({ from }) };
});
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => ({ ContentLength: 4, ContentType: "application/octet-stream" })) }, R2_BUCKET: "test-bucket" }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_c: unknown, cmd: { input: { Key: string } }) => `https://r2.test/${cmd.input.Key}`),
}));

import { runOrgExport } from "@/lib/dataExport";
import { EXPORT_OMITTED_COLUMNS, exportSelectFor } from "@/lib/exportTables";
import { planRestore, runChunkedRestore, type RestorePost, type RestoreEnvelopeLike } from "@/lib/dataRestore";
import { EMBED_MAX_ATTEMPTS } from "@/lib/ai/embeddings";
import { POST as applyTable } from "@/app/api/admin/restore/apply-table/route";
import { POST as beginRoute } from "@/app/api/admin/restore/begin/route";
import { drainEmbedBacklog } from "@/lib/knowledgeEmbedDrain";
import { freshAdminState, installMarkerRpc } from "./helpers/knowledgeFakeAdmin";

const SRC = "33333333-3333-4333-8333-333333333333";
const TARGET = "55555555-5555-4555-8555-555555555555";
const VECTOR = `[${Array.from({ length: 1024 }, (_, i) => (i / 1024).toFixed(6)).join(",")}]`;

/** A chunk as the live table holds it: every column the census lists, the vector included. */
function chunk(i: number, over: Row = {}): Row {
  return {
    id: `kc-${String(i).padStart(4, "0")}`, org_id: SRC, library_id: "kl-1", document_id: "kd-1", page: 1 + (i % 9), seq: i,
    section: "Specs", content: `Pump P-101A passage ${i}`, tsv: "'p-101a':3B 'pump':2B 'spec':1A",
    embedding: VECTOR, embedding_model: "embed-model-a", embed_attempts: 0, embed_error: null,
    embed_claimed_until: null, embed_retry_after: null, source: "text", source_model: null,
    ...over,
  };
}
function seedSource(chunks: Row[]) {
  db.rows = {
    orgs: [{ id: SRC, name: "Acme" }],
    org_members: [{ org_id: SRC, uid: "u-alice", email: "alice@acme.com", role: "Admin", roles: ["Admin"], status: "active" }],
    knowledge_libraries: [{ id: "kl-1", org_id: SRC, name: "Vendor manuals" }],
    knowledge_documents: [{ id: "kd-1", org_id: SRC, library_id: "kl-1", name: "Pump manual", status: "ready" }],
    knowledge_chunks: chunks,
  };
}
function seedTarget() {
  db.rows = {
    orgs: [{ id: TARGET, name: "Acme" }],
    org_members: [{ org_id: TARGET, uid: "t-alice", email: "alice@acme.com", role: "Admin", roles: ["Admin"], status: "active" }],
    users: [{ id: "t-alice", email: "alice@acme.com" }, { id: "admin-1", email: "admin@target.io" }],
  };
  db.authUsers = new Set(["t-alice", "admin-1"]);
  db.writes = []; db.attempts = [];
}
const exportEnvelope = () =>
  runOrgExport({ supabaseUrl: "https://x.supabase.co", serviceRoleKey: "svc", orgId: SRC, exporterUserId: "u-alice", exporterEmail: "alice@acme.com" });
const routePost: RestorePost = async (path, body) => {
  const req = new NextRequest(`https://app${path}`, {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const res = await (path.startsWith("/api/admin/restore/begin") ? beginRoute : applyTable)(req);
  return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};
const rowsOf = (t: string): Row[] => db.rows[t] ?? [];

beforeEach(() => {
  hooks.absent = {}; hooks.selects = {}; hooks.listError = {}; hooks.drain = null;
  db.keys = {}; db.writeError = null; db.readError = {}; db.writes = []; db.attempts = []; db.countless = false;
  db.fks = {}; db.maxRows = 1000; db.generated = { knowledge_chunks: ["tsv"] }; db.authUsers = null;
});

describe("ILIFE-11 criterion 1 — knowledge_chunks is exported by an explicit column list that leaves the embedding out", () => {
  it("no exported chunk carries `embedding`; every other column is carried as it was; the read named the list, not *", async () => {
    seedSource([chunk(0), chunk(1, { embedding: null, embedding_model: null })]);
    const env = await exportEnvelope();
    const out = env.tables.knowledge_chunks as Row[];
    expect(out).toHaveLength(2);
    for (const r of out) expect(r).not.toHaveProperty("embedding");
    const { embedding: _vector, ...rest } = chunk(0);
    expect(out[0]).toEqual(rest);                                    // nothing else dropped
    expect(JSON.stringify(env)).not.toContain(VECTOR.slice(0, 40));  // the vector is nowhere in the envelope
    expect(hooks.selects.knowledge_chunks).toEqual([exportSelectFor("knowledge_chunks")]);
    expect(hooks.selects.knowledge_documents).toEqual(["*"]);        // every other table: as before
    expect(env.manifest.complete).toBe(true);
  });

  it("the manifest says so: omittedColumns names the column, and a note says what a restore leaves (no automatic rebuild)", async () => {
    seedSource([chunk(0)]);
    const env = await exportEnvelope();
    expect(env.manifest.omittedColumns).toEqual({ knowledge_chunks: ["embedding"] });
    const note = env.manifest.notes.find((n) => n.startsWith("OMITTED derived columns"))!;
    expect(note).toContain("knowledge_chunks.embedding");
    expect(note).toContain(EXPORT_OMITTED_COLUMNS.knowledge_chunks.reason);
    expect(note).toMatch(/keyword search works at once/);
    expect(note).toMatch(/meaning-index Build on each library, which re-embeds them on that person's own embedding key/);
    expect(note).toMatch(/Nothing re-embeds them automatically/);
    expect(note).not.toMatch(/drain|rebuilt after a restore/);
    expect(/^[\x20-\x7e]*$/.test(note)).toBe(true);                // ASCII (total_bytes compares characters)
    expect(env.manifest.notes.join("\n")).toMatch(/derived columns listed in manifest\.omittedColumns, which are left out \(on a row that carried one, the state columns that described it are exported at their defaults/);
    expect(note).toMatch(/embedded passage's embedding retry state \(embed_attempts, embed_error, embed_claimed_until, embed_retry_after\) is exported reset to its default/);
    expect(note).toMatch(/a passage that never had a vector keeps its state, so one the provider refused stays refused with its reason/);
    expect(env.manifest.notes.join("\n")).not.toMatch(/preserved verbatim EXCEPT the credential columns listed in manifest\.redactedColumns, which are exported as null\. JSON keys/);
  });

  it("pages past the first 1,000 rows with the list (keyset on id), every chunk once, none with a vector", async () => {
    seedSource(Array.from({ length: 2300 }, (_, i) => chunk(i)));
    const env = await exportEnvelope();
    const ids = (env.tables.knowledge_chunks as Row[]).map((r) => String(r.id));
    expect(ids).toHaveLength(2300);
    expect(new Set(ids).size).toBe(2300);
    expect((env.tables.knowledge_chunks as Row[]).some((r) => "embedding" in r)).toBe(false);
    expect(hooks.selects.knowledge_chunks).toEqual(Array(3).fill(exportSelectFor("knowledge_chunks")));
    expect(env.manifest.complete).toBe(true);
  });

  it("a database without a listed column yet (20261122 not pasted: no source / source_model) falls back to * — today's read — and still drops the vector", async () => {
    hooks.absent.knowledge_chunks = ["source", "source_model"];
    seedSource(Array.from({ length: 1500 }, (_, i) => {
      const { source: _s, source_model: _m, ...pre } = chunk(i);
      return pre;
    }));
    const env = await exportEnvelope();
    const out = env.tables.knowledge_chunks as Row[];
    expect(out).toHaveLength(1500);
    expect(out.some((r) => "embedding" in r)).toBe(false);
    expect(out[0]).toMatchObject({ id: "kc-0000", content: "Pump P-101A passage 0", embedding_model: "embed-model-a" });
    // one refused list read, then "*" for the rest of the table
    expect(hooks.selects.knowledge_chunks).toEqual([exportSelectFor("knowledge_chunks"), "*", "*"]);
    expect(env.manifest.tables.find((t) => t.name === "knowledge_chunks")).toEqual({ name: "knowledge_chunks", rowCount: 1500 });
    expect(env.manifest.complete).toBe(true);
  });

  it("any other read error still fails the table (no fallback hides it): the backup is INCOMPLETE", async () => {
    seedSource([chunk(0)]);
    db.readError.knowledge_chunks = "canceling statement due to statement timeout";
    const env = await exportEnvelope();
    expect(env.manifest.tables.find((t) => t.name === "knowledge_chunks")?.error).toMatch(/statement timeout/);
    expect(env.manifest.complete).toBe(false);
  });

  it("an error on the list read that is not a missing column is not retried as *: the table fails", async () => {
    seedSource([chunk(0)]);
    hooks.listError.knowledge_chunks = { code: "42501", message: "permission denied for table knowledge_chunks" };
    const env = await exportEnvelope();
    expect(env.manifest.tables.find((t) => t.name === "knowledge_chunks")?.error).toMatch(/permission denied/);
    expect(env.manifest.complete).toBe(false);
    expect(hooks.selects.knowledge_chunks).toEqual([exportSelectFor("knowledge_chunks")]);
  });
});

/** The newest definition of a function across the numbered migrations. */
function newestDefinition(fn: string): { file: string; body: string } {
  const dir = join(process.cwd(), "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
  let found: { file: string; body: string } | null = null;
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    const at = src.search(new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public\\.)?${fn}\\s*\\(`, "i"));
    if (at < 0) continue;
    const end = src.indexOf("$$;", src.indexOf("$$", at) + 2);
    found = { file: f, body: src.slice(at, end) };
  }
  if (!found) throw new Error(`${fn} is defined nowhere`);
  return found;
}

describe("IEDGE-10 criterion 3 — the DATA_EXPORT row records the exporter's role and that the dump was not ACL-filtered", () => {
  it("user_role is the admitted role; details.aclFiltered is false (a full-fidelity Admin backup)", async () => {
    seedSource([chunk(0)]);
    await runOrgExport({ supabaseUrl: "https://x.supabase.co", serviceRoleKey: "svc", orgId: SRC, exporterUserId: "u-alice", exporterEmail: "alice@acme.com", exporterRole: "Admin" });
    const row = rowsOf("audit_logs").find((r) => r.action === "DATA_EXPORT")!;
    expect(row).toMatchObject({ user_role: "Admin", user_id: "u-alice" });
    expect(row.details).toMatchObject({ aclFiltered: false });
  });
});

describe("ILIFE-11 criterion 3 (chunk half) — a restore of a backup taken without embeddings leaves every chunk in the queue embed_claim_batch claims from", () => {
  it("export → restore into a fresh workspace: every chunk lands with no embedding, and each meets the drain's claim predicate", async () => {
    seedSource([chunk(0), chunk(1, { embed_attempts: 1 }), chunk(2, { embedding: null, embedding_model: null })]);
    const env = await exportEnvelope();
    seedTarget();
    const envelope = env as unknown as RestoreEnvelopeLike;
    const plan = planRestore(envelope, { orgId: TARGET, orgName: "Acme", members: [{ uid: "t-alice", email: "alice@acme.com" }] });
    const result = await runChunkedRestore({ orgId: TARGET, envelope, plan, orgNameChoice: "current", post: routePost });
    expect(result.stoppedAt).toBeNull();
    expect(result.notAttempted).toEqual([]);
    expect(result.totalRefused).toBe(0);

    const chunks = rowsOf("knowledge_chunks");
    expect(chunks.map((c) => c.id).sort()).toEqual(["kc-0000", "kc-0001", "kc-0002"]);
    const docs = new Map(rowsOf("knowledge_documents").map((d) => [d.id, d]));

    // embed_claim_batch's predicate, from its newest definition (the drain's
    // queue). A later re-definition that changes it fails the pin below.
    const def = newestDefinition("embed_claim_batch");
    for (const clause of [
      "c.embedding IS NULL",
      "d.status IN ('ready', 'indexing')",
      "c.embed_attempts < p_max_attempts",
      "(c.embed_claimed_until IS NULL OR c.embed_claimed_until < now())",
      "(c.embed_retry_after IS NULL OR c.embed_retry_after < now())",
    ]) expect(def.body, `${def.file}: ${clause}`).toContain(clause);
    const now = Date.now();
    const past = (v: unknown) => v === null || v === undefined || Date.parse(String(v)) < now;
    for (const c of chunks) {
      expect(c.org_id).toBe(TARGET);
      expect(c.embedding ?? null, String(c.id)).toBeNull();        // the column's default: NULL
      expect(["ready", "indexing"]).toContain(docs.get(c.document_id)?.status);
      expect(Number(c.embed_attempts ?? 0)).toBeLessThan(EMBED_MAX_ATTEMPTS);
      expect(past(c.embed_claimed_until) && past(c.embed_retry_after)).toBe(true);
    }
    // The model-mix guard looks only at rows WITH an embedding: none here.
    expect(def.body).toContain("o.embedding IS NOT NULL");
    expect(chunks.filter((c) => c.embedding !== undefined && c.embedding !== null)).toEqual([]);
  });

  it("a chunk that embedded on its LAST allowed try comes back with a fresh retry state, not one try from refused", async () => {
    // knowledgeEmbedCore raises embed_attempts on a failure and never lowers
    // it on success, so a live embedded chunk can carry EMBED_MAX_ATTEMPTS-1
    // (and a stale error / lease / backoff). Those described the vector the
    // export leaves out; restored with it, one transient provider error on
    // the next Build would refuse the passage for good.
    const future = new Date(Date.now() + 86_400_000).toISOString();
    seedSource([
      chunk(0, { embed_attempts: EMBED_MAX_ATTEMPTS - 1, embed_error: "provider 503 (transient)", embed_claimed_until: future, embed_retry_after: future }),
      chunk(1, { embed_attempts: EMBED_MAX_ATTEMPTS - 1 }),
    ]);
    const env = await exportEnvelope();
    for (const r of env.tables.knowledge_chunks as Row[]) {
      expect(r).toMatchObject({ embed_attempts: 0, embed_error: null, embed_claimed_until: null, embed_retry_after: null });
      expect(r).not.toHaveProperty("embedding");
    }
    seedTarget();
    const envelope = env as unknown as RestoreEnvelopeLike;
    const plan = planRestore(envelope, { orgId: TARGET, orgName: "Acme", members: [{ uid: "t-alice", email: "alice@acme.com" }] });
    const result = await runChunkedRestore({ orgId: TARGET, envelope, plan, orgNameChoice: "current", post: routePost });
    expect(result.stoppedAt).toBeNull();
    expect(result.totalRefused).toBe(0);
    const chunks = rowsOf("knowledge_chunks");
    expect(chunks).toHaveLength(2);
    for (const c of chunks) {
      expect(c.embedding ?? null).toBeNull();
      expect(c.embed_attempts).toBe(0);                            // the whole budget of tries, as a new chunk has
      expect(c.embed_error ?? null).toBeNull();
      expect(c.embed_claimed_until ?? null).toBeNull();            // claimable at once
      expect(c.embed_retry_after ?? null).toBeNull();
    }
  });

  it("a chunk that NEVER had a vector keeps its drain state: one refused for good stays refused, with its reason", async () => {
    // The reset describes the vector left out, so it applies only to a row
    // that carried one (embedding_model, which the writer sets with the
    // vector and the Rebuild clears with it). A passage the provider refused
    // at the attempt cap has neither; resetting it would bring it back as
    // pending, lose the refusal, and spend up to EMBED_MAX_ATTEMPTS more
    // provider calls on someone's key for a passage known to fail.
    const future = new Date(Date.now() + 86_400_000).toISOString();
    seedSource([
      chunk(0, { embedding: null, embedding_model: null, embed_attempts: EMBED_MAX_ATTEMPTS, embed_error: "input too long" }),
      chunk(1, { embedding: null, embedding_model: null, embed_attempts: 2, embed_error: "provider 503 (transient)", embed_retry_after: future }),
      chunk(2, { embed_attempts: EMBED_MAX_ATTEMPTS - 1, embed_error: "provider 503 (transient)" }),
    ]);
    const env = await exportEnvelope();
    const out = new Map((env.tables.knowledge_chunks as Row[]).map((r) => [String(r.id), r]));
    expect(out.get("kc-0000")).toMatchObject({ embed_attempts: EMBED_MAX_ATTEMPTS, embed_error: "input too long", embedding_model: null });
    expect(out.get("kc-0001")).toMatchObject({ embed_attempts: 2, embed_error: "provider 503 (transient)", embed_retry_after: future });
    expect(out.get("kc-0002")).toMatchObject({ embed_attempts: 0, embed_error: null });   // embedded: reset, as above
    for (const r of out.values()) expect(r).not.toHaveProperty("embedding");
    seedTarget();
    const envelope = env as unknown as RestoreEnvelopeLike;
    const plan = planRestore(envelope, { orgId: TARGET, orgName: "Acme", members: [{ uid: "t-alice", email: "alice@acme.com" }] });
    const result = await runChunkedRestore({ orgId: TARGET, envelope, plan, orgNameChoice: "current", post: routePost });
    expect(result.stoppedAt).toBeNull();
    expect(result.totalRefused).toBe(0);
    const refused = rowsOf("knowledge_chunks").find((c) => c.id === "kc-0000")!;
    expect(refused.embed_attempts).toBe(EMBED_MAX_ATTEMPTS);      // still out of embed_claim_batch's queue (attempts < max)
    expect(refused.embed_error).toBe("input too long");           // the reason survives the round trip
  });

  it("the drain's pre-20261121 queue (no claim function yet) is `embedding IS NULL` too", () => {
    const src = readFileSync(join(process.cwd(), "lib/knowledgeEmbedCore.ts"), "utf8");
    expect(src).toMatch(/\.from\("knowledge_chunks"\)\.select\("id, content, section, page, document_id"\)\s*\n\s*\.eq\("org_id", orgId\)\.eq\("library_id", libraryId\)\s*\n\s*\.is\("embedding", null\)/);
  });

  it("the omission is the declared one only", () => {
    expect(Object.keys(EXPORT_OMITTED_COLUMNS)).toEqual(["knowledge_chunks"]);
  });
});

describe("ILIFE-11 criterion 3 (library half) — what a restore leaves for the embed drain: nothing it will spend on", () => {
  // A real uuid, as a consent stamp carries (the drain releases a non-uuid
  // stamp before it looks at membership).
  const PAYER = "0d000000-0000-4000-8000-0000000000a1";
  /** Export the source, restore into a fresh workspace, and hand what the
   *  restore wrote to the service-role stand-in the drain reads. */
  async function exportRestoreAndHandToDrain() {
    const env = await exportEnvelope();
    seedTarget();
    const envelope = env as unknown as RestoreEnvelopeLike;
    const plan = planRestore(envelope, { orgId: TARGET, orgName: "Acme", members: [{ uid: "t-alice", email: "alice@acme.com" }] });
    const result = await runChunkedRestore({ orgId: TARGET, envelope, plan, orgNameChoice: "current", post: routePost });
    expect(result.stoppedAt).toBeNull();
    expect(result.totalRefused).toBe(0);
    const state = freshAdminState();
    for (const t of ["knowledge_libraries", "knowledge_documents", "knowledge_chunks", "org_members"]) {
      state.tables[t] = rowsOf(t).map((r) => ({ ...r }));
    }
    installMarkerRpc(state);
    hooks.drain = state;
    return state;
  }

  it("a fully built library (its stamp cleared at 100%) is not picked up: the drain does nothing, and every restored chunk stays without a vector", async () => {
    seedSource([chunk(0), chunk(1), chunk(2)]);
    db.rows.knowledge_libraries = [{ id: "kl-1", org_id: SRC, name: "Vendor manuals", ai_features: { summary: "pump vendor manuals" } }];
    const state = await exportRestoreAndHandToDrain();
    const lib = state.tables.knowledge_libraries.find((l) => l.name === "Vendor manuals")!;
    expect(lib.org_id).toBe(TARGET);
    expect((lib.ai_features as Record<string, unknown> | null)?.embedBuild).toBeUndefined();

    const first = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(first.drained).toEqual([]);                                   // no stamped library, nothing to continue
    const again = await drainEmbedBacklog({ scopeOrgIds: [TARGET], budgetMs: 200_000 });
    expect(again.drained).toEqual([]);                                   // the page-load nudge: the same
    expect(state.calls.some((c) => c.table === "knowledge_libraries" && c.method === "select")).toBe(true); // it did look
    expect(state.calls.some((c) => c.table === "ai_connections")).toBe(false); // nobody's key was even looked up
    const chunks = state.tables.knowledge_chunks;
    expect(chunks).toHaveLength(3);
    for (const c of chunks) expect(c.embedding ?? null, String(c.id)).toBeNull();
  });

  it("a standing 'keep current' consent restored into a fresh workspace names nobody there: the drain releases it unspent, and nothing is embedded", async () => {
    seedSource([chunk(0), chunk(1)]);
    db.rows.org_members = [{ org_id: SRC, uid: PAYER, email: "alice@acme.com", role: "Admin", roles: ["Admin"], status: "active" }];
    db.rows.knowledge_libraries = [{
      id: "kl-1", org_id: SRC, name: "Vendor manuals",
      ai_features: { embedBuild: { userId: PAYER, at: "2026-09-01T00:00:00.000Z", standing: true, completedAt: "2026-09-02T00:00:00.000Z" } },
    }];
    const state = await exportRestoreAndHandToDrain();
    const lib = state.tables.knowledge_libraries.find((l) => l.name === "Vendor manuals")!;
    expect(state.tables.org_members.some((m) => m.org_id === TARGET && m.uid === PAYER && m.status === "active")).toBe(false);

    const run = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 });
    expect(run.drained.map((d) => [d.libraryId, d.outcome])).toEqual([[lib.id, "released"]]);
    expect(run.drained[0].note).toMatch(/names no active member/);
    expect((lib.ai_features as Record<string, unknown>).embedBuild).toBeUndefined();
    expect(state.calls.some((c) => c.table === "ai_connections")).toBe(false);
    for (const c of state.tables.knowledge_chunks) expect(c.embedding ?? null, String(c.id)).toBeNull();
    // ...and the next run has nothing left to continue.
    expect((await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: 200_000 })).drained).toEqual([]);
  });
});
