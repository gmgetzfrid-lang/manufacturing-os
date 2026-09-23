// Document-control Round F (P9) — RET-13: the documented recovery for a
// failed R2 delete is reachable. A committed archive whose last commit left
// keys in the bucket carries `reclaim_shortfall` (written by both commit
// routes, migration 20261077); the catalog reports it, offers Reclaim while it
// is non-zero, and routes the retry by which table holds ANY linked rows.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { catalogNeedsReclaim, catalogCommitTarget, catalogReclaimLabel } from "@/lib/archiveCatalog";

type Op = { m: string; args: unknown[] };
const state = vi.hoisted(() => ({
  resolve: ((_t: string, _o: Array<{ m: string; args: unknown[] }>) => ({ data: [], error: null })) as
    (table: string, ops: Array<{ m: string; args: unknown[] }>) => { data?: unknown; error?: unknown },
}));
function chain(table: string) {
  const ops: Op[] = [];
  const run = () => state.resolve(table, ops);
  const c: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (res: (v: unknown) => void, rej?: (e: unknown) => void) => Promise.resolve().then(run).then(res, rej);
      return (...args: unknown[]) => {
        ops.push({ m: prop, args });
        if (prop === "maybeSingle") return Promise.resolve(run());
        return new Proxy(c, handler);
      };
    },
  };
  return new Proxy(c, handler);
}
vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: vi.fn(async () => ({ admin: { from: (t: string) => chain(t) }, userId: "admin1", email: "a@x" })),
}));
import { GET as ARCHIVES } from "@/app/api/admin/archives/route";

beforeEach(() => { state.resolve = () => ({ data: [], error: null }); });

const row = (over: Partial<Parameters<typeof catalogNeedsReclaim>[0]>) => ({
  status: "committed" as const, docPending: 0, docCommitted: 0, ticketPending: 0, ticketCommitted: 0, ...over,
});

describe("lib/archiveCatalog — the pure decisions", () => {
  it("offers Reclaim for pending rows and for committed rows with a shortfall, never otherwise", () => {
    expect(catalogNeedsReclaim(row({ status: "pending", docPending: 3 }))).toBe(true);
    expect(catalogNeedsReclaim(row({ docCommitted: 900, reclaimShortfall: 40 }))).toBe(true);
    expect(catalogNeedsReclaim(row({ docCommitted: 900, reclaimShortfall: 0 }))).toBe(false);
    expect(catalogNeedsReclaim(row({ docCommitted: 900 }))).toBe(false);
    expect(catalogNeedsReclaim(row({ status: "empty", reclaimShortfall: 5 }))).toBe(false);
    expect(catalogNeedsReclaim(row({ status: "producing" }))).toBe(false);
    expect(catalogNeedsReclaim(row({ status: "full" }))).toBe(false);
  });
  it("routes a retry by which table holds ANY linked rows — the all-stamped document archive goes to the document endpoint", () => {
    // The old rule (`docPending > 0 ? doc : ticket`) sent this one to the ticket endpoint.
    expect(catalogCommitTarget(row({ docCommitted: 900, reclaimShortfall: 40 }))).toBe("doc");
    expect(catalogCommitTarget(row({ status: "pending", docPending: 3 }))).toBe("doc");
    expect(catalogCommitTarget(row({ status: "pending", ticketPending: 2 }))).toBe("ticket");
    expect(catalogCommitTarget(row({ ticketCommitted: 12, reclaimShortfall: 1 }))).toBe("ticket");
  });
  it("labels the shortfall so the chip contradicts nothing", () => {
    expect(catalogReclaimLabel(row({ docCommitted: 900, reclaimShortfall: 40 }))).toMatch(/40 cloud object\(s\) failed to delete and are still billed — run Reclaim again/);
    expect(catalogReclaimLabel(row({ docCommitted: 900 }))).toBeNull();
    expect(catalogReclaimLabel(row({ status: "pending", docPending: 1 }))).toMatch(/awaiting reclaim/);
  });
});

describe("/api/admin/archives reports the delete shortfall", () => {
  it("a committed-with-shortfall archive is committed AND needsReclaim; a clean one is not; a pre-migration row reads 0", async () => {
    state.resolve = (table) => {
      if (table === "archives") return { data: [
        { archive_id: "A1", kind: "space", file_count: 900, total_bytes: 1, note: "x", created_at: null, created_by_email: null, reclaim_shortfall: 40 },
        { archive_id: "A2", kind: "space", file_count: 5, total_bytes: 1, note: "x", created_at: null, created_by_email: null, reclaim_shortfall: 0 },
        { archive_id: "A3", kind: "space", file_count: 5, total_bytes: 1, note: "x", created_at: null, created_by_email: null }, // column absent
      ], error: null };
      if (table === "document_versions") return { data: [
        { archive_id: "A1", archived_at: "2026-01-01" }, { archive_id: "A1", archived_at: "2026-01-01" },
        { archive_id: "A2", archived_at: "2026-01-01" }, { archive_id: "A3", archived_at: "2026-01-01" },
      ], error: null };
      return { data: [], error: null };
    };
    const res = await ARCHIVES(new NextRequest("https://app/api/admin/archives?orgId=o1"));
    const body = (await res.json()) as { archives: Array<Record<string, unknown>> };
    const byId = Object.fromEntries(body.archives.map((a) => [a.archiveId as string, a]));
    expect(byId.A1).toMatchObject({ status: "committed", docCommitted: 2, reclaimShortfall: 40, needsReclaim: true });
    expect(byId.A2).toMatchObject({ status: "committed", reclaimShortfall: 0, needsReclaim: false });
    expect(byId.A3).toMatchObject({ status: "committed", reclaimShortfall: 0, needsReclaim: false });
  });
});

describe("the storage page's Reclaim region uses the shared decisions", () => {
  const page = readFileSync(join(process.cwd(), "app/(protected)/admin/storage/page.tsx"), "utf8");
  it("renders Reclaim from catalogNeedsReclaim and routes from catalogCommitTarget — the pending-only gate and the docPending rule are gone", () => {
    expect(page).toMatch(/\{catalogNeedsReclaim\(row\) && \(/);
    expect(page).toMatch(/const which = catalogCommitTarget\(row\);/);
    expect(page).not.toMatch(/row\.docPending > 0 \? "doc" : "ticket"/);
    expect(page).not.toMatch(/\{row\.status === "pending" && \(\s*<button onClick=\{\(\) => void commitFromCatalog/);
    expect(page).toMatch(/reclaimShortfall\?: number;/);
    expect(page).toMatch(/const reclaimLabel = catalogReclaimLabel\(row\);/);
  });
});
