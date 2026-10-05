import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function getKey(): Buffer {
  const hex = process.env.INTEGRATIONS_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("INTEGRATIONS_KEY must be a 64-hex (32-byte) value");
  }
  return Buffer.from(hex, "hex");
}

export function sealSecret(
  plaintext: string,
  keyHex: string = getKey().toString("hex"),
): string {
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${ct.toString("hex")}`;
}

export function unsealSecret(
  packed: string,
  keyHex: string = getKey().toString("hex"),
): string {
  const [iv, tag, ct] = packed.split(".").map((p) => Buffer.from(p, "hex"));
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyHex, "hex"),
    iv,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    "utf8",
  );
}
