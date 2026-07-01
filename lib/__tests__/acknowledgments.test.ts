// lib/__tests__/acknowledgments.test.ts
import { describe, it, expect } from "vitest";
import {
  resolveEffectiveAckPolicy,
  ackStatusFor,
  renderAckReport,
  type AckSummary,
  type AckRosterRow,
} from "@/lib/acknowledgments";
import type { AckPolicy } from "@/types/schema";

const P = (p: Partial<AckPolicy> = {}): AckPolicy => ({ enabled: true, ...p });

describe("resolveEffectiveAckPolicy", () => {
  it("returns null when nothing is set", () => {
    expect(resolveEffectiveAckPolicy(null, null, null)).toBeNull();
  });
  it("uses the most specific DEFINED level (document > folder > library)", () => {
    const doc = P({ assigneeRoles: ["Operations"] });
    const folder = P({ assigneeRoles: ["Maintenance"] });
    const lib = P({ assigneeRoles: ["Safety"] });
    expect(resolveEffectiveAckPolicy(doc, folder, lib)).toBe(doc);
    expect(resolveEffectiveAckPolicy(null, folder, lib)).toBe(folder);
    expect(resolveEffectiveAckPolicy(null, null, lib)).toBe(lib);
  });
  it("treats an explicit enabled:false as opting out (returns null), even if a broader level is enabled", () => {
    expect(resolveEffectiveAckPolicy(P({ enabled: false }), P(), P())).toBeNull();
    expect(resolveEffectiveAckPolicy(null, P({ enabled: false }), P())).toBeNull();
  });
});

const S = (p: Partial<AckSummary> = {}): AckSummary => ({
  required: 0, done: 0, pending: 0, waived: 0, hardGate: false, oldestPendingAt: null, ...p,
});

describe("ackStatusFor", () => {
  it("is 'none' when there is no roster", () => {
    expect(ackStatusFor(null)).toBe("none");
    expect(ackStatusFor(S({ required: 0 }))).toBe("none");
  });
  it("is 'complete' when nobody is outstanding", () => {
    expect(ackStatusFor(S({ required: 12, done: 12, pending: 0 }))).toBe("complete");
  });
  it("is 'partial' when some are outstanding but within the grace window", () => {
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    expect(ackStatusFor(S({ required: 12, done: 5, pending: 7, oldestPendingAt: recent }))).toBe("partial");
  });
  it("is 'overdue' once the oldest outstanding assignment passes the grace window", () => {
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    expect(ackStatusFor(S({ required: 12, done: 5, pending: 7, oldestPendingAt: old }))).toBe("overdue");
  });
  it("is 'blocked' for a hard-gated policy with recent outstanding sign-offs", () => {
    const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();
    expect(ackStatusFor(S({ required: 3, done: 1, pending: 2, hardGate: true, oldestPendingAt: recent }))).toBe("blocked");
  });
});

describe("renderAckReport", () => {
  const rows: AckRosterRow[] = [
    { id: "1", documentVersionId: "v1", revisionLabel: "2", assigneeUserId: "u1", assigneeName: "Alice Operator", assigneeRole: "Operations", source: "role", status: "acknowledged", signatureId: "s1", acknowledgedAt: "2026-07-01T10:00:00Z", waivedReason: null, assignedAt: "2026-06-30T00:00:00Z" },
    { id: "2", documentVersionId: "v1", revisionLabel: "2", assigneeUserId: "u2", assigneeName: "Bob Operator", assigneeRole: "Operations", source: "role", status: "pending", signatureId: null, acknowledgedAt: null, waivedReason: null, assignedAt: "2026-06-30T00:00:00Z" },
  ];
  it("summarizes completion and lists each assignee", () => {
    const html = renderAckReport({ label: "OP-101", title: "Startup", revisionLabel: "2", generatedAt: "2026-07-01T12:00:00Z" }, rows);
    expect(html).toContain("1 of 2 acknowledged");
    expect(html).toContain("Alice Operator");
    expect(html).toContain("Bob Operator");
    expect(html).toContain("Outstanding");
    expect(html).toContain("OP-101");
  });
  it("escapes HTML in user-controlled fields", () => {
    const html = renderAckReport({ label: "<x>", generatedAt: "2026-07-01T12:00:00Z" }, []);
    expect(html).toContain("&lt;x&gt;");
    expect(html).not.toContain("<x>");
  });
});
