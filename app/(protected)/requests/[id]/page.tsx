"use client";

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { uploadTicketAttachment } from '@/lib/storage';
import { useRole } from '@/components/providers/RoleContext';
import { Ticket, TicketStatus, TicketAttachment, TicketComment, RequestType, Role } from '@/types/schema';
import { WorkflowEngine, WorkflowAction, requiresEngineerApproval } from '@/lib/workflow';
import EngineerPickerModal from '@/components/requests/EngineerPickerModal';
import { downloadStampedPdf } from '@/lib/stamping';
import { logAuditAction } from '@/lib/audit';
import AdvancedRedlineEditor from '@/components/drafting/AdvancedRedlineEditor';
import {
  ArrowLeft,
  Calendar,
  CheckCircle2,
  Clock,
  FileText,
  MessageSquare,
  Paperclip,
  Send,
  User,
  AlertCircle,
  Download,
  Eye,
  X,
  Printer,
  Save,
  UploadCloud,
  Loader2,
  FileIcon,
  Maximize2,
  MoreVertical,
  Flag,
  History,
  ShieldAlert,
  ChevronDown,
  Trash2,
  UserPlus,
  GitCommit,
  CheckSquare,
  AlertTriangle,
  FileCheck,
  Stamp,
  ArrowRight,
  Shield,
  Ban,
  Pen,
  TrendingUp,
  Check // Added Check icon
} from 'lucide-react';

// =========================================================================================
// UTILITY: SAFE DATE CONVERTER & FORMATTERS
// =========================================================================================

const toDate = (date: any): Date => {
  if (!date) return new Date();
  if (typeof date.toDate === 'function') return date.toDate();
  if (date instanceof Date) return date;
  if (typeof date === 'string') return new Date(date);
  if (date.seconds) return new Date(date.seconds * 1000);
  return new Date(date);
};

const formatBytes = (bytes: number, decimals = 2) => {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

// =========================================================================================
// CONSTANTS
// =========================================================================================
const REVISION_REASONS = [
  "Drafting Error",
  "Missing Information",
  "Incorrect Information",
  "Standards Violation",
  "Scope Change",
  "Design Update",
  "Other"
];

// =========================================================================================
// SUB-COMPONENT: ACTION MODAL (Comments / Rejection)
// =========================================================================================
interface ActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (text: string, category?: string) => void;
  onRedline?: () => void;
  title: string;
  description: string;
  isDestructive?: boolean;
  isLoading?: boolean;
  defaultValue?: string;
  showCategorySelection?: boolean;
}

const ActionModal = ({ isOpen, onClose, onSubmit, onRedline, title, description, isDestructive, isLoading, defaultValue, showCategorySelection }: ActionModalProps) => {
  const [comment, setComment] = useState('');
  const [category, setCategory] = useState(REVISION_REASONS[0]);

  useEffect(() => {
    if (isOpen) {
        setComment(defaultValue || '');
        setCategory(REVISION_REASONS[0]);
    }
  }, [isOpen, defaultValue]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full overflow-hidden border border-slate-200">
        <div className={`px-6 py-4 border-b ${isDestructive ? 'bg-red-50 border-red-100' : 'bg-slate-50 border-slate-100'}`}>
          <h3 className={`text-lg font-bold ${isDestructive ? 'text-red-900' : 'text-slate-900'}`}>{title}</h3>
          <p className="text-xs text-slate-500 mt-1">{description}</p>
        </div>
        <div className="p-6 space-y-4">
          {showCategorySelection && (
            <div>
              <label className="block text-sm font-bold text-slate-700 mb-2">
                Reason Category <span className="text-red-500">*</span>
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full p-2.5 border border-slate-300 rounded-lg text-sm bg-slate-50 focus:ring-2 focus:ring-orange-500 outline-none"
              >
                {REVISION_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="block text-sm font-bold text-slate-700 mb-2">
              {showCategorySelection ? 'Additional Details' : 'Reason / Comment'} <span className="text-red-500">*</span>
            </label>
            <textarea 
              className="w-full h-32 p-3 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-orange-500 outline-none resize-none"
              placeholder="Please provide details..."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            {defaultValue && (
              <p className="text-[10px] text-green-600 mt-2 flex items-center">
                <CheckCircle2 className="w-3 h-3 mr-1" />
                Pre-filled from your recent comment.
              </p>
            )}
          </div>
          <div className="flex justify-between pt-2">
            {onRedline && (
              <button 
                onClick={onRedline}
                className="flex items-center px-3 py-2 text-sm font-bold text-orange-600 hover:bg-orange-50 rounded-lg transition-colors border border-orange-200"
                disabled={isLoading}
              >
                <Pen className="w-4 h-4 mr-2" /> Add Redlines
              </button>
            )}
            <div className="flex space-x-3 ml-auto">
              <button onClick={onClose} className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors" disabled={isLoading}>Cancel</button>
              <button onClick={() => onSubmit(comment, showCategorySelection ? category : undefined)} disabled={!comment.trim() || isLoading} className={`px-6 py-2 text-sm font-bold text-white rounded-lg shadow-sm transition-all flex items-center ${isDestructive ? 'bg-red-600 hover:bg-red-700 disabled:bg-red-300' : 'bg-slate-900 hover:bg-slate-800 disabled:bg-slate-400'}`}>
                {isLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Confirm
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// =========================================================================================
// SUB-COMPONENT: ASSIGNMENT MODAL
// =========================================================================================
interface AssignmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (drafterId: string, drafterName: string, reason?: string) => void;
  isLoading?: boolean;
  activeOrgId: string | null;
  isReassignment?: boolean;
}

const AssignmentModal = ({ isOpen, onClose, onSubmit, isLoading, activeOrgId, isReassignment }: AssignmentModalProps) => {
  const [drafters, setDrafters] = useState<{uid: string, email: string, role: string}[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (isOpen) {
      setReason(''); // Reset reason on open
      if (activeOrgId) {
        const fetchDrafters = async () => {
          try {
            const { data } = await supabase
              .from('org_members')
              .select('uid, email, role')
              .eq('org_id', activeOrgId)
              .eq('role', 'Drafter')
              .eq('status', 'active');
            setDrafters((data || []).map(r => ({ uid: r.uid, email: r.email, role: r.role })));
          } catch (error) {
            console.error("Error fetching drafters:", error);
          } finally {
            setLoadingList(false);
          }
        };
        fetchDrafters();
      }
    }
  }, [isOpen, activeOrgId]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full overflow-hidden border border-slate-200">
        <div className={`px-6 py-4 border-b ${isReassignment ? 'bg-orange-50 border-orange-200' : 'bg-slate-50 border-slate-200'}`}>
          <h3 className={`text-lg font-bold ${isReassignment ? 'text-orange-900' : 'text-slate-900'}`}>{isReassignment ? 'Reassign Ticket' : 'Assign Ticket'}</h3>
          <p className="text-xs text-slate-500 mt-1">{isReassignment ? 'Select a new drafter and provide a reason.' : 'Select a Drafter to handle this request.'}</p>
        </div>
        
        <div className="p-4 space-y-4">
          {isReassignment && (
            <div>
              <label className="block text-sm font-bold text-slate-700 mb-2">
                Reason for Change <span className="text-red-500">*</span>
              </label>
              <textarea 
                className="w-full p-3 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-orange-500 outline-none resize-none bg-slate-50"
                rows={3}
                placeholder="Why is this ticket being reassigned?"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          )}

          <div className="max-h-[300px] overflow-y-auto custom-scrollbar border border-slate-100 rounded-lg">
            {loadingList ? (
              <div className="flex justify-center py-8"><Loader2 className="w-8 h-8 animate-spin text-orange-500" /></div>
            ) : drafters.length === 0 ? (
              <div className="p-4 text-center text-slate-500 italic">No drafters found in the system.</div>
            ) : (
              <div className="grid grid-cols-1 gap-1">
                {drafters.map(drafter => (
                  <button 
                    key={drafter.uid} 
                    onClick={() => {
                      if (isReassignment && !reason.trim()) {
                        alert("Please provide a reason for reassignment.");
                        return;
                      }
                      onSubmit(drafter.uid, drafter.email.split('@')[0], reason);
                    }} 
                    disabled={isLoading} 
                    className="flex items-center p-3 hover:bg-orange-50 rounded-lg transition-colors group text-left w-full border border-transparent hover:border-orange-100"
                  >
                    <div className="h-10 w-10 rounded-full bg-slate-100 group-hover:bg-white flex items-center justify-center text-slate-500 group-hover:text-orange-600 mr-4 border border-slate-200"><User className="w-5 h-5" /></div>
                    <div><p className="font-bold text-slate-800 text-sm">{drafter.email}</p><p className="text-xs text-slate-500 uppercase tracking-wide">Drafter</p></div>
                    <ChevronDown className="w-4 h-4 ml-auto text-slate-300 group-hover:text-orange-400 -rotate-90" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex justify-end"><button onClick={onClose} className="text-sm font-bold text-slate-500 hover:text-slate-800">Cancel</button></div>
      </div>
    </div>
  );
};

// =========================================================================================
// SUB-COMPONENT: UPLOAD IFC MODAL
// =========================================================================================
interface UploadIFCModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (file: File) => void;
  isLoading?: boolean;
}

const UploadIFCModal = ({ isOpen, onClose, onSubmit, isLoading }: UploadIFCModalProps) => {
  const [file, setFile] = useState<File | null>(null);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full overflow-hidden border border-slate-200">
        <div className="px-6 py-4 bg-teal-50 border-b border-teal-100">
          <h3 className="text-lg font-bold text-teal-900 flex items-center">
            <Stamp className="w-5 h-5 mr-2 text-teal-600" />
            Issue For Construction
          </h3>
          <p className="text-xs text-teal-700 mt-1">Please upload the finalized, stamped PDF.</p>
        </div>
        <div className="p-6">
          <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-teal-200 rounded-xl cursor-pointer bg-teal-50/30 hover:bg-teal-50 transition-colors">
            {file ? (
              <div className="text-center">
                <FileCheck className="w-8 h-8 text-teal-600 mx-auto mb-2" />
                <p className="text-sm font-bold text-teal-900">{file.name}</p>
                <p className="text-xs text-teal-600">{formatBytes(file.size)}</p>
              </div>
            ) : (
              <div className="text-center">
                <UploadCloud className="w-8 h-8 text-teal-400 mx-auto mb-2" />
                <p className="text-sm font-medium text-teal-800">Click to upload Stamped PDF</p>
              </div>
            )}
            <input type="file" className="hidden" accept=".pdf" onChange={(e) => e.target.files && setFile(e.target.files[0])} />
          </label>
        </div>
        <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex justify-end space-x-3">
           <button onClick={onClose} className="text-sm font-bold text-slate-500 hover:text-slate-800">Cancel</button>
           <button 
             onClick={() => file && onSubmit(file)}
             disabled={!file || isLoading}
             className="px-4 py-2 bg-teal-600 text-white text-sm font-bold rounded-lg hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center"
           >
             {isLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
             Issue Final Package
           </button>
        </div>
      </div>
    </div>
  );
};

// =========================================================================================
// SUB-COMPONENT: COMPLIANCE DOWNLOAD MODAL (Prevention Mechanism)
// =========================================================================================
interface DownloadComplianceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  fileName: string;
}

const DownloadComplianceModal = ({ isOpen, onClose, onConfirm, fileName }: DownloadComplianceModalProps) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-900/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="bg-white rounded-xl shadow-2xl max-w-sm w-full overflow-hidden border-2 border-amber-300">
        <div className="p-6 text-center">
          <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
             <AlertTriangle className="w-8 h-8 text-amber-600" />
          </div>
          <h3 className="text-lg font-bold text-slate-900 mb-2">Preliminary Document</h3>
          <p className="text-sm text-slate-500 mb-6">
            You are downloading <strong>{fileName}</strong>. This file is <span className="font-bold text-red-600">NOT FOR CONSTRUCTION</span>. It is for review purposes only.
          </p>
          <div className="space-y-3">
            <button 
              onClick={onConfirm}
              className="w-full py-3 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg transition-colors shadow-lg"
            >
              I Acknowledge
            </button>
            <button 
              onClick={onClose}
              className="w-full py-3 bg-white border border-slate-200 text-slate-600 font-bold rounded-lg hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// =========================================================================================
// SUB-COMPONENT: WATERMARK OVERLAY
// =========================================================================================
const WatermarkOverlay = () => (
  <div className="absolute inset-0 z-50 pointer-events-none overflow-hidden flex flex-col justify-center opacity-10 select-none">
     {Array.from({ length: 10 }).map((_, i) => (
       <div key={i} className="flex justify-center -rotate-12 transform scale-150 whitespace-nowrap">
         <span className="text-6xl font-black text-slate-900 mx-8">PRELIMINARY</span>
         <span className="text-6xl font-black text-slate-900 mx-8">NOT FOR CONSTRUCTION</span>
       </div>
     ))}
  </div>
);

// =========================================================================================
// SUB-COMPONENT: FILE VIEWER MODAL (With Protection)
// =========================================================================================
const FileViewerModal = ({
  file,
  isOpen,
  onClose,
  ticketId,
  orgId,
  userId,
  onApprove,
}: {
  file: TicketAttachment | null;
  isOpen: boolean;
  onClose: () => void;
  ticketId?: string;
  orgId?: string;
  userId?: string;
  onApprove?: () => void;
}) => {
  const [showCompliance, setShowCompliance] = useState(false);
  const { userEmail } = useRole();

  if (!isOpen || !file) return null;

  const isPdf = file.type?.includes('pdf') || file.name.toLowerCase().endsWith('.pdf');
  const isImage = file.type?.includes('image') || file.name.match(/\.(jpeg|jpg|gif|png)$/i);
  const isDraft = file.type === 'Draft' && file.status !== 'submitted'; // Apply logic if it's a draft

  const handlePrint = () => {
    // If draft, block print or warn? For high fidelity, we just warn on download for now.
    // Real implementation would watermark the print stream.
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = file.url;
    document.body.appendChild(iframe);
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    setTimeout(() => document.body.removeChild(iframe), 2000);
  };

  const handleDownloadClick = () => {
    if (file.type === 'Draft') {
      setShowCompliance(true);
    } else {
      performDownload();
    }
  };

  const performDownload = async () => {
    const now = new Date();
    const expiresAt = file.type === "Draft"
      ? new Date(now.getTime() + 72 * 60 * 60 * 1000)
      : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    try {
      await downloadStampedPdf({
        url: file.url,
        filename: file.name,
        options: {
          userLabel: userEmail?.split("@")[0] || userId || "USER",
          email: userEmail || undefined,
          timestamp: now,
          expiresAt,
          watermarkText: file.type === "Draft" ? "REVIEW ONLY - DO NOT DISTRIBUTE" : "CONTROLLED COPY",
        },
      });

      if (orgId && userId) {
        await supabase.from("download_audits").insert({
          org_id: orgId, ticket_id: ticketId ?? null, attachment_id: file.id,
          attachment_type: file.type, filename: file.name, user_id: userId,
          user_email: userEmail ?? null, expires_at: expiresAt,
          watermark_text: file.type === "Draft" ? "REVIEW ONLY - DO NOT DISTRIBUTE" : "CONTROLLED COPY",
          source: "drafting",
        });
      }
    } catch (e: any) {
      console.warn("Stamp Generation Failed (likely CORS). Falling back to direct download.", e);
      
      // SILENT FALLBACK:
      // If stamping fails, we simply give the user the original file.
      // We do not show an alert to avoid disrupting the user workflow.
      
      const link = document.createElement("a");
      link.href = file.url;
      link.download = file.name;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      setShowCompliance(false);
    }
  };

  return (
    <>
      <DownloadComplianceModal 
        isOpen={showCompliance} 
        onClose={() => setShowCompliance(false)} 
        onConfirm={performDownload}
        fileName={file.name}
      />
      
      <div className="fixed inset-0 z-[100] bg-slate-950/95 backdrop-blur-md flex flex-col animate-in fade-in duration-300">
        <div className="flex items-center justify-between px-6 py-4 bg-slate-900 border-b border-slate-800 text-white shadow-md relative z-50">
          <div className="flex items-center space-x-4">
            <div className={`p-2 rounded-lg border ${file.type === 'Draft' ? 'bg-amber-900/50 border-amber-500/50 text-amber-500' : 'bg-slate-800 border-slate-700 text-teal-500'}`}>
               {file.type === 'Draft' ? <AlertTriangle className="w-6 h-6" /> : <FileCheck className="w-6 h-6" />}
            </div>
            <div>
              <h3 className="font-bold text-lg leading-none flex items-center">
                {file.name}
                {file.type === 'Draft' && <span className="ml-3 px-2 py-0.5 bg-amber-500 text-black text-[10px] font-black rounded uppercase tracking-wider">Preliminary</span>}
              </h3>
              <div className="flex items-center text-xs text-slate-400 mt-1.5 space-x-2">
                <span className="bg-slate-800 px-2 py-0.5 rounded border border-slate-700">{file.type}</span>
                <span>•</span>
                <span>{file.size}</span>
                <span>•</span>
                <span>{toDate(file.uploadedAt).toLocaleString()}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center space-x-3">
            {onApprove && file.type === 'Draft' && (
              <button 
                onClick={onApprove}
                className="flex items-center px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg text-sm font-bold transition-colors shadow-lg animate-in fade-in slide-in-from-right-4"
              >
                <CheckCircle2 className="w-4 h-4 mr-2" /> Approve
              </button>
            )}
            {file.type !== 'Draft' && (
               <button onClick={handlePrint} className="flex items-center px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition-colors border border-slate-700">
                 <Printer className="w-4 h-4 mr-2" /> Print
               </button>
            )}
            <button 
              onClick={handleDownloadClick}
              className={`flex items-center px-4 py-2 rounded-lg text-sm font-bold transition-colors shadow-lg ${file.type === 'Draft' ? 'bg-amber-600 hover:bg-amber-700 text-white' : 'bg-orange-600 hover:bg-orange-700 text-white'}`}
            >
              <Download className="w-4 h-4 mr-2" /> {file.type === 'Draft' ? 'Download w/ Warning' : 'Download'}
            </button>
            <button onClick={onClose} className="p-2 hover:bg-slate-800 rounded-full transition-colors text-slate-400 hover:text-white">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
        
        <div className="flex-1 overflow-hidden relative bg-slate-900/50 flex items-center justify-center p-8">
          {/* VISUAL PROTECTION LAYER */}
          {file.type === 'Draft' && <WatermarkOverlay />}

          {isPdf ? (
            <iframe src={`${file.url}#toolbar=0&navpanes=0`} className="w-full h-full rounded-lg shadow-2xl bg-white border border-slate-700 relative z-0" title="PDF Viewer" />
          ) : isImage ? (
            <img src={file.url} alt="Preview" className="max-w-full max-h-full object-contain shadow-2xl rounded-lg border border-slate-700 relative z-0" />
          ) : (
            <div className="text-center p-12 bg-white rounded-xl shadow-2xl max-w-md border border-slate-200 relative z-10">
              <div className="w-24 h-24 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-6 border border-slate-100">
                <FileIcon className="w-12 h-12 text-slate-300" />
              </div>
              <h3 className="text-xl font-bold text-slate-900 mb-2">Preview Unavailable</h3>
              <p className="text-slate-500 mb-8 leading-relaxed">This file format cannot be previewed directly.<br/>Please download to view.</p>
              <button onClick={handleDownloadClick} className="inline-flex items-center px-8 py-3 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-lg transition-colors shadow-lg">
                <Download className="w-4 h-4 mr-2" /> Download File
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

// =========================================================================================
// MAIN PAGE COMPONENT
// =========================================================================================

export default function TicketDetailView() {
  const params = useParams();
  const router = useRouter();
  const { activeRole, userEmail, activeOrgId, uid } = useRole();
  const ticketId = params.id as string;

  // --- STATE ---
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [loading, setLoading] = useState(true);
  
  // Tab State
  const [activeTab, setActiveTab] = useState<'discussion' | 'audit'>('discussion');
  
  // Workflow Actions State
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<WorkflowAction | null>(null);
  
  // Modal States
  const [showCommentModal, setShowCommentModal] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [showEngineerPicker, setShowEngineerPicker] = useState(false);
  const [showUploadIFC, setShowUploadIFC] = useState(false);
  const [preFilledComment, setPreFilledComment] = useState<string>('');
  
  // Redline State
  const [showRedlineEditor, setShowRedlineEditor] = useState(false);
  const [fileToRedline, setFileToRedline] = useState<TicketAttachment | null>(null);
  const [pendingRedlineBlob, setPendingRedlineBlob] = useState<Blob | null>(null);
  const [isReassigning, setIsReassigning] = useState(false);

  const handleReassignClick = () => {
    setIsReassigning(true);
    setPendingAction({ action: 'assign', label: 'Reassign Ticket', variant: 'warning' });
    setShowAssignModal(true);
  };

  // File Staging State
  const [fileToUpload, setFileToUpload] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  
  // Chat State
  const [newComment, setNewComment] = useState('');
  const commentsEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null); 
  const [viewerFile, setViewerFile] = useState<TicketAttachment | null>(null);

  // Admin Override State
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editCategoryVal, setEditCategoryVal] = useState<string>('');

  const isAdmin = ['Admin', 'DocCtrl'].includes(activeRole);

  // --- 1. DATA SYNC ---
  useEffect(() => {
    if (!ticketId) return;
    let alive = true;

    const fromRow = (r: Record<string, unknown>): Ticket => ({
      id: r.id as string, orgId: r.org_id as string, ticketId: r.ticket_id as string,
      title: r.title as string, description: r.description as string | undefined,
      unit: r.unit as string, requestType: r.request_type as string,
      status: r.status as Ticket['status'], priority: r.priority as number | undefined,
      requesterId: r.requester_id as string, requesterName: r.requester_name as string | undefined,
      requesterEmail: r.requester_email as string | undefined,
      requesterRole: r.requester_role as Ticket['requesterRole'],
      assignedDrafterId: r.assigned_drafter_id as string | null | undefined,
      assignedDrafterName: r.assigned_drafter_name as string | null | undefined,
      assignedEngineerId: r.assigned_engineer_id as string | null | undefined,
      assignedEngineerName: r.assigned_engineer_name as string | null | undefined,
      assignedEngineerEmail: r.assigned_engineer_email as string | null | undefined,
      engineerReviewRequestedAt: r.engineer_review_requested_at as string | null | undefined,
      engineerApprovedAt: r.engineer_approved_at as string | null | undefined,
      engineerReviewReason: r.engineer_review_reason as string | null | undefined,
      attachments: (r.attachments as Ticket['attachments']) ?? [],
      comments: (r.comments as Ticket['comments']) ?? [],
      history: (r.history as Ticket['history']) ?? [],
      unreadBy: (r.unread_by as string[]) ?? [],
      revisionCount: r.revision_count as number | undefined,
      createdAt: r.created_at as string,
      lastModified: r.last_modified as string | undefined,
      updatedAt: r.updated_at as string | undefined,
    });

    const fetchTicket = async () => {
      const { data } = await supabase.from('tickets').select('*').eq('id', ticketId).single();
      if (!alive) return;
      if (!data) { router.push('/requests'); return; }
      const t = fromRow(data as Record<string, unknown>);
      if (activeOrgId && t.orgId && t.orgId !== activeOrgId) { router.push('/requests'); return; }
      setTicket(t);
      if (uid && t.unreadBy?.includes(uid)) {
        supabase.from('tickets').update({ unread_by: t.unreadBy.filter(id => id !== uid) }).eq('id', ticketId).then(() => {});
      }
      setLoading(false);
    };

    fetchTicket();
    const channel = supabase
      .channel(`ticket-detail-${ticketId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tickets', filter: `id=eq.${ticketId}` },
        () => { if (alive) fetchTicket(); })
      .subscribe();

    return () => { alive = false; supabase.removeChannel(channel); };
  }, [ticketId, router, activeOrgId, uid]);

  // --- 2. SAFE SCROLL ---
  useEffect(() => {
    if (chatContainerRef.current && activeTab === 'discussion') {
      const container = chatContainerRef.current;
      container.scrollTop = container.scrollHeight;
    }
  }, [ticket?.comments, activeTab]);

  // --- 3. ACTIONS & HANDLERS ---

  const handleUpdateCategory = async (commentId: string) => {
    if (!ticket || !ticket.comments) return;
    
    // Create a new array with the updated comment
    const updatedComments = ticket.comments.map(c => {
      if (c.id === commentId) {
        return { ...c, category: editCategoryVal };
      }
      return c;
    });

    try {
      await supabase.from('tickets').update({ comments: updatedComments }).eq('id', ticketId);
      await logAuditAction({
        action: 'TICKET_ROOT_CAUSE_UPDATE', resourceId: ticketId, resourceType: 'ticket',
        orgId: activeOrgId || undefined, userId: uid || 'unknown', userRole: activeRole,
        details: { commentId, newCategory: editCategoryVal }
      });
      setEditingCommentId(null);
    } catch (e) {
      console.error("Failed to update category", e);
      alert("Failed to update root cause.");
    }
  };

  const handleFileUpload = async (type: 'Draft' | 'Final' | 'Source' | 'Reference', fileOverride?: File) => {
    const file = fileOverride || fileToUpload;
    if (!file || !ticket) return;
    setIsUploading(true);
    try {
      if (!activeOrgId) throw new Error("No active workspace selected.");
      const result = await uploadTicketAttachment({
        file, orgId: activeOrgId, ticketId: ticket.ticketId,
        onProgress: (p) => setUploadProgress(p.percent),
      });
      const newAttachment: TicketAttachment = {
        id: crypto.randomUUID(), name: file.name, url: result.url, type,
        status: type === 'Source' ? 'submitted' : 'staged',
        size: formatBytes(file.size), uploadedBy: userEmail || 'Unknown', uploadedAt: new Date().toISOString()
      };
      const now = new Date().toISOString();
      const historyEntry = { action: 'File Uploaded', user: userEmail || 'Unknown', role: activeRole, date: now, details: `Uploaded ${type} file: ${file.name}` };
      const currentAttachments = ticket.attachments || [];
      const currentHistory = ticket.history || [];
      await supabase.from('tickets').update({
        attachments: [...currentAttachments, newAttachment],
        last_modified: now,
        history: [...currentHistory, historyEntry],
      }).eq('id', ticketId);

      await logAuditAction({
        action: 'TICKET_FILE_UPLOAD', resourceId: ticketId, resourceType: 'ticket',
        orgId: activeOrgId, userId: uid || 'unknown', userEmail: userEmail || 'unknown', userRole: activeRole,
        details: { fileName: file.name, fileType: type, fileSize: file.size }
      });

      setIsUploading(false);
      setFileToUpload(null);
      setUploadProgress(0);
    } catch (err) { console.error(err); alert("Upload failed. Please try again."); setIsUploading(false); }
  };

  const initiateWorkflowAction = (action: WorkflowAction) => {
    if (!ticket) return;
    if (action.requiresFile) {
      const hasFiles = ticket.attachments && ticket.attachments.length > 0;
      if (!hasFiles) { alert("Compliance Check Failed: You must upload at least one file before proceeding."); return; }
    }
    
    // Open IFC Upload Modal
    if (action.action === 'submit_final') {
      setPendingAction(action);
      setShowUploadIFC(true);
    }
    // Any action that needs an engineer routed to it opens the picker first.
    // The picker collects the engineer + a comment, then calls
    // executeWorkflowAction with engineerData filled in.
    else if (action.requiresEngineerPick) {
      setPendingAction(action);
      setShowEngineerPicker(true);
    }
    else if (action.requiresComment) {
      let defaultText = '';
      if (ticket.comments && ticket.comments.length > 0) {
        const lastComment = ticket.comments[ticket.comments.length - 1];
        const now = new Date().getTime();
        const commentTime = toDate(lastComment.date).getTime();
        if (lastComment.user === userEmail && (now - commentTime) < (5 * 60 * 1000)) { defaultText = lastComment.text; }
      }
      setPreFilledComment(defaultText);
      setPendingAction(action);
      setShowCommentModal(true);
    } 
    // MERGED FLOW: Approval now directly triggers Assignment
    else if (action.action === 'assign' || action.action === 'approve_initial') { 
      // If approving, we swap the action to 'assign' so the backend logic moves it straight to DRAFTING
      const effectiveAction = action.action === 'approve_initial' 
        ? { ...action, action: 'assign', label: 'Approve & Assign' } 
        : action;
      
      setPendingAction(effectiveAction); 
      setShowAssignModal(true); 
    } 
    else { executeWorkflowAction(action); }
  };

  // Handler for IFC Upload Modal
  const handleIFCUpload = async (file: File) => {
    if (!ticket || !pendingAction) return;
    setActionLoading('submit_final');
    try {
      if (!activeOrgId) throw new Error("No active workspace selected.");
      const result = await uploadTicketAttachment({ file, orgId: activeOrgId, ticketId: ticket.ticketId });
      const finalAttachment: TicketAttachment = {
        id: crypto.randomUUID(), name: file.name, url: result.url, type: 'Final',
        status: 'submitted', size: formatBytes(file.size), uploadedBy: userEmail || 'Unknown',
        uploadedAt: new Date().toISOString()
      };
      await executeWorkflowAction(pendingAction, undefined, undefined, finalAttachment);
    } catch (err) {
      console.error(err);
      alert("Failed to upload IFC package.");
      setActionLoading(null);
    }
  };

  const handleRedlineSave = async (blob: Blob) => {
    if (!ticket || !fileToRedline) return;
    // Store blob for later upload
    setPendingRedlineBlob(blob);
    setShowRedlineEditor(false);

    // Open the Rejection Modal (mocking the workflow action)
    const rejectAction: WorkflowAction = {
      label: 'Request Revision with Redlines',
      action: 'request_revision',
      variant: 'destructive',
      requiresComment: true
    };
    
    setPendingAction(rejectAction);
    setShowCommentModal(true);
  };

  const executeWorkflowAction = async (
    action: WorkflowAction,
    comment?: string,
    assignmentData?: {id: string, name: string},
    newFinalFile?: TicketAttachment,
    category?: string,
    engineerData?: {id: string, name: string, email: string}
  ) => {
    if (!ticket) return;
    setActionLoading(action.action);
    try {
      const historyEntry: any = { action: action.label, user: userEmail || 'Unknown', role: activeRole, date: new Date().toISOString() };
      
      // Handle Redline Upload if pending
      let finalComment = comment;
      let redlineAttachment: TicketAttachment | null = null;

      if (pendingRedlineBlob && fileToRedline) {
         if (!activeOrgId) throw new Error("No active workspace.");
         const fileName = `REDLINE_${Date.now()}_${fileToRedline.name}`;
         const redlineFile = new File([pendingRedlineBlob], fileName, { type: pendingRedlineBlob.type });
         const result = await uploadTicketAttachment({ file: redlineFile, orgId: activeOrgId, ticketId: ticket.ticketId });

         redlineAttachment = {
           id: crypto.randomUUID(),
           name: fileName,
           url: result.url,
           type: 'Reference',
           status: 'submitted',
           size: formatBytes(pendingRedlineBlob.size),
           uploadedBy: userEmail || 'Unknown',
           uploadedAt: new Date().toISOString()
         };

         // Append system note to comment
         finalComment = `${comment || ''}\n\n[System: Attached Redlines for ${fileToRedline.name}]`;
         historyEntry.details = finalComment;

         await logAuditAction({
            action: 'TICKET_REDLINE_CREATED', resourceId: ticketId, resourceType: 'ticket',
            orgId: activeOrgId, userId: uid || 'unknown', userRole: activeRole,
            details: { originalFile: fileToRedline.name, newFile: fileName }
         });
      } else if (finalComment) {
         historyEntry.details = finalComment;
      } else if (assignmentData) {
         historyEntry.details = `Assigned to ${assignmentData.name}${comment ? ` [Reason: ${comment}]` : ''}`;
      }
      
      if (action.action === 'request_revision' || action.action === 'reject' || action.action === 'reject_final') {
        historyEntry.revisionRound = (ticket.revisionCount || 0) + 1;
      }

      const now = new Date().toISOString();
      const newHistory = [...(ticket.history || []), historyEntry];
      const newUnreadBy = [ticket.requesterId, ticket.assignedDrafterId].filter((id): id is string => !!id && id !== uid);

      const updates: Record<string, unknown> = {
        last_modified: now,
        history: newHistory,
        unread_by: newUnreadBy,
      };

      if (finalComment && finalComment !== preFilledComment) {
        const newComment = {
          id: crypto.randomUUID(), text: finalComment, user: userEmail || 'Unknown', role: activeRole,
          date: now, type: (action.variant === 'destructive' || action.action === 'request_revision') ? 'Revision' : (isReassigning ? 'Reassignment' : 'General'),
          category: category || null
        };
        updates.comments = [...(ticket.comments || []), newComment];
        updates.last_activity_at = now;
      }

      let currentAttachments = [...(ticket.attachments || [])];
      if (redlineAttachment) currentAttachments = [...currentAttachments, redlineAttachment];

      switch (action.action) {
        case 'save_progress': break;
        case 'approve_initial': updates.status = 'PENDING_ASSIGNMENT'; break;
        case 'request_eng_review':
          updates.status = 'PENDING_ENG_TEAM';
          if (engineerData) {
            updates.assigned_engineer_id = engineerData.id;
            updates.assigned_engineer_name = engineerData.name;
            updates.assigned_engineer_email = engineerData.email;
            updates.engineer_review_requested_at = now;
            updates.engineer_review_reason = finalComment || null;
            // Notify the specific engineer
            updates.unread_by = [engineerData.id];
          }
          break;
        case 'approve_team': updates.status = 'PENDING_ASSIGNMENT'; break;
        case 'assign':
          if (assignmentData) {
            updates.assigned_drafter_id = assignmentData.id; updates.assigned_drafter_name = assignmentData.name;
            updates.status = 'DRAFTING'; updates.unread_by = [assignmentData.id];
          } break;
        case 'self_assign':
          if (uid && userEmail) { updates.assigned_drafter_id = uid; updates.assigned_drafter_name = userEmail.split('@')[0]; updates.status = 'DRAFTING'; } break;
        case 'submit_draft':
          updates.status = 'PENDING_REVIEW';
          if ((ticket.revisionCount || 0) > 0) historyEntry.action = `Submitted Revision ${ticket.revisionCount}`;
          currentAttachments = currentAttachments.map(a => a.status === 'staged' ? { ...a, status: 'submitted' } : a); break;
        case 'approve_draft_ifc': updates.status = 'PENDING_IFC'; break;

        // NEW: viewer-tier requester routes their approval to an engineer.
        // We stash the engineer + comment + timestamp so the audit shows
        // WHO is being asked to sign off (and when).
        case 'request_final_engineer_approval':
          updates.status = 'PENDING_FINAL_APPROVAL';
          if (engineerData) {
            updates.assigned_engineer_id = engineerData.id;
            updates.assigned_engineer_name = engineerData.name;
            updates.assigned_engineer_email = engineerData.email;
            updates.engineer_review_requested_at = now;
            updates.engineer_review_reason = finalComment || null;
            // Notify ONLY the assigned engineer — keep the inbox tight
            updates.unread_by = [engineerData.id];
          }
          break;

        // NEW: engineer signs off on final approval, hands back to drafter for IFC.
        case 'engineer_approve_final':
          updates.status = 'PENDING_IFC';
          updates.engineer_approved_at = now;
          // Notify drafter that they need to issue the IFC package
          if (ticket.assignedDrafterId) updates.unread_by = [ticket.assignedDrafterId];
          break;

        // NEW: engineer kicks the drawing back to the drafter.
        case 'engineer_request_revision':
          updates.status = 'REVISION_REQ';
          updates.revision_count = (ticket.revisionCount || 0) + 1;
          if (ticket.assignedDrafterId) updates.unread_by = [ticket.assignedDrafterId];
          break;

        // NEW: engineer kicks back to the original requester for clarification.
        case 'engineer_return_to_requester':
          updates.status = 'PENDING_REVIEW';
          if (ticket.requesterId) updates.unread_by = [ticket.requesterId];
          break;

        // NEW: admin swaps in a different engineer at PENDING_FINAL_APPROVAL.
        case 'reassign_engineer':
          if (engineerData) {
            updates.assigned_engineer_id = engineerData.id;
            updates.assigned_engineer_name = engineerData.name;
            updates.assigned_engineer_email = engineerData.email;
            updates.engineer_review_requested_at = now;
            updates.unread_by = [engineerData.id];
          }
          break;

        case 'request_revision':
        case 'reject':
        case 'reject_final': updates.status = 'REVISION_REQ'; updates.revision_count = (ticket.revisionCount || 0) + 1; break;
        case 'submit_final':
          updates.status = 'FINAL_DRAFT';
          if (newFinalFile) currentAttachments = [...currentAttachments, newFinalFile]; break;
        case 'close_ticket':
        case 'close_rfi': updates.status = 'CLOSED'; break;
      }

      updates.attachments = currentAttachments;

      await supabase.from('tickets').update(updates).eq('id', ticketId);

      await logAuditAction({
        action: `TICKET_WORKFLOW_${action.action.toUpperCase()}`, resourceId: ticketId, resourceType: 'ticket',
        orgId: activeOrgId || undefined, userId: uid || 'unknown', userEmail: userEmail || 'unknown', userRole: activeRole,
        details: { label: action.label, comment: finalComment || null, assignment: assignmentData || null, newStatus: updates.status }
      });

      setActionLoading(null); 
      setPendingAction(null); 
      setShowCommentModal(false); 
      setShowAssignModal(false); 
      setShowUploadIFC(false);
      setPendingRedlineBlob(null); // Clear redline state
      setFileToRedline(null);
    } catch (err) { console.error(err); alert("System Error: Failed to execute workflow action."); setActionLoading(null); }
  };

  const handlePostComment = async (text: string) => {
    if (!text.trim() || !ticket) return;
    const now = new Date().toISOString();
    const newComment = { id: crypto.randomUUID(), text, user: userEmail || 'Unknown', role: activeRole, date: now, type: 'General' };
    await supabase.from('tickets').update({
      comments: [...(ticket.comments || []), newComment],
      last_activity_at: now,
      unread_by: [ticket.requesterId, ticket.assignedDrafterId].filter((id): id is string => !!id && id !== uid),
    }).eq('id', ticketId);
    setNewComment('');
  };

  const deleteStagedFile = async (file: TicketAttachment) => {
    if (!confirm("Are you sure you want to remove this staged file?")) return;
    await supabase.from('tickets').update({ attachments: ticket?.attachments?.filter(a => a.id !== file.id) }).eq('id', ticketId);
  };

  const getStatusStyle = (status: TicketStatus) => {
    switch (status) {
      case 'DRAFTING': return 'bg-blue-100 text-blue-800 border-blue-200'; 
      case 'PENDING_IFC': return 'bg-teal-100 text-teal-800 border-teal-200';
      case 'REVISION_REQ': return 'bg-amber-100 text-amber-800 border-amber-200';
      case 'PENDING_ASSIGNMENT': return 'bg-purple-100 text-purple-800 border-purple-200';
      default: return 'bg-slate-100 text-slate-800 border-slate-200';
    }
  };

  if (loading || !ticket) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center bg-slate-50 gap-4">
        <Loader2 className="w-16 h-16 animate-spin text-orange-600" />
        <div className="flex flex-col items-center"><h2 className="text-xl font-bold text-slate-900">Loading Ticket Details...</h2><p className="text-slate-500 text-sm">Retrieving latest workflow state and assets.</p></div>
      </div>
    );
  }

  const availableActions = WorkflowEngine.getActions(ticket, activeRole, uid ?? undefined);
  const sourceFiles = ticket.attachments?.filter(a => a.type === 'Source' || a.type === 'Reference') || [];
  
  // LOGIC: DRAFTS SORTING & VERSIONING
  const draftFilesRaw = ticket.attachments?.filter(a => a.type === 'Draft') || [];
  const sortedDrafts = draftFilesRaw.sort((a, b) => toDate(b.uploadedAt).getTime() - toDate(a.uploadedAt).getTime());
  
  const latestDraft = sortedDrafts[0];
  const previousDrafts = sortedDrafts.slice(1);
  const draftFiles = sortedDrafts; // Backward compatibility for rendering if needed

  const finalFiles = ticket.attachments?.filter(a => a.type === 'Final') || [];

  // LOGIC: Check for Staged Files
  const hasStagedFiles = ticket.attachments?.some(a => a.status === 'staged' && a.type === 'Draft');

  return (
    <div className="min-h-screen bg-slate-50 pb-20">
      
      {/* MODALS */}
      {showRedlineEditor && fileToRedline && (
        <AdvancedRedlineEditor 
          fileUrl={fileToRedline.url} 
          onClose={() => setShowRedlineEditor(false)} 
          onSave={handleRedlineSave}
          isSaving={isUploading}
        />
      )}
      <FileViewerModal
        isOpen={!!viewerFile}
        file={viewerFile}
        onClose={() => setViewerFile(null)}
        ticketId={ticket?.ticketId}
        orgId={activeOrgId ?? undefined}
        userId={uid ?? undefined}
        onApprove={(() => {
          const action = availableActions.find(a => a.action === 'approve_draft_ifc');
          return action ? () => { setViewerFile(null); initiateWorkflowAction(action); } : undefined;
        })()}
      />
      <ActionModal 
        isOpen={showCommentModal} 
        onClose={() => setShowCommentModal(false)} 
        title={pendingAction?.action === 'request_revision' || pendingAction?.action === 'reject' ? 'Request Revision' : pendingAction?.variant === 'destructive' ? 'Reject & Return' : 'Workflow Comment'} 
        description={pendingAction?.action === 'request_revision' || pendingAction?.action === 'reject' ? 'Please provide feedback on what needs to be revised.' : pendingAction?.variant === 'destructive' ? 'Please explain why this request is being returned or rejected.' : 'Add an optional comment to this action.'} 
        isDestructive={pendingAction?.variant === 'destructive' || pendingAction?.action === 'request_revision'} 
        showCategorySelection={pendingAction?.action === 'request_revision' || pendingAction?.action === 'reject'}
        onSubmit={(comment, category) => pendingAction && executeWorkflowAction(pendingAction, comment, undefined, undefined, category)}
        isLoading={!!actionLoading} 
        defaultValue={preFilledComment}
        onRedline={
          (pendingAction?.action === 'reject' || pendingAction?.action === 'request_revision') && sortedDrafts.length > 0 
          ? () => {
              if (sortedDrafts.length === 1) {
                setFileToRedline(sortedDrafts[0]);
                setShowRedlineEditor(true);
                setShowCommentModal(false);
              } else {
                if(confirm(`Start redlining the latest draft: ${sortedDrafts[0].name}?`)) {
                   setFileToRedline(sortedDrafts[0]);
                   setShowRedlineEditor(true);
                   setShowCommentModal(false);
                }
              }
            } 
          : undefined
        }
      />
      <AssignmentModal isOpen={showAssignModal} onClose={() => { setShowAssignModal(false); setIsReassigning(false); }} onSubmit={(id, name, reason) => pendingAction && executeWorkflowAction(pendingAction, reason, {id, name})} isLoading={!!actionLoading} activeOrgId={activeOrgId} isReassignment={isReassigning} />
      <UploadIFCModal isOpen={showUploadIFC} onClose={() => setShowUploadIFC(false)} onSubmit={handleIFCUpload} isLoading={!!actionLoading} />

      {showEngineerPicker && pendingAction && activeOrgId && (
        <EngineerPickerModal
          isOpen={showEngineerPicker}
          onClose={() => { setShowEngineerPicker(false); setPendingAction(null); }}
          orgId={activeOrgId}
          currentEngineerId={pendingAction.action === 'reassign_engineer' ? ticket?.assignedEngineerId ?? undefined : undefined}
          title={
            pendingAction.action === 'request_final_engineer_approval' ? 'Send for Engineer Final Approval' :
            pendingAction.action === 'reassign_engineer' ? 'Reassign Engineer Reviewer' :
            'Flag for Engineering Review'
          }
          description={
            pendingAction.action === 'request_final_engineer_approval'
              ? 'Engineering policy: drawings need an engineer sign-off before IFC. The engineer you pick will get a notification and review the draft.'
              : pendingAction.action === 'reassign_engineer'
                ? 'Pick a different engineer to take over the final approval review.'
                : 'Route this ticket to a specific engineer for a scope review.'
          }
          commentLabel={pendingAction.action === 'request_final_engineer_approval' ? 'Note to the engineer *' : 'What needs to be reviewed? *'}
          commentPlaceholder={
            pendingAction.action === 'request_final_engineer_approval'
              ? "e.g. Please confirm orifice plate sizing on FE-201 is correct for the new flow conditions."
              : "What specifically should they look at?"
          }
          onSubmit={async ({ engineerId, engineerName, engineerEmail, comment }) => {
            if (!pendingAction) return;
            await executeWorkflowAction(
              pendingAction,
              comment,
              undefined,
              undefined,
              undefined,
              { id: engineerId, name: engineerName, email: engineerEmail }
            );
          }}
        />
      )}

      {/* HEADER */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-20 shadow-sm px-4 sm:px-6 lg:px-8 py-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 max-w-[1920px] mx-auto">
          <div className="flex items-center gap-4">
            <button onClick={() => router.back()} className="p-2 hover:bg-slate-100 rounded-full text-slate-500 transition-colors"><ArrowLeft className="w-5 h-5" /></button>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-bold text-slate-900 tracking-tight">{ticket.ticketId}</h1>
                <span className={`px-3 py-1 rounded-full text-xs font-bold border uppercase tracking-wider ${getStatusStyle(ticket.status)}`}>{ticket.status.replace(/_/g, ' ')}</span>
                {typeof ticket.priority === 'number' && (
                  <span className={`px-2 py-0.5 text-[10px] font-bold rounded border flex items-center
                    ${ticket.priority === 1 ? 'text-red-700 bg-red-100 border-red-200' : 
                      ticket.priority === 2 ? 'text-orange-700 bg-orange-100 border-orange-200' :
                      ticket.priority === 3 ? 'text-blue-700 bg-blue-100 border-blue-200' :
                      'text-slate-700 bg-slate-100 border-slate-200'
                    }`}>
                    {ticket.priority === 1 && <AlertCircle className="w-3 h-3 mr-1" />}
                    {ticket.priority === 2 && <TrendingUp className="w-3 h-3 mr-1" />}
                    {ticket.priority >= 3 && <Flag className="w-3 h-3 mr-1" />}
                    P{ticket.priority}
                  </span>
                )}
                {/* Dynamically checking if requestType matches any known flag type would require config, but keeping RFI hardcheck for now as it's likely standard */}
                {ticket.requestType === 'RFI' && <span className="px-2 py-0.5 bg-pink-100 text-pink-700 text-[10px] font-bold rounded border border-pink-200 flex items-center"><Flag className="w-3 h-3 mr-1" /> RFI</span>}
              </div>
              <p className="text-sm text-slate-500 mt-1 font-medium">{ticket.title}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 justify-end">
            {(activeRole === 'Drafter' || activeRole === 'Requester' || activeRole === 'Admin' || uid === ticket.requesterId) && (
              <>
                <label className={`cursor-pointer px-5 py-2.5 rounded-lg text-sm font-bold shadow-sm transition-all flex items-center bg-white border-2 border-slate-200 text-slate-700 hover:border-slate-300 hover:bg-slate-50 ${isUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                  {isUploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <UploadCloud className="w-4 h-4 mr-2 text-slate-400" />} 
                  {isUploading ? `Uploading ${uploadProgress.toFixed(0)}%` : 'Add New File'}
                  <input 
                    type="file" 
                    className="hidden" 
                    onChange={(e) => { 
                      const file = e.target.files?.[0];
                      if (file) {
                        const isPrivileged = activeRole === 'Drafter' || activeRole === 'Admin';
                        if (!isPrivileged) {
                          handleFileUpload('Source', file);
                        } else {
                          setFileToUpload(file); 
                        }
                      }
                    }} 
                  />
                </label>

                {fileToUpload && !isUploading && (
                  <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm animate-in fade-in">
                    <div className="bg-white p-6 rounded-xl shadow-2xl max-w-sm w-full animate-in zoom-in-95 border border-slate-200">
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="font-bold text-lg text-slate-900">Classify Upload</h3>
                        <button onClick={() => setFileToUpload(null)} className="p-1 hover:bg-slate-100 rounded-full transition-colors"><X className="w-5 h-5 text-slate-400 hover:text-slate-600"/></button>
                      </div>
                      <div className="p-3 bg-slate-50 rounded-lg mb-6 border border-slate-200 flex items-center">
                        <FileIcon className="w-8 h-8 text-blue-500 mr-3" />
                        <div className="overflow-hidden">
                          <p className="font-bold text-sm truncate text-slate-900">{fileToUpload.name}</p>
                          <p className="text-xs text-slate-500">{formatBytes(fileToUpload.size)}</p>
                        </div>
                      </div>
                      <div className="flex flex-col gap-2">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Select File Category</p>
                        <button onClick={() => handleFileUpload('Source')} className="w-full py-3 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 transition-colors flex items-center justify-center shadow-md shadow-blue-900/10">
                          <FileIcon className="w-4 h-4 mr-2"/> Source Asset
                        </button>
                        <button onClick={() => handleFileUpload('Draft')} className="w-full py-3 bg-orange-600 text-white rounded-lg font-bold hover:bg-orange-700 transition-colors flex items-center justify-center shadow-md shadow-orange-900/10">
                          <FileText className="w-4 h-4 mr-2"/> Draft Drawing
                        </button>
                        <button onClick={() => handleFileUpload('Reference')} className="w-full py-3 bg-white border border-slate-200 text-slate-700 rounded-lg font-bold hover:bg-slate-50 transition-colors flex items-center justify-center">
                          Supporting Doc / Reference
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            {isAdmin && ticket.assignedDrafterId && ticket.status !== 'CLOSED' && (
              <button 
                onClick={handleReassignClick}
                className="px-5 py-2.5 rounded-lg text-sm font-bold shadow-sm transition-all flex items-center bg-white border-2 border-orange-200 text-orange-700 hover:bg-orange-50 hover:border-orange-300"
              >
                <UserPlus className="w-4 h-4 mr-2" /> Reassign
              </button>
            )}
            {availableActions.length === 0 ? (
               <div className="flex items-center px-4 py-2 bg-slate-50 rounded-lg border border-slate-200 text-xs font-medium text-slate-400 italic"><ShieldAlert className="w-4 h-4 mr-2" /> View Only - No Actions Available</div>
            ) : (
              availableActions.map((action, idx) => (
                <button 
                  key={idx} 
                  onClick={() => initiateWorkflowAction(action)} 
                  disabled={!!actionLoading} 
                  className={`
                    px-5 py-2.5 rounded-lg text-sm font-bold shadow-sm transition-all flex items-center relative overflow-hidden group disabled:opacity-50 disabled:cursor-not-allowed
                    ${action.variant === 'success' ? 'bg-green-600 text-white hover:bg-green-700' : 
                      action.variant === 'destructive' ? 'bg-red-600 text-white hover:bg-red-700' : 
                      action.variant === 'outline' ? 'bg-white border-2 border-slate-300 text-slate-700 hover:border-slate-400 hover:bg-slate-50' : 
                      action.variant === 'warning' ? 'bg-amber-500 text-white hover:bg-amber-600' : 
                      'bg-slate-900 text-white hover:bg-slate-800'}
                    ${action.action === 'submit_draft' && hasStagedFiles ? 'ring-4 ring-orange-400/50 animate-pulse' : ''}
                  `}
                >
                  {actionLoading === action.action ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : action.action === 'save_progress' ? <Save className="w-4 h-4 mr-2" /> : action.action === 'submit_draft' ? <Send className="w-4 h-4 mr-2" /> : action.action === 'assign' ? <UserPlus className="w-4 h-4 mr-2" /> : action.action === 'submit_final' ? <FileCheck className="w-4 h-4 mr-2" /> : null}
                  {action.label}
                  {action.action === 'submit_draft' && hasStagedFiles && (
                    <span className="absolute top-0 right-0 w-3 h-3 bg-orange-500 rounded-full border-2 border-white translate-x-1 -translate-y-1"></span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      </div>

      {/* NOTIFICATION: Staged Files Warning */}
      {hasStagedFiles && (
        <div className="bg-orange-600 text-white px-4 py-3 shadow-md relative z-10 animate-in slide-in-from-top-2">
          <div className="max-w-[1920px] mx-auto flex items-center justify-between px-4 sm:px-6 lg:px-8">
             <div className="flex items-center">
               <AlertTriangle className="w-5 h-5 mr-3 animate-bounce" />
               <p className="text-sm font-bold">You have unsubmitted drafts. Please click "Submit Draft for Review" to notify the requester.</p>
             </div>
             <button 
               onClick={() => {
                 const submitAction = availableActions.find(a => a.action === 'submit_draft');
                 if (submitAction) initiateWorkflowAction(submitAction);
               }}
               className="px-4 py-1 bg-white text-orange-600 text-xs font-bold rounded hover:bg-orange-50 transition-colors shadow-sm"
             >
               Submit Now
             </button>
          </div>
        </div>
      )}

      <div className="max-w-[1920px] mx-auto p-4 sm:p-6 lg:p-8 grid grid-cols-1 xl:grid-cols-3 gap-8">
        {/* LEFT: DETAILS & FILES */}
        <div className="xl:col-span-2 space-y-8">
          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full bg-orange-500" />
            <div className="flex items-center justify-between mb-6 border-b border-slate-100 pb-4"><h2 className="text-sm font-bold text-slate-900 uppercase tracking-wide flex items-center"><FileText className="w-4 h-4 mr-2 text-orange-500" /> Project Specifications</h2><span className="text-xs text-slate-400 font-mono">ID: {ticket.id}</span></div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
              <div><label className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Unit</label><div className="font-mono text-sm font-bold text-slate-800 bg-slate-100 px-2 py-1 rounded w-fit mt-1 border border-slate-200">{ticket.unit}</div></div>
              <div><label className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Requester</label><div className="min-w-0 text-sm font-semibold text-slate-900 mt-1 flex items-center group cursor-help" title={ticket.requesterId}><User className="w-4 h-4 mr-2 text-slate-300 group-hover:text-orange-500 transition-colors shrink-0" /><span className="truncate">{ticket.requesterName}</span></div></div>
              <div><label className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Assigned Lead</label><div className="min-w-0 text-sm font-semibold text-slate-900 mt-1">{ticket.assignedDrafterName ? (<div className="flex items-center text-orange-700"><div className="w-2 h-2 rounded-full bg-green-500 mr-2 shrink-0" /><span className="truncate">{ticket.assignedDrafterName}</span></div>) : <span className="text-slate-400 italic">Unassigned</span>}</div></div>
              <div>
                <label className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Engineer Reviewer</label>
                <div className="min-w-0 text-sm font-semibold text-slate-900 mt-1">
                  {ticket.assignedEngineerName ? (
                    <div className="flex items-center text-blue-700">
                      <div className={`w-2 h-2 rounded-full mr-2 shrink-0 ${ticket.engineerApprovedAt ? "bg-emerald-500" : "bg-blue-500 animate-pulse"}`} />
                      <span className="truncate" title={ticket.assignedEngineerEmail || ticket.assignedEngineerName}>{ticket.assignedEngineerName}</span>
                      {ticket.engineerApprovedAt && <span className="ml-2 text-[10px] text-emerald-600 font-bold uppercase">approved</span>}
                    </div>
                  ) : <span className="text-slate-400 italic">Not yet assigned</span>}
                </div>
              </div>
              <div><label className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Initiated</label><div className="text-sm font-semibold text-slate-900 mt-1 flex items-center"><Calendar className="w-4 h-4 mr-2 text-slate-300 shrink-0" />{toDate(ticket.createdAt).toLocaleDateString()}</div></div>
            </div>
            <div className="mt-6 pt-6 border-t border-slate-100"><label className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-2 block">Scope of Work</label><div className="bg-slate-50 rounded-lg p-4 text-sm text-slate-700 leading-relaxed border border-slate-200 shadow-inner">{ticket.description}</div></div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
             <div className="px-6 py-4 border-b border-slate-200 bg-slate-50/50 flex flex-col sm:flex-row justify-between items-center gap-4">
               <div><h2 className="text-sm font-bold text-slate-900 uppercase tracking-wide flex items-center"><Paperclip className="w-4 h-4 mr-2 text-orange-500" /> Project Assets</h2></div>
             </div>

             <div className="p-4 bg-slate-50/50 border-b border-slate-100 order-1">
               <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Incoming Assets (Source)</h3>
               <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                 {sourceFiles.length === 0 ? <p className="text-xs text-slate-400 italic pl-2">No source files provided.</p> : sourceFiles.map((file, idx) => (
                   <div key={idx} className="flex items-center justify-between bg-white p-2.5 rounded-lg border border-slate-200 shadow-sm hover:border-slate-300">
                     <div className="flex items-center space-x-3 overflow-hidden"><div className="p-1.5 bg-slate-100 rounded text-slate-500"><FileIcon className="w-4 h-4" /></div><span className="text-xs font-bold text-slate-700 truncate">{file.name}</span></div>
                     <button onClick={() => setViewerFile(file)} className="text-slate-400 hover:text-blue-600"><Eye className="w-4 h-4" /></button>
                   </div>
                 ))}
               </div>
             </div>

             <div className={`p-4 border-b border-slate-100 ${['FINAL_DRAFT', 'PENDING_FINAL_APPROVAL', 'CLOSED'].includes(ticket.status) ? 'order-3 opacity-60 grayscale-[0.5]' : 'order-2'}`}>
               <h3 className="text-[10px] font-bold text-orange-600 uppercase tracking-widest mb-3 flex items-center"><Loader2 className="w-3 h-3 mr-1 animate-spin-slow" /> Work In Progress (Drafts)</h3>
               <div className="space-y-4">
                 {sortedDrafts.length === 0 ? <p className="text-xs text-slate-400 italic pl-2">No drafts started yet.</p> : (
                    <>
                      {/* LATEST DRAFT */}
                      {latestDraft && (
                         <div className="bg-orange-50/50 border border-orange-200 rounded-lg p-4 shadow-sm relative overflow-hidden group">
                           <div className="absolute top-0 right-0 bg-orange-500 text-white text-[9px] font-bold px-2 py-0.5 rounded-bl-lg uppercase tracking-wider">Latest Revision</div>
                           <div className="flex items-center justify-between relative z-10">
                              <div className="flex items-center space-x-4 min-w-0">
                                <div className="p-2.5 bg-orange-100 text-orange-600 rounded-lg">
                                  <FileText className="w-6 h-6" />
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm font-bold text-slate-900 truncate hover:text-orange-700 transition-colors cursor-pointer" onClick={() => setViewerFile(latestDraft)}>{latestDraft.name}</p>
                                  <div className="flex items-center text-xs text-slate-500 mt-0.5 space-x-2">
                                     <span>{latestDraft.size}</span>
                                     <span className="w-1 h-1 rounded-full bg-slate-300"/>
                                     <span>{toDate(latestDraft.uploadedAt).toLocaleString()}</span>
                                     <span className="w-1 h-1 rounded-full bg-slate-300"/>
                                     <span className="text-orange-600 font-medium">Current Version</span>
                                  </div>
                                </div>
                              </div>
                              <div className="flex items-center space-x-2">
                                {(ticket.status === 'PENDING_REVIEW' && ticket.requesterId === uid) && (
                                   <button 
                                     onClick={() => { setFileToRedline(latestDraft); setShowRedlineEditor(true); }}
                                     className="px-3 py-1.5 rounded-lg font-bold text-xs flex items-center bg-white border border-orange-200 text-orange-600 hover:bg-orange-600 hover:text-white transition-all shadow-sm"
                                   >
                                     <Pen className="w-3 h-3 mr-1.5"/> Redline
                                   </button>
                                )}
                                <button onClick={() => setViewerFile(latestDraft)} className="p-2 text-slate-400 hover:text-orange-600 hover:bg-orange-100 rounded-lg transition-colors"><Eye className="w-5 h-5" /></button>
                              </div>
                           </div>
                         </div>
                      )}

                      {/* PREVIOUS VERSIONS */}
                      {previousDrafts.length > 0 && (
                        <div className="space-y-3 pt-2">
                          <div className="flex items-center gap-3">
                            <div className="h-px bg-slate-200 flex-1"/>
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Previous Versions</span>
                            <div className="h-px bg-slate-200 flex-1"/>
                          </div>
                          <div className="grid grid-cols-1 gap-2">
                            {previousDrafts.map((file, idx) => (
                              <div key={idx} className="flex items-center justify-between bg-white p-2.5 rounded-lg border border-slate-100 text-slate-400 hover:border-slate-300 hover:text-slate-600 transition-all opacity-80 hover:opacity-100">
                                 <div className="flex items-center space-x-3 min-w-0">
                                   <FileIcon className="w-4 h-4 shrink-0" />
                                   <div className="min-w-0">
                                      <p className="text-xs font-medium truncate decoration-slate-300">{file.name}</p>
                                      <p className="text-xs opacity-70">{toDate(file.uploadedAt).toLocaleString()}</p>
                                   </div>
                                 </div>
                                 <button onClick={() => setViewerFile(file)} className="p-1.5 hover:bg-slate-100 rounded"><Eye className="w-3.5 h-3.5" /></button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                 )}
               </div>
             </div>

             <div className={`p-4 ${['FINAL_DRAFT', 'PENDING_FINAL_APPROVAL', 'CLOSED'].includes(ticket.status) ? 'bg-teal-50 order-2 border-b border-teal-100 shadow-sm relative overflow-hidden' : 'bg-teal-50/30 order-3'}`}>
               <h3 className={`text-[10px] font-bold uppercase tracking-widest mb-3 flex items-center ${['FINAL_DRAFT', 'PENDING_FINAL_APPROVAL', 'CLOSED'].includes(ticket.status) ? 'text-teal-800' : 'text-teal-700'}`}><CheckCircle2 className="w-3 h-3 mr-1" /> Final Issued Deliverables</h3>
               <div className="space-y-2 relative z-10">
                 {finalFiles.length === 0 ? <div className="text-center py-6 text-slate-400 text-xs border-2 border-dashed border-slate-200 rounded-lg">Nothing issued for construction yet.</div> : finalFiles.map((file, idx) => (
                   <div key={idx} className={`flex items-center justify-between bg-white p-3 rounded-lg border shadow-sm ${['FINAL_DRAFT', 'PENDING_FINAL_APPROVAL', 'CLOSED'].includes(ticket.status) ? 'border-teal-300 ring-1 ring-teal-100' : 'border-teal-200'}`}>
                     <div className="flex items-center space-x-4 min-w-0">
                       <div className="p-2 bg-teal-100 text-teal-700 rounded"><CheckSquare className="w-5 h-5" /></div>
                       <div className="min-w-0">
                         <p className="text-sm font-bold text-slate-900 truncate">{file.name}</p>
                         <p className="text-xs text-teal-600 font-semibold">ISSUED: {toDate(file.uploadedAt).toLocaleDateString()}</p>
                         {['FINAL_DRAFT', 'PENDING_FINAL_APPROVAL', 'CLOSED'].includes(ticket.status) && <span className="inline-block mt-1 px-2 py-0.5 bg-teal-600 text-white text-[9px] font-bold rounded uppercase tracking-wider shadow-sm">Issued For Construction</span>}
                       </div>
                     </div>
                     <button onClick={() => setViewerFile(file)} className="p-2 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded"><Maximize2 className="w-4 h-4" /></button>
                   </div>
                 ))}
               </div>
             </div>
          </div>
        </div>

        {/* RIGHT: ACTIVITY */}
        <div className="h-[calc(100vh-140px)] flex flex-col bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden sticky top-24">
          <div className="flex items-center border-b border-slate-200 bg-slate-50"><button onClick={() => setActiveTab('discussion')} className={`flex-1 py-3 text-xs font-bold transition-all ${activeTab === 'discussion' ? 'text-slate-800 border-b-2 border-orange-500 bg-white' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100/50'}`}>Discussion</button><button onClick={() => setActiveTab('audit')} className={`flex-1 py-3 text-xs font-bold transition-all ${activeTab === 'audit' ? 'text-slate-800 border-b-2 border-orange-500 bg-white' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100/50'}`}>Audit Log</button></div>
          <div ref={chatContainerRef} className="flex-1 overflow-y-auto p-4 space-y-6 bg-slate-50/30 custom-scrollbar relative">
            {activeTab === 'discussion' && (
              <>
                {(!ticket.comments || ticket.comments.length === 0) && <div className="absolute inset-0 flex flex-col items-center justify-center opacity-40 pointer-events-none"><MessageSquare className="w-12 h-12 text-slate-300 mb-2" /><p className="text-sm text-slate-400 font-medium">No comments yet</p></div>}
                {ticket.comments?.map((comment, idx) => (
                  <div key={`${comment.id}-${idx}`} className={`flex flex-col ${comment.user === userEmail ? 'items-end' : 'items-start'} animate-in slide-in-from-bottom-2`}>
                    <div className="flex items-end gap-2 max-w-[90%]">
                       {comment.user !== userEmail && <div className="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center text-[10px] font-bold text-slate-500 shrink-0 mb-1">{comment.user.charAt(0).toUpperCase()}</div>}
                       <div className={`rounded-2xl p-3.5 shadow-sm text-sm relative group ${comment.type === 'Rejection' || comment.type === 'Revision' ? 'bg-amber-50 border border-amber-200 text-amber-900 rounded-bl-none' : comment.type === 'Approval' ? 'bg-green-50 border border-green-100 text-green-900 rounded-bl-none' : comment.user === userEmail ? 'bg-blue-600 text-white rounded-br-none shadow-blue-900/10' : 'bg-white border border-slate-200 text-slate-800 rounded-bl-none'}`}>
                          
                          {/* HEADER: Type & Category */}
                          {comment.type !== 'General' && (
                            <div className={`text-[10px] font-bold uppercase mb-1.5 flex items-center justify-between ${comment.user === userEmail ? 'opacity-80' : 'opacity-60'} ${comment.type === 'Reassignment' ? 'text-orange-600 border-b border-orange-100 pb-1 italic' : ''}`}>
                              <div className="flex items-center">
                                {comment.type === 'Rejection' || comment.type === 'Revision' ? <AlertTriangle className="w-3 h-3 mr-1" /> : 
                                 comment.type === 'Reassignment' ? <UserPlus className="w-3 h-3 mr-1" /> :
                                 <CheckCircle2 className="w-3 h-3 mr-1" />}
                                
                                {comment.type === 'Rejection' || comment.type === 'Revision' ? 'Revision Requested' : 
                                 comment.type === 'Reassignment' ? 'Reassigned' : 
                                 comment.type}
                              </div>
                              
                              {/* ADMIN OVERRIDE CONTROLS */}
                              {(comment.type === 'Rejection' || comment.type === 'Revision') && (
                                <div className="ml-2">
                                  {editingCommentId === comment.id ? (
                                    <div className="flex items-center space-x-1" onClick={(e) => e.stopPropagation()}>
                                       <select 
                                         value={editCategoryVal} 
                                         onChange={(e) => setEditCategoryVal(e.target.value)}
                                         className="text-[10px] p-1 rounded border border-slate-300 text-slate-700 bg-white focus:ring-1 focus:ring-orange-500"
                                       >
                                         {REVISION_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                                       </select>
                                       <button onClick={() => handleUpdateCategory(comment.id)} className="p-1 bg-green-500 text-white rounded hover:bg-green-600"><Check className="w-3 h-3" /></button>
                                       <button onClick={() => setEditingCommentId(null)} className="p-1 bg-slate-300 text-slate-600 rounded hover:bg-slate-400"><X className="w-3 h-3" /></button>
                                    </div>
                                  ) : (
                                    <div className="flex items-center">
                                      <span className="bg-white/50 px-1.5 py-0.5 rounded text-[9px] border border-black/10 mr-1">
                                        {comment.category || 'Uncategorized'}
                                      </span>
                                      {isAdmin && (
                                        <button 
                                          onClick={() => { setEditingCommentId(comment.id); setEditCategoryVal(comment.category || REVISION_REASONS[0]); }} 
                                          className="p-1 hover:bg-black/10 rounded transition-colors"
                                          title="Edit Root Cause"
                                        >
                                          <Pen className="w-3 h-3" />
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}

                          <p className="whitespace-pre-wrap leading-relaxed">{comment.text}</p>
                          <div className="absolute -bottom-5 right-0 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-slate-400 whitespace-nowrap">{toDate(comment.date).toLocaleString()}</div>
                       </div>
                    </div>
                  </div>
                ))}
              </>
            )}
            {activeTab === 'audit' && (
              <div className="space-y-6 pl-2">
                 {ticket.history?.map((event, idx) => (
                   <div key={`history-${idx}`} className="flex gap-4 relative animate-in fade-in slide-in-from-left-2">
                     {idx !== (ticket.history?.length || 0) - 1 && <div className="absolute left-[11px] top-8 bottom-[-24px] w-0.5 bg-slate-200" />}
                     <div className="relative z-10"><div className="w-6 h-6 rounded-full bg-white border-2 border-slate-200 flex items-center justify-center"><div className="w-2 h-2 rounded-full bg-slate-400" /></div></div>
                     <div className="flex-1 pb-1">
                       <div className="flex items-center justify-between"><span className="text-xs font-bold text-slate-900">{event.action.replace(/_/g, ' ')}</span><span className="text-[10px] text-slate-400 font-mono">{toDate(event.date).toLocaleDateString()}</span></div>
                       <p className="text-xs text-slate-500 mt-0.5">by <span className="font-semibold text-slate-700">{event.user?.split('@')[0]}</span></p>
                       {event.details && <div className="mt-2 text-xs bg-slate-50 border border-slate-100 p-2 rounded text-slate-600 italic">"{event.details}"</div>}
                     </div>
                   </div>
                 ))}
                 {(!ticket.history || ticket.history.length === 0) && <div className="text-center py-8 text-slate-400 text-xs italic">No history recorded yet.</div>}
              </div>
            )}
          </div>
          {activeTab === 'discussion' && (
            <div className="p-4 bg-white border-t border-slate-200">
              <div className="relative group">
                <textarea className="w-full pl-4 pr-12 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-orange-500 focus:bg-white outline-none resize-none custom-scrollbar transition-all shadow-inner" rows={3} placeholder="Type a comment..." value={newComment} onChange={(e) => setNewComment(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePostComment(newComment); } }} />
                <button onClick={() => handlePostComment(newComment)} disabled={!newComment.trim()} className="absolute right-2 bottom-2 p-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 disabled:hover:bg-orange-600 transition-all shadow-md shadow-orange-900/20"><Send className="w-4 h-4" /></button>
              </div>
              <p className="text-[10px] text-slate-400 mt-2 text-center"><span className="font-bold">Enter</span> to send • <span className="font-bold">Shift+Enter</span> for new line</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
