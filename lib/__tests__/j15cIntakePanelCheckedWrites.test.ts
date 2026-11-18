// @vitest-environment jsdom
//
// projects-joint J15c CHECKED-WRITE SWEEP (projects-tab SAF-18) — the Intake
// tab's own writes, driven through the rendered panel
// (components/projects/IntakePanel.tsx). Each UPDATE now reads its matched
// rows (lib/checkedWrite.ts): a write that row-level security filtered to
// zero rows — no error, nothing changed — is said in words, and no audit row
// or contractor notice follows it. The sign-off close-out on a rejection is
// the one legitimate no-op (DEC-90 class c): an intake draft has no roster,
// so zero rows there is the ordinary case and the rejection stands.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Res = { data: unknown; error: null | { code?: string; message: string } };
const s = vi.hoisted(() => ({
  notify: vi.fn(),
  appPrompt: vi.fn(),
  /** Tables whose UPDATE row-level security filters to zero rows (no error). */
  refused: new Set<string>(),
  /** The link's assigned documents as the list reads them. */
  assigned: [] as string[],
  /** projects.intake_library_id as the panel reads it. */
  library: "lib1" as string | null,
  writes: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));
vi.mock("@/components/providers/DialogProvider", () => ({ appPrompt: (...a: unknown[]) => s.appPrompt(...a), appConfirm: vi.fn(async () => true), appAlert: vi.fn() }));
vi.mock("@/lib/reviewControl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reviewControl")>()),
  finalizeReviewedRevision: vi.fn(),
  effectiveReviewControlForDocument: vi.fn(async () => ({ mode: "none" })),
  listDraftRoster: vi.fn(async () => []),
  openReviewRoster: vi.fn(),
}));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async () => "document") }));
vi.mock("@/lib/checklists", () => ({ describeProjectSweep: vi.fn(() => null) }));
vi.mock("@/lib/transitionIn", () => ({ flagCollisionToDrafting: vi.fn() }));
vi.mock("@/components/projects/TransitionInPanel", () => ({ default: () => null }));
vi.mock("@/lib/intakeOutcomeNotice", () => ({ notifyIntakeOutcome: (...a: unknown[]) => s.notify(...a) }));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ hasAnyRole: () => true, roles: ["DocCtrl"], activeRole: "DocCtrl" }),
}));
vi.mock("@/lib/supabase", () => {
  const answer = (table: string, methods: string[], args: unknown[][]): Res => {
    const single = methods.includes("maybeSingle") || methods.includes("single");
    if (methods[0] === "update") {
      s.writes.push({ table, method: "update", args: args[0] });
      // PostgREST answers `.select("id")` with the rows it matched — none when RLS hid them
      return { data: s.refused.has(table) ? [] : [{ id: `${table}-1` }], error: null };
    }
    if (methods[0] === "insert") {
      s.writes.push({ table, method: "insert", args: args[0] });
      return { data: table === "project_intake_links" ? { id: "link-9" } : null, error: null };
    }
    if (table === "project_intake_links") return { data: [{ id: "l1", company_name: "Gulf Mechanical", contact_email: "pm@gulf.example", allow_auto_supersede: false, expires_at: null, revoked_at: null, submission_count: 1, last_used_at: null, assigned_doc_ids: s.assigned }], error: null };
    if (table === "projects") return { data: { intake_library_id: s.library, intake_collection_id: null }, error: null };
    if (table === "libraries") return { data: [{ id: "lib1", name: "Intake" }], error: null };
    if (table === "document_versions" && single) return { data: { moc_reference: null, file_hash: "h1" }, error: null };
    if (table === "document_versions") return { data: [{ id: "v2", record_id: "d1", revision_label: "B", created_by_name: "Gulf Mechanical", created_at: "2026-10-01T00:00:00Z", change_log: null }], error: null };
    if (table === "documents" && single) return { data: { id: "d1", pending_version_id: "v2" }, error: null };
    if (table === "documents") return { data: [{ id: "d1", document_number: "P-101", pending_version_id: "v2" }, { id: "d9", document_number: "P-900" }], error: null };
    return { data: [], error: null };
  };
  const chain = (table: string): unknown => {
    const methods: string[] = []; const args: unknown[][] = [];
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(answer(table, methods, args));
        return (...a: unknown[]) => { methods.push(prop); args.push(a); return new Proxy({}, h); };
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: null } }) } } };
});

import IntakePanel from "@/components/projects/IntakePanel";
import { CHECKED_WRITE_REFUSED } from "@/lib/checkedWrite";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  s.refused = new Set(); s.assigned = []; s.library = "lib1"; s.writes = [];
  s.notify.mockReset().mockResolvedValue({ sent: true });
  s.appPrompt.mockReset().mockResolvedValue("The weld map is missing from sheet 2");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const render = async () => {
  await act(async () => {
    root.render(React.createElement(IntakePanel, { orgId: "o1", projectId: "p1", canManage: true, uid: "u1", userEmail: "u1@example.com" }));
  });
  await settle();
};
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); await settle(); };
const button = (label: string) => {
  const b = [...host.querySelectorAll("button")].find((x) => x.textContent?.trim().endsWith(label));
  if (!b) throw new Error(`no button "${label}"`);
  return b as HTMLButtonElement;
};
const notice = () => host.querySelector("[data-tone]")?.textContent ?? "";
const tone = () => host.querySelector("[data-tone]")?.getAttribute("data-tone");
const wrote = (table: string, method: string) => s.writes.filter((w) => w.table === table && w.method === method);
const setInput = async (el: HTMLInputElement, v: string) => {
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
  await act(async () => { proto.set!.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); });
};

describe("SAF-18 (J15c) — a rejection's own writes are checked", () => {
  it("a pending-pointer clear that matched no row is said, and no INTAKE_REJECTED row or contractor notice follows it", async () => {
    s.refused.add("documents");
    await render();
    await click(button("Reject"));
    expect(notice()).toBe(`Couldn't clear the pending revision: ${CHECKED_WRITE_REFUSED}`);
    expect(tone()).toBe("error");
    expect(wrote("audit_logs", "insert")).toEqual([]);
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("(class c) a rejection whose draft has no sign-off rows to close stands — audited and told as before", async () => {
    s.refused.add("document_review_signoffs");
    await render();
    await click(button("Reject"));
    expect(notice()).toBe("P-101 Rev B rejected — the company sees it as not accepted, with your reason, on their portal. The company's contact was emailed the outcome.");
    expect(wrote("audit_logs", "insert")).toHaveLength(1);
    expect(s.notify).toHaveBeenCalledWith("o1", "v2");
  });

  it("regression: the ordinary rejection writes the version, the pointer, the sign-offs and the audit row, in that order", async () => {
    await render();
    await click(button("Reject"));
    expect(s.writes.map((w) => `${w.method}:${w.table}`)).toEqual([
      "update:document_versions", "update:documents", "update:document_review_signoffs", "insert:audit_logs",
    ]);
  });
});

describe("SAF-18 (J15c) — the link's assignment and the intake library are checked", () => {
  it("an unassign that matched no row is said, and no INTAKE_ASSIGNMENT_CHANGED row is written", async () => {
    s.assigned = ["d9"];
    s.refused.add("project_intake_links");
    await render();
    await click(host.querySelector('button[title="Unassign"]')!);
    expect(wrote("project_intake_links", "update")).toHaveLength(1);
    expect(notice()).toBe(CHECKED_WRITE_REFUSED);
    expect(wrote("audit_logs", "insert")).toEqual([]);
  });

  it("regression: an unassign that lands is audited as before", async () => {
    s.assigned = ["d9"];
    await render();
    await click(host.querySelector('button[title="Unassign"]')!);
    expect(wrote("audit_logs", "insert")).toHaveLength(1);
    expect((wrote("audit_logs", "insert")[0].args[0] as { action: string }).action).toBe("INTAKE_ASSIGNMENT_CHANGED");
  });

  it("a first intake-library set that matched no row is said, and no link is minted behind it", async () => {
    s.library = null;
    s.refused.add("projects");
    await render();
    await setInput(host.querySelector('input[placeholder^="Company name"]') as HTMLInputElement, "Gulf Mechanical");
    const pick = host.querySelector("select") as HTMLSelectElement;
    const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!;
    await act(async () => { proto.set!.call(pick, "lib1"); pick.dispatchEvent(new Event("change", { bubbles: true })); });
    await click([...host.querySelectorAll("button")].find((b) => /Create link/.test(b.textContent ?? ""))!);
    expect(wrote("projects", "update")).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(`Couldn't set the intake library: ${CHECKED_WRITE_REFUSED}`);
    expect(wrote("project_intake_links", "insert")).toEqual([]);
  });
});
