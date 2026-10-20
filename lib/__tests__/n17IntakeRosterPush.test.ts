// notifications Round G — the integrator's ruling R4 at the N17 merge
// (DEC-90), OS-16: the read-&-understood roster the intake link's
// auto-publish opens ON THE SERVER is pushed to its recipients after their
// bell rows land, exactly as a browser publish's roster is.
//
// Driven through the REAL door (app/api/intake/upload/route.ts), the REAL
// post-publish pipeline (lib/postPublish.ts), the REAL roster
// (lib/acknowledgments.ts recomputeDocumentAck) and the REAL push leg
// (lib/notify/dispatch.ts pushAfterBellRows → the door's server sender,
// lib/push/afterResponsePush.ts). The harness is intakeAutoPublishAcks's
// (the shared client bound to the service role inside the request); the
// roster's bell writer (notifyCompliance) answers per recipient, and the
// server sender lib/push/sendPush.ts sendPushSafe is a spy.
//
// Pinned: the push follows the last bell row, names only the rows that
// landed (never a refused one), carries the roster's actor (the link's
// creator) as writerUid, and runs in next/server after() — the upload never
// waits on it; the bell rows (and the roster) are exactly as before; an
// after() that cannot schedule is logged and the publish stands.

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
  log: [] as Array<{ what: "notify" | "push"; input: Row }>,
  refuse: new Set<string>(),
  afterCbs: [] as Array<() => unknown>,
  afterThrows: false,
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
      if (h) return h(args);
      // projects-joint J16 (GAP-401): a database before 20261184 — the door
      // promotes through the service-role publish_revision, as before.
      if (fn.startsWith("intake_door_")) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } };
      return { data: null, error: null };
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
// the REAL push leg (pushAfterBellRows → pushLeg → the caller's server
// sender); only emit() (the other notices) is stubbed
vi.mock("@/lib/notify/dispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/dispatch")>()),
  emit: vi.fn(async (e: Row) => { db.emits.push(e); }),
}));
// the roster's bell writer: answers per recipient whether the row landed
vi.mock("@/lib/complianceNotify", () => ({
  notifyCompliance: vi.fn(async (n: Row) => {
    db.log.push({ what: "notify", input: n });
    return !db.refuse.has(String(n.userId));
  }),
  loadScanRetryPlan: vi.fn(async () => ({ unreadable: false, has: () => false, only: () => () => true })),
}));
// next/server after(): kept, run by the test once the response is out
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn((cb: () => unknown) => { if (db.afterThrows) throw new Error("after() outside a request"); db.afterCbs.push(cb); }),
}));
// the server push sender: a spy recording WHEN it ran
vi.mock("@/lib/push/sendPush", () => ({
  sendPushSafe: vi.fn(async (input: Row) => { db.log.push({ what: "push", input }); return { eligible: 0, attempted: 0, sent: 0, pruned: 0, capped: 0 }; }),
}));
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
import { sendPushSafe } from "@/lib/push/sendPush";

const TOKEN = "t".repeat(40);
const D1 = "00000000-0000-4000-8000-0000000000d1";

beforeEach(() => {
  db.tables = {}; db.writes = []; db.errors = {}; db.rpcCalls = []; db.r2Puts = []; db.emits = []; db.pipeline = [];
  db.seq = 0; db.user = null; db.sharedBoundAtAckWrite = [];
  db.concurrentSawAdmin = null; db.pipelineEntered = null; db.pipelineRelease = null;
  db.log = []; db.refuse = new Set(); db.afterCbs = []; db.afterThrows = false;
  db.tables.project_intake_links = [{
    id: "lnk1", org_id: "o1", project_id: "p1", company_name: "Vendor Co", contact_email: null, allow_auto_supersede: true,
    expires_at: null, revoked_at: null, assigned_doc_ids: [], created_by: "creator1", token: null, token_hash: createHash("sha256").update(TOKEN).digest("hex"), purpose: "documents",
    submission_count: 0, max_submissions: 500, bytes_received: 0, max_total_bytes: 10 ** 9,
  }];
  db.tables.projects = [{ id: "p1", org_id: "o1", status: "active", name: "Unit 4", owner_user_id: "owner1", intake_library_id: "lib1", intake_collection_id: "col1" }];
  db.tables.org_members = [
    { org_id: "o1", uid: "creator1", status: "active", role: "DocCtrl", roles: ["DocCtrl"], email: "c@x" },
    { org_id: "o1", uid: "fitter1", status: "active", role: "Viewer", roles: ["Viewer"], email: "f@x", display_name: "Pipefitter" },
    { org_id: "o1", uid: "fitter2", status: "active", role: "Viewer", roles: ["Viewer"], email: "g@x", display_name: "Welder" },
  ];
  // An ack policy on the library: every issued revision needs the fitter's
  // read-&-understood.
  db.tables.libraries = [{ id: "lib1", org_id: "o1", ack_policy: { enabled: true, assigneeIds: ["fitter1", "fitter2"] }, review_control: null }];
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

const upload = () => {
  const fd = new FormData();
  fd.set("file", new File([new TextEncoder().encode("%PDF-1.7\nrev C\n") as BlobPart], "c.pdf", { type: "application/pdf" }));
  fd.set("docId", D1);
  fd.set("revLabel", "C");
  return POST(new NextRequest("http://x/api/intake/upload", { method: "POST", body: fd, headers: { "x-intake-token": TOKEN } }));
};
const asks = () => db.log.filter((l) => l.what === "notify" && l.input.kind === "ack_requested").map((l) => l.input);
const pushes = () => db.log.filter((l) => l.what === "push").map((l) => l.input);
const afterRun = async () => { for (const cb of db.afterCbs.splice(0)) await cb(); };
/** The bell row each assignee is asked with — exactly as before N17 (no push field, nothing changed). */
const BELL = (userId: string) => ({
  orgId: "o1", userId, kind: "ack_requested",
  title: "Please read & acknowledge: V-100 Rev C",
  body: "Open the document and confirm you've read and understood this revision.",
  link: `/documents/lib1?doc=${D1}`, resourceType: "document", resourceId: D1,
  actorUserId: "creator1",
});

describe("OS-16 / R4 — the intake link's auto-publish pushes its read-and-understood roster after the bell rows land", () => {
  beforeEach(() => { vi.mocked(sendPushSafe).mockClear(); });

  it("the roster's recipients are pushed (ack_requested, this document, the link's creator as writer) after their bell rows, from after() — the roster and the bell rows exactly as before", async () => {
    const res = await upload();
    expect((await res.json()).status).toBe("published");
    // REGRESSION: the roster and both bell rows, as before
    const fresh = db.tables.document_acknowledgments.filter((a) => a.document_version_id === "v-pub");
    expect(fresh.map((a) => a.assignee_user_id).sort()).toEqual(["fitter1", "fitter2"]);
    expect(asks()).toHaveLength(2);
    for (const a of asks()) expect(a).toMatchObject(BELL(String(a.userId)));
    expect(asks().map((a) => a.userId).sort()).toEqual(["fitter1", "fitter2"]);
    // nothing pushed before the response: the push is an after() callback
    expect(pushes()).toEqual([]);
    expect(db.afterCbs).toHaveLength(1);
    await afterRun();
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0]).toEqual({ orgId: "o1", kind: "ack_requested", resourceId: D1, recipients: expect.arrayContaining(["fitter1", "fitter2"]), writerUid: "creator1" });
    expect((pushes()[0].recipients as string[]).length).toBe(2);
    // after the last bell row
    const lastAsk = db.log.map((l) => (l.what === "notify" && l.input.kind === "ack_requested" ? 1 : 0)).lastIndexOf(1);
    expect(db.log.findIndex((l) => l.what === "push")).toBeGreaterThan(lastAsk);
  });

  it("a REFUSED bell row is never pushed: only the recipient whose row landed is; the refused one keeps today's outcome (asked, not written)", async () => {
    db.refuse.add("fitter2");
    expect((await (await upload()).json()).status).toBe("published");
    expect(asks().map((a) => a.userId).sort()).toEqual(["fitter1", "fitter2"]);
    await afterRun();
    expect(pushes()).toEqual([{ orgId: "o1", kind: "ack_requested", resourceId: D1, recipients: ["fitter1"], writerUid: "creator1" }]);
  });

  it("no row landed → nothing is pushed (the sender is not even called)", async () => {
    db.refuse = new Set(["fitter1", "fitter2"]);
    expect((await (await upload()).json()).status).toBe("published");
    await afterRun();
    expect(pushes()).toEqual([]);
    expect(vi.mocked(sendPushSafe)).not.toHaveBeenCalled();
  });

  it("an after() that cannot schedule the push is logged; the publish, the roster and its bell rows stand", async () => {
    db.afterThrows = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await (await upload()).json()).status).toBe("published");
    expect(asks()).toHaveLength(2);
    expect(db.tables.document_acknowledgments.filter((a) => a.document_version_id === "v-pub")).toHaveLength(2);
    expect(pushes()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[intake\/upload\] the ack_requested push was not scheduled/), "after() outside a request");
    warn.mockRestore();
  });
});
