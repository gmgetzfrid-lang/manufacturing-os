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
