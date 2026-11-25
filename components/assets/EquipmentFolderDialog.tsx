"use client";

// EquipmentFolderDialog - "New folder" inside the Equipment Files chain. A
// folder there is a unit, an equipment type or a piece of equipment, so it
// goes into the site codebook or the registry first and its folder follows
// (one source; the library never holds a list of its own):
//
//   at the top        → a new operating area (unit code and name, site codebook)
//   inside a unit     → an equipment type from the site codebook ("30 - Exchangers")
//   inside a type     → a piece of equipment (tag, number, description, registry)
//
// A plain folder ("General", "Datasheets") is one click away at every level.

import React, { useEffect, useMemo, useState } from "react";
import { FolderPlus } from "lucide-react";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { field as fieldCls } from "@/components/admin/kit";
import { sayError } from "@/components/projects/sayError";
import { supabase } from "@/lib/supabase";
import { loadCodebook, type Codebook } from "@/lib/codebook";
import { listAssetTypes, type AssetType } from "@/lib/assets";
import { assetHref } from "@/lib/equipmentIdentity";
import { NO_UNIT, assetFolderName, typeFolderName, unitFolderName, type EquipmentTree } from "@/lib/equipmentLibrary";
import { addEquipmentFromLibrary, addTypeFromLibrary, addUnitFromLibrary } from "@/lib/equipmentLibraryPush";

export type EquipmentFolderLevel = { level: "unit" } | { level: "type"; unitCode: string } | { level: "equipment"; unitCode: string; typeId: string | null };

const Field = ({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) => (
  <div className="grid gap-1">
    <label htmlFor={id} className="text-body font-medium text-[var(--color-text)]">{label}{hint && <span className="font-normal text-[var(--color-text-muted)]"> {hint}</span>}</label>
    {children}
  </div>
);

export default function EquipmentFolderDialog({ orgId, uid, email, tree, at, canAddEquipment, onDone, onPlain, onClose }: {
  orgId: string; uid: string; email?: string; tree: EquipmentTree; at: EquipmentFolderLevel;
  /** Adding equipment to the registry is Admin only (the database says so). */
  canAddEquipment: boolean;
  onDone: (folderId: string | null) => void;
  /** Make a plain folder here instead. */
  onPlain: () => void;
  onClose: () => void;
}) {
  const [book, setBook] = useState<Codebook | null>(null);
  const [types, setTypes] = useState<AssetType[]>([]);
  useEffect(() => {
    let on = true;
    void Promise.all([loadCodebook(orgId), listAssetTypes(orgId).catch(() => [] as AssetType[])]).then(([b, t]) => { if (on) { setBook(b); setTypes(t); } }, () => { if (on) setBook(null); });
    return () => { on = false; };
  }, [orgId]);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [typeCode, setTypeCode] = useState("");
  const [tag, setTag] = useState("");
  const [number, setNumber] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [taken, setTaken] = useState<{ tag: string; code: string | null } | null>(null);

  const unit = at.level !== "unit" ? book?.units.find((u) => u.code === at.unitCode) ?? null : null;
  const unitWords = at.level === "unit" ? "" : at.unitCode === NO_UNIT ? "No operating area" : unitFolderName(unit ?? { code: at.unitCode, label: at.unitCode });
  // The type's codebook number, matched by name as Operating areas matches it.
  const codeOfType = useMemo(() => new Map((book?.equipmentTypes ?? []).map((t) => [t.label.trim().toLowerCase(), t.code])), [book]);
  const thisType = at.level === "equipment" && at.typeId ? types.find((t) => t.id === at.typeId) ?? null : null;
  const thisTypeCode = thisType ? codeOfType.get(thisType.name.trim().toLowerCase()) ?? null : null;
  // A number starts the way the encoding writes it: unit, type, then the piece ("2030.").
  useEffect(() => {
    if (at.level === "equipment" && at.unitCode !== NO_UNIT && thisTypeCode && !number) setNumber(`${at.unitCode}${thisTypeCode}.`);
  }, [at, thisTypeCode, number]);

  // Types already with a folder in this unit aren't offered again.
  const typesHere = useMemo(() => {
    if (at.level !== "type") return new Set<string>();
    const ids = Object.keys(tree.types ?? {}).filter((k) => k.split("|")[0] === at.unitCode).map((k) => k.split("|")[1]);
    return new Set(types.filter((t) => ids.includes(t.id)).map((t) => t.name.trim().toLowerCase()));
  }, [at, tree, types]);
  const typeChoices = (book?.equipmentTypes ?? []).filter((t) => !typesHere.has(t.label.trim().toLowerCase()));
  const pickedType = typeChoices.find((t) => t.code === typeCode) ?? null;
  const unitTaken = at.level === "unit" && !!book?.units.some((u) => u.code.trim() === code.trim());

  const preview = at.level === "unit" ? (code.trim() && label.trim() ? unitFolderName({ code: code.trim(), label: label.trim() }) : null)
    : at.level === "type" ? (pickedType ? typeFolderName({ id: "", name: pickedType.label, code: pickedType.code }) : null)
    : (tag.trim() ? assetFolderName({ id: "", tag: tag.trim(), code: number.trim() || null, unitCode: null, typeId: null, description: desc.trim() || null }) : null);
  const ready = at.level === "unit" ? !!preview && !unitTaken : at.level === "type" ? !!pickedType : !!tag.trim() && canAddEquipment;

  const go = async () => {
    setErr(null); setTaken(null);
    setBusy(true);
    try {
      if (at.level === "unit") onDone(await addUnitFromLibrary(orgId, uid, email, { code, label }));
      else if (at.level === "type") onDone(pickedType ? await addTypeFromLibrary(orgId, uid, email, at.unitCode, { code: pickedType.code, label: pickedType.label }) : null);
      else {
        // The number is the identity: one already in the registry is that piece, never a second one.
        if (number.trim() && !/\.$/.test(number.trim())) {
          const { data } = await supabase.from("assets").select("tag, code").eq("org_id", orgId).eq("archived", false).eq("code", number.trim()).limit(1);
          const hit = ((data ?? []) as Array<{ tag: string; code: string | null }>)[0];
          if (hit) { setTaken(hit); return; }
        }
        onDone(await addEquipmentFromLibrary(orgId, uid, email, { unitCode: at.unitCode, typeId: at.typeId, tag, code: /\.$/.test(number.trim()) ? "" : number, description: desc }));
      }
    } catch (e) { setErr(sayError(e)); } finally { setBusy(false); }
  };

  const title = at.level === "unit" ? "New operating area" : at.level === "type" ? `New equipment type in ${unitWords}` : "New equipment";
  const where = at.level === "unit" ? "Added to the site codebook, with its folder here and a link on its unit page."
    : at.level === "type" ? "A type from the site codebook, numbered as the encoding numbers it."
    : `Added to the equipment registry in ${unitWords}${thisType ? `, ${thisTypeCode ? `${thisTypeCode} - ` : ""}${thisType.name}` : ", no type yet"}. Its folder is made here and its page lists what's filed in it.`;

  return (
    <Modal onClose={onClose} size="sm" zIndex={90} dismissable={!busy}>
      <ModalHeader icon={FolderPlus} title={title} subtitle={where} onClose={busy ? undefined : onClose} />
      <form onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void go(); }}>
        <ModalBody className="grid gap-3">
          {!book ? <p role="status" className="text-body text-[var(--color-text-muted)]">Reading the site codebook…</p>
            : at.level === "unit" ? (
              <div className="grid sm:grid-cols-[8rem_1fr] gap-3">
                <Field id="efd-code" label="Unit number"><input id="efd-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. 65" className={fieldCls} autoFocus inputMode="numeric" /></Field>
                <Field id="efd-label" label="Name"><input id="efd-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Sulfur Recovery" className={fieldCls} /></Field>
                {unitTaken && <p className="sm:col-span-2 text-body text-[var(--state-held-text)]">Unit {code.trim()} is already in the site codebook ({book.units.find((u) => u.code.trim() === code.trim())?.label}). Its folder is made for it already.</p>}
              </div>
            ) : at.level === "type" ? (
              <Field id="efd-type" label="Equipment type">
                <select id="efd-type" value={typeCode} onChange={(e) => setTypeCode(e.target.value)} className={fieldCls} autoFocus>
                  <option value="">Pick a type from the site codebook</option>
                  {typeChoices.map((t) => <option key={t.code} value={t.code}>{t.code} - {t.label}</option>)}
                </select>
              </Field>
            ) : !canAddEquipment ? (
              <p className="text-body text-[var(--state-held-text)]">Only an Admin adds equipment to the registry. Ask one, or make a plain folder here.</p>
            ) : (
              <>
                <div className="grid sm:grid-cols-2 gap-3">
                  <Field id="efd-tag" label="Tag"><input id="efd-tag" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="e.g. X-99" className={fieldCls} autoFocus autoCapitalize="characters" /></Field>
                  <Field id="efd-num" label="Number" hint="(its ID)"><input id="efd-num" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="e.g. 2030.99" className={fieldCls} inputMode="decimal" /></Field>
                </div>
                <Field id="efd-desc" label="Description"><input id="efd-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Overhead trim cooler" className={fieldCls} /></Field>
                {taken && <p className="text-body text-[var(--state-held-text)]">{number.trim()} is already {taken.tag} in the registry. <a href={assetHref(taken)} className="font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">Open {taken.tag}</a>; its folder is made for it already.</p>}
              </>
            )}
          {preview && <p className="text-body text-[var(--color-text-muted)]">Folder: <b className="font-medium text-[var(--color-text)]">{preview}</b></p>}
          {err && <p role="alert" className="text-body font-medium text-[var(--state-overdue-text)]">{err}</p>}
          <button type="button" onClick={onPlain} disabled={busy} className="justify-self-start min-h-9 pointer-coarse:min-h-11 text-body font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">Make a plain folder here instead</button>
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" loading={busy} disabled={!ready}>
            {at.level === "unit" ? (code.trim() ? `Add unit ${code.trim()}` : "Add the unit") : at.level === "type" ? (pickedType ? `Add ${pickedType.code} - ${pickedType.label}` : "Add the type") : (tag.trim() ? `Add ${tag.trim()} to the registry` : "Add to the registry")}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
