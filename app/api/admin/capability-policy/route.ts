// POST /api/admin/capability-policy
//
// WF-11: the capability policy's ONLY supported write path. The guardrails
// used to run in the browser (validateCapabilityPolicy inside
// saveCapabilityPolicy), so a DocCtrl with devtools could PATCH
// org_configurations.capability_policy directly — removing Admin from a
// critical capability, or granting themselves `ticket.manage` — with no
// validation and no audit row. Here, with the service-role client:
//
//   1. bearer auth; active membership in the org; the controller tier
//      (Admin / DocCtrl) BY THE ROLE COLLECTION, matching is_org_controller;
//   2. `save` replaces the role grid only — grants are preserved server-side;
//      a change to a CRITICAL capability's entry requires Admin — a change
//      in what the evaluator would answer, not in the JSON's shape;
//   3. `grant` / `revoke` change one person's delegation — Admin only, a
//      self-grant is refused, the target must be an active member, the
//      expiry is stored as ISO 8601, and the server stamps
//      grantedBy / grantedAt;
//   4. validateCapabilityPolicy runs on the RESULT; expired grants are pruned
//      on every write and the pruning is named in the audit row (WF-16);
//   5. the write is compare-and-set on the row's updated_at (two concurrent
//      grant writes cannot lose one another — WF-16 done-when 2);
//   6. this process's policy cache is invalidated (WF-10) and a before/after
//      CAPABILITY_POLICY_CHANGED row is written — a client cannot skip it.
//
// The 20261056 trigger holds rails 1–3 against a direct INSERT, UPDATE or
// DELETE that bypasses this route, and audits such a write itself.
//
// Body: { op: "save", orgId, caps }
//     | { op: "grant", orgId, uid, cap, expiresAt?, note? }
//     | { op: "revoke", orgId, uid, cap }

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  CAPABILITY_DEFS, RESOURCE_KEYS, baseTokensFor, grantActive, isRuleArray, normalizeCapabilityEntry,
  parseStoredCapabilityPolicy, ruleIsConditional, validateCapabilityPolicy, invalidateCapabilityPolicy,
  type CapabilityId, type CapabilityPolicy, type UserGrant,
} from "@/lib/capabilityPolicy";
import { memberHoldsAny } from "@/lib/roleHeld";

export const runtime = "nodejs";

const CONTROLLER_ROLES = ["Admin", "DocCtrl"] as const;
const OPS = new Set(["save", "grant", "revoke"]);

interface Body {
  op?: unknown; orgId?: unknown; caps?: unknown;
  uid?: unknown; cap?: unknown; expiresAt?: unknown; note?: unknown;
}

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The entry a policy EFFECTIVELY holds for one capability, in a form that
 *  is equal exactly when the evaluator (tokensFor) would answer the same for
 *  every resource — not when the JSON is byte-identical. The editor's
 *  split/join re-emits a stored rule list as [base, one rule per request
 *  type, ...the rest] (CapabilityPolicyEditor), so a stored multi-type
 *  clause, a conditional rule ahead of the unconditional one, or an absent
 *  unconditional rule (the base is the shipped default, which the editor
 *  writes out) would otherwise read as a change a DocCtrl never made.
 *  Sound rather than complete: conditional rules keep their relative ORDER
 *  (first match wins, so swapping two rules that can both match a resource
 *  IS a change and stays Admin's); a single-key clause with n values becomes
 *  n consecutive rules (what the editor emits — mutually exclusive, so their
 *  order is immaterial and kept as listed); token lists and `when` lists are
 *  sets. An absent key is the shipped default, so writing the default
 *  explicitly is not a change. */
function canonicalEntry(policy: CapabilityPolicy, id: CapabilityId): string {
  const asSet = (xs: readonly string[]) => [...new Set(xs)].sort();
  const entry = policy.caps?.[id];
  const base = asSet(baseTokensFor(policy, id));
  if (!isRuleArray(entry)) return JSON.stringify({ base, rules: [] });
  const rules = entry.filter(ruleIsConditional).flatMap((r) => {
    const keys = RESOURCE_KEYS.filter((k) => (r.when?.[k]?.length ?? 0) > 0);
    const tokens = asSet(r.tokens);
    if (keys.length === 1) return (r.when?.[keys[0]] ?? []).map((v) => ({ tokens, when: { [keys[0]]: [v] } }));
    return [{ tokens, when: Object.fromEntries(keys.map((k) => [k, asSet(r.when?.[k] ?? [])])) }];
  });
  return JSON.stringify({ base, rules });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user: caller }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !caller) return bad("Unauthorized", 401);

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return bad("Invalid JSON body", 400); }
  const op = str(body.op);
  const orgId = str(body.orgId);
  if (!OPS.has(op) || !orgId) return bad("op (save | grant | revoke) and orgId are required", 400);

  // Active membership + the controller tier, by the collection (ADD-1).
  const { data: member } = await supabaseAdmin
    .from("org_members").select("uid, role, roles, email")
    .eq("org_id", orgId).eq("uid", caller.id).eq("status", "active").maybeSingle();
  if (!member) return bad("Forbidden: not an active member of this workspace", 403);
  if (!memberHoldsAny(member, CONTROLLER_ROLES)) return bad("Forbidden: only Admin or DocCtrl may change the capability policy", 403);
  const isAdmin = memberHoldsAny(member, ["Admin"]);
  const callerEmail = (member.email as string | null) || caller.email || null;

  // The stored row, read fresh (never through the cache) — the `before` of
  // the audit row and the compare-and-set stamp of the write.
  const { data: stored, error: readErr } = await supabaseAdmin
    .from("org_configurations").select("data, updated_at")
    .eq("org_id", orgId).eq("key", "capability_policy").maybeSingle();
  if (readErr) return bad(`Couldn't read the stored policy: ${readErr.message}`, 500);
  const before = parseStoredCapabilityPolicy(stored?.data);
  const storedVersion = typeof stored?.updated_at === "string" ? stored.updated_at : null;

  // WF-16: expired grants are pruned on every write, and the pruning is
  // itself audited below.
  const liveGrants = (before.grants ?? []).filter((g) => grantActive(g));
  const pruned = (before.grants ?? []).filter((g) => !grantActive(g));
  const nowIso = new Date().toISOString();
  let after: CapabilityPolicy;
  let grantDetail: Record<string, unknown> = {};

  if (op === "save") {
    if (!body.caps || typeof body.caps !== "object" || Array.isArray(body.caps)) return bad("caps must be an object", 400);
    const caps: NonNullable<CapabilityPolicy["caps"]> = {};
    const raw = body.caps as Record<string, unknown>;
    for (const def of CAPABILITY_DEFS) {
      if (!(def.id in raw)) continue;
      const entry = normalizeCapabilityEntry(raw[def.id]);
      if (entry === undefined) return bad(`${def.label}: invalid value`, 400);
      caps[def.id] = entry;
    }
    after = { caps, grants: liveGrants };
    // WF-11 done-when 2: a critical capability's entry is Admin's to change —
    // a DocCtrl controller may edit the rest of the grid. "Change" is what
    // the evaluator would answer differently, not a different JSON shape.
    const criticalChanged = CAPABILITY_DEFS
      .filter((d) => d.critical)
      .filter((d) => canonicalEntry(before, d.id) !== canonicalEntry(after, d.id));
    if (criticalChanged.length > 0 && !isAdmin) {
      return bad(`Only an Admin may change a critical capability (${criticalChanged.map((d) => d.label).join(", ")})`, 403);
    }
  } else {
    // grant / revoke — Admin only (WF-11 done-when 2/3: "for ANY grant").
    if (!isAdmin) return bad("Only an Admin may grant or revoke a personal permission", 403);
    const uid = str(body.uid);
    const cap = str(body.cap) as CapabilityId;
    if (!uid || !cap) return bad("uid and cap are required", 400);
    if (!CAPABILITY_DEFS.some((d) => d.id === cap)) return bad(`Unknown capability: ${cap}`, 400);
    if (uid === caller.id) return bad("You cannot grant a permission to yourself — ask another Admin.", 403);
    const others = liveGrants.filter((g) => !(g.uid === uid && g.cap === cap));
    if (op === "grant") {
      const { data: target } = await supabaseAdmin
        .from("org_members").select("uid")
        .eq("org_id", orgId).eq("uid", uid).eq("status", "active").maybeSingle();
      if (!target) return bad("The person is not an active member of this workspace", 400);
      // Stored as ISO 8601: Date.parse accepts forms the SQL evaluator's
      // ::timestamptz cast does not ("Sep 17 2026 10:00:00 GMT+0000"), and a
      // stored one of those would make org_capability_allows_for raise for
      // this person on every holds / force-release check.
      const rawExpiry = body.expiresAt == null || body.expiresAt === "" ? null : str(body.expiresAt);
      const expiresMs = rawExpiry === null ? null : Date.parse(rawExpiry);
      if (expiresMs !== null && Number.isNaN(expiresMs)) return bad("The expiry date is invalid", 400);
      if (expiresMs !== null && expiresMs <= Date.now()) return bad("The expiry date is in the past", 400);
      const expiresAt = expiresMs === null ? null : new Date(expiresMs).toISOString();
      const grant: UserGrant = {
        cap, uid, expiresAt, note: str(body.note) || null,
        grantedBy: caller.id, grantedAt: nowIso,
      };
      after = { caps: before.caps ?? {}, grants: [...others, grant] };
      grantDetail = { grant };
    } else {
      const revoked = liveGrants.find((g) => g.uid === uid && g.cap === cap) ?? null;
      after = { caps: before.caps ?? {}, grants: others };
      grantDetail = { revoked };
    }
  }

  // WF-11 done-when 1: the rail runs HERE, with the service-role client, on
  // every policy and grant write.
  const invalid = validateCapabilityPolicy(after);
  if (invalid) return bad(invalid, 400);

  // Compare-and-set on the stamp we read: a concurrent write (a second
  // grant, another admin's save) is refused, not silently overwritten.
  if (stored) {
    let q = supabaseAdmin
      .from("org_configurations")
      .update({ data: after, updated_at: nowIso })
      .eq("org_id", orgId).eq("key", "capability_policy");
    q = storedVersion ? q.eq("updated_at", storedVersion) : q.is("updated_at", null);
    const { data: written, error: writeErr } = await q.select("org_id");
    if (writeErr) return bad(`Couldn't save the policy: ${writeErr.message}`, 500);
    if (!written || (written as unknown[]).length === 0) {
      return bad("The policy changed while you were editing — reload and try again", 409);
    }
  } else {
    const { error: insErr } = await supabaseAdmin
      .from("org_configurations")
      .insert({ org_id: orgId, key: "capability_policy", data: after, updated_at: nowIso });
    if (insErr) {
      return insErr.code === "23505"
        ? bad("The policy was created concurrently — reload and try again", 409)
        : bad(`Couldn't save the policy: ${insErr.message}`, 500);
    }
  }
  // WF-10: this instance forgets the old policy now. The instance serving
  // /api/tickets/workflow-action is a separate function on Vercel (the cache
  // is not shared across route functions), so the bound that holds there is
  // the TTL: it ages its entry out within SERVER_CACHE_TTL_MS (5 s).
  invalidateCapabilityPolicy(orgId);

  // Full before/after audit — a permission change is the one edit an IT
  // department must always be able to reconstruct. Server-written: the
  // client cannot skip it. A failure here is surfaced, never swallowed.
  const { error: auditErr } = await supabaseAdmin.from("audit_logs").insert({
    action: "CAPABILITY_POLICY_CHANGED",
    resource_type: "org_configuration",
    resource_id: orgId,
    org_id: orgId,
    user_id: caller.id,
    user_email: callerEmail,
    user_role: (member.role as string | null) ?? null,
    details: { op, via: "route", before, after, pruned, ...grantDetail },
  });
  if (auditErr) {
    return bad(`The policy was saved, but its audit row could not be written (${auditErr.message}). Save again to record it.`, 500);
  }
  return NextResponse.json({ ok: true, policy: after, pruned: pruned.length, version: nowIso });
}
