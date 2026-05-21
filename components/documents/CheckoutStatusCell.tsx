"use client";

import React, { useState, useRef, useEffect } from "react";
import { 
  User, 
  Clock, 
  Info, 
  Users, 
  MoreHorizontal, 
  FileText,
  Lock,
  LogOut,
  Shield,
  Loader2
} from "lucide-react";
import { doc, updateDoc, arrayRemove, collection, query, where, onSnapshot, addDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { logCheckoutEvent } from "@/lib/audit";
import type { DocumentRecord, CheckoutSession } from "@/types/schema";

function timeAgo(date: Date) {
  const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);
  let interval = seconds / 31536000;
  if (interval > 1) return Math.floor(interval) + "y";
  interval = seconds / 2592000;
  if (interval > 1) return Math.floor(interval) + "mo";
  interval = seconds / 86400;
  if (interval > 1) return Math.floor(interval) + "d";
  interval = seconds / 3600;
  if (interval > 1) return Math.floor(interval) + "h";
  interval = seconds / 60;
  if (interval > 1) return Math.floor(interval) + "m";
  return "now";
}

// Helper for deterministic colors
function stringToColor(str: string) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const c = (hash & 0x00ffffff).toString(16).toUpperCase();
  return "#" + "00000".substring(0, 6 - c.length) + c;
}

function getInitials(name: string) {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .substring(0, 2)
    .toUpperCase();
}

// Custom Tooltip/Popover Component
const CheckoutInfoPopover = ({ 
  doc: docRecord, 
  onClose,
  userRole,
  currentUserId,
  currentUserEmail
}: { 
  doc: DocumentRecord; 
  onClose: () => void;
  userRole?: string | null;
  currentUserId?: string;
  currentUserEmail?: string;
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [processing, setProcessing] = useState(false);
  const [sessions, setSessions] = useState<CheckoutSession[]>([]);
  const [loading, setLoading] = useState(true);

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  // Fetch Live Sessions for Notes
  useEffect(() => {
    if (!docRecord.id || !docRecord.orgId) return;
    const q = query(
      collection(db, "checkout_sessions"),
      where("orgId", "==", docRecord.orgId),
      where("documentId", "==", docRecord.id),
      where("status", "==", "active")
    );
    const unsub = onSnapshot(q, (snap) => {
      setSessions(snap.docs.map(d => d.data() as CheckoutSession));
      setLoading(false);
    });
    return () => unsub();
  }, [docRecord.id]);

  const handleForceRelease = async () => {
    if (!docRecord.id || processing) return;
    setProcessing(true);
    try {
      // 1. Audit Log
      await logCheckoutEvent({
        orgId: docRecord.orgId || 'unknown',
        fileId: docRecord.id,
        userId: currentUserId || 'unknown',
        userEmail: currentUserEmail || 'unknown',
        userRole: userRole || 'unknown',
        type: "FORCE_RELEASE",
        details: {
          releasedUser: docRecord.checkedOutByName,
          releasedUserId: docRecord.checkedOutBy
        }
      });

      // 2. System Alert Message
      await addDoc(collection(db, "checkout_messages"), {
        orgId: docRecord.orgId,
        documentId: docRecord.id,
        text: `SYSTEM ALERT: Admin ${currentUserEmail} forced release of lock held by ${docRecord.checkedOutByName || 'User'}.`,
        userId: "system",
        userName: "System",
        createdAt: serverTimestamp()
      });

      // 3. Clear Lock
      await updateDoc(doc(db, "documents", docRecord.id), {
        checkedOutBy: null,
        checkedOutByName: null,
        checkedOutAt: null,
        activeCollaborators: docRecord.checkedOutByName 
          ? arrayRemove(docRecord.checkedOutByName) 
          : [] 
      });

      setProcessing(false);
      onClose();
    } catch (e) {
      console.error("Failed to force release:", e);
      setProcessing(false);
    }
  };

  const canAdmin = userRole === 'Admin' || userRole === 'DocCtrl';

  return (
    <div 
      ref={popoverRef}
      className="absolute right-0 top-full mt-2 w-80 bg-white/90 backdrop-blur-xl rounded-2xl shadow-2xl border border-white/20 ring-1 ring-black/5 z-50 animate-in fade-in zoom-in-95 duration-200 overflow-hidden"
      onClick={(e) => e.stopPropagation()} 
    >
      {/* Header */}
      <div className="bg-gradient-to-r from-slate-50 to-white px-4 py-3 border-b border-slate-100 flex justify-between items-center">
        <h4 className="text-xs font-bold text-slate-600 uppercase tracking-wider flex items-center">
          <Clock className="w-3.5 h-3.5 mr-1.5 text-blue-500" /> Active Session
        </h4>
        {loading ? <Loader2 className="w-3 h-3 animate-spin text-slate-400" /> : (
           <span className="text-[10px] font-mono font-bold bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full border border-blue-100">
             {sessions.length} User{sessions.length !== 1 ? 's' : ''}
           </span>
        )}
      </div>

      <div className="p-4 space-y-4 max-h-[300px] overflow-y-auto custom-scrollbar">
        {loading ? (
          <div className="text-center py-4 text-xs text-slate-400">Loading session details...</div>
        ) : sessions.length === 0 ? (
          <div className="text-center py-4 text-xs text-slate-400 italic">No active sessions found (Orphaned Lock?)</div>
        ) : (
          <div className="space-y-3">
            {sessions.map(session => (
              <div key={session.userId} className={`rounded-xl p-3 border ${session.userId === docRecord.checkedOutBy ? 'bg-blue-50/50 border-blue-100' : 'bg-slate-50/50 border-slate-100'}`}>
                <div className="flex items-center gap-3 mb-2">
                  <div 
                    className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shadow-sm shrink-0"
                    style={{ backgroundColor: stringToColor(session.userName || "User") }}
                  >
                    {getInitials(session.userName || "U")}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-center">
                      <p className="text-xs font-bold text-slate-900 truncate">{session.userName}</p>
                      {session.userId === docRecord.checkedOutBy && (
                        <span className="flex items-center text-[9px] font-bold text-blue-600 bg-white px-1.5 py-0.5 rounded-full border border-blue-100 shadow-sm">
                          <Lock className="w-2.5 h-2.5 mr-1" /> PRIMARY
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-slate-400 flex items-center mt-0.5">
                       {session.mode} • {session.startedAt ? timeAgo((session.startedAt as any).toDate()) : ''}
                    </p>
                  </div>
                </div>
                {session.note ? (
                  <div className="ml-9 text-xs text-slate-700 bg-white/60 p-2 rounded-lg border border-black/5 italic">
                    "{session.note}"
                  </div>
                ) : (
                   <div className="ml-9 text-[10px] text-slate-400 italic">No notes</div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ADMIN ACTION */}
        {canAdmin && (
           <div className="pt-3 border-t border-slate-100 space-y-2">
             <div className="text-[10px] text-slate-400 font-mono bg-slate-50 p-2 rounded border border-slate-100 break-all">
               <span className="font-bold">DEBUG:</span><br/>
               Lock: {docRecord.checkedOutBy}<br/>
               You: {currentUserId}
             </div>
             <button
               onClick={handleForceRelease}
               disabled={processing}
               className="w-full py-2 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 rounded-lg text-xs font-bold flex items-center justify-center transition-colors disabled:opacity-50"
             >
               <Shield className="w-3.5 h-3.5 mr-1.5" />
               {processing ? "Releasing..." : "Admin Force Release"}
             </button>
           </div>
        )}
      </div>
    </div>
  );
}

export default function CheckoutStatusCell({ 
  docRecord, 
  currentUserId,
  currentUserEmail,
  userRole,
  onCheckout 
}: { 
  docRecord: DocumentRecord; 
  currentUserId?: string;
  currentUserEmail?: string;
  userRole?: string | null;
  onCheckout: (doc: DocumentRecord) => void;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const isCheckedOut = (docRecord.activeCollaborators && docRecord.activeCollaborators.length > 0) || !!docRecord.checkedOutBy;
  // Robust string comparison to prevent type mismatches
  const isLockedByMe = String(docRecord.checkedOutBy) === String(currentUserId);

  if (!isCheckedOut) {
    return (
      <div className="flex justify-center">
        <button
          onClick={(e) => { e.stopPropagation(); onCheckout(docRecord); }}
          className="group flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-slate-200 hover:border-slate-300 hover:shadow-sm transition-all text-xs font-medium text-slate-500 hover:text-slate-800"
        >
          <Clock className="w-3 h-3 text-slate-400 group-hover:text-blue-500 transition-colors" />
          <span>Check Out</span>
        </button>
      </div>
    );
  }

  // High Tech Active State
  return (
    <div className="flex justify-center items-center gap-2 relative group" ref={containerRef}>
      
      <div 
        onClick={(e) => { e.stopPropagation(); onCheckout(docRecord); }}
        className={`
          relative flex items-center pl-1 pr-3 py-1 rounded-full border shadow-sm cursor-pointer transition-all hover:shadow-md hover:scale-[1.02] active:scale-[0.98]
          ${isLockedByMe 
            ? 'bg-green-50/80 border-green-200 ring-1 ring-green-100' 
            : 'bg-orange-50/80 border-orange-200 ring-1 ring-orange-100'
          }
        `}
      >
        {/* Pulsing Dot */}
        <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${isLockedByMe ? 'bg-green-400' : 'bg-orange-400'}`}></span>
          <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${isLockedByMe ? 'bg-green-500' : 'bg-orange-500'}`}></span>
        </span>

        {/* Avatars */}
        <div className="flex -space-x-1.5 mr-2">
          {docRecord.activeCollaborators?.slice(0, 3).map((name, i) => (
            <div 
              key={`${name}-${i}`} 
              className="w-6 h-6 rounded-full border border-white flex items-center justify-center text-[9px] font-bold text-white shadow-sm"
              style={{ 
                backgroundColor: stringToColor(name),
                zIndex: 10 - i 
              }}
            >
              {getInitials(name)}
            </div>
          ))}
        </div>

        {/* Text Action */}
        <span className={`text-[10px] font-bold uppercase tracking-wide ${isLockedByMe ? 'text-green-700' : 'text-orange-700'}`}>
          {isLockedByMe ? 'Checked Out by You' : 'Checked Out'}
        </span>
      </div>

      {/* Info Button (Hover Trigger) */}
      <button
        onClick={(e) => { e.stopPropagation(); setShowInfo(!showInfo); }}
        className={`
          w-7 h-7 flex items-center justify-center rounded-full transition-all border
          ${showInfo 
            ? 'bg-slate-800 text-white border-slate-700' 
            : 'bg-white text-slate-400 border-slate-200 hover:border-slate-300 hover:text-slate-600 opacity-0 group-hover:opacity-100'
          }
        `}
      >
        <Info className="w-3.5 h-3.5" />
      </button>

      {/* Popover */}
      {showInfo && 
        <CheckoutInfoPopover 
          doc={docRecord} 
          onClose={() => setShowInfo(false)} 
          userRole={userRole} 
          currentUserId={currentUserId}
          currentUserEmail={currentUserEmail}
        />
      }

    </div>
  );
}