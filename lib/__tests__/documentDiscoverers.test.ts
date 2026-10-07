// NEDGE-6 done-when 3 (notifications Round G, N9): the server-side discover
// check for one document and a list of people — lib/documentDiscoverers.ts
// and POST /api/documents/discoverers. It answers who among the people may
// DISCOVER the document over its full library → folders → document chain
// (lib/permissions canDiscover), with the controller tier (DEC-43) and the
// effective owner (GAP-15 / DEC-7); a non-member is withheld; a read that
// fails answers no list; the route asks only about a document the CALLER's
// own session can read, and answers 404 otherwise.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { db } from "./helpers/restoreMemoryDb";
import type { AccessControl } from "@/types/schema";

const state = vi.hoisted(() => ({
  user: { id: "caller" } as { id: string } | null,
  callerSees: true,
  owner: null as string | null,
}));

vi.mock("@/lib/supabaseAdmin", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  return {
    supabaseAdmin: {
      from: mem.from,
      auth: { getUser: vi.fn(async () => (state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } })) },
    },
  };
});
vi.mock("@/lib/ownership", () => ({
  effectiveOwnerForDocument: vi.fn(async () => ({ userId: state.owner, name: null, source: state.owner ? "folder" : "none" })),
}));
vi.mock("@/lib/serverAuth", () => ({
  callerScopedClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      const self = () => b;
      b.select = self; b.eq = self; b.in = self;
      b.maybeSingle = async () => ({ data: state.callerSees ? { id: "doc-hidden" } : null, error: null });
      return b;
    },
  }),
}));

import { discoverersOfDocument, DISCOVERERS_MAX_UIDS, principalDiscovers } from "@/lib/documentDiscoverers";
import { POST } from "@/app/api/documents/discoverers/route";

const ORG = "org-1";
const allow = (uid: string, actions: string[]): AccessControl =>
  ({ rules: [{ effect: "allow", subject: { type: "user", id: uid }, actions }] } as unknown as AccessControl);

beforeEach(() => {
  state.user = { id: "caller" };
  state.callerSees = true;
  state.owner = null;
  db.rows = {
    org_members: [
      { org_id: ORG, uid: "caller", role: "Engineer-1", roles: ["Engineer-1"], status: "active" },
      { org_id: ORG, uid: "granted", role: "Engineer-1", roles: ["Engineer-1"], status: "active" },
      { org_id: ORG, uid: "plain", role: "Engineer-1", roles: ["Engineer-1"], status: "active" },
      { org_id: ORG, uid: "docctrl", role: "DocCtrl", roles: ["DocCtrl"], status: "active" },
      { org_id: ORG, uid: "folder-owner", role: "Viewer", roles: ["Viewer"], status: "active" },
      { org_id: ORG, uid: "gone", role: "Engineer-1", roles: ["Engineer-1"], status: "removed" },
    ],
    team_members: [],
    libraries: [{ id: "lib-1", org_id: ORG, acl: null }],
    collections: [{ id: "fold-1", org_id: ORG, library_id: "lib-1", path_ids: [], acl: null }],
    documents: [
      { id: "doc-hidden", org_id: ORG, library_id: "lib-1", collection_id: "fold-1", visibility: "hidden", acl: allow("granted", ["discover", "read"]), owner_user_id: null, owner_name: null },
      { id: "doc-normal", org_id: ORG, library_id: "lib-1", collection_id: null, visibility: "normal", acl: null, owner_user_id: null, owner_name: null },
      { id: "doc-broken", org_id: ORG, library_id: "lib-1", collection_id: "fold-gone", visibility: "normal", acl: null, owner_user_id: null, owner_name: null },
    ],
  };
  db.readError = {};
});

describe("NEDGE-6 dw3 — discoverersOfDocument", () => {
  it("a hidden document: only the granted person, the controller tier and the effective owner discover it; a non-member is withheld", async () => {
    state.owner = "folder-owner";
    const r = await discoverersOfDocument({ orgId: ORG, documentId: "doc-hidden", uids: ["granted", "plain", "docctrl", "folder-owner", "gone", "stranger"] });
    expect(r).toMatchObject({
      ok: true,
      discover: ["granted", "docctrl", "folder-owner"],
      withheld: ["plain", "gone", "stranger"],
      visibility: "hidden",
    });
  });

  it("a normal document with no ACL anywhere: every active member discovers it", async () => {
    const r = await discoverersOfDocument({ orgId: ORG, documentId: "doc-normal", uids: ["granted", "plain", "gone"] });
    expect(r).toMatchObject({ ok: true, discover: ["granted", "plain"], withheld: ["gone"], visibility: "normal" });
  });

  it("an allow-list on the LIBRARY binds a normal document: the chain is read, not only the document's own ACL", async () => {
    db.rows.libraries = [{ id: "lib-1", org_id: ORG, acl: allow("granted", ["read"]) }];
    const r = await discoverersOfDocument({ orgId: ORG, documentId: "doc-normal", uids: ["granted", "plain", "docctrl"] });
    expect(r).toMatchObject({ ok: true, discover: ["granted", "docctrl"], withheld: ["plain"] });
  });

  it("a broken chain cannot be evaluated: only the controller tier and the owner are answered", async () => {
    state.owner = "folder-owner";
    const r = await discoverersOfDocument({ orgId: ORG, documentId: "doc-broken", uids: ["plain", "docctrl", "folder-owner"] });
    expect(r).toMatchObject({ ok: true, discover: ["docctrl", "folder-owner"], withheld: ["plain"], brokenChain: true });
  });

  it("fails closed: a document of another org is 404; an unreadable membership or chain answers no list", async () => {
    expect(await discoverersOfDocument({ orgId: "org-2", documentId: "doc-hidden", uids: ["granted"] })).toMatchObject({ ok: false, status: 404 });
    db.readError = { org_members: "timeout" };
    expect(await discoverersOfDocument({ orgId: ORG, documentId: "doc-hidden", uids: ["granted"] })).toMatchObject({ ok: false, status: 503 });
    db.readError = { libraries: "timeout" };
    expect(await discoverersOfDocument({ orgId: ORG, documentId: "doc-hidden", uids: ["granted"] })).toMatchObject({ ok: false, status: 503 });
  });

  it("principalDiscovers is the canDiscover bar: a discover-only grant suffices on a hidden node", () => {
    const p = { uid: "x", role: "Engineer-1" as const, roles: ["Engineer-1" as const], orgId: ORG, teamIds: [], isActiveMember: true };
    expect(principalDiscovers(p, { visibility: "hidden", acl: allow("x", ["discover"]) }, [], null)).toBe(true);
    expect(principalDiscovers(p, { visibility: "hidden", acl: allow("y", ["discover"]) }, [], null)).toBe(false);
    expect(principalDiscovers(p, { visibility: "hidden", acl: null }, [], "x")).toBe(true);
  });
});

describe("NEDGE-6 dw3 — POST /api/documents/discoverers", () => {
  const post = (body: unknown) => new NextRequest("https://app/api/documents/discoverers", {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
  });

  it("answers the subset of the people sent who may discover the document", async () => {
    const res = await POST(post({ orgId: ORG, documentId: "doc-hidden", uids: ["granted", "plain", "docctrl"] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ discover: ["granted", "docctrl"], withheld: ["plain"] });
  });

  it("a document the caller's own session cannot read is answered as if it did not exist", async () => {
    state.callerSees = false;
    const res = await POST(post({ orgId: ORG, documentId: "doc-hidden", uids: ["granted"] }));
    expect(res.status).toBe(404);
  });

  it("refuses a signed-out caller, a non-member, a malformed body and an oversized list", async () => {
    state.user = null;
    expect((await POST(post({ orgId: ORG, documentId: "doc-hidden", uids: [] }))).status).toBe(401);
    state.user = { id: "gone" };
    expect((await POST(post({ orgId: ORG, documentId: "doc-hidden", uids: [] }))).status).toBe(403);
    state.user = { id: "caller" };
    expect((await POST(post({ orgId: ORG, documentId: "doc-hidden" }))).status).toBe(400);
    const many = Array.from({ length: DISCOVERERS_MAX_UIDS + 1 }, (_, i) => `u${i}`);
    expect((await POST(post({ orgId: ORG, documentId: "doc-hidden", uids: many }))).status).toBe(400);
  });
});
