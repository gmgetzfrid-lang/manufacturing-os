"use client";

// /assets/[tag] — the asset-as-hub "digital twin". One page per equipment tag
// (e.g. FE-201) that pulls together EVERYTHING controlled about that asset:
// its registry entry (type/location/description), every controlled document
// tagged to it, open holds on those docs, and its photos. Scan a QR on the
// equipment → land here. A view no shared-drive competitor can offer.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Loader2, Tag as TagIcon, MapPin, FileText, AlertOctagon, Lock, RefreshCw, ImageIcon } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { getAssetByTag, listAssetPhotos, type Asset, type AssetPhoto } from "@/lib/assets";
import { stateStyle, documentState } from "@/lib/stateColors";

interface HubDoc {
  id: string; number: string; title: string; rev: string | null;
  status: string | null; libraryId: string | null; checkedOutByName: string | null;
}

export default function AssetHubPage() {
  const params = useParams();
  const tag = decodeURIComponent(String(params?.tag ?? ""));
  const { activeOrgId } = useRole();

  const [asset, setAsset] = useState<Asset | null>(null);
  const [docs, setDocs] = useState<HubDoc[]>([]);
  const [holdsByDoc, setHoldsByDoc] = useState<Map<string, number>>(new Map());
  const [photos, setPhotos] = useState<AssetPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId || !tag) return;
    setLoading(true); setError(null);
    try {
      const a = await getAssetByTag(activeOrgId, tag).catch(() => null);
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
        number: String((r as Record<string, unknown>).document_number || (r as Record<string, unknown>).title || (r as Record<string, unknown>).name || "—"),
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
        const { data: holdRows } = await supabase
          .from("document_holds").select("document_id").in("document_id", ids).is("released_at", null);
        for (const h of (holdRows ?? []) as Array<{ document_id: string }>) {
          hold.set(h.document_id, (hold.get(h.document_id) ?? 0) + 1);
        }
      }
      setHoldsByDoc(hold);

      if (a?.id) setPhotos(await listAssetPhotos(a.id).catch(() => []));
      else setPhotos([]);
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
    return <div className="min-h-screen bg-slate-50 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-16">
      <div className="max-w-5xl mx-auto p-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-purple-100 text-purple-700"><TagIcon className="w-6 h-6" /></span>
              <div>
                <h1 className="text-2xl font-black text-slate-900 font-mono">{tag}</h1>
                <div className="text-sm text-slate-500">{asset?.description || (asset ? "Registered asset" : "Unregistered tag — showing tagged documents")}</div>
              </div>
            </div>
            {asset?.location && <div className="mt-2 text-xs text-slate-600 inline-flex items-center gap-1"><MapPin className="w-3.5 h-3.5 text-slate-400" /> {asset.location}</div>}
          </div>
          <button onClick={() => void refresh()} disabled={loading} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-slate-200 shadow-sm hover:bg-slate-50 text-xs font-bold text-slate-700">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>

        {error && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">{error}</div>}

        {/* Stat strip */}
        <div className="grid grid-cols-3 gap-3 mb-5">
          <Stat icon={FileText} tone="blue" label="Controlled documents" value={docCount} />
          <Stat icon={AlertOctagon} tone="rose" label="On hold" value={heldCount} />
          <Stat icon={ImageIcon} tone="violet" label="Photos" value={photos.length} />
        </div>

        {/* Documents */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden mb-5">
          <div className="px-4 py-3 border-b border-slate-100 text-sm font-black text-slate-900 inline-flex items-center gap-2"><FileText className="w-4 h-4 text-blue-500" /> Controlled documents</div>
          {docs.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-400 italic">No controlled documents are tagged to {tag} yet.</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {docs.map((d) => (
                <li key={d.id}>
                  <Link href={d.libraryId ? `/documents/${d.libraryId}?doc=${d.id}` : "/documents"} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50">
                    <span className="font-mono text-xs font-bold text-slate-900 truncate flex-1">{d.number}{d.title && d.title !== d.number ? <span className="font-sans font-normal text-slate-500"> — {d.title}</span> : ""}</span>
                    {d.rev && <span className="text-[10px] font-bold bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded shrink-0">Rev {d.rev}</span>}
                    {d.status && <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border shrink-0 ${stateStyle(documentState(d.status)).pill}`}>{d.status}</span>}
                    {(holdsByDoc.get(d.id) ?? 0) > 0 && <span className="text-[10px] font-bold text-rose-700 inline-flex items-center gap-0.5 shrink-0"><AlertOctagon className="w-3 h-3" /> hold</span>}
                    {d.checkedOutByName && <span className="text-[10px] font-bold text-blue-700 inline-flex items-center gap-0.5 shrink-0"><Lock className="w-3 h-3" />{d.checkedOutByName}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Photos */}
        {photos.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
            <div className="text-sm font-black text-slate-900 inline-flex items-center gap-2 mb-3"><ImageIcon className="w-4 h-4 text-violet-500" /> Photos</div>
            <div className="flex flex-wrap gap-2">
              {photos.slice(0, 12).map((p) => (
                <div key={p.id} className="w-24 h-24 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center text-[10px] text-slate-400 overflow-hidden" title={p.caption || ""}>
                  {p.caption || "photo"}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value, tone }: { icon: React.ComponentType<{ className?: string }>; label: string; value: number; tone: "blue" | "rose" | "violet" }) {
  const tones = { blue: "text-blue-700 bg-blue-50 border-blue-200", rose: "text-rose-700 bg-rose-50 border-rose-200", violet: "text-violet-700 bg-violet-50 border-violet-200" };
  return (
    <div className={`rounded-2xl border p-3 ${tones[tone]}`}>
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide opacity-80"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <div className="text-2xl font-black mt-1">{value}</div>
    </div>
  );
}
