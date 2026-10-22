import { describe, it, expect } from "vitest";
import { settleItems, keywordsOf, dropLibraryAsks, loosened } from "@/lib/ask/settleItems";

const draft = [
  "**Answer:** NOT SETTLED — the Class 150 wet-H2S class code is not visible [62].",
  "**To settle this:**",
  "- **EP 5-2-3 — Kern Engineering Piping Standards, piping class index (Class 150 entries)** — pull the Class 150 section [62].",
  "- **Line temperature and H2S partial pressure** — only you know these.",
  "- **Best answer with what I have:** a Class 150 carbon-steel NACE class.",
  "**Why:**",
  "- 1. Wet H2S per EP 10-2-1 [18].",
].join("\n");

describe("the draft's To settle this list", () => {
  it("is read as items, without the best-answer line or the next section", () => {
    const items = settleItems(draft);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("EP 5-2-3");
  });
  it("becomes a keyword search", () => {
    const item = settleItems(draft)[0];
    // Inside the named document, its own name is noise: the topic remains.
    expect(keywordsOf(item, "EP 5-2-3 — Kern Engineering Piping Standards")).toMatch(/^class index Class 150 entries/i);
    expect(loosened("Class 150 entries")).toBe("150 Class or 150 entries");
    expect(keywordsOf("see [62] the section")).toBe("");
  });
  it("items naming a library document are dropped; questions only the asker can answer stay", () => {
    const out = dropLibraryAsks(draft, (l) => l.includes("EP 5-2-3"));
    expect(out).not.toContain("Kern Engineering Piping Standards, piping class index");
    expect(out).toContain("Line temperature and H2S partial pressure");
    expect(out).toContain("Best answer with what I have");
    expect(out).toContain("**Why:**");
  });
});

describe("an empty ask is never shown", () => {
  it("drops a bare bullet left behind", async () => {
    const { settleItems: items, dropLibraryAsks: drop } = await import("@/lib/ask/settleItems");
    const a = "**To settle this:**\n- \n* **\n- **Best answer with what I have:** use the line class row.\n**Why:**\n- x";
    expect(items(a)).toEqual([]);
    expect(drop(a, () => false)).not.toMatch(/^- \s*$/m);
  });
});
