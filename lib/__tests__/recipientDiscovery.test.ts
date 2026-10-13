// notifications Round G, N15 RECIPIENT VISIBILITY AND NAMES.
//
// NEDGE-6 done-when 3 (the wiring): emit() drops a document's FOLLOWER who
// may not discover it (lib/notify/recipients.ts discoveringAmong — the
// server check lib/documentDiscoverers.ts registers, the route from the
// browser); controllers are never dropped (DEC-43); someone the producer
// names, a role pool and a project roster are not filtered. REGRESSION:
// every recipient with access still gets exactly one row.
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

  it("a check that FAILS keeps only the controllers (fail closed), logged", async () => {
    __registerServerDiscoverCheck(async () => ({ ok: false, error: "The document could not be read." }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await emit(ev());
    expect(bell()).toEqual(["w-admin", "w-dc"]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("discover check for document doc-1 failed"))).toBe(true);
    warn.mockRestore();
  });

  it("a check that THROWS is a failure too", async () => {
    __registerServerDiscoverCheck(async () => { throw new Error("boom"); });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await emit(ev());
    expect(bell()).toEqual(["w-admin", "w-dc"]);
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

  it("a check that fails keeps only the controllers", async () => {
    seedThread();
    __registerServerDiscoverCheck(async () => ({ ok: false, error: "unreadable" }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await post();
    expect(bell()).toEqual(["w-admin", "w-dc"]);
  });
});
