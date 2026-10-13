// @vitest-environment jsdom
//
// projects Round G — J17 BARRED LOOK-ALIKE, COST-3 residual 2 (DEC-90 A21,
// extended to the contractor link by the integrator under the user's
// delegation, 2026-10-08; DEC-48's J17 line). The project wizard's
// contractor link, rendered end to end: the wizard binds a typed contractor
// to its Known Company by exact name, and lib/costs checkPartyCompanyLink
// judges that link by the do-not-use gate (lib/bidTab barredCompanyFor).
//
// The wizard's acknowledgement path is DEC-76 item 3's: it never asks and
// never stops — a flagged link goes in UNLINKED, with a note that names the
// company and the Costs tab, where the acknowledgement (the typed reason) is
// made and recorded. This file pins that a LEADING look-alike ("Apex
// Industrial" before "Apex Industrial Services") reaches that path with the
// partial-match words, that an EQUAL name reaches it with the words it had
// before J17 (byte for byte), and that a contractor no registry row leads
// is linked with no note at all — the user's top rule.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Company } from "@/lib/companies";

const nav = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
const wiz = vi.hoisted(() => ({
  createProject: vi.fn(async () => ({ id: "p-new" })),
  listCompanies: vi.fn(async () => [] as unknown[]),
  listBarredCompanies: vi.fn(async () => [] as unknown[]),
  appAlert: vi.fn(async () => undefined),
  inserts: [] as Array<{ table: string; rows: Array<Record<string, unknown>> }>,
}));

vi.mock("@/lib/supabase", () => {
  // every write resolves; a project_parties insert is recorded
  const make = (table: string): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
        return (...args: unknown[]) => {
          if (prop === "insert") wiz.inserts.push({ table, rows: args[0] as Array<Record<string, unknown>> });
          return new Proxy(chain, handler);
        };
      },
    };
    return new Proxy(chain, handler);
  };
  return { supabase: { from: (table: string) => make(table), auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => undefined) }));
vi.mock("next/navigation", () => ({ useRouter: () => nav, useParams: () => ({ id: "p-new" }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/lib/projects", () => ({ createProject: wiz.createProject }));
vi.mock("@/lib/turnover", () => ({ seedTurnoverItems: vi.fn(async () => ({ ok: true, added: 0 })) }));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({}) }));
vi.mock("@/components/providers/DialogProvider", () => ({ appAlert: wiz.appAlert, appConfirm: vi.fn(async () => true), appPrompt: vi.fn(async () => null) }));
vi.mock("@/lib/companies", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/companies")>();
  return { ...actual, listCompanies: wiz.listCompanies, listBarredCompanies: wiz.listBarredCompanies };
});

import ProjectWizard from "@/components/projects/ProjectWizard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const company = (id: string, name: string, status: Company["status"] = "active"): Company => ({
  id, orgId: "o1", name, kind: "contractor", trade: null, status,
  contactName: null, contactEmail: null, contactPhone: null, qualityManualDocId: null, qualityManualScore: null,
  qualityManualGaps: null, qualityManualReviewedAt: null, qualityManualPagesRead: null, qualityManualPagesTotal: null,
  notes: null, createdAt: null,
});
const APEX_DNU = company("c-apex-dnu", "Apex Industrial", "do_not_use");
const APEX_SERVICES = company("c-apex-services", "Apex Industrial Services");
const APEX_LLC = company("c-apex-llc", "Apex Industrial LLC");
const ZENITHAL = company("c-zen", "Zenithal Corp");

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  wiz.inserts.length = 0;
  wiz.appAlert.mockClear();
  wiz.createProject.mockClear();
  wiz.listCompanies.mockResolvedValue([APEX_DNU, APEX_SERVICES, APEX_LLC, ZENITHAL]);
  wiz.listBarredCompanies.mockResolvedValue([APEX_DNU]);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const setValue = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label || b.textContent?.trim().startsWith(label)) as HTMLButtonElement;
const click = async (b: HTMLButtonElement) => { await act(async () => { b.click(); }); await flush(); };

/** Render the wizard, fill Basics, walk to the Contractors step and type
 *  the given contractor names, then create the project. */
async function createWithContractors(names: string[]): Promise<void> {
  await act(async () => { root.render(h(ProjectWizard, { orgId: "o1", actorUserId: "u1", onClose: vi.fn(), onCreated: vi.fn() })); });
  await flush();
  await act(async () => { setValue(document.querySelector('input[placeholder="2026 Q1 Turnaround — Unit 300"]') as HTMLInputElement, "Unit 300"); });
  await act(async () => { setValue(document.querySelector("textarea") as HTMLTextAreaElement, "Replace E-301 circuits"); });
  for (let i = 0; i < 5; i++) await click(button("Next"));
  for (let i = 0; i < names.length; i++) {
    if (i > 0) await click(button("Add contractor"));
    await act(async () => { setValue(document.querySelector(`input[aria-label="Contractor ${i + 1} name"]`) as HTMLInputElement, names[i]); });
  }
  await click(button("Create project"));
  await flush();
}

const partiesInsert = () => wiz.inserts.find((i) => i.table === "project_parties")?.rows ?? [];

describe("COST-3 residual 2 (J17; DEC-90 A21 extended to the contractor link, 2026-10-08) — the wizard's contractor link, rendered", () => {
  it("a contractor whose exact Known Company a do-not-use name only LEADS is added UNLINKED, and the note says partial match and names the Costs tab (the acknowledgement path) — the project is still created", async () => {
    await createWithContractors(["Apex Industrial Services"]);
    expect(wiz.createProject).toHaveBeenCalledTimes(1);
    expect(partiesInsert()).toEqual([expect.objectContaining({ name: "Apex Industrial Services", company_id: null, project_id: "p-new" })]);
    expect(wiz.appAlert).toHaveBeenCalledTimes(1);
    expect(wiz.appAlert).toHaveBeenCalledWith({
      title: "A contractor was added without its company link",
      message: '"Apex Industrial Services" was added without a company link: the name could be Apex Industrial, flagged DO NOT USE in the registry (a partial match — the registry name "Apex Industrial" leads "Apex Industrial Services"). Link it on the project\'s Costs tab, where the link records a reason.',
    });
    expect(nav.push).toHaveBeenCalledWith("/projects/p-new");
  });

  it("an EQUAL do-not-use name reaches the same path with the words it had before J17, and a contractor no registry row leads is linked with no note (the top rule)", async () => {
    await createWithContractors(["Apex Industrial LLC", "Zenithal Corp"]);
    expect(partiesInsert()).toEqual([
      expect.objectContaining({ name: "Apex Industrial LLC", company_id: null }),
      expect.objectContaining({ name: "Zenithal Corp", company_id: "c-zen" }),
    ]);
    expect(wiz.appAlert).toHaveBeenCalledTimes(1);
    expect(wiz.appAlert).toHaveBeenCalledWith({
      title: "A contractor was added without its company link",
      message: '"Apex Industrial LLC" was added without a company link: the name could be Apex Industrial, flagged DO NOT USE in the registry. Link it on the project\'s Costs tab, where the link records a reason.',
    });
  });

  it("the leading look-alike's note and an equal name's note are both said, in wizard order, and the do-not-use company itself links with no note (it answers for itself at the award)", async () => {
    await createWithContractors(["Apex Industrial Services", "Apex Industrial", "Apex Industrial LLC"]);
    expect(partiesInsert()).toEqual([
      expect.objectContaining({ name: "Apex Industrial Services", company_id: null }),
      expect.objectContaining({ name: "Apex Industrial", company_id: "c-apex-dnu" }),
      expect.objectContaining({ name: "Apex Industrial LLC", company_id: null }),
    ]);
    expect(wiz.appAlert).toHaveBeenCalledTimes(1);
    expect(wiz.appAlert).toHaveBeenCalledWith({
      title: "Some contractors were added without their company link",
      message: '"Apex Industrial Services" was added without a company link: the name could be Apex Industrial, flagged DO NOT USE in the registry (a partial match — the registry name "Apex Industrial" leads "Apex Industrial Services"). Link it on the project\'s Costs tab, where the link records a reason.'
        + ' "Apex Industrial LLC" was added without a company link: the name could be Apex Industrial, flagged DO NOT USE in the registry. Link it on the project\'s Costs tab, where the link records a reason.',
    });
  });

  it("with no do-not-use row in the registry, every exact-name contractor is linked and nothing is said", async () => {
    wiz.listBarredCompanies.mockResolvedValue([]);
    await createWithContractors(["Apex Industrial Services", "Zenithal Corp"]);
    expect(partiesInsert()).toEqual([
      expect.objectContaining({ name: "Apex Industrial Services", company_id: "c-apex-services" }),
      expect.objectContaining({ name: "Zenithal Corp", company_id: "c-zen" }),
    ]);
    expect(wiz.appAlert).not.toHaveBeenCalled();
  });
});
