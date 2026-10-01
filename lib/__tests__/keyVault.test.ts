// keyVault — AI provider keys at rest. The contract that matters: what goes
// in comes back out, legacy plaintext rows still work, an unconfigured
// DEVELOPMENT server degrades instead of breaking, and an unconfigured
// PRODUCTION server refuses to store a key at all (GOV-12).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  sealAiKey, openAiKey, aiKeyCryptoConfigured, aiKeyStorageReady, isSealedAiKey,
  AiKeyStorageError, AI_KEY_STORAGE_MESSAGE,
} from "@/lib/ai/keyVault";

const HEX_KEY = "a".repeat(64);
let savedKey: string | undefined;

beforeEach(() => { savedKey = process.env.EXPORT_ENCRYPTION_KEY; });
afterEach(() => {
  if (savedKey === undefined) delete process.env.EXPORT_ENCRYPTION_KEY;
  else process.env.EXPORT_ENCRYPTION_KEY = savedKey;
  vi.unstubAllEnvs();
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

  it("degrades to plaintext storage when EXPORT_ENCRYPTION_KEY is unset — in development only", () => {
    delete process.env.EXPORT_ENCRYPTION_KEY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(sealAiKey("sk-something")).toBe("sk-something");
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).not.toContain("sk-something");
    warn.mockRestore();
    expect(aiKeyStorageReady()).toEqual({ ok: true, encrypted: false });
  });

  it("GOV-12: a PRODUCTION server without the key refuses to store one, with an actionable error", () => {
    delete process.env.EXPORT_ENCRYPTION_KEY;
    vi.stubEnv("NODE_ENV", "production");
    expect(() => sealAiKey("sk-something")).toThrow(AiKeyStorageError);
    expect(() => sealAiKey("sk-something")).toThrow(/EXPORT_ENCRYPTION_KEY/);
    expect(aiKeyStorageReady()).toEqual({ ok: false, error: AI_KEY_STORAGE_MESSAGE });
    // configured production encrypts as ever
    process.env.EXPORT_ENCRYPTION_KEY = HEX_KEY;
    expect(sealAiKey("sk-something").startsWith("encv1:")).toBe(true);
    expect(aiKeyStorageReady()).toEqual({ ok: true, encrypted: true });
  });

  it("GOV-12: existing rows keep decrypting in production — sealed and legacy plaintext alike", () => {
    process.env.EXPORT_ENCRYPTION_KEY = HEX_KEY;
    const sealed = sealAiKey("sk-sealed-before");
    vi.stubEnv("NODE_ENV", "production");
    expect(openAiKey(sealed)).toBe("sk-sealed-before");
    delete process.env.EXPORT_ENCRYPTION_KEY;
    expect(openAiKey("sk-plaintext-legacy")).toBe("sk-plaintext-legacy");
    expect(isSealedAiKey(sealed)).toBe(true);
    expect(isSealedAiKey("sk-plaintext-legacy")).toBe(false);
    expect(isSealedAiKey(null)).toBe(false);
  });

  it("GOV-12: the key must be 64 HEX characters — 64 of anything else is not configured", () => {
    process.env.EXPORT_ENCRYPTION_KEY = "z".repeat(64);
    expect(aiKeyCryptoConfigured()).toBe(false);
    process.env.EXPORT_ENCRYPTION_KEY = "A1".repeat(32);
    expect(aiKeyCryptoConfigured()).toBe(true);
    process.env.EXPORT_ENCRYPTION_KEY = "a".repeat(63);
    expect(aiKeyCryptoConfigured()).toBe(false);
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
