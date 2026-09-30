// projects Round G — SEC-10: lib/docFileServer is the gate every
// service-role page read of a doc-control document goes through, and it
// must make the SAME content decision the bytes egress
// (/api/storage/download-url) makes. A member who cannot pull a document's
// bytes must not be able to have its pages read back to them by the
// checklist or quality-manual readers — and a controller-only read must be
// recorded in both places (DEC-43).
//
// The parity matrix below runs the real route and the real gate over the
// same principal × document fixtures and asserts they agree, so a change to
// either decision that the other does not share fails here.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com" } as { id: string; email?: string } | null,
  tables: {} as Record<string, { data?: unknown; error?: unknown }>,
  rpc: {} as Record<string, { data?: unknown; error?: unknown }>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));

function chain(table: string) {
  const result = () => state.tables[table] ?? { data: null, error: null };
  const c: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        const r = result();
        return (resolve: (v: unknown) => void) => resolve({ data: r.data ?? null, error: r.error ?? null });
      }
      return (...args: unknown[]) => {
        if (prop === "insert") state.inserts.push({ table, row: args[0] as Record<string, unknown> });
        if (prop === "maybeSingle" || prop === "single") {
          const r = result();
          return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
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
  resolveDocumentFile, documentContentDecision, discoverableDocuments, loadReaderPrincipal,
  DOC_READ_DENIED, DOC_NO_FILE, DOC_ACCESS_UNVERIFIED,
} from "@/lib/docFileServer";
import type { Principal } from "@/lib/permissions";

const ORG = "12345678-1234-1234-1234-123456789abc";
const KEY = `orgs/${ORG}/libraries/l1/HSE-7.pdf`;
const grant = (uid: string, actions: string[]) =>
  ({ rules: [{ effect: "allow", subject: { type: "user", id: uid }, actions }] });

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
};

function seed(member: { role: string; roles: string[] } | null, doc: Record<string, unknown>, owner = false) {
  state.user = { id: "u1", email: "u1@example.com" };
  state.tables = {
    org_members: { data: member ? { uid: "u1", status: "active", ...member } : null },
    team_members: { data: [] },
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

describe("SEC-10 parity: the page-read gate and the bytes egress decide alike", () => {
  for (const [who, member] of Object.entries(MEMBERS)) {
    for (const [what, doc] of Object.entries(DOCS)) {
      for (const owner of [false, true]) {
        it(`${who} × ${what}${owner ? " × effective owner" : ""}`, async () => {
          seed(member, doc, owner);
          const egress = await egressVerdict();
          seed(member, doc, owner);
          const gate = await gateVerdict();
          expect(gate.status, "served / refused").toBe(egress.status);
          // DEC-43: a served controller-only read is recorded by both. (The
          // egress route writes its row before its download-deny check; the
          // gate never records a read it then refuses.)
          if (gate.status === 200) expect(gate.recorded, "CONTROLLER_RESTRICTED_READ").toBe(egress.recorded);
          else expect(gate.recorded).toBe(0);
        });
      }
    }
  }

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
  it("loadReaderPrincipal builds the collection from the headline and the additive roles", async () => {
    seed(MEMBERS.additiveDocCtrl, DOCS.normal);
    state.tables.team_members = { data: [{ team_id: "t9" }] };
    expect(await loadReaderPrincipal(ORG, "u1")).toEqual({
      uid: "u1", role: "Manager", roles: ["Manager", "DocCtrl"], orgId: ORG, teamIds: ["t9"], isActiveMember: true,
    });
  });
});
