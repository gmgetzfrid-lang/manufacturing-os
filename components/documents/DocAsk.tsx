"use client";

// DocAsk: the "Needed from you" box at the top of a document's panel when
// the person came from a notification, an Inbox row or Home ("?doc=<id>&
// ask=<what>"). It finds out what is really still pending on this document
// for this person and says it: what is wanted, why, by when, and the
// buttons that do it. The buttons call the same functions the panel's own
// sections use, so nothing here is a new way of doing the work.

import React, { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/Button";
import { NeededFromYou, type NeededWhen } from "@/components/ui/NeededFromYou";
import { ErrorNote } from "@/components/ui/ErrorNote";
import SignatureCeremony from "@/components/signatures/SignatureCeremony";
import { appConfirm, appPrompt } from "@/components/providers/DialogProvider";
import { type Ask, dueWords, plainDate, daysFromToday } from "@/lib/asks";
import { markRead } from "@/lib/inAppNotifications";
import { resolveEffectivePolicy, describeInterval, markReviewed } from "@/lib/reviewCycles";
import { effectiveOwnerForDocument } from "@/lib/ownership";
import { listRoster, recordAcknowledgment, nudgeAcknowledgment, type AckRosterRow } from "@/lib/acknowledgments";
import { listDraftRoster, recordReviewSignoff, finalizeReviewedRevision, type ReviewSignoffRow } from "@/lib/reviewControl";
import { getMyPendingAck, acknowledge, type DistributionAck } from "@/lib/distributionAcks";
import { listOpenRequestsForDocument, resolveMarkupRequest } from "@/lib/markupRequests";
import { listActiveHoldsForDocument } from "@/lib/holds";
import { sendBackDraft, extendCheckout } from "@/lib/askActions";
import { friendlyError } from "@/lib/friendlyError";
import { shownRevision, uploadedName } from "@/lib/revisionShown";
import type { AckPolicy, DocumentHold, DocumentRecord, DocumentVersion, ReviewPolicy } from "@/types/schema";

interface Props {
  ask: Ask;
  /** The notification that brought them here, when one did. */
  notificationId?: string | null;
  doc: DocumentRecord;
  version: DocumentVersion | null;
  orgId: string;
  uid: string | null;
  userEmail: string | null;
  activeRole: string;
  /** May record reviews, publish, nudge (owner, publisher, Admin/DocCtrl). */
  canManage: boolean;
  onOpen: () => void;
  canOpen: boolean;
  onCheckout: (doc: DocumentRecord) => void;
  /** Something changed: the panel re-reads what it shows. */
  onChanged?: () => void;
}

type Note = { title?: string; body?: string | null; actor?: string | null; at?: string | null } | null;

const sinceWords = (iso: string | null | undefined): NeededWhen | null => {
  if (!iso) return null;
  const d = daysFromToday(iso);
  if (d == null) return null;
  const ago = -d;
  return { text: `No due date. Asked ${plainDate(iso)}${ago > 0 ? `, ${ago} day${ago === 1 ? "" : "s"} ago` : ", today"}`, soon: ago >= 7, late: ago >= 14 };
};

const where = (src: "document" | "collection" | "library" | null) =>
  src === "document" ? "this document's" : src === "collection" ? "this folder's" : src === "library" ? "this library's" : "the";

export default function DocAsk(p: Props) {
  const { ask, doc, version, orgId, uid, userEmail } = p;
  const router = useRouter();
  const me = (userEmail?.split("@")[0] ?? "").trim() || "user";
  const label = doc.documentNumber || doc.title || doc.name || "this document";
  const rev = shownRevision(version?.revisionLabel ?? doc.rev, uploadedName(doc));

  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actErr, setActErr] = useState<unknown>(null);
  const [done, setDone] = useState<React.ReactNode>(null);
  const [note, setNote] = useState<Note>(null);
  const [tick, setTick] = useState(0);

  // What each ask needs to know.
  const [review, setReview] = useState<{ next: string | null; last: string | null; lastBy: string | null; policy: ReviewPolicy | null; src: "document" | "collection" | "library" | null; owner: string | null; ownerId: string | null } | null>(null);
  const [ackRows, setAckRows] = useState<AckRosterRow[]>([]);
  const [ackSrc, setAckSrc] = useState<"document" | "collection" | "library" | null>(null);
  const [draft, setDraft] = useState<{ versionId: string | null; roster: ReviewSignoffRow[]; changeLog: string | null; by: string | null; at: string | null; fileUrl: string | null } | null>(null);
  const [dist, setDist] = useState<DistributionAck | null>(null);
  const [markups, setMarkups] = useState<Array<{ id: string; by: string | null; message: string | null; at: string; projectId: string | null }>>([]);
  const [session, setSession] = useState<{ id: string; startedAt: string | null; due: string | null; purpose: string | null } | null>(null);
  const [holds, setHolds] = useState<DocumentHold[]>([]);
  const [signing, setSigning] = useState<"ack" | "signoff" | null>(null);

  const load = useCallback(async () => {
    if (!doc.id) return;
    setLoading(true); setLoadErr(null);
    try {
      if (p.notificationId) {
        const { data } = await supabase.from("notifications").select("title, body, actor_name, created_at").eq("id", p.notificationId).maybeSingle();
        setNote(data ? { title: data.title as string, body: (data.body as string | null) ?? null, actor: (data.actor_name as string | null) ?? null, at: (data.created_at as string | null) ?? null } : null);
      }
      if (ask === "review") {
        const { data: d, error } = await supabase.from("documents")
          .select("review_policy, collection_id, library_id, next_review_date, last_reviewed_at, last_reviewed_by, owner_user_id, owner_name").eq("id", doc.id).maybeSingle();
        if (error) throw error;
        const colId = (d?.collection_id as string | null) ?? doc.collectionId ?? null;
        const [{ data: l }, col, evt, owner] = await Promise.all([
          supabase.from("libraries").select("review_policy").eq("id", doc.libraryId).maybeSingle(),
          colId ? supabase.from("collections").select("review_policy").eq("id", colId).maybeSingle() : Promise.resolve({ data: null }),
          supabase.from("document_review_events").select("performed_by_name, performed_at").eq("document_id", doc.id).order("performed_at", { ascending: false }).limit(1),
          effectiveOwnerForDocument({ ownerUserId: (d?.owner_user_id as string | null) ?? null, ownerName: (d?.owner_name as string | null) ?? null, collectionId: colId, libraryId: doc.libraryId }).catch(() => null),
        ]);
        const docPol = (d?.review_policy as ReviewPolicy | null) ?? null;
        const colPol = ((col as { data: { review_policy?: ReviewPolicy | null } | null }).data?.review_policy) ?? null;
        const libPol = (l?.review_policy as ReviewPolicy | null) ?? null;
        const ev = ((evt as { data: Array<{ performed_by_name: string | null; performed_at: string }> | null }).data ?? [])[0];
        setReview({
          next: (d?.next_review_date as string | null) ?? doc.nextReviewDate ?? null,
          last: (d?.last_reviewed_at as string | null) ?? null,
          lastBy: ev?.performed_by_name?.split("@")[0] ?? null,
          policy: resolveEffectivePolicy(docPol, colPol, libPol),
          src: docPol ? "document" : colPol ? "collection" : libPol ? "library" : null,
          owner: owner?.name ?? null, ownerId: owner?.userId ?? null,
        });
      } else if (ask === "ack" || ask === "chase") {
        const [rows, { data: d }, { data: l }] = await Promise.all([
          listRoster(doc.id, doc.currentVersionId ?? null),
          supabase.from("documents").select("ack_policy, collection_id").eq("id", doc.id).maybeSingle(),
          supabase.from("libraries").select("ack_policy").eq("id", doc.libraryId).maybeSingle(),
        ]);
        const colId = (d?.collection_id as string | null) ?? doc.collectionId ?? null;
        const col = colId ? (await supabase.from("collections").select("ack_policy").eq("id", colId).maybeSingle()).data : null;
        const dp = (d?.ack_policy as AckPolicy | null) ?? null, cp = (col?.ack_policy as AckPolicy | null) ?? null, lp = (l?.ack_policy as AckPolicy | null) ?? null;
        setAckSrc(dp ? "document" : cp ? "collection" : lp ? "library" : null);
        setAckRows(rows);
        // A distribution confirmation can come in under the same notice.
        if (ask === "ack" && uid && doc.currentVersionId && !rows.some((r) => r.assigneeUserId === uid && r.status === "pending")) {
          setDist(await getMyPendingAck(doc.currentVersionId, uid));
        }
      }
      if (ask === "signoff" || ask === "publish" || ask === "chase") {
        const { data: d } = await supabase.from("documents").select("pending_version_id").eq("id", doc.id).maybeSingle();
        const pv = (d?.pending_version_id as string | null) ?? null;
        if (pv) {
          const [roster, { data: ver }] = await Promise.all([
            listDraftRoster(doc.id, pv),
            supabase.from("document_versions").select("change_log, created_by_name, created_at, file_url").eq("id", pv).maybeSingle(),
          ]);
          setDraft({ versionId: pv, roster, changeLog: (ver?.change_log as string | null) ?? null, by: ((ver?.created_by_name as string | null) ?? "").split("@")[0] || null, at: (ver?.created_at as string | null) ?? null, fileUrl: (ver?.file_url as string | null) ?? null });
        } else setDraft({ versionId: null, roster: [], changeLog: null, by: null, at: null, fileUrl: null });
      }
      if (ask === "dist" && uid && doc.currentVersionId) setDist(await getMyPendingAck(doc.currentVersionId, uid));
      if (ask === "markup" && uid) {
        const open = await listOpenRequestsForDocument(doc.id);
        setMarkups(open.filter((m) => m.requestedFromUserId === uid).map((m) => ({ id: String(m.id), by: m.requestedByName ?? null, message: m.message ?? null, at: String(m.createdAt ?? ""), projectId: m.projectId ?? null })));
      }
      if (ask === "checkout" && uid) {
        const { data } = await supabase.from("checkout_sessions").select("id, started_at, expected_release_at, auto_expires_at, purpose")
          .eq("document_id", doc.id).eq("user_id", uid).eq("status", "active").order("started_at", { ascending: false }).limit(1);
        const s = (data ?? [])[0] as Record<string, unknown> | undefined;
        setSession(s ? { id: s.id as string, startedAt: (s.started_at as string | null) ?? null, due: (s.expected_release_at as string | null) ?? (s.auto_expires_at as string | null) ?? null, purpose: (s.purpose as string | null) ?? null } : null);
      }
      if (ask === "hold") setHolds(await listActiveHoldsForDocument(doc.id));
    } catch (e) {
      setLoadErr(e);
    } finally {
      setLoading(false);
    }
  }, [ask, doc.id, doc.libraryId, doc.collectionId, doc.currentVersionId, doc.nextReviewDate, p.notificationId, uid]);

  useEffect(() => { void load(); }, [load, tick]);

  /** Run an action: spinner on its button, the box says done or the error. */
  const run = async (key: string, fn: () => Promise<React.ReactNode | void>) => {
    setBusy(key); setActErr(null);
    try {
      const said = await fn();
      if (said) setDone(said);
      if (p.notificationId) void markRead(p.notificationId);
      p.onChanged?.();
    } catch (e) {
      setActErr(e);
    } finally {
      setBusy(null);
    }
  };

  const errLine = actErr ? <ErrorNote compact error={actErr} title={`That didn't go through. ${friendlyError(actErr)}`} next="Nothing was changed. Try again." /> : null;
  const asked = note?.actor ? <> {note.actor} asked{note.at ? ` on ${plainDate(note.at)}` : ""}.</> : null;

  if (loadErr) {
    return <ErrorNote error={loadErr} title="Couldn't check what this document needs from you." onRetry={() => setTick((n) => n + 1)} />;
  }
  if (loading) return <NeededFromYou what="" loading />;
  if (done) {
    return <NeededFromYou done what={done} />;
  }

  // Nothing pending any more: say so (once the thing was done elsewhere,
  // the notice that brought them here is moot).
  const nothing = (what: React.ReactNode) => <NeededFromYou done what={what} />;

  // ── Periodic review ──────────────────────────────────────────────────
  if (ask === "review" && review) {
    const due = dueWords(review.next);
    const lead = review.policy?.leadDays ?? 30;
    const daysLeft = daysFromToday(review.next);
    if (!review.policy) return nothing(<>This document has no review cycle now, so no periodic review is due.</>);
    if (daysLeft != null && daysLeft > lead) return nothing(<>No review is due now. The next one is {plainDate(review.next)}.</>);
    const what = <>Periodic review {due?.late ? "overdue" : "due"}{review.next ? ` ${plainDate(review.next)}` : ""}: confirm {label} is still right, or start a revision.</>;
    const why = (
      <>
        {where(review.src) === "the" ? "The" : `${where(review.src).charAt(0).toUpperCase()}${where(review.src).slice(1)}`} review rule: {describeInterval(review.policy).toLowerCase()}.{" "}
        {review.last ? <>Last reviewed {plainDate(review.last)}{review.lastBy ? ` by ${review.lastBy}` : ""}.</> : <>No review recorded yet.</>}
        {!p.canManage && <> {review.owner ? `${review.owner} (the owner)` : "The owner or document control"} records it.</>}
      </>
    );
    const sourcePath = version?.fileUrl ?? "";
    const startRevision = () => {
      const params = new URLSearchParams({
        title: `Revision: ${label}${doc.title && doc.title !== label ? `, ${doc.title}` : ""}`,
        description: [
          `Source: ${label}${rev ? ` Rev ${rev}` : ""}${doc.title && doc.title !== label ? ` - ${doc.title}` : ""}`,
          `Periodic review${review.next ? ` (due ${plainDate(review.next)})` : ""} found it needs changes.`,
          "\nWhat needs to change:\n- ",
        ].join("\n"),
        sourceDocId: String(doc.id ?? ""),
        sourceDocNum: String(doc.documentNumber ?? ""),
        sourceDocTitle: String(doc.title ?? ""),
        sourceDocRev: rev ?? "",
      });
      if (sourcePath) { params.set("sourceFileUrl", sourcePath); params.set("sourceFileName", uploadedName(doc) || "document"); }
      router.push(`/requests/new?${params.toString()}`);
    };
    return (
      <NeededFromYou what={what} why={why} when={due} note={errLine ?? (p.canManage
        ? <>Still current records the review and starts the next {describeInterval(review.policy).replace(/^Every /, "").toLowerCase()}. Needs changes records that and opens a drafting request for the revision.</>
        : <>Needs changes opens a drafting request for the revision.</>)}>
        {p.canManage && uid && (
          <Button loading={busy === "current"} onClick={() => void run("current", async () => {
            const r = await markReviewed({ orgId, documentId: doc.id!, userId: uid, userName: userEmail, outcome: "no_change" });
            return <>Review recorded: {label} is still current.{r.nextReviewDate ? ` Next review due ${plainDate(r.nextReviewDate)}.` : ""}</>;
          })}>Still current</Button>
        )}
        <Button variant={p.canManage ? "secondary" : "primary"} loading={busy === "changes"} onClick={() => void run("changes", async () => {
          if (p.canManage && uid) await markReviewed({ orgId, documentId: doc.id!, userId: uid, userName: userEmail, outcome: "needs_revision" });
          startRevision();
        })}>Needs changes</Button>
        {p.canOpen && <Button variant="tertiary" onClick={p.onOpen}>Open it to check</Button>}
      </NeededFromYou>
    );
  }

  // ── Read and acknowledge ─────────────────────────────────────────────
  const myAck = ackRows.find((r) => r.assigneeUserId === uid && r.status === "pending");
  if (ask === "ack" && myAck) {
    const r = myAck.revisionLabel || rev;
    return (
      <>
        <NeededFromYou
          what={<>Read {label}{r ? ` Rev ${r}` : ""} and confirm you understood it.</>}
          why={<>You&apos;re on {where(ackSrc)} read-and-understood list for this revision.{asked}</>}
          when={sinceWords(myAck.assignedAt)}
          note={errLine ?? <>Your confirmation goes on the record with your signature.</>}
        >
          <Button loading={busy === "ack"} onClick={() => setSigning("ack")}>I&apos;ve read and understood it</Button>
          {p.canOpen && <Button variant="secondary" onClick={p.onOpen}>Open it to read</Button>}
        </NeededFromYou>
        {signing === "ack" && (
          <SignatureCeremony
            signerName={me}
            resourceLabel={`${label}${r ? ` Rev ${r}` : ""}`}
            defaultIntent="Acknowledged"
            defaultStatement={`I, ${me}, confirm I have READ and UNDERSTOOD ${label}${r ? ` Rev ${r}` : ""}, and affirm this as my electronic signature.`}
            lockIntent
            busy={busy === "ack"}
            onCancel={() => { if (!busy) setSigning(null); }}
            onSign={(_i, statement, img) => void run("ack", async () => {
              await recordAcknowledgment({
                orgId, documentId: doc.id!, documentVersionId: doc.currentVersionId ?? null, revisionLabel: myAck.revisionLabel, rosterId: myAck.id,
                signerUserId: uid!, signerName: me, signerRole: p.activeRole ?? null, signerEmail: userEmail ?? null, statement, signatureImage: img ?? null,
              });
              setSigning(null);
              return <>Acknowledged: {label}{r ? ` Rev ${r}` : ""} is on the record with your signature.</>;
            })}
          />
        )}
      </>
    );
  }

  // ── Distribution confirmation ────────────────────────────────────────
  if ((ask === "dist" || ask === "ack") && dist) {
    const r = dist.revLabel || rev;
    return (
      <NeededFromYou
        what={<>Confirm you have {label}{r ? ` Rev ${r}` : ""}, the current revision.</>}
        why={<>{dist.requestedByName ? `${dist.requestedByName.split("@")[0]} sent it to you` : "It was sent to you"} and needs your confirmation for the distribution record.</>}
        when={sinceWords(dist.requestedAt)}
        note={errLine}
      >
        <Button loading={busy === "dist"} onClick={() => void run("dist", async () => {
          await acknowledge(dist.id);
          return <>Confirmed: you have {label}{r ? ` Rev ${r}` : ""}. It&apos;s on the distribution record.</>;
        })}>I have this revision</Button>
        {p.canOpen && <Button variant="secondary" onClick={p.onOpen}>Open it</Button>}
      </NeededFromYou>
    );
  }
  if (ask === "ack" || ask === "dist") {
    const signed = ackRows.find((r) => r.assigneeUserId === uid && r.status === "acknowledged");
    return nothing(signed
      ? <>You acknowledged {label}{signed.revisionLabel ? ` Rev ${signed.revisionLabel}` : ""}{signed.acknowledgedAt ? ` on ${plainDate(signed.acknowledgedAt)}` : ""}. Nothing else is needed.</>
      : <>Nothing waits on you for {label} now: no acknowledgment or confirmation is open for you on the current revision.</>);
  }

  // ── Reviewer sign-off ────────────────────────────────────────────────
  const mine = draft?.roster.find((r) => r.reviewerUserId === uid && r.status === "pending" && (r.slot === "primary" || r.activated));
  const draftLabel = draft?.roster[0]?.revisionLabel ?? null;
  if (ask === "signoff" && draft?.versionId && mine) {
    const primaries = draft.roster.filter((r) => r.slot === "primary");
    const signedN = draft.roster.filter((r) => r.status === "signed").length;
    const viewDraft = async () => {
      if (!draft.fileUrl) return;
      const { resolveFileUrl } = await import("@/lib/storage");
      const url = await resolveFileUrl(draft.fileUrl);
      if (url) window.open(url, "_blank", "noopener");
    };
    return (
      <>
        <NeededFromYou
          what={<>Review draft {draftLabel ?? ""} of {label} and sign it off, or send it back. It can&apos;t publish until you do.</>}
          why={<>
            What changed: {rev ? `Rev ${rev}` : "the current revision"} to draft {draftLabel ?? "(unlabelled)"}{draft.by ? `, put up by ${draft.by}` : ""}{draft.at ? ` on ${plainDate(draft.at)}` : ""}.
            {draft.changeLog ? <> Their note: &ldquo;{draft.changeLog}&rdquo;</> : <> No change note was given.</>}
            {" "}{signedN} of {primaries.length} reviewer{primaries.length === 1 ? "" : "s"} signed.
          </>}
          when={sinceWords(mine.assignedAt)}
          note={errLine ?? <>Send back tells {draft.by ?? "whoever put the draft up"} and the owner what to change. Your sign-off stays open.</>}
        >
          <Button loading={busy === "sign"} onClick={() => setSigning("signoff")}>Sign off</Button>
          <Button variant="secondary" loading={busy === "back"} onClick={() => void run("back", async () => {
            const why = await appPrompt({ title: "Send it back", message: `What needs to change in draft ${draftLabel ?? ""}?`, placeholder: "e.g. Valve tag V-301 should be V-310 on sheet 2" });
            if (!why?.trim() || !uid) return;
            const n = await sendBackDraft({ orgId, documentId: doc.id!, libraryId: doc.libraryId, versionId: draft.versionId!, draftLabel, docLabel: label, reviewerId: uid, reviewerName: me, note: why });
            return <>Sent back{n ? `: ${n === 1 ? "1 person was" : `${n} people were`} told what to change` : ""}. Your sign-off stays open until a corrected draft is up.</>;
          })}>Send back</Button>
          {draft.fileUrl && <Button variant="tertiary" onClick={() => void viewDraft()}>Open the draft</Button>}
        </NeededFromYou>
        {signing === "signoff" && (
          <SignatureCeremony
            signerName={me}
            resourceLabel={`${label} draft ${draftLabel ?? ""}`}
            defaultIntent="Reviewed"
            defaultStatement={`I, ${me}, have REVIEWED ${label} draft ${draftLabel ?? ""} and approve it for issue, and affirm this as my electronic signature.`}
            lockIntent
            busy={busy === "sign"}
            onCancel={() => { if (!busy) setSigning(null); }}
            onSign={(_i, statement, img) => void run("sign", async () => {
              await recordReviewSignoff({
                orgId, documentId: doc.id!, libraryId: doc.libraryId, versionId: draft.versionId!, revisionLabel: draftLabel || "", contentHash: mine.contentHash,
                signoffId: mine.id, signerUserId: uid!, signerName: me, signerRole: p.activeRole ?? null, signerEmail: userEmail ?? null, statement, signatureImage: img ?? null,
              });
              setSigning(null);
              return <>Signed off draft {draftLabel ?? ""} of {label}.{signedN + 1 >= primaries.length ? " Every reviewer has signed: the owner can publish it now." : ` ${primaries.length - signedN - 1} more to sign.`}</>;
            })}
          />
        )}
      </>
    );
  }
  if (ask === "signoff") {
    return nothing(draft?.versionId
      ? <>Your sign-off on {label} draft {draftLabel ?? ""} isn&apos;t waiting: it&apos;s signed, or you aren&apos;t a reviewer on it.</>
      : <>No draft of {label} is in review now, so nothing waits on your sign-off.</>);
  }

  // ── Every reviewer signed: publish ───────────────────────────────────
  if (ask === "publish") {
    const primaries = draft?.roster.filter((r) => r.slot === "primary") ?? [];
    const signedN = draft?.roster.filter((r) => r.status === "signed").length ?? 0;
    const ready = !!draft?.versionId && primaries.length > 0 && signedN >= primaries.length;
    if (!ready) return nothing(draft?.versionId ? <>Draft {draftLabel ?? ""} still has {primaries.length - signedN} sign-off{primaries.length - signedN === 1 ? "" : "s"} to come.</> : <>No draft of {label} is waiting to publish.</>);
    const base = (draftLabel ?? "").replace(/[A-Z]$/, "");
    return (
      <NeededFromYou
        what={<>Every reviewer signed draft {draftLabel}. Publish it{base ? ` as Rev ${base}` : ""}.</>}
        why={<>{primaries.map((r) => r.reviewerName || "A reviewer").join(", ")} signed it off.{asked}</>}
        note={errLine ?? (!p.canManage ? <>The owner or document control publishes it.</> : null)}
      >
        {p.canManage && (
          <Button loading={busy === "pub"} onClick={() => void run("pub", async () => {
            const res = await finalizeReviewedRevision({ orgId, documentId: doc.id!, actorId: uid, actorName: userEmail });
            if (!res.published) throw new Error(res.reason === "incomplete" ? "Not every reviewer has signed off yet." : `It didn't publish (${res.reason ?? "unknown"}).`);
            return <>Published {label}{base ? ` Rev ${base}` : ""}.</>;
          })}>Publish{base ? ` Rev ${base}` : ""}</Button>
        )}
      </NeededFromYou>
    );
  }

  // ── Someone owes a sign-off or acknowledgment: follow up ─────────────
  if (ask === "chase") {
    const pendingAcks = ackRows.filter((r) => r.status === "pending");
    const pendingSigs = draft?.roster.filter((r) => r.status === "pending" && (r.slot === "primary" || r.activated)) ?? [];
    if (pendingAcks.length === 0 && pendingSigs.length === 0) return nothing(<>Everyone has signed. Nothing is outstanding on {label}.</>);
    const names = (xs: Array<{ assigneeName?: string | null; reviewerName?: string | null }>) => xs.slice(0, 4).map((x) => (x.assigneeName ?? x.reviewerName ?? "someone").split("@")[0]).join(", ") + (xs.length > 4 ? ` and ${xs.length - 4} more` : "");
    const oldest = [...pendingAcks.map((r) => r.assignedAt), ...pendingSigs.map((r) => r.assignedAt)].sort()[0];
    return (
      <NeededFromYou
        what={pendingSigs.length
          ? <>Draft {draftLabel ?? ""} of {label} is waiting on {pendingSigs.length} sign-off{pendingSigs.length === 1 ? "" : "s"}: follow up with {names(pendingSigs)}.</>
          : <>{pendingAcks.length} {pendingAcks.length === 1 ? "person hasn't" : "people haven't"} acknowledged {label}{rev ? ` Rev ${rev}` : ""}: remind them.</>}
        why={<>{note?.body ?? (pendingSigs.length ? "It can't publish until they sign." : "The revision isn't fully acknowledged until they confirm.")}</>}
        when={sinceWords(oldest)}
        note={errLine}
      >
        {pendingAcks.length > 0 && p.canManage && (
          <Button loading={busy === "nudge"} onClick={() => void run("nudge", async () => {
            for (const r of pendingAcks) await nudgeAcknowledgment({ orgId, rosterId: r.id });
            return <>Reminded {pendingAcks.length} {pendingAcks.length === 1 ? "person" : "people"} to acknowledge {label}.</>;
          })}>Remind {pendingAcks.length === 1 ? "them" : `all ${pendingAcks.length}`}</Button>
        )}
        {pendingSigs.length > 0 && <span className="text-[14px] text-[var(--color-text-muted)]">Under Review and sign-off below you can bring in an alternate reviewer.</span>}
      </NeededFromYou>
    );
  }

  // ── Markups asked for ────────────────────────────────────────────────
  if (ask === "markup") {
    const m = markups[0];
    if (!m) return nothing(<>No markup request on {label} is waiting on you now.</>);
    return (
      <NeededFromYou
        what={<>{m.by ? m.by.split("@")[0] : "Someone"} asked for your markups on {label}{rev ? ` Rev ${rev}` : ""}.</>}
        why={m.message ? <>&ldquo;{m.message}&rdquo;</> : <>No message came with it.</>}
        when={sinceWords(m.at)}
        note={errLine ?? <>Mark it up in the viewer, then mark the request shared so they know.</>}
      >
        {p.canOpen && <Button onClick={p.onOpen}>Open and mark up</Button>}
        <Button variant={p.canOpen ? "secondary" : "primary"} loading={busy === "shared"} onClick={() => void run("shared", async () => {
          await resolveMarkupRequest({ markupRequestId: m.id, status: "shared", orgId, projectId: m.projectId ?? undefined, actorUserId: uid!, actorEmail: userEmail ?? undefined, actorRole: p.activeRole });
          return <>Marked shared. {m.by ? m.by.split("@")[0] : "They"} can see your markups were sent.</>;
        })}>Mark shared</Button>
        <Button variant="tertiary" loading={busy === "decline"} onClick={() => void run("decline", async () => {
          const ok = await appConfirm({ message: `Decline the markup request on ${label}?`, confirmLabel: "Decline", tone: "danger" });
          if (!ok) return;
          await resolveMarkupRequest({ markupRequestId: m.id, status: "declined", orgId, projectId: m.projectId ?? undefined, actorUserId: uid!, actorEmail: userEmail ?? undefined, actorRole: p.activeRole });
          return <>Declined the markup request on {label}.</>;
        })}>Decline</Button>
      </NeededFromYou>
    );
  }

  // ── A checkout of yours ──────────────────────────────────────────────
  if (ask === "checkout") {
    if (session) {
      const late = session.due ? (daysFromToday(session.due) ?? 0) < 0 : false;
      const when: NeededWhen | null = session.due
        ? (late ? { text: `Was due back ${plainDate(session.due)} (${-(daysFromToday(session.due) ?? 0)} days ago)`, late: true } : { text: `Due back ${plainDate(session.due)}`, soon: true })
        : session.startedAt ? { text: `No return date. Out since ${plainDate(session.startedAt)}`, soon: true } : null;
      return (
        <NeededFromYou
          what={<>Check in {label}, or keep it longer. You&apos;ve had it checked out since {plainDate(session.startedAt) || "a while"}.</>}
          why={<>While you hold it, nobody else can check it out or publish over it.{session.purpose ? ` You took it for: ${session.purpose}.` : ""}</>}
          when={when}
          note={errLine ?? <>Keep it 7 more days moves its return date to {plainDate(new Date(Date.now() + 7 * 86_400_000).toISOString())}.</>}
        >
          <Button onClick={() => p.onCheckout(doc)}>Check in</Button>
          <Button variant="secondary" loading={busy === "extend"} onClick={() => void run("extend", async () => {
            const until = await extendCheckout(session.id, 7);
            return <>Kept: {label} is yours until {plainDate(until)}.</>;
          })}>Keep it 7 more days</Button>
        </NeededFromYou>
      );
    }
    const other = doc.checkedOutBy && doc.checkedOutBy !== uid;
    if (other) {
      return (
        <NeededFromYou
          what={<>{doc.checkedOutByName || "Someone else"} has {label} checked out. Talk to them before you change it.</>}
          why={note?.body ?? <>Their changes come in when they check it in; work on an old copy can be lost.</>}
          when={doc.checkedOutAt ? { text: `Checked out ${plainDate(String(doc.checkedOutAt))}` } : null}
        />
      );
    }
    return nothing(<>{note?.body ? `${note.body} ` : ""}You don&apos;t have {label} checked out now. Check it out again if you&apos;re still working on it.</>);
  }

  // ── A hold stops work ────────────────────────────────────────────────
  if (ask === "hold") {
    const h = holds[0];
    if (!h) return nothing(<>The hold on {label} was released. It can be used again.</>);
    return (
      <NeededFromYou
        what={<>Don&apos;t use {label} for work: it&apos;s on hold ({h.reason}).</>}
        why={<>{h.openedByName ? `${h.openedByName.split("@")[0]} put it on hold` : "Put on hold"}{h.openedAt ? ` on ${plainDate(String(h.openedAt))}` : ""}.{h.notes ? ` "${h.notes}"` : ""}{holds.length > 1 ? ` ${holds.length - 1} more hold${holds.length === 2 ? "" : "s"} too.` : ""}</>}
        when={h.expectedReleaseAt ? { text: `Expected to be released ${plainDate(String(h.expectedReleaseAt))}` } : null}
        note={<>Whoever can release it does so in the hold box just below, once the reason is cleared.</>}
      />
    );
  }

  return null;
}
