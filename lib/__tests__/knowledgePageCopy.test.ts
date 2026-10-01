// intelligence Round G (I-02) — what the knowledge page and the meaning-index
// panel say, and to whom.
//
//   * SEM-12 — every library answer carries its retrieval mode, for every
//     reader, read WITH the library's coverage so a 3% index never reads like
//     a 100% one; a low-coverage answer gets an explicit note by its sources.
//   * SEM-8 — the drift from 100% is on the page where questions are asked,
//     for everyone, not only inside the build panel.
//   * ASK-6 — model-written text (a Need prompt, a clarify question and its
//     options) is shown as the assistant's words in a container that is not
//     app chrome, carries the never-enter-secrets line at the input, and is
//     refused outright when it reaches for credentials or links (tier 1). A
//     pin, PIN, OTP or code is only ever a caution (tier 2, fix pass 6).
//   * HUB-11 — the library page carries the Intelligence strip.
//   * SEM-13 / SEM-5 / SEM-3 / HUB-12 — the panel's price, definition, rebuild
//     copy and the vision checkbox named as it appears on screen.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeRetrieval, meaningIndexDrift, screenAssistantRequest, MEANING_COVERAGE_NOTE_BELOW, ASSISTANT_REQUEST_MAX,
} from "@/lib/knowledge";
import { formatEmbedCost } from "@/components/knowledge/SemanticIndexPanel";
import { ASSISTANT_PIN_CAUTION, ASSISTANT_LOGIN_CAUTION } from "@/lib/assistantScreen";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const page = repo("app/(protected)/knowledge/[id]/page.tsx");
const panel = repo("components/knowledge/SemanticIndexPanel.tsx");
const cards = repo("components/knowledge/AssistantAskCards.tsx");

describe("SEM-12 — the retrieval mode reaches every reader, with the coverage behind it", () => {
  it("keyword-only says meaning search did not run, and why; the note box is for a library that HAS an index", () => {
    expect(describeRetrieval("keyword", { embedded: 0, total: 400 })).toEqual({
      label: "Keyword search only", keywordOnly: true, emphasize: false,
      note: "Meaning search did not run for this answer — this library has no meaning index yet. A passage that says the same thing in other words may be missing.",
    });
    const partial = describeRetrieval("keyword", { embedded: 100, total: 400 })!;
    expect(partial.note).toMatch(/covers 25% of this library/);
    expect(partial.emphasize).toBe(true);
    // coverage unknown (status not loaded, or pre-migration): no coverage claim at all
    expect(describeRetrieval("keyword", null)!.note).toBe("Meaning search did not run for this answer. A passage that says the same thing in other words may be missing.");
  });
  it("hybrid over a 3% index is NOT the same as hybrid over 100%", () => {
    const three = describeRetrieval("hybrid", { embedded: 1_200, total: 40_000 })!;
    const full = describeRetrieval("hybrid", { embedded: 40_000, total: 40_000 })!;
    expect(three.label).toBe(full.label);
    expect(three.note).toBe("Meaning search covers 3% of this library — passages without a meaning vector were found by keyword only.");
    expect(three.emphasize).toBe(true);
    expect(full.note).toBeNull();
    expect(full.emphasize).toBe(false);
    expect(describeRetrieval("hybrid", { embedded: MEANING_COVERAGE_NOTE_BELOW, total: 100 })!.note).toBeNull();
    expect(describeRetrieval("hybrid", { embedded: MEANING_COVERAGE_NOTE_BELOW - 1, total: 100 })!.note).not.toBeNull();
  });
  it("a replayed answer (no flag) shows no chip — it was not searched now", () => {
    expect(describeRetrieval(undefined, { embedded: 1, total: 2 })).toBeNull();
  });
  it("the answer card renders the chip from the answer's own flag, the route's coverage first, the library's second — with no controller gate", () => {
    expect(page).toContain("const retrieval = describeRetrieval(answer.retrieval, answer.retrievalCoverage ?? coverage ?? null);");
    expect(page).toContain("<span data-retrieval={answer.retrieval}");
    expect(page).toContain("{retrieval.label}");
    expect(page).toMatch(/\{retrieval\?\.note && retrieval\.emphasize && \(\s*<div[^>]*data-retrieval-note="true">/);
    // the note sits immediately before the sources strip
    expect(page.indexOf('data-retrieval-note="true"')).toBeLessThan(page.indexOf("Sources — most load-bearing documents first"));
    // every rendered answer gets the library's coverage
    expect((page.match(/coverage=\{libraryCoverage\}/g) ?? []).length).toBe(2);
    expect(page).toContain("onStatus={setSemanticStatus}");
    const chip = page.slice(page.indexOf("{retrieval && ("), page.indexOf("{retrieval.label}"));
    expect(chip).not.toMatch(/isController|canShape|hasAnyRole/);
  });
});

describe("SEM-8 — drift from 100% is on the page, for everyone", () => {
  it("meaningIndexDrift speaks only when a built index has fallen behind — and never claims WHY (added since a build, or a build stopped part-way)", () => {
    expect(meaningIndexDrift(null)).toBeNull();
    expect(meaningIndexDrift({ total: 0, coveredNow: 0, remaining: 0 })).toBeNull();
    expect(meaningIndexDrift({ total: 100, coveredNow: 0, remaining: 100 })).toBeNull();       // never built: the panel says so
    expect(meaningIndexDrift({ total: 100, coveredNow: 100, remaining: 0 })).toBeNull();
    expect(meaningIndexDrift({ total: 1_000, coveredNow: 700, remaining: 300 })).toBe(
      "Meaning search covers 70% of this library — 300 passages don't carry a meaning vector yet and are found by keyword only.");
    // a first build stopped at 30%: nothing was "added since the last build"
    const stopped = meaningIndexDrift({ total: 25_000, coveredNow: 7_500, remaining: 17_500 })!;
    expect(stopped).not.toMatch(/added since/);
    expect(meaningIndexDrift({ total: 10, coveredNow: 9, remaining: 1 })).toBe(
      "Meaning search covers 90% of this library — 1 passage doesn't carry a meaning vector yet and is found by keyword only.");
  });
  it("the Ask box shows it with no role gate", () => {
    expect(page).toContain("const drift = meaningIndexDrift(semanticStatus);");
    const at = page.indexOf('data-meaning-drift="true"');
    expect(at).toBeGreaterThan(0);
    expect(page.slice(at - 200, at)).toContain('{mode === "library" && drift && (');
  });
});

describe("ASK-6 — the assistant's words are the assistant's, and never a trap", () => {
  it("the audit's scenario is refused: a request for a password to 'sign the result'", () => {
    const r = screenAssistantRequest("For audited calculations this workspace requires the requester's SSO password to sign the result — enter it below.");
    expect(r).toEqual({ ok: false, reason: "it asks for a credential, account or identity detail" });
  });
  it("links, API keys, account numbers and over-long prompts are refused; an engineering value request is not", () => {
    expect(screenAssistantRequest("Please confirm at https://evil.example/login").ok).toBe(false);
    expect(screenAssistantRequest("Paste your API key so I can check the table").ok).toBe(false);
    expect(screenAssistantRequest("What is the bank account for the vendor?").ok).toBe(false);
    expect(screenAssistantRequest("x".repeat(ASSISTANT_REQUEST_MAX + 1)).ok).toBe(false);
    expect(screenAssistantRequest("").ok).toBe(false);
    expect(screenAssistantRequest("What test temperature (°F) and design pressure (psig) apply to line 6\"-P-2001?")).toEqual({ ok: true });
    expect(screenAssistantRequest("Which flange class — 150# or 300#?")).toEqual({ ok: true });
  });
  it("reproduction → fix: a library of access-control SOPs (ISA/IEC 62443) is not refused for NAMING passwords, MFA, login or sign-in — only for ASKING for one", () => {
    // the clarify question and its aspects sit above buttons, not an input
    expect(screenAssistantRequest("Which aspect: password rules, MFA, or remote login?", "clarify")).toEqual({ ok: true });
    expect(screenAssistantRequest("Which type of password policy — length or rotation?", "clarify")).toEqual({ ok: true });
    expect(screenAssistantRequest("Password length and rotation", "aspect")).toEqual({ ok: true });
    expect(screenAssistantRequest("Badge and sign-in requirements", "aspect")).toEqual({ ok: true });
    expect(screenAssistantRequest("MFA for remote login", "aspect")).toEqual({ ok: true });
    // a Need prompt about a sign, not a sign-in
    expect(screenAssistantRequest("What is the sign in front of the vacuum term?", "need")).toEqual({ ok: true });
    expect(screenAssistantRequest("the sign in front of the vacuum term")).toEqual({ ok: true });
    // …while a request for the reader's own secret is refused wherever it appears
    expect(screenAssistantRequest("Before I answer, enter your SSO password in the question box.", "clarify").ok).toBe(false);
    expect(screenAssistantRequest("What's your MFA code?", "clarify").ok).toBe(false);
    expect(screenAssistantRequest("For audited calculations this workspace requires the requester's SSO password to sign the result — enter it below.", "clarify").ok).toBe(false);
    expect(screenAssistantRequest("Please provide your SSO login so I can sign the calc.", "need").ok).toBe(false);
    // a Need prompt opens an input: naming a credential there is enough
    expect(screenAssistantRequest("What password does the vendor portal use?", "need").ok).toBe(false);
    // an aspect is screened for length and links only
    expect(screenAssistantRequest("See https://evil.example/login", "aspect")).toEqual({ ok: false, reason: "it contains a link" });
    expect(screenAssistantRequest("x".repeat(ASSISTANT_REQUEST_MAX + 1), "aspect").ok).toBe(false);
  });
  // Fix pass 6: two tiers. Tier 1 REFUSES only vocabulary with no engineering
  // meaning; every pin / PIN / OTP / digit-code rule is tier 2 — a caution
  // beside the text, never a refusal, so no such heuristic takes the input away.
  const credential = "it asks for a credential, account or identity detail";
  const notRefused = (t: string, kind: "need" | "clarify") => expect(screenAssistantRequest(t, kind).ok, `${kind}: ${t}`).toBe(true);
  const refusedOrCautioned = (t: string, kind: "need" | "clarify") => {
    const r = screenAssistantRequest(t, kind);
    expect(r.ok === false || r.caution === ASSISTANT_PIN_CAUTION, `${kind}: ${t}`).toBe(true);
  };
  it("fix pass 6 → no pin, PIN, OTP or code sentence an engineering library writes is refused (tier 2 may caution; it never blocks)", () => {
    const engineering = [
      // the verifier's list (fix pass 5 refused or would have refused these)
      "the voltage on the input pin", "How many input pins?", "Which supply pin?", "Which aspect: output pins or input pins?",
      "Enter the pin number for the input card.", "the I/O card pin assignment for the transmitter", "the pin number for the relay card.",
      "the grounding pin for the capacitor bank.", "the length of the anchor pins for the river bank.",
      "the force on the release pin to unlock the latch", "the alignment pins used to verify the fixture position",
      "the 2-digit pin number of the signal on connector J4", "the calibration code that was sent to you with the load cell",
      "Provide the site PIN code to look up the basic wind speed (IS 875 Part 3)", "the voltage at the input PIN.", "Provide the OTP.",
      "the PIN number on the nameplate",
      // the fix-pass-4 review's set
      "the clearance between your pin and the bore (mm)", "the diametral clearance of your pin to the lug hole",
      "the double-shear load on your pin.", "the diameter of your pins, in mm",
      "the material grade of the SHEAR PIN, which the BOM leaves blank", "the grade of the DOWEL PIN, 6 X 20, on the BOM",
      "the size of the cotter PIN for the castle nut", "the PIN and bushing material", "Need: DOWEL PIN", "Need: the PIN-to-hole clearance",
      "ENTER CLEVIS PIN DIAMETER (IN)", "HOW MANY ANCHOR PINS?", "HOW MANY ANCHOR PINS", "ENTER CONNECTOR PIN NUMBER FOR SIGNAL A",
      // earlier passes
      "Provide the pin diameter (in) and the applied shear load (lbf).", "Enter the clevis pin diameter and material yield strength.",
      "Provide the clevis pin diameter", "Please give the number of anchor pins and the bolt circle diameter.",
      "Provide the OTP (operating test pressure) in psig.", "Provide your OTP (operating test pressure) in psig.",
      "Enter the connector pin number for signal A.", "What's your pin count per flange?", "Provide the double-shear load on your pin.",
      "Provide the pin diameter to verify the double-shear capacity.", "the pin load, taking into account the eccentricity",
      "the pin count of the card-edge connector", "the pin for the card guide", "the base pin of the portal frame",
      "the pin for verification testing of the hinge", "Enter the 6-digit code stamped on the nameplate.", "What's the pin diameter?",
      // engineering words that tier 1 no longer refuses (a routing, an I/O card, PWD schedules, an inspector's credentials,
      // a SECRET drawing, "log in" / "sign in" as two words, a certificate's verification code)
      "Provide the routing number for part 1234-A.", "Enter the card number of the analog input module.",
      "Provide the PWD schedule of rates item for M20 concrete.", "Provide the inspector's CWI credentials number.",
      "Provide the classification (CONFIDENTIAL or SECRET) of the drawing.", "Enter the sign in front of the vacuum term.",
      "Give the log in base 10 of the pressure ratio.", "Provide the verification code of the calibration certificate.",
    ];
    for (const t of engineering) { notRefused(t, "need"); notRefused(t, "clarify"); }
    // most of them carry no caution at all — the binding rules keep tier 2 quiet on a pin that is a part
    for (const t of ["the voltage on the input pin", "How many input pins?", "Which supply pin?", "Enter the pin number for the input card.",
      "the I/O card pin assignment for the transmitter", "the pin number for the relay card.", "the grounding pin for the capacitor bank.",
      "the length of the anchor pins for the river bank.", "the force on the release pin to unlock the latch",
      "the alignment pins used to verify the fixture position", "the voltage at the input PIN.", "the PIN number on the nameplate",
      "the clearance between your pin and the bore (mm)", "the double-shear load on your pin.", "Need: DOWEL PIN",
      "the size of the cotter PIN for the castle nut", "Provide your OTP (operating test pressure) in psig.", "What's your pin count per flange?"]) {
      expect(screenAssistantRequest(t, "need"), t).toEqual({ ok: true });
    }
    // a PIN code (an Indian postal code) is a caution, never a refusal
    expect(screenAssistantRequest("Provide the site PIN code to look up the basic wind speed (IS 875 Part 3)", "need"))
      .toEqual({ ok: true, caution: ASSISTANT_PIN_CAUTION });
  });
  it("fix pass 6 → a credential prompt is refused (tier 1) or carries the caution (tier 2); the audit's SSO-password scenario stays refused", () => {
    const prompts = [
      "Enter your PIN to sign the result.", "Enter your SIM PIN.", "Enter the PIN number.", "Enter the 6-digit code we sent to your phone.",
      "Enter the code from Google Authenticator.", "Enter your PIN (4 digits).", "What is your mother's maiden name?",
      "Enter your online banking password.", "Enter your 2FA code.",
      "enter your banking pin", "your debit card pin", "the 4-digit pin for your card", "enter the pin to unlock", "the 6-digit code we texted you",
      "enter your PIN", "Enter your pin.", "ENTER YOUR PIN", "Enter the PIN.", "Provide the PIN number for the vendor portal.",
      "what is your OTP code", "What is your OTP?", "Type the OTP code we sent you.", "Enter the one-time code below.",
      "Please enter your PIN to continue.", "Enter your PIN, please.", "Enter your card's PIN.", "the pin you use to sign in",
      "the PIN that was texted to you", "the code in the SMS", "What's the PIN?", "PIN?",
    ];
    for (const t of prompts) refusedOrCautioned(t, "need");
    for (const t of ["Enter your PIN to sign the result.", "Enter the 6-digit code we sent to your phone.", "enter your banking pin",
      "what's your pin?", "Please enter your PIN to continue.", "Type your one-time code below.", "What is your mother's maiden name?"]) {
      refusedOrCautioned(t, "clarify");
    }
    // tier 1 — refused outright: vocabulary with no engineering meaning
    for (const t of ["For audited calculations this workspace requires the requester's SSO password to sign the result — enter it below.",
      "What is your mother's maiden name?", "Enter your online banking password.", "Enter your 2FA code.", "Enter your one-time password.",
      "Enter the verification code.", "Enter the security code on the back of your card.", "Enter your CVV.", "Provide your SSN.",
      "Enter your credit card number.", "Enter your date of birth.", "Provide your login credentials.", "What is your security question answer?"]) {
      expect(screenAssistantRequest(t, "need"), t).toEqual({ ok: false, reason: credential });
    }
    expect(screenAssistantRequest("For audited calculations this workspace requires the requester's SSO password to sign the result — enter it below.", "clarify"))
      .toEqual({ ok: false, reason: credential });
    // tier 2 — a caution, the input stays: every pin / PIN / OTP / code rule
    for (const t of ["Enter your PIN to sign the result.", "Enter your SIM PIN.", "Enter the PIN number.", "Enter the 6-digit code we sent to your phone.",
      "Enter the code from Google Authenticator.", "Enter your PIN (4 digits).", "enter your banking pin", "your debit card pin",
      "the 4-digit pin for your card", "enter the pin to unlock", "the 6-digit code we texted you", "What is your OTP?", "Enter the one-time code below."]) {
      expect(screenAssistantRequest(t, "need"), t).toEqual({ ok: true, caution: ASSISTANT_PIN_CAUTION });
    }
    // an aspect label is screened for length and links only — never cautioned
    expect(screenAssistantRequest("PIN code rules", "aspect")).toEqual({ ok: true });
    // naming, not asking, above buttons stays plain
    expect(screenAssistantRequest("Which aspect: debit card pin rules or password rotation?", "clarify")).toEqual({ ok: true });
    expect(screenAssistantRequest("Which aspect: PIN code rules or password rotation?", "clarify").ok).toBe(true);
  });
  it("fix pass 6 addendum → an ask verb beside a bare login / SSO / MFA word is a caution; a password, an MFA code or the reader's own login asked for is refused", () => {
    // refused by "an ask verb then login / SSO / MFA anywhere in the sentence" before the addendum
    for (const t of ["Give the login count.", "Provide the MFA flow rate.", "Provide the SSO login for the vendor portal.", "Enter your login count."]) {
      for (const kind of ["need", "clarify"] as const) {
        expect(screenAssistantRequest(t, kind), `${kind}: ${t}`).toEqual({ ok: true, caution: ASSISTANT_LOGIN_CAUTION });
      }
    }
    // explicit secret nouns asked of the reader stay tier 1 — "Enter your SSO login." is REFUSED (the reader's own login as the object)
    for (const t of ["Enter your SSO password.", "Enter your MFA code.", "Enter your SSO login.", "Please provide your SSO login so I can sign the calc.",
      "What's your login?", "Provide your login credentials.",
      "For audited calculations this workspace requires the requester's SSO password to sign the result — enter it below."]) {
      for (const kind of ["need", "clarify"] as const) {
        expect(screenAssistantRequest(t, kind), `${kind}: ${t}`).toEqual({ ok: false, reason: credential });
      }
    }
    // naming access words above buttons stays plain
    expect(screenAssistantRequest("Which aspect: password rules, MFA, or remote login?", "clarify")).toEqual({ ok: true });
  });
  it("fix pass 6 → no pin or code rule sits in the refusing tier", () => {
    const screen = repo("lib/assistantScreen.ts");
    const tier1 = screen.slice(screen.indexOf("// ── TIER 1"), screen.indexOf("// ── TIER 2"))
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"); // the patterns, not their comments
    expect(tier1).not.toMatch(/\bpins?\b|otps?\b|\\d\+\[\\s-\]\?digit/i);
    // nor the bare access words (addendum): they are a caution beside an ask verb
    expect(tier1).not.toContain("ACCESS_TERMS");
    expect(screen).toContain("if (kind !== \"aspect\" && ACCESS_CAUTION_RE.test(t)) return { ok: true, caution: ASSISTANT_LOGIN_CAUTION };");
    expect(screen).toContain("if (kind !== \"aspect\" && PIN_CAUTION_RE.test(t)) return { ok: true, caution: ASSISTANT_PIN_CAUTION };");
  });
  it("NeedCard: the app's first-person chrome is gone; the prompt is quoted inside the assistant frame; the secrets line is at the input", () => {
    const need = cards.slice(cards.indexOf("export function NeedCard("));
    expect(need).not.toContain("I need a value from you to run this calculation");
    expect(need).toContain('const check = screenAssistantRequest(prompt, "need");');
    expect(need).toContain("if (!check.ok) return <AssistantRequestRefused reason={check.reason} />;");
    expect(need).toContain('<AssistantAskingFrame tone="indigo">');
    expect(need).toContain("&ldquo;{prompt}&rdquo;");
    expect(need).toContain("Never enter passwords, keys, account numbers or personal data here");
    expect(need.indexOf("Never enter passwords")).toBeLessThan(need.indexOf("<Textarea"));
    // a tier-2 caution is a line in the frame, never a return in place of the input
    expect(need).toContain("{check.caution && <AssistantCaution text={check.caution} />}");
    expect(need.indexOf("<AssistantCaution")).toBeLessThan(need.indexOf("<Textarea"));
  });
  it("ClarifyCard: the question is quoted, each option is marked as AI-suggested, unsafe options are dropped (too few → no card)", () => {
    const clarify = cards.slice(cards.indexOf("export function ClarifyCard("), cards.indexOf("// Need round:"));
    expect(clarify).not.toContain("One thing before I answer");
    expect(clarify).toContain('const promptCheck = screenAssistantRequest(prompt, "clarify");');
    expect(clarify).toContain('const safeOptions = options.filter((o) => screenAssistantRequest(o, "aspect").ok).map((o) => o.slice(0, 80));');
    expect(clarify).toContain("if (safeOptions.length < 2) return <AssistantRequestRefused");
    expect(clarify).toContain("aria-label={`AI-suggested aspect: ${o}`}");
    expect(clarify).toContain("Aspects the assistant suggested — pick which to answer:");
    expect(clarify).toContain("onClick={() => onAnswer(safeOptions)}");
    expect(clarify).toContain("{promptCheck.caution && <AssistantCaution text={promptCheck.caution} />}");
  });
  it("the page renders the cards from components/knowledge/AssistantAskCards.tsx, which screens with the pure module", () => {
    expect(page).toContain('import { ClarifyCard, NeedCard } from "@/components/knowledge/AssistantAskCards";');
    expect(page).not.toContain("function NeedCard(");
    expect(page).not.toContain("function ClarifyCard(");
    expect(cards).toContain('import { screenAssistantRequest } from "@/lib/assistantScreen";');
  });
  it("the screen is one pure module (no imports) the ask route can run server-side; the page re-exports it", () => {
    const screen = repo("lib/assistantScreen.ts");
    expect(screen).not.toMatch(/^import /m);
    expect(repo("lib/knowledge.ts")).toContain('export { screenAssistantRequest, ASSISTANT_REQUEST_MAX } from "@/lib/assistantScreen";');
  });
  it("the frame names the words as the model's, not the app's", () => {
    const frame = cards.slice(cards.indexOf("function AssistantAskingFrame("), cards.indexOf("function AssistantRequestRefused("));
    expect(frame).toContain("AI-written");
    expect(frame).toContain("The assistant is asking — the words below are the AI model&apos;s, not this app&apos;s.");
    expect(frame).toContain('data-assistant-authored="true"');
  });
});

describe("HUB-11 — the library page keeps the Intelligence strip", () => {
  it("renders ViewTabs titled Intelligence, like every other surface of the tool", () => {
    expect(page).toContain('import ViewTabs, { INTELLIGENCE_VIEWS } from "@/components/navigation/ViewTabs";');
    expect(page).toMatch(/<PageShell>\n\s+<ViewTabs title="Intelligence" tabs=\{INTELLIGENCE_VIEWS\} \/>\n\s+<PageHeaderBar/);
  });
});

describe("the meaning-index panel's words", () => {
  it("SEM-13: no flat 1¢ per 1,000 passages — the price is the status's per-model estimate, formatted for a person", () => {
    expect(panel).not.toContain("CENTS_PER_1K_PASSAGES");
    expect(panel).toContain("const fullCost = formatEmbedCost(status?.estimate?.fullUsd ?? 0);");
    expect(panel).toContain("const remainingCost = formatEmbedCost(status?.estimate?.remainingUsd ?? 0);");
    expect(panel).toContain("(estimate — this provider's rate in the app is a conservative placeholder)");
    expect(formatEmbedCost(0)).toBe("");
    expect(formatEmbedCost(0.004)).toBe("under 1¢");
    expect(formatEmbedCost(0.072)).toBe("~8¢");
    expect(formatEmbedCost(18.25)).toBe("~$18.25");
  });
  it("SEM-5: coverage is defined against the passages search can return", () => {
    expect(panel).toContain("Counted over the passages of documents that are indexed and searchable — the same passages meaning search can return.");
  });
  it("SEM-3: the rebuild dialog says vectors are never reused across models", () => {
    expect(panel).toContain("Vectors from one embedding model are never reused by another, so switching models always means a rebuild.");
  });
  it("HUB-12 (this package's line): the checkbox is quoted by its on-screen label, and the re-index control by its real name and place", () => {
    const modal = repo("components/knowledge/LibraryAiModal.tsx");
    expect(modal).toContain("Text doesn&apos;t extract from these files — index every page as an image");
    expect(panel).toContain("<b>&ldquo;Text doesn&apos;t extract from these files — index every page as an image&rdquo;</b>");
    expect(panel).toContain("<b>Re-index all</b> in the Documents header");
    expect(panel).not.toContain("These are CAD exports or scans");
    expect(panel).not.toContain("under Drawing intelligence");
    expect(page).toContain("Re-index all");
  });
  it("SEM-1 / SEM-4 / SEM-8 / SEM-11: mixed index, refused passages, keep-current and the background state are all said", () => {
    expect(panel).toContain("<b>This index mixes embedding models</b>");
    expect(panel).toContain("could not be embedded</b> — the provider refused");
    expect(panel).toContain("Keep this index current as documents are added");
    expect(panel).toContain('bg.blockedReason === "cap" ? "the monthly AI budget is reached; it resets on the 1st"');
    expect(panel).toContain("runs on {bg.mine ? \"your\" : \"another member's\"} embeddings key and monthly cap");
  });
});
