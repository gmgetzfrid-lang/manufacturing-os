// notifications Round G, N16 LIBRARY DISCOVER AND BOUNDED FALLBACK.
//
// NEDGE-22: a notice about a LIBRARY that names a document in it
// (library_doc_revised, library_doc_added, transmittal_issued) tells a
// follower reached only through the library's follow list the document's
// name only while they may discover it — the DEC-106 check, document by
// document (lib/notify/recipients.ts discoveringAmong, through
// EmitInput.namesDocuments). Nobody who follows the library stops hearing
// about it: a follower the check ANSWERED for who may not discover the
// document gets the notice without its name (unnamedNotice); one a FAILED
// check could not settle gets redactedNotice() (DEC-106 item 2); controllers
// are never dropped (DEC-43); someone the producer names is not filtered.
// REGRESSION: every library notice that reaches a follower today still
// reaches them, exactly as written for everyone who may discover what it
// names.
//
// NEDGE-6 remainder: on a FAILED check the controllers lookup
// (controllersAmong) is bounded — one deadline and a row cap; a stalled or
// failed lookup answers what it confirmed, the emit goes on (whoever it could
// not confirm gets the redacted notice) and the shortfall is logged.
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
  h.client = {
    ...base,
    from: (t: string) => {
      const b = base.from(t);
      return new Proxy(b, {
        get(target, prop: string) {
          if (prop !== "select") return target[prop];
          return (cols: string, o?: unknown) => (h.stall?.(t, cols) ? never() : (target.select as (c: string, o?: unknown) => unknown)(cols, o));
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

const ORG = "o-1";

function seed() {
  resetState(h.state);
  h.emails.length = 0;
  h.stall = null;
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

  it("several named documents (a transmittal): told the names only when every one may be discovered; asked one document at a time about the followers still owed them", async () => {
    __registerServerDiscoverCheck(check);
    await emit(libEv({
      kind: "transmittal_issued", title: "Transmittal TR-7 issued: 2 documents to BuildCo",
      body: "Dana issued transmittal TR-7 to BuildCo: E-9, PID-4412.", link: "/transmittals",
      namesDocuments: { ids: ["doc-2", "doc-1"], unnamed: { title: "Transmittal TR-7 issued to BuildCo", body: "Dana issued transmittal TR-7 to BuildCo, with documents from a library you follow." } },
    }));
    expect(calls.map((c) => c.documentId)).toEqual(["doc-2", "doc-1"]);
    for (const u of ["f-sees", "f-admin", "f-dc"]) expect(rowFor(u)[0].title, u).toBe("Transmittal TR-7 issued: 2 documents to BuildCo");
    expect(rowFor("f-hidden")[0]).toMatchObject({ title: "Transmittal TR-7 issued to BuildCo", link: "/transmittals" });
    expect(JSON.stringify(rowFor("f-hidden"))).not.toMatch(/PID-4412|E-9/);
  });

  it("a follower ruled out by the first document is not asked about the next; a failure stops the asking (only the controllers stay owed the names)", async () => {
    const seen: string[][] = [];
    let n = 0;
    __registerServerDiscoverCheck(async ({ uids }) => {
      seen.push([...uids]);
      n += 1;
      if (n === 1) return { ok: true, discover: uids.filter((u) => u !== "f-hidden") };
      return { ok: false, error: "timeout" };
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await emit(libEv({ namesDocuments: { ids: ["doc-a", "doc-b", "doc-c"] } }));
    expect(seen).toEqual([["f-sees", "f-hidden", "f-admin", "f-dc"], ["f-sees", "f-admin", "f-dc"]]);
    // f-hidden: answered → unnamed (generic, the producer worded none); f-sees: failed → redacted; controllers in full
    expect(rowFor("f-hidden")[0]).toMatchObject({ title: "New activity on a library", body: UNNAMED_BODY, metadata: { redacted: true } });
    expect(String(rowFor("f-sees")[0].body)).toMatch(/could not be confirmed/);
    for (const u of ["f-admin", "f-dc"]) expect(rowFor(u)[0].title, u).toBe("PID-4412 → Rev C");
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
    expect(CONTROLLERS_LOOKUP_MAX_ROWS).toBe(150);
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

  it("the browser scenario the integrator named: a stalled session read times the check out (DISCOVER_TIMEOUT_MS) and stalls the lookup too — the emit still finishes after both bounds, on the redacted path", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
    const stalledSession = vi.fn(() => new Promise(() => undefined));
    (h.client.auth as Record<string, unknown>).getSession = stalledSession;
    vi.stubGlobal("fetch", vi.fn());
    stallControllers(); // the shared client awaits the same session read before its own requests
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

  it("whoever was resolved keeps the notice in full: a lookup cut short after its first read keeps the controllers that read confirmed", async () => {
    vi.useFakeTimers();
    const many = Array.from({ length: CONTROLLERS_LOOKUP_MAX_ROWS + 10 }, (_, i) => `m${i}`);
    for (const u of many) h.state.tables.org_members.push({ org_id: ORG, uid: u, status: "active", role: u === "m3" || u === "m155" ? "DocCtrl" : "Engineer", roles: null, email: `${u}@x.com` });
    let reads = 0;
    h.stall = (t, cols) => t === "org_members" && cols === "uid, role, roles" && ++reads > 1;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pending = controllersAmong(ORG, many);
    await vi.advanceTimersByTimeAsync(CONTROLLERS_LOOKUP_TIMEOUT_MS);
    const out = await pending;
    expect(out.timedOut).toBe(true);
    expect([...out.controllers]).toEqual(["m3"]); // m155 was in the read that stalled
  });

  it("the row cap: the lookup asks only about the people in question, at most CONTROLLERS_LOOKUP_MAX_ROWS per read, so a controller past PostgREST's row limit of a large org is still found", async () => {
    const many = Array.from({ length: 1200 }, (_, i) => `x${i}`);
    for (const u of many) h.state.tables.org_members.push({ org_id: ORG, uid: u, status: "active", role: "Engineer", roles: null, email: `${u}@x.com` });
    h.state.tables.org_members.push({ org_id: ORG, uid: "late-dc", status: "active", role: "Engineer", roles: ["Engineer", "DocCtrl"], email: "late@x.com" });
    h.state.calls.length = 0;
    const out = await controllersAmong(ORG, ["f-sees", "late-dc", "f-admin", "ghost"]);
    expect(out).toEqual({ controllers: new Set(["late-dc", "f-admin"]), timedOut: false });
    const memberCalls = h.state.calls.filter((c) => c.table === "org_members");
    const inArgs = memberCalls.filter((c) => c.method === "in").map((c) => c.args[1] as string[]);
    expect(inArgs).toEqual([["f-sees", "late-dc", "f-admin", "ghost"]]);
    expect(memberCalls.filter((c) => c.method === "limit").map((c) => c.args[0])).toEqual([CONTROLLERS_LOOKUP_MAX_ROWS]);
    // more people than one read carries: several reads, none over the cap
    h.state.calls.length = 0;
    await controllersAmong(ORG, many);
    const sizes = h.state.calls.filter((c) => c.table === "org_members" && c.method === "in").map((c) => (c.args[1] as string[]).length);
    expect(sizes.every((n) => n <= CONTROLLERS_LOOKUP_MAX_ROWS)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(1200);
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
