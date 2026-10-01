// @vitest-environment jsdom
//
// projects Round G — J10b UI REMAINDERS: projects-tab REL-9 (the checklist
// limb). lib/checklists.setChecklistStatus has always accepted 'void', and
// the Quality tab filters void checklists out of every list — but no
// interface could void one, so a checklist created by mistake stayed on the
// project (and in every closeout count) for good. The database rail
// (20261136 project_checklists_signoff_rail, QUAL-15) admits a void from the
// controller tier only (is_org_controller: Admin / DocCtrl held anywhere),
// so the control is offered to exactly that tier:
//   * a controller sees "Void checklist" on an open or completed checklist,
//     gives a reason (the consequence is said; a signed-off one says so; the
//     reason meets the record's bar), and the checklist is written 'void'
//     through the checked lib write with that reason, the tab re-reads (the
//     card leaves the list) and the page is told;
//   * the void's audit row is its only record of who voided it (the table
//     keeps no voided_by): when that insert fails the lib says so
//     (auditError) and the section — which outlives the card — says the
//     void landed unrecorded (the review's REL-9 minor);
//   * anyone else is not offered it;
//   * a refusal (the rail's own sentence) is shown on the card, nothing else
//     changes; cancelling the prompt writes nothing.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const m = vi.hoisted(() => ({
  roles: [] as string[],
  listChecklists: vi.fn(), listChecklistItems: vi.fn(), setChecklistStatus: vi.fn(), loadSignoffAuthority: vi.fn(),
  appConfirm: vi.fn(), appPrompt: vi.fn(), invalidate: vi.fn(),
}));

vi.mock("@/lib/supabase", () => {
  const chain: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
      return () => new Proxy(chain, handler);
    },
  };
  return { supabase: { from: () => new Proxy(chain, handler), rpc: () => new Proxy(chain, handler), auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn() }));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ member: { displayName: "Dana Controller" }, activeRole: m.roles[0] ?? null, roles: m.roles }),
}));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: m.appConfirm, appPrompt: m.appPrompt }));
vi.mock("@/components/signatures/SignatureCeremony", () => ({ default: () => null }));
vi.mock("@/lib/costs", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/costs")>();
  return { ...real, listParties: vi.fn(async () => []) };
});
vi.mock("@/lib/checklists", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/checklists")>();
  return {
    ...real, listChecklists: m.listChecklists, listChecklistItems: m.listChecklistItems,
    setChecklistStatus: m.setChecklistStatus, loadSignoffAuthority: m.loadSignoffAuthority,
  };
});
vi.mock("@/lib/turnover", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/turnover")>();
  return { ...real, listTurnoverItems: vi.fn(async () => []), listTurnoverReviewEvents: vi.fn(async () => []), listPunchItems: vi.fn(async () => []) };
});
vi.mock("@/lib/projectSnapshot", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/projectSnapshot")>();
  return { ...real, invalidateProjectSnapshot: m.invalidate };
});

import QualityTab from "@/components/projects/QualityTab";
import type { Checklist } from "@/lib/checklists";
import { REASON_MIN_LENGTH } from "@/lib/checklistEngine";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const checklist = (over: Partial<Checklist> = {}): Checklist => ({
  id: "cl1", orgId: "o1", projectId: "p1", kind: "pssr", title: "PSSR — Unit 300 tie-in", sourceDocumentId: null,
  status: "open", createdAt: null, createdBy: "someone-else", ...over,
} as Checklist);

let host: HTMLDivElement;
let root: Root;
let told = 0;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  for (const f of [m.listChecklists, m.listChecklistItems, m.setChecklistStatus, m.loadSignoffAuthority, m.appConfirm, m.appPrompt, m.invalidate]) f.mockReset();
  m.roles = [];
  told = 0;
  m.listChecklists.mockResolvedValue([checklist()]);
  m.listChecklistItems.mockResolvedValue([]);
  m.loadSignoffAuthority.mockResolvedValue({ maySign: true, otherSigners: 2, source: "database" });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function render() {
  await act(async () => {
    root.render(React.createElement(QualityTab, {
      orgId: "o1", projectId: "p1", canManage: true, uid: "u-dana", userEmail: "dana@plant.example", jobKind: "small",
      onDataChanged: () => { told++; },
    }));
  });
  await settle();
}
const buttonByText = (re: RegExp) => [...host.querySelectorAll("button")].find((b) => re.test(b.textContent ?? "")) as HTMLButtonElement | undefined;
async function openCard() {
  const toggle = buttonByText(/PSSR — Unit 300 tie-in/)!;
  expect(toggle).toBeTruthy();
  await act(async () => { toggle.click(); });
  await settle();
}

describe("REL-9 — a mistaken checklist can be voided, by the tier the database admits", () => {
  it("a controller (DocCtrl held beside a headline Engineer role) voids an open checklist: the prompt names the consequence and asks the reason, the lib writes 'void' with it, the card leaves the list and the page is told", async () => {
    m.roles = ["Engineer", "DocCtrl"];
    await render();
    await openCard();
    const voidBtn = buttonByText(/Void checklist/)!;
    expect(voidBtn).toBeTruthy();
    expect(voidBtn.className).toContain("pointer-coarse:min-h-11");   // a decision control (A11Y-8 floor)

    m.appPrompt.mockResolvedValueOnce("  Created against the wrong unit  ");
    m.setChecklistStatus.mockResolvedValueOnce({ ok: true });
    m.listChecklists.mockResolvedValue([]);   // the re-read: void checklists are not listed
    await act(async () => { voidBtn.click(); });
    await settle();

    expect(m.appConfirm).not.toHaveBeenCalled();
    const ask = m.appPrompt.mock.calls[0][0] as Record<string, unknown>;
    expect(ask.title).toBe("Void the checklist “PSSR — Unit 300 tie-in”?");
    expect(ask.message).toBe("Use this for a checklist created by mistake. Voiding takes it out of this project's checklists and every closeout count. Its items stay on the record, and the void is recorded under your name with the reason you give. Only Admin / Document Control can void a checklist.");
    expect(ask).toMatchObject({ confirmLabel: "Void checklist", tone: "danger", required: true, minLength: REASON_MIN_LENGTH });
    expect(m.setChecklistStatus).toHaveBeenCalledTimes(1);
    expect(m.setChecklistStatus).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "o1", projectId: "p1", status: "void", checklist: expect.objectContaining({ id: "cl1" }),
      actor: { uid: "u-dana", email: "dana@plant.example" }, reason: "Created against the wrong unit",
    }));
    expect(m.listChecklists).toHaveBeenCalledTimes(2);
    expect(buttonByText(/PSSR — Unit 300 tie-in/)).toBeUndefined();
    expect(host.querySelector('[role="alert"]')).toBeNull();   // the record landed: nothing to say
    expect(m.invalidate).toHaveBeenCalledWith("o1", "p1");
    expect(told).toBe(1);
  });

  it("the void landed but its audit row failed: the section says so after the card has left the list — the void is not recorded under the voider's name", async () => {
    m.roles = ["Admin"];
    await render();
    await openCard();
    m.appPrompt.mockResolvedValueOnce("Duplicate of the Unit 300 PSSR");
    m.setChecklistStatus.mockResolvedValueOnce({ ok: true, auditError: "You don't have permission to do this." });
    m.listChecklists.mockResolvedValue([]);
    await act(async () => { buttonByText(/Void checklist/)!.click(); });
    await settle();
    expect(buttonByText(/PSSR — Unit 300 tie-in/)).toBeUndefined();   // the card is gone …
    // … and the section's notice says what the card cannot
    expect(host.querySelector('[role="alert"]')?.textContent?.trim()).toBe("The checklist “PSSR — Unit 300 tie-in” was voided, but its audit record failed (You don't have permission to do this) — the void is not recorded under your name, so closeout cannot say who voided it or why.");
    expect(told).toBe(1);   // the void landed, so the page re-gathers
  });

  it("a completed (signed-off) checklist says so in the prompt; cancelling writes nothing", async () => {
    m.roles = ["Admin"];
    m.listChecklists.mockResolvedValue([checklist({ status: "complete", completedByName: "Sam Signer" } as Partial<Checklist>)]);
    await render();
    await openCard();
    m.appPrompt.mockResolvedValueOnce(null);
    await act(async () => { buttonByText(/Void checklist/)!.click(); });
    await settle();
    const ask = m.appPrompt.mock.calls[0][0] as { message: string };
    expect(ask.message).toBe("It was signed off by Sam Signer. Voiding withdraws it from this project's checklists and every closeout count. Its items and its signature stay on the record, and the void is recorded under your name with the reason you give. Only Admin / Document Control can void a checklist.");
    expect(m.setChecklistStatus).not.toHaveBeenCalled();
    expect(told).toBe(0);
  });

  it("a refusal is said on the card and nothing else changes", async () => {
    m.roles = ["DocCtrl"];
    await render();
    await openCard();
    m.appPrompt.mockResolvedValueOnce("Created against the wrong unit");
    m.setChecklistStatus.mockResolvedValueOnce({ ok: false, error: "Voiding a checklist takes it out of the project's closeout with no reason on record — only Admin / Document Control voids one. Nothing was changed. QUAL-15, 20261136" });
    await act(async () => { buttonByText(/Void checklist/)!.click(); });
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("only Admin / Document Control voids one. Nothing was changed.");
    expect(buttonByText(/PSSR — Unit 300 tie-in/)).toBeTruthy();
    expect(m.listChecklists).toHaveBeenCalledTimes(1);
    expect(told).toBe(0);
  });

  for (const roles of [[], ["Engineer"], ["Manager", "Supervisor"], ["Viewer"]]) {
    it(`no Void control outside the controller tier (${roles.join(" + ") || "no role"}) — the project owner and a sign-off grantee included`, async () => {
      m.roles = roles;
      await render();
      await openCard();
      expect(buttonByText(/Void checklist/)).toBeUndefined();
    });
  }

  it("the client gate is the database's: isControllerPrincipal mirrors is_org_controller's Admin / DocCtrl union, and the rail refuses everyone else", () => {
    const tab = src("components/projects/QualityTab.tsx");
    expect(tab).toContain("const mayVoidChecklist = isControllerPrincipal({ role: activeRole, roles });");
    // the tier is the lib's (DEC-35: the quality layer names no role literal)
    expect(src("lib/permissions.ts")).toContain('return role === "Admin" || role === "DocCtrl";');
    expect(tab).toMatch(/\{mayVoid && checklist\.status !== "void" && \(/);
    const rail = src("supabase/migrations/20261136_prj_roundG_quality_signoff.sql");
    expect(rail).toContain("IF NEW.status = 'void' AND OLD.status IS DISTINCT FROM 'void'\n     AND NOT is_org_controller(OLD.org_id) THEN");
    const ctl = src("supabase/migrations/20260814_documents_delete_controllers.sql");
    expect(ctl).toContain("AND (role IN ('Admin', 'DocCtrl') OR roles && ARRAY['Admin', 'DocCtrl']::text[])");
  });
});

describe("REL-9 — the company history panels' dead scorecard prop is gone", () => {
  it("HistoryPanels takes the profile only; the dial is the scorecard's one reader on the page", () => {
    const page = src("app/(protected)/companies/[id]/page.tsx");
    expect(page).toContain("<HistoryPanels profile={profile} />");
    expect(page).toContain("function HistoryPanels({ profile }: { profile: CompanyProfileData | null }) {");
    expect(page).not.toContain("void scorecard;");
    expect(page).not.toMatch(/scorecard=\{sc\}/);
  });
});
