// lib/documentShares.ts
//
// The browser side of sending documents. Links for people outside the
// company are made, listed and turned off only through the server
// (/api/share/create, /list, /revoke), which checks the sender can open
// every document first. The table itself is read-only to members.
//
// Links for people in this workspace are just the app's own addresses:
// they sign in and see the live document.

import { supabase } from "@/lib/supabase";
import { publicOrigin } from "@/lib/publicOrigin";

/** A link already sent outside the company, as the Send sheet lists it. */
export interface SentLink {
  id: string;
  /** Only for the person who made it (so they can copy it again). */
  url: string | null;
  mine: boolean;
  recipient: string | null;
  createdAt: string | null;
  createdByName: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  accessCount: number;
  accessLastAt: string | null;
  withCode: boolean;
  allowDownload: boolean;
  /** Too many wrong codes: the link no longer opens. */
  locked: boolean;
  documentIds: string[];
  markedUpIds: string[];
}

export interface CreatedLink {
  id: string;
  token: string;
  url: string;
  /** The 6-digit code, when one was asked for. Shown this once only. */
  code: string | null;
  expiresAt: string;
}

/** One document on a link, as the public page shows it. */
export interface ResolvedShareItem {
  documentId: string;
  documentNumber: string | null;
  title: string | null;
  rev: string | null;
  /** The sender's marked-up copy rather than the issued file. */
  markedUp: boolean;
  /** False when there's no file that can be shown (none issued, or not a PDF or picture). */
  viewable: boolean;
}
export interface ResolvedShare {
  orgName: string | null;
  /** The sending workspace's logo link (/api/brand/logo), when it has one. */
  orgLogo?: string | null;
  senderName: string | null;
  recipient: string | null;
  expiresAt: string | null;
  allowDownload: boolean;
  items: ResolvedShareItem[];
}

async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Sign in again.");
  return { authorization: `Bearer ${session.access_token}` };
}

async function readError(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error || `The server answered ${res.status}.`);
}

export async function createSendLink(input: {
  orgId: string;
  recipient: string;
  expiresDays: 1 | 7 | 30;
  withCode: boolean;
  allowDownload: boolean;
  items: Array<{ documentId: string; markupPath?: string | null }>;
}): Promise<CreatedLink> {
  const res = await fetch("/api/share/create", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeader()) },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as CreatedLink;
}

export async function listSentLinks(orgId: string, docIds: string[]): Promise<SentLink[]> {
  if (docIds.length === 0) return [];
  // The first 150 keep the address a safe length; a bigger set is rare.
  const qs = new URLSearchParams({ orgId, docIds: docIds.slice(0, 150).join(",") });
  const res = await fetch(`/api/share/list?${qs}`, { headers: await authHeader() });
  if (!res.ok) throw await readError(res);
  return ((await res.json()) as { links: SentLink[] }).links ?? [];
}

export async function turnOffSentLink(orgId: string, id: string): Promise<string> {
  const res = await fetch("/api/share/revoke", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ orgId, id }),
  });
  if (!res.ok) throw await readError(res);
  return ((await res.json()) as { revokedAt: string }).revokedAt;
}

/** The app's own address for a document (sign-in needed): /d/<number>, or
 *  the library with the document open when it has no number. */
export function appLinkFor(doc: { id: string; documentNumber: string | null; libraryId: string }): string {
  const origin = publicOrigin();
  return doc.documentNumber
    ? `${origin}/d/${encodeURIComponent(doc.documentNumber)}`
    : `${origin}/documents/${encodeURIComponent(doc.libraryId)}?doc=${encodeURIComponent(doc.id)}`;
}

/** Live: not turned off, not expired, not locked. */
export function linkIsLive(l: Pick<SentLink, "revokedAt" | "expiresAt" | "locked">, now = Date.now()): boolean {
  return !l.revokedAt && !l.locked && !(l.expiresAt && new Date(l.expiresAt).getTime() < now);
}
