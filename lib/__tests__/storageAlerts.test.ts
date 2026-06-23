import { describe, it, expect } from "vitest";
import { alertBand } from "@/lib/storageAlerts";

describe("alertBand", () => {
  it("is ok below 70%", () => {
    expect(alertBand(60, 100)).toEqual({ pct: 60, band: "ok" });
  });
  it("warns from 70% to 89%", () => {
    expect(alertBand(70, 100).band).toBe("warn");
    expect(alertBand(89, 100).band).toBe("warn");
  });
  it("is critical at 90%+", () => {
    expect(alertBand(90, 100).band).toBe("crit");
    expect(alertBand(250, 100)).toEqual({ pct: 250, band: "crit" });
  });
  it("is ok (no quota) when quota is zero or unset", () => {
    expect(alertBand(500, 0)).toEqual({ pct: 0, band: "ok" });
  });
});
