// lib/ticketAuditDrain.ts
//
// drafting-flow Round G, DF-P8 — SM-7 / EVID-12 (DEC-90 ruling (6) for DF-P8):
// the drain for what the workflow route can only LOG. The route writes every
// transition's audit row first and refuses the transition when it cannot
// (DEC-89 item 2), so no applied transition lacks its row. Two follow-ups are
// best-effort there, retried once and then logged:
//
//   (a) the ticket_comments MIRROR of a workflow comment — reconciled here
//       from tickets.comments (the thread the page renders): a comment in the
//       JSONB, dated inside the window, with no ticket_comments row of its id,
//       is inserted in the route's own mirror shape. A row that exists (even
//       soft-deleted) is never touched; nothing is updated or deleted.
//   (b) the TICKET_<ACTION>_NOT_APPLIED row for an attempt whose transition
//       did not land — reconciled from the ticket's history. Since DF-P8 the
//       transition's own history line names its attempt row (`attempt`), in
//       the same compare-and-set as the status, and the attempt row says so
//       (`details.historyAttempt`). An attempt row older than the settle time,
//       with no follow-up naming it (_NOT_APPLIED / _HOLDS_NOT_RELEASED), on
//       a live ticket whose history carries NO line naming it, did not land:
//       the drain writes its _NOT_APPLIED row (reason "reconciled"). A line
//       naming it means it landed: nothing is written. An attempt row written
//       before DF-P8 (no `historyAttempt`), or a ticket that is archived or
//       gone, cannot be decided from the ticket and is left alone, counted.
//       audit_logs stays append-only.
//
// No new table, no new cron entry: the maintenance cron runs it as one step.
// Never throws; every failure is a line in `errors`. Bounded by row caps and
// the caller's deadline.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (table: string) => any };

/** How far back the drain looks (both legs). */
export const AUDIT_DRAIN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** An attempt younger than this may still be in flight — never decided. */
export const AUDIT_DRAIN_SETTLE_MS = 15 * 60 * 1000;
/** Tickets (leg a) and attempt rows (leg b) one run reads. */
export const AUDIT_DRAIN_ROWS = 300;
const CHUNK = 100;

export interface TicketAuditDrainReport {
  mirrorsReconciled: number;
  notAppliedWritten: number;
  /** attempt rows the ticket proved landed */
  attemptsLanded: number;
  /** attempt rows that could not be decided (archived / missing ticket) */
  undecidable: number;
  truncated: boolean;
  errors: string[];
}

type CommentJson = { id?: unknown; user?: unknown; role?: unknown; text?: unknown; type?: unknown; category?: unknown; date?: unknown; authorUid?: unknown };

/** The mirror row the workflow route writes for a comment (pure). */
export function mirrorRowFor(ticket: { id: string; org_id: string }, c: CommentJson): Record<string, unknown> | null {
  if (typeof c.id !== "string" || !c.id) return null;
  return {
    id: c.id,
    org_id: ticket.org_id,
    ticket_id: ticket.id,
    author_uid: typeof c.authorUid === "string" ? c.authorUid : null,
    author_email: typeof c.user === "string" ? c.user : null,
    author_role: typeof c.role === "string" ? c.role : null,
    body: typeof c.text === "string" ? c.text : "",
    type: typeof c.type === "string" ? c.type : "General",
    category: typeof c.category === "string" ? c.category : null,
    mentioned_uids: [],
    created_at: typeof c.date === "string" ? c.date : new Date().toISOString(),
  };
}

/** Did this ticket's history record the attempt landing? (pure) */
export function historyNamesAttempt(history: unknown, attemptId: string): boolean {
  return Array.isArray(history) && history.some((h) => !!h && typeof h === "object" && (h as { attempt?: unknown }).attempt === attemptId);
}

export async function runTicketAuditDrain(opts: { client: Db; deadlineAt: number; now?: number }): Promise<TicketAuditDrainReport> {
  const sb = opts.client;
  const now = opts.now ?? Date.now();
  const since = new Date(now - AUDIT_DRAIN_WINDOW_MS).toISOString();
  const settled = new Date(now - AUDIT_DRAIN_SETTLE_MS).toISOString();
  const r: TicketAuditDrainReport = { mirrorsReconciled: 0, notAppliedWritten: 0, attemptsLanded: 0, undecidable: 0, truncated: false, errors: [] };
  const timeLeft = () => Date.now() < opts.deadlineAt;

  // ── (a) ticket_comments mirrors ──────────────────────────────────────────
  try {
    const { data: tickets, error } = await sb.from("tickets")
      .select("id, org_id, comments")
      .gte("last_modified", since).is("archived_at", null)
      .order("last_modified", { ascending: false }).limit(AUDIT_DRAIN_ROWS);
    if (error) {
      r.errors.push(`ticket-audit-drain: the recent tickets could not be read (${error.message}) — no comment mirror reconciled this run`);
    } else {
      const rows = (tickets ?? []) as Array<{ id: string; org_id: string; comments: unknown }>;
      if (rows.length >= AUDIT_DRAIN_ROWS) r.truncated = true;
      const wanted: Array<Record<string, unknown>> = [];
      for (const t of rows) {
        for (const c of (Array.isArray(t.comments) ? t.comments : []) as CommentJson[]) {
          if (!c || typeof c !== "object" || typeof c.date !== "string" || c.date < since) continue;
          const m = mirrorRowFor(t, c);
          if (m) wanted.push(m);
        }
      }
      const have = new Set<string>();
      let readOk = true;
      for (let i = 0; i < wanted.length && readOk; i += CHUNK) {
        const ids = wanted.slice(i, i + CHUNK).map((w) => String(w.id));
        const { data, error: e2 } = await sb.from("ticket_comments").select("id").in("id", ids);
        if (e2) { readOk = false; r.errors.push(`ticket-audit-drain: the comment mirror could not be read (${e2.message}) — nothing inserted this run`); break; }
        for (const x of (data ?? []) as Array<{ id: string }>) have.add(String(x.id));
      }
      if (readOk) {
        for (const w of wanted) {
          if (have.has(String(w.id))) continue;
          if (!timeLeft()) { r.truncated = true; break; }
          const { error: insErr } = await sb.from("ticket_comments").insert(w);
          if (!insErr || insErr.code === "23505") r.mirrorsReconciled += insErr ? 0 : 1;
          else r.errors.push(`ticket-audit-drain: the mirror of comment ${String(w.id)} on ticket ${String(w.ticket_id)} could not be written (${insErr.message})`);
        }
      }
    }
  } catch (e) {
    r.errors.push(`ticket-audit-drain (mirrors): ${(e as Error)?.message ?? String(e)}`);
  }

  // ── (b) _NOT_APPLIED rows ────────────────────────────────────────────────
  try {
    if (!timeLeft()) { r.truncated = true; return r; }
    const { data: attempts, error } = await sb.from("audit_logs")
      .select("id, action, resource_id, org_id, user_id, user_email, user_role, details, timestamp")
      .eq("resource_type", "ticket").like("action", "TICKET\\_%")
      .eq("details->>historyAttempt", "true")
      .gte("timestamp", since).lte("timestamp", settled)
      .order("timestamp", { ascending: false }).limit(AUDIT_DRAIN_ROWS);
    if (error) {
      r.errors.push(`ticket-audit-drain: the attempt rows could not be read (${error.message}) — nothing reconciled this run`);
      return r;
    }
    const rows = (attempts ?? []) as Array<{ id: string; action: string; resource_id: string; org_id: string; user_id: string | null; user_email: string | null; user_role: string | null; details: Record<string, unknown> | null }>;
    if (rows.length >= AUDIT_DRAIN_ROWS) r.truncated = true;
    if (rows.length === 0) return r;
    // Follow-ups that name an attempt settle it (either way) — never decided
    // twice. Read by the tickets' own rows (resource_type / resource_id), in
    // the window, never by a scan of the JSON.
    const named = new Set<string>();
    const allTickets = [...new Set(rows.map((x) => x.resource_id))];
    for (let i = 0; i < allTickets.length; i += CHUNK) {
      const { data, error: e2 } = await sb.from("audit_logs").select("details")
        .eq("resource_type", "ticket").in("resource_id", allTickets.slice(i, i + CHUNK)).like("action", "TICKET%NOT%").gte("timestamp", since);
      if (e2) { r.errors.push(`ticket-audit-drain: the follow-up rows could not be read (${e2.message}) — nothing reconciled this run`); return r; }
      for (const x of (data ?? []) as Array<{ details: Record<string, unknown> | null }>) {
        const a = x.details?.attempt;
        if (typeof a === "string") named.add(a);
      }
    }
    const open = rows.filter((x) => !named.has(x.id));
    const ticketIds = [...new Set(open.map((x) => x.resource_id))];
    const tickets = new Map<string, { history: unknown; archived_at: string | null }>();
    for (let i = 0; i < ticketIds.length; i += CHUNK) {
      const { data, error: e3 } = await sb.from("tickets").select("id, history, archived_at").in("id", ticketIds.slice(i, i + CHUNK));
      if (e3) { r.errors.push(`ticket-audit-drain: the tickets could not be read (${e3.message}) — nothing reconciled this run`); return r; }
      for (const t of (data ?? []) as Array<{ id: string; history: unknown; archived_at: string | null }>) tickets.set(String(t.id), t);
    }
    for (const a of open) {
      if (!timeLeft()) { r.truncated = true; break; }
      const t = tickets.get(a.resource_id);
      if (!t || t.archived_at) { r.undecidable += 1; continue; }
      if (historyNamesAttempt(t.history, a.id)) { r.attemptsLanded += 1; continue; }
      const { error: insErr } = await sb.from("audit_logs").insert({
        id: crypto.randomUUID(),
        action: `${a.action}_NOT_APPLIED`,
        resource_id: a.resource_id, resource_type: "ticket", org_id: a.org_id,
        user_id: a.user_id, user_email: a.user_email, user_role: a.user_role,
        details: {
          attempt: a.id, from: a.details?.from ?? null, to: a.details?.to ?? null,
          reason: "reconciled", reconciledBy: "maintenance",
          note: "The route could not record that this transition did not land; the ticket's history carries no line naming the attempt.",
        },
      });
      if (insErr) r.errors.push(`ticket-audit-drain: the _NOT_APPLIED row for attempt ${a.id} could not be written (${insErr.message}) — the next run retries`);
      else r.notAppliedWritten += 1;
    }
  } catch (e) {
    r.errors.push(`ticket-audit-drain (attempts): ${(e as Error)?.message ?? String(e)}`);
  }
  return r;
}
