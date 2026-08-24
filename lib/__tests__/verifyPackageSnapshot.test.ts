// /api/verify-package snapshot verdict (PKG-2).
//
// With a print id, the verdict is computed against the RECORDED versions in
// the print snapshot, not the live pins — so refreshing pins after printing
// cannot flip already-distributed paper back to green.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const PKG = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PRINT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const DOC = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const state = vi.hoisted(() => ({
  pkg: null as Record<string, unknown> | null,
  print: null as Record<string, unknown> | null,
  liveMembers: [] as unknown[],
  docs: [] as unknown[],
}));

function chain(table: string) {
  const filters: Record<string, unknown> = {};
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, p: string) {
      if (p === "then") {
        return (resolve: (v: unknown) => void) => {
          if (table === "work_package_documents") resolve({ data: state.liveMembers, error: null });
          else if (table === "documents") resolve({ data: state.docs, error: null });
          else resolve({ data: [], error: null });
        };
      }
      return (...args: unknown[]) => {
        if (p === "eq") filters[args[0] as string] = args[1];
        if (p === "maybeSingle") {
          if (table === "work_packages") return Promise.resolve({ data: state.pkg, error: null });
          if (table === "work_package_prints") return Promise.resolve({ data: state.print, error: null });
          return Promise.resolve({ data: null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chain(t) }) }));

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  state.pkg = { id: PKG, name: "TA-2026", status: "open", closed_at: null };
  state.print = null;
  state.liveMembers = [];
  // The document has advanced to v2 since printing.
  state.docs = [{ id: DOC, document_number: "P-101", title: "P&ID", name: "P-101", rev: "4", current_version_id: "v2", status: "Issued" }];
});

async function verify(withPrint: boolean): Promise<Record<string, unknown>> {
  const { GET } = await import("@/app/api/verify-package/route");
  const u = new URL("https://app/api/verify-package");
  u.searchParams.set("p", PKG);
  if (withPrint) u.searchParams.set("print", PRINT);
  const res = await GET(new NextRequest(u));
  return (await res.json()) as Record<string, unknown>;
}

describe("/api/verify-package snapshot (PKG-2)", () => {
  it("snapshot printed at v1 reads STALE even after the LIVE pin was refreshed to v2", async () => {
    // The live pin has been refreshed to current (v2) — the old bug would read
    // this as fresh. The print snapshot recorded v1, so it must read stale.
    state.liveMembers = [{ document_id: DOC, pinned_version_id: "v2", pinned_rev_label: "4" }];
    state.print = { id: PRINT, package_id: PKG, printed_at: "2026-08-01T00:00:00Z",
      sheets: [{ documentId: DOC, versionId: "v1", revLabel: "3", label: "P-101" }] };
    const r = await verify(true);
    expect(r.allFresh).toBe(false);
    expect(r.staleCount).toBe(1);
    expect(r.printedAt).toBe("2026-08-01T00:00:00Z");
  });

  it("snapshot printed at the current version reads CURRENT", async () => {
    state.print = { id: PRINT, package_id: PKG, printed_at: "2026-08-20T00:00:00Z",
      sheets: [{ documentId: DOC, versionId: "v2", revLabel: "4", label: "P-101" }] };
    const r = await verify(true);
    expect(r.allFresh).toBe(true);
    expect(r.staleCount).toBe(0);
  });

  it("a print id that resolves to no snapshot never reads green", async () => {
    state.print = null; // unknown print
    const r = await verify(true);
    expect(r.snapshotMissing).toBe(true);
    expect(r.allFresh).toBe(false);
  });

  it("legacy QR without a print id still uses the live pins", async () => {
    state.liveMembers = [{ document_id: DOC, pinned_version_id: "v2", pinned_rev_label: "4" }];
    const r = await verify(false);
    expect(r.allFresh).toBe(true); // pin matches current
    expect(r.snapshotMissing).toBe(false);
  });
});
