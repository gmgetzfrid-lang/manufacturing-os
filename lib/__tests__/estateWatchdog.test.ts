// The watchdog is the part that notices "Dave's stuff / OC74321 … crude
// P&ID" and says where crude P&IDs live. It must be right about the home,
// quiet when there is nothing to go on, and quiet when the file is already
// somewhere that fits.

import { describe, it, expect } from "vitest";
import { suggestHome, type HomeFolder } from "@/lib/estate/watchdog";
import type { ResolveContext } from "@/lib/estate/resolver";

const ctx: ResolveContext = {
  units: [{ code: "20", label: "Crude Unit" }, { code: "45", label: "Transmix" }],
  aliases: [], projects: [], assets: new Map(),
  unitFromDrawingNumber: (raw) => (/^2002-/.test(raw) ? "20" : /^4502-/.test(raw) ? "45" : null),
  folderUnits: new Map(), folderProjects: new Map(),
};
// Chains are folder names only; the library name is carried separately.
const folders: HomeFolder[] = [
  { id: "pids", libraryId: "L", libraryName: "Drawings", chain: ["P&IDs"], chainIds: ["pids"] },
  { id: "pids20", libraryId: "L", libraryName: "Drawings", chain: ["P&IDs", "20 - Crude"], chainIds: ["pids", "pids20"], unitCode: "20" },
  { id: "pids45", libraryId: "L", libraryName: "Drawings", chain: ["P&IDs", "45 - Transmix"], chainIds: ["pids", "pids45"], unitCode: "45" },
  { id: "dave", libraryId: "L", libraryName: "Drawings", chain: ["Dave's stuff"], chainIds: ["dave"] },
  { id: "iso20", libraryId: "L", libraryName: "Drawings", chain: ["Isometrics", "20 - Crude"], chainIds: ["isos", "iso20"], unitCode: "20" },
];

describe("suggestHome", () => {
  it("sends a crude P&ID dropped in Dave's folder to the crude P&ID folder, with the reason", () => {
    const s = suggestHome({ kind: "document", id: "x", name: "2002-D-2001_SHT07 PID.pdf", documentNumber: "2002-D-2001", pathIds: ["dave"], libraryId: "L" }, folders, ctx);
    expect(s?.home.id).toBe("pids20");
    expect(s?.alreadyHome).toBe(false);
    expect(s?.reason).toMatch(/looks like a P&ID for Crude Unit; Drawings \/ P&IDs \/ 20 - Crude is where those live/);
  });
  it("is quiet when the file is already home", () => {
    const s = suggestHome({ kind: "document", id: "x", name: "2002-D-2001_SHT07 PID.pdf", documentNumber: "2002-D-2001", pathIds: ["pids", "pids20"], libraryId: "L" }, folders, ctx);
    expect(s?.alreadyHome).toBe(true);
  });
  it("never suggests another unit's folder", () => {
    const s = suggestHome({ kind: "document", id: "x", name: "4502-D-0001 PID.pdf", documentNumber: "4502-D-0001", pathIds: ["dave"], libraryId: "L" }, folders, ctx);
    expect(s?.home.id).toBe("pids45");
  });
  it("is silent when there is nothing to go on", () => {
    expect(suggestHome({ kind: "document", id: "x", name: "scan0001.pdf", pathIds: ["dave"], libraryId: "L" }, folders, ctx)).toBeNull();
  });
  it("uses the unit alone when the type is unknown", () => {
    const s = suggestHome({ kind: "folder", id: "f", name: "Crude heater job", pathIds: [], libraryId: "L" }, folders, ctx);
    expect(s?.unitCode).toBe("20");
    expect(["pids20", "iso20"]).toContain(s?.home.id);
  });
});
