import { describe, it, expect } from "vitest";
import { rolesOf, rolesFromLogo, contrast, DEFAULT_ROLES, sideTokens, bandFor, actionText, buttonText } from "@/lib/themeRoles";

describe("theme roles", () => {
  it("gives the default pair and orange third with nothing saved", () => {
    expect(rolesOf(null)).toEqual(DEFAULT_ROLES);
  });

  it("treats the old orange default as the new default", () => {
    expect(rolesOf({ id: "industrial", primary: "#ea580c", secondary: "#f59e0b" })).toEqual(DEFAULT_ROLES);
  });

  it("keeps a three-role palette and makes the band readable with white text", () => {
    const r = rolesOf({ primary: "#4fd1c5", accent: "#db2777", base: "#0f1b2d" });
    expect(contrast(r.main, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(r.action).toBe("#db2777");
    expect(r.base).toBe("#0f1b2d");
  });

  it("turns an older two-color palette into a band and a separate action color", () => {
    const r = rolesOf({ id: "ocean", primary: "#2563eb", secondary: "#06b6d4" });
    expect(contrast(r.main, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    // cyan sits too close to blue, so the action color is the opposite side
    expect(r.action).not.toBe("#06b6d4");
  });

  it("builds three roles from a logo's colors", () => {
    const r = rolesFromLogo(["#1d4ed8", "#2563eb", "#f97316"])!;
    expect(r.action).toBe("#f97316");
    expect(contrast(r.base, "#ffffff")).toBeGreaterThan(10); // a deep shade
  });

  it("reads light text on a dark menu and dark text on a light one", () => {
    expect(sideTokens("#11141a").text).toBe("#f3f4f6");
    expect(sideTokens("#f6f5f2").text).toBe("#0b1220");
  });

  it("deepens the band in dark mode", () => {
    expect(bandFor("dark", "#1c3fbd")).not.toBe("#1c3fbd");
    expect(bandFor("light", "#1c3fbd")).toBe("#1c3fbd");
  });

  it("makes a light action color readable as link text", () => {
    expect(contrast(actionText("light", "#f5b700"), "#f4f3f0")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(actionText("dark", "#1c3fbd"), "#111827")).toBeGreaterThanOrEqual(4.5);
    expect(actionText("light", "#0b1220")).toBe("#0b1220");
  });

  it("keeps white text on orange buttons and uses ink on yellow ones", () => {
    expect(buttonText("#ea580c")).toBe("#ffffff");
    expect(buttonText("#f5b700")).toBe("#0b1220");
  });
});
