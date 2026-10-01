// projects Round G — J12 SERVER REMAINDERS: the pure halves and the source
// pins (the route, lib and migration halves have their own files:
// costDocs.test.ts, checklists.test.ts, costDocsRoute.test.ts,
// intakeOutcomeNoticeRoute.test.ts, projectSnapshot.test.ts,
// projectReportJ12.test.ts, evidencePackQuality.test.ts,
// prjRoundGJ12Migration.test.ts).
//
//   SAF-8   a MISSED task earns nothing in the cost EV index
//   COST-2  the health Cost part burns on exposure (spent + open commitments)
//   SAF-9   the contractor's notice reads the outcome and the reason
//   PERF-9  the project page loads its four heavy tabs on open
//   PERF-8  the page hands the coach the project row and roster it read
//   PERF-5  the board's date labels reuse their formatters; the axis and
//           gridlines are memo'd (a drag does not rebuild them)

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { milestonePctIndex, computeCostRollup, type CostAccount, type CostEntry } from "@/lib/costs";
import { computeProjectHealth, type ProjectStateSnapshot } from "@/lib/projectHealth";
import { intakeOutcomeEmail } from "@/lib/intakeOutcomeNotice";

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("SAF-8 — a missed task earns nothing in the cost EV index", () => {
  it("missed reads 0 whatever percent is stored; every other status keeps the old rule", () => {
    const idx = milestonePctIndex([
      { id: "m1", status: "missed", percentComplete: 80 },
      { id: "m2", status: "missed" },
      { id: "m3", status: "in_progress", percentComplete: 80 },
      { id: "m4", status: "completed" },
      { id: "m5", status: "planned" },
    ]);
    expect([...idx.entries()]).toEqual([["m1", 0], ["m2", 0], ["m3", 80], ["m4", 100], ["m5", 0]]);
  });
  it("the 100%-then-missed transition: the pinned account's earned value goes 1000 → 0 and the cost CPI with it", () => {
    const account: CostAccount = { id: "a1", projectId: "p1", code: "01", name: "Piping", costType: "subcontract",
      budget: 1000, currency: "USD", partyId: null, wbsMilestoneId: "m1", status: "active" };
    const spent: CostEntry = { id: "e1", costAccountId: "a1", projectId: "p1", partyId: null, entryType: "actual", amount: 500,
      entryDate: "2026-09-01", description: null, reference: null, status: "posted", sourceDocumentId: null };
    const done = computeCostRollup([account], [spent], milestonePctIndex([{ id: "m1", status: "completed", percentComplete: 100 }]));
    const missed = computeCostRollup([account], [spent], milestonePctIndex([{ id: "m1", status: "missed", percentComplete: 100 }]));
    expect(done.cpi).toBeCloseTo(2);
    expect(missed.cpi).toBe(0);
  });
});

const snapshot = (over: Partial<ProjectStateSnapshot> = {}): ProjectStateSnapshot => ({
  hasPurpose: true, hasGoals: true, hasSow: true, jobKind: "standard",
  budget: 100_000, committed: 0, spent: 0, cpi: null,
  accountCount: 3, accountsPinned: 0, partyCount: 1, quoteCount: 0,
  unawardedRfqGroups: 0, pendingCostDocs: 0,
  openChangeOrders: 0, approvedCoAmount: 0,
  milestoneCount: 0, overdueMilestones: 0, spi: null, hasBaseline: false,
  checklistCount: 0, checklistOpenItems: 0, checklistNeedsEvidence: 0,
  turnoverRequired: 0, turnoverAccepted: 0, punchOpen: 0,
  intakeLinkCount: 0, membersCount: 3,
  ...over,
});
const cost = (s: ProjectStateSnapshot) => computeProjectHealth(s).parts.find((p) => p.label === "Cost")!;

describe("COST-2 — the Cost part reads commitments, not spend alone", () => {
  it("a budget fully committed with nothing spent is NOT 'all clear': it scores as 100% burned and says so", () => {
    const committed = cost(snapshot({ committed: 100_000, spent: 0, exposure: 100_000 }));
    expect(committed.score).toBe(60);
    expect(committed.detail).toBe("0% of budget spent · 100% committed · 100% committed or spent");
    // the same budget with nothing promised is all clear
    expect(cost(snapshot({ committed: 0, spent: 0, exposure: 0 })).score).toBe(100);
  });
  it("committed past the budget is over budget, and scores below any under-budget position", () => {
    const over = cost(snapshot({ committed: 90_000, spent: 30_000, exposure: 120_000 }));
    expect(over.detail).toBe("30% of budget spent · 90% committed · 120% committed or spent — over budget");
    expect(over.score).toBeCloseTo(20, 6);
    expect(over.score!).toBeLessThan(cost(snapshot({ committed: 99_000, spent: 0, exposure: 99_000 })).score!);
  });
  it("with CPI known, an over-committed budget caps the part and the detail names it", () => {
    const capped = cost(snapshot({ cpi: 1.1, committed: 130_000, spent: 10_000, exposure: 130_000 }));
    expect(capped.score).toBe(0);
    expect(capped.detail).toBe("CPI 1.10 — getting more done per dollar than planned · committed and spent run 130% of budget — over budget");
    const calm = cost(snapshot({ cpi: 1.1, committed: 50_000, spent: 10_000, exposure: 50_000 }));
    expect(calm.score).toBe(100);
    expect(calm.detail).toBe("CPI 1.10 — getting more done per dollar than planned");
  });
  it("a snapshot without exposure (an older caller) reads exactly as before", () => {
    expect(cost(snapshot({ budget: 100_000, spent: 40_000, committed: 60_000 })).detail).toBe("40% of budget spent · 60% committed");
  });
  it("the revised budget is the yardstick when there is one", () => {
    expect(cost(snapshot({ budget: 50_000, revisedBudget: 100_000, committed: 50_000, spent: 0, exposure: 50_000 })).detail)
      .toBe("0% of budget spent · 50% committed · 50% committed or spent");
  });
});

describe("SAF-9 — the contractor's notice says what was decided, and why", () => {
  it("a rejection carries the reviewer's reason and the resubmit instruction", () => {
    const m = intakeOutcomeEmail({ outcome: "rejected", company: "Gulf Mechanical", projectName: "Unit 300", document: "WPS-12 — Weld procedure", revision: "B", reason: "  Missing PQR reference.  " });
    expect(m.subject).toBe("Not accepted — resubmit: WPS-12 — Weld procedure Rev B for Unit 300");
    expect(m.text).toContain("Hello Gulf Mechanical,");
    expect(m.text).toContain("Reviewer's reason: Missing PQR reference.");
    expect(m.text).toContain("resubmit through your submission portal");
  });
  it("a rejection with no recorded reason says so (it never invents one); an approval says accepted", () => {
    const r = intakeOutcomeEmail({ outcome: "rejected", company: null, projectName: null, document: "your submission", revision: null, reason: null });
    expect(r.text).toContain("The reviewer recorded no reason with this decision");
    expect(r.text.startsWith("Hello,")).toBe(true);
    const a = intakeOutcomeEmail({ outcome: "approved", company: "Acme", projectName: "Unit 300", document: "P-101", revision: "0", reason: "ignored" });
    expect(a.subject).toBe("Accepted: P-101 Rev 0 for Unit 300");
    expect(a.text).not.toContain("ignored");
  });
});

describe("PERF-9 — the project page loads its heavy tabs when they are opened", () => {
  const page = src("app/(protected)/projects/[id]/page.tsx");
  it("the four tabs are next/dynamic (ssr off, a spinner while loading), never static imports", () => {
    for (const name of ["IntakePanel", "CostsTab", "QualityTab", "ScheduleTab"]) {
      expect(page).not.toMatch(new RegExp(`^import ${name} from`, "m"));
      expect(page).toMatch(new RegExp(`const ${name} = dynamic\\(\\(\\) => import\\("@/components/projects/${name}"\\), \\{ ssr: false, loading: tabLoading \\}\\);`));
    }
    expect(page).toMatch(/^import dynamic from "next\/dynamic";$/m);
  });
  it("inside the Schedule tab, the board, the import modal, the task panel and the calendar load on use", () => {
    const tab = src("components/projects/ScheduleTab.tsx");
    expect(tab).not.toMatch(/^import ExecutionView from/m);
    expect(tab).not.toMatch(/^import ScheduleImportModal from/m);
    expect(tab).toMatch(/const ExecutionView = dynamic\(\(\) => import\("@\/components\/projects\/ExecutionView"\)/);
    expect(tab).toMatch(/const ScheduleImportModal = dynamic\(\(\) => import\("@\/components\/projects\/ScheduleImportModal"\)/);
    const board = src("components/projects/ExecutionView.tsx");
    expect(board).not.toMatch(/^import TaskDetailPanel from/m);
    expect(board).not.toMatch(/^import ScheduleCalendarTileView from/m);
    expect(board).toMatch(/const TaskDetailPanel = dynamic\(\(\) => import\("@\/components\/projects\/TaskDetailPanel"\)/);
    expect(board).toMatch(/const ScheduleCalendarTileView = dynamic\(\(\) => import\("@\/components\/projects\/ScheduleCalendarTileView"\)/);
  });
  it("census: no file under app/ or components/ statically imports one of the lazy components (a type import is fine)", () => {
    const lazy = /^import (?!type )[^;]*from "@\/components\/projects\/(ExecutionView|TaskDetailPanel|ScheduleCalendarTileView|ScheduleImportModal|CostsTab|QualityTab|IntakePanel|ScheduleTab)";/m;
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
    });
    const hits = [...walk(join(process.cwd(), "app")), ...walk(join(process.cwd(), "components"))]
      .filter((f) => lazy.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(process.cwd().length + 1));
    expect(hits).toEqual([]);
  });
});

describe("PERF-8 — the coach takes the project row and roster the page already read", () => {
  it("the page holds the pre-read, sets it from the same load, and mounts the coach only with it", () => {
    const page = src("app/(protected)/projects/[id]/page.tsx");
    expect(page).toMatch(/const \[coachPre, setCoachPre\] = useState<SnapshotPreRead \| null>\(null\);/);
    expect(page).toMatch(/setCoachPre\(\{ project: got\.row, members: m \}\);\s*\n\s*setCoachKey\(\(k\) => k \+ 1\);/);
    expect(page).toMatch(/&& coachPre && \(/);
    expect(page).toMatch(/<ProjectCoach orgId=\{project\.orgId\} projectId=\{project\.id\} refreshKey=\{coachKey\} preRead=\{coachPre\} \/>/);
  });
  it("the coach hands its pre-read to the gather", () => {
    const coach = src("components/projects/ProjectCoach.tsx");
    expect(coach).toMatch(/preRead\?: SnapshotPreRead;/);
    expect(coach).toMatch(/gatherProjectSnapshot\(orgId, projectId, \{ signal: controller\.signal, share, pre: pre\.current \}\)/);
  });
});

describe("PERF-5 — a drag does not rebuild the axis or construct a date formatter per label", () => {
  const board = src("components/projects/ExecutionView.tsx");
  it("no per-call toLocaleDateString in the board; the three formatters are built once", () => {
    expect(board.replace(/\/\/[^\n]*/g, "")).not.toMatch(/toLocaleDateString\(/);
    expect(board).toMatch(/dayFmt \?\?= new Intl\.DateTimeFormat\(undefined, \{ month: "short", day: "numeric", timeZone: "UTC" \}\);/);
    expect(board).toMatch(/dateFmt \?\?= new Intl\.DateTimeFormat\(undefined, \{ timeZone: "UTC" \}\);/);
    expect(board).toMatch(/monthFmt \?\?= new Intl\.DateTimeFormat\(undefined, \{ month: "short", year: "2-digit", timeZone: "UTC" \}\);/);
  });
  it("the axis and the gridlines are React.memo'd", () => {
    expect(board).toMatch(/const Axis = React\.memo\(function Axis\(/);
    expect(board).toMatch(/const Gridlines = React\.memo\(function Gridlines\(/);
  });
  it("a cached formatter prints what toLocaleDateString printed", () => {
    const d = new Date(Date.UTC(2026, 9, 1));
    expect(new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(d))
      .toBe(d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }));
    expect(new Intl.DateTimeFormat(undefined, { timeZone: "UTC" }).format(d)).toBe(d.toLocaleDateString(undefined, { timeZone: "UTC" }));
    expect(new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit", timeZone: "UTC" }).format(d))
      .toBe(d.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" }));
  });
});
