"use client";

// LogoUploadModal: add or change the workspace logo straight from the side
// menu (Admins only). Colors, the palette and the slide template live at
// /admin/branding; this only handles the logo so nobody has to hunt for
// the page.

import React, { useRef, useState } from "react";
import Link from "next/link";
import { Upload } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { useOrgBranding } from "@/components/providers/OrgBrandingProvider";
import { appConfirm } from "@/components/providers/DialogProvider";
import { uploadToPath } from "@/lib/storage";
import { tryUpload } from "@/lib/uploadRetry";
import { useFileDrag } from "@/hooks/useFileDrag";
import FileThumb from "@/components/ui/FileThumb";
import { formatBytes } from "@/lib/formatBytes";
import { Modal, ModalHeader, ModalBody } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { link } from "@/components/admin/kit";
import { bandSeg, bandSegItem } from "@/components/admin/band";
import { said } from "@/components/admin/said";


export default function LogoUploadModal({ onClose }: { onClose: () => void }) {
  const { activeOrgId } = useRole();
  const { branding, logoUrl, save } = useOrgBranding();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shape, setShape] = useState<"mark" | "full">(branding?.logoShape ?? "full");
  const [picked, setPicked] = useState<File | null>(null);

  const pick = async (file: File | undefined | null) => {
    if (!file || !activeOrgId) return;
    if (!file.type.startsWith("image/")) { setError("Choose an image file (PNG, SVG or JPG)."); return; }
    setBusy("upload"); setError(null); setPicked(file);
    try {
      const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
      const rand = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}`;
      const path = `orgs/${activeOrgId}/branding/logo-${rand}.${ext}`;
      // Upload, then point the workspace at it. Safe to repeat: same file,
      // same path, and saving the logo again just sets it again.
      await tryUpload(file.name, async () => {
        await uploadToPath(file, path, { contentType: file.type });
        await save({ ...branding, logoPath: path, logoShape: shape });
      });
      onClose();
    } catch (e) {
      setError(said(e, "The logo didn't upload."));
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!(await appConfirm({ message: "Remove the workspace logo? Everyone sees the app's name in its place until a new one is uploaded.", tone: "danger", confirmLabel: "Remove logo" }))) return;
    setBusy("remove"); setError(null);
    try {
      await save({ ...branding, logoPath: undefined, logoShape: shape });
      onClose();
    } catch (e) {
      setError(said(e, "Couldn't remove the logo."));
      setBusy(null);
    }
  };

  const drag = useFileDrag((files) => void pick(files[0]), !!busy);

  return (
    <Modal onClose={onClose} size="sm" dismissable={!busy}>
      <ModalHeader title="Workspace logo" onClose={busy ? undefined : onClose} />
      <ModalBody className="space-y-4">
        <div {...drag.bind} className={`rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-2)] h-24 grid place-items-center overflow-hidden p-2 ${drag.ring}`}>
          {drag.over ? (
            <div className="text-[14px] font-semibold text-[var(--color-text)]">{drag.say}</div>
          ) : logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- signed storage URL
            <img src={logoUrl} alt="Workspace logo" className="max-h-16 max-w-[80%] object-contain" draggable={false} />
          ) : (
            <div className="text-[14px] text-[var(--color-text-muted)]">No logo yet. Drop one here.</div>
          )}
        </div>

        <div>
          <div className="text-[14px] font-semibold text-[var(--color-text)] mb-1.5">Show it as</div>
          <div role="radiogroup" aria-label="Show the logo as" className={bandSeg}>
            {(["full", "mark"] as const).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={shape === s} onClick={() => setShape(s)} className={bandSegItem(shape === s)}>
                {s === "full" ? "Wide wordmark" : "Square mark"}
              </button>
            ))}
          </div>
        </div>

        {picked && (
          <div className="flex items-center gap-2.5">
            <FileThumb file={picked} size={32} />
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold text-[var(--color-text)] truncate">{picked.name}</span>
              <span className="block text-[13px] text-[var(--color-text-muted)]">{formatBytes(picked.size)}{busy === "upload" ? ", uploading" : ""}</span>
            </span>
            {!busy && error && (
              <Button size="sm" variant="secondary" onClick={() => void pick(picked)}>Try again</Button>
            )}
          </div>
        )}
        {error && <p role="alert" className="text-[14px] font-semibold text-[var(--state-overdue-text)]">{error}</p>}

        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
        <Button className="w-full" loading={busy === "upload"} disabled={!!busy} onClick={() => fileRef.current?.click()}>
          {busy !== "upload" && <Upload className="w-4 h-4" />}
          {logoUrl ? "Replace logo" : "Upload logo"}
        </Button>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href="/admin/branding" onClick={onClose} className={`${link} text-[14px]`}>Colors and slide template</Link>
          {logoUrl && (
            <Button size="sm" variant="danger" loading={busy === "remove"} disabled={!!busy} onClick={() => void remove()}>Remove logo</Button>
          )}
        </div>
      </ModalBody>
    </Modal>
  );
}
