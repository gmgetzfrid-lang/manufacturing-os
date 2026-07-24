// lib/documentOrigin.ts
//
// Documents of external origin (ISO 9001 §7.5.3). Records whether a controlled
// document was authored internally or comes from an external source (OEM, a
// standards body, a regulator, a vendor), plus the source's own reference and
// edition so you can tell which external edition you're holding under control.

import { supabase } from "@/lib/supabase";
import { logAuditAction } from "@/lib/audit";

export interface OriginInfo {
  origin?: "internal" | "external" | null;
  externalSource?: string | null;
  externalReference?: string | null;
  externalEdition?: string | null;
  externalUrl?: string | null;
}

/** A short human label — "Internal" or "External · API 610". */
export function describeOrigin(d: OriginInfo): string {
  if (d.origin !== "external") return "Internal";
  const parts = [d.externalSource, d.externalReference].map((s) => s?.trim()).filter(Boolean);
  return parts.length ? `External · ${parts.join(" ")}` : "External";
}

export async function setDocumentOrigin(input: {
  documentId: string; orgId?: string | null; actorId?: string | null;
  origin: "internal" | "external";
  externalSource?: string | null; externalReference?: string | null; externalEdition?: string | null; externalUrl?: string | null;
}): Promise<void> {
  const ext = input.origin === "external";
  await supabase.from("documents").update({
    origin: input.origin,
    external_source: ext ? (input.externalSource?.trim() || null) : null,
    external_reference: ext ? (input.externalReference?.trim() || null) : null,
    external_edition: ext ? (input.externalEdition?.trim() || null) : null,
    external_url: ext ? (input.externalUrl?.trim() || null) : null,
  }).eq("id", input.documentId);
  await logAuditAction({
    action: "DOCUMENT_ORIGIN_SET", resourceType: "document", resourceId: input.documentId,
    orgId: input.orgId ?? undefined, userId: input.actorId ?? "",
    details: { origin: input.origin, source: input.externalSource, reference: input.externalReference, edition: input.externalEdition },
  }).catch(() => {});
}
