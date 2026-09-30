// projects Round G — SEC-10: lib/docFileServer is the gate every
// service-role page read of a doc-control document goes through. A member
// the app would not let read a document must not be able to have its pages
// read back to them by the checklist or quality-manual readers — and a
// controller-only read must be recorded (DEC-43).
//
// Two halves:
//   · the gate evaluates the app's own read decision over the FULL chain
//     (library → ancestor folders → folder → document), requiring read or
//     download wherever an ACL exists, on every visibility — the matrix in
//     "SEC-10: the full chain" pins it case by case, and pins that the gate
//     never serves what read-or-download over the chain would refuse (the
//     library page LISTS by read alone; a download-only grant, which the
//     gate serves as the egress does, is the one named divergence). A chain
//     that cannot be read is 503; one with a rung that does not exist is
//     409, naming it. The version served must belong to the document the
//     decision was made on;
//   · it is never LOOSER than the bytes egress (/api/storage/download-url):
//     the parity matrix runs the real route and the real gate over the same
//     principal × document fixtures and names every case where the gate is
//     stricter. Intelligence KACL-5 brings the egress route to the same
//     chain; when it lands, those named divergences shrink.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com" } as { id: string; email?: string } | null,
  tables: {} as Record<string, { data?: unknown; error?: unknown }>,
  // Per-table override for .maybeSingle() — collections is read both as one
  // row (the document's folder) and as a list (its ancestors).
  single: {} as Record<string, { data?: unknown; error?: unknown }>,
  rpc: {} as Record<string, { data?: unknown; error?: unknown }>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  calls: [] as Array<{ table: string; method: string; args: unknown[]; chain: number }>,
  chainSeq: 0,
  // Tables whose single-row reads honour .eq() filters against the fixture
  // (a filter on a column the fixture carries, with another value, resolves
  // no row — as the database would). seed() turns it on for
  // document_versions, so every served case proves the version's record_id
  // matched the evaluated document.
  honourEq: new Set<string>(),
}));

function chain(table: string) {
  const result = () => state.tables[table] ?? { data: null, error: null };
  const c: Record<string, unknown> = {};
  const id = ++state.chainSeq;
  const eqs: Array<[string, unknown]> = [];
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        const r = result();
        return (resolve: (v: unknown) => void) => resolve({ data: r.data ?? null, error: r.error ?? null });
      }
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args, chain: id });
        if (prop === "eq") eqs.push([String(args[0]), args[1]]);
        if (prop === "insert") state.inserts.push({ table, row: args[0] as Record<string, unknown> });
        if (prop === "maybeSingle" || prop === "single") {
          const r = state.single[table] ?? result();
          const row = r.data as Record<string, unknown> | null | undefined;
          const filteredOut = state.honourEq.has(table) && !!row && !Array.isArray(row)
            && eqs.some(([col, val]) => col in row && row[col] !== val);
          return Promise.resolve({ data: filteredOut ? null : r.data ?? null, error: r.error ?? null });
        }
        return new Proxy(c, handler);
      };
    },
  };
  return new Proxy(c, handler);
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: {
      getUser: vi.fn(async () =>
        state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }),
    },
    from: (t: string) => chain(t),
    rpc: vi.fn(async (fn: string) => state.rpc[fn] ?? { data: null, error: null }),
  },
}));
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => ({})) }, R2_BUCKET: "test-bucket" }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: vi.fn(async () => "https://signed.example/get") }));

import { GET as downloadUrl } from "@/app/api/storage/download-url/route";
import {
  resolveDocumentFile, documentContentDecision, discoverableDocuments, loadReaderPrincipal, loadContainerAclChain,
  docChainBrokenMessage, BrokenAclChainError,
  DOC_READ_DENIED, DOC_NO_FILE, DOC_ACCESS_UNVERIFIED,
} from "@/lib/docFileServer";
import { canWithAclChain, type Principal } from "@/lib/permissions";
import type { AccessControl } from "@/types/schema";

const ORG = "12345678-1234-1234-1234-123456789abc";
const KEY = `orgs/${ORG}/libraries/l1/HSE-7.pdf`;
const grant = (uid: string, actions: string[]) =>
  ({ rules: [{ effect: "allow", subject: { type: "user", id: uid }, actions }] });
const teamGrant = (team: string, actions: string[]) =>
  ({ rules: [{ effect: "allow", subject: { type: "team", id: team }, actions }] });

const MEMBERS: Record<string, { role: string; roles: string[] }> = {
  viewer: { role: "Viewer", roles: [] },
  manager: { role: "Manager", roles: ["Manager"] },
  additiveDocCtrl: { role: "Manager", roles: ["Manager", "DocCtrl"] },
  admin: { role: "Admin", roles: ["Admin"] },
};
const DOCS: Record<string, Record<string, unknown>> = {
  normal: {},
  privateNoAcl: { visibility: "private" },
  privateOthersOnly: { visibility: "private", acl: grant("someone-else", ["discover", "read"]) },
  hiddenDiscoverOnly: { visibility: "hidden", acl: grant("u1", ["discover"]) },
  privateReadGrant: { visibility: "private", acl: grant("u1", ["discover", "read"]) },
  privateDownloadGrant: { visibility: "private", acl: grant("u1", ["download"]) },
  normalRoleDownloadDeny: { acl_index: { deny: { roles: { download: ["Viewer", "Manager"] } } } },
  privateUserDownloadDeny: { visibility: "private", acl: grant("u1", ["read"]), acl_index: { deny: { users: { download: ["u1"] } } } },
  // The ordinary PermissionDrawer restriction: normal visibility, read
  // granted to someone else only (an allow-list).
  normalOthersOnly: { acl: grant("someone-else", ["discover", "read"]) },
  normalReadGrant: { acl: grant("u1", ["read"]) },
  // "Everyone in the org: no download" — an org-subject deny.
  orgDownloadDeny: { acl_index: { deny: { orgs: { download: [ORG] } } } },
};

function seed(member: { role: string; roles: string[] } | null, doc: Record<string, unknown>, owner = false) {
  state.user = { id: "u1", email: "u1@example.com" };
  state.calls = [];
  // The container chain: library l1 → folder c1 (no ancestors), no ACL on
  // either unless a case sets one.
  state.single = { collections: { data: { id: "c1", library_id: "l1", path_ids: [], acl: null } } };
  state.tables = {
    org_members: { data: member ? { uid: "u1", status: "active", ...member } : null },
    team_members: { data: [] },
    libraries: { data: { id: "l1", acl: null } },
    collections: { data: [] },
    documents: {
      data: {
        id: "d1", document_number: "HSE-7", title: "Incident procedure", name: null,
        current_version_id: "v1", pending_version_id: null,
        visibility: "normal", acl: null, acl_index: null,
        owner_user_id: "someone-else", collection_id: "c1", library_id: "l1",
        org_id: ORG,
        ...doc,
      },
    },
    document_versions: { data: { record_id: "d1", file_url: KEY, file_type: "application/pdf", archived_at: null, archive_id: null } },
    archive_settings: { data: null },
  };
  state.rpc = owner ? { user_is_effective_owner: { data: true } } : {};
  state.inserts = [];
  state.honourEq = new Set(["document_versions"]);
}
const restrictedReads = () => state.inserts.filter((i) => i.table === "audit_logs" && i.row.action === "CONTROLLER_RESTRICTED_READ");

async function egressVerdict(): Promise<{ status: number; recorded: number }> {
  state.inserts = [];
  const res = await downloadUrl(new NextRequest(
    `https://app/api/storage/download-url?path=${encodeURIComponent(KEY)}`,
    { headers: { authorization: "Bearer t" } },
  ));
  return { status: res.status, recorded: restrictedReads().length };
}
async function gateVerdict(): Promise<{ status: number; recorded: number }> {
  state.inserts = [];
  const r = await resolveDocumentFile(ORG, "d1", { uid: "u1", email: "u1@example.com", channel: "test" });
  return { status: r.ok ? 200 : r.status, recorded: restrictedReads().length };
}

beforeEach(() => { seed(MEMBERS.viewer, DOCS.normal); });

// Where the gate is STRICTER than today's egress route, by design: the
// egress route evaluates only the document's own ACL, only for private /
// hidden documents, and reads no org-subject deny (intelligence KACL-5). Every
// other fixture decides — and records — alike.
const STRICTER_THAN_EGRESS = new Set([
  // An allow-list on a normal document binds (SEC-10's own scenario).
  "viewer × normalOthersOnly", "manager × normalOthersOnly",
  // …so a controller served it only by the tier is recorded (DEC-43).
  "additiveDocCtrl × normalOthersOnly", "admin × normalOthersOnly",
  // An org-subject download deny binds everyone, the owner included.
  ...Object.keys(MEMBERS).flatMap((who) => [`${who} × orgDownloadDeny`, `${who} × orgDownloadDeny × effective owner`]),
]);

describe("SEC-10 parity: the page-read gate is never looser than the bytes egress", () => {
  for (const [who, member] of Object.entries(MEMBERS)) {
    for (const [what, doc] of Object.entries(DOCS)) {
      for (const owner of [false, true]) {
        const name = `${who} × ${what}${owner ? " × effective owner" : ""}`;
        it(name, async () => {
          seed(member, doc, owner);
          const egress = await egressVerdict();
          seed(member, doc, owner);
          const gate = await gateVerdict();
          // Never looser: what the egress route refuses, the gate refuses.
          if (egress.status !== 200) expect(gate.status, "the egress route refuses — so must the gate").toBe(egress.status);
          // DEC-43: a served controller-only read the egress route records,
          // the gate records too. The gate never records a read it refuses.
          if (gate.status === 200) expect(gate.recorded, "CONTROLLER_RESTRICTED_READ").toBeGreaterThanOrEqual(egress.recorded);
          else expect(gate.recorded).toBe(0);
          const same = gate.status === egress.status && gate.recorded === egress.recorded;
          expect(same, "decides exactly as the egress route unless named in STRICTER_THAN_EGRESS").toBe(!STRICTER_THAN_EGRESS.has(name));
        });
      }
    }
  }

  it("the named divergences are exactly the ones observed — none stale, none unnamed", async () => {
    const divergent = new Set<string>();
    for (const [who, member] of Object.entries(MEMBERS)) {
      for (const [what, doc] of Object.entries(DOCS)) {
        for (const owner of [false, true]) {
          seed(member, doc, owner);
          const egress = await egressVerdict();
          seed(member, doc, owner);
          const gate = await gateVerdict();
          if (gate.status !== egress.status || gate.recorded !== egress.recorded) {
            divergent.add(`${who} × ${what}${owner ? " × effective owner" : ""}`);
          }
        }
      }
    }
    expect(divergent).toEqual(STRICTER_THAN_EGRESS);
  });

  it("the matrix is not vacuous: it contains serves, refusals and recorded controller reads", async () => {
    const seen = new Set<string>();
    for (const member of Object.values(MEMBERS)) {
      for (const doc of Object.values(DOCS)) {
        seed(member, doc);
        const g = await gateVerdict();
        seen.add(`${g.status}:${g.recorded}`);
      }
    }
    expect(seen).toEqual(new Set(["200:0", "403:0", "200:1"]));
  });
});

describe("SEC-10: the full chain — library → ancestor folders → folder → document", () => {
  const VIEWER = MEMBERS.viewer;
  function inTeam(team: string | null) {
    state.tables.team_members = { data: team ? [{ team_id: team }] : [] };
  }
  const setLibrary = (acl: unknown) => { state.tables.libraries = { data: { id: "l1", acl } }; };
  const setFolder = (acl: unknown, pathIds: string[] = []) => {
    state.single.collections = { data: { id: "c1", library_id: "l1", path_ids: pathIds, acl } };
  };
  const setAncestors = (rows: Array<{ id: string; acl: unknown }>) => { state.tables.collections = { data: rows }; };

  it("(a) a normal document with an allow-list for team-A: 403 outside team-A, 200 inside — the egress route serves both today (KACL-5)", async () => {
    seed(VIEWER, { acl: teamGrant("team-A", ["discover", "read"]) });
    expect((await gateVerdict()).status).toBe(403);
    seed(VIEWER, { acl: teamGrant("team-A", ["discover", "read"]) });
    expect((await egressVerdict()).status).toBe(200);
    seed(VIEWER, { acl: teamGrant("team-A", ["discover", "read"]) });
    inTeam("team-A");
    expect((await gateVerdict()).status).toBe(200);
  });

  it("an allow-list on the LIBRARY binds a normal document with no ACL of its own", async () => {
    seed(VIEWER, DOCS.normal);
    setLibrary(teamGrant("team-A", ["discover", "read", "download"]));
    expect((await gateVerdict()).status).toBe(403);
    seed(VIEWER, DOCS.normal);
    setLibrary(teamGrant("team-A", ["discover", "read", "download"]));
    inTeam("team-A");
    expect((await gateVerdict()).status).toBe(200);
  });

  it("an allow-list on an ANCESTOR folder binds too — every rung of path_ids is read, in order", async () => {
    seed(VIEWER, DOCS.normal);
    setFolder(null, ["c0"]);
    setAncestors([{ id: "c0", acl: teamGrant("team-A", ["read"]) }]);
    expect((await gateVerdict()).status).toBe(403);
    seed(VIEWER, DOCS.normal);
    setFolder(null, ["c0"]);
    setAncestors([{ id: "c0", acl: teamGrant("team-A", ["read"]) }]);
    inTeam("team-A");
    expect((await gateVerdict()).status).toBe(200);
  });

  it("(b) a private document whose read grant is INHERITED from its library serves a team-A member (200) — the egress route refuses today (KACL-5)", async () => {
    seed(VIEWER, { visibility: "private" });
    setLibrary(teamGrant("team-A", ["discover", "read"]));
    inTeam("team-A");
    expect((await gateVerdict()).status).toBe(200);
    seed(VIEWER, { visibility: "private" });
    setLibrary(teamGrant("team-A", ["discover", "read"]));
    inTeam("team-A");
    expect((await egressVerdict()).status).toBe(403);
  });

  it("an inherited DISCOVER-only grant on a private document is not enough (DOCACL-5)", async () => {
    seed(VIEWER, { visibility: "private" });
    setFolder(teamGrant("team-A", ["discover"]));
    inTeam("team-A");
    expect((await gateVerdict()).status).toBe(403);
  });

  it("an org-wide library grant serves everyone the document does not deny", async () => {
    const everyone = { rules: [{ effect: "allow", subject: { type: "org", id: ORG }, actions: ["discover", "read"] }] };
    const denyU1 = { rules: [{ effect: "deny", subject: { type: "user", id: "u1" }, actions: ["read"] }] };
    seed(VIEWER, DOCS.normal);
    setLibrary(everyone);
    expect((await gateVerdict()).status).toBe(200);
    seed(VIEWER, { acl: denyU1 });
    setLibrary(everyone);
    expect((await gateVerdict()).status).toBe(403);
  });

  it("a folder that does not inherit starts the chain again (the engine's own inherit semantics)", async () => {
    seed(VIEWER, DOCS.normal);
    setLibrary(teamGrant("team-A", ["read"]));
    setFolder({ inherit: false, rules: [{ effect: "allow", subject: { type: "org", id: ORG }, actions: ["read"] }] });
    expect((await gateVerdict()).status).toBe(200);
  });

  it("a download deny in the LIVE chain binds before the index is rebuilt — an org-subject one binds an Admin", async () => {
    seed(MEMBERS.admin, DOCS.normal);
    setLibrary({ rules: [{ effect: "deny", subject: { type: "org", id: ORG }, actions: ["download"] }] });
    expect((await gateVerdict()).status).toBe(403);
    expect(restrictedReads()).toHaveLength(0);
  });

  it("DEC-43: a controller served a normal document ONLY by the tier (a library allow-list excludes them) is recorded", async () => {
    seed(MEMBERS.additiveDocCtrl, DOCS.normal);
    setLibrary(teamGrant("team-A", ["read"]));
    const g = await gateVerdict();
    expect(g).toEqual({ status: 200, recorded: 1 });
    // …and not when the chain admits the Manager they also are.
    seed(MEMBERS.additiveDocCtrl, DOCS.normal);
    setLibrary({ rules: [{ effect: "allow", subject: { type: "role", id: "Manager" }, actions: ["read"] }] });
    expect(await gateVerdict()).toEqual({ status: 200, recorded: 0 });
  });

  it("the gate never serves what read-or-download over the chain would refuse — the one divergence from the library page's read listing is a download-only grant, named", async () => {
    const lib = teamGrant("team-A", ["read"]);
    const fixtures: Array<{ doc: Record<string, unknown>; library: unknown; team: string | null }> = [];
    for (const doc of Object.values(DOCS)) {
      for (const library of [null, lib]) for (const team of [null, "team-A"]) fixtures.push({ doc, library, team });
    }
    let served = 0;
    const servedWithoutRead = new Set<string>();
    for (const [who, member] of Object.entries(MEMBERS)) {
      for (const f of fixtures) {
        seed(member, f.doc);
        setLibrary(f.library);
        inTeam(f.team);
        const g = await gateVerdict();
        if (g.status !== 200) continue;
        served++;
        const principal: Principal = {
          uid: "u1", role: member.role as Principal["role"], roles: member.roles as Principal["roles"],
          orgId: ORG, teamIds: f.team ? [f.team] : [], isActiveMember: true,
        };
        // The library page: canWithAclChain(read) over library → folder →
        // document, default-allow (documents/[libraryId]/page.tsx).
        const aclChain = [f.library, null, f.doc.acl].map((a) => (a ?? undefined) as AccessControl | undefined);
        const pageMayRead = (action: "read" | "download") => canWithAclChain({
          principal, action, aclChain, defaultAllow: true,
          effectiveOwnerUserId: "someone-else",
        });
        expect(pageMayRead("read") || pageMayRead("download")).toBe(true);
        // The library page lists by READ alone; the gate (like the bytes
        // egress) also serves a DOWNLOAD grant. Collect where that differs.
        if (!pageMayRead("read")) {
          const docName = Object.entries(DOCS).find(([, d]) => d === f.doc)![0];
          servedWithoutRead.add(`${who} × ${docName}`);
        }
      }
    }
    expect(served).toBeGreaterThan(20);
    expect(servedWithoutRead).toEqual(new Set(["viewer × privateDownloadGrant", "manager × privateDownloadGrant"]));
  });

  it("fails CLOSED: a library, folder or ancestor that cannot be READ is 503 ('try again'), never 'no ACL'", async () => {
    const cases: Array<[string, () => void]> = [
      ["library read error", () => { state.tables.libraries = { data: null, error: { message: "boom" } }; }],
      ["folder read error", () => { state.single.collections = { data: null, error: { message: "boom" } }; }],
      ["ancestor read error", () => { setFolder(null, ["c0"]); state.tables.collections = { data: null, error: { message: "boom" } }; }],
    ];
    for (const [label, breakIt] of cases) {
      seed(MEMBERS.viewer, DOCS.normal);
      breakIt();
      expect(await resolveDocumentFile(ORG, "d1", { uid: "u1", channel: "test" }), label)
        .toEqual({ ok: false, status: 503, error: DOC_ACCESS_UNVERIFIED });
      expect(state.calls.filter((c) => c.table === "document_versions"), label).toHaveLength(0);
    }
  });

  it("fails CLOSED on a BROKEN chain too — a rung that does not exist is 409 naming it, not a retry, and it binds a controller", async () => {
    const cases: Array<[string, () => void, string]> = [
      ["library missing", () => { state.tables.libraries = { data: null }; }, docChainBrokenMessage("library", "l1")],
      ["folder missing", () => { state.single.collections = { data: null }; }, docChainBrokenMessage("folder", "c1")],
      ["ancestor missing (a stale path_ids rung)", () => { setFolder(null, ["c0", "c00"]); setAncestors([{ id: "c0", acl: null }]); },
        docChainBrokenMessage("folder", "c00")],
      ["no library recorded", () => {
        state.tables.documents = { data: { ...(state.tables.documents.data as object), library_id: null } };
        state.single.collections = { data: { id: "c1", library_id: null, path_ids: [], acl: null } };
      }, docChainBrokenMessage("library", null)],
    ];
    for (const member of [MEMBERS.viewer, MEMBERS.admin]) {
      for (const [label, breakIt, message] of cases) {
        seed(member, DOCS.normal);
        breakIt();
        expect(await resolveDocumentFile(ORG, "d1", { uid: "u1", channel: "test" }), label)
          .toEqual({ ok: false, status: 409, error: message });
        expect(state.calls.filter((c) => c.table === "document_versions"), label).toHaveLength(0);
        expect(restrictedReads(), label).toHaveLength(0);
      }
    }
    expect(docChainBrokenMessage("folder", "c00")).toBe(
      "This document's folder chain is broken (folder c00 no longer exists), so access to it can't be checked. "
      + "A document controller needs to repair the folder chain — trying again won't help.");
    // The loader itself: an intact chain resolves; a stale rung throws the typed error naming it.
    seed(MEMBERS.viewer, DOCS.normal);
    await expect(loadContainerAclChain(ORG, { collectionId: "c1" }).then(() => null, (e: unknown) => e))
      .resolves.toBeNull();
    setFolder(null, ["gone"]);
    const err = await loadContainerAclChain(ORG, { collectionId: "c1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokenAclChainError);
    expect(err).toMatchObject({ rung: "folder", missingId: "gone" });
  });

  it("a root document (no folder) reads only its library; every chain read is org-scoped", async () => {
    seed(VIEWER, { collection_id: null });
    expect((await gateVerdict()).status).toBe(200);
    expect(state.calls.filter((c) => c.table === "collections")).toHaveLength(0);
    seed(VIEWER, DOCS.normal);
    setFolder(null, ["c0"]);
    setAncestors([{ id: "c0", acl: null }]);
    await gateVerdict();
    const orgScoped = (table: string) => state.calls
      .filter((c) => c.table === table && c.method === "select").length
      === state.calls.filter((c) => c.table === table && c.method === "eq" && c.args[0] === "org_id" && c.args[1] === ORG).length;
    expect(state.calls.filter((c) => c.table === "collections" && c.method === "select")).toHaveLength(2);
    expect(orgScoped("collections")).toBe(true);
    expect(orgScoped("libraries")).toBe(true);
  });

  it("loadContainerAclChain: library first, then ancestors root-first, then the folder", async () => {
    seed(VIEWER, DOCS.normal);
    setLibrary({ rules: [], tag: "lib" });
    setFolder({ rules: [], tag: "folder" }, ["root", "mid"]);
    setAncestors([{ id: "mid", acl: { rules: [], tag: "mid" } }, { id: "root", acl: { rules: [], tag: "root" } }]);
    const chainTags = (await loadContainerAclChain(ORG, { collectionId: "c1" }))
      .map((a) => (a as unknown as { tag: string }).tag);
    expect(chainTags).toEqual(["lib", "root", "mid", "folder"]);
  });
});

describe("resolveDocumentFile — the required reader, fail-closed lookups, and the file it resolves", () => {
  it("resolves the current version's key and label for a reader who may read it", async () => {
    const r = await resolveDocumentFile(ORG, "d1", { uid: "u1", channel: "test" });
    expect(r).toEqual({ ok: true, file: { documentId: "d1", label: "HSE-7", fileKey: KEY, fileType: "application/pdf" } });
  });
  it("refuses a reader who is not an active member", async () => {
    seed(null, DOCS.normal);
    expect(await resolveDocumentFile(ORG, "d1", { uid: "u1", channel: "test" })).toEqual({ ok: false, status: 403, error: DOC_READ_DENIED });
  });
  it("a membership or document lookup error is 503, never a guess", async () => {
    state.tables.team_members = { data: null, error: { message: "boom" } };
    expect(await resolveDocumentFile(ORG, "d1", { uid: "u1", channel: "test" })).toEqual({ ok: false, status: 503, error: DOC_ACCESS_UNVERIFIED });
    seed(MEMBERS.viewer, DOCS.normal);
    state.tables.documents = { data: null, error: { message: "boom" } };
    expect(await resolveDocumentFile(ORG, "d1", { uid: "u1", channel: "test" })).toEqual({ ok: false, status: 503, error: DOC_ACCESS_UNVERIFIED });
  });
  it("a missing document, pointer or file is 404 — decided AFTER the ACL, so a refusal never reveals it", async () => {
    state.tables.documents = { data: null };
    expect(await resolveDocumentFile(ORG, "d1", { uid: "u1", channel: "test" })).toEqual({ ok: false, status: 404, error: DOC_NO_FILE });
    seed(MEMBERS.viewer, { current_version_id: null });
    expect((await resolveDocumentFile(ORG, "d1", { uid: "u1", channel: "test" })).ok).toBe(false);
    seed(MEMBERS.viewer, { visibility: "private", current_version_id: null });
    expect(await resolveDocumentFile(ORG, "d1", { uid: "u1", channel: "test" })).toEqual({ ok: false, status: 403, error: DOC_READ_DENIED });
  });
  it("the pending version is the fallback when nothing is current", async () => {
    seed(MEMBERS.viewer, { current_version_id: null, pending_version_id: "v2" });
    expect((await resolveDocumentFile(ORG, "d1", { uid: "u1", channel: "test" })).ok).toBe(true);
  });
  it("SEC-10: the version is bound to the document the decision was made on — a pointer naming ANOTHER document's version resolves nothing", async () => {
    const KEY_B = `orgs/${ORG}/libraries/l1/HSE-private.pdf`;
    // d1 is readable to each reader (a normal document to the viewer; a
    // private one to the Admin, whose served read WOULD write a DEC-43 row);
    // its member-writable pointer names private document dB's version vB.
    for (const [member, doc] of [[MEMBERS.viewer, DOCS.normal], [MEMBERS.admin, DOCS.privateNoAcl]] as const) {
      for (const pointer of [{ current_version_id: "vB" }, { current_version_id: null, pending_version_id: "vB" }]) {
        seed(member, { ...doc, ...pointer });
        state.tables.document_versions = { data: { id: "vB", record_id: "dB", org_id: ORG, file_url: KEY_B, file_type: "application/pdf" } };
        expect(await resolveDocumentFile(ORG, "d1", { uid: "u1", channel: "test" }))
          .toEqual({ ok: false, status: 404, error: DOC_NO_FILE });
        expect(restrictedReads()).toHaveLength(0);
        // The version read carried the binding — the id, the evaluated document, the org.
        const ver = state.calls.filter((c) => c.table === "document_versions");
        const verEqs = ver.filter((c) => c.method === "eq").map((c) => c.args);
        expect(verEqs).toEqual([["id", "vB"], ["record_id", "d1"], ["org_id", ORG]]);
      }
    }
    // The same pointer naming d1's OWN version serves it (and the Admin's controller-only read is recorded).
    seed(MEMBERS.admin, { ...DOCS.privateNoAcl, current_version_id: "v9" });
    state.tables.document_versions = { data: { id: "v9", record_id: "d1", org_id: ORG, file_url: KEY, file_type: "application/pdf" } };
    const r = await resolveDocumentFile(ORG, "d1", { uid: "u1", channel: "test" });
    expect(r).toEqual({ ok: true, file: { documentId: "d1", label: "HSE-7", fileKey: KEY, fileType: "application/pdf" } });
    expect(restrictedReads()).toHaveLength(1);
  });
  it("labelOnly: a controller-only label read is served but leaves no CONTROLLER_RESTRICTED_READ row", async () => {
    seed(MEMBERS.admin, DOCS.privateNoAcl);
    const r = await resolveDocumentFile(ORG, "d1", { uid: "u1", channel: "test", labelOnly: true });
    expect(r.ok).toBe(true);
    expect(restrictedReads()).toHaveLength(0);
    seed(MEMBERS.admin, DOCS.privateNoAcl);
    await resolveDocumentFile(ORG, "d1", { uid: "u1", email: "a@x", channel: "quality_manual" });
    expect(restrictedReads()).toHaveLength(1);
    expect(restrictedReads()[0].row).toMatchObject({
      resource_type: "document", resource_id: "d1", org_id: ORG, user_id: "u1", user_email: "a@x",
      details: { path: KEY, visibility: "private", channel: "quality_manual" },
    });
  });
});

describe("documentContentDecision / discoverableDocuments — pure", () => {
  const principal = (roles: string[], role = roles[0] ?? "Viewer"): Principal =>
    ({ uid: "u1", role: role as Principal["role"], roles: roles as Principal["roles"], orgId: ORG, teamIds: ["t1"], isActiveMember: true });

  it("a team download deny binds; a deny naming someone else does not", () => {
    expect(documentContentDecision(principal(["Viewer"]), { acl_index: { deny: { teams: { download: ["t1"] } } } }).downloadDenied).toBe(true);
    expect(documentContentDecision(principal(["Viewer"]), { acl_index: { deny: { users: { download: ["u2"] } } } }).downloadDenied).toBe(false);
  });
  it("the explicit owner is served without a bypass; a controller on a node they are not admitted to is a bypass", () => {
    expect(documentContentDecision(principal(["Viewer"]), { visibility: "private", owner_user_id: "u1" }))
      .toEqual({ served: true, controllerBypass: false, downloadDenied: false });
    expect(documentContentDecision(principal(["Manager", "DocCtrl"], "Manager"), { visibility: "hidden" }))
      .toEqual({ served: true, controllerBypass: true, downloadDenied: false });
  });
  it("the container chain is part of the decision: a library allow-list binds a normal document; an inherited read serves a private one", () => {
    const lib = teamGrant("t1", ["read"]) as AccessControl;
    const other = teamGrant("t9", ["read"]) as AccessControl;
    expect(documentContentDecision(principal(["Viewer"]), {}, [other]).served).toBe(false);
    expect(documentContentDecision(principal(["Viewer"]), {}, [lib]).served).toBe(true);
    expect(documentContentDecision(principal(["Viewer"]), { visibility: "private" }, [lib]).served).toBe(true);
    expect(documentContentDecision(principal(["Viewer"]), { visibility: "private" }, []).served).toBe(false);
    // No ACL anywhere: a normal document is open.
    expect(documentContentDecision(principal(["Viewer"]), {}, [undefined, undefined]).served).toBe(true);
    // An org-subject download deny in the index binds.
    expect(documentContentDecision(principal(["Admin"]), { acl_index: { deny: { orgs: { download: [ORG] } } } }).downloadDenied).toBe(true);
  });
  it("discoverableDocuments keeps what the reader may discover — normal, owned, or granted discover", () => {
    const rows = [
      { id: "a", visibility: "normal" },
      { id: "b", visibility: "hidden" },
      { id: "c", visibility: "private", owner_user_id: "u1" },
      { id: "d", visibility: "hidden", acl: grant("u1", ["discover"]) },
      { id: "e", visibility: "normal", acl: { rules: [{ effect: "deny", subject: { type: "user", id: "u1" }, actions: ["discover"] }] } },
    ];
    expect(discoverableDocuments(principal(["Viewer"]), rows).map((r) => r.id)).toEqual(["a", "c", "d"]);
    expect(discoverableDocuments(principal(["Admin"]), rows).map((r) => r.id)).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("discoverableDocuments reads the shared container chain: a library allow-list hides normal titles; an inherited discover keeps a private one", () => {
    const rows = [{ id: "n", visibility: "normal" }, { id: "p", visibility: "private" }];
    const others = teamGrant("t9", ["discover", "read"]) as AccessControl;
    const mine = teamGrant("t1", ["discover"]) as AccessControl;
    expect(discoverableDocuments(principal(["Viewer"]), rows, [others]).map((r) => r.id)).toEqual([]);
    expect(discoverableDocuments(principal(["Viewer"]), rows, [mine]).map((r) => r.id)).toEqual(["n", "p"]);
  });
  it("loadReaderPrincipal builds the collection from the headline and the additive roles", async () => {
    seed(MEMBERS.additiveDocCtrl, DOCS.normal);
    state.tables.team_members = { data: [{ team_id: "t9" }] };
    expect(await loadReaderPrincipal(ORG, "u1")).toEqual({
      uid: "u1", role: "Manager", roles: ["Manager", "DocCtrl"], orgId: ORG, teamIds: ["t9"], isActiveMember: true,
    });
  });
});
