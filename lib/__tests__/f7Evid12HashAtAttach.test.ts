// drafting-flow EVID-12 (fleet F7-EVID12, DEC-90 option (b)): a ticket file is
// fingerprinted ONCE, server-side, at the workflow route's attach step, and the
// serial approval's OWN audit row carries that stored sha256. Pinned here:
//   * attach stores a sealed hash bound to the bytes read (count + ETag);
//   * attach succeeds IDENTICALLY when hashing fails, hangs or is over the
//     bound (same response, same ticket write; the reason rides the audit row);
//   * a client cannot supply the hash, and a moved / tampered one is ignored;
//   * the approval row carries the stored hash; a legacy file keeps today's
//     row and today's follow-up row exactly; the follow-up still runs and
//     says whether the bytes still match (a key can be written again).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";
import type { TicketAttachment } from "@/types/schema";

const LM = "2026-11-18T00:00:00.000Z";
const BYTES = "%PDF-1.7 the draft at attach";
const SHA = createHash("sha256").update(BYTES).digest("hex");
const KEY = "orgs/o1/tickets/REQ-1/1763424000000_iso_1A.pdf";

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  objects: {} as Record<string, { bytes: string; etag: string }>,
  r2: [] as Array<{ kind: string; key: string }>,
  getFail: false,
  getHang: false,
  /** the ETag a GetObject answers when it differs from the HEAD's (a re-PUT between the two) */
  getEtagOverride: null as string | null,
  after: [] as Array<() => unknown>,
}));
function chain(table: string) {
  const filters: Array<[string, unknown, "eq" | "is" | "in"]> = [];
  const rows = () => (state.rows[table] ?? [])
    .filter((r) => filters.every(([k, v, how]) => (how === "is" ? (r[k] ?? null) === v : how === "in" ? (v as unknown[]).includes(r[k]) : r[k] === v)))
    .map((r) => ({ ...r }));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null, count: rows().length });
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "eq") filters.push([String(args[0]), args[1], "eq"]);
        if (prop === "is") filters.push([String(args[0]), args[1], "is"]);
        if (prop === "in") filters.push([String(args[0]), args[1], "in"]);
        if (prop === "maybeSingle" || prop === "single") return Promise.resolve({ data: rows()[0] ?? null, error: null });
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (t: string) => chain(t),
    rpc: vi.fn(async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } })),
  },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) }, __registerScopedServerClient: () => {} }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn((fn: () => unknown) => { state.after.push(fn); }) }));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "b",
  r2: {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: { Key: string } }) => {
      const kind = cmd.constructor.name;
      const key = cmd.input.Key;
      state.r2.push({ kind, key });
      const o = state.objects[key];
      if (!o) throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
      if (kind === "GetObjectCommand") {
        if (state.getHang) return new Promise(() => {});
        if (state.getFail) throw new Error("timeout");
        return { ContentLength: o.bytes.length, ETag: `"${state.getEtagOverride ?? o.etag}"`, Body: (async function* () { yield new TextEncoder().encode(o.bytes); })() };
      }
      return { ContentLength: o.bytes.length, ETag: `"${o.etag}"` };
    }),
  },
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => ({ ok: true })) }));
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";
import { HASH_LIMITS } from "@/lib/ticketRoster";
import { sealContentHash, verifiedStoredHash, hashFilesAtAttach, storedHashFields } from "@/lib/ticketFileHash";
const LIMITS0 = { ...HASH_LIMITS };
const CTX = { orgId: "o1", ticketRowId: "t1" };

const post = (body: unknown) => workflowAction(new NextRequest("http://x/api/tickets/workflow-action", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const member = (uid: string, role: string) => ({ org_id: "o1", uid, role, roles: [role], email: `${uid}@x.io`, display_name: uid, status: "active" });
const DRAFT = { id: "a-d", name: "iso_1A.pdf", url: KEY, type: "Draft", status: "submitted", rev: "1A" } as TicketAttachment;
const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "x", status: "DRAFTING", request_type: "ISO", unit: null,
  requester_id: "req-1", requester_role: "Engineer-2", assigned_drafter_id: "d-1", assigned_engineer_id: null,
  attachments: [], comments: [], history: [], watchers: [], unread_by: [], revision_count: 0, draft_iteration: 0,
  last_modified: LM, library_id: null, metadata: {}, ...over,
});
const awaiting = (attachments: TicketAttachment[], over: Record<string, unknown> = {}) =>
  ticketRow({ status: "PENDING_REVIEW", deliverable_rev: "1A", draft_iteration: 1, attachments, ...over });
const seed = () => {
  state.rows.org_members = [member("req-1", "Engineer-2"), member("d-1", "Drafter"), member("a-1", "Admin")];
  state.rows.libraries = [];
};
const updates = () => state.calls.filter((c) => c.table === "tickets" && c.method === "update").map((c) => c.args[0] as Record<string, unknown>);
const audits = () => state.calls.filter((c) => c.table === "audit_logs" && c.method === "insert").map((c) => c.args[0] as { id?: string; action: string; details: Record<string, unknown> });
const row = (action: string) => audits().find((x) => x.action === action);
const gets = () => state.r2.filter((x) => x.kind === "GetObjectCommand");
async function runAfter(): Promise<void> {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  const fns = state.after.splice(0);
  await Promise.allSettled(fns.map((f) => Promise.resolve().then(f)));
  vi.unstubAllGlobals();
}
/** Attach a Draft as the drafter; the response, the written entry, the audit row. */
async function attach(extra: Record<string, unknown> = {}) {
  state.user = { id: "d-1" };
  state.rows.tickets = [ticketRow()];
  const res = await post({ ticketId: "t1", actionType: "attach_file", attachment: { name: "iso_1A.pdf", url: KEY, type: "Draft", ...extra } });
  const entry = ((updates()[0]?.attachments as TicketAttachment[] | undefined) ?? []).find((a) => a.url === KEY);
  return { status: res.status, body: await res.json(), entry, audit: row("TICKET_ATTACH_FILE") };
}
/** The entry / identity with the per-request values (minted id, clock) removed. */
const VOLATILE = ["id", "uploadedAt", "date", "attempt", "last_modified", "updated_at"];
const stable = (o: unknown) => JSON.parse(JSON.stringify(o ?? null, (k, v) => (VOLATILE.includes(k) ? undefined : v)));

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.r2 = []; state.after = [];
  state.getFail = false; state.getHang = false; state.getEtagOverride = null;
  state.objects = { [KEY]: { bytes: BYTES, etag: "etag-a" } };
  Object.assign(HASH_LIMITS, LIMITS0);
  seed();
});

describe("EVID-12 (F7) — the attach step stores the file's sha256, sealed and bound to the bytes read", () => {
  it("attach_file: the new entry carries contentHash (sha256 of the stored bytes, their count, the serving ETag, a seal that verifies); the attach row names it", async () => {
    const r = await attach();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, status: "DRAFTING" });
    expect(gets().map((g) => g.key)).toEqual([KEY]);
    expect(r.entry?.contentHash).toMatchObject({ sha256: SHA, bytes: BYTES.length, etag: "etag-a" });
    expect(verifiedStoredHash(r.entry, CTX)?.sha256).toBe(SHA);
    expect(r.audit?.details.attachment).toMatchObject({ url: KEY, etag: "etag-a", type: "Draft", sha256: SHA, sha256AtAttach: { bytes: BYTES.length, etag: "etag-a" } });
    // the seal is never written to the audit row
    expect(JSON.stringify(r.audit)).not.toContain(r.entry!.contentHash!.seal);
  });

  it("the hash survives submission (staged → submitted) and the approval's OWN row carries it — end to end, no storage read before the approval answers", async () => {
    const r = await attach();
    const afterAttach = updates()[0].attachments as TicketAttachment[];
    state.calls = []; state.r2 = []; state.after = [];
    state.rows.tickets = [ticketRow({ attachments: afterAttach })];
    expect((await post({ ticketId: "t1", actionType: "submit_draft" })).status).toBe(200);
    const submitted = updates()[0].attachments as TicketAttachment[];
    expect(submitted[0]).toMatchObject({ status: "submitted", rev: "1A", contentHash: r.entry!.contentHash });
    state.calls = []; state.r2 = []; state.after = [];
    state.rows.tickets = [awaiting(submitted)];
    state.user = { id: "req-1" };
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(200);
    expect(gets()).toEqual([]);
    const a = row("TICKET_APPROVE_DRAFT_IFC")!;
    expect(a.details.approvedDrafts).toEqual([{ id: submitted[0].id, name: "iso_1A.pdf", url: KEY, size: `${BYTES.length} B`, etag: null, sha256: SHA, sha256AtAttach: { bytes: BYTES.length, etag: "etag-a" } }]);
  });

  it("a file already on the ticket (re-attached under the same key) keeps the hash its first attach stored — not read again", async () => {
    const sealed = sealContentHash(CTX, KEY, { sha256: SHA, bytes: BYTES.length, etag: "etag-a" })!;
    state.user = { id: "d-1" };
    state.rows.tickets = [ticketRow({ attachments: [{ ...DRAFT, status: "staged", contentHash: sealed }] })];
    expect((await post({ ticketId: "t1", actionType: "attach_file", attachment: { name: "iso_1A.pdf", url: KEY, type: "Draft" } })).status).toBe(200);
    expect(gets()).toEqual([]);
    const entries = updates()[0].attachments as TicketAttachment[];
    expect(entries[entries.length - 1].contentHash).toEqual(sealed);
  });

  it("a hash the CLIENT sends is dropped: the entry carries only the server's", async () => {
    const forged = { sha256: "0".repeat(64), bytes: 1, etag: "x", seal: "forged" };
    const r = await attach({ contentHash: forged });
    expect(r.entry?.contentHash?.sha256).toBe(SHA);
    // and when the server cannot hash it, the client's claim is not kept either
    state.calls = []; state.r2 = []; state.getFail = true;
    const r2 = await attach({ contentHash: forged });
    expect(r2.status).toBe(200);
    expect(r2.entry && "contentHash" in r2.entry).toBe(false);
  });
});

describe("EVID-12 (F7) — bookkeeping: an attach whose hash cannot be taken lands exactly as today", () => {
  async function baseline() {
    // what the attach writes when no hash is stored (storage served no bytes —
    // the entry is today's entry, field for field)
    state.getFail = true;
    const r = await attach();
    state.calls = []; state.r2 = []; state.after = []; state.getFail = false;
    return r;
  }
  it("storage that cannot serve the bytes: 200, the same response, the same ticket write (no contentHash key), the HEAD as before; the audit row adds only why", async () => {
    const ok = await attach();
    const okUpdate = updates()[0];
    state.calls = []; state.r2 = [];
    state.getFail = true;
    const down = await attach();
    const downUpdate = updates()[0];
    expect(down.status).toBe(200);
    expect(down.body).toEqual(ok.body);
    expect(down.entry && "contentHash" in down.entry).toBe(false);
    const { contentHash: _h, ...okWithoutHash } = ok.entry!;
    void _h;
    expect(stable(down.entry)).toEqual(stable(okWithoutHash));
    // the rest of the ticket write (status, history line, …) is the same too
    expect(stable({ ...downUpdate, attachments: undefined })).toEqual(stable({ ...okUpdate, attachments: undefined }));
    const { sha256Unavailable, ...identity } = down.audit!.details.attachment as Record<string, unknown>;
    expect(sha256Unavailable).toBe("storage could not be read");
    const { sha256: _s, sha256AtAttach: _b, ...okIdentity } = ok.audit!.details.attachment as Record<string, unknown>;
    void _s; void _b;
    expect(stable(identity)).toEqual(stable(okIdentity));
    expect(state.r2.filter((x) => x.kind === "HeadObjectCommand").map((x) => x.key)).toEqual([KEY]);
  });

  it("a GetObject that NEVER answers: the attach lands at the attach deadline (bounded, never hung), the entry identical to today's", async () => {
    const today = await baseline();
    HASH_LIMITS.attachDeadlineMs = 60;
    state.getHang = true;
    const t0 = Date.now();
    const r = await attach();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(today.body);
    expect(stable(r.entry)).toEqual(stable(today.entry));
    expect((r.audit!.details.attachment as Record<string, unknown>).sha256Unavailable).toBe("not hashed (deadline)");
  });

  it("a file over the attach byte budget: not hashed (recorded why), attach identical", async () => {
    const today = await baseline();
    HASH_LIMITS.attachByteBudget = 4;
    const r = await attach();
    expect(r.status).toBe(200);
    expect(stable(r.entry)).toEqual(stable(today.entry));
    expect((r.audit!.details.attachment as Record<string, unknown>).sha256Unavailable).toBe("not hashed (byte budget)");
  });

  it("bytes replaced between the storage check and the read (the GetObject's ETag differs from the HEAD's): no hash stored, attach identical", async () => {
    const today = await baseline();
    state.getEtagOverride = "etag-b";
    const r = await attach();
    expect(r.status).toBe(200);
    expect(stable(r.entry)).toEqual(stable(today.entry));
    expect((r.audit!.details.attachment as Record<string, unknown>).sha256Unavailable).toBe("the stored file changed while it was being attached");
  });

  it("a refused attach (the file is not in storage) is refused exactly as before — no hash read", async () => {
    state.objects = {};
    const r = await attach();
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "That file is not in storage — upload it again and retry" });
    expect(gets()).toEqual([]);
    expect(updates()).toEqual([]);
  });
});

describe("EVID-12 (F7) — the serial approval's own row carries each approved Draft's stored sha256", () => {
  const sealed = (url = KEY, sha = SHA, etag = "etag-a", ctx = CTX) => sealContentHash(ctx, url, { sha256: sha, bytes: BYTES.length, etag })!;

  it("a Draft with a stored hash: the approval row names it with sha256 + what it is bound to; the follow-up row is still written, re-reads the bytes and says they match", async () => {
    state.rows.tickets = [awaiting([{ ...DRAFT, contentHash: sealed() }])];
    state.user = { id: "req-1" };
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(200);
    expect(gets()).toEqual([]);
    const a = row("TICKET_APPROVE_DRAFT_IFC")!;
    expect(a.details.approvedDrafts).toEqual([{ id: "a-d", name: "iso_1A.pdf", url: KEY, size: null, etag: null, sha256: SHA, sha256AtAttach: { bytes: BYTES.length, etag: "etag-a" } }]);
    expect(a.details.filesHashedIn).toBe("TICKET_APPROVE_DRAFT_IFC_FILES_HASHED");
    await runAfter();
    const f = row("TICKET_APPROVE_DRAFT_IFC_FILES_HASHED")!;
    expect(f.details.approval).toBe(a.id);
    expect((f.details.approvedDrafts as Array<Record<string, unknown>>)[0]).toMatchObject({ id: "a-d", sha256: SHA, matchesStoredHash: true });
  });

  it("the key was written again after the attach: the approval row carries the attach-time hash with its binding, and the follow-up row says the bytes no longer match (stale)", async () => {
    state.objects[KEY] = { bytes: "replaced bytes", etag: "etag-z" };
    state.rows.tickets = [awaiting([{ ...DRAFT, contentHash: sealed() }])];
    state.user = { id: "req-1" };
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(200);
    expect((row("TICKET_APPROVE_DRAFT_IFC")!.details.approvedDrafts as Array<Record<string, unknown>>)[0]).toMatchObject({ sha256: SHA, sha256AtAttach: { etag: "etag-a" } });
    await runAfter();
    const d = (row("TICKET_APPROVE_DRAFT_IFC_FILES_HASHED")!.details.approvedDrafts as Array<Record<string, unknown>>)[0];
    expect(d.sha256).toBe(createHash("sha256").update("replaced bytes").digest("hex"));
    expect(d.matchesStoredHash).toBe(false);
  });

  it("REGRESSION — a legacy Draft (no stored hash): the approval row and its follow-up row are exactly today's", async () => {
    state.rows.tickets = [awaiting([{ ...DRAFT }])];
    state.user = { id: "req-1" };
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(200);
    expect(gets()).toEqual([]);
    const a = row("TICKET_APPROVE_DRAFT_IFC")!;
    expect(a.details.approvedDrafts).toEqual([{ id: "a-d", name: "iso_1A.pdf", url: KEY, size: null, etag: null }]);
    expect(a.details.filesHashedIn).toBe("TICKET_APPROVE_DRAFT_IFC_FILES_HASHED");
    await runAfter();
    const f = row("TICKET_APPROVE_DRAFT_IFC_FILES_HASHED")!;
    expect(f.details).toEqual({ approval: a.id, deliverable_rev: "1", approvedDrafts: [{ id: "a-d", name: "iso_1A.pdf", url: KEY, size: null, etag: null, sha256: SHA }] });
  });

  it("a hash that is not the route's seal for THIS ticket and key — unsealed, tampered, moved from another ticket or key — is ignored: today's row", async () => {
    const forged = [
      { sha256: SHA, bytes: BYTES.length, etag: "etag-a" },
      { ...sealed(), sha256: "f".repeat(64) },
      sealed(KEY, SHA, "etag-a", { orgId: "o1", ticketRowId: "t-other" }),
      sealed("orgs/o1/tickets/REQ-1/other.pdf"),
    ];
    for (const contentHash of forged) {
      state.calls = []; state.after = [];
      state.rows.tickets = [awaiting([{ ...DRAFT, contentHash } as TicketAttachment])];
      state.user = { id: "req-1" };
      expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(200);
      expect(row("TICKET_APPROVE_DRAFT_IFC")!.details.approvedDrafts).toEqual([{ id: "a-d", name: "iso_1A.pdf", url: KEY, size: null, etag: null }]);
    }
  });

  it("mixed: a stored-hash Draft and a legacy Draft — each carries what it has; the follow-up row still hashes both", async () => {
    const LEG = "orgs/o1/tickets/REQ-1/legacy.pdf";
    state.objects[LEG] = { bytes: "legacy", etag: "etag-l" };
    state.rows.tickets = [awaiting([{ ...DRAFT, contentHash: sealed() }, { ...DRAFT, id: "a-l", name: "legacy.pdf", url: LEG }])];
    state.user = { id: "req-1" };
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(200);
    const drafts = row("TICKET_APPROVE_DRAFT_IFC")!.details.approvedDrafts as Array<Record<string, unknown>>;
    expect(drafts[0]).toMatchObject({ id: "a-d", sha256: SHA });
    expect(drafts[1]).toEqual({ id: "a-l", name: "legacy.pdf", url: LEG, size: null, etag: null });
    await runAfter();
    const f = row("TICKET_APPROVE_DRAFT_IFC_FILES_HASHED")!.details.approvedDrafts as Array<Record<string, unknown>>;
    expect(f[0]).toMatchObject({ id: "a-d", sha256: SHA, matchesStoredHash: true });
    expect(f[1]).toEqual({ id: "a-l", name: "legacy.pdf", url: LEG, size: null, etag: null, sha256: createHash("sha256").update("legacy").digest("hex") });
  });

  it("FRIC-5 issue-as-is on today's path: the Final the approval recorded carries the Draft's stored hash (same key, same bytes); the follow-up states the hash read now", async () => {
    state.rows.tickets = [awaiting([{ ...DRAFT, contentHash: sealed() }], { metadata: { issue_ready: { rev: "1A", by: "d-1", at: LM } } })];
    state.user = { id: "req-1" };
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc", issueAsIsAcknowledged: true })).status).toBe(200);
    const asIs = row("TICKET_APPROVE_DRAFT_IFC")!.details.issuedAsIsFinals as Array<Record<string, unknown>>;
    expect(asIs[0]).toMatchObject({ url: KEY, issuedFromDraftId: "a-d", sha256: SHA, sha256AtAttach: { bytes: BYTES.length, etag: "etag-a" } });
    await runAfter();
    const f = (row("TICKET_APPROVE_DRAFT_IFC_FILES_HASHED")!.details.issuedAsIsFinals as Array<Record<string, unknown>>)[0];
    expect(f).toMatchObject({ issuedFromDraftId: "a-d", sha256: SHA, matchesStoredHash: true });
    expect("sha256AtAttach" in f).toBe(false);
  });
});

describe("EVID-12 (F7) — lib/ticketFileHash.ts", () => {
  it("the seal binds org, ticket row, key, sha256, bytes and ETag; storedHashFields never prints the seal", () => {
    const s = sealContentHash(CTX, KEY, { sha256: SHA, bytes: 3, etag: "e" })!;
    expect(verifiedStoredHash({ url: KEY, contentHash: s }, CTX)).toEqual(s);
    for (const bad of [{ ...s, bytes: 4 }, { ...s, etag: "f" }, { ...s, etag: null }, { ...s, seal: s.seal.slice(1) }]) {
      expect(verifiedStoredHash({ url: KEY, contentHash: bad }, CTX)).toBeNull();
    }
    expect(verifiedStoredHash({ url: KEY, contentHash: s }, { orgId: "o2", ticketRowId: "t1" })).toBeNull();
    expect(verifiedStoredHash({ url: KEY, contentHash: undefined }, CTX)).toBeNull();
    expect(storedHashFields(s)).toEqual({ sha256: SHA, sha256AtAttach: { bytes: 3, etag: "e" } });
    expect(storedHashFields(null)).toEqual({});
  });
  it("no sealing key configured: nothing is stored (never an unsealed hash), and nothing verifies", async () => {
    const s = sealContentHash(CTX, KEY, { sha256: SHA, bytes: 3, etag: "e" })!;
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("TICKET_FILE_HASH_SECRET", "");
    try {
      expect(sealContentHash(CTX, KEY, { sha256: SHA, bytes: 3, etag: "e" })).toBeNull();
      expect(verifiedStoredHash({ url: KEY, contentHash: s }, CTX)).toBeNull();
      const out = await hashFilesAtAttach([KEY], async () => ({ ContentLength: 3, ETag: '"e"', Body: (async function* () { yield new Uint8Array([1, 2, 3]); })() }), { deadlineMs: 1000, byteBudget: 100 }, CTX);
      expect(out.get(KEY)).toEqual({ ok: false, reason: "no sealing key configured" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("a get that throws synchronously-ish or rejects never throws out of hashFilesAtAttach", async () => {
    const out = await hashFilesAtAttach([KEY, KEY], async () => { throw new Error("boom"); }, { deadlineMs: 1000, byteBudget: 100 }, CTX);
    expect([...out.keys()]).toEqual([KEY]);
    expect(out.get(KEY)).toEqual({ ok: false, reason: "storage could not be read" });
  });
});
