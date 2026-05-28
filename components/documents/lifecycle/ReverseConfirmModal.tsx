"use client";

// ReverseConfirmModal — confirmation dialog for reversing a lifecycle
// operation (Split / Merge / Renumber).
//
// We use "compensating actions" instead of hard deletes — the
// reversal preserves the audit trail and parks newly-created docs
// under Superseded rather than destroying them. This modal makes
// that explicit so users know what to expect.

import React, { useState } from "react";
import { Undo2, X, Loader2, AlertTriangle, Check, Info } from "lucide-react";
import {
  reverseSplit, reverseMerge, reverseRenumber, type ReverseResult,
} from "@/lib/documentLifecycle";
import type { TimelineEvent } from "@/lib/timeline";

interface ReverseConfirmModalProps {
  event: TimelineEvent;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  onCancel: () => void;
  onSuccess: () => void;
}

export default function ReverseConfirmModal({
  event, orgId, actorUserId, actorEmail, actorRole, onCancel, onSuccess,
}: ReverseConfirmModalProps) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReverseResult | null>(null);

  // The audit event's id comes from the prefixed TimelineEvent.id
  // ("audit:<uuid>"). Strip the prefix here.
  const auditEventId = event.id.replace(/^audit:/, "");
  const valid = reason.trim().length > 0;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      let res: ReverseResult;
      if (event.action === "DOC_SPLIT") {
        res = await reverseSplit({
          splitAuditEventId: auditEventId,
          reason, orgId, actorUserId, actorEmail, actorRole,
        });
      } else if (event.action === "DOC_MERGED") {
        res = await reverseMerge({
          mergeAuditEventId: auditEventId,
          reason, orgId, actorUserId, actorEmail, actorRole,
        });
      } else if (event.action === "DOC_RENUMBERED") {
        res = await reverseRenumber({
          renumberAuditEventId: auditEventId,
          reason, orgId, actorUserId, actorEmail, actorRole,
        });
      } else {
        throw new Error(`Cannot reverse action: ${event.action}`);
      }
      setResult(res);
      // Auto-close after a brief moment if there were no warnings;
      // otherwise stay open so the user reads the warnings before
      // dismissing.
      if (res.warnings.length === 0) {
        onSuccess();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const description = describeReversal(event);

  return (
    <div className="fixed inset-0 z-[210] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-2">
            <Undo2 className="w-5 h-5 text-slate-700" />
            <div>
              <h2 className="font-black text-slate-900">Reverse {description.opName}</h2>
              <div className="text-[11px] text-slate-500 mt-0.5">
                Originally: {event.summary} · {formatWhen(event.timestamp)}
              </div>
            </div>
          </div>
          <button onClick={onCancel} className="p-1.5 rounded hover:bg-slate-200 text-slate-500">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3">
          {/* What will happen */}
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs">
            <div className="flex items-start gap-2">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-blue-600" />
              <div>
                <div className="font-bold text-slate-800 mb-1">What this will do</div>
                <ul className="list-disc ml-4 space-y-0.5 text-slate-700">
                  {description.steps.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            </div>
          </div>

          {/* Compensating-action note */}
          <div className="text-[11px] text-slate-500">
            We never hard-delete — newly-created docs are parked under <b>Superseded</b> so the audit trail stays intact.
            If derivative work happened on them, it&apos;s preserved under that status.
          </div>

          {/* Reason */}
          <label className="block">
            <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Reason for reversal *</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder='e.g. "Wrong split count — should have been 3 sheets, not 2."'
              className="mt-1 w-full text-sm border border-slate-300 rounded px-2.5 py-1.5"
              autoFocus
            />
          </label>

          {/* Result (after reversal completes) */}
          {result && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs space-y-1">
              <div className="font-bold text-emerald-900 inline-flex items-center gap-1">
                <Check className="w-3.5 h-3.5" /> Reversal complete
              </div>
              <div className="text-emerald-800">
                {result.reversedDocIds.length} doc{result.reversedDocIds.length === 1 ? "" : "s"} touched,
                {result.preservedAsSuperseded > 0 && ` ${result.preservedAsSuperseded} parked under Superseded,`}{" "}
                audit row written.
              </div>
              {result.warnings.length > 0 && (
                <div className="pt-2 border-t border-emerald-200">
                  <div className="font-bold text-amber-800 inline-flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" /> Heads up
                  </div>
                  <ul className="list-disc ml-4 mt-1 text-amber-800 space-y-0.5">
                    {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
          {result ? (
            <button onClick={onSuccess} className="text-sm font-bold bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded">
              Done
            </button>
          ) : (
            <>
              <button onClick={onCancel} disabled={busy} className="text-sm text-slate-600 hover:text-slate-900 px-3 py-1.5">
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={busy || !valid}
                className="inline-flex items-center gap-1.5 text-sm font-bold bg-slate-700 hover:bg-slate-800 text-white px-3 py-1.5 rounded disabled:opacity-40"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />}
                Confirm Reverse
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface Description {
  opName: string;
  steps: string[];
}

function describeReversal(event: TimelineEvent): Description {
  const d = event.details ?? {};
  if (event.action === "DOC_SPLIT") {
    const newCount = (d.newDocumentCount as number | undefined) ?? (d.replacementDocIds as string[] | undefined)?.length ?? 0;
    return {
      opName: "Split",
      steps: [
        `Source document will return to "Issued" status.`,
        `${newCount} new doc${newCount === 1 ? "" : "s"} from the split will be marked Superseded with reason "Reverted split".`,
        `document_supersessions links from this split will be removed (audit row retains the history).`,
        `Asset tags on the parked docs are NOT moved back — they stay with the new doc rows for the audit reconstructable.`,
        `Active holds and project memberships carried over during the split stay on the parked docs.`,
      ],
    };
  }
  if (event.action === "DOC_MERGED") {
    const siblings = (d.mergeSiblings as string[] | undefined) ?? [];
    return {
      opName: "Merge",
      steps: [
        `${siblings.length || "All"} source document${siblings.length === 1 ? "" : "s"} will return to "Issued" status.`,
        `Merge target will be parked under Superseded IF it was newly created by the merge. If it was an existing doc that absorbed the others, it stays Active and you'll need to use Revert separately to undo its rev-up.`,
        `document_supersessions links from this merge will be removed.`,
      ],
    };
  }
  if (event.action === "DOC_RENUMBERED") {
    return {
      opName: "Renumber",
      steps: [
        `documents.document_number will be set back to "${d.previousDocumentNumber ?? "(previous)"}".`,
        `If the number was changed again since this renumber, the reversal will warn but still proceed.`,
      ],
    };
  }
  return { opName: event.action, steps: ["Operation will be reversed via a compensating audit event."] };
}

function formatWhen(ts: string): string {
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}
