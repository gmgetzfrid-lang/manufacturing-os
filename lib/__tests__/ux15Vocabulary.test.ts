// projects Round G — J10, UX-15. One word per concept on the Projects
// surface: "contractor" for the company on a project (never the schema word
// "party"), one kind list, "task" for the schedule row (with sub-task /
// phase / milestone each meaning one thing), one word per kind of "no longer
// counts", the four exports told apart, and a Costs glossary that defines
// exactly what the tab shows.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/supabase", () => {
  const chain = (): unknown => new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: "no database in this test" } });
      return () => chain();
    },
  });
  return { supabase: { from: () => chain() } };
});
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => undefined) }));

import {
  COMPANY_KINDS, COMPANY_KIND_LABEL, CONTRACTOR_TERM, VOID_TERM, SCHEDULE_TERMS, TURNOVER_STATUS_MEANING,
} from "@/lib/projectVocabulary";
import { COMPANY_KIND_LABEL as REGISTRY_KIND_LABEL } from "@/lib/companies";
import { COST_GLOSSARY_TERMS } from "@/components/projects/cost/CostCharts";
import { saveParty } from "@/lib/costs";
import { SNAPSHOT_READS } from "@/lib/projectHealth";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** The text a user can read in a source file: string literals and JSX text,
 *  with comments removed. Identifiers (party_id, partyId, project_parties)
 *  never match a whole-word search. */
function userText(p: string): string[] {
  const code = src(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
    .replace(/^\s*(import\b[^;]*;|\} from "[^"]*";)\s*$/gm, "");
  const out: string[] = [];
  for (const m of code.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)) out.push(m[0].slice(1, -1));
  // JSX text: after a tag's closing ">" (an attribute quote, an expression's
  // brace or a tag name) — never an arrow's "=>" or a generic's "]>".
  for (const m of code.matchAll(/["}A-Za-z0-9]>([^<>{}]+)</g)) {
    // a generic call (useState<string>("…")) or code between two template
    // literals is not text
    if (/^\s*\(/.test(m[1]) || /\n\s*(const|let|var|return|if|for)\b/.test(m[1])) continue;
    out.push(m[1]);
  }
  // A bare lower-case identifier ("parties", "milestone") is a key, not text;
  // inside a template literal, property access and field names are code.
  return out
    .filter((t) => !/^[a-z_][A-Za-z0-9_]*$/.test(t.trim()))
    .map((t) => t.replace(/\$\{[^{}]*\}/g, " ").replace(/\.\s*[A-Za-z_]\w*/g, " ").replace(/\b[A-Za-z_]\w*\??:\s+(Array|number|string)\b/g, " "));
}

const PROJECTS_SURFACE = [
  "components/projects/CostsTab.tsx",
  "components/projects/cost/QuotesPanel.tsx",
  "components/projects/cost/ChangeOrdersPanel.tsx",
  "components/projects/cost/CostCharts.tsx",
  "components/projects/ProjectWizard.tsx",
  "components/projects/QualityTab.tsx",
  "app/(protected)/projects/[id]/page.tsx",
  "app/(protected)/companies/page.tsx",
  "app/(protected)/companies/[id]/page.tsx",
  "lib/costs.ts",
  "lib/companyScore.ts",
  "lib/projectReport.ts",
  "lib/projectHealth.ts",
  "lib/projects.ts",
  "lib/projectWizardWrites.ts",
];

describe("UX-15 — the company on a project is a contractor; 'party' never reaches the screen", () => {
  it("no user-facing string on the Projects surface says party / parties", () => {
    const hits: string[] = [];
    for (const f of PROJECTS_SURFACE) {
      for (const t of userText(f)) if (/\bpart(y|ies)\b/i.test(t)) hits.push(`${f}: ${t.trim().slice(0, 100)}`);
    }
    expect(hits).toEqual([]);
  });

  it("the required-name refusal and the list heading say contractor", async () => {
    const r = await saveParty({ orgId: "o1", projectId: "p1", patch: { name: "  " }, actor: { uid: "u1", email: null } });
    expect(r).toEqual({ ok: false, error: "Contractor name is required." });
    expect(src("components/projects/CostsTab.tsx")).toMatch(/>Contractors<\/span>/);
    expect(src("components/projects/ProjectWizard.tsx")).toContain('{ key: "team", label: "Contractors", icon: HardHat }');
    expect(SNAPSHOT_READS.parties).toBe("contractors");
  });

  it("one kind list everywhere — the Costs panel offers rental like the wizard and the registry", () => {
    expect([...COMPANY_KINDS]).toEqual(["contractor", "vendor", "rental", "internal"]);
    expect(Object.keys(COMPANY_KIND_LABEL)).toEqual([...COMPANY_KINDS]);
    expect(REGISTRY_KIND_LABEL).toBe(COMPANY_KIND_LABEL);
    for (const f of ["components/projects/CostsTab.tsx", "components/projects/ProjectWizard.tsx"]) {
      const s = src(f);
      expect(s).toContain("COMPANY_KINDS.map((k) => <option key={k} value={k}>{COMPANY_KIND_LABEL[k]}</option>)");
      expect(s).not.toMatch(/<option value="(contractor|vendor|internal)">/);
      expect(s).not.toMatch(/\["contractor", "vendor"/);
    }
    expect(src("app/(protected)/companies/page.tsx")).toContain('const KIND_FILTERS = ["all", ...COMPANY_KINDS] as const;');
  });
});

describe("UX-15 — the schedule row is a task, and the legend agrees", () => {
  it("the Schedule tab, the import count, the wizard and the report call the row a task", () => {
    const hits: string[] = [];
    for (const f of ["components/projects/ScheduleTab.tsx", "components/projects/ScheduleImportModal.tsx", "components/projects/ProjectWizard.tsx", "components/projects/TaskDetailPanel.tsx", "components/projects/ScheduleCalendarTileView.tsx", "components/projects/ExecutionGuide.tsx"]) {
      for (const t of userText(f)) {
        if (/^milestones?-?$/.test(t.trim())) continue; // the table, realtime channel and attribute key names
        const wizardStep = f.endsWith("ProjectWizard.tsx"); // "this step" there is a wizard step
        if (/\bmilestones?\b|\bsub-?(step|item)s?\b/i.test(t) || (!wizardStep && /\bthis step\b/i.test(t))) hits.push(`${f}: ${t.trim().slice(0, 100)}`);
      }
    }
    expect(hits).toEqual([]);
    const tab = src("components/projects/ScheduleTab.tsx");
    expect(tab).toContain('text-sm">Tasks</div>');
    expect(tab).toContain("<Plus className=\"w-3.5 h-3.5\" /> Add task");
    expect(tab).toContain('title="Delete task"');
  });

  it("the Execution legend's milestone is a kind of task (a diamond), not the name of every row", () => {
    const ev = src("components/projects/ExecutionView.tsx");
    expect(ev).toContain("</span> Task (fill = % done)");
    expect(ev).toContain('title="A milestone — a task with no duration: a single date the schedule marks (shown as a diamond, never a bar)"');
    expect(ev).toContain("</span> Phase (rolls up sub-tasks)");
    expect(ev).not.toContain("A milestone — a zero-duration marker");
    expect(SCHEDULE_TERMS.map((t) => t.term)).toEqual(["Task", "Sub-task", "Phase", "Milestone"]);
    expect(SNAPSHOT_READS.milestones).toBe("schedule tasks");
  });
});

describe("UX-15 — one word per kind of 'no longer counts', each said where it is used", () => {
  it("Void (money) names the Quality tab's Not applicable and Waived, so the three are told apart", () => {
    expect(VOID_TERM.plain).toMatch(/Not applicable/);
    expect(VOID_TERM.plain).toMatch(/Waived/);
    const quality = src("components/projects/QualityTab.tsx");
    expect(quality).toContain("<b>Waived</b> — {TURNOVER_STATUS_MEANING.waived}");
    expect(TURNOVER_STATUS_MEANING.waived).toMatch(/goes without it/);
    // The quote that lost is "not selected" — the old "declined" is gone from the screen.
    expect(userText("components/projects/cost/QuotesPanel.tsx").filter((t) => /\bdeclined\b/i.test(t) && !/^declined$/.test(t.trim()))).toEqual([]);
  });

  it("money posts 'as actual' — never 'as spend'", () => {
    for (const f of ["components/projects/cost/QuotesPanel.tsx", "lib/projectHealth.ts"]) {
      expect(userText(f).filter((t) => /post(ed|s)? as (actual )?spend/i.test(t))).toEqual([]);
    }
  });
});

describe("UX-15 — the four exports are told apart where they sit", () => {
  it("a labelled note explains Export CSV, Evidence pack, Report and Lessons learned", () => {
    const page = src("app/(protected)/projects/[id]/page.tsx");
    const at = page.indexOf('<HelpTooltip label="What each export contains"');
    expect(at).toBeGreaterThan(0);
    const note = page.slice(at, page.indexOf("</HelpTooltip>", at));
    for (const b of ["Export CSV", "Evidence pack", "Report", "Lessons learned"]) expect(note).toContain(`${b}</b> —`);
  });
});

describe("UX-15 — the Costs glossary covers the terms on screen, and only those", () => {
  const terms = COST_GLOSSARY_TERMS.map((t) => t.term);

  it("adds the terms the tab shows and the old glossary missed", () => {
    for (const t of ["Value score", "Not stated", "check:", "excludes:", "% burned", "Peak crew", "Pinned (to a schedule task)", "Reason code", "Contractor", "Bidder", "Void", "Not selected", "Exposure", "Revised budget", "Unspent (actuals only)"]) {
      expect(terms).toContain(t);
    }
    expect(COST_GLOSSARY_TERMS.find((t) => t.term === "RFQ group")!.plain).toContain("Request For Quotation");
    expect(COST_GLOSSARY_TERMS).toContainEqual(CONTRACTOR_TERM);
  });

  it("names things as the screen does, and drops what the tab never shows", () => {
    expect(terms).toContain("Spend curve");
    expect(terms).toContain("Price / hr");
    for (const gone of ["S-curve", "$/labor-hour", "SPI"]) expect(terms).not.toContain(gone);
  });

  it("every term is on the tab — each one's word appears in the Costs sources outside the glossary itself", () => {
    const screen = ["components/projects/CostsTab.tsx", "components/projects/cost/QuotesPanel.tsx", "components/projects/cost/ChangeOrdersPanel.tsx", "components/projects/cost/CostCharts.tsx", "lib/costDocs.ts", "lib/costs.ts"]
      .map((f) => src(f).split("\n").filter((l) => !/^\s*\{ term: "/.test(l)).join("\n"))
      .join("\n").toLowerCase();
    const token: Record<string, string> = {
      "Earned value (EV)": "earned value (ev)",
      "EAC / forecast": "data-forecast",
      "Pinned (to a schedule task)": "pinned",
      "RFQ group": "rfq group",
      "Change order (CO)": "change order",
      "Available (uncommitted)": "uncommitted (budget − spent − open commitments)",
    };
    const missing = terms.filter((t) => !screen.includes((token[t] ?? t).toLowerCase()));
    expect(missing).toEqual([]);
  });
});
