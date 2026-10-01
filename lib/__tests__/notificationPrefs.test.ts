// lib/__tests__/notificationPrefs.test.ts
//
// notifications Round G, N1 PREFS-GATE — one vocabulary, one email rule.
//
//   * DIGEST_FREQUENCIES / PREF_DEFAULTS against the SQL that defines the
//     table: the CHECK list and every column default, read from the
//     migrations (NEDGE-2 / DELIV-12: the page's 'immediate' was in no SQL
//     file, so the first save of every member with no row was refused).
//   * shouldSendForEvent (the app's rule) against email_gate()'s CASE in
//     20261148 (the database's copy of the same rule): equal, event by event.
//   * readToastPreference fails open (RT-10's consumer, N3, relies on it).
//   * the toast switch is offered exactly when the listener reads it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const q = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as null | { code: string; message: string } },
  throws: null as null | Error,
  calls: [] as Array<{ table: string; select?: string; eq?: [string, unknown] }>,
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const call: { table: string; select?: string; eq?: [string, unknown] } = { table };
      q.calls.push(call);
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: (c: string) => { call.select = c; return b; },
        eq: (c: string, v: unknown) => { call.eq = [c, v]; return b; },
        maybeSingle: async () => { if (q.throws) throw q.throws; return q.result; },
      });
      return b;
    },
  },
}));

import {
  DIGEST_FREQUENCIES, OFFERED_DIGEST_FREQUENCIES, DIGEST_LABELS, PREF_DEFAULTS, TOAST_PREFERENCE_HONOURED,
  normalizeDigestFrequency, prefsFromRow, shouldSendForEvent, emailAllowedByPrefs,
  isMissingColumnError, isCheckViolation, isMissingEmailGate, readToastPreference,
  type NotificationPrefs,
} from "@/lib/notificationPrefs";
import { categoryToEventType, type NotifCategory } from "@/lib/notify/dispatch";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const strip = (sql: string) => sql.replace(/--[^\n]*/g, "");
const MIG = "supabase/migrations";
const numbered = readdirSync(join(root, MIG)).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const P529 = strip(read(`${MIG}/20260529_phase_b_notifications.sql`));
const P1148 = strip(read(`${MIG}/20261148_notif_roundG_prefs_gate.sql`));
/** email_gate()'s body as the database stores it (prosrc). */
const GATE_BODY = (() => {
  const at = P1148.indexOf("CREATE OR REPLACE FUNCTION email_gate");
  const open = P1148.indexOf("AS $$", at) + "AS $$".length;
  return P1148.slice(open, P1148.indexOf("$$;", open));
})();

const checkList = (sql: string) => {
  const m = sql.match(/CHECK \(digest_frequency IN \(([^)]*)\)\)/);
  if (!m) throw new Error("no digest_frequency CHECK");
  return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
};

describe("NEDGE-2 / DELIV-12 — the vocabulary is the CHECK's", () => {
  it("DIGEST_FREQUENCIES is the CHECK list, in order (20260529 and the schema.sql baseline)", () => {
    expect([...DIGEST_FREQUENCIES]).toEqual(checkList(P529));
    expect([...DIGEST_FREQUENCIES]).toEqual(checkList(strip(read("supabase/schema.sql"))));
  });

  it("the CHECK is defined once and never altered or widened by a later migration", () => {
    const defs = numbered.filter((f) => /CHECK \(digest_frequency IN/.test(strip(read(`${MIG}/${f}`))));
    expect(defs).toEqual(["20260529_phase_b_notifications.sql"]);
    const alters = numbered.filter((f) => /ALTER[^;]*digest_frequency/i.test(strip(read(`${MIG}/${f}`))));
    expect(alters).toEqual([]);
    // the old spelling exists in no SQL that runs
    for (const f of numbered) expect(strip(read(`${MIG}/${f}`)), f).not.toMatch(/'immediate'/);
  });

  it("PREF_DEFAULTS equals every column default (20260529 + toast_enabled from 20261148), so the defaults round-trip", () => {
    const sqlDefaults: Record<string, string> = {};
    for (const m of P529.matchAll(/^\s*(\w+) (?:BOOLEAN|TEXT) NOT NULL DEFAULT ('?\w+'?)/gm)) sqlDefaults[m[1]] = m[2];
    const toast = P1148.match(/ADD COLUMN IF NOT EXISTS toast_enabled BOOLEAN NOT NULL DEFAULT (TRUE|FALSE)/);
    expect(toast).not.toBeNull();
    sqlDefaults.toast_enabled = toast![1];
    for (const [k, v] of Object.entries(PREF_DEFAULTS)) {
      const expected = typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : `'${v}'`;
      expect(sqlDefaults[k], k).toBe(expected);
    }
    expect(DIGEST_FREQUENCIES).toContain(PREF_DEFAULTS.digest_frequency);
  });

  it("the page offers only values the CHECK admits, and labels the default 'Immediately'", () => {
    for (const v of OFFERED_DIGEST_FREQUENCIES) expect(DIGEST_FREQUENCIES).toContain(v);
    expect([...OFFERED_DIGEST_FREQUENCIES]).toEqual(["instant", "never"]);
    expect(DIGEST_LABELS.instant).toBe("Immediately");
  });

  it("the settings page takes its vocabulary from here and spells no cadence of its own", () => {
    const page = read("app/(protected)/settings/notifications/page.tsx");
    expect(page).not.toMatch(/"immediate"/);
    expect(page).not.toMatch(/"hourly"|"daily"/);
    expect(page).toMatch(/from "@\/lib\/notificationPrefs"/);
    expect(page).toMatch(/OFFERED_DIGEST_FREQUENCIES\.map/);
    expect(page).toMatch(/useState<Prefs>\(\{ \.\.\.PREF_DEFAULTS \}\)/);
  });

  it("legacy values read into the CHECK vocabulary; a row missing a column reads its default", () => {
    expect(normalizeDigestFrequency("immediate")).toBe("instant");
    expect(normalizeDigestFrequency("hourly")).toBe("hourly");
    expect(normalizeDigestFrequency("never")).toBe("never");
    expect(normalizeDigestFrequency(null)).toBe("instant");
    expect(normalizeDigestFrequency("weekly")).toBe("instant");
    expect(prefsFromRow(null)).toEqual(PREF_DEFAULTS);
    // a row that predates toast_enabled (and carries the deprecated / push columns)
    expect(prefsFromRow({ user_id: "u", email_enabled: false, email_on_mention: false, inapp_enabled: false, push_enabled: false, digest_frequency: "never" }))
      .toEqual({ ...PREF_DEFAULTS, email_enabled: false, email_on_mention: false, digest_frequency: "never" });
    expect(prefsFromRow({ toast_enabled: false }).toast_enabled).toBe(false);
  });
});

// ── the email rule, and its database copy ───────────────────────────────────

const TOGGLES = [
  "email_on_mention", "email_on_assignment", "email_on_status_change", "email_on_watched_activity", "email_on_sla_warning",
] as const satisfies ReadonlyArray<keyof NotificationPrefs>;
const CATEGORIES: NotifCategory[] = ["mention", "assignment", "status", "watched", "sla", "system", "recall", "safety"];

/** email_gate()'s CASE, event → column, read from the migration. */
function sqlCase(): Map<string, string> {
  const body = GATE_BODY;
  const block = body.slice(body.indexOf("v_toggle := CASE p_event_type"), body.indexOf("END;", body.indexOf("v_toggle := CASE")));
  const out = new Map<string, string>();
  for (const m of block.matchAll(/WHEN '(\w+)'\s+THEN v_prefs\.(\w+)/g)) out.set(m[1], m[2]);
  expect(block).toMatch(/ELSE true\s*$/);
  return out;
}

/** shouldSendForEvent's mapping, derived by BEHAVIOUR: the column whose false
 *  alone silences the event. */
function tsMapping(events: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    for (const col of TOGGLES) {
      const row = { ...PREF_DEFAULTS, [col]: false };
      if (!shouldSendForEvent(row, e)) out.set(e, col);
    }
  }
  return out;
}

describe("DELIV-2 — one rule, evaluated in the app and in email_gate()", () => {
  const sql = sqlCase();
  const events = [...new Set([...sql.keys(), ...CATEGORIES.map(categoryToEventType), "compliance_digest", "anything_else"])];

  it("email_gate's per-event CASE equals shouldSendForEvent, event by event", () => {
    expect(sql.size).toBe(9);
    expect(tsMapping(events)).toEqual(sql);
  });

  it("recall and safety mail has no toggle in either copy", () => {
    for (const c of ["recall", "safety"] as const) {
      const e = categoryToEventType(c);
      expect(sql.has(e)).toBe(false);
      expect(tsMapping([e]).size).toBe(0);
    }
    expect(GATE_BODY).not.toMatch(/safety_recall|safety_alert/);
    expect(read("lib/notificationPrefs.ts")).not.toMatch(/case "safety_/);
  });

  it("both copies stop on the master switch and on 'never' before the toggle", () => {
    expect(GATE_BODY).toMatch(/IF v_prefs\.email_enabled IS FALSE THEN RETURN false; END IF;\s*IF v_prefs\.digest_frequency = 'never' THEN RETURN false; END IF;\s*v_toggle := CASE/);
    for (const e of events) {
      expect(emailAllowedByPrefs({ ...PREF_DEFAULTS, email_enabled: false }, e), e).toBe(false);
      expect(emailAllowedByPrefs({ ...PREF_DEFAULTS, digest_frequency: "never" }, e), e).toBe(false);
      expect(emailAllowedByPrefs({ ...PREF_DEFAULTS }, e), e).toBe(true);
      expect(emailAllowedByPrefs(null, e), e).toBe(true);
    }
  });

  it("hourly and daily send as instant in both copies (nothing batches them)", () => {
    for (const d of ["hourly", "daily", "instant"]) {
      expect(emailAllowedByPrefs({ ...PREF_DEFAULTS, digest_frequency: d }, "comment_mention")).toBe(true);
    }
    expect(GATE_BODY).not.toMatch(/'hourly'|'daily'/);
  });

  it("the rule lives here once: lib/notifications.ts imports it and defines no switch of its own", () => {
    const lib = read("lib/notifications.ts");
    expect(lib).toMatch(/import \{ emailAllowedByPrefs, isMissingEmailGate \} from "@\/lib\/notificationPrefs";/);
    expect(lib).not.toMatch(/function shouldSendForEvent/);
    expect(lib).not.toMatch(/case "comment_mention"/);
  });
});

describe("error classifiers", () => {
  it("isMissingEmailGate: PGRST202, or 42883 naming email_gate — never a 42883 raised inside the body", () => {
    expect(isMissingEmailGate({ code: "PGRST202", message: "Could not find the function public.email_gate" })).toBe(true);
    expect(isMissingEmailGate({ code: "42883", message: "function public.email_gate(uuid, uuid, text, text) does not exist" })).toBe(true);
    expect(isMissingEmailGate({ code: "42883", message: "function auth.role() does not exist" })).toBe(false);
    expect(isMissingEmailGate({ code: "42501", message: "email_gate: not an active member of this workspace" })).toBe(false);
    expect(isMissingEmailGate(null)).toBe(false);
  });

  it("isMissingColumnError names the column; isCheckViolation is 23514 only", () => {
    expect(isMissingColumnError({ code: "PGRST204", message: "Could not find the 'toast_enabled' column of 'notification_preferences' in the schema cache" }, "toast_enabled")).toBe(true);
    expect(isMissingColumnError({ code: "42703", message: "column notification_preferences.toast_enabled does not exist" }, "toast_enabled")).toBe(true);
    expect(isMissingColumnError({ code: "PGRST204", message: "Could not find the 'other' column" }, "toast_enabled")).toBe(false);
    expect(isCheckViolation({ code: "23514", message: "violates check constraint" })).toBe(true);
    expect(isCheckViolation({ code: "23505", message: "duplicate key" })).toBe(false);
  });
});

describe("RT-10 — readToastPreference fails open", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    q.result = { data: null, error: null };
    q.throws = null;
    q.calls.length = 0;
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it("reads only toast_enabled, for this member", async () => {
    q.result = { data: { toast_enabled: false }, error: null };
    expect(await readToastPreference("u1")).toBe(false);
    expect(q.calls).toEqual([{ table: "notification_preferences", select: "toast_enabled", eq: ["user_id", "u1"] }]);
  });

  it("no row, a stored true, no uid: toasts on", async () => {
    expect(await readToastPreference("u1")).toBe(true);
    q.result = { data: { toast_enabled: true }, error: null };
    expect(await readToastPreference("u1")).toBe(true);
    expect(await readToastPreference(null)).toBe(true);
    expect(q.calls).toHaveLength(2);
  });

  it("before 20261148 (the column is unknown): toasts on, quietly", async () => {
    q.result = { data: null, error: { code: "42703", message: "column notification_preferences.toast_enabled does not exist" } };
    expect(await readToastPreference("u1")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("any other failure: toasts on, and a warning", async () => {
    q.result = { data: null, error: { code: "57014", message: "statement timeout" } };
    expect(await readToastPreference("u1")).toBe(true);
    q.throws = new Error("network down");
    expect(await readToastPreference("u1")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("RT-10 — the toast switch is offered exactly when the listener honours it", () => {
  it("TOAST_PREFERENCE_HONOURED flips with NotificationListener reading the preference — through readToastPreference or toast_enabled directly (N3 flips both)", () => {
    // N3 runs in parallel from a base without lib/notificationPrefs.ts, so it
    // may read the column itself; either spelling counts as reading it.
    const listener = read("components/providers/NotificationListener.tsx");
    expect(TOAST_PREFERENCE_HONOURED).toBe(/readToastPreference|toast_enabled/.test(listener));
  });
});
