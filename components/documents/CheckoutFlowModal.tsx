"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  arrayUnion,
  arrayRemove
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { logCheckoutEvent } from "@/lib/audit";
import { 
  X, 
  Clock, 
  User, 
  MessageSquare, 
  AlertTriangle, 
  CheckCircle2, 
  FileText, 
  ArrowRight,
  Send,
  Loader2,
  Shield,
  RefreshCw
} from "lucide-react";
import type { CheckoutSession, DocumentRecord, CheckoutMode } from "@/types/schema";
import { useRouter } from "next/navigation";

interface CheckoutFlowModalProps {
  isOpen: boolean;
  onClose: () => void;
  document: DocumentRecord;
  currentUser: { uid: string; email: string | null; role: string | null };
}

interface ChatMessage {
  id: string;
  text: string;
  userId: string;
  userName: string;
  createdAt: any;
}

export default function CheckoutFlowModal({ isOpen, onClose, document, currentUser }: CheckoutFlowModalProps) {
  const router = useRouter();
  const [activeSessions, setActiveSessions] = useState<CheckoutSession[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<CheckoutMode>("view");
  const [note, setNote] = useState("");
  const [newMessage, setNewMessage] = useState("");
  
  // Check-in State
  const [checkInReason, setCheckInReason] = useState<'abandon' | 'revise' | null>(null);
  const [revisionNote, setRevisionNote] = useState("");
  const [processing, setProcessing] = useState(false);

  const mySession = activeSessions.find(s => s.userId === currentUser.uid);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Helper to force unlock (Admin or Orphaned Self)
  const handleForceUnlock = async () => {
    if (!document.id || !currentUser.uid) return;
    setProcessing(true);
    try {
      // 2. Force clear the lock
      await updateDoc(doc(db, "documents", document.id), {
        checkedOutBy: null,
        checkedOutByName: null,
        checkedOutAt: null,
        currentLockId: null, // Clear Lock ID
        activeCollaborators: document.checkedOutByName 
          ? arrayRemove(document.checkedOutByName) 
          : arrayRemove(currentUser.email?.split('@')[0] || "User")
      });

      // 3. Alert
      await addDoc(collection(db, "checkout_messages"), {
        orgId: document.orgId,
        documentId: document.id,
        text: `SYSTEM ALERT: Lock force released by ${currentUser.email}.`,
        userId: "system",
        userName: "System",
        createdAt: serverTimestamp(),
        lockId: document.currentLockId // Log to old session so they see it
      });

      setProcessing(false);
      onClose();
    } catch (e) {
      console.error(e);
      setProcessing(false);
    }
  };

  // 1. Listen to Active Sessions
  useEffect(() => {
    if (!isOpen || !document.id || !document.orgId) return;
    
    // If we have a lockId, filter by it. If not, we might be starting fresh (empty list)
    // But we still want to see if there ARE active sessions in DB that match docId 
    // (in case of orphan state where doc has no lockId but sessions exist? unlikely with new logic)
    // Let's stick to documentId for sessions to ensure we catch everything relevant.
    // Actually, sessions should probably be cleared on force release.
    
    const q = query(
      collection(db, "checkout_sessions"),
      where("orgId", "==", document.orgId),
      where("documentId", "==", document.id),
      where("status", "==", "active"),
      orderBy("startedAt", "desc")
    );

    const unsub = onSnapshot(q, (snap) => {
      setActiveSessions(snap.docs.map(d => ({ id: d.id, ...d.data() } as CheckoutSession)));
      setLoading(false);
    }, (err) => {
      console.error("Session listener error:", err);
      setLoading(false);
    });

    return () => unsub();
  }, [isOpen, document.id, document.orgId]);

  // 2. Listen to Chat Messages (ISOLATED BY LOCK ID)
  useEffect(() => {
    if (!isOpen || !document.id || !document.orgId) return;

    if (!document.currentLockId) {
      setMessages([]);
      return;
    }

    const q = query(
      collection(db, "checkout_messages"),
      where("orgId", "==", document.orgId),
      where("documentId", "==", document.id),
      where("lockId", "==", document.currentLockId), // ISOLATION KEY
      orderBy("createdAt", "asc")
    );

    const unsub = onSnapshot(q, (snap) => {
      setMessages(snap.docs.map(d => ({ id: d.id, ...d.data() } as ChatMessage)));
      if (scrollRef.current) {
        setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }), 100);
      }
    });

    return () => unsub();
  }, [isOpen, document.id, document.orgId, document.currentLockId]);

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !currentUser.uid) return;
    if (!document.currentLockId) return; // Can't chat without a lock session

    try {
      await addDoc(collection(db, "checkout_messages"), {
        orgId: document.orgId,
        documentId: document.id,
        lockId: document.currentLockId,
        text: newMessage.trim(),
        userId: currentUser.uid,
        userName: currentUser.email?.split('@')[0] || "User",
        createdAt: serverTimestamp()
      });
      setNewMessage("");
    } catch (e) {
      console.error("Failed to send message", e);
    }
  };

  const handleCheckout = async () => {
    if (!currentUser.uid) return;
    setProcessing(true);
    try {
      const userName = currentUser.email?.split('@')[0] || "User";
      
      // Determine Lock ID (Existing or New)
      const lockId = document.currentLockId || crypto.randomUUID();

      await addDoc(collection(db, "checkout_sessions"), {
        orgId: document.orgId,
        documentId: document.id,
        libraryId: document.libraryId,
        userId: currentUser.uid,
        userName: userName,
        mode,
        note: note || null,
        status: "active",
        startedAt: serverTimestamp(),
        lastSeenAt: serverTimestamp(),
        lockId: lockId
      });

      const updateData: any = {
        activeCollaborators: arrayUnion(userName)
      };

      if (!document.checkedOutBy || String(document.checkedOutBy) === String(currentUser.uid)) {
        updateData.checkedOutBy = currentUser.uid;
        updateData.checkedOutByName = userName;
        updateData.checkedOutAt = serverTimestamp();
        updateData.checkoutNote = note || null;
        updateData.currentLockId = lockId; // Set Lock ID
      }

      await updateDoc(doc(db, "documents", document.id!), updateData);

      setProcessing(false);
      onClose();
    } catch (e: any) {
      console.error(e);
      alert(`Checkout failed: ${e.message}`);
      setProcessing(false);
    }
  };

  const handleCheckIn = async () => {
    if (!mySession || !checkInReason || !currentUser.uid) return;
    setProcessing(true);

    try {
      const userName = currentUser.email?.split('@')[0] || "User";

      await updateDoc(doc(db, "checkout_sessions", mySession.id!), {
        status: checkInReason === 'abandon' ? 'abandoned' : 'checked_in',
        endedAt: serverTimestamp(),
      });

      // 2. Clear Doc Lock ONLY if I was the one holding it
      if (String(document.checkedOutBy) === String(currentUser.uid)) {
         await updateDoc(doc(db, "documents", document.id!), {
           checkedOutBy: null,
           checkedOutByName: null,
           checkedOutAt: null,
           currentLockId: null, // Clear Lock ID
           checkoutNote: null
         });
      }

      await updateDoc(doc(db, "documents", document.id!), {
        activeCollaborators: arrayRemove(userName)
      });

      if (checkInReason === 'revise') {
        const ticketRef = await addDoc(collection(db, "tickets"), {
          orgId: document.orgId,
          title: `Revision Request: ${document.title}`,
          description: `Generated from Check-in. User Note: ${revisionNote}`,
          requestType: 'Revision',
          status: 'NEW', // Or PENDING_ENG_INITIAL
          priority: 2,
          requesterId: currentUser.uid,
          requesterName: currentUser.email?.split('@')[0] || "User",
          requesterEmail: currentUser.email,
          requesterRole: currentUser.role,
          createdAt: serverTimestamp(),
          history: [{
            action: 'Created via Check-in',
            user: currentUser.email,
            date: new Date().toISOString(),
            details: `Source Document: ${document.documentNumber}`
          }],
        });
        
        await addDoc(collection(db, "checkout_messages"), {
          orgId: document.orgId,
          documentId: document.id,
          lockId: document.currentLockId,
          text: `Checked in (Revision Requested). Ticket #${ticketRef.id} created.`,
          userId: "system",
          userName: "System",
          createdAt: serverTimestamp()
        });

        router.push(`/requests/${ticketRef.id}`);
      } else {
        await addDoc(collection(db, "checkout_messages"), {
          orgId: document.orgId,
          documentId: document.id,
          lockId: document.currentLockId,
          text: `Checked in (Abandoned).`,
          userId: "system",
          userName: "System",
          createdAt: serverTimestamp()
        });
        onClose();
      }
      
      setProcessing(false);
    } catch (e: any) {
      console.error(e);
      alert(`Check-in failed: ${e.message}`);
      setProcessing(false);
    }
  };

  if (!isOpen) return null;

  // Orphaned State: 
  // 1. I hold the lock (checkedOutBy == me) but have no active session doc (mySession is missing).
  // 2. I am in activeCollaborators list, but checkedOutBy is null (Zombie State).
  // 3. I am in activeCollaborators list, but have no session doc (Stale Collaborator).
  const isLockHolderWithoutSession = String(document.checkedOutBy) === String(currentUser.uid) && !mySession;
  const isZombieCollaborator = !document.checkedOutBy && document.activeCollaborators?.includes(currentUser.email?.split('@')[0] || "User");
  const isStaleCollaborator = document.activeCollaborators?.includes(currentUser.email?.split('@')[0] || "User") && !mySession;
  
  const isOrphaned = isLockHolderWithoutSession || isZombieCollaborator || isStaleCollaborator;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in">
      <div className="bg-white w-full max-w-4xl h-[80vh] rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col md:flex-row">
        
        {/* LEFT: SESSION & ACTIONS */}
        <div className="flex-1 flex flex-col border-r border-slate-200 bg-slate-50">
          <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-white">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Document Checkout</h2>
              <p className="text-xs text-slate-500 truncate max-w-[200px]">{document.title}</p>
            </div>
            <button onClick={onClose} className="md:hidden p-2 rounded-lg hover:bg-slate-100"><X className="w-5 h-5" /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            
            {/* Active Sessions List */}
            <div>
              <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Active Collaborators</h3>
              {activeSessions.length === 0 ? (
                <div className="p-4 rounded-xl border border-dashed border-slate-300 text-center text-slate-400 text-sm">
                  {isOrphaned ? "Session tracking inconsistent. Please restore session below." : "No one is currently working on this file."}
                </div>
              ) : (
                <div className="space-y-2">
                  {activeSessions.map(s => (
                    <div key={s.id} className={`p-3 rounded-xl border flex items-start gap-3 ${s.userId === currentUser.uid ? 'bg-blue-50 border-blue-200 ring-1 ring-blue-100' : 'bg-white border-slate-200'}`}>
                      <div className={`p-2 rounded-full ${s.userId === currentUser.uid ? 'bg-blue-200 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                        <User className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex justify-between items-start">
                          <p className="text-sm font-bold text-slate-900">{s.userName}</p>
                          <span className="text-[10px] bg-white border border-slate-200 px-2 py-0.5 rounded-full text-slate-500 uppercase">{s.mode}</span>
                        </div>
                        {s.note && <p className="text-xs text-slate-600 mt-1 italic">"{s.note}"</p>}
                        <p className="text-[10px] text-slate-400 mt-2 flex items-center">
                          <Clock className="w-3 h-3 mr-1" /> Checked out just now
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ACTION AREA */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              {mySession ? (
                // CHECK IN FLOW (Existing Session)
                <div className="space-y-4">
                  <h3 className="text-sm font-bold text-slate-900 flex items-center"><CheckCircle2 className="w-4 h-4 mr-2 text-green-600" /> You are checked out</h3>
                  
                  <div className="grid grid-cols-2 gap-3">
                    <button 
                      onClick={() => setCheckInReason('abandon')}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${checkInReason === 'abandon' ? 'border-amber-500 bg-amber-50 ring-1 ring-amber-500' : 'border-slate-100 hover:border-amber-300'}`}
                    >
                      <div className="font-bold text-sm text-slate-900 mb-1">Abandon / Cancel</div>
                      <p className="text-[10px] text-slate-500 leading-tight">Release lock without changes.</p>
                    </button>
                    <button 
                      onClick={() => setCheckInReason('revise')}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${checkInReason === 'revise' ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-slate-100 hover:border-blue-300'}`}
                    >
                      <div className="font-bold text-sm text-slate-900 mb-1">Submit Changes</div>
                      <p className="text-[10px] text-slate-500 leading-tight">Create revision request.</p>
                    </button>
                  </div>

                  {checkInReason === 'revise' && (
                    <textarea 
                      value={revisionNote}
                      onChange={(e) => setRevisionNote(e.target.value)}
                      placeholder="Describe your changes or markups..."
                      className="w-full p-3 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                      rows={3}
                    />
                  )}

                  <button 
                    onClick={handleCheckIn}
                    disabled={!checkInReason || processing}
                    className="w-full py-3 bg-slate-900 text-white rounded-xl font-bold text-sm hover:bg-slate-800 disabled:opacity-50 flex items-center justify-center"
                  >
                    {processing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ArrowRight className="w-4 h-4 mr-2" />}
                    {checkInReason === 'revise' ? 'Create Ticket & Check In' : 'Confirm Check In'}
                  </button>
                </div>
              ) : (
                // CHECK OUT FLOW (Start New Session or Recover)
                <div className="space-y-4">
                  {isOrphaned ? (
                    <div className="flex items-center gap-2 p-3 bg-blue-50 text-blue-800 rounded-lg text-xs">
                      <RefreshCw className="w-4 h-4 shrink-0" />
                      <span><strong>Session Recovery:</strong> You hold the lock, but your session data was cleared. Start a new session to continue working.</span>
                    </div>
                  ) : (
                    <h3 className="text-sm font-bold text-slate-900">Start working</h3>
                  )}

                  <div>
                    <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">Mode</label>
                    <div className="flex bg-slate-100 p-1 rounded-lg">
                      {(['view', 'markup', 'edit'] as const).map(m => (
                        <button 
                          key={m}
                          onClick={() => setMode(m)}
                          className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all capitalize ${mode === m ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">Reason / Note</label>
                    <input 
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="e.g. Updating pump specs..."
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                  </div>
                  
                  {activeSessions.length > 0 && !isOrphaned && (
                    <div className="p-3 bg-amber-50 text-amber-800 rounded-lg text-xs flex items-start">
                      <AlertTriangle className="w-4 h-4 mr-2 shrink-0 mt-0.5" />
                      Others are currently working on this file. Coordinate via chat to avoid conflicts.
                    </div>
                  )}

                  <div className="flex gap-2">
                    {isOrphaned && (
                      <button
                        onClick={handleForceUnlock}
                        className="px-4 py-3 bg-white border border-slate-300 text-slate-700 rounded-xl font-bold text-sm hover:bg-slate-50"
                        title="Release the lock without starting a session"
                      >
                        Release Lock
                      </button>
                    )}
                    
                    <button 
                      onClick={handleCheckout}
                      disabled={processing}
                      className={`flex-1 py-3 rounded-xl font-bold text-sm flex items-center justify-center shadow-lg ${document.checkedOutBy && !isOrphaned ? 'bg-white border-2 border-blue-600 text-blue-700 hover:bg-blue-50' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-blue-900/20'} disabled:opacity-50`}
                    >
                      {processing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Clock className="w-4 h-4 mr-2" />}
                      {isOrphaned ? "Restore Session" : document.checkedOutBy ? "Join Session" : "Check Out Now"}
                    </button>
                  </div>
                </div>
              )}
            </div>

          </div>
        </div>

        {/* RIGHT: CHAT */}
        <div className="w-full md:w-80 bg-white flex flex-col h-[400px] md:h-auto">
          {/* ... Chat UI ... */}
          <div className="px-4 py-3 border-b border-slate-200 flex justify-between items-center bg-white sticky top-0">
            <h3 className="text-sm font-bold text-slate-900 flex items-center"><MessageSquare className="w-4 h-4 mr-2" /> Session Chat</h3>
            <button onClick={onClose} className="hidden md:block p-2 hover:bg-slate-100 rounded-full"><X className="w-4 h-4 text-slate-400" /></button>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50/30" ref={scrollRef}>
            {messages.length === 0 ? (
              <div className="text-center text-slate-400 text-xs mt-10">
                {document.currentLockId ? "No messages yet." : "Start session to chat."}<br/>
              </div>
            ) : (
              messages.map(msg => (
                <div key={msg.id} className={`flex flex-col ${msg.userId === currentUser.uid ? 'items-end' : 'items-start'}`}>
                  <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-xs ${msg.userId === 'system' ? 'bg-slate-100 text-slate-500 italic mx-auto text-center border border-slate-200 w-full' : msg.userId === currentUser.uid ? 'bg-blue-600 text-white rounded-br-sm' : 'bg-white border border-slate-200 text-slate-700 rounded-bl-sm shadow-sm'}`}>
                    {msg.userId !== currentUser.uid && msg.userId !== 'system' && <span className="block font-bold text-[10px] mb-0.5 opacity-70">{msg.userName}</span>}
                    {msg.text}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="p-3 border-t border-slate-200 bg-white">
            <div className="relative">
              <input 
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                placeholder={document.currentLockId ? "Type a message..." : "Locked until session starts"}
                disabled={!document.currentLockId}
                className="w-full pl-4 pr-10 py-2 rounded-full border border-slate-200 bg-slate-50 text-xs focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50"
              />
              <button 
                onClick={handleSendMessage}
                disabled={!newMessage.trim() || !document.currentLockId}
                className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 bg-blue-600 text-white rounded-full hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                <Send className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}