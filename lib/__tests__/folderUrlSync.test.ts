import { describe, it, expect } from "vitest";
import { folderUrlAction } from "@/lib/folderUrlSync";

/** Simulates the page: on each commit the reader (URL → state) and the
 *  writer (state → URL) effects both run against the SAME render's values,
 *  and a push lands one commit later — the order React and Next give us. */
function simulate(start: { state: string | null; url: string | null }, event: (w: World) => void) {
  const w: World = { state: start.state, url: start.url, prev: start.state, history: [start.url] };
  let lastUrl = start.url;
  event(w);
  for (let commit = 0; commit < 50; commit++) {
    const renderState = w.state, renderUrl = w.url;
    // reader: copies URL → state when the URL changed since last commit
    const nextState = renderUrl !== lastUrl ? renderUrl : renderState;
    // writer: same render's values
    const act = folderUrlAction(w.prev, renderState, renderUrl);
    w.prev = renderState;
    lastUrl = renderUrl;
    w.state = nextState;
    if (act === "push") { w.url = renderState; w.history.push(renderState); }
    if (w.state === renderState && w.url === renderUrl) return { ...w, commits: commit + 1 };
  }
  return { ...w, commits: Infinity };
}
interface World { state: string | null; url: string | null; prev: string | null; history: Array<string | null> }

/** The old writer: pushed whenever URL and state disagreed. */
function oldAction(_prev: string | null, state: string | null, url: string | null) {
  return url === state ? "sync" : "push";
}

describe("folderUrlAction", () => {
  it("(the bug) the old writer flips forever on Back", () => {
    let state: string | null = "X", url: string | null = "P", lastUrl: string | null = "X";
    let flips = 0;
    for (let i = 0; i < 20; i++) {
      const rs: string | null = state, ru: string | null = url;
      if (ru !== lastUrl) state = ru;
      lastUrl = ru;
      if (oldAction(null, rs, ru) === "push") { url = rs; flips++; }
    }
    expect(flips).toBeGreaterThan(5);
  });

  it("browser Back settles on the URL's folder instead of flipping forever", () => {
    // In folder X (came from P); Back puts P in the address bar first.
    const r = simulate({ state: "X", url: "X" }, (w) => { w.url = "P"; });
    expect(r.commits).toBeLessThan(5);
    expect(r.state).toBe("P");
    expect(r.url).toBe("P");
  });

  it("Back to the library top (no folderId) settles too", () => {
    const r = simulate({ state: "X", url: "X" }, (w) => { w.url = null; });
    expect(r.commits).toBeLessThan(5);
    expect(r.state).toBeNull();
    expect(r.url).toBeNull();
  });

  it("opening a folder (state moves) pushes it into the address bar", () => {
    const r = simulate({ state: "P", url: "P" }, (w) => { w.state = "X"; });
    expect(r.state).toBe("X");
    expect(r.url).toBe("X");
    expect(r.history).toEqual(["P", "X"]);
  });

  it("a re-render while our own push is landing doesn't push again", () => {
    // state already moved to X and was pushed; URL not caught up yet.
    expect(folderUrlAction("X", "X", "P")).toBe("leave");
  });

  it("agreeing URL and state is a plain sync", () => {
    expect(folderUrlAction("P", "X", "X")).toBe("sync");
    expect(folderUrlAction(null, null, null)).toBe("sync");
  });
});
