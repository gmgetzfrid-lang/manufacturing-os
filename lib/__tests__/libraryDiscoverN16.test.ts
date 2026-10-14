// notifications Round G, N16 LIBRARY DISCOVER AND BOUNDED FALLBACK.
//
// NEDGE-22: a notice about a LIBRARY that names a document in it
// (library_doc_revised, library_doc_added, transmittal_issued) tells a
// follower reached only through the library's follow list the document's
// name only while they may discover it — the DEC-106 check for each named
// document, all asked at once (lib/notify/recipients.ts discoveringAmong,
// through EmitInput.namesDocuments). Nobody who follows the library stops hearing
// about it: a follower the check ANSWERED for who may not discover the
// document gets the notice without its name (unnamedNotice); one a FAILED
// check could not settle gets redactedNotice() (DEC-106 item 2); controllers
// are never dropped (DEC-43); someone the producer names is not filtered.
// REGRESSION: every library notice that reaches a follower today still
// reaches them, exactly as written for everyone who may discover what it
// names.
//
// NEDGE-6 remainder: on a FAILED check the controllers lookup
// (controllersAmong — one read of the org's controllers) is bounded — one
// deadline and a row cap; a stalled, failed or capped lookup answers what it
// confirmed, never holds the emit open itself (whoever it could not confirm
// gets the redacted notice) and the shortfall is logged. The reads and
// inserts after it still wait on a stalled session read, like every request
// the shared client makes — NEDGE-6's residual, pinned end to end below.
//
// Also pinned: the staged upload's notice target (lib/libraryNotify
// firstNoticeTarget) and a transmittal's per-library notices started side by
// side (lib/transmittals notifyTransmittalIssued).
//
// Driven through the REAL dispatcher, recipients and inAppNotifications over
// the in-memory PostgREST stand-in (helpers/memoryDb), as
// recipientDiscovery.test.ts is.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resetState, type MemoryState } from "./helpers/memoryDb";

const h = vi.hoisted(() => ({
  state: null as unknown as MemoryState,
  emails: [] as Array<Record<string, unknown>>,
  client: null as unknown as Record<string, unknown>,
  /** org_members reads whose columns match — never answered (a stalled read) */
  stall: null as null | ((table: string, cols: string) => boolean),
  /** while set, EVERY request through the client (reads and inserts) waits
   *  on it — the shared supabase-js client awaiting a stalled
   *  auth.getSession() before each request, as it does in the browser */
  gate: null as null | Promise<unknown>,
}));

vi.mock("@/lib/supabase", async () => {
  const mem = await import("./helpers/memoryDb");
  h.state = mem.freshState();
  const base = mem.makeSupabase(h.state) as unknown as Record<string, unknown> & { from: (t: string) => Record<string, unknown> };
  const never = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    const proxy: Record<string, unknown> = new Proxy(p, {
      get(_t, prop: string) {
        if (prop === "then") return () => undefined; // never settles
        return () => proxy;
      },
    });
    return proxy;
  };
  // PostgREST's own answer to the two modifiers the controllers lookup sends,
  // which the shared stand-in ignores: `.or(roleFilter(roles))` (headline in
  // roles, or the collection overlaps) and `.limit(n)`.
  type Ctx = { roles?: string[]; limit?: number };
  const parseRoleFilter = (f: string): string[] | undefined => {
    const m = /^role\.in\.\(([^)]*)\)/.exec(f);
    return m ? m[1].split(",").map((r) => r.replace(/"/g, "").trim()).filter(Boolean) : undefined;
  };
  const shape = (out: unknown, ctx: Ctx): unknown => {
    const o = out as { data?: unknown } | null;
    if (!o || !Array.isArray(o.data)) return out;
    let rows = o.data as Array<Record<string, unknown>>;
    if (ctx.roles) {
      const want = ctx.roles;
      rows = rows.filter((r) => want.includes(r.role as string) || (Array.isArray(r.roles) && (r.roles as string[]).some((x) => want.includes(x))));
    }
    if (ctx.limit != null) rows = rows.slice(0, ctx.limit);
    return { ...o, data: rows };
  };
  const gated = (v: unknown, ctx: Ctx): unknown => {
    if (v === null || (typeof v !== "object" && typeof v !== "function")) return v;
    return new Proxy(v as object, {
      get(target, prop) {
        const val = Reflect.get(target, prop) as unknown;
        if (typeof val !== "function") return val;
        const fn = val as (...a: unknown[]) => unknown;
        if (prop === "then") {
          return (res?: (x: unknown) => unknown, rej?: (e: unknown) => unknown) => {
            const run = () => fn.call(target, (out: unknown) => (res ? res(shape(out, ctx)) : shape(out, ctx)), rej);
            return h.gate ? h.gate.then(run) : run();
          };
        }
        return (...args: unknown[]) => {
          if (prop === "or" && typeof args[0] === "string") ctx.roles = parseRoleFilter(args[0]);
          if (prop === "limit" && typeof args[0] === "number") ctx.limit = args[0];
          return gated(fn.apply(target, args), ctx);
        };
      },
    });
  };
  h.client = {
    ...base,
    from: (t: string) => {
      const b = base.from(t);
      const ctx: Ctx = {};
      return new Proxy(b, {
        get(target, prop: string) {
          const val = target[prop] as unknown;
          if (prop === "select") {
            return (cols: string, o?: unknown) => (h.stall?.(t, cols) ? never() : gated((val as (c: string, o?: unknown) => unknown)(cols, o), ctx));
          }
          return typeof val === "function" ? (...args: unknown[]) => gated((val as (...a: unknown[]) => unknown)(...args), ctx) : val;
        },
      });
    },
  };
  return { supabase: h.client };
});
vi.mock("@/lib/notifications", () => ({
  queueEmail: vi.fn(async (input: Record<string, unknown>) => { h.emails.push(input); }),
}));
vi.mock("@/lib/intents", () => ({ listLiveIntents: vi.fn(async () => []) }));
vi.mock("@/lib/ownership", () => ({
  effectiveOwnerForDocument: vi.fn(async (d: { ownerUserId?: string | null }) => ({ userId: d.ownerUserId ?? null })),
}));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ error: null })) }));

import { emit, resolveRecipients, unnamedNotice, redactedNotice, UNNAMED_BODY, type EmitInput } from "@/lib/notify/dispatch";
import {
  __registerServerDiscoverCheck, controllersAmong, discoveringAmong,
  CONTROLLERS_LOOKUP_MAX_ROWS, CONTROLLERS_LOOKUP_TIMEOUT_MS, DISCOVER_TIMEOUT_MS,
  type DiscoverCheck,
} from "@/lib/notify/recipients";
import { roleFilter } from "@/lib/roleHeld";

const ORG = "o-1";

function seed() {
  resetState(h.state);
  h.emails.length = 0;
  h.stall = null;
  h.gate = null;
  h.state.tables.org_members = [
    { org_id: ORG, uid: "actor", status: "active", role: "Engineer", roles: null, email: "actor@x.com" },
    { org_id: ORG, uid: "f-sees", status: "active", role: "Engineer", roles: null, email: "f-sees@x.com" },
    { org_id: ORG, uid: "f-hidden", status: "active", role: "Engineer", roles: null, email: "f-hidden@x.com" },
    { org_id: ORG, uid: "f-admin", status: "active", role: "Admin", roles: null, email: "f-admin@x.com" },
    { org_id: ORG, uid: "f-dc", status: "active", role: "Manager", roles: ["Manager", "DocCtrl"], email: "f-dc@x.com" },
    { org_id: ORG, uid: "owner", status: "active", role: "Engineer", roles: null, email: "owner@x.com" },
  ];
  // the library's followers (WatchButton → subscriptions)
  h.state.tables.subscriptions = ["f-sees", "f-hidden", "f-admin", "f-dc"].map((u) => ({
    org_id: ORG, user_id: u, resource_type: "library", resource_id: "lib-1",
  }));
  h.state.tables.notifications = [];
}

/** The server check (lib/documentDiscoverers.ts registers the real one): doc-1
 *  is a hidden document in an open library, granted to f-sees; the
 *  controllers pass by DEC-43. doc-2 is open to every member. */
const calls: Array<{ documentId: string; uids: string[] }> = [];
const check: DiscoverCheck = async ({ documentId, uids }) => {
  calls.push({ documentId, uids: [...uids] });
  if (documentId === "doc-2") return { ok: true, discover: [...uids] };
  return { ok: true, discover: uids.filter((u) => ["f-sees", "f-admin", "f-dc"].includes(u)) };
};
const openCheck: DiscoverCheck = async ({ documentId, uids }) => { calls.push({ documentId, uids: [...uids] }); return { ok: true, discover: [...uids] }; };

function libEv(over: Partial<EmitInput> = {}): EmitInput {
  return {
    orgId: ORG, category: "watched", kind: "library_doc_revised",
    title: "PID-4412 → Rev C", body: "Dana published Rev C in a library you subscribe to.",
    link: "/documents/lib-1?doc=doc-1", resource: { type: "library", id: "lib-1" },
    actorUserId: "actor", actorName: "Dana",
    audience: { followers: true },
    namesDocuments: {
      ids: ["doc-1"],
      unnamed: { title: "New revision in a library you follow", body: "Dana published a new revision in a library you subscribe to.", link: "/documents/lib-1" },
    },
    ...over,
  };
}
const rows = () => (h.state.tables.notifications ?? []) as Array<Record<string, unknown>>;
const bell = () => rows().map((r) => r.user_id as string).sort();
const rowFor = (u: string) => rows().filter((r) => r.user_id === u);
const mailFor = (u: string) => h.emails.filter((e) => e.toUserId === u);

beforeEach(() => { seed(); calls.length = 0; __registerServerDiscoverCheck(null); });
afterEach(() => { __registerServerDiscoverCheck(null); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("NEDGE-22 — a library's follower is told a document's name only while they may discover it", () => {
  it("reproduced (the notice as HEAD sent it — no namesDocuments): every library follower reads the hidden document's number, f-hidden included, and nothing is asked", async () => {
    __registerServerDiscoverCheck(check);
    await emit(libEv({ namesDocuments: undefined }));
    expect(bell()).toEqual(["f-admin", "f-dc", "f-hidden", "f-sees"]);
    expect(rowFor("f-hidden")[0].title).toBe("PID-4412 → Rev C");
    expect(calls).toEqual([]);
  });

  it("with the check: f-hidden (outside the hidden document's ACL) gets exactly one row and one email WITHOUT the document; f-sees and both controllers (headline and additive) get it as written", async () => {
    __registerServerDiscoverCheck(check);
    const r = await emit(libEv());
    expect(bell()).toEqual(["f-admin", "f-dc", "f-hidden", "f-sees"]);
    expect(r).toEqual({ recipients: 4, inapp: { sent: 4, failed: 0 } });
    for (const u of ["f-sees", "f-admin", "f-dc"]) {
      expect(rowFor(u), u).toHaveLength(1);
      expect(rowFor(u)[0], u).toMatchObject({ title: "PID-4412 → Rev C", link: "/documents/lib-1?doc=doc-1", kind: "library_doc_revised" });
    }
    const [row] = rowFor("f-hidden");
    expect(rowFor("f-hidden")).toHaveLength(1);
    expect(row).toMatchObject({
      kind: "library_doc_revised", title: "New revision in a library you follow", link: "/documents/lib-1",
      resource_type: "library", resource_id: "lib-1", metadata: { redacted: true },
    });
    expect(JSON.stringify(row)).not.toMatch(/PID-4412|doc-1|Rev C/);
    const mail = mailFor("f-hidden");
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toBe("New revision in a library you follow");
    expect(JSON.stringify(mail[0])).not.toMatch(/PID-4412|doc-1|Rev C/);
    expect(h.emails).toHaveLength(4);
    // asked once, about the followers only — the actor never
    expect(calls).toEqual([{ documentId: "doc-1", uids: ["f-sees", "f-hidden", "f-admin", "f-dc"] }]);
  });

  it("REGRESSION: a document every member may discover — every library follower gets exactly the notice as written, one row and one email each", async () => {
    __registerServerDiscoverCheck(openCheck);
    await emit(libEv());
    expect(bell()).toEqual(["f-admin", "f-dc", "f-hidden", "f-sees"]);
    expect(new Set(bell()).size).toBe(4);
    expect(rows().every((x) => x.title === "PID-4412 → Rev C" && x.link === "/documents/lib-1?doc=doc-1")).toBe(true);
    expect(rows().some((x) => (x.metadata as { redacted?: boolean } | null)?.redacted)).toBe(false);
    expect(h.emails).toHaveLength(4);
  });

  it("someone the producer NAMES (a transmittal's document owner) is not filtered and not asked about", async () => {
    __registerServerDiscoverCheck(check);
    await emit(libEv({ audience: { involved: ["owner", "f-hidden"], followers: true } }));
    expect(rowFor("f-hidden")[0].title).toBe("PID-4412 → Rev C");
    expect(rowFor("owner")[0].title).toBe("PID-4412 → Rev C");
    expect(calls[0].uids).toEqual(["f-sees", "f-admin", "f-dc"]);
  });

  it("a check that FAILS redacts exactly as DEC-106 does — the controllers in full, every other follower one redacted row and email; the document's link is replaced by the library's", async () => {
    __registerServerDiscoverCheck(async () => ({ ok: false, error: "the discover check answered 503" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await emit(libEv());
    expect(r.recipients).toBe(4);
    for (const u of ["f-admin", "f-dc"]) expect(rowFor(u)[0].title, u).toBe("PID-4412 → Rev C");
    for (const u of ["f-sees", "f-hidden"]) {
      const [row] = rowFor(u);
      expect(rowFor(u), u).toHaveLength(1);
      expect(row, u).toMatchObject({ title: "New activity on a library", link: "/documents/lib-1", metadata: { redacted: true } });
      expect(String(row.body), u).toMatch(/could not be confirmed/);
      expect(JSON.stringify(row), u).not.toMatch(/PID-4412|doc-1/);
      expect(mailFor(u), u).toHaveLength(1);
    }
    expect(warn.mock.calls.some((c) => String(c[0]).includes("follower(s) of library lib-1 the discover check could not settle"))).toBe(true);
  });

  it("no check in this context (a server entry that never loaded lib/documentDiscoverers): everyone gets the notice as written, as before, logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await emit(libEv());
    expect(rows().every((x) => x.title === "PID-4412 → Rev C")).toBe(true);
    expect(bell()).toEqual(["f-admin", "f-dc", "f-hidden", "f-sees"]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("no discover check in this context"))).toBe(true);
  });

  it("several named documents (a transmittal): told the names only when every one may be discovered; every named document is asked about, each about every follower", async () => {
    __registerServerDiscoverCheck(check);
    await emit(libEv({
      kind: "transmittal_issued", title: "Transmittal TR-7 issued: 2 documents to BuildCo",
      body: "Dana issued transmittal TR-7 to BuildCo: E-9, PID-4412.", link: "/transmittals",
      namesDocuments: { ids: ["doc-2", "doc-1"], unnamed: { title: "Transmittal TR-7 issued to BuildCo", body: "Dana issued transmittal TR-7 to BuildCo, with documents from a library you follow." } },
    }));
    expect(calls).toEqual([
      { documentId: "doc-2", uids: ["f-sees", "f-hidden", "f-admin", "f-dc"] },
      { documentId: "doc-1", uids: ["f-sees", "f-hidden", "f-admin", "f-dc"] },
    ]);
    for (const u of ["f-sees", "f-admin", "f-dc"]) expect(rowFor(u)[0].title, u).toBe("Transmittal TR-7 issued: 2 documents to BuildCo");
    expect(rowFor("f-hidden")[0]).toMatchObject({ title: "Transmittal TR-7 issued to BuildCo", link: "/transmittals" });
    expect(JSON.stringify(rowFor("f-hidden"))).not.toMatch(/PID-4412|E-9/);
  });

  it("the named documents are asked about AT ONCE — every check starts before any answers — and the three outcomes hold: ruled out by an answered check → unnamed (even beside a failed one); left out only by a failed check → redacted; kept by every answer → in full", async () => {
    const started: string[] = [];
    let release!: () => void;
    const answersMay = new Promise<void>((r) => { release = r; });
    __registerServerDiscoverCheck(async ({ documentId, uids }) => {
      started.push(documentId);
      await answersMay;
      if (documentId === "doc-a") return { ok: true, discover: uids.filter((u) => u !== "f-hidden") };
      if (documentId === "doc-b") return { ok: false, error: "timeout" };
      return { ok: true, discover: [...uids] };
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sent = emit(libEv({ namesDocuments: { ids: ["doc-a", "doc-b", "doc-c"] } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["doc-a", "doc-b", "doc-c"]); // all three asked while none has answered
    release();
    expect((await sent).recipients).toBe(4);
    // f-hidden: doc-a answered no → unnamed (generic, the producer worded none), though doc-b failed too
    expect(rowFor("f-hidden")[0]).toMatchObject({ title: "New activity on a library", body: UNNAMED_BODY, metadata: { redacted: true } });
    // f-sees: kept by every answer that was given, left out only by doc-b's failure → redacted
    expect(String(rowFor("f-sees")[0].body)).toMatch(/could not be confirmed/);
    // the controllers: kept by doc-a and doc-c, confirmed by doc-b's controllers lookup → in full
    for (const u of ["f-admin", "f-dc"]) expect(rowFor(u)[0].title, u).toBe("PID-4412 → Rev C");
    expect(rows()).toHaveLength(4);
  });

  it("the BROWSER: three named documents cost one round trip's wait, not three (the checks run side by side)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
    (h.client.auth as Record<string, unknown>).getSession = async () => ({ data: { session: { access_token: "tok-1" } } });
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { documentId: string; uids: string[] };
      asked.push(body.documentId);
      return new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ discover: body.uids }) }), 1000));
    }));
    try {
      let done = false;
      const sent = emit(libEv({ namesDocuments: { ids: ["doc-a", "doc-b", "doc-c"] } })).then((r) => { done = true; return r; });
      await vi.advanceTimersByTimeAsync(1000);
      expect(asked).toEqual(["doc-a", "doc-b", "doc-c"]);
      expect(done).toBe(true); // one-at-a-time asking would still be waiting on the second answer
      expect((await sent).recipients).toBe(4);
      expect(rows().every((x) => x.title === "PID-4412 → Rev C")).toBe(true);
    } finally {
      (h.client.auth as Record<string, unknown>).getSession = async () => ({ data: { session: null } });
    }
  });

  it("a document resource ignores namesDocuments (its own check runs, as N15 wired it)", async () => {
    __registerServerDiscoverCheck(check);
    h.state.tables.subscriptions = ["f-sees", "f-hidden"].map((u) => ({ org_id: ORG, user_id: u, resource_type: "document", resource_id: "doc-2" }));
    await emit(libEv({ resource: { type: "document", id: "doc-2" }, namesDocuments: { ids: ["doc-1"] } }));
    expect(calls).toEqual([{ documentId: "doc-2", uids: ["f-sees", "f-hidden"] }]);
    expect(bell()).toEqual(["f-hidden", "f-sees"]);
  });

  it("resolveRecipients (the preview) counts the unnamed followers too — everyone still gets a row", async () => {
    __registerServerDiscoverCheck(check);
    expect((await resolveRecipients(libEv())).sort()).toEqual(["f-admin", "f-dc", "f-hidden", "f-sees"]);
  });

  it("unnamedNotice keeps the kind, resource and channels; takes the producer's wording and link; drops the metadata and the producer's email copy — and is marked redacted, so it is never pushed", () => {
    const out = unnamedNotice(libEv({ channels: ["inapp"], metadata: { transmittalId: "t1" }, email: { subject: "PID-4412", bodyHtml: "<b>PID-4412</b>" } }));
    expect(out).toMatchObject({
      kind: "library_doc_revised", title: "New revision in a library you follow", link: "/documents/lib-1",
      channels: ["inapp"], resource: { type: "library", id: "lib-1" }, metadata: { redacted: true }, audience: {},
    });
    expect(out.email).toEqual({ subject: "New revision in a library you follow", bodyText: "New revision in a library you follow\n\nDana published a new revision in a library you subscribe to." });
    expect(JSON.stringify({ ...out, namesDocuments: undefined })).not.toMatch(/PID-4412|doc-1|Rev C/);
    // the redacted (failed-check) notice of a library event takes the document-free link too; a document's is unchanged
    expect(redactedNotice(libEv()).link).toBe("/documents/lib-1");
    expect(redactedNotice(libEv({ resource: { type: "document", id: "doc-1" } })).link).toBe("/documents/lib-1?doc=doc-1");
  });

  it("the BROWSER asks POST /api/documents/discoverers about the named document; a push-worthy kind pushes only the followers told in full", async () => {
    vi.stubGlobal("window", {});
    (h.client.auth as Record<string, unknown>).getSession = async () => ({ data: { session: { access_token: "tok-1" } } });
    const pushes: string[][] = [];
    const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { documentId?: string; uids?: string[]; recipients?: string[] };
      if (url === "/api/push/notify") { pushes.push(body.recipients ?? []); return { ok: true, status: 204, json: async () => ({}) }; }
      expect(body.documentId).toBe("doc-1");
      return { ok: true, status: 200, json: async () => ({ discover: (body.uids ?? []).filter((u) => u !== "f-hidden") }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      // hold_opened is push-worthy (KIND_META); a library-scoped stand-in for the push leg
      await emit(libEv({ kind: "hold_opened", category: "status" }));
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchMock.mock.calls.filter((c) => c[0] === "/api/documents/discoverers")).toHaveLength(1);
      expect(rowFor("f-hidden")[0].metadata).toEqual({ redacted: true });
      expect(pushes.flat().sort()).toEqual(["f-admin", "f-dc", "f-sees"]);
    } finally {
      (h.client.auth as Record<string, unknown>).getSession = async () => ({ data: { session: null } });
    }
  });
});

describe("NEDGE-22 — the three producers name their document to the dispatcher", () => {
  it("lib/postPublish.ts notifySuperseded: library_doc_revised names the published document; a library follower who may not discover it reads the rev-up without the name or the document's link", async () => {
    __registerServerDiscoverCheck(check);
    const { notifySuperseded } = await import("@/lib/postPublish");
    await notifySuperseded({ orgId: ORG, documentId: "doc-1", libraryId: "lib-1", docLabel: "PID-4412", newRev: "C", actorUserId: "actor", actorName: "Dana" });
    const lib = rows().filter((x) => x.kind === "library_doc_revised");
    expect(lib.map((x) => x.user_id).sort()).toEqual(["f-admin", "f-dc", "f-hidden", "f-sees"]);
    expect(lib.find((x) => x.user_id === "f-sees")).toMatchObject({ title: "PID-4412 → Rev C", link: "/documents/lib-1?doc=doc-1" });
    expect(lib.find((x) => x.user_id === "f-hidden")).toMatchObject({
      title: "New revision in a library you follow", body: "Dana published a new revision in a library you subscribe to.", link: "/documents/lib-1",
    });
  });

  it("lib/libraryNotify.ts: one new document is named only to a follower who may discover it; a batch names none and asks nothing (REGRESSION)", async () => {
    __registerServerDiscoverCheck(check);
    const { notifyLibraryDocsAdded } = await import("@/lib/libraryNotify");
    await notifyLibraryDocsAdded({ orgId: ORG, libraryId: "lib-1", count: 1, firstLabel: "PID-4412", firstDocumentId: "doc-1", actorUserId: "actor", actorName: "Dana" });
    expect(rowFor("f-sees")[0]).toMatchObject({ title: "New document: PID-4412", body: "Dana added PID-4412 to a library you subscribe to." });
    expect(rowFor("f-hidden")[0]).toMatchObject({ title: "New document added", body: "Dana added a document to a library you subscribe to.", link: "/documents/lib-1" });
    expect(h.emails).toEqual([]); // in-app only, as before (PROD-7 dw3)
    h.state.tables.notifications = [];
    calls.length = 0;
    await notifyLibraryDocsAdded({ orgId: ORG, libraryId: "lib-1", count: 3, firstLabel: "PID-4412", firstDocumentId: "doc-1", actorUserId: "actor", actorName: "Dana" });
    expect(calls).toEqual([]);
    expect(rows().every((x) => x.title === "3 new documents added")).toBe(true);
    expect(bell()).toEqual(["f-admin", "f-dc", "f-hidden", "f-sees"]);
  });

  it("lib/transmittals.ts notifyTransmittalIssued: the library's followers who may not discover a listed document read the issue without the names; the owners and the discovering followers as before", async () => {
    __registerServerDiscoverCheck(check);
    h.state.tables.documents = [
      { id: "doc-2", org_id: ORG, library_id: "lib-1", collection_id: null, owner_user_id: "owner", owner_name: null },
      { id: "doc-1", org_id: ORG, library_id: "lib-1", collection_id: null, owner_user_id: null, owner_name: null },
    ];
    const { notifyTransmittalIssued } = await import("@/lib/transmittals");
    const t = {
      id: "t1", orgId: ORG, number: "TR-0007", purpose: "For Construction", recipientName: "Jane Doe", recipientCompany: "BuildCo",
      items: [{ documentId: "doc-2", number: "E-9", rev: "A" }, { documentId: "doc-1", number: "PID-4412", rev: "C" }],
    } as never;
    expect(await notifyTransmittalIssued(t, { orgId: ORG, actorUserId: "actor", actorName: "Dana" } as never)).toBe(1);
    expect(calls.map((c) => c.documentId)).toEqual(["doc-2", "doc-1"]);
    for (const u of ["owner", "f-sees", "f-admin", "f-dc"]) {
      expect(rowFor(u)[0], u).toMatchObject({ title: "Transmittal TR-0007 issued: 2 documents to Jane Doe, BuildCo", kind: "transmittal_issued" });
    }
    const [row] = rowFor("f-hidden");
    expect(row).toMatchObject({ title: "Transmittal TR-0007 issued to Jane Doe, BuildCo", link: "/transmittals", metadata: { redacted: true } });
    expect(String(row.body)).toBe("Dana issued transmittal TR-0007 (For Construction) to Jane Doe, BuildCo, with documents from a library you follow. A controlled copy is now outside the organization; its receipt is tracked on the transmittal register.");
    expect(JSON.stringify(row)).not.toMatch(/PID-4412|E-9/);
    expect(JSON.stringify(mailFor("f-hidden"))).not.toMatch(/PID-4412|E-9/);
  });

  it("lib/transmittals.ts: a transmittal across two libraries starts the second library's notice without waiting for the first's (its check is asked before the first answers); both land", async () => {
    const asked: string[] = [];
    let release!: () => void;
    const answersMay = new Promise<void>((r) => { release = r; });
    __registerServerDiscoverCheck(async ({ documentId, uids }) => { asked.push(documentId); await answersMay; return { ok: true, discover: [...uids] }; });
    h.state.tables.documents = [
      { id: "doc-1", org_id: ORG, library_id: "lib-1", collection_id: null, owner_user_id: null, owner_name: null },
      { id: "doc-9", org_id: ORG, library_id: "lib-2", collection_id: null, owner_user_id: null, owner_name: null },
    ];
    h.state.tables.subscriptions.push({ org_id: ORG, user_id: "f-sees", resource_type: "library", resource_id: "lib-2" });
    const { notifyTransmittalIssued } = await import("@/lib/transmittals");
    const t = {
      id: "t2", orgId: ORG, number: "TR-0008", purpose: null, recipientName: "Jane Doe", recipientCompany: null,
      items: [{ documentId: "doc-1", number: "PID-4412", rev: "C" }, { documentId: "doc-9", number: "E-77", rev: "A" }],
    } as never;
    const started = notifyTransmittalIssued(t, { orgId: ORG, actorUserId: "actor", actorName: "Dana" } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(asked.sort()).toEqual(["doc-1", "doc-9"]); // both libraries asked while neither has answered
    release();
    expect(await started).toBe(2);
    expect(rows().filter((x) => x.resource_id === "lib-2").map((x) => x.user_id)).toEqual(["f-sees"]);
  });

  it("firstNoticeTarget (the staged upload's choice): the first file's label, and its id only when THAT file landed — label and id always describe the same file", async () => {
    const { firstNoticeTarget } = await import("@/lib/libraryNotify");
    const staged = [{ docNumber: "P-101", original: "P-101" }, { docNumber: "P-102", original: "P-102" }];
    // the first file landed: its own id
    expect(firstNoticeTarget(staged, new Map([[0, "d-101"], [1, "d-102"]]))).toEqual({ label: "P-101", id: "d-101" });
    // the first file failed while another landed: no id (the notice names no document), never the other file's
    expect(firstNoticeTarget(staged, new Map([[1, "d-102"]]))).toEqual({ label: "P-101", id: null });
    // the label falls back to the original name, then "document"
    expect(firstNoticeTarget([{ docNumber: "", original: "scan.pdf" }], new Map([[0, "d-1"]]))).toEqual({ label: "scan.pdf", id: "d-1" });
    expect(firstNoticeTarget([], new Map([[0, "d-1"]]))).toEqual({ label: "document", id: null });
  });

  it("the library page's staged upload keys each landed id by the file's index and hands the notice firstNoticeTarget's pair (pinned against the source)", () => {
    const page = readFileSync(join(__dirname, "..", "..", "app", "(protected)", "documents", "[libraryId]", "page.tsx"), "utf8");
    const run = page.slice(page.indexOf("const landedIds = new Map<number, string>();"), page.indexOf("const notes: string[] = [];", page.indexOf("const landedIds = new Map<number, string>();")));
    expect(run).toContain("landedIds.set(i + j, r.value);");
    expect(run).toMatch(/const first = firstNoticeTarget\(resolved, landedIds\);\s*notifyLibrarySubscribers\(landed, first\.label, first\.id\);/);
    // uploadOne answers the new document's id — the value landedIds holds
    expect(page).toContain("return String(newDoc.id);");
  });
});

describe("NEDGE-6 remainder — a FAILED check's controllers lookup is bounded", () => {
  const failing: DiscoverCheck = async () => ({ ok: false, error: "the discover check answered 503" });
  const stallControllers = () => { h.stall = (t, cols) => t === "org_members" && cols === "uid, role, roles"; };

  it("reproduced on HEAD's shape: the fallback read the org's whole member table (resolveRoleRecipients, no deadline, no cap)", () => {
    // pinned against the source so the bound cannot be removed silently
    const src = readFileSync(join(__dirname, "..", "notify", "recipients.ts"), "utf8");
    const failureBranch = src.slice(src.indexOf("if (failure) {"), src.indexOf("return { uids: kept, outcome: \"failed\", error: failure };"));
    expect(failureBranch).toContain("await controllersAmong(orgId, want)");
    expect(failureBranch).not.toContain("resolveRoleRecipients");
    expect(CONTROLLERS_LOOKUP_TIMEOUT_MS).toBe(DISCOVER_TIMEOUT_MS);
    expect(CONTROLLERS_LOOKUP_MAX_ROWS).toBe(1000);
    // one read of the org's controllers: lib/roleHeld roleFilter (the one place that filter is spelled) and the cap
    const lookup = src.slice(src.indexOf("export async function controllersAmong"), src.indexOf("/** The BROWSER check"));
    expect(lookup).toContain(".or(roleFilter(CONTROLLER_ROLES))");
    expect(lookup).toContain(".limit(CONTROLLERS_LOOKUP_MAX_ROWS)");
    expect(lookup).not.toMatch(/for \(/); // no read after read under the one deadline
  });

  it("a stalled lookup answers after CONTROLLERS_LOOKUP_TIMEOUT_MS — never before, never later — with nobody confirmed, and the shortfall is logged", async () => {
    vi.useFakeTimers();
    stallControllers();
    __registerServerDiscoverCheck(failing);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let settled = false;
    const pending = discoveringAmong(ORG, "doc-1", ["f-sees", "f-admin", "f-dc"]).then((v) => { settled = true; return v; });
    await vi.advanceTimersByTimeAsync(CONTROLLERS_LOOKUP_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ uids: [], outcome: "failed", error: "the discover check answered 503" });
    expect(warn.mock.calls.some((c) => String(c[0]).includes(`the controllers lookup for document doc-1 did not answer within ${CONTROLLERS_LOOKUP_TIMEOUT_MS} ms`))).toBe(true);
  });

  it("through emit(): a stalled lookup never holds the inserts — every follower, the unconfirmed controllers included, gets exactly one redacted row and email (a library notice and a document's)", async () => {
    vi.useFakeTimers();
    stallControllers();
    __registerServerDiscoverCheck(failing);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sent = emit(libEv());
    await vi.advanceTimersByTimeAsync(CONTROLLERS_LOOKUP_TIMEOUT_MS);
    expect(await sent).toEqual({ recipients: 4, inapp: { sent: 4, failed: 0 } });
    expect(bell()).toEqual(["f-admin", "f-dc", "f-hidden", "f-sees"]);
    expect(rows().every((x) => (x.metadata as { redacted?: boolean }).redacted === true)).toBe(true);
    expect(h.emails).toHaveLength(4);
    // the document-scoped notice (N15's path) is bounded the same way
    h.state.tables.notifications = [];
    h.emails.length = 0;
    h.state.tables.subscriptions = ["f-sees", "f-admin"].map((u) => ({ org_id: ORG, user_id: u, resource_type: "document", resource_id: "doc-1" }));
    const doc = emit(libEv({ kind: "doc_superseded", title: "PID-4412 advanced to Rev C", resource: { type: "document", id: "doc-1" }, namesDocuments: undefined }));
    await vi.advanceTimersByTimeAsync(CONTROLLERS_LOOKUP_TIMEOUT_MS);
    expect((await doc).recipients).toBe(2);
    expect(rows().map((x) => x.title)).toEqual(["New activity on a document", "New activity on a document"]);
  });

  it("a stalled check AND a stalled controllers lookup are each bounded: the check fails at DISCOVER_TIMEOUT_MS, the lookup answers CONTROLLERS_LOOKUP_TIMEOUT_MS later (only those two requests stall here — the stand-in answers the rest), and the emit goes on to the redacted path", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
    (h.client.auth as Record<string, unknown>).getSession = vi.fn(() => new Promise(() => undefined));
    vi.stubGlobal("fetch", vi.fn());
    stallControllers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      let done = false;
      const sent = emit(libEv()).then((r) => { done = true; return r; });
      await vi.advanceTimersByTimeAsync(DISCOVER_TIMEOUT_MS);
      expect(done).toBe(false); // the check timed out; the lookup is still within its own bound
      await vi.advanceTimersByTimeAsync(CONTROLLERS_LOOKUP_TIMEOUT_MS);
      const r = await sent;
      expect(r.recipients).toBe(4);
      expect(rows().every((x) => (x.metadata as { redacted?: boolean }).redacted === true)).toBe(true);
    } finally {
      (h.client.auth as Record<string, unknown>).getSession = async () => ({ data: { session: null } });
    }
  });

  it("the browser scenario the integrator named, end to end: the session read stalls while the check runs and EVERY request then waits on it — the check fails at DISCOVER_TIMEOUT_MS, the lookup answers at its own bound with nobody confirmed (logged), and the emit STAYS PENDING on the membership read and the inserts behind the same session (NEDGE-6's residual) until the session answers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
    let answerSession!: () => void;
    const session = new Promise<void>((r) => { answerSession = r; });
    // from the check's session read on, every request through the client waits on the same read
    (h.client.auth as Record<string, unknown>).getSession = vi.fn(() => { h.gate = session; return session.then(() => ({ data: { session: null } })); });
    vi.stubGlobal("fetch", vi.fn());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const lookupGaveUp = () => warn.mock.calls.some((c) => String(c[0]).includes(`the controllers lookup for document doc-1 did not answer within ${CONTROLLERS_LOOKUP_TIMEOUT_MS} ms`));
    try {
      let done = false;
      const sent = emit(libEv()).then((r) => { done = true; return r; });
      await vi.advanceTimersByTimeAsync(DISCOVER_TIMEOUT_MS);
      expect(lookupGaveUp()).toBe(false);
      await vi.advanceTimersByTimeAsync(CONTROLLERS_LOOKUP_TIMEOUT_MS);
      expect(lookupGaveUp()).toBe(true); // the lookup's own bound held
      await vi.advanceTimersByTimeAsync(60_000);
      expect(done).toBe(false); // …but the emit is still waiting on the stalled session
      expect(rows()).toEqual([]);
      answerSession();
      const r = await sent;
      expect(r.recipients).toBe(4);
      expect(rows().every((x) => (x.metadata as { redacted?: boolean }).redacted === true)).toBe(true); // the unconfirmed controllers included
    } finally {
      h.gate = null;
      (h.client.auth as Record<string, unknown>).getSession = async () => ({ data: { session: null } });
    }
  });

  it("a read that comes back AT the row cap keeps the controllers it returned and is logged; a controller past the cap is left unconfirmed (the redacted notice), never dropped", async () => {
    // 1,002 controllers: PostgREST answers the first CONTROLLERS_LOOKUP_MAX_ROWS (f-admin, f-dc, c0 … c997)
    for (let i = 0; i < CONTROLLERS_LOOKUP_MAX_ROWS; i += 1) h.state.tables.org_members.push({ org_id: ORG, uid: `c${i}`, status: "active", role: "DocCtrl", roles: null, email: `c${i}@x.com` });
    expect(await controllersAmong(ORG, ["f-admin", "c5", "c999", "f-sees"])).toEqual({ controllers: new Set(["f-admin", "c5"]), timedOut: false, capped: true });
    __registerServerDiscoverCheck(failing);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await discoveringAmong(ORG, "doc-1", ["f-admin", "c5", "c999", "f-sees"])).toEqual({ uids: ["f-admin", "c5"], outcome: "failed", error: "the discover check answered 503" });
    expect(warn.mock.calls.some((c) => String(c[0]).includes(`the controllers lookup for document doc-1 came back at its row cap (${CONTROLLERS_LOOKUP_MAX_ROWS} rows) — 2 controller(s) confirmed; the other 2 recipient(s)`))).toBe(true);
  });

  it("one read: the org's active controllers (roleFilter — headline or additive), capped by .limit, never a per-uid list — so a controller among a 1,200-member org is found, and asking about 1,200 people is still one read", async () => {
    const many = Array.from({ length: 1200 }, (_, i) => `x${i}`);
    for (const u of many) h.state.tables.org_members.push({ org_id: ORG, uid: u, status: "active", role: "Engineer", roles: null, email: `${u}@x.com` });
    h.state.tables.org_members.push({ org_id: ORG, uid: "late-dc", status: "active", role: "Engineer", roles: ["Engineer", "DocCtrl"], email: "late@x.com" });
    h.state.calls.length = 0;
    const out = await controllersAmong(ORG, ["f-sees", "late-dc", "f-admin", "ghost"]);
    expect(out).toEqual({ controllers: new Set(["late-dc", "f-admin"]), timedOut: false });
    const memberCalls = h.state.calls.filter((c) => c.table === "org_members");
    expect(memberCalls.filter((c) => c.method === "select").map((c) => c.args[0])).toEqual(["uid, role, roles"]);
    expect(memberCalls.filter((c) => c.method === "or").map((c) => c.args[0])).toEqual([roleFilter(["Admin", "DocCtrl"])]);
    expect(memberCalls.filter((c) => c.method === "limit").map((c) => c.args[0])).toEqual([CONTROLLERS_LOOKUP_MAX_ROWS]);
    expect(memberCalls.filter((c) => c.method === "in")).toEqual([]);
    h.state.calls.length = 0;
    expect((await controllersAmong(ORG, [...many, "late-dc"])).controllers).toEqual(new Set(["late-dc"]));
    expect(h.state.calls.filter((c) => c.table === "org_members" && c.method === "select")).toHaveLength(1);
  });

  it("a lookup read that FAILS keeps what it confirmed (nobody here), is logged, and the emit goes on — the controllers then get the redacted notice, never none", async () => {
    __registerServerDiscoverCheck(failing);
    h.state.readError = { org_members: { message: "connection reset" } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await controllersAmong(ORG, ["f-admin"]);
    expect(out).toEqual({ controllers: new Set(), timedOut: false, error: "connection reset" });
    const filter = await discoveringAmong(ORG, "doc-1", ["f-admin", "f-sees"]);
    expect(filter).toMatchObject({ uids: [], outcome: "failed" });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("the controllers lookup for document doc-1 failed (connection reset)"))).toBe(true);
  });

  it("REGRESSION: a lookup that answers at once settles exactly the controllers it did before (headline Admin and an additive DocCtrl), and nobody else", async () => {
    __registerServerDiscoverCheck(failing);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await discoveringAmong(ORG, "doc-1", ["f-sees", "f-hidden", "f-admin", "f-dc", "actor"]))
      .toEqual({ uids: ["f-admin", "f-dc"], outcome: "failed", error: "the discover check answered 503" });
    // a suspended controller is not one
    h.state.tables.org_members.push({ org_id: ORG, uid: "gone-admin", status: "suspended", role: "Admin", roles: null, email: "g@x.com" });
    expect((await controllersAmong(ORG, ["gone-admin"])).controllers.size).toBe(0);
  });
});
