import { describe, it, expect, vi, beforeEach } from "vitest";

// The database as it is: no project_materials table yet. The project row's
// settings (shift_times) are where the register lives until it is.
const db = vi.hoisted(() => ({ project: { id: "p1", shift_times: { review: { all: { items: {} } } } as Record<string, unknown> }, updates: 0 }));
vi.mock("@/lib/supabase", () => {
  const missing = { message: "Could not find the table 'public.project_materials' in the schema cache", code: "PGRST205" };
  const table = () => {
    const q: Record<string, unknown> = {};
    for (const k of ["select", "eq", "order", "insert", "update", "delete"]) q[k] = () => q;
    q.range = async () => ({ data: null, error: missing });
    q.single = async () => ({ data: null, error: missing });
    return q;
  };
  const projects = () => {
    let patch: Record<string, unknown> | null = null;
    const q: Record<string, unknown> = {
      select: () => q, eq: () => q,
      update: (p: Record<string, unknown>) => { patch = p; return q; },
      maybeSingle: async () => ({ data: { shift_times: db.project.shift_times }, error: null }),
      then: (ok: (v: unknown) => void) => { if (patch) { db.project.shift_times = patch.shift_times as Record<string, unknown>; db.updates++; } ok({ data: [{ id: "p1" }], error: null }); },
    };
    return q;
  };
  return { supabase: { from: (t: string) => (t === "projects" ? projects() : table()) } };
});

import { blankMaterial, deleteMaterial, listMaterials, saveMaterial } from "@/lib/materials";

const actor = { id: "u1", name: "eng@kern.test" };
beforeEach(() => { db.project.shift_times = { review: { all: { items: {} } } }; db.updates = 0; });

describe("materials register without its table", () => {
  it("adds, changes and removes lines in the project's settings, leaving the rest of the settings alone", async () => {
    expect((await listMaterials("p1")).rows).toEqual([]);
    const a = await saveMaterial({ orgId: "o1", projectId: "p1", fields: { ...blankMaterial(null), item: "Seal rings, E-12 bundle", spec: "Per task sheet", owner: "Buyer", workOrder: "E-12", needBy: "2026-10-27" }, actor });
    expect(a.id).toMatch(/^s-/);
    expect(a.status).toBe("ready");
    expect(db.project.shift_times.review).toEqual({ all: { items: {} } });
    const b = await saveMaterial({ id: a.id, orgId: "o1", projectId: "p1", fields: { ...a, status: "short", question: "When do the rest come?" }, was: a, actor });
    expect(b).toMatchObject({ id: a.id, status: "short", question: "When do the rest come?", createdByName: "eng@kern.test" });
    expect(b.questionAt).not.toBeNull();
    const list = (await listMaterials("p1")).rows;
    expect(list.map((r) => [r.item, r.status])).toEqual([["Seal rings, E-12 bundle", "short"]]);
    await deleteMaterial(a.id, "p1");
    expect((await listMaterials("p1")).rows).toEqual([]);
    expect(db.updates).toBe(3);
  });
});
