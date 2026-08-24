// Share authorization re-check (EGRESS-1 Done-when 4).
//
// shareStillAuthorized fails closed on every ambiguous case, so a share can
// never serve more than its creator currently holds.

import { describe, it, expect, vi, beforeEach } from "vitest";

const ka = vi.hoisted(() => ({
  principal: null as null | { uid: string; orgId: string; isController: boolean; role: string; teamIds: string[] },
  readable: new Set<string>(),
  loadThrows: false,
}));

vi.mock("@/lib/knowledgeAccess", () => ({
  loadPrincipal: vi.fn(async () => {
    if (ka.loadThrows) throw new Error("db down");
    return ka.principal;
  }),
  readableControlledDocIds: vi.fn(async () => ka.readable),
}));

import { shareStillAuthorized } from "@/lib/shareAuthorization";

beforeEach(() => {
  ka.principal = null;
  ka.readable = new Set();
  ka.loadThrows = false;
});

describe("shareStillAuthorized (fail closed)", () => {
  it("refuses a null creator", async () => {
    expect(await shareStillAuthorized("orgA", null, "doc1")).toBe(false);
  });

  it("refuses when the creator is no longer an active member", async () => {
    ka.principal = null;
    expect(await shareStillAuthorized("orgA", "u1", "doc1")).toBe(false);
  });

  it("serves for a controller creator without a per-doc check", async () => {
    ka.principal = { uid: "u1", orgId: "orgA", isController: true, role: "Admin", teamIds: [] };
    expect(await shareStillAuthorized("orgA", "u1", "doc1")).toBe(true);
  });

  it("serves only when the creator can still read the document", async () => {
    ka.principal = { uid: "u1", orgId: "orgA", isController: false, role: "Drafter", teamIds: [] };
    ka.readable = new Set(["doc1"]);
    expect(await shareStillAuthorized("orgA", "u1", "doc1")).toBe(true);
    ka.readable = new Set();
    expect(await shareStillAuthorized("orgA", "u1", "doc1")).toBe(false);
  });

  it("refuses on any lookup error — never serves what it cannot confirm", async () => {
    ka.loadThrows = true;
    expect(await shareStillAuthorized("orgA", "u1", "doc1")).toBe(false);
  });
});
