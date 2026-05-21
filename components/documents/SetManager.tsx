"use client";

import React, { useState, useEffect } from 'react';
import { 
  X, Plus, Layers, 
  Trash2, BookOpen, CheckCircle2,
  AlertCircle, Loader2, Search
} from 'lucide-react';
import { 
  collection, query, where, getDocs, addDoc, 
  updateDoc, doc, serverTimestamp 
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { DocumentSet, DocumentRecord } from '@/types/schema';

interface SetManagerProps {
  isOpen: boolean;
  onClose: () => void;
  libraryId: string;
}

export default function SetManager({ isOpen, onClose, libraryId }: SetManagerProps) {
  // Data State
  const [sets, setSets] = useState<DocumentSet[]>([]);
  const [activeSet, setActiveSet] = useState<DocumentSet | null>(null);
  const [setDocs, setSetDocs] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [docsLoading, setDocsLoading] = useState(false);

  // UI State
  const [mode, setMode] = useState<'list' | 'create' | 'edit'>('list');
  const [inputValue, setInputValue] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<DocumentRecord[]>([]);

  // --- 1. INITIAL LOAD ---
  useEffect(() => {
    if (isOpen) fetchSets();
  }, [isOpen, libraryId]);

  const fetchSets = async () => {
    setLoading(true);
    try {
      const q = query(collection(db, 'documentSets'), where('libraryId', '==', libraryId));
      const snap = await getDocs(q);
      setSets(snap.docs.map(d => ({ id: d.id, ...d.data() } as DocumentSet)));
    } catch (e) {
      console.error("Failed to load sets", e);
    } finally {
      setLoading(false);
    }
  };

  // --- 2. LOAD BINDER CONTENT ---
  const selectSet = async (set: DocumentSet) => {
    setActiveSet(set);
    setMode('edit');
    setDocsLoading(true);
    try {
      // Fetch documents linked to this Set
      const q = query(collection(db, 'documents'), where('setId', '==', set.id));
      const snap = await getDocs(q);
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() } as DocumentRecord));
      // Sort by Sheet Number
      setSetDocs(docs.sort((a, b) => (a.sheetNumber || 0) - (b.sheetNumber || 0)));
    } catch (e) {
      console.error(e);
    } finally {
      setDocsLoading(false);
    }
  };

  // --- 3. ACTIONS ---
  const handleCreateSet = async () => {
    if (!inputValue) return;
    try {
      const newSet = {
        title: inputValue,
        libraryId,
        currentSetRev: '0',
        sheetCount: 0,
        assetIndex: {},
        updatedAt: serverTimestamp()
      };
      await addDoc(collection(db, 'documentSets'), newSet);
      setInputValue('');
      setMode('list');
      fetchSets();
    } catch (e) {
      alert("Failed to create set");
    }
  };

  const handleSearchDocs = async (term: string) => {
    setSearchTerm(term);
    if (term.length < 3) return;
    try {
      const q = query(
        collection(db, 'documents'), 
        where('libraryId', '==', libraryId),
        where('documentNumber', '>=', term.toUpperCase()),
        where('documentNumber', '<=', term.toUpperCase() + '\uf8ff')
      );
      const snap = await getDocs(q);
      setSearchResults(snap.docs.map(d => ({ id: d.id, ...d.data() } as DocumentRecord)));
    } catch (e) { console.error(e); }
  };

  const addToSet = async (docRecord: DocumentRecord) => {
    if (!activeSet?.id || !docRecord.id) return;
    try {
      const newSheetNum = setSetDocs.length + 1;
      await updateDoc(doc(db, 'documents', docRecord.id), {
        setId: activeSet.id,
        sheetNumber: newSheetNum,
        sheetTotal: (activeSet.sheetCount || 0) + 1
      });
      // Update Set Count
      await updateDoc(doc(db, 'documentSets', activeSet.id), {
        sheetCount: (activeSet.sheetCount || 0) + 1
      });
      
      // Refresh local view
      setActiveSet({ ...activeSet, sheetCount: (activeSet.sheetCount || 0) + 1 });
      setSetDocs(prev => [...prev, { ...docRecord, sheetNumber: newSheetNum }]);
      setSearchTerm('');
      setSearchResults([]);
    } catch (e) {
      alert("Failed to add document to set");
    }
  };

  const removeFromSet = async (docRecord: DocumentRecord) => {
    if (!activeSet || !docRecord.id) return;
    try {
      await updateDoc(doc(db, 'documents', docRecord.id), {
        setId: null,
        sheetNumber: null,
        sheetTotal: null
      }); // Note: In High Fidelity, we should re-sequence remaining sheets here.
      setSetDocs(prev => prev.filter(d => d.id !== docRecord.id));
    } catch (e) { alert("Remove failed"); }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-4xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col h-[80vh]">
        
        {/* HEADER */}
        <div className="h-16 border-b border-slate-200 flex items-center justify-between px-6 bg-slate-50/50 shrink-0">
          <div className="flex items-center">
            <BookOpen className="w-5 h-5 mr-3 text-blue-600" />
            <div>
              <h2 className="text-lg font-bold text-slate-900">Binder Management</h2>
              <p className="text-xs text-slate-500 font-medium">Manage Document Sets & P&ID Packs</p>
            </div>
          </div>
          <button onClick={onClose}><X className="w-5 h-5 text-slate-400 hover:text-slate-600" /></button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          
          {/* LEFT SIDEBAR: SET LIST */}
          <div className="w-72 border-r border-slate-200 bg-slate-50 flex flex-col">
            <div className="p-4 border-b border-slate-200">
              <button 
                onClick={() => setMode('create')}
                className="w-full py-2 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 flex items-center justify-center"
              >
                <Plus className="w-3 h-3 mr-2" /> New Binder
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {loading && (
                <div className="p-3 text-xs text-slate-400">Loading binders...</div>
              )}
              {sets.map(set => (
                <div 
                  key={set.id}
                  onClick={() => selectSet(set)}
                  className={`p-3 rounded-lg cursor-pointer border transition-all ${activeSet?.id === set.id ? 'bg-white border-blue-200 shadow-sm ring-1 ring-blue-100' : 'bg-transparent border-transparent hover:bg-slate-100'}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-sm text-slate-700 truncate">{set.title}</span>
                    <span className="text-[10px] bg-slate-200 px-1.5 rounded text-slate-600">Rev {set.currentSetRev}</span>
                  </div>
                  <div className="flex items-center text-xs text-slate-400">
                    <Layers className="w-3 h-3 mr-1" /> {set.sheetCount || 0} Sheets
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* RIGHT PANEL: CONTENT */}
          <div className="flex-1 flex flex-col bg-white relative">
            
            {/* CREATE MODE */}
            {mode === 'create' && (
              <div className="flex flex-col items-center justify-center h-full p-10">
                <div className="w-full max-w-sm">
                  <h3 className="text-lg font-bold text-slate-900 mb-4">Create New Document Set</h3>
                  <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">Set Title</label>
                  <input 
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    className="w-full p-3 border border-slate-200 rounded-lg mb-4 focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="e.g. Unit 100 P&ID Master Set"
                    autoFocus
                  />
                  <div className="flex space-x-2">
                    <button onClick={() => setMode('list')} className="flex-1 py-3 border rounded-lg font-bold text-sm text-slate-600">Cancel</button>
                    <button onClick={handleCreateSet} className="flex-1 py-3 bg-blue-600 text-white rounded-lg font-bold text-sm">Create</button>
                  </div>
                </div>
              </div>
            )}

            {/* EDIT MODE */}
            {mode === 'edit' && activeSet && (
              <div className="flex flex-col h-full">
                {/* TOOLBAR */}
                <div className="h-14 border-b border-slate-100 flex items-center justify-between px-6 shrink-0">
                  <h3 className="font-bold text-slate-800">{activeSet.title} <span className="text-slate-400 font-normal ml-2">Table of Contents</span></h3>
                  <div className="relative group">
                    <div className="flex items-center border border-slate-200 rounded-lg px-3 py-1.5 bg-slate-50 focus-within:bg-white focus-within:ring-2 ring-blue-100 transition-all">
                      <Search className="w-4 h-4 text-slate-400 mr-2" />
                      <input 
                        className="bg-transparent outline-none text-sm w-64" 
                        placeholder="Search to add sheet..." 
                        value={searchTerm}
                        onChange={(e) => handleSearchDocs(e.target.value)}
                      />
                    </div>
                    {/* DROPDOWN RESULTS */}
                    {searchResults.length > 0 && (
                      <div className="absolute top-full right-0 w-80 bg-white border border-slate-200 rounded-lg shadow-xl mt-2 p-1 z-50">
                        {searchResults.map(res => (
                          <div key={res.id} onClick={() => addToSet(res)} className="p-2 hover:bg-blue-50 rounded cursor-pointer flex justify-between items-center group">
                            <div className="flex flex-col truncate">
                              <span className="text-xs font-bold text-slate-700">{res.documentNumber}</span>
                              <span className="text-[10px] text-slate-400 truncate w-48">{res.title}</span>
                            </div>
                            <Plus className="w-4 h-4 text-slate-400 group-hover:text-blue-500" />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* SHEET GRID */}
                <div className="flex-1 overflow-y-auto p-6 bg-slate-50/30">
                  {docsLoading ? (
                    <div className="flex justify-center p-10"><Loader2 className="w-8 h-8 animate-spin text-slate-300" /></div>
                  ) : setDocs.length === 0 ? (
                    <div className="text-center p-10 border-2 border-dashed border-slate-200 rounded-xl">
                      <Layers className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                      <p className="text-slate-500 font-bold">Binder is Empty</p>
                      <p className="text-slate-400 text-xs">Search documents above to add them to this set.</p>
                    </div>
                  ) : (
                    <table className="w-full text-left">
                      <thead className="text-xs font-bold text-slate-400 uppercase border-b border-slate-200">
                        <tr>
                          <th className="px-4 py-2 w-16">Seq</th>
                          <th className="px-4 py-2">Document</th>
                          <th className="px-4 py-2 w-20">Rev</th>
                          <th className="px-4 py-2 w-24">Status</th>
                          <th className="px-4 py-2 w-16"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {setDocs.map((doc, idx) => (
                          <tr key={doc.id} className="bg-white hover:bg-slate-50 transition-colors">
                            <td className="px-4 py-3">
                              <div className="w-8 h-8 rounded bg-slate-100 flex items-center justify-center font-mono font-bold text-slate-600 text-xs border border-slate-200">
                                {idx + 1}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex flex-col">
                                <span className="text-sm font-bold text-slate-800">{doc.documentNumber}</span>
                                <span className="text-xs text-slate-500">{doc.title}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded text-xs font-bold border border-blue-100">{doc.rev}</span>
                            </td>
                            <td className="px-4 py-3">
                              {doc.status === 'Locked' ? <span className="text-red-500 text-xs font-bold flex items-center"><AlertCircle className="w-3 h-3 mr-1" /> Locked</span> : <span className="text-green-600 text-xs font-bold flex items-center"><CheckCircle2 className="w-3 h-3 mr-1" /> Active</span>}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <button onClick={() => removeFromSet(doc)} className="p-2 text-slate-300 hover:text-red-500 transition-colors"><Trash2 className="w-4 h-4" /></button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            )}

            {mode === 'list' && (
              <div className="h-full flex flex-col items-center justify-center text-slate-400">
                <BookOpen className="w-16 h-16 mb-4 opacity-20" />
                <p>Select a Binder to View Contents</p>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}
