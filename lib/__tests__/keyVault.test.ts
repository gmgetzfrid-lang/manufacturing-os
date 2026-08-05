// keyVault — AI provider keys at rest. The contract that matters: what goes
// in comes back out, legacy plaintext rows still work, and an unconfigured
// deployment degrades instead of breaking.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sealAiKey, openAiKey } from "@/lib/ai/keyVault";

const HEX_KEY = "a".repeat(64);
let savedKey: string | undefined;

beforeEach(() => { savedKey = process.env.EXPORT_ENCRYPTION_KEY; });
afterEach(() => {
  if (savedKey === undefined) delete process.env.EXPORT_ENCRYPTION_KEY;
  else process.env.EXPORT_ENCRYPTION_KEY = savedKey;
});

describe("sealAiKey / openAiKey", () => {
  it("round-trips a key when crypto is configured", () => {
    process.env.EXPORT_ENCRYPTION_KEY = HEX_KEY;
    const sealed = sealAiKey("sk-ant-api03-verysecret");
    expect(sealed.startsWith("encv1:")).toBe(true);
    expect(sealed).not.toContain("verysecret");
    expect(openAiKey(sealed)).toBe("sk-ant-api03-verysecret");
  });

  it("passes legacy plaintext rows through unchanged", () => {
    process.env.EXPORT_ENCRYPTION_KEY = HEX_KEY;
    expect(openAiKey("sk-plaintext-from-before")).toBe("sk-plaintext-from-before");
  });

  it("degrades to plaintext storage when EXPORT_ENCRYPTION_KEY is unset", () => {
    delete process.env.EXPORT_ENCRYPTION_KEY;
    expect(sealAiKey("sk-something")).toBe("sk-something");
  });

  it("handles empty/null stored values", () => {
    expect(openAiKey("")).toBe("");
    expect(openAiKey(null)).toBe("");
    expect(openAiKey(undefined)).toBe("");
    expect(sealAiKey("")).toBe("");
  });

  it("uses a fresh IV per seal (same input, different ciphertext)", () => {
    process.env.EXPORT_ENCRYPTION_KEY = HEX_KEY;
    expect(sealAiKey("sk-x")).not.toBe(sealAiKey("sk-x"));
  });
});
