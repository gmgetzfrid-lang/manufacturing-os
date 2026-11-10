// nextPlanTalk - "Tell the schedule": a person's words ("V-7 is critical
// path, start it as soon as possible", "Ancon has 2 crews on nights") read
// into changes to the suggested schedule. The model only names changes from
// a short list, against the work orders and activities it's shown; the app
// checks every one and works out what it does to the finish itself.

import type { NextPlan, PlanChange } from "@/lib/nextPlan";
import { cleanChange } from "@/lib/nextPlanStore";

export const TALK_SYSTEM = [
  "You turn a turnaround planner's instruction into changes to a suggested schedule. Reply with JSON only:",
  '{"understood": "<one short sentence, plain words>", "changes": [...], "question": "<only if you can\'t tell what they mean>"}',
  "Each change is one of:",
  '- {"kind":"nights","order":"<order key>"|"ids":["<activity id>"],"on":true|false}  run on nights too (on) or days only (off)',
  '- {"kind":"asap","order":"..."|"ids":[...]}  start as soon as its links allow, not at its planned date',
  '- {"kind":"first","order":"..."|"ids":[...]}  goes first when its crew is short (what people mean by "critical" or "priority")',
  '- {"kind":"hold","order":"..."|"ids":[...],"day":N}  not before Day N',
  '- {"kind":"hours","actId":"<id>","hours":H}  how long one activity takes',
  '- {"kind":"drop","order":"..."|"ids":[...]}  not needed next time',
  '- {"kind":"add","name":"...","crew":"...","hours":H,"after":"<id>"|null,"before":"<id>"|null,"pre":true|false}  a new activity (pre: before the shutdown, a booking or material)',
  '- {"kind":"heads","crew":"<crew>","day":N,"shift":"day"|"night"|"both","n":H}  hands on the tools; days "1-9" is allowed as "day":"1-9"',
  "Use only the order keys, activity ids and crews listed. A name that fits more than one (E-22 on two units) is a question, not a guess.",
  "If they say something is critical or the critical path, use first and asap for it. Never invent numbers they didn't give.",
].join("\n");

export function talkCatalog(plan: NextPlan, orders: Array<{ key: string; name: string; wo: string | null }>, dayOf: (t: number) => number): string {
  const lines = [`Day 1 is the first shift. Days run 1 to ${dayOf(plan.finish)}.`, "CREWS: " + Object.keys(plan.load).join(", "), "ORDERS (key | name | WO):"];
  for (const o of orders) lines.push(`${o.key} | ${o.name}${o.wo ? ` | ${o.wo}` : ""}`);
  lines.push("ACTIVITIES (id | name | order key | crew | hours | days or both | Day start-finish):");
  for (const a of plan.acts) lines.push(`${a.id} | ${a.name} | ${a.order} | ${a.crew} | ${a.hours} | ${a.cal} | ${dayOf(a.start)}-${dayOf(a.finish)}`);
  return lines.join("\n").slice(0, 150_000);
}

/** The model's reply, checked against what's there. */
export function parseTalkReply(v: unknown, known: { orders: Set<string>; acts: Set<string>; crews: Set<string> }, said: string, shiftsOfDay: (day: number, kind: "day" | "night") => number): { understood: string; changes: PlanChange[]; question: string | null; dropped: number } {
  const r = (v ?? {}) as { understood?: unknown; changes?: unknown; question?: unknown };
  const out: PlanChange[] = [];
  let dropped = 0;
  const now = Date.now();
  const list = Array.isArray(r.changes) ? r.changes.slice(0, 60) : [];
  list.forEach((x: Record<string, unknown>, i: number) => {
    const target = { order: typeof x.order === "string" && known.orders.has(x.order) ? x.order : undefined, ids: Array.isArray(x.ids) ? x.ids.filter((id): id is string => typeof id === "string" && known.acts.has(id)) : undefined };
    const base = { id: `t${now.toString(36)}${i}`, said, at: now };
    if (x.kind === "heads") {
      const crew = typeof x.crew === "string" && known.crews.has(x.crew) ? x.crew : null;
      const n = Number(x.n);
      if (!crew || !Number.isFinite(n)) { dropped++; return; }
      const span = String(x.day ?? "").split("-").map(Number).filter(Number.isFinite);
      const [d0, d1] = [span[0], span[1] ?? span[0]];
      if (!d0) { dropped++; return; }
      const kinds: Array<"day" | "night"> = x.shift === "night" ? ["night"] : x.shift === "both" ? ["day", "night"] : ["day"];
      for (let d = d0; d <= Math.min(d1, d0 + 60); d++) for (const k of kinds) {
        const c = cleanChange({ ...base, id: `${base.id}${d}${k}`, kind: "heads", crew, shift: shiftsOfDay(d, k), n });
        if (c) out.push(c);
      }
      return;
    }
    const c = cleanChange({ ...base, ...x, target, actId: typeof x.actId === "string" && known.acts.has(x.actId) ? x.actId : undefined, after: typeof x.after === "string" && known.acts.has(x.after) ? x.after : null, before: typeof x.before === "string" && known.acts.has(x.before) ? x.before : null });
    if (c) out.push(c); else dropped++;
  });
  return { understood: typeof r.understood === "string" ? r.understood.slice(0, 400) : "", changes: out, question: typeof r.question === "string" && r.question.trim() ? r.question.slice(0, 400) : null, dropped };
}
