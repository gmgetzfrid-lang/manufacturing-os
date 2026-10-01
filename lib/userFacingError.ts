// lib/userFacingError.ts — what a plant user reads when the database refuses
// (projects-tab REL-3 / UX-10).
//
// The Projects and Companies libraries used to hand `error.message` straight
// to the screen, so a superintendent read "new row violates row-level
// security policy for table \"cost_entries\"" or "relation
// \"public.cost_accounts\" does not exist". This is the one translator:
//
//   * RAW DRIVER TEXT is mapped to a plain sentence by a fixed table —
//     Postgres / PostgREST templates ("duplicate key value violates…",
//     "new row violates row-level security…", "permission denied for
//     table…", "relation … does not exist", PGRST116 / PGRST204 / PGRST205,
//     a statement timeout, a lock timeout, a dropped connection);
//   * a SENTENCE WRITTEN FOR USERS passes through untouched — the database
//     rails raise their own refusals (the intake door, the quality sign-off,
//     the closeout and money rails RAISE … USING ERRCODE = '42501' /
//     '23514' / '23505' / '23503', or plain P0001) and the libraries' own
//     messages are already plain; a code alone never decides, the message
//     template does;
//   * any other driver error (a SQLSTATE or PGRST code whose text is not a
//     sentence we know) becomes an "unexpected" line that names no table,
//     column or policy.
// Whenever the text is replaced, the raw detail goes to console.error for
// diagnosis — never to the screen.
//
// The missing-schema shapes are the ones lib/checkedWrite.ts already treats
// as a pending migration (kept here too so neither module imports the other).

export interface DbErrorLike {
  message?: string | null;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
}

export type UserFacingKind =
  | "permission" | "migration" | "duplicate" | "reference" | "required" | "invalid" | "rejected_value"
  | "busy" | "conflict" | "timeout" | "unavailable" | "not_found" | "session" | "network" | "unexpected" | "passthrough";

/** Sentences for a refused WRITE (nothing landed — a statement is atomic). */
const WRITE: Record<Exclude<UserFacingKind, "passthrough">, string> = {
  permission: "You don't have permission to do this — nothing was changed.",
  migration: "This needs the latest database migration applied — nothing was changed.",
  duplicate: "That already exists — nothing was changed.",
  reference: "Something this refers to has been removed, or is still in use — nothing was changed. Refresh and try again.",
  required: "A required value is missing — nothing was changed.",
  invalid: "A value isn't in the expected format — nothing was changed.",
  rejected_value: "That value isn't allowed here — nothing was changed.",
  busy: "Someone else is changing this right now — nothing was changed. Try again.",
  conflict: "Someone else changed this at the same moment — nothing was changed. Try again.",
  timeout: "The database took too long to answer — try again.",
  unavailable: "The database couldn't be reached just now — try again in a moment.",
  not_found: "That record wasn't found — it may have been removed, or you can't see it.",
  session: "Your session has expired — sign in again.",
  network: "Couldn't reach the server — check your connection and try again.",
  unexpected: "Something went wrong on the server — try again. If it keeps happening, tell your administrator.",
};

/** The REASON alone, for a sentence embedded after a lead-in that already
 *  says what happened — "X was saved, but Y was not: <reason>". A lead-in
 *  that reports a write which LANDED must never be followed by "nothing was
 *  changed", so the embedded form never says it (`embed: true`). */
const REASON: Record<Exclude<UserFacingKind, "passthrough">, string> = {
  permission: "You don't have permission to do this.",
  migration: "This needs the latest database migration applied.",
  duplicate: "That already exists.",
  reference: "Something this refers to has been removed, or is still in use — refresh and try again.",
  required: "A required value is missing.",
  invalid: "A value isn't in the expected format.",
  rejected_value: "That value isn't allowed here.",
  busy: "Someone else is changing this right now — try again.",
  conflict: "Someone else changed this at the same moment — try again.",
  timeout: WRITE.timeout,
  unavailable: WRITE.unavailable,
  not_found: WRITE.not_found,
  session: WRITE.session,
  network: WRITE.network,
  unexpected: WRITE.unexpected,
};

/** Sentences for a failed READ — every kind worded as a load; none says
 *  "nothing was changed" (a read changes nothing). */
const READ: Record<Exclude<UserFacingKind, "passthrough">, string> = {
  permission: "You don't have permission to see this.",
  migration: "This needs the latest database migration applied.",
  duplicate: "The database reported a duplicate record — refresh and try again.",
  reference: "Something this refers to has been removed — refresh and try again.",
  required: "A required value is missing from the request.",
  invalid: "A value in the request isn't in the expected format.",
  rejected_value: "A value in the request isn't allowed here.",
  busy: "Someone else is changing this right now — try again.",
  conflict: "Someone else changed this at the same moment — try again.",
  timeout: WRITE.timeout,
  unavailable: WRITE.unavailable,
  not_found: WRITE.not_found,
  session: WRITE.session,
  network: WRITE.network,
  unexpected: WRITE.unexpected,
};

const MISSING_SCHEMA_CODES = new Set(["42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"]);

/** The fixed table: a raw template (or a code whose text is always the
 *  driver's) → the kind of sentence. Order matters only where two could
 *  match; the first wins. */
const RULES: Array<{ kind: Exclude<UserFacingKind, "passthrough">; code?: RegExp; text?: RegExp }> = [
  { kind: "migration", code: /^(42P01|42703|42883|PGRST202|PGRST204|PGRST205)$/ },
  { kind: "migration", text: /relation "[^"]+" does not exist|column "[^"]+"( of relation "[^"]+")? does not exist|column [\w.]+ does not exist|function [\w.]+\(.*\) does not exist|in the schema cache/i },
  { kind: "permission", text: /new row violates row-level security policy|violates row-level security policy|permission denied for (table|relation|sequence|schema|function|view|column|database)\b/i },
  { kind: "duplicate", text: /duplicate key value violates unique constraint/i },
  { kind: "reference", text: /violates foreign key constraint/i },
  { kind: "required", text: /null value in column "?[^"\s]+"?.* violates not-null constraint/i },
  { kind: "rejected_value", text: /new row for relation "[^"]+" violates check constraint|violates check constraint "[^"]+"/i },
  { kind: "invalid", code: /^(22P02|22001|22003|22007|22008|22023|22P05)$/ },
  { kind: "invalid", text: /invalid input syntax for type|invalid input value for enum|value too long for type|out of range for type|numeric field overflow/i },
  { kind: "busy", code: /^55P03$/ },
  { kind: "busy", text: /could not obtain lock|canceling statement due to lock timeout|lock timeout/i },
  { kind: "conflict", code: /^(40001|40P01)$/ },
  { kind: "conflict", text: /deadlock detected|could not serialize access/i },
  { kind: "timeout", code: /^57014$/ },
  { kind: "timeout", text: /canceling statement due to statement timeout|statement timeout/i },
  { kind: "unavailable", code: /^PGRST00[0-3]$/ },
  { kind: "unavailable", text: /upstream (request )?timeout|Timed out acquiring connection|Could not connect (with|to|due to|when)/i },
  { kind: "not_found", code: /^PGRST116$/ },
  { kind: "not_found", text: /JSON object requested, multiple \(or no\) rows returned|Cannot coerce the result to a single JSON object/i },
  { kind: "session", code: /^PGRST30[0-3]$/ },
  { kind: "session", text: /JWT expired|invalid JWT|jwt malformed/i },
  { kind: "network", text: /^(TypeError: )?(Failed to fetch|NetworkError when attempting to fetch resource\.?|fetch failed|Load failed|Network request failed)$/i },
];

/** Codes the database's own rails raise with a sentence written for users;
 *  P0001 is plain RAISE EXCEPTION. A message under one of these that is not
 *  a driver template is the rail's own refusal — shown as written. */
const RAIL_CODES = new Set(["P0001", "42501", "23514", "23505", "23503", ""]);

/** A SQLSTATE (five characters, digits / upper-case letters) or a PostgREST code. */
const DRIVER_CODE = /^([0-9A-Z]{5}|PGRST\d{3})$/;

function normalize(err: unknown): DbErrorLike {
  if (err == null) return {};
  if (typeof err === "string") return { message: err };
  if (err instanceof Error) {
    const withCode = err as Error & { code?: unknown; details?: unknown; hint?: unknown };
    return {
      message: err.message,
      code: typeof withCode.code === "string" ? withCode.code : null,
      details: typeof withCode.details === "string" ? withCode.details : null,
      hint: typeof withCode.hint === "string" ? withCode.hint : null,
    };
  }
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    return {
      message: typeof o.message === "string" ? o.message : null,
      code: typeof o.code === "string" ? o.code : null,
      details: typeof o.details === "string" ? o.details : null,
      hint: typeof o.hint === "string" ? o.hint : null,
    };
  }
  return { message: String(err) };
}

/** Classify an error: which sentence it gets, or "passthrough" when its
 *  message is already a sentence for users. Pure — no logging. */
export function classifyDbError(err: unknown): UserFacingKind {
  const e = normalize(err);
  const code = (e.code ?? "").trim();
  const msg = (e.message ?? "").trim();
  if (MISSING_SCHEMA_CODES.has(code)) return "migration";
  for (const r of RULES) {
    if (r.code && r.code.test(code)) return r.kind;
    if (r.text && r.text.test(msg)) return r.kind;
  }
  if (!msg) return "unexpected";
  if (RAIL_CODES.has(code)) return "passthrough";
  if (DRIVER_CODE.test(code)) return "unexpected";
  return "passthrough";
}

export interface UserFacingOptions {
  action?: "read" | "write";
  context?: string;
  /** The sentence goes after a lead-in that already says what happened
   *  (a partial success: "X was saved, but Y was not: …") — the reason
   *  alone, never "nothing was changed". */
  embed?: boolean;
  /** The text sits INSIDE a sentence the caller finishes — in parentheses,
   *  "Could not delete “X” (<reason>) — nothing was changed." — so it is
   *  the reason alone (as `embed`, or the read wording for a read) with no
   *  closing full stop: never "….)" and never the caller's own tail twice. */
  clause?: boolean;
}

/** A finished sentence made a clause: its closing full stop dropped, for
 *  text already translated (a library's `error` field) that the caller
 *  places inside its own sentence. */
export function asClause(text: string): string {
  return text.trim().replace(/\.+$/, "");
}

/**
 * The sentence a user reads for `err` — a database / PostgREST error object,
 * an Error, or a string. `action: "read"` words the sentence for a failed
 * load (no "nothing was changed"); `embed: true` gives the reason alone, for
 * a lead-in that reports a write which landed; `clause: true` gives the
 * reason alone without its full stop, for text placed inside the caller's
 * own sentence. `context` labels the console line. When the text is
 * replaced, the raw detail is logged with console.error.
 */
export function userFacingError(err: unknown, opts: UserFacingOptions = {}): string {
  const kind = classifyDbError(err);
  const e = normalize(err);
  if (kind === "passthrough") return opts.clause ? asClause(e.message ?? "") : (e.message ?? "").trim();
  const text = (opts.action === "read" ? READ : opts.embed || opts.clause ? REASON : WRITE)[kind];
  try {
    console.error(`[userFacingError]${opts.context ? ` ${opts.context}:` : ""} ${kind}`, {
      code: e.code ?? null, message: e.message ?? null, details: e.details ?? null, hint: e.hint ?? null,
    });
  } catch { /* logging must never break the refusal */ }
  return opts.clause ? asClause(text) : text;
}

/** For a failed load: the read-worded sentence. */
export function userFacingReadError(err: unknown, context?: string): string {
  return userFacingError(err, { action: "read", context });
}

/** Driver wording that sits just BEFORE the part a template matches (the
 *  foreign-key and schema-cache texts name the table first). */
const DRIVER_PREAMBLE = /(?:(?:insert or update|update or delete) on table "[^"]*"|Could not (?:find|choose)\b[\s\S]*?)\s*$/i;
/** What must never reach the screen around a replaced fragment. */
const LEAKS = /"[a-z_][\w.]*"|'[a-z_][\w.]*'|\brelation\b|\bconstraint\b|\bpolicy\b|\bschema\b|\bPGRST|\bSQLSTATE|\bpublic\.|row-level/i;

/** Where the leftmost known driver template starts inside `msg`, or -1. */
function driverFragmentAt(msg: string): number {
  let at = -1;
  for (const r of RULES) {
    if (!r.text) continue;
    const m = r.text.exec(msg);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  return at;
}

/**
 * A CAUGHT error's text for the screen (projects REL-3), for a call site
 * that shows whatever a library threw. A library outside the translated set
 * may wrap raw driver text in its own sentence — "The new revision is
 * published, but the prior revision could not be marked superseded: <driver
 * text>". Translating the whole would drop what DID happen and claim nothing
 * changed, so the library's lead-in is kept and only the driver fragment is
 * replaced — by the REASON alone (the embedded form: never "nothing was
 * changed" after a lead-in, which may report a write that landed). What
 * follows a parenthesised fragment, or a new sentence after it, is kept
 * too. A lead-in or tail that would itself name a table, column or policy is
 * dropped. A message with no driver text passes through untouched; a bare
 * driver message becomes its full sentence. The raw detail is logged exactly
 * as userFacingError logs it.
 */
export function userFacingCaughtError(err: unknown, opts: UserFacingOptions = {}): string {
  // A clause is the reason alone (as embed) without its closing full stop.
  if (opts.clause) return asClause(userFacingCaughtError(err, { ...opts, clause: false, embed: true }));
  const kind = classifyDbError(err);
  const e = normalize(err);
  const msg = (e.message ?? "").trim();
  if (kind === "passthrough") return msg;
  const at = driverFragmentAt(msg);
  const before = at > 0 ? msg.slice(0, at).replace(DRIVER_PREAMBLE, "") : "";
  const paren = /\(\s*$/.test(before);
  const lead = before.replace(/[\s:;,(—–-]+$/, "").trim();
  if (!lead || LEAKS.test(lead) || driverFragmentAt(lead) >= 0) return userFacingError(err, opts);
  // A kept lead-in says what happened (often a write that LANDED — "The new
  // revision is published, but …"), so what follows it is the reason alone.
  const sentence = userFacingError(err, { ...opts, embed: true });
  let rest = "";
  if (paren) {
    // the fragment runs to the parenthesis that closes it
    let depth = 1, i = at;
    for (; i < msg.length && depth > 0; i++) {
      if (msg[i] === "(") depth++;
      else if (msg[i] === ")") depth--;
    }
    rest = depth === 0 ? msg.slice(i).trim() : "";
  } else {
    // the fragment runs to the end, or to a new sentence after it
    const next = /\.\s+(?=[A-Z])/.exec(msg.slice(at));
    rest = next ? msg.slice(at + next.index + next[0].length).trim() : "";
  }
  if (rest && (LEAKS.test(rest) || driverFragmentAt(rest) >= 0)) rest = "";
  if (paren) return `${lead} (${sentence.replace(/\.$/, "")})${rest ? `${/^[.,;:]/.test(rest) ? "" : " "}${rest}` : "."}`;
  return `${lead}: ${sentence}${rest ? ` ${rest.replace(/^[.,;:\s]+/, "")}` : ""}`;
}
