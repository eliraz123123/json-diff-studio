import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const keys = new Map();

function keyFor(secret) {
  if (!keys.has(secret)) {
    keys.set(secret, Buffer.from(hkdfSync("sha256", secret, "json-diff-studio", "field-encryption", 32)));
  }
  return keys.get(secret);
}

// Customer API keys and webhook URLs are stored with AES-256-GCM so a leaked database
// file alone does not expose them.
export function encrypt(plaintext, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url")}`;
}

export function decrypt(token, secret) {
  if (!token.startsWith("v1.")) throw new Error("Unknown ciphertext version");
  const raw = Buffer.from(token.slice(3), "base64url");
  const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

export const randomToken = () => randomBytes(32).toString("base64url");

export const sha256 = value => createHash("sha256").update(value).digest("hex");

export function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
