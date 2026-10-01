// document-control Round F wave 3 — P15 SURFACE REMAINDERS: public-surfaces
// SHR-14 done-when 3. The share modal's mint gate asks the database's
// download-deny predicate (user_download_denied, 20261140 — callable for
// oneself) and says why instead of offering the Create box; createShareLink
// names the deny when the INSERT policy refuses for it. Before 20261140 is
// pasted the predicate is absent and so is the rail: the mint behaves as
// before (offered), and the reason is logged — never an admission the server
// would refuse, never a refusal it would not make.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
type Err = { message: string; code?: string } | null;

const state = vi.hoisted(() => ({
  doc: null as Row | null,
  docError: null as { message: string } | null,
  holds: { data: [] as Row[], error: null as { message: string } | null },
  insertError: null as { message: string; code?: string } | null,
  inserts: [] as Row[],
  rpc: {} as Record<string, { data: unknown; error: { message: string; code?: string } | null } | "throw">,
  rpcCalls: [] as Array<{ fn: string; args: Row }>,
  selects: [] as Array<{ table: string; cols: unknown }>,
  audits: [] as Row[],
}));

function chain(table: string) {
  let op: "select" | "insert" = "select";
  let payload: Row = {};
  const c: Row = {};
  const handler: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve(table === "document_holds" ? state.holds : { data: [], error: null });
      }
      return (...args: unknown[]) => {
        if (prop === "select") state.selects.push({ table, cols: args[0] });
        if (prop === "insert") { op = "insert"; payload = args[0] as Row; }
        if (prop === "maybeSingle" || prop === "single") {
          if (op === "insert") {
            state.inserts.push(payload);
            return Promise.resolve(state.insertError ? { data: null, error: state.insertError } : { data: { id: "new-share", ...payload }, error: null });
          }
          if (table === "documents") return Promise.resolve(state.docError ? { data: null, error: state.docError } : { data: state.doc, error: null });
          if (table === "document_versions") {
            return Promise.resolve({ data: { id: "v-cur", file_url: "k", revision_label: "B", review_state: "approved", is_branch: false, superseded_at: null }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }
        return new Proxy(c, handler);
      };
    },
  };
  return new Proxy(c, handler);
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: async (fn: string, args: Row) => {
      state.rpcCalls.push({ fn, args });
      const r = state.rpc[fn];
      if (r === "throw") throw new Error("network down");
      return r ?? { data: null, error: null };
    },
    auth: { getSession: async () => ({ data: { session: null } }) },
  },
}));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async (e: Row) => { state.audits.push(e); return { error: null }; }) }));

import {
  shareMintDownloadDenial, mintDenialNotice, createShareLink, loadShareDocumentContext, canMintShare,
  SHARE_DOWNLOAD_DENIED, SHARE_MINT_REFUSED, type ShareMintDenial,
} from "@/lib/documentShares";

const ACL = { deny: { teams: { download: ["team-vendor"] } } };
const issuedDoc = (over: Row = {}): Row => ({
  id: "docA", rev: "A", status: "Issued", archived_at: null, library_id: "lib1", current_version_id: "v-cur", acl_index: ACL, ...over,
});
const input = { orgId: "orgA", documentId: "docA", createdBy: "u1", createdByName: "u" };
const POLICY_REFUSAL: Err = { message: 'new row violates row-level security policy for table "document_shares"', code: "42501" };

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.doc = issuedDoc();
  state.docError = null;
  state.holds = { data: [], error: null };
  state.insertError = null;
  state.inserts = [];
  state.rpc = {};
  state.rpcCalls = [];
  state.selects = [];
  state.audits = [];
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { warn.mockRestore(); });

describe("SHR-14 dw3 — shareMintDownloadDenial asks the database's own predicate, for oneself", () => {
  it("passes the document's acl_index, the caller's uid and the org — the 20261140 signature", async () => {
    state.rpc.user_download_denied = { data: false, error: null };
    expect(await shareMintDownloadDenial({ orgId: "orgA", uid: "u1", aclIndex: ACL })).toEqual({ kind: "clear" });
    expect(state.rpcCalls).toEqual([{ fn: "user_download_denied", args: { p_acl_index: ACL, p_uid: "u1", p_org: "orgA" } }]);
    // the named arguments are the function's own (PostgREST resolves by name)
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261140_dc_roundF_share_download_deny_rail.sql"), "utf8");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION user_download_denied(p_acl_index jsonb, p_uid uuid, p_org uuid)");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION user_download_denied(jsonb, uuid, uuid) TO authenticated, service_role;");
  });
  it("a deny that names the creator → denied, with the sentence that says why", async () => {
    state.rpc.user_download_denied = { data: true, error: null };
    const d = await shareMintDownloadDenial({ orgId: "orgA", uid: "u1", aclIndex: ACL });
    expect(d).toEqual({ kind: "denied", reason: SHARE_DOWNLOAD_DENIED });
    expect(SHARE_DOWNLOAD_DENIED).toMatch(/denied download on this document/);
    expect(mintDenialNotice(d)).toBe(SHARE_DOWNLOAD_DENIED);
  });
  it("a missing acl_index is sent as null (the predicate answers false for it)", async () => {
    state.rpc.user_download_denied = { data: false, error: null };
    await shareMintDownloadDenial({ orgId: "orgA", uid: "u1", aclIndex: undefined });
    expect(state.rpcCalls[0].args.p_acl_index).toBeNull();
  });
  it("pre-paste (PGRST202 / 42883 — the function is absent): unchecked, the reason LOGGED, and the Create box is offered as before", async () => {
    for (const error of [
      { code: "PGRST202", message: "Could not find the function public.user_download_denied(p_acl_index, p_org, p_uid) in the schema cache" },
      { code: "42883", message: "function user_download_denied(jsonb, uuid, uuid) does not exist" },
    ]) {
      warn.mockClear();
      state.rpc.user_download_denied = { data: null, error };
      const d = await shareMintDownloadDenial({ orgId: "orgA", uid: "u1", aclIndex: ACL });
      expect(d.kind).toBe("unchecked");
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/user_download_denied is not installed \(migration 20261140 is not applied\)/));
      expect(mintDenialNotice(d)).toBeNull(); // today's behaviour: offered
    }
  });
  it("any other failure fails CLOSED: unknown, nothing offered, the reason said", async () => {
    state.rpc.user_download_denied = { data: null, error: { code: "42501", message: "user_download_denied answers only for the signed-in caller." } };
    let d = await shareMintDownloadDenial({ orgId: "orgA", uid: "u1", aclIndex: ACL });
    expect(d.kind).toBe("unknown");
    expect(mintDenialNotice(d)).toMatch(/Couldn't confirm that you may download this document \(user_download_denied answers only/);
    state.rpc.user_download_denied = "throw";
    d = await shareMintDownloadDenial({ orgId: "orgA", uid: "u1", aclIndex: ACL });
    expect(d.kind).toBe("unknown");
    expect(mintDenialNotice(d)).toMatch(/network down/);
  });
  it("mintDenialNotice: only `denied` and `unknown` take the Create box away", () => {
    const cases: Array<[ShareMintDenial, boolean]> = [
      [{ kind: "clear" }, false],
      [{ kind: "unchecked", reason: "x" }, false],
      [{ kind: "denied", reason: "d" }, true],
      [{ kind: "unknown", reason: "u" }, true],
    ];
    for (const [d, blocks] of cases) expect(mintDenialNotice(d) !== null).toBe(blocks);
  });
});

describe("SHR-14 dw3 — loadShareDocumentContext hands the modal the document's acl_index", () => {
  it("selects acl_index with the context and returns it", async () => {
    const ctx = await loadShareDocumentContext("docA");
    expect(state.selects).toContainEqual({ table: "documents", cols: "rev, status, archived_at, library_id, current_version_id, acl_index" });
    expect(ctx.aclIndex).toEqual(ACL);
    state.doc = issuedDoc({ acl_index: undefined });
    expect((await loadShareDocumentContext("docA")).aclIndex).toBeNull();
  });
});

describe("SHR-14 dw3 — createShareLink says the deny when the policy refuses for it (and only then)", () => {
  it("REGRESSION: a legitimate mint still mints — no predicate call on the way, one audit row", async () => {
    const made = await createShareLink({ ...input, expiresInDays: 7 });
    expect(made.id).toBe("new-share");
    expect(state.inserts).toHaveLength(1);
    expect(state.rpcCalls).toEqual([]);
    expect(state.audits.map((a) => a.action)).toEqual(["SHARE_LINK_CREATED"]);
  });
  it("a policy refusal the predicate attributes to a download deny names it", async () => {
    state.insertError = POLICY_REFUSAL;
    state.rpc.user_download_denied = { data: true, error: null };
    await expect(createShareLink(input)).rejects.toThrow(`This link was not created. ${SHARE_DOWNLOAD_DENIED}`);
    expect(state.rpcCalls).toEqual([{ fn: "user_download_denied", args: { p_acl_index: ACL, p_uid: "u1", p_org: "orgA" } }]);
    expect(state.audits).toEqual([]);
  });
  it("any other policy refusal (the tier, the predicate absent or failing, the document unreadable) keeps the general sentence", async () => {
    state.insertError = POLICY_REFUSAL;
    state.rpc.user_download_denied = { data: false, error: null };
    await expect(createShareLink(input)).rejects.toThrow(SHARE_MINT_REFUSED);
    state.rpc.user_download_denied = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    await expect(createShareLink(input)).rejects.toThrow(SHARE_MINT_REFUSED);
    state.rpc.user_download_denied = "throw";
    await expect(createShareLink(input)).rejects.toThrow(SHARE_MINT_REFUSED);
  });
  it("canMintShare is unchanged (the tier answer — the deny is a separate question)", async () => {
    expect(await canMintShare({ orgId: "orgA", uid: "u1", libraryId: null, isController: true })).toBe(true);
    expect(state.rpcCalls).toEqual([]);
  });
});

describe("SHR-14 dw3 — the modal asks the predicate and says why instead of offering Create", () => {
  const m = readFileSync(join(process.cwd(), "components/documents/ShareLinkModal.tsx"), "utf8");
  it("asks it with the creator's uid and the context's acl_index, beside the tier and the refusal", () => {
    expect(m).toMatch(/const \[allowed, why, denial\] = await Promise\.all\(\[\s*\n\s*canMintShare\(\{ orgId, uid: createdBy, libraryId: ctx\.libraryId, isController \}\),\s*\n\s*shareRefusalState\(documentId\),\s*\n\s*shareMintDownloadDenial\(\{ orgId, uid: createdBy, aclIndex: ctx\.aclIndex \}\),\s*\n\s*\]\);/);
    expect(m).toContain("setMintDenial(mintDenialNotice(denial));");
  });
  it("the Create box needs no deny; the deny box is drawn for a minter the deny stops", () => {
    expect(m).toContain("const showCreate = readable && canMint === true && refusal === null && mintDenial === null;");
    expect(m).toMatch(/\{readable && !loading && canMint === true && mintDenial && \([\s\S]{0,400}?data-testid="share-mint-denied"[\s\S]{0,400}?No new link can be created: \{mintDenial\}/);
  });
  it("an unreadable document or a failed context read leaves no deny standing from an earlier read", () => {
    const refresh = m.slice(m.indexOf("const refresh = useCallback(async () => {"), m.indexOf("}, [documentId, orgId, createdBy, isController]);"));
    expect(refresh).toMatch(/if \(!readableNow\) \{[\s\S]*?setMintDenial\(null\);\s*\n\s*return;/);
    expect(refresh).toContain("setError((e as Error).message); setCanMint(null); setServed(null); setMintDenial(null);");
  });
});
