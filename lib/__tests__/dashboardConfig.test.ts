// lib/__tests__/dashboardConfig.test.ts
//
// Pure-function coverage for the dashboard layout model: the default layout
// shape, the w/h clamps, and (critically) the migration that upgrades legacy
// `{width: "full"|"half"}` widgets to the new `{w, h}` shape without ever
// throwing.

import { describe, it, expect } from "vitest";
import {
  defaultDashboard,
  sanitizeDashboardConfig,
  clampW,
  clampH,
  GRID_COLS,
  MAX_H,
} from "@/lib/dashboard/config";

describe("defaultDashboard", () => {
  it("returns a versioned config with w/h on every widget", () => {
    const cfg = defaultDashboard();
    expect(cfg.version).toBe(1);
    expect(cfg.widgets.length).toBeGreaterThan(0);
    for (const w of cfg.widgets) {
      expect(typeof w.w).toBe("number");
      expect(typeof w.h).toBe("number");
      expect(w.w).toBeGreaterThanOrEqual(1);
      expect(w.w).toBeLessThanOrEqual(GRID_COLS);
    }
  });

  it("leads with a full-width Document Control banner", () => {
    const cfg = defaultDashboard();
    const first = cfg.widgets[0];
    expect(first.type).toBe("documentControl");
    expect(first.w).toBe(12);
    expect(first.h).toBe(3);
  });

  it("gives every widget a stable, unique id", () => {
    const cfg = defaultDashboard();
    const ids = cfg.widgets.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("clampW / clampH", () => {
  it("clamps width into [1, 12]", () => {
    expect(clampW(0)).toBe(1);
    expect(clampW(-5)).toBe(1);
    expect(clampW(6)).toBe(6);
    expect(clampW(99)).toBe(GRID_COLS);
    expect(clampW(3.4)).toBe(3);
    expect(clampW(Number.NaN)).toBe(1);
  });

  it("clamps height into [1, MAX_H]", () => {
    expect(clampH(0)).toBe(1);
    expect(clampH(4)).toBe(4);
    expect(clampH(999)).toBe(MAX_H);
    expect(clampH(Number.NaN)).toBe(1);
  });
});

describe("sanitizeDashboardConfig", () => {
  it("returns null for junk", () => {
    expect(sanitizeDashboardConfig(null)).toBeNull();
    expect(sanitizeDashboardConfig(42)).toBeNull();
    expect(sanitizeDashboardConfig("nope")).toBeNull();
    expect(sanitizeDashboardConfig({})).toBeNull();
    expect(sanitizeDashboardConfig({ widgets: "x" })).toBeNull();
  });

  it("keeps valid new-shape widgets and clamps their sizes", () => {
    const out = sanitizeDashboardConfig({
      widgets: [
        { id: "a", type: "inbox", w: 6, h: 4 },
        { id: "b", type: "projects", w: 99, h: 999 },
      ],
    });
    expect(out).not.toBeNull();
    expect(out!.widgets).toHaveLength(2);
    expect(out!.widgets[0]).toMatchObject({ id: "a", type: "inbox", w: 6, h: 4 });
    expect(out!.widgets[1].w).toBe(GRID_COLS);
    expect(out!.widgets[1].h).toBe(MAX_H);
  });

  it("accepts the two new cockpit widget types", () => {
    const out = sanitizeDashboardConfig({
      widgets: [
        { id: "d", type: "dailyBrief", w: 6, h: 5 },
        { id: "q", type: "quickLaunch", w: 3, h: 5 },
      ],
    });
    expect(out!.widgets.map((w) => w.type)).toEqual(["dailyBrief", "quickLaunch"]);
  });

  it("migrates legacy width:full -> w:12 and width:half -> w:6", () => {
    const out = sanitizeDashboardConfig({
      version: 1,
      widgets: [
        { id: "a", type: "documentControl", width: "full", settings: {} },
        { id: "b", type: "draftingRequests", width: "half" },
        { id: "c", type: "inbox", width: "half" },
      ],
    });
    expect(out).not.toBeNull();
    const byId = Object.fromEntries(out!.widgets.map((w) => [w.id, w]));
    expect(byId.a.w).toBe(12);
    expect(byId.b.w).toBe(6);
    expect(byId.c.w).toBe(6);
    // Heights are defaulted by type — list widgets taller than banners.
    expect(byId.a.h).toBe(3); // documentControl banner
    expect(byId.b.h).toBe(4); // draftingRequests list
    expect(byId.c.h).toBe(4); // inbox/command deck
  });

  it("drops unknown widget types and malformed entries", () => {
    const out = sanitizeDashboardConfig({
      widgets: [
        { id: "ok", type: "inbox", w: 6, h: 4 },
        { id: "bad", type: "totallyNotAWidget", w: 6, h: 4 },
        null,
        "string",
        { type: "projects" }, // missing id -> gets a generated one
      ],
    });
    expect(out).not.toBeNull();
    const types = out!.widgets.map((w) => w.type);
    expect(types).toContain("inbox");
    expect(types).toContain("projects");
    expect(types).not.toContain("totallyNotAWidget");
  });

  it("dedupes repeated ids", () => {
    const out = sanitizeDashboardConfig({
      widgets: [
        { id: "dup", type: "inbox", w: 6, h: 4 },
        { id: "dup", type: "projects", w: 6, h: 4 },
      ],
    });
    expect(out!.widgets).toHaveLength(1);
    expect(out!.widgets[0].type).toBe("inbox");
  });

  it("never throws on hostile input", () => {
    const hostile = { widgets: [{ id: {}, type: 123, w: "x", h: [], settings: 5 }] };
    expect(() => sanitizeDashboardConfig(hostile)).not.toThrow();
  });
});
