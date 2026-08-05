import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  beginUpload, endUpload, isUploading, onUploadActivity, withUploadActivity,
} from "@/lib/uploadActivity";

describe("uploadActivity", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    // Drain any cooldown so tests don't leak state into each other.
    vi.advanceTimersByTime(60_000);
    vi.useRealTimers();
  });

  it("reports busy while an upload is in flight", () => {
    expect(isUploading()).toBe(false);
    beginUpload();
    expect(isUploading()).toBe(true);
    endUpload();
  });

  it("stays busy through a cooldown so a staged batch isn't interleaved", () => {
    beginUpload();
    endUpload();
    expect(isUploading()).toBe(true);          // cooling down
    vi.advanceTimersByTime(21_000);
    expect(isUploading()).toBe(false);
  });

  it("handles overlapping uploads without releasing early", () => {
    beginUpload();
    beginUpload();
    endUpload();
    expect(isUploading()).toBe(true);          // one still running
    endUpload();
    vi.advanceTimersByTime(21_000);
    expect(isUploading()).toBe(false);
  });

  it("never goes negative if end is called more than begin", () => {
    endUpload(); endUpload();
    beginUpload();
    expect(isUploading()).toBe(true);
    endUpload();
  });

  it("notifies listeners on both edges", () => {
    const seen: boolean[] = [];
    const off = onUploadActivity((b) => seen.push(b));
    beginUpload();
    endUpload();
    vi.advanceTimersByTime(21_000);
    off();
    expect(seen[0]).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it("releases the flag even when the work throws", async () => {
    vi.useRealTimers();
    await expect(withUploadActivity(async () => { throw new Error("boom"); }))
      .rejects.toThrow("boom");
    // In flight is back to zero; only the cooldown keeps it busy.
    await new Promise((r) => setTimeout(r, 5));
    vi.useFakeTimers();
    vi.advanceTimersByTime(21_000);
    expect(isUploading()).toBe(false);
  });

  it("stops notifying after unsubscribe", () => {
    const seen: boolean[] = [];
    const off = onUploadActivity((b) => seen.push(b));
    off();
    beginUpload();
    endUpload();
    expect(seen).toHaveLength(0);
  });

  it("survives a listener that throws", () => {
    const off1 = onUploadActivity(() => { throw new Error("bad listener"); });
    const seen: boolean[] = [];
    const off2 = onUploadActivity((b) => seen.push(b));
    expect(() => beginUpload()).not.toThrow();
    expect(seen).toContain(true);
    endUpload(); off1(); off2();
  });
});
