"use client";

import React, { useEffect, useState } from "react";
import { X, Search, Pencil, History, ArrowRight, Lock, Trash2, Maximize2, Activity, Shield } from "lucide-react";
import SecureDocViewer from "@/components/viewers/SecureDocViewer";
import CheckoutStatusCell from "@/components/documents/CheckoutStatusCell";
import { supabase } from "@/lib/supabase";
import type { DocumentRecord, DocumentVersion } from "@/types/schema";
import { AuditEntry } from "@/lib/audit";

interface InspectorPanelProps {
  selectedDoc: DocumentRecord | null;
  selectedVersion: DocumentVersion | null;
  activeRole: string;
  uid: string | null;
  userEmail: string | null;
  onClose: () => void;
  onMetadata: () => void;
  onHistory: () => void;
  onMove: () => void;
  onPermissions: () => void;
  onDelete: () => void;
  onCheckout: (doc: DocumentRecord) => void;
  onForceUnlock?: (doc: DocumentRecord) => void;
  onFullScreen: () => void;
}

export default function InspectorPanel({
  selectedDoc,
  selectedVersion,
  activeRole,
  uid,
  userEmail,
  onClose,
  onMetadata,
  onHistory,
  onMove,
  onPermissions,
  onDelete,
  onCheckout,
  onForceUnlock,
  onFullScreen
}: InspectorPanelProps) {
  const [recentAudits, setRecentAudits] = useState<AuditEntry[]>([]);
  const isController = activeRole === 'Admin' || activeRole === 'DocCtrl';
  // Show Force Release if EITHER primary lock is held OR there are active collaborators (zombie state)
  const isCheckedOut = !!selectedDoc?.checkedOutBy || (selectedDoc?.activeCollaborators?.length || 0) > 0;

  useEffect(() => {
    if (!selectedDoc?.id || !selectedDoc.orgId) {
      setRecentAudits([]);
      return;
    }

    supabase
      .from("audit_logs")
      .select("*")
      .eq("org_id", selectedDoc.orgId)
      .eq("resource_id", selectedDoc.id)
      .order("timestamp", { ascending: false })
      .limit(3)
      .then(({ data }) => {
        if (data) {
          setRecentAudits(data.map((r) => ({
            action: r.action,
            resourceId: r.resource_id,
            resourceType: r.resource_type,
            orgId: r.org_id,
            userId: r.user_id,
            userEmail: r.user_email,
            userRole: r.user_role,
            details: r.details,
            timestamp: r.timestamp,
          } as AuditEntry)));
        }
      });
  }, [selectedDoc?.id, selectedDoc?.orgId]);

  if (!selectedDoc) {
    return (
      <div className="text-center py-12 text-slate-400 bg-slate-50 rounded-xl border border-slate-100 border-dashed">
        <Search className="w-8 h-8 mx-auto mb-2 opacity-50" />
        <p className="text-xs">Select a document to view details.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
        {/* Header */}
        <div className="rounded-xl border border-slate-200 p-4 bg-slate-50/50">
            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Active Selection</div>
            <div className="text-sm font-bold text-slate-900 break-words">{selectedDoc.documentNumber || selectedDoc.title}</div>
            <div className="text-xs text-slate-500 mt-1">Rev {selectedDoc.rev || "-"} • {selectedDoc.status || "-"}</div>
            
            {/* DEBUG FOR ADMIN */}
            {activeRole === 'Admin' && (
              <div className="mt-2 text-[10px] font-mono text-slate-400 border-t border-slate-200 pt-1">
                UID: {uid}<br/>
                Locker: {selectedDoc.checkedOutBy || 'None'}
              </div>
            )}
        </div>

        {/* Preview */}
        {selectedVersion?.fileUrl && (
            <div className="relative group rounded-xl border border-slate-200 overflow-hidden h-48 bg-slate-100">
                <SecureDocViewer
                url={selectedVersion.fileUrl}
                title={selectedDoc.title || selectedDoc.name || "Document"}
                docNumber={selectedDoc.documentNumber || selectedDoc.id || ""}
                rev={selectedDoc.rev || "-"}
                zoomLevel={50}
                watermarkText="PREVIEW"
                />
                <button 
                onClick={onFullScreen}
                className="absolute top-2 right-2 p-2 bg-black/60 hover:bg-black/80 text-white rounded-lg opacity-0 group-hover:opacity-100 transition-all backdrop-blur-sm shadow-sm"
                title="Full Screen View"
                >
                <Maximize2 className="w-4 h-4" />
                </button>
            </div>
        )}

        {/* Actions */}
        <div className="grid grid-cols-2 gap-2">
            <button onClick={onMetadata} className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-xs font-bold text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-all shadow-sm">
            <Pencil className="w-3.5 h-3.5" /> Metadata
            </button>
            <button onClick={onHistory} className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-xs font-bold text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-all shadow-sm">
            <History className="w-3.5 h-3.5" /> History
            </button>
            {isController && (
            <>
                <button onClick={onMove} className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-xs font-bold text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-all shadow-sm">
                <ArrowRight className="w-3.5 h-3.5" /> Move
                </button>
                <button onClick={onPermissions} className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-xs font-bold text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-all shadow-sm">
                <Lock className="w-3.5 h-3.5" /> Permissions
                </button>
                <button onClick={onDelete} className="col-span-2 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-red-200 bg-red-50 text-xs font-bold text-red-700 hover:bg-red-100 transition-all">
                <Trash2 className="w-3.5 h-3.5" /> Delete Document
                </button>
            </>
            )}
        </div>
        
        {/* Checkout Status */}
        <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Checkout Status</div>
            <CheckoutStatusCell 
            docRecord={selectedDoc} 
            currentUserId={uid ?? undefined}
            currentUserEmail={userEmail ?? undefined}
            userRole={activeRole}
            onCheckout={onCheckout}
            />
            
            {/* ADMIN FORCE RELEASE */}
            {isController && isCheckedOut && onForceUnlock && (
               <button 
                 onClick={() => onForceUnlock(selectedDoc)}
                 className="w-full mt-3 py-2 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 rounded-lg text-xs font-bold flex items-center justify-center transition-colors"
               >
                 <Shield className="w-3.5 h-3.5 mr-1.5" />
                 Force Release Lock
               </button>
            )}
        </div>

        {/* Audit Log Preview */}
        <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center">
              <Activity className="w-3 h-3 mr-1.5" /> Recent Activity
            </div>
            {recentAudits.length === 0 ? (
                <div className="text-xs text-slate-400 italic">No recent activity.</div>
            ) : (
                <div className="space-y-3">
                    {recentAudits.map((log, i) => (
                        <div key={i} className="flex flex-col gap-1 border-l-2 border-slate-100 pl-3">
                            <span className="text-[10px] font-bold text-slate-700 uppercase">{log.action.replace('_', ' ')}</span>
                            <span className="text-[10px] text-slate-500">by {log.userEmail?.split('@')[0]}</span>
                            <span className="text-[9px] text-slate-400 font-mono">
                                {log.timestamp ? new Date(log.timestamp as string).toLocaleString() : '-'}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    </div>
  );
}
