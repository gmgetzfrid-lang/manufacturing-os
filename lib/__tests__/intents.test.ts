// Freezes the pure logic of the intent layer: decay windows, liveness, and
// the edit×edit overlap rule (views must NEVER produce an overlap — that is
// the false-positive firewall the advisory banner depends on).

import { describe, it, expect } from "vitest";
import {
  computeIntentExpiry,
  intentIsLive,
  findEditOverlaps,
  INTENT_TTL_MS,
  TICKET_INTENT_TTL_MS,
  CHECKOUT_INTENT_TTL_MS,
} from "@/lib/intents";

const NOW = Date.parse("2026-07-23T12:00:00Z");

describe("computeIntentExpiry", () => {
  it("applies the kind TTL for plain sources", () => {
    expect(Date.parse(computeIntentExpiry("view", "viewer", NOW))).toBe(NOW + INTENT_TTL_MS.view);
    expect(Date.parse(computeIntentExpiry("reference", "download", NOW))).toBe(NOW + INTENT_TTL_MS.reference);
    expect(Date.parse(computeIntentExpiry("edit", "declared", NOW))).toBe(NOW + INTENT_TTL_MS.edit);
  });

  it("ticket and checkout sources get their longer windows", () => {
    expect(Date.parse(computeIntentExpiry("edit", "ticket", NOW))).toBe(NOW + TICKET_INTENT_TTL_MS);
    expect(Date.parse(computeIntentExpiry("edit", "checkout", NOW))).toBe(NOW + CHECKOUT_INTENT_TTL_MS);
  });

  it("view decays faster than reference, which decays faster than a ticket", () => {
    expect(INTENT_TTL_MS.view).toBeLessThan(INTENT_TTL_MS.reference);
    expect(INTENT_TTL_MS.reference).toBeLessThan(TICKET_INTENT_TTL_MS);
  });
});

describe("intentIsLive", () => {
  it("live before expiry, dead after", () => {
    expect(intentIsLive({ expiresAt: new Date(NOW + 1000).toISOString() }, NOW)).toBe(true);
    expect(intentIsLive({ expiresAt: new Date(NOW - 1000).toISOString() }, NOW)).toBe(false);
  });
  it("treats unparseable timestamps as dead, never live", () => {
    expect(intentIsLive({ expiresAt: "garbage" }, NOW)).toBe(false);
  });
});

const mk = (userId: string, kind: "view" | "reference" | "edit", opts?: {
  expired?: boolean; userName?: string; base?: string | null; source?: "viewer" | "checkout" | "ticket" | "download";
}) => ({
  userId,
  userName: opts?.userName ?? userId,
  kind,
  expiresAt: new Date(NOW + (opts?.expired ? -1 : 1) * 3600_000).toISOString(),
  baseVersionId: opts?.base ?? "v1",
  source: (opts?.source ?? "checkout") as "viewer" | "checkout" | "ticket" | "download",
});

describe("findEditOverlaps — the false-positive firewall", () => {
  it("two live edits from different users overlap", () => {
    const out = findEditOverlaps([mk("dave", "edit"), mk("sarah", "edit")], NOW, "dave");
    expect(out).toHaveLength(1);
    expect(out[0].userId).toBe("sarah");
  });

  it("views and references NEVER create overlaps", () => {
    expect(findEditOverlaps([mk("dave", "edit"), mk("tom", "view"), mk("ann", "reference")], NOW, "dave")).toEqual([]);
  });

  it("expired edits don't count", () => {
    expect(findEditOverlaps([mk("dave", "edit"), mk("sarah", "edit", { expired: true })], NOW, "dave")).toEqual([]);
  });

  it("a caller who isn't editing gets no overlap (it's not their collision)", () => {
    expect(findEditOverlaps([mk("dave", "edit"), mk("sarah", "edit")], NOW, "tom")).toEqual([]);
  });

  it("the same user with two edit intents is not an overlap with themself", () => {
    const twice = [mk("dave", "edit", { source: "checkout" }), mk("dave", "edit", { source: "ticket" })];
    expect(findEditOverlaps(twice, NOW, "dave")).toEqual([]);
  });

  it("omitting userId returns every editing party (org sweep mode)", () => {
    const out = findEditOverlaps([mk("dave", "edit"), mk("sarah", "edit"), mk("tom", "view")], NOW);
    expect(out.map((o) => o.userId).sort()).toEqual(["dave", "sarah"]);
  });
});
