// @vitest-environment jsdom
//
// notifications Round G, N1 PREFS-GATE — /settings/notifications on the
// RENDERED page, against the real CHECK constraint text.
//
//   NEDGE-2 / DELIV-12: the page wrote digest_frequency = 'immediate'; the
//     CHECK (20260529_phase_b_notifications.sql:77-78) admits only
//     ('instant','hourly','daily','never'), so the first save of every member
//     with no row was refused. The first test is the reproduction: it fails on
//     the pre-N1 page.
//   RT-10: the in-app card states what is always on and, once the toast
//     listener honours it, offers the pop-up toggle (toast_enabled).
//   Regression: a member whose row predates toast_enabled (or whose database
//     has not had 20261148 pasted yet) loads and saves.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Err = { code?: string; message: string; details?: string } | null;
const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  loadError: null as Err,
  upserts: [] as Array<Record<string, unknown>>,
  upsertResults: [] as Array<{ error: Err }>,
  toastHonoured: false,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "notification_preferences") throw new Error(`unexpected table ${table}`);
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: db.loadError ? null : db.row, error: db.loadError }),
        upsert: async (row: Record<string, unknown>) => {
          db.upserts.push(row);
          return db.upsertResults.shift() ?? { data: null, error: null };
        },
      });
      return q;
    },
    auth: { getSession: async () => ({ data: { session: null } }) },
  },
}));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ uid: "u1" }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/lib/notificationPrefs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    get TOAST_PREFERENCE_HONOURED() { return db.toastHonoured; },
  };
});

import NotificationSettingsPage from "@/app/(protected)/settings/notifications/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The one CHECK on digest_frequency, read from the migration that defines it.
const CHECK = (() => {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20260529_phase_b_notifications.sql"), "utf8");
  const m = sql.match(/CHECK \(digest_frequency IN \(([^)]*)\)\)/);
  if (!m) throw new Error("digest_frequency CHECK not found");
  return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
})();

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  db.row = null;
  db.loadError = null;
  db.upserts.length = 0;
  db.upsertResults.length = 0;
  db.toastHonoured = false;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const byText = (sel: string, text: RegExp) =>
  [...host.querySelectorAll(sel)].find((el) => text.test(el.textContent ?? "")) as HTMLElement | undefined;
const sw = (label: string) => host.querySelector(`[role="switch"][aria-label="${label}"]`) as HTMLButtonElement | null;
const mount = async () => {
  await act(async () => { root.render(React.createElement(NotificationSettingsPage)); });
  await flush();
};
const save = async () => {
  await act(async () => { byText("button", /Save preferences/)!.click(); });
  await flush();
};

describe("NEDGE-2 / DELIV-12 — a member with no row saves the defaults", () => {
  it("the first save carries a digest_frequency the CHECK admits, and says Saved", async () => {
    await mount();
    await save();
    expect(db.upserts).toHaveLength(1);
    expect(CHECK).toContain(db.upserts[0].digest_frequency);
    expect(db.upserts[0].digest_frequency).toBe("instant");
    expect(host.textContent).toMatch(/Saved/);
    expect(host.textContent).not.toMatch(/check constraint/i);
  });

  it("the defaults saved are exactly the column defaults (all on, instant), for this user", async () => {
    await mount();
    await save();
    expect(db.upserts[0]).toEqual({
      user_id: "u1",
      email_enabled: true, email_on_mention: true, email_on_assignment: true, email_on_status_change: true,
      email_on_watched_activity: true, email_on_sla_warning: true, toast_enabled: true, digest_frequency: "instant",
    });
  });

  it("offers only what the backend honours: Immediately and Never (Hourly / Daily are not offered)", async () => {
    await mount();
    const cadence = byText("div", /^Delivery cadence$/)!.parentElement!;
    const labels = [...cadence.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["Immediately", "Never"]);
    await act(async () => { byText("button", /^Never$/)!.click(); });
    await save();
    expect(db.upserts[0].digest_frequency).toBe("never");
  });

  it("a check violation is reported as one, distinctly, with nothing claimed saved", async () => {
    db.upsertResults.push({ error: { code: "23514", message: 'new row for relation "notification_preferences" violates check constraint "notification_preferences_digest_frequency_check"' } });
    await mount();
    await save();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/refused a preference value/);
    expect(alert?.textContent).toMatch(/notification_preferences_digest_frequency_check/);
    expect(host.textContent).not.toMatch(/Saved/);
  });

  it("any other refusal is shown as itself", async () => {
    db.upsertResults.push({ error: { code: "42501", message: "new row violates row-level security policy" } });
    await mount();
    await save();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/row-level security/);
  });
});

describe("a row that predates toast_enabled loads and saves", () => {
  const LEGACY = {
    user_id: "u1", email_enabled: true, email_on_mention: false, email_on_assignment: true,
    email_on_status_change: true, email_on_watched_activity: false, email_on_sla_warning: true,
    inapp_enabled: true, push_enabled: true, digest_frequency: "instant", updated_at: "2026-06-01T00:00:00Z",
  };

  it("the stored toggles render as stored, and Save writes them back unchanged", async () => {
    db.row = { ...LEGACY };
    await mount();
    expect(sw("Mentions")?.getAttribute("aria-checked")).toBe("false");
    expect(sw("Watched activity")?.getAttribute("aria-checked")).toBe("false");
    expect(sw("Assignments")?.getAttribute("aria-checked")).toBe("true");
    await save();
    expect(db.upserts[0]).toMatchObject({ email_on_mention: false, email_on_watched_activity: false, email_on_assignment: true, digest_frequency: "instant" });
    // never touches the columns the page does not own (push_enabled is N10's; inapp_enabled is deprecated)
    expect(db.upserts[0]).not.toHaveProperty("push_enabled");
    expect(db.upserts[0]).not.toHaveProperty("inapp_enabled");
  });

  it("before 20261148 is pasted (toast_enabled unknown to the API) the save retries without it and succeeds", async () => {
    db.row = { ...LEGACY };
    db.upsertResults.push({ error: { code: "PGRST204", message: "Could not find the 'toast_enabled' column of 'notification_preferences' in the schema cache" } });
    await mount();
    await save();
    expect(db.upserts).toHaveLength(2);
    expect(db.upserts[0]).toHaveProperty("toast_enabled");
    expect(db.upserts[1]).not.toHaveProperty("toast_enabled");
    expect(db.upserts[1]).toMatchObject({ email_on_mention: false });
    expect(host.textContent).toMatch(/Saved/);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("a stored Hourly / Daily (accepted by the CHECK, never implemented) shows Immediately and says so", async () => {
    db.row = { ...LEGACY, digest_frequency: "hourly" };
    await mount();
    expect(host.textContent).toMatch(/“Hourly” was never implemented/);
    const selected = byText("button", /^Immediately$/)!;
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    await save();
    expect(db.upserts[0].digest_frequency).toBe("instant");
  });

  it("a failed load is shown and Save is refused, so the defaults never overwrite a row that could not be read", async () => {
    db.loadError = { code: "57014", message: "canceling statement due to statement timeout" };
    await mount();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/statement timeout/);
    const btn = byText("button", /Save preferences/)!;
    expect(btn.hasAttribute("disabled")).toBe(true);
    await act(async () => { btn.click(); });
    expect(db.upserts).toHaveLength(0);
  });
});

describe("RT-10 — the in-app card", () => {
  it("states that bell notifications are always on (the durable record)", async () => {
    await mount();
    expect(host.textContent).toMatch(/Bell notifications are always on/);
  });

  it("does not offer a pop-up toggle until the toast listener reads it (an inert switch is the bug this page had)", async () => {
    db.toastHonoured = false;
    await mount();
    expect(sw("Pop-up toasts")).toBeNull();
  });

  it("once honoured, the toggle renders from the row and saves toast_enabled", async () => {
    db.toastHonoured = true;
    db.row = { user_id: "u1", toast_enabled: true, digest_frequency: "instant" };
    await mount();
    const t = sw("Pop-up toasts")!;
    expect(t.getAttribute("aria-checked")).toBe("true");
    await act(async () => { t.click(); });
    await save();
    expect(db.upserts[0].toast_enabled).toBe(false);
  });

  it("toast off saved before the column exists: the rest saves and the page says the toast setting did not", async () => {
    db.toastHonoured = true;
    db.upsertResults.push({ error: { code: "PGRST204", message: "Could not find the 'toast_enabled' column of 'notification_preferences' in the schema cache" } });
    await mount();
    await act(async () => { sw("Pop-up toasts")!.click(); });
    await save();
    expect(db.upserts).toHaveLength(2);
    expect(host.textContent).toMatch(/pop-up setting was not saved/i);
  });
});
