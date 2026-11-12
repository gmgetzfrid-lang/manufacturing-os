// eventOrganization - the roles an event needs and who fills each one,
// kept with the project (projects.shift_times.organization). The list starts
// from the organization a turnaround is run with; a project changes it to
// its own: add, rename or remove roles, say which are required, and name a
// person for each. The post-event review reads it: a required role with no
// name is a finding, and one with a name is no longer "not assigned".

import { supabase } from "@/lib/supabase";
import { noEmDash } from "@/lib/noEmDash";
import type { OrgStanding } from "@/lib/postEventReview";

export interface OrgRole { id: string; role: string; does: string; person: string; required: boolean }

const D = (id: string, role: string, does: string, required: boolean): OrgRole => ({ id, role, does, person: "", required });
/** Where every project starts. */
export const defaultRoles = (): OrgRole[] => [
  D("manager", "Turnaround manager", "Single point of responsibility for preparation, execution and close-out", true),
  D("planning", "Preparation and planning coordinator", "Scope validation and freeze, task packages, the schedule", true),
  D("logistics", "Logistics and materials coordinator", "Materials register, expediting, off-site repairs, deliveries", true),
  D("area", "Area coordinator", "Daily control against the critical path; balances crews across the area", true),
  D("hse", "HSE lead", "Permits, gas testing, safe system of work", true),
  D("inspection", "Inspection and QA/QC lead", "Inspection and acceptance of the work", true),
  D("operations", "Operations liaison", "Decontamination, isolation, hand-over and start-up", true),
  D("steering", "Steering group chair", "Objectives, funding and scope policy; approves late scope", false),
  D("mechanical", "Mechanical supervisor", "Exchangers, vessels, piping", false),
  D("cleaning", "Cleaning supervisor", "Hydroblasting and chemical cleaning", false),
  D("valves", "Valves and instruments coordinator", "Control valves, relief valves, meters; everything sent off site", false),
  D("bulk", "Bulk services supervisor", "Scaffold, insulation, cranes", false),
];

const text = (v: unknown, max: number) => (typeof v === "string" ? noEmDash(v).slice(0, max) : "");
/** A saved organization as it is read back. `null`: none was ever saved. */
export function cleanOrg(v: unknown): OrgRole[] | null {
  if (!v || typeof v !== "object" || !Array.isArray((v as { roles?: unknown }).roles)) return null;
  const out: OrgRole[] = [];
  for (const x of (v as { roles: unknown[] }).roles) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    const role = text(r.role, 120).trim();
    if (!role || typeof r.id !== "string") continue;
    out.push({ id: r.id, role, does: text(r.does, 300).trim(), person: text(r.person, 120).trim(), required: r.required === true });
  }
  return out;
}

/** How it stands: the required roles, and which have no name. */
export function orgStanding(roles: OrgRole[] | null): OrgStanding {
  const list = roles ?? [];
  const req = list.filter((r) => r.required);
  return {
    recorded: roles != null,
    required: req.length, filled: req.filter((r) => r.person.trim()).length,
    missing: req.filter((r) => !r.person.trim()).map((r) => r.role),
    roles: list.map((r) => ({ role: r.role, person: r.person.trim(), does: r.does, required: r.required })),
  };
}

export async function loadOrg(projectId: string): Promise<OrgRole[] | null> {
  const { data, error } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  if (error) throw new Error(error.message);
  return cleanOrg(((data as { shift_times?: Record<string, unknown> | null } | null)?.shift_times ?? {}).organization);
}

export const ORG_CHANGED = "event-organization:changed";
export async function saveOrg(projectId: string, roles: OrgRole[], actor: { name: string | null }): Promise<OrgRole[]> {
  const { data: cur, error: readErr } = await supabase.from("projects").select("shift_times").eq("id", projectId).maybeSingle();
  if (readErr) throw new Error(readErr.message);
  const st = { ...(((cur as { shift_times?: Record<string, unknown> | null } | null)?.shift_times) ?? {}) };
  const clean = cleanOrg({ roles }) ?? [];
  st.organization = { roles: clean, savedAt: Date.now(), savedBy: actor.name };
  const { data, error } = await supabase.from("projects").update({ shift_times: st }).eq("id", projectId).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("Not saved - only the project's owner, a co-owner, an editor or an admin can change this.");
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(ORG_CHANGED, { detail: { projectId } }));
  return clean;
}
