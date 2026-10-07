// @vitest-environment jsdom
//
// admin-and-org Round G, package P6 — /admin/storage, rendered:
//   * BILL-12: the storage limit is compared to THIS workspace's own files
//     (stats.workspace.files), never the server's database + bucket total,
//     and the page says which figures are the workspace's and which are the
//     whole server's;
//   * BILL-5: on a shared server (scope "workspace") the server's figures are
//     not shown; the plan ceilings' editor is a platform operator's;
//   * BILL-11 / BILL-7: the quota copy says it is advisory and audited;
//   * P3 handoff (DEC-87 §1, BKP-8): the Full ZIP / JSON buttons show only to
//     a member holding the data-export surface's entry (Admin), by the full
//     collection; anyone else reads a line pointing them to an Admin.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const ORG = "77777777-7777-4777-8777-777777777777";
const role = vi.hoisted(() => ({ held: ["Admin"] as string[] }));

vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeOrgId: ORG, activeRole: role.held[0], hasAnyRole: (roles: string[]) => roles.some((r) => role.held.includes(r)) }),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } },
}));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => true) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));

import StoragePage from "@/app/(protected)/admin/storage/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const workspace = { files: { bytes: 1.5 * GB, objects: 40, newest: null, truncated: false, stoppedBy: null }, filesError: null };
const DEPLOYMENT = {
  generatedAt: "2026-10-02T10:00:00.000Z", scope: "deployment", platformOperator: false,
  operatorSql: "INSERT INTO platform_settings (key, value) VALUES ('platform_operators', ...) ...; UPDATE platform_settings ...;",
  workspace,
  db: { totalBytes: 100 * MB, tables: [{ name: "tickets", rows: 10, bytes: 50 * MB, category: "archive", reason: "records", grower: false }], byCategory: { purge: 0, archive: 50 * MB, reference: 0 } },
  r2Estimate: { totalBytes: 9 * GB, versionsBytes: 9 * GB, photosBytes: 0, versionCount: 3, photoCount: 0 },
  r2Real: { bytes: 9 * GB, objects: 900, truncated: false, stoppedBy: null, pct: 90, band: "crit", segments: [{ label: "Controlled document revisions", bytes: 9 * GB, objects: 900, newest: null }], newest: null },
  r2Error: null,
  freeTier: { r2LimitBytes: 10 * GB, dbLimitBytes: 500 * MB, dbPct: 20, dbBand: "ok", source: "default" },
  dedup: null, ai: { last24h: 1, last30d: 2 }, note: "Deployment-wide figures (every workspace on this server)...",
};
const SHARED = {
  generatedAt: "2026-10-02T10:00:00.000Z", scope: "workspace", platformOperator: false, operatorSql: "INSERT ...;",
  workspace: { ...workspace, files: { ...workspace.files, segments: [{ label: "Knowledge library files", bytes: 1.5 * GB, objects: 40, newest: null }] } },
  db: null, r2Estimate: null, r2Real: null, r2Error: null, freeTier: null, dedup: null, ai: { last24h: 0, last30d: 0 },
  note: "This workspace shares its server with other workspaces...",
};

let stats: unknown = DEPLOYMENT;
let quota: number | null = null;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  role.held = ["Admin"];
  stats = DEPLOYMENT;
  quota = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.startsWith("/api/admin/storage-stats")) return json(stats);
    if (u.startsWith("/api/admin/archive-settings")) return json({ settings: { location_hint: null, naming: null, quota_bytes: quota } });
    if (u.startsWith("/api/admin/purge")) return json({ cutoffDays: 90, targets: [], totalRows: 0, totalEstBytes: 0, note: "" });
    if (u.startsWith("/api/admin/shed")) return json({ selectedCount: 0, reclaimableBytes: 0, eligibleCount: 0 });
    if (u.startsWith("/api/admin/ticket-shed")) return json({ selectedCount: 0, reclaimableBytes: 0, eligibleCount: 0 });
    if (u.startsWith("/api/admin/archives")) return json({ archives: [] });
    return new Response("not found", { status: 404 });
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => { root.render(React.createElement(StoragePage)); });
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return container.textContent ?? "";
}
const buttons = () => [...container.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");

describe("BILL-12 — the limit is compared to this workspace's own files", () => {
  it("REPRODUCED: the watermark is the workspace's 1.5 GB of a 2 GB soft budget (75%), not the server's 100 MB + 9 GB", async () => {
    const text = await render();
    expect(text).toContain("This workspace's files");
    expect(text).toMatch(/1\.5 GB\s*\/ 2\.0 GB soft budget/);
    expect(text).toContain("75%");
    expect(text).toContain("Plan a backup");
    expect(text).not.toMatch(/Total footprint/);
    expect(text).toContain("Measured from this workspace's own files in storage, not the whole server");
  });
  it("the server's figures are labelled as the whole server's; on its only workspace they are shown", async () => {
    const text = await render();
    expect(text).toContain("The whole server — every workspace on it (this is its only workspace)");
    expect(text).toContain("Where the files are — measured from the whole bucket (every workspace)");
    expect(text).toContain("Tables by size");
    expect(text).toContain("AI usage (every workspace on this server)");
  });
  it("a partial workspace walk is a floor, said as such", async () => {
    stats = { ...DEPLOYMENT, workspace: { files: { ...workspace.files, truncated: true, stoppedBy: "deadline" }, filesError: null } };
    const text = await render();
    expect(text).toMatch(/at least 1\.5 GB/);
    expect(text).toContain("≥75%");
    expect(text).toContain("The measurement stopped early, so the real figure is higher.");
  });
  it("a failed workspace walk is 'Not measured', never a zero", async () => {
    stats = { ...DEPLOYMENT, workspace: { files: null, filesError: "bucket unreachable" } };
    const text = await render();
    expect(text).toContain("Not measured");
    expect(text).toContain("could not be measured just now (bucket unreachable)");
  });
});

describe("BILL-5 — a shared server shows a member only their workspace; the ceilings are an operator's", () => {
  it("scope workspace: no server tables, bucket total or plan headroom; the workspace's own breakdown and a note why", async () => {
    stats = SHARED;
    const text = await render();
    expect(text).not.toContain("Tables by size");
    expect(text).not.toContain("Plan headroom");
    expect(text).not.toContain("The whole server");
    expect(text).toContain("This workspace shares its server with other workspaces");
    expect(text).toContain("Where this workspace's files are — measured from its own storage");
    expect(text).toContain("AI usage (this workspace)");
    expect(text).toMatch(/1\.5 GB\s*\/ 2\.0 GB soft budget/);
  });
  it("not an operator: no ceilings editor; an Admin / DocCtrl sees how the owner registers one", async () => {
    const text = await render();
    expect(buttons().some((b) => /plan ceilings|real ceilings/.test(b))).toBe(false);
    expect(text).toContain("only a platform operator can change them");
    expect(text).toContain("INSERT INTO platform_settings");
  });
  it("a Manager is not shown the SQL", async () => {
    role.held = ["Manager"];
    const text = await render();
    expect(text).toContain("only a platform operator can change them");
    expect(text).not.toContain("INSERT INTO platform_settings");
  });
  it("an operator gets the editor", async () => {
    stats = { ...DEPLOYMENT, platformOperator: true, operatorSql: null };
    const text = await render();
    expect(buttons()).toContain("Upgraded your plan? Set the real ceilings");
    expect(text).toContain("The whole server — every workspace on it (you are a platform operator)");
  });
});

describe("BILL-11 / BILL-7 — the quota copy", () => {
  it("says the limit is advisory, who is notified, and that a change is audited", async () => {
    quota = 10 * GB;
    const text = await render();
    expect(text).toContain("Advisory: Admin and Document Control are notified at 70% / 90%; uploads are never blocked at this limit. A change is recorded in the audit log.");
    expect(text).not.toContain("Admins are alerted at 70% / 90%.");
  });
});

describe("P3 handoff (DEC-87 §1) — the backup buttons are the data-export surface's", () => {
  it("an Admin sees Full ZIP and JSON", async () => {
    await render();
    expect(buttons()).toEqual(expect.arrayContaining(["Full ZIP (records + binaries)", "JSON only (records)"]));
  });
  it("an Admin by the COLLECTION (headline Viewer) sees them too", async () => {
    role.held = ["Viewer", "Admin"];
    await render();
    expect(buttons()).toContain("Full ZIP (records + binaries)");
  });
  for (const held of [["Manager"], ["DocCtrl"], ["Manager", "DocCtrl"]]) {
    it(`${held.join("+")} sees no export button — a line pointing to an Admin instead of a 403`, async () => {
      role.held = held;
      const text = await render();
      expect(buttons()).not.toContain("Full ZIP (records + binaries)");
      expect(buttons()).not.toContain("JSON only (records)");
      expect(text).toContain("Exporting the whole workspace, and its scheduled destinations, is limited to Admins. Ask an Admin to take a full backup.");
    });
  }
});
