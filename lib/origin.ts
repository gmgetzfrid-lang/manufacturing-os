// origin - where a work order or step came from, in words: imported with
// the schedule (which file, who, when), or added during the job (what for,
// who found it, who added it, who approved it, when).
//
// Only what was recorded is said. An import before files were kept says
// who and when, not a file name; work added by hand with no reason says
// no reason was recorded.

import type { Milestone, MilestoneSource } from "@/types/schema";
import { ADDED, discoveryOf, kindOf, type DiscoveryRecord } from "@/lib/discovery";

/** Kept on each row an import writes (JSON text): the file, when, by whom. */
export const IMPORT_KEY = "imported";
export interface ImportStamp { file: string | null; at: string; by: string | null }
export const importStampValue = (s: ImportStamp) => JSON.stringify(s);

export function importOf(m: Pick<Milestone, "attributes">): ImportStamp | null {
  const raw = (m.attributes as Record<string, unknown> | null | undefined)?.[IMPORT_KEY];
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { return null; } }
  const s = v as Partial<ImportStamp> | null | undefined;
  return s && typeof s === "object" && typeof s.at === "string" ? { file: s.file ?? null, at: s.at, by: s.by ?? null } : null;
}

const SOURCE: Record<MilestoneSource, string> = { p6: "Primavera P6", msproject: "MS Project", csv: "CSV", mpxj: "schedule", manual: "" };

export type OriginKind = "imported" | "discovery" | "added" | "by-hand";
export interface Origin { kind: OriginKind; lines: string[] }

type When = (t: number) => string;
const ms = (v: unknown) => {
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** The words for a piece of added work, from its record. */
export function addedLines(d: DiscoveryRecord, when: When, fallbackBy?: string | null): string[] {
  const k = kindOf(d);
  const found = ADDED[k].found;
  const out = [`${ADDED[k].word}: ${d.what.trim()}`];
  if (d.foundBy || d.foundAt) out.push(`${found[0].toUpperCase()}${found.slice(1)}${d.foundAt ? ` ${when(d.foundAt)}` : ""}${d.foundBy ? ` by ${d.foundBy}` : ""}`);
  const by = d.addedBy || fallbackBy;
  if (d.addedAt || by) out.push(`Added to the schedule${d.addedAt ? ` ${when(d.addedAt)}` : ""}${by ? ` by ${by}` : ""}`);
  out.push(d.approvedBy ? `Approved by ${d.approvedBy}` : "No approval recorded");
  return out;
}

/** Where one row came from. */
export function originOf(m: Milestone, when: When): Origin {
  const d = discoveryOf(m);
  if (d) return { kind: kindOf(d), lines: addedLines(d, when, m.createdByName) };
  const created = ms(m.createdAt);
  const by = m.createdByName || null;
  if (m.source && m.source !== "manual") {
    const stamp = importOf(m);
    // The stamp is the last import that wrote it; the first one made it.
    const first = stamp && created != null && Math.abs((ms(stamp.at) ?? 0) - created) < 3_600_000 ? stamp : null;
    const lines = [`Imported with the ${SOURCE[m.source]} schedule${first?.file ? ` (${first.file})` : ""}${created != null ? ` ${when(created)}` : ""}${by ? ` by ${by}` : ""}`];
    if (stamp && !first) {
      const at = ms(stamp.at);
      lines.push(`Last updated by an import${stamp.file ? ` of ${stamp.file}` : ""}${at != null ? ` ${when(at)}` : ""}${stamp.by ? ` by ${stamp.by}` : ""}`);
    }
    return { kind: "imported", lines };
  }
  return { kind: "by-hand", lines: [`Added by hand${created != null ? ` ${when(created)}` : ""}${by ? ` by ${by}` : ""}. No reason recorded.`] };
}

/** A work order's origin: its own, then the work added to it later (each
 *  piece once, with how many of its steps), then steps added by hand. */
export function workOrderOrigin(owner: Milestone, steps: Milestone[], when: When): { own: Origin; added: Array<{ lines: string[]; steps: number }>; byHand: { steps: number; lines: string[] } | null } {
  const own = originOf(owner, when);
  const ownId = discoveryOf(owner)?.id;
  const pieces = new Map<string, { d: DiscoveryRecord; by: string | null; steps: number }>();
  const hand: Milestone[] = [];
  for (const s of steps) {
    if (s.id === owner.id) continue;
    const d = discoveryOf(s);
    if (d) {
      if (d.id === ownId) continue;
      const p = pieces.get(d.id) ?? { d, by: s.createdByName ?? null, steps: 0 };
      p.steps += 1;
      pieces.set(d.id, p);
    } else if (own.kind === "imported" && s.source === "manual") hand.push(s);
  }
  // A work order made during the job: its steps' record says why.
  if (own.kind === "by-hand" && pieces.size > 0) {
    const [first] = [...pieces.values()];
    pieces.delete(first.d.id);
    return { own: { kind: kindOf(first.d), lines: addedLines(first.d, when, first.by) }, added: [...pieces.values()].map((p) => ({ lines: addedLines(p.d, when, p.by), steps: p.steps })), byHand: null };
  }
  const handBy = [...new Set(hand.map((s) => s.createdByName).filter(Boolean))];
  const handAt = hand.map((s) => ms(s.createdAt)).filter((t): t is number => t != null).sort((a, b) => a - b);
  return {
    own,
    added: [...pieces.values()].map((p) => ({ lines: addedLines(p.d, when, p.by), steps: p.steps })),
    byHand: hand.length ? { steps: hand.length, lines: [`${hand.length} step${hand.length === 1 ? "" : "s"} added by hand${handAt.length ? ` ${when(handAt[0])}${handAt.length > 1 && handAt.at(-1)! - handAt[0] > 3_600_000 ? ` to ${when(handAt.at(-1)!)}` : ""}` : ""}${handBy.length ? ` by ${handBy.join(", ")}` : ""}. No reason recorded.`] } : null,
  };
}
