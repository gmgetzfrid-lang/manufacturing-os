// @vitest-environment jsdom
//
// admin-and-org Round G, package P13 — ALOG-8: /admin/storage no longer
// treats any 2xx from a destructive route as a recorded success. Since P7 /
// P14 / P13 the purge, the orphans purge, archive-cancel, both reclaims and
// the ticket restore answer `auditError` when the operation ran but its
// audit row was refused (the routes' half of done-when 1's "response body"
// form). The page now says it, in an amber notice naming what ran and why its
// record is missing. Regression: a recorded operation shows no notice and
// behaves as before.

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
  generatedAt: "2026-10-02T10:00:00.000Z", scope: "deployment", platformOperator: false, soleTenant: true,
  operatorSql: "INSERT INTO platform_settings (key, value) VALUES ('platform_operators', ...) ...; UPDATE platform_settings ...;",
  workspace,
  db: { totalBytes: 100 * MB, tables: [{ name: "tickets", rows: 10, bytes: 50 * MB, category: "archive", reason: "records", grower: false }], byCategory: { purge: 0, archive: 50 * MB, reference: 0 } },
  r2Estimate: { totalBytes: 9 * GB, versionsBytes: 9 * GB, photosBytes: 0, versionCount: 3, photoCount: 0 },
  r2Real: { bytes: 9 * GB, objects: 900, truncated: false, stoppedBy: null, pct: 90, band: "crit", segments: [{ label: "Controlled document revisions", bytes: 9 * GB, objects: 900, newest: null }], newest: null },
  r2Error: null,
  freeTier: { r2LimitBytes: 10 * GB, dbLimitBytes: 500 * MB, dbPct: 20, dbBand: "ok", source: "default" },
  dedup: null, ai: { last24h: 1, last30d: 2 }, note: "Deployment-wide figures (every workspace on this server)...",
};

const EMPTY_SHED = { selectedCount: 0, reclaimableBytes: 0, eligibleCount: 0 };
const PURGE_PREVIEW = { cutoffDays: 90, targets: [{ table: "notifications", rows: 12, estBytes: 4096, reason: "read notices" }], totalRows: 12, totalEstBytes: 4096, note: "" };
const CATALOG_ROW = {
  archiveId: "MOS-20261014-AB12", kind: "data", fileCount: 2, totalBytes: 2048, note: "2 files", createdAt: "2026-10-14T08:00:00.000Z",
  createdByEmail: "admin@x.io", docPending: 2, docCommitted: 0, ticketPending: 0, ticketCommitted: 0, status: "pending",
};
let answers: Record<string, { status: number; body: unknown }> = {};
const posts: string[] = [];
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  role.held = ["Admin"];
  answers = {};
  posts.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (init?.method === "POST") {
      const path = u.split("?")[0];
      posts.push(path);
      const a = answers[path];
      return a ? json(a.body, a.status) : json({ ok: true });
    }
    if (u.startsWith("/api/admin/storage-stats")) return json(DEPLOYMENT);
    if (u.startsWith("/api/admin/archive-settings")) return json({ settings: { location_hint: null, naming: null, quota_bytes: null } });
    if (u.startsWith("/api/admin/purge")) return json(PURGE_PREVIEW);
    if (u.startsWith("/api/admin/shed")) return json(EMPTY_SHED);
    if (u.startsWith("/api/admin/ticket-shed")) return json(EMPTY_SHED);
    if (u.startsWith("/api/admin/archives")) return json({ archives: [CATALOG_ROW] });
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

async function settle() { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
async function render() {
  await act(async () => { root.render(React.createElement(StoragePage)); });
  await settle();
}
async function click(label: RegExp) {
  const b = [...container.querySelectorAll("button")].find((x) => label.test(x.textContent ?? ""));
  expect(b, `button ${label}`).toBeTruthy();
  await act(async () => { (b as HTMLButtonElement).click(); });
  await settle();
}
const gaps = () => container.querySelector('[data-testid="storage-audit-gaps"]')?.textContent ?? null;

describe("ALOG-8 (P13) — /admin/storage says when a destructive operation ran but was not recorded", () => {
  it("purge: a 200 carrying auditError shows the amber notice naming it", async () => {
    answers["/api/admin/purge"] = { status: 200, body: { ok: true, deleted: 12, auditError: "the purge ran but its DATA_PURGE audit row was not written: permission denied" } };
    await render();
    await click(/Purge 12 rows/);
    expect(posts).toContain("/api/admin/purge");
    const t = gaps();
    expect(t).toContain("Purge ran — NOT recorded in the audit log: the purge ran but its DATA_PURGE audit row was not written: permission denied");
    expect(t).toContain("only its audit-log record is missing");
  });

  it("regression: a recorded purge shows no notice", async () => {
    answers["/api/admin/purge"] = { status: 200, body: { ok: true, deleted: 12 } };
    await render();
    await click(/Purge 12 rows/);
    expect(posts).toContain("/api/admin/purge");
    expect(gaps()).toBeNull();
  });

  it("archive-cancel (catalog Discard): a 200 carrying auditError is said", async () => {
    answers["/api/admin/archive-cancel"] = { status: 200, body: { ok: true, auditError: "the archive was discarded but its ARCHIVE_PRODUCE_CANCELED audit row was not written: timeout" } };
    await render();
    await click(/^Discard$/);
    expect(posts).toContain("/api/admin/archive-cancel");
    expect(gaps()).toContain("MOS-20261014-AB12: discard — NOT recorded in the audit log: the archive was discarded but its ARCHIVE_PRODUCE_CANCELED audit row was not written: timeout");
  });

  it("archive-cancel's partial 500 (tickets unlinked, then refused) says the unrecorded change as well as the error", async () => {
    answers["/api/admin/archive-cancel"] = { status: 500, body: { error: "The revisions could not be unlinked", auditError: "the 3 ticket(s) unlinked were not recorded: the ARCHIVE_PRODUCE_CANCELED audit row was not written: refused" } };
    await render();
    await click(/^Discard$/);
    expect(gaps()).toContain("the 3 ticket(s) unlinked were not recorded");
    expect(container.textContent).toContain("The revisions could not be unlinked");
  });

  it("the catalog's reclaim (shed commit): a 200 carrying auditError is said; regression: a recorded one is not", async () => {
    answers["/api/admin/shed/commit"] = { status: 200, body: { ok: true, reclaimed: 2, keysDeleted: 2, errors: [], auditError: "the reclaim freed 2 file(s) but its DATA_ARCHIVE_RECLAIM audit row was not written: refused" } };
    await render();
    await click(/I saved it — reclaim/);
    expect(posts).toContain("/api/admin/shed/commit");
    expect(gaps()).toContain("MOS-20261014-AB12: space reclaimed — NOT recorded in the audit log: the reclaim freed 2 file(s)");
    await click(/Dismiss/);
    expect(gaps()).toBeNull();
  });

  it("regression: a recorded catalog reclaim shows the usual line and no notice", async () => {
    answers["/api/admin/shed/commit"] = { status: 200, body: { ok: true, reclaimed: 2, keysDeleted: 2, errors: [] } };
    await render();
    await click(/I saved it — reclaim/);
    expect(gaps()).toBeNull();
    expect(container.textContent).toContain("MOS-20261014-AB12: space reclaimed.");
  });
});
