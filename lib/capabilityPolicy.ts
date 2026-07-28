// lib/capabilityPolicy.ts
//
// THE CAPABILITY POLICY LAYER — org-configurable "who may perform which
// action" for the parts of the app that aren't content (content permissions
// live on each node's ACL). Covers every drafting-request workflow
// transition plus holds, force-release, and admin surfaces.
//
// Design contract:
//   * DEFAULTS exactly reproduce the historical hardcoded behavior — an org
//     that never edits the policy sees zero change.
//   * The policy maps capability id -> allowed role tokens. Tokens are role
//     names, plus "Engineer" (matches every Engineer-N tier — the tiers were
//     never enforced anywhere and remain a labeling convention) and "*"
//     (every active member).
//   * IDENTITY-based rights are NOT configurable by design: a ticket's
//     requester, assigned drafter, and assigned engineer always keep their
//     own-ticket actions. Policy governs ROLE-based authority only.
//   * Enforced where it matters: the workflow-action API route re-derives
//     actions server-side with the org's policy, so a tampered client
//     changes nothing.
//   * Saves are guardrailed (critical capabilities must keep Admin) and
//     audited with before/after.

import { supabase } from "@/lib/supabase";

export type CapabilityId =
  | "ticket.manage"            // management override tier (approve anywhere, force close)
  | "ticket.initial_review"
  | "ticket.eng_review"
  | "ticket.assign"
  | "ticket.self_assign"
  | "ticket.draft_work"
  | "ticket.requester_review"
  | "ticket.direct_approve"
  | "ticket.final_approve"
  | "ticket.reopen"
  | "ticket.force_close"
  | "ticket.reassign_engineer"
  | "holds.open"
  | "holds.release"
  | "checkout.force_release"
  | "admin.analytics_view"
  | "admin.archive_view";

export interface CapabilityDef {
  id: CapabilityId;
  area: string;
  label: string;
  description: string;
  defaultRoles: string[];
  /** Admin can never be removed from a critical capability. */
  critical?: boolean;
}

const MGMT = ["Admin", "Manager", "Supervisor"];

export const CAPABILITY_DEFS: CapabilityDef[] = [
  { id: "ticket.manage", area: "Requests", label: "Management override", critical: true,
    description: "The management tier: co-approve at any review stage, override assigned reviewers, force-close.",
    defaultRoles: MGMT },
  { id: "ticket.initial_review", area: "Requests", label: "Initial review (approve / flag / reject)",
    description: "Act on brand-new requests before assignment.", defaultRoles: [...MGMT, "Engineer"] },
  { id: "ticket.eng_review", area: "Requests", label: "Engineering scope review",
    description: "Complete an engineering review when no specific engineer is assigned (the assigned engineer always can).",
    defaultRoles: ["Engineer"] },
  { id: "ticket.assign", area: "Requests", label: "Assign drafters",
    description: "Run the assignment queue.", defaultRoles: [...MGMT, "DraftingSupervisor"] },
  { id: "ticket.self_assign", area: "Requests", label: "Self-assign drafting work",
    description: "Pick up unassigned tickets from the queue.", defaultRoles: ["Drafter"] },
  { id: "ticket.draft_work", area: "Requests", label: "Do drafting work",
    description: "Save progress, submit drafts, issue IFC (the assigned drafter always can).", defaultRoles: ["Drafter"] },
  { id: "ticket.requester_review", area: "Requests", label: "Requester review",
    description: "Review returned drafts as a requester (the ticket's own requester always can).", defaultRoles: ["Requester"] },
  { id: "ticket.direct_approve", area: "Requests", label: "Direct engineering approval",
    description: "Approve a draft to IFC without being the requester.", defaultRoles: ["Engineer"] },
  { id: "ticket.final_approve", area: "Requests", label: "Final engineering approval",
    description: "Sign off at the final-approval stage when unassigned (the assigned engineer always can).",
    defaultRoles: ["Engineer"] },
  { id: "ticket.reopen", area: "Requests", label: "Reopen closed tickets",
    description: "Resurrect a closed ticket (its requester always can).", defaultRoles: MGMT },
  { id: "ticket.force_close", area: "Requests", label: "Force close", critical: true,
    description: "Close a ticket from any state.", defaultRoles: MGMT },
  { id: "ticket.reassign_engineer", area: "Requests", label: "Reassign engineer reviewer", critical: true,
    description: "Swap the assigned engineer at final approval.", defaultRoles: ["Admin"] },
  { id: "holds.open", area: "Holds", label: "Place a hold",
    description: "Open a do-not-advance hold on a document.", defaultRoles: ["*"] },
  { id: "holds.release", area: "Holds", label: "Release a hold",
    description: "Release an open hold.", defaultRoles: ["*"] },
  { id: "checkout.force_release", area: "Checkouts", label: "Force-release a checkout", critical: true,
    description: "Release another user's active checkout. Note: the database additionally enforces an Admin/DocCtrl floor — this toggle can narrow but not widen it.",
    defaultRoles: ["Admin", "DocCtrl"] },
  { id: "admin.analytics_view", area: "Metrics", label: "Analytics dashboards",
    description: "Open /admin/analytics.", defaultRoles: [...MGMT, "DocCtrl"] },
  { id: "admin.archive_view", area: "Metrics", label: "Archive browser",
    description: "Open /admin/archive-view.", defaultRoles: ["Admin", "DocCtrl"] },
];

export type CapabilityPolicy = Partial<Record<CapabilityId, string[]>>;

const DEFAULTS: Record<CapabilityId, string[]> = Object.fromEntries(
  CAPABILITY_DEFS.map((d) => [d.id, d.defaultRoles]),
) as Record<CapabilityId, string[]>;

export function defaultCapabilityPolicy(): Record<CapabilityId, string[]> {
  return { ...DEFAULTS };
}

/** "Engineer" matches every Engineer-N tier; "*" matches any role. */
export function roleTokenMatches(token: string, role: string): boolean {
  if (token === "*") return true;
  if (token === "Engineer") return role.includes("Engineer");
  return token === role;
}

/** Role-based check. Identity-based rights are handled by callers. */
export function policyAllows(
  policy: CapabilityPolicy | null | undefined,
  cap: CapabilityId,
  role?: string | null,
  extraRoles?: string[] | null,
): boolean {
  const list = policy?.[cap] ?? DEFAULTS[cap] ?? [];
  const held = [role, ...(extraRoles ?? [])].filter((r): r is string => !!r);
  return held.some((r) => list.some((t) => roleTokenMatches(t, r)));
}

// ── Load (cached) ──────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; policy: CapabilityPolicy }>();
export function __resetCapabilityPolicyCache(): void { cache.clear(); }

/** `client` lets server routes pass their own (service-role) client — the
 *  shared browser client has no session in a route handler. */
export async function loadCapabilityPolicy(
  orgId: string,
  client?: Pick<typeof supabase, "from">,
): Promise<CapabilityPolicy> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.policy;
  try {
    const { data } = await (client ?? supabase)
      .from("org_configurations")
      .select("value")
      .eq("org_id", orgId)
      .eq("key", "capability_policy")
      .maybeSingle();
    const raw = (data?.value as CapabilityPolicy | null) ?? {};
    const policy: CapabilityPolicy = {};
    for (const def of CAPABILITY_DEFS) {
      const v = raw[def.id];
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) policy[def.id] = v;
    }
    cache.set(orgId, { at: Date.now(), policy });
    return policy;
  } catch {
    return {}; // defaults apply
  }
}

// ── Save (guardrailed + audited) ───────────────────────────────────────────

/** Returns a human-readable error, or null when the policy is safe. */
export function validateCapabilityPolicy(policy: CapabilityPolicy): string | null {
  for (const def of CAPABILITY_DEFS) {
    const v = policy[def.id];
    if (v === undefined) continue;
    if (!Array.isArray(v)) return `${def.label}: invalid value`;
    if (def.critical && !v.includes("Admin") && !v.includes("*")) {
      return `${def.label}: Admin cannot be removed from a critical capability — that's the rail that keeps the org recoverable.`;
    }
  }
  return null;
}

export async function saveCapabilityPolicy(input: {
  orgId: string;
  policy: CapabilityPolicy;
  actorUserId: string;
  actorEmail?: string | null;
}): Promise<void> {
  const err = validateCapabilityPolicy(input.policy);
  if (err) throw new Error(err);
  const before = await loadCapabilityPolicy(input.orgId);
  const { error } = await supabase
    .from("org_configurations")
    .upsert(
      { org_id: input.orgId, key: "capability_policy", value: input.policy, updated_at: new Date().toISOString() },
      { onConflict: "org_id,key" },
    );
  if (error) throw new Error(error.message);
  cache.delete(input.orgId);
  // Full before/after audit — a permission change is the one edit an IT
  // department must always be able to reconstruct.
  await supabase.from("audit_logs").insert({
    action: "CAPABILITY_POLICY_CHANGED",
    resource_type: "org_configuration",
    resource_id: input.orgId,
    org_id: input.orgId,
    user_id: input.actorUserId,
    user_email: input.actorEmail ?? null,
    details: { before, after: input.policy },
  }).then(() => undefined, () => undefined);
}
