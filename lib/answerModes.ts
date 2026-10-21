// lib/answerModes.ts — the shapes an answer can take. Picked BEFORE asking
// (the composer's Mode picker) or AFTER (Rethink as… under an answer) —
// one list, so the two never disagree.

export type AnswerMode = "answer" | "compliance" | "explore" | "deviation";

export const ANSWER_MODES: Array<{ id: AnswerMode; label: string; hint: string }> = [
  { id: "answer", label: "Direct answer", hint: "The answer and its proof, nothing extra" },
  { id: "compliance", label: "Compliance check", hint: "Does what was done meet the standard? Findings with quoted proof, and a note you can send" },
  { id: "deviation", label: "Deviation case", hint: "Why the rule exists, whether that reason applies to you, and a justification ready for the form" },
  { id: "explore", label: "Explore / design review", hint: "Broader — related rules and what to consider" },
];

export const AUTO_MODE_HINT = "The assistant picks the shape from your question";
