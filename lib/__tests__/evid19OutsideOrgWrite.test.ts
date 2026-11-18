// drafting-flow EVID-19 (DEC-90: deny by default, allow-list what
// legitimately exists): neither signing door — /api/storage/upload-url and
// /api/storage/multipart create / complete — signs a write to a key OUTSIDE
// orgs/<uuid>/ except what lib/storageWriteAllowList.ts allows:
//   - `avatars/<uid>/…` for that uid alone (lib/userProfiles.ts saveMyAvatar);
//   - a legacy request file for the backup restore's put-back: an active Admin
//     of EVERY workspace whose request lists the key, and only while the
//     object is absent (listed and stored → EVID-17's 409).
// Everything else is 403 in plain words with nothing signed; a lookup or
// storage check that cannot be made is a 503. The orgs/<uuid>/ branch is
// untouched: every key the app's writers mint is pinned signed exactly as
// before, and the writer census below fails when a new writer appears.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest } from "next/server";

const ORG_A = "12345678-1234-1234-1234-123456789abc";
const ORG_B = "87654321-4321-4321-4321-cba987654321";
const LEGACY = "tickets/REQ-7/1600000000000_iso_IFC.pdf"; // a pre-orgs/ request file

type Member = { org_id: string; uid: string; role: string; roles: string[]; status?: string };

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com" } as { id: string; email?: string } | null,
  /** legacy key → the workspaces whose requests list it */
  listedBy: {} as Record<string, Array<string | null>>,
  ticketsErr: null as null | { message: string },
  membersErr: null as null | { message: string },
  members: [] as Member[],
  stored: [] as string[],
  headErr: null as null | Error,
  versionClash: false,
  reads: [] as Array<{ table: string; filters: Array<[string, unknown[]]> }>,
  signed: [] as Array<{ key: string; contentType?: unknown }>,
  sends: [] as Array<{ name: string; key: string }>,
}));

function chain(table: string) {
  const filters: Array<[string, unknown[]]> = [];
  const arg = (m: string, i = 0) => filters.find(([f, a]) => f === m && (i === 0 || a.length > i))?.[1];
  const eqs = () => Object.fromEntries(filters.filter(([f]) => f === "eq").map(([, a]) => [a[0], a[1]]));
  const result = (single: boolean) => {
    if (table === "org_members") {
      if (state.membersErr) return { data: null, error: state.membersErr };
      const e = eqs();
      const inOrgs = arg("in")?.[1] as string[] | undefined;
      const rows = state.members.filter((m) => m.uid === e.uid && (m.status ?? "active") === e.status
        && (e.org_id === undefined || m.org_id === e.org_id) && (!inOrgs || inOrgs.includes(m.org_id)));
      return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
    }
    if (table === "document_versions") return { data: state.versionClash ? { id: "v1" } : null, error: null };
    if (table === "tickets") {
      if (state.ticketsErr) return { data: null, error: state.ticketsErr };
      const c = arg("contains");
      const url = c ? (JSON.parse(String(c[1])) as Array<{ url: string }>)[0].url : null;
      const orgEq = eqs().org_id as string | undefined;
      const orgs = (url && state.listedBy[url]) || [];
      const rows = orgs.filter((o) => orgEq === undefined || o === orgEq).map((o) => ({ id: `t-${o}`, org_id: o }));
      return { data: rows, error: null };
    }
    if (table === "audit_logs") return { data: null, error: null };
    return { data: null, error: null };
  };
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        state.reads.push({ table, filters: [...filters] });
        const r = result(false);
        return (resolve: (v: unknown) => void) => resolve(r);
      }
      return (...args: unknown[]) => {
        filters.push([prop, args]);
        if (prop === "maybeSingle" || prop === "single") {
          state.reads.push({ table, filters: [...filters] });
          return Promise.resolve(result(true));
        }
        if (prop === "insert") return Promise.resolve({ data: null, error: null });
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => (state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } })) },
    from: (t: string) => chain(t),
  },
}));
vi.mock("@/lib/serverAuth", () => ({ enforceOrgAccess: vi.fn(async () => null) }));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "b",
  r2: {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: { Key: string } }) => {
      const name = cmd.constructor.name;
      state.sends.push({ name, key: cmd.input.Key });
      if (name === "HeadObjectCommand") {
        if (state.headErr) throw state.headErr;
        if (!state.stored.includes(cmd.input.Key)) throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
        return { ContentLength: 10 };
      }
      if (name === "CreateMultipartUploadCommand") return { UploadId: "up-1" };
      return {};
    }),
  },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_c: unknown, cmd: { input: { Key: string; ContentType?: unknown } }) => {
    state.signed.push({ key: cmd.input.Key, contentType: cmd.input.ContentType });
    return "https://signed.example/put";
  }),
}));

import { POST as uploadUrl } from "@/app/api/storage/upload-url/route";
import { POST as multipart } from "@/app/api/storage/multipart/route";
import {
  outsideOrgWriteRefusal, avatarKeyOwner, isOrgKey,
  OUTSIDE_ORG_REFUSAL, AVATAR_NOT_YOURS_REFUSAL, LEGACY_KEY_NOT_ADMIN_REFUSAL, OUTSIDE_ORG_UNVERIFIED,
} from "@/lib/storageWriteAllowList";
import { TICKET_KEY_LISTED_REFUSAL } from "@/lib/ticketKeyOverwrite";
import { restoreUploadRequest } from "@/lib/storageKey";
import { makeLibraryStoragePath, makeTicketAttachmentPath, makeUserPrivatePath, uniqueUploadName } from "@/lib/storage";
import { ticketStagingFolder } from "@/lib/ticketCreate";

const up = (path: string, extra: Record<string, unknown> = { contentType: "application/pdf" }) =>
  uploadUrl(new NextRequest("https://app/api/storage/upload-url", {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ path, ...extra }),
  }));
const mp = (body: Record<string, unknown>) => multipart(new NextRequest("https://app/api/storage/multipart", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const SIGNED = (path: string) => JSON.stringify({ url: "https://signed.example/put", path });
const COMPLETE = { uploadId: "up-1", parts: [{ partNumber: 1, etag: "e" }] };
/** The allow-list's own reads: the unscoped listing (select org_id, no org
 *  filter) and the Admin lookup across workspaces (`in`). */
const allowListReads = () => state.reads.filter((r) =>
  (r.table === "tickets" && r.filters.some(([f, a]) => f === "select" && a[0] === "org_id"))
  || (r.table === "org_members" && r.filters.some(([f]) => f === "in")));
const sendNames = () => state.sends.map((s) => s.name);

const admin = (org: string, uid = "u1", roles = ["Admin"]): Member => ({ org_id: org, uid, role: roles[0], roles });

beforeEach(() => {
  state.user = { id: "u1", email: "u1@example.com" };
  state.listedBy = {}; state.ticketsErr = null; state.membersErr = null; state.members = [];
  state.stored = []; state.headErr = null; state.versionClash = false;
  state.reads = []; state.signed = []; state.sends = [];
});

describe("EVID-19 — upload-url: a key outside orgs/<uuid>/ is refused unless allow-listed", () => {
  it("REPRODUCED on base 96a7b81d: a legacy key workspace A's request lists, asked for by a user of workspace B — now 403 in plain words, nothing signed, storage never asked", async () => {
    state.user = { id: "u2" };
    state.members = [admin(ORG_B, "u2")];
    state.listedBy[LEGACY] = [ORG_A]; state.stored = [LEGACY];
    const res = await up(LEGACY);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: LEGACY_KEY_NOT_ADMIN_REFUSAL });
    expect(state.signed).toEqual([]);
    expect(state.sends).toEqual([]);
  });

  it("a plain member (not an Admin) of the very workspace whose request lists the legacy key is refused too", async () => {
    state.members = [{ org_id: ORG_A, uid: "u1", role: "Drafter", roles: ["Drafter", "Manager"] }];
    state.listedBy[LEGACY] = [ORG_A];
    const res = await up(LEGACY);
    expect(res.status).toBe(403);
    expect(state.signed).toEqual([]);
  });

  it("an INACTIVE Admin membership does not count", async () => {
    state.members = [{ ...admin(ORG_A), status: "suspended" }];
    state.listedBy[LEGACY] = [ORG_A];
    expect((await up(LEGACY)).status).toBe(403);
    expect(state.signed).toEqual([]);
  });

  it("a key nothing lists and no rule allows (a stray legacy key, the offline-archive data/ prefix, a non-uuid orgs/ folder) → 403 in plain words", async () => {
    for (const key of ["legacy/other/report.pdf", "data/archive-1.zip", "exports/run.zip", "orgs/acme/tickets/1_a.pdf", "public/index.html"]) {
      state.signed = [];
      const res = await up(key);
      expect(res.status, key).toBe(403);
      expect(await res.json(), key).toEqual({ error: OUTSIDE_ORG_REFUSAL });
      expect(state.signed, key).toEqual([]);
    }
  });

  it("REGRESSION — the caller's own avatar (lib/userProfiles.ts saveMyAvatar): signed exactly as before, the response byte-identical, nothing extra read", async () => {
    const key = "avatars/u1/avatar-0b9f2c1e-7a8d-4c1b-9e7f-3a2d1c0b9f8e.png";
    const res = await up(key, { contentType: "image/png", size: 1234 });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SIGNED(key));
    expect(state.signed).toEqual([{ key, contentType: "image/png" }]);
    expect(allowListReads()).toEqual([]);
    expect(state.sends).toEqual([]);
  });

  it("another user's avatar is refused (403, plain words, nothing signed)", async () => {
    for (const key of ["avatars/u2/avatar-1.png", "avatars/u1x/avatar-1.png", "avatars/u1.png"]) {
      state.signed = [];
      const res = await up(key, { contentType: "image/png" });
      expect(res.status, key).toBe(403);
      expect(state.signed, key).toEqual([]);
    }
    expect(await (await up("avatars/u2/avatar-1.png")).json()).toEqual({ error: AVATAR_NOT_YOURS_REFUSAL });
  });

  it("REGRESSION — the backup restore's put-back of a legacy request file (the page's own request body): an Admin of the workspace whose restored request lists it, the file absent → signed exactly as before", async () => {
    state.members = [admin(ORG_A, "u1", ["Manager", "Admin"])]; // Admin by the full role collection
    state.listedBy[LEGACY] = [ORG_A];
    const req = restoreUploadRequest(LEGACY, 4096);
    const res = await up(LEGACY, { contentType: req.body.contentType, size: req.body.size });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SIGNED(LEGACY));
    expect(state.signed).toEqual([{ key: LEGACY, contentType: "application/pdf" }]);
    expect(sendNames()).toEqual(["HeadObjectCommand"]);
  });

  it("EVID-17's rule applies to a legacy key: listed and stored is refused (409, its words) even for an Admin", async () => {
    state.members = [admin(ORG_A)];
    state.listedBy[LEGACY] = [ORG_A]; state.stored = [LEGACY];
    const res = await up(LEGACY);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: TICKET_KEY_LISTED_REFUSAL });
    expect(state.signed).toEqual([]);
  });

  it("a legacy key two workspaces' requests list is signed only for an Admin of BOTH (a planted listing in B cannot reach A's file)", async () => {
    state.listedBy[LEGACY] = [ORG_A, ORG_B];
    state.members = [admin(ORG_B)];
    expect((await up(LEGACY)).status).toBe(403);
    expect(state.sends).toEqual([]);
    state.members = [admin(ORG_A), admin(ORG_B)];
    expect((await up(LEGACY)).status).toBe(200);
  });

  it("fail closed: the request lookup, the membership lookup or the storage check errors → 503 in plain words, nothing signed", async () => {
    state.listedBy[LEGACY] = [ORG_A]; state.members = [admin(ORG_A)];
    state.ticketsErr = { message: "timeout" };
    let res = await up(LEGACY);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: OUTSIDE_ORG_UNVERIFIED });
    state.ticketsErr = null; state.membersErr = { message: "timeout" };
    res = await up(LEGACY);
    expect(res.status).toBe(503);
    state.membersErr = null; state.headErr = new Error("socket hang up");
    res = await up(LEGACY);
    expect(res.status).toBe(503);
    expect(state.signed).toEqual([]);
  });

  it("the orgs/<uuid>/ branch is unchanged: a non-member is refused with its own words and the allow-list reads nothing", async () => {
    const res = await up(`orgs/${ORG_A}/libraries/l1/x.pdf`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Not a member of this workspace" });
    expect(allowListReads()).toEqual([]);
  });

  it("PKG-1 still applies after the allow-list: the caller's own avatar key that is a version's bytes is refused with PKG-1's words", async () => {
    state.versionClash = true;
    const res = await up("avatars/u1/avatar-1.png", { contentType: "image/png" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already belongs to a published revision/);
  });
});

describe("EVID-19 — the multipart door: the same rule at create and at complete; sign and abort unchanged", () => {
  it("a cross-tenant legacy key: create and complete are refused (403) and nothing reaches storage", async () => {
    state.user = { id: "u2" };
    state.members = [admin(ORG_B, "u2")];
    state.listedBy[LEGACY] = [ORG_A];
    for (const action of ["create", "complete"]) {
      state.sends = [];
      const res = await mp({ action, path: LEGACY, contentType: "application/pdf", ...COMPLETE });
      expect(res.status, action).toBe(403);
      expect(await res.json(), action).toEqual({ error: LEGACY_KEY_NOT_ADMIN_REFUSAL });
      expect(state.sends, action).toEqual([]);
    }
  });

  it("an unlisted stray key and another user's avatar: create and complete refused", async () => {
    for (const path of ["legacy/scan.e57", "avatars/u2/avatar-1.png"]) {
      for (const action of ["create", "complete"]) {
        state.sends = [];
        const res = await mp({ action, path, contentType: "application/octet-stream", ...COMPLETE });
        expect(res.status, `${path} ${action}`).toBe(403);
        expect(state.sends, `${path} ${action}`).toEqual([]);
      }
    }
  });

  it("an upload opened by an Admin while the legacy file was absent cannot complete once the bytes are there (EVID-17's words)", async () => {
    state.members = [admin(ORG_A)]; state.listedBy[LEGACY] = [ORG_A];
    expect((await mp({ action: "create", path: LEGACY, contentType: "application/pdf" })).status).toBe(200);
    state.stored = [LEGACY]; state.sends = [];
    const res = await mp({ action: "complete", path: LEGACY, ...COMPLETE });
    expect(res.status).toBe(409);
    expect(sendNames()).toEqual(["HeadObjectCommand"]);
  });

  it("REGRESSION — the caller's own avatar: create, sign, complete and abort exactly as before", async () => {
    const key = "avatars/u1/avatar-big.png";
    expect(await (await mp({ action: "create", path: key, contentType: "image/png" })).text()).toBe(JSON.stringify({ uploadId: "up-1" }));
    expect(await (await mp({ action: "sign", path: key, uploadId: "up-1", partNumber: 1 })).text()).toBe(JSON.stringify({ url: "https://signed.example/put" }));
    expect(await (await mp({ action: "complete", path: key, ...COMPLETE })).text()).toBe(JSON.stringify({ ok: true }));
    expect(await (await mp({ action: "abort", path: key, uploadId: "up-1" })).text()).toBe(JSON.stringify({ ok: true }));
    expect(allowListReads()).toEqual([]);
  });

  it("REGRESSION — signing a part and aborting ask nothing, for any key (an abort must always work)", async () => {
    state.listedBy[LEGACY] = [ORG_A];
    expect((await mp({ action: "sign", path: LEGACY, uploadId: "up-1", partNumber: 1 })).status).toBe(200);
    expect((await mp({ action: "abort", path: LEGACY, uploadId: "up-1" })).status).toBe(200);
    expect(allowListReads()).toEqual([]);
  });

  it("fail closed at create and complete: a lookup error is 503, no upload opened or completed", async () => {
    state.listedBy[LEGACY] = [ORG_A]; state.members = [admin(ORG_A)];
    state.ticketsErr = { message: "timeout" };
    for (const action of ["create", "complete"]) {
      const res = await mp({ action, path: LEGACY, contentType: "application/pdf", ...COMPLETE });
      expect(res.status, action).toBe(503);
    }
    expect(sendNames().some((n) => n === "CreateMultipartUploadCommand" || n === "CompleteMultipartUploadCommand")).toBe(false);
  });
});

describe("EVID-19 — NO REGRESSION: every key the app's writers mint is signed exactly as before", () => {
  // One key per writer, minted the way the writer mints it (the real minting
  // function where one is exported, else the writer's template).
  const writers: Array<{ writer: string; key: string; extra?: Record<string, unknown> }> = [
    { writer: "lib/storage.ts uploadTicketAttachment (request page attach, IFC upload, redline)", key: makeTicketAttachmentPath({ orgId: ORG_A, ticketId: "REQ-7", filename: "iso IFC.pdf" }) },
    { writer: "requests/new + CheckInPanel staging folder", key: makeTicketAttachmentPath({ orgId: ORG_A, ticketId: ticketStagingFolder("0b9f2c1e-7a8d-4c1b-9e7f-3a2d1c0b9f8e", "1b9f2c1e-7a8d-4c1b-9e7f-3a2d1c0b9f8e"), filename: "a.pdf" }) },
    { writer: "documents/[libraryId] upload, lib/revisions.ts (5 sites), lib/documentLifecycle/common.ts", key: makeLibraryStoragePath({ orgId: ORG_A, libraryId: "lib1", folderPath: ["Area 1"], filename: uniqueUploadName("P-101.pdf", "3") }) },
    { writer: "lib/storage.ts uploadUserPrivateFile", key: makeUserPrivatePath({ orgId: ORG_A, uid: "u1", relativePath: "notes.pdf" }) },
    { writer: "admin/branding page + LogoUploadModal (workspace logo)", key: `orgs/${ORG_A}/branding/logo-0b9f2c1e.png`, extra: { contentType: "image/png", size: 2048 } },
    { writer: "CustomizeNodeModal cover", key: `orgs/${ORG_A}/branding/covers/0b9f2c1e.png`, extra: { contentType: "image/png" } },
    { writer: "CustomizeNodeModal background", key: `orgs/${ORG_A}/branding/backgrounds/0b9f2c1e.webp`, extra: { contentType: "image/webp" } },
    { writer: "AssetPhotoUploader", key: `orgs/${ORG_A}/assets/a1/photos/1763424000000-pump.jpg`, extra: { contentType: "image/jpeg" } },
    { writer: "lib/plotPlans.ts", key: `orgs/${ORG_A}/plot-plans/0b9f2c1e-7a8d-4c1b-9e7f-3a2d1c0b9f8e-site.png` },
    { writer: "lib/costDocs.ts", key: `orgs/${ORG_A}/project-costs/p1/0b9f2c1e-7a8d-4c1b-9e7f-3a2d1c0b9f8e-quote.pdf` },
    { writer: "lib/knowledge.ts", key: `orgs/${ORG_A}/knowledge/lib1/1763424000000-manual.pdf` },
    { writer: "lib/outputTemplates.ts (templates, examples, data)", key: `orgs/${ORG_A}/output-templates/1763424000000-form.docx` },
    { writer: "lib/storage.ts storageSelfTest", key: `orgs/${ORG_A}/diagnostics/probe-1763424000000.bin` },
  ];

  it.each(writers)("$writer — upload-url signs it with the byte-identical response, the allow-list reading nothing", async ({ key, extra }) => {
    state.members = [admin(ORG_A)];
    const res = await up(key, extra);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SIGNED(key));
    expect(state.signed.map((s) => s.key)).toEqual([key]);
    expect(allowListReads()).toEqual([]);
  });

  it.each(writers.filter((w) => !w.key.includes("/branding/logo-")))("$writer — multipart create and complete as before (a file of 64 MB or more)", async ({ key, extra }) => {
    state.members = [admin(ORG_A)];
    expect(await (await mp({ action: "create", path: key, contentType: (extra?.contentType as string) ?? "application/pdf" })).text()).toBe(JSON.stringify({ uploadId: "up-1" }));
    expect(await (await mp({ action: "complete", path: key, ...COMPLETE })).text()).toBe(JSON.stringify({ ok: true }));
    expect(allowListReads()).toEqual([]);
  });

  it("lib/userProfiles.ts still mints avatars under avatars/<the caller's uid>/ — the allow-list's avatar rule names that layout", () => {
    const src = readFileSync(join(process.cwd(), "lib/userProfiles.ts"), "utf8");
    expect(src).toContain("path = `avatars/${uid}/avatar-${rand}.${ext}`;");
    expect(avatarKeyOwner("avatars/u1/avatar-x.png")).toBe("u1");
    expect(isOrgKey(`orgs/${ORG_A}/x`)).toBe(true);
    expect(isOrgKey("orgs/acme/x")).toBe(false);
  });
});

describe("EVID-19 — writer census: every caller of the signing doors is in the inventory", () => {
  // The files that ask the two doors for a signed write (through
  // lib/storage.ts's upload helpers, or by fetching the route). A new caller
  // fails this test until its key layout is checked against the allow-list
  // and added here.
  const INVENTORY: Record<string, string> = {
    "app/(protected)/admin/branding/page.tsx": "orgs/<org>/branding/logo-…",
    "app/(protected)/admin/restore/page.tsx": "the backup's keys (org-remapped orgs/<org>/…, or a legacy request file — allow-list rule 2)",
    "app/(protected)/documents/[libraryId]/page.tsx": "orgs/<org>/libraries/…",
    "app/(protected)/requests/[id]/page.tsx": "orgs/<org>/tickets/<n>/…",
    "app/(protected)/requests/new/page.tsx": "orgs/<org>/tickets/pending/<uid>/<batch>/…",
    "components/assets/AssetPhotoUploader.tsx": "orgs/<org>/assets/<id>/photos/…",
    "components/branding/LogoUploadModal.tsx": "orgs/<org>/branding/logo-…",
    "components/documents/CheckInPanel.tsx": "orgs/<org>/tickets/pending/<uid>/<batch>/…",
    "components/documents/CustomizeNodeModal.tsx": "orgs/<org>/branding/covers|backgrounds/…",
    "lib/costDocs.ts": "orgs/<org>/project-costs/<project>/…",
    "lib/documentLifecycle/common.ts": "orgs/<org>/libraries/…",
    "lib/knowledge.ts": "orgs/<org>/knowledge/<library>/…",
    "lib/outputTemplates.ts": "orgs/<org>/output-<folder>/…",
    "lib/plotPlans.ts": "orgs/<org>/plot-plans/…",
    "lib/revisions.ts": "orgs/<org>/libraries/…",
    "lib/storage.ts": "the helpers themselves (+ storageSelfTest: orgs/<org>/diagnostics/…)",
    "lib/userProfiles.ts": "avatars/<own uid>/… — allow-list rule 1",
  };
  const CALL = /\b(uploadToPath|uploadFile|uploadTicketAttachment|uploadUserPrivateFile|storageSelfTest)\s*\(|\/api\/storage\/(upload-url|multipart)\b[`"']/;

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  }

  it("the callers found in app/, components/, lib/ and hooks/ are exactly the inventory (the routes themselves excluded)", () => {
    const root = process.cwd();
    const found = ["app", "components", "lib", "hooks"]
      .flatMap((d) => { try { return walk(join(root, d)); } catch { return []; } })
      .filter((f) => !/app\/api\/storage\/(upload-url|multipart)\/route\.ts$/.test(f))
      .filter((f) => readFileSync(f, "utf8").split("\n").some((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && CALL.test(l)))
      .map((f) => relative(root, f).split("\\").join("/"))
      .sort();
    expect(found).toEqual(Object.keys(INVENTORY).sort());
  });
});

describe("EVID-19 — lib/storageWriteAllowList.ts", () => {
  const head = (stored: string[]) => async (k: string) => {
    if (!stored.includes(k)) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
    return {};
  };
  const sb = { from: (t: string) => chain(t) } as never;

  it("the restore rule's listing is unscoped (every workspace that lists the key), the Admin lookup scoped to the caller and active rows", async () => {
    state.listedBy[LEGACY] = [ORG_A]; state.members = [admin(ORG_A)];
    expect(await outsideOrgWriteRefusal(sb, head([]), LEGACY, "u1")).toBeNull();
    const t = state.reads.find((r) => r.table === "tickets")!;
    expect(t.filters).toEqual(expect.arrayContaining([["select", ["org_id"]], ["contains", ["attachments", JSON.stringify([{ url: LEGACY }])]]]));
    expect(t.filters.some(([f, a]) => f === "eq" && a[0] === "org_id")).toBe(false);
    const m = state.reads.find((r) => r.table === "org_members")!;
    expect(m.filters).toEqual(expect.arrayContaining([["in", ["org_id", [ORG_A]]], ["eq", ["uid", "u1"]], ["eq", ["status", "active"]]]));
  });

  it("a request row with no workspace is never matched to an Admin", async () => {
    state.listedBy[LEGACY] = [ORG_A, null]; state.members = [admin(ORG_A)];
    expect(await outsideOrgWriteRefusal(sb, head([]), LEGACY, "u1")).toEqual({ status: 403, error: LEGACY_KEY_NOT_ADMIN_REFUSAL });
    // refused before the Admin lookup, so no `null` is ever sent as a workspace id
    expect(state.reads.filter((r) => r.table === "org_members")).toEqual([]);
  });

  it("a thrown lookup is a 503, never an admission", async () => {
    const throwing = { from: () => { throw new Error("boom"); } } as never;
    expect(await outsideOrgWriteRefusal(throwing, head([]), LEGACY, "u1")).toEqual({ status: 503, error: OUTSIDE_ORG_UNVERIFIED });
  });
});
