// @vitest-environment jsdom
//
// document-control Round G — P34 review fix 2, REV-34 (d) / DEC-90 (2)(d)
// "never claiming a retirement": a bulk door that re-runs the retirement
// duties on a row already Superseded / Archived / Void writes its
// SUPERSEDE_DOC / ARCHIVE_DOC / VOID_DOC with `alreadyRetired: true`
// (lib/revisions.ts finishRetirementDuties). The readers people see say no
// retirement was made:
//   * lib/timeline.ts summarizeAudit — "Retirement steps re-run (already X)";
//   * app/(protected)/activity/page.tsx — the verb "re-ran retirement steps
//     on", and the row is left out of the Revisions count.
// Regression: every other row (a real supersession, archive, void, an
// un-archive, any other action) reads and counts as before.
//
// P34 final fix pass: the same rows' VISUALS claim no retirement either —
//   * components/documents/TimelineFeed.tsx visualsFor — a neutral dot
//     (RefreshCw, slate ring), never the Stamp / Archive / Ban of a retirement;
//   * app/(protected)/admin/audit/page.tsx — the row's chip and icon neutral
//     (RefreshCw, the slate tone), never the retirement's violet / rose.
// Every other row renders exactly as before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({ audits: [] as Array<Record<string, unknown>> }));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    const c: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (res: (v: unknown) => void) => res({ data: table === "audit_logs" ? s.audits : [], error: null, count: 0 });
        return () => new Proxy(c, h);
      },
    };
    return new Proxy(c, h);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeOrgId: "org1", uid: "u1", userEmail: "u1@x.io", activeRole: "DocCtrl", hasAnyRole: () => true }),
}));
vi.mock("@/components/navigation/ViewTabs", () => ({ default: () => null, ACTIVITY_VIEWS: [] }));
vi.mock("@/components/documents/DocThumb", () => ({ default: () => null }));
vi.mock("@/components/documents/DocHoverPreview", () => ({ default: (p: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, p.children) }));
vi.mock("next/link", () => ({ default: (p: { href: string; children?: React.ReactNode }) => React.createElement("a", { href: p.href }, p.children) }));

import { summarizeAudit, alreadyRetiredStatus, type TimelineEvent } from "@/lib/timeline";
import ActivityFeedPage from "@/app/(protected)/activity/page";
import TimelineFeed from "@/components/documents/TimelineFeed";
import AuditLogPage from "@/app/(protected)/admin/audit/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("REV-34 (d) — the document timeline never claims a retirement for an alreadyRetired row", () => {
  it("SUPERSEDE_DOC / ARCHIVE_DOC / VOID_DOC with alreadyRetired: true say the steps were re-run, naming the status the row was already in", () => {
    const sup = summarizeAudit({ action: "SUPERSEDE_DOC", details: { alreadyRetired: true, reason: "Replaced by the 2027 set", via: "bulk" } });
    expect(sup).toBe("Retirement steps re-run (already Superseded)");
    expect(sup.toLowerCase()).not.toContain("document superseded");
    const arc = summarizeAudit({ action: "ARCHIVE_DOC", details: { alreadyRetired: true, reason: "Retention" } });
    expect(arc).toBe("Retirement steps re-run (already Archived)");
    expect(arc).not.toMatch(/^Archived/);
    expect(summarizeAudit({ action: "VOID_DOC", details: { alreadyRetired: true } })).toBe("Retirement steps re-run (already Void)");
  });

  it("regression: every other row reads as before (a real retirement, an un-archive, alreadyRetired false or absent, any other action)", () => {
    expect(summarizeAudit({ action: "SUPERSEDE_DOC", details: {} })).toBe("Document superseded");
    expect(summarizeAudit({ action: "SUPERSEDE_DOC", details: { retiredFrom: "Issued", reason: "x" } })).toBe("Document superseded");
    expect(summarizeAudit({ action: "SUPERSEDE_DOC", details: { alreadyRetired: false } })).toBe("Document superseded");
    expect(summarizeAudit({ action: "SUPERSEDE_DOC", details: null })).toBe("Document superseded");
    expect(summarizeAudit({ action: "ARCHIVE_DOC", details: { retiredFrom: "Issued" } })).toBe("Archived");
    expect(summarizeAudit({ action: "ARCHIVE_DOC", details: { priorStatusUnknown: true, retiredFrom: null } })).toBe("Archived");
    expect(summarizeAudit({ action: "ARCHIVE_DOC", details: { action: "unarchive" } })).toBe("Restored from archive");
    expect(summarizeAudit({ action: "VOID_DOC", details: { action: "void", via: "metadata" } })).toBe("Voided");
    // a flag on an action that is no retirement changes nothing
    expect(summarizeAudit({ action: "REV_UP", details: { alreadyRetired: true, newRev: "C" } })).toBe("Rev-up → C");
    expect(alreadyRetiredStatus("REV_UP", { alreadyRetired: true })).toBeNull();
    expect(alreadyRetiredStatus("SUPERSEDE_DOC", { alreadyRetired: "true" })).toBeNull();
  });
});

describe("REV-34 (d) — the /activity feed never claims a retirement for an alreadyRetired row, nor counts it as a revision", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    s.audits = [];
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  const row = (id: string, action: string, details: Record<string, unknown> | null) => ({
    id, action, resource_id: `doc-${id}`, resource_type: "document", org_id: "org1", user_id: "u9",
    user_email: "dc@x.io", user_role: "DocCtrl", actor_kind: "member", details, timestamp: "2026-10-14T08:00:00.000Z",
  });
  const lineOf = (id: string): string => {
    const label = `document doc-${id}`.slice(0, "document ".length + 8);
    const lines = Array.from(host.querySelectorAll("div.flex.items-start")).map((el) => el.textContent ?? "");
    const hit = lines.filter((t) => t.includes(label));
    expect(hit).toHaveLength(1);
    return hit[0];
  };
  const revisionsCount = (): string => {
    const tile = Array.from(host.querySelectorAll("div")).find((el) => el.children.length === 3 && el.lastElementChild?.textContent === "Revisions");
    return tile!.children[1].textContent ?? "";
  };

  it("an alreadyRetired SUPERSEDE_DOC / ARCHIVE_DOC / VOID_DOC reads \"re-ran retirement steps on\" and is not counted; the real retirements read and count as before", async () => {
    s.audits = [
      row("s1aaaaaa", "SUPERSEDE_DOC", { alreadyRetired: true, reason: "Replaced by the 2027 set" }),
      row("a1aaaaaa", "ARCHIVE_DOC", { alreadyRetired: true }),
      row("v1aaaaaa", "VOID_DOC", { alreadyRetired: true }),
      row("s2bbbbbb", "SUPERSEDE_DOC", { retiredFrom: "Issued", reason: "Replaced" }),
      row("a2bbbbbb", "ARCHIVE_DOC", { retiredFrom: "Issued" }),
      row("v2bbbbbb", "VOID_DOC", { action: "void" }),
      row("r1bbbbbb", "REV_UP", { newRev: "C" }),
    ];
    await act(async () => { root.render(React.createElement(ActivityFeedPage)); });
    await settle();
    for (const id of ["s1aaaaaa", "a1aaaaaa", "v1aaaaaa"]) {
      const t = lineOf(id);
      expect(t).toContain("re-ran retirement steps on");
      expect(t).not.toMatch(/\b(superseded|archived|voided)\b/);
    }
    // regression: the real retirements and the rev-up read as before
    expect(lineOf("s2bbbbbb")).toMatch(/\bsuperseded\b/);
    expect(lineOf("a2bbbbbb")).toMatch(/\barchived\b/);
    expect(lineOf("v2bbbbbb")).toMatch(/\bvoided\b/);
    expect(lineOf("r1bbbbbb")).toContain("published a new revision of");
    for (const id of ["s2bbbbbb", "a2bbbbbb", "v2bbbbbb", "r1bbbbbb"]) expect(lineOf(id)).not.toContain("re-ran retirement steps on");
    // Revisions: the real SUPERSEDE_DOC, VOID_DOC and REV_UP (ARCHIVE_DOC was never in the bucket); none of the re-runs
    expect(revisionsCount()).toBe("3");
  });
});

// ─── P34 final fix pass: the visuals ──────────────────────────────────────
describe("REV-34 (d) — the timeline dot and the admin viewer's chip claim no retirement for an alreadyRetired row", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    s.audits = [];
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  const icon = (el: Element | null | undefined): string | null =>
    [...(el?.querySelector("svg")?.classList ?? [])].find((c) => c.startsWith("lucide-") && !c.endsWith("-icon")) ?? null;

  const ev = (id: string, action: string, details: Record<string, unknown> | null): TimelineEvent => ({
    id: `audit:${id}`, kind: "audit", action, resourceType: "document", resourceId: "doc1",
    timestamp: "2026-10-14T08:00:00.000Z", userId: "u9", userName: "Dana", userEmail: "dc@x.io",
    summary: `summary-${id}`, details,
  });
  /** The dot (icon + ring) of the timeline row whose summary is `summary-<id>`. */
  const dotOf = (id: string): Element => {
    const rows = Array.from(host.querySelectorAll("div.flex.items-start.relative"));
    const hit = rows.filter((r) => r.textContent?.includes(`summary-${id}`));
    expect(hit).toHaveLength(1);
    return hit[0].firstElementChild!;
  };

  it("TimelineFeed: an alreadyRetired SUPERSEDE_DOC / ARCHIVE_DOC / VOID_DOC gets the neutral dot (RefreshCw, slate ring); every other row's dot is as before", async () => {
    const events = [
      ev("s1", "SUPERSEDE_DOC", { alreadyRetired: true, reason: "Replaced" }),
      ev("a1", "ARCHIVE_DOC", { alreadyRetired: true }),
      ev("v1", "VOID_DOC", { alreadyRetired: true }),
      ev("s2", "SUPERSEDE_DOC", { retiredFrom: "Issued" }),
      ev("a2", "ARCHIVE_DOC", { retiredFrom: "Issued" }),
      ev("u2", "ARCHIVE_DOC", { action: "unarchive", alreadyRetired: true }),
      ev("v2", "VOID_DOC", { action: "void" }),
      ev("r2", "REV_UP", { alreadyRetired: true, newRev: "C" }),
    ];
    await act(async () => { root.render(React.createElement(TimelineFeed, { events })); });
    for (const id of ["s1", "a1", "v1"]) {
      const dot = dotOf(id);
      expect(icon(dot), id).toBe("lucide-refresh-cw");
      expect(dot.className, id).toContain("border-slate-400");
      expect(dot.className, id).not.toMatch(/border-(amber|rose)-/);
    }
    // REGRESSION: the real retirements, an un-archive and a flag on a non-retirement render as before
    expect(icon(dotOf("s2"))).toBe("lucide-stamp");
    expect(dotOf("s2").className).toContain("border-amber-500");
    expect(icon(dotOf("a2"))).toBe("lucide-archive");
    expect(icon(dotOf("u2"))).toBe("lucide-archive");
    expect(icon(dotOf("v2"))).toBe("lucide-ban");
    expect(dotOf("v2").className).toContain("border-rose-400");
    expect(icon(dotOf("r2"))).toBe("lucide-git-branch");
    expect(dotOf("r2").className).toContain("border-emerald-500");
  });

  const row = (id: string, action: string, details: Record<string, unknown> | null) => ({
    id, action, resource_id: `doc-${id}`, resource_type: "document", org_id: "org1", user_id: "u9",
    user_email: "dc@x.io", user_role: "DocCtrl", actor_kind: "member", details, metadata: null, timestamp: "2026-10-14T08:00:00.000Z",
  });
  const NEUTRAL = "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]";
  /** The admin viewer's list item for resource doc-<id>: its icon tile and its action chip. */
  const adminRow = (id: string): { tile: Element; chip: Element } => {
    const items = Array.from(host.querySelectorAll("li")).filter((li) => li.textContent?.includes(`doc-${id}`));
    expect(items).toHaveLength(1);
    const tile = items[0].firstElementChild!;
    const chip = items[0].querySelector("span.uppercase")!;
    return { tile, chip };
  };

  it("/admin/audit: an alreadyRetired SUPERSEDE_DOC / ARCHIVE_DOC / VOID_DOC row's tile and chip are neutral (RefreshCw, the slate tone); every other row's are as before", async () => {
    s.audits = [
      row("s1aaaaaa", "SUPERSEDE_DOC", { alreadyRetired: true, reason: "Replaced by the 2027 set" }),
      row("a1aaaaaa", "ARCHIVE_DOC", { alreadyRetired: true }),
      row("v1aaaaaa", "VOID_DOC", { alreadyRetired: true }),
      row("s2bbbbbb", "SUPERSEDE_DOC", { retiredFrom: "Issued" }),
      row("a2bbbbbb", "ARCHIVE_DOC", { retiredFrom: "Issued" }),
      row("v2bbbbbb", "VOID_DOC", { action: "void" }),
      row("r1bbbbbb", "REV_UP", { alreadyRetired: true, newRev: "C" }),
    ];
    await act(async () => { root.render(React.createElement(AuditLogPage)); });
    await settle();
    for (const id of ["s1aaaaaa", "a1aaaaaa", "v1aaaaaa"]) {
      const { tile, chip } = adminRow(id);
      expect(icon(tile), id).toBe("lucide-refresh-cw");
      expect(tile.className, id).toContain(NEUTRAL);
      expect(chip.className, id).toContain(NEUTRAL);
      expect(chip.className, id).not.toMatch(/violet|rose/);
    }
    // REGRESSION: the real retirements and a flag on a non-retirement render as before
    expect(icon(adminRow("s2bbbbbb").tile)).toBe("lucide-arrow-up-right");
    expect(adminRow("s2bbbbbb").chip.className).toContain("bg-violet-50 text-violet-700 border-violet-200");
    expect(icon(adminRow("a2bbbbbb").tile)).toBe("lucide-shield-off");
    expect(adminRow("a2bbbbbb").chip.className).toContain("bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border-strong)]");
    expect(icon(adminRow("v2bbbbbb").tile)).toBe("lucide-ban");
    expect(adminRow("v2bbbbbb").chip.className).toContain("bg-rose-50 text-rose-700 border-rose-200");
    expect(icon(adminRow("r1bbbbbb").tile)).toBe("lucide-git-branch");
    expect(adminRow("r1bbbbbb").chip.className).toContain("bg-blue-50 text-blue-700 border-blue-200");
    // the chip's label is unchanged (the registry's)
    expect(adminRow("s1aaaaaa").chip.textContent).toBe(adminRow("s2bbbbbb").chip.textContent);
  });
});
