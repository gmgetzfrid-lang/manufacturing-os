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
// NEDGE-22 done-when 2 (the integrator's ruling under DEC-90, 2026-10-14):
// someone the producer names (a transmittal's document owner) is spared the
// check only for the document(s) they are involved with; every other named
// document is checked for them, with the same three outcomes. A notice naming
// one document to the person involved with it is unchanged.
//
// Also pinned: the named documents of one notice checked side by side, at
// most NAMED_DOCUMENT_CHECKS_AT_ONCE at a time, with the outcomes asking one
// at a time gives; notifySuperseded's library notice not held behind the
// document notice's check; the staged upload's notice target (lib/libraryNotify
// firstNoticeTarget, and the page's own chunk loop, run); and a transmittal's
// per-library notices started side by side (lib/transmittals
// notifyTransmittalIssued).
//
// Driven through the REAL dispatcher, recipients and inAppNotifications over
// the in-memory PostgREST stand-in (helpers/memoryDb), as
// recipientDiscovery.test.ts is.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
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

import { emit, resolveRecipients, unnamedNotice, redactedNotice, UNNAMED_BODY, NAMED_DOCUMENT_CHECKS_AT_ONCE, type EmitInput } from "@/lib/notify/dispatch";
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

  it("someone the producer NAMES on a notice naming ONE document (involved with the one thing it names) is not filtered and not asked about — unchanged by done-when 2", async () => {
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

  it("the named documents are asked about AT ONCE (three, within the bound of five) — every check starts before any answers — and the three outcomes hold: ruled out by an answered check → unnamed (even beside a failed one); left out only by a failed check → redacted; kept by every answer → in full", async () => {
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

  it("lib/transmittals.ts notifyTransmittalIssued: the library's followers who may not discover a listed document read the issue without the names; the discovering followers, and an owner who may discover every listed document, as before", async () => {
    // the owner of doc-2 may discover doc-1 too (the reviewer's case, where they may not, is pinned under "done-when 2" below)
    __registerServerDiscoverCheck(async (a) => (a.documentId === "doc-1" && a.uids.includes("owner")
      ? (calls.push({ documentId: a.documentId, uids: [...a.uids] }), { ok: true, discover: a.uids.filter((u) => ["f-sees", "f-admin", "f-dc", "owner"].includes(u)) })
      : check(a)));
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
    // the owner is asked about the OTHER listed document only (done-when 2), in the followers' request
    expect(calls).toEqual([
      { documentId: "doc-2", uids: ["f-sees", "f-hidden", "f-admin", "f-dc"] },
      { documentId: "doc-1", uids: ["f-sees", "f-hidden", "f-admin", "f-dc", "owner"] },
    ]);
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

/** Let the started work run up to its next wait (real timers). */
const settle = async (n = 5) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

describe("NEDGE-22 done-when 2 (the integrator's ruling under DEC-90, 2026-10-14) — someone the producer names is spared the check only for the document(s) they are involved with", () => {
  // The reviewer's case: a two-document transmittal from lib-1 — doc-2 (E-9) owned by "owner", doc-1
  // (PID-4412) hidden: only f-sees and the controllers may discover it (`check`).
  const actor = { orgId: ORG, actorUserId: "actor", actorName: "Dana" } as never;
  const twoDocs = () => {
    h.state.tables.documents = [
      { id: "doc-2", org_id: ORG, library_id: "lib-1", collection_id: null, owner_user_id: "owner", owner_name: null },
      { id: "doc-1", org_id: ORG, library_id: "lib-1", collection_id: null, owner_user_id: null, owner_name: null },
    ];
    return {
      id: "t1", orgId: ORG, number: "TR-0007", purpose: "For Construction", recipientName: "Jane Doe", recipientCompany: "BuildCo",
      items: [{ documentId: "doc-2", number: "E-9", rev: "A" }, { documentId: "doc-1", number: "PID-4412", rev: "C" }],
    } as never;
  };
  const FULL = "Transmittal TR-0007 issued: 2 documents to Jane Doe, BuildCo";
  const UNNAMED = "Transmittal TR-0007 issued to Jane Doe, BuildCo";

  it("reproduced (HEAD told every involved person in full): the owner of ONE document, who also follows the library, read the other document's name — now asked about that document only, and told without the names (one row, one email); everyone else exactly as before", async () => {
    __registerServerDiscoverCheck(check);
    h.state.tables.subscriptions.push({ org_id: ORG, user_id: "owner", resource_type: "library", resource_id: "lib-1" });
    const t = twoDocs();
    const { notifyTransmittalIssued } = await import("@/lib/transmittals");
    expect(await notifyTransmittalIssued(t, actor)).toBe(1);
    // never asked about their own document; asked about the other one in the followers' request
    expect(calls).toEqual([
      { documentId: "doc-2", uids: ["f-sees", "f-hidden", "f-admin", "f-dc"] },
      { documentId: "doc-1", uids: ["f-sees", "f-hidden", "f-admin", "f-dc", "owner"] },
    ]);
    expect(rowFor("owner")).toHaveLength(1);
    expect(rowFor("owner")[0]).toMatchObject({ title: UNNAMED, link: "/transmittals", kind: "transmittal_issued", resource_id: "lib-1", metadata: { redacted: true } });
    expect(JSON.stringify(rowFor("owner"))).not.toMatch(/PID-4412|E-9/);
    expect(mailFor("owner")).toHaveLength(1);
    expect(JSON.stringify(mailFor("owner"))).not.toMatch(/PID-4412|E-9/);
    for (const u of ["f-sees", "f-admin", "f-dc"]) expect(rowFor(u)[0], u).toMatchObject({ title: FULL });
    expect(rowFor("f-hidden")[0]).toMatchObject({ title: UNNAMED });
    expect(rows()).toHaveLength(5); // nobody dropped, nobody told twice
  });

  it("an owner who does not follow the library is held to the same rule: their own document unchecked, the other checked — told without the names", async () => {
    __registerServerDiscoverCheck(check);
    const { notifyTransmittalIssued } = await import("@/lib/transmittals");
    await notifyTransmittalIssued(twoDocs(), actor);
    expect(calls.find((c) => c.documentId === "doc-2")?.uids).not.toContain("owner");
    expect(calls.find((c) => c.documentId === "doc-1")?.uids).toContain("owner");
    expect(rowFor("owner")).toHaveLength(1);
    expect(rowFor("owner")[0]).toMatchObject({ title: UNNAMED, metadata: { redacted: true } });
  });

  it("a check of the other document that FAILS sends the owner the redacted notice (fail safe): never the names, never dropped", async () => {
    __registerServerDiscoverCheck(async ({ documentId, uids }) => (documentId === "doc-1" ? { ok: false, error: "the discover check answered 503" } : { ok: true, discover: [...uids] }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { notifyTransmittalIssued } = await import("@/lib/transmittals");
    await notifyTransmittalIssued(twoDocs(), actor);
    const [row] = rowFor("owner");
    expect(rowFor("owner")).toHaveLength(1);
    expect(row).toMatchObject({ link: "/transmittals", metadata: { redacted: true } });
    expect(String(row.body)).toMatch(/could not be confirmed/);
    expect(JSON.stringify(row)).not.toMatch(/PID-4412|E-9/);
    // the controllers are confirmed by the lookup and told in full, as before
    for (const u of ["f-admin", "f-dc"]) expect(rowFor(u)[0].title, u).toBe(FULL);
  });

  it("REGRESSION: a one-document transmittal to its owner asks nothing about the owner and tells them in full — exactly as before", async () => {
    __registerServerDiscoverCheck(check);
    h.state.tables.subscriptions.push({ org_id: ORG, user_id: "owner", resource_type: "library", resource_id: "lib-1" });
    h.state.tables.documents = [{ id: "doc-2", org_id: ORG, library_id: "lib-1", collection_id: null, owner_user_id: "owner", owner_name: null }];
    const { notifyTransmittalIssued } = await import("@/lib/transmittals");
    const t = { id: "t3", orgId: ORG, number: "TR-0009", purpose: null, recipientName: "Jane Doe", recipientCompany: null, items: [{ documentId: "doc-2", number: "E-9", rev: "A" }] } as never;
    expect(await notifyTransmittalIssued(t, actor)).toBe(1);
    expect(calls).toEqual([{ documentId: "doc-2", uids: ["f-sees", "f-hidden", "f-admin", "f-dc"] }]);
    expect(rowFor("owner")).toHaveLength(1);
    expect(rowFor("owner")[0]).toMatchObject({ title: "Transmittal TR-0009 issued: E-9 Rev A to Jane Doe", link: "/transmittals" });
    expect(rowFor("owner")[0].metadata).toEqual({ transmittalId: "t3" });
    expect(mailFor("owner")).toHaveLength(1);
  });

  it("through emit(): without an involvement map a notice naming ONE document spares every involved person (unchanged), one naming several checks them for every named document (fail safe); with a map only the mapped document is spared; the actor is never asked", async () => {
    __registerServerDiscoverCheck(check);
    // several documents, no map: the owner is asked about both and ruled out by doc-1 → without the names
    await emit(libEv({ audience: { involved: ["owner", "actor"], followers: true }, namesDocuments: { ids: ["doc-2", "doc-1"] } }));
    expect(calls).toEqual([
      { documentId: "doc-2", uids: ["f-sees", "f-hidden", "f-admin", "f-dc", "owner"] },
      { documentId: "doc-1", uids: ["f-sees", "f-hidden", "f-admin", "f-dc", "owner"] },
    ]);
    expect(rowFor("owner")[0]).toMatchObject({ title: "New activity on a library", metadata: { redacted: true } });
    expect(rowFor("actor")).toEqual([]);
    // the same with the owner mapped to doc-1: asked about doc-2 only (open to everyone) → in full
    h.state.tables.notifications = [];
    calls.length = 0;
    await emit(libEv({ audience: { involved: ["owner"], followers: true }, namesDocuments: { ids: ["doc-2", "doc-1"], involved: { "doc-1": ["owner"] } } }));
    expect(calls.map((c) => [c.documentId, c.uids.includes("owner")])).toEqual([["doc-2", true], ["doc-1", false]]);
    expect(rowFor("owner")[0]).toMatchObject({ title: "PID-4412 → Rev C" });
    // one document, no map: not asked, in full (the case pinned above under "someone the producer NAMES")
    h.state.tables.notifications = [];
    calls.length = 0;
    await emit(libEv({ audience: { involved: ["owner"], followers: true } }));
    expect(calls).toEqual([{ documentId: "doc-1", uids: ["f-sees", "f-hidden", "f-admin", "f-dc"] }]);
    expect(rowFor("owner")[0]).toMatchObject({ title: "PID-4412 → Rev C" });
  });

  it("the map spares only people the producer named in `involved` — a follower listed in it is still checked", async () => {
    __registerServerDiscoverCheck(check);
    await emit(libEv({ namesDocuments: { ids: ["doc-1"], involved: { "doc-1": ["f-hidden"] } } }));
    expect(calls).toEqual([{ documentId: "doc-1", uids: ["f-sees", "f-hidden", "f-admin", "f-dc"] }]);
    expect(rowFor("f-hidden")[0]).toMatchObject({ title: "New activity on a library", body: UNNAMED_BODY, metadata: { redacted: true } });
  });
});

describe("NEDGE-22 — one notice's named documents are checked side by side, at most five at a time", () => {
  it(`at most NAMED_DOCUMENT_CHECKS_AT_ONCE (${NAMED_DOCUMENT_CHECKS_AT_ONCE}) checks in flight: seven named documents — the first five start before any answers, the sixth only when one has answered — and the outcomes are the ones asking one at a time gives`, async () => {
    expect(NAMED_DOCUMENT_CHECKS_AT_ONCE).toBe(5);
    const ids = ["d1", "d2", "d3", "d4", "d5", "d6", "d7"];
    const started: string[] = [];
    const release = new Map<string, () => void>();
    let inFlight = 0;
    let peak = 0;
    const answer = (documentId: string, uids: string[]) => {
      if (documentId === "d6") return { ok: true as const, discover: uids.filter((u) => u !== "f-hidden") };
      if (documentId === "d7") return { ok: false as const, error: "timeout" };
      return { ok: true as const, discover: [...uids] };
    };
    __registerServerDiscoverCheck(async ({ documentId, uids }) => {
      started.push(documentId);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => release.set(documentId, r));
      inFlight -= 1;
      return answer(documentId, uids);
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sent = emit(libEv({ namesDocuments: { ids } }));
    await settle();
    expect(started).toEqual(["d1", "d2", "d3", "d4", "d5"]);
    release.get("d3")!();
    await settle();
    expect(started).toEqual(["d1", "d2", "d3", "d4", "d5", "d6"]);
    for (const d of ["d1", "d2", "d4", "d5", "d6"]) release.get(d)!();
    await settle();
    expect(started).toEqual(ids);
    release.get("d7")!();
    const r = await sent;
    expect(peak).toBe(5);
    expect(r.recipients).toBe(4);
    // the reference: the same answers, asked one at a time
    const seq: Record<string, string> = {};
    for (const u of ["f-sees", "f-hidden", "f-admin", "f-dc"]) {
      const per = ids.map((d) => answer(d, [u]));
      const keptByAll = per.every((a) => a.ok && a.discover.includes(u));
      const ruledOut = per.some((a) => a.ok && !a.discover.includes(u));
      seq[u] = keptByAll ? "full" : ruledOut ? "unnamed" : "redacted";
    }
    // the controllers are confirmed by d7's failed check's lookup — told in full
    seq["f-admin"] = "full";
    seq["f-dc"] = "full";
    const got = (u: string) => {
      const [row] = rowFor(u);
      if (!(row.metadata as { redacted?: boolean } | null)?.redacted) return "full";
      return String(row.body).includes("could not be confirmed") ? "redacted" : "unnamed";
    };
    for (const u of ["f-sees", "f-hidden", "f-admin", "f-dc"]) expect(got(u), u).toBe(seq[u]);
    expect(seq).toEqual({ "f-sees": "redacted", "f-hidden": "unnamed", "f-admin": "full", "f-dc": "full" });
    expect(rows()).toHaveLength(4);
  });
});

describe("NEDGE-22 — lib/postPublish.ts notifySuperseded does not hold the library notice behind the document notice", () => {
  it("the library notice's check is asked, and its rows land, while the document notice's check is still unanswered; both notices are exactly as before", async () => {
    // the document's own followers (N15's check drops f-hidden from the document notice, as before)
    h.state.tables.subscriptions.push(...["f-sees", "f-hidden"].map((u) => ({ org_id: ORG, user_id: u, resource_type: "document", resource_id: "doc-1" })));
    let answerDocument!: () => void;
    const documentAnswers = new Promise<void>((r) => { answerDocument = r; });
    const asked: string[] = [];
    __registerServerDiscoverCheck(async (a) => {
      const which = a.uids.length === 2 ? "document notice" : "library notice";
      asked.push(which);
      if (which === "document notice") await documentAnswers;
      return check(a);
    });
    const { notifySuperseded } = await import("@/lib/postPublish");
    const sent = notifySuperseded({ orgId: ORG, documentId: "doc-1", libraryId: "lib-1", docLabel: "PID-4412", newRev: "C", actorUserId: "actor", actorName: "Dana" });
    await settle(10);
    expect(asked).toEqual(["document notice", "library notice"]); // started in the same order as before
    const lib = () => rows().filter((x) => x.kind === "library_doc_revised");
    expect(lib().map((x) => x.user_id).sort()).toEqual(["f-admin", "f-dc", "f-hidden", "f-sees"]); // landed already
    expect(rows().filter((x) => x.kind === "doc_superseded")).toEqual([]); // still waiting on its check
    answerDocument();
    await sent;
    const doc = rows().filter((x) => x.kind === "doc_superseded");
    expect(doc.map((x) => x.user_id)).toEqual(["f-sees"]);
    expect(doc[0]).toMatchObject({ title: "PID-4412 advanced to Rev C", link: "/documents/lib-1?doc=doc-1", resource_type: "document", resource_id: "doc-1" });
    for (const u of ["f-sees", "f-admin", "f-dc"]) expect(lib().find((x) => x.user_id === u), u).toMatchObject({ title: "PID-4412 → Rev C", link: "/documents/lib-1?doc=doc-1" });
    expect(lib().find((x) => x.user_id === "f-hidden")).toMatchObject({ title: "New revision in a library you follow", link: "/documents/lib-1" });
    expect(rows()).toHaveLength(5);
  });

  it("pinned against the source: both emits are started before either is awaited, the document notice first, and awaited together", () => {
    const src = readFileSync(join(__dirname, "..", "postPublish.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function notifySuperseded"), src.indexOf("export interface PostPublishInput"));
    expect(fn).toMatch(/const docNotice = emit\(\{[\s\S]*kind: "doc_superseded"[\s\S]*const libraryNotice = emit\(\{[\s\S]*kind: "library_doc_revised"/);
    expect(fn).toContain("await Promise.allSettled([docNotice, libraryNotice])");
    expect(fn).not.toMatch(/await emit\(/);
  });
});

describe("NEDGE-22 — which document id the library page's staged upload hands the notice (the page's own loop, run)", () => {
  // The page's chunk loop and notice call, lifted from the source and run (as isP1LibraryPage.test.ts
  // runs page handlers): from `const failures` to the notice, with uploadOne and the notice stubbed.
  const PAGE = readFileSync(join(__dirname, "..", "..", "app", "(protected)", "documents", "[libraryId]", "page.tsx"), "utf8");
  const lifted = (() => {
    const from = PAGE.indexOf("const failures: Array<{ name: string; reason: string }> = [];", PAGE.indexOf("const handleStagedUpload = async"));
    const to = PAGE.indexOf("const notes: string[] = [];", from);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const js = ts.transpileModule(
      `async function run({ resolved, signal, setUploadProgress, uploadOne, firstNoticeTarget, notifyLibrarySubscribers, UPLOAD_CONCURRENCY }) {${PAGE.slice(from, to)}\nreturn { failures, landedIds, landed };\n}`,
      { compilerOptions: { target: ts.ScriptTarget.ES2020 } },
    ).outputText;
    return new Function(`${js}\nreturn run;`)() as (d: Record<string, unknown>) => Promise<{ failures: unknown[]; landedIds: Map<number, string>; landed: number }>;
  })();
  const concurrency = Number(/const UPLOAD_CONCURRENCY = (\d+);/.exec(PAGE)?.[1]);
  const staged = (n: number) => Array.from({ length: n }, (_, i) => ({ docNumber: `P-${101 + i}`, original: `P-${101 + i}.pdf`, item: { file: { name: `P-${101 + i}.pdf` } } }));
  async function upload(n: number, fails: number[], delays: number[] = []) {
    const { firstNoticeTarget } = await import("@/lib/libraryNotify");
    const notices: Array<[number, string, string | null]> = [];
    const out = await lifted({
      resolved: staged(n), signal: undefined, setUploadProgress: () => undefined, UPLOAD_CONCURRENCY: concurrency, firstNoticeTarget,
      notifyLibrarySubscribers: (count: number, label: string, id: string | null) => { notices.push([count, label, id]); },
      // each file's document id is d-<number>; later files answer FIRST, so a map filled in finishing order would differ
      uploadOne: async (e: { docNumber: string }) => {
        const i = Number(e.docNumber.slice(2)) - 101;
        await new Promise((r) => setTimeout(r, delays[i] ?? (n - i)));
        if (fails.includes(i)) throw new Error(`refused ${e.docNumber}`);
        return `d-${e.docNumber}`;
      },
    });
    return { ...out, notices };
  }

  it("the first file landed: the notice gets ITS id (d-P-101) and label, across chunks and out-of-order finishes", async () => {
    expect(concurrency).toBe(4);
    const r = await upload(6, []);
    expect(r.notices).toEqual([[6, "P-101", "d-P-101"]]);
    expect([...r.landedIds.entries()]).toEqual([[0, "d-P-101"], [1, "d-P-102"], [2, "d-P-103"], [3, "d-P-104"], [4, "d-P-105"], [5, "d-P-106"]]);
  });

  it("one file staged and landed: the notice names it with its own id — so the dispatcher checks THAT document, and a follower who may not discover it reads the notice without the name", async () => {
    const r = await upload(1, []);
    expect(r.notices).toEqual([[1, "P-101", "d-P-101"]]);
    __registerServerDiscoverCheck(async ({ documentId, uids }) => { calls.push({ documentId, uids: [...uids] }); return { ok: true, discover: uids.filter((u) => u !== "f-hidden") }; });
    const { notifyLibraryDocsAdded } = await import("@/lib/libraryNotify");
    const [count, label, id] = r.notices[0];
    await notifyLibraryDocsAdded({ orgId: ORG, libraryId: "lib-1", count, firstLabel: label, firstDocumentId: id, actorUserId: "actor", actorName: "Dana" });
    expect(calls.map((c) => c.documentId)).toEqual(["d-P-101"]);
    expect(rowFor("f-sees")[0]).toMatchObject({ title: "New document: P-101" });
    expect(rowFor("f-hidden")[0]).toMatchObject({ title: "New document added" });
  });

  it("the first file failed and the second landed: no id (the notice names no document), never the second file's", async () => {
    const r = await upload(2, [0]);
    expect(r.notices).toEqual([[1, "P-101", null]]);
    expect(r.failures).toHaveLength(1);
  });

  it("a file in the second chunk is keyed by its own index (i + j), not its chunk position", async () => {
    const r = await upload(6, [1, 4]);
    expect([...r.landedIds.keys()]).toEqual([0, 2, 3, 5]);
    expect(r.landedIds.get(5)).toBe("d-P-106");
    expect(r.notices).toEqual([[4, "P-101", "d-P-101"]]);
  });

  it("nothing landed: no notice", async () => {
    const r = await upload(2, [0, 1]);
    expect(r.notices).toEqual([]);
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

  it("NEDGE-6's residual as the browser can produce it — the access token's refresh hangs after the follow list was read: the shared client's session read, which the check and every later request await, stalls; the check fails at DISCOVER_TIMEOUT_MS without sending, the controllers lookup gives up at its own bound (logged), and the bell rows wait on that session read; when the refresh completes every follower, the unconfirmed controllers included, gets exactly one redacted row and one email", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
    // supabase-js: every request awaits auth.getSession() (fetchWithAuth), and every caller of
    // getSession() waits on the one refresh in flight. The follow list was read with a valid token;
    // the token then passes its expiry margin and the refresh request hangs (it has no timeout of its
    // own) — modelled as: from the check's session read on, every request waits on the refresh (h.gate).
    let completeRefresh!: () => void;
    const refresh = new Promise<void>((r) => { completeRefresh = r; });
    (h.client.auth as Record<string, unknown>).getSession = vi.fn(() => {
      h.gate = refresh;
      return refresh.then(() => ({ data: { session: { access_token: "tok-refreshed" } } }));
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
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
      expect(done).toBe(false); // …but the membership read and the inserts wait on the hung refresh
      expect(rows()).toEqual([]);
      completeRefresh(); // the refresh comes back with a new token: the queued requests go out with it
      const r = await sent;
      expect(r.recipients).toBe(4);
      expect(bell()).toEqual(["f-admin", "f-dc", "f-hidden", "f-sees"]);
      expect(rows().every((x) => (x.metadata as { redacted?: boolean }).redacted === true)).toBe(true); // the unconfirmed controllers included
      expect(h.emails).toHaveLength(4);
      // the timed-out check never sent its request (it gave up before it had a token)
      expect(fetchMock).not.toHaveBeenCalled();
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
