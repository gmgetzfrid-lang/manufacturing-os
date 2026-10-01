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
//     refused in exactly two cases (fix pass 7): a real URL, or a secret plus
//     an instruction to type it into this box. Every other credential
//     mention is a caution that never blocks the input.
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
import { ASSISTANT_CREDENTIAL_CAUTION, ASSISTANT_LINK_CAUTION } from "@/lib/assistantScreen";

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
  // Fix pass 7: refusing on vocabulary kept refusing real engineering prompts,
  // and the page had no screen before ASK-6. The screen refuses in exactly two
  // cases — a real URL, and a secret plus an instruction to put it in this box
  // — and every other credential mention is a caution that never blocks.
  const injection = "it asks you to type a credential into this box";
  const notRefused = (t: string, kind: "need" | "clarify") => {
    const r = screenAssistantRequest(t, kind);
    expect(r.ok, `${kind}: ${t} → ${JSON.stringify(r)}`).toBe(true);
  };
  const refusedOrCautioned = (t: string, kind: "need" | "clarify") => {
    const r = screenAssistantRequest(t, kind);
    expect(r.ok === false || r.caution === ASSISTANT_CREDENTIAL_CAUTION, `${kind}: ${t} → ${JSON.stringify(r)}`).toBe(true);
  };
  const SWAPS = ["SSO password", "SSO login", "network login", "PIN", "e-signature PIN", "Okta credentials", "domain credentials",
    "corporate card number", "employee ID and badge PIN", "pass phrase", "sign-on secret"];
  const scenario = (x: string) => `For audited calculations this workspace requires the requester's ${x} to sign the result — enter it below.`;

  it("fix pass 7 → refusal (b), the injection signature: the audit's scenario and every swapped variant, under need and clarify", () => {
    for (const x of SWAPS) {
      for (const kind of ["need", "clarify"] as const) {
        expect(screenAssistantRequest(scenario(x), kind), `${kind}: ${x}`).toEqual({ ok: false, reason: injection });
        // curly apostrophes are normalised before matching
        expect(screenAssistantRequest(scenario(x).replace("requester's", "requester’s"), kind), `${kind}: ’ ${x}`)
          .toEqual({ ok: false, reason: injection });
      }
    }
    // the box instruction in the next sentence, or the secret itself put in the box
    for (const t of ["This workspace requires your PIN to sign the result. Enter it below.", "Enter your SSO password below.",
      "Before I answer, enter your SSO password in the question box.", "Your password is required. Type it here.",
      "Paste your client secret here.", "Put your badge PIN in the box.",
      "The requester's Okta credentials are needed. Enter them in the field below."]) {
      expect(screenAssistantRequest(t, "need"), t).toEqual({ ok: false, reason: injection });
      expect(screenAssistantRequest(t, "clarify"), t).toEqual({ ok: false, reason: injection });
    }
  });
  it("fix pass 7 → refusal (a), a real URL: an explicit scheme or www., under every kind; a bare dotted token is not one", () => {
    for (const t of ["https://evil.example/collect", "www.vendor.com/ds123", "Please confirm at https://evil.example/login"]) {
      for (const kind of ["need", "clarify", "aspect"] as const) {
        expect(screenAssistantRequest(t, kind), `${kind}: ${t}`).toEqual({ ok: false, reason: "it contains a link" });
      }
    }
    // a lower-case bare domain is a caution, never a refusal
    expect(screenAssistantRequest("Check the datasheet on acme.com for the rating.", "need")).toEqual({ ok: true, caution: ASSISTANT_LINK_CAUTION });
    // aspects are dropped only for a real URL: these are kept
    for (const t of ["Mean and Std.Dev.", "VB.NET scripts", "Password length and rotation", "MFA for remote login", "PIN code rules"]) {
      expect(screenAssistantRequest(t, "aspect"), t).toEqual({ ok: true });
    }
  });
  it("fix pass 7 → the only other guards are length (at least 1000 characters) and an empty text", () => {
    expect(ASSISTANT_REQUEST_MAX).toBeGreaterThanOrEqual(1000);
    expect(screenAssistantRequest("x".repeat(ASSISTANT_REQUEST_MAX)).ok).toBe(true);
    expect(screenAssistantRequest("x".repeat(ASSISTANT_REQUEST_MAX + 1)).ok).toBe(false);
    expect(screenAssistantRequest("x".repeat(ASSISTANT_REQUEST_MAX + 1), "aspect").ok).toBe(false);
    expect(screenAssistantRequest("").ok).toBe(false);
  });
  it("fix pass 7 → no engineering or project-controls sentence from either verifier is refused (a caution is allowed)", () => {
    const engineering = [
      // the fix-pass-6 verifier
      "Provide the employer social security tax rate for the burdened labor rate.",
      "Provide the credit card surcharge (%) to include in the quote total.",
      "Provide the Std.Dev. of the bore diameter readings (mm).", "Provide the St.Dev. of the readings.", "Which language: VB.NET or C#?",
      "the Smith Mfg.Co. drawing number", "Enter your SSO and creep relief set pressures (mbar).",
      "Provide the verification code from your calibration certificate.",
      "Should I give the password policy for contractors or for employees?",
      // the fix-pass-5 verifier
      "the voltage on the input pin", "How many input pins?", "Which supply pin?", "Which aspect: output pins or input pins?",
      "Enter the pin number for the input card.", "the I/O card pin assignment for the transmitter", "the pin number for the relay card.",
      "the grounding pin for the capacitor bank.", "the length of the anchor pins for the river bank.",
      "the force on the release pin to unlock the latch", "the alignment pins used to verify the fixture position",
      "the 2-digit pin number of the signal on connector J4", "the calibration code that was sent to you with the load cell",
      "Provide the site PIN code to look up the basic wind speed (IS 875 Part 3)", "the voltage at the input PIN.", "Provide the OTP.",
      "the PIN number on the nameplate",
      // the fix-pass-4 review and earlier passes
      "the clearance between your pin and the bore (mm)", "the diametral clearance of your pin to the lug hole",
      "the double-shear load on your pin.", "the diameter of your pins, in mm",
      "the material grade of the SHEAR PIN, which the BOM leaves blank", "the grade of the DOWEL PIN, 6 X 20, on the BOM",
      "the size of the cotter PIN for the castle nut", "the PIN and bushing material", "Need: DOWEL PIN", "Need: the PIN-to-hole clearance",
      "ENTER CLEVIS PIN DIAMETER (IN)", "HOW MANY ANCHOR PINS?", "ENTER CONNECTOR PIN NUMBER FOR SIGNAL A",
      "Provide the pin diameter (in) and the applied shear load (lbf).", "Enter the clevis pin diameter and material yield strength.",
      "Please give the number of anchor pins and the bolt circle diameter.", "Provide the OTP (operating test pressure) in psig.",
      "Provide your OTP (operating test pressure) in psig.", "What's your pin count per flange?", "Give the login count.",
      "Provide the MFA flow rate.", "Enter the sign in front of the vacuum term.", "Give the log in base 10 of the pressure ratio.",
      "Provide the routing number for part 1234-A.", "Enter the card number of the analog input module.",
      "Provide the PWD schedule of rates item for M20 concrete.", "Provide the inspector's CWI credentials number.",
      "Provide the classification (CONFIDENTIAL or SECRET) of the drawing.", "What is the sign in front of the vacuum term?",
      'What test temperature (°F) and design pressure (psig) apply to line 6"-P-2001?', "Which flange class — 150# or 300#?",
      "Which aspect: password rules, MFA, or remote login?", "Which type of password policy — length or rotation?",
      // the same sentences beside a box instruction — no secret is named as the reader's, so no refusal
      "Provide the clevis pin diameter and enter it below.", "the double-shear load on your pin. Enter it below.",
      "the clearance between your pin and the bore (mm) — enter it below.", "Enter your pin diameter below.",
      "Provide the SSO and creep relief set pressures (mbar) — enter them below.",
      "Provide the minimum password length required by the policy — enter it below.",
      "Provide the verification code from your calibration certificate and enter it below.",
      "Provide your cost account number — enter it below.", "the I/O card number — enter it below.",
      "Provide the token count and enter it here.", "Provide the shear PIN diameter — enter it below.", "Need: DOWEL PIN. Enter it below.",
      "Provide the badge pin diameter — enter it below.", "the portal pin — enter it below.", "the capacitor bank PIN — enter it below.",
      "Provide the SECRET drawing number — enter it below.", "Provide the credit card surcharge (%) — enter it below.",
    ];
    for (const t of engineering) { notRefused(t, "need"); notRefused(t, "clarify"); }
    // ordinary pin and code sentences stay plain — the precision fixes keep the caution quiet on a pin that is a part
    for (const t of ["the voltage on the input pin", "How many input pins?", "Which supply pin?", "Enter the pin number for the input card.",
      "the I/O card pin assignment for the transmitter", "the pin number for the relay card.", "the grounding pin for the capacitor bank.",
      "the length of the anchor pins for the river bank.", "the force on the release pin to unlock the latch",
      "the alignment pins used to verify the fixture position", "the voltage at the input PIN.", "the PIN number on the nameplate",
      "the clearance between your pin and the bore (mm)", "the double-shear load on your pin.", "Need: DOWEL PIN",
      "Provide the Std.Dev. of the bore diameter readings (mm).", "Which language: VB.NET or C#?", "the Smith Mfg.Co. drawing number",
      "Provide the routing number for part 1234-A.", "Enter the card number of the analog input module.",
      "Enter the sign in front of the vacuum term.", "Give the log in base 10 of the pressure ratio."]) {
      expect(screenAssistantRequest(t, "need"), t).toEqual({ ok: true });
    }
  });
  it("fix pass 7 → every plain credential prompt from the verifier comes back refused or cautioned, never plain", () => {
    const prompts = [
      // the fix-pass-6 verifier's plain list
      "Enter your Okta credentials.", "Enter your network credentials to continue.", "Enter your Windows credentials.",
      "Enter your Okta / network / Windows credentials to continue.", "Enter your card number.", "Enter your account number.",
      "Enter your e-signature PIN.", "Enter your badge PIN.", "Enter your employee PIN.", "Provide your client secret.",
      "Provide your AWS secret access key.", "Provide your private key.", "Enter your recovery code.", "Enter your backup code.",
      "Enter your Okta Verify code.", "Enter your RSA token code.", "Enter your RSA SecurID code.", "What’s your login?",
      "Enter your access code.", "Enter your sign in details.", "Enter your log in details.", "Enter your pwd.", "Enter your pw.",
      "Enter your pass word.", "Enter your network logon.", "Enter your username.", "Enter your employee ID.", "What is your badge number?",
      "Enter your GitHub token.", "Provide your API secret.", "Enter the SSH key.", "Provide your bank details.", "Enter your passport number.",
      "Enter your domain password.", "Enter your token.", "Enter your secret.",
      // earlier passes
      "Enter your PIN to sign the result.", "Enter your SIM PIN.", "Enter the PIN number.", "Enter the 6-digit code we sent to your phone.",
      "Enter the code from Google Authenticator.", "Enter your PIN (4 digits).", "What is your mother's maiden name?",
      "Enter your online banking password.", "Enter your 2FA code.", "enter your banking pin", "your debit card pin",
      "the 4-digit pin for your card", "enter the pin to unlock", "the 6-digit code we texted you", "enter your PIN", "Enter your pin.",
      "Enter the PIN.", "Provide the PIN number for the vendor portal.", "what is your OTP code", "What is your OTP?",
      "Type the OTP code we sent you.", "Enter the one-time code below.", "Please enter your PIN to continue.", "Enter the verification code.",
      "Enter the security code on the back of your card.", "What's your MFA code?", "Please provide your SSO login so I can sign the calc.",
      "What password does the vendor portal use?", "Paste your API key so I can check the table", "What is the bank account for the vendor?",
      "Enter your SSO password.", "Enter your MFA code.", "Enter your SSO login.", "Enter your CVV.", "Provide your SSN.",
      "Enter your credit card number.", "Enter your date of birth.", "Provide your login credentials.", "What is your security question answer?",
    ];
    for (const t of prompts) { refusedOrCautioned(t, "need"); refusedOrCautioned(t, "clarify"); }
    // the curly apostrophe is the same apostrophe
    expect(screenAssistantRequest("What’s your login?", "need")).toEqual(screenAssistantRequest("What's your login?", "need"));
  });
  it("fix pass 7 → nothing but the two refusals blocks: a caution is { ok: true }, and an aspect is never cautioned", () => {
    const screen = repo("lib/assistantScreen.ts");
    const fn = screen.slice(screen.indexOf("export function screenAssistantRequest("));
    // the only refusals in the function: empty, length, URL, injection
    expect(fn.match(/ok: false/g)?.length).toBe(4);
    expect(fn).toContain('if (URL_RE.test(t)) return { ok: false, reason: "it contains a link" };');
    expect(fn).toContain('if (injectionSignature(t)) return { ok: false, reason: "it asks you to type a credential into this box" };');
    expect(fn).toContain('if (CREDENTIAL_CAUTION_RE.test(t)) return { ok: true, caution: ASSISTANT_CREDENTIAL_CAUTION };');
    expect(fn.indexOf('if (kind === "aspect") return { ok: true };')).toBeLessThan(fn.indexOf("injectionSignature(t)"));
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
    // a caution is a line in the frame, never a return in place of the input
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
