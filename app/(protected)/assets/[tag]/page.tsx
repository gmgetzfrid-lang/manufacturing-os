"use client";

// /assets/[tag] — the asset-as-hub "digital twin". One page per equipment tag
// (e.g. FE-201) that pulls together EVERYTHING controlled about that asset:
// its registry entry (type/location/description), every controlled document
// tagged to it, open holds on those docs, and its photos. Scan a QR on the
// equipment → land here. A view no shared-drive competitor can offer.
//
// Layout: the paperwork and what the estate says about it on the wide side
// (about 62%), the things you check at a glance (photos, its work, its other
// names) on the narrow side.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { MapPin, AlertOctagon, RefreshCw, Printer, QrCode } from "lucide-react";
import MoreMenu from "@/components/ui/MoreMenu";
import SignedImg from "@/components/assets/SignedImg";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import { CopyId } from "@/components/ui/CopyId";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";
import { friendlyError } from "@/lib/friendlyError";
import { transitionPush } from "@/lib/viewTransition";
import { getAssetByTag, listAssetPhotos, type Asset, type AssetPhoto } from "@/lib/assets";
import AliasPanel from "@/components/assets/AliasPanel";
import MentionsPanel from "@/components/assets/MentionsPanel";
import EstatePanel from "@/components/assets/EstatePanel";
import WorkHistoryPanel from "@/components/assets/WorkHistoryPanel";
import { StatusTag } from "@/components/documents/StatusTag";
import { shortDate } from "@/components/admin/kit";

interface HubDoc {
  id: string; number: string; title: string; rev: string | null;
  status: string | null; libraryId: string | null; checkedOutByName: string | null;
  updatedAt: string | null;
}

export default function AssetHubPage() {
  const params = useParams();
  const router = useRouter();
  const tag = decodeURIComponent(String(params?.tag ?? ""));
  const { activeOrgId, activeRole, uid, userEmail } = useRole();
  const [packing, setPacking] = useState(false);
  const [packDone, setPackDone] = useState(false);
  const [packProgress, setPackProgress] = useState<[number, number] | null>(null);
  const [packNote, setPackNote] = useState<{ text: string; bad: boolean } | null>(null);

  const [asset, setAsset] = useState<Asset | null>(null);
  const [docs, setDocs] = useState<HubDoc[]>([]);
  const [holdsByDoc, setHoldsByDoc] = useState<Map<string, number>>(new Map());
  const [photos, setPhotos] = useState<AssetPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [partError, setPartError] = useState<string | null>(null);
  const [docLimit, setDocLimit] = useState(25);

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
        .select("id, document_number, title, name, rev, status, library_id, checked_out_by_name, updated_at")
        .eq("org_id", activeOrgId)
        .contains("asset_tags", [{ tag }])
        .neq("status", "Archived")
        .limit(500);
      if (de) throw de;
      const mapped: HubDoc[] = (docRows ?? []).map((r) => {
        const x = r as Record<string, unknown>;
        return {
          id: String(x.id),
          number: String(x.document_number || x.title || x.name || "-"),
          title: String(x.title || ""),
          rev: (x.rev as string) ?? null,
          status: (x.status as string) ?? null,
          libraryId: (x.library_id as string) ?? null,
          checkedOutByName: (x.checked_out_by_name as string) ?? null,
          updatedAt: (x.updated_at as string) ?? null,
        };
      });
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
      setError(e ?? true);
    } finally {
      setLoading(false);
    }
  }, [activeOrgId, tag]);

  useEffect(() => { void refresh(); }, [refresh]);

  const docCount = docs.length;
  const heldCount = useMemo(() => Array.from(holdsByDoc.values()).reduce((a, b) => a + (b > 0 ? 1 : 0), 0), [holdsByDoc]);
  const backHref = asset?.unit_code ? `/admin/assets?unit=${encodeURIComponent(asset.unit_code)}` : "/admin/assets";
  const kicker = <>Operating areas{asset?.unit_code ? ` · Unit ${asset.unit_code}` : ""}</>;

  if (loading && docs.length === 0 && !asset) {
    return (
      <PageShell width="work">
        <PageHero kicker={kicker} title={<CopyId value={tag} label="tag" />} size="md" overlap={false}
          back={{ href: backHref, label: "Back to operating areas" }} />
        <PageBody>
          <SkeletonRows rows={5} cols={3} what={tag || "the equipment"} />
        </PageBody>
      </PageShell>
    );
  }

  const printPack = async () => {
    if (!uid || !activeOrgId || packing) return;
    setPacking(true);
    setPackDone(false);
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
      setPackDone(true);
      setPackNote({
        bad: false,
        text: result.skipped.length === 0
          ? `Pack ready: ${result.included} drawing${result.included === 1 ? "" : "s"}, all current, all stamped.`
          : `Pack ready: ${result.included} included, ${result.skipped.length} left out (${result.skipped.map((s) => s.label).join(", ")}).`,
      });
    } catch (e) {
      setPackNote({ bad: true, text: `Couldn't make the pack. ${friendlyError(e)}` });
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
      setPackNote({ bad: true, text: `Couldn't print the label. ${friendlyError(e)}` });
    }
  };

  // The equipment tag is the answer engineers read (click to copy it); the
  // numbers sit under it. A hold is the one that needs someone, so it leads
  // when there is one.
  const outCount = docs.filter((d) => !!d.checkedOutByName).length;
  const answerFacts = error && docs.length === 0 ? undefined : [
    { label: "Documents", value: docCount.toLocaleString() },
    { label: "On hold", value: heldCount.toLocaleString(), tone: heldCount > 0 ? "bad" as const : undefined, hero: heldCount > 0 },
    { label: "Checked out", value: outCount.toLocaleString(), tone: outCount > 0 ? "warn" as const : undefined },
    ...(photos.length > 0 ? [{ label: "Photos", value: photos.length.toLocaleString() }] : []),
  ];
  const openDoc = (d: HubDoc) => transitionPush(router, d.libraryId ? `/documents/${d.libraryId}?doc=${d.id}` : "/documents");

  return (
    <PageShell width="work">
        <PageHero
          kicker={kicker}
          back={{ href: backHref, label: "Back to operating areas" }}
          title={<CopyId value={tag} label="tag" />}
          facts={answerFacts}
          factsHero={heldCount > 0 ? "auto" : "none"}
          sub={
            <>
              {!!error && docs.length === 0 ? "Its documents didn't load." : asset?.description || (asset ? "Registered equipment." : "Not in the equipment list. Showing documents tagged with it.")}
              {asset?.location && <span className="ml-3 whitespace-nowrap"><MapPin aria-hidden className="inline w-4 h-4 -mt-0.5" /> {asset.location}</span>}
            </>
          }
          tools={
            <>
              {/* One click from equipment tag to a single stamped PDF of every
                  current drawing, each sheet carrying its own verify-QR. */}
              {docs.length > 0 && uid && activeOrgId && (
                <Button variant="secondary" loading={packing} done={packDone} doneLabel="Pack ready" onClick={() => void printPack()}>
                  {!packing && <Printer aria-hidden className="w-4 h-4" />}
                  {packing && packProgress ? `Packing ${packProgress[0]} of ${packProgress[1]}` : <><span className="max-sm:hidden">Print doc pack</span><span className="sm:hidden">Pack</span></>}
                </Button>
              )}
              <MoreMenu iconOnly triggerClass={heroQuiet} items={[
                // The QR sticker turns this equipment into an app entry point:
                // scan at the pump, land on this page.
                { icon: <QrCode className="w-4 h-4" />, label: "Print QR label", onClick: () => void printLabel() },
                { icon: <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />, label: loading ? "Refreshing" : "Refresh", onClick: () => void refresh() },
              ]} />
            </>
          }
          // Report a problem: a pre-filled drafting request. The scan landing
          // must let the field WRITE, not just read.
          primary={
            <Link
              href={`/requests/new?title=${encodeURIComponent(`Issue at ${tag}`)}&description=${encodeURIComponent(`Equipment: ${tag}${asset?.location ? ` (${asset.location})` : ""}\n\nDescribe the problem: `)}`}
              className={heroPrimary}
            >
              <AlertOctagon className="w-4 h-4" /> Report a problem
            </Link>
          }
        />

        <PageBody>
        {(packNote || partError) && (
          <div className="space-y-1.5 -mb-4">
            {packNote && (
              <p role={packNote.bad ? "alert" : "status"} className={`text-[14px] ${packNote.bad ? "font-semibold text-[var(--state-overdue-text)]" : "text-[var(--color-text)]"}`}>
                {packNote.text}
              </p>
            )}
            {partError && !error && <ErrorNote compact title={partError} next="" onRetry={() => void refresh()} />}
          </div>
        )}
        {/* The narrow side only when it has something to hold. */}
        <div className={`grid grid-cols-1 gap-x-8 gap-y-8 items-start ${photos.length > 0 || asset?.id ? "lg:grid-cols-[minmax(0,62fr)_minmax(0,38fr)]" : ""}`}>
          <div className="min-w-0 space-y-8">
            {/* Documents */}
            <section className="min-w-0">
              <div className="flex flex-wrap items-end gap-x-3 gap-y-1 mb-3 min-h-8">
                <h2 className="font-display text-[20px] leading-tight font-semibold text-[var(--color-text)]">Controlled documents</h2>
                <span className="ui-count">{docCount.toLocaleString()}</span>
              </div>
              {!!error ? (
                <ErrorNote error={error} title="Couldn't load the documents." onRetry={() => void refresh()} />
              ) : (
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
              {docs.length === 0 ? (
                <p className="px-4 py-4 text-[15px] text-[var(--color-text-muted)]">No controlled documents are tagged to {tag} yet.</p>
              ) : (
                <table className="w-full text-[14px] tabular-nums">
                  <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left max-sm:hidden">
                    <tr>
                      <th className="font-semibold px-4 h-10">Number</th>
                      <th className="font-semibold px-4 w-16">Rev</th>
                      <th className="font-semibold px-4 w-36">Status</th>
                      <th className="font-semibold px-4 w-32 hidden xl:table-cell">Changed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border)]">
                  {docs.slice(0, docLimit).map((d) => {
                    const held = (holdsByDoc.get(d.id) ?? 0) > 0;
                    const status = held
                      ? <StatusTag tone="bad" colored>On hold</StatusTag>
                      : d.checkedOutByName
                        ? <StatusTag tone="warn" colored>Out to {d.checkedOutByName}</StatusTag>
                        : d.status ? <StatusTag status={d.status} /> : <span className="text-[var(--color-text-faint)]">No status</span>;
                    return (
                      <tr key={d.id} onClick={() => openDoc(d)} className="cursor-pointer hover:bg-[var(--color-surface-2)] max-sm:block">
                        <td className="px-4 py-2.5 relative max-sm:block min-w-0">
                          {held && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />}
                          <span className="flex items-center gap-3">
                            <span className="flex-1 min-w-0">
                              <CopyId value={d.number} label="document number" className="text-[15px] max-w-full" />
                              {d.title && d.title !== d.number && <span className="block truncate text-[13px] text-[var(--color-text-muted)]">{d.title}</span>}
                            </span>
                            {/* Phone: status at right, revision under it. */}
                            <span className="sm:hidden shrink-0">{status}</span>
                          </span>
                          {d.rev && <span className="sm:hidden mt-0.5 block text-[13px] text-[var(--color-text-muted)]">Rev <span className="ui-id">{d.rev}</span></span>}
                          {/* The link for keyboards and screen readers. */}
                          <Link href={d.libraryId ? `/documents/${d.libraryId}?doc=${d.id}` : "/documents"} onClick={(e) => e.stopPropagation()} className="sr-only focus:not-sr-only text-[13px] text-[var(--color-accent-text)]">Open {d.number}</Link>
                        </td>
                        <td className="px-4 py-2.5 font-display text-[15px] font-semibold max-sm:hidden">{d.rev || <span className="text-[var(--color-text-faint)]">-</span>}</td>
                        <td className="px-4 py-2.5 max-sm:hidden">{status}</td>
                        <td className="px-4 py-2.5 hidden xl:table-cell text-[13px] text-[var(--color-text-muted)]">{shortDate(d.updatedAt)}</td>
                      </tr>
                    );
                  })}
                  </tbody>
                </table>
              )}
              {docs.length > docLimit && (
                <div className="px-4 py-3 border-t border-[var(--color-border)] flex items-center justify-between text-[14px]">
                  <span className="text-[var(--color-text-muted)] tabular-nums">{docLimit} of {docs.length.toLocaleString()} shown</span>
                  <button type="button" onClick={() => setDocLimit((n) => n + 50)} className="font-semibold text-[var(--color-accent-text)] hover:underline underline-offset-2">
                    Show {Math.min(50, docs.length - docLimit)} more
                  </button>
                </div>
              )}
              </div>
              )}
            </section>

            {/* Every document that TALKS about this equipment, whether or not
                anyone remembered to tag it. Derived from the indexed text, with
                the sentence attached. */}
            {asset?.id && activeOrgId && (
              <MentionsPanel orgId={activeOrgId} assetId={asset.id} tag={tag} />
            )}

            {/* Everything the estate knows about it, through the one find service:
                drawn on, mentioned in, tagged, filed, and the work in flight. */}
            {asset?.id && activeOrgId && (
              <EstatePanel orgId={activeOrgId} assetId={asset.id} tag={tag} />
            )}
          </div>

          <div className="min-w-0 space-y-8">
            {/* Photos */}
            {photos.length > 0 && (
              <section className="min-w-0">
                <div className="flex items-end gap-2 mb-3 min-h-8">
                  <h2 className="font-display text-[20px] leading-tight font-semibold text-[var(--color-text)]">Photos</h2>
                  <span className="ui-count">{photos.length}</span>
                  <span className="flex-1" />
                  {photos[0]?.captured_at && <span className="text-[13px] text-[var(--color-text-muted)]">Newest {shortDate(photos[0].captured_at)}</span>}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {photos.slice(0, 9).map((p) => (
                    <div key={p.id} className="aspect-square rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border)] flex items-center justify-center text-[13px] text-[var(--color-text-muted)] overflow-hidden" title={p.caption || ""}>
                      <SignedImg path={p.file_url} alt={p.caption || `${tag} photo`} className="w-full h-full object-cover" placeholder={<span className="px-1 text-center truncate">{p.caption || "Photo"}</span>} />
                    </div>
                  ))}
                </div>
                {photos.length > 9 && <p className="mt-2 text-[13px] text-[var(--color-text-muted)]">And {photos.length - 9} more in its photos.</p>}
              </section>
            )}

            {/* Every job done on it, across projects, and what was learned. */}
            {asset?.id && activeOrgId && (
              <WorkHistoryPanel orgId={activeOrgId} assetId={asset.id} code={asset.code ?? null} tag={asset.tag} unitCode={asset.unit_code ?? null} />
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
          </div>
        </div>
        </PageBody>
    </PageShell>
  );
}
