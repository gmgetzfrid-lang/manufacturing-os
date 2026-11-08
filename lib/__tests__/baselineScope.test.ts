// Saving a phase's baseline never touches another phase's saved plan.

import { describe, it, expect, vi } from "vitest";

const updated: string[] = [];
const rows = [
  { id: "p1a", planned_at: "2026-10-30T00:00:00Z", planned_start_at: null },
  { id: "p2a", planned_at: "2026-11-09T00:00:00Z", planned_start_at: null },
  { id: "p2b", planned_at: "2026-11-10T00:00:00Z", planned_start_at: null },
];
vi.mock("@/lib/supabase", () => {
  const select = () => {
    let ids: string[] | null = null;
    const q = {
      eq: () => q,
      in: (_c: string, v: string[]) => { ids = v; return q; },
      order: () => q,
      range: () => Promise.resolve({ data: rows, error: null }),
      then: (r: (x: unknown) => unknown) => r({ data: rows.filter((x) => !ids || ids.includes(x.id)), error: null }),
    };
    return q;
  };
  return { supabase: { from: () => ({ select, update: () => ({ eq: (_c: string, id: string) => { updated.push(id); return Promise.resolve({ error: null }); } }) }) } };
});
vi.mock("@/lib/audit", () => ({ logAuditAction: () => Promise.resolve() }));

import { setBaseline } from "@/lib/milestones";

describe("setBaseline", () => {
  it("a phase's steps only, when given", async () => {
    updated.length = 0;
    const r = await setBaseline({ orgId: "o", projectId: "p", actorUserId: "u", ids: ["p2a", "p2b"] });
    expect(r).toMatchObject({ ok: true, count: 2 });
    expect(updated.sort()).toEqual(["p2a", "p2b"]);
  });
  it("the whole project when no phase is given", async () => {
    updated.length = 0;
    await setBaseline({ orgId: "o", projectId: "p", actorUserId: "u" });
    expect(updated.sort()).toEqual(["p1a", "p2a", "p2b"]);
  });
});
