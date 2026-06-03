"use client";
import { useToast } from "@/components/providers/ToastProvider";

import React, { useState, useEffect } from 'react';
import { 
  X, UploadCloud, 
  CheckCircle2, GitCommit, FileDiff, Loader2 
} from 'lucide-react';
import { DocumentRecord, AssetTag } from '@/types/schema';
import { analyzeRevisionImpact, supersedeSheet } from '@/lib/services/DocumentControl'; // From Iteration 2
import type { RevisionImpact } from '@/lib/services/DocumentControl';
import { useRole } from '@/components/providers/RoleContext';

interface RevisionWizardProps {
  isOpen: boolean;
  onClose: () => void;
  targetDoc: DocumentRecord;
  onSuccess: () => void;
}

// --- SUB-COMPONENTS FOR HIGH FIDELITY UI ---
type WizardStepProps = {
  number: string;
  title: string;
  active?: boolean;
  completed?: boolean;
};

const WizardStep = ({ number, title, active, completed }: WizardStepProps) => (
  <div className={`flex items-center ${active ? 'text-blue-600' : completed ? 'text-green-600' : 'text-slate-400'}`}>
    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border-2 mr-2 ${
      active ? 'border-blue-600 bg-blue-50' : 
      completed ? 'border-green-600 bg-green-50' : 'border-slate-200 bg-slate-50'
    }`}>
      {completed ? <CheckCircle2 className="w-4 h-4" /> : number}
    </div>
    <span className="text-sm font-bold">{title}</span>
    <div className="mx-4 h-px w-8 bg-slate-200" />
  </div>
);

export default function RevisionWizard({ isOpen, onClose, targetDoc, onSuccess }: RevisionWizardProps) {
  const { showToast } = useToast();
  const { uid, userEmail } = useRole();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [file, setFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  
  // Revision State
  type RevisionType = 'Major' | 'Minor' | 'Correction';
  type RevisionScope = 'Sheet' | 'Set';

  const [revType, setRevType] = useState<RevisionType>('Minor');
  const [scope, setScope] = useState<RevisionScope>('Sheet');
  const [reason, setReason] = useState('');
  const [nextRevCode, setNextRevCode] = useState('');

  // Impact Analysis State
  const [impact, setImpact] = useState<RevisionImpact | null>(null);
  const [detectedTags, setDetectedTags] = useState<AssetTag[]>([]);

  // 1. Initialize Wizard
  useEffect(() => {
    if (isOpen) {
      // Auto-calculate next revision logic (Simple incrementer for demo)
      const current = targetDoc.rev || '0';
      const isNumeric = !isNaN(Number(current));
      setNextRevCode(isNumeric ? String(Number(current) + 1) : String.fromCharCode(current.charCodeAt(0) + 1));
    }
  }, [isOpen, targetDoc]);

  // 2. Simulate Metadata Extraction (Item 5)
  // In a real app, this would parse the PDF text or read a sidecar CSV.
  const simulateExtraction = async (f: File) => {
    setIsLoading(true);
    // Mocking async extraction delay
    setTimeout(() => {
      // Mock detected tags based on filename for demo
      const mockTags: AssetTag[] = [
        { tag: 'P-101', type: 'Pump' },
        { tag: 'E-205', type: 'Exchanger' }
      ];
      setDetectedTags(mockTags);
      
      // Run Impact Analysis (Item 6 - Vision without Digging)
      const analysis = analyzeRevisionImpact(targetDoc.assetTags || [], mockTags);
      setImpact(analysis);
      
      setIsLoading(false);
      setStep(2);
    }, 1500);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      setFile(e.target.files[0]);
      simulateExtraction(e.target.files[0]);
    }
  };

  const handleSubmit = async () => {
    if (!file || !uid) return;
    setIsLoading(true);
    try {
      // Upload Logic would go here to get new URL
      const mockDownloadUrl = "https://mock-url.com/new-file.pdf"; 

      await supersedeSheet(
        uid,
        userEmail || uid || 'Unknown',
        targetDoc.id,
        mockDownloadUrl,
        detectedTags,
        {
          type: scope,
          newRevCode: nextRevCode,
          reason,
          changeType: revType
        }
      );
      onSuccess();
      onClose();
    } catch (e) {
      console.error(e);
      showToast({ type: "error", title: "Revision failed", message: (e as Error)?.message });
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* HEADER */}
        <div className="bg-slate-50 px-8 py-6 border-b border-slate-200 flex justify-between items-center">
          <div>
            <h2 className="text-xl font-bold text-slate-900 flex items-center">
              <GitCommit className="w-5 h-5 mr-2 text-blue-600" />
              Supersede Document
            </h2>
            <p className="text-xs text-slate-500 mt-1 font-medium">
              Revising <span className="font-mono text-slate-700">{targetDoc.documentNumber}</span> / Current Rev: <span className="bg-slate-200 px-1.5 rounded text-slate-800">{targetDoc.rev || '-'}</span>
            </p>
          </div>
          <button onClick={onClose}><X className="w-6 h-6 text-slate-400 hover:text-slate-600" /></button>
        </div>

        {/* PROGRESS BAR */}
        <div className="px-8 py-4 bg-white border-b border-slate-100 flex items-center">
          <WizardStep number="1" title="Upload" active={step === 1} completed={step > 1} />
          <WizardStep number="2" title="Analysis" active={step === 2} completed={step > 2} />
          <WizardStep number="3" title="Commit" active={step === 3} />
        </div>

        {/* BODY */}
        <div className="p-8 overflow-y-auto flex-1">
          
          {/* STEP 1: UPLOAD */}
          {step === 1 && (
            <div className="flex flex-col items-center justify-center h-64 border-2 border-dashed border-slate-300 rounded-xl hover:bg-slate-50 transition-colors relative">
              {isLoading ? (
                <div className="text-center">
                  <Loader2 className="w-10 h-10 text-blue-600 animate-spin mx-auto mb-4" />
                  <p className="text-sm font-bold text-slate-700">Scanning Document Metadata...</p>
                  <p className="text-xs text-slate-400">Extracting tags and checking sets</p>
                </div>
              ) : (
                <>
                  <UploadCloud className="w-12 h-12 text-slate-300 mb-4" />
                  <p className="text-sm font-bold text-slate-700">Drop new revision here</p>
                  <p className="text-xs text-slate-400 mt-1 mb-4">PDF, DWG (Max 50MB)</p>
                  <input type="file" className="absolute inset-0 opacity-0 cursor-pointer" onChange={handleFileSelect} />
                  <button className="px-4 py-2 bg-white border border-slate-300 rounded-lg text-xs font-bold text-slate-700 shadow-sm">Browse Files</button>
                </>
              )}
            </div>
          )}

          {/* STEP 2: IMPACT & CONFIG */}
          {step === 2 && (
            <div className="space-y-6">
              
              {/* IMPACT CARD (Item 6) */}
              <div className="bg-orange-50 border border-orange-100 rounded-xl p-4">
                <h4 className="text-xs font-bold text-orange-800 uppercase tracking-wider mb-2 flex items-center">
                  <FileDiff className="w-4 h-4 mr-2" /> Revision Impact
                </h4>
                <p className="text-sm text-orange-900 font-medium">{impact?.summary}</p>
                <div className="flex gap-2 mt-2">
                  {impact?.changes.added.map((t: AssetTag) => (
                    <span key={t.tag} className="text-[10px] font-bold bg-green-100 text-green-700 px-2 py-1 rounded border border-green-200">+ {t.tag}</span>
                  ))}
                  {impact?.changes.removed.map((t: AssetTag) => (
                    <span key={t.tag} className="text-[10px] font-bold bg-red-100 text-red-700 px-2 py-1 rounded border border-red-200">- {t.tag}</span>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Revision Type</label>
                  <select 
                    value={revType} 
                    onChange={(e) => setRevType(e.target.value as RevisionType)} 
                    className="w-full p-2.5 bg-white border border-slate-200 rounded-lg text-sm font-bold text-slate-700 focus:ring-2 focus:ring-blue-500 outline-none"
                  >
                    <option value="Minor">Minor (Typo/Correction)</option>
                    <option value="Major">Major (Engineering Change)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-2">New Rev Code</label>
                  <input 
                    value={nextRevCode} 
                    onChange={(e) => setNextRevCode(e.target.value)} 
                    className="w-full p-2.5 bg-white border border-slate-200 rounded-lg text-sm font-bold text-slate-700 focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
              </div>

              {targetDoc.setId && (
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-200">
                  <label className="flex items-start cursor-pointer">
                    <input 
                      type="radio" 
                      name="scope" 
                      checked={scope === 'Sheet'} 
                      onChange={() => setScope('Sheet')} 
                      className="mt-1 mr-3 text-blue-600 focus:ring-blue-500" 
                    />
                    <div>
                      <span className="block text-sm font-bold text-slate-900">Revise Sheet Only</span>
                      <span className="block text-xs text-slate-500">Updates only this drawing. The Set revision remains {targetDoc.rev}.</span>
                    </div>
                  </label>
                  <div className="h-px bg-slate-200 my-3" />
                  <label className="flex items-start cursor-pointer">
                    <input 
                      type="radio" 
                      name="scope" 
                      checked={scope === 'Set'} 
                      onChange={() => setScope('Set')} 
                      className="mt-1 mr-3 text-blue-600 focus:ring-blue-500" 
                    />
                    <div>
                      <span className="block text-sm font-bold text-slate-900">Revise Entire Set (Binder)</span>
                      <span className="block text-xs text-slate-500">Increments the Master Set Revision. Use if changes affect multiple sheets.</span>
                    </div>
                  </label>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Reason for Change</label>
                <textarea 
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full p-3 bg-white border border-slate-200 rounded-lg text-sm font-medium focus:ring-2 focus:ring-blue-500 outline-none h-24 resize-none"
                  placeholder="e.g. Added bypass valve per MOC-2024-05..."
                />
              </div>
            </div>
          )}
        </div>

        {/* FOOTER */}
        <div className="px-8 py-5 bg-slate-50 border-t border-slate-200 flex justify-end space-x-3">
          <button 
            onClick={onClose} 
            className="px-6 py-2.5 text-sm font-bold text-slate-600 hover:text-slate-800 transition-colors"
          >
            Cancel
          </button>
          
          {step === 2 && (
            <button 
              onClick={handleSubmit} 
              disabled={!reason || !nextRevCode || isLoading}
              className="px-6 py-2.5 bg-blue-600 text-white text-sm font-bold rounded-xl shadow-lg shadow-blue-600/20 hover:bg-blue-700 disabled:opacity-50 disabled:shadow-none flex items-center transition-all"
            >
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <><CheckCircle2 className="w-4 h-4 mr-2" /> Commit Revision</>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
