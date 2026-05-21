"use client";

import React, { useMemo, useState } from "react";
import { AlertTriangle, Loader2, Trash2, X } from "lucide-react";

interface DeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  libraryName: string;
  isLoading: boolean;
}

export default function DeleteSafetyModal(props: DeleteModalProps) {
  const { isOpen } = props;
  const openKey = useMemo(() => (isOpen ? `open-${Date.now()}` : "closed"), [isOpen]);

  if (!isOpen) return null;
  return <DeleteSafetyModalBody key={openKey} {...props} />;
}

function DeleteSafetyModalBody({
  onClose,
  onConfirm,
  libraryName,
  isLoading,
}: DeleteModalProps) {
  const [confirmText, setConfirmText] = useState("");
  const isMatch = confirmText === libraryName;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl overflow-hidden border-2 border-red-100">
        <div className="px-6 py-4 bg-red-50 border-b border-red-100 flex items-center justify-between">
          <h3 className="text-lg font-bold text-red-900 flex items-center">
            <AlertTriangle className="w-5 h-5 mr-2 text-red-600" />
            Delete Library?
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-red-100 text-red-400 hover:text-red-700 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <p className="text-sm text-slate-600 leading-relaxed">
            This action is <span className="font-bold text-red-600">irreversible</span>. This
            will permanently delete the <strong>{libraryName}</strong> library configuration.
            Documents inside this library may become orphaned or inaccessible if not migrated
            first.
          </p>

          <div className="space-y-2">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Type{" "}
              <span className="select-all font-mono text-slate-800 bg-slate-100 px-1 py-0.5 rounded border border-slate-200">
                {libraryName}
              </span>{" "}
              to confirm:
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="w-full p-3 border border-slate-300 rounded-lg text-sm font-bold focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none transition-all placeholder:font-normal"
              placeholder="Type library name here..."
              autoFocus
            />
          </div>
        </div>

        <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-white hover:text-slate-900 border border-transparent hover:border-slate-200 rounded-lg transition-all"
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!isMatch || isLoading}
            className="px-4 py-2 bg-red-600 text-white text-sm font-bold rounded-lg shadow-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center"
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4 mr-2" />
            )}
            I understand, delete this library
          </button>
        </div>
      </div>
    </div>
  );
}
