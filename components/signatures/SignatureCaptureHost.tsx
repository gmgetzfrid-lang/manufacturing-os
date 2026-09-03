"use client";

// Mounts once in the protected layout. Listens for a global `request-signature`
// CustomEvent and runs the ceremony with the signed-in user's identity, then
// records the signature and announces `signature-recorded` so any open list can
// refresh. Lets any surface request a signature without prop-drilling.

import React from "react";
import SignatureCeremony from "@/components/signatures/SignatureCeremony";
import { recordSignature, type SignatureIntent, type SigningCredential } from "@/lib/eSignatures";
import { useRole } from "@/components/providers/RoleContext";
import { useToast } from "@/components/providers/ToastProvider";

export interface RequestSignatureDetail {
  resourceType: string;
  resourceId: string;
  resourceLabel?: string;
  defaultIntent?: SignatureIntent;
  defaultStatement?: string;
  documentVersionId?: string | null;
  contentHash?: string | null;
}

export function requestSignature(detail: RequestSignatureDetail) {
  window.dispatchEvent(new CustomEvent("request-signature", { detail }));
}

export default function SignatureCaptureHost() {
  const { activeOrgId, uid, userEmail, activeRole, member } = useRole();
  const { showToast } = useToast();
  const [req, setReq] = React.useState<RequestSignatureDetail | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const onReq = (e: Event) => {
      const d = (e as CustomEvent<RequestSignatureDetail>).detail;
      if (d?.resourceId) setReq(d);
    };
    window.addEventListener("request-signature", onReq as EventListener);
    return () => window.removeEventListener("request-signature", onReq as EventListener);
  }, []);

  if (!req) return null;
  // RG-9: the name the signer types to confirm is their membership display
  // name (the server records the same); the email local part is only the
  // fallback for a member who never set one.
  const signerName = (member?.displayName ?? "").trim() || (userEmail?.split("@")[0] ?? "").trim() || "user";

  const sign = async (intent: SignatureIntent, statement: string, signatureImage?: string | null, reauth?: SigningCredential) => {
    if (!activeOrgId || !uid) return;
    setBusy(true);
    try {
      await recordSignature({
        orgId: activeOrgId,
        resourceType: req.resourceType,
        resourceId: req.resourceId,
        documentVersionId: req.documentVersionId ?? null,
        contentHash: req.contentHash ?? null,
        intent,
        statement,
        signerUserId: uid,
        signerName,
        signerRole: activeRole ?? undefined,
        signerEmail: userEmail ?? undefined,
        signatureImage: signatureImage ?? undefined,
        reauth: reauth ?? null,
      });
      window.dispatchEvent(new CustomEvent("signature-recorded", { detail: { resourceType: req.resourceType, resourceId: req.resourceId } }));
      showToast({ type: "success", title: "Signed", message: `${intent} — recorded with your name and timestamp.` });
      setReq(null);
    } catch (e) {
      showToast({ type: "error", title: "Couldn't record signature", message: (e as Error).message });
    } finally { setBusy(false); }
  };

  return (
    <SignatureCeremony
      signerName={signerName}
      resourceLabel={req.resourceLabel}
      defaultIntent={req.defaultIntent}
      defaultStatement={req.defaultStatement}
      busy={busy}
      onCancel={() => !busy && setReq(null)}
      onSign={sign}
    />
  );
}
