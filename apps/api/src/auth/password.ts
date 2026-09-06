import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 32;
const N = 16384;
const R = 8;
const P = 1;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P });
  if (!(key instanceof Buffer)) {
    throw new Error("scrypt returned a non-buffer key");
  }
  return `scrypt$${String(N)}$${String(R)}$${String(P)}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4];
  const keyHex = parts[5];
  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    saltHex === undefined ||
    keyHex === undefined
  ) {
    return false;
  }
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(password, salt, expected.length, { N: n, r, p });
  if (!(actual instanceof Buffer) || actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
