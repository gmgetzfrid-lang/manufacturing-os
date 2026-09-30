// @vitest-environment jsdom
//
// projects Round G — J8 PROJECT-MODEL, the project page and its cards:
//
//   REL-5   each tab renders inside its own error boundary: a throw in one tab
//           leaves the header, the tab bar and the other tabs usable (rendered)
//   UX-11   the Documents card is the primary list: approved intake rows, the
//           DEC-40 "not current" marker, and the count permissions hide are
//           rendered; the badge counts distinct documents (source pin)
//   SAF-17  detaching states its consequence before it lands (rendered)
//   PERF-8  the timeline is fetched when the Activity tab opens, not on load
//   SAF-14 / QUAL-9  the dialog's gate lines are the recorded lines, and the
//           override line is read from CLOSEOUT_GATE_POLICY
//   PM-6    the delete confirm is driven by live counts
//   PM-11 / UX-14  the observer role has copy and behaviour; authority never
//           comes from a roster row's role
//   SEC-15  "Make owner" is offered only for an active member

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const reg = vi.hoisted(() => ({ listProjectDocuments: vi.fn(), writeActivity: vi.fn() }));
const dlg = vi.hoisted(() => ({ appConfirm: vi.fn(), appAlert: vi.fn(), appPrompt: vi.fn() }));
const db = vi.hoisted(() => ({ deletes: [] as Array<Record<string, unknown>> }));

vi.mock("@/lib/projects", () => reg);
vi.mock("@/components/providers/DialogProvider", () => dlg);
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    let op = "select";
    const filters: Record<string, unknown> = {};
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
          if (op === "delete") db.deletes.push({ table, ...filters });
          return (resolve: (v: unknown) => void) => resolve({ data: op === "delete" ? [{ id: filters.id }] : [], error: null });
        }
        return (...args: unknown[]) => {
          if (prop === "delete") op = "delete";
          if (prop === "eq") filters[String(args[0])] = args[1];
          return new Proxy({}, h);
        };
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: (t: string) => chain(t) } };
});

import TabErrorBoundary from "@/components/projects/TabErrorBoundary";
import ProjectDocumentsCard from "@/components/projects/ProjectDocumentsCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const page = src("app/(protected)/projects/[id]/page.tsx");

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  reg.listProjectDocuments.mockReset(); reg.writeActivity.mockReset();
  dlg.appConfirm.mockReset(); dlg.appAlert.mockReset(); dlg.appPrompt.mockReset();
  db.deletes = [];
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function Boom(): React.ReactElement { throw new Error("Cannot read properties of undefined (reading 'budget')"); }

describe("REL-5 — one tab crashing leaves the page usable", () => {
  it("the crashing tab renders its fallback; everything outside the boundary stays mounted", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    act(() => root.render(
      React.createElement("div", null,
        React.createElement("nav", { id: "tabs" }, "Documents Costs Quality Activity"),
        React.createElement(TabErrorBoundary, { label: "The Costs tab", resetKey: "costs" }, React.createElement(Boom)),
      ),
    ));
    expect(host.querySelector("#tabs")?.textContent).toContain("Documents");
    expect(host.querySelector("[role=alert]")?.textContent).toContain("The Costs tab couldn't load");
    expect(host.textContent).toContain("reading 'budget'");
    expect(host.textContent).toContain("The rest of the project page still works.");
    err.mockRestore();
  });

  it("moving to another tab clears the error (resetKey); Retry re-renders the tab", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let crash = true;
    function Maybe() { if (crash) throw new Error("x"); return React.createElement("p", { id: "ok" }, "schedule"); }
    act(() => root.render(React.createElement(TabErrorBoundary, { label: "The Costs tab", resetKey: "costs" }, React.createElement(Maybe))));
    expect(host.querySelector("[role=alert]")).not.toBeNull();
    crash = false;
    act(() => root.render(React.createElement(TabErrorBoundary, { label: "The Schedule tab", resetKey: "schedule" }, React.createElement(Maybe))));
    expect(host.querySelector("#ok")?.textContent).toBe("schedule");
    crash = true;
    act(() => root.render(React.createElement(TabErrorBoundary, { label: "The Schedule tab", resetKey: "schedule" }, React.createElement(Maybe))));
    expect(host.querySelector("[role=alert]")).not.toBeNull();
    crash = false;
    act(() => (host.querySelector("[role=alert] button") as HTMLButtonElement).click());
    expect(host.querySelector("#ok")).not.toBeNull();
    err.mockRestore();
  });

  it("the project page wraps the tab content and the coach in boundaries keyed on the tab", () => {
    expect(page).toContain('<TabErrorBoundary label={`The ${TAB_LABEL[tab]} tab`} resetKey={tab}>');
    expect(page).toContain('<TabErrorBoundary label="The project coach" resetKey={tab}>');
    const open = page.indexOf('<TabErrorBoundary label={`The ${TAB_LABEL[tab]} tab`}');
    const close = page.indexOf("</TabErrorBoundary>\n      </div>");
    for (const t of ['tab === "documents"', 'tab === "costs"', 'tab === "quality"', 'tab === "intake"', 'tab === "activity"', 'tab === "schedule"', 'tab === "members"']) {
      const at = page.indexOf(`{${t}`, open);
      expect(at, t).toBeGreaterThan(open);
      expect(at, t).toBeLessThan(close);
    }
  });
});

describe("UX-11 / SAF-17 / DEC-40 — the Documents card", () => {
  const register = {
    hiddenByPermissions: 2,
    rows: [
      { linkId: "l1", docId: "d1", label: "ISO-100", rev: "C", status: "Issued", libraryId: "lib", source: "checkout", lastSeenAt: null, isCurrent: true },
      { linkId: "l2", docId: "d2", label: "ISO-101", rev: "B", status: "Superseded", libraryId: "lib", source: "manual", lastSeenAt: null, isCurrent: false },
      { linkId: null, docId: "d9", label: "ISO-900", rev: "A", status: "Issued", libraryId: "lib", source: "intake", lastSeenAt: null, isCurrent: true },
    ],
  };

  it("renders approved intake rows, marks the not-current one, and discloses what permissions hide", async () => {
    reg.listProjectDocuments.mockResolvedValue(register);
    const onLoaded = vi.fn();
    await act(async () => root.render(React.createElement(ProjectDocumentsCard, { orgId: "o1", projectId: "p1", canManage: true, uid: "own", onLoaded })));
    expect(host.textContent).toContain("ISO-900");
    expect(host.textContent).toContain("approved intake");
    expect(host.textContent).toContain("Not current");
    expect(host.textContent).toContain("2 linked documents are hidden by your permissions.");
    expect(onLoaded).toHaveBeenCalledWith(register);
    // An intake row is not a register link: nothing to detach.
    const removeButtons = [...host.querySelectorAll("button[aria-label^='Remove']")].map((b) => b.getAttribute("aria-label"));
    expect(removeButtons).toEqual(["Remove ISO-100 from the project", "Remove ISO-101 from the project"]);
  });

  it("detaching states the consequence first; declining removes nothing; confirming removes and writes the stamped feed row", async () => {
    reg.listProjectDocuments.mockResolvedValue(register);
    await act(async () => root.render(React.createElement(ProjectDocumentsCard, { orgId: "o1", projectId: "p1", canManage: true, uid: "own" })));
    const btn = host.querySelector("button[aria-label='Remove ISO-100 from the project']") as HTMLButtonElement;
    dlg.appConfirm.mockResolvedValueOnce(false);
    await act(async () => { btn.click(); });
    expect(String(dlg.appConfirm.mock.calls[0][0].message)).toMatch(/Its history up to now stays on the project's Activity tab/);
    expect(String(dlg.appConfirm.mock.calls[0][0].message)).toMatch(/re-link automatically the next time someone checks it out/);
    expect(db.deletes).toEqual([]);
    dlg.appConfirm.mockResolvedValueOnce(true);
    await act(async () => { btn.click(); });
    expect(db.deletes).toEqual([{ table: "project_documents", id: "l1" }]);
    expect(reg.writeActivity).toHaveBeenCalledWith(expect.objectContaining({ type: "doc_removed", metadata: { documentId: "d1" } }));
  });

  it("a refused feed row after a successful detach is shown, not swallowed", async () => {
    reg.listProjectDocuments.mockResolvedValue(register);
    reg.writeActivity.mockRejectedValueOnce(new Error("The project activity row was not written: denied"));
    await act(async () => root.render(React.createElement(ProjectDocumentsCard, { orgId: "o1", projectId: "p1", canManage: true, uid: "own" })));
    dlg.appConfirm.mockResolvedValueOnce(true);
    await act(async () => { (host.querySelector("button[aria-label='Remove ISO-101 from the project']") as HTMLButtonElement).click(); });
    expect(host.textContent).toContain("ISO-101 was removed, but the project activity row was not written: denied");
  });

  it("a viewer who cannot manage sees no attach or remove control", async () => {
    reg.listProjectDocuments.mockResolvedValue(register);
    await act(async () => root.render(React.createElement(ProjectDocumentsCard, { orgId: "o1", projectId: "p1", canManage: false, uid: "v" })));
    expect(host.querySelector("button[aria-label^='Remove']")).toBeNull();
    expect(host.textContent).not.toContain("Attach document");
  });

  it("the tab badge counts distinct documents (documentsTabCount), not sessions; the header comment describes seven tabs", () => {
    expect(page).toContain("Documents <span className=\"text-[10px] text-[var(--color-text-faint)]\">{documentsTabCount(register, checkouts.map((c) => c.documentId))}</span>");
    expect(page).not.toMatch(/Documents <span[^>]*>\{checkouts\.length\}/);
    expect(page).toContain("// /projects/[id] — project detail with seven tabs:");
    expect(page).toContain("onLoaded={setRegister}");
  });
});

describe("PERF-8 — the timeline loads with the Activity tab", () => {
  it("refresh() does not fetch the timeline or re-read job_kind; the Activity tab's effect does", () => {
    const refresh = page.slice(page.indexOf("const refresh = useCallback("), page.indexOf("// Closeout gates load when the Complete confirmation opens."));
    expect(refresh).not.toMatch(/getProjectTimeline/);
    expect(refresh).not.toMatch(/select\("job_kind"\)/);
    expect(refresh).not.toMatch(/listActivity\(/);
    expect(refresh).toMatch(/const got = await getProjectForPage\(projectId\);/);
    expect(refresh).toMatch(/setJobKind\(got\.jobKind\);/);
    // The header paints as soon as the project row lands.
    expect(refresh.indexOf("setLoading(false);")).toBeLessThan(refresh.indexOf("listMembers(projectId)"));
    expect(page).toMatch(/if \(tab !== "activity" \|\| timelineFresh \|\| !projectId\) return;[\s\S]*?getProjectTimeline\(\{ projectId, limit: 200 \}\)/);
    // The Activity badge counts what the tab renders (SAF-6 dw2).
    expect(page).toContain("Activity {timeline && <span className=\"text-[10px] text-[var(--color-text-faint)]\">{timeline.length}</span>}");
  });
});

describe("SAF-14 / QUAL-9 / PM-4 / PM-1 — the transition dialog", () => {
  it("renders the recorded gate lines, passes them to the transition, and reads the override line from CLOSEOUT_GATE_POLICY", () => {
    expect(page).toContain("const gateLines = closeoutGateLines(gates);");
    expect(page).toContain("gateSnapshot: pendingStatus === \"completed\" ? gates : undefined,");
    expect(page).toContain("{CLOSEOUT_GATE_POLICY.overrideNote} The gate state above is recorded with the completion.");
    expect(page).not.toContain("You can complete anyway — the open items stay on the record and in the report.");
  });
  it("promises no release it cannot make, and names the intake-link revocation and the freeze", () => {
    expect(page).not.toContain('"Every active checkout on this project will be released."');
    expect(page).toMatch(/A checkout you are not allowed to release stays with its holder, and you will be told who still holds what\./);
    expect(page).toMatch(/contractor intake links are revoked/);
  });
  it("offers Reopen only to a controller on a closed project, with a reason", () => {
    expect(page).toContain("{isAdmin && isClosed && (");
    expect(page).toMatch(/await reopenProject\(\{ projectId: project\.id, orgId: project\.orgId, reason, actorUserId: uid/);
  });
});

describe("PM-6 / QUAL-3 — the delete confirm", () => {
  it("is driven by live counts, refuses a non-controller when records exist, and asks a controller for a reason", () => {
    const del = page.slice(page.indexOf("const handleDelete = async () => {"), page.indexOf("if (loading) return ("));
    expect(del).toMatch(/counts = await countProjectRecords\(project\.id\)/);
    expect(del).toMatch(/const lines = describeProjectRecords\(counts\);/);
    expect(del).toMatch(/if \(regulated === null \|\| regulated > 0\) \{\s*\n\s*if \(!isAdmin\) \{/);
    expect(del).toMatch(/archive it/);
    expect(del).toMatch(/await deleteProject\(\{ projectId: project\.id, actorUserId: uid, [^}]*reason \}\)/);
    expect(page).not.toContain("This permanently removes the project and its schedule.");
  });
});

describe("PM-11 / UX-14 / SEC-15 — members", () => {
  it("authority is projects.owner_user_id; an observer gets no comment box; the observer option says what it means", () => {
    expect(page).toContain("const isOwner = project && uid && project.ownerUserId === uid;");
    expect(page).toContain('const canComment = isOwner || isAdmin || (isMember && myRosterRole !== "observer");');
    expect(page).toContain("const isOwner = m.userId === project.ownerUserId;");
    expect(page).not.toContain('const isOwner = m.role === "owner" || m.userId === project.ownerUserId;');
    expect(page).toContain('<option value="observer">Observer — can see, cannot manage or comment</option>');
  });
  it("Make owner is offered only when the target is an ACTIVE member", () => {
    expect(page).toContain("const canReceiveOwnership = canManage && !isOwner && activeMemberIds !== null && activeMemberIds.has(m.userId);");
    expect(page).toContain("{canReceiveOwnership && (");
  });
});
