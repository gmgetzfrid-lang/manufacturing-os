// requirementSource - where a project's requirement came from, said in one
// quiet line beside it: the app's default, set when the project was made,
// or set for this project later (when, and by whom, when that was
// recorded). Never a guess: with no record of who or when, the line says
// only "Set for this project".

import { fmtInTz } from "@/lib/scheduleTz";

/** When a setting was changed, and by whom (as the record has it). */
export interface Stamp { at?: string | number | null; by?: string | null }

export type Source =
  /** Nobody set it: the app's own rule ("each phase needs its own PSSR"). */
  | { kind: "default"; note?: string }
  /** Set for this project after it was made. */
  | { kind: "set"; stamp?: Stamp | null; note?: string }
  /** Set when the project was made (the new-project steps). */
  | { kind: "made"; stamp?: Stamp | null; note?: string }
  /** Passed over in the new-project steps (recorded in setup_state). */
  | { kind: "skipped"; stamp?: Stamp | null; note?: string }
  /** Not a setting: another part of the app measures it. */
  | { kind: "asked"; by: string; note?: string };

const toMs = (v: string | number | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
};

/** "ggetzfrid@kernenergy.com" → "ggetzfrid"; a name stays a name. */
export function whoWord(by: string | null | undefined): string | null {
  const s = String(by ?? "").trim();
  if (!s) return null;
  return s.includes("@") ? s.split("@")[0] : s;
}

/** "Oct 20 by ggetzfrid", "Oct 20", "by ggetzfrid", or "" when nothing was
 *  recorded. Another year's date says the year. */
export function stampWords(s: Stamp | null | undefined, tz: string, now: number = Date.now()): string {
  if (!s) return "";
  const t = toMs(s.at ?? null);
  const who = whoWord(s.by);
  const sameYear = t != null && fmtInTz(t, tz, { year: "numeric" }) === fmtInTz(now, tz, { year: "numeric" });
  const day = t == null ? "" : fmtInTz(t, tz, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  return [day, who ? `by ${who}` : ""].filter(Boolean).join(" ");
}

/** The one quiet line: "App default: …", "Set for this project (Oct 20 by
 *  ggetzfrid)", "Set when the project was made (Oct 13)", "Asked by the
 *  post-event review". */
export function sourceWords(s: Source, tz: string, now: number = Date.now()): string {
  const tail = (note?: string) => (note ? `: ${note}` : "");
  if (s.kind === "default") return `App default${tail(s.note)}`;
  if (s.kind === "asked") return `Asked by ${s.by}${tail(s.note)}`;
  const w = stampWords(s.stamp, tz, now);
  const head = s.kind === "made" ? "Set when the project was made" : s.kind === "skipped" ? "Skipped when the project was made" : "Set for this project";
  return `${head}${w ? ` (${w})` : ""}${tail(s.note)}`;
}

/** The newest of several stamps (none recorded: null). */
export function latestStamp(xs: Array<Stamp | null | undefined>): Stamp | null {
  let best: Stamp | null = null, bt = -Infinity;
  for (const x of xs) {
    const t = toMs(x?.at ?? null);
    if (x && t != null && t > bt) { best = x; bt = t; }
  }
  return best;
}

/** A stamp for a change made now. */
export const stampNow = (by: string | null | undefined): Stamp => ({ at: new Date().toISOString(), by: by ?? null });

// ── The PSSR rule ──
// The close-out asks for a PSSR: one for the job, or one for each phase
// when the project is split into phases (each restart has its own). That
// is the app's rule until someone marks it not needed for this project.

export interface PssrSetting { notNeeded?: boolean; at?: string | number | null; by?: string | null }

/** Where one phase's (or the job's) PSSR requirement came from. */
export function pssrSource(v: PssrSetting | null | undefined, inPhases: boolean): Source {
  const stamp = v && (v.at != null || v.by) ? { at: v.at ?? null, by: v.by ?? null } : null;
  if (v?.notNeeded) return { kind: "set", stamp };
  // Put back to needed by a person: theirs, with when.
  if (stamp) return { kind: "set", stamp };
  return { kind: "default", note: inPhases ? "each phase needs its own PSSR" : "every project needs a PSSR" };
}

// ── The turnover documents ──
// None are required until someone adds them, or the new-project steps
// added the usual list for the job's size.

export interface TurnoverRow { required: boolean; createdAt: string | null; createdBy?: string | null }

/** Where the turnover list came from. `madeAt` is when the project was
 *  made: a list added within minutes of it came with the new project. */
export function turnoverSource(items: TurnoverRow[], madeAt: string | number | null | undefined, nameOf: (uid: string | null | undefined) => string | null = () => null): Source {
  const req = items.filter((i) => i.required);
  if (!req.length) return { kind: "default", note: items.length ? "none of these are required" : "no documents required until you add them" };
  const first = [...items].sort((a, b) => (toMs(a.createdAt) ?? Infinity) - (toMs(b.createdAt) ?? Infinity))[0];
  const firstAt = toMs(first?.createdAt ?? null), made = toMs(madeAt ?? null);
  const stamp: Stamp | null = firstAt != null ? { at: firstAt, by: nameOf(first?.createdBy) } : null;
  const withProject = firstAt != null && made != null && Math.abs(firstAt - made) <= 15 * 60_000;
  return withProject ? { kind: "made", stamp } : { kind: "set", stamp };
}

/** The job sizes the new-project steps offer, and the words for each. */
export const JOB_SIZES = [
  { v: "small", label: "Small job" },
  { v: "standard", label: "Standard project" },
  { v: "capital", label: "Capital project" },
] as const;
export const jobSizeWord = (k: string | null | undefined) => JOB_SIZES.find((x) => x.v === k)?.label ?? "Standard project";
