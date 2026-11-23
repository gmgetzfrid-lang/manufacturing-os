import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CODE_LOCK_AT, SHARE_TOKEN_RE, gateShare, hashShareCode, isMissingShareColumn, isValidMarkupPath,
  newShareCode, newShareToken, shareItems, shareStatus, verifyShareCode, withLegacyDefaults, fileKind,
  type ShareRow,
} from "@/lib/shareLinks";
import { createFakeDb } from "./fakeShareDb";

const ORG = "215b762d-7be4-4cbd-bdb1-4b2703d81296";
const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";

describe("link tokens and codes", () => {
  it("makes 32-character url-safe tokens and 6-digit codes", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newShareToken()));
    expect(tokens.size).toBe(50);
    for (const t of tokens) { expect(t).toHaveLength(32); expect(SHARE_TOKEN_RE.test(t)).toBe(true); }
    const codes = Array.from({ length: 200 }, () => newShareCode());
    for (const c of codes) expect(c).toMatch(/^\d{6}$/);
    expect(new Set(codes).size).toBeGreaterThan(150);
  });

  it("keeps only a hash, which checks the right code and nothing else", async () => {
    const token = newShareToken();
    const stored = await hashShareCode("048213", token);
    expect(stored).not.toContain("048213");
    expect(await verifyShareCode("048213", token, stored)).toBe(true);
    expect(await verifyShareCode("048214", token, stored)).toBe(false);
    expect(await verifyShareCode("48213", token, stored)).toBe(false);
    expect(await verifyShareCode("04821a", token, stored)).toBe(false);
    // The salt is the link's token: the same code on another link is another hash.
    expect(await verifyShareCode("048213", newShareToken(), stored)).toBe(false);
    expect(await hashShareCode("048213", newShareToken())).not.toBe(stored);
    expect(await verifyShareCode("048213", token, "plain")).toBe(false);
  });
});

describe("what a link covers", () => {
  it("accepts a marked-up copy only from this workspace's shares folder", () => {
    expect(isValidMarkupPath(`orgs/${ORG}/shares/abc.pdf`, ORG)).toBe(true);
    expect(isValidMarkupPath(`orgs/${ORG}/shares/../libraries/x.pdf`, ORG)).toBe(false);
    expect(isValidMarkupPath(`orgs/${ORG}/shares/a..b.pdf`, ORG)).toBe(false);
    expect(isValidMarkupPath(`orgs/00000000-0000-4000-8000-000000000000/shares/abc.pdf`, ORG)).toBe(false);
    expect(isValidMarkupPath(`orgs/${ORG}/libraries/abc.pdf`, ORG)).toBe(false);
    expect(isValidMarkupPath(`/orgs/${ORG}/shares/abc.pdf`, ORG)).toBe(false);
    expect(isValidMarkupPath(`orgs/${ORG}/shares//abc.pdf`, ORG)).toBe(false);
    expect(isValidMarkupPath(`orgs/${ORG}/shares/abc.dwg`, ORG)).toBe(false);
    expect(isValidMarkupPath(`orgs/${ORG}/shares/a\\b.pdf`, ORG)).toBe(false);
    expect(isValidMarkupPath(42, ORG)).toBe(false);
  });

  it("reads a link made before sets as its one document, and a set as its items", () => {
    expect(shareItems({ document_id: D1, items: null })).toEqual([{ documentId: D1, markupPath: null }]);
    expect(shareItems({ document_id: D1 })).toEqual([{ documentId: D1, markupPath: null }]);
    const set = shareItems({
      document_id: D1, org_id: ORG,
      items: [
        { documentId: D1, markupPath: null },
        { documentId: D2, markupPath: `orgs/${ORG}/shares/m.pdf` },
        { documentId: D2, markupPath: null },          // duplicate: dropped
        { documentId: "not-an-id" },                   // junk: dropped
      ],
    });
    expect(set).toEqual([{ documentId: D1, markupPath: null }, { documentId: D2, markupPath: `orgs/${ORG}/shares/m.pdf` }]);
    // A markup path pointing anywhere else is never served.
    expect(shareItems({ document_id: D1, org_id: ORG, items: [{ documentId: D1, markupPath: "orgs/other/x.pdf" }] }))
      .toEqual([{ documentId: D1, markupPath: null }]);
  });

  it("treats links from before the migration as no code, download allowed", () => {
    const r = withLegacyDefaults({ id: "s", token: "t", org_id: ORG, document_id: D1 });
    expect(r.allow_download).toBe(true);
    expect(r.code_hash).toBeNull();
    expect(r.code_failures).toBe(0);
    expect(r.items).toBeNull();
    expect(withLegacyDefaults({ allow_download: false }).allow_download).toBe(false);
  });

  it("knows what can carry the stamp", () => {
    expect(fileKind("orgs/x/a.PDF")).toBe("pdf");
    expect(fileKind("orgs/x/a.png")).toBe("png");
    expect(fileKind("orgs/x/a.jpeg")).toBe("jpg");
    expect(fileKind("orgs/x/a", "application/pdf")).toBe("pdf");
    expect(fileKind("orgs/x/a.dwg")).toBe("other");
  });

  it("spots the missing-column answer from Postgres and PostgREST", () => {
    expect(isMissingShareColumn({ code: "42703", message: "column document_shares.items does not exist" })).toBe(true);
    expect(isMissingShareColumn({ code: "PGRST204", message: "Could not find the 'items' column of 'document_shares' in the schema cache" })).toBe(true);
    expect(isMissingShareColumn({ message: "column \"code_hash\" does not exist" })).toBe(true);
    expect(isMissingShareColumn({ code: "23505", message: "duplicate key" })).toBe(false);
    expect(isMissingShareColumn(null)).toBe(false);
  });
});

describe("opening a link", () => {
  const base = (over: Partial<ShareRow> = {}): ShareRow => ({
    id: "s1", token: "tok_tok_tok_tok_tok_tok_tok_tok_", org_id: ORG, document_id: D1, items: null,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(), revoked_at: null, created_by: "u1",
    created_by_name: "Grant", created_at: null, recipient: "John", note: null, allow_download: true,
    code_hash: null, code_failures: 0, access_count: 0, access_last_at: null, ...over,
  });

  it("says turned off, expired and locked, in that order", () => {
    expect(shareStatus(base())).toBe("ok");
    expect(shareStatus(base({ revoked_at: "2026-01-01T00:00:00Z", expires_at: "2020-01-01T00:00:00Z" }))).toBe("revoked");
    expect(shareStatus(base({ expires_at: "2020-01-01T00:00:00Z" }))).toBe("expired");
    expect(shareStatus(base({ code_hash: "scrypt1$00", code_failures: CODE_LOCK_AT }))).toBe("locked");
    // Without a code there's nothing to lock.
    expect(shareStatus(base({ code_failures: CODE_LOCK_AT }))).toBe("ok");
  });

  it("asks for the code, counts wrong ones, and locks at ten for good", async () => {
    const fake = createFakeDb();
    const row = base({ code_hash: await hashShareCode("123456", "tok_tok_tok_tok_tok_tok_tok_tok_") });
    fake.tables.document_shares = [{ ...row }];
    const sb = fake.client as unknown as SupabaseClient;
    const fresh = (): ShareRow => ({ ...row, ...(fake.tables.document_shares[0] as Partial<ShareRow>) });

    expect(await gateShare(sb, fresh(), null)).toEqual({ ok: false, status: 401, error: "code" });
    expect(await gateShare(sb, fresh(), "123456")).toEqual({ ok: true });
    expect(fake.tables.document_shares[0].code_failures).toBe(0);

    for (let i = 1; i < CODE_LOCK_AT; i++) {
      expect(await gateShare(sb, fresh(), "000000")).toEqual({ ok: false, status: 401, error: "badcode" });
      expect(fake.tables.document_shares[0].code_failures).toBe(i);
    }
    expect(await gateShare(sb, fresh(), "999999")).toEqual({ ok: false, status: 423, error: "locked" });
    // Locked: even the right code no longer opens it.
    expect(await gateShare(sb, fresh(), "123456")).toEqual({ ok: false, status: 423, error: "locked" });
  });

  it("counts a wrong code once even when another landed first", async () => {
    const fake = createFakeDb();
    const row = base({ code_hash: await hashShareCode("123456", "tok_tok_tok_tok_tok_tok_tok_tok_") });
    fake.tables.document_shares = [{ ...row, code_failures: 3 }];
    // This request read the row when it still said 2.
    await gateShare(fake.client as unknown as SupabaseClient, { ...row, code_failures: 2 }, "000000");
    expect(fake.tables.document_shares[0].code_failures).toBe(4);
  });

  it("ignores a code on a link that doesn't ask for one", async () => {
    const fake = createFakeDb();
    expect(await gateShare(fake.client as unknown as SupabaseClient, base(), "000000")).toEqual({ ok: true });
  });
});
