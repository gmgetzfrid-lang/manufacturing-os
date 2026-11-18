// notifications N13 LAYERS SWEEP — TAX-15's first step: the upload counters
// and the leave-page guard live in a leaf module with no import at all
// (lib/uploadInFlight.ts), which lib/uploadActivity.ts re-exports. One
// module instance holds the state whichever path a caller imports, and the
// update prompt's fallback (ServiceWorkerManager, beside every page) reads it
// without pulling the Supabase client into every page's root bundle.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as activity from "@/lib/uploadActivity";
import * as leaf from "@/lib/uploadInFlight";

const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("lib/uploadInFlight — the leaf", () => {
  it("imports nothing (no Supabase client, no other module)", () => {
    expect(src("lib/uploadInFlight.ts")).not.toMatch(/^\s*import\b/m);
    expect(src("lib/uploadInFlight.ts")).not.toMatch(/\brequire\(/);
  });

  it("lib/uploadActivity re-exports every name, and they are the same functions — one state", () => {
    for (const name of Object.keys(leaf)) {
      expect((activity as Record<string, unknown>)[name], name).toBe((leaf as Record<string, unknown>)[name]);
    }
    activity.beginTransfer();
    try {
      expect(leaf.hasUploadsInFlight()).toBe(true);
    } finally {
      activity.endTransfer();
    }
    expect(leaf.hasUploadsInFlight()).toBe(false);
  });

  it("ServiceWorkerManager reads the leaf, never lib/uploadActivity or the Supabase client", () => {
    const swm = src("components/pwa/ServiceWorkerManager.tsx");
    expect(swm).toMatch(/from "@\/lib\/uploadInFlight"/);
    expect(swm).not.toMatch(/from "@\/lib\/uploadActivity"/);
    expect(swm).not.toMatch(/from "@\/lib\/supabase"/);
  });
});
