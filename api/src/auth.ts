// Team passcode login: the passcode buys a signed token carrying the student's display name.
// Token = base64url(JSON {name, exp}) + "." + base64url(HMAC-SHA256(payload, tokenSecret)).

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.ts";

const TOKEN_DAYS = 90;

const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest();
const sha256 = (s: string) => createHash("sha256").update(s).digest();

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function checkPasscode(config: Config, passcode: string): boolean {
  return sameBytes(sha256(passcode), sha256(config.passcode));
}

export function checkSnapshotKey(config: Config, key: string | null): boolean {
  return key !== null && sameBytes(sha256(key), sha256(config.snapshotKey));
}

export function issueToken(config: Config, name: string): { token: string; exp: number } {
  const exp = Date.now() + TOKEN_DAYS * 24 * 3600 * 1000;
  const payload = Buffer.from(JSON.stringify({ name, exp })).toString("base64url");
  const sig = hmac(config.tokenSecret, payload).toString("base64url");
  return { token: `${payload}.${sig}`, exp };
}

/** Returns the display name for a valid bearer token, else null. */
export function verifyToken(config: Config, authHeader: string | null): string | null {
  const token = authHeader?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if (!sameBytes(Buffer.from(sig, "base64url"), hmac(config.tokenSecret, payload))) return null;
  try {
    const { name, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof name === "string" && typeof exp === "number" && exp > Date.now() ? name : null;
  } catch {
    return null;
  }
}
