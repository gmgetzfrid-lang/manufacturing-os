"use client";

import React from 'react';
import { Layers, X, Maximize2, Minus } from 'lucide-react';
import { useRouter } from 'next/navigation';

export interface StagedDoc {
  id: string;
  title: string;
  docNumber: string;
  rev: string;
}

interface StagingDockProps {
  items: StagedDoc[];
  onRemove: (id: string) => void;
  onClear: () => void;
}

export default function StagingDock({ items, onRemove, onClear }: StagingDockProps) {
  const router = useRouter();

  if (items.length === 0) return null;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-10 fade-in duration-300">
      <div className="bg-slate-900/95 backdrop-blur-xl text-white p-2 pl-4 rounded-2xl shadow-2xl flex items-center space-x-4 border border-white/10 ring-1 ring-black/50">
        
        {/* Indicator */}
        <div className="flex items-center space-x-3 mr-2">
          <div className="p-2 bg-[var(--color-accent)] rounded-lg shadow-lg shadow-black/20 animate-pulse">
            <Layers className="w-5 h-5 text-white" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-bold leading-none">{items.length} Sheets Staged</span>
            <span className="text-[10px] text-slate-400 font-medium">Ready for Comparison</span>
          </div>
        </div>

        <div className="h-8 w-px bg-white/10" />

        {/* The Filmstrip */}
        <div className="flex -space-x-2 px-2">
          {items.slice(0, 5).map((item) => (
            <div 
              key={item.id} 
              className="group relative w-10 h-10 rounded-full bg-slate-800 border-2 border-slate-700 flex items-center justify-center shadow-lg hover:scale-110 hover:z-10 transition-all cursor-help"
              title={`${item.docNumber} - Rev ${item.rev}`}
            >
              <span className="text-[10px] font-mono font-bold text-slate-300">{item.docNumber.slice(-3)}</span>
              
              {/* Hover Remove Button */}
              <button 
                onClick={(e) => { e.stopPropagation(); onRemove(item.id); }}
                className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Minus className="w-3 h-3" />
              </button>
            </div>
          ))}
          {items.length > 5 && (
            <div className="w-10 h-10 rounded-full bg-slate-800 border-2 border-slate-700 flex items-center justify-center text-xs font-bold text-slate-400">
              +{items.length - 5}
            </div>
          )}
        </div>

        <div className="h-8 w-px bg-white/10" />

        {/* Actions */}
        <div className="flex items-center space-x-2">
          <button 
            onClick={() => router.push('/workspace')} 
            className="flex items-center px-4 py-2 bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-bold rounded-xl hover:bg-[var(--color-accent-hover)] transition-all shadow-lg hover:shadow-xl active:scale-95"
          >
            <Maximize2 className="w-3.5 h-3.5 mr-2" />
            Open Workspace
          </button>
          
          <button 
            onClick={onClear} 
            className="p-2 text-slate-400 hover:text-red-400 hover:bg-white/5 rounded-full transition-colors"
            title="Clear Stage"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}