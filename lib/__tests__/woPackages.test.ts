import { describe, it, expect, beforeAll } from "vitest";
import { coverPhotos, draftPackage, formsFor, joinPath, moveItem, packageStage, pageItems, workingPaths, type PackageKit, type PkgItem, type WoPackage } from "@/lib/woPackagesCore";
import type { ScopeWO } from "@/lib/woIntake";

const wo = (o: Partial<ScopeWO>): ScopeWO => ({ wo: "400101", what: "Pull and clean bundle", equipment: "E-101", tag: "E-101", equipmentName: "Overhead Exchanger", category: "Exchanger", notes: "", conditional: false, drafted: false, approved: false, ...o });
const kit: PackageKit = {
  cover: null, toc: null,
  forms: [
    { id: "f1", title: "Flange log", path: "k/1.pdf", name: "1.pdf", pages: 1, for: [] },
    { id: "f2", title: "Exchanger closure", path: "k/2.pdf", name: "2.pdf", pages: 2, for: ["Exchanger"] },
    { id: "f3", title: "Vessel closure", path: "k/3.pdf", name: "3.pdf", pages: 1, for: ["Vessel", "Drum"] },
    { id: "f4", title: "Hydro test sheet", path: "k/4.pdf", name: "4.pdf", pages: 1, for: ["exchangers", "Piping"] },
  ],
};

describe("work order packages: the kit's forms for each equipment", () => {
  it("every-package forms, plus those whose equipment word or tag letter matches", () => {
    expect(formsFor(kit, [wo({})]).map((f) => f.title)).toEqual(["Flange log", "Exchanger closure", "Hydro test sheet"]);
    // No word in the group, but the tag says it: V-12 is a vessel.
    expect(formsFor(kit, [wo({ tag: "V-12", equipmentName: "Accumulator", category: "Other", what: "Open and inspect" })]).map((f) => f.title)).toEqual(["Flange log", "Vessel closure"]);
    expect(formsFor(kit, [wo({ tag: "", equipmentName: "", category: "Piping", what: "Replace spool" })]).map((f) => f.title)).toEqual(["Flange log", "Hydro test sheet"]);
  });
  it("a package drafted for an equipment group carries its WOs, name and forms", () => {
    const p = draftPackage([wo({}), wo({ wo: "400102", what: "Hydro test" })], kit, "2027-01-01T00:00:00Z");
    expect(p).toMatchObject({ key: "400101", wos: ["400101", "400102"], equipment: "E-101 Overhead Exchanger", description: "Pull and clean bundle; Hydro test", status: "draft" });
    expect(p.items.map((i) => i.title)).toEqual(["Flange log", "Exchanger closure", "Hydro test sheet"]);
    expect(new Set(p.items.map((i) => i.id)).size).toBe(3);
  });
});

describe("work order packages: order, stage, working copies, paths", () => {
  const base: WoPackage = { key: "400101", wos: ["400101"], equipment: "E-101", description: "", status: "issued", updatedAt: "",
    items: [
      { id: "a", kind: "form", title: "A", formId: "f1", signed: { path: "s/a.pdf", pages: 1, at: "", by: "", via: "link" } },
      { id: "b", kind: "form", title: "B", formId: "f2" },
      { id: "c", kind: "photo", title: "C", path: "p/c.jpg" },
      { id: "d", kind: "drawing", title: "D", documentId: "doc1" },
    ] };
  it("moves an item and keeps the rest in order", () => {
    expect(moveItem(base.items, 0, 2).map((i) => i.id)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(base.items, 3, 0).map((i) => i.id)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(base.items, 1, 1)).toBe(base.items);
  });
  it("counts signed forms; working copies are photos, files and signed scans, never kit forms or drawings", () => {
    expect(packageStage(base)).toMatchObject({ forms: 2, signed: 1, issued: true, filed: false });
    expect(workingPaths(base).sort()).toEqual(["p/c.jpg", "s/a.pdf"]);
  });
  it("joins a network folder and a file name with the folder's own slashes", () => {
    expect(joinPath("\\\\kern-fs01\\TAR\\Crude\\", "WO 400101 - E-101.pdf")).toBe("\\\\kern-fs01\\TAR\\Crude\\WO 400101 - E-101.pdf");
    expect(joinPath("P:\\Packages", "x.pdf")).toBe("P:\\Packages\\x.pdf");
    expect(joinPath("/mnt/tar/", "x.pdf")).toBe("/mnt/tar/x.pdf");
  });
});

describe("work order packages: the cover's QR code", () => {
  beforeAll(() => { process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key"; });
  it("a code printed before the package-code secret was set still opens; new ones use the secret", async () => {
    const { packageCode, readPackageCode } = await import("@/lib/packageReturnsServer");
    const link = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const old = packageCode(link, "400101");
    process.env.PACKAGE_CODE_SECRET = "a-long-random-secret";
    try {
      const fresh = packageCode(link, "400101");
      expect(fresh).not.toBe(old);
      expect(readPackageCode(old)).toEqual({ linkId: link, key: "400101" });
      expect(readPackageCode(fresh)).toEqual({ linkId: link, key: "400101" });
      // The database key rotated: codes signed with the secret still open.
      process.env.SUPABASE_SERVICE_ROLE_KEY = "rotated";
      expect(readPackageCode(fresh)).toEqual({ linkId: link, key: "400101" });
    } finally { delete process.env.PACKAGE_CODE_SECRET; process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key"; }
  });
  it("opens its own package only, and a changed code is refused", async () => {
    const { packageCode, readPackageCode, visiblePackages } = await import("@/lib/packageReturnsServer");
    const link = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const code = packageCode(link, "400101");
    expect(readPackageCode(code)).toEqual({ linkId: link, key: "400101" });
    // Another package's key with the same signature: refused.
    const [id, , sig] = code.split(".");
    const other = `${id}.${Buffer.from("400102").toString("base64").replace(/=+$/, "")}.${sig}`;
    expect(readPackageCode(other)).toBeNull();
    expect(readPackageCode("nonsense")).toBeNull();
    const all = { packages: {
      a: { key: "a", status: "draft" }, b: { key: "b", status: "approved" }, c: { key: "c", status: "issued" }, d: { key: "d", status: "filed" },
    } } as unknown as Parameters<typeof visiblePackages>[0];
    expect(visiblePackages(all, "c").map((p) => p.key)).toEqual(["c"]);
    expect(visiblePackages(all, "d")).toEqual([]);
    expect(visiblePackages(all, null).map((p) => p.key).sort()).toEqual(["b", "c"]);
  });
});

describe("photos on the cover", () => {
  const photo = (id: string, extra: Partial<PkgItem> = {}): PkgItem => ({ id, kind: "photo", title: id, path: `orgs/o/p/${id}.jpg`, mime: "image/jpeg", pages: 1, ...extra });
  it("two at most go on the cover, and they don't print as pages", () => {
    const items = [photo("a", { cover: true }), { id: "f", kind: "form", title: "Flange log", formId: "k1" } as PkgItem, photo("b", { cover: true }), photo("c", { cover: true }), photo("d")];
    expect(coverPhotos(items).map((i) => i.id)).toEqual(["a", "b"]);
    expect(pageItems(items).map((i) => i.id)).toEqual(["f", "c", "d"]);
  });
  it("a photo borrowed from the registry is never deleted with the package", () => {
    const pkg = { key: "1", wos: ["1"], equipment: "X-2", description: "", status: "filed", items: [photo("a", { cover: true, shared: true, path: "orgs/o/assets/x/photos/1.jpg" }), photo("b", { cover: true })] } as WoPackage;
    expect(workingPaths(pkg)).toEqual(["orgs/o/p/b.jpg"]);
  });
});
