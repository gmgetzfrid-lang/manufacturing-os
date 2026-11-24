"use client";

// Branding → Slide template. The company's PowerPoint template (a branding
// kit): upload it once, and the slides the app makes go onto its layouts.
// The app picks a layout for each kind of slide; an admin can change any
// pick, see the slides drawn on the template right here, and download a
// test deck. Also shown inside each project's printed-reports setup (bare),
// beside the letterhead, so nobody has to leave the project to set it.

import React, { useEffect, useState } from "react";
import { FileUp, Loader2, Download, Trash2, RefreshCw, Check } from "lucide-react";
import { Card } from "@/components/ui/PageHero";
import { btnQuiet, btnDanger, fieldBox } from "@/components/admin/kit";
import { useOrgBranding } from "@/components/providers/OrgBrandingProvider";
import { useRole } from "@/components/providers/RoleContext";
import { appConfirm } from "@/components/providers/DialogProvider";
import { useFileDrag } from "@/hooks/useFileDrag";
import { tryUpload } from "@/lib/uploadRetry";
import { deleteFile } from "@/lib/storage";
import { saveFile } from "@/lib/saveFile";
import { LAYOUT_ROLES, ROLE_WORD, layoutFor, templateColors, templateFonts, type LayoutRole, type SlideTemplateRef } from "@/lib/slideTemplate";
import { loadSlideTemplate, PPTX_MIME, TEMPLATE_ACCEPT, templateLook, uploadSlideTemplate } from "@/lib/slideTemplateStore";
import type { ScreenDeck } from "@/lib/slidePreview";
import SlideFrame from "@/components/slides/SlideFrame";
import { Skeleton } from "@/components/ui/Skeleton";
import { said } from "@/components/admin/said";

const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export default function SlideTemplateSetup({ bare = false }: { bare?: boolean } = {}) {
  const { branding, save, canEdit } = useOrgBranding();
  const { activeOrgId } = useRole();
  const ref = branding?.slides ?? null;
  const [busy, setBusy] = useState<"read" | "test" | "remove" | "pick" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // A made file the phone wants a fresh tap to hand over.
  const [held, setHeld] = useState<{ data: Uint8Array; name: string } | null>(null);

  // The test deck drawn on the template, so the result shows here.
  const [preview, setPreview] = useState<{ key: string; deck: ScreenDeck | null; error?: string } | null>(null);
  const previewKey = ref ? `${ref.path}|${JSON.stringify(ref.pick ?? {})}` : "";
  useEffect(() => {
    if (!ref) return;
    let live = true;
    void (async () => {
      try {
        const [{ info, data }, { screenTestDeck }] = await Promise.all([loadSlideTemplate(ref), import("@/lib/slidePreview")]);
        const deck = await screenTestDeck(ref.path, info, data, templateLook(info, ref), ref.pick);
        if (live) setPreview({ key: previewKey, deck });
      } catch (e) { if (live) setPreview({ key: previewKey, deck: null, error: (e as Error).message }); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);
  const shown = preview?.key === previewKey ? preview : null;

  const store = async (next: SlideTemplateRef | undefined) => save({ ...(branding ?? {}), slides: next });

  const upload = async (f: File | undefined) => {
    if (!f || !activeOrgId) return;
    setBusy("read"); setErr(null); setMsg(null);
    const old = ref;
    try {
      const made = await tryUpload(`Slide template: ${f.name}`, () => uploadSlideTemplate(activeOrgId, f));
      await store(made);
      setMsg(`Saved. Slides now go onto ${f.name}.`);
      if (old) { void deleteFile(old.path).catch(() => {}); if (old.thumbPath) void deleteFile(old.thumbPath).catch(() => {}); }
    } catch (e) { setErr(said(e, "The template didn't upload.")); }
    finally { setBusy(null); }
  };
  const drag = useFileDrag((fs) => { void upload(fs[0]); }, !!busy || !canEdit);

  const remove = async () => {
    if (!ref) return;
    if (!(await appConfirm({ message: "Remove the slide template? Slides go back to the workspace colors.", tone: "danger", confirmLabel: "Remove" }))) return;
    setBusy("remove"); setErr(null); setMsg(null);
    try {
      await store(undefined);
      void deleteFile(ref.path).catch(() => {});
      if (ref.thumbPath) void deleteFile(ref.thumbPath).catch(() => {});
      setMsg("Removed. Slides use the workspace colors.");
    } catch (e) { setErr(said(e, "Couldn't remove the template.")); }
    finally { setBusy(null); }
  };

  const pickLayout = async (role: LayoutRole, file: string) => {
    if (!ref) return;
    setBusy("pick"); setErr(null); setMsg(null);
    try {
      const pick = { ...(ref.pick ?? {}), [role]: file };
      if (file === ref.roles[role]) delete pick[role];
      let next: SlideTemplateRef = { ...ref, pick };
      // Tables take the colors and fonts of the layout they sit on.
      if (role === "content") {
        const { info } = await loadSlideTemplate(ref);
        const l = layoutFor(info, "content", pick);
        if (l) next = { ...next, colors: templateColors(l), fonts: templateFonts(l) };
      }
      await store(next);
    } catch (e) { setErr(said(e, "Couldn't change the layout.")); }
    finally { setBusy(null); }
  };

  const testDeck = async () => {
    if (!ref) return;
    setBusy("test"); setErr(null); setMsg(null);
    try {
      const { info, data } = await loadSlideTemplate(ref);
      const { deckOnTemplate, testSlides } = await import("@/lib/reviewTemplateDeck");
      const out = await deckOnTemplate(testSlides(info, ref.pick), { info, data, look: templateLook(info, ref), pick: ref.pick, title: "Test deck" });
      const name = `Test deck, ${ref.name.replace(/\.(pptx|potx)$/i, "")}.pptx`;
      if (!(await saveFile(out, name, PPTX_MIME))) setHeld({ data: out, name });
    } catch (e) { setErr(said(e, "The test deck couldn't be made.")); }
    finally { setBusy(null); }
  };

  const fileButton = (label: string, Icon: typeof FileUp) => (
    <label className={`${btnQuiet} cursor-pointer ${busy || !canEdit ? "pointer-events-none opacity-50" : ""}`}>
      {busy === "read" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Icon className="w-4 h-4" />} {busy === "read" ? "Reading" : label}
      <input type="file" accept={TEMPLATE_ACCEPT} className="sr-only" disabled={!!busy || !canEdit} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
    </label>
  );
  const heading = "Slide template";
  const notes = (
    <>
      {err && <p role="alert" className="mt-3 text-body font-medium text-[var(--state-overdue-text)]">{err}</p>}
      {msg && <p role="status" className="mt-3 inline-flex items-center gap-1.5 text-body text-[var(--color-text)]"><Check className="w-4 h-4 text-[var(--state-released)]" /> {msg}</p>}
      {held && (
        <p role="status" className="mt-3 flex items-center gap-3 text-body font-medium text-[var(--color-text)]">
          The test deck is ready.
          <button type="button" onClick={async () => { if (await saveFile(held.data, held.name, PPTX_MIME)) setHeld(null); }} className={btnQuiet}><Download className="w-4 h-4" /> Save file</button>
        </p>
      )}
    </>
  );

  const wrap = (c: React.ReactNode) => (bare ? <div>{c}</div> : <Card label={heading}>{c}</Card>);
  if (!ref) {
    return wrap(
      <>
        <label {...drag.bind}
          className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-9 text-center cursor-pointer transition-colors ${drag.over ? `border-[var(--color-main)] ${drag.ring}` : "border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]"} ${!canEdit ? "pointer-events-none opacity-60" : ""}`}>
          <span aria-hidden className="text-[var(--color-text-faint)]">{busy === "read" ? <Loader2 className="w-5 h-5 animate-spin" /> : <FileUp className="w-5 h-5" />}</span>
          <span className="text-reading font-medium text-[var(--color-text)]">{drag.over ? drag.say : busy === "read" ? "Reading your template" : "Upload your company's PowerPoint template"}</span>
          <span className="text-body text-[var(--color-text-muted)] max-w-md">A .pptx or .potx. Review slides go onto its layouts, fonts and colors.</span>
          <input type="file" accept={TEMPLATE_ACCEPT} className="sr-only" disabled={!!busy || !canEdit} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        {!canEdit && <p className="mt-2 text-body text-[var(--color-text-muted)]">Only an admin can set the slide template.</p>}
        {notes}
      </>
    );
  }

  const roleRows: LayoutRole[] = LAYOUT_ROLES;
  return wrap(
    <>
      <div className="flex flex-col sm:flex-row gap-5">
        <div className="min-w-0 flex-1">
          <div className="text-section font-semibold text-[var(--color-text)] break-words">{ref.name}</div>
          <div className="mt-0.5 text-body text-[var(--color-text-muted)]">{ref.layouts.length} layouts · {mb(ref.size)} · Saved {day(ref.savedAt)}</div>
          <div className="mt-3 flex items-center gap-1.5" aria-label="Template colors">
            {ref.colors.swatches.map((c) => (
              <span key={c} title={`#${c}`} className={`rounded-full ring-1 ring-black/10 ${c === ref.colors.main || c === ref.colors.accent ? "w-7 h-7" : "w-5 h-5"}`} style={{ background: `#${c}` }} />
            ))}
          </div>
          <div className="mt-2 text-body text-[var(--color-text)]">Titles in <b className="font-medium">{ref.fonts.title}</b>, text in <b className="font-medium">{ref.fonts.body}</b></div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => void testDeck()} disabled={!!busy} className={btnQuiet}>
              {busy === "test" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Make a test deck
            </button>
            {canEdit && fileButton("Replace", RefreshCw)}
            {canEdit && <button type="button" onClick={() => void remove()} disabled={!!busy} className={btnDanger}>{busy === "remove" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Remove</button>}
          </div>
        </div>
      </div>

      <div className="mt-5" data-template-preview>
        <div className="mb-2 text-body font-medium text-[var(--color-text-muted)]">How slides come out on it</div>
        {shown?.deck ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {shown.deck.slides.map((h, i) => <SlideFrame key={i} html={h} w={shown.deck!.w} h={shown.deck!.h} label={`Test slide ${i + 1}`} className="rounded-sm overflow-hidden ring-1 ring-[var(--color-border-strong)]" />)}
          </div>
        ) : shown?.error ? (
          <p role="alert" className="text-body font-medium text-[var(--state-overdue-text)]">{said(shown.error, "The test slides couldn't be drawn.")}</p>
        ) : (
          <div role="status" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <span className="sr-only">Laying test slides on your template</span>
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="block !h-auto aspect-video rounded-sm" />)}
          </div>
        )}
      </div>

      <div className="mt-5 rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
        <div className="px-4 py-2.5 text-body font-medium text-[var(--color-text-muted)]">Which layout each slide goes on</div>
        {roleRows.map((role) => {
          const auto = ref.roles[role];
          const value = ref.pick?.[role] ?? auto ?? "none";
          const optional = role === "agenda" || role === "section";
          return (
            <div key={role} className="px-4 py-2.5 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <label htmlFor={`lay-${role}`} className="sm:w-48 shrink-0 text-reading font-medium text-[var(--color-text)]">{ROLE_WORD[role]}</label>
              <select id={`lay-${role}`} value={value} disabled={!canEdit || !!busy} onChange={(e) => void pickLayout(role, e.target.value)}
                className={`${fieldBox} h-10 pointer-coarse:h-11 text-reading w-full sm:w-72`}>
                {(optional || !auto) && <option value="none">{optional ? "Leave out" : "None"}</option>}
                {ref.layouts.map((l) => <option key={l.file} value={l.file}>{l.name}{l.file === auto ? " (app's pick)" : ""}</option>)}
              </select>
            </div>
          );
        })}
      </div>
      {notes}
    </>
  );
}
