// notifications N13 LAYERS SWEEP — drafting-flow EDGE-14 (with notifications
// TAX-9 done-when 1). `notification_preferences.inapp_enabled` was added for
// "the unified dispatcher" and nothing ever read it; the dispatcher's
// docblock claimed every channel honoured "per-user, per-channel
// preferences". The integrator's ruling (DEC-90, at the N13 launch): honour
// it only if it is wired end to end today — it is not (no reader, no writer,
// no settings switch) — otherwise drop the dead field and correct the
// docblock, whichever changes no delivered notification. The column itself
// stays (DEC-74: deprecated and kept, a dropped column cannot be restored;
// ratified at the N3 merge); no app code carries it, and the docblock now
// says what each channel honours.
//
// Pinned here: no code reads or writes `inapp_enabled`; the bell row is
// written whatever the preference row says (so no delivered notification
// changed); the docblock names the bell as never suppressible.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { resetState, type MemoryState } from "./helpers/memoryDb";

const h = vi.hoisted(() => ({ state: null as unknown as MemoryState }));

vi.mock("@/lib/supabase", async () => {
  const mem = await import("./helpers/memoryDb");
  h.state = mem.freshState();
  return { supabase: mem.makeSupabase(h.state) };
});
vi.mock("@/lib/notifications", () => ({ queueEmail: vi.fn(async () => {}) }));

import { emit } from "@/lib/notify/dispatch";

const ORG = "o-1";

function seed(inappEnabled: boolean) {
  resetState(h.state);
  h.state.tables.org_members = [
    { org_id: ORG, uid: "actor", status: "active", role: "Engineer", roles: null, email: "actor@example.com" },
    { org_id: ORG, uid: "u-1", status: "active", role: "Engineer", roles: null, email: "u-1@example.com" },
  ];
  h.state.tables.notification_preferences = [
    { user_id: "u-1", email_enabled: true, inapp_enabled: inappEnabled, push_enabled: true, toast_enabled: true },
  ];
  h.state.tables.notifications = [];
}

/** Every string literal and identifier in the app's code (comments excluded). */
function codeTokens(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, src);
  const out: string[] = [];
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) {
    if (k === ts.SyntaxKind.Identifier || k === ts.SyntaxKind.StringLiteral || k === ts.SyntaxKind.NoSubstitutionTemplateLiteral
      || k === ts.SyntaxKind.TemplateHead || k === ts.SyntaxKind.TemplateMiddle || k === ts.SyntaxKind.TemplateTail) {
      out.push(scanner.getTokenText());
    }
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "__tests__" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

beforeEach(() => seed(true));

describe("EDGE-14 — inapp_enabled is dead in code and changes no delivery", () => {
  it("no code in app/, components/, hooks/ or lib/ reads or writes inapp_enabled (comments may name it)", () => {
    const files = ["app", "components", "hooks", "lib"].flatMap((d) => walk(resolve(d)));
    const hits = files.filter((f) => codeTokens(f).some((t) => /inapp_?enabled/i.test(t)));
    expect(hits.map((f) => relative(process.cwd(), f))).toEqual([]);
  }, 120_000);

  it("the bell row is written whatever inapp_enabled says — false, true or no preference row (as before: nothing read it)", async () => {
    const input = {
      orgId: ORG, category: "status" as const, kind: "ticket_status" as const, title: "REQ-12 advanced", body: "Moved to drafting.",
      link: "/requests/t-1", resource: { type: "ticket" as const, id: "t-1" }, actorUserId: "actor", actorName: "Dana",
      audience: { involved: ["u-1"] }, channels: ["inapp" as const],
    };
    for (const pref of [false, true, null] as const) {
      seed(pref ?? true);
      if (pref === null) h.state.tables.notification_preferences = [];
      await emit(input);
      expect((h.state.tables.notifications ?? []).map((r) => r.user_id), String(pref)).toEqual(["u-1"]);
    }
  });

  it("the dispatcher's docblock no longer claims per-channel preferences for every channel: the bell is never suppressible, and inapp_enabled is named deprecated", () => {
    const head = readFileSync(resolve("lib/notify/dispatch.ts"), "utf8").split("\n").slice(0, 40).join("\n");
    expect(head).not.toMatch(/each\s+honou?ring per-user, per-channel preferences/);
    expect(head).toMatch(/a bell row is always written/);
    expect(head).toMatch(/inapp_enabled[\s\S]{0,40}deprecated and read by nothing/);
  });
});
