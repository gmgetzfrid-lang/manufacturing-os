// admin-and-org Round G, package P6 — ORG-5: the workspace logo's BYTES are
// held to what its pointer is held to. A file directly under
// orgs/<org>/branding/ (lib/storageKey.ts isWorkspaceLogoKey) is signed by
// /api/storage/upload-url only for an Admin (by the full role collection),
// only as a PNG / JPEG / WebP of at most 5 MB, with the type and the length
// SIGNED into the PUT, and only after an audit row naming the actor lands.
// The multipart route refuses the logo area outright. Every other key — a
// document, a folder's cover or page background under branding/covers/ and
// branding/backgrounds/ — is signed exactly as before.
//
// Fix pass: the restore page's "Put the files back" is the second direct
// caller of upload-url. It builds its request with the same helper the test
// below drives the route with (lib/storageKey.ts restoreUploadRequest), so a
// logo in a backup is put back with its size, and a legacy SVG / GIF logo the
// route will not sign is named instead of failing silently.
//
// The route signs with the REAL presigner (an S3 client with inert
// credentials — presigning is local), so the assertions read the URL's own
// X-Amz-SignedHeaders: what storage will hold the PUT to.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com" } as { id: string; email?: string } | null,
  member: { uid: "u1", role: "Drafter", roles: ["Drafter"] } as Record<string, unknown> | null,
  versionClash: null as unknown,
  versionErr: null as unknown,
  auditErr: null as unknown,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  r2Sends: [] as Array<{ name: string; input: Record<string, unknown> }>,
}));

function chain(table: string) {
  const c: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return undefined;
      return (...args: unknown[]) => {
        if (prop === "insert") {
          state.inserts.push({ table, row: args[0] as Record<string, unknown> });
          return Promise.resolve({ data: null, error: table === "audit_logs" ? state.auditErr : null });
        }
        if (prop === "maybeSingle" || prop === "single") {
          if (table === "org_members") return Promise.resolve({ data: state.member, error: null });
          if (table === "document_versions") return Promise.resolve({ data: state.versionClash, error: state.versionErr });
          return Promise.resolve({ data: null, error: null });
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
  },
}));
vi.mock("@/lib/r2", async () => {
  const { S3Client } = await import("@aws-sdk/client-s3");
  const real = new S3Client({
    region: "auto",
    endpoint: "https://acct.r2.cloudflarestorage.com",
    credentials: { accessKeyId: "AKTEST", secretAccessKey: "SKTEST" },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  // presigning reads the client's config; a SEND (multipart create) is recorded, never sent
  const send = async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    state.r2Sends.push({ name: cmd.constructor.name, input: cmd.input });
    return { UploadId: "up-1" };
  };
  (real as unknown as { send: typeof send }).send = send;
  return { r2: real, R2_BUCKET: "test-bucket" };
});

import { POST as uploadUrl } from "@/app/api/storage/upload-url/route";
import { restoreUploadRequest, contentTypeForKey } from "@/lib/storageKey";
import { POST as multipart } from "@/app/api/storage/multipart/route";

const ORG = "12345678-1234-1234-1234-123456789abc";
const LOGO = `orgs/${ORG}/branding/logo-0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b.png`;

const post = (body: Record<string, unknown>) => uploadUrl(new NextRequest("https://app/api/storage/upload-url", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const mp = (body: Record<string, unknown>) => multipart(new NextRequest("https://app/api/storage/multipart", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const signedHeaders = (url: string) => (new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "").split(";");

beforeEach(() => {
  state.user = { id: "u1", email: "u1@example.com" };
  state.member = { uid: "u1", role: "Drafter", roles: ["Drafter"] };
  state.versionClash = null;
  state.versionErr = null;
  state.auditErr = null;
  state.inserts = [];
  state.r2Sends = [];
});

describe("ORG-5 — the workspace logo is an Admin's to write (upload-url)", () => {
  it("REPRODUCED: a Drafter (any member, before) asking to PUT the exact logo key is refused 403 — nothing signed, nothing audited", async () => {
    const res = await post({ path: LOGO, contentType: "image/png", size: 1000 });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Only an Admin can change the workspace logo.");
    expect(state.inserts).toEqual([]);
  });

  it("a Viewer and a Contractor are refused the same way; a non-member is refused before that", async () => {
    for (const roles of [["Viewer"], ["Contractor"], ["Manager", "DocCtrl"]]) {
      state.member = { uid: "u1", role: roles[0], roles };
      expect((await post({ path: LOGO, contentType: "image/png", size: 1000 })).status, roles.join("+")).toBe(403);
    }
    state.member = null;
    const res = await post({ path: LOGO, contentType: "image/png", size: 1000 });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Not a member of this workspace");
  });

  it("an Admin by the COLLECTION (headline Viewer, Admin additive) is signed: type and length are SIGNED headers of the PUT", async () => {
    state.member = { uid: "u1", role: "Viewer", roles: ["Viewer", "Admin"] };
    const res = await post({ path: LOGO, contentType: "image/png", size: 4096 });
    expect(res.status).toBe(200);
    const { url, path } = await res.json();
    expect(path).toBe(LOGO);
    const signed = signedHeaders(url);
    expect(signed).toContain("content-type");
    expect(signed).toContain("content-length");
    expect(signed).toContain("host");
  });

  it("the upload is audited BEFORE it is signed, naming the actor, the key, the type and the size", async () => {
    state.member = { uid: "u1", role: "Admin", roles: ["Admin"] };
    await post({ path: LOGO, contentType: "image/webp", size: 2048 });
    expect(state.inserts).toEqual([{
      table: "audit_logs",
      row: {
        action: "BRANDING_LOGO_UPLOAD", resource_id: ORG, resource_type: "org_branding", org_id: ORG,
        user_id: "u1", user_email: "u1@example.com", user_role: "Admin",
        details: { path: LOGO, contentType: "image/webp", size: 2048 },
      },
    }]);
  });

  it("a refused audit row refuses the upload (503) — never signed unrecorded", async () => {
    state.member = { uid: "u1", role: "Admin", roles: ["Admin"] };
    state.auditErr = { message: "new row violates row-level security policy" };
    const res = await post({ path: LOGO, contentType: "image/png", size: 10 });
    expect(res.status).toBe(503);
    expect((await res.json()).url).toBeUndefined();
  });

  it("only PNG / JPEG / WebP: SVG and HTML are 415, a missing size 400, over 5 MB 413 — and nothing is audited", async () => {
    state.member = { uid: "u1", role: "Admin", roles: ["Admin"] };
    expect((await post({ path: LOGO, contentType: "image/svg+xml", size: 10 })).status).toBe(415);
    expect((await post({ path: LOGO, contentType: "text/html", size: 10 })).status).toBe(415);
    expect((await post({ path: LOGO, size: 10 })).status).toBe(415);
    expect((await post({ path: LOGO, contentType: "image/png" })).status).toBe(400);
    expect((await post({ path: LOGO, contentType: "image/png", size: 5 * 1024 * 1024 + 1 })).status).toBe(413);
    expect((await post({ path: LOGO, contentType: "image/jpeg", size: 5 * 1024 * 1024 })).status).toBe(200);
    expect(state.inserts.filter((i) => i.table === "audit_logs")).toHaveLength(1); // only the one that was signed
  });

  it("PKG-1 still runs for the logo area: a key that is a published revision's bytes is 409, unaudited", async () => {
    state.member = { uid: "u1", role: "Admin", roles: ["Admin"] };
    state.versionClash = { id: "v1" };
    expect((await post({ path: LOGO, contentType: "image/png", size: 10 })).status).toBe(409);
    expect(state.inserts).toEqual([]);
  });
});

describe("REGRESSION — every other upload is signed exactly as before", () => {
  it("a document upload by any member: signed, content-type NOT a signed header (unchanged), no audit row", async () => {
    const res = await post({ path: `orgs/${ORG}/libraries/lib1/${Date.now()}-a.pdf`, contentType: "application/pdf", size: 123 });
    expect(res.status).toBe(200);
    expect(signedHeaders((await res.json()).url)).toEqual(["host"]);
    expect(state.inserts).toEqual([]);
  });

  it("a folder cover and a page background under branding/ sub-folders stay member-writable, any image type", async () => {
    for (const p of [`orgs/${ORG}/branding/covers/c1.gif`, `orgs/${ORG}/branding/backgrounds/b1.svg`]) {
      const res = await post({ path: p, contentType: "image/gif" });
      expect(res.status, p).toBe(200);
    }
    expect(state.inserts).toEqual([]);
  });

  it("the client's size is ignored for a non-logo key (no Content-Length pinned)", async () => {
    const res = await post({ path: `orgs/${ORG}/tickets/t1/x.bin`, contentType: "application/octet-stream", size: 99 });
    expect(signedHeaders((await res.json()).url)).not.toContain("content-length");
  });
});

describe("ORG-5 — the multipart route refuses the logo area (it is never the way around upload-url)", () => {
  it("create / sign / complete for a logo key are 400 before storage is touched, for an Admin too", async () => {
    state.member = { uid: "u1", role: "Admin", roles: ["Admin"] };
    for (const action of ["create", "sign", "complete", "abort"]) {
      const res = await mp({ action, path: LOGO, contentType: "image/png", uploadId: "u", partNumber: 1, parts: [{ partNumber: 1, etag: "e" }] });
      expect(res.status, action).toBe(400);
    }
    expect(state.r2Sends).toEqual([]);
  });

  it("a big scan's multipart create is untouched (a member, any type)", async () => {
    const res = await mp({ action: "create", path: `orgs/${ORG}/libraries/l/scan.e57`, contentType: "application/octet-stream" });
    expect(res.status).toBe(200);
    expect(state.r2Sends.map((s) => s.name)).toEqual(["CreateMultipartUploadCommand"]);
  });
});

describe("the client sends the size and reads the refusal (lib/storage.ts), and the logo modal pre-checks", () => {
  const storage = readFileSync(join(process.cwd(), "lib/storage.ts"), "utf8");
  const modal = readFileSync(join(process.cwd(), "components/branding/LogoUploadModal.tsx"), "utf8");
  it("getPresignedUploadUrl posts { path, contentType, size } and uploadToPath hands it file.size", () => {
    expect(storage).toMatch(/body: JSON\.stringify\(\{ path, contentType, size \}\)/);
    expect(storage).toMatch(/uploadUrl = await getPresignedUploadUrl\(path, contentType, opts\?\.signal, file\.size\);/);
  });
  it("a refused presign keeps its status prefix and adds the route's reason", () => {
    expect(storage).toMatch(/throw new Error\(`Failed to get upload URL \(HTTP \$\{res\.status\}\)\$\{typeof reason === "string" && reason \? `: \$\{reason\}` : ""\}`\);/);
  });
  it("the modal checks the same allow-list and cap before uploading, and offers only those types", () => {
    expect(modal).toMatch(/const problem = logoUploadProblem\(file\.type, file\.size\);/);
    expect(modal).toMatch(/accept=\{LOGO_CONTENT_TYPES\.join\(","\)\}/);
  });
});

describe("ORG-5 fix pass — a backup restore puts the workspace logo back (app/(protected)/admin/restore/page.tsx)", () => {
  const restorePage = readFileSync(join(process.cwd(), "app/(protected)/admin/restore/page.tsx"), "utf8");
  const ADMIN = { uid: "u1", role: "Admin", roles: ["Admin"] };
  const logoKey = (ext: string) => `orgs/${ORG}/branding/logo-0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c.${ext}`;

  it("REPRODUCED: the restore page's old body, { path, contentType } with no size, is refused 400 for a logo", async () => {
    state.member = ADMIN;
    const res = await post({ path: LOGO, contentType: "image/png" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("The logo's size is required to upload it.");
  });

  it("the restore page's exact body for a PNG / JPEG / WebP logo is signed, type and length signed, and its PUT sends the signed type", async () => {
    state.member = ADMIN;
    for (const [ext, type] of [["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["webp", "image/webp"]]) {
      const req = restoreUploadRequest(logoKey(ext), 4096);
      expect(req.logoProblem, ext).toBeNull();
      expect(req.body, ext).toEqual({ path: logoKey(ext), contentType: type, size: 4096 });
      expect(req.contentType, ext).toBe(type);
      const res = await post(req.body);
      expect(res.status, ext).toBe(200);
      const signed = signedHeaders((await res.json()).url);
      expect(signed, ext).toEqual(expect.arrayContaining(["content-type", "content-length", "host"]));
    }
    // each signed upload is audited, as any logo upload is
    expect(state.inserts.filter((i) => i.table === "audit_logs").map((i) => i.row.details)).toEqual([
      { path: logoKey("png"), contentType: "image/png", size: 4096 },
      { path: logoKey("jpg"), contentType: "image/jpeg", size: 4096 },
      { path: logoKey("jpeg"), contentType: "image/jpeg", size: 4096 },
      { path: logoKey("webp"), contentType: "image/webp", size: 4096 },
    ]);
  });

  it("a legacy SVG or GIF logo, or one over 5 MB, is named by the helper exactly when the route would refuse it", async () => {
    state.member = ADMIN;
    const cases: Array<[string, number, number]> = [["svg", 2048, 415], ["gif", 2048, 415], ["png", 5 * 1024 * 1024 + 1, 413]];
    for (const [ext, size, status] of cases) {
      const req = restoreUploadRequest(logoKey(ext), size);
      const res = await post(req.body);
      expect(res.status, ext).toBe(status);
      expect(req.logoProblem, ext).toBe((await res.json()).error);
    }
    expect(state.inserts).toEqual([]);
  });

  it("every other backup file is unaffected: a document, a cover GIF, a background SVG — no logo problem, signed as before", async () => {
    for (const key of [`orgs/${ORG}/libraries/l1/1-a.pdf`, `orgs/${ORG}/branding/covers/c1.gif`, `orgs/${ORG}/branding/backgrounds/b1.svg`, `orgs/${ORG}/tickets/t1/x.unknownext`]) {
      const req = restoreUploadRequest(key, 99);
      expect(req.logoProblem, key).toBeNull();
      expect(req.body.contentType, key).toBe(contentTypeForKey(key));
      const res = await post(req.body);
      expect(res.status, key).toBe(200);
      expect(signedHeaders((await res.json()).url), key).toEqual(["host"]);
    }
    expect(contentTypeForKey(`orgs/${ORG}/tickets/t1/x.unknownext`)).toBe("application/octet-stream");
    expect(state.inserts).toEqual([]);
  });

  it("the page builds its request with the helper, sends its body, PUTs the same type, and says why a file failed", () => {
    expect(restorePage).toMatch(/import \{ restoreUploadRequest \} from "@\/lib\/storageKey";/);
    expect(restorePage).toMatch(/const req = restoreUploadRequest\(key, blob\.size\);/);
    expect(restorePage).toMatch(/body: JSON\.stringify\(req\.body\),/);
    expect(restorePage).toMatch(/method: "PUT", body: blob, headers: \{ "Content-Type": req\.contentType \}/);
    expect(restorePage).not.toMatch(/contentTypeFor\(/);
    expect(restorePage).not.toMatch(/JSON\.stringify\(\{ path: key, contentType/);
    // a refusal's reason is kept and shown, not swallowed
    expect(restorePage).toMatch(/\} catch \(e\) \{\n\s+counters\.failed\+\+;\n\s+const reason = \(e instanceof Error && e\.message\) \|\| "Upload failed";/);
    expect(restorePage).toMatch(/\{fmtNum\(r\.files\)\} file\(s\): \{r\.reason\}/);
    // a logo the route will not sign is not asked for; the restorer is told to upload it again
    expect(restorePage).toMatch(/if \(req\.logoProblem\) \{\n\s+logoNotRestored = /);
    expect(restorePage).toContain("The workspace logo in this backup was not put back");
    expect(restorePage).toMatch(/href="\/admin\/branding"/);
  });
});
