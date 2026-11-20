"use client";

// /assets/[tag] — the asset-as-hub "digital twin". One page per equipment tag
// (e.g. FE-201) that pulls together EVERYTHING controlled about that asset:
// its registry entry (type/location/description), every controlled document
// tagged to it, open holds on those docs, and its photos. Scan a QR on the
// equipment → land here. A view no shared-drive competitor can offer.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Tag as TagIcon, MapPin, FileText, AlertOctagon, Lock, RefreshCw, ImageIcon, Printer, Loader2, QrCode } from "lucide-react";
import MoreMenu from "@/components/ui/MoreMenu";
import LoadingBlock from "@/components/ui/LoadingBlock";
import SignedImg from "@/components/assets/SignedImg";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { getAssetByTag, listAssetPhotos, type Asset, type AssetPhoto } from "@/lib/assets";
import AliasPanel from "@/components/assets/AliasPanel";
import MentionsPanel from "@/components/assets/MentionsPanel";
import EstatePanel from "@/components/assets/EstatePanel";
import WorkHistoryPanel from "@/components/assets/WorkHistoryPanel";
import { stateStyle, documentState } from "@/lib/stateColors";

interface HubDoc {
  id: string; number: string; title: string; rev: string | null;
  status: string | null; libraryId: string | null; checkedOutByName: string | null;
}

export default function AssetHubPage() {
  const params = useParams();
  const tag = decodeURIComponent(String(params?.tag ?? ""));
  const { activeOrgId, activeRole, uid, userEmail } = useRole();
  const [packing, setPacking] = useState(false);
  const [packProgress, setPackProgress] = useState<[number, number] | null>(null);
  const [packNote, setPackNote] = useState<string | null>(null);

  const [asset, setAsset] = useState<Asset | null>(null);
  const [docs, setDocs] = useState<HubDoc[]>([]);
  const [holdsByDoc, setHoldsByDoc] = useState<Map<string, number>>(new Map());
  const [photos, setPhotos] = useState<AssetPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [partError, setPartError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId || !tag) return;
    setLoading(true); setError(null); setPartError(null);
    const missed: string[] = [];
    try {
      const a = await getAssetByTag(activeOrgId, tag).catch(() => { missed.push("the equipment record"); return null; });
      setAsset(a);

      // Every controlled document tagged to this asset (JSONB containment).
      const { data: docRows, error: de } = await supabase
        .from("documents")
        .select("id, document_number, title, name, rev, status, library_id, checked_out_by_name")
        .eq("org_id", activeOrgId)
        .contains("asset_tags", [{ tag }])
        .neq("status", "Archived")
        .limit(500);
      if (de) throw new Error(de.message);
      const mapped: HubDoc[] = (docRows ?? []).map((r) => ({
        id: String((r as Record<string, unknown>).id),
        number: String((r as Record<string, unknown>).document_number || (r as Record<string, unknown>).title || (r as Record<string, unknown>).name || "-"),
        title: String((r as Record<string, unknown>).title || ""),
        rev: ((r as Record<string, unknown>).rev as string) ?? null,
        status: ((r as Record<string, unknown>).status as string) ?? null,
        libraryId: ((r as Record<string, unknown>).library_id as string) ?? null,
        checkedOutByName: ((r as Record<string, unknown>).checked_out_by_name as string) ?? null,
      }));
      setDocs(mapped);

      // Open holds on those documents.
      const ids = mapped.map((d) => d.id);
      const hold = new Map<string, number>();
      if (ids.length > 0) {
        const { data: holdRows, error: he } = await supabase
          .from("document_holds").select("document_id").in("document_id", ids).is("released_at", null);
        if (he) missed.push("holds");
        for (const h of (holdRows ?? []) as Array<{ document_id: string }>) {
          hold.set(h.document_id, (hold.get(h.document_id) ?? 0) + 1);
        }
      }
      setHoldsByDoc(hold);

      if (a?.id) setPhotos(await listAssetPhotos(a.id).catch(() => { missed.push("photos"); return []; }));
      else setPhotos([]);
      if (missed.length) setPartError(`Couldn't load ${missed.join(", ")}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [activeOrgId, tag]);

  useEffect(() => { void refresh(); }, [refresh]);

  const docCount = docs.length;
  const heldCount = useMemo(() => Array.from(holdsByDoc.values()).reduce((a, b) => a + (b > 0 ? 1 : 0), 0), [holdsByDoc]);

  if (loading && docs.length === 0 && !asset) {
    return <div className="p-6"><LoadingBlock what={tag || "the equipment"} /></div>;
  }

  const printPack = async () => {
    if (!uid || !activeOrgId || packing) return;
    setPacking(true);
    setPackNote(null);
    setPackProgress([0, docs.length]);
    try {
      const { buildAndDownloadDocPack } = await import("@/lib/docPack");
      const result = await buildAndDownloadDocPack({
        orgId: activeOrgId,
        packLabel: tag,
        documentIds: docs.map((d) => d.id),
        userId: uid,
        userEmail,
        onProgress: (done, total) => setPackProgress([done, total]),
      });
      setPackNote(
        result.skipped.length === 0
          ? `Pack ready: ${result.included} drawing${result.included === 1 ? "" : "s"}, all current, all stamped.`
          : `Pack ready: ${result.included} included, ${result.skipped.length} skipped (${result.skipped.map((s) => s.label).join(", ")}).`,
      );
    } catch (e) {
      setPackNote(`Pack failed: ${(e as Error).message}`);
    } finally {
      setPacking(false);
      setPackProgress(null);
    }
  };
  const printLabel = async () => {
    try {
      const { printEquipmentLabels } = await import("@/lib/physicalBridge");
      await printEquipmentLabels([{
        tag,
        description: asset?.description ?? null,
        location: asset?.location ?? null,
      }]);
    } catch (e) {
      setPackNote(`Label failed: ${(e as Error).message}`);
    }
  };

  return (
    <PageShell width="work">
        {/* Header */}
        <PageHeaderBar
          icon={TagIcon}
          title={<span className="font-mono">{tag}</span>}
          subtitle={
            <>
              {asset?.description || (asset ? "Registered asset" : "Not in the equipment list. Showing documents tagged with it.")}
              {asset?.location && (
                <span className="mt-1 flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
                  <MapPin className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> {asset.location}
                </span>
              )}
            </>
          }
          actions={
            <>
              {/* Report a problem: pre-filled drafting request. The scan
                  landing must let the field WRITE, not just read. */}
              <Link
                href={`/requests/new?title=${encodeURIComponent(`Issue at ${tag}`)}&description=${encodeURIComponent(`Equipment: ${tag}${asset?.location ? ` (${asset.location})` : ""}\n\nDescribe the problem: `)}`}
                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]"
              >
                <AlertOctagon className="w-3.5 h-3.5" /> Report a problem
              </Link>
              {/* One click from equipment tag to a single stamped PDF of every
                  current drawing, each sheet carrying its own verify-QR. */}
              {docs.length > 0 && uid && activeOrgId && (
                <Button variant="secondary" size="sm" disabled={packing} onClick={() => void printPack()}>
                  {packing
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {packProgress ? `Packing ${packProgress[0]}/${packProgress[1]}…` : "Packing…"}</>
                    : <><Printer className="w-3.5 h-3.5" /> Print doc pack</>}
                </Button>
              )}
              <MoreMenu items={[
                // The QR sticker turns this equipment into an app entry point:
                // scan at the pump, land on this page.
                { icon: <QrCode className="w-4 h-4" />, label: "Print QR label", onClick: () => void printLabel() },
                { icon: <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />, label: loading ? "Refreshing…" : "Refresh", onClick: () => void refresh() },
              ]} />
            </>
          }
        />

        {/* One line with what matters: how many documents, and how many are held. */}
        <p className="mb-4 text-sm text-[var(--color-text-muted)]">
          <span className="font-bold text-[var(--color-text)]">{docCount}</span> controlled document{docCount === 1 ? "" : "s"}
          {heldCount > 0
            ? <> · <span className="font-bold text-rose-700 dark:text-rose-400">{heldCount} on hold</span></>
            : <> · none on hold</>}
          {photos.length > 0 && <> · {photos.length} photo{photos.length === 1 ? "" : "s"}</>}
        </p>

        {packNote && (
          <p role="status" className={`mb-4 border-l-2 pl-3 text-xs ${packNote.startsWith("Pack failed") || packNote.startsWith("Label failed") ? "border-red-500 text-red-700 dark:text-red-400" : "border-emerald-500 text-emerald-700 dark:text-emerald-400"}`}>
            {packNote}
          </p>
        )}

        {error && (
          <p role="alert" className="mb-4 border-l-2 border-red-500 pl-3 text-xs text-red-700 dark:text-red-400">
            Couldn&apos;t load the documents: {error}{" "}
            <button type="button" onClick={() => void refresh()} className="font-bold underline">Try again</button>
          </p>
        )}
        {partError && !error && (
          <p role="alert" className="mb-4 border-l-2 border-amber-500 pl-3 text-xs text-amber-800 dark:text-amber-300">
            {partError}{" "}
            <button type="button" onClick={() => void refresh()} className="font-bold underline">Try again</button>
          </p>
        )}

        {/* Documents */}
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden mb-5">
          <div className="px-4 py-3 border-b border-[var(--color-border)] text-sm font-black text-[var(--color-text)] inline-flex items-center gap-2"><FileText className="w-4 h-4 text-[var(--color-text-muted)]" /> Controlled documents</div>
          {docs.length === 0 ? (
            <div className="p-8 text-center text-xs text-[var(--color-text-faint)] italic">No controlled documents are tagged to {tag} yet.</div>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {docs.map((d) => (
                <li key={d.id}>
                  <Link href={d.libraryId ? `/documents/${d.libraryId}?doc=${d.id}` : "/documents"} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-surface-2)] transition-colors">
                    <span className="font-mono text-xs font-bold text-[var(--color-text)] truncate flex-1">{d.number}{d.title && d.title !== d.number ? <span className="font-sans font-normal text-[var(--color-text-muted)]"> · {d.title}</span> : ""}</span>
                    {d.rev && <span className="text-[11px] font-bold bg-[var(--color-surface-2)] text-[var(--color-text-muted)] px-1.5 py-0.5 rounded shrink-0">Rev {d.rev}</span>}
                    {d.status && <span className={`text-[11px] font-bold uppercase px-1.5 py-0.5 rounded border shrink-0 ${stateStyle(documentState(d.status)).pill}`}>{d.status}</span>}
                    {(holdsByDoc.get(d.id) ?? 0) > 0 && <span className="text-[11px] font-bold text-rose-700 dark:text-rose-400 inline-flex items-center gap-0.5 shrink-0"><AlertOctagon className="w-3 h-3" /> hold</span>}
                    {d.checkedOutByName && <span className="text-[11px] font-bold text-[var(--color-text)] inline-flex items-center gap-0.5 shrink-0"><Lock className="w-3 h-3" />{d.checkedOutByName}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Every job done on it, across projects, and what was learned. */}
        {asset?.id && activeOrgId && (
          <WorkHistoryPanel orgId={activeOrgId} assetId={asset.id} code={asset.code ?? null} tag={asset.tag} unitCode={asset.unit_code ?? null} />
        )}

        {/* Everything the estate knows about it, through the one find service:
            drawn on, mentioned in, tagged, filed, and the work in flight. */}
        {asset?.id && activeOrgId && (
          <EstatePanel orgId={activeOrgId} assetId={asset.id} tag={tag} />
        )}

        {/* Every document that TALKS about this equipment, whether or not
            anyone remembered to tag it. Derived from the indexed text, with
            the sentence attached. */}
        {asset?.id && activeOrgId && (
          <MentionsPanel orgId={activeOrgId} assetId={asset.id} tag={tag} />
        )}

        {/* What people actually call it — nicknames, old tags, vendor names */}
        {asset?.id && activeOrgId && (
          <AliasPanel
            orgId={activeOrgId}
            assetId={asset.id}
            canManage={["Admin", "DocCtrl", "Manager", "Supervisor"].includes(activeRole ?? "")}
            userId={uid ?? undefined}
            userName={userEmail ?? undefined}
          />
        )}

        {/* Photos */}
        {photos.length > 0 && (
          <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm p-4">
            <div className="text-sm font-black text-[var(--color-text)] inline-flex items-center gap-2 mb-3"><ImageIcon className="w-4 h-4 text-[var(--color-text-muted)]" /> Photos</div>
            <div className="flex flex-wrap gap-2">
              {photos.slice(0, 12).map((p) => (
                <div key={p.id} className="w-24 h-24 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border)] flex items-center justify-center text-[11px] text-[var(--color-text-faint)] overflow-hidden" title={p.caption || ""}>
                  <SignedImg path={p.file_url} alt={p.caption || `${tag} photo`} className="w-full h-full object-cover" placeholder={<span className="px-1 text-center truncate">{p.caption || "Photo"}</span>} />
                </div>
              ))}
            </div>
          </div>
        )}
    </PageShell>
  );
}

