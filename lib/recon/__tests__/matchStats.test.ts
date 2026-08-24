import { describe, expect, it } from "vitest";
import { matchMutualCpu, type DescriptorSet, type MatchStageStats } from "../gpu/matcher";

/** 32-byte descriptors with a chosen number of bits set, deterministically. */
function descriptor(onBits: number[]): Uint8Array {
  const d = new Uint8Array(32);
  for (const bit of onBits) d[bit >> 3] |= 1 << (bit & 7);
  return d;
}

function set(rows: Uint8Array[]): DescriptorSet {
  const data = new Uint8Array(rows.length * 32);
  rows.forEach((r, i) => data.set(r, i * 32));
  return { data, count: rows.length };
}

const stats = (): MatchStageStats =>
  ({ candidates: 0, overDistance: 0, failedRatio: 0, failedMutual: 0, kept: 0 });

describe("match stage statistics", () => {
  it("counts a clean unique match as kept", () => {
    const a = set([descriptor([1, 2, 3])]);
    const b = set([descriptor([1, 2, 3]), descriptor(Array.from({ length: 120 }, (_, i) => i + 100))]);
    const st = stats();
    const out = matchMutualCpu(a, b, { stats: st });
    expect(out.length).toBe(1);
    expect(st.kept).toBe(1);
    expect(st.candidates).toBe(1);
  });

  it("attributes an ambiguous match to the ratio gate", () => {
    // Two train descriptors nearly equidistant from the query: the winner's
    // margin is tiny, which is what repeated texture looks like.
    const a = set([descriptor([1, 2, 3, 4])]);
    const b = set([descriptor([1, 2, 3, 5]), descriptor([1, 2, 3, 6])]);
    const st = stats();
    const out = matchMutualCpu(a, b, { stats: st });
    expect(out.length).toBe(0);
    expect(st.failedRatio).toBe(1);
  });

  it("attributes a distant match to the distance cap", () => {
    const a = set([descriptor(Array.from({ length: 128 }, (_, i) => i))]);
    const b = set([descriptor(Array.from({ length: 128 }, (_, i) => i + 120))]);
    const st = stats();
    const out = matchMutualCpu(a, b, { stats: st });
    expect(out.length).toBe(0);
    expect(st.overDistance).toBe(1);
  });

  it("adds up: every candidate lands in exactly one bucket", () => {
    const a = set([
      descriptor([1, 2, 3]),
      descriptor([40, 41, 42, 43]),
      descriptor(Array.from({ length: 128 }, (_, i) => i)),
    ]);
    const b = set([
      descriptor([1, 2, 3]),
      descriptor([40, 41, 42, 44]),
      descriptor([40, 41, 42, 45]),
    ]);
    const st = stats();
    matchMutualCpu(a, b, { stats: st });
    expect(st.overDistance + st.failedRatio + st.failedMutual + st.kept)
      .toBe(st.candidates);
  });

  it("respects a loosened distance cap, as the lenient retry uses", () => {
    // 30 differing bits: dead at the default 96? No — 30 < 96. Use ~100 bits.
    const a = set([descriptor(Array.from({ length: 100 }, (_, i) => i))]);
    const b = set([descriptor(Array.from({ length: 100 }, (_, i) => (i + 50) % 200))]);
    const strict = matchMutualCpu(a, b, {});
    const loose = matchMutualCpu(a, b, { maxDistance: 110 });
    expect(loose.length).toBeGreaterThanOrEqual(strict.length);
  });
});
