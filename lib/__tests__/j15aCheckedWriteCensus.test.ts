// projects-tab SAF-18 (J15a) → SAF-21 (J15d): a POINTER.
//
// J15a widened the census to writes through a client PARAMETER (`db` / `sb`
// / `admin` / `client` `.from(…)`) for its own 27 files here. J15d folded
// that rule into the shared census, lib/__tests__/checkedWrite.test.ts
// (`CLIENT_PARAM` in its `writeSites`), so every file the shared census
// reads is now judged by it — J15a's 27 files among them (all in
// `CLEAN_LIB`), and the 14 files SAF-21 named. The rule's self-tests and
// lib/checkoutEpisodes.ts's five-writes pin moved there with it. This file
// only holds that the move kept the coverage.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const census = readFileSync(join(process.cwd(), "lib/__tests__/checkedWrite.test.ts"), "utf8");

const J15A = [
  "lib/acknowledgments.ts", "lib/checkoutEpisodes.ts", "lib/reviewControl.ts", "lib/revisions.ts", "lib/reviewCycles.ts",
  "lib/documentLifecycle/common.ts", "lib/documentLifecycle/renumber.ts", "lib/documentLifecycle/reverse.ts", "lib/documentLifecycle/split.ts",
  "lib/holds.ts", "lib/effectiveDate.ts", "lib/documentOrigin.ts", "lib/documentShares.ts", "lib/docClass.ts", "lib/retention.ts",
  "lib/markups.ts", "lib/markupRequests.ts", "lib/transmittals.ts", "lib/branches.ts", "lib/unitCodeDecode.ts", "lib/collections.ts",
  "lib/libraryCollections.ts", "lib/libraryViews.ts", "lib/favorites.ts", "lib/tableViews.ts", "lib/watches.ts", "lib/assets.ts",
];

describe("SAF-18 (J15a) → SAF-21 (J15d) — the client-parameter rule lives in the shared census", () => {
  it("the shared census counts client-parameter writes and holds J15a's 27 files clean", () => {
    expect(census).toMatch(/const CLIENT_PARAM = \/\(\?:\^\|\[\^\\w\.\$\]\)\(\?:db\|sb\|admin\|client\)/);
    expect(census).toMatch(/if \(viaParam && !CLIENT_PARAM\.test\(stmt\)\) continue;/);
    const clean = census.slice(census.indexOf("const CLEAN_LIB = ["), census.indexOf("];", census.indexOf("const CLEAN_LIB = [")));
    for (const f of J15A) expect(clean, f).toContain(`"${f}"`);
    expect(census).toMatch(/lib\/checkoutEpisodes\.ts's five/);
  });
});
