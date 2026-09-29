// Document-control Round F — P10 EDGES: the export / restore contract.
//
//   EGR-7 / XEDGE-10  bearer columns are nulled on export (dumpTable applies
//                     redactRow) and never reinstated on restore: a restored
//                     share / intake link arrives with a placeholder token and
//                     revoked, a transmittal with no portal token, an export
//                     destination with no credentials and disabled.
//   XEDGE-3           download_audits joins IMMUTABLE_TABLES; /apply-table
//                     refuses audit_logs and download_audits with 400 before
//                     any write; /begin leaves a RESTORE_BEGIN audit row as a
//                     checked write.
//   XEDGE-14          the Stripe webhook derives subscribed_plan from the
//                     price id, falls back to metadata, and a null plan leaves
//                     the stored value untouched.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

type Call = { m: string; args: unknown[] };
type Logged = { table: string; calls: Call[] };

const state = vi.hoisted(() => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  return {
    log: [] as Array<{ table: string; calls: Array<{ m: string; args: unknown[] }> }>,
    resolver: ((): unknown => ({ data: null, error: null })) as unknown as (table: string, calls: Array<{ m: string; args: unknown[] }>) => unknown,
    event: null as unknown,
  };
});

/** A thenable Proxy chain: every method call is recorded, `await` resolves
 *  through `state.resolver(table, calls)`. */
function makeClient() {
  return {
    from(table: string) {
      const calls: Call[] = [];
      const proxy: Record<string, unknown> = new Proxy(function () {} as unknown as Record<string, unknown>, {
        get(_t, p: string) {
          if (p === "then") {
            return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
              state.log.push({ table, calls });
              try { resolve(state.resolver(table, calls)); } catch (e) { reject(e); }
            };
          }
          return (...args: unknown[]) => { calls.push({ m: p, args }); return proxy; };
        },
      });
      return proxy;
    },
  };
}

vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: vi.fn(async (_req: unknown, orgId: string) => ({
    userId: "admin-1", email: "admin@x", orgId, role: "Admin", roles: ["Admin"], admin: makeClient(),
  })),
  assertOrgHasAccess: vi.fn(async () => null),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeClient() }));
vi.mock("@/lib/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stripe")>()),
  getStripe: () => ({ webhooks: { constructEvent: () => state.event } }),
  isStripeConfigured: () => true,
}));

import { REDACT_COLUMNS } from "@/lib/exportTables";
import {
  IMMUTABLE_TABLES, isImmutableTable, isSkippedTable, planRestore, remapRow, scrubRestoredRow, RESTORED_TOKEN_PREFIX,
  RESTORED_TRANSMITTAL_NOTE,
} from "@/lib/dataRestore";
import { planFromSubscription, getPlanForPriceId } from "@/lib/stripe";
import { POST as applyTable } from "@/app/api/admin/restore/apply-table/route";
import { POST as begin } from "@/app/api/admin/restore/begin/route";
import { POST as stripeWebhook } from "@/app/api/stripe/webhook/route";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const logged = (table: string) => state.log.filter((l) => l.table === table);
const firstArg = (l: Logged, m: string) => l.calls.find((c) => c.m === m)?.args[0];

beforeEach(() => {
  state.log = [];
  state.resolver = () => ({ data: null, error: null });
});

describe("EGR-7 / XEDGE-10 — the restore never reinstates a bearer column", () => {
  const idRemap = { orgId: { "old-org": "new-org" }, uid: {} };

  it("a restored share gets an unguessable placeholder token and arrives revoked", () => {
    const row = remapRow({ id: "s1", org_id: "old-org", token: "live-token-from-old-backup", revoked_at: null, note: "n" }, idRemap);
    expect(row.org_id).toBe("new-org");
    expect(String(row.token)).toMatch(new RegExp(`^${RESTORED_TOKEN_PREFIX}[0-9a-f-]{36}$`));
    expect(row.token).not.toBe("live-token-from-old-backup");
    expect(typeof row.revoked_at).toBe("string");
    expect(row.note).toBe("n");
    // two restored rows never collide on the UNIQUE token
    const again = remapRow({ id: "s2", org_id: "old-org", token: null, revoked_at: null }, idRemap);
    expect(again.token).not.toBe(row.token);
  });

  it("a redacted (null) token from a redacted backup lands the same way; an existing revocation is preserved", () => {
    const row = scrubRestoredRow({ token: null, revoked_at: "2026-01-01T00:00:00.000Z" }, "2026-09-23T00:00:00.000Z");
    expect(String(row.token)).toMatch(/^restored-/);
    expect(row.revoked_at).toBe("2026-01-01T00:00:00.000Z");
    const fresh = scrubRestoredRow({ token: null, revoked_at: null }, "2026-09-23T00:00:00.000Z");
    expect(fresh.revoked_at).toBe("2026-09-23T00:00:00.000Z");
  });

  it("a transmittal's portal token is nulled and an ISSUED one lands VOIDED, so the insert rail cannot mint a fresh token", () => {
    // trg_transmittals_guard (20261027) mints NEW.portal_token for every row
    // INSERTED with status 'issued' — the exact re-mint DEC-44 rejects.
    const trigger = src("supabase/migrations/20261027_dc_phase1_unguarded_doors.sql");
    expect(trigger).toMatch(/IF NEW\.status = 'issued'\s+AND \(TG_OP = 'INSERT' OR OLD\.status IS DISTINCT FROM 'issued'\) THEN\s+NEW\.portal_token := /);
    const issued = scrubRestoredRow({ id: "t", portal_token: "abc", status: "issued", notes: "sent 3 sheets" });
    expect(issued).toEqual({ id: "t", portal_token: null, status: "voided", notes: `sent 3 sheets\n\n${RESTORED_TRANSMITTAL_NOTE}` });
    expect(scrubRestoredRow({ id: "t", portal_token: "abc", status: "issued", notes: null }).notes).toBe(RESTORED_TRANSMITTAL_NOTE);
    // draft / acknowledged / voided rows never trip the mint condition and keep their status
    for (const status of ["draft", "acknowledged", "voided"]) {
      expect(scrubRestoredRow({ id: "t", portal_token: "abc", status, notes: "n" })).toEqual({ id: "t", portal_token: null, status, notes: "n" });
    }
    const dest = scrubRestoredRow({
      id: "d", enabled: true, bucket: "b",
      access_key_id_encrypted: "enc", secret_access_key_encrypted: "enc", webhook_secret_encrypted: "enc",
    });
    expect(dest).toEqual({ id: "d", enabled: false, bucket: "b", access_key_id_encrypted: null, secret_access_key_encrypted: null, webhook_secret_encrypted: null });
  });

  it("a row with no bearer column is returned as-is; the input is never mutated", () => {
    const doc = { id: "x", file_url: "orgs/old-org/a.pdf", enabled: true };
    expect(scrubRestoredRow(doc)).toBe(doc);
    const share = { token: "t", revoked_at: null };
    scrubRestoredRow(share);
    expect(share).toEqual({ token: "t", revoked_at: null });
  });

  it("the export applies the redaction to every dumped row and tells the reader (manifest, notes, README)", () => {
    const e = src("lib/dataExport.ts");
    expect(e).toMatch(/out\.push\(\.\.\.rows\.map\(\(r\) => redactRow\(table, r as Record<string, unknown>\)\)\)/);
    expect(e).toMatch(/redactedColumns: Record<string, string\[\]>;/);
    expect(e).toMatch(/REDACTED credential columns \(secrets never leave the database\)/);
    expect(e).not.toMatch(/"Every column from the source schema is preserved verbatim\. JSON keys/);
    expect(e).toMatch(/a restored transmittal has no portal link \(an issued one arrives VOIDED on the register/);
    const r = src("lib/exportRunner.ts");
    expect(r).toMatch(/## Redacted credential columns/);
    expect(r).toMatch(/a restored transmittal has no portal link \(an issued one arrives VOIDED on the register/);
    expect(r).toMatch(/\$\{omittedNote\}\$\{shedNote\}\$\{redactedNote\}/);
    // the decision is written down next to the ai_connections exclusion
    expect(src("lib/exportTables.ts")).toMatch(/re-issued, never\s+\*\s+revived/);
    expect(Object.keys(REDACT_COLUMNS)).toContain("export_destinations");
  });
});

describe("XEDGE-3 — restore audit / immutability residual", () => {
  const post = (path: string, body: unknown) =>
    new NextRequest(`https://app${path}?orgId=org-1`, {
      method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
    });

  it("download_audits is immutable: never planned in, refused by the chunked route with 400 before any write", async () => {
    expect(IMMUTABLE_TABLES.download_audits).toMatch(/download egress/);
    expect(isImmutableTable("download_audits")).toBe(true);
    expect(isSkippedTable("download_audits")).toBe(true);
    const plan = planRestore({ manifest: { orgId: "b" }, tables: { download_audits: [{}, {}], documents: [{}] } }, { orgId: "c", orgName: "x", members: [] });
    expect(plan.counts.tables.find((t) => t.name === "download_audits")).toMatchObject({ willImport: false, rows: 2 });
    expect(plan.counts.totalRows).toBe(1);

    for (const table of ["audit_logs", "download_audits", "e_signatures", "document_acknowledgments", "document_review_signoffs"]) {
      state.log = [];
      const res = await applyTable(post("/api/admin/restore/apply-table", { table, rows: [{ id: "x" }], idRemap: { orgId: {}, uid: {} } }));
      expect(res.status, table).toBe(400);
      expect((await res.json()).error, table).toMatch(/append-only|never restored/);
      expect(state.log, `${table} must not touch the database`).toEqual([]);
    }
  });

  it("the chunked route lands a share row scrubbed: placeholder token, revoked, org forced", async () => {
    state.resolver = (table) => (table === "document_shares" ? { data: null, error: null, count: 1 } : { data: null, error: null });
    const res = await applyTable(post("/api/admin/restore/apply-table", {
      table: "document_shares",
      rows: [{ id: "s1", org_id: "hostile-org", token: "live", revoked_at: null }],
      idRemap: { orgId: { "hostile-org": "org-1" }, uid: {} },
    }));
    expect(res.status).toBe(200);
    const up = logged("document_shares")[0];
    const chunk = firstArg(up, "upsert") as Array<Record<string, unknown>>;
    expect(chunk[0].org_id).toBe("org-1");
    expect(String(chunk[0].token)).toMatch(/^restored-/);
    expect(chunk[0].revoked_at).toBeTruthy();
    expect((firstArg(logged("audit_logs")[0], "insert") as { action: string }).action).toBe("RESTORE_CHUNK");
  });

  it("/begin writes a RESTORE_BEGIN audit row naming the backup, as a checked write", async () => {
    state.resolver = (table) => {
      if (table === "orgs") return { data: { name: "Acme" }, error: null };
      if (table === "org_members") return { data: [], error: null };
      return { data: null, error: null };
    };
    const res = await begin(post("/api/admin/restore/begin", { manifest: { orgId: "backup-org", orgName: "Acme" }, orgMembers: [] }));
    expect(res.status).toBe(200);
    const audit = firstArg(logged("audit_logs")[0], "insert") as { action: string; details: Record<string, unknown>; user_id: string };
    expect(audit.action).toBe("RESTORE_BEGIN");
    expect(audit.user_id).toBe("admin-1");
    expect(audit.details).toMatchObject({ backupOrgId: "backup-org", backupOrgName: "Acme", membersInBackup: 0, createdUsers: 0, linkedUsers: 0 });

    state.log = [];
    state.resolver = (table) => {
      if (table === "orgs") return { data: { name: "Acme" }, error: null };
      if (table === "org_members") return { data: [], error: null };
      if (table === "audit_logs") return { data: null, error: { message: "trail down" } };
      return { data: null, error: null };
    };
    const failed = await begin(post("/api/admin/restore/begin", { manifest: { orgId: "backup-org" }, orgMembers: [] }));
    expect(failed.status).toBe(500);
    expect((await failed.json()).error).toMatch(/restore audit row failed: trail down/);
  });
});

describe("XEDGE-14 — subscribed_plan from the price id, never NULL over a paying workspace", () => {
  const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { await fn(); } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  };

  it("planFromSubscription: price id wins, metadata is the fallback, nothing is null", async () => {
    await withEnv({ STRIPE_PRICE_STARTER: "price_s", STRIPE_PRICE_GROWTH: "price_g", STRIPE_PRICE_ENTERPRISE: undefined }, async () => {
      expect(getPlanForPriceId("price_g")).toBe("growth");
      expect(getPlanForPriceId("price_s")).toBe("starter");
      expect(getPlanForPriceId("price_nope")).toBeNull();
      expect(getPlanForPriceId(null)).toBeNull();
      expect(planFromSubscription({ items: { data: [{ price: { id: "price_g" } }] }, metadata: { plan: "starter" } })).toEqual({ plan: "growth", source: "price" });
      expect(planFromSubscription({ items: { data: [{ price: { id: "price_nope" } }] }, metadata: { plan: "starter" } })).toEqual({ plan: "starter", source: "metadata" });
      // a multi-item subscription (seat add-on first, plan second): every item is tried before metadata
      expect(planFromSubscription({ items: { data: [{ price: { id: "price_seat_addon" } }, { price: { id: "price_g" } }] }, metadata: { plan: "starter" } })).toEqual({ plan: "growth", source: "price" });
      expect(planFromSubscription({ items: { data: [{ price: null }, {}, { price: { id: "price_s" } }] }, metadata: {} })).toEqual({ plan: "starter", source: "price" });
      expect(planFromSubscription({ items: { data: [{ price: { id: "price_nope" } }] }, metadata: {} })).toEqual({ plan: null, source: null });
      expect(planFromSubscription({})).toEqual({ plan: null, source: null });
    });
  });

  const subscriptionUpdated = (priceId: string, metadata: Record<string, string>) => ({
    type: "customer.subscription.updated",
    data: { object: { id: "sub_1", status: "active", customer: "cus_1", metadata, items: { data: [{ price: { id: priceId } }] }, current_period_end: 1_800_000_000 } },
  });
  const deliver = () => stripeWebhook(new NextRequest("https://app/api/stripe/webhook", {
    method: "POST", headers: { "stripe-signature": "sig" }, body: "{}",
  }));

  it("a subscription.updated event whose metadata lacks `plan` and whose price is unmapped leaves subscribed_plan untouched", async () => {
    await withEnv({ STRIPE_PRICE_STARTER: "price_s", STRIPE_PRICE_GROWTH: "price_g" }, async () => {
      state.event = subscriptionUpdated("price_portal_only", { org_id: "org-1" });
      const res = await deliver();
      expect(res.status).toBe(200);
      const update = firstArg(logged("orgs")[0], "update") as Record<string, unknown>;
      expect(update.subscription_status).toBe("active");
      expect("subscribed_plan" in update).toBe(false);
      const audit = firstArg(logged("audit_logs")[0], "insert") as { details: Record<string, unknown> };
      expect(audit.details).toMatchObject({ plan: null, plan_source: null });
    });
  });

  it("a portal-side plan change (price id, stale metadata) reaches the app as the billed plan", async () => {
    await withEnv({ STRIPE_PRICE_STARTER: "price_s", STRIPE_PRICE_GROWTH: "price_g" }, async () => {
      state.event = subscriptionUpdated("price_g", { org_id: "org-1", plan: "starter" });
      await deliver();
      const update = firstArg(logged("orgs")[0], "update") as Record<string, unknown>;
      expect(update.subscribed_plan).toBe("growth");
      expect((firstArg(logged("audit_logs")[0], "insert") as { details: Record<string, unknown> }).details).toMatchObject({ plan: "growth", plan_source: "price" });
    });
  });

  it("the webhook never writes subscribed_plan unconditionally any more (source pin)", () => {
    const w = src("app/api/stripe/webhook/route.ts");
    expect(w).not.toMatch(/subscribed_plan: plan,/);
    expect(w).toMatch(/\.\.\.\(plan \? \{ subscribed_plan: plan \} : \{\}\),/);
    expect(w).not.toMatch(/sub\.metadata\?\.plan as string/);
  });
});
