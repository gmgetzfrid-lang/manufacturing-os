"use client";

// DeclarationCard — the review model on the ticket (drafting-flow DF-P6).
//
//   * WHY engineering review is (or is not) required — the like-in-kind
//     declaration, attributed to its author with its date and the
//     e-signature that is its record (GAP-110 acceptance 4, DEC-34), or "no
//     declaration — engineered work" (DEC-33), or a requirement raised after
//     the declaration (GAP-111: the assigner's flag, an engineering review,
//     an engineering class). "Because of your job title" is never the
//     answer; a request filed before the declaration existed says the
//     workspace's earlier rule decides for it (the seed) — also when the
//     backfill or a later flag set its requirement (DF-P6 fix pass 2, minor
//     5: never "no declaration was made" for a request filed before
//     declarations existed). A declaration is said to stand only once its
//     e-signature is checked as the workflow route checks it
//     (declarationSignatureStands); one that does not stand reads as
//     engineered work, as the route treats it.
//   * The work class and the code class triage recorded (GAP-101, TIER-4) —
//     the workspace's own words.
//   * The equipment the request names, through the registry and the
//     document↔equipment relation (intelligence GAP-312 / WIRE-7 criterion
//     1): each resolved tag with the sheets it appears on (lib/search.ts
//     lookupTag — the ⌘K lookup, RLS-scoped, no AI call); a tag the registry
//     does not know is shown as typed and flagged.
//
// Reads only what the viewer may read (the ticket row they already hold,
// ticket_equipment and the drawings through RLS). Before 20261250 / 20261251
// are pasted it shows nothing for what is not there — never a guess.

import React, { useEffect, useState } from "react";
import { ShieldCheck, ShieldAlert, Wrench, FileText, AlertTriangle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { isMissingSchemaError } from "@/lib/checkedWrite";
import { lookupTag, type TagLookupHit } from "@/lib/search";
import { engineeringBasis, isDeclaredLikeInKind, declarationSignatureStands, type DeclarationCheck, type DeclarationSignatureRow } from "@/lib/reviewModel";
import type { Ticket } from "@/types/schema";

interface EquipmentRow { tag: string; asset_id: string | null }

/** The sentence the card leads with (pure; exported for tests).
 *  `declaration`: the declaration's e-signature check — "pending" while the
 *  card reads it (nothing is said yet). Only a declared request asks. */
export function engineeringLine(
  ticket: Pick<Ticket, "engineeringRequired" | "likeInKindDeclaredAt" | "likeInKindStatement" | "likeInKindDeclaredBy" | "engineerReviewRequestedAt" | "reviewModelFiled">,
  declaration: DeclarationCheck | "pending",
): { required: boolean | null; text: string } | null {
  const basis = engineeringBasis(ticket);
  if (basis.kind === "declared") {
    if (declaration === "pending") return null;
    if (declaration !== "verified") {
      return {
        required: true,
        text: declaration === "missing"
          ? "Engineering review is required: the requester's like-in-kind declaration has no e-signature on record for this request, so it does not stand — the request is treated as engineered work."
          : "Engineering review is required for now: the like-in-kind declaration's e-signature could not be checked, so the request is treated as engineered work until it can be.",
      };
    }
    return { required: false, text: "Engineering review is not required: the requester declared this work like-in-kind when they filed it." };
  }
  if (basis.kind === "required" && basis.legacy) {
    return {
      required: true,
      text: "Filed before like-in-kind declarations existed: an engineer's sign-off is required — under the workspace's earlier rule (the requester's roles), or because it was raised since (see the history).",
    };
  }
  if (basis.kind === "required") {
    return {
      required: true,
      text: ticket.likeInKindDeclaredAt
        ? "Engineering review is required: it was raised after the requester's like-in-kind declaration (see the history for who flagged it, when and why). The declaration stays on record."
        : "Engineering review is required: no like-in-kind declaration was made, so this is engineered work. It requires an engineer's sign-off before it issues; management may override that, recorded as an override.",
    };
  }
  // The seed: the column cannot speak for this request.
  if (ticket.engineeringRequired === undefined) return null;
  return { required: null, text: "Filed before like-in-kind declarations existed: whether an engineer must sign off follows the workspace's earlier rule (the requester's roles)." };
}

/** `onDeclarationCheck` (DF-P6 fix pass 4, review minor 6): the card's
 *  e-signature check, shared with the request page so its buttons are
 *  evaluated on the ticket the route evaluates (ticketAsDeclarationChecked). */
export default function DeclarationCard({ ticket, onDeclarationCheck }: { ticket: Ticket; onDeclarationCheck?: (check: DeclarationCheck | "pending") => void }) {
  const [equipment, setEquipment] = useState<EquipmentRow[] | null>(null);
  const [sheets, setSheets] = useState<Map<string, TagLookupHit>>(new Map());
  const [equipmentError, setEquipmentError] = useState<string | null>(null);
  // The declaration's e-signature, checked as the workflow route checks it
  // (RLS-scoped read of e_signatures by its id).
  const declared = ticket.engineeringRequired === false && isDeclaredLikeInKind(ticket);
  const [declaration, setDeclaration] = useState<DeclarationCheck | "pending">("pending");
  useEffect(() => {
    if (!declared || !ticket.id) return;
    let alive = true;
    const sigId = ticket.likeInKindSignatureId ?? "";
    void (async () => {
      if (!sigId) { if (alive) setDeclaration("missing"); return; }
      const { data, error } = await supabase.from("e_signatures").select("id, org_id, resource_type, resource_id, signer_user_id").eq("id", sigId).maybeSingle();
      if (!alive) return;
      if (error) { setDeclaration("unchecked"); return; }
      setDeclaration(declarationSignatureStands(data as DeclarationSignatureRow | null, { id: ticket.id!, orgId: ticket.orgId, likeInKindDeclaredBy: ticket.likeInKindDeclaredBy }) ? "verified" : "missing");
    })();
    return () => { alive = false; };
  }, [declared, ticket.id, ticket.orgId, ticket.likeInKindSignatureId, ticket.likeInKindDeclaredBy]);
  useEffect(() => { onDeclarationCheck?.(declared ? declaration : "pending"); }, [declared, declaration, onDeclarationCheck]);

  useEffect(() => {
    if (!ticket.id) return;
    let alive = true;
    void (async () => {
      const { data, error } = await supabase.from("ticket_equipment").select("tag, asset_id").eq("ticket_id", ticket.id!).order("created_at");
      if (!alive) return;
      if (error) {
        // Not pasted yet: nothing to show. Any other failure is said.
        if (!isMissingSchemaError(error)) setEquipmentError("The equipment this request names could not be read.");
        setEquipment([]);
        return;
      }
      const rows = (data ?? []) as EquipmentRow[];
      setEquipment(rows);
      const found = new Map<string, TagLookupHit>();
      for (const r of rows.filter((x) => x.asset_id).slice(0, 10)) {
        try {
          const hits = await lookupTag(ticket.orgId, r.tag, { documentsPerAsset: 5 });
          const hit = hits.find((h) => h.asset.id === r.asset_id);
          if (hit) found.set(r.asset_id!, hit);
        } catch {
          /* the sheets are a help, not a claim: a failed lookup shows the tag alone */
        }
      }
      if (alive) setSheets(found);
    })();
    return () => { alive = false; };
  }, [ticket.id, ticket.orgId]);

  const line = engineeringLine(ticket, declared ? declaration : "verified");
  const hasClasses = !!ticket.workClass || !!ticket.codeClass;
  const hasEquipment = (equipment?.length ?? 0) > 0;
  if (!line && !hasClasses && !hasEquipment && !equipmentError) return null;

  return (
    <section data-testid="declaration-card" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3 text-sm">
      {line && (
        <div className="flex items-start gap-2" data-testid="engineering-line">
          {line.required === false
            ? <ShieldCheck className="w-4 h-4 mt-0.5 text-emerald-600 shrink-0" />
            : <ShieldAlert className="w-4 h-4 mt-0.5 text-amber-600 shrink-0" />}
          <p className="text-[var(--color-text)]">{line.text}</p>
        </div>
      )}
      {ticket.likeInKindStatement && (
        <blockquote data-testid="declaration-statement" className="border-l-4 border-emerald-300 pl-3 text-[var(--color-text)]">
          <p className="italic">&ldquo;{ticket.likeInKindStatement}&rdquo;</p>
          <footer className="mt-1 text-xs text-[var(--color-text-muted)]">
            Declared by {ticket.requesterName || "the requester"}
            {ticket.likeInKindDeclaredAt ? ` on ${new Date(ticket.likeInKindDeclaredAt).toLocaleString()}` : ""}
            {ticket.likeInKindSignatureId ? ` · e-signature ${ticket.likeInKindSignatureId.slice(0, 8)}` : ""}
          </footer>
        </blockquote>
      )}
      {hasClasses && (
        <p data-testid="review-classes" className="text-xs text-[var(--color-text-muted)]">
          {ticket.workClass ? <>Work class: <span className="font-semibold text-[var(--color-text)]">{ticket.workClass}</span></> : null}
          {ticket.workClass && ticket.codeClass ? " · " : null}
          {ticket.codeClass ? <>Code class: <span className="font-semibold text-[var(--color-text)]">{ticket.codeClass}</span></> : null}
        </p>
      )}
      {equipmentError && (
        <p role="alert" className="flex items-center gap-1 text-xs text-amber-700"><AlertTriangle className="w-3.5 h-3.5" />{equipmentError}</p>
      )}
      {hasEquipment && (
        <div data-testid="request-equipment">
          <p className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-faint)]"><Wrench className="w-3.5 h-3.5" />Equipment</p>
          <ul className="mt-1 space-y-1">
            {equipment!.map((e) => {
              const hit = e.asset_id ? sheets.get(e.asset_id) : undefined;
              return (
                <li key={`${e.tag}-${e.asset_id ?? "typed"}`}>
                  <span className="font-semibold text-[var(--color-text)]">{e.tag}</span>
                  {!e.asset_id && <span className="ml-2 text-xs text-amber-700">not linked to the equipment registry (not found there, or the lookup failed when the request was filed) — kept as typed</span>}
                  {hit && hit.documents.length > 0 && (
                    <span className="ml-2 text-xs text-[var(--color-text-muted)]">
                      appears on {hit.documents.map((d, i) => (
                        <span key={d.id}>{i > 0 ? ", " : ""}<FileText className="inline w-3 h-3" /> {d.document_number || d.title || "a drawing"}{d.sheetLabel ? ` (${d.sheetLabel})` : ""}</span>
                      ))}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
