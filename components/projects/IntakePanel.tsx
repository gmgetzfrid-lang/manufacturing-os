"use client";

// IntakePanel — the project's controlled drop point (internal door).
// Manage tokenized submit links for contracted companies (no site access:
// they get /submit/<token>), and review the submissions that arrive:
// approve (promotes via the same finalize pipeline as any reviewed
// revision — supersede notices, ack rosters, the works) or reject with the
// reason on the record. Trusted links (auto-supersede own work) are marked.
//
// projects Round G (J1): approve honours the document's review policy
// through the container chain — a policy that REQUIRES sign-off sends the
// submission to its reviewers first (SEC-13); a drawing-class document asks
// for its MOC reference (SEC-14); the approval is of exactly the version on
// screen (SAF-15). A rejection needs a reason, which the contractor sees on
// their portal (SAF-9). Every link expires (SEC-5); quote links live on the
// Costs tab, not here (INTK-12).

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Link2, Loader2, Check, X, UploadCloud, Copy, Ban, ShieldCheck, Clock,
  FilePlus2, Search,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  finalizeReviewedRevision, finalizeReasonMessage,
  effectiveReviewControlForDocument, listDraftRoster, openReviewRoster,
} from "@/lib/reviewControl";
import { effectiveDocClassForDocument } from "@/lib/docClass";
import { appConfirm, appPrompt } from "@/components/providers/DialogProvider";
import { INTAKE_LINK_DEFAULT_DAYS, INTAKE_LINK_MAX_DAYS, intakeExpiryFor } from "@/lib/intakeLinks";
import { describeProjectSweep } from "@/lib/checklists";
import type { ReviewControl } from "@/types/schema";

// SEC-5: the date picker works in the user's LOCAL calendar (the expiry
// is that day's end, local time — intakeExpiryFor). A UTC date is a day
// ahead west of UTC in the evening, which offered a "90-day" maximum that
// was really 91 and then refused it.
const isoDateInDays = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
import TransitionInPanel from "@/components/projects/TransitionInPanel";
import { flagCollisionToDrafting, TransitionCandidate, TransitionImpact } from "@/lib/transitionIn";

interface IntakeLink {
  id: string; token: string; companyName: string; contactEmail: string | null;
  allowAutoSupersede: boolean; expiresAt: string | null; revokedAt: string | null;
  submissionCount: number; lastUsedAt: string | null;
  assignedDocIds: string[];
}
interface PendingSub {
  docId: string; label: string; pendingVersionId: string; revLabel: string | null;
  company: string | null; submittedAt: string | null; changeLog: string | null;
}

export default function IntakePanel({ orgId, projectId, canManage, uid, userEmail }: {
  orgId: string; projectId: string; canManage: boolean; uid: string; userEmail?: string | null;
}) {
  const [links, setLinks] = useState<IntakeLink[]>([]);
  const [pending, setPending] = useState<PendingSub[]>([]);
  const [libs, setLibs] = useState<Array<{ id: string; name: string }>>([]);
  const [intakeLibraryId, setIntakeLibraryId] = useState<string | null>(null);
  const [intakeCollectionId, setIntakeCollectionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Assign-existing-documents picker (per link)
  const [assignOpen, setAssignOpen] = useState<string | null>(null);
  const [assignQ, setAssignQ] = useState("");
  const [assignResults, setAssignResults] = useState<Array<{ id: string; label: string }>>([]);
  const [assignSearching, setAssignSearching] = useState(false);
  const [docLabels, setDocLabels] = useState<Map<string, string>>(new Map());

  // New-link form
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  // SEC-5: a link always expires — 14 days unless changed, 90 at most.
  const [expires, setExpires] = useState(() => isoDateInDays(INTAKE_LINK_DEFAULT_DAYS));
  const [trusted, setTrusted] = useState(false);
  const [libPick, setLibPick] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // INTK-12: this panel manages DOCUMENT links only — a quote link is
      // the Costs tab's (with its own expiry and revoke), and shown here it
      // would offer an "Assign docs" that does nothing. Tolerant of a
      // database without the purpose column (20261013).
      const linkCols = "id, token, company_name, contact_email, allow_auto_supersede, expires_at, revoked_at, submission_count, last_used_at, assigned_doc_ids";
      const [linksRead, { data: proj }, { data: ls }] = await Promise.all([
        supabase.from("project_intake_links").select(linkCols)
          .eq("project_id", projectId).eq("purpose", "documents").order("created_at", { ascending: false }),
        supabase.from("projects").select("intake_library_id, intake_collection_id").eq("id", projectId).maybeSingle(),
        supabase.from("libraries").select("id, name").eq("org_id", orgId).order("name"),
      ]);
      let lk = linksRead.data;
      if (linksRead.error && /purpose/.test(linksRead.error.message ?? "")) {
        ({ data: lk } = await supabase.from("project_intake_links").select(linkCols)
          .eq("project_id", projectId).order("created_at", { ascending: false }));
      } else if (linksRead.error) {
        throw new Error(linksRead.error.message);
      }
      const linkRows = (((lk ?? []) as Array<Record<string, unknown>>)).map((r) => ({
        id: String(r.id), token: String(r.token), companyName: String(r.company_name),
        contactEmail: (r.contact_email as string | null) ?? null,
        allowAutoSupersede: !!r.allow_auto_supersede,
        expiresAt: (r.expires_at as string | null) ?? null,
        revokedAt: (r.revoked_at as string | null) ?? null,
        submissionCount: Number(r.submission_count ?? 0),
        lastUsedAt: (r.last_used_at as string | null) ?? null,
        assignedDocIds: ((r.assigned_doc_ids as string[] | null) ?? []),
      }));
      setLinks(linkRows);
      // Labels for every assigned document across all links (chips need names).
      const assignedAll = [...new Set(linkRows.flatMap((l) => l.assignedDocIds))];
      if (assignedAll.length) {
        const { data: labelDocs } = await supabase
          .from("documents").select("id, document_number, title, name").in("id", assignedAll);
        setDocLabels(new Map((((labelDocs ?? []) as Array<Record<string, unknown>>)).map((d) => [
          String(d.id), String(d.document_number || d.title || d.name || "Document"),
        ])));
      } else {
        setDocLabels(new Map());
      }
      setLibs((((ls ?? []) as Array<{ id: string; name: string }>)));
      const libId = (proj?.intake_library_id as string | null) ?? null;
      setIntakeLibraryId(libId);
      setIntakeCollectionId((proj?.intake_collection_id as string | null) ?? null);
      // Pending submissions: every in-review version submitted through one of
      // THIS project's links — covers new intake documents AND revisions of
      // assigned org documents (which live in their own collections).
      const linkIds = linkRows.map((l) => l.id);
      if (linkIds.length) {
        const { data: subVers } = await supabase
          .from("document_versions")
          .select("id, record_id, revision_label, created_by_name, created_at, change_log")
          .in("intake_link_id", linkIds)
          .eq("review_state", "in_review");
        const vRows = ((subVers ?? []) as Array<Record<string, unknown>>);
        const recIds = [...new Set(vRows.map((v) => String(v.record_id)))];
        const { data: docs } = recIds.length
          ? await supabase.from("documents")
              .select("id, document_number, title, name, pending_version_id")
              .in("id", recIds).not("pending_version_id", "is", null)
          : { data: [] };
        const dMap = new Map((((docs ?? []) as Array<Record<string, unknown>>)).map((d) => [String(d.id), d]));
        setPending(vRows
          .filter((v) => String(dMap.get(String(v.record_id))?.pending_version_id ?? "") === String(v.id))
          .map((v) => {
            const d = dMap.get(String(v.record_id));
            return {
              docId: String(v.record_id),
              label: String(d?.document_number || d?.title || d?.name || "Document"),
              pendingVersionId: String(v.id),
              revLabel: (v.revision_label as string | null) ?? null,
              company: (v.created_by_name as string | null) ?? null,
              submittedAt: (v.created_at as string | null) ?? null,
              changeLog: (v.change_log as string | null) ?? null,
            };
          })
          .sort((a, b) => String(a.submittedAt ?? "").localeCompare(String(b.submittedAt ?? ""))));
      } else {
        setPending([]);
      }
    } catch (e) {
      setMsg(`Couldn't load intake data: ${(e as Error).message}`);
    } finally { setLoading(false); }
  }, [orgId, projectId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const createLink = async () => {
    if (!company.trim()) { setMsg("Company name is required."); return; }
    const lib = intakeLibraryId ?? libPick;
    if (!lib) { setMsg("Pick the library where intake documents will live."); return; }
    const expiry = intakeExpiryFor(expires);
    if (!expiry.ok) { setMsg(expiry.message); return; }
    setBusy("create"); setMsg(null);
    try {
      if (!intakeLibraryId) {
        const { error: libErr } = await supabase.from("projects").update({ intake_library_id: lib }).eq("id", projectId);
        if (libErr) throw new Error(`Couldn't set the intake library: ${libErr.message}`);
      }
      const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "").slice(0, 40);
      const { data: created, error } = await supabase.from("project_intake_links").insert({
        org_id: orgId, project_id: projectId, token,
        company_name: company.trim(), contact_email: email.trim() || null,
        allow_auto_supersede: trusted,
        expires_at: expiry.iso,
        created_by: uid,
      }).select("id").single();
      if (error) throw new Error(error.message);
      // INTK-12: the audit row names the LINK (its id) — never the project in
      // its place, never token material — and a failed audit is visible.
      const { error: auditErr } = await supabase.from("audit_logs").insert({
        action: "INTAKE_LINK_CREATED",
        resource_type: "project_intake_link", resource_id: String((created as { id: string }).id),
        org_id: orgId, user_id: uid, user_email: userEmail ?? null,
        details: { company: company.trim(), trusted, expiresAt: expiry.iso, projectId },
      });
      setCompany(""); setEmail(""); setExpires(isoDateInDays(INTAKE_LINK_DEFAULT_DAYS)); setTrusted(false);
      await refresh();
      setMsg(auditErr
        ? `Link created, but its audit record failed: ${auditErr.message}`
        : "Link created — copy it below and send it to the company.");
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(null); }
  };

  const revoke = async (l: IntakeLink) => {
    if (!(await appConfirm({ message: `Revoke ${l.companyName}'s submit link? They lose access immediately.`, tone: "danger" }))) return;
    setBusy(l.id);
    try {
      const { error } = await supabase.from("project_intake_links").update({ revoked_at: new Date().toISOString() }).eq("id", l.id);
      if (error) { setMsg(`Couldn't revoke: ${error.message}`); return; }
      const { error: auditErr } = await supabase.from("audit_logs").insert({
        action: "INTAKE_LINK_REVOKED",
        resource_type: "project_intake_link", resource_id: l.id,
        org_id: orgId, user_id: uid, user_email: userEmail ?? null,
        details: { company: l.companyName, projectId },
      });
      if (auditErr) setMsg(`The link was revoked, but its audit record failed: ${auditErr.message}`);
      await refresh();
    } finally { setBusy(null); }
  };

  // Assign an existing controlled document to a link. Assigned docs show on
  // the company's portal register and accept revision submissions — always
  // through review (auto-supersede never applies to org-authored documents).
  const searchSeq = useRef(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchAssignable = (q: string) => {
    setAssignQ(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    // Strip characters that are grammar in PostgREST filter strings — raw
    // interpolation let a comma or paren rewrite the query itself.
    const term = q.trim().replace(/[,().\\%]/g, " ").replace(/\s+/g, " ").trim();
    if (term.length < 2) { setAssignResults([]); setAssignSearching(false); return; }
    setAssignSearching(true);
    const seq = ++searchSeq.current;
    searchTimer.current = setTimeout(async () => {
      try {
        const { data } = await supabase
          .from("documents")
          .select("id, document_number, title, name")
          .eq("org_id", orgId)
          .or(`document_number.ilike.%${term}%,title.ilike.%${term}%,name.ilike.%${term}%`)
          .limit(8);
        if (seq !== searchSeq.current) return; // a newer keystroke superseded us
        setAssignResults((((data ?? []) as Array<Record<string, unknown>>)).map((d) => ({
          id: String(d.id), label: String(d.document_number || d.title || d.name || "Document"),
        })));
      } finally {
        if (seq === searchSeq.current) setAssignSearching(false);
      }
    }, 250);
  };

  const updateAssigned = async (l: IntakeLink, ids: string[], addedLabel?: string) => {
    setBusy(l.id); setMsg(null);
    try {
      const { error } = await supabase.from("project_intake_links")
        .update({ assigned_doc_ids: ids }).eq("id", l.id);
      if (error) throw new Error(error.message);
      await supabase.from("audit_logs").insert({
        action: "INTAKE_ASSIGNMENT_CHANGED",
        resource_type: "project_intake_link", resource_id: l.id,
        org_id: orgId, user_id: uid, user_email: userEmail ?? null,
        details: { company: l.companyName, projectId, before: l.assignedDocIds, after: ids },
      }).then(() => undefined, () => undefined);
      setAssignQ(""); setAssignResults([]);
      await refresh();
      if (addedLabel) setMsg(`${addedLabel} assigned to ${l.companyName} — revisions they submit will come to review.`);
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(null); }
  };

  const approve = async (p: PendingSub) => {
    setBusy(p.docId); setMsg(null);
    try {
      // SAF-15: approve exactly the version on screen. A pointer that has
      // moved since the list loaded (rejected and resubmitted, or displaced)
      // is refused — the reviewer never approves a file they did not open.
      const { data: doc, error: docErr } = await supabase.from("documents")
        .select("id, library_id, collection_id, review_control, pending_version_id")
        .eq("id", p.docId).eq("org_id", orgId).maybeSingle();
      if (docErr) throw new Error(`Couldn't read ${p.label}: ${docErr.message}`);
      if (!doc || String(doc.pending_version_id ?? "") !== p.pendingVersionId) {
        await refresh();
        throw new Error(`${p.label} changed since this list loaded — it has been refreshed. Check the submission shown now before approving.`);
      }
      const libraryId = String(doc.library_id);
      // SEC-13 / DEC-36: the document's review policy, resolved through the
      // container chain. A policy that REQUIRES sign-off is never satisfied
      // by this click alone: the submission goes to the resolved roster, and
      // publishes when the roster is complete (the database refuses an
      // intake promote that skipped it — 20261105).
      const control = await effectiveReviewControlForDocument({
        reviewControl: (doc.review_control as ReviewControl | null) ?? null,
        collectionId: (doc.collection_id as string | null) ?? null,
        libraryId,
      });
      const rosterRequired = control.mode === "require";
      // The submission as stored: its file hash binds reviewers' sign-offs
      // to the bytes they reviewed; its MOC reference is SEC-14's.
      const { data: ver, error: verErr } = await supabase.from("document_versions")
        .select("moc_reference, file_hash").eq("id", p.pendingVersionId).maybeSingle();
      if (verErr) throw new Error(`Couldn't read the submission: ${verErr.message}`);
      // SEC-14: a drawing-class document's external revision carries its
      // management-of-change reference (the database refuses it otherwise).
      // Captured HERE, before either path — on the roster path the publish
      // happens later from the review panel, which has no MOC prompt, so a
      // reference missing now would refuse the reviewers' final sign-off.
      const docClass = await effectiveDocClassForDocument({ id: p.docId, collectionId: (doc.collection_id as string | null) ?? null, libraryId });
      if (docClass === "drawing" && String((ver as { moc_reference?: string | null } | null)?.moc_reference ?? "").trim().length < 3) {
        const moc = await appPrompt({
          title: "MOC reference required",
          message: `${p.label} is a drawing — PSM (OSHA 1910.119(l)) requires the management-of-change reference for this revision before it can become current.`,
          placeholder: "MOC reference",
          confirmLabel: rosterRequired ? "Record and continue" : "Record and approve",
        });
        if (moc == null) return;
        if (moc.trim().length < 3) throw new Error("An MOC reference is at least 3 characters.");
        const { data: set, error: setErr } = await supabase.from("document_versions")
          .update({ moc_reference: moc.trim() }).eq("id", p.pendingVersionId).eq("review_state", "in_review").select("id");
        if (setErr) throw new Error(`Couldn't record the MOC reference: ${setErr.message}`);
        if (!set || set.length === 0) throw new Error("Couldn't record the MOC reference: the write was refused.");
      }
      if (rosterRequired) {
        // A roster is its PRIMARY slots (the guard counts primaries; a
        // standby alternate alone reviews nothing).
        const hasPrimary = (rows: Awaited<ReturnType<typeof listDraftRoster>>) => rows.some((r) => r.slot === "primary");
        const roster = await listDraftRoster(p.docId, p.pendingVersionId);
        if (!hasPrimary(roster)) {
          if (!(await appConfirm({ message: `${p.label}'s review policy requires reviewer sign-off. Send Rev ${p.revLabel ?? ""} to its reviewers? It publishes from the document's review panel once they have signed.` }))) return;
          await openReviewRoster({
            orgId, documentId: p.docId, libraryId, versionId: p.pendingVersionId,
            revisionLabel: p.revLabel ?? "",
            contentHash: ((ver as { file_hash?: string | null } | null)?.file_hash ?? null),
            control, actorId: uid, actorName: userEmail ?? null,
          });
          // Say what actually happened: a policy that resolves nobody opens
          // no roster (the owner and Document Control are told of the gap),
          // and "sent to its reviewers" would loop the next Approve on the
          // same prompt.
          const opened = await listDraftRoster(p.docId, p.pendingVersionId);
          setMsg(hasPrimary(opened)
            ? `${p.label} Rev ${p.revLabel ?? ""} was sent to its reviewers — it publishes when the last of them signs off on the document's review panel (in the document library), not from this tab.`
            : `No reviewer could be resolved for ${p.label}'s library — set its reviewers before this submission can be approved.`);
          await refresh();
          return;
        }
      }
      // A roster-free policy: this click IS the review (the publish guard
      // still checks authority and holds). A required one: the roster must
      // be complete.
      const res = await finalizeReviewedRevision({
        orgId, documentId: p.docId, actorId: uid, actorName: userEmail ?? "Reviewer",
        requireRosterComplete: rosterRequired,
      });
      if (!res.published) throw new Error(finalizeReasonMessage(res.reason));
      // Name what actually became current — never the stale row's label.
      const { data: after } = await supabase.from("documents").select("rev, current_version_id").eq("id", p.docId).maybeSingle();
      // UX-16: the approval swept the project's open checklists — say what it did.
      const swept = res.evidenceSweep ? describeProjectSweep(res.evidenceSweep) : null;
      setMsg((String(after?.current_version_id ?? "") === p.pendingVersionId
        ? `${p.label} Rev ${String(after?.rev ?? p.revLabel ?? "")} approved — it is now the current revision.`
        : `${p.label}: the approval went through, but the current revision is not the submission you approved — refresh and check the document.`)
        + (swept ? ` ${swept.text}` : ""));
      await refresh();
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(null); }
  };

  const reject = async (p: PendingSub) => {
    // SAF-9: a rejection carries its reason — the contractor sees it on
    // their portal, so they never resubmit blind.
    const reason = await appPrompt({
      title: `Reject ${p.label} Rev ${p.revLabel ?? ""}?`,
      message: "Say why — the company sees this reason on their submission portal.",
      placeholder: "What needs to change",
      confirmLabel: "Reject",
      tone: "danger",
    });
    if (reason == null) return;
    if (reason.trim().length < 5) { setMsg("Give the company a reason (at least a few words) so they know what to fix."); return; }
    setBusy(p.docId); setMsg(null);
    try {
      // Mark the version first — if the DB refuses (pre-migration CHECK, or
      // the EGRESS-6 overlay), we stop BEFORE clearing pending, so nothing
      // half-completes. Zero rows is a refusal too. The reason rides on the
      // version (20261105); a database without the column keeps it in the
      // audit row only.
      let { data: vRows, error: vErr } = await supabase.from("document_versions")
        .update({ review_state: "rejected", review_note: reason.trim() }).eq("id", p.pendingVersionId).select("id");
      if (vErr && /review_note/.test(vErr.message ?? "")) {
        ({ data: vRows, error: vErr } = await supabase.from("document_versions")
          .update({ review_state: "rejected" }).eq("id", p.pendingVersionId).select("id"));
      }
      if (vErr) throw new Error(`Couldn't reject: ${vErr.message}`);
      if (!vRows || vRows.length === 0) throw new Error("Couldn't reject: the write was refused.");
      const { error: dErr } = await supabase.from("documents")
        .update({ pending_version_id: null, updated_at: new Date().toISOString() }).eq("id", p.docId);
      if (dErr) throw new Error(`Couldn't clear the pending revision: ${dErr.message}`);
      // RG-10: close out any sign-off rows on the rejected draft, so the daily
      // scan and the reviewers' inboxes stop chasing a draft nothing points at.
      // Zero rows is the normal case (an intake draft has no roster).
      const { error: voidErr } = await supabase.from("document_review_signoffs")
        .update({ status: "void", updated_at: new Date().toISOString() })
        .eq("document_version_id", p.pendingVersionId).in("status", ["pending", "signed"]);
      if (voidErr) throw new Error(`The submission was rejected, but its review sign-offs could not be closed out: ${voidErr.message}`);
      const { error: auditErr } = await supabase.from("audit_logs").insert({
        action: "INTAKE_REJECTED",
        resource_type: "document", resource_id: p.docId,
        org_id: orgId, user_id: uid, user_email: userEmail ?? null,
        details: { projectId, versionId: p.pendingVersionId, revLabel: p.revLabel, company: p.company, reason: reason.trim() },
      });
      setMsg(auditErr
        ? `${p.label} Rev ${p.revLabel ?? ""} rejected, but its audit record failed: ${auditErr.message}`
        : `${p.label} Rev ${p.revLabel ?? ""} rejected — the company sees it as not accepted, with your reason, on their portal.`);
      await refresh();
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(null); }
  };

  const portalUrl = (token: string) =>
    `${typeof window !== "undefined" ? window.location.origin : ""}/submit/${token}`;

  // Transition-in flag: collision/overlap → drafting ticket in the
  // assignment queue, pre-loaded with both sides of the conflict.
  const flagCollision = async (candidate: TransitionCandidate, impact: TransitionImpact) => {
    setMsg(null);
    const res = await flagCollisionToDrafting({
      orgId, projectId, candidate, impact,
      actorId: uid, actorEmail: userEmail ?? null, actorRole: null,
    });
    setMsg(res.ok
      ? `${candidate.label} flagged to drafting — ticket ${res.ticketNumber} is in the assignment queue.`
      : (res.error ?? "Couldn't flag the collision."));
  };

  if (loading) return <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-accent)]" /></div>;

  return (
    <div className="space-y-4">
      {msg && <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-bold text-[var(--color-text)]">{msg}</div>}

      {/* Review queue — the point of the whole system. */}
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="flex items-center gap-2 mb-2">
          <UploadCloud className="w-4 h-4 text-[var(--color-accent)]" />
          <span className="text-base font-bold text-[var(--color-text)]">Submissions awaiting review</span>
          <span className={`text-base font-black tabular-nums ${pending.length ? "text-amber-600" : "text-[var(--color-text-faint)]"}`}>{pending.length}</span>
        </div>
        {pending.length === 0 && <div className="text-xs italic text-[var(--color-text-faint)]">Nothing waiting. Approved intake revisions become the single current version automatically.</div>}
        <ul className="space-y-2">
          {pending.map((p) => (
            <li key={p.docId} className="rounded-xl border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Clock className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                <span className="text-sm font-bold text-[var(--color-text)]">{p.label}</span>
                <span className="text-xs text-[var(--color-text-muted)]">Rev {p.revLabel ?? "—"} · {p.company ?? "external"}{p.submittedAt ? ` · ${new Date(p.submittedAt).toLocaleDateString()}` : ""}</span>
                {canManage && (
                  <span className="ml-auto flex items-center gap-1.5">
                    <button onClick={() => void approve(p)} disabled={busy === p.docId} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500 text-white text-[11px] font-black hover:bg-emerald-600 disabled:opacity-50">
                      {busy === p.docId ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Approve
                    </button>
                    <button onClick={() => void reject(p)} disabled={busy === p.docId} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-rose-500/40 text-rose-700 dark:text-rose-300 text-[11px] font-black hover:bg-rose-500/10 disabled:opacity-50">
                      <X className="w-3 h-3" /> Reject
                    </button>
                  </span>
                )}
              </div>
              {p.changeLog && <div className="mt-1 text-[11px] text-[var(--color-text-muted)] italic">&ldquo;{p.changeLog}&rdquo;</div>}
            </li>
          ))}
        </ul>
      </div>

      {/* Transition-in: adopt intake sheets into the controlled register. */}
      {intakeCollectionId && (
        <TransitionInPanel
          orgId={orgId} projectId={projectId} intakeCollectionId={intakeCollectionId}
          canManage={canManage} uid={uid} userEmail={userEmail}
          onFlagCollision={(c, i) => void flagCollision(c, i)}
        />
      )}

      {/* Submit links */}
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="flex items-center gap-2 mb-2">
          <Link2 className="w-4 h-4 text-[var(--color-accent)]" />
          <span className="text-base font-bold text-[var(--color-text)]">Contractor submit links</span>
          <span className="text-xs text-[var(--color-text-muted)]">no account needed — upload-only, own documents only, everything tracked</span>
        </div>
        <ul className="space-y-1.5 mb-3">
          {links.map((l) => (
            <li key={l.id} className={`text-xs rounded-lg border px-2.5 py-1.5 ${l.revokedAt ? "border-[var(--color-border)] opacity-60" : "border-[var(--color-border-strong)]"}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-[var(--color-text)]">{l.companyName}</span>
                {l.allowAutoSupersede && <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-violet-700 dark:text-violet-300"><ShieldCheck className="w-3 h-3" /> trusted</span>}
                <span className="text-[var(--color-text-faint)]">{l.submissionCount} submission{l.submissionCount === 1 ? "" : "s"}{l.expiresAt ? ` · expires ${new Date(l.expiresAt).toLocaleDateString()}` : ""}{l.revokedAt ? " · REVOKED" : ""}</span>
                {!l.revokedAt && (
                  <span className="ml-auto flex items-center gap-1">
                    {canManage && (!l.expiresAt || Date.parse(l.expiresAt) > Date.now()) && (
                      <button onClick={() => { void navigator.clipboard.writeText(portalUrl(l.token)); setMsg(`Copied ${l.companyName}'s link.`); }} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--color-border-strong)] font-bold hover:border-[var(--color-accent-ring)]"><Copy className="w-3 h-3" /> Copy link</button>
                    )}
                    {canManage && (
                      <button onClick={() => { setAssignOpen(assignOpen === l.id ? null : l.id); setAssignQ(""); setAssignResults([]); }} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--color-border-strong)] font-bold hover:border-[var(--color-accent-ring)]">
                        <FilePlus2 className="w-3 h-3" /> Assign docs
                      </button>
                    )}
                    {canManage && <button onClick={() => void revoke(l)} disabled={busy === l.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-rose-500/40 text-rose-700 dark:text-rose-300 font-bold hover:bg-rose-500/10"><Ban className="w-3 h-3" /> Revoke</button>}
                  </span>
                )}
              </div>
              {/* Assigned org documents — visible on the company's portal, revisions always come to review. */}
              {(l.assignedDocIds.length > 0 || assignOpen === l.id) && !l.revokedAt && (
                <div className="mt-1.5 pt-1.5 border-t border-[var(--color-border)] space-y-1.5">
                  {l.assignedDocIds.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] font-bold text-[var(--color-text-muted)]">Assigned:</span>
                      {l.assignedDocIds.map((id) => (
                        <span key={id} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[var(--color-surface-2)] border border-[var(--color-border-strong)] text-[10px] font-bold text-[var(--color-text)]">
                          {docLabels.get(id) ?? "Document"}
                          {canManage && (
                            <button onClick={() => void updateAssigned(l, l.assignedDocIds.filter((x) => x !== id))} disabled={busy === l.id} title="Unassign" className="text-[var(--color-text-faint)] hover:text-rose-600">
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                  {assignOpen === l.id && canManage && (
                    <div>
                      <div className="relative">
                        <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
                        <input
                          value={assignQ}
                          onChange={(e) => searchAssignable(e.target.value)}
                          placeholder="Search documents by number or title…"
                          autoFocus
                          className="h-7 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] pl-6 pr-2 text-xs"
                        />
                      </div>
                      {assignSearching && <div className="mt-1 text-[10px] text-[var(--color-text-faint)]">Searching…</div>}
                      {assignResults.length > 0 && (
                        <ul className="mt-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)] overflow-hidden">
                          {assignResults.filter((r) => !l.assignedDocIds.includes(r.id)).map((r) => (
                            <li key={r.id}>
                              <button
                                onClick={() => void updateAssigned(l, [...l.assignedDocIds, r.id], r.label)}
                                disabled={busy === l.id}
                                className="w-full text-left px-2 py-1 text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
                              >
                                {r.label}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="mt-1 text-[10px] text-[var(--color-text-faint)]">Assigned documents appear on {l.companyName}&rsquo;s portal. Their revisions of your documents <b>always</b> go through review, even on trusted links.</div>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
          {links.length === 0 && <li className="text-xs italic text-[var(--color-text-faint)]">No links yet.</li>}
        </ul>

        {canManage && (
          <div className="rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)]/40 p-3 space-y-2">
            <div className="text-[10px] font-bold text-[var(--color-text-muted)]">New submit link</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company name (stamped on every submission)" className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Contact email (optional)" className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
              {!intakeLibraryId && (
                <select value={libPick} onChange={(e) => setLibPick(e.target.value)} className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs">
                  <option value="">Intake documents live in library…</option>
                  {libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              )}
              <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} min={isoDateInDays(0)} max={isoDateInDays(INTAKE_LINK_MAX_DAYS)} required className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs [color-scheme:light] dark:[color-scheme:dark]" title={`Expiry (required — at most ${INTAKE_LINK_MAX_DAYS} days)`} aria-label="Link expiry date" />
            </div>
            <label className="flex items-center gap-2 text-xs text-[var(--color-text)]">
              <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} />
              Trusted: once one of <b>their own documents</b> has been approved, their later revisions of it publish immediately — never documents assigned to them, never over a hold or a checkout, never in a library that requires reviewer sign-off
            </label>
            <button onClick={() => void createLink()} disabled={busy === "create"} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
              {busy === "create" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />} Create link
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
