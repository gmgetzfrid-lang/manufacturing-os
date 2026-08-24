// /api/verify verdict per document status (DIST-2).
//
// The QR verify endpoint is the only recall channel that reaches paper. Its
// verdict must be honest for EVERY DocumentStatus and for an active hold — a
// new status must never default to green. These pin one verdict per status.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const V = "11111111-1111-1111-1111-111111111111"; // current version id
const DOC = "22222222-2222-2222-2222-222222222222";

const state = vi.hoisted(() => ({
  doc: null as Record<string, unknown> | null,
  holdRows: [] as unknown[],
  holdError: false as boolean,
}));

function chain(table: string) {
  const filters: Record<string, unknown> = {};
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, p: string) {
      if (p === "then") {
        return (resolve: (v: unknown) => void) => {
          if (table === "document_holds") {
            resolve(state.holdError ? { data: null, error: { message: "x" } } : { data: state.holdRows, error: null });
          } else resolve({ data: [], error: null });
        };
      }
      return (...args: unknown[]) => {
        if (p === "eq") filters[args[0] as string] = args[1];
        if (p === "maybeSingle") {
          if (table === "documents") return Promise.resolve({ data: state.doc, error: null });
          if (table === "document_versions") {
            // current version lookup + printed version lookup both resolve here
            if (filters.id === V) return Promise.resolve({ data: { revision_label: "5", created_at: "2026-01-01", record_id: DOC, effective_date: null }, error: null });
            return Promise.resolve({ data: { revision_label: "5", created_at: "2026-01-01", record_id: DOC, superseded_at: null }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chain(t) }) }));

const OLD_ENV = { ...process.env };
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  state.doc = null;
  state.holdRows = [];
  state.holdError = false;
});

async function verify(): Promise<Record<string, unknown>> {
  const { GET } = await import("@/app/api/verify/route");
  const u = new URL("https://app/api/verify");
  u.searchParams.set("doc", DOC);
  u.searchParams.set("v", V); // print carries the CURRENT version id
  const res = await GET(new NextRequest(u));
  return (await res.json()) as Record<string, unknown>;
}

const docWith = (status: string, extra: Record<string, unknown> = {}) => ({
  id: DOC, document_number: "P-101", title: "P&ID", name: "P-101",
  rev: "5", status, current_version_id: V, superseded_at: null, legal_hold: false, ...extra,
});

describe("/api/verify verdict per status (DIST-2)", () => {
  it("Issued current version → current / isCurrent true", async () => {
    state.doc = docWith("Issued");
    const r = await verify();
    expect(r.verdict).toBe("current");
    expect(r.isCurrent).toBe(true);
  });

  it("Void → void, never green", async () => {
    state.doc = docWith("Void");
    const r = await verify();
    expect(r.verdict).toBe("void");
    expect(r.isCurrent).toBe(false);
  });

  it("Superseded → superseded", async () => {
    state.doc = docWith("Superseded");
    const r = await verify();
    expect(r.verdict).toBe("superseded");
    expect(r.isCurrent).toBe(false);
  });

  it("Archived → archived", async () => {
    state.doc = docWith("Archived");
    const r = await verify();
    expect(r.verdict).toBe("archived");
    expect(r.isCurrent).toBe(false);
  });

  it("Draft → draft, not green", async () => {
    state.doc = docWith("Draft");
    const r = await verify();
    expect(r.verdict).toBe("draft");
    expect(r.isCurrent).toBe(false);
  });

  it("an active hold overrides even a current Issued version → held", async () => {
    state.doc = docWith("Issued");
    state.holdRows = [{ id: "h1" }];
    const r = await verify();
    expect(r.verdict).toBe("held");
    expect(r.isCurrent).toBe(false);
    expect(r.onHold).toBe(true);
  });

  it("legal_hold flag alone → held", async () => {
    state.doc = docWith("Issued", { legal_hold: true });
    const r = await verify();
    expect(r.verdict).toBe("held");
  });

  it("a hold-lookup error fails SAFE to held, never green", async () => {
    state.doc = docWith("Issued");
    state.holdError = true;
    const r = await verify();
    expect(r.verdict).toBe("held");
    expect(r.isCurrent).toBe(false);
  });
});

Object.assign(process.env, OLD_ENV);
