// lib/inputValidation.ts
//
// Defensive input layer. Two complementary jobs:
//
//   1. translatePostgresError(error) — convert raw Postgres error
//      codes ("23505: duplicate key value violates unique constraint
//      ...") into plain-language user messages. So when a typo slips
//      through client-side validation, the user sees a useful
//      message instead of database internals.
//
//   2. live duplicate-check helpers (used by DuplicateAwareInput) —
//      queries a table for an existing row matching a value, so the
//      form can warn the user BEFORE they submit. Debounced; cheap
//      because every check is an indexed equality on a single column.
//
// Designed to be the only place that knows about Postgres error
// codes — callers ask "is this a duplicate?" not "what does 23505
// mean?".

import { supabase } from "@/lib/supabase";

// ─── Postgres error translation ─────────────────────────────────

export interface FriendlyError {
  /** Short heading for a toast / banner. */
  heading: string;
  /** Optional longer message with concrete next-step suggestion. */
  message: string;
  /** Raw code if the caller wants to branch on it. */
  code?: string;
}

interface ErrorTranslationContext {
  /** What was the user creating? Used in the message. */
  entity?: string;        // "asset", "project", "plant", "unit"…
  /** Which field caused the conflict, if knowable. */
  field?: string;         // "tag", "code"
}

/** Translate a thrown error (or Supabase error object) into a
 *  user-facing FriendlyError. Falls back to the raw message if we
 *  can't recognize the code. */
export function translatePostgresError(
  err: unknown,
  ctx: ErrorTranslationContext = {}
): FriendlyError {
  const code = extractCode(err);
  const rawMessage = extractMessage(err);
  const entity = ctx.entity ?? "record";
  const field = ctx.field;

  switch (code) {
    case "23505": {
      // Unique violation. Try to extract the constraint name to
      // make the message more specific.
      const constraint = extractConstraint(rawMessage);
      // Special-case the document uniqueness constraint with an
      // actionable hint pointing at the column manager.
      if (constraint && /documents_library_(uniqkey|docnumber)_uniq/.test(constraint)) {
        return {
          code,
          heading: "Same document number already in this library",
          message:
            "Another active document in this library has the same number. If your library legitimately reuses numbers across sheets/variants, open the Column Manager and tick a column (e.g. Sheet) to include in the uniqueness key — that lets the same number coexist when the other field differs.",
        };
      }
      const fieldText = field ? `with that ${field}` : "with those values";
      return {
        code,
        heading: `That ${entity} already exists`,
        message: `An existing ${entity} ${fieldText} is already in the system${constraint ? ` (constraint: ${constraint})` : ""}. Edit the existing one or change what you're entering here.`,
      };
    }
    case "23503":
      return {
        code,
        heading: "Referenced item not found",
        message: `Couldn't link this ${entity} — one of the references it points at no longer exists. Refresh the page; if the problem persists, the referenced item may have been deleted.`,
      };
    case "23502": {
      const fieldText = field ? `"${field}"` : "A required field";
      return {
        code,
        heading: `${fieldText} is required`,
        message: `Fill it in and try again.`,
      };
    }
    case "23514":
      return {
        code,
        heading: "Value not allowed",
        message: `One of the values doesn't match the allowed list. ${rawMessage}`,
      };
    case "42501":
      return {
        code,
        heading: "Not permitted",
        message: `You don't have permission to do that. Talk to an Admin if you think this is wrong.`,
      };
    case "42P01":
      return {
        code,
        heading: "Database table missing",
        message: `The expected table doesn't exist — the database may be behind on migrations. Contact support / DocCtrl.`,
      };
    case "PGRST301": // PostgREST: no rows returned where one was expected
      return {
        code,
        heading: "Not found",
        message: `That ${entity} doesn't exist (or you don't have access to it).`,
      };
    default:
      return {
        code,
        heading: `Couldn't save ${entity}`,
        message: rawMessage || "Something went wrong. Try again, or contact support if it persists.",
      };
  }
}

function extractCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.code === "string") return e.code;
  // Some errors bury the code inside a string "23505: duplicate key…"
  const msg = typeof e.message === "string" ? e.message : "";
  const m = msg.match(/\b(\d{5})\b/);
  return m ? m[1] : undefined;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
  }
  return "Unknown error";
}

function extractConstraint(msg: string): string | undefined {
  // Postgres message format: '... violates unique constraint "name_uniq"'
  const m = msg.match(/unique constraint "([^"]+)"/);
  return m ? m[1] : undefined;
}

// ─── Duplicate-check helpers (used by DuplicateAwareInput) ──────

export interface DuplicateCheckParams {
  /** Postgres table to query. */
  table: string;
  /** Column to check the value against. */
  column: string;
  /** The value to look up. */
  value: string;
  /** Optional scope filters (e.g. {org_id: '...'}). */
  scope?: Record<string, string | number | boolean | null>;
  /** Optional normalization applied to the value before comparing.
   *  Use this when the column is itself a normalized form, e.g.
   *  assets.tag_normalized. */
  normalize?: (s: string) => string;
  /** When editing, exclude the row being edited from the conflict
   *  check (so updating "name" to itself doesn't flag a conflict). */
  excludeId?: string;
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  /** The id of the existing row (when isDuplicate=true). Useful for
   *  "edit the existing one" deep-links. */
  existingId?: string;
  /** Raw existing record fields the caller might want to surface. */
  existingRow?: Record<string, unknown>;
}

export async function checkForDuplicate(p: DuplicateCheckParams): Promise<DuplicateCheckResult> {
  const value = p.normalize ? p.normalize(p.value) : p.value;
  if (!value.trim()) return { isDuplicate: false };

  let q = supabase.from(p.table).select("*").eq(p.column, value).limit(1);
  if (p.scope) {
    for (const [k, v] of Object.entries(p.scope)) {
      q = v === null ? q.is(k, null) : q.eq(k, v);
    }
  }
  if (p.excludeId) q = q.neq("id", p.excludeId);

  const { data, error } = await q.maybeSingle();
  if (error && error.code !== "PGRST116") {
    // PGRST116 = no rows found, which is the not-duplicate happy case
    return { isDuplicate: false };
  }
  if (data) {
    return { isDuplicate: true, existingId: (data as { id?: string }).id, existingRow: data as Record<string, unknown> };
  }
  return { isDuplicate: false };
}

// ─── Local string validators ────────────────────────────────────

/** Strip whitespace, collapse internal whitespace runs to a single space. */
export function tidyWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Minimum-effort length / non-empty check. Returns null if valid,
 *  or a user-facing reason string. */
export function requiredField(value: string, name: string, opts?: { minLength?: number; maxLength?: number }): string | null {
  const trimmed = value.trim();
  if (!trimmed) return `${name} is required.`;
  if (opts?.minLength && trimmed.length < opts.minLength) {
    return `${name} must be at least ${opts.minLength} characters.`;
  }
  if (opts?.maxLength && trimmed.length > opts.maxLength) {
    return `${name} must be ${opts.maxLength} characters or fewer.`;
  }
  return null;
}
