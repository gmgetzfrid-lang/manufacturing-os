// notifications Round G, N16 — NEDGE-22 with the REAL server check.
//
// A library-scoped follower's discover answer comes from the same predicate
// the library page uses (DEC-90's I-12 ruling R1): lib/documentDiscoverers.ts
// discoverersOfDocument reads the library rung through lib/docFileServer
// loadContainerAclChain → lib/libraryAccess effectiveLibraryAclFromRow — the
// rung the library page evaluates with effectiveLibraryAcl — so a LEGACY
// library whose ACL says nothing binds its read lists here as it does on the
// page. No second chain walk: this file drives the registered check itself
// (import "@/lib/documentDiscoverers") through the real dispatcher.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { db } from "./helpers/restoreMemoryDb";
import { resetState, type MemoryState } from "./helpers/memoryDb";
import type { Principal } from "@/lib/permissions";

const h = vi.hoisted(() => ({
  state: null as unknown as MemoryState,
  emails: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabaseAdmin", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  return { supabaseAdmin: { from: mem.from } };
});
vi.mock("@/lib/supabase", async () => {
  const mem = await import("./helpers/memoryDb");
  h.state = mem.freshState();
  return { supabase: mem.makeSupabase(h.state), __registerScopedServerClient: () => undefined };
});
vi.mock("@/lib/notifications", () => ({
  queueEmail: vi.fn(async (input: Record<string, unknown>) => { h.emails.push(input); }),
}));
vi.mock("@/lib/ownership", () => ({
  effectiveOwnerForDocument: vi.fn(async () => ({ userId: null, name: null, source: "none" })),
}));

import "@/lib/documentDiscoverers";
import { __registerServerDiscoverCheck } from "@/lib/notify/recipients";
import { discoverersOfDocument } from "@/lib/documentDiscoverers";
import { emit, type EmitInput } from "@/lib/notify/dispatch";
import { explorerDocReadable, explorerLibraryVisible, libraryConfigFromRow, effectiveLibraryAcl } from "@/lib/libraryAccess";

const ORG = "org-1";
const members = [
  { org_id: ORG, uid: "actor", role: "Engineer-1", roles: ["Engineer-1"], status: "active", email: "actor@x.com" },
  { org_id: ORG, uid: "eng", role: "Engineer-1", roles: ["Engineer-1"], status: "active", email: "eng@x.com" },
  { org_id: ORG, uid: "viewer", role: "Viewer", roles: ["Viewer"], status: "active", email: "viewer@x.com" },
  { org_id: ORG, uid: "dc", role: "DocCtrl", roles: ["DocCtrl"], status: "active", email: "dc@x.com" },
];
const legacyLibrary = { id: "lib-L", org_id: ORG, acl: null, visibility: null, read_access: ["Engineer-1"], visible_to: [], write_access: [], admin_access: [] };
const doc = { id: "doc-L", org_id: ORG, library_id: "lib-L", collection_id: null, visibility: "normal", acl: null, owner_user_id: null, owner_name: null };

function seed(library: Record<string, unknown> = legacyLibrary) {
  db.rows = {
    org_members: members.map((m) => ({ ...m })),
    team_members: [],
    libraries: [library],
    collections: [],
    documents: [doc],
  };
  db.readError = {};
  resetState(h.state);
  h.emails.length = 0;
  h.state.tables.org_members = members.map((m) => ({ ...m }));
  h.state.tables.subscriptions = ["eng", "viewer", "dc"].map((u) => ({ org_id: ORG, user_id: u, resource_type: "library", resource_id: "lib-L" }));
  h.state.tables.notifications = [];
}

const principal = (uid: string): Principal => {
  const m = members.find((x) => x.uid === uid)!;
  return { uid, role: m.role as Principal["role"], roles: m.roles as Principal["roles"], orgId: ORG, teamIds: [], isActiveMember: true };
};

const ev = (): EmitInput => ({
  orgId: ORG, category: "watched", kind: "library_doc_revised",
  title: "P-77 → Rev B", body: "Dana published Rev B in a library you subscribe to.",
  link: "/documents/lib-L?doc=doc-L", resource: { type: "library", id: "lib-L" },
  actorUserId: "actor", actorName: "Dana", audience: { followers: true },
  namesDocuments: { ids: ["doc-L"], unnamed: { title: "New revision in a library you follow", body: "Dana published a new revision in a library you subscribe to.", link: "/documents/lib-L" } },
});
const rowFor = (u: string) => ((h.state.tables.notifications ?? []) as Array<Record<string, unknown>>).filter((r) => r.user_id === u);

beforeEach(() => { seed(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("NEDGE-22 / DEC-90 R1 — a legacy library's read list binds the follower's discover answer, as it binds the library page", () => {
  it("the server check registered itself, and answers by the library page's predicate: the legacy list admits the Engineer, not the Viewer; the controller always", async () => {
    const r = await discoverersOfDocument({ orgId: ORG, documentId: "doc-L", uids: ["eng", "viewer", "dc"] });
    expect(r).toMatchObject({ ok: true, discover: ["eng", "dc"], withheld: ["viewer"] });
    // the library page's own evaluation of the same rows (lib/libraryAccess)
    const lib = libraryConfigFromRow(legacyLibrary);
    const rung = effectiveLibraryAcl(lib);
    for (const uid of ["eng", "viewer", "dc"]) {
      const onPage = explorerLibraryVisible(principal(uid), lib)
        && explorerDocReadable(principal(uid), rung, { collectionId: null }, new Map(), null);
      expect(r.ok && r.discover.includes(uid), uid).toBe(onPage);
    }
  });

  it("through emit(): the Viewer who follows the legacy library reads the rev-up without the document; the Engineer and the controller read it as written", async () => {
    const r = await emit(ev());
    expect(r.recipients).toBe(3);
    for (const u of ["eng", "dc"]) expect(rowFor(u)[0], u).toMatchObject({ title: "P-77 → Rev B", link: "/documents/lib-L?doc=doc-L" });
    expect(rowFor("viewer")[0]).toMatchObject({ title: "New revision in a library you follow", link: "/documents/lib-L", metadata: { redacted: true } });
    expect(JSON.stringify(rowFor("viewer"))).not.toMatch(/P-77|doc-L/);
  });

  it("REGRESSION: a library open to everyone (read_access 'ALL') — every follower reads the notice as written", async () => {
    seed({ ...legacyLibrary, read_access: "ALL" });
    await emit(ev());
    for (const u of ["eng", "viewer", "dc"]) expect(rowFor(u)[0], u).toMatchObject({ title: "P-77 → Rev B" });
  });

  it("an unreadable chain is a FAILED check (DEC-106): the controller in full, the others redacted — never the name unchecked", async () => {
    db.readError = { libraries: "timeout" };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await emit(ev());
    expect(rowFor("dc")[0].title).toBe("P-77 → Rev B");
    for (const u of ["eng", "viewer"]) expect(rowFor(u)[0], u).toMatchObject({ title: "New activity on a library", link: "/documents/lib-L", metadata: { redacted: true } });
  });

  it("the check is the one lib/documentDiscoverers.ts registers (no second walk in the dispatcher)", () => {
    // re-registering null and back proves the dispatcher asks only through the registration
    __registerServerDiscoverCheck(null);
    return import("@/lib/notify/recipients").then(async ({ discoveringAmong }) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect((await discoveringAmong(ORG, "doc-L", ["viewer"])).outcome).toBe("unavailable");
      __registerServerDiscoverCheck(async ({ orgId, documentId, uids }) => {
        const a = await discoverersOfDocument({ orgId, documentId, uids });
        return a.ok ? { ok: true, discover: a.discover } : { ok: false, error: a.error };
      });
      expect(await discoveringAmong(ORG, "doc-L", ["viewer", "eng"])).toEqual({ uids: ["eng"], outcome: "checked" });
    });
  });
});
