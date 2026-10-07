// lib/recordTime.ts
//
// One way to write a moment into a server-composed notification or email
// body (notifications Round G, N6 — NEDGE-12 done-when 1). A server's bare
// toLocaleString() / toLocaleDateString() prints the runtime's locale and
// zone (en-US / UTC on Vercel) with no zone label, so a recipient reads a
// shifted, unlabelled time — and the bell, which formats in the viewer's own
// browser, disagrees with the email about the same event by up to a day.
//
// Here a moment is ISO-8601 with its offset and the zone named beside it:
//   formatRecordTime("2026-03-20T23:15:15Z")                    → "2026-03-20T23:15:15+00:00 (UTC)"
//   formatRecordTime("2026-03-20T23:15:15Z", "America/Chicago") → "2026-03-20T18:15:15-05:00 (America/Chicago)"
//   formatRecordDate("2026-03-20T23:15:15Z")                    → "2026-03-20 (UTC)"
//
// The zone is the org's when one is configured (org_configurations key
// "timezone", data.timeZone — an IANA name; orgTimeZone), else UTC, labelled
// as such. Nothing writes that key yet: an org-level timezone setting is its
// own finding (NEDGE-19, opened by N6), so today every body reads UTC.
//
// Server-safe and browser-safe: Intl only.

/** Whether `tz` is an IANA zone this runtime knows. */
export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function toDate(input: string | number | Date): Date | null {
  const d = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The wall-clock parts of `d` in `tz`, and its UTC offset there ("+HH:MM"). */
function partsIn(d: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    timeZoneName: "longOffset",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  // "GMT-05:00", "GMT+05:30", or "GMT" for a zero offset
  const m = /^GMT([+-]\d{2}):?(\d{2})?$/.exec(p.timeZoneName ?? "");
  const offset = m ? `${m[1]}:${m[2] ?? "00"}` : "+00:00";
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}`, offset };
}

/** A moment as ISO-8601 with its offset, the zone named: in `timeZone` when it
 *  is a valid IANA zone, else UTC. An unparseable input is returned as given
 *  — never "Invalid Date" in a record. */
export function formatRecordTime(input: string | number | Date, timeZone?: string | null): string {
  const d = toDate(input);
  if (!d) return String(input);
  if (isValidTimeZone(timeZone) && timeZone !== "UTC") {
    const { date, time, offset } = partsIn(d, timeZone);
    return `${date}T${time}${offset} (${timeZone})`;
  }
  return `${d.toISOString().slice(0, 19)}+00:00 (UTC)`;
}

/** A calendar day (ISO-8601) in `timeZone` when valid, else UTC, the zone
 *  named — for a body that says "since <day>". */
export function formatRecordDate(input: string | number | Date, timeZone?: string | null): string {
  const d = toDate(input);
  if (!d) return String(input);
  if (isValidTimeZone(timeZone) && timeZone !== "UTC") return `${partsIn(d, timeZone).date} (${timeZone})`;
  return `${d.toISOString().slice(0, 10)} (UTC)`;
}

type ConfigClient = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => { maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }> };
      };
    };
  };
};

/** The org's configured zone — org_configurations key "timezone",
 *  data.timeZone, when it names a valid IANA zone — else null (UTC). A read
 *  that fails is null too: a label falls back to UTC, never blocks a body. */
export async function orgTimeZone(client: unknown, orgId: string): Promise<string | null> {
  if (!orgId) return null;
  try {
    const { data, error } = await (client as ConfigClient)
      .from("org_configurations").select("data").eq("org_id", orgId).eq("key", "timezone").maybeSingle();
    if (error || !data) return null;
    const tz = ((data as { data?: { timeZone?: unknown } }).data?.timeZone ?? null) as string | null;
    return isValidTimeZone(tz) ? tz : null;
  } catch {
    return null;
  }
}
