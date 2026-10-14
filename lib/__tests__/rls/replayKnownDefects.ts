// What the fresh replay is known to hit today, each with its finding and
// owner (intelligence I-17, IRLS-6; DEC-90 ruling 3). A file that cannot run
// in filename order is REPORTED here — never edited by the harness — and the
// replay test holds this list to the truth both ways: a failure not listed
// fails the opt-in run, and a listed failure that no longer happens fails it
// too (so the entry is removed when its owner lands the fix).
//
// Measured on PostgreSQL 16.13 with pgvector 0.6.0, 2026-10-14.

/**
 * supabase/schema.sql cannot run as one script on an empty database (the
 * documented first step of a fresh install), so the harness runs it statement
 * by statement in autocommit and holds the statements that fail to this exact
 * multiset of messages. Every object they would have made is (re)made by the
 * numbered migrations, which the fresh-install census then checks.
 * Finding: intelligence IRLS-17 (owner: the integrator, to route).
 */
export const BASELINE_KNOWN_ERRORS: readonly string[] = [
  // :319-331 project_documents references projects (created at :933)
  'relation "projects" does not exist',
  'relation "project_documents" does not exist',
  'relation "project_documents" does not exist',
  'relation "project_documents" does not exist',
  // :400 document_versions has no archived_at column in this file
  'column "archived_at" does not exist',
  // :501 the CREATE EXTENSION pg_trgm sits at the end of a comment line
  'operator class "gin_trgm_ops" does not exist for access method "gin"',
  // :656-663 milestones references projects (created at :933)
  'relation "projects" does not exist',
  'relation "milestones" does not exist',
  'relation "milestones" does not exist',
  'relation "milestones" does not exist',
  'relation "milestones" does not exist',
  'relation "milestones" does not exist',
  'relation "milestones" does not exist',
  // :1392-1395 RLS enabled on tables only the migrations create
  'relation "project_documents" does not exist',
  'relation "document_assets" does not exist',
  'relation "milestones" does not exist',
];

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

export const OUT_OF_ORDER_FILES: readonly OutOfOrderFile[] = [
  {
    file: "20260630_perf_indexes.sql",
    error: /relation "team_members" does not exist/,
    finding: "intelligence IRLS-18",
    owner: "the integrator, to route (team_members is created by 20260707_teams.sql)",
    mode: "retry",
  },
  {
    file: "20261075_dc_roundF_checkout_episode_seal.sql",
    error: /syntax error at or near "check"/,
    finding: "intelligence IRLS-19",
    owner: "document-control (DCK-14's file; the integrator to route)",
    mode: "unparseable",
  },
];

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
 * grant migration (INTK-14 / DRLS-16).
 */
export const CHECKPOINTS: readonly string[] = ["20261217"];
