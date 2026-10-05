import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";

/** High-entropy opaque token (session tokens, device secrets) */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * sha256 is enough for high-entropy tokens (no need for bcrypt):
 * they can't be brute forced and are checked on every request.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Alphabet without ambiguous chars (0/O, 1/I/L) */
const CLAIM_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Human friendly pairing code, shown as "K7QM-4XRT" and compared without the dash */
export function generateClaimCode(length = 8): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += CLAIM_ALPHABET[randomInt(CLAIM_ALPHABET.length)];
  }
  return code;
}

export function normalizeClaimCode(code: string): string {
  return String(code ?? "").replace(/[\s-]/g, "").toUpperCase();
}

export function formatClaimCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

const DEVICE_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function generateDeviceId(): string {
  let id = "";
  for (let i = 0; i < 12; i++) {
    id += DEVICE_ID_ALPHABET[randomInt(DEVICE_ID_ALPHABET.length)];
  }
  return `dev_${id}`;
}
