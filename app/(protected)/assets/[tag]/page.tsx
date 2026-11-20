"use client";

// /assets/[tag] — the asset-as-hub "digital twin". One page per equipment tag
// (e.g. FE-201) that pulls together EVERYTHING controlled about that asset:
// its registry entry (type/location/description), every controlled document
// tagged to it, open holds on those docs, and its photos. Scan a QR on the
// equipment → land here. A view no shared-drive competitor can offer.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { MapPin, AlertOctagon, RefreshCw, Printer, Loader2, QrCode } from "lucide-react";
import MoreMenu from "@/components/ui/MoreMenu";
import LoadingBlock from "@/components/ui/LoadingBlock";
import SignedImg from "@/components/assets/SignedImg";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import { getAssetByTag, listAssetPhotos, type Asset, type AssetPhoto } from "@/lib/assets";
import AliasPanel from "@/components/assets/AliasPanel";
import MentionsPanel from "@/components/assets/MentionsPanel";
import EstatePanel from "@/components/assets/EstatePanel";
import WorkHistoryPanel from "@/components/assets/WorkHistoryPanel";
import { StatusTag } from "@/components/documents/StatusTag";

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
    return (
      <PageShell width="work">
        <PageHero kicker="Equipment" title={<span className="font-display tabular-nums">{tag}</span>} size="md" overlap={false}
          back={{ href: "/admin/assets", label: "Back to operating areas" }} />
        <LoadingBlock what={tag || "the equipment"} />
      </PageShell>
    );
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

  // The answer: what state this equipment's paperwork is in.
  // The equipment tag is the answer engineers read; the numbers sit beside it.
  const answer = <span className="tabular-nums">{tag}</span>;
  const outCount = docs.filter((d) => !!d.checkedOutByName).length;
  const answerFacts = error && docs.length === 0 ? undefined : [
    { label: "Documents", value: docCount.toLocaleString() },
    { label: "On hold", value: heldCount.toLocaleString(), tone: heldCount > 0 ? "bad" as const : undefined },
    { label: "Checked out", value: outCount.toLocaleString(), tone: outCount > 0 ? "warn" as const : undefined },
    ...(photos.length > 0 ? [{ label: "Photos", value: photos.length.toLocaleString() }] : []),
  ];
  const backHref = asset?.unit_code ? `/admin/assets?unit=${encodeURIComponent(asset.unit_code)}` : "/admin/assets";

  return (
    <PageShell width="work">
        <PageHero
          kicker={<>Operating areas{asset?.unit_code ? ` · Unit ${asset.unit_code}` : ""} · {tag}</>}
          back={{ href: backHref, label: "Back to operating areas" }}
          title={answer}
          facts={answerFacts}
          sub={
            <>
              {error && docs.length === 0 ? "Its documents didn't load." : asset?.description || (asset ? "Registered equipment" : "Not in the equipment list. Showing documents tagged with it.")}
              {asset?.location && <span className="ml-3 whitespace-nowrap"><MapPin className="inline w-3.5 h-3.5 -mt-0.5" /> {asset.location}</span>}
            </>
          }
          tools={
            <>
              {/* One click from equipment tag to a single stamped PDF of every
                  current drawing, each sheet carrying its own verify-QR. */}
              {docs.length > 0 && uid && activeOrgId && (
                <button type="button" className={heroQuiet} disabled={packing} onClick={() => void printPack()}>
                  {packing
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {packProgress ? `Packing ${packProgress[0]}/${packProgress[1]}…` : "Packing…"}</>
                    : <><Printer className="w-3.5 h-3.5" /> <span className="max-sm:hidden">Print doc pack</span><span className="sm:hidden">Pack</span></>}
                </button>
              )}
              <MoreMenu iconOnly triggerClass={heroQuiet} items={[
                // The QR sticker turns this equipment into an app entry point:
                // scan at the pump, land on this page.
                { icon: <QrCode className="w-4 h-4" />, label: "Print QR label", onClick: () => void printLabel() },
                { icon: <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />, label: loading ? "Refreshing…" : "Refresh", onClick: () => void refresh() },
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
        {/* Documents */}
        <section className="min-w-0">
          <div className="flex items-baseline gap-2 mb-2.5">
            <h2 className="font-display text-[19px] leading-tight font-semibold text-[var(--color-text)]">Controlled documents</h2>
            <span className="text-[14px] text-[var(--color-text-muted)] tabular-nums">{docCount.toLocaleString()}</span>
          </div>
          {(packNote || error || (partError && !error)) && (
            <div className="mb-3 space-y-1.5">
              {packNote && (
                <p role="status" className={`text-[14px] ${packNote.startsWith("Pack failed") || packNote.startsWith("Label failed") ? "font-semibold text-[var(--state-overdue)]" : "text-[var(--color-text)]"}`}>
                  {packNote}
                </p>
              )}
              {error && (
                <p role="alert" className="text-[14px] font-semibold text-[var(--state-overdue)]">
                  Couldn&apos;t load the documents: {error}{" "}
                  <button type="button" onClick={() => void refresh()} className="font-normal text-[var(--color-accent-text)] hover:underline">Try again</button>
                </p>
              )}
              {partError && !error && (
                <p role="alert" className="text-[14px] text-[var(--color-text)]">
                  {partError}{" "}
                  <button type="button" onClick={() => void refresh()} className="text-[var(--color-accent-text)] hover:underline">Try again</button>
                </p>
              )}
            </div>
          )}
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
          {docs.length === 0 ? (
            <p className="px-4 py-4 text-[15px] text-[var(--color-text-muted)]">No controlled documents are tagged to {tag} yet.</p>
          ) : (
            <table className="w-full text-[14px]">
              <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left max-sm:hidden">
                <tr>
                  <th className="font-semibold px-4 h-10">Number</th>
                  <th className="font-semibold px-4 hidden md:table-cell">Title</th>
                  <th className="font-semibold px-4 w-20">Rev</th>
                  <th className="font-semibold px-4 w-36">Status</th>
                  <th className="font-semibold px-4 w-40 hidden lg:table-cell">Checked out by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
              {docs.slice(0, docLimit).map((d) => {
                const held = (holdsByDoc.get(d.id) ?? 0) > 0;
                const href = d.libraryId ? `/documents/${d.libraryId}?doc=${d.id}` : "/documents";
                return (
                  <tr key={d.id} className="hover:bg-[var(--color-surface-2)] max-sm:block">
                    <td className="px-4 py-2.5 relative max-sm:block">
                      {held && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />}
                      <span className="flex items-center gap-3">
                        <Link href={href} className="flex-1 min-w-0 truncate font-display text-[16px] font-semibold tabular-nums text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{d.number}</Link>
                        {/* Phone: status at right, the rest under it. */}
                        <span className="sm:hidden shrink-0">{held ? <StatusTag tone="bad" colored>On hold</StatusTag> : d.status ? <StatusTag status={d.status} /> : null}</span>
                      </span>
                      <span className="sm:hidden mt-0.5 flex gap-x-3 text-[13px] text-[var(--color-text-muted)] min-w-0">
                        {d.title && d.title !== d.number && <span className="truncate min-w-0">{d.title}</span>}
                        {d.rev && <span className="shrink-0">Rev <span className="font-display tabular-nums font-semibold text-[var(--color-text)]">{d.rev}</span></span>}
                        {d.checkedOutByName && <span className="shrink-0 font-semibold text-[var(--state-held)]">Out: {d.checkedOutByName}</span>}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-[var(--color-text-muted)] hidden md:table-cell max-w-0 truncate">{d.title && d.title !== d.number ? d.title : ""}</td>
                    <td className="px-4 py-2.5 font-display text-[15px] font-semibold tabular-nums max-sm:hidden">{d.rev || "-"}</td>
                    <td className="px-4 py-2.5 max-sm:hidden">
                      {held ? <StatusTag tone="bad" colored>On hold</StatusTag> : d.status ? <StatusTag status={d.status} /> : <span className="text-[var(--color-text-muted)]">-</span>}
                    </td>
                    <td className="px-4 py-2.5 hidden lg:table-cell">
                      {d.checkedOutByName ? <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[13px] font-semibold whitespace-nowrap leading-[18px] bg-[color-mix(in_srgb,var(--state-held)_16%,transparent)] text-[var(--state-held)]">{d.checkedOutByName}</span> : ""}
                    </td>
                  </tr>
                );
              })}
              </tbody>
            </table>
          )}
          {docs.length > docLimit && (
            <div className="px-4 py-3 border-t border-[var(--color-border)] flex items-center justify-between text-[14px]">
              <span className="text-[var(--color-text-muted)] tabular-nums">{docLimit} of {docs.length.toLocaleString()} shown</span>
              <button type="button" onClick={() => setDocLimit((n) => n + 50)} className={heroQuiet}>
                Show {Math.min(50, docs.length - docLimit)} more
              </button>
            </div>
          )}
          </div>
        </section>

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
          <Card label={<>Photos <span className="font-sans text-[14px] font-normal text-[var(--color-text-muted)] tabular-nums">{photos.length}</span></>}>
            <div className="flex flex-wrap gap-2">
              {photos.slice(0, 12).map((p) => (
                <div key={p.id} className="w-24 h-24 rounded-md bg-[var(--color-surface-2)] flex items-center justify-center text-[13px] text-[var(--color-text-muted)] overflow-hidden" title={p.caption || ""}>
                  <SignedImg path={p.file_url} alt={p.caption || `${tag} photo`} className="w-full h-full object-cover" placeholder={<span className="px-1 text-center truncate">{p.caption || "Photo"}</span>} />
                </div>
              ))}
            </div>
          </Card>
        )}
        </PageBody>
    </PageShell>
  );
}

