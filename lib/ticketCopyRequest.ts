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
//     own prefix (orgs/<org>/tickets/<number>/), under its ORIGINAL number's
//     folder when the restore renumbered it (drafting-flow EDGE-19, DF-P17:
//     a listed file, the number read from the restore's history line —
//     lib/ticketFilePrefix.ts), or at the requester's staged
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
//     such a member the whole workspace, but since DF-P11 (lib/ticketKeyGate.ts,
//     DEC-90 ruling (2)) /api/storage/download-url and /api/storage/resolve
//     refuse that member the request's files (403), as the copy route does —
//     so the browser path says why (READ_SCOPE_FALLBACK_NOTE) and the door's
//     refusal is shown; after the paste the page cannot load the ticket for
//     them at all, so the fallback is never wider than the database. So is a 422 `unstampable` that carries `reason:
//     "oversize"` (DF-P15 fix, on review): a PDF over the server's 64 MB
//     stamping bound was stamped in the tab before DF-P15 (stampPdf /
//     downloadStampedPdf, watermark, QR and superseded footer included), so
//     the page keeps doing that — OVERSIZE_FALLBACK_NOTE says why — and the
//     "take the UNSTAMPED copy anyway?" question is asked only when a stamp
//     really failed. So is a TRANSIENT answer to a print or download — a JSON
//     502 (the storage read failed), a 503 other than `unrecorded` (the
//     ticket, membership or read-scope read failed), or a network failure
//     reaching the route: the server copy was unavailable, not refused, so the
//     page takes the browser path that worked before DF-P15 (stamped and
//     recorded by the tab exactly as before, carrying `acknowledged` when the
//     route already asked its question) and says so in one sentence
//     (serverUnavailableNotice). Ruled by the integrator at the DF-P15 merge,
//     2026-10-20 (DEC-90): option (a) of the final review's issue 1 — no
//     print or download that worked before DF-P15 fails because the new route
//     hiccuped. A 503 `unrecorded` (the record could not be written) stays a
//     refusal: an unrecorded copy is never handed out (DEC-44). Anything else
//     (401, 409 `archived`, 404 not in storage, 503 `unrecorded` …) is said in
//     words and nothing is copied — a preview's transient answer is below.
//   * takeTicketCopy runs the questions in order. A preview ("view") asks
//     none: the stamp says the file's standing, and an unstampable file is
//     shown unstamped and recorded as such (the viewer marks it). A preview
//     the route refuses for a TRANSIENT reason — a JSON 502 (storage read) or
//     a 503 other than `unrecorded` (the ticket, membership or read-scope read
//     failed) — keeps the presigned inline frame it had before DF-P15, the
//     reason said (DF-P15 fix, on review): a momentary read failure never
//     blanks a preview the old path would have shown. A preview whose VIEW
//     row was refused (503 `unrecorded`, DEC-44) is still not shown.

import type { TicketAttachment } from "@/types/schema";
import { TICKET_ATTACHMENT_ID_RE } from "@/lib/verifyTicketVerdict";
import { isStagedKeyOf } from "@/lib/ticketCreate";
import { isSafeStorageKey } from "@/lib/storageKey";
import { ticketFolder, underFolder, restoredFromFolder } from "@/lib/ticketFilePrefix";

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
 *  unpasted). The file doors apply the same scope (DF-P11), so the request's
 *  files are not served either (DF-P11 integrator fix pass, DEC-29 wording). */
export const READ_SCOPE_FALLBACK_NOTE =
  "the server's copy route applies the Contractor read scope, which does not include you on this request, and the file doors apply it too, so this request's files are not served to you; until this workspace's database applies that scope, the request itself stays listed and open to you here";

/** What the viewer says when the server answers that a PDF is over its
 *  stamping bound: the copy is stamped in the tab, as before DF-P15. */
export const OVERSIZE_FALLBACK_NOTE = "the file is over the 64 MB the server stamps";

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
  /** drafting-flow EDGE-19 (DF-P17): the ticket's history — a request the
   *  restore renumbered keeps its files under its ORIGINAL number's folder,
   *  read from the restore's own history line (lib/ticketFilePrefix.ts
   *  restoredFromFolder). Absent: the request's own number's folder only. */
  history?: unknown;
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
  const prefix = ticketFolder(org, number);
  const underTicket = !!org && !!number && underFolder(key, prefix);
  const staged = !!org && !!ctx.requesterId && isStagedKeyOf(key, org, ctx.requesterId);
  // EDGE-19 (DF-P17): a file this ticket lists (named once, above) under the
  // original number's folder of a request the restore renumbered — the
  // route's own rule, which confirms the number against the restore's audit
  // row; a refusal there takes the browser path, as before.
  const original = !!org && !!number && !underTicket && !staged ? restoredFromFolder({ orgId: org, ticketNumber: number, history: ctx.history }) : null;
  const underOriginal = !!original && underFolder(key, original);
  if (!key || !isSafeStorageKey(key) || !(underTicket || staged || underOriginal)) return { kind: "browser", reason: "outside_request" };
  return { kind: "server" };
}

export type TicketCopyResponse =
  | { kind: "file"; blob: Blob; filename: string; stamped: boolean }
  | { kind: "confirm"; message: string }
  | { kind: "unstampable"; message: string }
  /** The server cannot issue this file by construction — the browser path.
   *  `transient`: the route was unavailable for a print or download (a JSON
   *  502, a 503 other than `unrecorded`, a network failure) — the browser
   *  path too, said as the server copy being unavailable (DEC-90 ruling). */
  | { kind: "not_server"; message: string; transient?: boolean }
  /** `transient`: the route could not read what it checks right now (a JSON
   *  502, or a 503 other than `unrecorded`) — not a ruling on this caller. */
  | { kind: "refused"; status: number; message: string; transient?: boolean };

/** The file name a response names (Content-Disposition), else the fallback. */
export function filenameFromDisposition(header: string | null | undefined, fallback: string): string {
  const m = /filename="([^"]+)"/i.exec(header ?? "");
  return m?.[1] || fallback;
}

/** What the viewer says, in one sentence, when the server copy route was
 *  unavailable for a print or download and the browser copy was used
 *  (EVID-16 transient fallback — ruled by the integrator at the DF-P15 merge,
 *  2026-10-20, DEC-90). */
export function serverUnavailableNotice(reason: string): string {
  return `The server copy was unavailable (${reason}), so the browser copy was used — stamped and recorded from your browser, as before.`;
}

/** A route message without its "try again" tail — the copy is not retried,
 *  the browser path takes it. */
const transientReason = (message: string) => message.replace(/\s*[—-]\s*try again in a moment\.?\s*$/i, "") || message;

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
    const why = (e as Error)?.message || "network error";
    // The route could not be reached: for a print or download the browser
    // path takes the copy (DEC-90 ruling, see the header); a preview keeps its
    // presigned frame (takeTicketCopy, `transient`).
    if (input.channel !== "view") return { kind: "not_server", message: `the copy route could not be reached (${why})`, transient: true };
    return { kind: "refused", status: 0, message: `The preview could not be requested (${why}).`, transient: true };
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
  const parsed = (await res.json().catch(() => null)) as { error?: string; message?: string; reason?: string } | null;
  if ((parsed === null || typeof parsed !== "object") && PLATFORM_FAILURE_STATUSES.has(res.status)) {
    // The host refused or timed out the function (no JSON body: not the
    // route's answer) — the browser path, said.
    return { kind: "not_server", message: `the server could not deliver it (HTTP ${res.status})` };
  }
  const body = parsed && typeof parsed === "object" ? parsed : {};
  const message = body.message || body.error || `The copy was refused (HTTP ${res.status}).`;
  if (res.status === 409 && body.error === "confirm") return { kind: "confirm", message };
  if (res.status === 422 && body.error === "unstampable" && body.reason === "oversize") {
    // A PDF over the server's stamping bound: the tab stamps it, as before
    // DF-P15 (see the header) — never offered only unstamped.
    return { kind: "not_server", message: OVERSIZE_FALLBACK_NOTE };
  }
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
  const transient = res.status === 502 || (res.status === 503 && body.error !== "unrecorded");
  if (transient && input.channel !== "view") {
    // The server copy was unavailable, not refused: the browser path, said
    // (DEC-90 ruling, see the header). A 503 `unrecorded` never lands here.
    return { kind: "not_server", message: transientReason(message), transient: true };
  }
  return transient ? { kind: "refused", status: res.status, message, transient: true } : { kind: "refused", status: res.status, message };
}

export type TicketCopyOutcome =
  | { kind: "file"; blob: Blob; filename: string; stamped: boolean }
  | { kind: "declined" }
  /** `acknowledged`: the user already answered the route's confirm question
   *  for this copy — the browser path does not ask it a second time. */
  /** `previewOnly`: a preview refused for a transient reason — the presigned
   *  inline frame shows it; print and download still go through the server. */
  /** `transient`: a print or download whose server copy was unavailable —
   *  the browser path, said with serverUnavailableNotice. */
  | { kind: "browser"; message: string; acknowledged?: boolean; previewOnly?: boolean; transient?: boolean }
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
    if (res.kind === "not_server") {
      return {
        kind: "browser",
        message: res.message,
        ...(!view && acknowledged ? { acknowledged: true } : {}),
        ...(!view && res.transient ? { transient: true } : {}),
      };
    }
    if (res.kind === "refused") {
      // A preview refused for a transient reason keeps the presigned inline
      // frame, said (see the header). A print or download's transient answer
      // arrived as not_server (the browser path); what is left is a refusal.
      if (view && res.transient) return { kind: "browser", message: res.message, previewOnly: true };
      return { kind: "refused", message: res.message };
    }
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
