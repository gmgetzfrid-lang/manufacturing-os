// projects-joint J16 — projects-tab GAP-401 owed item 2: an
// UNTRUSTED_CONTENT_ORIGIN that presigned GETs of door uploads are signed for.
//
// The real AWS presigner signs offline (no network), so these cases read the
// URL a door upload would be handed: its host (the origin a browser would load
// it from), its path, and the DEC-49 disposition it still carries.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GetObjectCommand } from "@aws-sdk/client-s3";

const ENV = {
  R2_ACCOUNT_ID: "acct0123456789",
  R2_BUCKET_NAME: "plant-docs",
  R2_ACCESS_KEY_ID: "AKIDEXAMPLE",
  R2_SECRET_ACCESS_KEY: "secret-example",
  NEXT_PUBLIC_SITE_URL: "https://app.refinery.example",
};
const UNTRUSTED = "https://acct0123456789.r2.cloudflarestorage.com";

type Mod = typeof import("@/lib/untrustedContent");
let mod: Mod;

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  vi.stubEnv("UNTRUSTED_CONTENT_ORIGIN", "");
  // lib/r2.ts builds its client from the environment when it is first imported.
  mod = await import("@/lib/untrustedContent");
});
afterAll(() => { vi.unstubAllEnvs(); });

const DOOR_DOC = "orgs/o1/project-intake/p1/0f7c1d2e-1111-4a2b-9c3d-123456789abc-skid.pdf";
const DOOR_REDLINE = "orgs/o1/project-intake/p1/redlines/0f7c1d2e-1111-4a2b-9c3d-123456789abc-mark.png";
const DOOR_QUOTE = "orgs/o1/project-costs/p1/quote-0f7c1d2e-1111-4a2b-9c3d-123456789abc-bid.pdf";
const MEMBER_QUOTE = "orgs/o1/project-costs/p1/0f7c1d2e-1111-4a2b-9c3d-123456789abc-bid.pdf";
const CONTROLLED = "orgs/o1/documents/lib1/0f7c1d2e-1111-4a2b-9c3d-123456789abc-P-100.pdf";
const get = (key: string) => new GetObjectCommand({ Bucket: ENV.R2_BUCKET_NAME, Key: key, ResponseContentDisposition: 'attachment; filename="x.pdf"' });

describe("which keys are the door's", () => {
  it("a drawing, a redline and a quote the door filed are door uploads; a member's quote, a controlled document and the staging root are not", () => {
    expect(mod.isDoorUploadKey(DOOR_DOC)).toBe(true);
    expect(mod.isDoorUploadKey(DOOR_REDLINE)).toBe(true);
    expect(mod.isDoorUploadKey(DOOR_QUOTE)).toBe(true);
    expect(mod.isDoorUploadKey(MEMBER_QUOTE)).toBe(false);
    expect(mod.isDoorUploadKey(CONTROLLED)).toBe(false);
    expect(mod.isDoorUploadKey("intake-staging/o1/p1/l1/0f7c1d2e-1111-4a2b-9c3d-123456789abc")).toBe(false);
    expect(mod.isDoorUploadKey("orgs/o1/project-intake/p1")).toBe(false);
  });
  it("the key shapes are the ones the door builds (app/api/intake/upload/route.ts) and lib/costDocs.ts's member upload is not one of them", () => {
    const route = readFileSync(join(process.cwd(), "app/api/intake/upload/route.ts"), "utf8");
    expect(route).toContain("const key = `orgs/${orgId}/project-costs/${projectId}/quote-${crypto.randomUUID()}-${safeName}`;");
    expect(route).toContain("const key = `orgs/${orgId}/project-intake/${projectId}/redlines/${crypto.randomUUID()}-${safeName}`;");
    expect(route).toContain("const key = `orgs/${orgId}/project-intake/${projectId}/${crypto.randomUUID()}-${safeName}`;");
    expect(readFileSync(join(process.cwd(), "lib/costDocs.ts"), "utf8")).toContain("const key = `orgs/${input.orgId}/project-costs/${input.projectId}/${crypto.randomUUID()}-${safeName}`;");
  });
});

describe("the setting, validated", () => {
  const env = (v: string, over: Record<string, string> = {}) => ({ ...ENV, UNTRUSTED_CONTENT_ORIGIN: v, ...over });
  it("unset is no origin and no problem — the app signs as it always has", () => {
    expect(mod.untrustedContentOrigin(env(""))).toEqual({ origin: null, problem: null });
  });
  it("storage's account endpoint is accepted (a trailing slash is fine) and normalised to an origin", () => {
    expect(mod.untrustedContentOrigin(env(UNTRUSTED))).toEqual({ origin: UNTRUSTED });
    expect(mod.untrustedContentOrigin(env(`${UNTRUSTED}/`))).toEqual({ origin: UNTRUSTED });
    expect(mod.untrustedContentOrigin(env("https://ACCT0123456789.r2.cloudflarestorage.com"))).toEqual({ origin: UNTRUSTED });
  });
  it.each([
    ["not an address", "files", /not an address/],
    ["plain http", "http://acct0123456789.r2.cloudflarestorage.com", /https/],
    ["a path", `${UNTRUSTED}/plant-docs`, /origin only/],
    ["a port", `${UNTRUSTED}:8443`, /origin only/],
    ["a query", `${UNTRUSTED}/?x=1`, /origin only/],
    ["credentials", "https://user:pw@acct0123456789.r2.cloudflarestorage.com", /origin only/],
    ["the app's own host", "https://app.refinery.example", /app's own address/],
    ["a host under the app's (its cookies could reach it)", "https://files.app.refinery.example", /app's own address/],
    ["the host controlled documents are already served from", "https://plant-docs.acct0123456789.r2.cloudflarestorage.com", /already served from/],
    // only storage's account endpoint for THIS app's R2_ACCOUNT_ID serves its bucket — any other host would break every door download
    ["a foreign host", "https://files.example.com", /must be exactly https:\/\/<R2_ACCOUNT_ID>\.r2\.cloudflarestorage\.com/],
    ["a custom domain on storage", "https://files.refinery-storage.example", /must be exactly/],
    ["a wrong account ID (one character off)", "https://acct0123456788.r2.cloudflarestorage.com", /must be exactly/],
    ["another account's endpoint", "https://other0123456789.r2.cloudflarestorage.com", /must be exactly/],
    ["another jurisdiction's endpoint (lib/r2.ts does not sign there)", "https://acct0123456789.eu.r2.cloudflarestorage.com", /must be exactly/],
    ["a host that merely ends like the account endpoint", "https://evil-acct0123456789.r2.cloudflarestorage.com", /must be exactly/],
  ])("refuses %s", (_l, value, why) => {
    const r = mod.untrustedContentOrigin(env(value));
    expect(r.origin).toBeNull();
    expect((r as { problem: string }).problem).toMatch(why);
    // the reason never echoes the account ID or the value back into the log
    expect((r as { problem: string }).problem).not.toContain("acct0123456789");
  });
  it("with R2_ACCOUNT_ID unset nothing can be checked, so nothing is accepted", () => {
    const r = mod.untrustedContentOrigin(env(UNTRUSTED, { R2_ACCOUNT_ID: "" }));
    expect(r).toEqual({ origin: null, problem: expect.stringMatching(/R2_ACCOUNT_ID is not set/) });
  });
});

describe("signStorageGet — what a door upload's presigned GET is signed for", () => {
  it("unset: a door upload is signed exactly as today (the bucket's own host), with its disposition", async () => {
    vi.stubEnv("UNTRUSTED_CONTENT_ORIGIN", "");
    const url = new URL(await mod.signStorageGet(get(DOOR_DOC), { expiresIn: 300 }));
    expect(url.host).toBe("plant-docs.acct0123456789.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(`/${DOOR_DOC}`);
    expect(url.searchParams.get("response-content-disposition")).toBe('attachment; filename="x.pdf"');
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
  });
  it("set: a door upload (drawing, redline, quote) is signed for the untrusted origin, path style — the bucket's host is never used for it; its disposition and lifetime are unchanged", async () => {
    vi.stubEnv("UNTRUSTED_CONTENT_ORIGIN", UNTRUSTED);
    for (const key of [DOOR_DOC, DOOR_REDLINE, DOOR_QUOTE]) {
      const url = new URL(await mod.signStorageGet(get(key), { expiresIn: 300 }));
      expect(url.origin).toBe(UNTRUSTED);
      expect(url.pathname).toBe(`/plant-docs/${key}`);
      expect(url.searchParams.get("response-content-disposition")).toBe('attachment; filename="x.pdf"');
      expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
      expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    }
  });
  it("set: everything that is not a door upload — a controlled drawing, a member's quote — is signed exactly as today", async () => {
    vi.stubEnv("UNTRUSTED_CONTENT_ORIGIN", UNTRUSTED);
    for (const key of [CONTROLLED, MEMBER_QUOTE]) {
      const url = new URL(await mod.signStorageGet(get(key), { expiresIn: 300 }));
      expect(url.host).toBe("plant-docs.acct0123456789.r2.cloudflarestorage.com");
      expect(url.pathname).toBe(`/${key}`);
    }
  });
  it("a refused setting changes nothing: the door upload is signed as today and the reason is logged once per runtime", async () => {
    vi.stubEnv("UNTRUSTED_CONTENT_ORIGIN", "https://files.app.refinery.example");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const a = new URL(await mod.signStorageGet(get(DOOR_DOC), { expiresIn: 60 }));
    const b = new URL(await mod.signStorageGet(get(DOOR_DOC), { expiresIn: 60 }));
    expect(a.host).toBe("plant-docs.acct0123456789.r2.cloudflarestorage.com");
    expect(b.host).toBe("plant-docs.acct0123456789.r2.cloudflarestorage.com");
    // a foreign host or a mistyped account ID is refused the same way — never signed for
    for (const wrong of ["https://files.example.com", "https://acct0123456788.r2.cloudflarestorage.com"]) {
      vi.stubEnv("UNTRUSTED_CONTENT_ORIGIN", wrong);
      const u = new URL(await mod.signStorageGet(get(DOOR_DOC), { expiresIn: 60 }));
      expect(u.host, wrong).toBe("plant-docs.acct0123456789.r2.cloudflarestorage.com");
    }
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toMatch(/app's own address/);
    spy.mockRestore();
  });
});

describe("the operator step", () => {
  // (prose wraps: whitespace is folded before matching)
  const doc = readFileSync(join(process.cwd(), "docs/UNTRUSTED_CONTENT_ORIGIN.md"), "utf8").replace(/\s+/g, " ");
  it("is written down: the exact value, where to set it, how to check it worked, and how to undo it", () => {
    expect(doc).toContain("UNTRUSTED_CONTENT_ORIGIN");
    expect(doc).toContain("https://<your R2 account ID>.r2.cloudflarestorage.com");
    expect(doc).toMatch(/Settings → Environment Variables/);
    expect(doc).toMatch(/Redeploy/);
    expect(doc).toMatch(/How to check it worked/);
    expect(doc).toMatch(/How to undo it/);
    // it says when the setting starts doing anything (the issuers' adoption)
    expect(doc).toContain("app/api/storage/download-url/route.ts");
  });
  it(".env.example lists the variable, blank by default", () => {
    const env = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    expect(env).toMatch(/^UNTRUSTED_CONTENT_ORIGIN=$/m);
    expect(env).toContain("docs/UNTRUSTED_CONTENT_ORIGIN.md");
  });
});
