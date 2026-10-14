// NEDGE-21 / NEDGE-8 done-when 2 (notifications Round G, N15): the billing
// module and the watch / follow module are renamed apart — lib/billing.ts
// (the orgs row's billing state) and lib/watches.ts (the `subscriptions`
// table) — every importer moved, no file keeps the old name, each header
// names its table. No behaviour change: the exports are the same.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SCAN = ["app", "components", "hooks", "lib", "types", "scripts"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

describe("NEDGE-21 — lib/billing.ts and lib/watches.ts, renamed apart", () => {
  it("the old one-letter-apart files are gone", () => {
    expect(existsSync(join(ROOT, "lib/subscription.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "lib/subscriptions.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "lib/billing.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "lib/watches.ts"))).toBe(true);
  });

  it("no source file imports either old name", () => {
    const offenders: string[] = [];
    for (const top of SCAN) {
      const dir = join(ROOT, top);
      if (!existsSync(dir)) continue;
      for (const f of walk(dir)) {
        const src = readFileSync(f, "utf8");
        if (/["']@\/lib\/subscriptions?["']/.test(src)) offenders.push(f.slice(ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("each header names the table it is about", () => {
    const billing = readFileSync(join(ROOT, "lib/billing.ts"), "utf8").split("\n").slice(0, 12).join("\n");
    const watches = readFileSync(join(ROOT, "lib/watches.ts"), "utf8").split("\n").slice(0, 12).join("\n");
    expect(billing).toMatch(/TABLE:\s*(\/\/\s*)?public\.orgs/);
    expect(billing).toMatch(/NOT the watch \/ follow list/);
    expect(watches).toMatch(/TABLE: public\.subscriptions/);
    expect(watches).toMatch(/NOT billing/);
  });

  it("the exports are unchanged (a rename, no behaviour change)", async () => {
    const billing = await import("@/lib/billing");
    const watches = await import("@/lib/watches");
    for (const k of ["hasAccess", "trialDaysRemaining", "isTrialExpired", "shouldShowTrialBanner", "mapStripeStatus", "holdsLiveSubscription"]) {
      expect(typeof (billing as Record<string, unknown>)[k]).toBe("function");
    }
    for (const k of ["isWatching", "watch", "unwatch", "listFollowerIds"]) {
      expect(typeof (watches as Record<string, unknown>)[k]).toBe("function");
    }
  });
});
