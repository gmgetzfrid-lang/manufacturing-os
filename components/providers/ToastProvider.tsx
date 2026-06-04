"use client";

import React, { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { X, CheckCircle, AlertCircle, Info, Bell } from "lucide-react";

export type ToastType = "success" | "error" | "info" | "warning";

interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
}

interface ToastContextValue {
  showToast: (props: Omit<Toast, "id">) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Declared before showToast so it can be referenced from the timeout without
  // a use-before-declaration; useCallback keeps the reference stable.
  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(({ type, title, message, duration = 5000 }: Omit<Toast, "id">) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, type, title, message, duration }]);

    if (duration > 0) {
      setTimeout(() => {
        removeToast(id);
      }, duration);
    }
  }, [removeToast]);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      
      {/* Toast Container */}
      <div className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`
              pointer-events-auto w-80 p-4 rounded-xl shadow-lg border animate-in slide-in-from-right-full fade-in duration-300
              flex items-start gap-3 bg-white
              ${toast.type === "success" ? "border-green-100 bg-green-50/50" : ""}
              ${toast.type === "error" ? "border-red-100 bg-red-50/50" : ""}
              ${toast.type === "info" ? "border-blue-100 bg-blue-50/50" : ""}
              ${toast.type === "warning" ? "border-amber-100 bg-amber-50/50" : ""}
            `}
          >
            <div className={`mt-0.5 shrink-0 
              ${toast.type === "success" ? "text-green-600" : ""}
              ${toast.type === "error" ? "text-red-600" : ""}
              ${toast.type === "info" ? "text-blue-600" : ""}
              ${toast.type === "warning" ? "text-amber-600" : ""}
            `}>
              {toast.type === "success" && <CheckCircle className="w-5 h-5" />}
              {toast.type === "error" && <AlertCircle className="w-5 h-5" />}
              {toast.type === "info" && <Info className="w-5 h-5" />}
              {toast.type === "warning" && <Bell className="w-5 h-5" />}
            </div>
            
            <div className="flex-1 min-w-0">
              <h4 className={`text-sm font-bold ${toast.type === 'error' ? 'text-red-900' : 'text-slate-900'}`}>
                {toast.title}
              </h4>
              {toast.message && (
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  {toast.message}
                </p>
              )}
            </div>

            <button 
              onClick={() => removeToast(toast.id)}
              className="text-slate-400 hover:text-slate-600 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
