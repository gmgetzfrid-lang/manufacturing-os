// lib/dataRestore.ts
//
// Restore / re-import planner — the reconciliation brain for bringing a client
// back from a backup (Machine B). PURE + deterministic so it can be unit-tested
// without a database: given a backup envelope and the CURRENT workspace's
// context it produces a RestorePlan the admin previews and approves BEFORE any
// write happens.
//
// Principles (from the product spec):
//   • Users are ADDITIVE BY EMAIL — an email already in the workspace re-links
//     to the existing person; an unknown email becomes an inactive "restored"
//     placeholder (no paid seat) to be re-invited. Auth creds are never restored.
//   • ORG-NAME COLLISIONS ("Acme" vs "Acme Inc.") are surfaced for the admin to
//     choose — never auto-merged.
//   • Old IDs are REMAPPED to the current workspace (org_id always; uid per the
//     email reconciliation) so foreign keys land correctly.
//   • Nothing is trusted blindly: incomplete backups and missing files surface
//     as warnings.

export interface RestoreEnvelopeLike {
  manifest: {
    orgId: string;
    orgName?: string;
    schemaVersion?: string;
    complete?: boolean;
    files?: { count?: number; missing?: number };
  };
  tables: Record<string, unknown[]>;
  files?: Array<{ path: string }>;
}

export interface CurrentMember { uid: string; email: string }
export interface CurrentOrgContext {
  orgId: string;
  orgName: string;
  /** Active members of the target workspace (the join key is email). */
  members: CurrentMember[];
}

export type UserDisposition = "linked" | "new";
export interface UserReconcileItem {
  oldUid: string;
  email: string;
  displayName?: string;
  role?: string;
  disposition: UserDisposition;
  /** Present when disposition === "linked": the existing workspace uid. */
  newUid?: string;
}

export interface TablePlanItem {
  name: string;
  rows: number;
  willImport: boolean;
  reason?: string;
}

export interface RestorePlan {
  schemaVersion?: string;
  targetOrgId: string;
  /** Non-null when the backup's org name differs from the current one — the
   *  admin must pick which to keep. */
  orgNameCollision: { backupName: string; currentName: string } | null;
  users: UserReconcileItem[];
  idRemap: {
    /** Always maps the backup org_id → the current workspace org_id. */
    orgId: Record<string, string>;
    /** old uid → existing uid, for emails already in the workspace. New users
     *  get their uid at apply time (not known until the row is created). */
    uid: Record<string, string>;
  };
  counts: {
    matchedUsers: number;
    newUsers: number;
    totalRows: number;
    files: number;
    tables: TablePlanItem[];
  };
  warnings: string[];
}

const norm = (s: string | undefined | null) => (s ?? "").trim().toLowerCase();

// Tables never imported by blind insert — identity/auth/config is handled by
// reconciliation, not copied over the top of the live workspace.
const SKIP_TABLES: Record<string, string> = {
  orgs: "target workspace already exists; org name is reconciled separately",
  org_members: "membership is rebuilt from the user reconciliation",
  users: "user profiles are created via the additive-by-email reconciliation",
  notification_preferences: "per-user settings are re-established on re-invite",
};

interface BackupMember { uid?: string; email?: string; display_name?: string; role?: string }

/** Build the reconciliation plan for restoring `env` into `current`. Pure. */
export function planRestore(env: RestoreEnvelopeLike, current: CurrentOrgContext): RestorePlan {
  const warnings: string[] = [];
  const backupOrgId = env.manifest.orgId;
  const targetOrgId = current.orgId;

  // ── Org-name collision ──────────────────────────────────────────────────
  const backupName = (env.manifest.orgName ?? "").trim();
  const currentName = (current.orgName ?? "").trim();
  const orgNameCollision =
    backupName && currentName && norm(backupName) !== norm(currentName)
      ? { backupName, currentName }
      : null;

  // ── User reconciliation (additive by email) ─────────────────────────────
  const existingByEmail = new Map<string, string>(); // email -> uid
  for (const m of current.members) {
    if (m.email) existingByEmail.set(norm(m.email), m.uid);
  }

  const members = (env.tables.org_members as BackupMember[] | undefined) ?? [];
  const seenEmail = new Set<string>();
  const users: UserReconcileItem[] = [];
  for (const m of members) {
    const email = norm(m.email);
    if (!email || seenEmail.has(email)) continue; // dedupe by email
    seenEmail.add(email);
    const existing = existingByEmail.get(email);
    users.push({
      oldUid: m.uid ?? "",
      email: (m.email ?? "").trim(),
      displayName: m.display_name,
      role: m.role,
      disposition: existing ? "linked" : "new",
      newUid: existing,
    });
  }

  const idRemap = {
    orgId: { [backupOrgId]: targetOrgId } as Record<string, string>,
    uid: {} as Record<string, string>,
  };
  for (const u of users) {
    if (u.disposition === "linked" && u.oldUid && u.newUid) idRemap.uid[u.oldUid] = u.newUid;
  }

  // ── Per-table import plan ────────────────────────────────────────────────
  const tables: TablePlanItem[] = [];
  let totalRows = 0;
  for (const [name, rows] of Object.entries(env.tables)) {
    const n = Array.isArray(rows) ? rows.length : 0;
    const skip = SKIP_TABLES[name];
    tables.push({ name, rows: n, willImport: !skip, reason: skip });
    if (!skip) totalRows += n;
  }
  tables.sort((a, b) => b.rows - a.rows);

  // ── Warnings ─────────────────────────────────────────────────────────────
  if (env.manifest.complete === false) {
    warnings.push("This backup was marked INCOMPLETE — some tables were not exported. Restoring it will not fully reconstruct the workspace.");
  }
  const missing = env.manifest.files?.missing ?? 0;
  if (missing > 0) {
    warnings.push(`${missing} referenced file(s) had no binary in the backup and cannot be restored.`);
  }
  if (orgNameCollision) {
    warnings.push(`Org name differs: backup "${orgNameCollision.backupName}" vs current "${orgNameCollision.currentName}". Choose which to keep before applying.`);
  }
  if (users.length === 0) {
    warnings.push("No members found in the backup (org_members empty) — users cannot be reconciled.");
  }

  const matchedUsers = users.filter((u) => u.disposition === "linked").length;

  return {
    schemaVersion: env.manifest.schemaVersion,
    targetOrgId,
    orgNameCollision,
    users,
    idRemap,
    counts: {
      matchedUsers,
      newUsers: users.length - matchedUsers,
      totalRows,
      files: env.files?.length ?? env.manifest.files?.count ?? 0,
      tables,
    },
    warnings,
  };
}

/** Apply the org/uid remap to a single row's foreign keys. Returns a new row
 *  object; never mutates the input. Used by the apply path (one place, tested
 *  here) so remapping is consistent across every table. */
export function remapRow(
  row: Record<string, unknown>,
  idRemap: RestorePlan["idRemap"],
): Record<string, unknown> {
  const out = { ...row };
  if (typeof out.org_id === "string" && idRemap.orgId[out.org_id]) {
    out.org_id = idRemap.orgId[out.org_id];
  }
  // Common uid-bearing columns across the schema. Only remap when we have a
  // mapping (linked users); unmapped uids belong to not-yet-created new users
  // and are resolved at apply time.
  for (const col of UID_COLUMNS) {
    const v = out[col];
    if (typeof v === "string" && idRemap.uid[v]) out[col] = idRemap.uid[v];
  }
  return out;
}

// Columns that reference a user id somewhere in the schema. Kept explicit so a
// remap never silently misses a foreign key.
export const UID_COLUMNS = [
  "uid", "user_id", "created_by", "updated_by", "actor_user_id", "assigned_to",
  "triggered_by", "to_user_id", "reviewer_id", "owner_id", "approved_by",
  "checked_by", "drawn_by",
] as const;
