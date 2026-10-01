// projects Round G — J1 INTAKE-DOOR, INTK-2 dw2 / SAF-5: after a trusted
// intake auto-publish, the REAL post-publish pipeline (lib/postPublish.ts →
// lib/acknowledgments.ts) runs against the same database the route wrote —
// bound to the service role — so the new revision gets a fresh
// read-&-understood roster and the prior revision's roster is closed.
// Only the signal fan-outs that are not the roster (stale copies, packages,
// revision impact, proposals, review cycle, retention, the bell) are stubbed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";

type Row = Record<string, unknown>;
type Filter = [string, string, unknown];

const db = vi.hoisted(() => ({
  sharedBoundAtAckWrite: [] as boolean[],
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  writes: [] as Array<{ table: string; method: string; args: unknown[]; filters: Array<[string, string, unknown]> }>,
  errors: {} as Record<string, Array<{ message: string; code?: string } | null>>,
  rpc: {} as Record<string, (args: Record<string, unknown>) => { data: unknown; error: unknown }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  r2Puts: [] as Array<Record<string, unknown>>,
  emits: [] as Array<Record<string, unknown>>,
  pipeline: [] as Array<{ input: Record<string, unknown>; boundToServiceRole: boolean }>,
  scopeRead: null as null | (() => unknown),
  /** A concurrent request's sample of the shared client, taken while the
   *  upload's pipeline is mid-flight (INTK-2 / DEC-56: request-scoped). */
  concurrentSawAdmin: null as null | boolean,
  pipelineEntered: null as null | (() => void),
  pipelineRelease: null as null | Promise<void>,
  seq: 0,
  user: null as null | { id: string; email: string },
}));
const scopedToAdmin = () => (db.scopeRead?.() as { __admin?: boolean } | undefined)?.__admin === true;

function parseOr(expr: string): (r: Row) => boolean {
  const parts = expr.split(/,(?![^(]*\))(?![^{]*\})/);
  const preds = parts.map((p) => {
    let m: RegExpExecArray | null;
    if ((m = /^(\w+)\.in\.\(([^)]*)\)$/.exec(p))) { const list = m[2].split(",").map((x) => x.replace(/"/g, "")); const col = m[1]; return (r: Row) => list.includes(String(r[col])); }
    if ((m = /^(\w+)\.ov\.\{([^}]*)\}$/.exec(p))) { const list = m[2].split(",").map((x) => x.replace(/"/g, "")); const col = m[1]; return (r: Row) => Array.isArray(r[col]) && (r[col] as string[]).some((x) => list.includes(x)); }
    if ((m = /^(\w+)\.is\.null$/.exec(p))) { const col = m[1]; return (r: Row) => r[col] == null; }
    if ((m = /^(\w+)\.neq\.(.+)$/.exec(p))) { const col = m[1]; const v = m[2]; return (r: Row) => r[col] != null && String(r[col]) !== v; }
    return () => false;
  });
  return (r) => preds.some((p) => p(r));
}

function chain(table: string) {
  const filters: Filter[] = [];
  let pending: { method: string; args: unknown[] } | null = null;
  let head = false;
  let limitN: number | null = null;
  const matches = (r: Row) => filters.every(([op, col, val]) => {
    const v = col.includes("->") ? undefined : r[col];
    if (op === "eq") return col.includes("->")
      ? String((((r.metadata as Row | undefined)?.intake_collision as Row | undefined)?.intakeLinkId) ?? "") === String(val)
      : v === val;
    if (op === "neq") return v !== val;
    if (op === "in") return (val as unknown[]).includes(v);
    if (op === "is") return val === null ? v == null : v === val;
    if (op === "not-is") return !(val === null ? v == null : v === val);
    if (op === "not-in") return !(val as string[]).includes(String(v));
    if (op === "gte") return v == null || String(v) >= String(val);
    if (op === "or") return (val as (r: Row) => boolean)(r);
    return true;
  });
  const rows = () => (db.tables[table] ?? []).filter(matches);
  const errFor = (method: string) => db.errors[`${table}.${method}`]?.shift() ?? null;
  const finish = (): { data: unknown; error: unknown; count?: number | null } => {
    if (pending) {
      db.writes.push({ table, method: pending.method, args: pending.args, filters: [...filters] });
      const err = errFor(pending.method);
      if (err) return { data: null, error: err };
      if (pending.method === "update") {
        const matched = rows();
        for (const r of matched) Object.assign(r, pending.args[0] as Row);
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      if (pending.method === "delete") {
        const keep = (db.tables[table] ?? []).filter((r) => !matches(r));
        const gone = (db.tables[table] ?? []).length - keep.length;
        db.tables[table] = keep;
        return { data: Array.from({ length: gone }, () => ({})), error: null };
      }
      const payload = pending.args[0];
      const list = Array.isArray(payload) ? payload : [payload];
      const inserted = list.map((p) => ({ id: `${table}-new-${++db.seq}`, created_at: new Date().toISOString(), ...(p as Row) }));
      (db.tables[table] ??= []).push(...inserted);
      return { data: inserted, error: null };
    }
    const err = errFor("select");
    if (err) return { data: null, error: err };
    const all = rows();
    if (head) return { data: null, error: null, count: all.length };
    return { data: limitN != null ? all.slice(0, limitN) : all, error: null };
  };
  const one = (r: { data: unknown; error: unknown }) => ({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error });
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(finish());
      return (...args: unknown[]) => {
        switch (prop) {
          case "select": if ((args[1] as { head?: boolean } | undefined)?.head) head = true; break;
          case "eq": filters.push(["eq", String(args[0]), args[1]]); break;
          case "neq": filters.push(["neq", String(args[0]), args[1]]); break;
          case "in": filters.push(["in", String(args[0]), args[1]]); break;
          case "is": filters.push(["is", String(args[0]), args[1]]); break;
          case "gte": filters.push(["gte", String(args[0]), args[1]]); break;
          case "or": filters.push(["or", "", parseOr(String(args[0]))]); break;
          case "not": {
            const [col, op, val] = args as [string, string, unknown];
            if (op === "is") filters.push(["not-is", col, val]);
            else if (op === "in") filters.push(["not-in", col, String(val).replace(/^\(|\)$/g, "").split(",")]);
            break;
          }
          case "limit": limitN = Number(args[0]); break;
          case "update": case "insert": case "upsert": case "delete": pending = { method: prop, args }; break;
          case "maybeSingle": case "single": return Promise.resolve(one(finish()));
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}


vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    __admin: true,
    from: (t: string) => chain(t),
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ fn, args });
      const h = db.rpc[fn];
      return h ? h(args) : { data: null, error: null };
    }),
    auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: { message: "none" } })) },
  },
}));
// The shared client: a DIFFERENT view of the same tables, usable only in an
// async context the route has scoped to the service role (the REAL
// lib/serverClientScope.ts registers its AsyncLocalStorage reader here) —
// an unscoped (anon) call sees nothing, as RLS would show an anonymous caller.
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => {
      const bound = scopedToAdmin();
      if (t === "document_acknowledgments") db.sharedBoundAtAckWrite.push(bound);
      return bound ? chain(t) : chain("__anon_sees_nothing__");
    },
    rpc: async () => ({ data: null, error: null }),
  },
  __registerScopedServerClient: vi.fn((read: () => unknown) => { db.scopeRead = read; }),
}));
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async (cmd: { input: Row }) => { db.r2Puts.push(cmd.input); }) }, R2_BUCKET: "bucket" }));
vi.mock("@aws-sdk/client-s3", () => ({ PutObjectCommand: class { constructor(public input: unknown) {} } }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async (e: Row) => { db.emits.push(e); }) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => undefined), notifyMany: vi.fn(async () => undefined) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => undefined), logRevisionEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/intents", () => ({ listLiveIntents: vi.fn(async () => []) }));
vi.mock("@/lib/staleCopies", () => ({ getDocumentRecall: vi.fn(async () => ({ holders: [], unavailable: false })), nudgeStaleHolders: vi.fn(async () => undefined) }));
vi.mock("@/lib/workPackages", () => ({ notifyPackagesOfRevUp: vi.fn(async () => undefined) }));
vi.mock("@/lib/revisionImpact", () => ({ notifyConnectedWork: vi.fn(async () => undefined) }));
vi.mock("@/lib/linkProposals", () => ({ staleProposalsForDocument: vi.fn(async () => undefined) }));
vi.mock("@/lib/reviewCycles", () => ({
  onDocumentIssued: vi.fn(async () => {
    // A hook for the concurrency test: hold the pipeline mid-flight while
    // another request samples the shared client.
    if (db.pipelineEntered) { db.pipelineEntered(); await db.pipelineRelease; }
  }),
}));
vi.mock("@/lib/retention", () => ({ recomputeRetention: vi.fn(async () => undefined) }));
vi.mock("@/lib/distributionAcks", () => ({ closeStaleAcksForDocument: vi.fn(async () => 0) }));

import { POST } from "@/app/api/intake/upload/route";

const TOKEN = "t".repeat(40);
const D1 = "00000000-0000-4000-8000-0000000000d1";

beforeEach(() => {
  db.tables = {}; db.writes = []; db.errors = {}; db.rpcCalls = []; db.r2Puts = []; db.emits = []; db.pipeline = [];
  db.seq = 0; db.user = null; db.sharedBoundAtAckWrite = [];
  db.concurrentSawAdmin = null; db.pipelineEntered = null; db.pipelineRelease = null;
  db.tables.project_intake_links = [{
    id: "lnk1", org_id: "o1", project_id: "p1", company_name: "Vendor Co", contact_email: null, allow_auto_supersede: true,
    expires_at: null, revoked_at: null, assigned_doc_ids: [], created_by: "creator1", token: null, token_hash: createHash("sha256").update(TOKEN).digest("hex"), purpose: "documents",
    submission_count: 0, max_submissions: 500, bytes_received: 0, max_total_bytes: 10 ** 9,
  }];
  db.tables.projects = [{ id: "p1", org_id: "o1", status: "active", name: "Unit 4", owner_user_id: "owner1", intake_library_id: "lib1", intake_collection_id: "col1" }];
  db.tables.org_members = [
    { org_id: "o1", uid: "creator1", status: "active", role: "DocCtrl", roles: ["DocCtrl"], email: "c@x" },
    { org_id: "o1", uid: "fitter1", status: "active", role: "Viewer", roles: ["Viewer"], email: "f@x", display_name: "Pipefitter" },
  ];
  // An ack policy on the library: every issued revision needs the fitter's
  // read-&-understood.
  db.tables.libraries = [{ id: "lib1", org_id: "o1", ack_policy: { enabled: true, assigneeIds: ["fitter1"] }, review_control: null }];
  db.tables.collections = [{ id: "col1", ack_policy: null }];
  db.tables.documents = [{
    id: D1, org_id: "o1", authored_by_link_id: "lnk1", document_number: "V-100", title: "Skid", name: "Skid", rev: "B",
    status: "Issued", current_version_id: "v-cur", pending_version_id: null, library_id: "lib1", collection_id: "col1",
    review_control: null, ack_policy: null, checked_out_by: null, legal_hold: false,
  }];
  db.tables.document_versions = [{ id: "v-cur", org_id: "o1", record_id: D1, intake_link_id: "lnk1", review_state: "approved", revision_label: "B", created_at: "2026-09-01T00:00:00Z" }];
  // The crew acknowledged Rev B.
  db.tables.document_acknowledgments = [
    { id: "ack-b", document_id: D1, document_version_id: "v-cur", assignee_user_id: "fitter1", status: "pending" },
  ];
  db.rpc = {
    review_control_mode_for: () => ({ data: "none", error: null }),
    publish_revision: (a) => {
      db.tables.document_versions.push({ id: "v-pub", org_id: "o1", record_id: a.p_doc, review_state: null, revision_label: (a.p_version as Row).revision_label, released_at: new Date().toISOString() });
      Object.assign(db.tables.documents[0], { current_version_id: "v-pub", rev: (a.p_version as Row).revision_label, status: "Issued" });
      return { data: { status: "published", version: { id: "v-pub" } }, error: null };
    },
  };
});

describe("INTK-2 dw2 — an intake auto-publish opens a fresh acknowledgment roster and closes the prior one", () => {
  it("the new revision gets its roster; the Rev B row is voided; every roster write ran bound to the service role", async () => {
    const fd = new FormData();
    fd.set("file", new File([new TextEncoder().encode("%PDF-1.7\nrev C\n") as BlobPart], "c.pdf", { type: "application/pdf" }));
    fd.set("docId", D1);
    fd.set("revLabel", "C");
    const res = await POST(new NextRequest("http://x/api/intake/upload", { method: "POST", body: fd, headers: { "x-intake-token": TOKEN } }));
    expect((await res.json()).status).toBe("published");
    const acks = db.tables.document_acknowledgments;
    expect(acks.find((a) => a.id === "ack-b")).toMatchObject({ status: "void" });
    expect(acks.find((a) => a.document_version_id === "v-pub")).toMatchObject({ assignee_user_id: "fitter1", status: "pending", revision_label: "C" });
    expect(db.sharedBoundAtAckWrite.length).toBeGreaterThan(0);
    expect(db.sharedBoundAtAckWrite.every(Boolean)).toBe(true);
    // outside the request's async context nothing stays bound
    expect(scopedToAdmin()).toBe(false);
  });
  it("the binding is REQUEST-SCOPED: a concurrent request in the same instance, sampled while the pipeline is mid-flight, still sees the anonymous client (DEC-56)", async () => {
    let entered!: () => void;
    const inPipeline = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    db.pipelineRelease = new Promise<void>((r) => { release = r; });
    db.pipelineEntered = entered;
    const fd = new FormData();
    fd.set("file", new File([new TextEncoder().encode("%PDF-1.7\nrev C\n") as BlobPart], "c.pdf", { type: "application/pdf" }));
    fd.set("docId", D1);
    fd.set("revLabel", "C");
    const upload = POST(new NextRequest("http://x/api/intake/upload", { method: "POST", body: fd, headers: { "x-intake-token": TOKEN } }));
    // "another request": started outside the upload's context, it runs while
    // the upload holds the service-role binding
    const other = (async () => {
      await inPipeline;
      db.concurrentSawAdmin = scopedToAdmin();
      const { supabase } = await import("@/lib/supabase");
      const { data } = await supabase.from("documents").select("id");
      release();
      return data;
    })();
    const [res, otherRows] = await Promise.all([upload, other]);
    expect((await res.json()).status).toBe("published");
    expect(db.concurrentSawAdmin).toBe(false);
    expect(otherRows).toEqual([]); // the anonymous view — never the service role's
  });
  it("control: without the service-role binding the same pipeline would have touched nothing (why the route binds it)", async () => {
    const { runPostPublishSideEffects } = await import("@/lib/postPublish");
    await runPostPublishSideEffects({ orgId: "o1", documentId: D1, libraryId: "lib1", docLabel: "V-100", newRev: "C", actorUserId: "creator1", actorName: "x", settle: true });
    expect(db.tables.document_acknowledgments).toEqual([{ id: "ack-b", document_id: D1, document_version_id: "v-cur", assignee_user_id: "fitter1", status: "pending" }]);
  });
});
