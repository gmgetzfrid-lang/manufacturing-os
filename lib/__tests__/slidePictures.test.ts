import { describe, it, expect } from "vitest";
import { autoPictures, captionOf, picRoom, rankPhotos, slideTags } from "@/lib/slidePictures";
import { picPlace, type SlideSpec } from "@/lib/reviewFiles";
import { cleanSaved } from "@/lib/reviewStore";

const table = (key: string, title: string, rows: string[][], lead?: string): SlideSpec => ({
  key, kicker: "k", title, notes: "",
  body: { k: "table", head: ["Measure", "Target", "Actual", "Result"], widths: [1.4, 2.4, 3.4, 1.7], rows, ...(lead ? { lead } : {}) },
});
const cover: SlideSpec = { key: "cover", kicker: "Post-event review", title: "Phase 1", notes: "", body: { k: "cover", sub: "", meta: "", agenda: [] } };
const score = table("score", "Phase 1 finished 33.5 h late. 24 h of it was E-12.", [["Duration", "Sat", "Mon", "33.5 h late"], ["Quality", "0", "2 failed tests: E-12 Tube Side Hydro", "Missed"]], "Where the 33.5 h went: E-12 24 h, V-7 4 h, E-17 3 h.");
const photo = (id: string, tag: string, captured: string | null, status = "current") => ({ id, tag, file_url: `orgs/215b762d-7be4-4cbd-bdb1-4b2703d81296/assets/${tag}/photos/${id}.jpg`, captured_at: captured, uploaded_at: captured, status, caption: null });

describe("pictures on the review slides", () => {
  it("finds the equipment a slide names, title first, without repeats", () => {
    expect(slideTags(score)).toEqual(["E-12", "V-7", "E-17"]);
    expect(slideTags(table("x", "Nothing named here", [["Phase 1", "a", "b", "c"]]))).toEqual([]);
  });

  it("ranks a piece of equipment's photos: taken during the event first, superseded last", () => {
    const window = { from: Date.parse("2026-10-24T00:00:00Z"), to: Date.parse("2026-11-02T00:00:00Z") };
    const ranked = rankPhotos([photo("old", "E-12", "2024-01-01T00:00:00Z"), photo("during", "E-12", "2026-10-29T00:00:00Z"), photo("gone", "E-12", "2026-11-19T00:00:00Z", "superseded")], window);
    expect(ranked.get("e12")!.map((p) => p.photoId)).toEqual(["during", "old", "gone"]);
    expect(ranked.get("e12")![0].caption).toBe("E-12 · Oct 29, 2026");
  });

  it("puts each slide's own equipment on it, and the equipment that held the finish on the cover", () => {
    const photos = rankPhotos([photo("e", "E-12", "2026-10-29T00:00:00Z"), photo("v", "V-7", "2026-10-27T00:00:00Z")], { from: null, to: null });
    const auto = autoPictures([cover, score], photos);
    expect(auto.cover.map((p) => p.tag)).toEqual(["E-12"]);
    expect(auto.score.map((p) => p.tag)).toEqual(["E-12", "V-7"]);
    // No equipment with photos: no pictures, no empty box.
    expect(autoPictures([cover, score], new Map())).toEqual({});
  });

  it("keeps a table readable: pictures go beside it, under it, or nowhere", () => {
    expect(picPlace(score)).toBe("right");
    const wide = table("areas-1", "Areas", Array.from({ length: 12 }, (_, i) => [`Area ${i} with a long name`, "Something that went well, written at length", "What did not go well, written out over several words and lines", "No. 1"]));
    expect(picPlace(wide)).toBeNull();
    expect(picRoom(wide)).toBe(0);
    expect(picRoom(cover)).toBe(1);
    expect(picRoom(cover, false)).toBe(0);
    // A narrow column that would break its words beside a picture puts the picture under the table instead.
    const narrow: SlideSpec = { ...table("areas-2", "Areas", [["Execution", "", "Crews sat", "No reason written", "No. 3"]]), body: { k: "table", head: ["Area", "What went well", "What did not go well", "Root cause", "Action"], widths: [1.35, 2.3, 3.85, 2.75, 0.75], rows: [["Execution", "", "Crews sat", "No reason written", "No. 3"]] } };
    expect(picPlace(narrow)).toBe("below");
  });

  it("captions say what and when", () => {
    expect(captionOf("V-7", "2026-10-27T15:00:00Z")).toBe("V-7 · Oct 27, 2026");
    expect(captionOf("V-7", null, "North side")).toBe("V-7 · North side");
  });

  it("a person's picture choices are kept only when they point at the workspace's own files", () => {
    const s = cleanSaved({ slides: {
      score: { pics: [{ path: "orgs/215b762d-7be4-4cbd-bdb1-4b2703d81296/assets/a/photos/1.jpg", caption: "E-12 · Oct 29, 2026", tag: "E-12" }, { path: "https://evil.example/x.jpg", caption: "x" }, { path: "orgs/215b762d-7be4-4cbd-bdb1-4b2703d81296/../other/x.jpg", caption: "y" }] },
      cover: { pics: [] },
      bad: "nope",
    } });
    expect(s.slides.score.pics.map((p) => p.tag)).toEqual(["E-12"]);
    // An empty list is kept: that slide has no pictures, by choice.
    expect(s.slides.cover.pics).toEqual([]);
    expect(s.slides.bad).toBeUndefined();
  });
});
