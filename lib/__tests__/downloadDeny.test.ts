// document-control Round F wave 2 — P1 SHARE verification fix (public-surfaces
// SHR-3 criterion 3): the explicit ACL "deny download" rule lives in ONE
// helper, lib/downloadDeny.ts. /api/storage/download-url applies it to the
// signed-in member (unchanged evaluation, unchanged fail-open posture);
// lib/shareServe.ts applies it to a share's creator (shareRoutes.test.ts
// drives that half through both public routes).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com" } as { id: string; email?: string } | null,
  tables: {} as Record<string, { data?: unknown; error?: unknown }>,
  reads: [] as string[],
  signed: 0,
}));

function chain(table: string) {
  const result = () => state.tables[table] ?? { data: null, error: null };
  const c: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        state.reads.push(table);
        const r = result();
        return (resolve: (v: unknown) => void) => resolve({ data: r.data ?? null, error: r.error ?? null });
      }
      return (..._args: unknown[]) => {
        if (prop === "maybeSingle" || prop === "single") {
          state.reads.push(table);
          const r = result();
          const d = Array.isArray(r.data) ? (r.data[0] ?? null) : (r.data ?? null);
          return Promise.resolve({ data: d, error: r.error ?? null });
        }
        return new Proxy(c, handler);
      };
    },
  };
  return new Proxy(c, handler);
}
const client = { from: (t: string) => chain(t) };

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: {
      getUser: vi.fn(async () =>
        state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }),
    },
    from: (t: string) => chain(t),
    rpc: vi.fn(async () => ({ data: false, error: null })),
  },
}));
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => ({})) }, R2_BUCKET: "test-bucket" }));
vi.mock("@aws-sdk/client-s3", () => ({ GetObjectCommand: class {} }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async () => { state.signed++; return "https://signed.example/get"; }),
}));

import { downloadDenyPresent, downloadDeniedTo, memberDownloadDenied, type DownloadDenyClient } from "@/lib/downloadDeny";
import { GET as downloadUrl } from "@/app/api/storage/download-url/route";

const ORG = "12345678-1234-1234-1234-123456789abc";
const KEY = `orgs/${ORG}/documents/lib/P-101.pdf`;
const download = () => downloadUrl(new NextRequest(
  `https://app/api/storage/download-url?path=${encodeURIComponent(KEY)}`,
  { headers: { authorization: "Bearer t" } },
));
const withIndex = (deny: Record<string, unknown>) => ({ allow: {}, deny });

beforeEach(() => {
  state.user = { id: "u1", email: "u1@example.com" };
  state.tables = {};
  state.reads = [];
  state.signed = 0;
});

describe("lib/downloadDeny — the rule", () => {
  it("downloadDenyPresent: only a non-empty download list under deny counts", () => {
    expect(downloadDenyPresent(null)).toBe(false);
    expect(downloadDenyPresent(undefined)).toBe(false);
    expect(downloadDenyPresent({ deny: null })).toBe(false);
    expect(downloadDenyPresent(withIndex({ users: { read: ["u1"] } }))).toBe(false);
    expect(downloadDenyPresent(withIndex({ users: { download: [] } }))).toBe(false);
    expect(downloadDenyPresent(withIndex({ users: { download: ["u1"] } }))).toBe(true);
    expect(downloadDenyPresent(withIndex({ roles: { download: ["Viewer"] } }))).toBe(true);
    expect(downloadDenyPresent(withIndex({ teams: { download: ["t1"] } }))).toBe(true);
    // an ALLOW-side download entry is not a deny
    expect(downloadDenyPresent({ allow: { users: { download: ["u1"] } }, deny: {} } as never)).toBe(false);
  });
  it("downloadDeniedTo: by uid, by ANY held role (the headline is not special), by any team; controllers are not exempt", () => {
    const who = { uid: "u1", roles: ["Manager", "Contractor"], teamIds: ["t1", "t2"] };
    expect(downloadDeniedTo(withIndex({ users: { download: ["u1"] } }), who)).toBe(true);
    expect(downloadDeniedTo(withIndex({ roles: { download: ["Contractor"] } }), who)).toBe(true);
    expect(downloadDeniedTo(withIndex({ teams: { download: ["t2"] } }), who)).toBe(true);
    expect(downloadDeniedTo(withIndex({ users: { download: ["u1"] } }), { ...who, roles: ["Admin"] })).toBe(true);
    expect(downloadDeniedTo(withIndex({ users: { download: ["u2"] }, roles: { download: ["Viewer"] }, teams: { download: ["t9"] } }), who)).toBe(false);
    expect(downloadDeniedTo(withIndex({ users: { read: ["u1"] } }), who)).toBe(false);
    expect(downloadDeniedTo(null, who)).toBe(false);
  });
  it("memberDownloadDenied: no I/O without a download deny; reads the ACTIVE membership's collection and the teams; reports a read error as unreadable", async () => {
    const sb = client as unknown as DownloadDenyClient;
    expect(await memberDownloadDenied(sb, { orgId: ORG, uid: "u1", aclIndex: withIndex({ users: { read: ["u1"] } }) })).toEqual({ denied: false, unreadable: false });
    expect(state.reads).toEqual([]);
    // roles: [] with a headline still carries the headline (normalizeRoles seeds from it)
    state.tables = { org_members: { data: { role: "Contractor", roles: [] } }, team_members: { data: [] } };
    expect(await memberDownloadDenied(sb, { orgId: ORG, uid: "u1", aclIndex: withIndex({ roles: { download: ["Contractor"] } }) })).toEqual({ denied: true, unreadable: false });
    expect(state.reads.sort()).toEqual(["org_members", "team_members"]);
    // no membership row reads as Viewer (the route's historical default)
    state.tables = { org_members: { data: null }, team_members: { data: [] } };
    expect((await memberDownloadDenied(sb, { orgId: ORG, uid: "u1", aclIndex: withIndex({ roles: { download: ["Viewer"] } }) })).denied).toBe(true);
    // a team read error: evaluated on what was read, and flagged
    state.tables = { org_members: { data: { role: "Engineer-2", roles: ["Engineer-2"] } }, team_members: { data: null, error: { message: "down" } } };
    expect(await memberDownloadDenied(sb, { orgId: ORG, uid: "u1", aclIndex: withIndex({ teams: { download: ["t1"] } }) })).toEqual({ denied: false, unreadable: true });
    expect(await memberDownloadDenied(sb, { orgId: ORG, uid: "u1", aclIndex: withIndex({ users: { download: ["u1"] } }) })).toEqual({ denied: true, unreadable: true });
  });
});

describe("GET /api/storage/download-url — the member half, through the one helper", () => {
  const member = (roles: string[], teams: string[] = []) => ({
    org_members: { data: { uid: "u1", role: roles[0], roles } },
    team_members: { data: teams.map((team_id) => ({ team_id })) },
    document_versions: { data: { record_id: "docA" } },
  });
  const doc = (acl_index: unknown) => ({ data: { visibility: "normal", acl: null, acl_index, org_id: ORG, owner_user_id: null, collection_id: null, library_id: "lib1" } });

  it("a member named by a download deny (uid / role / team) is refused 403 and nothing is signed; anyone else is signed", async () => {
    for (const [label, tables] of [
      ["uid", { ...member(["Engineer-2"]), documents: doc(withIndex({ users: { download: ["u1"] } })) }],
      ["additive role", { ...member(["Engineer-2", "Contractor"]), documents: doc(withIndex({ roles: { download: ["Contractor"] } })) }],
      ["team", { ...member(["Engineer-2"], ["t1"]), documents: doc(withIndex({ teams: { download: ["t1"] } })) }],
      ["a controller named by uid", { ...member(["Admin"]), documents: doc(withIndex({ users: { download: ["u1"] } })) }],
    ] as Array<[string, Record<string, { data?: unknown; error?: unknown }>]>) {
      state.tables = tables; state.signed = 0;
      const res = await download();
      expect(res.status, label).toBe(403);
      expect(await res.json(), label).toEqual({ error: "Downloading this document is denied for your account" });
      expect(state.signed, label).toBe(0);
    }
    state.tables = { ...member(["Engineer-2"], ["t1"]), documents: doc(withIndex({ users: { download: ["u2"] }, teams: { download: ["t2"] } })) };
    expect((await download()).status).toBe(200);
    expect(state.signed).toBe(1);
  });
  it("keeps its fail-open posture on a read error: evaluated on what was read", async () => {
    state.tables = { ...member(["Engineer-2"]), team_members: { data: null, error: { message: "down" } }, documents: doc(withIndex({ teams: { download: ["t1"] } })) };
    expect((await download()).status).toBe(200);
    state.tables = { ...member(["Engineer-2"]), team_members: { data: null, error: { message: "down" } }, documents: doc(withIndex({ users: { download: ["u1"] } })) };
    expect((await download()).status).toBe(403);
  });
});
