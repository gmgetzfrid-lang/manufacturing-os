// document-control PKG-15: /api/storage/multipart asks upload-url's PKG-1
// question — is this key already a document version's bytes? — at create AND
// at complete, with the same helper, words and codes (lib/versionKeyWriteGate.ts).
// A published revision's key (file_url or source_file_key) is refused 409 with
// nothing opened or completed in storage; a ledger read error refuses 503; a
// fresh key is answered byte-identically to before; sign and abort are
// unchanged; upload-url's own PKG-1 answers are unchanged.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const ORG = "12345678-1234-1234-1234-123456789abc";
const DOC = `orgs/${ORG}/libraries/l1/P-101__rev3__1763424000000.pdf`;

const state = vi.hoisted(() => ({
  /** column → key that a document_versions row names */
  versionKeys: {} as Record<string, string>,
  versionErr: null as null | { message: string },
  versionReads: [] as Array<[string, unknown]>,
  sends: [] as string[],
  signed: 0,
}));

function chain(table: string) {
  const eqs: Array<[string, unknown]> = [];
  const result = () => {
    if (table === "org_members") return { data: { uid: "u1" }, error: null };
    if (table === "document_versions") {
      if (state.versionErr) return { data: null, error: state.versionErr };
      const [col, val] = eqs[0] ?? ["", null];
      state.versionReads.push([col, val]);
      return { data: state.versionKeys[col] === val ? { id: "v1" } : null, error: null };
    }
    if (table === "tickets") return { data: [], error: null };
    return { data: null, error: null };
  };
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") { const r = result(); return (resolve: (v: unknown) => void) => resolve(r); }
      return (...args: unknown[]) => {
        if (prop === "eq") eqs.push([String(args[0]), args[1]]);
        if (prop === "maybeSingle" || prop === "single") return Promise.resolve(result());
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u1", email: "u1@x.io" } }, error: null })) },
    from: (t: string) => chain(t),
  },
}));
vi.mock("@/lib/serverAuth", () => ({ enforceOrgAccess: vi.fn(async () => null) }));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "b",
  r2: { send: vi.fn(async (cmd: { constructor: { name: string } }) => { state.sends.push(cmd.constructor.name); return cmd.constructor.name === "CreateMultipartUploadCommand" ? { UploadId: "up-1" } : {}; }) },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: vi.fn(async () => { state.signed += 1; return "https://signed.example/x"; }) }));

import { POST as multipart } from "@/app/api/storage/multipart/route";
import { POST as uploadUrl } from "@/app/api/storage/upload-url/route";
import { VERSION_KEY_REFUSAL, VERSION_KEY_UNVERIFIED } from "@/lib/versionKeyWriteGate";

const mp = (body: Record<string, unknown>) => multipart(new NextRequest("https://app/api/storage/multipart", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const up = (path: string) => uploadUrl(new NextRequest("https://app/api/storage/upload-url", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ path }),
}));
const COMPLETE = { uploadId: "up-1", parts: [{ partNumber: 1, etag: "e" }] };

beforeEach(() => { state.versionKeys = {}; state.versionErr = null; state.versionReads = []; state.sends = []; state.signed = 0; });

describe("PKG-15 — the multipart door never overwrites a document version's bytes", () => {
  it("a version's rendered file (file_url): create AND complete are refused 409 with PKG-1's words; nothing opened or completed", async () => {
    state.versionKeys = { file_url: DOC };
    for (const action of ["create", "complete"]) {
      state.sends = [];
      const res = await mp({ action, path: DOC, contentType: "application/pdf", ...COMPLETE });
      expect(res.status, action).toBe(409);
      expect(await res.json(), action).toEqual({ error: VERSION_KEY_REFUSAL });
      expect(state.sends, action).toEqual([]);
    }
  });

  it("a version's native source (source_file_key) is refused the same way", async () => {
    state.versionKeys = { source_file_key: DOC };
    expect((await mp({ action: "create", path: DOC, contentType: "application/pdf" })).status).toBe(409);
    expect((await mp({ action: "complete", path: DOC, ...COMPLETE })).status).toBe(409);
    expect(state.sends).toEqual([]);
  });

  it("an upload opened before the version was published cannot complete over its bytes afterwards", async () => {
    expect((await mp({ action: "create", path: DOC, contentType: "application/pdf" })).status).toBe(200);
    state.versionKeys = { file_url: DOC }; state.sends = [];
    const res = await mp({ action: "complete", path: DOC, ...COMPLETE });
    expect(res.status).toBe(409);
    expect(state.sends).toEqual([]);
  });

  it("fail closed: a ledger read error is 503 with PKG-1's words, nothing reaches storage", async () => {
    state.versionErr = { message: "timeout" };
    for (const action of ["create", "complete"]) {
      const res = await mp({ action, path: DOC, contentType: "application/pdf", ...COMPLETE });
      expect(res.status, action).toBe(503);
      expect(await res.json(), action).toEqual({ error: VERSION_KEY_UNVERIFIED });
    }
    expect(state.sends).toEqual([]);
  });

  it("REGRESSION — a fresh key: create, sign, complete, abort answer byte-identically to before; both columns are asked at create and complete only", async () => {
    expect(await (await mp({ action: "create", path: DOC, contentType: "application/pdf" })).text()).toBe(JSON.stringify({ uploadId: "up-1" }));
    expect(state.versionReads).toEqual([["file_url", DOC], ["source_file_key", DOC]]);
    state.versionReads = [];
    expect(await (await mp({ action: "sign", path: DOC, uploadId: "up-1", partNumber: 1 })).text()).toBe(JSON.stringify({ url: "https://signed.example/x" }));
    expect(state.versionReads).toEqual([]);
    expect(await (await mp({ action: "complete", path: DOC, ...COMPLETE })).text()).toBe(JSON.stringify({ ok: true }));
    expect(state.versionReads).toEqual([["file_url", DOC], ["source_file_key", DOC]]);
    state.versionKeys = { file_url: DOC }; state.versionReads = [];
    // an abort must always work, even for a key since published
    expect(await (await mp({ action: "abort", path: DOC, uploadId: "up-1" })).text()).toBe(JSON.stringify({ ok: true }));
    expect(state.versionReads).toEqual([]);
    expect(state.sends).toEqual(["CreateMultipartUploadCommand", "CompleteMultipartUploadCommand", "AbortMultipartUploadCommand"]);
  });
});

describe("PKG-1 — upload-url's answers unchanged by the move to the shared helper", () => {
  it("409 / 503 / signed, with the same words", async () => {
    state.versionKeys = { file_url: DOC };
    let res = await up(DOC);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "That file already belongs to a published revision and cannot be overwritten. Publish a new revision instead." });
    state.versionKeys = {}; state.versionErr = { message: "x" };
    res = await up(DOC);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Couldn't verify the target key; upload refused." });
    state.versionErr = null;
    res = await up(DOC);
    expect(await res.text()).toBe(JSON.stringify({ url: "https://signed.example/x", path: DOC }));
    expect(state.signed).toBe(1);
  });
});
