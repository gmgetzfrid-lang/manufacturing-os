// @vitest-environment jsdom
//
// projects Round G — J10b UI REMAINDERS:
//   INTK-17 (projects-and-cost) the Intake tab's Revoke updates only a
//           still-unrevoked link of THIS project and reads back the rows it
//           changed; a revoke that changed nothing writes no
//           INTAKE_LINK_REVOKED row and says so, and a second click on an
//           already-revoked link never moves its revoked_at (the update
//           carries `revoked_at IS NULL`) — the Costs tab's twin's shape.
//   XEDGE-5 / PHYS-13 (document-control / public-surfaces, the projects
//           sites) the contractor /submit links the Intake tab and the
//           Costs tab's quote links hand out are built on the app's public
//           origin (lib/publicOrigin), never window.location.origin — a link
//           copied on a preview deploy never sends a contractor to the
//           preview host.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Res = { data: unknown; error: null | { code?: string; message: string } };
const db = vi.hoisted(() => ({
  byOp: {} as Record<string, Res>,
  results: {} as Record<string, Res>,
  calls: [] as Array<{ table: string; op: string; method: string; args: unknown[] }>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));
const dlg = vi.hoisted(() => ({ appPrompt: vi.fn(), appConfirm: vi.fn(), appAlert: vi.fn() }));
const reg = vi.hoisted(() => ({ listCompanies: vi.fn(async () => []), listBarredCompanies: vi.fn(async () => []), getCompany: vi.fn() }));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    let op = "";
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
          const res = db.byOp[`${table}.${op}`] ?? db.results[table] ?? { data: [], error: null };
          return (resolve: (v: unknown) => void) => resolve(res);
        }
        return (...args: unknown[]) => {
          if (!op) op = prop;
          db.calls.push({ table, op, method: prop, args });
          if (prop === "insert") db.inserts.push({ table, row: args[0] as Record<string, unknown> });
          return new Proxy({}, h);
        };
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/components/providers/DialogProvider", () => dlg);
vi.mock("@/lib/reviewControl", () => ({
  finalizeReviewedRevision: vi.fn(), finalizeReasonMessage: vi.fn(() => ""),
  effectiveReviewControlForDocument: vi.fn(), listDraftRoster: vi.fn(async () => []), openReviewRoster: vi.fn(),
}));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn() }));
// projects Round G J14 (INTK-18): the panel reads the controller tier from the role collection.
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ hasAnyRole: () => false }) }));
vi.mock("@/lib/transitionIn", () => ({ flagCollisionToDrafting: vi.fn() }));
vi.mock("@/components/projects/TransitionInPanel", () => ({ default: () => null }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => undefined) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/lib/companies", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/companies")>()), ...reg }));

import IntakePanel from "@/components/projects/IntakePanel";
import QuotesPanel from "@/components/projects/cost/QuotesPanel";
import { intakePortalPath } from "@/lib/intakeLinks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

let host: HTMLDivElement;
let root: Root;
const clip: string[] = [];
beforeEach(() => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  for (const f of Object.values(dlg)) f.mockReset();
  db.byOp = {}; db.results = {}; db.calls = []; db.inserts = [];
  db.byOp["projects.select"] = { data: { intake_library_id: "lib1", intake_collection_id: null }, error: null };
  db.byOp["libraries.select"] = { data: [{ id: "lib1", name: "Intake" }], error: null };
  db.byOp["project_intake_links.select"] = { data: [], error: null };
  clip.length = 0;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { clip.push(t); } } });
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllEnvs(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const setInput = async (el: HTMLInputElement, v: string) => {
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
  await act(async () => { proto.set!.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); });
};
const buttonByText = (re: RegExp, scope: ParentNode = host) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => re.test(b.textContent ?? ""));
const auditRows = () => db.inserts.filter((i) => i.table === "audit_logs");
const renderIntake = async () => {
  await act(async () => {
    root.render(React.createElement(IntakePanel, { orgId: "o1", projectId: "p1", canManage: true, uid: "u1", userEmail: "u1@example.com" }));
  });
  await settle();
};
const live = {
  id: "L1", token_prefix: "abc123", company_name: "Bayline", contact_email: null, allow_auto_supersede: false,
  expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(), revoked_at: null, submission_count: 0, last_used_at: null, assigned_doc_ids: [],
};

describe("INTK-17 — the Intake tab's Revoke changes only an unrevoked link of this project, and audits only a revocation that happened", () => {
  it("the update is scoped to the project and to revoked_at IS NULL, and reads back its rows; one row → INTAKE_LINK_REVOKED by link id", async () => {
    db.byOp["project_intake_links.select"] = { data: [live], error: null };
    db.byOp["project_intake_links.update"] = { data: [{ id: "L1" }], error: null };
    db.byOp["audit_logs.insert"] = { data: null, error: null };
    dlg.appConfirm.mockResolvedValue(true);
    await renderIntake();
    // A11Y-14: the link row's decision controls carry the 24 / 44 px floor
    expect(buttonByText(/Revoke/)!.className).toContain("pointer-coarse:min-h-11");
    expect(buttonByText(/Assign docs/)!.className).toContain("pointer-coarse:min-h-11");
    await act(async () => { buttonByText(/Revoke/)!.click(); }); await settle();
    const upd = db.calls.filter((c) => c.table === "project_intake_links" && c.op === "update");
    expect(upd.map((c) => c.method)).toEqual(["update", "eq", "eq", "is", "select"]);
    expect(upd.map((c) => c.args)).toEqual([
      [expect.objectContaining({ revoked_at: expect.any(String) })], ["id", "L1"], ["project_id", "p1"], ["revoked_at", null], ["id"],
    ]);
    expect(Object.keys(upd[0].args[0] as object)).toEqual(["revoked_at"]);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0].row).toMatchObject({ action: "INTAKE_LINK_REVOKED", resource_type: "project_intake_link", resource_id: "L1" });
    expect(host.textContent).not.toContain("was not revoked");
  });

  it("zero rows (already revoked by someone else, or not permitted): no audit row, the user is told, and the list is re-read", async () => {
    db.byOp["project_intake_links.select"] = { data: [live], error: null };
    db.byOp["project_intake_links.update"] = { data: [], error: null };
    dlg.appConfirm.mockResolvedValue(true);
    await renderIntake();
    const readsBefore = db.calls.filter((c) => c.table === "project_intake_links" && c.op === "select" && c.method === "select").length;
    await act(async () => { buttonByText(/Revoke/)!.click(); }); await settle();
    expect(auditRows()).toHaveLength(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Bayline's link was not revoked — it may already be revoked, or you may not have permission. The list now shows its current state.");
    const readsAfter = db.calls.filter((c) => c.table === "project_intake_links" && c.op === "select" && c.method === "select").length;
    expect(readsAfter).toBeGreaterThan(readsBefore);
  });

  it("a second click on an already-revoked link cannot move its revoked_at: the update only ever matches revoked_at IS NULL", () => {
    const panel = src("components/projects/IntakePanel.tsx");
    const revoke = panel.slice(panel.indexOf("const revoke = async (l: IntakeLink) => {"), panel.indexOf("// Assign an existing controlled document to a link."));
    expect(revoke).toContain('.eq("id", l.id).eq("project_id", projectId).is("revoked_at", null).select("id");');
    expect(revoke.indexOf("(revoked as unknown[]).length === 0")).toBeLessThan(revoke.indexOf('action: "INTAKE_LINK_REVOKED"'));
  });
});

describe("XEDGE-5 / PHYS-13 — contractor links are built on the app's public origin", () => {
  it("Intake tab: a minted /submit link copies with the configured site URL, not the page's host", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.plant.example/");
    expect(window.location.origin).not.toBe("https://app.plant.example");
    db.byOp["project_intake_links.insert"] = { data: { id: "link-9" }, error: null };
    db.byOp["audit_logs.insert"] = { data: null, error: null };
    await renderIntake();
    db.byOp["project_intake_links.select"] = { data: [{ ...live, id: "link-9", company_name: "Gulf Mechanical" }], error: null };
    await setInput(host.querySelector('input[placeholder^="Company name"]') as HTMLInputElement, "Gulf Mechanical");
    await act(async () => { buttonByText(/Create link/)!.click(); }); await settle();
    const token = String(db.inserts.find((i) => i.table === "project_intake_links")!.row.token);
    await act(async () => { buttonByText(/Copy link/)!.click(); }); await settle();
    expect(clip).toEqual([`https://app.plant.example${intakePortalPath(token)}`]);
    expect(clip[0]).not.toContain(window.location.host);
  });

  it("Costs tab: a minted quote link copies with the configured site URL, not the page's host", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.plant.example");
    db.results.project_intake_links = { data: [], error: null };
    db.byOp["project_intake_links.insert"] = { data: { id: "link-123" }, error: null };
    db.byOp["audit_logs.insert"] = { data: null, error: null };
    await act(async () => {
      root.render(React.createElement(QuotesPanel, {
        orgId: "o1", projectId: "p1", canManage: true, actor: { uid: "u1", email: "u1@example.com" },
        accounts: [], docs: [], onChanged: () => undefined, setErr: () => undefined,
      }));
    });
    await settle();
    await act(async () => { buttonByText(/Quote links for contractors/)!.click(); }); await settle();
    db.byOp["project_intake_links.select"] = { data: [{ id: "link-123", token_prefix: "abc123", company_name: "Gulf Mechanical", rfq_group: null, revoked_at: null, expires_at: new Date(Date.now() + 9 * 86_400_000).toISOString(), submission_count: 0, purpose: "quote" }], error: null };
    await setInput(host.querySelector('input[placeholder="Company name"]') as HTMLInputElement, "Gulf Mechanical");
    await act(async () => { buttonByText(/Create link/)!.click(); }); await settle();
    const token = String(db.inserts.find((i) => i.table === "project_intake_links")!.row.token);
    await act(async () => { buttonByText(/Copy link/)!.click(); }); await settle();
    expect(clip).toEqual([`https://app.plant.example${intakePortalPath(token)}`]);
    expect(clip[0]).not.toContain(window.location.host);
  });

  it("no outbound link in the projects components reads window.location.origin; both builders use publicOrigin()", () => {
    for (const f of ["components/projects/IntakePanel.tsx", "components/projects/cost/QuotesPanel.tsx"]) {
      const s = src(f);
      expect(s, f).not.toMatch(/window\.location\.origin/);
      expect(s, f).toContain('import { publicOrigin } from "@/lib/publicOrigin";');
      expect(s, f).toContain("const portalUrl = (token: string) => `${publicOrigin()}${intakePortalPath(token)}`;");
    }
  });
});
