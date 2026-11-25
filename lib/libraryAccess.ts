// lib/libraryAccess.ts - a library's access: the default a new library
// gets (never no rules: in this app a library with no rules lets every
// member add and change files), and the access in words for the screens
// that make or fill a library. Pure.

import type { AccessControl, AccessRule } from "@/types/schema";

const CONTROLLERS = ["Admin", "DocCtrl"];
const WRITE_ACTIONS: AccessRule["actions"] = ["upload", "createFolder", "editMetadata", "write", "download", "read", "discover"];

/** A new library's access when none is copied: the library wizard's default
 *  (everyone in the workspace sees it; Admin and Document Control add,
 *  change and manage it). Never no rules at all: in this app a library with
 *  no rules lets every member add and change files. */
export function defaultLibraryAccess(orgId: string) {
  const rules: AccessRule[] = [
    { effect: "allow", subject: { type: "org", id: orgId }, actions: ["discover", "read", "download"] },
    ...CONTROLLERS.map((r): AccessRule => ({ effect: "allow", subject: { type: "role", id: r }, actions: WRITE_ACTIONS })),
    ...CONTROLLERS.map((r): AccessRule => ({ effect: "allow", subject: { type: "role", id: r }, actions: ["admin", "managePermissions"] })),
  ];
  const acl: AccessControl = { inherit: true, visibility: "normal", rules };
  return {
    type: "Engineering",
    custom_columns: [
      { key: "document_number", label: "Document number", type: "text", searchable: true, required: true, visible: true },
      { key: "rev", label: "Revision", type: "text", searchable: true, required: true, visible: true },
      { key: "title", label: "Title", type: "text", searchable: true, required: true, visible: true },
      { key: "status", label: "Status", type: "text", searchable: true, required: false, visible: true },
    ],
    write_access: CONTROLLERS, admin_access: CONTROLLERS, read_access: "ALL", visible_to: [],
    folder_security: "Inherited", default_new_visibility: "normal", default_new_acl: acl, acl,
  };
}

const roleWord = (r: string) => (r === "DocCtrl" ? "Document Control" : r);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** A library's access in words: who sees it, who adds to it. Admin and
 *  Document Control always can (the app lets them everywhere). */
export function accessWords(acl: AccessControl | null | undefined): { view: string; add: string; open: boolean } {
  const rules = (acl?.rules ?? []).filter((r) => r.effect === "allow");
  if (!rules.length) return { view: "Everyone in the workspace", add: "everyone in the workspace", open: true };
  const roles = (act: AccessRule["actions"][number]) => [...new Set([...CONTROLLERS, ...rules.filter((r) => r.subject.type === "role" && r.actions.includes(act)).map((r) => String(r.subject.id))])];
  const everyone = (act: AccessRule["actions"][number]) => rules.some((r) => r.subject.type === "org" && r.actions.includes(act));
  const people = (act: AccessRule["actions"][number]) => rules.some((r) => (r.subject.type === "user" || r.subject.type === "team") && r.actions.includes(act));
  const say = (act: AccessRule["actions"][number]) => everyone(act) ? "everyone in the workspace" : `${list(roles(act).map(roleWord))}${people(act) ? " and people named on it" : ""}`;
  const view = say("read");
  return { view: view[0].toUpperCase() + view.slice(1), add: say("upload"), open: everyone("upload") };
}
