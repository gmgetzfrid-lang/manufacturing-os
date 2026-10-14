// notifications Round G, N15 RECIPIENT VISIBILITY AND NAMES.
//
// NEDGE-6 done-when 3 (the wiring): emit() drops a document's FOLLOWER who
// may not discover it (lib/notify/recipients.ts discoveringAmong — the
// server check lib/documentDiscoverers.ts registers, the route from the
// browser); controllers are never dropped (DEC-43); someone the producer
// names, a role pool and a project roster are not filtered. REGRESSION:
// every recipient with access still gets exactly one row — when the check
// FAILS too (fix pass 2): a follower it could not settle gets one row and
// one email WITHOUT the document's name or the reason (redactedNotice).
//
// PROD-4 done-whens 1 and 4 (as DEC-100 item 2 narrows them): a
// subscriptions row on a document puts that user in resolveRecipients for
// every NON-PERSONAL document-scoped kind — the emits that pass
// `followers: true` on a document resource, censused from the source.
//
// ROUTE-3 (a): resolveFollowers' ticket branch stays (the intake door's
// redline notice walks it) and its header says the two ticket routes fold
// tickets.watchers themselves.
//
// Driven through the REAL dispatcher, recipients and inAppNotifications over
// the in-memory PostgREST stand-in (helpers/memoryDb).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resetState, type MemoryState } from "./helpers/memoryDb";

const h = vi.hoisted(() => ({
  state: null as unknown as MemoryState,
  emails: [] as Array<Record<string, unknown>>,
  client: null as unknown as Record<string, unknown>,
}));

vi.mock("@/lib/supabase", async () => {
  const mem = await import("./helpers/memoryDb");
  h.state = mem.freshState();
  h.client = mem.makeSupabase(h.state) as unknown as Record<string, unknown>;
  return { supabase: h.client };
});
vi.mock("@/lib/notifications", () => ({
  queueEmail: vi.fn(async (input: Record<string, unknown>) => { h.emails.push(input); }),
}));

import { emit, resolveRecipients, type EmitInput } from "@/lib/notify/dispatch";
import { __registerServerDiscoverCheck, discoveringAmong, type DiscoverCheck } from "@/lib/notify/recipients";

const ORG = "o-1";
const ROOT = join(__dirname, "..", "..");

function seed() {
  resetState(h.state);
  h.emails.length = 0;
  h.state.tables.org_members = [
    { org_id: ORG, uid: "actor", status: "active", role: "Engineer", roles: null, email: "actor@x.com" },
    { org_id: ORG, uid: "w-sees", status: "active", role: "Engineer", roles: null, email: "w-sees@x.com" },
    { org_id: ORG, uid: "w-hidden", status: "active", role: "Engineer", roles: null, email: "w-hidden@x.com" },
    { org_id: ORG, uid: "w-admin", status: "active", role: "Admin", roles: null, email: "w-admin@x.com" },
    { org_id: ORG, uid: "w-dc", status: "active", role: "Manager", roles: ["Manager", "DocCtrl"], email: "w-dc@x.com" },
    { org_id: ORG, uid: "named", status: "active", role: "Engineer", roles: null, email: "named@x.com" },
  ];
  h.state.tables.subscriptions = ["w-sees", "w-hidden", "w-admin", "w-dc", "named"].map((u) => ({
    org_id: ORG, user_id: u, resource_type: "document", resource_id: "doc-1",
  }));
  h.state.tables.notifications = [];
}

/** The server check: who may discover doc-1 (a hidden document granted to
 *  w-sees; the controllers by DEC-43). */
const calls: Array<{ documentId: string; uids: string[] }> = [];
const hiddenDoc: DiscoverCheck = async ({ documentId, uids }) => {
  calls.push({ documentId, uids: [...uids] });
  return { ok: true, discover: uids.filter((u) => ["w-sees", "w-admin", "w-dc"].includes(u)) };
};
const openDoc: DiscoverCheck = async ({ uids }) => ({ ok: true, discover: [...uids] });

function ev(over: Partial<EmitInput> = {}): EmitInput {
  return {
    orgId: ORG, category: "watched", kind: "doc_superseded",
    title: "PID-4412 advanced to Rev C", body: "Dana published Rev C.",
    link: "/documents/lib-1?doc=doc-1", resource: { type: "document", id: "doc-1" },
    actorUserId: "actor", actorName: "Dana",
    audience: { followers: true },
    ...over,
  };
}
const bell = () => (h.state.tables.notifications ?? []).map((r) => r.user_id as string).sort();

beforeEach(() => { seed(); calls.length = 0; __registerServerDiscoverCheck(null); });
afterEach(() => { __registerServerDiscoverCheck(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("NEDGE-6 done-when 3 — a document's follower who may not discover it is dropped", () => {
  it("reproduced on HEAD's behaviour (no check): every follower is notified, the one who cannot see the hidden document included", async () => {
    await emit(ev());
    expect(bell()).toEqual(["named", "w-admin", "w-dc", "w-hidden", "w-sees"]);
  });

  it("with the server check: w-hidden is dropped; the granted follower and both controllers (headline and additive) keep their row", async () => {
    __registerServerDiscoverCheck(hiddenDoc);
    const r = await emit(ev());
    expect(bell()).toEqual(["w-admin", "w-dc", "w-sees"]);
    expect(r.recipients).toBe(3);
    expect(h.emails.map((e) => e.toUserId).sort()).toEqual(["w-admin", "w-dc", "w-sees"]);
    expect(calls).toEqual([{ documentId: "doc-1", uids: ["w-sees", "w-hidden", "w-admin", "w-dc", "named"] }]);
  });

  it("someone the producer NAMES is not filtered (the producer's choice), and is not asked about", async () => {
    __registerServerDiscoverCheck(hiddenDoc);
    await emit(ev({ audience: { involved: ["named", "w-hidden"], followers: true } }));
    expect(bell()).toEqual(["named", "w-admin", "w-dc", "w-hidden", "w-sees"]);
    expect(calls[0].uids).toEqual(["w-sees", "w-admin", "w-dc"]);
  });

  it("REGRESSION: a document everyone may discover — every follower still gets exactly one row and one email", async () => {
    __registerServerDiscoverCheck(openDoc);
    await emit(ev());
    expect(bell()).toEqual(["named", "w-admin", "w-dc", "w-hidden", "w-sees"]);
    expect(new Set(bell()).size).toBe(bell().length);
    expect(h.emails).toHaveLength(5);
  });

  const rowsOf = () => (h.state.tables.notifications ?? []) as Array<Record<string, unknown>>;
  const rowFor = (u: string) => rowsOf().filter((r) => r.user_id === u);
  const mailFor = (u: string) => h.emails.filter((e) => e.toUserId === u);

  it("a check that FAILS: the controllers get the notice as written; every other follower gets exactly one REDACTED row and email (fix pass 2 — nothing leaks, nothing is lost), logged", async () => {
    __registerServerDiscoverCheck(async () => ({ ok: false, error: "The document could not be read." }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await emit(ev());
    expect(bell()).toEqual(["named", "w-admin", "w-dc", "w-hidden", "w-sees"]);
    expect(new Set(bell()).size).toBe(bell().length);
    expect(r.recipients).toBe(5);
    expect(r.inapp).toEqual({ sent: 5, failed: 0 });
    for (const u of ["w-admin", "w-dc"]) expect(rowFor(u)[0].title, u).toBe("PID-4412 advanced to Rev C");
    for (const u of ["named", "w-hidden", "w-sees"]) {
      const [row] = rowFor(u);
      expect(row.title, u).toBe("New activity on a document");
      expect(String(row.body), u).not.toMatch(/PID-4412|Rev C|Dana published/);
      expect(row.metadata, u).toEqual({ redacted: true });
      expect(row.kind, u).toBe("doc_superseded");
      expect(row.resource_id, u).toBe("doc-1");
      const mail = mailFor(u);
      expect(mail, u).toHaveLength(1);
      expect(mail[0].subject, u).toBe("New activity on a document");
      expect(String(mail[0].bodyText), u).not.toMatch(/PID-4412|Rev C/);
    }
    expect(h.emails).toHaveLength(5);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("discover check for document doc-1 failed"))).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("could not settle get the doc_superseded notice without its details"))).toBe(true);
    warn.mockRestore();
  });

  it("a check that THROWS is a failure too — the same redacted notice", async () => {
    __registerServerDiscoverCheck(async () => { throw new Error("boom"); });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await emit(ev());
    expect(bell()).toEqual(["named", "w-admin", "w-dc", "w-hidden", "w-sees"]);
    expect(rowFor("w-sees")[0].title).toBe("New activity on a document");
  });

  it("fix pass 2 (the review's scenario): a hold's stop-work notice under a failed check (a 503) — the engineer who follows the P&ID still gets exactly one row and one email, saying a hold was placed, without the document or the reason", async () => {
    __registerServerDiscoverCheck(async () => ({ ok: false, error: "the discover check answered 503" }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // notifyHoldChange's shape (lib/holds.ts): a reason in the title, the
    // release pool named, the followers walked, the bell rows retried (DELIV-16)
    const r = await emit(ev({
      category: "status", kind: "hold_opened",
      title: "HOLD placed on P-101 — Do not fabricate", body: 'Dana placed a "Do not fabricate" hold. Work from this document should stop until it\'s released.',
      link: "/documents/lib-1?doc=doc-1",
      audience: { involved: ["named"], followers: true },
      inappRetry: {},
    }));
    expect(r.recipients).toBe(5);
    const [row] = rowFor("w-sees");
    expect(rowFor("w-sees")).toHaveLength(1);
    expect(row).toMatchObject({ kind: "hold_opened", title: "HOLD placed on a document you follow", link: "/documents/lib-1?doc=doc-1", resource_id: "doc-1", metadata: { redacted: true } });
    expect(String(row.body)).not.toMatch(/P-101|fabricate/i);
    const mail = mailFor("w-sees");
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toBe("HOLD placed on a document you follow");
    expect(String(mail[0].bodyText)).not.toMatch(/P-101|fabricate/i);
    // the named release-pool member and the controllers keep the notice as written
    for (const u of ["named", "w-admin", "w-dc"]) expect(rowFor(u)[0].title, u).toBe("HOLD placed on P-101 — Do not fabricate");
    expect(rowFor("w-hidden")).toHaveLength(1);
  });

  it("redactedNotice keeps the kind, resource, link and channels and drops the label, the reason, the metadata and the producer's email copy", async () => {
    const { redactedNotice } = await import("@/lib/notify/dispatch");
    const out = redactedNotice(ev({
      kind: "hold_released", category: "status", title: "Hold released on P-101", channels: ["inapp"],
      metadata: { holdId: "h1", reason: "x" }, email: { subject: "P-101", bodyHtml: "<b>P-101</b>" },
    }));
    expect(out).toMatchObject({ kind: "hold_released", title: "Hold released on a document you follow", channels: ["inapp"], link: "/documents/lib-1?doc=doc-1", resource: { type: "document", id: "doc-1" }, metadata: { redacted: true }, audience: {} });
    expect(out.email).toEqual({ subject: "Hold released on a document you follow", bodyText: expect.not.stringMatching(/P-101/) });
    expect(JSON.stringify(out)).not.toMatch(/P-101/);
  });

  it("a library-scoped event is not checked (the filter is the document's)", async () => {
    __registerServerDiscoverCheck(hiddenDoc);
    h.state.tables.subscriptions.push({ org_id: ORG, user_id: "w-hidden", resource_type: "library", resource_id: "lib-1" });
    await emit(ev({ kind: "library_doc_revised", resource: { type: "library", id: "lib-1" } }));
    expect(bell()).toEqual(["w-hidden"]);
    expect(calls).toEqual([]);
  });

  it("more than one call's worth of followers is asked in chunks of 500", async () => {
    const many = Array.from({ length: 520 }, (_, i) => `u${i}`);
    for (const u of many) {
      h.state.tables.org_members.push({ org_id: ORG, uid: u, status: "active", role: "Engineer", roles: null, email: `${u}@x.com` });
    }
    __registerServerDiscoverCheck(hiddenDoc);
    const out = await discoveringAmong(ORG, "doc-1", many);
    expect(calls.map((c) => c.uids.length)).toEqual([500, 20]);
    expect(out).toEqual({ uids: [], outcome: "checked" });
  });

  it("the BROWSER asks POST /api/documents/discoverers with the member's own token", async () => {
    vi.stubGlobal("window", {});
    (h.client.auth as Record<string, unknown>).getSession = async () => ({ data: { session: { access_token: "tok-1", user: { id: "actor" } } } });
    const fetchMock = vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      const body = JSON.parse(init.body) as { uids: string[] };
      return { ok: true, status: 200, json: async () => ({ discover: body.uids.filter((u) => u !== "w-hidden"), withheld: ["w-hidden"] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await discoveringAmong(ORG, "doc-1", ["w-sees", "w-hidden", "w-admin"]);
    expect(out).toEqual({ uids: ["w-sees", "w-admin"], outcome: "checked" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/documents/discoverers");
    expect(init.headers.authorization).toBe("Bearer tok-1");
    expect(JSON.parse(init.body)).toEqual({ orgId: ORG, documentId: "doc-1", uids: ["w-sees", "w-hidden", "w-admin"] });
    (h.client.auth as Record<string, unknown>).getSession = async () => ({ data: { session: null } });
  });

  it("the browser: a route that answers 404 (the caller cannot read the document) is a failure — controllers only", async () => {
    vi.stubGlobal("window", {});
    (h.client.auth as Record<string, unknown>).getSession = async () => ({ data: { session: { access_token: "tok-1" } } });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: "No such document in this organization." }) })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await discoveringAmong(ORG, "doc-1", ["w-sees", "w-admin"]);
    expect(out).toMatchObject({ uids: ["w-admin"], outcome: "failed", error: "No such document in this organization." });
    (h.client.auth as Record<string, unknown>).getSession = async () => ({ data: { session: null } });
  });

  it("fix pass 3 (the review's major): a browser discover route that never answers is aborted after DISCOVER_TIMEOUT_MS — a FAILED check (controllers only), so the emit takes the redacted path instead of hanging", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("window", {});
      (h.client.auth as Record<string, unknown>).getSession = async () => ({ data: { session: { access_token: "tok-1" } } });
      const fetchMock = vi.fn((_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        // a hung route: answers only by honouring the abort, as fetch does
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })));
      }));
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { DISCOVER_TIMEOUT_MS } = await import("@/lib/notify/recipients");
      expect(DISCOVER_TIMEOUT_MS).toBe(5000);
      const pending = discoveringAmong(ORG, "doc-1", ["w-sees", "w-admin"]);
      await vi.advanceTimersByTimeAsync(DISCOVER_TIMEOUT_MS);
      const out = await pending;
      expect(out).toMatchObject({ uids: ["w-admin"], outcome: "failed", error: "the discover check did not answer within 5000 ms" });
      expect(fetchMock.mock.calls[0][1].signal).toBeDefined();
      // through emit(): the hung check ends in one full row (the controller) and one redacted row each for the rest
      const sent = emit(ev());
      await vi.advanceTimersByTimeAsync(DISCOVER_TIMEOUT_MS);
      const r = await sent;
      expect(r.recipients).toBe(5);
      const rows = h.state.tables.notifications as Array<Record<string, unknown>>;
      expect(rows.filter((x) => (x.metadata as { redacted?: boolean } | null)?.redacted).map((x) => x.user_id).sort()).toEqual(["named", "w-hidden", "w-sees"]);
    } finally {
      vi.useRealTimers();
      (h.client.auth as Record<string, unknown>).getSession = async () => ({ data: { session: null } });
    }
  });

  it("no check in this context (a server entry that did not load lib/documentDiscoverers): everyone kept, as before, logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await discoveringAmong(ORG, "doc-1", ["w-hidden"]);
    expect(out).toEqual({ uids: ["w-hidden"], outcome: "unavailable" });
    expect(String(warn.mock.calls[0]?.[0])).toContain("no discover check in this context");
  });

  it("lib/documentDiscoverers.ts registers the server check when it is loaded, and the intake door loads it", () => {
    const src = readFileSync(join(ROOT, "lib/documentDiscoverers.ts"), "utf8");
    expect(src).toMatch(/__registerServerDiscoverCheck\(async \(\{ orgId, documentId, uids \}\) => \{/);
    expect(readFileSync(join(ROOT, "app/api/intake/upload/route.ts"), "utf8")).toContain('import "@/lib/documentDiscoverers";');
    // recipients.ts is bundled for the browser: it never imports the server module
    expect(readFileSync(join(ROOT, "lib/notify/recipients.ts"), "utf8")).not.toMatch(/from "@\/lib\/(documentDiscoverers|supabaseAdmin|docFileServer)"/);
  });
});

describe("PROD-4 done-whens 1 and 4 (DEC-100 item 2) — a document's watcher is in resolveRecipients for every non-personal document-scoped kind", () => {
  /** Every emit() in app/ and lib/ that passes `followers: true` with a
   *  document resource, by kind — the non-personal document-scoped notices. */
  function followerDocKinds(): string[] {
    const kinds = new Set<string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) {
          const src = readFileSync(p, "utf8");
          for (const m of src.matchAll(/emit\(\{[\s\S]*?\n\s*\}\);/g)) {
            const call = m[0];
            if (!/followers:\s*true/.test(call)) continue;
            if (!/resource:\s*\{\s*type:\s*"document"/.test(call)) continue;
            const ks = [...call.matchAll(/kind:\s*(?:[^,\n]*\?\s*)?"(\w+)"(?:\s*:\s*"(\w+)")?/g)];
            for (const k of ks) { kinds.add(k[1]); if (k[2]) kinds.add(k[2]); }
          }
        }
      }
    };
    walk(join(ROOT, "lib"));
    walk(join(ROOT, "app"));
    return [...kinds].sort();
  }

  it("the census finds the follower notices: the supersede, the hold pair, and PROD-17's force-release and retirement notices", () => {
    expect(followerDocKinds()).toEqual(expect.arrayContaining(["doc_superseded", "hold_opened", "hold_released"]));
  });

  it("for each, a subscriptions row on the document puts the watcher in resolveRecipients (with the discover check registered and passing)", async () => {
    __registerServerDiscoverCheck(openDoc);
    const kinds = followerDocKinds();
    expect(kinds.length).toBeGreaterThanOrEqual(3);
    for (const kind of kinds) {
      const r = await resolveRecipients(ev({ kind: kind as EmitInput["kind"], audience: { followers: true } }));
      expect(r, kind).toContain("w-sees");
    }
  });
});

describe("ROUTE-3 (a) — resolveFollowers' ticket branch: kept for its one consumer, its header true", () => {
  it("the header no longer claims EVERY follow mechanism, and names the ticket routes as folding watchers themselves", () => {
    const src = readFileSync(join(ROOT, "lib/notify/recipients.ts"), "utf8");
    expect(src).not.toMatch(/EVERY follow\/subscribe mechanism/);
    expect(src).toMatch(/do NOT walk\s*\n\/\/\s*this resolver: they fold tickets\.watchers into their own fan-out/);
  });

  it("the branch's one consumer is real: the intake door's redline notice passes followers on a ticket", () => {
    const route = readFileSync(join(ROOT, "app/api/intake/upload/route.ts"), "utf8");
    expect(route).toMatch(/resource: \{ type: "ticket", id: ticketId \}[^\n]*\n\s*audience: \{ involved, followers: true \}/);
    for (const f of ["app/api/tickets/comment/route.ts", "app/api/tickets/workflow-action/route.ts"]) {
      expect(readFileSync(join(ROOT, f), "utf8"), f).not.toMatch(/resolveFollowers|followers:\s*true/);
    }
  });

  it("a ticket follower is still reached through tickets.watchers (no regression for the redline notice)", async () => {
    h.state.tables.tickets = [{ id: "t-1", org_id: ORG, watchers: ["w-hidden"] }];
    const r = await resolveRecipients(ev({ kind: "ticket_comment", resource: { type: "ticket", id: "t-1" } }));
    expect(r).toEqual(["w-hidden"]);
  });
});

describe("TAX-4 done-when 3 — the checkout thread's notice (and so its toast) reaches only people who may discover the document", () => {
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  function seedThread() {
    h.state.tables.checkout_messages = [
      { id: "m0", org_id: ORG, document_id: "doc-1", episode_id: "e1", user_id: "w-hidden", text: "earlier", kind: "chat" },
    ];
    h.state.tables.checkout_sessions = [{ document_id: "doc-1", user_id: "w-dc", status: "active" }];
    h.state.tables.subscriptions = [
      { org_id: ORG, user_id: "w-sees", resource_type: "document", resource_id: "doc-1" },
      { org_id: ORG, user_id: "w-admin", resource_type: "document", resource_id: "doc-1" },
    ];
    h.state.tables.documents = [{ id: "doc-1", org_id: ORG, library_id: "lib-1", document_number: "P-4412", title: "P&ID" }];
  }
  const post = async () => {
    const { postChat } = await import("@/lib/activityThread");
    await postChat({ orgId: ORG, documentId: "doc-1", episodeId: "e1", userId: "actor", userName: "Alice", text: "pressure relief sizing looks wrong on sheet 3" });
    await settle();
  };

  it("a participant who lost access (w-hidden) gets no row and no snippet; the watcher who can see it, the session holder and a controller do", async () => {
    seedThread();
    __registerServerDiscoverCheck(hiddenDoc);
    await post();
    expect(bell()).toEqual(["w-admin", "w-dc", "w-sees"]);
    expect(calls.at(-1)?.uids.sort()).toEqual(["w-admin", "w-dc", "w-hidden", "w-sees"]);
    expect((h.state.tables.notifications as Array<Record<string, unknown>>).every((r) => r.title === "Alice posted to P-4412")).toBe(true);
  });

  it("REGRESSION: everyone with access still gets exactly one row, as before", async () => {
    seedThread();
    __registerServerDiscoverCheck(openDoc);
    await post();
    expect(bell()).toEqual(["w-admin", "w-dc", "w-hidden", "w-sees"]);
  });

  it("a check that fails: the controllers (and the session holders, here a controller too) get the notice as written; the participant and the watcher get exactly one REDACTED row — no document, no snippet, same kind and link (fix pass 3)", async () => {
    seedThread();
    __registerServerDiscoverCheck(async () => ({ ok: false, error: "unreadable" }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await post();
    expect(bell()).toEqual(["w-admin", "w-dc", "w-hidden", "w-sees"]);
    const rows = h.state.tables.notifications as Array<Record<string, unknown>>;
    const of = (u: string) => rows.filter((r) => r.user_id === u);
    for (const u of ["w-admin", "w-dc"]) {
      expect(of(u)).toHaveLength(1);
      expect(of(u)[0]).toMatchObject({ title: "Alice posted to P-4412", body: "pressure relief sizing looks wrong on sheet 3" });
    }
    const { THREAD_REDACTED } = await import("@/lib/activityThread");
    for (const u of ["w-hidden", "w-sees"]) {
      expect(of(u)).toHaveLength(1);
      expect(of(u)[0]).toMatchObject({ kind: "checkout_message", title: THREAD_REDACTED.title, body: THREAD_REDACTED.body, link: "/documents/lib-1?doc=doc-1" });
      expect(JSON.stringify(of(u)[0])).not.toMatch(/P-4412|P&ID|pressure relief/);
    }
  });

  it("fix pass: a TRANSIENT failure of the check (a 503) does not cut off the person doing the work — a non-controller session holder still gets the notice", async () => {
    seedThread();
    // Bob (named, an Engineer) holds the checkout; the check answers 503
    h.state.tables.checkout_sessions = [
      { document_id: "doc-1", user_id: "w-dc", status: "active" },
      { document_id: "doc-1", user_id: "named", status: "active" },
    ];
    __registerServerDiscoverCheck(async () => ({ ok: false, error: "the discover check answered 503" }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await post();
    // the session holder and the controllers in full; the participant (w-hidden) and the watcher (w-sees) redacted (fix pass 3)
    expect(bell()).toEqual(["named", "w-admin", "w-dc", "w-hidden", "w-sees"]);
    const rows = h.state.tables.notifications as Array<Record<string, unknown>>;
    expect(rows.filter((r) => r.title === "Alice posted to P-4412").map((r) => r.user_id).sort()).toEqual(["named", "w-admin", "w-dc"]);
    expect(rows.filter((r) => (r.metadata as { redacted?: boolean } | null)?.redacted).map((r) => r.user_id).sort()).toEqual(["w-hidden", "w-sees"]);
  });

  it("REGRESSION: a check that ANSWERS still drops a session holder who may not discover the document (the session exemption is for a failed check only)", async () => {
    seedThread();
    h.state.tables.checkout_sessions = [{ document_id: "doc-1", user_id: "w-hidden", status: "active" }];
    __registerServerDiscoverCheck(hiddenDoc);
    await post();
    expect(bell()).toEqual(["w-admin", "w-sees"]);
  });
});

describe("PROD-17 (fix pass) — one retirement, one notice per person: a watcher the supersede door told personally gets no second FYI", () => {
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
  function seedRetirement() {
    h.state.tables.org_members = [
      ...(h.state.tables.org_members ?? []),
      { org_id: ORG, uid: "holder", status: "active", role: "Engineer", roles: null, email: "holder@x.com" },
      { org_id: ORG, uid: "pkowner", status: "active", role: "Engineer", roles: null, email: "pkowner@x.com" },
    ];
    h.state.tables.subscriptions = ["holder", "pkowner", "w-sees"].map((u) => ({
      org_id: ORG, user_id: u, resource_type: "document", resource_id: "doc-1",
    }));
    // the supersede leaves the checkout open
    h.state.tables.documents = [{ id: "doc-1", org_id: ORG, library_id: "lib-1", document_number: "P-101", checked_out_by: "holder" }];
    h.state.tables.work_package_documents = [{ package_id: "pk-1", document_id: "doc-1" }];
    h.state.tables.work_packages = [{ id: "pk-1", org_id: ORG, name: "Turnaround 3", owner_user_id: "pkowner", status: "open" }];
    h.state.tables.download_audits = [];
  }

  it("the checkout holder and the package owner (both watching) each get exactly their personal notice; the plain watcher gets the FYI, under doc_retired", async () => {
    seedRetirement();
    __registerServerDiscoverCheck(openDoc);
    const { notifyPackagesOfRetirement } = await import("@/lib/postPublish");
    const { recallRetiredDocument } = await import("@/lib/staleCopies");
    // the supersede door's personal notices (lib/revisions.ts): the checkout
    // holder's (revision_published_over_checkout — written here as that
    // door's notify() writes it) and the open packages' owners'
    const { notify } = await import("@/lib/inAppNotifications");
    await notify({
      orgId: ORG, userId: "holder", kind: "revision_published_over_checkout",
      title: "Document superseded while you're checked out", body: "Superseded by Dana: replaced",
      resourceType: "document", resourceId: "doc-1", actorUserId: "actor", actorName: "Dana",
    });
    await notifyPackagesOfRetirement({ orgId: ORG, documentId: "doc-1", docLabel: "P-101", newStatus: "Superseded", actorUserId: "actor", actorName: "Dana" });
    await recallRetiredDocument({ orgId: ORG, documentId: "doc-1", libraryId: "lib-1", docLabel: "P-101", newStatus: "Superseded", actorUserId: "actor", actorName: "Dana" });
    await settle();
    const rows = (h.state.tables.notifications ?? []) as Array<{ user_id: string; kind: string }>;
    const per = (u: string) => rows.filter((r) => r.user_id === u).map((r) => r.kind);
    expect(per("holder")).toEqual(["revision_published_over_checkout"]);
    expect(per("pkowner")).toEqual(["package_doc_retired"]);
    expect(per("w-sees")).toEqual(["doc_retired"]);
    expect(per("actor")).toEqual([]);
  });

  it("the watcher's FYI is not a compliance kind: the cron's digest set leaves it out, and the delete policy's registry lets a read one be cleared", async () => {
    const { KIND_META } = await import("@/lib/notificationKinds");
    const digestKinds = (Object.keys(KIND_META) as Array<keyof typeof KIND_META>).filter((k) => KIND_META[k].compliance);
    expect(digestKinds).not.toContain("doc_retired");
    expect(digestKinds).toContain("doc_recalled");
    // 20261161's notifications_own_delete refuses only kinds notification_kinds() flags compliance
    const sql = readFileSync(join(ROOT, "supabase/migrations/20261206_notif_roundG_stale_escalation_kind.sql"), "utf8");
    expect(sql).toMatch(/\('doc_retired',\s+false\),/);
    expect(readFileSync(join(ROOT, "supabase/migrations/20261161_notif_roundG_read_scope.sql"), "utf8"))
      .toMatch(/AND NOT EXISTS \(SELECT 1 FROM notification_kinds\(\) k WHERE k\.kind = notifications\.kind AND k\.compliance\)/);
  });
});

describe("TAX-17 / PROD-17 deploy window (fix pass 2) — a watcher FYI of a kind the rail refuses sends no email without its bell row", () => {
  const refuseNotifications = () => {
    h.state.tableWriteError = { notifications: { code: "22023", message: "notification kind doc_retired is not declared (notification_kinds())" } };
  };

  it("before 20261206 is pasted: doc_retired's bell rows are refused, and emailOnlyWithBell sends no email either", async () => {
    __registerServerDiscoverCheck(openDoc);
    refuseNotifications();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await emit(ev({ kind: "doc_retired", title: "P-101 was retired (Superseded)", emailOnlyWithBell: true }));
    expect(r.inapp).toEqual({ sent: 0, failed: 5 });
    expect(bell()).toEqual([]);
    expect(h.emails).toEqual([]);
  });

  it("reproduced: without emailOnlyWithBell the email went out with no bell row (the review's finding)", async () => {
    __registerServerDiscoverCheck(openDoc);
    refuseNotifications();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await emit(ev({ kind: "doc_retired", title: "P-101 was retired (Superseded)" }));
    expect(bell()).toEqual([]);
    expect(h.emails).toHaveLength(5);
  });

  it("after the paste: every watcher gets exactly one row and one email", async () => {
    __registerServerDiscoverCheck(openDoc);
    const r = await emit(ev({ kind: "doc_retired", title: "P-101 was retired (Superseded)", emailOnlyWithBell: true }));
    expect(r.inapp).toEqual({ sent: 5, failed: 0 });
    expect(bell()).toEqual(["named", "w-admin", "w-dc", "w-hidden", "w-sees"]);
    expect(h.emails.map((e) => e.toUserId).sort()).toEqual(["named", "w-admin", "w-dc", "w-hidden", "w-sees"]);
  });

  it("both watcher FYIs pass it (the force-release and the retirement)", () => {
    for (const f of ["lib/checkoutEpisodes.ts", "lib/staleCopies.ts"]) {
      expect(readFileSync(join(ROOT, f), "utf8"), f).toMatch(/kind: "(checkout_force_released_fyi|doc_retired)",[\s\S]*?emailOnlyWithBell: true,/);
    }
  });
});
