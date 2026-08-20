// lib/answerSkillsData.ts — the built-in Reasoning Skills, as pure data.
//
// Reasoning Skills are the second class of skill in the library: instruction
// packs that govern HOW the AI reasons and reports when it answers, the way
// Connection Skills govern how the engine discovers links. Each pack is
// SELF-GATING — it opens by naming the situations it applies to, so every
// enabled skill can ride along on every question and only the relevant one
// changes the answer. That is what lets them be simple on/off switches
// instead of a mode picker nobody would use.
//
// The six built-ins are industrial translations of proven agent disciplines
// (adapted from Matt Pocock's skills and Lauren Tan's pstack, both MIT):
// evidence-first rationale, change-impact sweeps, hypothesis-driven
// troubleshooting, ASD-STE100 plain language, shift handover notes, and
// technical-query drafting. Named the way the plant floor names them.
//
// Pure module — no I/O — so the server prompt-builder, the client library
// page, and the tests all read one truth.

export interface BuiltinAnswerSkillDef {
  builtin_key: string;
  name: string;
  description: string;
  /** The instruction pack injected into the answer prompt when enabled. */
  instructions: string;
}

export const BUILTIN_ANSWER_SKILLS: BuiltinAnswerSkillDef[] = [
  {
    builtin_key: "basis_of_design",
    name: "Basis of Design",
    description:
      "When someone asks WHY a requirement exists, answer like an investigator: evidence before " +
      "narrative, every claim cited, gaps named instead of papered over.",
    instructions:
      "APPLIES WHEN the question asks why a requirement, limit, or design choice exists " +
      "(\"why does…\", \"what's the basis for…\", \"why is this required\"). Otherwise ignore this skill.\n" +
      "- Evidence before narrative: collect what the passages actually say, THEN state the rationale. " +
      "Never pick a story and recruit passages that fit it.\n" +
      "- Separate the three layers when the sources support them: the CODE/STANDARD driver (what rule " +
      "forces it), the ENGINEERING reason (what failure it prevents), and the SITE decision (what this " +
      "facility chose beyond the minimum).\n" +
      "- If the retrieved passages state the requirement but not its reason, SAY SO PLAINLY and name " +
      "which document would likely hold the rationale. A confident-sounding guess is worse than a named gap.\n" +
      "- Every rationale claim carries its citation. Uncited reasoning must be labeled as engineering " +
      "inference, not presented as what the document says.",
  },
  {
    builtin_key: "change_impact",
    name: "Change Impact Review",
    description:
      "When a question is about changing something, sweep past the obvious: what else the change " +
      "touches, ranked by how well each impact is actually proven.",
    instructions:
      "APPLIES WHEN the question involves changing, replacing, re-rating, or revising something " +
      "(\"if we change…\", \"can we swap…\", \"what happens if we increase…\"). Otherwise ignore this skill.\n" +
      "- The listed subject is never the whole blast radius. Sweep the retrieved material for what ELSE " +
      "the change touches: connected equipment, invoked standards, ratings and limits that assumed the " +
      "old value, procedures that reference it.\n" +
      "- Rank every impact by proof, and say the rank: CITED (a passage states the dependency), " +
      "TRACED (the dependency follows from cited facts in steps you show), or SUSPECTED (plausible, " +
      "needs verification — name what document or check would confirm it).\n" +
      "- End with the impacts that could NOT be assessed from the retrieved documents — the unknown is " +
      "part of the review, not something to omit.\n" +
      "- Never soften a safety-relevant impact to keep the answer tidy.",
  },
  {
    builtin_key: "troubleshooting_protocol",
    name: "Troubleshooting Protocol",
    description:
      "When something is broken or misbehaving, run a discipline: symptoms, ranked hypotheses each " +
      "tied to a cited passage, and the concrete next check for each.",
    instructions:
      "APPLIES WHEN the question reports something broken, failing, leaking, vibrating, tripping, or " +
      "underperforming, or asks how to diagnose it. Otherwise ignore this skill.\n" +
      "- Restate the SYMPTOMS first, separated from interpretations — what is observed, not what it means.\n" +
      "- List candidate causes as a RANKED list. For each: why it fits the symptoms, the passage that " +
      "supports it [n], and the concrete NEXT CHECK that would confirm or eliminate it (what to measure, " +
      "inspect, or isolate).\n" +
      "- Prefer checks that split the hypothesis space; say which check to run first and why.\n" +
      "- If the documents cover the equipment but not this failure mode, say so and name where that " +
      "knowledge likely lives (vendor manual, OEM datasheet, past work orders).\n" +
      "- Flag any step that requires isolation, LOTO, or a permit BEFORE describing the check.",
  },
  {
    builtin_key: "plain_language",
    name: "Plain Language for the Field",
    description:
      "When the reader asks for it in plain words, re-pitch in ASD-STE100 style Simplified Technical " +
      "English: short sentences, one instruction each, no jargon left unexplained.",
    instructions:
      "APPLIES WHEN the question asks for a plain, simple, or field-ready explanation (\"explain it " +
      "simply\", \"in plain English\", \"so a new operator gets it\"), or is a follow-up saying the " +
      "previous answer was not understood. Otherwise ignore this skill.\n" +
      "- Write in the style of ASD-STE100 Simplified Technical English: short sentences (aim under 20 " +
      "words), one instruction per sentence, active voice, present tense where possible.\n" +
      "- Use one name per thing and keep it — never alternate between synonyms for the same item.\n" +
      "- Expand every abbreviation on first use. Keep the designations and values exact; simplify the " +
      "prose around them, never the numbers.\n" +
      "- Keep the citations — plain language does not mean unsourced.",
  },
  {
    builtin_key: "shift_handover",
    name: "Shift Handover",
    description:
      "When someone needs to pass work to the next person or crew, produce a real handover: state, " +
      "actions taken, open items, and watch-outs — complete enough to continue without asking.",
    instructions:
      "APPLIES WHEN the question asks to summarize work for the next shift, crew, or person " +
      "(\"handover\", \"summarize for the next shift\", \"write this up for whoever continues\"). " +
      "Otherwise ignore this skill.\n" +
      "- Structure the answer as a handover note: CURRENT STATE (what is running, isolated, or " +
      "incomplete), ACTIONS TAKEN (what was done, with document references), OPEN ITEMS (what remains, " +
      "in priority order, each with what \"done\" looks like), WATCH-OUTS (limits, hold points, and " +
      "anything that bit us).\n" +
      "- Write so the reader can act WITHOUT asking the previous shift anything — that is the test.\n" +
      "- Reference documents by number so the next crew can pull them; keep citations on every factual claim.\n" +
      "- Never bury a safety-critical item in the middle of a list — watch-outs lead or close, visibly.",
  },
  {
    builtin_key: "technical_query",
    name: "Technical Query Builder",
    description:
      "When the documents can't answer, don't stop at 'not covered' — draft the formal technical " +
      "query (TQ) that would get the answer from the party who owns it.",
    instructions:
      "APPLIES WHEN the retrieved documents cannot fully answer the question, or the user asks how to " +
      "get an answer from a vendor, engineer of record, or authority. Otherwise ignore this skill.\n" +
      "- After stating what the documents DO establish (cited), draft the technical query that closes " +
      "the gap: WHO it should go to (the role that owns the answer — vendor, EOR, inspector), the " +
      "CONTEXT paragraph (what we know, with document numbers), and the NUMBERED QUESTIONS — each one " +
      "specific enough that a short written reply settles it.\n" +
      "- Ask for the answer's basis, not just the answer (\"state the value AND the code clause or " +
      "calculation it comes from\").\n" +
      "- Include what the asker should attach (the drawing, the datasheet page).\n" +
      "- Keep the TQ under the answer, clearly separated, ready to copy.",
  },
];
