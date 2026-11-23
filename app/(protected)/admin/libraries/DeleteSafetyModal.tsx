"use client";

// Deleting a library can't be undone, so it asks for the library's name
// typed out before the Delete button wakes up.

import { useState } from "react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";

interface DeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  libraryName: string;
  isLoading: boolean;
}

export default function DeleteSafetyModal(props: DeleteModalProps) {
  // The body unmounts whenever the dialog is closed, so each reopen is a
  // fresh mount with reset state.
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
  const isMatch = confirmText.trim() === libraryName.trim();

  return (
    <Modal onClose={onClose} size="sm" zIndex={60} dismissable={!isLoading}>
      <ModalHeader title={`Delete ${libraryName}?`} onClose={isLoading ? undefined : onClose} />
      <form onSubmit={(e) => { e.preventDefault(); if (isMatch && !isLoading) void onConfirm(); }}>
        <ModalBody className="space-y-4">
          <p className="text-[15px] text-[var(--color-text)]">
            This deletes the library&apos;s setup for good. Documents still in it are left without a library, so move them first.
          </p>
          <Field label={<>Type <span className="font-mono select-all">{libraryName}</span> to confirm</>}>
            <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" spellCheck={false} autoFocus />
          </Field>
        </ModalBody>
        <ModalFooter>
          {!isMatch && <span className="mr-auto text-[13px] text-[var(--color-text-muted)]">Type the name to turn on Delete.</span>}
          <Button type="button" variant="secondary" onClick={onClose} disabled={isLoading}>Cancel</Button>
          <Button type="submit" variant="danger" loading={isLoading} disabled={!isMatch}>Delete library</Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
