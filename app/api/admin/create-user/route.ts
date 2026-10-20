import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ALL_ROLES, type Role } from "@/types/schema";
import { normalizeEmail, applyEmailLookup } from "@/lib/identity";
import { normalizeRoles, primaryRole } from "@/lib/roleCapabilities";
import { enforceOrgAccess } from "@/lib/serverAuth";
import { clearAccessRequestNotices, queueAccessRequestOutcome } from "@/lib/accessRequestOutcome";
import { pruneRemovedMemberAclIndex, type RpcClient } from "@/lib/memberAclIndexPrune";
import { memberHoldsAny } from "@/lib/roleHeld";

// Bounded lookup of auth users by email. Only used in the rare path where the
// auth account already exists (e.g. they signed in with Microsoft first) but
// has no profile row to read the id from. Collects EVERY match rather than
// returning the first: with two auth identities on one address, "first in
// listUsers page order" is not a property anyone controls, and attaching a
// role to an arbitrary identity is exactly the defect this route had (IDENT-2).
async function findAuthUsersByEmail(email: string): Promise<string[] | null> {
  const target = normalizeEmail(email);
  const matches: string[] = [];
  const perPage = 200;
  for (let page = 1; page <= 25; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) return null; // lookup failed — caller must refuse, not guess
    if (!data?.users?.length) break;
    for (const u of data.users) {
      if ((u.email || "").toLowerCase() === target) matches.push(u.id);
    }
    if (data.users.length < perPage) break;
  }
  return matches;
}

/** Close the loop on the pending-requests card (/admin/users): once this org
 *  granted the address a membership, its pending access_requests rows are
 *  resolved. Without this the card lists an accepted request forever AND the
 *  public route 409s the person's every later request ("You already have a
 *  pending request"), including a legitimate re-request after removal.
 *  Best-effort by design — membership is already granted; a failure here only
 *  leaves the card row visible — but logged so it is never invisible. Both
 *  sides store emails normalized (lib/identity.ts / 20261018), so eq matches. */
async function resolvePendingAccessRequests(orgId: string, email: string, memberUid: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("access_requests")
    .update({ status: "approved" })
    .eq("org_id", orgId)
    .eq("email", email)
    .eq("status", "pending")
    .select("id, org_name");
  if (error) { console.warn(`[create-user] couldn't resolve pending access request for ${email}: ${error.message}`); return; }
  // PROD-2 dw2: the membership IS the approval. When it answered a pending
  // request, the person who asked hears so at the address they gave (now
  // their member address — the lookup matched it). Only rows THIS call
  // resolved; an "Add member" that answered no request emails nobody.
  const rows = (Array.isArray(data) ? data : []) as Array<{ id: string; org_name: string | null }>;
  if (rows.length === 0) return;
  await queueAccessRequestOutcome(supabaseAdmin, {
    outcome: "approved",
    orgId,
    orgName: rows[0].org_name ?? null,
    requestIds: rows.map((r) => String(r.id)),
    toEmail: email,
    queuedBy: memberUid,
    toMember: true,
  });
  // The requests are closed: the pool's notices about them stop waiting on
  // anyone (N8's review fix — the PROD-3 rule). Best-effort.
  await clearAccessRequestNotices(supabaseAdmin, orgId, rows.map((r) => String(r.id)));
}

/** ORG-7 (admin-and-org Round G, P12): how long a re-add may spend clearing
 *  the person's stale inherited acl_index entries before the membership is
 *  re-created. What is left is the nightly acl_index rebuild's (DEC-10). */
const READD_ACL_INDEX_BUDGET_MS = 5_000;
const READD_ACL_INDEX_CHUNK = 2_000;

type ReAddAclIndexCleanup = { done: boolean; pruned: number; calls: number; error?: string };

/** One audit row read as EVIDENCE for skipping the re-add walk, with what is
 *  needed to judge whose word it is. `actor_kind` exists from 20261201. */
type AuditEvidenceRow = {
  details?: Record<string, unknown> | null;
  timestamp?: string | null;
  user_id?: string | null;
  actor_kind?: string | null;
};

/** Postgres / PostgREST "no such column" — audit_logs.actor_kind before
 *  20261201 is pasted. */
function isMissingColumnError(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "PGRST204") return true;
  const msg = String(err.message ?? "");
  return /actor_kind/.test(msg) && /column/i.test(msg);
}

/** ORG-7 re-review fix (DEC-90, fail-safe = walk): the person's audit rows of
 *  one action, newest first, with the writer columns. Asks for actor_kind;
 *  when the column is not there (42703 / PGRST204 — 20261201 not pasted) the
 *  read is repeated without it and `actorKind` is false, so only the
 *  Admin-writer rule can make a row trustworthy. Any other read error
 *  answers null — the caller walks. */
async function readRemovalEvidence(
  orgId: string, uid: string, action: string, opts: { sinceIso?: string; limit: number },
): Promise<{ rows: AuditEvidenceRow[]; actorKind: boolean; error?: string } | { rows: null; actorKind: false; error: string }> {
  const read = async (cols: string) => {
    let q = supabaseAdmin.from("audit_logs").select(cols)
      .eq("org_id", orgId).eq("action", action).eq("resource_id", uid);
    if (opts.sinceIso) q = q.gte("timestamp", opts.sinceIso);
    const { data, error } = await q.order("timestamp", { ascending: false }).limit(opts.limit);
    return { data: data as unknown, error: error as { code?: string | null; message?: string | null } | null };
  };
  let actorKind = true;
  let res = await read("details, timestamp, user_id, actor_kind");
  if (res.error && isMissingColumnError(res.error)) {
    actorKind = false;
    res = await read("details, timestamp, user_id");
  }
  if (res.error || !Array.isArray(res.data)) {
    return { rows: null, actorKind: false, error: String(res.error?.message ?? "audit_logs read returned no rows array") };
  }
  return { rows: res.data as AuditEvidenceRow[], actorKind };
}

/** ORG-7 re-review fix: which evidence rows may switch the re-add walk off.
 *  Any active member can INSERT an audit_logs row naming themselves, with
 *  any action and details (audit_logs_insert asks only user_id =
 *  auth.uid()), so a row's CONTENT alone is never trusted. A row counts
 *  only when
 *   · its actor_kind is 'server' or 'system' (20261201's stamp: the service
 *     role or a database function's machine pass — a member's own row is
 *     always 'member'; read only when the column exists), or
 *   · its writer (user_id) holds Admin in this workspace NOW — an ACTIVE
 *     membership, by the role collection (memberHoldsAny). revoke_member's
 *     remove and the chunk RPC both refuse anyone but an active Admin, so
 *     every legitimate row passes while its writer is still an Admin.
 *  Anything else — no writer, a non-Admin writer, an Admin read that fails
 *  (null) — is untrusted, and the caller walks. */
async function trustedEvidence(orgId: string, rows: AuditEvidenceRow[], actorKind: boolean): Promise<boolean[] | null> {
  const byServer = (r: AuditEvidenceRow) => actorKind && (r.actor_kind === "server" || r.actor_kind === "system");
  const writers = new Set<string>();
  for (const r of rows) if (!byServer(r) && r.user_id) writers.add(String(r.user_id));
  const admins = new Set<string>();
  if (writers.size > 0) {
    const { data, error } = await supabaseAdmin
      .from("org_members")
      .select("uid, role, roles")
      .eq("org_id", orgId)
      .eq("status", "active")
      .in("uid", [...writers]);
    if (error || !Array.isArray(data)) return null;
    for (const m of data as Array<{ uid: string; role?: unknown; roles?: unknown }>) {
      if (writers.has(String(m.uid)) && memberHoldsAny(m, ["Admin"])) admins.add(String(m.uid));
    }
  }
  return rows.map((r) => byServer(r) || (!!r.user_id && admins.has(String(r.user_id))));
}

/** ORG-7 review fix: does the audit trail already show that nothing the
 *  removal left can still name the person? Read from the
 *  MEMBER_ACL_GRANTS_PRUNED rows written at or after the removal
 *  (`sinceIso`, the MEMBER_REMOVED row's timestamp — revoke_member writes
 *  both in one transaction, so its own row carries the same timestamp):
 *   · revoke_member's own row (no `phase`) says no library and no folder
 *     carried the grant (`libraries` and `collections` both 0) — a grant on
 *     a document or a set is inherited by nothing, so there is nothing to
 *     walk; or
 *   · a chunk row of prune_removed_member_acl_index (`phase: "acl_index"`)
 *     says `done: true` — the members page's walk, or an earlier re-add's
 *     service-role walk, finished.
 *  The chunk RPC writes a row only for a call that pruned something, so a
 *  walk whose LAST call pruned nothing leaves no `done` row: that case
 *  still walks (within the budget). Re-review fix: a settling row counts
 *  only when trustedEvidence says so (server / system actor_kind, or an
 *  Admin writer at read time). A read that fails answers false — the walk
 *  runs. */
async function removalWalkSettled(orgId: string, uid: string, sinceIso: string): Promise<boolean> {
  const ev = await readRemovalEvidence(orgId, uid, "MEMBER_ACL_GRANTS_PRUNED", { sinceIso, limit: 200 });
  if (ev.rows === null) return false;
  const settling = ev.rows.filter((row) => {
    const d = row.details ?? {};
    return (d.phase === "acl_index" && d.done === true)
      || (d.phase === undefined && d.reason === "member_removed"
          && Number(d.libraries ?? NaN) === 0 && Number(d.collections ?? NaN) === 0);
  });
  if (settling.length === 0) return false;
  const trusted = await trustedEvidence(orgId, settling, ev.actorKind);
  if (!trusted) return false;
  return trusted.some(Boolean);
}

/** ORG-7 — the re-add residual of the member-removal prune. A removal
 *  (revoke_member, 20261204) strips the person's own grant rules at once,
 *  and the members page strips what descendants INHERITED from them in
 *  bounded chunks afterwards (prune_removed_member_acl_index). If that walk
 *  was cut short (the Admin's tab closed, a call failed, a 2-minute
 *  deadline) the inherited entries still list the person until the nightly
 *  rebuild — harmless while they are not a member, but a re-add inside that
 *  window would make them count again. So before the membership row is
 *  created again, the same RPC (it admits the service role, and refuses
 *  while any membership row exists) walks the workspace's libraries within
 *  READD_ACL_INDEX_BUDGET_MS. Never blocks the re-add: a call that fails, or
 *  a walk the budget cuts short, is logged and returned, and the rest is the
 *  nightly rebuild's. Returns null when there was nothing to clear.
 *
 *  When the walk is SKIPPED (re-review fix, DEC-90 fail-safe = walk): only
 *  on evidence nobody but an Admin or the server could have written.
 *   · No MEMBER_REMOVED row at all: never removed, nothing a removal left
 *     (an absent row cannot be forged) — skipped, as before.
 *   · The person's LATEST MEMBER_REMOVED row is trustworthy
 *     (trustedEvidence) AND either says the removal pruned no grant
 *     (`prunedAclGrants` 0 or absent — written by 20261204's revoke_member)
 *     or a trustworthy row shows the walk settled (removalWalkSettled).
 *  Everything else walks: a latest row a non-Admin wrote (a forged
 *  "prunedAclGrants: 0" cannot switch the clean-up off), a writer no longer
 *  an Admin, a read that fails, an Admin lookup that fails. */
async function clearStaleInheritedAclIndex(orgId: string, uid: string): Promise<ReAddAclIndexCleanup | null> {
  try {
    const removal = await readRemovalEvidence(orgId, uid, "MEMBER_REMOVED", { limit: 1 });
    let skip = false;
    if (removal.rows === null) {
      console.warn(`[create-user] ORG-7: the removal record of ${uid} could not be read (${removal.error}) — walking the workspace's index entries (fail safe).`);
    } else {
      const last = removal.rows[0] ?? null;
      if (!last) return null;
      const trusted = await trustedEvidence(orgId, [last], removal.actorKind);
      if (trusted?.[0] === true) {
        const prunedGrants = Number(last.details?.prunedAclGrants ?? 0);
        skip = !(prunedGrants > 0)
          || (!!last.timestamp && await removalWalkSettled(orgId, uid, last.timestamp));
      }
    }
    if (skip) return null;
    const libraries: string[] = [];
    for (let from = 0; from < 50_000; from += 1000) {
      const { data: libs, error: libErr } = await supabaseAdmin
        .from("libraries").select("id").eq("org_id", orgId).order("id", { ascending: true }).range(from, from + 999);
      if (libErr) {
        console.warn(`[create-user] ORG-7: the workspace's libraries could not be read (${libErr.message}) — stale index entries of ${uid} are left to the nightly rebuild.`);
        return { done: false, pruned: 0, calls: 0, error: libErr.message };
      }
      const page = (Array.isArray(libs) ? libs : []) as Array<{ id: string }>;
      libraries.push(...page.map((l) => String(l.id)));
      if (page.length < 1000) break;
    }
    if (libraries.length === 0) return null;
    const out = await pruneRemovedMemberAclIndex(supabaseAdmin as unknown as RpcClient, orgId, uid, { libraries, collections: [] }, {
      chunk: READD_ACL_INDEX_CHUNK, deadlineMs: READD_ACL_INDEX_BUDGET_MS,
    });
    if (out.unavailable) return null;
    if (!out.ok || !out.done) {
      console.warn(`[create-user] ORG-7: stale index entries of ${uid} were not all cleared before the re-add (${out.error ?? `budget of ${READD_ACL_INDEX_BUDGET_MS} ms reached after ${out.calls} call(s)`}) — the nightly rebuild finishes the clean-up.`);
    }
    return { done: out.ok && out.done, pruned: out.pruned, calls: out.calls, ...(out.error ? { error: out.error } : {}) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[create-user] ORG-7: clearing stale index entries of ${uid} failed (${msg}) — left to the nightly rebuild.`);
    return { done: false, pruned: 0, calls: 0, error: msg };
  }
}

/** The refusal every ambiguous-identity path lands on. Copies the pattern the
 *  projects member-picker already uses — select two, refuse on two — which was
 *  the only call site in the codebase defending against email collisions.
 *  The colliding auth uids are logged server-side for whoever reconciles,
 *  but NOT returned: the lookups are system-wide, so the ids can belong to
 *  other workspaces, and handing them to an org admin is a cross-org
 *  account-existence oracle (security-review finding). */
function identityCollisionResponse(email: string, ids: string[]) {
  console.warn(`[create-user] identity collision on ${email}: ${ids.length} accounts share the address`, ids);
  return NextResponse.json(
    {
      error: `Multiple accounts share the email ${email} — contact your admin. No role was granted.`,
      collisionCount: ids.length,
    },
    { status: 409 }
  );
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const { data: { user: caller }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { email: rawEmail, password, orgId, role, displayName } = await req.json() as {
    email: string;
    password: string;
    orgId: string;
    role: string;
    displayName?: string;
  };

  if (!rawEmail?.trim()) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }
  // Identity is matched and stored in one canonical form (IDENT-3) — the
  // lower(email) unique indexes are the database backstop.
  const email = normalizeEmail(rawEmail);

  // Only real roles may be granted. Without this, `role` is a free string
  // written straight to org_members.role/roles — a typo silently strands a
  // member with rights nothing recognizes, and it's an unvalidated write on
  // a service-role (RLS-bypassing) path.
  if (!(ALL_ROLES as string[]).includes(String(role))) {
    return NextResponse.json({ error: `Invalid role: ${String(role)}` }, { status: 400 });
  }
  const grantedRole = role as Role;

  // Verify caller is Admin or DocCtrl in the target org
  const { data: callerMember } = await supabaseAdmin
    .from("org_members")
    .select("role, roles")
    .eq("org_id", orgId)
    .eq("uid", caller.id)
    .eq("status", "active")
    .single();

  // ADD-1 / OWN-3: the controller tier follows the role COLLECTION.
  const callerHeld = new Set<string>([
    (callerMember?.role as string) || "",
    ...(((callerMember?.roles as string[] | null) ?? [])),
  ]);
  if (!callerMember || !(callerHeld.has("Admin") || callerHeld.has("DocCtrl"))) {
    return NextResponse.json({ error: "Forbidden: insufficient permissions" }, { status: 403 });
  }

  // SURF-15: adding a seat is THE billable mutation — the server-side
  // subscription gate finally has a caller. Per DEC-18 the refusal is behind
  // SUBSCRIPTION_ENFORCE so behaviour is byte-identical until billing is
  // switched on; off, the would-be 402 is logged, never silent. BILL-10
  // (admin-and-org Round G P5): through enforceOrgAccess, the ONE reading of
  // the switch the upload routes and the strip share (lib/serverAuth.ts).
  const gate = await enforceOrgAccess(supabaseAdmin, orgId, "create-user");
  if (gate) return NextResponse.json({ error: gate.error }, { status: gate.status });

  // Only an Admin may grant the Admin role. Without this a DocCtrl (who can
  // otherwise manage members) could mint an Admin and escalate — the RLS
  // guard on org_members doesn't apply here because this route uses the
  // service-role key, which bypasses RLS.
  // ADD-1: the caller's Admin hat counts however it is held.
  if (String(role) === "Admin" && !callerHeld.has("Admin")) {
    return NextResponse.json({ error: "Only an Admin can grant the Admin role" }, { status: 403 });
  }

  // Resolve the target auth user. Reuse an existing account when the email is
  // already registered — e.g. the person already signed in with Microsoft, or
  // they belong to another workspace — rather than failing on a duplicate email.
  //
  // This lookup decides WHICH HUMAN gets the role, so it fails loudly in both
  // directions (IDENT-2): a lookup error refuses rather than falling through
  // to account creation, and two profiles on one address refuse rather than
  // guessing. The case-insensitive match also finds rows stored before
  // normalization (IDENT-3).
  let userId: string | null = null;
  let createdNewUser = false;

  const { data: profileRows, error: profileLookupError } = await applyEmailLookup(
    supabaseAdmin.from("users").select("id, email"),
    "email",
    email
  ).limit(2);
  if (profileLookupError) {
    return NextResponse.json(
      { error: `Couldn't verify whether ${email} already has an account — try again. No role was granted.` },
      { status: 500 }
    );
  }
  const profiles = (profileRows ?? []) as Array<{ id: string; email: string | null }>;
  if (profiles.length > 1) {
    return identityCollisionResponse(email, profiles.map((p) => p.id));
  }
  if (profiles[0]?.id) {
    userId = profiles[0].id;
  }

  if (!userId) {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (data?.user) {
      userId = data.user.id;
      createdNewUser = true;
    } else {
      // Email may already exist in auth without a readable profile row.
      const recovered = await findAuthUsersByEmail(email);
      if (recovered === null) {
        return NextResponse.json(
          { error: `Couldn't resolve the account for ${email} — try again. No role was granted.` },
          { status: 500 }
        );
      }
      if (recovered.length > 1) {
        return identityCollisionResponse(email, recovered);
      }
      if (recovered.length === 1) {
        userId = recovered[0];
      } else {
        return NextResponse.json({ error: error?.message ?? "Failed to create user" }, { status: 400 });
      }
    }
  }

  // Create or refresh the org membership. Idempotent: re-adding an existing
  // member (re)activates them and ADDS the chosen role to their collection.
  // A transient lookup error must refuse here — misreading "member exists"
  // as "new member" would send an existing member down the insert path.
  // select("*") rather than naming columns: a pre-migration database has no
  // `roles` column, and naming it would turn every "Add member" call into a
  // 42703 error — the same pre-migration tolerance the roles seed below
  // promises. normalizeRoles handles the column's absence.
  const { data: existingMember, error: memberLookupError } = await supabaseAdmin
    .from("org_members")
    .select("*")
    .eq("org_id", orgId)
    .eq("uid", userId)
    .maybeSingle();
  if (memberLookupError) {
    return NextResponse.json(
      { error: `Couldn't check existing membership — try again. No role was granted.` },
      { status: 500 }
    );
  }

  // "Add member" doubles as a role grant on the re-add path. That means a
  // DocCtrl could re-add an existing Admin and alter their membership — an
  // unintended privilege change that the Admin-only guard above doesn't
  // catch because the NEW role isn't Admin. Only an Admin may alter an
  // existing Admin's membership. Checked against the roles COLLECTION too,
  // not just the mirrored headline, so a drifted headline can't hide an
  // Admin hat.
  const existingIsAdmin =
    existingMember &&
    (String(existingMember.role) === "Admin" ||
      normalizeRoles(existingMember.roles, existingMember.role as Role | undefined).includes("Admin"));
  if (existingIsAdmin && !callerHeld.has("Admin")) {
    return NextResponse.json({ error: "Only an Admin can change an existing Admin's role" }, { status: 403 });
  }

  if (existingMember) {
    // MERGE into the additive collection — never assign over it (ORGSEL-3).
    // The old `roles: [role]` write silently deleted every other hat the
    // member held: a DraftingSupervisor + DocCtrl re-added as DocCtrl came
    // out holding only DocCtrl, and the loss reached RLS via the mirrored
    // headline. Removing a role is the role editor's job, where it is
    // explicit. The headline is recomputed from the merged collection so
    // `role` can never rank below a role the member still holds.
    const merged = normalizeRoles(existingMember.roles, existingMember.role as Role | undefined);
    // ALOG-4: the state before this write, read before it (the audit row's "before").
    const beforeRoles = [...merged];
    const statusBefore = (existingMember.status as string | null) ?? null;
    const headlineBefore = (existingMember.role as string | null) ?? null;
    if (!merged.includes(grantedRole)) merged.push(grantedRole);
    const headline = primaryRole(merged);
    const { error: updateError } = await supabaseAdmin
      .from("org_members")
      .update({
        role: headline,
        roles: merged,
        status: "active",
        // Keep the existing display name unless the caller provided one —
        // the old write nulled it on every re-add (ORGSEL-5).
        display_name: displayName?.trim() ? displayName : (existingMember.display_name as string | null),
      })
      .eq("org_id", orgId)
      .eq("uid", userId);
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    // ALOG-4 (admin-and-org Round G, P8): a re-add that grants a role or
    // reactivates the member is a change of authority — recorded with the
    // actor, the subject and the roles before and after. Checked: a refused
    // write is returned (auditError) and shown, never swallowed.
    const added = merged.filter((r) => !beforeRoles.includes(r));
    let auditError: string | null = null;
    if (added.length > 0 || statusBefore !== "active") {
      const { error: aErr } = await supabaseAdmin.from("audit_logs").insert({
        action: statusBefore !== "active" ? "MEMBER_REACTIVATED" : "ROLE_GRANTED",
        resource_type: "org_member", resource_id: userId, org_id: orgId,
        user_id: caller.id, user_email: caller.email ?? null, user_role: callerHeld.has("Admin") ? "Admin" : "DocCtrl",
        details: { memberEmail: email, memberUid: userId, via: "add_member", added, before: beforeRoles, after: merged,
                   headlineBefore, headlineAfter: headline, statusBefore, statusAfter: "active" },
      });
      if (aErr) {
        auditError = aErr.message;
        console.error(`[create-user] audit row for the re-add of ${email} failed: ${aErr.message}`);
      }
    }

    // Refresh the profile email/display name; the membership row above is
    // the authority on roles.
    await supabaseAdmin.from("users").upsert({
      id: userId,
      email,
      ...(displayName?.trim() ? { display_name: displayName } : {}),
      updated_at: new Date().toISOString(),
    });

    await resolvePendingAccessRequests(orgId, email, userId);

    return NextResponse.json({ uid: userId, roles: merged, merged: true, ...(auditError ? { auditError } : {}) });
  }

  // ORG-7: a person removed earlier whose inherited index entries were not
  // all stripped is cleared BEFORE the membership exists again (the RPC
  // refuses once it does), within a time budget; the rest is the nightly
  // rebuild's. Never blocks the add.
  const aclIndexCleanup = userId ? await clearStaleInheritedAclIndex(orgId, userId) : null;

  const { error: memberError } = await supabaseAdmin
    .from("org_members")
    .insert({
      org_id: orgId,
      uid: userId,
      email,
      role,
      display_name: displayName ?? null,
      status: "active",
      created_by: caller.id,
      created_at: new Date().toISOString(),
    });

  if (memberError) {
    // Only roll back the auth user if THIS request created it.
    if (createdNewUser && userId) {
      await supabaseAdmin.auth.admin.deleteUser(userId);
    }
    // Two distinct unique backstops can fire here, and they mean different
    // things — do not conflate them (adversarial-review finding):
    //  · org_members_org_email_active_unique_ci → a DIFFERENT identity is
    //    already active on this email in this org: the IDENT-2 collision
    //    reaching the database. Refuse with the collision explanation.
    //  · UNIQUE(org_id, uid) → a concurrent request already added THIS
    //    identity (two admins double-adding): the membership exists; saying
    //    "another account" would be false.
    const code = (memberError as { code?: string }).code;
    const msg = memberError.message ?? "";
    if (/org_members_org_email_active_unique/i.test(msg)) {
      return NextResponse.json(
        {
          error: `Another account already holds an active membership for ${email} in this workspace — contact your admin. No role was granted.`,
        },
        { status: 409 }
      );
    }
    if (code === "23505") {
      return NextResponse.json(
        { error: `${email} was just added by a concurrent request — refresh the member list. This request made no changes.` },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: memberError.message }, { status: 500 });
  }

  // SURF-16: membership creation leaves a trail (MEMBER_% rides the admin-only
  // audit overlay from 20261045). ALOG-4 (P8): checked — a refused write is
  // returned (auditError) and shown, never swallowed — and it names the
  // subject and the roles before (none) and after.
  let createdAuditError: string | null = null;
  {
    const { error: aErr } = await supabaseAdmin.from("audit_logs").insert({
      action: "MEMBER_CREATED", resource_type: "member", resource_id: userId, org_id: orgId,
      user_id: caller.id, user_email: caller.email ?? null, user_role: callerHeld.has("Admin") ? "Admin" : "DocCtrl",
      details: { memberEmail: email, memberUid: userId, role, createdNewUser, before: [], after: [role] },
    });
    if (aErr) {
      createdAuditError = aErr.message;
      console.error(`[create-user] MEMBER_CREATED audit row for ${email} failed: ${aErr.message}`);
    }
  }

  // Seed the additive role collection to match the headline role. Best-effort:
  // if the `roles` column isn't present yet (pre-migration), this no-ops and
  // the app falls back to [role]. Never blocks user creation. Keyed on
  // (org_id, uid) it can only reach the row inserted above, never an
  // existing member's collection.
  await supabaseAdmin.from("org_members").update({ roles: [role] }).eq("org_id", orgId).eq("uid", userId);

  // Create / update the user profile. A brand-new account also gets this org
  // as its profile default — without it, an admin-created member's first
  // sign-in has no candidate workspace and resolves through the self-heal
  // pick (ORGSEL-1). An existing account's default is left alone: it may
  // deliberately point at another workspace.
  await supabaseAdmin.from("users").upsert({
    id: userId,
    email,
    display_name: displayName ?? null,
    ...(createdNewUser ? { default_org_id: orgId } : {}),
    updated_at: new Date().toISOString(),
  });

  await resolvePendingAccessRequests(orgId, email, userId);

  return NextResponse.json({ uid: userId, ...(createdAuditError ? { auditError: createdAuditError } : {}), ...(aclIndexCleanup ? { aclIndexCleanup } : {}) });
}
