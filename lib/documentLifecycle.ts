// lib/documentLifecycle.ts
//
// Public barrel for the document-lifecycle workflows. Each operation
// lives in its own focused module under lib/documentLifecycle/;
// importing the barrel keeps existing caller paths
// (`from "@/lib/documentLifecycle"`) stable through the split.
//
// Module layout:
//
//   common.ts    — shared internals (sha256, createNewDoc, mark
//                  superseded, copy holds, copy project memberships).
//                  Not re-exported; per-operation modules use it.
//   split.ts     — splitDocument, SplitTargetSpec,
//                  SplitDocumentInput, SplitDocumentResult
//   merge.ts     — mergeDocuments, MergeTargetSpec,
//                  MergeDocumentsInput, MergeDocumentsResult
//   renumber.ts  — renumberDocument, RenumberInput
//   setRevUp.ts  — setLevelRevUp, SetRevUpSheetSpec,
//                  SetRevUpInput, SetRevUpResult
//   reverse.ts   — reverseSplit, reverseMerge, reverseRenumber,
//                  ReverseResult
//
// All four forward operations use document_supersessions as the
// canonical lineage record. Reversals are compensating actions
// (never hard deletes) so audit immutability is preserved.

export * from "./documentLifecycle/split";
export * from "./documentLifecycle/merge";
export * from "./documentLifecycle/renumber";
export * from "./documentLifecycle/setRevUp";
export * from "./documentLifecycle/reverse";
