// lib/assetIdentity.ts
//
// The pure half of the registry's identity review and the server re-decode
// (CB-6): what a stored site code says against what the codebook as it
// stands derives. Split out of lib/assetCategorize.ts at the I-16 merge so
// a server route (app/api/admin/codebook) can import it without pulling in
// lib/assets.ts, which carries React hooks a route bundle refuses.
// lib/assetCategorize.ts re-exports every name here, so its callers are
// unchanged.

import { codeToTag, tagToCode, type Codebook } from "@/lib/codebook";
import type { Asset } from "@/lib/assets";

export type IdentityFields = Pick<Asset, "id" | "tag" | "unit_code" | "code">;

/** AREA-11: the unit a stored site code names, when it contradicts the
 *  asset's filing. Null when they agree, when either is blank, or when the
 *  codebook cannot place the code (no opinion is not a conflict). */
export function codeUnitConflict(a: IdentityFields, book: Codebook): { codeUnit: string; unitCode: string } | null {
  if (!a.code || !a.unit_code) return null;
  const decoded = codeToTag(a.code, book);
  if (!decoded) return null;
  return decoded.unitCode !== a.unit_code ? { codeUnit: decoded.unitCode, unitCode: a.unit_code } : null;
}

export interface IdentityReviewRow {
  assetId: string;
  tag: string;
  unitCode: string | null;
  code: string | null;
  /** code_names_other_unit — AREA-11: the code says one unit, the filing another.
   *  code_rederives — CB-6: the codebook as it stands derives a different code
   *  (a padding, type-code or prefix edit since the code was written).
   *  derived_code_taken — CB-10: filed, no code, and the code the codebook
   *  derives is already carried by another asset (one site code is one
   *  asset) — a person gives this one its own code. */
  kind: "code_names_other_unit" | "code_rederives" | "derived_code_taken";
  /** The unit the stored code names (code_names_other_unit). */
  codeUnit: string | null;
  /** What the current codebook derives for (tag, unit_code); null = it cannot. */
  derivedCode: string | null;
  /** derived_code_taken: the asset that already carries derivedCode. */
  heldBy?: { id: string; tag: string; archived: boolean } | null;
}

/** The re-decode plan: every asset whose stored identity disagrees with the
 *  codebook as it stands. Pure. A blank code the codebook can derive is the
 *  categorizer's fill-blank job (codeAssignments), not a disagreement —
 *  unless another asset already carries that code (CB-10: derived_code_taken;
 *  `codeHolders`, every asset of the org with archived ones included,
 *  defaults to `assets`). */
export function planIdentityReview(
  assets: ReadonlyArray<IdentityFields>,
  book: Codebook,
  codeHolders: ReadonlyArray<IdentityFields & { archived?: boolean }> = assets,
): IdentityReviewRow[] {
  const out: IdentityReviewRow[] = [];
  const holderOf = new Map<string, { id: string; tag: string; archived: boolean }>();
  for (const h of codeHolders) {
    const c = (h.code ?? "").trim() ? h.code! : null;
    if (c && !holderOf.has(c)) holderOf.set(c, { id: h.id, tag: h.tag, archived: !!h.archived });
  }
  for (const a of assets) {
    if (a.unit_code && !(a.code ?? "").trim()) {
      const derived = tagToCode(a.tag, a.unit_code, book);
      const holder = derived ? holderOf.get(derived) : undefined;
      if (derived && holder && holder.id !== a.id) {
        out.push({ assetId: a.id, tag: a.tag, unitCode: a.unit_code, code: null, kind: "derived_code_taken", codeUnit: null, derivedCode: derived, heldBy: holder });
      }
      continue;
    }
    if (!a.unit_code || !a.code) continue;
    const derived = tagToCode(a.tag, a.unit_code, book);
    const conflict = codeUnitConflict(a, book);
    if (conflict) {
      out.push({ assetId: a.id, tag: a.tag, unitCode: a.unit_code, code: a.code, kind: "code_names_other_unit", codeUnit: conflict.codeUnit, derivedCode: derived });
    } else if (derived && derived !== a.code) {
      out.push({ assetId: a.id, tag: a.tag, unitCode: a.unit_code, code: a.code, kind: "code_rederives", codeUnit: null, derivedCode: derived });
    }
  }
  return out;
}

// ─── Server re-decode (CB-6) ──────────────────────────────────────────────
//
// The identity review's code_rederives rows, as ONE admin-triggered job
// (POST /api/admin/codebook, "redecode-preview" then "redecode-apply"). The
// plan is the review's own (planIdentityReview, unchanged), narrowed to what
// a job may write without a person's judgement: a filed asset whose stored
// code the codebook as it stands derives differently, re-derived from its
// own tag and filing. The filing (unit_code) is the job's INPUT and is never
// rewritten here — a unit moves only through a rename (rename_codebook_code)
// or a person. A code naming another unit than the filing (AREA-11) and a
// derived code another asset already carries (CB-10) are listed, never
// written: a person decides those under Identity review. The apply writes
// exactly these rows, each only while the asset still carries the stored
// code (compare-and-set) — preview = apply (redecodeDigest).

export interface RedecodeRow {
  assetId: string;
  tag: string;
  unitCode: string;
  /** The stored code — the value the write re-checks before it lands. */
  from: string;
  /** What the codebook as it stands derives for (tag, unitCode). */
  to: string;
  /** The codebook version the stored code was written under (20261178);
   *  null: written before the version existed, or the column is absent. */
  codebookVersion: number | null;
}

export interface RedecodeSkip {
  assetId: string;
  tag: string;
  from: string;
  to: string | null;
  /** names_other_unit — the stored code says another unit than the filing
   *  (AREA-11); taken — another asset already carries the derived code, or
   *  an earlier row of this plan takes it (CB-10). */
  reason: "names_other_unit" | "taken";
}

export interface RedecodePlan {
  rows: RedecodeRow[];
  skipped: RedecodeSkip[];
}

/** Pure. `assets` are the rows the job may rewrite (the active registry, as
 *  the Identity review lists it); `codeHolders` every asset of the org with
 *  a code, archived included (who already carries a code). */
export function planRedecode(
  assets: ReadonlyArray<IdentityFields & { codebook_version?: number | null }>,
  book: Codebook,
  codeHolders: ReadonlyArray<IdentityFields & { archived?: boolean }> = assets,
): RedecodePlan {
  const rows: RedecodeRow[] = [];
  const skipped: RedecodeSkip[] = [];
  const holderOf = new Map<string, string>();
  for (const h of codeHolders) {
    const c = (h.code ?? "").trim() ? h.code! : null;
    if (c && !holderOf.has(c)) holderOf.set(c, h.id);
  }
  const versionOf = new Map(assets.map((a) => [a.id, a.codebook_version ?? null] as const));
  const claimed = new Set<string>();
  for (const r of planIdentityReview(assets, book, codeHolders)) {
    // A blank code the codebook derives is the categorizer's fill, not a re-decode.
    if (r.kind === "derived_code_taken") continue;
    if (r.kind === "code_names_other_unit") {
      skipped.push({ assetId: r.assetId, tag: r.tag, from: r.code ?? "", to: r.derivedCode, reason: "names_other_unit" });
      continue;
    }
    const to = r.derivedCode as string; // code_rederives: derived, and not the stored code
    const holder = holderOf.get(to);
    if ((holder && holder !== r.assetId) || claimed.has(to)) {
      skipped.push({ assetId: r.assetId, tag: r.tag, from: r.code ?? "", to, reason: "taken" });
      continue;
    }
    claimed.add(to);
    rows.push({ assetId: r.assetId, tag: r.tag, unitCode: r.unitCode as string, from: r.code as string, to, codebookVersion: versionOf.get(r.assetId) ?? null });
  }
  return { rows, skipped };
}

/** The canonical text of what an apply would write — the route hashes it
 *  into the preview's token and re-hashes the plan it recomputes at apply:
 *  equal tokens, equal writes. The version is display only and left out (a
 *  version that moved without changing any row changes nothing written). */
export function redecodeDigest(rows: ReadonlyArray<Pick<RedecodeRow, "assetId" | "unitCode" | "from" | "to">>): string {
  return JSON.stringify(rows.map((r) => [r.assetId, r.unitCode, r.from, r.to]));
}
