import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { readOrCreatePrivateFile } from "./data-dir";

function masterKey(): Buffer {
  const key = readOrCreatePrivateFile("secret.key", () => randomBytes(32));
  if (key.length !== 32) throw new Error("HUM_DATA_DIR/secret.key 长度无效");
  return key;
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(value: string): string {
  const [version, ivRaw, tagRaw, ciphertextRaw] = value.split(".");
  if (version !== "v1" || !ivRaw || !tagRaw || !ciphertextRaw) throw new Error("密钥配置格式无效");
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function hashPassword(password: string, salt = randomBytes(16)): { salt: string; hash: string } {
  const hash = scryptSync(password, salt, 64);
  return { salt: salt.toString("base64url"), hash: hash.toString("base64url") };
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  try {
    const actual = scryptSync(password, Buffer.from(salt, "base64url"), 64);
    const expected = Buffer.from(expectedHash, "base64url");
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
