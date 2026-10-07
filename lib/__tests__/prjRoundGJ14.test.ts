// projects Round G — projects-joint J14 PROJECTS FOLLOW-UPS: the pins that
// are plain source or pure-function checks (the rendered and route tests
// sit beside the surfaces they drive).
//
//   REL-9 done-when 3 — the remaining dead declarations: `trend` (a literal
//   "steady" reserved field nobody rendered) is gone from ProjectHealth;
//   `setup_state` is KEPT by decision, with its reader recorded (the
//   workspace export / restore carry the projects row whole). The other two
//   (`equipmentTags`, `addEvidence`) are pinned in checklists.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeProjectHealth, type ProjectStateSnapshot } from "@/lib/projectHealth";

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
