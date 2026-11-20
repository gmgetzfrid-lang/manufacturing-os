"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";

interface DeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  libraryName: string;
  isLoading: boolean;
}

export default function DeleteSafetyModal(props: DeleteModalProps) {
  // The body unmounts whenever the modal is closed, so each reopen is already a
  // fresh mount with reset state, no synthetic remount key needed.
  if (!props.isOpen) return null;
  return <DeleteSafetyModalBody {...props} />;
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
    <Modal onClose={onClose} size="sm" zIndex={60} dismissable={!isLoading}>
      <ModalHeader
        icon={AlertTriangle}
        iconClassName="bg-[var(--color-surface-2)] text-[var(--state-overdue)]"
        title="Delete Library?"
        onClose={isLoading ? undefined : onClose}
      />
      <ModalBody className="space-y-4">
        <p className="text-sm text-[var(--color-text-muted)] leading-relaxed">
          This <span className="font-semibold text-[var(--state-overdue)]">can&apos;t be undone</span>. It
          permanently deletes the <strong className="text-[var(--color-text)]">{libraryName}</strong> library setup.
          Documents inside it may be left without a library if they aren&apos;t moved first.
        </p>

        <div className="space-y-2">
          <label className="text-[13px] font-semibold text-[var(--color-text-muted)] ">
            Type{" "}
            <span className="select-all font-mono text-[var(--color-text)] bg-[var(--color-surface-2)] px-1 py-0.5 rounded border border-[var(--color-border)] normal-case">
              {libraryName}
            </span>{" "}
            to confirm:
          </label>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && isMatch && !isLoading) void onConfirm(); }}
            className="w-full p-3 border border-[var(--color-border-strong)] rounded-lg text-sm font-semibold bg-[var(--color-surface)] text-[var(--color-text)] focus:ring-2 focus:ring-[var(--state-overdue)] focus:border-red-500 outline-none transition-all placeholder:font-normal"
            placeholder="Type the library name…"
            autoFocus
          />
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] border border-transparent hover:border-[var(--color-border)] rounded-lg transition-all"
          disabled={isLoading}
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={!isMatch || isLoading}
          className="inline-flex items-center justify-center gap-2 h-10 px-4 rounded-md bg-[var(--state-overdue)] text-white text-[15px] font-semibold hover:brightness-95 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isLoading ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Trash2 className="w-4 h-4 mr-2" />
          )}
          Delete this library
        </button>
      </ModalFooter>
    </Modal>
  );
}
