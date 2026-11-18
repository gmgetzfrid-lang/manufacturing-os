// drafting-flow EVID-17: a request's stored file cannot be overwritten in
// place through the signed-upload doors (/api/storage/upload-url, and
// /api/storage/multipart create / complete). Pinned: a listed key whose bytes
// are in storage is refused (409) with nothing signed or sent; a fresh key is
// signed exactly as before (byte-identical response); the restore's put-back
// of a listed file that is NOT in storage is signed; a lookup or storage check
// that fails refuses (503); PKG-1's version check is unchanged and first;
// signing a part and aborting an upload are unchanged.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const ORG = "12345678-1234-1234-1234-123456789abc";
const KEY = `orgs/${ORG}/tickets/REQ-7/1763424000000_iso_IFC.pdf`;

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com" } as { id: string; email?: string } | null,
  /** keys a request lists */
  listed: [] as string[],
  ticketsErr: null as null | { message: string },
  /** keys in storage */
  stored: [] as string[],
  headErr: null as null | Error,
  versionClash: false,
  reads: [] as Array<{ table: string; filters: Array<[string, unknown[]]> }>,
  signed: [] as string[],
  sends: [] as Array<{ name: string; key: string }>,
}));

function chain(table: string) {
  const filters: Array<[string, unknown[]]> = [];
  const result = () => {
    if (table === "org_members") return { data: { uid: "u1" }, error: null };
    if (table === "document_versions") return { data: state.versionClash ? { id: "v1" } : null, error: null };
    if (table === "tickets") {
      if (state.ticketsErr) return { data: null, error: state.ticketsErr };
      const c = filters.find(([m]) => m === "contains");
      const url = c ? (JSON.parse(String(c[1][1])) as Array<{ url: string }>)[0].url : null;
      return { data: url && state.listed.includes(url) ? [{ id: "t7" }] : [], error: null };
    }
    return { data: null, error: null };
  };
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        state.reads.push({ table, filters: [...filters] });
        const r = result();
        return (resolve: (v: unknown) => void) => resolve(r);
      }
      return (...args: unknown[]) => {
        filters.push([prop, args]);
        if (prop === "maybeSingle" || prop === "single") {
          state.reads.push({ table, filters: [...filters] });
          return Promise.resolve(result());
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

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
        return { ContentLength: 10, ETag: '"e"' };
      }
      if (name === "CreateMultipartUploadCommand") return { UploadId: "up-1" };
      return {};
    }),
  },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_c: unknown, cmd: { input: { Key: string } }) => { state.signed.push(cmd.input.Key); return "https://signed.example/put"; }),
}));

import { POST as uploadUrl } from "@/app/api/storage/upload-url/route";
import { POST as multipart } from "@/app/api/storage/multipart/route";
import { ticketKeyOrg, TICKET_KEY_LISTED_REFUSAL, TICKET_KEY_UNVERIFIED } from "@/lib/ticketKeyOverwrite";

const up = (path: string) => uploadUrl(new NextRequest("https://app/api/storage/upload-url", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ path, contentType: "application/pdf" }),
}));
const mp = (body: Record<string, unknown>) => multipart(new NextRequest("https://app/api/storage/multipart", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const ticketReads = () => state.reads.filter((r) => r.table === "tickets");

beforeEach(() => {
  state.user = { id: "u1", email: "u1@example.com" };
  state.listed = []; state.ticketsErr = null; state.stored = []; state.headErr = null; state.versionClash = false;
  state.reads = []; state.signed = []; state.sends = [];
});

describe("EVID-17 — upload-url never re-signs a request's stored file", () => {
  it("a key a request lists, whose bytes are in storage: 409 in plain words, nothing signed", async () => {
    state.listed = [KEY]; state.stored = [KEY];
    const res = await up(KEY);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: TICKET_KEY_LISTED_REFUSAL });
    expect(state.signed).toEqual([]);
    // the lookup is scoped to the key's workspace
    expect(ticketReads()[0].filters).toEqual(expect.arrayContaining([["eq", ["org_id", ORG]], ["contains", ["attachments", JSON.stringify([{ url: KEY }])]]]));
  });

  it("REGRESSION — a fresh upload key (no request lists it): signed exactly as before, the response byte-identical, no storage check", async () => {
    const res = await up(KEY);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify({ url: "https://signed.example/put", path: KEY }));
    expect(state.signed).toEqual([KEY]);
    expect(state.sends).toEqual([]);
  });

  it("REGRESSION — the backup restore's put-back: a key the restored request lists but that is NOT in storage is signed as before", async () => {
    state.listed = [KEY];
    const res = await up(KEY);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify({ url: "https://signed.example/put", path: KEY }));
    expect(state.sends.map((s) => s.name)).toEqual(["HeadObjectCommand"]);
  });

  it("REGRESSION — a key outside orgs/<org>/tickets/ makes no request lookup and is signed as before", async () => {
    const doc = `orgs/${ORG}/libraries/l1/1-a.pdf`;
    const res = await up(doc);
    expect(res.status).toBe(200);
    expect(ticketReads()).toEqual([]);
    expect(state.signed).toEqual([doc]);
  });

  it("fail closed: the request lookup errors → 503 in plain words, nothing signed; the storage check errors (not a 404) → 503", async () => {
    state.ticketsErr = { message: "timeout" };
    let res = await up(KEY);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: TICKET_KEY_UNVERIFIED });
    state.ticketsErr = null; state.listed = [KEY]; state.headErr = new Error("socket hang up");
    res = await up(KEY);
    expect(res.status).toBe(503);
    expect(state.signed).toEqual([]);
  });

  it("PKG-1 is unchanged and asked first: a published revision's key is refused with its own words", async () => {
    state.versionClash = true; state.listed = [KEY]; state.stored = [KEY];
    const res = await up(KEY);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already belongs to a published revision/);
    expect(ticketReads()).toEqual([]);
  });
});

describe("EVID-17 — the multipart door: refused at create and at complete; sign and abort unchanged", () => {
  it("a listed, stored key: create and complete are refused (409) and nothing reaches storage but the check", async () => {
    state.listed = [KEY]; state.stored = [KEY];
    for (const action of ["create", "complete"]) {
      state.sends = [];
      const res = await mp({ action, path: KEY, contentType: "application/pdf", uploadId: "up-1", parts: [{ partNumber: 1, etag: "e" }] });
      expect(res.status, action).toBe(409);
      expect(state.sends.map((s) => s.name), action).toEqual(["HeadObjectCommand"]);
    }
  });

  it("an upload opened before the file was attached cannot complete over it afterwards", async () => {
    expect((await mp({ action: "create", path: KEY, contentType: "application/pdf" })).status).toBe(200);
    state.listed = [KEY]; state.stored = [KEY]; state.sends = [];
    const res = await mp({ action: "complete", path: KEY, uploadId: "up-1", parts: [{ partNumber: 1, etag: "e" }] });
    expect(res.status).toBe(409);
    expect(state.sends.some((s) => s.name === "CompleteMultipartUploadCommand")).toBe(false);
  });

  it("REGRESSION — a fresh key: create, sign, complete as before; signing a part and aborting never ask (an abort must always work)", async () => {
    expect(await (await mp({ action: "create", path: KEY, contentType: "application/pdf" })).json()).toEqual({ uploadId: "up-1" });
    expect((await mp({ action: "complete", path: KEY, uploadId: "up-1", parts: [{ partNumber: 1, etag: "e" }] })).status).toBe(200);
    state.listed = [KEY]; state.stored = [KEY]; state.reads = [];
    expect((await mp({ action: "sign", path: KEY, uploadId: "up-1", partNumber: 1 })).status).toBe(200);
    expect((await mp({ action: "abort", path: KEY, uploadId: "up-1" })).status).toBe(200);
    expect(ticketReads()).toEqual([]);
  });

  it("fail closed at create: a lookup error is 503, no upload opened", async () => {
    state.ticketsErr = { message: "timeout" };
    const res = await mp({ action: "create", path: KEY, contentType: "application/pdf" });
    expect(res.status).toBe(503);
    expect(state.sends.some((s) => s.name === "CreateMultipartUploadCommand")).toBe(false);
  });
});

describe("EVID-17 — lib/ticketKeyOverwrite.ts", () => {
  it("only keys under orgs/<org>/tickets/ are request files (the staging folder included)", () => {
    expect(ticketKeyOrg(KEY)).toBe(ORG);
    expect(ticketKeyOrg(`orgs/${ORG}/tickets/pending/u1/b1/x.pdf`)).toBe(ORG);
    expect(ticketKeyOrg(`orgs/${ORG}/libraries/l1/x.pdf`)).toBeNull();
    expect(ticketKeyOrg(`tickets/${ORG}/x.pdf`)).toBeNull();
    expect(ticketKeyOrg(`orgs/${ORG}/project-intake/p/redlines/x.pdf`)).toBeNull();
  });
});
