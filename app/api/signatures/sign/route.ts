// POST /api/signatures/sign — the signing ceremony's server half.
//
// SURF-14 / RG-9 / EVID-3: an e-signature is the strongest evidentiary artifact
// in the system, so it is minted HERE, never by the browser:
//   1. the caller is the bearer token's user, and re-authentication is verified
//      server-side at the moment of signing — a password account re-enters its
//      password (probed against Supabase Auth with a throwaway client; the
//      session that probe issues is discarded), an SSO account must have a
//      provider sign-in inside the freshness window (read from the token's own
//      user record, not from a client claim);
//   2. signer_name / signer_role / signer_email are derived from org_members for
//      the caller — client-supplied values for those columns are ignored;
//   3. content_hash, when the signature binds a document version, is taken from
//      the version row the publish path hashed from the bytes it stored — a
//      client-supplied hash that disagrees is refused;
//   4. intent "Approved" needs approval capability (controller or engineer
//      tier, by the role collection); the roster guards at the database bind
//      "Reviewed" / "Acknowledged" to the named reviewer / assignee afterwards.
// The row is written with the service-role key (20261050 removes the client
// INSERT policy and adds a trigger that refuses any non-service insert), then an
// ESIGNATURE_CAPTURED audit row is written as a CHECKED write.
//
// drafting-flow EVID-11 done-whens 2-3 (F4 SIGNATURE TRANSACTION, 20261269):
// once that migration is pasted, the signature, its audit mirror and — when
// the body names it (`pair`) — the roster row the signature authorises (a
// read-and-understood acknowledgment, a review sign-off) are written in ONE
// database transaction by record_signature_transaction, from the very rows
// below: a signature never exists without its sign-off or the reverse, and a
// refused mirror is kept in the audit outbox (DEC-109) in that transaction.
// Before the paste (PGRST202 / 42883) every write is today's, byte for byte,
// and the browser writes its roster row itself, as today. Every check above
// the write stays here; the roster write is judged by the database as the
// signer (lib/signatureReconciliation.ts finds any orphan).
//
// Body: { orgId, resourceType, resourceId, documentVersionId?, contentHash?,
//         intent, statement, signatureImage?, reauth: { method: "password", password } | { method: "sso" },
//         pair?: { kind: "acknowledgment", rosterId? } | { kind: "review_signoff", signoffId } }

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { heldRoles } from "@/lib/roleHeld";
import { userFacingError } from "@/lib/userFacingError";

export const runtime = "nodejs";

/** SSO sign-ins older than this are not "fresh" — mirrors lib/eSignatures. */
export const SSO_REAUTH_WINDOW_MS = 15 * 60 * 1000;
const INTENTS = new Set(["Approved", "Reviewed", "Rejected", "Witnessed", "Acknowledged"]);
const APPROVAL_TIER = ["Admin", "DocCtrl", "Engineer-1", "Engineer-2", "Engineer-3", "Engineer-4"];

interface Body {
  orgId?: unknown; resourceType?: unknown; resourceId?: unknown;
  documentVersionId?: unknown; contentHash?: unknown;
  intent?: unknown; statement?: unknown; signatureImage?: unknown;
  reauth?: { method?: unknown; password?: unknown } | null;
  pair?: { kind?: unknown; rosterId?: unknown; signoffId?: unknown } | null;
}

/** The roster row a signature authorises, written in its transaction (20261269). */
type Pair = { kind: "acknowledgment"; rosterId: string | null } | { kind: "review_signoff"; signoffId: string };

/** What the signer reads when the roster write matched no row of theirs —
 *  the transaction rolled the signature back with it. */
const PAIR_NO_ROW: Record<Pair["kind"], string> = {
  acknowledgment: "There was no pending acknowledgment of yours to mark — it may have been replaced by a newer revision. Nothing was signed: reload and acknowledge the current revision.",
  review_signoff: "That roster row is not yours to sign — only the named reviewer can sign their own row. If your row was voided by a newer draft, review the new draft instead. Nothing was signed.",
};

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Unauthorized", 401);

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return bad("Invalid JSON body", 400); }
  const orgId = str(body.orgId), resourceType = str(body.resourceType), resourceId = str(body.resourceId);
  const intent = str(body.intent), statement = str(body.statement);
  if (!orgId || !resourceType || !resourceId || !intent || !statement) {
    return bad("orgId, resourceType, resourceId, intent and statement are required", 400);
  }
  if (!INTENTS.has(intent)) return bad("Unknown signature intent", 400);
  const documentVersionId = str(body.documentVersionId);
  const claimedHash = str(body.contentHash);
  const signatureImage = typeof body.signatureImage === "string" && body.signatureImage.startsWith("data:image/") ? body.signatureImage : null;
  // EVID-11: the roster row this signature authorises — only the pairs the
  // two roster ceremonies send, with the intent and resource they sign.
  let pair: Pair | null = null;
  if (body.pair != null) {
    const kind = str(body.pair.kind);
    const rosterId = str(body.pair.rosterId), signoffId = str(body.pair.signoffId);
    if (kind === "acknowledgment" && intent === "Acknowledged" && resourceType === "document") {
      pair = { kind, rosterId };
    } else if (kind === "review_signoff" && intent === "Reviewed" && resourceType === "document_version" && signoffId) {
      pair = { kind, signoffId };
    } else {
      return bad("That roster row cannot be signed with this signature", 400);
    }
    if ((rosterId && !UUID.test(rosterId)) || (signoffId && !UUID.test(signoffId))) {
      return bad("Your roster row could not be identified — reload and sign again. Nothing was signed.", 400);
    }
  }

  // ── 1. re-authentication, verified here ────────────────────────────────────
  const provider = (user.app_metadata as { provider?: string } | null)?.provider ?? "email";
  const method = str(body.reauth?.method);
  const now = Date.now();
  let reauthMethod: "password" | "sso";
  if (provider === "email") {
    const password = typeof body.reauth?.password === "string" ? body.reauth.password : "";
    if (method !== "password" || !password) return bad("Re-enter your password to sign.", 403);
    if (!user.email) return bad("This account has no email to verify against.", 403);
    const probe = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
    );
    const { data: probed, error: probeErr } = await probe.auth.signInWithPassword({ email: user.email, password });
    if (probeErr || probed?.user?.id !== user.id) return bad("That password doesn't match — signature not applied.", 403);
    try { await probe.auth.signOut({ scope: "local" }); } catch { /* the probe session is never persisted */ }
    reauthMethod = "password";
  } else {
    const last = user.last_sign_in_at ? new Date(user.last_sign_in_at).getTime() : 0;
    if (!last || now - last > SSO_REAUTH_WINDOW_MS) {
      return bad("Signatures need a recent sign-in — re-authenticate with your provider, then sign.", 403);
    }
    reauthMethod = "sso";
  }

  // ── 2. identity from the membership row, never from the body ───────────────
  const { data: member } = await supabaseAdmin
    .from("org_members").select("uid, email, display_name, role, roles")
    .eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle();
  if (!member) return bad("Forbidden: not an active member of this workspace", 403);
  const m = member as { email: string | null; display_name: string | null; role: string | null; roles: string[] | null };
  const held = heldRoles(m);
  const signerEmail = m.email || user.email || null;
  const signerName = (m.display_name || "").trim() || (signerEmail ? signerEmail.split("@")[0] : "") || "user";
  const signerRole = m.role ?? held[0] ?? null;

  // ── 3. the content hash is the stored object's, not the client's ───────────
  let contentHash: string | null = claimedHash;
  if (documentVersionId) {
    const { data: version } = await supabaseAdmin
      .from("document_versions").select("id, org_id, file_hash")
      .eq("id", documentVersionId).maybeSingle();
    const v = version as { id: string; org_id: string | null; file_hash: string | null } | null;
    if (!v || (v.org_id && v.org_id !== orgId)) return bad("That document version does not exist in this workspace", 404);
    if (v.file_hash) {
      if (claimedHash && claimedHash !== v.file_hash) {
        return bad("The content you are signing does not match the stored revision — reload and sign again.", 409);
      }
      contentHash = v.file_hash;
    }
  }

  // ── 4. intent authority ────────────────────────────────────────────────────
  if (intent === "Approved" && !held.some((r) => APPROVAL_TIER.includes(r))) {
    return bad("Only Admin, Document Control or an engineer can sign as Approved.", 403);
  }

  const signedAt = new Date(now).toISOString();
  const signatureRow = {
    org_id: orgId, resource_type: resourceType, resource_id: resourceId,
    document_version_id: documentVersionId, content_hash: contentHash,
    intent, statement,
    signer_user_id: user.id, signer_name: signerName, signer_role: signerRole, signer_email: signerEmail,
    signature_image: signatureImage,
    user_agent: req.headers.get("user-agent"),
    signed_at: signedAt,
    reauth_method: reauthMethod, reauth_at: signedAt,
    metadata: { reauth: { method: reauthMethod, at: signedAt, provider }, minted_by: "api/signatures/sign" },
  };
  const auditRow = (signatureId: string | null) => ({
    action: "ESIGNATURE_CAPTURED",
    resource_id: resourceId, resource_type: resourceType, org_id: orgId,
    user_id: user.id, user_email: signerEmail, user_role: signerRole,
    details: { intent, statement, signerName, signatureId, documentVersionId, reauthMethod },
  });

  // ── 5. EVID-11: one transaction — the signature, its mirror, its roster row ─
  const { data: tx, error: txErr } = await supabaseAdmin.rpc("record_signature_transaction", {
    p_signature: signatureRow, p_audit: auditRow(null), p_pair: pair, p_paired_at: new Date().toISOString(),
  });
  if (!txErr) {
    // An answer with no row is never retried as a second write.
    if (!tx) return bad("The signature could not be confirmed — reload before signing again.", 500);
    const t = tx as { signature: Record<string, unknown>; paired: { kind: string; rosterIds: string[] } | null; auditError: string | null };
    return NextResponse.json({
      signature: t.signature,
      ...(t.paired ? { paired: t.paired } : {}),
      ...(t.auditError ? { warning: `Signed, but the audit row failed: ${t.auditError}` } : {}),
    });
  }
  if (txErr.code !== "PGRST202" && txErr.code !== "42883") {
    // The transaction wrote nothing: say so, in the words the signer can act
    // on — a guard's or the function's own sentence as written, any driver
    // text replaced (userFacingError logs the raw detail).
    if (pair && txErr.code === "P0002") return bad(PAIR_NO_ROW[pair.kind], 409);
    if (txErr.code === "23514") return bad(`${userFacingError(txErr, { context: "signatures/sign", clause: true })}. Nothing was signed.`, 409);
    console.error("[signatures/sign] record_signature_transaction refused:", { code: txErr.code ?? null, message: txErr.message ?? null });
    return bad(`Nothing was signed. ${userFacingError(txErr, { context: "signatures/sign", embed: true })}`, 500);
  }
  // Said in the server log, never silent: PGRST202 is the function not in the
  // schema (20261269 not pasted); 42883 is a function missing — possibly one
  // the body calls.
  console.warn(`[signatures/sign] taking the pre-paste path: ${txErr.code === "PGRST202"
    ? "record_signature_transaction is not in the schema (PGRST202 — 20261269 not pasted)"
    : `a function is missing (42883: ${txErr.message ?? ""})`}`);

  // ── Before 20261269 (PGRST202 / 42883): today's path, byte for byte ───────
  const { data: row, error: insErr } = await supabaseAdmin
    .from("e_signatures")
    .insert(signatureRow)
    .select("*")
    .single();
  if (insErr || !row) return bad(insErr?.message || "Failed to record signature", 500);

  // The audit mirror is a CHECKED write: a signature without its trail is reported
  // — and (DEC-109, EVID-11 done-when 3) kept in the audit outbox, never dropped.
  const mirror = auditRow((row as { id: string }).id);
  const { error: auditErr } = await supabaseAdmin.from("audit_logs").insert(mirror);
  if (auditErr) {
    const { error: outboxErr } = await supabaseAdmin.from("audit_dead_letters").insert({
      org_id: orgId, action: mirror.action, entry: { row: { ...mirror, metadata: null }, reporter: null },
      error: (auditErr.message || "audit insert refused").slice(0, 2000), source: "server", reported_by: null,
    });
    if (outboxErr) console.warn("[signatures/sign] the refused ESIGNATURE_CAPTURED mirror was not kept in the outbox:", outboxErr.message);
  }
  return NextResponse.json({ signature: row, ...(auditErr ? { warning: `Signed, but the audit row failed: ${auditErr.message}` } : {}) });
}
