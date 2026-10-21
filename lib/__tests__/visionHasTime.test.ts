import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: {} }));

describe("visionHasTime", () => {
  it("the first drawing page of a request always gets to start (the P&ID loop)", async () => {
    const { visionHasTime } = await import("@/lib/knowledgeIngest");
    // A 45s request that spent 4s opening the PDF: 41s left. The old rule
    // demanded 45s, so the first page never started and nothing progressed.
    expect(visionHasTime({ now: 0, deadlineMs: 41_000, firstOfBatch: true, drawingSet: true })).toBe(true);
    // Later pages still need the full drawing reserve.
    expect(visionHasTime({ now: 0, deadlineMs: 41_000, firstOfBatch: false, drawingSet: true })).toBe(false);
    expect(visionHasTime({ now: 0, deadlineMs: 46_000, firstOfBatch: false, drawingSet: true })).toBe(true);
    // Plain vision pages: 25s reserve.
    expect(visionHasTime({ now: 0, deadlineMs: 24_000, firstOfBatch: false, drawingSet: false })).toBe(false);
    expect(visionHasTime({ now: 0, deadlineMs: null, firstOfBatch: false, drawingSet: true })).toBe(true);
  });
});
