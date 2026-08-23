// Guard rails for vercel.json — the file where one wrong line stops EVERY
// deployment while the dashboard keeps showing an old green build.
//
// This has now happened TWICE: an hourly cron was added, every deployment
// was rejected by the plan's cron limits (max 2 cron jobs, daily schedules
// only), production silently froze on the last good commit for a day, and
// the log already carried the lesson from the first time ("Revert hourly
// cron — it was failing EVERY Vercel deployment"). Encoding the plan limits
// here makes the third time a failing test instead of a frozen production.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const raw = readFileSync(join(__dirname, "..", "..", "vercel.json"), "utf8");

describe("vercel.json deployability", () => {
  it("is valid JSON", () => {
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("stays within the plan's cron limits: at most 2 jobs, all DAILY schedules", () => {
    const cfg = JSON.parse(raw) as { crons?: Array<{ path: string; schedule: string }> };
    const crons = cfg.crons ?? [];
    expect(crons.length).toBeLessThanOrEqual(2);
    for (const c of crons) {
      // Daily = fixed minute, fixed hour, every day. Anything with * or a
      // step in the minute/hour fields (hourly, every-N-hours) fails the
      // whole deployment on this plan.
      expect(c.schedule, `${c.path} must be a once-a-day schedule`).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
    }
  });

  it("keeps the master ignoreCommand", () => {
    const cfg = JSON.parse(raw) as { ignoreCommand?: string };
    expect(cfg.ignoreCommand ?? "").toContain("master");
  });

  // Vercel reads this backwards from how it looks: the ignore command exits 1
  // to CONTINUE the build and 0 to SKIP it. Getting that inverted silently
  // stops production deploying while the dashboard still shows green — the
  // exact failure this file already records twice. So run the command rather
  // than pattern-match it.
  describe("the ignoreCommand actually decides what it claims to", () => {
    const cfg = JSON.parse(raw) as { ignoreCommand?: string };
    const decide = (ref: string): "build" | "skip" => {
      const r = spawnSync("sh", ["-c", cfg.ignoreCommand ?? "exit 0"], {
        env: { ...process.env, VERCEL_GIT_COMMIT_REF: ref },
      });
      expect(r.error, `ignoreCommand failed to run for ${ref}`).toBeUndefined();
      return r.status === 1 ? "build" : "skip";
    };

    it("builds master, so production keeps deploying", () => {
      expect(decide("master")).toBe("build");
    });

    it("skips branches that were not opted in", () => {
      expect(decide("some/other-branch")).toBe("skip");
      expect(decide("")).toBe("skip");
    });

    it("builds exactly the branches named in the command, and no others", () => {
      const named = [...(cfg.ignoreCommand ?? "").matchAll(/[\w./-]+(?=\)| \))/g)]
        .map((m) => m[0])
        .filter((w) => w !== "esac" && w !== "exit");
      for (const ref of named) {
        if (ref === "*") continue;
        expect(decide(ref), `${ref} is named but does not build`).toBe("build");
      }
    });
  });
});
