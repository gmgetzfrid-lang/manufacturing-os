// lib/woPackagesCore.ts - work order packages: the shapes and the pure
// rules (no database, no browser), shared by the app and the server routes
// contractors' returns go through. The story is in lib/woPackages.ts.

import { isTypedItem, type ScopeWO } from "@/lib/woIntake";
import type { FieldPlacement } from "@/lib/packagePdf";

// ── The kit ──────────────────────────────────────────────────

export interface KitFile { path: string; name: string; pages: number; size?: number }
export interface KitForm extends KitFile {
  id: string;
  /** "Exchanger closure". */
  title: string;
  /** Equipment words it's for ("exchanger", "vessel"); empty: every package. */
  for: string[];
}
export interface PackageKit {
  cover: (KitFile & { fields?: FieldPlacement[] }) | null;
  toc: (KitFile & { region?: { x: number; y: number; w: number; h: number } }) | null;
  forms: KitForm[];
  updatedAt?: string;
  updatedBy?: string;
}
export const EMPTY_KIT: PackageKit = { cover: null, toc: null, forms: [] };

/** Equipment words offered for a form's "For" (the owner's own can be typed). */
export const EQUIPMENT_WORDS = ["Exchanger", "Vessel", "Tower", "Drum", "Heater", "Piping", "Pump", "Valve", "PSV", "Tank", "Fin fan", "Compressor"];

// ── A project's packages ─────────────────────────────────────

export type ItemKind = "form" | "drawing" | "photo" | "file";
export interface SignedCopy { path: string; pages: number; at: string; by: string; via: "app" | "link" | "scan"; mime?: string }
export interface PkgItem {
  id: string;
  kind: ItemKind;
  title: string;
  /** A kit form (its blank comes from the kit). */
  formId?: string;
  /** A drawing from the library, at the revision when it was added. */
  documentId?: string;
  libraryId?: string | null;
  versionId?: string | null;
  rev?: string | null;
  /** An uploaded photo or file (a working copy, deleted when filed). */
  path?: string;
  mime?: string;
  pages?: number;
  /** The signed form that came back, in the blank's place. */
  signed?: SignedCopy;
}
export type PackageStatus = "draft" | "approved" | "issued" | "filed";
export interface WoPackage {
  /** The equipment group's key: its first work order. */
  key: string;
  wos: string[];
  equipment: string;
  description: string;
  items: PkgItem[];
  status: PackageStatus;
  approvedBy?: string;
  approvedAt?: string;
  /** Printed for the field. */
  issuedAt?: string;
  issuedBy?: string;
  /** Filed: the finished PDF's path on the network drive. */
  filed?: { path: string; at: string; by: string; pages: number; bytes: number; how: "folder" | "download" };
  /** The working copies were deleted (after filing). */
  purgedAt?: string;
  updatedAt: string;
}
export interface ProjectPackages {
  /** The network folder filed packages go to ("\\server\TAR\Crude\Packages"). */
  folder?: string;
  packages: Record<string, WoPackage>;
}
export const EMPTY_PROJECT_PACKAGES: ProjectPackages = { packages: {} };

export const KIT_KEY = "package_kit";
export const packagesKey = (projectId: string) => `wo_packages:${projectId}`;

// ── Pure helpers ─────────────────────────────────────────────

export const newItemId = () => `it_${Math.random().toString(36).slice(2, 9)}`;

/** The words a group of work orders goes by, for matching kit forms. */
function words(group: ScopeWO[]): string {
  return group.map((x) => `${x.category} ${x.tag} ${x.equipmentName} ${x.equipment} ${x.what}`).join(" ").toLowerCase();
}

/** The kit forms this equipment gets by default: forms for every package,
 *  and forms whose equipment words appear in its group, tag or name
 *  ("Exchanger" matches an "Exchanger" group or an "E-101 ... exchanger"). */
export function formsFor(kit: PackageKit, group: ScopeWO[]): KitForm[] {
  const w = words(group);
  const tag = group.map((x) => x.tag.toUpperCase()).join(" ");
  // Common tag letters, so "E-101" finds exchanger forms without the word.
  const byTag: Record<string, RegExp> = { exchanger: /\bE-?\d/, vessel: /\bV-?\d/, drum: /\bD-?\d/, tower: /\b(T|C)-?\d/, pump: /\bP-?\d/, heater: /\bH-?\d|\bF-?\d/, tank: /\bTK-?\d/, psv: /\bPSV-?\d/ };
  return kit.forms.filter((f) => !f.for.length || f.for.some((raw) => {
    const k = raw.trim().toLowerCase();
    if (!k) return false;
    const stem = k.replace(/s$/, "");
    return w.includes(stem) || (byTag[stem]?.test(tag) ?? false);
  }));
}

/** A new package for an equipment group, drafted from the kit. */
export function draftPackage(group: ScopeWO[], kit: PackageKit, at = new Date().toISOString()): WoPackage {
  const first = group[0];
  const wos = group.filter((x) => !isTypedItem(x.wo)).map((x) => x.wo);
  return {
    key: first.wo,
    wos,
    equipment: [first.tag, first.equipmentName || first.equipment].filter(Boolean).join(" ") || first.what,
    description: [...new Set(group.map((x) => x.what))].join("; "),
    items: formsFor(kit, group).map((f) => ({ id: newItemId(), kind: "form" as const, title: f.title, formId: f.id, pages: f.pages })),
    status: "draft",
    updatedAt: at,
  };
}

/** Where a package stands, in numbers. */
export function packageStage(p: WoPackage | undefined) {
  const forms = p?.items.filter((i) => i.kind === "form") ?? [];
  return {
    built: !!p,
    approved: !!p && p.status !== "draft",
    issued: !!p && (p.status === "issued" || p.status === "filed"),
    filed: !!p?.filed,
    forms: forms.length,
    signed: forms.filter((i) => i.signed).length,
  };
}

/** Moving one item to another place in the list (drag and drop). */
export function moveItem(items: PkgItem[], from: number, to: number): PkgItem[] {
  if (from === to || from < 0 || from >= items.length) return items;
  const next = items.slice();
  const [it] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, it);
  return next;
}

/** The working copies a package keeps in storage (photos, files, signed
 *  copies): deleted once the package is filed. Kit forms and library
 *  drawings are never deleted here. */
export function workingPaths(p: WoPackage): string[] {
  return p.items.flatMap((i) => [i.kind === "photo" || i.kind === "file" ? i.path : undefined, i.signed?.path]).filter((x): x is string => !!x);
}

/** A path on the network drive: the folder and the file name, with the
 *  folder's own slashes ("\\server\TAR" or "/mnt/tar"). */
export function joinPath(folder: string, file: string): string {
  const f = folder.trim().replace(/[\\/]+$/, "");
  const sep = f.includes("\\") || /^[a-z]:/i.test(f) ? "\\" : "/";
  return f ? `${f}${sep}${file}` : file;
}

/** Storage keys (fresh each time; nothing is ever overwritten). */
const rand = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
export const kitPath = (orgId: string, ext: string) => `orgs/${orgId}/package-kit/${rand()}.${ext}`;
export const packageFilePath = (orgId: string, projectId: string, key: string, ext: string) => `orgs/${orgId}/packages/${projectId}/${encodeURIComponent(key)}/${rand()}.${ext}`;


/** Told on this page when a project's packages change (the scope list, the
 *  builder, the step card all read the same). */
export const PACKAGES_CHANGED = "wo-packages:changed";
export function sayPackagesChanged(projectId: string) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PACKAGES_CHANGED, { detail: { projectId } }));
}
