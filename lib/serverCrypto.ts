// lib/serverCrypto.ts
//
// AES-256-GCM symmetric encryption for credentials at rest (S3 access
// keys, webhook signing secrets). The encryption key lives in
// EXPORT_ENCRYPTION_KEY as a 64-char hex string (32 bytes). If unset,
// the API endpoints refuse to save credentials — we never want plaintext
// secrets on disk by accident.
//
// Format on disk: base64(iv || authTag || ciphertext)
//   - iv         12 bytes (GCM-recommended)
//   - authTag    16 bytes
//   - ciphertext variable
//
// This file is server-only. Don't import it into client code.

import { createCipheriv, createDecipheriv, randomBytes, createHmac } from "node:crypto";

const ALG = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  const hex = process.env.EXPORT_ENCRYPTION_KEY || "";
  if (!hex || hex.length !== 64) {
    throw new Error(
      "EXPORT_ENCRYPTION_KEY env var must be a 64-character hex string " +
      "(32 bytes). Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return Buffer.from(hex, "hex");
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return "";
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(packed: string): string {
  if (!packed) return "";
  const key = getKey();
  const buf = Buffer.from(packed, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

/** Mask a secret for safe display in API responses. */
export function maskSecret(s?: string | null): string {
  if (!s) return "";
  if (s.length <= 8) return "•".repeat(s.length);
  return s.slice(0, 4) + "•".repeat(Math.max(0, s.length - 8)) + s.slice(-4);
}

/** Sign a webhook payload with the customer's shared secret. */
export function hmacSign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}
