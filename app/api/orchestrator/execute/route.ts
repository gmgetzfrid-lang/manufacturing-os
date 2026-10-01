// /api/orchestrator/execute — run ONE stored proposal, exactly as proposed,
// at most once (ORCH-4 / PR-1 / ORCH-10).
//
// The confirm button used to re-run the whole question with the approval
// attached and hope the model reached the same tool with byte-identical
// parameters. That was replaced by posting the tool and its parameters back
// here — which made the browser the only custodian of the proposal: any
// member could post any write with any parameters, and the route approved
// whatever it was sent. Now a run stores each executable proposal server-side
// (lib/orchestrator/proposals.ts, table orchestrator_proposals), and this
// route takes only the proposal's id: it re-reads the row and runs the
// STORED tool with the STORED parameters, for the person it was proposed to,
// in that org, within 15 minutes, once. The tool handler still re-checks
// everything it checks in a run — membership, readability, the controller
// tier where the tool needs it. This route confirms; it grants no authority.
//
// Every write goes through here and is audited (ORCH-10): AI_ACTION_EXECUTED
// is written BEFORE the tool runs — no write can land without its row — and
// if that row cannot be written nothing runs. A tool that then refuses or
// fails writes AI_ACTION_FAILED for the same proposal, and the claim is
// given back so the person can try again before it expires.
//
// POST { orgId, proposalId, fingerprint? }            → { ok, result }
// POST { orgId, proposalId, decision: "dismiss" }     → { ok, dismissed }
// Anything else — a body carrying a tool and parameters from a page opened
// before this change, an unknown / expired / spent / dismissed / someone
// else's proposal — is a 409 that says so. Nothing runs.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { toolByName, type ToolContext } from "@/lib/orchestrator/tools";
import { validateParams } from "@/lib/orchestrator/protocol";
import { loadPrincipal } from "@/lib/knowledgeAccess";
import { claimProposal, releaseProposal, dismissProposal, REFUSAL } from "@/lib/orchestrator/proposals";

export const runtime = "nodejs";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !user) return bad("Unauthorized", 401);

  let body: { orgId?: string; proposalId?: unknown; fingerprint?: unknown; decision?: unknown; tool?: unknown };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  if (!orgId) return bad("orgId is required");

  // SURF-7 / EGRESS-3: the caller's ACL principal — role COLLECTION, teams,
  // controller tier — is what every tool filters through. The service-role
  // key fetches; the principal decides what the caller may see or do.
  const [principal, { data: member }] = await Promise.all([
    loadPrincipal(orgId, user.id),
    supabaseAdmin.from("org_members").select("uid, role, display_name, email")
      .eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle(),
  ]);
  if (!principal || !member) return bad("Not a member of this workspace", 403);
  const role = principal.role;
  const actorName = ((member.display_name as string | null) || (member.email as string | null)?.split("@")[0] || "A colleague");

  const proposalId = typeof body.proposalId === "string" ? body.proposalId.trim() : "";
  if (!proposalId) {
    // A page opened before the proposal store shipped posts the tool and
    // its parameters. That is exactly what may no longer run.
    return bad(body.tool !== undefined ? REFUSAL.legacy : REFUSAL.unknown, 409);
  }

  if (body.decision === "dismiss") {
    const out = await dismissProposal(orgId, user.id, proposalId);
    if (!out.ok) return bad(out.error, out.status);
    return NextResponse.json({ ok: true, dismissed: true });
  }

  const fingerprint = typeof body.fingerprint === "string" && body.fingerprint ? body.fingerprint : null;
  const claim = await claimProposal(orgId, user.id, proposalId, fingerprint);
  if (!claim.ok) return bad(claim.error, claim.status);
  const { proposal, claimedAt } = claim;

  // Every outcome below that did NOT run the write hands the claim back.
  const refuse = async (msg: string, status: number, failed?: { error: string }) => {
    if (failed) {
      const { error: auditErr } = await supabaseAdmin.from("audit_logs").insert({
        action: "AI_ACTION_FAILED",
        resource_type: "orchestrator", resource_id: orgId,
        org_id: orgId, user_id: user.id,
        details: { tool: proposal.tool, proposalId: proposal.id, error: failed.error },
      });
      if (auditErr) console.error("[orchestrator/execute] AI_ACTION_FAILED not recorded:", auditErr.message);
    }
    await releaseProposal(proposal.id, claimedAt);
    return bad(msg, status);
  };

  const def = toolByName(proposal.tool);
  if (!def || !def.writes) return refuse("That isn't an executable action.", 409);
  const checked = validateParams(proposal.parameters ?? {}, def.params);
  if (!checked.ok) return refuse(checked.error, 409);

  // Audit FIRST (ORCH-10): no write may complete without its row, so a row
  // that cannot be written stops the action before it starts.
  const { error: auditErr } = await supabaseAdmin.from("audit_logs").insert({
    action: "AI_ACTION_EXECUTED",
    resource_type: "orchestrator", resource_id: orgId,
    org_id: orgId, user_id: user.id,
    details: {
      tool: def.name, parameters: checked.values,
      proposalId: proposal.id, fingerprint: proposal.fingerprint, summary: proposal.summary,
    },
  });
  if (auditErr) {
    return refuse("The action could not be recorded in the audit log, so it was not run. Try again.", 503);
  }

  // Approve exactly the stored action. The tool's own proposal gate sees the
  // stored fingerprint and executes; every check inside the handler runs.
  const ctx: ToolContext = {
    orgId, userId: user.id, role, principal, actorName,
    approved: new Set([proposal.fingerprint]),
  };

  let out;
  try {
    out = await def.run(checked.values, ctx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "The action failed.";
    return refuse(msg, 500, { error: msg });
  }

  // The stored parameters re-proposed instead of executing: the action no
  // longer matches what the tool would do (or it is a handoff, which never
  // executes here). Nothing ran.
  if (out.pending) {
    return refuse(
      out.pending.href
        ? "This action completes in the app, not here — use its link."
        : "This proposal no longer matches what the assistant would do. Ask again. Nothing was done.",
      409, { error: "re-proposed" },
    );
  }
  const result = (out.data ?? {}) as Record<string, unknown>;
  if (typeof result.error === "string" && result.error) {
    return refuse(result.error, result.forbidden === true ? 403 : 409, { error: result.error });
  }

  return NextResponse.json({ ok: true, result });
}
