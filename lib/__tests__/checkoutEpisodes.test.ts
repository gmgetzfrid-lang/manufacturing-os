// lib/__tests__/checkoutEpisodes.test.ts
//
// The checkout-episode state machine. These tests freeze the rules the whole
// checkout system hangs off:
//
//   * an episode closes ONLY when the last active session ends
//   * the lock TRANSFERS (never silently clears) when the holder leaves
//     while collaborators remain
//   * the collaborator display list is rebuilt from session rows, never
//     patched from a stale array

import { describe, it, expect } from "vitest";
import {
  pickNextLockHolder,
  computeCheckInTransition,
  activeCollaboratorNames,
  isMissingEpisodeSchema,
  type SessionLite,
} from "@/lib/checkoutEpisodes";

const s = (
  id: string,
  userId: string,
  userName: string | null,
  startedAt: string | null,
): SessionLite => ({ id, userId, userName, startedAt });

const ALICE = s("sess-a", "user-alice", "alice", "2026-06-01T08:00:00Z");
const BOB = s("sess-b", "user-bob", "bob", "2026-06-01T09:00:00Z");
const CARA = s("sess-c", "user-cara", "cara", "2026-06-01T10:00:00Z");

describe("pickNextLockHolder", () => {
  it("picks the longest-running remaining session", () => {
    expect(pickNextLockHolder([ALICE, BOB, CARA], "user-alice")?.userId).toBe("user-bob");
    expect(pickNextLockHolder([CARA, BOB], "user-bob")?.userId).toBe("user-cara");
  });

  it("excludes every session of the leaver (multi-session user)", () => {
    const aliceSecond = s("sess-a2", "user-alice", "alice", "2026-06-01T07:00:00Z");
    expect(pickNextLockHolder([ALICE, aliceSecond, CARA], "user-alice")?.userId).toBe("user-cara");
  });

  it("returns null when nobody remains", () => {
    expect(pickNextLockHolder([ALICE], "user-alice")).toBeNull();
    expect(pickNextLockHolder([], "user-alice")).toBeNull();
  });

  it("breaks startedAt ties deterministically by session id", () => {
    const x = s("sess-1", "user-x", "x", "2026-06-01T09:00:00Z");
    const y = s("sess-2", "user-y", "y", "2026-06-01T09:00:00Z");
    expect(pickNextLockHolder([y, x], "user-z")?.id).toBe("sess-1");
    expect(pickNextLockHolder([x, y], "user-z")?.id).toBe("sess-1");
  });

  it("sorts sessions with unknown start time last", () => {
    const unknown = s("sess-u", "user-u", "u", null);
    expect(pickNextLockHolder([unknown, BOB], "user-z")?.userId).toBe("user-bob");
  });
});

describe("computeCheckInTransition", () => {
  it("closes the episode when the last participant leaves", () => {
    const t = computeCheckInTransition({
      sessions: [ALICE],
      leavingUserId: "user-alice",
      lockHolderId: "user-alice",
    });
    expect(t.kind).toBe("close");
  });

  it("closes when the leaver's rows are already ended (empty list)", () => {
    const t = computeCheckInTransition({
      sessions: [],
      leavingUserId: "user-alice",
      lockHolderId: "user-alice",
    });
    expect(t.kind).toBe("close");
  });

  it("TRANSFERS the lock when the holder leaves and others remain", () => {
    const t = computeCheckInTransition({
      sessions: [ALICE, BOB, CARA],
      leavingUserId: "user-alice",
      lockHolderId: "user-alice",
    });
    expect(t.kind).toBe("transfer");
    if (t.kind === "transfer") expect(t.next.userId).toBe("user-bob");
  });

  it("transfers to the senior remaining session, not insertion order", () => {
    const t = computeCheckInTransition({
      sessions: [CARA, BOB], // cara listed first but bob started earlier
      leavingUserId: "user-zed",
      lockHolderId: "user-zed",
    });
    expect(t.kind).toBe("transfer");
    if (t.kind === "transfer") expect(t.next.userId).toBe("user-bob");
  });

  it("leaves the lock alone when a non-holder collaborator checks in", () => {
    const t = computeCheckInTransition({
      sessions: [ALICE, BOB],
      leavingUserId: "user-bob",
      lockHolderId: "user-alice",
    });
    expect(t.kind).toBe("remain");
  });

  it("treats a lockless document with remaining sessions as 'remain' (reconcile owns repair)", () => {
    const t = computeCheckInTransition({
      sessions: [ALICE, BOB],
      leavingUserId: "user-bob",
      lockHolderId: null,
    });
    expect(t.kind).toBe("remain");
  });

  it("compares holder ids loosely (string/uuid type drift tolerated)", () => {
    const t = computeCheckInTransition({
      sessions: [ALICE, BOB],
      leavingUserId: "user-alice",
      lockHolderId: `${"user-alice"}`,
    });
    expect(t.kind).toBe("transfer");
  });
});

describe("activeCollaboratorNames", () => {
  it("rebuilds the display list from session rows, deduped", () => {
    const twice = s("sess-a2", "user-alice", "alice", null);
    expect(activeCollaboratorNames([ALICE, twice, BOB])).toEqual(["alice", "bob"]);
  });

  it("drops empty and whitespace-only names", () => {
    const blank = s("sess-x", "user-x", "  ", null);
    const nul = s("sess-y", "user-y", null, null);
    expect(activeCollaboratorNames([blank, nul, CARA])).toEqual(["cara"]);
  });

  it("returns [] for no sessions — the state that previously left zombies", () => {
    expect(activeCollaboratorNames([])).toEqual([]);
  });
});

describe("isMissingEpisodeSchema", () => {
  it("recognizes missing-table / missing-column codes", () => {
    expect(isMissingEpisodeSchema({ code: "42P01", message: "x" })).toBe(true);
    expect(isMissingEpisodeSchema({ code: "42703", message: "x" })).toBe(true);
    expect(isMissingEpisodeSchema({ code: "PGRST204", message: "x" })).toBe(true);
    expect(isMissingEpisodeSchema({ code: "PGRST205", message: "x" })).toBe(true);
  });

  it("recognizes schema-cache messages mentioning the episode objects", () => {
    expect(isMissingEpisodeSchema({
      message: "Could not find the table 'public.checkout_episodes' in the schema cache",
    })).toBe(true);
    expect(isMissingEpisodeSchema({
      message: "column \"episode_id\" does not exist",
    })).toBe(true);
  });

  it("does NOT swallow unrelated errors", () => {
    expect(isMissingEpisodeSchema({ code: "23505", message: "duplicate key" })).toBe(false);
    expect(isMissingEpisodeSchema({ message: "permission denied for table documents" })).toBe(false);
    expect(isMissingEpisodeSchema(null)).toBe(false);
    expect(isMissingEpisodeSchema(undefined)).toBe(false);
  });
});
