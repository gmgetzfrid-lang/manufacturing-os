// projectAccess - what someone may do on a project: its owner, a member's
// permission on it (Members: Co-owner, Editor, Viewer), or their role in
// the organization. One rule for the whole project page.
//
//   Owner / Co-owner  everything: Setup, import or clear the schedule,
//                     members and their permissions, the project's status.
//                     (Deleting the project and handing over ownership
//                     stay with the owner.)
//   Editor            the work: progress, work orders, moving and adding
//                     work, shift notes and meetings, Lock report.
//   Viewer            reads.
//
// The database keeps the stored names: co_owner, collaborator (Editor),
// observer (Viewer).

import type { ProjectMemberRole } from "@/types/schema";

export const MEMBER_ROLES: Array<{ role: Exclude<ProjectMemberRole, "owner">; label: string; help: string }> = [
  { role: "co_owner", label: "Co-owner", help: "Everything the owner can do: Setup, the schedule, members and their permissions" },
  { role: "collaborator", label: "Editor", help: "Updates the work: progress, work orders, the schedule, shift notes and meetings" },
  { role: "observer", label: "Viewer", help: "Reads only" },
];

export const roleLabel = (r: ProjectMemberRole | string | null | undefined): string =>
  r === "owner" ? "Owner" : MEMBER_ROLES.find((x) => x.role === r)?.label ?? "Viewer";

/** Org roles that may work any project's schedule. */
const ORG_EDIT = ["Admin", "Manager", "Supervisor", "DocCtrl"];
/** Org roles that may manage any project. */
const ORG_MANAGE = ["Admin", "DocCtrl"];

export function projectAccess(o: {
  isOwner: boolean;
  /** Their permission on the project (none: not a member). */
  memberRole?: ProjectMemberRole | string | null;
  /** Their roles in the organization (headline and additional). */
  orgRoles?: Array<string | null | undefined>;
}): { canEdit: boolean; canManage: boolean } {
  const org = (o.orgRoles ?? []).filter((x): x is string => !!x);
  const manage = o.isOwner || o.memberRole === "owner" || o.memberRole === "co_owner" || org.some((r) => ORG_MANAGE.includes(r));
  const edit = manage || o.memberRole === "collaborator" || org.some((r) => ORG_EDIT.includes(r));
  return { canEdit: edit, canManage: manage };
}

/** The database hasn't been given the co-owner permission yet. */
export const needsCoOwnerSql = (message: string) => /project_members_role_check|violates check constraint/i.test(message);
