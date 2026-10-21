// What the fresh replay is known to hit today, each with its finding and
// owner (intelligence I-17, IRLS-6; DEC-90 ruling 3). A file that cannot run
// in filename order is REPORTED here — never edited by the harness — and the
// replay test holds this list to the truth both ways: a failure not listed
// fails the opt-in run, and a listed failure that no longer happens fails it
// too (so the entry is removed when its owner lands the fix).
//
// Measured on PostgreSQL 16.13 with pgvector 0.6.0, 2026-10-14.

/**
 * The error supabase/schema.sql stops on when it is sent as ONE script — the
 * editor's way, which is how the replay sends it — on an empty database. An
 * error anywhere rolls the whole paste back, so the list holds at most one.
 * Empty since 2026-10-14 (intelligence I-27, IRLS-17): the file runs as one
 * script with zero errors. Until then it stopped at :328 (project_documents
 * referenced projects, created at :933), the harness ran it statement by
 * statement instead, and 16 statements failed even so (the forward
 * references, an index on a column the file never made, a CREATE EXTENSION
 * hidden at the end of a comment line, and RLS switched on for tables only
 * the migrations create).
 */
export const BASELINE_KNOWN_ERRORS: readonly string[] = [];

export interface OutOfOrderFile {
  file: string;
  /** The error the file stops on when replayed in filename order. */
  error: RegExp;
  finding: string;
  owner: string;
  /**
   * "retry": the whole file rolled back on a missing object; it is run once
   * more after the sequence (as an operator re-pasting it would), and must
   * then succeed. "unparseable": a syntax error — PostgreSQL parses the whole
   * script before running any of it, so nothing in the file ever applies and
   * a re-run cannot help; its objects are absent from the replay.
   */
  mode: "retry" | "unparseable";
}

// Empty since 2026-10-14 (intelligence I-27): every numbered migration
// replays in filename order. The two files this list held left it when their
// owner landed the fix:
//   * 20261075_dc_roundF_checkout_episode_seal.sql (IRLS-19): its final
//     SELECT's bare `check` is quoted in place, so the file parses and
//     applies as one paste;
//   * 20260630_perf_indexes.sql (IRLS-18): its team_members index runs only
//     when the table exists (20260707 builds the same index with the table),
//     so the file no longer rolls back on a fresh install.
// A file that cannot run in filename order is listed here again, with its
// finding and owner, until it is fixed.
export const OUT_OF_ORDER_FILES: readonly OutOfOrderFile[] = [];

/**
 * A file that refuses on purpose until its operator says the deploy it waits
 * on is live. The harness gives the documented switch for that file only —
 * the step the file's own message tells the operator to take.
 */
export const OPERATOR_SWITCHES: Readonly<Record<string, Record<string, string>>> = {
  // "uncomment the line  SET app.j11_deployed = 'yes';" (SEC-19, J11)
  "20261141_prj_roundG_intake_token_hash_and_adoption.sql": { "app.j11_deployed": "yes" },
};

/**
 * Snapshot databases taken just BEFORE a file runs, so a test can prove the
 * app works before and after that paste (DEC-30). 20261217 is I-17's own
 * grant migration (INTK-14 / DRLS-16); 20261224 is I-28's (INTK-19: every
 * policy that calls the bound helpers answers the same before and after it);
 * 20261261 is I-34's (DACL-11: every reader who can read both documents of a
 * supersession reads the same rows before and after its read rail); 20261131
 * (document control's documents rails) is there for I-34 too: 20261261 pasted
 * before 20261131 refuses and changes nothing, so 20261131 still reads every
 * check true.
 */
export const CHECKPOINTS: readonly string[] = ["20261131", "20261217", "20261224", "20261261"];
