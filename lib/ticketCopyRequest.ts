// lib/ticketCopyRequest.ts
//
// drafting-flow EVID-16 done-when 2 (DF-P15 DELIVERABLE PAGE WIRING): the
// ticket page's print, download and inline PDF preview go through the server
// copy route (POST /api/tickets/copy, DF-P12), which stamps the file and
// writes its record in the request that issues the bytes. Pulled out of the
// page (app/(protected)/requests/[id] FileViewerModal) so the rules are
// tested.
//
//   * Which path a file takes (ticketFileCopyPath): the route issues a file
//     the ticket names ONCE by a well-formed id, stored under the ticket's
//     own prefix (orgs/<org>/tickets/<number>/) or at the requester's staged
//     key — the route's own rule, mirrored here so the page never sends it a
//     file it will refuse by construction. Anything else keeps the page's
//     BROWSER path (stamped and recorded from the tab, as before DF-P15), and
//     the viewer says so: a legacy absolute-URL file (the route never fetches
//     a URL a row names), a library file named at filing (a Source reference
//     — a register key, not this request's storage), and a file the ticket
//     does not name once by a well-formed id. A PRINT of a file that is not
//     a PDF keeps the browser path too (the page's handlePrint — a hidden
//     frame prints a PDF or an image loaded from the file itself, never an
//     application/octet-stream blob, which the browser would download). With
//     the route's streamed body and the fallbacks below, every print and
//     download that worked before still works for the same people — a
//     Contractor-only member outside the route's read scope included (the
//     "Request not found" fallback below; DF-P15 fix, on review).
//   * The route's answers (requestTicketCopy): the bytes; 409 `confirm` (a
//     superseded, withdrawn or in-progress file — asked, then retried with
//     `acknowledged`); 422 `unstampable` (asked, then retried with
//     `acceptUnstamped`, the copy recorded as unstamped); a refusal that says
//     the server cannot issue THIS file (409 `legacy_file`, 409 "not stored
//     under this request", 404 "not on this request", 400) → the browser path,
//     said; so is a PLATFORM failure that carries no JSON body (413 / 500 /
//     502 / 504 — the host refusing or timing out the function, not the
//     route answering) and a copy whose bytes were cut off in transit: the
//     user still gets the file, stamped and recorded from the tab (DF-P15
//     fix; the route streams its body, so a large file no longer meets the
//     host's buffered-response cap — this is the fallback if anything else
//     does). So is the route's 404 "Request not found" (DF-P15 fix, on
//     review): the page only opens this viewer for a ticket it has loaded,
//     so the caller can read the ticket here — the route answers 404 when
//     its Contractor-only read scope (lib/ticketReadScope.ts, AUTHZ-13 /
//     DEC-89) leaves the caller out, a scope the database applies only once
//     migration 20261166 is pasted. Until then the tickets RLS still shows
//     such a member the whole workspace and /api/storage/download-url signs
//     their copy, so the browser path keeps what they could do before DF-P15
//     (READ_SCOPE_FALLBACK_NOTE says why); after the paste the page cannot
//     load the ticket for them at all, so the fallback is never wider than
//     the database. Anything else (401, 409 `archived`, 503 `unrecorded`, a
//     JSON 502 …) is said in words and nothing is copied.
//   * takeTicketCopy runs the questions in order. A preview ("view") asks
//     none: the stamp says the file's standing, and an unstampable file is
//     shown unstamped and recorded as such (the viewer marks it).

import type { TicketAttachment } from "@/types/schema";
import { TICKET_ATTACHMENT_ID_RE } from "@/lib/verifyTicketVerdict";
import { isStagedKeyOf } from "@/lib/ticketCreate";
import { isSafeStorageKey } from "@/lib/storageKey";

export type TicketCopyRequestChannel = "print" | "download" | "view";

export type TicketCopyBrowserReason = "legacy_url" | "outside_request" | "unaddressable";

export type TicketCopyPath = { kind: "server" } | { kind: "browser"; reason: TicketCopyBrowserReason };

/** What the viewer says about a file that keeps the browser path. */
export const BROWSER_PATH_NOTE: Record<TicketCopyBrowserReason, string> = {
  legacy_url: "This file was recorded before files were stored by path, so the server cannot issue it: its copies are stamped and recorded from your browser.",
  outside_request: "This file is kept outside this request's storage (a library file named when the request was filed), so its copies are stamped and recorded from your browser.",
  unaddressable: "This file is not named once on this request, so the server cannot issue it: its copies are stamped and recorded from your browser.",
};

/** What the viewer says when the copy route answers "Request not found" for a
 *  ticket this page has loaded: the route's Contractor-only read scope leaves
 *  the caller out, and the database does not apply that scope yet (20261166
 *  unpasted) — the browser path, as before DF-P15. */
export const READ_SCOPE_FALLBACK_NOTE =
  "the server's copy route applies the Contractor read scope, which does not include you on this request; until this workspace's database applies that scope too, the request stays open to you here";

/** What the viewer says about a non-PDF file the server issues: its print
 *  keeps the browser path (a hidden frame cannot print a downloaded blob). */
export const NON_PDF_PRINT_NOTE =
  "This file is not a PDF, so it cannot carry the watermark / QR stamp: a print of it is loaded from the file itself and recorded from your browser. Its download is issued and recorded by the server, marked unstamped.";

export interface TicketCopyContext {
  /** The ticket's row id (the route's ticketId). */
  ticketRowId?: string | null;
  /** The ticket's workspace and request number — its storage prefix. */
  orgId?: string | null;
  ticketNumber?: string | null;
  /** The requester — a creation-time file may still sit at their staged key. */
  requesterId?: string | null;
  /** Every file the ticket lists (an id named twice is not addressable). */
  attachments?: ReadonlyArray<{ id?: string | null } | null | undefined> | null;
}

/** Which path this file's copies take — the route's own door, mirrored. */
export function ticketFileCopyPath(file: Pick<TicketAttachment, "id" | "url">, ctx: TicketCopyContext): TicketCopyPath {
  const key = typeof file.url === "string" ? file.url : "";
  if (/^https?:\/\//i.test(key)) return { kind: "browser", reason: "legacy_url" };
  const id = typeof file.id === "string" ? file.id : "";
  const named = (ctx.attachments ?? []).filter((a) => a && a.id === id).length;
  if (!ctx.ticketRowId || !id || !TICKET_ATTACHMENT_ID_RE.test(id) || named !== 1) {
    return { kind: "browser", reason: "unaddressable" };
  }
  const org = ctx.orgId ?? "";
  const number = ctx.ticketNumber ?? "";
  const prefix = `orgs/${org}/tickets/${number}/`;
  const underTicket = !!org && !!number && key.startsWith(prefix) && key.length > prefix.length;
  const staged = !!org && !!ctx.requesterId && isStagedKeyOf(key, org, ctx.requesterId);
  if (!key || !isSafeStorageKey(key) || !(underTicket || staged)) return { kind: "browser", reason: "outside_request" };
  return { kind: "server" };
}

export type TicketCopyResponse =
  | { kind: "file"; blob: Blob; filename: string; stamped: boolean }
  | { kind: "confirm"; message: string }
  | { kind: "unstampable"; message: string }
  /** The server cannot issue this file by construction — the browser path. */
  | { kind: "not_server"; message: string }
  | { kind: "refused"; status: number; message: string };

/** The file name a response names (Content-Disposition), else the fallback. */
export function filenameFromDisposition(header: string | null | undefined, fallback: string): string {
  const m = /filename="([^"]+)"/i.exec(header ?? "");
  return m?.[1] || fallback;
}

/** Statuses the HOST answers (no JSON body) when it refuses or times out the
 *  function — a too-large response, a crash, a gateway timeout. */
const PLATFORM_FAILURE_STATUSES = new Set([413, 500, 502, 504]);

type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>;

/** One call to POST /api/tickets/copy, its answer classified. Never throws. */
export async function requestTicketCopy(
  input: {
    ticketRowId: string;
    attachmentId: string;
    channel: TicketCopyRequestChannel;
    token: string;
    fallbackName: string;
    acknowledged?: boolean;
    acceptUnstamped?: boolean;
  },
  fetchImpl: FetchLike = (u, i) => fetch(u, i),
): Promise<TicketCopyResponse> {
  let res: Response;
  try {
    res = await fetchImpl("/api/tickets/copy", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${input.token}` },
      body: JSON.stringify({
        ticketId: input.ticketRowId,
        attachmentId: input.attachmentId,
        channel: input.channel,
        ...(input.acknowledged ? { acknowledged: true } : {}),
        ...(input.acceptUnstamped ? { acceptUnstamped: true } : {}),
      }),
    });
  } catch (e) {
    return { kind: "refused", status: 0, message: `The copy could not be requested (${(e as Error)?.message || "network error"}). Try again in a moment.` };
  }
  if (res.ok) {
    let blob: Blob;
    try {
      blob = await res.blob();
    } catch (e) {
      return { kind: "not_server", message: `the copy was cut off in transit (${(e as Error)?.message || "connection closed"})` };
    }
    return {
      kind: "file",
      blob,
      filename: filenameFromDisposition(res.headers.get("content-disposition"), input.fallbackName),
      stamped: res.headers.get("x-ticket-copy-stamped") === "1",
    };
  }
  const parsed = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if ((parsed === null || typeof parsed !== "object") && PLATFORM_FAILURE_STATUSES.has(res.status)) {
    // The host refused or timed out the function (no JSON body: not the
    // route's answer) — the browser path, said.
    return { kind: "not_server", message: `the server could not deliver it (HTTP ${res.status})` };
  }
  const body = parsed && typeof parsed === "object" ? parsed : {};
  const message = body.message || body.error || `The copy was refused (HTTP ${res.status}).`;
  if (res.status === 409 && body.error === "confirm") return { kind: "confirm", message };
  if (res.status === 422 && body.error === "unstampable") return { kind: "unstampable", message };
  if (res.status === 409 && (body.error === "legacy_file" || body.error === "That file is not stored under this request")) {
    return { kind: "not_server", message };
  }
  if ((res.status === 404 && body.error === "That file is not on this request") || res.status === 400) {
    return { kind: "not_server", message };
  }
  if (res.status === 404 && body.error === "Request not found") {
    // The route's read scope leaves the caller out of a ticket the page could
    // load — the database's scope is not applied yet (see the header).
    return { kind: "not_server", message: READ_SCOPE_FALLBACK_NOTE };
  }
  return { kind: "refused", status: res.status, message };
}

export type TicketCopyOutcome =
  | { kind: "file"; blob: Blob; filename: string; stamped: boolean }
  | { kind: "declined" }
  | { kind: "browser"; message: string }
  | { kind: "refused"; message: string };

/** The whole exchange for one copy: the questions the route asks, asked in
 *  order (each at most once), then the bytes — or the browser path, or a
 *  refusal in words. A preview ("view") asks nothing (see the header). */
export async function takeTicketCopy(input: {
  ticketRowId: string;
  attachmentId: string;
  channel: TicketCopyRequestChannel;
  fallbackName: string;
  getToken: () => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  fetchImpl?: FetchLike;
}): Promise<TicketCopyOutcome> {
  const token = await input.getToken();
  if (!token) return { kind: "refused", message: "You're not signed in, so no copy was taken." };
  const view = input.channel === "view";
  let acknowledged = view;
  let acceptUnstamped = view;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await requestTicketCopy({
      ticketRowId: input.ticketRowId, attachmentId: input.attachmentId, channel: input.channel,
      token, fallbackName: input.fallbackName, acknowledged, acceptUnstamped,
    }, input.fetchImpl);
    if (res.kind === "file") return res;
    if (res.kind === "not_server") return { kind: "browser", message: res.message };
    if (res.kind === "refused") return { kind: "refused", message: res.message };
    if (res.kind === "confirm") {
      if (acknowledged || !(await input.confirm(res.message))) return acknowledged ? { kind: "refused", message: res.message } : { kind: "declined" };
      acknowledged = true;
      continue;
    }
    // unstampable
    if (acceptUnstamped || !(await input.confirm(res.message))) return acceptUnstamped ? { kind: "refused", message: res.message } : { kind: "declined" };
    acceptUnstamped = true;
  }
  return { kind: "refused", message: "The copy could not be completed — try again in a moment." };
}
