// lib/__tests__/retention.test.ts
import { describe, it, expect } from "vitest";
import { resolveEffectiveRetentionPolicy, computeRetentionUntil, retentionStatusFor } from "@/lib/retention";
import type { RetentionPolicy } from "@/types/schema";

const P = (p: Partial<RetentionPolicy> = {}): RetentionPolicy => ({ enabled: true, years: 7, basis: "created", ...p });
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe("resolveEffectiveRetentionPolicy", () => {
  it("returns null when nothing is set", () => {
    expect(resolveEffectiveRetentionPolicy(null, null, null)).toBeNull();
  });
  it("takes the most specific DEFINED level", () => {
    const doc = P({ years: 3 }), folder = P({ years: 7 }), lib = P({ years: 10 });
    expect(resolveEffectiveRetentionPolicy(doc, folder, lib)).toBe(doc);
    expect(resolveEffectiveRetentionPolicy(null, folder, lib)).toBe(folder);
    expect(resolveEffectiveRetentionPolicy(null, null, lib)).toBe(lib);
  });
  it("lets an explicit enabled:false opt out", () => {
    expect(resolveEffectiveRetentionPolicy(P({ enabled: false }), P(), P())).toBeNull();
  });
});

describe("computeRetentionUntil", () => {
  it("adds the retention years to the basis date", () => {
    expect(computeRetentionUntil("2020-01-15", P({ years: 7 }))).toBe("2027-01-15");
  });
  it("returns null without a policy / years / basis", () => {
    expect(computeRetentionUntil("2020-01-15", null)).toBeNull();
    expect(computeRetentionUntil(null, P())).toBeNull();
    expect(computeRetentionUntil("2020-01-15", P({ enabled: false }))).toBeNull();
  });
});

describe("retentionStatusFor", () => {
  it("legal hold wins over everything", () => {
    expect(retentionStatusFor({ legalHold: true, dispositionState: "eligible", retentionUntil: iso(-10) })).toBe("hold");
  });
  it("reflects disposed", () => {
    expect(retentionStatusFor({ dispositionState: "disposed" })).toBe("disposed");
  });
  it("is eligible when the retention date has passed", () => {
    expect(retentionStatusFor({ retentionUntil: iso(-1) })).toBe("eligible");
    expect(retentionStatusFor({ dispositionState: "eligible" })).toBe("eligible");
  });
  it("is active while still retained, none when unset", () => {
    expect(retentionStatusFor({ retentionUntil: iso(365) })).toBe("active");
    expect(retentionStatusFor({})).toBe("none");
  });
});
