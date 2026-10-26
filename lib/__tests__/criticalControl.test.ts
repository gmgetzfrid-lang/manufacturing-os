import { describe, it, expect } from "vitest";
import { resolveCriticalPath, effectiveCriticalMode, criticalOverrideOf, fileHasCritical } from "@/lib/criticalPath";
import type { Milestone } from "@/types/schema";

const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone =>
  ({ orgId: "o", weight: 1, status: "planned", source: "import", createdBy: "u", plannedStartAt: "2026-10-26T13:00:00Z", plannedAt: "2026-10-26T17:00:00Z", ...p } as Milestone);

// E-17 with three steps, E-12 with two. The file marks a, b and d critical.
const e17 = mk({ id: "e17", name: "E-17", isSummary: true });
const e12 = mk({ id: "e12", name: "E-12", isSummary: true });
const a = mk({ id: "a", name: "Set Blinds", parentId: "e17", attributes: { ms_critical: "1" } });
const b = mk({ id: "b", name: "Pull Bundle", parentId: "e17", attributes: { ms_critical: "1" } });
const c = mk({ id: "c", name: "Hydroblast", parentId: "e17", attributes: { ms_critical: "0" } });
const d = mk({ id: "d", name: "Set Blinds", parentId: "e12", attributes: { ms_critical: "1" } });
const e = mk({ id: "e", name: "Pull Bundle", parentId: "e12", attributes: { ms_critical: "0" }, status: "completed", percentComplete: 100 });
const base = [e17, e12, a, b, c, d, e];
const ids = (r: { ids: Set<string> }) => [...r.ids].sort();

describe("critical path control", () => {
  it("takes the file's flags when the import has them, and only unfinished steps", () => {
    expect(fileHasCritical(base)).toBe(true);
    expect(effectiveCriticalMode(base, null)).toBe("file");
    expect(ids(resolveCriticalPath(base, null))).toEqual(["a", "b", "d"]);
  });

  it("without file flags it falls back to the estimate", () => {
    const plain = base.map((m) => ({ ...m, attributes: {} }));
    expect(effectiveCriticalMode(plain, null)).toBe("estimate");
  });

  it("'only what I mark' strips everything", () => {
    expect(ids(resolveCriticalPath(base, "none"))).toEqual([]);
  });

  it("marking an overall task Not critical strips every step under it", () => {
    const ms = base.map((m) => (m.id === "e17" ? { ...m, criticalOverride: "no" as const } : m));
    expect(ids(resolveCriticalPath(ms, "file"))).toEqual(["d"]);
  });

  it("a step's own mark beats its overall task's", () => {
    const ms = base.map((m) => (m.id === "e17" ? { ...m, criticalOverride: "no" as const } : m.id === "c" ? { ...m, criticalOverride: "yes" as const } : m));
    expect(ids(resolveCriticalPath(ms, "file"))).toEqual(["c", "d"]);
    const byId = new Map(ms.map((m) => [m.id!, m]));
    expect(criticalOverrideOf(byId.get("a")!, byId)).toBe("no");
    expect(criticalOverrideOf(byId.get("c")!, byId)).toBe("yes");
  });

  it("with nothing else critical, marked tasks are the whole path", () => {
    const ms = base.map((m) => (m.id === "e12" ? { ...m, criticalOverride: "yes" as const } : m));
    const r = resolveCriticalPath(ms, "none");
    expect(ids(r)).toEqual(["d"]);       // e is done: never on the path
    expect(r.mode).toBe("none");
    expect(r.marked).toBe(2);
  });
});
