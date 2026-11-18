"use client";

// Mounts once in the protected layout. Listens for a global `request-signature`
// CustomEvent and runs the ceremony with the signed-in user's identity, then
// records the signature and announces `signature-recorded` so any open list can
// refresh. Lets any surface request a signature without prop-drilling.
//
// The listener is in the app shell from mount; the ceremony (and the
// signature library it records through) is fetched when the browser is
// first idle, or at the first request, and shows as soon as it lands
// (projects-tab PERF-12, projects-joint J18). A failed fetch closes the
// request — as Cancel does: nothing is signed, nothing is announced (the
// request is a fire-and-forget event with no reply channel; a requester
// hears only `signature-recorded`) — and the signer is told in a toast that
// it did not open; the next request fetches again.

import React from "react";
import type { SignatureIntent, SigningCredential } from "@/lib/eSignatures";
import { useRole } from "@/components/providers/RoleContext";
import { useToast } from "@/components/providers/ToastProvider";
import { lazyModule, loadFailedToast, usePreloadWhenIdle } from "@/lib/lazyModule";

export const signatureCeremonyModule = lazyModule(
  async () => {
    const [ceremony, eSignatures] = await Promise.all([
      import("@/components/signatures/SignatureCeremony"),
      import("@/lib/eSignatures"),
    ]);
    return { SignatureCeremony: ceremony.default, recordSignature: eSignatures.recordSignature };
  },
  "signature ceremony",
);

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
  const [attempt, setAttempt] = React.useState(0);
  usePreloadWhenIdle(signatureCeremonyModule);

  React.useEffect(() => {
    const onReq = (e: Event) => {
      const d = (e as CustomEvent<RequestSignatureDetail>).detail;
      if (d?.resourceId) {
        setReq(d);
        setAttempt((n) => n + 1);
      }
    };
    window.addEventListener("request-signature", onReq as EventListener);
    return () => window.removeEventListener("request-signature", onReq as EventListener);
  }, []);

  const loaded = signatureCeremonyModule.useLoaded(!!req, {
    attempt,
    onError: () => {
      setReq(null);
      showToast({ ...loadFailedToast("signature ceremony"), message: "Nothing was signed. Check your connection and try again." });
    },
  });
  if (!req || !loaded) return null;
  const { SignatureCeremony, recordSignature } = loaded;
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
