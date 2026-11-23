// POST /api/share/create - make a link for someone outside the company.
//
//   { orgId, recipient, expiresDays: 1|7|30, withCode, allowDownload,
//     items: [{ documentId, markupPath? }] }
//
// Only the server makes links now (the table is read-only to members), so
// the checks the old browser insert skipped happen here: the sender is an
// active member, every document is in this workspace, and the sender can
// open every one of them. A link can't hand an outsider something its
// sender couldn't see.
//
// The code, when asked for, is returned this once and never stored: only a
// hash of it is kept.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal, readableControlledDocIds } from "@/lib/knowledgeAccess";
import { publicOrigin } from "@/lib/publicOrigin";
import {
  EXPIRY_DAYS, MAX_SHARE_ITEMS, SHARE_SQL_MESSAGE, UUID_RE,
  docLabel, fileKind, hashShareCode, isMissingShareColumn, isValidMarkupPath,
  newShareCode, newShareToken, resolveIssuedFile, type ShareItem,
} from "@/lib/shareLinks";

export const runtime = "nodejs";
export const maxDuration = 60;

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });
type DocRow = { id: string; org_id: string; document_number: string | null; title: string | null; name: string | null; rev: string | null; current_version_id: string | null };

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return bad("Sign in again.", 401);
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return bad("The request wasn't readable."); }

  const orgId = String(body.orgId ?? "");
  if (!UUID_RE.test(orgId)) return bad("Which workspace?");
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(auth.slice(7));
  if (authErr || !user) return bad("Sign in again.", 401);
  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("You're not a member of this workspace.", 403);

  const recipient = String(body.recipient ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!recipient) return bad("Say who it's for: a name or a company.");
  const expiresDays = Number(body.expiresDays);
  if (!(EXPIRY_DAYS as readonly number[]).includes(expiresDays)) return bad("Pick how long the link works: 1, 7 or 30 days.");
  const withCode = body.withCode === true;
  const allowDownload = body.allowDownload === true;

  const rawItems = Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : [];
  if (rawItems.length === 0) return bad("Pick at least one document.");
  if (rawItems.length > MAX_SHARE_ITEMS) return bad(`One link can carry up to ${MAX_SHARE_ITEMS} documents.`);
  const items: ShareItem[] = [];
  const seen = new Set<string>();
  for (const it of rawItems) {
    const id = String(it?.documentId ?? "");
    if (!UUID_RE.test(id)) return bad("A document in the list isn't valid.");
    if (seen.has(id)) continue;
    seen.add(id);
    const mp = it.markupPath;
    if (mp !== undefined && mp !== null && mp !== "" && !isValidMarkupPath(mp, orgId)) {
      return bad("A marked-up copy isn't in this workspace's storage.");
    }
    items.push({ documentId: id, markupPath: typeof mp === "string" && mp ? mp : null });
  }
  const ids = items.map((i) => i.documentId);

  // Every document is in this workspace...
  const docs: DocRow[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabaseAdmin.from("documents")
      .select("id, org_id, document_number, title, name, rev, current_version_id")
      .eq("org_id", orgId).in("id", ids.slice(i, i + 100));
    if (error) return bad(`The documents couldn't be read: ${error.message}`, 500);
    docs.push(...((data ?? []) as DocRow[]));
  }
  const byId = new Map(docs.map((d) => [d.id, d]));
  if (ids.some((id) => !byId.has(id))) return bad("Some of these documents aren't in this workspace anymore.", 404);

  // ...and the sender can open every one.
  let readable: Set<string>;
  try { readable = await readableControlledDocIds(principal, ids); }
  catch (e) { return bad(`Who can open these documents couldn't be checked: ${(e as Error).message}`, 500); }
  const blocked = ids.filter((id) => !readable.has(id));
  if (blocked.length > 0) {
    const more = blocked.length > 1 ? ` and ${blocked.length - 1} more` : "";
    return bad(`You don't have access to ${docLabel(byId.get(blocked[0]))}${more}, so no link was made.`, 403);
  }

  // Each one has a file that can carry the uncontrolled stamp.
  for (const it of items) {
    if (it.markupPath) continue;
    const d = byId.get(it.documentId)!;
    const f = await resolveIssuedFile(supabaseAdmin, d);
    if (!f) return bad(`${docLabel(d)} has no issued file to send.`, 422);
    if (fileKind(f.path, f.fileType) === "other") {
      return bad(`${docLabel(d)} isn't a PDF or a picture, so it can't be stamped as an uncontrolled copy. Add a PDF of it first.`, 422);
    }
  }

  const { data: me } = await supabaseAdmin.from("org_members").select("display_name, email")
    .eq("org_id", orgId).eq("uid", user.id).maybeSingle();
  const senderName = ((me as { display_name?: string | null } | null)?.display_name || user.email || (me as { email?: string | null } | null)?.email || null);

  const token = newShareToken();
  const code = withCode ? newShareCode() : null;
  const expiresAt = new Date(Date.now() + expiresDays * 86_400_000).toISOString();
  const { data: created, error: insErr } = await supabaseAdmin.from("document_shares").insert({
    token,
    org_id: orgId,
    document_id: ids[0],
    document_ids: ids,
    items,
    recipient,
    created_by: user.id,
    created_by_name: senderName,
    expires_at: expiresAt,
    allow_download: allowDownload,
    code_hash: code ? await hashShareCode(code, token) : null,
    code_failures: 0,
  }).select("id").single();
  if (insErr || !created) {
    if (isMissingShareColumn(insErr)) return bad(SHARE_SQL_MESSAGE, 503);
    return bad(`The link couldn't be made: ${insErr?.message ?? "no row came back"}`, 500);
  }
  const id = (created as { id: string }).id;

  await supabaseAdmin.from("audit_logs").insert({
    action: "SHARE_LINK_CREATED",
    resource_type: "document_share", resource_id: id,
    org_id: orgId, user_id: user.id, user_email: user.email ?? null,
    details: {
      recipient, expiresAt, withCode, allowDownload,
      documents: ids.slice(0, 200),
      labels: ids.slice(0, 50).map((d) => docLabel(byId.get(d))),
      markedUp: items.filter((i) => i.markupPath).map((i) => i.documentId),
    },
  }).then(() => undefined, () => undefined);

  const origin = publicOrigin() || req.nextUrl.origin;
  return NextResponse.json({ id, token, url: `${origin}/share/${token}`, code, expiresAt });
}
