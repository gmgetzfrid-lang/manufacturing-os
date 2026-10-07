// projects Round G — projects-joint J14 PROJECTS FOLLOW-UPS: the pins that
// are plain source or pure-function checks (the rendered and route tests
// sit beside the surfaces they drive).
//
//   REL-9 done-when 3 — the remaining dead declarations: `trend` (a literal
//   "steady" reserved field nobody rendered) is gone from ProjectHealth;
//   `setup_state` is KEPT by decision, with its reader recorded (the
//   workspace export / restore carry the projects row whole). The other two
//   (`equipmentTags`, `addEvidence`) are pinned in checklists.test.ts.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeProjectHealth, type ProjectStateSnapshot } from "@/lib/projectHealth";
import { notifyQuoteOutcome, quoteOutcomeEmail } from "@/lib/intakeOutcomeNotice";

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } } }));

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("REL-9 (J14) — the remaining dead declarations", () => {
  it("ProjectHealth carries no `trend`: the reserved literal is gone, and nothing read it", () => {
    const h = computeProjectHealth({} as unknown as ProjectStateSnapshot);
    expect("trend" in h).toBe(false);
    expect(Object.keys(h).sort()).toEqual(["parts", "score"]);
    expect(src("lib/projectHealth.ts")).not.toMatch(/\btrend\b/);
  });

  it("setup_state is kept as the wizard's record, its reader recorded: the export reads every exported table whole, and `projects` is one", () => {
    const writes = src("lib/projectWizardWrites.ts");
    expect(writes).toContain("setup_state: d.setupState,");
    expect(writes).toContain("REL-9 (projects Round G J14): kept, by decision");
    expect(src("lib/exportTables.ts")).toMatch(/\n\s+"projects",\n/);
    expect(src("lib/dataExport.ts")).toContain('sb.from(table).select("*")');
  });

  it("the checklist engine's evidence state no longer declares equipmentTags", () => {
    expect(src("lib/checklistEngine.ts")).not.toContain("equipmentTags");
    expect(src("lib/checklists.ts")).not.toContain("equipmentTags");
  });
});

describe("MON-10 (J14) — the Costs tab's call and the quote notice's words", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("notifyQuoteOutcome posts the quote's id to J12's route with the caller's token, and passes the answer through", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sent: false, reason: "undecided", error: "x" }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await notifyQuoteOutcome("o1", "q1")).toEqual({ sent: false, reason: "undecided" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("/api/intake/outcome-notice");
    expect(init.headers.authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({ orgId: "o1", costDocumentId: "q1" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ sent: true, outcome: "awarded" }), { status: 200 })));
    expect(await notifyQuoteOutcome("o1", "q1")).toEqual({ sent: true });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await notifyQuoteOutcome("o1", "q1")).toEqual({ sent: false, reason: "offline" });
  });
  it("the words say selected or not, as the portal does — no price, no reason, no rivals", () => {
    const a = quoteOutcomeEmail({ outcome: "awarded", company: null, projectName: null, vendorName: "Gulf", rfqGroup: null });
    expect(a.subject).toBe("Selected: your quote");
    expect(a.text).toContain("Hello,\n\nThank you — your quote was selected.");
    const d = quoteOutcomeEmail({ outcome: "declined", company: "Gulf", projectName: "Unit 300", vendorName: "Gulf", rfqGroup: "  " });
    expect(d.subject).toBe("Not selected: Unit 300");
    expect(d.text).toContain("Thank you for your quote on Unit 300. It was not selected this time.");
  });
});

describe("SAF-9 done-when 3 (J14) — no UI string claims a contractor channel that does not exist", () => {
  it("the turnover rejection prompt says where the reason goes: the item's nonconformance record and the contractor's company scorecard — and that the contractor is not sent it", () => {
    const tab = src("components/projects/QualityTab.tsx");
    expect(tab).not.toContain("The contractor sees this reason");
    expect(tab).toContain("The reason is kept on this item as a nonconformance, and the rejection counts on its contractor's company record when the contractor is linked to a Known Company. The contractor is not sent this reason — tell them yourself.");
    // the company record it names does count a rejected turnover item (lib/companies.ts)
    expect(src("lib/companies.ts")).toContain('turnoverRejected: turnover.filter((t) => t.status === "rejected").length,');
  });
});
