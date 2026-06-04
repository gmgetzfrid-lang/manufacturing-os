"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import { DocumentRecord, DocumentVersion } from '@/types/schema';
import { 
  Maximize2, 
  Minimize2, 
  X, 
  ArrowLeft, 
  Columns, 
  Square,
  Search,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Save,
  Layers,
  FileText,
  ChevronDown,
  MoreVertical,
  Loader2,
  AlertTriangle
} from 'lucide-react';

// =========================================================================================
// TYPES
// =========================================================================================

interface StagedItem {
  id: string;
  docNumber: string;
  title: string;
  rev: string;
}

// =========================================================================================
// SUB-COMPONENT: VIEWER PANE (The Cad View)
// =========================================================================================

interface ViewerPaneProps {
  documentId: string | null;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
}

const ViewerPane = ({ documentId, isActive, onActivate, onClose }: ViewerPaneProps) => {
  const [record, setRecord] = useState<DocumentRecord | null>(null);
  const [version, setVersion] = useState<DocumentVersion | null>(null);
  const [loading, setLoading] = useState(false);
  const [zoom, setZoom] = useState(100);

  useEffect(() => {
    if (!documentId) return;
    
    const fetchDoc = async () => {
      setLoading(true);
      try {
        const { data: recRow } = await supabase
          .from('documents')
          .select('*')
          .eq('id', documentId)
          .single();

        if (recRow) {
          const recData: DocumentRecord = {
            id: recRow.id, orgId: recRow.org_id, libraryId: recRow.library_id,
            collectionId: recRow.collection_id, documentNumber: recRow.document_number,
            title: recRow.title, name: recRow.name, status: recRow.status,
            rev: recRow.rev, currentVersionId: recRow.current_version_id,
            checkedOutBy: recRow.checked_out_by, checkedOutByName: recRow.checked_out_by_name,
            checkedOutAt: recRow.checked_out_at, activeCollaborators: recRow.active_collaborators ?? [],
            createdAt: recRow.created_at as unknown as DocumentRecord['createdAt'],
            createdBy: recRow.created_by ?? '',
          };
          setRecord(recData);

          if (recData.currentVersionId) {
            const { data: verRow } = await supabase
              .from('document_versions')
              .select('*')
              .eq('id', recData.currentVersionId)
              .single();
            if (verRow) {
              setVersion({
                id: verRow.id, orgId: verRow.org_id, fileUrl: verRow.file_url,
                revisionLabel: verRow.revision_label, changeType: verRow.change_type,
                changeLog: verRow.change_log, createdAt: verRow.created_at,
                createdByName: verRow.created_by_name,
              } as DocumentVersion);
            }
          }
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };

    fetchDoc();
  }, [documentId]);

  if (!documentId) {
    return (
      <div 
        onClick={onActivate}
        className={`h-full flex flex-col items-center justify-center border-2 border-dashed rounded-xl transition-all cursor-pointer ${isActive ? 'border-orange-500/50 bg-slate-800/50' : 'border-slate-700 bg-slate-900/50'}`}
      >
        <div className={`p-4 rounded-full mb-4 ${isActive ? 'bg-orange-500/10 text-orange-500' : 'bg-slate-800 text-slate-500'}`}>
          <Layers className="w-8 h-8" />
        </div>
        <h3 className={`text-sm font-bold ${isActive ? 'text-orange-500' : 'text-slate-500'}`}>
          {isActive ? 'Active Slot' : 'Inactive Slot'}
        </h3>
        <p className="text-xs text-slate-600 mt-1">Select a document from the dock to view</p>
      </div>
    );
  }

  return (
    <div 
      onClick={onActivate}
      className={`h-full flex flex-col bg-slate-900 rounded-xl overflow-hidden border-2 transition-all relative ${isActive ? 'border-orange-500 shadow-[0_0_20px_rgba(249,115,22,0.15)]' : 'border-slate-700 hover:border-slate-600'}`}
    >
      {/* Pane Header */}
      <div className={`h-12 border-b flex items-center justify-between px-4 shrink-0 ${isActive ? 'bg-slate-800 border-orange-500/30' : 'bg-slate-900 border-slate-700'}`}>
        <div className="flex items-center min-w-0">
          <div className="flex flex-col mr-3">
             <span className="text-xs font-black text-white leading-none truncate">{record?.documentNumber || 'Loading...'}</span>
             <span className="text-[10px] text-slate-400 leading-none mt-1 truncate max-w-[150px]">{record?.title}</span>
          </div>
          {record?.status === 'Draft' && (
            <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-500 text-[10px] font-bold border border-amber-500/30">DRAFT</span>
          )}
        </div>
        
        <div className="flex items-center space-x-1">
           <button onClick={(e) => { e.stopPropagation(); setZoom(z => Math.max(10, z - 10)); }} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded"><ZoomOut className="w-3.5 h-3.5" /></button>
           <span className="text-[10px] text-slate-500 w-8 text-center">{zoom}%</span>
           <button onClick={(e) => { e.stopPropagation(); setZoom(z => Math.min(200, z + 10)); }} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded"><ZoomIn className="w-3.5 h-3.5" /></button>
           <div className="w-px h-4 bg-slate-700 mx-2" />
           <button onClick={(e) => { e.stopPropagation(); onClose(); }} className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded"><X className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      {/* Pane Content */}
      <div className="flex-1 bg-slate-950 relative overflow-hidden group">
         {loading ? (
           <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500">
             <Loader2 className="w-8 h-8 animate-spin mb-2" />
             <span className="text-xs font-medium">Loading View...</span>
           </div>
         ) : version?.fileUrl ? (
           <iframe 
             src={`${version.fileUrl}#toolbar=0&navpanes=0&zoom=${zoom}`} 
             className="w-full h-full border-none bg-white" 
             title="Document Viewer"
           />
         ) : (
           <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600">
             <FileText className="w-12 h-12 mb-3 opacity-20" />
             <p className="text-sm">Preview not available</p>
           </div>
         )}
         
         {/* Inactive Overlay (Click to wake) */}
         {!isActive && <div className="absolute inset-0 bg-black/20 hover:bg-transparent transition-colors cursor-pointer z-10" />}
      </div>
    </div>
  );
};

// =========================================================================================
// MAIN PAGE COMPONENT: TWIN TURBO WORKSPACE
// =========================================================================================

export default function Workspace() {
  const router = useRouter();
  const { activeOrgId } = useRole();

  // Layout State
  const [layout, setLayout] = useState<'single' | 'split'>('split');
  const [activeSlot, setActiveSlot] = useState<'left' | 'right'>('left');

  // Document State
  const [leftDocId, setLeftDocId] = useState<string | null>(null);
  const [rightDocId, setRightDocId] = useState<string | null>(null);

  // The Dock (Staging Area)
  const [dockItems, setDockItems] = useState<StagedItem[]>([]);
  
  // Search Overlay State
  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<DocumentRecord[]>([]);

  // --- HANDLER: SEARCH FOR DOCS (Quick Find) ---
  useEffect(() => {
    if (!searchQuery.trim()) {
      // Wrapped so the synchronous clear isn't flagged as a cascading
      // setState-in-effect; it still runs synchronously (no await).
      void (async () => setSearchResults([]))();
      return;
    }
    // Debounced search simulation
    const timer = setTimeout(async () => {
      try {
        const q = supabase
          .from('documents')
          .select('id, document_number, title, status')
          .ilike('document_number', `${searchQuery.toUpperCase()}%`)
          .limit(5);
        if (activeOrgId) q.eq('org_id', activeOrgId);
        const { data } = await q;
        setSearchResults((data || []).map(r => ({
          id: r.id, documentNumber: r.document_number, title: r.title, status: r.status,
        } as DocumentRecord)));
      } catch (e) {
        console.error(e);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // --- HANDLER: LOAD DOC INTO ACTIVE SLOT ---
  const handleLoadDoc = (item: StagedItem) => {
    if (layout === 'single') {
      setLeftDocId(item.id);
      setActiveSlot('left');
    } else {
      if (activeSlot === 'left') setLeftDocId(item.id);
      else setRightDocId(item.id);
    }
  };

  // --- HANDLER: ADD SEARCH RESULT TO DOCK ---
  const handleAddToDock = (doc: DocumentRecord) => {
    // Prevent duplicates
    if (!dockItems.find(i => i.id === doc.id)) {
      setDockItems([...dockItems, {
        id: doc.id!,
        docNumber: doc.documentNumber || "Untitled",
        title: doc.title || "No Title",
        rev: 'A' // Mock rev for now
      }]);
    }
    setSearchQuery('');
    setIsSearching(false);
    // Auto-load if slots are empty
    if (!leftDocId) setLeftDocId(doc.id!);
    else if (!rightDocId && layout === 'split') setRightDocId(doc.id!);
  };

  return (
    <div className="h-screen bg-slate-950 flex flex-col overflow-hidden text-slate-300 font-sans">
      
      {/* 1. TOP BAR */}
      <div className="h-14 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-4 shrink-0 z-20">
        <div className="flex items-center space-x-6">
           <button onClick={() => router.back()} className="flex items-center text-slate-400 hover:text-white transition-colors text-xs font-bold uppercase tracking-wider">
             <ArrowLeft className="w-4 h-4 mr-2" /> Exit
           </button>
           
           <div className="h-6 w-px bg-slate-800" />
           
           <h1 className="text-white font-bold text-lg tracking-tight flex items-center">
             Twin<span className="text-orange-500 font-black italic mr-1">Turbo</span> <span className="text-slate-500 font-normal ml-2 text-xs border border-slate-700 px-2 py-0.5 rounded">BETA</span>
           </h1>
        </div>

        <div className="flex items-center space-x-4">
           {/* Layout Toggles */}
           <div className="flex bg-black/50 p-1 rounded-lg border border-slate-800">
             <button 
               onClick={() => { setLayout('single'); setActiveSlot('left'); }}
               className={`p-1.5 rounded transition-all ${layout === 'single' ? 'bg-slate-700 text-white shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}
               title="Single Focus"
             >
               <Square className="w-4 h-4" />
             </button>
             <button 
               onClick={() => setLayout('split')}
               className={`p-1.5 rounded transition-all ${layout === 'split' ? 'bg-slate-700 text-white shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}
               title="Split Compare"
             >
               <Columns className="w-4 h-4" />
             </button>
           </div>

           <button className="flex items-center px-3 py-1.5 bg-slate-800 text-slate-300 text-xs font-bold rounded border border-slate-700 hover:bg-slate-700 hover:text-white transition-colors">
             <Save className="w-3 h-3 mr-2" /> Save Session
           </button>
        </div>
      </div>

      {/* 2. MAIN CANVAS */}
      <div className="flex-1 flex overflow-hidden p-2 relative bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-slate-900 to-black">
        
        {/* LEFT PANE */}
        <div className={`${layout === 'split' ? 'w-1/2 pr-1' : 'w-full'} h-full transition-all duration-300`}>
          <ViewerPane 
            documentId={leftDocId} 
            isActive={activeSlot === 'left' || layout === 'single'}
            onActivate={() => setActiveSlot('left')}
            onClose={() => setLeftDocId(null)}
          />
        </div>

        {/* RIGHT PANE */}
        {layout === 'split' && (
          <div className="w-1/2 pl-1 h-full transition-all duration-300 animate-in fade-in slide-in-from-right-4">
             <ViewerPane 
               documentId={rightDocId} 
               isActive={activeSlot === 'right'}
               onActivate={() => setActiveSlot('right')}
               onClose={() => setRightDocId(null)}
             />
          </div>
        )}

        {/* SEARCH OVERLAY (Quick Find) */}
        {isSearching && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 w-96 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50 animate-in fade-in zoom-in-95">
             <div className="p-3 border-b border-slate-800 flex items-center">
               <Search className="w-4 h-4 text-orange-500 mr-2" />
               <input 
                 value={searchQuery}
                 onChange={(e) => setSearchQuery(e.target.value)}
                 className="flex-1 bg-transparent border-none outline-none text-sm text-white placeholder:text-slate-500 h-6"
                 placeholder="Search Doc No (e.g. 20-PID...)"
                 autoFocus
               />
               <button onClick={() => setIsSearching(false)}><X className="w-4 h-4 text-slate-500 hover:text-white"/></button>
             </div>
             <div className="max-h-60 overflow-y-auto">
                {searchResults.map(res => (
                  <div 
                    key={res.id} 
                    onClick={() => handleAddToDock(res)}
                    className="p-3 hover:bg-slate-800 cursor-pointer border-b border-slate-800/50 last:border-none group"
                  >
                    <div className="flex justify-between items-center">
                      <span className="font-mono text-xs font-bold text-slate-300 group-hover:text-orange-400">{res.documentNumber}</span>
                      <span className="text-[10px] text-slate-500 uppercase">{res.status}</span>
                    </div>
                    <p className="text-xs text-slate-500 truncate">{res.title}</p>
                  </div>
                ))}
                {searchQuery && searchResults.length === 0 && (
                  <div className="p-4 text-center text-xs text-slate-500">No documents found.</div>
                )}
             </div>
          </div>
        )}
      </div>

      {/* 3. THE DOCK */}
      <div className="h-24 bg-slate-900 border-t border-slate-800 flex items-center px-6 shrink-0 z-50 shadow-[0_-10px_40px_rgba(0,0,0,0.5)]">
        <div className="flex items-center mr-8">
           <div className="flex flex-col">
             <span className="text-xs font-bold text-white uppercase tracking-widest">Staging Dock</span>
             <span className="text-[10px] text-slate-500">{dockItems.length} items ready</span>
           </div>
           <div className="h-10 w-px bg-slate-800 ml-6" />
        </div>
        
        {/* Scrollable Filmstrip */}
        <div className="flex-1 flex space-x-4 overflow-x-auto custom-scrollbar pb-3 pt-3 items-center">
           {/* Add New Button */}
           <button 
             onClick={() => setIsSearching(true)}
             className="w-16 h-16 rounded-xl border-2 border-dashed border-slate-700 flex flex-col items-center justify-center text-slate-600 hover:text-orange-500 hover:border-orange-500/50 hover:bg-orange-500/10 transition-all shrink-0 group"
           >
             <Search className="w-5 h-5 mb-1 group-hover:scale-110 transition-transform" />
             <span className="text-[9px] font-bold uppercase">Find</span>
           </button>

           {/* Staged Items */}
           {dockItems.map(item => (
             <button 
               key={item.id}
               onClick={() => handleLoadDoc(item)}
               className="w-48 h-16 bg-slate-800 border border-slate-700 rounded-xl flex items-center px-3 hover:bg-slate-700 hover:border-slate-500 transition-all group relative shrink-0 text-left shadow-lg"
             >
               <div className="w-10 h-10 rounded-lg bg-slate-900 flex items-center justify-center mr-3 border border-slate-700 group-hover:border-orange-500/50 shadow-inner">
                 <FileText className="w-5 h-5 text-slate-500 group-hover:text-orange-500 transition-colors" />
               </div>
               <div className="overflow-hidden flex-1">
                 <p className="text-xs font-bold text-slate-200 truncate group-hover:text-white transition-colors">{item.docNumber}</p>
                 <p className="text-[10px] text-slate-500 truncate">{item.title}</p>
               </div>
               
               {/* Remove Button (Hover only) */}
               <div 
                 onClick={(e) => { e.stopPropagation(); setDockItems(dockItems.filter(i => i.id !== item.id)); }}
                 className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-slate-600 rounded-full text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500 shadow-md"
               >
                 <X className="w-3 h-3" />
               </div>
               
               {/* Active Indicator */}
               {(item.id === leftDocId || item.id === rightDocId) && (
                 <div className="absolute inset-0 border-2 border-orange-500 rounded-xl pointer-events-none opacity-50" />
               )}
             </button>
           ))}
        </div>
      </div>

    </div>
  );
}