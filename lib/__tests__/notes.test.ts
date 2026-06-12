// lib/__tests__/notes.test.ts
//
// Pure-function tests for the scratchpad's markdown task parser and
// in-place toggle. These are the most operationally important pure
// functions in lib/notes.ts: a bug in the regex or the line-rewrite
// causes silent data loss when a user checks a task off.

import { describe, it, expect } from "vitest";
import { extractTasks, toggleTaskInBody } from "@/lib/notes";

const stubNote = (body: string) => ({ id: "test", body });

describe("extractTasks", () => {
  it("extracts open and completed tasks", () => {
    const tasks = extractTasks(stubNote(
      "- [ ] open thing\n" +
      "- [x] done thing\n" +
      "- [X] also done"
    ));
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toMatchObject({ body: "open thing", completed: false, lineIndex: 0 });
    expect(tasks[1]).toMatchObject({ body: "done thing", completed: true, lineIndex: 1 });
    expect(tasks[2]).toMatchObject({ body: "also done", completed: true, lineIndex: 2 });
  });

  it("accepts asterisk bullets", () => {
    const tasks = extractTasks(stubNote("* [ ] one\n* [x] two"));
    expect(tasks.map((t) => t.body)).toEqual(["one", "two"]);
  });

  it("preserves indentation in the line index but trims body", () => {
    const tasks = extractTasks(stubNote("  - [ ]   spaced task   "));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].body).toBe("spaced task");
  });

  it("ignores plain bullets and non-task lines", () => {
    const tasks = extractTasks(stubNote(
      "just a note\n" +
      "- bullet no checkbox\n" +
      "- [ ] real task"
    ));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ body: "real task", lineIndex: 2 });
  });

  it("returns empty for empty bodies", () => {
    expect(extractTasks(stubNote(""))).toEqual([]);
    expect(extractTasks(stubNote("\n\n"))).toEqual([]);
  });
});

describe("toggleTaskInBody", () => {
  it("flips an open task to done", () => {
    const out = toggleTaskInBody("- [ ] thing", 0);
    expect(out).toBe("- [x] thing");
  });

  it("flips a done task to open", () => {
    const out = toggleTaskInBody("- [x] thing", 0);
    expect(out).toBe("- [ ] thing");
  });

  it("flips capital-X done as well", () => {
    // Capital X gets normalized to lowercase x on toggle.
    const out = toggleTaskInBody("- [X] thing", 0);
    expect(out).toBe("- [ ] thing");
  });

  it("preserves indentation and asterisk bullets", () => {
    expect(toggleTaskInBody("  * [ ] indented", 0)).toBe("  * [x] indented");
  });

  it("only toggles the targeted line; leaves siblings alone", () => {
    const body = "- [ ] one\n- [ ] two\n- [ ] three";
    const out = toggleTaskInBody(body, 1);
    expect(out).toBe("- [ ] one\n- [x] two\n- [ ] three");
  });

  it("is a no-op for non-task lines", () => {
    expect(toggleTaskInBody("plain text", 0)).toBe("plain text");
    expect(toggleTaskInBody("- bullet no checkbox", 0)).toBe("- bullet no checkbox");
  });

  it("is a no-op for out-of-range line indices", () => {
    expect(toggleTaskInBody("- [ ] one", -1)).toBe("- [ ] one");
    expect(toggleTaskInBody("- [ ] one", 99)).toBe("- [ ] one");
  });

  it("roundtrips: extract → toggle → extract sees flipped state", () => {
    const body = "- [ ] one\n- [x] two";
    const before = extractTasks(stubNote(body));
    expect(before.map((t) => t.completed)).toEqual([false, true]);

    const after1 = toggleTaskInBody(body, 0);
    const after1Tasks = extractTasks(stubNote(after1));
    expect(after1Tasks.map((t) => t.completed)).toEqual([true, true]);

    const after2 = toggleTaskInBody(after1, 1);
    const after2Tasks = extractTasks(stubNote(after2));
    expect(after2Tasks.map((t) => t.completed)).toEqual([true, false]);
  });
});

// ─── Cockpit additions ──────────────────────────────────────────
//
// completeTaskInBody / snoozeTaskInBody / appendOutcomeToTask /
// removeTaskLineFromBody are the cockpit's write path — same
// silent-data-loss stakes as toggleTaskInBody above. The organizer
// and flight log are pure derivations over the same body format.

import {
  completeTaskInBody, snoozeTaskInBody, appendOutcomeToTask,
  removeTaskLineFromBody, nextOccurrence, taskKeyFor, organizeCapture,
  getFlightLog, topicForTask,
} from "@/lib/notes";

// 2026-06-12 is a Friday.
const FRI = new Date("2026-06-12T08:00:00");

describe("extractTasks — completion markers & recurrence", () => {
  it("parses a ✓date completion marker with outcome", () => {
    const [t] = extractTasks(stubNote("- [x] call Joe ✓2026-06-10: spec confirmed 85 ft-lb"));
    expect(t.completed).toBe(true);
    expect(t.doneAt).toBe("2026-06-10");
    expect(t.outcome).toBe("spec confirmed 85 ft-lb");
    expect(t.body).toBe("call Joe");
  });

  it("parses a ✓date marker without outcome", () => {
    const [t] = extractTasks(stubNote("- [x] thing ✓2026-06-11"));
    expect(t.doneAt).toBe("2026-06-11");
    expect(t.outcome).toBeNull();
    expect(t.body).toBe("thing");
  });

  it("never reads the ✓date as a due date", () => {
    const [t] = extractTasks(stubNote("- [x] thing ✓2026-06-11"));
    expect(t.dueAt).toBeNull();
  });

  it("detects recurrence words", () => {
    const [a, b, c] = extractTasks(stubNote(
      "- [ ] grease bearings every monday\n" +
      "- [ ] walk the unit every shift\n" +
      "- [ ] no recurrence here"
    ));
    expect(a.recurring).toBe("monday");
    expect(b.recurring).toBe("shift");
    expect(c.recurring).toBeNull();
  });
});

describe("completeTaskInBody", () => {
  it("checks the box and stamps ✓date", () => {
    const res = completeTaskInBody("- [ ] call Joe", 0, { now: FRI });
    expect(res.rolled).toBe(false);
    expect(res.body).toBe("- [x] call Joe ✓2026-06-12");
  });

  it("records the outcome inline", () => {
    const res = completeTaskInBody("- [ ] call Joe", 0, { now: FRI, outcome: "85 ft-lb" });
    expect(res.body).toBe("- [x] call Joe ✓2026-06-12: 85 ft-lb");
  });

  it("rolls a recurring task forward instead of checking it", () => {
    const res = completeTaskInBody("- [ ] grease bearings every monday", 0, { now: FRI });
    expect(res.rolled).toBe(true);
    expect(res.nextDueAt).toBe("2026-06-15");
    expect(res.body).toBe("- [ ] grease bearings every monday @2026-06-15");
    const [t] = extractTasks(stubNote(res.body));
    expect(t.completed).toBe(false);
    expect(t.dueAt).toBe("2026-06-15");
  });

  it("re-rolling replaces the previous rolled date", () => {
    const first = completeTaskInBody("- [ ] walk unit every day", 0, { now: FRI });
    expect(first.nextDueAt).toBe("2026-06-13");
    const second = completeTaskInBody(first.body, 0, { now: new Date("2026-06-13T08:00:00") });
    expect(second.body).toBe("- [ ] walk unit every day @2026-06-14");
  });

  it("is a no-op for non-task lines and bad indices", () => {
    expect(completeTaskInBody("plain", 0).body).toBe("plain");
    expect(completeTaskInBody("- [ ] x", 9).body).toBe("- [ ] x");
  });
});

describe("snoozeTaskInBody", () => {
  it("replaces an ISO due token", () => {
    expect(snoozeTaskInBody("- [ ] thing @2026-06-10", 0, "2026-06-15"))
      .toBe("- [ ] thing @2026-06-15");
  });

  it("replaces a word due token", () => {
    expect(snoozeTaskInBody("- [ ] thing due friday", 0, "2026-06-15"))
      .toBe("- [ ] thing @2026-06-15");
  });

  it("appends when there is no due token", () => {
    expect(snoozeTaskInBody("- [ ] dateless thing", 0, "2026-06-15"))
      .toBe("- [ ] dateless thing @2026-06-15");
  });

  it("roundtrips through the parser", () => {
    const body = snoozeTaskInBody("- [ ] thing due tomorrow", 0, "2026-07-01");
    const [t] = extractTasks(stubNote(body));
    expect(t.dueAt).toBe("2026-07-01");
  });
});

describe("appendOutcomeToTask", () => {
  it("appends an outcome to a completed task without one", () => {
    expect(appendOutcomeToTask("- [x] thing ✓2026-06-12", 0, "all good"))
      .toBe("- [x] thing ✓2026-06-12: all good");
  });

  it("does not double-append", () => {
    const body = "- [x] thing ✓2026-06-12: already";
    expect(appendOutcomeToTask(body, 0, "again")).toBe(body);
  });

  it("ignores open tasks and blank outcomes", () => {
    expect(appendOutcomeToTask("- [ ] open", 0, "x")).toBe("- [ ] open");
    expect(appendOutcomeToTask("- [x] done ✓2026-06-12", 0, "  ")).toBe("- [x] done ✓2026-06-12");
  });
});

describe("removeTaskLineFromBody", () => {
  it("removes exactly the targeted task line", () => {
    expect(removeTaskLineFromBody("title\n- [ ] kill me\n- [ ] keep me", 1))
      .toBe("title\n- [ ] keep me");
  });

  it("refuses to remove non-task lines", () => {
    const body = "title\n- [ ] task";
    expect(removeTaskLineFromBody(body, 0)).toBe(body);
  });
});

describe("nextOccurrence", () => {
  it("computes weekday / day / week / month from a Friday", () => {
    expect(nextOccurrence("monday", FRI)).toBe("2026-06-15");
    expect(nextOccurrence("friday", FRI)).toBe("2026-06-19"); // strictly after
    expect(nextOccurrence("day", FRI)).toBe("2026-06-13");
    expect(nextOccurrence("shift", FRI)).toBe("2026-06-13");
    expect(nextOccurrence("week", FRI)).toBe("2026-06-19");
    expect(nextOccurrence("month", FRI)).toBe("2026-07-12");
  });
});

describe("taskKeyFor", () => {
  it("is stable across due-date changes and completion", () => {
    const a = taskKeyFor("Call Joe due friday");
    const b = taskKeyFor("Call Joe @2026-06-15");
    const c = taskKeyFor("call joe");
    expect(a).toBe(c);
    expect(b).toBe(c);
  });
});

describe("organizeCapture", () => {
  it("splits a messy capture into findings + tasks the parser understands", () => {
    const raw = "walked unit 3 this morning. e-204 flange still weeping. " +
      "need to call joe about the gasket spec before friday. also order 2 spare gaskets";
    const org = organizeCapture(raw);
    expect(org.taskCount).toBe(2);
    expect(org.body).toContain("- [ ] ");
    // The organized body parses into real tasks with the due date intact.
    const tasks = extractTasks(stubNote(org.body));
    expect(tasks).toHaveLength(2);
    expect(tasks[0].dueAt).not.toBeNull(); // "by friday" resolved
    expect(org.taskSources).toHaveLength(2);
  });

  it("keeps non-actionable text verbatim", () => {
    const raw = "just a thought about the layout";
    const org = organizeCapture(raw);
    expect(org.body).toBe(raw);
    expect(org.taskCount).toBe(0);
  });
});

describe("getFlightLog", () => {
  it("collects completed receipts newest-first, honoring since", () => {
    const notes = [
      { id: "a", body: "- [x] older ✓2026-06-01: ok\n- [ ] open" },
      { id: "b", body: "- [x] newer ✓2026-06-10" },
    ];
    const all = getFlightLog(notes);
    expect(all.map((e) => e.text)).toEqual(["newer", "older"]);
    expect(all[1].outcome).toBe("ok");
    const recent = getFlightLog(notes, "2026-06-05");
    expect(recent).toHaveLength(1);
    expect(recent[0].text).toBe("newer");
  });
});

describe("topicForTask", () => {
  it("prefers MOC refs, then equipment tags, then units", () => {
    expect(topicForTask("review MOC-2024-051 redlines")).toBe("MOC-2024-051");
    expect(topicForTask("inspect e-204 flange")).toBe("E-204");
    expect(topicForTask("walk down unit 3")).toBe("Unit 3");
    expect(topicForTask("file the paperwork")).toBe("General");
  });
});

// ─── Reports — daily / weekly / monthly ─────────────────────────
//
// The report is the user's proof-of-work: achievements (when, outcome,
// how long they took) + carry-over (how long open, how overdue). Pinned
// here so the organizing logic can't silently regress into a metric dump.

import { buildReport, reportToMarkdown, getFlightLog as flightLog2 } from "@/lib/notes";

const RPT_NOW = new Date("2026-06-12T08:00:00"); // Friday

const RPT_NOTES = [
  // Done Wednesday, created Monday → took 2d, with an outcome.
  { id: "n1", createdAt: "2026-06-08T07:00:00Z", resolved: false,
    body: "- [x] Call Joe re gasket spec ✓2026-06-10: 85 ft-lb confirmed" },
  // Done today, created today → same day. Second open task carries over, 2d overdue.
  { id: "n2", createdAt: "2026-06-12T06:00:00Z", resolved: false,
    body: "- [x] Walk down P-101A ✓2026-06-12\n- [ ] Verify LOTO list for E-204 @2026-06-10" },
  // Done long ago — outside week window, inside month window.
  { id: "n3", createdAt: "2026-05-20T07:00:00Z", resolved: false,
    body: "- [x] Old cleanup ✓2026-05-30" },
  // Open dateless task in a RESOLVED note → must NOT carry over.
  { id: "n4", createdAt: "2026-06-01T07:00:00Z", resolved: true,
    body: "- [ ] zombie task in a closed note" },
];

describe("getFlightLog — tookDays", () => {
  it("computes how long each achievement took from note creation", () => {
    const log = flightLog2(RPT_NOTES);
    const joe = log.find((e) => e.text.startsWith("Call Joe"))!;
    const walk = log.find((e) => e.text.startsWith("Walk down"))!;
    expect(joe.tookDays).toBe(2);
    expect(walk.tookDays).toBe(0);
  });

  it("leaves tookDays null without a createdAt", () => {
    const log = flightLog2([{ id: "x", body: "- [x] thing ✓2026-06-10" }]);
    expect(log[0].tookDays).toBeNull();
  });
});

describe("buildReport", () => {
  it("weekly: groups achievements by day, newest first, and excludes out-of-window items", () => {
    const r = buildReport(RPT_NOTES, { period: "week", now: RPT_NOW });
    expect(r.periodLabel).toBe("Last 7 days");
    expect(r.achievements.map((g) => g.day)).toEqual(["2026-06-12", "2026-06-10"]);
    expect(r.stats.done).toBe(2);
    // Old cleanup (May 30) is outside the 7-day window…
    expect(r.achievements.flatMap((g) => g.items.map((i) => i.text))).not.toContain("Old cleanup");
  });

  it("monthly window includes what weekly excludes", () => {
    const r = buildReport(RPT_NOTES, { period: "month", now: RPT_NOW });
    expect(r.stats.done).toBe(3);
    expect(r.achievements.flatMap((g) => g.items.map((i) => i.text))).toContain("Old cleanup");
  });

  it("daily window is just today", () => {
    const r = buildReport(RPT_NOTES, { period: "day", now: RPT_NOW });
    expect(r.stats.done).toBe(1);
    expect(r.achievements[0].items[0].text).toBe("Walk down P-101A");
  });

  it("carry-over reports how long open and how overdue, skipping resolved notes", () => {
    const r = buildReport(RPT_NOTES, { period: "week", now: RPT_NOW });
    expect(r.carryOver).toHaveLength(1);
    const c = r.carryOver[0];
    expect(c.text).toContain("Verify LOTO list");
    expect(c.daysOpen).toBe(0);        // note created today
    expect(c.overdueDays).toBe(2);     // due 06-10, today 06-12
    expect(r.stats.overdueCarry).toBe(1);
    // zombie task from the resolved note is gone
    expect(r.carryOver.map((x) => x.text)).not.toContain("zombie task in a closed note");
  });

  it("computes average days-to-close", () => {
    const r = buildReport(RPT_NOTES, { period: "week", now: RPT_NOW });
    expect(r.stats.avgTookDays).toBe(1); // (2 + 0) / 2
  });
});

describe("reportToMarkdown", () => {
  it("renders organized sections, not a metric dump", () => {
    const md = reportToMarkdown(buildReport(RPT_NOTES, { period: "week", now: RPT_NOW }));
    expect(md).toContain("## Achievements");
    expect(md).toContain("## Carrying over");
    expect(md).toContain("85 ft-lb confirmed");   // outcome
    expect(md).toContain("took 2d");               // duration
    expect(md).toContain("2d overdue");            // carry-over aging
    expect(md).toContain("E-204");                 // topic
  });
});

// ─── Capture organizer — conjoined-task splitting ───────────────
//
// The user's core complaint: "follow up with Steve and Dave and Hector"
// became ONE vague task you couldn't check off individually. These pin
// the splitting + context-preservation so it can't regress.

import { splitConjoinedTasks, splitCaptureSentence } from "@/lib/notes";

describe("splitConjoinedTasks — people lists", () => {
  it("splits a name list into one task per person, sharing trailing context", () => {
    expect(splitConjoinedTasks("follow up with Steve and Dave and Hector on the gaskets")).toEqual([
      "Follow up with Steve on the gaskets",
      "Follow up with Dave on the gaskets",
      "Follow up with Hector on the gaskets",
    ]);
  });

  it("keeps per-person context when each has its own", () => {
    expect(splitConjoinedTasks("call Steve on the spec and Dave on the LOTO list")).toEqual([
      "Call Steve on the spec",
      "Call Dave on the LOTO list",
    ]);
  });

  it("handles Oxford commas", () => {
    expect(splitConjoinedTasks("ask Steve, Dave, and Hector")).toEqual([
      "Ask Steve",
      "Ask Dave",
      "Ask Hector",
    ]);
  });

  it("preserves a lead-in like 'I need to'", () => {
    expect(splitConjoinedTasks("I need to follow up with Steve and Dave")).toEqual([
      "I need to follow up with Steve",
      "I need to follow up with Dave",
    ]);
  });
});

describe("splitConjoinedTasks — coordinated actions", () => {
  it("splits two different actions joined by 'and'", () => {
    expect(splitConjoinedTasks("order 2 spare gaskets and check P-101A vibration")).toEqual([
      "Order 2 spare gaskets",
      "Check P-101A vibration",
    ]);
  });

  it("does NOT split an object list under a single non-people verb", () => {
    // "gaskets and bolts" is one order, not two tasks.
    expect(splitConjoinedTasks("order gaskets and bolts")).toEqual(["Order gaskets and bolts"]);
  });

  it("leaves a single task untouched", () => {
    expect(splitConjoinedTasks("verify the LOTO list for E-204")).toEqual(["Verify the LOTO list for E-204"]);
  });
});

describe("splitCaptureSentence — findings vs tasks", () => {
  it("keeps a leading observation as a finding, not a task", () => {
    const r = splitCaptureSentence("E-204 flange is weeping, need to call Joe about the gasket spec");
    expect(r.findings).toEqual(["E-204 flange is weeping"]);
    expect(r.tasks).toEqual(["Need to call Joe about the gasket spec"]);
  });

  it("treats a noun that looks like a verb as prose, not a task", () => {
    const r = splitCaptureSentence("the gasket order is running late");
    expect(r.tasks).toEqual([]);
    expect(r.findings).toEqual(["The gasket order is running late"]);
  });
});

describe("organizeCapture — end to end", () => {
  it("turns a messy multi-person capture into atomic, checkable tasks", () => {
    const org = organizeCapture(
      "walked unit 3. e-204 flange weeping. follow up with steve and dave and hector on the gasket order. also order new stud bolts and check p-101a vibration"
    );
    const lines = extractTasks(stubNote(org.body)).map((t) => t.body);
    expect(lines).toContain("Follow up with steve on the gasket order");
    expect(lines).toContain("Follow up with dave on the gasket order");
    expect(lines).toContain("Follow up with hector on the gasket order");
    expect(lines).toContain("Order new stud bolts");
    expect(lines).toContain("Check p-101a vibration");
    // The observation stayed a finding (not a task).
    expect(lines).not.toContain("E-204 flange weeping");
    expect(org.body).toContain("- E-204 flange weeping");
  });
});

// ─── Title synthesis ────────────────────────────────────────────
//
// The user's complaint: titles were just the first sentence copied.
// The heuristic now leads with the dominant subject and adds the task
// count, so it reads like a summary even without AI.

import { deriveCaptureTitle } from "@/lib/notes";

describe("deriveCaptureTitle", () => {
  it("leads with the dominant subject when the gist doesn't mention it", () => {
    const t = deriveCaptureTitle(
      ["Walked the overheads this morning"],
      ["Call Joe re: E-204 gasket spec", "Order E-204 spares"],
    );
    expect(t.startsWith("E-204 — ")).toBe(true);
    expect(t).toContain("(2 tasks)");
  });

  it("does not repeat a subject the gist already contains", () => {
    const t = deriveCaptureTitle(["E-204 flange weeping"], ["Call Joe about e-204"]);
    expect(t.startsWith("E-204 — E-204")).toBe(false);
  });

  it("falls back to the first task when there are no findings", () => {
    const t = deriveCaptureTitle([], ["Follow up with Steve on the gaskets", "Follow up with Dave on the gaskets"]);
    expect(t).toContain("Follow up with Steve");
    expect(t).toContain("(2 tasks)");
  });

  it("uses the plain gist for single-task topicless captures", () => {
    expect(deriveCaptureTitle(["Thinking about the layout"], [])).toBe("Thinking about the layout");
  });
});
