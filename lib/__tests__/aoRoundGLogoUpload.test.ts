// admin-and-org Round G, package P6 — ORG-5: the workspace logo's BYTES are
// held to what its pointer is held to. A file directly under
// orgs/<org>/branding/ (lib/storageKey.ts isWorkspaceLogoKey) is signed by
// /api/storage/upload-url only for an Admin (by the full role collection),
// only as a PNG / JPEG / WebP of at most 5 MB, with the type and the length
// SIGNED into the PUT, and only after an audit row naming the actor lands.
// The multipart route refuses the logo area outright. Every other key — a
// document, a ticket attachment — is signed exactly as before. (A folder's
// cover or page background under branding/covers/ and branding/backgrounds/
// was member-writable here until admin-and-org ORG-16, Round G P10: it is now
// held to the node editor's authority and an image type —
// lib/__tests__/aoRoundGStorageFollowups.test.ts.)
//
// Fix pass: the restore page's "Put the files back" is the second direct
// caller of upload-url. It builds its request with the same helper the test
// below drives the route with (lib/storageKey.ts restoreUploadRequest), so a
// logo in a backup is put back with its size, and a legacy SVG / GIF logo the
// route will not sign is named instead of failing silently.
//
// Fix pass 2: a logo key used to be minted from the file's NAME, so a real
// JPEG could sit at "….jfif" (or under no extension) and be signed by its
// declared type, then fail to restore because the restore read the type from
// the extension. New keys take the extension of the signed type
// (logoExtensionForType); the restore reads a logo's type from its first
// bytes (sniffImageType) before falling back to the extension.
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
import { restoreUploadRequest, contentTypeForKey, logoExtensionForType, sniffImageType, LOGO_CONTENT_TYPES } from "@/lib/storageKey";
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

  it("ORG-16 (P10) supersedes the member rule for covers and backgrounds: a Drafter is refused; a controller is signed, type signed, no audit row", async () => {
    for (const p of [`orgs/${ORG}/branding/covers/c1.gif`, `orgs/${ORG}/branding/backgrounds/b1.svg`]) {
      expect((await post({ path: p, contentType: "image/gif" })).status, p).toBe(403);
    }
    state.member = { uid: "u1", role: "DocCtrl", roles: ["DocCtrl"] };
    for (const p of [`orgs/${ORG}/branding/covers/c1.gif`, `orgs/${ORG}/branding/backgrounds/b1.svg`]) {
      const res = await post({ path: p, contentType: "image/gif" });
      expect(res.status, p).toBe(200);
      expect(signedHeaders((await res.json()).url), p).toEqual(expect.arrayContaining(["content-type", "host"]));
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

  it("every other backup file is unaffected: a document, a ticket file — no logo problem, signed as before (covers and backgrounds: ORG-16, P10's test)", async () => {
    for (const key of [`orgs/${ORG}/libraries/l1/1-a.pdf`, `orgs/${ORG}/tickets/t1/x.unknownext`]) {
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
    expect(restorePage).toMatch(/import \{ restoreUploadRequest, isWorkspaceLogoKey \} from "@\/lib\/storageKey";/);
    expect(restorePage).toContain("const head = isWorkspaceLogoKey(key) ? new Uint8Array(await blob.slice(0, 12).arrayBuffer()) : null;");
    expect(restorePage).toMatch(/const req = restoreUploadRequest\(key, blob\.size, head\);/);
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

describe("ORG-5 fix pass 2 — a logo's type is its bytes' and its signed type's, never its file name's", () => {
  const ADMIN = { uid: "u1", role: "Admin", roles: ["Admin"] };
  const key = (ext: string) => `orgs/${ORG}/branding/logo-0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d.${ext}`;
  const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(Math.max(0, 12 - b.length)).fill(0)]);
  const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
  const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
  const GIF = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);

  it("REPRODUCED: a real JPEG uploaded as 'Company Logo.jfif' (signed as image/jpeg) did not restore — by its extension it was octet-stream, 415 (until P10 named .jfif)", async () => {
    state.member = ADMIN;
    // how it got there: the modal's old key took the NAME's extension, and upload-url signed the declared type
    expect((await post({ path: key("jfif"), contentType: "image/jpeg", size: 4096 })).status).toBe(200);
    // admin-and-org ORG-16 (Round G, P10): the restore's extension table now
    // names .jfif (a JPEG), so a cover stored under it is put back as an
    // image; without its bytes such a logo now restores as a JPEG too.
    // An unnamed extension still falls back to octet-stream and is refused.
    const byName = restoreUploadRequest(key("jfif"), 4096);
    expect(byName.contentType).toBe("image/jpeg");
    expect(byName.logoProblem).toBeNull();
    const unnamed = restoreUploadRequest(key("companylogo"), 4096);
    expect(unnamed.contentType).toBe("application/octet-stream");
    expect(unnamed.logoProblem).toBe("A workspace logo must be a PNG, JPEG or WebP image (SVG is not accepted).");
  });

  it("with its first bytes, that logo — and one with no real extension ('CompanyLogo') — restores as what it is, signed and audited", async () => {
    state.member = ADMIN;
    for (const [ext, head, type] of [["jfif", JPEG, "image/jpeg"], ["companylogo", PNG, "image/png"], ["companylogo", WEBP, "image/webp"]] as const) {
      const req = restoreUploadRequest(key(ext), 4096, head);
      expect(req.logoProblem, ext).toBeNull();
      expect(req.contentType, ext).toBe(type);
      expect(req.body, ext).toEqual({ path: key(ext), contentType: type, size: 4096 });
      const res = await post(req.body);
      expect(res.status, ext).toBe(200);
      expect(signedHeaders((await res.json()).url), ext).toEqual(expect.arrayContaining(["content-type", "content-length"]));
    }
    expect(state.inserts.filter((i) => i.table === "audit_logs").map((i) => (i.row.details as { contentType: string }).contentType))
      .toEqual(["image/jpeg", "image/png", "image/webp"]);
  });

  it("the bytes win over a wrong extension: a GIF stored at '.png' is named as not restorable, never signed as a PNG", () => {
    const req = restoreUploadRequest(key("png"), 2048, GIF);
    expect(req.contentType).toBe("image/gif");
    expect(req.logoProblem).toBe("A workspace logo must be a PNG, JPEG or WebP image (SVG is not accepted).");
  });

  it("bytes that are no known image fall back to the extension; a non-logo key never reads its bytes' type", () => {
    expect(restoreUploadRequest(key("png"), 10, bytes(0x3c, 0x73, 0x76, 0x67)).contentType).toBe("image/png");
    expect(restoreUploadRequest(key("svg"), 10, bytes(0x3c, 0x73, 0x76, 0x67)).logoProblem).not.toBeNull();
    expect(restoreUploadRequest(`orgs/${ORG}/libraries/l/a.pdf`, 10, JPEG).contentType).toBe("application/pdf");
    expect(restoreUploadRequest(`orgs/${ORG}/branding/covers/c.bin`, 10, PNG).contentType).toBe("application/octet-stream");
  });

  it("sniffImageType reads the four magic numbers and nothing else", () => {
    expect([sniffImageType(PNG), sniffImageType(JPEG), sniffImageType(WEBP), sniffImageType(GIF)])
      .toEqual(["image/png", "image/jpeg", "image/webp", "image/gif"]);
    expect(sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeNull(); // RIFF…WAVE
    expect(sniffImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffImageType(null)).toBeNull();
  });

  it("a new logo key takes the signed type's extension, and the restore reads the same type back from it", () => {
    expect(LOGO_CONTENT_TYPES.map((t) => logoExtensionForType(t))).toEqual(["png", "jpg", "webp"]);
    for (const t of LOGO_CONTENT_TYPES) expect(contentTypeForKey(key(logoExtensionForType(t)!)), t).toBe(t);
    for (const t of ["image/svg+xml", "image/gif", "text/html", undefined]) expect(logoExtensionForType(t), String(t)).toBeNull();
  });
});
