import { describe, expect, it } from "vitest";
import { DEFAULT_RECON_CONFIG, applyPreset, fitToMachine } from "../config";

const DESKTOP = { maxStorageBufferBytes: 2 ** 31, deviceMemoryGb: 32, cores: 16 };

describe("fitToMachine", () => {
  it("leaves a capable desktop essentially alone", () => {
    const base = applyPreset(DEFAULT_RECON_CONFIG, "balanced");
    const out = fitToMachine(base, DESKTOP);
    expect(out.dense.longEdge).toBe(base.dense.longEdge);
    expect(out.limits.maxTotalFrames).toBe(base.limits.maxTotalFrames);
  });

  // navigator.deviceMemory is absent on iOS Safari and Firefox. Before this,
  // null meant "skip every memory guard", so a phone ran workstation settings.
  it("does not hand a phone desktop limits just because memory is unreportable", () => {
    const base = applyPreset(DEFAULT_RECON_CONFIG, "balanced");
    const phone = fitToMachine(base, {
      maxStorageBufferBytes: 128 * 1024 * 1024,
      deviceMemoryGb: null,
      cores: 6,
      mobile: true,
    });
    expect(phone.limits.maxTotalFrames).toBeLessThan(base.limits.maxTotalFrames);
    expect(phone.dense.maxPoints).toBeLessThan(base.dense.maxPoints);
    expect(phone.dense.maxReferenceViews).toBeLessThanOrEqual(60);
    expect(phone.dense.longEdge).toBeLessThanOrEqual(640);
  });

  it("still trusts a real memory reading over the mobile fallback", () => {
    const base = applyPreset(DEFAULT_RECON_CONFIG, "balanced");
    const known = fitToMachine(base, { ...DESKTOP, deviceMemoryGb: 8 });
    expect(known.limits.maxTotalFrames).toBeLessThanOrEqual(260);
  });

  // The largest binding the sweep makes is 4 bytes per pixel (the packed source
  // planes, and the depth and cost outputs). depthSamples is a loop count in
  // the shader, not an allocation, so it must not enter this calculation.
  it("sizes the sweep resolution to the adapter's storage binding limit", () => {
    const base = applyPreset(DEFAULT_RECON_CONFIG, "high");
    for (const limitMb of [16, 64, 256, 2048]) {
      const limit = limitMb * 1024 * 1024;
      const tight = fitToMachine(base, {
        maxStorageBufferBytes: limit, deviceMemoryGb: 16, cores: 8,
      });
      const w = tight.dense.longEdge;
      const bytes = 4 * w * Math.round(w * 0.5625);
      expect(bytes, `${limitMb}MB adapter`).toBeLessThanOrEqual(limit * 0.25);
    }
  });

  it("does not trade away depth precision for memory the sweep never spends", () => {
    const base = applyPreset(DEFAULT_RECON_CONFIG, "high");
    const tight = fitToMachine(base, {
      maxStorageBufferBytes: 128 * 1024 * 1024, deviceMemoryGb: 16, cores: 8,
    });
    expect(tight.dense.depthSamples).toBe(base.dense.depthSamples);
  });

  it("never returns a config that would produce zero work", () => {
    for (const preset of ["draft", "balanced", "high"] as const) {
      const out = fitToMachine(applyPreset(DEFAULT_RECON_CONFIG, preset), {
        maxStorageBufferBytes: 16 * 1024 * 1024, deviceMemoryGb: 2, cores: 2, mobile: true,
      });
      expect(out.dense.depthSamples).toBeGreaterThanOrEqual(32);
      expect(out.dense.maxReferenceViews).toBeGreaterThan(0);
      expect(out.limits.maxTotalFrames).toBeGreaterThan(0);
    }
  });
});
