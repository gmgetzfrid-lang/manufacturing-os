// @vitest-environment jsdom
//
// projects Round G — J10, A11Y-4 Done-when 3 on the SHARED modal. Modal is
// the shell behind every appConfirm / appPrompt / appAlert in the app
// (DialogProvider) and the plot-plans dialog, so its focus handling is
// pinned against the shapes that could break an existing consumer:
//   * the trap — Tab / Shift+Tab wrap at the edges, the browser moves focus
//     between them, focus outside the dialog is brought back in;
//   * a nested modal — only the topmost traps and answers Escape (a confirm
//     opened from a dialog closes alone; the dialog under it stays);
//   * restore — focus returns to the opener on close, only when the opener
//     still exists; never to a removed one; never trapped by a closed modal;
//   * a form inside the trap still submits, and Enter is never swallowed;
//   * Escape and backdrop dismissal are unchanged for a single modal, and a
//     non-dismissable modal still ignores both;
//   * an open HelpTooltip inside a dialog takes the first Escape.
// Then the five modals A11Y-4 names compose it: rendered where the page can
// be rendered (the wizard, the two company dialogs), pinned on the source
// for the two project-page dialogs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const nav = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
const wiz = vi.hoisted(() => ({ createProject: vi.fn(), listCompanies: vi.fn(async () => []) }));
const comp = vi.hoisted(() => ({
  listCompaniesPage: vi.fn(), gatherCompanyProfiles: vi.fn(), getCompany: vi.fn(), gatherCompanyProfile: vi.fn(),
  saveCompany: vi.fn(), addCompanyEvent: vi.fn(),
}));
const role = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("@/lib/supabase", () => ({ supabase: { from: () => ({}), auth: { getSession: async () => ({ data: { session: null } }) } } }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => undefined) }));
vi.mock("next/navigation", () => ({ useRouter: () => nav, useParams: () => ({ id: "c1" }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/lib/projects", () => ({ createProject: wiz.createProject }));
vi.mock("@/lib/turnover", () => ({ seedTurnoverItems: vi.fn(async () => ({ ok: true, added: 0 })) }));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => role.value }));
vi.mock("@/components/ui/ChartKit", () => ({ ScoreDial: () => null, scoreBandColor: () => "#888" }));
vi.mock("@/lib/companies", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/companies")>();
  return { ...actual, ...comp, listCompanies: wiz.listCompanies };
});

import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { DialogHost, appConfirm } from "@/components/providers/DialogProvider";
import HelpTooltip from "@/components/ui/HelpTooltip";
import ProjectWizard from "@/components/projects/ProjectWizard";
import CompaniesPage from "@/app/(protected)/companies/page";
import CompanyProfilePage from "@/app/(protected)/companies/[id]/page";
import type { Company } from "@/lib/companies";
import { computeCompanyScorecard } from "@/lib/companyScore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
type ModalProps = React.ComponentProps<typeof Modal>;
/** createElement for a component whose children are required in its props type. */
const modal = (props: Omit<ModalProps, "children">, ...kids: React.ReactNode[]) => h(Modal, props as ModalProps, ...kids);
const tip = (label: string, text: string) => h(HelpTooltip, { label } as React.ComponentProps<typeof HelpTooltip>, text);
const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  for (const f of Object.values(comp)) f.mockReset();
  wiz.createProject.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const key = (k: string, opts: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
};
const dialogs = () => [...document.querySelectorAll('[role="dialog"]')] as HTMLElement[];
const byText = (sel: string, re: RegExp, scope: ParentNode = document) => [...scope.querySelectorAll(sel)].find((el) => re.test(el.textContent ?? "")) as HTMLElement | undefined;

/** A page with an opener button and a modal it toggles. */
function Harness({ onClose, dismissable = true, children }: { onClose?: () => void; dismissable?: boolean; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return h("div", null,
    h("button", { id: "opener", onClick: () => setOpen(true) }, "Open"),
    h("button", { id: "behind" }, "Behind"),
    open && modal({ dismissable, onClose: () => { onClose?.(); setOpen(false); } },
      h(ModalHeader, { title: "Rename folder", onClose: () => setOpen(false) }),
      h(ModalBody, null, children ?? h(React.Fragment, null, h("input", { id: "first-field" }), h("input", { id: "second-field" }))),
      h(ModalFooter, null, h("button", { id: "cancel", onClick: () => setOpen(false) }, "Cancel"), h("button", { id: "save" }, "Save")),
    ),
  );
}
const openHarness = async (props: React.ComponentProps<typeof Harness> = {}) => {
  await act(async () => { root.render(h(Harness, props)); });
  const opener = document.getElementById("opener") as HTMLButtonElement;
  opener.focus();
  await act(async () => { opener.click(); });
  return opener;
};

describe("Modal — the trap", () => {
  it("opening moves focus into the dialog; the dialog is named by its header", async () => {
    await openHarness();
    const [dlg] = dialogs();
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    expect(dlg.contains(document.activeElement)).toBe(true);
    const name = document.getElementById(dlg.getAttribute("aria-labelledby")!)?.textContent;
    expect(name).toBe("Rename folder");
  });

  it("an autoFocus inside the dialog keeps focus (the panel does not steal it)", async () => {
    await openHarness({ children: h("input", { id: "auto", autoFocus: true }) });
    expect(document.activeElement?.id).toBe("auto");
  });

  it("Tab on the last control wraps to the first; Shift+Tab on the first wraps to the last; between them the browser moves", async () => {
    await openHarness();
    const [dlg] = dialogs();
    const close = dlg.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    const save = document.getElementById("save") as HTMLButtonElement;
    save.focus();
    const e1 = key("Tab");
    expect(e1.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    const e2 = key("Tab", { shiftKey: true });
    expect(e2.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(save);
    (document.getElementById("first-field") as HTMLInputElement).focus();
    const e3 = key("Tab");
    expect(e3.defaultPrevented).toBe(false);
  });

  it("focus that escaped to the page behind is brought back in on Tab", async () => {
    await openHarness();
    (document.getElementById("behind") as HTMLButtonElement).focus();
    const e = key("Tab");
    expect(e.defaultPrevented).toBe(true);
    expect(dialogs()[0].contains(document.activeElement)).toBe(true);
  });

  it("a form inside the trap still submits, and Enter is never swallowed", async () => {
    const submitted = vi.fn((e: React.FormEvent) => e.preventDefault());
    await openHarness({ children: h("form", { onSubmit: submitted }, h("input", { id: "f" }), h("button", { id: "go", type: "submit" }, "Go")) });
    (document.getElementById("f") as HTMLInputElement).focus();
    expect(key("Enter").defaultPrevented).toBe(false);
    await act(async () => { (document.getElementById("go") as HTMLButtonElement).click(); });
    expect(submitted).toHaveBeenCalledTimes(1);
    // the trap still holds after the submit
    (document.getElementById("save") as HTMLButtonElement).focus();
    expect(key("Tab").defaultPrevented).toBe(true);
  });
});

describe("Modal — dismissal is unchanged for one modal", () => {
  it("Escape closes a dismissable modal; the backdrop click closes it", async () => {
    const onClose = vi.fn();
    await openHarness({ onClose });
    await act(async () => { key("Escape"); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialogs()).toHaveLength(0);
    await act(async () => { (document.getElementById("opener") as HTMLButtonElement).click(); });
    const backdrop = dialogs()[0].firstElementChild as HTMLElement;
    await act(async () => { backdrop.click(); });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(dialogs()).toHaveLength(0);
  });

  it("a non-dismissable modal ignores Escape and the backdrop (mid-flight operations) — and still traps", async () => {
    const onClose = vi.fn();
    await openHarness({ onClose, dismissable: false });
    await act(async () => { key("Escape"); });
    await act(async () => { (dialogs()[0].firstElementChild as HTMLElement).click(); });
    expect(onClose).not.toHaveBeenCalled();
    expect(dialogs()).toHaveLength(1);
    (document.getElementById("save") as HTMLButtonElement).focus();
    expect(key("Tab").defaultPrevented).toBe(true);
  });

  it("an open HelpTooltip inside the dialog takes the first Escape; the second closes the dialog", async () => {
    const onClose = vi.fn();
    await openHarness({ onClose, children: tip("What this does", "Explained.") });
    const trigger = dialogs()[0].querySelector('button[aria-label="What this does"]') as HTMLButtonElement;
    await act(async () => { trigger.click(); });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => { key("Escape"); });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { key("Escape"); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Modal — focus restore", () => {
  it("closing returns focus to the element that opened it", async () => {
    const opener = await openHarness();
    expect(document.activeElement).not.toBe(opener);
    await act(async () => { (document.getElementById("cancel") as HTMLButtonElement).click(); });
    await flush();
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(opener);
  });

  it("an opener that unmounted while the modal was open is not focused (focus is not thrown at a removed node); a closed modal traps nothing", async () => {
    function GoneOpener() {
      const [showOpener, setShowOpener] = useState(true);
      const [open, setOpen] = useState(false);
      return h("div", null,
        showOpener && h("button", { id: "row-action", onClick: () => setOpen(true) }, "Edit row"),
        h("button", { id: "elsewhere" }, "Elsewhere"),
        open && modal({ onClose: () => setOpen(false) },
          h("button", { id: "save-and-remove", onClick: () => { setShowOpener(false); setOpen(false); } }, "Save (removes the row)")),
      );
    }
    await act(async () => { root.render(h(GoneOpener)); });
    const opener = document.getElementById("row-action") as HTMLButtonElement;
    opener.focus();
    await act(async () => { opener.click(); });
    expect(dialogs()).toHaveLength(1);
    await act(async () => { (document.getElementById("save-and-remove") as HTMLButtonElement).click(); });
    await flush();
    expect(dialogs()).toHaveLength(0);
    expect(opener.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(opener);
    // nothing traps once it is closed
    (document.getElementById("elsewhere") as HTMLButtonElement).focus();
    expect(key("Tab").defaultPrevented).toBe(false);
    expect(key("Escape").defaultPrevented).toBe(false);
  });

  it("focus the consumer moved elsewhere on close is left there", async () => {
    function MovesFocus() {
      const [open, setOpen] = useState(false);
      React.useEffect(() => { if (!open) document.getElementById("error-field")?.focus(); }, [open]);
      return h("div", null,
        h("button", { id: "opener2", onClick: () => setOpen(true) }, "Open"),
        h("input", { id: "error-field" }),
        open && modal({ onClose: () => setOpen(false) }, h("button", { id: "close2", onClick: () => setOpen(false) }, "Close")),
      );
    }
    await act(async () => { root.render(h(MovesFocus)); });
    const opener = document.getElementById("opener2") as HTMLButtonElement;
    opener.focus();
    await act(async () => { opener.click(); });
    await act(async () => { (document.getElementById("close2") as HTMLButtonElement).click(); });
    await flush();
    expect(document.activeElement?.id).toBe("error-field");
  });
});

describe("Modal — nested (a confirm opened from a dialog)", () => {
  it("only the topmost traps and answers Escape: the confirm closes alone, the dialog under it stays, and focus returns into it", async () => {
    const outerClose = vi.fn();
    let answer: boolean | null = null;
    function Page() {
      const [open, setOpen] = useState(true);
      return h(React.Fragment, null,
        h(DialogHost),
        open && modal({ onClose: () => { outerClose(); setOpen(false); } },
          h(ModalHeader, { title: "New project" }),
          h(ModalBody, null, h("input", { id: "name" })),
          h(ModalFooter, null,
            h("button", { id: "discard", onClick: () => { void appConfirm({ title: "Discard?" }).then((v) => { answer = v; }); } }, "Discard")),
        ),
      );
    }
    await act(async () => { root.render(h(Page)); });
    const discard = document.getElementById("discard") as HTMLButtonElement;
    discard.focus();
    await act(async () => { discard.click(); });
    await flush();
    expect(dialogs()).toHaveLength(2);
    const confirmDlg = dialogs()[1];
    expect(confirmDlg.contains(document.activeElement)).toBe(true);   // the Confirm button's autoFocus
    // Tab at the confirm's last control wraps inside the CONFIRM, not the dialog under it
    const confirmBtn = byText("button", /^Confirm$/, confirmDlg)!;
    confirmBtn.focus();
    expect(key("Tab").defaultPrevented).toBe(true);
    expect(confirmDlg.contains(document.activeElement)).toBe(true);
    // Escape cancels the confirm only
    await act(async () => { key("Escape"); });
    await flush();
    expect(answer).toBe(false);
    expect(outerClose).not.toHaveBeenCalled();
    expect(dialogs()).toHaveLength(1);
    expect(document.activeElement).toBe(discard);
    // and the dialog under it is the topmost again
    await act(async () => { key("Escape"); });
    expect(outerClose).toHaveBeenCalledTimes(1);
  });

  it("appConfirm / appPrompt keep working as before: Enter-submit settles, Cancel returns false / null", async () => {
    await act(async () => { root.render(h(DialogHost)); });
    let ok: boolean | null = null;
    await act(async () => { void appConfirm("Release this hold?").then((v) => { ok = v; }); });
    await flush();
    const form = dialogs()[0].querySelector("form")!;
    await act(async () => { form.requestSubmit(); });
    await flush();
    expect(ok).toBe(true);
    let no: boolean | null = null;
    await act(async () => { void appConfirm("Again?").then((v) => { no = v; }); });
    await flush();
    await act(async () => { byText("button", /^Cancel$/, dialogs()[0])!.click(); });
    await flush();
    expect(no).toBe(false);
    expect(dialogs()).toHaveLength(0);
  });
});

describe("A11Y-4 — the five modals compose the shared Modal", () => {
  it("the project wizard: a named dialog, focus on Name, Escape closes an empty wizard and asks before discarding typing", async () => {
    const onClose = vi.fn();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await act(async () => {
      root.render(h(ProjectWizard, { orgId: "o1", actorUserId: "u1", onClose, onCreated: vi.fn() }));
    });
    const [dlg] = dialogs();
    expect(document.getElementById(dlg.getAttribute("aria-labelledby")!)?.textContent).toMatch(/^New project — Basics/);
    expect((document.activeElement as HTMLInputElement).placeholder).toBe("2026 Q1 Turnaround — Unit 300");
    expect(dlg.querySelector('button[aria-label="Close"]')).not.toBeNull();
    await act(async () => { key("Escape"); });
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();

    // with something typed, Escape asks first — and a "no" keeps the wizard and the typing
    onClose.mockReset();
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => { root.render(h(ProjectWizard, { orgId: "o1", actorUserId: "u1", onClose, onCreated: vi.fn() })); });
    const name = document.activeElement as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(name, "Unit 300 turnaround"); name.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { key("Escape"); });
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect((dialogs()[0].querySelector('input[placeholder="2026 Q1 Turnaround — Unit 300"]') as HTMLInputElement).value).toBe("Unit 300 turnaround");
  });

  it("A11Y-6: a wizard refusal moves focus to the failed field (a budget amount that isn't a number) or, with no single field, to the announced banner", async () => {
    await act(async () => { root.render(h(ProjectWizard, { orgId: "o1", actorUserId: "u1", onClose: vi.fn(), onCreated: vi.fn() })); });
    const setValue = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const dlg = dialogs()[0];
    await act(async () => { setValue(dlg.querySelector('input[placeholder="2026 Q1 Turnaround — Unit 300"]') as HTMLInputElement, "Unit 300"); });
    await act(async () => { setValue(dlg.querySelector("textarea") as HTMLTextAreaElement, "Replace E-301 circuits"); });
    for (let i = 0; i < 3; i++) await act(async () => { byText("button", /^\s*Next\s*$/, dlg)!.click(); });
    expect(document.getElementById(dlg.getAttribute("aria-labelledby")!)?.textContent).toMatch(/Budget/);
    await act(async () => { setValue(dlg.querySelector('input[aria-label="Budget line 1 name"]') as HTMLInputElement, "Piping"); });
    await act(async () => { setValue(dlg.querySelector('input[aria-label="Budget line 1 amount (USD)"]') as HTMLInputElement, "lots"); });
    await act(async () => { byText("button", /Create project/, dlg)!.click(); });
    await flush();
    expect(dlg.querySelector('[role="alert"]')?.textContent).toMatch(/Budget amount isn't a number for: Piping/);
    expect((document.activeElement as HTMLInputElement).getAttribute("aria-label")).toBe("Budget line 1 amount (USD)");

    // fix it; the create itself fails → focus lands on the announced error
    wiz.createProject.mockRejectedValueOnce(new Error("You don't have permission to do this — nothing was changed."));
    await act(async () => { setValue(dlg.querySelector('input[aria-label="Budget line 1 amount (USD)"]') as HTMLInputElement, "1200"); });
    await act(async () => { byText("button", /Create project/, dlg)!.click(); });
    await flush();
    const banner = dlg.querySelector('[role="alert"]') as HTMLElement;
    expect(banner.textContent).toMatch(/You don't have permission/);
    expect(document.activeElement).toBe(banner);
  });

  const company: Company = {
    id: "c1", orgId: "o1", name: "Apex Industrial", kind: "contractor", trade: "piping", status: "active",
    contactName: null, contactEmail: null, contactPhone: null, qualityManualDocId: null, qualityManualScore: null,
    qualityManualGaps: null, qualityManualReviewedAt: null, qualityManualPagesRead: null, qualityManualPagesTotal: null,
    notes: null, createdAt: null,
  };

  it("Known Companies → Add company: a named dialog with a labelled close, Escape closes it, and its grids collapse on a phone", async () => {
    role.value = { activeOrgId: "o1", uid: "u1", hasAnyRole: () => true, loading: false, membershipState: "member" };
    comp.listCompaniesPage.mockResolvedValue({ rows: [], total: 0, page: 0, pageSize: 50 });
    comp.gatherCompanyProfiles.mockResolvedValue(new Map());
    await act(async () => { root.render(h(CompaniesPage)); });
    await flush();
    // A11Y-7 (rendered): the kind filter says which pill is pressed, and moves with a click
    const pills = [...document.querySelectorAll('[aria-label="Filter companies by kind"] button')] as HTMLButtonElement[];
    expect(pills.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false", "false"]);
    await act(async () => { pills[1].click(); });
    await flush();
    expect(pills.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false", "false", "false"]);
    expect(pills[1].className).toContain("ring-[var(--color-accent)]");
    const add = byText("button", /Add company/)!;
    add.focus();
    await act(async () => { add.click(); });
    const [dlg] = dialogs();
    expect(document.getElementById(dlg.getAttribute("aria-labelledby")!)?.textContent).toBe("Add a known company");
    expect(dlg.querySelector('button[aria-label="Close"]')).not.toBeNull();
    expect(dlg.querySelector(".grid-cols-2:not(.sm\\:grid-cols-2), .grid-cols-3")).toBeNull();
    await act(async () => { key("Escape"); });
    await flush();
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(add);
  });

  it("company profile → Edit: a named dialog; a failed save is announced inside it", async () => {
    role.value = { activeOrgId: "o1", uid: "u1", userEmail: "pm@example.com", hasAnyRole: () => true };
    comp.getCompany.mockResolvedValue(company);
    comp.gatherCompanyProfile.mockResolvedValue({
      company, events: [], partiesLinked: 1, awardsSource: "none", projects: [], bids: [], changeOrders: [],
      scorecard: computeCompanyScorecard({
        recordables: 0, nearMisses: 0, warnings: 0, stopWorks: 0, commendations: 0, qualityManualScore: null,
        turnoverAccepted: 0, turnoverRejected: 0, punchClosed: 0, punchTotal: 0, awardsTotal: 0, finalCostTotal: 0,
        changeOrderCount: 0, changeOrderScopeGapCount: 0, milestonesOnTheirScopes: 0, milestonesHitOnTime: 0,
        submissionCount: 0, avgSubmitToReviewDays: null, avgAssignToSubmitDays: null,
      }),
    });
    comp.saveCompany.mockRejectedValue(new Error("“Apex Industrial” is already in the registry."));
    await act(async () => { root.render(h(CompanyProfilePage)); });
    await flush();
    await act(async () => { byText("button", /Edit/)!.click(); });
    const [dlg] = dialogs();
    expect(document.getElementById(dlg.getAttribute("aria-labelledby")!)?.textContent).toBe("Edit Apex Industrial");
    expect(dlg.querySelector('select[aria-describedby="company-status-help"]')).not.toBeNull();
    await act(async () => { byText("button", /Save/, dlg)!.click(); });
    await flush();
    expect(dlg.querySelector('[role="alert"]')?.textContent).toMatch(/already in the registry/);
  });

  it("the project page's lessons-learned and status-transition dialogs compose Modal + ModalHeader (a labelled close on both; no hand-rolled shell left)", () => {
    const page = src("app/(protected)/projects/[id]/page.tsx");
    expect(page).toContain('import { Modal, ModalHeader } from "@/components/ui/Modal";');
    expect(page).not.toMatch(/fixed inset-0 z-\[200\]/);
    expect(page).toContain('<ModalHeader title="Lessons learned" onClose={lessonsBusy ? undefined : () => setLessonsDraft(null)}');
    expect(page).toMatch(/<Modal size="md" dismissable=\{!transitionBusy\}/);
    expect(page).toContain("onClose={transitionBusy ? undefined : () => { setPendingStatus(null); setStatusReason(\"\"); setActionError(null); }} />");
    expect(page).toContain('{actionError && <div role="alert" className="mt-2 text-xs font-bold text-rose-700 dark:text-rose-300">{actionError}</div>}');
    for (const f of ["components/projects/ProjectWizard.tsx", "app/(protected)/companies/page.tsx", "app/(protected)/companies/[id]/page.tsx"]) {
      expect(src(f), f).not.toMatch(/fixed inset-0 z-\[200\]/);
      expect(src(f), f).toMatch(/<Modal /);
    }
  });
});
