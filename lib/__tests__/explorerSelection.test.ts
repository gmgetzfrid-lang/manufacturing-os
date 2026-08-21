import { describe, expect, it } from "vitest";
import {
  clickItem,
  contextClickItem,
  emptySelection,
  moveFocus,
  pruneSelection,
  selectAll,
  toggleFocused,
  typeAheadTarget,
} from "@/lib/explorerSelection";

const ORDER = ["a", "b", "c", "d", "e", "f"];

describe("clickItem", () => {
  it("plain click selects exactly one and sets anchor + focus", () => {
    const s = clickItem(emptySelection(), ORDER, "c");
    expect([...s.ids]).toEqual(["c"]);
    expect(s.anchorId).toBe("c");
    expect(s.focusId).toBe("c");
  });

  it("ctrl+click toggles membership and moves the anchor", () => {
    let s = clickItem(emptySelection(), ORDER, "b");
    s = clickItem(s, ORDER, "d", { ctrl: true });
    expect(new Set(s.ids)).toEqual(new Set(["b", "d"]));
    expect(s.anchorId).toBe("d");
    s = clickItem(s, ORDER, "b", { ctrl: true });
    expect([...s.ids]).toEqual(["d"]);
  });

  it("shift+click selects the contiguous range from the anchor, both directions", () => {
    let s = clickItem(emptySelection(), ORDER, "b");
    s = clickItem(s, ORDER, "e", { shift: true });
    expect(new Set(s.ids)).toEqual(new Set(["b", "c", "d", "e"]));
    // Re-pivot around the SAME anchor — Explorer keeps it put.
    s = clickItem(s, ORDER, "a", { shift: true });
    expect(new Set(s.ids)).toEqual(new Set(["a", "b"]));
    expect(s.anchorId).toBe("b");
  });

  it("shift+click with no anchor degrades to a single selection", () => {
    const s = clickItem(emptySelection(), ORDER, "d", { shift: true });
    expect([...s.ids]).toEqual(["d"]);
  });

  it("ctrl+shift+click ADDS the range instead of replacing", () => {
    let s = clickItem(emptySelection(), ORDER, "a");
    s = clickItem(s, ORDER, "f", { ctrl: true });      // {a, f}, anchor f
    s = clickItem(s, ORDER, "d", { ctrl: true, shift: true });
    expect(new Set(s.ids)).toEqual(new Set(["a", "d", "e", "f"]));
  });

  it("a vanished anchor falls back to a single-item range", () => {
    let s = clickItem(emptySelection(), ORDER, "b");
    s = clickItem(s, ["c", "d", "e"], "e", { shift: true }); // b no longer visible
    expect([...s.ids]).toEqual(["e"]);
  });
});

describe("contextClickItem", () => {
  it("right-click on a selected item keeps the whole selection", () => {
    let s = clickItem(emptySelection(), ORDER, "b");
    s = clickItem(s, ORDER, "d", { shift: true });
    const next = contextClickItem(s, ORDER, "c");
    expect(new Set(next.ids)).toEqual(new Set(["b", "c", "d"]));
    expect(next.focusId).toBe("c");
  });

  it("right-click on an unselected item selects just it", () => {
    const s = clickItem(emptySelection(), ORDER, "b");
    const next = contextClickItem(s, ORDER, "e");
    expect([...next.ids]).toEqual(["e"]);
  });
});

describe("moveFocus", () => {
  it("plain arrow selects the next item alone", () => {
    let s = clickItem(emptySelection(), ORDER, "b");
    s = moveFocus(s, ORDER, "down");
    expect([...s.ids]).toEqual(["c"]);
    expect(s.anchorId).toBe("c");
  });

  it("clamps at both ends", () => {
    let s = clickItem(emptySelection(), ORDER, "a");
    s = moveFocus(s, ORDER, "up");
    expect([...s.ids]).toEqual(["a"]);
    s = clickItem(s, ORDER, "f");
    s = moveFocus(s, ORDER, "down");
    expect([...s.ids]).toEqual(["f"]);
  });

  it("shift+arrow grows then shrinks the range around the anchor", () => {
    let s = clickItem(emptySelection(), ORDER, "c");
    s = moveFocus(s, ORDER, "down", { shift: true });
    s = moveFocus(s, ORDER, "down", { shift: true });
    expect(new Set(s.ids)).toEqual(new Set(["c", "d", "e"]));
    s = moveFocus(s, ORDER, "up", { shift: true });
    expect(new Set(s.ids)).toEqual(new Set(["c", "d"]));
    expect(s.anchorId).toBe("c");
  });

  it("ctrl+arrow moves focus without touching the selection; ctrl+space toggles", () => {
    let s = clickItem(emptySelection(), ORDER, "a");
    s = moveFocus(s, ORDER, "down", { ctrl: true });
    s = moveFocus(s, ORDER, "down", { ctrl: true });
    expect([...s.ids]).toEqual(["a"]);
    expect(s.focusId).toBe("c");
    s = toggleFocused(s);
    expect(new Set(s.ids)).toEqual(new Set(["a", "c"]));
  });

  it("home/end jump to the extremes; first press with no focus lands sensibly", () => {
    let s = moveFocus(emptySelection(), ORDER, "down");
    expect([...s.ids]).toEqual(["a"]);
    s = moveFocus(s, ORDER, "end");
    expect([...s.ids]).toEqual(["f"]);
    s = moveFocus(s, ORDER, "home", { shift: true });
    expect(new Set(s.ids)).toEqual(new Set(ORDER));
  });

  it("pageUp/pageDown step by the page size", () => {
    let s = clickItem(emptySelection(), ORDER, "a");
    s = moveFocus(s, ORDER, "pageDown", {}, 3);
    expect([...s.ids]).toEqual(["d"]);
  });

  it("ctrl+shift+arrow ADDS the range to the selection", () => {
    let s = clickItem(emptySelection(), ORDER, "a");
    s = clickItem(s, ORDER, "f", { ctrl: true });               // {a, f}, anchor f
    s = moveFocus(s, ORDER, "up", { ctrl: true, shift: true }); // + range f→e
    expect(new Set(s.ids)).toEqual(new Set(["a", "e", "f"]));
  });

  it("empty list is a no-op", () => {
    const s = moveFocus(emptySelection(), [], "down");
    expect(s.ids.size).toBe(0);
  });
});

describe("selectAll + pruneSelection", () => {
  it("selectAll covers the visible order", () => {
    const s = selectAll(ORDER);
    expect(s.ids.size).toBe(6);
    expect(s.focusId).toBe("f");
  });

  it("prune drops ids that left the view and preserves identity when clean", () => {
    const s = selectAll(ORDER);
    const pruned = pruneSelection(s, ["a", "b"]);
    expect(new Set(pruned.ids)).toEqual(new Set(["a", "b"]));
    expect(pruned.focusId).toBeNull(); // f is gone
    const same = pruneSelection(pruned, ["a", "b"]);
    expect(same).toBe(pruned);
  });
});

describe("typeAheadTarget", () => {
  const ITEMS = [
    { id: "1", label: "Pump P-101" },
    { id: "2", label: "Pump P-102" },
    { id: "3", label: "Exchanger E-201" },
    { id: "4", label: "Piping ISO 12" },
  ];

  it("multi-char buffer matches from the focused item (spelling one name)", () => {
    expect(typeAheadTarget(ITEMS, "pu", null)).toBe("1");
    expect(typeAheadTarget(ITEMS, "pi", "1")).toBe("4");
  });

  it("no focus scans from the FIRST item even when the last also matches", () => {
    const items = [
      { id: "1", label: "Pump A" },
      { id: "2", label: "Pump B" },
    ];
    expect(typeAheadTarget(items, "pu", null)).toBe("1");
    expect(typeAheadTarget(items, "p", null)).toBe("1");
  });

  it("single-char buffer cycles PAST the current focus", () => {
    expect(typeAheadTarget(ITEMS, "p", "1")).toBe("2");
    expect(typeAheadTarget(ITEMS, "p", "2")).toBe("4");
    expect(typeAheadTarget(ITEMS, "p", "4")).toBe("1"); // wraps
  });

  it("no match returns null; empty buffer returns null", () => {
    expect(typeAheadTarget(ITEMS, "zz", null)).toBeNull();
    expect(typeAheadTarget(ITEMS, "  ", "1")).toBeNull();
  });
});
