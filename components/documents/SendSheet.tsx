"use client";

// SendSheet - send one or more documents: to someone outside (a controlled
// link, no sign-in) or to someone in this workspace (the app's own link),
// by copying the link, email, text or a QR code. (Contract shared by the
// library, the side panel and the Staged page.)

import React from "react";

/** A document to send. */
export interface SendDoc {
  id: string;
  documentNumber: string | null;
  title: string | null;
  rev: string | null;
  libraryId: string;
}

export interface SendSheetProps {
  orgId: string;
  docs: SendDoc[];
  /** The marked-up copy of a document, when the person marked it up (staged
   *  documents). Null: the issued file is sent. */
  markedUp?: (docId: string) => Promise<Blob | null>;
  /** The documents that have markups, so the sheet can offer to send them. */
  markedUpIds?: string[];
  onClose: () => void;
}

export default function SendSheet(props: SendSheetProps) {
  void props;
  return null;
}
